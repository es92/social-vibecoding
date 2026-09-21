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

const BOT_USERNAME = 'homeroom_bot';
const MODES = Object.freeze(['off', 'shadow', 'live']);
const VERDICTS = Object.freeze(['question', 'ready', 'person']);

const KEY_MODE = 'homeroom_bot_mode';
const KEY_CONCURRENCY = 'homeroom_bot_concurrency';
const KEY_BATCH_SIZE = 'homeroom_bot_batch_size';
const KEY_PAUSED_APPS = 'homeroom_bot_paused_apps';
const SETTING_KEYS = Object.freeze([KEY_MODE, KEY_CONCURRENCY, KEY_BATCH_SIZE, KEY_PAUSED_APPS]);

// batchSize is how many of ONE app's issues a pass takes before the loop
// looks for the most urgent app again — the fairness knob between apps, not
// a throughput cap: the loop drains continuously (see the cadence below).
// 100 means "finish the app you are on" for any realistic board.
const DEFAULTS = Object.freeze({
  mode: 'off',
  concurrency: 1,
  batchSize: 100,
  pausedApps: [],
});
const MAX_CONCURRENCY = 4;
const MAX_BATCH_SIZE = 500;

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
const QUESTION_TRIPWIRE_PER_DAY = 10;

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
  return { mode, concurrency, batchSize, pausedApps };
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
      reason: verdict === 'person' ? clip(obj.reason, 2000) : null,
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
 *   lastRun      the bot's most recent run on it ({ thread_seen_at }), or null
 *
 * `threadSeenAt` is the newest activity the bot knows of. A run is only
 * worth repeating when something happened after the last one saw it.
 */
function classifyIssue({ issue, threadLastAt = null, busy = false, lastRun = null }) {
  if (!issue || !Number.isInteger(issue.number)) return { eligible: false, reason: 'invalid' };
  if (issue.state && issue.state !== 'open') return { eligible: false, reason: 'closed' };
  if (busy) return { eligible: false, reason: 'in_progress' };
  const seenMs = Math.max(toMs(issue.updatedAt), toMs(issue.createdAt), toMs(threadLastAt));
  const threadSeenAt = seenMs ? new Date(seenMs).toISOString() : null;
  if (lastRun) {
    const lastSeenMs = toMs(lastRun.thread_seen_at);
    if (lastSeenMs && seenMs <= lastSeenMs) return { eligible: false, reason: 'unchanged', threadSeenAt };
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

async function lastRunsByIssue(pool, appId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (issue_number) issue_number, thread_seen_at, verdict, created_at
       FROM homeroom_bot_runs
      WHERE app_id = $1
      ORDER BY issue_number, created_at DESC`,
    [appId],
  );
  return new Map(rows.map((r) => [Number(r.issue_number), r]));
}

/**
 * One refresh of one app's slice of the queue. Returns what it did so a
 * test can drive it directly. `github` is injectable for the same reason.
 */
async function refreshApp(pool, app, { github = require('./github') } = {}) {
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
  for (const issue of issues) {
    const n = Number(issue.number);
    const verdict = classifyIssue({
      issue,
      threadLastAt: threads.get(n) || null,
      busy: busy.has(n),
      lastRun: lastRuns.get(n) || null,
    });
    if (verdict.eligible) eligible.push({ n, ...verdict });
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
      const r = await refreshApp(pool, app, deps);
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
      const r = await refreshApp(pool, app, deps);
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
        input_tokens, output_tokens, duration_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING id`,
    [run.appId, run.issueNumber, run.sessionId || null, run.mode, run.verdict,
      run.determined ?? null, run.missingFact || null, run.question || null,
      run.questionDefault || null, run.buildNote || null, run.reason || null,
      run.capSuppressed || null, run.threadSeenAt || null, run.model || null,
      run.costUsd ?? null, run.inputTokens ?? null, run.outputTokens ?? null,
      run.durationMs ?? null, run.error ? clip(run.error, MAX_ERROR_CHARS) : null],
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
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM chat_sessions
        WHERE app_id = $1 AND user_id = $2 AND status IN ('promoted', 'merging')`,
      [appId, bot.id],
    );
    if ((rows[0]?.cnt || 0) >= PROPOSALS_PER_APP_CAP) return 'proposals_per_app';
  }
  if (verdict === 'question') {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM homeroom_bot_runs
        WHERE app_id = $1 AND verdict = 'question'
          AND created_at > NOW() - INTERVAL '24 hours'`,
      [appId],
    );
    if ((rows[0]?.cnt || 0) >= QUESTION_TRIPWIRE_PER_DAY) return 'question_tripwire';
  }
  return null;
}

/**
 * One issue, one read-only scout turn, one ledger row. Returns
 * { ran: true, verdict } or { ran: false, reason }. `budget` is the one
 * reason the caller stops the whole pass on: the queue is left alone and
 * the loop idles until the week's allowance moves.
 */
async function runTriage(pool, config, { bot, app, item, mode, deps = {} }) {
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
  const repo = parseRepo(app.repo_url);
  const model = config.openrouterDefaultCodexModel || null;

  // A failed run is recorded either way. A MODEL failure (the turn ran and
  // produced nothing usable) consumes the queue row: retrying costs money
  // and the thread has not changed. A PLATFORM failure keeps the row, hands
  // it back to the queue, and tells the caller to stop the pass.
  const recordFailure = async (error, extra = {}, { infra = false } = {}) => {
    const id = await insertRun(pool, {
      appId: app.id, issueNumber, mode, verdict: 'failed', error,
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
  const [{ comments = [] } = {}, thread] = await Promise.all([
    github.fetchIssueComments(repo.owner, repo.repo, issueNumber).catch(() => ({ comments: [] })),
    threadContext.loadIssueThread(pool, app.id, issueNumber),
  ]);
  const seed = sessions.buildHeadlessSeed(
    issueNumber, issue, comments, github.getBotUsername(), thread?.messages || [],
  );
  const prompt = `${seed}\n\n${triagePrompt()}`;

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
      onProgress: () => {},
    });
  } catch (err) {
    return recordFailure(`worker: ${err.message}`, { sessionId: session.id }, { infra: true });
  }

  await pool.query(
    "UPDATE chat_sessions SET status = 'active', last_activity_at = NOW() WHERE id = $1",
    [session.id],
  );
  activeWorkers.add(session.id);
  let routed;
  try {
    routed = await sessions.runCodexAttemptLoop({
      pool, session, userId: bot.id, config, isCodexSession: true,
      turnModel: model, resumeThreadId: null, mode: 'scout',
      telemetryComponent: 'homeroom_bot_triage',
      resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
        pool, session, userId: bot.id, model, resumeThreadId: null, config,
      }),
      dispatchOnce: (ctx) => worker.execInWorker(session.id, {
        mode: 'scout',
        prompt,
        model,
        commitMsg: '',
        resumeSessionId: null,
        branchName: session.branch_name,
        ...(ctx || {}),
        telemetryComponent: 'homeroom_bot_triage',
        onProgress: () => {},
      }),
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
    activeWorkers.delete(session.id);
    await pool.query(
      "UPDATE chat_sessions SET status = 'paused', last_activity_at = NOW() WHERE id = $1",
      [session.id],
    ).catch(() => {});
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
  const result = routed.result || {};
  const costUsd = Number.isFinite(routed.estimatedCostUsd) ? routed.estimatedCostUsd : null;
  const usage = {
    inputTokens: Number.isFinite(result.inputTokens) ? result.inputTokens : null,
    outputTokens: Number.isFinite(result.outputTokens) ? result.outputTokens : null,
  };

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

  const text = String(result.lastResultText || '');
  const parsed = parseVerdict(text);
  if (!parsed) {
    return recordFailure(`unparseable: ${clip(text.slice(-300), 300) || '(empty reply)'}`, {
      sessionId: session.id, costUsd, ...usage,
    });
  }
  const capSuppressed = await simulateCaps(pool, bot, app.id, parsed.verdict);
  const runId = await insertRun(pool, {
    appId: app.id, issueNumber, sessionId: session.id, mode,
    verdict: parsed.verdict, determined: parsed.determined, missingFact: parsed.missingFact,
    question: parsed.question, questionDefault: parsed.questionDefault,
    buildNote: parsed.buildNote, reason: parsed.reason, capSuppressed,
    threadSeenAt: item.thread_seen_at || null, model, costUsd,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    durationMs: Date.now() - startedMs,
  });
  await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [item.id]);
  log.info('homeroom-bot', 'Triaged', {
    app: app.slug, issueNumber, verdict: parsed.verdict, costUsd, runId,
  });
  return { ran: true, verdict: parsed.verdict, runId };
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

    const now = deps.now ? deps.now() : Date.now();
    // Take the wakes that arrived before this pass. Ones that arrive DURING
    // it are left for the next, which tick() schedules at once.
    const targeted = [...pendingApps];
    pendingApps.clear();
    const forceAll = !!deps.forceRefresh || refreshAllRequested;
    refreshAllRequested = false;
    wakeRequested = false;
    if (forceAll || now - lastRefreshAt >= REFRESH_INTERVAL_MS) {
      const summary = await refreshQueue(pool, settings, deps);
      lastRefreshAt = now;
      out.refreshed = true;
      if (summary.queued) log.info('homeroom-bot', 'Queue refreshed', summary);
    } else if (targeted.length) {
      const summary = await refreshApps(pool, settings, targeted, deps);
      out.refreshed = true;
      out.woken = targeted.length;
      if (summary.queued) log.info('homeroom-bot', 'Queue refreshed on activity', summary);
    }

    const bot = await ensureBotUser(pool, config);
    const taken = [];
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

    const results = await Promise.all(batches.map(async (batch) => {
      let processed = 0;
      for (const item of batch.items) {
        if (stopped) break;
        // Re-read the mode between issues so "off" stops a batch mid-way.
        const live = await readSettings(pool);
        if (live.mode === 'off') { out.paused = 'mode_off'; break; }
        let r;
        try {
          r = await runTriage(pool, config, { bot, app: batch.app, item, mode: live.mode, deps });
        } catch (err) {
          log.error('homeroom-bot', 'Triage threw', { app: batch.app.slug, issueNumber: item.issue_number, err: err.message });
          r = { ran: false, reason: 'threw' };
        }
        if (r.ran) processed += 1;
        if (r.reason === 'budget') { out.paused = 'budget'; break; }
        if (r.reason === 'infra') { out.paused = 'infra'; out.detail = r.detail || null; break; }
      }
      return processed;
    }));
    out.processed = results.reduce((a, b) => a + b, 0);
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

async function adminPayload(pool, config, { app = null, verdict = null, before = null, limit = RUNS_PAGE } = {}) {
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
            COUNT(*) FILTER (WHERE verdict = 'failed')::int AS failed,
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
    failed: t.failed || 0,
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

  // One static statement, filters as nullable parameters, so the SQL lint's
  // inventory stays static and the shadow database checks every column.
  const pageSize = Math.min(Math.max(Number(limit) || RUNS_PAGE, 1), 200);
  const { rows: runRows } = await pool.query(
    `SELECT r.id, r.issue_number, r.mode, r.verdict, r.determined, r.missing_fact,
            r.question, r.question_default, r.build_note, r.reason, r.cap_suppressed,
            r.rating, r.rating_note, r.rated_at, r.thread_seen_at, r.model, r.cost_usd::float8 AS cost_usd,
            r.input_tokens, r.output_tokens, r.duration_ms, r.error, r.created_at,
            a.slug AS app_slug, a.name AS app_name, a.repo_url, u.username AS rated_by
       FROM homeroom_bot_runs r
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN users u ON u.id = r.rating_by
      WHERE ($1::text IS NULL OR a.slug = $1::text)
        AND ($2::text IS NULL OR r.verdict = $2::text)
        AND ($3::int IS NULL OR r.id < $3::int)
      ORDER BY r.id DESC
      LIMIT $4`,
    [app || null, verdict || null, before == null ? null : Number(before), pageSize],
  );

  const { rows: appRows } = await pool.query(
    `SELECT slug, name FROM apps WHERE status = 'running' AND repo_url IS NOT NULL ORDER BY name`,
  );

  return {
    settings,
    modes: MODES,
    bot,
    loop: lastPass,
    totals,
    queue: { depth: depthRows[0]?.depth || 0, items: queueRows },
    runs: runRows.map((r) => ({
      ...r,
      issueUrl: r.repo_url ? `${String(r.repo_url).replace(/\.git$/, '')}/issues/${r.issue_number}` : null,
    })),
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
  rateRun,
  enqueueNow,
  wake,
  wakeAll,
  noteIssueActivity,
  onBusMessage,
  refreshApps,
  BUS_KIND,
  MAX_BATCH_SIZE,
  // Pure, exported for tests.
  classifyIssue,
  parseVerdict,
  parseRepo,
  BOT_USERNAME,
  MODES,
  VERDICTS,
  KEY_MODE,
  KEY_CONCURRENCY,
  KEY_BATCH_SIZE,
  KEY_PAUSED_APPS,
  DEFAULT_WEEKLY_LIMIT_CENTS,
  REFRESH_INTERVAL_MS,
  IDLE_PASS_DELAY_MS,
  BUSY_PASS_DELAY_MS,
  PROPOSALS_PER_APP_CAP,
  QUESTION_TRIPWIRE_PER_DAY,
  _resetForTests() {
    lastRefreshAt = 0; triagePromptCache = null; stopped = false; passInFlight = false; lastPass = null;
    if (timer) clearTimeout(timer);
    timer = null; loopConfig = null; pendingApps.clear(); refreshAllRequested = false; wakeRequested = false;
  },
  // Test seams for the wake path.
  _pendingForTests() { return { apps: [...pendingApps], all: refreshAllRequested, wake: wakeRequested, armed: timer !== null }; },
  _armForTests(config) { stopped = false; loopConfig = config; passInFlight = false; timer = setTimeout(() => {}, 1e9); timer.unref(); },
  _setPassInFlightForTests(v) { passInFlight = !!v; },
};
