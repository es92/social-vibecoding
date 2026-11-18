'use strict';

// #2380: a proposal's before & after shots, as the rest of the platform
// reads them and declares them. The shots machine (src/workflow/shots/) is
// their one writer: every declaration, head move, run and waiver is an event
// it decides on, and the slot on chat_sessions and the rows of shot_runs are
// its domain writes. This module keeps the readers, and the entry points the
// declaring flows call (recordIntent, recordIntentInTransaction,
// markStaleForHead), which validate and append. A verified run means at
// least one declared change has a complete set of shots on the exact
// revisions; people decide whether those shots show the change.

const crypto = require('crypto');
const planContract = require('./visible-changes');
const shots = require('./shots-files');
const detailRules = require('../workflow/rules/shots-detail.ts');

let workflowForTests = null;
const workflow = () => workflowForTests || require('../workflow/platform.ts');

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

// A run that failed on a platform step that says nothing about the
// proposal, by its kind (shots-orchestrator.platformFault): the shots
// machine takes the same head again once. Only these kinds are taken again:
// a build that fails, a change that broke on the after build or a state the
// copies cannot reach is the proposal's to fix.
const PLATFORM_FAULT_KINDS = new Set([
  'database', 'clone', 'worker_bootstrap', 'github_rate_limited', 'github_unavailable', 'agent_exit',
]);

const { currentCode, agentBusyCode, AGENT_BUSY_REASON } = detailRules;

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

const { claimsFromIntent, requiredForIntent, pendingDetail, missingIntentDetail } = detailRules;

// ── Declarations (the shots machine decides) ─────────────────────────────

function prepareIntent(rawIntent, options) {
  const intent = planContract.parseIntent(rawIntent);
  const detail = pendingDetail(intent, options);
  const state = intent.impact === 'none' && !detail.required ? 'not_required' : 'planned';
  return { intent, detail, state };
}

async function sessionApp(pool, sessionId) {
  const { rows: [row] } = await pool.query('SELECT app_id FROM chat_sessions WHERE id = $1', [sessionId]);
  if (!row) throw new ShotsStateError('session_not_found', 'Proposal session not found.', 404);
  return row.app_id;
}

/**
 * A declaration of visible changes for the proposal (validated here), for
 * `options.headSha` or its newest head: the shots machine records it, ends
 * shots it changes, and takes the shots once the head is ready. The same
 * declaration again changes nothing. Resolves what the slot reads now.
 * `options.pin` / `options.from` fence `headSha` as markStaleForHead's do:
 * a declaration for a revision a newer move overtook is refused.
 */
async function recordIntent(pool, sessionId, rawIntent, options = {}) {
  const prepared = prepareIntent(rawIntent, options);
  const id = Number(sessionId);
  const outcome = await workflow().shotsDeclared({
    sessionId: id, appId: await sessionApp(pool, id), head: options.headSha || null, intent: prepared.intent,
    pin: options.pin || null, from: options.from || null,
  });
  if (outcome.status === 'rejected' && outcome.reason === 'stale_head') {
    throw new ShotsStateError('stale_head', 'A newer revision of this proposal replaced the one this declaration was for.', 409);
  }
  if (outcome.status === 'rejected' || outcome.status === 'faulted') {
    throw new ShotsStateError(outcome.reason || 'shots_declaration_refused', 'The declaration of visible changes was not recorded.');
  }
  const reply = outcome.reply || {};
  return {
    accepted: true,
    unchanged: reply.unchanged === true,
    required: prepared.detail.required,
    state: reply.state || prepared.state,
    intent: prepared.intent,
    detail: reply.detail || prepared.detail,
    runId: reply.runId || null,
  };
}

// PR import owns the transaction that inserts the proposal row: its
// declaration is appended in that transaction, and the shots machine
// records it once it commits.
async function recordIntentInTransaction(client, sessionId, rawIntent, options = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A transaction client is required');
  }
  const prepared = prepareIntent(rawIntent, options);
  await workflow().shotsDeclared({
    sessionId: Number(sessionId), head: options.headSha || null, intent: prepared.intent, db: client,
    pin: options.pin || null, from: options.from || null,
  });
  return {
    accepted: true, unchanged: false, required: prepared.detail.required, state: prepared.state,
    intent: prepared.intent, detail: prepared.detail, runId: null,
  };
}

// The proposal's head moved to `headSha`: shots of other heads stop
// counting (the shots machine ends a run of another head). `fence.pin`
// names the revision column the caller moved ('imported', 'reviewed',
// 'handoff'), and `fence.from` the head the caller read there (when it
// appends before it writes): a move a newer one overtook is then refused.
async function markStaleForHead(pool, sessionId, headSha, reason = null, fence = {}) {
  if (!validSha(headSha)) throw new ShotsStateError('invalid_shots_revision', 'A valid head SHA is required.', 400);
  await workflow().shotsHeadMoved(Number(sessionId), headSha, reason, { pin: fence.pin || null, from: fence.from || null });
  return 1;
}

// A person's Retry (with a new declaration, maybe), Stop and waiver, for
// the shots routes: the shots machine decides, and its outcome is answered.
function retryShots({ sessionId, appId, intent = null, actor = null }) {
  return workflow().shotsRetry({ sessionId: Number(sessionId), appId: Number(appId), intent, actor });
}
function stopShots({ sessionId, appId, actor = null }) {
  return workflow().shotsStop({ sessionId: Number(sessionId), appId: Number(appId), actor });
}
function waiveShots({ sessionId, appId, userId, reason }) {
  return workflow().shotsWaive({ sessionId: Number(sessionId), appId: Number(appId), userId: Number(userId), reason });
}

// ── A run under way, for the flows that wait for it ─────────────────────
//
// A shots run holds the proposal's agent from its copies' first build to
// its agent's last word. A coding turn (the Homeroom bot's) waits for it
// rather than taking the agent from under it (#4575). Read
// from the shots machine's instance, so it answers for every process and
// across restarts.

async function shotsRunning(sessionId) {
  return workflow().shotsRunning(Number(sessionId));
}

const SHOTS_RUN_POLL_MS = 2000;

// Wait, at most `timeoutMs`, for a run under way on the proposal to end:
// 'idle' when there was none, 'finished' or 'timeout'. Never throws.
async function waitForShotsRun(sessionId, { timeoutMs, pollMs = SHOTS_RUN_POLL_MS } = {}) {
  const running = () => shotsRunning(sessionId).catch(() => false);
  if (!(await running())) return 'idle';
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))); });
    if (!(await running())) return 'finished';
  }
  return 'timeout';
}

// A run's row as the proposal reads it (src/workflow/rules/shots-detail.ts),
// its changes' stored conditions tidied.
function runSummary(row, artifactSummary = []) {
  return detailRules.runSummary(row, artifactSummary, { cleanConditions: shots.cleanConditions });
}

// How long a ready-to-try message waits on shots that have not settled, the
// shots on a head that failed or were skipped for want of seed data, and
// whether shots still hold a change: the Homeroom bot's change machine
// decides from these (src/workflow/rules/bot-readiness.ts, the one copy;
// src/workflow/bot-change/), and this module's callers read them here.
const readiness = require('../workflow/rules/bot-readiness.ts');
const { READY_HOLD_MS, brokenOnHead, seedableSkip, skippedOnHead } = readiness;

// ── A skip its author can fix ────────────────────────────────────────────
//
// 9 to 12 Oct 2026: of the 166 merged proposals that needed shots, 22 runs
// failed with no declared change reachable and 13 more changes were skipped
// inside runs that published, and each of those proposals went to its vote
// without pictures of that change. Only a change that FAILED went back to its
// author (brokenOnHead); a skip went nowhere.
//
// The shots agent skips a change for two kinds of reason. Some say the
// copies lack the data the change needs: "The after copy has no '[Mock]
// Advisory vote' row", "These copies have no member with a nearly spent
// weekly allowance", "no fixture for this state". Its author can supply
// that, with a staging seed in the proposal or a hints.setup step. Others
// say the copies lack something no data gives them: a model key (4 of the
// 35), a wallet (4), a mailbox to read a code from, a file to upload, a
// network to drop, a location, the browser's own tab; or the after build
// answered an error, or the agent never finished. A seed changes none of
// those, so they never go back.
//
// So the rule is narrow on purpose. A skip qualifies only when its reason
// names missing data (MISSING_DATA_RE) and none of those causes
// (NOT_SEEDABLE_RE). The claim says whether its screen is new on the after
// side (baseState not_present): a seed the proposal adds runs on the after
// copy alone, which for a new change is the side that has it, and for a
// change to a screen both sides already show the same seed would make them
// differ by more than the change. 18 Nov 2026 (#6822): such a claim goes
// back too, but to a ready-made demo state that both copies already hold,
// never to a seed (the Homeroom bot's fix turn asks for one; anyone else's
// is not told to seed it). 11 of the 35 reasons name missing data and no
// such cause.
/** Pure: whether shots of head `headSha` are still to come (bot-readiness.ts heldUntil). */
function holdsReady(row, headSha, { now = Date.now() } = {}) {
  return readiness.holdsReady(row, headSha, now);
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
async function getForSession(pool, sessionId, { headSha = null } = {}) {
  const values = [sessionId];
  const headClause = headSha ? `AND r.head_sha = $${values.push(headSha)}` : '';
  const result = await pool.query(
    `SELECT r.*,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', a.id, 'storyId', a.story_id, 'viewport', a.viewport,
                'side', a.side, 'variant', a.variant, 'media', a.media,
                'theme', a.theme,
                'contentType', a.content_type, 'width', a.width,
                'height', a.height, 'bytes', a.bytes,
                'density', a.density, 'denseWidth', a.dense_width, 'denseHeight', a.dense_height,
                'sha256', a.sha256,
                'focusRect', a.focus_rect, 'stageLabels', a.stage_labels,
                'part', a.part, 'scale', a.scale
              ) ORDER BY a.story_id, a.viewport, a.side, a.variant, a.theme, a.part)
                FROM shot_artifacts a WHERE a.run_id = r.id
            ), '[]'::jsonb) AS artifact_summary
       FROM shot_runs r
      WHERE r.session_id = $1 ${headClause}
        AND r.state NOT IN ('stale','cancelled')
      ORDER BY r.created_at DESC LIMIT 1`,
    values
  );
  const row = result.rows[0];
  return row ? runSummary(row, row.artifact_summary || []) : null;
}

// Published runs by id, with their files, whatever their state now (a run
// of an earlier head went stale when the head moved): the previous
// version's shots a proposal's card keeps while its current version's are
// taken (shots_detail.previous, shots-view.js). Only a run that published
// has files. Each summary carries its id and its proposal's.
async function getPublishedRuns(pool, runIds) {
  const ids = [...new Set((Array.isArray(runIds) ? runIds : [])
    .filter((id) => /^[0-9a-f]{32}$/.test(String(id || ''))))];
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT r.*,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', a.id, 'storyId', a.story_id, 'viewport', a.viewport,
                'side', a.side, 'variant', a.variant, 'media', a.media,
                'theme', a.theme,
                'contentType', a.content_type, 'width', a.width,
                'height', a.height, 'bytes', a.bytes,
                'density', a.density, 'denseWidth', a.dense_width, 'denseHeight', a.dense_height,
                'focusRect', a.focus_rect, 'stageLabels', a.stage_labels,
                'part', a.part, 'scale', a.scale
              ) ORDER BY a.story_id, a.viewport, a.side, a.variant, a.theme, a.part)
                FROM shot_artifacts a WHERE a.run_id = r.id
            ), '[]'::jsonb) AS artifact_summary
       FROM shot_runs r
      WHERE r.id = ANY($1::varchar[]) AND r.state IN ('verified', 'stale')`,
    [ids]
  );
  return new Map(rows.map((row) => [String(row.id), {
    ...runSummary(row, row.artifact_summary || []), id: String(row.id), sessionId: Number(row.session_id),
  }]));
}

module.exports = {
  currentCode,
  AGENT_BUSY_REASON,
  agentBusyCode,
  PLATFORM_FAULT_KINDS,
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
  markStaleForHead,
  retryShots,
  stopShots,
  waiveShots,
  shotsRunning,
  waitForShotsRun,
  getRun,
  runSummary,
  getForSession,
  getPublishedRuns,
  READY_HOLD_MS,
  brokenOnHead,
  seedableSkip,
  skippedOnHead,
  holdsReady,
  _setWorkflowForTests: (w) => { workflowForTests = w; },
};
