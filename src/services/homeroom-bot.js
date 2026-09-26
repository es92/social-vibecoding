'use strict';

// #2684: the Homeroom bot (`homeroom_bot`), slice 1 — shadow-mode triage.
//
// ── What it is ───────────────────────────────────────────────────────────
//
// A synthetic platform user that walks every app's open requests and, for
// each one, runs ONE read-only scout turn on the OpenRouter coding backend
// with the app's repository checked out, and records a verdict:
//
//   question  the request is not clear enough to build; here is the one
//             question the bot would ask, with a suggested default
//   ready     the request is clear and the change is small and safe; here
//             is what the bot would change
//   person    the request is clear but a person has to decide something
//             (auth, billing, schema, a design question)
//
// In this slice the verdict is ALL it produces. Nothing is posted to the
// issue, nothing is claimed, nothing is built, nobody is notified. The admin
// console's "Homeroom bot" section reads the ledger and shows, per issue,
// what the bot would have done — and an admin rates each verdict, which is
// the calibration signal the later slices are gated on.
//
// ── Shape ────────────────────────────────────────────────────────────────
//
// A QUEUE, not an hourly sweep. `refreshQueue` reads the GitHub issue cache
// for every app every REFRESH_INTERVAL_MS and upserts one row per eligible
// issue into homeroom_bot_queue; the leader's work loop drains it. Draining
// is PER APP in batches: the bot keeps one dev session per app, so every
// issue of that app runs through the same warm worker container and pays
// the clone once. Scout mode already fetches and resets the workspace at
// the start of each turn, so issues do not see each other's state, and each
// turn starts a fresh model thread.
//
// A `homeroom_bot_mode` platform setting is `off` (the loop idles), `shadow`
// (this slice) or `live` (reserved; the settings route refuses it). Ships
// `off`, so the change that adds the bot is itself inert.
//
// ── What the bot never does here ─────────────────────────────────────────
//
// The scout runner blanks the push token (worker/run-codex-agent.sh), so
// "nothing is built" is structural rather than a prompt instruction. The
// bot's sessions carry an empty linked_issues and is_headless FALSE, so the
// issue payload's `headless` and `in_progress` derivations never paint them
// on a card; routes/issues.js excludes synthetic authors there as well, as
// defence in depth. The sessions sit `paused` between turns and are
// excluded from the global session cap (routes/sessions.js), so a bot turn
// never costs a person a slot.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const log = require('./logger');
const { HOMEROOM_BOT_LOCK } = require('./advisory-locks');
const live = require('./homeroom-bot-live');

const BOT_USERNAME = 'homeroom_bot';
const MODES = Object.freeze(['off', 'shadow', 'live']);
// `empty` (#2737) is the fourth: a request with nothing in it to build or
// even to ask about. It exists because the prompt's unclear branch used to
// force a question, so a placeholder issue got asked "what do you mean?"
// with a suggested default of "discard" — the model already knew, and had
// nowhere to say it. Shadow only in this slice: it posts nothing.
const VERDICTS = Object.freeze(['question', 'ready', 'person', 'empty']);

const KEY_MODE = 'homeroom_bot_mode';
const KEY_CONCURRENCY = 'homeroom_bot_concurrency';
const KEY_BATCH_SIZE = 'homeroom_bot_batch_size';
const KEY_PAUSED_APPS = 'homeroom_bot_paused_apps';
const KEY_TURN_SECONDS = 'homeroom_bot_turn_seconds';
const KEY_TURN_INPUT_TOKENS = 'homeroom_bot_turn_input_tokens';
// #3146: the apps the bot acts on for real — posts on their issues, and
// builds and proposes the clear ones. Everything else stays in shadow.
const KEY_LIVE_APPS = 'homeroom_bot_live_apps';
const SETTING_KEYS = Object.freeze([
  KEY_MODE, KEY_CONCURRENCY, KEY_BATCH_SIZE, KEY_PAUSED_APPS,
  KEY_TURN_SECONDS, KEY_TURN_INPUT_TOKENS, KEY_LIVE_APPS,
]);

// batchSize is how many of ONE app's issues a pass takes before the loop
// looks for the most urgent app again — the fairness knob between apps, not
// a throughput cap: the loop drains continuously (see the cadence below).
// 100 means "finish the app you are on" for any realistic board.
const DEFAULTS = Object.freeze({
  mode: 'off',
  concurrency: 1,
  batchSize: 100,
  pausedApps: [],
  liveApps: [],
  turnSeconds: 20 * 60,
  turnInputTokens: 10_000_000,
});
const MAX_CONCURRENCY = 4;
const MAX_BATCH_SIZE = 500;
// The budget a single triage turn may spend (#2737). Measured over the
// first 213 shadow runs: 7 of the 74 that produced a verdict took $30.04 of
// the $31.40 spent, one of them running 56 minutes for a single verdict,
// and 13 more returned nothing at all after 25 to 149 minutes. The 67 that
// behaved cost $1.36 between them, and 90% finished inside 9 minutes.
//
// Only the clock can STOP a turn (#3035). The token limit was meant to
// catch a turn that burns tokens fast, but neither agent the bot runs
// reports usage until the turn is over, so a token stop can only land on a
// finished turn. It is read after the turn instead: the verdict is kept and
// the overrun logged. The figure is the worker's `inputTokens`, which on
// Codex is the THREAD's running total — meaningful per turn only because
// each triage now starts a fresh thread.
const MIN_TURN_SECONDS = 30;
const MAX_TURN_SECONDS = 3 * 60 * 60;
const MIN_TURN_INPUT_TOKENS = 100_000;
const MAX_TURN_INPUT_TOKENS = 5_000_000_000;

// The bot's own weekly allowance, on its users row like anybody else's.
// $150 to start: at Flash prices a triage is a few cents, so this is a
// ceiling on a runaway loop, not a budget anybody expects to reach.
const DEFAULT_WEEKLY_LIMIT_CENTS = 15000;

// Loop cadence. The loop is EVENT-DRIVEN: an issue filed, edited or
// discussed on the platform calls noteIssueActivity, which queues that app's
// issues and wakes the loop at once (through the ws-bus when the event
// landed on another Pod, since only the leader runs the loop). A pass drains
// one batch; when it did work the next pass follows almost at once, and when
// the queue was empty the loop sleeps until the next wake. The idle delay is
// only a fallback poll for a wake that was lost, and REFRESH_INTERVAL_MS is
// the reconcile sweep for what no event can tell us — an issue opened or
// commented on GitHub directly, a claim that expired — read through
// github.fetchPublicIssues' own cache.
const FIRST_PASS_DELAY_MS = 60 * 1000;
const BUSY_PASS_DELAY_MS = 2 * 1000;
const IDLE_PASS_DELAY_MS = 30 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const BUS_KIND = 'homeroom_bot';

// Eligibility windows. A human claim counts while it is younger than the
// board's own claim TTL; a paused human session counts while it is inside
// the board's in-progress window. Both mirror routes/issues.js.
const CLAIM_TTL_DAYS = 7;
const PAUSED_SESSION_WINDOW_DAYS = 7;

// The live caps the dashboard SIMULATES in shadow mode: a run reports
// whether these would have suppressed it, so the dashboard shows the live
// bot's behaviour and not only the raw model's.
const PROPOSALS_PER_APP_CAP = 2;
// Questions and `empty` verdicts share this one allowance, so the bot
// cannot answer a quiet board with ten questions AND ten close proposals in
// the same day. Both are a demand on somebody's attention.
const QUESTION_TRIPWIRE_PER_DAY = 10;
const TRIPWIRE_VERDICTS = Object.freeze(['question', 'empty']);

// A session that refuses a turn is backed off per app rather than retried
// on the next wake (#2737). One wedged session produced 121 of 124 refusals
// in the first day, a median of 31 seconds apart, which is the idle poll.
const BACKOFF_BASE_MS = 2 * 60 * 1000;
const BACKOFF_CEILING_MS = 60 * 60 * 1000;
// How far past one turn's budget a claimed queue row counts as abandoned.
const STALE_CLAIM_MARGIN_SECONDS = 10 * 60;

// Bounds on what a verdict may carry into the ledger.
const MAX_FIELD_CHARS = 4000;
const MAX_ERROR_CHARS = 600;

const TRIAGE_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'homeroom-bot-triage.md');

let timer = null;
let stopped = false;
let passInFlight = false;
let lastRefreshAt = 0;
let triagePromptCache = null;
// The config start() was handed, so a wake can schedule a pass itself.
let loopConfig = null;
// appId → { until, attempts }. In memory on purpose: the loop is a
// singleton on the leader, and a restart SHOULD retry immediately — a new
// process is exactly the event most likely to have cleared the wedge.
const appBackoff = new Map();
// sessionId → when we last killed that session's container on a budget stop
// (#2870). An issue dispatched into the same session while the kill lands
// comes back with an empty reply that has nothing to do with the issue, and
// used to be recorded as a permanent parse failure against it.
const stoppedSessions = new Map();
// What the last pass refused, for the dashboard's loop line. Refusals are
// counted here instead of being written as verdict rows.
let lastRefusals = [];
// A platform fault backs off the WHOLE bot (#3122): the worker quota, a
// missing key or a refused ledger fails every app the same way, and the
// loop used to retry the same issue every 30 seconds, writing a failed row
// each time — 60 rows in 70 minutes while the volume quota was full.
// { attempts, until, error, at }. In memory for the same reason as
// appBackoff: a restart is the event most likely to have cleared it.
let platformFault = null;
// When the bot last freed its own leftover worker volumes.
let lastVolumeSweepAt = 0;
// Apps whose issues changed since the last pass (wake), and whether a full
// reconcile was asked for (the mode was switched on, say). Read and cleared
// at the top of every pass; only meaningful on the Pod running the loop.
const pendingApps = new Set();
let refreshAllRequested = false;
let wakeRequested = false;
// What the last pass did, for the dashboard: a loop that is on but idle
// on budget or on a worker fault should say so rather than show nothing.
let lastPass = null;

// Failures the platform, not the model, produced: the worker could not be
// bootstrapped, the bot has no key or model, the ledger refused the turn.
// Retrying the next issue would fail the same way, so the pass stops and
// the loop idles; the queue row is kept for when the fault is cleared.
const INFRA_ERRORS = new Set([
  'backend_disabled', 'credential_required', 'model_required', 'invalid_base_url',
  'agent_context_changed', 'session_busy', 'ledger_start_failed', 'not_a_codex_session',
]);

// ── Settings ─────────────────────────────────────────────────────────────

function parseSettings(rows) {
  const map = new Map((rows || []).map((r) => [r.key, r.value]));
  const mode = MODES.includes(map.get(KEY_MODE)) ? map.get(KEY_MODE) : DEFAULTS.mode;
  const concurrency = clampInt(map.get(KEY_CONCURRENCY), DEFAULTS.concurrency, 1, MAX_CONCURRENCY);
  const batchSize = clampInt(map.get(KEY_BATCH_SIZE), DEFAULTS.batchSize, 1, MAX_BATCH_SIZE);
  let pausedApps = DEFAULTS.pausedApps;
  try {
    const parsed = JSON.parse(map.get(KEY_PAUSED_APPS) || '[]');
    if (Array.isArray(parsed)) pausedApps = parsed.filter((s) => typeof s === 'string').slice(0, 500);
  } catch {
    pausedApps = DEFAULTS.pausedApps;
  }
  let liveApps = DEFAULTS.liveApps;
  try {
    const parsed = JSON.parse(map.get(KEY_LIVE_APPS) || '[]');
    if (Array.isArray(parsed)) liveApps = parsed.filter((s) => typeof s === 'string').slice(0, 50);
  } catch {
    liveApps = DEFAULTS.liveApps;
  }
  const turnSeconds = clampInt(
    map.get(KEY_TURN_SECONDS), DEFAULTS.turnSeconds, MIN_TURN_SECONDS, MAX_TURN_SECONDS,
  );
  const turnInputTokens = clampInt(
    map.get(KEY_TURN_INPUT_TOKENS), DEFAULTS.turnInputTokens,
    MIN_TURN_INPUT_TOKENS, MAX_TURN_INPUT_TOKENS,
  );
  return { mode, concurrency, batchSize, pausedApps, liveApps, turnSeconds, turnInputTokens };
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function readSettings(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT key, value FROM platform_settings WHERE key = ANY($1)',
      [SETTING_KEYS],
    );
    return parseSettings(rows);
  } catch (err) {
    // platform_settings may not exist on a very first boot before migrate()
    // has run; the defaults keep the loop idle, which is the safe answer.
    log.warn('homeroom-bot', 'settings read failed; using defaults', { err: err.message });
    return { ...DEFAULTS };
  }
}

/**
 * Validate an admin's settings patch. Returns { ok, error } or
 * { ok, updates: [[key, value], …], weeklyLimitCents }. `live` is refused
 * here rather than merely ignored: this slice has no live behaviour, and a
 * switch that reads "live" while the bot posts nothing would be a lie.
 */
function validateSettingsPatch(patch) {
  const body = patch || {};
  const updates = [];
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode)) return { ok: false, error: 'mode must be off, shadow or live' };
    if (body.mode === 'live') {
      return { ok: false, error: 'Live mode is not available yet: this build only triages in shadow mode.' };
    }
    updates.push([KEY_MODE, body.mode]);
  }
  if (body.concurrency !== undefined) {
    const n = Number(body.concurrency);
    if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
      return { ok: false, error: `concurrency must be an integer from 1 to ${MAX_CONCURRENCY}` };
    }
    updates.push([KEY_CONCURRENCY, String(n)]);
  }
  if (body.turnSeconds !== undefined) {
    const n = Number(body.turnSeconds);
    if (!Number.isInteger(n) || n < MIN_TURN_SECONDS || n > MAX_TURN_SECONDS) {
      return { ok: false, error: `turnSeconds must be an integer from ${MIN_TURN_SECONDS} to ${MAX_TURN_SECONDS}` };
    }
    updates.push([KEY_TURN_SECONDS, String(n)]);
  }
  if (body.turnInputTokens !== undefined) {
    const n = Number(body.turnInputTokens);
    if (!Number.isInteger(n) || n < MIN_TURN_INPUT_TOKENS || n > MAX_TURN_INPUT_TOKENS) {
      return { ok: false, error: `turnInputTokens must be an integer from ${MIN_TURN_INPUT_TOKENS} to ${MAX_TURN_INPUT_TOKENS}` };
    }
    updates.push([KEY_TURN_INPUT_TOKENS, String(n)]);
  }
  if (body.batchSize !== undefined) {
    const n = Number(body.batchSize);
    if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) {
      return { ok: false, error: `batchSize must be an integer from 1 to ${MAX_BATCH_SIZE}` };
    }
    updates.push([KEY_BATCH_SIZE, String(n)]);
  }
  if (body.pausedApps !== undefined) {
    if (!Array.isArray(body.pausedApps)
        || !body.pausedApps.every((s) => typeof s === 'string' && /^[a-z0-9-]{1,120}$/.test(s))) {
      return { ok: false, error: 'pausedApps must be an array of app slugs' };
    }
    updates.push([KEY_PAUSED_APPS, JSON.stringify([...new Set(body.pausedApps)])]);
  }
  if (body.liveApps !== undefined) {
    if (!Array.isArray(body.liveApps) || body.liveApps.length > 50
        || !body.liveApps.every((s) => typeof s === 'string' && /^[a-z0-9-]{1,120}$/.test(s))) {
      return { ok: false, error: 'liveApps must be an array of up to 50 app slugs' };
    }
    updates.push([KEY_LIVE_APPS, JSON.stringify([...new Set(body.liveApps)])]);
  }
  let weeklyLimitCents;
  if (body.weeklyLimitCents !== undefined) {
    const n = Number(body.weeklyLimitCents);
    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) {
      return { ok: false, error: 'weeklyLimitCents must be a non-negative integer' };
    }
    weeklyLimitCents = n;
  }
  if (!updates.length && weeklyLimitCents === undefined) {
    return { ok: false, error: 'Nothing to update' };
  }
  return { ok: true, updates, weeklyLimitCents };
}

async function writeSettings(pool, patch, actorId, config = {}) {
  const valid = validateSettingsPatch(patch);
  if (!valid.ok) return valid;
  let modeBefore = null;
  if (valid.updates.some(([key]) => key === KEY_MODE)) {
    try { modeBefore = (await readSettings(pool)).mode; } catch {}
  }
  for (const [key, value] of valid.updates) {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [key, value, actorId || null],
    );
  }
  if (valid.weeklyLimitCents !== undefined) {
    // The cap lives on the bot's users row, which the first pass used to be
    // the only thing that created — so a cap saved before that pass updated
    // nothing and the box stayed blank. Create the row first.
    await ensureBotUser(pool, config);
    await pool.query(
      'UPDATE users SET weekly_limit_cents = $1 WHERE username = $2 AND is_synthetic = TRUE',
      [valid.weeklyLimitCents, BOT_USERNAME],
    );
    // The cap the platform enforces is the users row above; the child key's
    // provider-side limit is a backstop and lags until the next sync.
    try {
      const limits = require('./limits');
      limits.invalidate();
    } catch {}
  }
  const modeAfter = valid.updates.find(([key]) => key === KEY_MODE)?.[1];
  if (modeAfter && modeAfter !== 'off' && modeAfter !== modeBefore) {
    // Switched on: rebuild the whole queue now rather than when the next
    // reconcile sweep happens to be due.
    wakeAll();
  }
  return { ok: true };
}

// ── Identity ─────────────────────────────────────────────────────────────

/**
 * The bot's users row, created on first use. Synthetic like demo mode's
 * partner: a random discarded password, no admin bit, no app quota, and
 * routes/auth.js refuses the row at login. Its company-funded OpenRouter
 * key is minted through the same path every account's is; a refusal there
 * is logged and retried on the next pass rather than failing the loop.
 */
async function ensureBotUser(pool, config = {}) {
  const { rows: found } = await pool.query(
    'SELECT id, username, weekly_limit_cents FROM users WHERE username = $1',
    [BOT_USERNAME],
  );
  let bot = found[0] || null;
  if (bot && !(await isSynthetic(pool, bot.id))) {
    // A person registered the name before the bot existed. Never adopt a
    // real account as the bot.
    throw new Error(`users row '${BOT_USERNAME}' exists and is not synthetic`);
  }
  if (!bot) {
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    await pool.query(
      // daily_limit_cents is set too: #2571 stopped applying the daily cap,
      // but a per-user override is still what marks an account as having
      // its allowance decided by an admin rather than by a verified identity
      // (limits.getUserCreditEntitlement), and the bot has no identity.
      `INSERT INTO users (username, password, is_admin, can_create_apps, is_synthetic,
                          weekly_limit_cents, daily_limit_cents)
       VALUES ($1, $2, FALSE, FALSE, TRUE, $3, $3)
       ON CONFLICT (username) DO NOTHING`,
      [BOT_USERNAME, hash, DEFAULT_WEEKLY_LIMIT_CENTS],
    );
    const { rows } = await pool.query(
      'SELECT id, username, weekly_limit_cents FROM users WHERE username = $1',
      [BOT_USERNAME],
    );
    bot = rows[0];
    if (!bot) throw new Error(`Could not create the ${BOT_USERNAME} user`);
    log.info('homeroom-bot', 'Bot user created', { userId: bot.id });
  }
  if (bot.weekly_limit_cents == null) {
    await pool.query('UPDATE users SET weekly_limit_cents = $1 WHERE id = $2',
      [DEFAULT_WEEKLY_LIMIT_CENTS, bot.id]);
    bot.weekly_limit_cents = DEFAULT_WEEKLY_LIMIT_CENTS;
  }
  try {
    const managedOpenRouter = require('./openrouter-managed-keys');
    const key = await managedOpenRouter.ensureIncludedKey({
      pool, userId: bot.id, config, reason: 'homeroom_bot',
    });
    if (key?.created) log.info('homeroom-bot', 'Included OpenRouter key issued to the bot', { userId: bot.id });
  } catch (err) {
    log.warn('homeroom-bot', 'Included key check failed', { err: err.message });
  }
  return bot;
}

async function isSynthetic(pool, userId) {
  const { rows } = await pool.query('SELECT is_synthetic FROM users WHERE id = $1', [userId]);
  return rows[0]?.is_synthetic === true;
}

// ── Verdict parsing (pure) ──────────────────────────────────────────────

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/g;

function clip(value, max = MAX_FIELD_CHARS) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The verdict is the LAST fenced JSON block in the agent's final message;
 * anything before it is working notes. A message with no parseable block,
 * or one whose `verdict` is not one of the three, yields null and the run
 * is recorded as `failed` with the tail of the text — never a guessed
 * verdict.
 */
function parseVerdict(text) {
  const raw = String(text || '');
  const candidates = [];
  let m;
  while ((m = FENCE_RE.exec(raw)) !== null) candidates.push(m[1]);
  FENCE_RE.lastIndex = 0;
  // No fence: try the outermost braces of the whole text as a last resort.
  if (!candidates.length) {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    let obj;
    try { obj = JSON.parse(candidates[i]); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const verdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : '';
    if (!VERDICTS.includes(verdict)) continue;
    const missing = clip(obj.missing_fact, 1000);
    return {
      verdict,
      determined: typeof obj.determined === 'boolean' ? obj.determined : null,
      missingFact: missing && /^none\.?$/i.test(missing) ? null : missing,
      question: verdict === 'question' ? clip(obj.question, 2000) : null,
      questionDefault: verdict === 'question' ? clip(obj.default, 1000) : null,
      buildNote: verdict === 'ready' ? clip(obj.build_note) : null,
      // `person` says which criterion fails; `empty` says what a person
      // should do with a request that has nothing in it. Same field.
      reason: (verdict === 'person' || verdict === 'empty') ? clip(obj.reason, 2000) : null,
    };
  }
  return null;
}

// ── Eligibility (pure) ──────────────────────────────────────────────────

function toMs(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Decide whether one open issue should be queued, and at what priority.
 *
 *   issue        a normalized GitHub issue ({ number, updatedAt, ... })
 *   threadLastAt newest Homeroom discussion message on it, or null
 *   busy         true when a person has a live claim, session or proposal
 *                on it — the bot never competes with a human who started
 *   lastRun      the bot's most recent run on it ({ thread_seen_at,
 *                cap_suppressed }), or null
 *
 * `threadSeenAt` is the newest activity the bot knows of. A run is only
 * worth repeating when something happened after the last one saw it, or
 * (#3152) when a live cap held its verdict: that issue comes back as `held`,
 * naming the cap, and refreshApp decides whether the cap has room again.
 */
function classifyIssue({ issue, threadLastAt = null, busy = false, lastRun = null }) {
  if (!issue || !Number.isInteger(issue.number)) return { eligible: false, reason: 'invalid' };
  if (issue.state && issue.state !== 'open') return { eligible: false, reason: 'closed' };
  if (busy) return { eligible: false, reason: 'in_progress' };
  const seenMs = Math.max(toMs(issue.updatedAt), toMs(issue.createdAt), toMs(threadLastAt));
  const threadSeenAt = seenMs ? new Date(seenMs).toISOString() : null;
  if (lastRun) {
    const lastSeenMs = toMs(lastRun.thread_seen_at);
    if (lastSeenMs && seenMs <= lastSeenMs) {
      if (lastRun.cap_suppressed) {
        return { eligible: false, reason: 'held', cap: lastRun.cap_suppressed, threadSeenAt };
      }
      return { eligible: false, reason: 'unchanged', threadSeenAt };
    }
    return { eligible: true, reason: 'changed', priority: 2, threadSeenAt };
  }
  return { eligible: true, reason: 'new', priority: 1, threadSeenAt };
}

function parseRepo(url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ── The queue ───────────────────────────────────────────────────────────

async function listApps(pool) {
  const { rows } = await pool.query(
    `SELECT id, slug, name, repo_url, self_hosted
       FROM apps
      WHERE status = 'running' AND repo_url IS NOT NULL
      ORDER BY id`,
  );
  return rows;
}

/**
 * Everything that makes an issue "somebody's": a live human claim, a live
 * non-synthetic session that declared it, a human auto-solve run on it, or
 * an open proposal addressing it. One query per kind, per app.
 */
async function busyIssueNumbers(pool, appId) {
  const busy = new Set();
  const add = (rows) => { for (const r of rows) if (r.n != null) busy.add(Number(r.n)); };
  const claims = await pool.query(
    `SELECT ic.github_issue_number AS n
       FROM issue_claims ic JOIN users u ON u.id = ic.user_id
      WHERE ic.app_id = $1 AND u.is_synthetic IS NOT TRUE
        AND ic.claimed_at > NOW() - make_interval(days => $2)`,
    [appId, CLAIM_TTL_DAYS],
  );
  add(claims.rows);
  const linked = await pool.query(
    `SELECT UNNEST(cs.linked_issues) AS n
       FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND u.is_synthetic IS NOT TRUE
        AND cardinality(cs.linked_issues) > 0
        AND (cs.status IN ('active', 'promoted', 'merging')
             OR (cs.status = 'paused'
                 AND cs.last_activity_at > NOW() - make_interval(days => $2)))`,
    [appId, PAUSED_SESSION_WINDOW_DAYS],
  );
  add(linked.rows);
  const headless = await pool.query(
    `SELECT cs.headless_issue_number AS n
       FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND u.is_synthetic IS NOT TRUE
        AND cs.is_headless = TRUE AND cs.headless_status IN ('generating', 'ready')`,
    [appId],
  );
  add(headless.rows);
  const created = await pool.query(
    `SELECT cs.created_from_issue_number AS n
       FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND u.is_synthetic IS NOT TRUE
        AND cs.created_from_issue_number IS NOT NULL
        AND cs.status IN ('active', 'promoted', 'merging')`,
    [appId],
  );
  add(created.rows);
  return busy;
}

async function threadActivityByIssue(pool, appId) {
  const { rows } = await pool.query(
    `SELECT thread_ref AS n, MAX(created_at) AS last_at
       FROM chat_messages
      WHERE app_id = $1 AND thread_type = 'issue' AND msg_type = 'message'
      GROUP BY thread_ref`,
    [appId],
  );
  return new Map(rows.map((r) => [Number(r.n), r.last_at]));
}

/**
 * The run each issue was last judged by, for the "unchanged since" check.
 *
 * Two kinds of row are not a judgement of the issue and are skipped (#3035):
 * a turn killed as collateral from a stop on the same session, and a turn
 * discarded by the token check between #2870 and #3035, which fired on every
 * finished turn because it compared a whole conversation's running total.
 * Counting either as "seen" left the issue unchanged-since-its-last-run and
 * so never queued again, which is how issues dropped out without a verdict.
 * Skipping them puts those issues back on the next refresh; no new rows of
 * either kind are written once the causes are gone, so the filter is a
 * recovery that costs nothing afterwards.
 */
async function lastRunsByIssue(pool, appId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (issue_number) issue_number, thread_seen_at, verdict, cap_suppressed, created_at
       FROM homeroom_bot_runs
      WHERE app_id = $1
        AND budget_stop IS DISTINCT FROM 'input tokens'
        AND (error IS NULL OR error NOT LIKE 'collateral:%')
      ORDER BY issue_number, created_at DESC`,
    [appId],
  );
  return new Map(rows.map((r) => [Number(r.issue_number), r]));
}

/**
 * One refresh of one app's slice of the queue. Returns what it did so a
 * test can drive it directly. `github` is injectable for the same reason.
 *
 * `capRoom` (#3152) is how many more verdicts each live cap would let
 * through on this app right now, from capRoomFor; null on a shadow app.
 * An unchanged issue whose last verdict a cap held comes back once that
 * cap has room: oldest hold first, and no more of them than there is room
 * for, so a merged proposal brings back one held build rather than all of
 * them at once.
 */
async function refreshApp(pool, app, { github = require('./github'), capRoom = null } = {}) {
  const repo = parseRepo(app.repo_url);
  const out = { app: app.slug, queued: 0, removed: 0, skipped: null };
  if (!repo) { out.skipped = 'no_repo'; return out; }
  const fetched = await github.fetchPublicIssues(repo.owner, repo.repo);
  const issues = Array.isArray(fetched?.issues) ? fetched.issues : [];
  if (!issues.length && fetched?.note) { out.skipped = 'github_unavailable'; return out; }

  const [busy, threads, lastRuns] = await Promise.all([
    busyIssueNumbers(pool, app.id),
    threadActivityByIssue(pool, app.id),
    lastRunsByIssue(pool, app.id),
  ]);

  const eligible = [];
  const held = [];
  for (const issue of issues) {
    const n = Number(issue.number);
    const lastRun = lastRuns.get(n) || null;
    const verdict = classifyIssue({
      issue,
      threadLastAt: threads.get(n) || null,
      busy: busy.has(n),
      lastRun,
    });
    if (verdict.eligible) eligible.push({ n, ...verdict });
    else if (verdict.reason === 'held') held.push({ n, heldAt: toMs(lastRun.created_at), ...verdict });
  }
  if (capRoom) {
    const room = { ...capRoom };
    held.sort((a, b) => a.heldAt - b.heldAt);
    for (const h of held) {
      if (!(room[h.cap] > 0)) continue;
      room[h.cap] -= 1;
      eligible.push({ n: h.n, eligible: true, reason: 'cap_freed', priority: 2, threadSeenAt: h.threadSeenAt });
    }
  }

  for (const item of eligible) {
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, thread_seen_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, issue_number) DO UPDATE
         SET priority = LEAST(homeroom_bot_queue.priority, EXCLUDED.priority),
             thread_seen_at = EXCLUDED.thread_seen_at,
             reason = CASE WHEN homeroom_bot_queue.priority = 0
                           THEN homeroom_bot_queue.reason ELSE EXCLUDED.reason END
       WHERE homeroom_bot_queue.started_at IS NULL`,
      [app.id, item.n, item.priority, item.reason, item.threadSeenAt],
    );
    out.queued += 1;
  }
  // Rows the refresh no longer wants (closed, claimed, unchanged) leave the
  // queue; an admin's "run now" (priority 0) is kept until it runs.
  const removed = await pool.query(
    `DELETE FROM homeroom_bot_queue
      WHERE app_id = $1 AND started_at IS NULL AND priority > 0
        AND NOT (issue_number = ANY($2::int[]))`,
    [app.id, eligible.map((e) => e.n)],
  );
  out.removed = removed.rowCount || 0;
  return out;
}

async function refreshQueue(pool, settings, deps = {}) {
  const apps = await listApps(pool);
  const paused = new Set(settings?.pausedApps || []);
  const summary = { apps: 0, queued: 0, removed: 0, skipped: 0 };
  for (const app of apps) {
    if (paused.has(app.slug)) continue;
    summary.apps += 1;
    try {
      const capRoom = deps.bot && live.isLiveFor(settings, app)
        ? await capRoomFor(pool, deps.bot, app.id) : null;
      const r = await refreshApp(pool, app, { ...deps, capRoom });
      summary.queued += r.queued;
      summary.removed += r.removed;
      if (r.skipped) summary.skipped += 1;
    } catch (err) {
      log.warn('homeroom-bot', 'Queue refresh failed for app', { app: app.slug, err: err.message });
    }
  }
  return summary;
}

/** refreshQueue for the named apps only: what a wake asks for. */
async function refreshApps(pool, settings, appIds, deps = {}) {
  const wanted = new Set(appIds.map(Number));
  const apps = (await listApps(pool)).filter((a) => wanted.has(Number(a.id)));
  const paused = new Set(settings?.pausedApps || []);
  const summary = { apps: 0, queued: 0, removed: 0, skipped: 0 };
  for (const app of apps) {
    if (paused.has(app.slug)) continue;
    summary.apps += 1;
    try {
      const capRoom = deps.bot && live.isLiveFor(settings, app)
        ? await capRoomFor(pool, deps.bot, app.id) : null;
      const r = await refreshApp(pool, app, { ...deps, capRoom });
      summary.queued += r.queued;
      summary.removed += r.removed;
      if (r.skipped) summary.skipped += 1;
    } catch (err) {
      log.warn('homeroom-bot', 'Queue refresh failed for app', { app: app.slug, err: err.message });
    }
  }
  return summary;
}

/**
 * The next batch: the app holding the most urgent queued item, and up to
 * `batchSize` of that app's items. Apps in `excludeAppIds` are skipped so
 * concurrent passes never share an app (one container, one turn at a time).
 */
/**
 * Release rows a pass claimed and never finished. runTriage claims its row
 * (`started_at`) before it runs; nextBatch takes unclaimed rows only, and a
 * refresh updates and deletes unclaimed rows only, so a row whose pass died
 * mid-turn (a platform restart) was skipped for good and its issue never
 * looked at again. Passes hold the loop's lock, so nothing live is older
 * than one turn's budget; past that, with a margin, the claim is abandoned.
 */
async function releaseStaleClaims(pool, settings) {
  const seconds = (Number(settings?.turnSeconds) || DEFAULTS.turnSeconds) + STALE_CLAIM_MARGIN_SECONDS;
  const { rowCount } = await pool.query(
    `UPDATE homeroom_bot_queue SET started_at = NULL
      WHERE started_at IS NOT NULL AND started_at < NOW() - make_interval(secs => $1)`,
    [seconds],
  );
  if (rowCount) log.info('homeroom-bot', 'Released queue rows an unfinished pass had claimed', { count: rowCount });
  return rowCount || 0;
}

/**
 * A triage that threw left its row claimed, recorded nothing, and so was
 * never tried again (rss-reader #24, 2026-09-25: its "looking" post and then
 * silence). Record it as a failed run and drop the row, as recordFailure does
 * for a failure it sees. Not a retry: a throw that repeats would sit at the
 * head of the queue and starve every other app. What it has seen is now, so
 * the bot's own post just before the throw is not read as a change; the issue
 * is looked at again when somebody changes it, or on an admin's Run now.
 */
async function recordThrownTriage(pool, { app, item, settings, err }) {
  try {
    await insertRun(pool, {
      appId: app.id, issueNumber: item.issue_number,
      mode: live.isLiveFor(settings, app) ? 'live' : settings.mode,
      verdict: 'failed', error: `threw: ${err?.message || err}`,
      threadSeenAt: new Date().toISOString(),
    });
    await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
  } catch (recordErr) {
    log.warn('homeroom-bot', 'Could not record a triage that threw', {
      app: app.slug, issueNumber: item.issue_number, err: recordErr.message,
    });
  }
}

async function nextBatch(pool, { batchSize, excludeAppIds = [], pausedApps = [] }) {
  const { rows: head } = await pool.query(
    `SELECT q.app_id
       FROM homeroom_bot_queue q JOIN apps a ON a.id = q.app_id
      WHERE q.started_at IS NULL
        AND NOT (q.app_id = ANY($1::int[]))
        AND NOT (a.slug = ANY($2::text[]))
      ORDER BY q.priority, q.enqueued_at
      LIMIT 1`,
    [excludeAppIds, pausedApps],
  );
  if (!head.length) return null;
  const appId = head[0].app_id;
  const { rows: appRows } = await pool.query(
    'SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = $1', [appId],
  );
  const { rows: items } = await pool.query(
    `SELECT id, app_id, issue_number, priority, reason, thread_seen_at, requested_by
       FROM homeroom_bot_queue
      WHERE app_id = $1 AND started_at IS NULL
      ORDER BY priority, enqueued_at
      LIMIT $2`,
    [appId, batchSize],
  );
  return { app: appRows[0], items };
}

// ── The triage turn ─────────────────────────────────────────────────────

function triagePrompt() {
  if (triagePromptCache) return triagePromptCache;
  triagePromptCache = fs.readFileSync(TRIAGE_PROMPT_PATH, 'utf8');
  return triagePromptCache;
}

// What the triage knows of the platform. A request often turns on it (its
// native kit, its `--un-*` tokens, what an app may do), and the app's
// repository does not hold those answers.
//
// The conventions are a TOOL CALL away, not inline. #3161 inlined all
// 150 KB of them, as an agent-chat scout carries them, and on rss-reader #24
// (2026-09-26) that went wrong twice: once the model took the whole message
// for one conventions document and never triaged; once every request
// carried 50k tokens before the first file read, the context crossed the
// auto-compaction limit after 86 reads, and the model's own summary said
// the task was "not visible in my surviving context". The Homeroom read
// tool every scout has serves the same document on demand: the essentials
// and an index of sections, then one section at a time. The UI design
// guidance the coding agents build with is small, so it stays inline.
//
// It goes AFTER the request and the triage instructions, fenced and
// labelled as reference, so it is never read as the task.
function triageReference() {
  const designGuidance = require('./prompts').getDesignGuidance({ readsImages: false });
  return `==== PLATFORM REFERENCE (for looking things up; not the request) ====

The Homeroom platform's own conventions (its rules for every app on it: its native UI kit, its \`--un-*\` theme tokens, its APIs and what an app may do) are one tool call away. Call \`get_platform_conventions\` with no arguments for the essentials and an index of its sections, then with a section's slug to read just that section. Use it when the request turns on the platform; nothing in this reference is a task.

The UI design guidance every coding agent here builds with follows, for judging a request that changes what people see.

${designGuidance}

==== END PLATFORM REFERENCE ====`;
}

// The last thing the model reads says what it is doing and restates the one
// format parseVerdict accepts, so the verdict does not depend on it
// remembering instructions from earlier in the turn.
function triageClosing(issueNumber) {
  return `That is the end of the reference. Now answer the triage request above, for issue #${issueNumber}: decide which verdict is true, and END YOUR REPLY WITH EXACTLY ONE fenced JSON block in this format, and nothing after it:
{"verdict": "question" | "empty" | "ready" | "person", "determined": true | false, "missing_fact": "...", "question": "...", "default": "...", "build_note": "...", "reason": "..."}`;
}

/**
 * The bot's one dev session per app, created on first use. `paused` at
 * rest and `active` only while a turn runs; is_headless FALSE and an empty
 * linked_issues so no board derivation reads it as work on any issue.
 */
async function ensureBotSession(pool, config, bot, app) {
  const { rows: found } = await pool.query(
    `SELECT * FROM chat_sessions
      WHERE user_id = $1 AND app_id = $2 AND status IN ('active', 'paused')
      ORDER BY id DESC LIMIT 1`,
    [bot.id, app.id],
  );
  let session = found[0] || null;
  if (!session) {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues,
                                  session_title, agent_backend, agent_provider, agent_model,
                                  agent_reasoning_effort)
       VALUES ($1, $2, 'main', 'paused', FALSE, '{}', $3, 'codex_openrouter', 'openrouter', $4, $5)
       RETURNING *`,
      [app.id, bot.id, 'Homeroom bot triage',
        config.openrouterDefaultCodexModel || null,
        config.openrouterDefaultCodexReasoning || 'low'],
    );
    session = rows[0];
    log.info('homeroom-bot', 'Bot session created', { app: app.slug, sessionId: session.id });
  }
  session.app_slug = app.slug;
  session.app_name = app.name;
  session.repo_url = app.repo_url;
  session.app_self_hosted = app.self_hosted;
  return session;
}

async function insertRun(pool, run) {
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_runs
       (app_id, issue_number, session_id, mode, verdict, determined, missing_fact, question,
        question_default, build_note, reason, cap_suppressed, thread_seen_at, model, cost_usd,
        input_tokens, output_tokens, duration_ms, error, budget_stop)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING id`,
    [run.appId, run.issueNumber, run.sessionId || null, run.mode, run.verdict,
      run.determined ?? null, run.missingFact || null, run.question || null,
      run.questionDefault || null, run.buildNote || null, run.reason || null,
      run.capSuppressed || null, run.threadSeenAt || null, run.model || null,
      run.costUsd ?? null, run.inputTokens ?? null, run.outputTokens ?? null,
      run.durationMs ?? null, run.error ? clip(run.error, MAX_ERROR_CHARS) : null,
      run.budgetStop || null],
  );
  return rows[0]?.id || null;
}

/**
 * Which live cap would have stopped this verdict from being posted. Both
 * counts are over the bot's own rows, so in shadow mode they read zero
 * until the tripwire on questions trips — which is exactly the number the
 * dashboard exists to show.
 */
async function simulateCaps(pool, bot, appId, verdict) {
  if (verdict === 'ready') {
    if (await openBotProposalCount(pool, bot, appId) >= PROPOSALS_PER_APP_CAP) return 'proposals_per_app';
  }
  if (TRIPWIRE_VERDICTS.includes(verdict)) {
    if (await tripwireCount(pool, appId) >= QUESTION_TRIPWIRE_PER_DAY) return 'question_tripwire';
  }
  return null;
}

async function openBotProposalCount(pool, bot, appId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM chat_sessions
      WHERE app_id = $1 AND user_id = $2 AND status IN ('promoted', 'merging')`,
    [appId, bot.id],
  );
  return rows[0]?.cnt || 0;
}

// Only the verdicts that went out (or, in shadow, would have). A held one
// said nothing but the one-line held note, and counting it would let each
// retry of a held question push the window out again (#3152).
async function tripwireCount(pool, appId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM homeroom_bot_runs
      WHERE app_id = $1 AND verdict = ANY($2::text[])
        AND cap_suppressed IS NULL
        AND created_at > NOW() - INTERVAL '24 hours'`,
    [appId, TRIPWIRE_VERDICTS],
  );
  return rows[0]?.cnt || 0;
}

/**
 * How many more verdicts each cap would let through on this app now, keyed
 * by the name simulateCaps records (#3152). The same two counts, so a held
 * issue is only brought back when the check it failed would now pass.
 */
async function capRoomFor(pool, bot, appId) {
  const [proposals, questions] = await Promise.all([
    openBotProposalCount(pool, bot, appId),
    tripwireCount(pool, appId),
  ]);
  return {
    proposals_per_app: Math.max(0, PROPOSALS_PER_APP_CAP - proposals),
    question_tripwire: Math.max(0, QUESTION_TRIPWIRE_PER_DAY - questions),
  };
}

// Errors that mean "this app cannot be worked right now", as opposed to
// "this turn failed". They are refusals: no turn ran, nothing was spent,
// and the queue row is untouched. Writing a verdict row for one is how two
// thirds of the first day's ledger became noise.
const REFUSAL_ERRORS = new Set(['session_busy']);

// How long after a budget stop an empty reply on the same session is read
// as collateral from the kill rather than as the turn's own answer (#2870).
// The two observed cases landed within one second of the stop; a minute
// leaves room for a slower kill without swallowing a later genuine failure.
const STOP_SETTLE_MS = 60 * 1000;

/** Whether this app is inside a backoff window, and how long is left. */
function backoffFor(appId, now = Date.now()) {
  const entry = appBackoff.get(Number(appId));
  if (!entry || entry.until <= now) return null;
  return { ...entry, remainingMs: entry.until - now };
}

/** Double this app's backoff, from 2 minutes up to an hour. */
function noteRefusal(appId, error, now = Date.now()) {
  const id = Number(appId);
  const prior = appBackoff.get(id);
  const attempts = (prior?.attempts || 0) + 1;
  const delay = Math.min(BACKOFF_BASE_MS * (2 ** (attempts - 1)), BACKOFF_CEILING_MS);
  appBackoff.set(id, { attempts, until: now + delay, error, at: now });
  return { attempts, delayMs: delay };
}

/** A turn got through for this app, so the next refusal starts from 2 min. */
function clearRefusals(appId) {
  appBackoff.delete(Number(appId));
}

/**
 * A platform fault, said the way the dashboard should say it (#3122). The
 * quota refusal arrives as a Kubernetes Status body several hundred
 * characters long; what anyone needs from it is which quota is full.
 */
function summarizeFault(error) {
  const text = String(error || '').replace(/\s+/g, ' ').trim();
  if (/exceeded quota/i.test(text)) {
    return /persistentvolumeclaims|requests\.storage/i.test(text)
      ? 'the worker storage quota is full'
      : 'a worker quota is full';
  }
  return clip(text, 160) || 'unknown platform fault';
}

/** Whether the bot is inside a platform-fault backoff, and for how long. */
function faultBackoff(now = Date.now()) {
  if (!platformFault || platformFault.until <= now) return null;
  return { ...platformFault, remainingMs: platformFault.until - now };
}

/** Double the bot-wide backoff, from 2 minutes up to an hour. */
function noteFault(error, now = Date.now()) {
  const attempts = (platformFault?.attempts || 0) + 1;
  const delayMs = Math.min(BACKOFF_BASE_MS * (2 ** (attempts - 1)), BACKOFF_CEILING_MS);
  platformFault = { attempts, until: now + delayMs, error: summarizeFault(error), at: now };
  return { attempts, delayMs, summary: platformFault.error };
}

/**
 * The same fault the current streak already recorded. A retry that fails
 * the same way is logged, not written to the ledger again: one row says
 * the bot hit it, and the loop line says it is still waiting.
 */
function isRepeatFault(error) {
  return !!platformFault && platformFault.error === summarizeFault(error);
}

/** A turn ran, so the platform is fine again. */
function clearFault() {
  platformFault = null;
}

/**
 * Free the worker volumes the bot's own sessions still hold (#3122).
 *
 * Every Kubernetes worker used to claim a 5Gi volume, and the bot keeps one
 * session per app, paused forever, so every app it ever triaged held one:
 * 26 of the namespace's 120 when the quota refused everybody's workers.
 * The bot has needed no persistent storage since each issue got a fresh
 * thread (#3036), and its workers now start on temporary storage, so what
 * is left is only what it claimed before. A volume is freed only when no
 * worker Deployment for that session exists, so a warm worker is never
 * pulled from under a turn; its volume goes on a later sweep, once the
 * worker has idled out.
 */
async function releaseBotVolumes(pool, bot, deps = {}) {
  const worker = deps.worker || require('./worker');
  if (typeof worker.listWorkerVolumes !== 'function') return [];
  const volumes = await worker.listWorkerVolumes();
  const detached = (volumes || []).filter((v) => !v.attached && !v.terminating
    && Number.isSafeInteger(Number(v.sessionId)));
  if (!detached.length) return [];
  const { rows } = await pool.query(
    'SELECT id FROM chat_sessions WHERE user_id = $1 AND id = ANY($2::int[])',
    [bot.id, detached.map((v) => Number(v.sessionId))],
  );
  const mine = new Set(rows.map((r) => Number(r.id)));
  const freed = [];
  for (const volume of detached) {
    const sessionId = Number(volume.sessionId);
    if (!mine.has(sessionId)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await worker.destroyCcVolume(sessionId);
      freed.push(sessionId);
    } catch (err) {
      log.warn('homeroom-bot', 'Could not free a bot worker volume', { sessionId, err: err.message });
    }
  }
  if (freed.length) log.info('homeroom-bot', 'Freed bot worker volumes', { sessionIds: freed });
  return freed;
}

/** This session's container was just killed on a budget stop (#2870). */
function noteStopped(sessionId, now = Date.now()) {
  stoppedSessions.set(Number(sessionId), now);
}

/**
 * Whether a stop on this session is recent enough to explain an empty reply.
 *
 * Deliberately generous: the window costs a requeue when it is wrong, and
 * costs an issue its triage when it is too short. Entries older than the
 * window are dropped on read, so the map cannot grow without bound.
 */
function wasStoppedRecently(sessionId, now = Date.now()) {
  const id = Number(sessionId);
  for (const [key, at] of stoppedSessions) {
    if (now - at > STOP_SETTLE_MS) stoppedSessions.delete(key);
  }
  const at = stoppedSessions.get(id);
  return at != null && now - at <= STOP_SETTLE_MS;
}

/**
 * What a turn used, from the relay's per-request sum, and what that costs
 * at the turn's catalog price (#3038). Null when the relay saw no request
 * finish; `costUsd` is null when the turn had no pricing snapshot.
 */
function relaySpend(relayUsage, pricing, agentTurn) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const requests = count(relayUsage?.requests);
  if (!requests) return null;
  const inputTokens = count(relayUsage.inputTokens) ?? 0;
  const outputTokens = count(relayUsage.outputTokens) ?? 0;
  const { estimatedCostUsd } = agentTurn.estimateRequestedModelCost({ inputTokens, outputTokens }, pricing);
  return {
    requests, inputTokens, outputTokens,
    costUsd: Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : null,
  };
}

/**
 * Why a turn came back with nothing (#2870).
 *
 * The worker's watch state is what `execInWorker` returns, and it already
 * carries the provider's own account of how the turn ended. None of it was
 * being recorded, so an empty reply reached the ledger as the bare string
 * `(empty reply)` — 21 of the first 225 runs, with no way to tell a
 * provider refusal from a rate limit from a container that died. Anything
 * non-null here is worth more than the guess it replaces.
 */
function describeStop(result) {
  const parts = [];
  const add = (label, value) => {
    if (value == null || value === '') return;
    parts.push(`${label}=${clip(String(value), 120)}`);
  };
  add('subtype', result.resultSubtype);
  add('stop', result.providerStopReason);
  add('code', result.agentErrorCode);
  add('markerless', result.markerlessCause);
  if (result.agentExit != null && result.agentExit !== 0) add('agentExit', result.agentExit);
  if (result.ccExit != null && result.ccExit !== 0) add('ccExit', result.ccExit);
  add('err', result.agentError);
  return parts.length ? `[${parts.join(' ')}]` : '[no reason reported]';
}

/**
 * Clear a turn record nothing owns any more (#2737).
 *
 * `chat_sessions.active_turn` is what makes a session refuse a new turn.
 * It is cleared when a turn ends, and a turn that dies without ending is
 * recovered by adopting its worker CONTAINER — so once the container is
 * gone (idle eviction, a replaced Pod) there is nothing left to do the
 * clearing, and the session refuses every turn forever. The first day of
 * shadow triage lost an app to exactly that for over an hour.
 *
 * Narrow on purpose: the bot's own synthetic session, a record older than
 * the turn budget (so a live turn is never touched), and only when no
 * container claims the session.
 */
async function clearStaleTurn(pool, session, { worker, maxAgeMs, now = Date.now() }) {
  const { rows } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [session.id]);
  const activeTurn = rows[0]?.active_turn || null;
  if (!activeTurn) return null;
  const startedAt = toMs(activeTurn.startedAt);
  if (startedAt && now - startedAt < maxAgeMs) return null;

  let containers = [];
  try {
    containers = await worker.listOrphanWorkers();
  } catch (err) {
    log.warn('homeroom-bot', 'Could not list workers; leaving the turn record alone', { err: err.message });
    return null;
  }
  const owned = containers.some((c) => Number(c.sessionId) === Number(session.id)
    && String(c.state || '').toLowerCase() === 'running');
  if (owned) return null;

  const turnLifecycle = require('./turn-lifecycle');
  await worker.clearActiveTurn(session.id, turnLifecycle.cleanupArgs(activeTurn));
  const ageMs = startedAt ? now - startedAt : null;
  log.warn('homeroom-bot', 'Cleared a turn record no container owned', {
    sessionId: session.id, ageMs,
  });
  return { ageMs };
}

/**
 * One issue, one read-only scout turn, one ledger row. Returns
 * { ran: true, verdict } or { ran: false, reason }. `budget` is the one
 * reason the caller stops the whole pass on: the queue is left alone and
 * the loop idles until the week's allowance moves.
 */
async function runTriage(pool, config, { bot, app, item, mode, settings = null, deps = {} }) {
  const github = deps.github || require('./github');
  const worker = deps.worker || require('./worker');
  const agentTurn = deps.agentTurn || require('./agent-turn');
  const limits = deps.limits || require('./limits');
  const threadContext = deps.threadContext || require('./thread-context');
  const managedOpenRouter = deps.managedOpenRouter || require('./openrouter-managed-keys');
  // routes/sessions.js exports the seed builder and the per-attempt Codex
  // ledger loop. Required lazily: that module loads half the platform, and
  // this one is required by server.js before the route layer is.
  const sessions = deps.sessions || require('../routes/sessions');
  const activeWorkers = deps.activeWorkers || require('./active-workers').activeWorkers;

  const issueNumber = Number(item.issue_number);
  const startedMs = Date.now();
  // #3146: on an app in the live list the verdict is acted on, and the run
  // is recorded as 'live' so the ledger says which runs spoke.
  const liveMode = live.isLiveFor(settings, app);
  const runMode = liveMode ? 'live' : mode;
  const liveD = liveMode ? liveDeps(deps) : null;
  const turnBudgetMs = 1000 * clampInt(
    settings?.turnSeconds, DEFAULTS.turnSeconds, MIN_TURN_SECONDS, MAX_TURN_SECONDS,
  );
  const turnInputTokens = clampInt(
    settings?.turnInputTokens, DEFAULTS.turnInputTokens,
    MIN_TURN_INPUT_TOKENS, MAX_TURN_INPUT_TOKENS,
  );
  const repo = parseRepo(app.repo_url);
  const model = config.openrouterDefaultCodexModel || null;

  // A failed run is recorded either way. A MODEL failure (the turn ran and
  // produced nothing usable) consumes the queue row: retrying costs money
  // and the thread has not changed. A PLATFORM failure keeps the row, hands
  // it back to the queue, and tells the caller to stop the pass.
  // A REFUSAL is not a failure: no turn ran and nothing was spent, so it
  // gets no ledger row. The app backs off instead, and the loop line says
  // what happened.
  const recordRefusal = (error) => {
    const { attempts, delayMs } = noteRefusal(app.id, error);
    log.info('homeroom-bot', 'App refused a turn; backing off', {
      app: app.slug, issueNumber, error, attempts, delayMs,
    });
    return { ran: false, reason: 'refused', detail: error, app: app.slug, retryInMs: delayMs };
  };

  const recordFailure = async (error, extra = {}, { infra = false } = {}) => {
    if (REFUSAL_ERRORS.has(error)) return recordRefusal(error);
    // A platform fault the current streak already recorded gets no second
    // row (#3122); the retry is still logged below.
    const id = infra && isRepeatFault(error) ? null : await insertRun(pool, {
      appId: app.id, issueNumber, mode: runMode, verdict: 'failed', error,
      threadSeenAt: item.thread_seen_at || null, model,
      durationMs: Date.now() - startedMs, ...extra,
    });
    if (infra) {
      await pool.query('UPDATE homeroom_bot_queue SET started_at = NULL WHERE id = $1', [item.id]);
    } else {
      await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
    }
    log.warn('homeroom-bot', 'Triage failed', { app: app.slug, issueNumber, error, infra });
    return infra
      ? { ran: false, reason: 'infra', detail: error, runId: id }
      : { ran: true, verdict: 'failed', runId: id };
  };

  if (!repo || !github.isEnabled()) return recordFailure('github_unavailable', {}, { infra: true });

  const budget = await limits.checkBudget(pool, bot.id);
  if (budget.error) {
    log.info('homeroom-bot', 'Pass paused on budget', { reason: budget.reason || null });
    return { ran: false, reason: 'budget', detail: budget.reason || null };
  }

  await pool.query('UPDATE homeroom_bot_queue SET started_at = NOW() WHERE id = $1', [item.id]);

  const fetched = await github.fetchPublicIssue(repo.owner, repo.repo, issueNumber);
  const issue = fetched?.issue || null;
  if (!issue || (issue.state && issue.state !== 'open')) {
    await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
    return { ran: false, reason: 'not_open' };
  }
  // #3146: what this run has posted on GitHub, so its own comments are not
  // read back as a change (see homeroom-bot-live.js).
  const postedAt = [];
  if (liveMode) {
    const open = await live.openBotProposal(pool, bot.id, app.id, issueNumber);
    if (open) {
      // One proposal per issue: the group is already voting on the bot's
      // answer, and a second build would be a second, competing proposal.
      await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
      log.info('homeroom-bot', 'Issue already has a bot proposal; not looking again', {
        app: app.slug, issueNumber, sessionId: open.id,
      });
      return { ran: false, reason: 'has_proposal' };
    }
    const looked = await live.post({
      pool, github, ws: liveD.ws, app, repo, issueNumber,
      kind: 'looking', text: live.lookingText(),
    }).catch((err) => {
      log.warn('homeroom-bot', 'Looking post failed (continuing)', { app: app.slug, issueNumber, err: err.message });
      return null;
    });
    if (looked?.githubCreatedAt) postedAt.push(looked.githubCreatedAt);
  }
  const seedReadAt = new Date().toISOString();
  const [{ comments = [] } = {}, thread, botUsername] = await Promise.all([
    github.fetchIssueComments(repo.owner, repo.repo, issueNumber).catch(() => ({ comments: [] })),
    threadContext.loadIssueThread(pool, app.id, issueNumber),
    // Resolved, never the Promise: see live.botUsernameOf.
    live.botUsernameOf(github),
  ]);
  const seed = sessions.buildHeadlessSeed(
    issueNumber, issue, comments, botUsername, thread?.messages || [],
  );
  const prompt = [
    seed, triagePrompt(), triageReference(), triageClosing(issueNumber),
  ].join('\n\n');

  let session;
  try {
    session = await ensureBotSession(pool, config, bot, app);
  } catch (err) {
    return recordFailure(`session: ${err.message}`, {}, { infra: true });
  }

  let containerName = null;
  try {
    await worker.ensureWorkerImage();
    containerName = await worker.ensureWorker(session.id, {
      repoOwner: repo.owner, repoName: repo.repo, branchName: session.branch_name,
      // Scratch storage, not a volume (#3122, using #3119's option). Every
      // issue starts a fresh thread, so nothing on the worker needs to
      // outlive it, and a volume per app is what filled the quota.
      temporary: true,
      onProgress: () => {},
    });
  } catch (err) {
    return recordFailure(`worker: ${err.message}`, { sessionId: session.id }, { infra: true });
  }

  // A turn record nothing owns any more would refuse every turn from here
  // on. Checked after the container is up, so a live turn is never touched.
  await clearStaleTurn(pool, session, { worker, maxAgeMs: turnBudgetMs })
    .catch((err) => log.warn('homeroom-bot', 'Stale turn check failed', { err: err.message }));

  // A fresh model conversation for every issue (#3035). Passing a null
  // thread below is NOT enough: the platform reads null as "carry on the
  // session's saved thread" (resolveCodexRuntimeContext falls back to
  // `session.agent_thread_id`, the attempt loop to the runtime's thread),
  // and every finished turn saves its thread back. So the bot's one session
  // per app was one conversation per app — the Homeroom app's ran from
  // 2026-09-21 onward, every issue triaged with all the earlier ones in
  // context, its usage a running total that passed 2.7 billion tokens.
  // Clearing the saved thread here, in the row and in the object the
  // runtime is resolved from, is what makes every path resolve to none.
  await pool.query(
    "UPDATE chat_sessions SET status = 'active', agent_thread_id = NULL, last_activity_at = NOW() WHERE id = $1",
    [session.id],
  );
  session.agent_thread_id = null;
  activeWorkers.add(session.id);

  // The budget (#2737). The wall clock ends the turn the same way a person's
  // Stop button does: the in-container kill plus the journal exit marker,
  // which the attempt loop below resolves on within milliseconds.
  let budgetHit = null;
  // The kill in flight, awaited before this function returns (#3035). It
  // used to be fire-and-forget, and the next issue starts in the same
  // container the moment this one returns: a kill still landing takes that
  // issue down one to three seconds in.
  let stopping = null;
  const spendBudget = (kind) => {
    if (budgetHit) return;
    budgetHit = kind;
    log.warn('homeroom-bot', 'Triage turn stopped on its budget', {
      app: app.slug, issueNumber, kind, sessionId: session.id,
    });
    // Recorded BEFORE the kill, not after it: the bystander dispatch this
    // protects has already failed by the time stopTurn resolves (#2870).
    noteStopped(session.id);
    stopping = Promise.resolve(worker.stopTurn(session.id)).catch((err) => {
      log.warn('homeroom-bot', 'Budget stop failed', { sessionId: session.id, err: err.message });
    });
  };
  const budgetTimer = setTimeout(() => spendBudget('wall clock'), turnBudgetMs);
  if (typeof budgetTimer.unref === 'function') budgetTimer.unref();

  let routed;
  // The turn's pricing snapshot, as the runtime resolved it, so a turn the
  // ledger could not price is priced from the same catalog (#3038).
  let pricing = null;
  try {
    routed = await sessions.runCodexAttemptLoop({
      pool, session, userId: bot.id, config, isCodexSession: true,
      turnModel: model, resumeThreadId: null, mode: 'scout',
      telemetryComponent: 'homeroom_bot_triage',
      resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
        pool, session, userId: bot.id, model, resumeThreadId: null, config,
      }),
      dispatchOnce: (ctx) => { pricing = ctx?.pricingSnapshot || pricing; return worker.execInWorker(session.id, {
        mode: 'scout',
        // No `onUsage` here, deliberately (#3035). Neither agent the bot can
        // run reports usage until its turn is over, so a token check wired
        // to the stop can only ever fire on a finished turn — and did, on
        // every one, discarding the verdict and killing the next issue. The
        // token limit is read after the turn instead, below, and never
        // throws a result away. The wall clock is what ends a runaway.
        prompt,
        model,
        commitMsg: '',
        resumeSessionId: null,
        branchName: session.branch_name,
        ...(ctx || {}),
        telemetryComponent: 'homeroom_bot_triage',
        onProgress: () => {},
      }); },
      retryPredicate: () => null,
      sendStatus: async () => {},
      waitForStopped: async () => {},
      prepareRetry: async () => false,
      classifyAttemptStatus: ({ failed }) => (failed ? 'failed' : 'completed'),
      containerName,
    });
  } catch (err) {
    routed = { error: `dispatch: ${err.message}` };
  } finally {
    clearTimeout(budgetTimer);
    if (stopping) await stopping;
    activeWorkers.delete(session.id);
    await pool.query(
      "UPDATE chat_sessions SET status = 'paused', last_activity_at = NOW() WHERE id = $1",
      [session.id],
    ).catch(() => {});
  }

  // What the turn spent, read ONCE and read null-safely, because both the
  // stopped path and the completed path below need it (#2870). The debit
  // used to live only on the completed path, under a `return` the budget
  // branch took first, so the turns that wasted the most were the only ones
  // the weekly cap never saw.
  const result = (routed && routed.result) || {};
  const ledgerCostUsd = Number.isFinite(routed && routed.estimatedCostUsd)
    ? routed.estimatedCostUsd
    : null;
  // When the ledger has no figure — always, for a turn stopped before
  // turn.completed — fall back to what the relay saw each model request use
  // (#3038), priced by the same estimator the ledger uses for a finished
  // turn, so a stopped turn and a finished one are measured alike. It is a
  // floor: the request in flight at the stop never reports.
  const relay = relaySpend(result.relayUsage, pricing, agentTurn);
  const costUsd = ledgerCostUsd ?? relay?.costUsd ?? null;
  const usage = {
    inputTokens: Number.isFinite(result.inputTokens) ? result.inputTokens : (relay?.inputTokens ?? null),
    outputTokens: Number.isFinite(result.outputTokens) ? result.outputTokens : (relay?.outputTokens ?? null),
  };
  if (ledgerCostUsd == null && relay) {
    log.info('homeroom-bot', 'Turn priced from the relay: the agent reported no usage', {
      app: app.slug, issueNumber, stopped: budgetHit || null, costUsd: relay.costUsd,
      requests: relay.requests, inputTokens: relay.inputTokens, outputTokens: relay.outputTokens,
    });
  } else if (relay && Number.isFinite(result.inputTokens)) {
    // Both figures exist on a finished turn. With a fresh thread per issue
    // they should agree; this is how production confirms the relay figure
    // before anything relies on it for a turn that did not finish.
    log.info('homeroom-bot', 'Turn usage: agent total vs relay sum', {
      app: app.slug, issueNumber, agentInputTokens: result.inputTokens, relayInputTokens: relay.inputTokens,
      agentOutputTokens: result.outputTokens ?? null, relayOutputTokens: relay.outputTokens,
      requests: relay.requests,
    });
  }

  // #2571: an included (company-funded) key's spend joins the shared weekly
  // pool the budget gate above measures; a personal key would be nobody's
  // to debit, and the bot never has one.
  if (costUsd > 0) {
    try {
      if (await managedOpenRouter.usesIncludedKey(pool, bot.id)) {
        await limits.recordSpend(pool, bot.id, Math.round(costUsd * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('homeroom-bot', 'Spend debit failed', { err: err.message });
    }
  }

  // The token budget, observed rather than enforced (#2870, #3035). Usage
  // arrives once, when the turn is already over, so there is nothing left
  // to stop and the verdict is kept — but a turn that ran away is worth
  // saying out loud. With a fresh thread per issue this is the turn's own
  // usage; before #3035 it was the conversation's running total, which is
  // why it read in the billions. The wall clock is what bounds a turn.
  if (!budgetHit && usage.inputTokens != null && usage.inputTokens > turnInputTokens) {
    log.warn('homeroom-bot', 'Triage turn finished over its token budget', {
      app: app.slug, issueNumber, inputTokens: usage.inputTokens, budget: turnInputTokens,
    });
  }

  // A turn we stopped ourselves. Recorded as a failure so the ledger shows
  // what it cost, then requeued ONCE at the back — the runaway may have
  // been the issue rather than the bot, and retrying it forever is the loop
  // this whole change exists to end.
  if (budgetHit) {
    const retried = String(item.reason || '') === 'budget_retry';
    const id = await insertRun(pool, {
      appId: app.id, issueNumber, sessionId: session.id, mode: runMode, verdict: 'failed',
      error: `budget: ${budgetHit}`, budgetStop: budgetHit,
      threadSeenAt: item.thread_seen_at || null, model,
      costUsd, ...usage,
      durationMs: Date.now() - startedMs,
    });
    if (retried) {
      await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
    } else {
      await pool.query(
        `UPDATE homeroom_bot_queue
            SET started_at = NULL, reason = 'budget_retry', priority = 9, enqueued_at = NOW()
          WHERE id = $1`,
        [item.id],
      );
    }
    log.warn('homeroom-bot', 'Triage stopped on its budget', {
      app: app.slug, issueNumber, kind: budgetHit, requeued: !retried, runId: id,
    });
    return { ran: true, verdict: 'failed', runId: id, budget: budgetHit };
  }

  if (!routed) return recordFailure('not_a_codex_session', { sessionId: session.id }, { infra: true });
  if (routed.error) {
    const code = String(routed.error);
    // A turn that died mid-flight on a previous process leaves active_turn
    // set on the bot's own session, and nothing else will ever clear it.
    if (code === 'session_busy' && !worker.isInFlight(session.id)) {
      await worker.clearActiveTurn(session.id).catch(() => {});
    }
    return recordFailure(code, { sessionId: session.id }, { infra: INFRA_ERRORS.has(code) || code.startsWith('dispatch:') });
  }
  const text = String(result.lastResultText || '');
  const parsed = parseVerdict(text);
  if (!parsed) {
    const body = clip(text.slice(-300), 300);
    if (!body) {
      // An empty reply right after a stop on this session is almost always
      // collateral, not a verdict the bot failed to parse: stopTurn kills
      // the session's container, and an issue dispatched into it
      // concurrently dies with it. Two of the first three budget stops took
      // a bystander issue down this way, each recorded as a permanent parse
      // failure a second after the stop. Put that issue back on the queue
      // instead of burning its triage on somebody else's timeout.
      if (!budgetHit && wasStoppedRecently(session.id)) {
        return recordFailure('collateral: the session was stopped mid-dispatch', {
          sessionId: session.id, costUsd, ...usage,
        }, { infra: true });
      }
      // Otherwise say WHY it was empty. The worker's watch state already
      // knows — it was simply being thrown away, which left 21 of the first
      // 225 runs recorded as `(empty reply)` and nothing else.
      return recordFailure(`unparseable: (empty reply) ${describeStop(result)}`, {
        sessionId: session.id, costUsd, ...usage,
      });
    }
    return recordFailure(`unparseable: ${body}`, {
      sessionId: session.id, costUsd, ...usage,
    });
  }
  const capSuppressed = await simulateCaps(pool, bot, app.id, parsed.verdict);
  const runId = await insertRun(pool, {
    appId: app.id, issueNumber, sessionId: session.id, mode: runMode,
    verdict: parsed.verdict, determined: parsed.determined, missingFact: parsed.missingFact,
    question: parsed.question, questionDefault: parsed.questionDefault,
    buildNote: parsed.buildNote, reason: parsed.reason, capSuppressed,
    threadSeenAt: item.thread_seen_at || null, model, costUsd,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    durationMs: Date.now() - startedMs,
  });
  await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
  clearRefusals(app.id);
  log.info('homeroom-bot', 'Triaged', {
    app: app.slug, issueNumber, verdict: parsed.verdict, costUsd, runId,
  });
  let acted = null;
  if (liveMode) {
    try {
      acted = await actOnVerdict({
        pool, config, bot, app, repo, issueNumber, issue, parsed, capSuppressed, runId,
        seed, seedReadAt, postedAt, turnBudgetMs, model,
        deps: {
          github, worker, agentTurn, limits, threadContext, managedOpenRouter, sessions,
          activeWorkers, ...liveD,
        },
      });
    } catch (err) {
      log.error('homeroom-bot', 'Acting on a live verdict failed', { app: app.slug, issueNumber, err: err.message });
    }
  }
  return { ran: true, verdict: parsed.verdict, runId, ...(acted ? { acted } : {}) };
}

/**
 * #3146: what a live verdict does. Posts to the issue, builds and proposes
 * a ready request, then records what the bot has seen so its own comments
 * are not read back as a change. A verdict the live caps hold back posts
 * one line saying so (#3152), and only when that same line is not already
 * the bot's newest post there: a held issue is retried whenever its cap has
 * room, and a retry that is held again has nothing new to say.
 */
async function actOnVerdict({
  pool, config, bot, app, repo, issueNumber, issue, parsed, capSuppressed, runId,
  seed, seedReadAt, postedAt, turnBudgetMs, model, deps,
}) {
  const { github, ws } = deps;
  const say = async (kind, text, extra = {}) => {
    const posted = await live.post({ pool, github, ws, app, repo, issueNumber, kind, runId, text, ...extra });
    if (posted?.githubCreatedAt) postedAt.push(posted.githubCreatedAt);
    return posted;
  };
  let acted = capSuppressed ? 'held' : parsed.verdict;
  if (capSuppressed) {
    const kind = live.heldKind(capSuppressed);
    const already = await live.lastPostKind(pool, app.id, issueNumber) === kind;
    log.info('homeroom-bot', 'Live verdict held by a cap', {
      app: app.slug, issueNumber, verdict: parsed.verdict, cap: capSuppressed, noted: !already,
    });
    if (!already) {
      await say(kind, live.heldText({
        cap: capSuppressed,
        verdict: parsed.verdict,
        limit: capSuppressed === 'proposals_per_app' ? PROPOSALS_PER_APP_CAP : QUESTION_TRIPWIRE_PER_DAY,
      }));
    }
  } else if (parsed.verdict === 'question') {
    await say('question', live.questionText(parsed));
  } else if (parsed.verdict === 'person') {
    await say('person', live.personText(parsed));
  } else if (parsed.verdict === 'empty') {
    await say('empty', live.emptyText(parsed));
  } else if (parsed.verdict === 'ready') {
    const built = await live.buildAndPropose({
      pool, config, bot, app, repo, issueNumber, issue, seed, buildNote: parsed.buildNote,
      turnBudgetMs, model, deps,
    });
    if (built.costUsd > 0) {
      try {
        if (await deps.managedOpenRouter.usesIncludedKey(pool, bot.id)) {
          await deps.limits.recordSpend(pool, bot.id, Math.round(built.costUsd * 1e6) / 1e4, { byok: false });
        }
      } catch (err) {
        log.warn('homeroom-bot', 'Build spend debit failed', { err: err.message });
      }
    }
    if (built.ok) {
      acted = 'proposed';
      await pool.query(
        'UPDATE homeroom_bot_runs SET proposal_session_id = $2 WHERE id = $1',
        [runId, built.sessionId],
      ).catch(() => {});
      // The vote-card metadata the promote route's own activity rows carry,
      // so the issue's thread shows the live proposal card, not only a link.
      await say('proposal', live.proposalText({
        link: live.proposalLink(deps.domain, app.slug, built.sessionId), prNumber: built.prNumber,
      }), { msgType: 'vote', metadata: { vote: { sessionId: built.sessionId, prNumber: built.prNumber } } });
    } else {
      acted = 'build_failed';
      log.warn('homeroom-bot', 'Live build did not become a proposal', {
        app: app.slug, issueNumber, sessionId: built.sessionId || null, error: built.error,
      });
      await say('build_failed', live.buildFailedText(built.error));
    }
  }
  await live.advanceSeen({
    pool, github, threadContext: deps.threadContext, app, repo, issueNumber, runId,
    since: seedReadAt, postedAt,
  }).catch((err) => log.warn('homeroom-bot', 'Could not record what the bot has seen', { err: err.message }));
  return acted;
}

// Resolved lazily, and only for a live app: ws and session-lifecycle load
// half the platform. Each is injectable for the tests.
function liveDeps(deps = {}) {
  return {
    ws: deps.ws || require('./ws'),
    sessionLifecycle: deps.sessionLifecycle || require('./session-lifecycle'),
    domain: deps.domain || require('./caddy').USERNODE_DOMAIN,
    votesRouter: deps.votesRouter || null,
  };
}

// ── The work loop ───────────────────────────────────────────────────────

/**
 * One pass: take the loop lock, refresh the queue when due, drain up to
 * `concurrency` app batches, release. Returns what it did so a test can
 * drive it directly and so the scheduler knows whether to come straight
 * back or idle. Never throws.
 */
async function runOnce(pool, config, deps = {}) {
  const out = { mode: null, busy: false, refreshed: false, processed: 0, paused: null };
  let client;
  let locked = false;
  try {
    client = await pool.connect();
    const lock = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired', [HOMEROOM_BOT_LOCK, 0],
    );
    if (lock.rows[0]?.acquired !== true) { out.busy = true; return out; }
    locked = true;

    const settings = await readSettings(pool);
    out.mode = settings.mode;
    if (settings.mode === 'off') return out;

    // Before anything is picked: a row an unfinished pass claimed is free again.
    out.releasedClaims = await releaseStaleClaims(pool, settings);

    const now = deps.now ? deps.now() : Date.now();
    // Take the wakes that arrived before this pass. Ones that arrive DURING
    // it are left for the next, which tick() schedules at once.
    const targeted = [...pendingApps];
    pendingApps.clear();
    const forceAll = !!deps.forceRefresh || refreshAllRequested;
    refreshAllRequested = false;
    wakeRequested = false;
    // Before the refresh: on a live app it asks how much room the caps have
    // for the bot's held issues (#3152).
    const bot = await ensureBotUser(pool, config);
    if (forceAll || now - lastRefreshAt >= REFRESH_INTERVAL_MS) {
      const summary = await refreshQueue(pool, settings, { ...deps, bot });
      lastRefreshAt = now;
      out.refreshed = true;
      if (summary.queued) log.info('homeroom-bot', 'Queue refreshed', summary);
    } else if (targeted.length) {
      const summary = await refreshApps(pool, settings, targeted, { ...deps, bot });
      out.refreshed = true;
      out.woken = targeted.length;
      if (summary.queued) log.info('homeroom-bot', 'Queue refreshed on activity', summary);
    }

    // Free what the bot's own sessions still hold, on the refresh cadence
    // (#3122). Runs before the fault check on purpose: a full quota is
    // exactly when freeing a volume helps.
    if (now - lastVolumeSweepAt >= REFRESH_INTERVAL_MS) {
      lastVolumeSweepAt = now;
      try {
        const freed = await releaseBotVolumes(pool, bot, deps);
        if (freed.length) out.volumesFreed = freed.length;
      } catch (err) {
        log.warn('homeroom-bot', 'Bot volume sweep failed', { err: err.message });
      }
    }

    // Inside a platform-fault backoff nothing is dispatched (#3122). A wake
    // still refreshes the queue above, but cannot restart the retry storm.
    const fault = faultBackoff(now);
    if (fault) {
      out.paused = 'infra';
      out.detail = fault.error;
      out.retryInMs = fault.remainingMs;
      return out;
    }

    // An app inside its backoff window is skipped exactly like a paused one
    // (#2737). Without this, a session that refuses every turn is retried on
    // every wake, which is how one wedged app wrote 121 rows in a day.
    const backedOff = [];
    for (const [appId] of appBackoff) {
      if (backoffFor(appId, now)) backedOff.push(Number(appId));
      else appBackoff.delete(appId);
    }
    out.backedOffApps = backedOff.length;
    const taken = [...backedOff];
    const batches = [];
    for (let i = 0; i < settings.concurrency; i += 1) {
      const batch = await nextBatch(pool, {
        batchSize: settings.batchSize, excludeAppIds: taken, pausedApps: settings.pausedApps,
      });
      if (!batch || !batch.app) break;
      taken.push(batch.app.id);
      batches.push(batch);
    }
    if (!batches.length) return out;

    const refusals = [];
    const budgets = [];
    const results = await Promise.all(batches.map(async (batch) => {
      let processed = 0;
      for (const item of batch.items) {
        if (stopped) break;
        // Re-read the mode between issues so "off" stops a batch mid-way.
        const live = await readSettings(pool);
        if (live.mode === 'off') { out.paused = 'mode_off'; break; }
        let r;
        try {
          r = await runTriage(pool, config, {
            bot, app: batch.app, item, mode: live.mode, settings: live, deps,
          });
        } catch (err) {
          log.error('homeroom-bot', 'Triage threw', { app: batch.app.slug, issueNumber: item.issue_number, err: err.message });
          await recordThrownTriage(pool, { app: batch.app, item, settings: live, err });
          r = { ran: false, reason: 'threw' };
        }
        if (r.ran) { processed += 1; clearFault(); }
        if (r.budget) budgets.push({ app: batch.app.slug, issueNumber: item.issue_number, kind: r.budget });
        if (r.reason === 'budget') { out.paused = 'budget'; break; }
        // A refusal moves on to the next APP rather than stopping the pass:
        // the others are not wedged just because this one is.
        if (r.reason === 'refused') {
          refusals.push({ app: r.app, error: r.detail, retryInMs: r.retryInMs });
          break;
        }
        if (r.reason === 'infra') {
          const fault = noteFault(r.detail);
          log.warn('homeroom-bot', 'Platform fault; the bot backs off', {
            app: batch.app.slug, issueNumber: item.issue_number, fault: fault.summary,
            attempts: fault.attempts, retryInMs: fault.delayMs,
          });
          out.paused = 'infra';
          out.detail = fault.summary;
          out.retryInMs = fault.delayMs;
          break;
        }
      }
      return processed;
    }));
    out.processed = results.reduce((a, b) => a + b, 0);
    out.refusals = refusals;
    out.budgets = budgets;
    lastRefusals = refusals;
    return out;
  } catch (err) {
    log.error('homeroom-bot', 'Pass failed', { err: err.message });
    return out;
  } finally {
    lastPass = { at: new Date().toISOString(), ...out };
    if (client) {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [HOMEROOM_BOT_LOCK, 0]).catch(() => {});
      }
      client.release();
    }
  }
}

function schedule(config, delayMs) {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; tick(config); }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

async function tick(config) {
  if (stopped || passInFlight) return;
  passInFlight = true;
  let delay = IDLE_PASS_DELAY_MS;
  try {
    const { getPool } = require('../db/pool');
    const out = await runOnce(getPool(config), config);
    if (out.processed > 0 && !out.paused && out.mode !== 'off') delay = BUSY_PASS_DELAY_MS;
    // A platform fault waits out its backoff rather than the 30-second idle.
    if (out.paused === 'infra' && out.retryInMs > 0) delay = Math.max(IDLE_PASS_DELAY_MS, out.retryInMs);
    // A wake that landed while this pass ran is not made to wait out the
    // idle delay; a pass that paused (budget, fault) is not spun by it.
    if (wakeRequested && !out.paused && out.mode !== 'off') delay = 0;
  } catch (err) {
    log.error('homeroom-bot', 'Tick failed', { err: err.message });
  } finally {
    passInFlight = false;
    schedule(config, delay);
  }
}

/** Started from becomeLeader(): the loop is a singleton across Pods. */
function start(config) {
  if (timer) return;
  stopped = false;
  loopConfig = config;
  schedule(config, FIRST_PASS_DELAY_MS);
}

function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

// ── Wakes ────────────────────────────────────────────────────────────────
//
// The loop runs on the leader Pod only; an issue event can land on any Pod.
// So a wake has two halves: the local one (below) records what changed and
// pulls the next pass forward, and the bus half tells the other Pods the
// same thing — the leader among them does the local half on receipt. A Pod
// that is not running the loop records nothing, so the pending set cannot
// grow on the Pods that never drain it.

/** Record that `appId`'s issues changed (or `all` did) and run a pass now. */
function wake({ appId = null, all = false } = {}) {
  const running = timer !== null || passInFlight;
  if (stopped || !running) return false;
  if (all) refreshAllRequested = true;
  else if (Number.isInteger(Number(appId)) && Number(appId) > 0) pendingApps.add(Number(appId));
  else return false;
  wakeRequested = true;
  // Idle (a timer waiting): pull the pass forward. In a pass: tick() sees
  // wakeRequested and schedules the next one at once.
  if (!passInFlight && loopConfig) schedule(loopConfig, 0);
  return true;
}

function publishWake(data) {
  try {
    require('./ws-bus').publish(BUS_KIND, null, data);
  } catch (err) {
    log.warn('homeroom-bot', 'wake publish failed', { err: err.message });
  }
}

/** The whole queue is stale (the mode was switched on): every Pod hears. */
function wakeAll() {
  wake({ all: true });
  publishWake({ all: true });
}

/**
 * An issue was filed, edited or discussed on the platform. Called from the
 * places that already know (routes/issues.js on create, ws.pushIssueUpdate
 * on edits and unclaims, ws.handleMessage on a thread post); never throws,
 * never waits — the event has already happened and the bot is a follower.
 */
function noteIssueActivity({ appId, issueNumber, reason = 'activity' } = {}) {
  const id = Number(appId);
  const n = Number(issueNumber);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(n) || n <= 0) return false;
  wake({ appId: id });
  publishWake({ appId: id, issueNumber: n, reason: String(reason).slice(0, 40) });
  return true;
}

/** ws._onBusMessage hands BUS_KIND envelopes here. */
function onBusMessage(data) {
  if (!data || typeof data !== 'object') return false;
  return wake({ appId: data.appId, all: !!data.all });
}

// ── The dashboard's read and writes ─────────────────────────────────────

const RUNS_PAGE = 50;

// One static statement, filters as nullable parameters, so the SQL lint's
// inventory stays static and the shadow database checks every column. The
// dashboard's page and the CSV export are the same query at different page
// sizes — `$3` is a keyset cursor (`id <`) over the `id DESC` order, which
// is what lets the export walk the whole ledger a chunk at a time.
const RUNS_SQL = `SELECT r.id, r.issue_number, r.mode, r.verdict, r.determined, r.missing_fact,
            r.budget_stop,
            r.question, r.question_default, r.build_note, r.reason, r.cap_suppressed,
            r.rating, r.rating_note, r.rated_at, r.thread_seen_at, r.model, r.cost_usd::float8 AS cost_usd,
            r.input_tokens, r.output_tokens, r.duration_ms, r.error, r.created_at,
            r.proposal_session_id,
            a.slug AS app_slug, a.name AS app_name, a.repo_url, u.username AS rated_by
       FROM homeroom_bot_runs r
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN users u ON u.id = r.rating_by
      WHERE ($1::text IS NULL OR a.slug = $1::text)
        AND ($2::text IS NULL OR r.verdict = $2::text)
        AND ($3::int IS NULL OR r.id < $3::int)
        AND (NOT $5::boolean OR r.budget_stop IS NOT NULL)
      ORDER BY r.id DESC
      LIMIT $4`;

/** The issue this run triaged, on GitHub. Null when the app has no repo. */
function issueUrlFor(row) {
  return row.repo_url
    ? `${String(row.repo_url).replace(/\.git$/, '')}/issues/${row.issue_number}`
    : null;
}

// The CSV's columns, in order: the whole record, so the file can answer
// questions the dashboard cannot (how often `ready` was rated wrong, what a
// verdict costs by app, which questions repeat). `repo_url` is left out —
// `issue_url` already carries it in the form a reader wants.
const EXPORT_COLUMNS = Object.freeze([
  'id', 'created_at', 'app_slug', 'app_name', 'issue_number', 'issue_url',
  'mode', 'verdict', 'determined', 'missing_fact',
  'question', 'question_default', 'build_note', 'reason', 'cap_suppressed',
  'rating', 'rating_note', 'rated_by', 'rated_at',
  'model', 'cost_usd', 'input_tokens', 'output_tokens', 'duration_ms',
  'error', 'budget_stop', 'thread_seen_at',
  // #3146: the proposal a live `ready` run opened. Last, so an analysis
  // that reads the earlier columns by position is not shifted.
  'proposal_session_id',
]);

/** One run as the values of EXPORT_COLUMNS, in that order. */
function exportRow(row) {
  const flat = { ...row, issue_url: issueUrlFor(row) };
  return EXPORT_COLUMNS.map((key) => {
    const v = flat[key];
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}

// How many rows one export query takes. Bounded so a ledger of any size
// streams in constant memory; not a cap on how many rows the file holds.
const EXPORT_CHUNK = 500;

/**
 * Every run matching the filters, oldest page last, a chunk at a time.
 *
 * Keyset paging rather than OFFSET: rows are only ever appended, so `id <`
 * the last id of the previous chunk cannot skip or repeat a row while the
 * export runs. Caller writes each chunk out and never holds the whole set.
 */
async function* iterateRunsForExport(pool, {
  app = null, verdict = null, chunk = EXPORT_CHUNK, budgetOnly = false,
} = {}) {
  const size = Math.min(Math.max(Number(chunk) || EXPORT_CHUNK, 1), 2000);
  let cursor = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await pool.query(RUNS_SQL, [app || null, verdict || null, cursor, size, !!budgetOnly]);
    if (!rows.length) return;
    yield rows;
    if (rows.length < size) return;
    cursor = rows[rows.length - 1].id;
  }
}

async function adminPayload(pool, config, {
  app = null, verdict = null, before = null, limit = RUNS_PAGE, budgetOnly = false,
} = {}) {
  const settings = await readSettings(pool);
  const limits = require('./limits');
  const managedOpenRouter = require('./openrouter-managed-keys');

  let { rows: botRows } = await pool.query(
    'SELECT id, username, weekly_limit_cents FROM users WHERE username = $1 AND is_synthetic = TRUE',
    [BOT_USERNAME],
  );
  if (!botRows.length) {
    // Nothing else creates the row until the loop's first pass in a mode
    // that is not off — which left the cap box blank and the cap write a
    // no-op on a fresh deployment. The dashboard creates it on load.
    try {
      await ensureBotUser(pool, config);
      ({ rows: botRows } = await pool.query(
        'SELECT id, username, weekly_limit_cents FROM users WHERE username = $1 AND is_synthetic = TRUE',
        [BOT_USERNAME],
      ));
    } catch (err) {
      log.warn('homeroom-bot', 'Could not create the bot user for the dashboard', { err: err.message });
    }
  }
  const botRow = botRows[0] || null;
  let bot = null;
  if (botRow) {
    let weeklySpentCents = 0;
    let hasIncludedKey = false;
    try { weeklySpentCents = await limits.getWeeklySpentCents(pool, botRow.id); } catch {}
    try { hasIncludedKey = await managedOpenRouter.usesIncludedKey(pool, botRow.id); } catch {}
    bot = {
      id: botRow.id,
      username: botRow.username,
      weeklyLimitCents: botRow.weekly_limit_cents ?? DEFAULT_WEEKLY_LIMIT_CENTS,
      weeklySpentCents,
      hasIncludedKey,
      model: config.openrouterDefaultCodexModel || null,
    };
  }

  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*)::int AS runs,
            COUNT(*) FILTER (WHERE verdict = 'question')::int AS questions,
            COUNT(*) FILTER (WHERE verdict = 'ready')::int AS ready,
            COUNT(*) FILTER (WHERE verdict = 'person')::int AS person,
            COUNT(*) FILTER (WHERE verdict = 'failed' AND budget_stop IS NULL)::int AS failed,
            COUNT(*) FILTER (WHERE budget_stop IS NOT NULL)::int AS budget_stopped,
            COUNT(*) FILTER (WHERE rating IS NOT NULL)::int AS rated,
            COUNT(*) FILTER (WHERE rating = 'yes')::int AS agreed,
            COUNT(*) FILTER (WHERE cap_suppressed IS NOT NULL)::int AS suppressed,
            COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd
       FROM homeroom_bot_runs
      WHERE created_at > NOW() - INTERVAL '7 days'`,
  );
  const t = totalRows[0] || {};
  const totals = {
    days: 7,
    runs: t.runs || 0,
    questions: t.questions || 0,
    ready: t.ready || 0,
    person: t.person || 0,
    // Failures are failures again: a turn we stopped ourselves is counted
    // separately, not as one (#2742).
    failed: t.failed || 0,
    budgetStopped: t.budget_stopped || 0,
    rated: t.rated || 0,
    agreed: t.agreed || 0,
    suppressed: t.suppressed || 0,
    costUsd: Number(t.cost_usd) || 0,
  };

  const { rows: queueRows } = await pool.query(
    `SELECT q.id, q.issue_number, q.priority, q.reason, q.enqueued_at, q.started_at,
            a.slug AS app_slug, a.name AS app_name
       FROM homeroom_bot_queue q JOIN apps a ON a.id = q.app_id
      ORDER BY q.started_at DESC NULLS LAST, q.priority, q.enqueued_at
      LIMIT 12`,
  );
  const { rows: depthRows } = await pool.query(
    'SELECT COUNT(*)::int AS depth FROM homeroom_bot_queue WHERE started_at IS NULL',
  );

  const pageSize = Math.min(Math.max(Number(limit) || RUNS_PAGE, 1), 200);
  const { rows: runRows } = await pool.query(
    RUNS_SQL,
    [app || null, verdict || null, before == null ? null : Number(before), pageSize, !!budgetOnly],
  );

  const { rows: appRows } = await pool.query(
    `SELECT slug, name FROM apps WHERE status = 'running' AND repo_url IS NOT NULL ORDER BY name`,
  );

  return {
    settings,
    modes: MODES,
    bot,
    loop: lastPass ? { ...lastPass, refusals: lastRefusals } : lastPass,
    totals,
    queue: { depth: depthRows[0]?.depth || 0, items: queueRows },
    runs: runRows.map((r) => ({ ...r, issueUrl: issueUrlFor(r) })),
    apps: appRows,
    caps: { proposalsPerApp: PROPOSALS_PER_APP_CAP, questionsPerAppPerDay: QUESTION_TRIPWIRE_PER_DAY },
  };
}

async function rateRun(pool, { id, rating, note, actorId }) {
  const runId = Number(id);
  if (!Number.isInteger(runId) || runId <= 0) return { ok: false, status: 400, error: 'Invalid run id' };
  if (rating !== null && rating !== 'yes' && rating !== 'no') {
    return { ok: false, status: 400, error: 'rating must be "yes", "no" or null' };
  }
  const cleanNote = note == null ? null : clip(String(note), 1000);
  const { rows } = await pool.query(
    `UPDATE homeroom_bot_runs
        SET rating = $2::text,
            rating_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::int END,
            rating_note = $4::text,
            rated_at = CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END
      WHERE id = $1
      RETURNING id, rating, rating_note, rated_at`,
    [runId, rating, actorId || null, cleanNote],
  );
  if (!rows.length) return { ok: false, status: 404, error: 'Run not found' };
  return { ok: true, run: rows[0] };
}

/** An admin's "run now": the issue goes to the head of the queue. */
async function enqueueNow(pool, { slug, issueNumber, actorId }) {
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, status: 400, error: 'Invalid issue number' };
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,120}$/.test(slug)) {
    return { ok: false, status: 400, error: 'Invalid app slug' };
  }
  const { rows: apps } = await pool.query(
    'SELECT id, slug FROM apps WHERE slug = $1 AND repo_url IS NOT NULL', [slug],
  );
  if (!apps.length) return { ok: false, status: 404, error: 'App not found' };
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, requested_by)
     VALUES ($1, $2, 0, 'admin', $3)
     ON CONFLICT (app_id, issue_number) DO UPDATE
       SET priority = 0, reason = 'admin', requested_by = EXCLUDED.requested_by,
           started_at = NULL, enqueued_at = NOW()
     RETURNING id, app_id, issue_number, priority, reason, enqueued_at`,
    [apps[0].id, n, actorId || null],
  );
  return { ok: true, item: rows[0] };
}

module.exports = {
  start,
  stop,
  runOnce,
  runTriage,
  refreshQueue,
  refreshApp,
  nextBatch,
  ensureBotUser,
  ensureBotSession,
  readSettings,
  writeSettings,
  validateSettingsPatch,
  parseSettings,
  adminPayload,
  iterateRunsForExport,
  exportRow,
  EXPORT_COLUMNS,
  EXPORT_CHUNK,
  rateRun,
  enqueueNow,
  wake,
  wakeAll,
  backoffFor,
  noteRefusal,
  clearRefusals,
  clearStaleTurn,
  noteStopped,
  wasStoppedRecently,
  actOnVerdict,
  summarizeFault,
  faultBackoff,
  noteFault,
  isRepeatFault,
  clearFault,
  releaseBotVolumes,
  describeStop,
  relaySpend,
  STOP_SETTLE_MS,
  BACKOFF_BASE_MS,
  BACKOFF_CEILING_MS,
  TRIPWIRE_VERDICTS,
  REFUSAL_ERRORS,
  MIN_TURN_SECONDS,
  MAX_TURN_SECONDS,
  MIN_TURN_INPUT_TOKENS,
  MAX_TURN_INPUT_TOKENS,
  KEY_TURN_SECONDS,
  KEY_TURN_INPUT_TOKENS,
  DEFAULTS,
  noteIssueActivity,
  onBusMessage,
  refreshApps,
  BUS_KIND,
  MAX_BATCH_SIZE,
  // Pure, exported for tests.
  classifyIssue,
  capRoomFor,
  parseVerdict,
  parseRepo,
  BOT_USERNAME,
  MODES,
  VERDICTS,
  KEY_MODE,
  KEY_CONCURRENCY,
  KEY_BATCH_SIZE,
  KEY_PAUSED_APPS,
  KEY_LIVE_APPS,
  DEFAULT_WEEKLY_LIMIT_CENTS,
  REFRESH_INTERVAL_MS,
  IDLE_PASS_DELAY_MS,
  BUSY_PASS_DELAY_MS,
  PROPOSALS_PER_APP_CAP,
  QUESTION_TRIPWIRE_PER_DAY,
  _resetForTests() {
    lastRefreshAt = 0; triagePromptCache = null; stopped = false; passInFlight = false; lastPass = null;
    appBackoff.clear(); lastRefusals = []; platformFault = null; lastVolumeSweepAt = 0;
    if (timer) clearTimeout(timer);
    timer = null; loopConfig = null; pendingApps.clear(); refreshAllRequested = false; wakeRequested = false;
  },
  // Test seams for the wake path.
  _pendingForTests() { return { apps: [...pendingApps], all: refreshAllRequested, wake: wakeRequested, armed: timer !== null }; },
  _armForTests(config) { stopped = false; loopConfig = config; passInFlight = false; timer = setTimeout(() => {}, 1e9); timer.unref(); },
  _setPassInFlightForTests(v) { passInFlight = !!v; },
};
