'use strict';

// #2380 — durable lifecycle for before/after shots of a proposal's declared
// changes. All state changes pass through this module so a new head
// invalidates old shots before any serializer can return them. A verified run
// means at least one declared change has a complete set of shots on the exact
// revisions; people decide whether those shots show the change.

const crypto = require('crypto');
const dbRetry = require('./db-retry');
const planContract = require('./visible-changes');
const shots = require('./shots-files');

const STATES = Object.freeze([
  'planned', 'provisioning', 'exploring', 'replaying', 'reviewing',
  'verified', 'failed', 'stale', 'cancelled', 'not_required', 'overridden',
]);

const TERMINAL_STATES = new Set([
  'verified', 'failed', 'stale', 'cancelled', 'not_required', 'overridden',
]);

const TRANSITIONS = Object.freeze({
  planned: new Set(['provisioning', 'failed', 'cancelled']),
  provisioning: new Set(['exploring', 'failed', 'cancelled']),
  // exploring -> reviewing: the shots agent's shots are stored, then
  // published. 'replaying' remains only so rows from the retired replay
  // mode can still be failed or cancelled by recovery.
  exploring: new Set(['reviewing', 'failed', 'cancelled']),
  replaying: new Set(['failed', 'cancelled']),
  reviewing: new Set(['verified', 'failed', 'cancelled']),
  verified: new Set(['stale']),
  failed: new Set(['stale']),
  not_required: new Set(['stale']),
  overridden: new Set(['stale']),
  stale: new Set(),
  cancelled: new Set(),
});

const PATCH_COLUMNS = Object.freeze({
  planHash: 'plan_hash',
  traceSummary: 'trace_summary',
  hardVerdict: 'hard_verdict',
  failureCode: 'failure_code',
  failureReason: 'failure_reason',
  fixtureFingerprint: 'fixture_fingerprint',
  baseImageDigest: 'base_image_digest',
  headImageDigest: 'head_image_digest',
  startedAt: 'started_at',
  completedAt: 'completed_at',
});

// Codes written before the rename name "evidence": runs, snapshots and turns
// recorded then, or by the previous release's pods during a rollout. Read
// them as the codes this release writes.
const RENAMED_CODES = Object.freeze({
  visual_evidence_intent_conflict: 'visible_changes_conflict',
  invalid_visual_evidence: 'invalid_visible_changes',
  evidence: 'shots',
});

// A rollout interrupts runs through no fault of the proposal. The recovery
// sweep (services/shots-gc.js retryInterrupted) starts the same head again
// under this trigger.
//
// Two budgets, because the two causes are not alike. Production redeploys
// on every merge, and on a busy day merges land every few minutes, which is
// shorter than a run: a proposal can lose run after run to rollouts that
// say nothing about it. The shutdown handler records those as
// `interruptedBy: 'shutdown'` (SHUTDOWN_INTERRUPTION), and they count only
// against MAX_INTERRUPTED_RETRIES, the ceiling on automatic retries of any
// cause. An interruption nothing explained (a crash, a SIGKILL, a heartbeat
// that simply stopped) could be the run itself taking the process down, so
// those keep the original, tighter budget: MAX_UNEXPLAINED_RETRIES retries,
// after which the run is a failure a person has to retry.
const INTERRUPTED_RETRY_TRIGGER = 'interrupted-retry';
const MAX_INTERRUPTED_RETRIES = 6;
const MAX_UNEXPLAINED_RETRIES = 2;
const SHUTDOWN_INTERRUPTION = 'shutdown';
const SHUTDOWN_INTERRUPTED_REASON = 'Homeroom restarted while these before & after shots were being taken. You can take them again.';

// Whether an interrupted run gets another automatic retry, from the two
// counts every loader selects beside the run (see the `interrupted_retries`
// and `unexplained_interruptions` subqueries in getForSession,
// shots-view.getForSessions and shots-gc.retryInterrupted, which must agree
// with this). A loader that did not count them cannot promise a retry.
function interruptedRetryAllowed({ interrupted_retries: retries, unexplained_interruptions: unexplained } = {}) {
  if (retries == null || unexplained == null) return false;
  return Number(retries) < MAX_INTERRUPTED_RETRIES
    && Number(unexplained) <= MAX_UNEXPLAINED_RETRIES;
}

function currentCode(code) {
  if (typeof code !== 'string' || !code.includes('evidence')) return code;
  return RENAMED_CODES[code] || code.replace(/visual_evidence/g, 'shots').replace(/evidence/g, 'shots');
}

// #4575: the codes a dispatch fails with when another turn (the Homeroom
// bot's, say) holds the proposal's agent. The worker's own wording ("durable
// active turn could not be persisted") means nothing to a person reading the
// card, so a run that ended on one of these says so in plain words, even one
// stored before this copy existed.
const AGENT_BUSY_CODES = new Set([
  'session_busy',
  'TURN_IN_FLIGHT',
  'durable_turn_persist_failed',
  'durable_retry_persist_failed',
]);
const AGENT_BUSY_REASON = 'The proposal\u2019s agent was busy with another turn, so the shots didn\u2019t start. Take the shots again.';

function agentBusyCode(code) {
  return typeof code === 'string' && AGENT_BUSY_CODES.has(code);
}

class ShotsStateError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'ShotsStateError';
    this.code = code;
    this.status = status;
  }
}

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function assertTransition(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to) || !TRANSITIONS[from]?.has(to)) {
    throw new ShotsStateError(
      'invalid_shots_transition',
      `Before & after shots cannot move from ${JSON.stringify(from)} to ${JSON.stringify(to)}.`
    );
  }
}

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

function clip(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, max) : null;
}

function claimsFromIntent(intent) {
  return Array.isArray(intent?.stories)
    ? intent.stories.slice(0, planContract.MAX_STORIES).map((story) => ({
      id: story.id,
      claim: story.claim,
      persona: story.persona,
      viewports: story.viewports.map((viewport) => viewport.name),
      steps: story.intent.steps,
      baseState: story.intent.baseState === 'not_present' ? 'not_present' : 'present',
      animation: story.intent.animation,
    }))
    : [];
}

// The changed-file heuristic only decides whether a MISSING declaration is
// needed. It cannot overrule an explicit `impact: none`: that intent has no
// stories by contract, so a run it forced had nothing to shoot and always
// failed (then `missing_evidence_replay`) after building two environments. Nearly
// every platform change touches a .js file, so that was most no-UI proposals.
function requiredForIntent(intent, { heuristicUi = false } = {}) {
  if (!intent) return !!heuristicUi;
  return intent.impact !== 'none';
}

function pendingDetail(intent, options = {}) {
  const required = requiredForIntent(intent, options);
  return {
    version: 1,
    required,
    impact: intent?.impact || null,
    rationale: intent?.rationale || null,
    claims: claimsFromIntent(intent),
    ...(options.headSha ? { headSha: options.headSha } : {}),
    ...(options.reason ? { reason: clip(options.reason, 1000) } : {}),
    intent: intent || null,
  };
}

function missingIntentDetail({ headSha = null, reason = null } = {}) {
  return {
    version: 1,
    required: true,
    impact: null,
    rationale: null,
    claims: [],
    ...(headSha ? { headSha } : {}),
    reason: clip(reason, 1000)
      || 'This proposal appears to change the UI but has not declared the change for before/after shots yet.',
  };
}

async function withTransaction(pool, fn) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A database pool is required');
  if (typeof pool.connect !== 'function') return fn(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function recordIntentWithClient(client, sessionId, intent, detail, state, options) {
  const selected = await client.query(
    `SELECT shots_state, shots_run_id, shots_detail
       FROM chat_sessions WHERE id = $1 FOR UPDATE`,
    [sessionId]
  );
  const session = selected.rows[0];
  if (!session) throw new ShotsStateError('session_not_found', 'Proposal session not found.', 404);

  // Build tools can report the same declaration more than once (for
  // example after a transport retry). Treat that as an idempotent write so
  // a completed, same-head run is not accidentally invalidated.
  const currentIntent = session.shots_detail?.intent || null;
  const sameRevision = !options.headSha
    || session.shots_detail?.headSha === options.headSha;
  const sameIntent = currentIntent
    && planContract.canonicalJson(currentIntent) === planContract.canonicalJson(intent)
    && requiredForIntent(currentIntent, options) === detail.required
    && sameRevision;
  if (sameIntent) {
    return {
      accepted: true,
      unchanged: true,
      required: detail.required,
      state: session.shots_state || state,
      intent,
      detail: session.shots_detail,
      runId: session.shots_run_id || null,
    };
  }

  // A changed declaration changes what reviewers are being asked to
  // verify. Cancel active work and stale terminal shots before moving
  // the session pointer; old media may remain for audit/retention but can
  // no longer be served as current shots.
  await client.query(
    `UPDATE shot_runs
        SET state = CASE
              WHEN state IN ('planned','provisioning','exploring','replaying','reviewing')
                THEN 'cancelled'
              ELSE 'stale'
            END,
            failure_code = CASE
              WHEN state IN ('planned','provisioning','exploring','replaying','reviewing')
                THEN 'intent_changed'
              ELSE failure_code
            END,
            failure_reason = CASE
              WHEN state IN ('planned','provisioning','exploring','replaying','reviewing')
                THEN 'The author changed the declared changes.'
              ELSE failure_reason
            END,
            completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
      WHERE session_id = $1 AND state NOT IN ('stale','cancelled')`,
    [sessionId]
  );
  await client.query(
    `UPDATE chat_sessions
        SET shots_state = $2,
            shots_run_id = NULL,
            shots_detail = $3::jsonb,
            shots_updated_at = NOW()
      WHERE id = $1`,
    [sessionId, state, JSON.stringify(detail)]
  );
  return { accepted: true, unchanged: false, required: detail.required, state, intent, detail, runId: null };
}

function prepareIntent(rawIntent, options) {
  const intent = planContract.parseIntent(rawIntent);
  const detail = pendingDetail(intent, options);
  const state = intent.impact === 'none' && !detail.required ? 'not_required' : 'planned';
  return { intent, detail, state };
}

async function recordIntent(pool, sessionId, rawIntent, options = {}) {
  const prepared = prepareIntent(rawIntent, options);
  return withTransaction(pool, (client) => recordIntentWithClient(
    client, sessionId, prepared.intent, prepared.detail, prepared.state, options
  ));
}

// PR import already owns the transaction that inserts the proposal row. Its
// shots declaration must be part of that same atomic write: a second pool
// connection cannot see the uncommitted row, while calling `.connect()` on
// the checked-out PoolClient throws and releasing it would steal ownership
// from the route. Make that ownership explicit rather than trying to infer a
// Pool from a PoolClient by the presence of `.connect()` — both have it.
async function recordIntentInTransaction(client, sessionId, rawIntent, options = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A transaction client is required');
  }
  const prepared = prepareIntent(rawIntent, options);
  return recordIntentWithClient(
    client, sessionId, prepared.intent, prepared.detail, prepared.state, options
  );
}

async function clearIntent(pool, sessionId) {
  const { rowCount } = await pool.query(
    `UPDATE chat_sessions
        SET shots_state = NULL,
            shots_run_id = NULL,
            shots_detail = NULL,
            shots_updated_at = NOW()
      WHERE id = $1`,
    [sessionId]
  );
  return rowCount > 0;
}

// The changed-file classifier is a backstop for an implementing agent that
// forgets to declare visual impact. Persist a truthful, exact-head pending
// requirement instead of letting absence of metadata bypass enforcement.
// A later recordIntent call replaces this placeholder with the validated
// semantic contract.
async function requireIntentForUiChange(pool, sessionId, options = {}) {
  if (options.headSha && !validSha(options.headSha)) {
    throw new ShotsStateError('invalid_shots_revision', 'A valid head SHA is required.', 400);
  }
  return withTransaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT shots_state, shots_run_id, shots_detail
         FROM chat_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    const session = selected.rows[0];
    if (!session) throw new ShotsStateError('session_not_found', 'Proposal session not found.', 404);
    if (session.shots_detail && typeof session.shots_detail === 'object'
        && (session.shots_detail.intent
          || !options.headSha
          || session.shots_detail.headSha === options.headSha)) {
      return {
        changed: false,
        required: session.shots_detail.required !== false,
        state: session.shots_state || 'planned',
        detail: session.shots_detail,
      };
    }
    await client.query(
      `UPDATE shot_runs
          SET state = CASE
                WHEN state IN ('planned','provisioning','exploring','replaying','reviewing')
                  THEN 'cancelled'
                ELSE 'stale'
              END,
              failure_code = CASE
                WHEN state IN ('planned','provisioning','exploring','replaying','reviewing')
                  THEN 'intent_missing'
                ELSE failure_code
              END,
              failure_reason = CASE
                WHEN state IN ('planned','provisioning','exploring','replaying','reviewing')
                  THEN 'The UI change has no declared change for before/after shots.'
                ELSE failure_reason
              END,
              completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE session_id = $1 AND state NOT IN ('stale','cancelled')`,
      [sessionId]
    );
    const detail = missingIntentDetail(options);
    await client.query(
      `UPDATE chat_sessions
          SET shots_state = 'planned',
              shots_run_id = NULL,
              shots_detail = $2::jsonb,
              shots_updated_at = NOW()
        WHERE id = $1`,
      [sessionId, JSON.stringify(detail)]
    );
    return { changed: true, required: true, state: 'planned', detail };
  });
}

function runSummary(row, artifactSummary = []) {
  if (!row) return null;
  const intent = row.intent && typeof row.intent === 'object' ? row.intent : null;
  const trace = row.trace_summary && typeof row.trace_summary === 'object'
    ? row.trace_summary : null;
  const progress = trace?.progress;
  return {
    state: row.state,
    // A heuristic may keep an explicit `impact:none` declaration in the
    // required path. The durable run state, not a fresh heuristic-free
    // calculation, is authoritative when serializing that run.
    required: row.state !== 'not_required',
    claims: claimsFromIntent(intent),
    baseSha: row.base_sha,
    headSha: row.head_sha,
    failureCode: currentCode(row.failure_code) || null,
    failureReason: agentBusyCode(row.failure_code)
      ? AGENT_BUSY_REASON
      : (row.failure_reason || null),
    // Any finished run on the current head can be taken again; an explicit
    // no-visible-change declaration or a stop has nothing to retry.
    repairAvailable: row.state === 'failed' && currentCode(row.failure_code) !== 'visible_changes_conflict',
    // Interrupted by a restart, with an automatic retry still to come. Only
    // a query that counted the retries (`interrupted_retries`) can say so;
    // anything else reads false. Whether the proposal is still open is the
    // view's to add.
    // The code as stored, not read through currentCode: the sweep matches it
    // exactly, so a run interrupted under the old name is not retried.
    automaticRetryPending: row.state === 'failed'
      && row.failure_code === 'shots_run_interrupted'
      && interruptedRetryAllowed(row),
    planHash: row.plan_hash || null,
    // One result per declared change: ready (with the shots agent's note
    // on what its shots leave out, if any), or skipped with the reason
    // people see on the proposal. Runs from before shots have none.
    // The screens the card shows, with where each change's before and after
    // differ (services/shots-diff.js). Runs from before it have none.
    screens: shots.isShotsVerdict(row.hard_verdict) && Array.isArray(row.hard_verdict.screens)
      ? row.hard_verdict.screens : [],
    // `failed`: the agent did the steps and the after build broke.
    shotResults: shots.isShotsVerdict(row.hard_verdict) && Array.isArray(row.hard_verdict.stories)
      ? row.hard_verdict.stories.map((story) => ({
        id: story?.id,
        status: story?.status === 'ready' || story?.status === 'failed' ? story.status : 'skipped',
        reason: story?.status === 'ready' ? null : (story?.reason || null),
        note: story?.status === 'ready' ? (story?.note || null) : null,
      }))
      : [],
    // What the shots agent noticed broken on the after build besides the
    // declared changes (shots-files.notice). Advisory only: brokenOnHead and
    // everything that gates a change read shotResults, never these. Runs
    // from before them have none.
    shotNotices: shots.isShotsVerdict(row.hard_verdict) && Array.isArray(row.hard_verdict.notices)
      ? row.hard_verdict.notices : [],
    progress: progress && typeof progress.phase === 'string'
      && /^[a-z][a-z0-9_-]{0,63}$/.test(progress.phase)
      ? { phase: progress.phase, at: progress.at || null } : null,
    verifiedReason: null,
    overriddenBy: row.override_user_id || null,
    overriddenAt: row.overridden_at || null,
    overrideReason: row.override_reason || null,
    artifactSummary,
    updatedAt: row.updated_at || row.completed_at || row.created_at || null,
  };
}

// ── What a settled run means for whoever waits on it ────────────────────
//
// The Homeroom bot offers a change of its own as ready to try only once its
// shots on that exact head have settled, and gives it back to itself to fix
// when they show a declared change failing (homeroom-bot-dm.noteShotsSettled).
// Every way the proposal's slot settles calls this after its write commits:
// a terminal transition (published, failed, cancelled, stale), a waiver, a
// run that will not start, a declaration that needs none. Fire-and-forget,
// and one indexed read for any proposal that is not the bot's.
let settleListener = (pool, sessionId) => require('./homeroom-bot-dm').noteShotsSettled(pool, sessionId);

function noteSettled(pool, sessionId) {
  const id = Number(sessionId);
  const listener = settleListener;
  if (!listener || !pool || !Number.isInteger(id) || id <= 0) return;
  setImmediate(() => {
    Promise.resolve().then(() => listener(pool, id)).catch(() => {});
  });
}

function setSettleListenerForTests(listener) {
  const previous = settleListener;
  settleListener = listener;
  return previous;
}

const IN_FLIGHT_STATES = new Set(['planned', 'provisioning', 'exploring', 'replaying', 'reviewing']);
// How long a ready-to-try message waits on shots that have not settled,
// from the checks verdict on the same head. A run is bounded by its own
// budget (SHOTS_MAX_RUN_MS, 24 minutes) and recovery fails one that stops
// reporting, so this only matters if no settle ever arrives; the bot's
// refresh then sends what waited (homeroom-bot-dm.sweepHeldReady).
const READY_HOLD_MS = 45 * 60_000;

function lowerSha(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function timeOf(value) {
  if (value == null) return NaN;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Pure: the declared changes the shots on head `headSha` show failing (the
 * shots agent did the steps and the after build broke), from a session row's
 * `shots_state` and `shots_detail`: [{ id, claim, steps, reason }]. Empty
 * for shots on another head, unsettled shots, and runs from before the
 * failed outcome existed.
 */
function brokenOnHead(row, headSha) {
  const detail = row?.shots_detail;
  const head = lowerSha(headSha);
  if (!detail || typeof detail !== 'object' || !head) return [];
  if (!['verified', 'failed'].includes(row.shots_state)) return [];
  if (lowerSha(detail.headSha) !== head) return [];
  const claims = Array.isArray(detail.claims) ? detail.claims : [];
  const results = Array.isArray(detail.shotResults) ? detail.shotResults : [];
  return results.filter((result) => result && result.status === 'failed' && typeof result.id === 'string')
    .slice(0, planContract.MAX_STORIES)
    .map((result) => {
      const declared = claims.find((claim) => claim && claim.id === result.id) || {};
      return {
        id: result.id,
        claim: clip(declared.claim, 300) || result.id,
        steps: Array.isArray(declared.steps) ? declared.steps.slice(0, 12).map((step) => String(step).slice(0, 200)) : [],
        reason: clip(result.reason, 1000),
      };
    });
}

/**
 * Pure: whether shots of head `headSha` are still to come, so a change is
 * not yet ready to try. True while a run on that head is under way, or
 * while declared shots have no settled run on it yet and nothing recorded
 * that one will not start (a run is created only once the checks settle,
 * beside the verdict that asks this). False when nothing visible was
 * declared, when shots on this head settled, and once READY_HOLD_MS has
 * passed since the checks verdict (`checks_checked_at`) or, without one,
 * since the slot last changed.
 */
function holdsReady(row, headSha, { now = Date.now() } = {}) {
  const detail = row?.shots_detail;
  const head = lowerSha(headSha);
  if (!detail || typeof detail !== 'object' || !head) return false;
  if (detail.required === false || row.shots_state === 'not_required' || !row.shots_state) return false;
  const since = Math.max(timeOf(row.checks_checked_at) || 0, timeOf(row.shots_updated_at) || 0);
  if (!since || now - since > READY_HOLD_MS) return false;
  const onHead = !detail.headSha || lowerSha(detail.headSha) === head;
  if (onHead && row.shots_run_id) return IN_FLIGHT_STATES.has(row.shots_state);
  if (onHead && TERMINAL_STATES.has(row.shots_state)) return false;
  if (row.shots_state === 'planned' && typeof detail.notStartedReason === 'string' && detail.notStartedReason.trim()) {
    return false;
  }
  const stories = detail.intent && Array.isArray(detail.intent.stories) ? detail.intent.stories : [];
  return stories.length > 0;
}

async function createRunWithClient(client, {
  sessionId, baseSha, headSha, intent: rawIntent, trigger = null, heuristicUi = false,
}) {
  if (!validSha(baseSha) || !validSha(headSha)) {
    throw new ShotsStateError('invalid_shots_revision', 'Before & after shots requires exact 40-character base and head SHAs.', 400);
  }
  const intent = planContract.parseIntent(rawIntent);
  const required = requiredForIntent(intent, { heuristicUi });
  const initialState = required ? 'planned' : 'not_required';
  const id = newId();

  const locked = await client.query(
    'SELECT id FROM chat_sessions WHERE id = $1 FOR UPDATE',
    [sessionId]
  );
  if (!locked.rows[0]) throw new ShotsStateError('session_not_found', 'Proposal session not found.', 404);
  const existing = await client.query(
    `SELECT * FROM shot_runs
      WHERE session_id = $1 AND head_sha = $2
        AND state NOT IN ('stale', 'cancelled')
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [sessionId, headSha]
  );
  if (existing.rows[0]) return { created: false, run: existing.rows[0] };

  // In-flight work for an older revision is cancelled; a terminal verdict
  // becomes stale. Both happen before the session pointer moves.
  await client.query(
    `UPDATE shot_runs
        SET state = CASE
              WHEN state IN ('planned','provisioning','exploring','replaying','reviewing')
                THEN 'cancelled'
              ELSE 'stale'
            END,
            completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
      WHERE session_id = $1 AND head_sha <> $2
        AND state NOT IN ('stale','cancelled')`,
    [sessionId, headSha]
  );

  const inserted = await client.query(
    `INSERT INTO shot_runs
       (id, session_id, base_sha, head_sha, plan_version, intent, state,
        trigger, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::varchar(24), $8,
        CASE WHEN $7::varchar(24) = 'not_required' THEN NOW() END)
     RETURNING *`,
    [id, sessionId, baseSha, headSha, planContract.PLAN_VERSION,
     JSON.stringify(intent), initialState, clip(trigger, 32)]
  );
  const run = inserted.rows[0];
  const detail = {
    ...pendingDetail(intent, { heuristicUi, headSha }),
    runId: id,
    baseSha,
    state: initialState,
  };
  const updated = await client.query(
    `UPDATE chat_sessions
        SET shots_state = $2,
            shots_run_id = $3,
            shots_detail = $4::jsonb,
            shots_updated_at = NOW()
      WHERE id = $1`,
    [sessionId, initialState, id, JSON.stringify(detail)]
  );
  if (!updated.rowCount) throw new ShotsStateError('session_not_found', 'Proposal session not found.', 404);
  return { created: true, run };
}

async function createRun(pool, options) {
  const created = await withTransaction(pool, (client) => createRunWithClient(client, options));
  if (created?.created && created.run?.state === 'not_required') noteSettled(pool, options.sessionId);
  return created;
}


function assertTransitionPayload(row, next, patch) {
  const hard = patch.hardVerdict ?? row.hard_verdict;
  const planHash = patch.planHash ?? row.plan_hash;

  if (next === 'reviewing' && hard?.passed !== true) {
    throw new ShotsStateError('shots_hard_verdict_required', 'Publishing shots requires at least one ready change.');
  }
  if (next === 'verified') {
    if (!planHash || hard?.passed !== true) {
      throw new ShotsStateError('shots_verdict_required', 'Published shots require a manifest and at least one ready change.');
    }
    patch.completedAt = patch.completedAt || new Date();
  }
  if (next === 'failed') {
    patch.failureReason = clip(patch.failureReason || row.failure_reason, 2000);
    if (!patch.failureReason) throw new ShotsStateError('shots_failure_reason_required', 'Failed shots requires a user-visible reason.');
    patch.completedAt = patch.completedAt || new Date();
  }
  if (next === 'cancelled' || next === 'stale') patch.completedAt = patch.completedAt || new Date();
}

// The transition locks the run, then its proposal (FOR UPDATE OF r, s), while
// createRun and markStaleForHead lock the proposal first: two of them on one
// proposal at once can deadlock, and Postgres rolls one back (40P01). The
// transition re-reads and re-checks everything under its lock, so a rolled-
// back one is run again, a bounded number of times, from a fresh copy of
// the patch.
async function transitionRun(pool, runId, nextState, rawPatch = {}, { retry = {} } = {}) {
  if (!/^[0-9a-f]{32}$/.test(String(runId || ''))) {
    throw new ShotsStateError('invalid_shots_run', 'Invalid before & after shots run id.', 400);
  }
  const next = await dbRetry.withDbRetry(() => withTransaction(pool, async (client) => {
    const patch = { ...rawPatch };
    const selected = await client.query(
      `SELECT r.*, s.shots_run_id AS current_run_id
         FROM shot_runs r
         JOIN chat_sessions s ON s.id = r.session_id
        WHERE r.id = $1
        FOR UPDATE OF r, s`,
      [runId]
    );
    const row = selected.rows[0];
    if (!row) throw new ShotsStateError('shots_run_not_found', 'Before/after shots run not found.', 404);
    if (row.current_run_id !== row.id) {
      throw new ShotsStateError(
        'stale_shots_operation',
        'This run no longer owns the proposal shots slot.'
      );
    }
    // Recovery reads the run before acquiring this lock. A heartbeat may
    // renew it in between, so check the idle interval again under the lock
    // before failing it or removing its resources.
    if (Object.prototype.hasOwnProperty.call(patch, 'recoveryMinIdleMs')) {
      const idleMs = Date.now() - new Date(row.updated_at).getTime();
      if (!Number.isFinite(idleMs) || idleMs < patch.recoveryMinIdleMs) {
        throw new ShotsStateError(
          'shots_run_active', 'These before/after shots are still being taken.'
        );
      }
      delete patch.recoveryMinIdleMs;
    }
    assertTransition(row.state, nextState);
    assertTransitionPayload(row, nextState, patch);

    const sets = ['state = $2', 'updated_at = NOW()'];
    const values = [runId, nextState];
    // `traceMerge` adds keys to the stored trace instead of replacing it:
    // the shutdown handler tags an interruption without wiping the
    // diagnostics the run had already written.
    if (Object.prototype.hasOwnProperty.call(patch, 'traceMerge')) {
      const merge = patch.traceMerge;
      delete patch.traceMerge;
      if (merge && typeof merge === 'object' && !Array.isArray(merge)) {
        if (Object.prototype.hasOwnProperty.call(patch, 'traceSummary')) {
          patch.traceSummary = { ...(patch.traceSummary || {}), ...merge };
        } else {
          values.push(JSON.stringify(merge));
          sets.push(`trace_summary = COALESCE(trace_summary, '{}'::jsonb) || $${values.length}::jsonb`);
        }
      }
    }
    for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      let value = patch[key];
      if (['traceSummary', 'hardVerdict'].includes(key)) {
        value = value == null ? null : JSON.stringify(value);
        values.push(value);
        sets.push(`${column} = $${values.length}::jsonb`);
      } else {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
    }
    const updated = await client.query(
      `UPDATE shot_runs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, values
    );
    const next = updated.rows[0];
    let artifacts = [];
    if (next.state === 'verified') {
      const artifactResult = await client.query(
        `SELECT id, story_id AS "storyId", viewport, side, variant, media,
                content_type AS "contentType", width, height, bytes, sha256,
                focus_rect AS "focusRect", stage_labels AS "stageLabels"
           FROM shot_artifacts
          WHERE run_id = $1
          ORDER BY story_id, viewport, side, variant`,
        [next.id]
      );
      artifacts = artifactResult.rows;
    }
    const detail = { ...runSummary(next, artifacts), intent: next.intent };
    const sessionUpdate = await client.query(
      `UPDATE chat_sessions
          SET shots_state = $2,
              shots_run_id = $3,
              shots_detail = $4::jsonb,
              shots_updated_at = NOW()
        WHERE id = $1 AND shots_run_id = $3`,
      [next.session_id, next.state, next.id, JSON.stringify(detail)]
    );
    if (!sessionUpdate.rowCount) {
      throw new ShotsStateError(
        'stale_shots_operation',
        'The proposal shots owner changed while the run was updating.'
      );
    }
    return next;
  }), { label: 'Shots run transition', ...retry });
  if (TERMINAL_STATES.has(next?.state)) noteSettled(pool, next.session_id);
  return next;
}

// A fire-and-forget shots run belongs to a web process. Keep a durable
// lease while that process is alive so a rollout can be distinguished from a
// slow checkout, clone, or image build. Only the current active run may renew
// its lease; a late heartbeat cannot revive a failed or superseded run.
async function heartbeatRun(pool, runId, phase, progress = null) {
  if (!/^[0-9a-f]{32}$/.test(String(runId || ''))
      || !/^[a-z][a-z0-9_-]{0,63}$/.test(String(phase || ''))) {
    throw new ShotsStateError('invalid_shots_heartbeat', 'Shots heartbeat identity or phase is invalid.', 400);
  }
  const progressPatch = progress == null ? null : JSON.stringify({
    ...(progress.agentActivity ? { agentActivity: progress.agentActivity } : {}),
    ...(progress.agentFinalResponse ? { agentFinalResponse: progress.agentFinalResponse } : {}),
    ...(progress.heartbeat ? { heartbeat: progress.heartbeat } : {}),
  });
  if (progressPatch && progressPatch.length > 64_000) {
    throw new ShotsStateError('invalid_shots_heartbeat', 'Shots heartbeat trace is too large.', 400);
  }
  const result = await pool.query(
    `UPDATE shot_runs r
        SET updated_at = NOW(),
            trace_summary = jsonb_set(
              COALESCE(r.trace_summary, '{}'::jsonb), '{progress}',
              jsonb_build_object('phase', $2::text, 'at', NOW()), true)
              || COALESCE($3::jsonb, '{}'::jsonb)
       FROM chat_sessions s
      WHERE r.id = $1 AND s.id = r.session_id
        AND s.shots_run_id = r.id
        AND r.state IN ('provisioning','exploring','replaying','reviewing')`,
    [runId, phase, progressPatch]
  );
  return { active: (result.rowCount || 0) > 0 };
}

async function markStaleForHead(pool, sessionId, headSha, reason = 'A newer revision of this proposal replaced these shots.') {
  if (!validSha(headSha)) throw new ShotsStateError('invalid_shots_revision', 'A valid head SHA is required.', 400);
  return withTransaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT shots_state, shots_run_id, shots_detail
         FROM chat_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    const session = selected.rows[0];
    if (!session) throw new ShotsStateError('session_not_found', 'Proposal session not found.', 404);
    const result = await client.query(
      `UPDATE shot_runs
          SET state = CASE
                WHEN state IN ('planned','provisioning','exploring','replaying','reviewing')
                  THEN 'cancelled'
                ELSE 'stale'
              END,
              failure_code = CASE
                WHEN state IN ('planned','provisioning','exploring','replaying','reviewing')
                  THEN 'superseded'
                ELSE failure_code
              END,
              failure_reason = CASE
                WHEN state IN ('planned','provisioning','exploring','replaying','reviewing')
                  THEN $3
                ELSE failure_reason
              END,
              completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE session_id = $1 AND head_sha <> $2
          AND state NOT IN ('stale','cancelled')
       RETURNING id`,
      [sessionId, headSha, clip(reason, 2000)]
    );
    const previous = session.shots_detail && typeof session.shots_detail === 'object'
      ? session.shots_detail : {};
    const intent = previous.intent && typeof previous.intent === 'object' ? previous.intent : null;
    const revisionChanged = previous.headSha && previous.headSha !== headSha;
    if (result.rowCount || revisionChanged) {
      let detail;
      let nextState = 'planned';
      if (intent) {
        // Keep the already-validated declaration while dropping every
        // run-derived field. The next exact revision needs new shots, but the
        // author should not have to restate the change after every push.
        detail = pendingDetail(intent, { headSha, reason });
        nextState = intent.impact === 'none' && detail.required === false
          ? 'not_required' : 'planned';
      } else {
        detail = {
          version: 1,
          required: true,
          headSha,
          reason: clip(reason, 1000),
        };
      }
      await client.query(
        `UPDATE chat_sessions
            SET shots_state = $2,
                shots_run_id = NULL,
                shots_detail = $3::jsonb,
                shots_updated_at = NOW()
          WHERE id = $1`,
        [sessionId, nextState, JSON.stringify(detail)]
      );
    }
    return result.rowCount || 0;
  });
}

async function overrideRun(pool, runId, { userId, reason }) {
  const overrideReason = clip(reason, 1000);
  if (!Number.isInteger(Number(userId)) || Number(userId) <= 0 || !overrideReason) {
    throw new ShotsStateError('invalid_shots_override', 'An authorized user and visible override reason are required.', 400);
  }
  return withTransaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT r.*, s.shots_run_id AS current_run_id
         FROM shot_runs r
         JOIN chat_sessions s ON s.id = r.session_id
        WHERE r.id = $1 FOR UPDATE OF r, s`,
      [runId]
    );
    const row = selected.rows[0];
    if (!row) throw new ShotsStateError('shots_run_not_found', 'Before/after shots run not found.', 404);
    if (row.current_run_id !== row.id) {
      throw new ShotsStateError('stale_shots_operation', 'Only the proposal’s current before/after shots can be waived.');
    }
    if (!['planned', 'provisioning', 'exploring', 'replaying', 'reviewing', 'failed'].includes(row.state)) {
      throw new ShotsStateError('invalid_shots_override_state', `Shots in state ${row.state} cannot be overridden.`);
    }
    const updated = await client.query(
      `UPDATE shot_runs
          SET state = 'overridden', override_user_id = $2, override_reason = $3,
              overridden_at = NOW(), completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [runId, Number(userId), overrideReason]
    );
    const next = updated.rows[0];
    const sessionUpdated = await client.query(
      `UPDATE chat_sessions
          SET shots_state = 'overridden', shots_run_id = $2,
              shots_detail = $3::jsonb, shots_updated_at = NOW()
        WHERE id = $1 AND shots_run_id = $2`,
      [next.session_id, next.id, JSON.stringify({ ...runSummary(next), intent: next.intent })]
    );
    if (!sessionUpdated.rowCount) {
      throw new ShotsStateError('stale_shots_operation', 'The proposal shots owner changed during the override.');
    }
    return next;
  }).then((next) => {
    noteSettled(pool, next?.session_id);
    return next;
  });
}

async function getRun(pool, runId, { forUpdate = false } = {}) {
  if (!/^[0-9a-f]{32}$/.test(String(runId || ''))) {
    throw new ShotsStateError('invalid_shots_run', 'Invalid before & after shots run id.', 400);
  }
  const result = await pool.query(
    `SELECT r.*, s.shots_run_id AS current_run_id,
            s.shots_state AS current_shots_state,
            s.shots_detail AS current_shots_detail
       FROM shot_runs r
       JOIN chat_sessions s ON s.id = r.session_id
      WHERE r.id = $1${forUpdate ? ' FOR UPDATE OF r, s' : ''}`,
    [runId]
  );
  if (!result.rows[0]) throw new ShotsStateError('shots_run_not_found', 'Before/after shots run not found.', 404);
  return result.rows[0];
}

// A same-head retry creates a new immutable run rather than rewinding the old
// row. This preserves the failed/verified audit record while the partial
// unique index guarantees there is still one reviewer-visible owner.
async function rerunSameHead(pool, runId, {
  trigger = 'manual-rerun', intent: replacementIntent = null,
} = {}) {
  return withTransaction(pool, async (client) => {
    const old = await getRun(client, runId, { forUpdate: true });
    if (!['failed', 'verified', 'overridden', 'not_required'].includes(old.state)) {
      throw new ShotsStateError('shots_rerun_in_flight', 'Wait for the current shots to finish before taking them again.');
    }
    if (old.current_run_id !== old.id) {
      throw new ShotsStateError('stale_shots_operation', 'Only the proposal\'s current before/after shots can be taken again.');
    }
    const intent = planContract.parseIntent(replacementIntent || old.intent);
    const required = requiredForIntent(intent);
    const initialState = required ? 'planned' : 'not_required';
    await client.query(
      `UPDATE shot_runs
          SET state = 'stale', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE id = $1`,
      [old.id]
    );
    const id = newId();
    const inserted = await client.query(
      `INSERT INTO shot_runs
         (id, session_id, base_sha, head_sha, plan_version, intent, state,
          trigger, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::varchar(24), $8,
          CASE WHEN $7::varchar(24) = 'not_required' THEN NOW() END)
       RETURNING *`,
      [id, old.session_id, old.base_sha, old.head_sha, planContract.PLAN_VERSION,
       JSON.stringify(intent), initialState, clip(trigger, 32)]
    );
    const next = inserted.rows[0];
    const updated = await client.query(
      `UPDATE chat_sessions
          SET shots_state = $2, shots_run_id = $3,
              shots_detail = $4::jsonb, shots_updated_at = NOW()
        WHERE id = $1 AND shots_run_id = $5`,
      [old.session_id, next.state, next.id,
       JSON.stringify({
         ...runSummary(next),
         required,
         intent: next.intent,
         impact: intent.impact,
         rationale: intent.rationale,
       }), old.id]
    );
    if (!updated.rowCount) {
      throw new ShotsStateError('stale_shots_operation', 'The proposal shots owner changed during the rerun.');
    }
    return next;
  });
}

async function getForSession(pool, sessionId, { headSha = null } = {}) {
  const values = [sessionId];
  const headClause = headSha ? `AND r.head_sha = $${values.push(headSha)}` : '';
  const result = await pool.query(
    `SELECT r.*,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', a.id, 'storyId', a.story_id, 'viewport', a.viewport,
                'side', a.side, 'variant', a.variant, 'media', a.media,
                'contentType', a.content_type, 'width', a.width,
                'height', a.height, 'bytes', a.bytes,
                'sha256', a.sha256,
                'focusRect', a.focus_rect, 'stageLabels', a.stage_labels
              ) ORDER BY a.story_id, a.viewport, a.side, a.variant)
                FROM shot_artifacts a WHERE a.run_id = r.id
            ), '[]'::jsonb) AS artifact_summary,
            -- Its automatic retries, so the view can say one is coming.
            (SELECT COUNT(*) FROM shot_runs retry
              WHERE retry.session_id = r.session_id AND retry.head_sha = r.head_sha
                AND retry.trigger = 'interrupted-retry')::int AS interrupted_retries,
            (SELECT COUNT(*) FROM shot_runs crash
              WHERE crash.session_id = r.session_id AND crash.head_sha = r.head_sha
                AND crash.failure_code = 'shots_run_interrupted'
                AND COALESCE(crash.trace_summary->>'interruptedBy', '') <> 'shutdown')::int AS unexplained_interruptions
       FROM shot_runs r
      WHERE r.session_id = $1 ${headClause}
        AND r.state NOT IN ('stale','cancelled')
      ORDER BY r.created_at DESC LIMIT 1`,
    values
  );
  const row = result.rows[0];
  return row ? runSummary(row, row.artifact_summary || []) : null;
}

// ── Why a run never got under way (#2601, #2558) ──────────────────────
//
// `recordIntent` writes 'planned' onto the session the moment a proposal
// declares its claim, and only the orchestrator moves it on. Every reason
// the orchestrator can decline to start — execution switched off for the
// deployment, no intent to run, no staging preview to shoot against — used
// to be a return value the caller logged at warn and dropped. So a
// proposal nothing was ever going to pick up looked exactly like one about
// to start, for as long as anybody cared to watch it: the whole of #2558.
//
// The reason goes on the PROPOSAL rather than the run, because the refusals
// that matter most are the ones that happen before any run row exists, and
// because the proposal is what a reviewer has open.
//
// Two deliberate omissions. The write does NOT touch
// `shots_updated_at`: that timestamp is how the reviewer surfaces
// measure "this has sat here long enough to call it not started", and
// bumping it on every refusal would restart the clock forever. And it only
// fires while the session still reads 'planned' — a run that has moved on
// owns its own state and must not be annotated by a late refusal from a
// schedule attempt something else already superseded.
async function recordNotStarted(pool, sessionId, reason) {
  const text = String(reason || '').trim().slice(0, 300);
  const id = Number(sessionId);
  if (!text || !Number.isInteger(id) || id <= 0) return { recorded: false };
  const { rows } = await pool.query(
    `UPDATE chat_sessions
        SET shots_detail = COALESCE(shots_detail, '{}'::jsonb)
              || jsonb_build_object('notStartedReason', $2::text)
      WHERE id = $1
        AND shots_state = 'planned'
        AND shots_detail->>'notStartedReason' IS DISTINCT FROM $2::text
      RETURNING id`,
    [id, text]
  );
  // A run that will not start is settled for whoever waits on it.
  if (rows.length) noteSettled(pool, id);
  return { recorded: rows.length > 0 };
}

// The counterpart: a run that HAS started carries no reason for not having.
// Called on the scheduling success path so a retry does not inherit the
// note left by the attempt before it.
async function clearNotStarted(pool, sessionId) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return { cleared: false };
  const { rows } = await pool.query(
    `UPDATE chat_sessions
        SET shots_detail = shots_detail - 'notStartedReason'
      WHERE id = $1 AND jsonb_exists(shots_detail, 'notStartedReason')
      RETURNING id`,
    [id]
  );
  return { cleared: rows.length > 0 };
}

// Publishes a run's before/after files in one transaction, fenced by the
// exact head and the run's manifest hash: a run that lost its proposal slot
// (a newer commit, a stop) cannot publish into it.
async function storeArtifacts(pool, runId, artifacts, { headSha, planHash } = {}) {
  if (!/^[0-9a-f]{32}$/.test(String(runId || ''))) {
    throw new ShotsStateError('invalid_shots_run', 'Invalid preview run id.', 400);
  }
  if (!validSha(headSha) || !/^[0-9a-f]{64}$/.test(String(planHash || ''))) {
    throw new ShotsStateError('invalid_artifact_fence', 'Publishing shots requires the exact head SHA and manifest hash.');
  }
  return withTransaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT r.id
         FROM shot_runs r
         JOIN chat_sessions s ON s.id = r.session_id
        WHERE r.id = $1 AND r.head_sha = $2 AND r.plan_hash = $3
          AND r.state = 'reviewing'
          AND s.shots_run_id = r.id
          AND s.shots_state = 'reviewing'
        FOR UPDATE`,
      [runId, headSha, planHash]
    );
    if (!selected.rowCount) {
      throw new ShotsStateError(
        'stale_shots_operation',
        'This run no longer owns the proposal\'s before/after slot; its shots were discarded.'
      );
    }
    await client.query('DELETE FROM shot_artifacts WHERE run_id = $1', [runId]);
    for (const artifact of artifacts) {
      await client.query(
        `INSERT INTO shot_artifacts
           (id, run_id, story_id, viewport, side, variant, media, content_type,
            data, width, height, bytes, sha256, focus_rect, stage_labels)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)`,
        [newId(), runId, artifact.storyId, artifact.viewport,
         artifact.side, artifact.variant, artifact.media, artifact.contentType, artifact.data,
         artifact.width, artifact.height, artifact.bytes, artifact.sha256,
         artifact.focusRect ? JSON.stringify(artifact.focusRect) : null,
         artifact.stageLabels ? JSON.stringify(artifact.stageLabels) : null]
      );
    }
    return artifacts.length;
  });
}

module.exports = {
  storeArtifacts,
  currentCode,
  AGENT_BUSY_CODES,
  AGENT_BUSY_REASON,
  agentBusyCode,
  INTERRUPTED_RETRY_TRIGGER,
  MAX_INTERRUPTED_RETRIES,
  MAX_UNEXPLAINED_RETRIES,
  SHUTDOWN_INTERRUPTION,
  SHUTDOWN_INTERRUPTED_REASON,
  interruptedRetryAllowed,
  STATES,
  TRANSITIONS,
  TERMINAL_STATES,
  ShotsStateError,
  newId,
  validSha,
  assertTransition,
  isTerminal,
  claimsFromIntent,
  requiredForIntent,
  pendingDetail,
  missingIntentDetail,
  recordIntent,
  recordIntentInTransaction,
  recordNotStarted,
  clearNotStarted,
  requireIntentForUiChange,
  clearIntent,
  createRun,
  transitionRun,
  heartbeatRun,
  markStaleForHead,
  overrideRun,
  getRun,
  rerunSameHead,
  runSummary,
  getForSession,
  READY_HOLD_MS,
  brokenOnHead,
  holdsReady,
  _setSettleListenerForTests: setSettleListenerForTests,
};
