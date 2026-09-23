'use strict';

// #2380 — durable lifecycle for agent-authored visual evidence. All state
// changes pass through this module so a new head invalidates old media before
// any serializer can return it. A verified run attests to reproducible,
// complete captures; people decide whether those captures prove the claim.

const crypto = require('crypto');
const planContract = require('./visual-evidence-plan');

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
  exploring: new Set(['replaying', 'failed', 'cancelled']),
  replaying: new Set(['reviewing', 'failed', 'cancelled']),
  reviewing: new Set(['replaying', 'verified', 'failed', 'cancelled']),
  verified: new Set(['stale']),
  failed: new Set(['stale']),
  not_required: new Set(['stale']),
  overridden: new Set(['stale']),
  stale: new Set(),
  cancelled: new Set(),
});

const PATCH_COLUMNS = Object.freeze({
  replayPlan: 'replay_plan',
  planHash: 'plan_hash',
  traceSummary: 'trace_summary',
  hardVerdict: 'hard_verdict',
  failureCode: 'failure_code',
  failureReason: 'failure_reason',
  fixtureFingerprint: 'fixture_fingerprint',
  baseImageDigest: 'base_image_digest',
  headImageDigest: 'head_image_digest',
  repairAttempt: 'repair_attempt',
  startedAt: 'started_at',
  completedAt: 'completed_at',
});

class VisualEvidenceStateError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'VisualEvidenceStateError';
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
    throw new VisualEvidenceStateError(
      'invalid_evidence_transition',
      `Visual evidence cannot move from ${JSON.stringify(from)} to ${JSON.stringify(to)}.`
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

function requiredForIntent(intent, { heuristicUi = false } = {}) {
  if (!intent) return !!heuristicUi;
  if (intent.impact === 'none') return !!heuristicUi;
  return true;
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
      || 'This proposal appears to change the UI but has no visual change preview declaration yet.',
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
    `SELECT visual_evidence_state, visual_evidence_run_id, visual_evidence_detail
       FROM chat_sessions WHERE id = $1 FOR UPDATE`,
    [sessionId]
  );
  const session = selected.rows[0];
  if (!session) throw new VisualEvidenceStateError('session_not_found', 'Proposal session not found.', 404);

  // Build tools can report the same declaration more than once (for
  // example after a transport retry). Treat that as an idempotent write so
  // a completed, same-head run is not accidentally invalidated.
  const currentIntent = session.visual_evidence_detail?.intent || null;
  const sameRevision = !options.headSha
    || session.visual_evidence_detail?.headSha === options.headSha;
  const sameIntent = currentIntent
    && planContract.canonicalJson(currentIntent) === planContract.canonicalJson(intent)
    && requiredForIntent(currentIntent, options) === detail.required
    && sameRevision;
  if (sameIntent) {
    return {
      accepted: true,
      unchanged: true,
      required: detail.required,
      state: session.visual_evidence_state || state,
      intent,
      detail: session.visual_evidence_detail,
      runId: session.visual_evidence_run_id || null,
    };
  }

  // A changed declaration changes what reviewers are being asked to
  // verify. Cancel active work and stale terminal evidence before moving
  // the session pointer; old media may remain for audit/retention but can
  // no longer be served as current evidence.
  await client.query(
    `UPDATE visual_evidence_runs
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
                THEN 'The author changed the visual change preview declaration.'
              ELSE failure_reason
            END,
            completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
      WHERE session_id = $1 AND state NOT IN ('stale','cancelled')`,
    [sessionId]
  );
  await client.query(
    `UPDATE chat_sessions
        SET visual_evidence_state = $2,
            visual_evidence_run_id = NULL,
            visual_evidence_detail = $3::jsonb,
            visual_evidence_updated_at = NOW()
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
// evidence declaration must be part of that same atomic write: a second pool
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
        SET visual_evidence_state = NULL,
            visual_evidence_run_id = NULL,
            visual_evidence_detail = NULL,
            visual_evidence_updated_at = NOW()
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
    throw new VisualEvidenceStateError('invalid_evidence_revision', 'A valid head SHA is required.', 400);
  }
  return withTransaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT visual_evidence_state, visual_evidence_run_id, visual_evidence_detail
         FROM chat_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    const session = selected.rows[0];
    if (!session) throw new VisualEvidenceStateError('session_not_found', 'Proposal session not found.', 404);
    if (session.visual_evidence_detail && typeof session.visual_evidence_detail === 'object'
        && (session.visual_evidence_detail.intent
          || !options.headSha
          || session.visual_evidence_detail.headSha === options.headSha)) {
      return {
        changed: false,
        required: session.visual_evidence_detail.required !== false,
        state: session.visual_evidence_state || 'planned',
        detail: session.visual_evidence_detail,
      };
    }
    await client.query(
      `UPDATE visual_evidence_runs
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
                  THEN 'The UI change has no visual change preview declaration.'
                ELSE failure_reason
              END,
              completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE session_id = $1 AND state NOT IN ('stale','cancelled')`,
      [sessionId]
    );
    const detail = missingIntentDetail(options);
    await client.query(
      `UPDATE chat_sessions
          SET visual_evidence_state = 'planned',
              visual_evidence_run_id = NULL,
              visual_evidence_detail = $2::jsonb,
              visual_evidence_updated_at = NOW()
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
    failureCode: row.failure_code || null,
    failureReason: row.failure_reason || null,
    repairAvailable: row.state === 'failed' && Number(row.repair_attempt || 0) < 1,
    planHash: row.plan_hash || null,
    replayCount: Number.isInteger(trace?.runs) ? Math.max(0, Math.min(2, trace.runs)) : null,
    repairCount: Number.isInteger(Number(row.repair_attempt))
      ? Math.max(0, Math.min(1, Number(row.repair_attempt))) : 0,
    relativePointer: trace?.relativePointer === true,
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

async function createRunWithClient(client, {
  sessionId, baseSha, headSha, intent: rawIntent, trigger = null, heuristicUi = false,
  authorPlan: rawAuthorPlan = null,
}) {
  if (!validSha(baseSha) || !validSha(headSha)) {
    throw new VisualEvidenceStateError('invalid_evidence_revision', 'Visual evidence requires exact 40-character base and head SHAs.', 400);
  }
  const intent = planContract.parseIntent(rawIntent);
  const authorPlan = rawAuthorPlan == null ? null : planContract.parseReplayPlan(rawAuthorPlan);
  if (authorPlan && planContract.canonicalJson(planContract.semanticIntentFromPlan(authorPlan))
      !== planContract.canonicalJson(intent)) {
    throw new VisualEvidenceStateError('evidence_intent_mismatch', 'The author plan changes the accepted visual evidence intent.', 400);
  }
  const required = requiredForIntent(intent, { heuristicUi });
  const initialState = intent.impact === 'none' && !required ? 'not_required' : 'planned';
  const id = newId();

  const locked = await client.query(
    'SELECT id FROM chat_sessions WHERE id = $1 FOR UPDATE',
    [sessionId]
  );
  if (!locked.rows[0]) throw new VisualEvidenceStateError('session_not_found', 'Proposal session not found.', 404);
  const existing = await client.query(
    `SELECT * FROM visual_evidence_runs
      WHERE session_id = $1 AND head_sha = $2
        AND state NOT IN ('stale', 'cancelled')
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [sessionId, headSha]
  );
  if (existing.rows[0]) {
    const run = existing.rows[0];
    if (!authorPlan) return { created: false, run };
    if (run.state !== 'planned') return { created: false, run };
    if (run.base_sha !== baseSha || planContract.canonicalJson(run.intent) !== planContract.canonicalJson(intent)) {
      throw new VisualEvidenceStateError('evidence_revision_mismatch', 'The existing evidence run belongs to another revision or claim.');
    }
    const updated = await client.query(
      `UPDATE visual_evidence_runs SET author_plan = $2::jsonb, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [run.id, JSON.stringify(authorPlan)]
    );
    return { created: false, run: updated.rows[0] };
  }

  // In-flight work for an older revision is cancelled; a terminal verdict
  // becomes stale. Both happen before the session pointer moves.
  await client.query(
    `UPDATE visual_evidence_runs
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
    `INSERT INTO visual_evidence_runs
       (id, session_id, base_sha, head_sha, plan_version, intent, author_plan, state,
        trigger, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $9::jsonb, $7::varchar(24), $8,
        CASE WHEN $7::varchar(24) = 'not_required' THEN NOW() END)
     RETURNING *`,
    [id, sessionId, baseSha, headSha, planContract.PLAN_VERSION,
     JSON.stringify(intent), initialState, clip(trigger, 32),
     authorPlan ? JSON.stringify(authorPlan) : null]
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
        SET visual_evidence_state = $2,
            visual_evidence_run_id = $3,
            visual_evidence_detail = $4::jsonb,
            visual_evidence_updated_at = NOW()
      WHERE id = $1`,
    [sessionId, initialState, id, JSON.stringify(detail)]
  );
  if (!updated.rowCount) throw new VisualEvidenceStateError('session_not_found', 'Proposal session not found.', 404);
  return { created: true, run };
}

async function createRun(pool, options) {
  return withTransaction(pool, (client) => createRunWithClient(client, options));
}

// Import already owns the session INSERT transaction. Store the typed plan
// with the run before committing that session, so no checks/recovery worker
// can start a different planner in the gap after import.
async function createRunInTransaction(client, options) {
  if (!client || typeof client.query !== 'function') throw new TypeError('A transaction client is required');
  return createRunWithClient(client, options);
}

function assertTransitionPayload(row, next, patch) {
  const hard = patch.hardVerdict ?? row.hard_verdict;
  const planHash = patch.planHash ?? row.plan_hash;
  const replayPlan = patch.replayPlan ?? row.replay_plan;

  if (next === 'replaying') {
    if (!replayPlan) throw new VisualEvidenceStateError('missing_replay_plan', 'A validated replay plan is required before replay starts.');
    const parsed = planContract.parseReplayPlan(replayPlan);
    const expectedHash = planContract.planHash(parsed);
    if (planHash && planHash !== expectedHash) {
      throw new VisualEvidenceStateError('evidence_plan_hash_mismatch', 'The replay plan hash does not match its canonical plan.');
    }
    patch.replayPlan = parsed;
    patch.planHash = expectedHash;
  }
  if (next === 'reviewing' && hard?.passed !== true) {
    throw new VisualEvidenceStateError('evidence_hard_verdict_required', 'Captured media requires a passing hard replay verdict.');
  }
  if (next === 'verified') {
    if (!planHash || hard?.passed !== true) {
      throw new VisualEvidenceStateError('evidence_verdict_required', 'Verified captures require a matching plan and passing hard replay verdict.');
    }
    patch.completedAt = patch.completedAt || new Date();
  }
  if (next === 'failed') {
    patch.failureReason = clip(patch.failureReason || row.failure_reason, 2000);
    if (!patch.failureReason) throw new VisualEvidenceStateError('evidence_failure_reason_required', 'Failed evidence requires a user-visible reason.');
    patch.completedAt = patch.completedAt || new Date();
  }
  if (next === 'cancelled' || next === 'stale') patch.completedAt = patch.completedAt || new Date();
}

async function transitionRun(pool, runId, nextState, rawPatch = {}) {
  if (!/^[0-9a-f]{32}$/.test(String(runId || ''))) {
    throw new VisualEvidenceStateError('invalid_evidence_run', 'Invalid visual evidence run id.', 400);
  }
  const patch = { ...rawPatch };
  return withTransaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT r.*, s.visual_evidence_run_id AS current_run_id
         FROM visual_evidence_runs r
         JOIN chat_sessions s ON s.id = r.session_id
        WHERE r.id = $1
        FOR UPDATE OF r, s`,
      [runId]
    );
    const row = selected.rows[0];
    if (!row) throw new VisualEvidenceStateError('evidence_run_not_found', 'Visual change preview run not found.', 404);
    if (row.current_run_id !== row.id) {
      throw new VisualEvidenceStateError(
        'stale_evidence_operation',
        'This run no longer owns the proposal evidence slot.'
      );
    }
    // Recovery reads the run before acquiring this lock. A heartbeat may
    // renew it in between, so check the idle interval again under the lock
    // before failing it or removing its resources.
    if (Object.prototype.hasOwnProperty.call(patch, 'recoveryMinIdleMs')) {
      const idleMs = Date.now() - new Date(row.updated_at).getTime();
      if (!Number.isFinite(idleMs) || idleMs < patch.recoveryMinIdleMs) {
        throw new VisualEvidenceStateError(
          'evidence_run_active', 'This visual evidence run is still active.'
        );
      }
      delete patch.recoveryMinIdleMs;
    }
    assertTransition(row.state, nextState);
    assertTransitionPayload(row, nextState, patch);

    const sets = ['state = $2', 'updated_at = NOW()'];
    const values = [runId, nextState];
    for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      let value = patch[key];
      if (['replayPlan', 'traceSummary', 'hardVerdict'].includes(key)) {
        value = value == null ? null : JSON.stringify(value);
        values.push(value);
        sets.push(`${column} = $${values.length}::jsonb`);
      } else {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
    }
    const updated = await client.query(
      `UPDATE visual_evidence_runs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, values
    );
    const next = updated.rows[0];
    let artifacts = [];
    if (next.state === 'verified') {
      const artifactResult = await client.query(
        `SELECT id, story_id AS "storyId", viewport, side, variant, media,
                content_type AS "contentType", width, height, bytes, sha256,
                focus_rect AS "focusRect", stage_labels AS "stageLabels"
           FROM visual_evidence_artifacts
          WHERE run_id = $1
          ORDER BY story_id, viewport, side, variant`,
        [next.id]
      );
      artifacts = artifactResult.rows;
    }
    const detail = { ...runSummary(next, artifacts), intent: next.intent };
    const sessionUpdate = await client.query(
      `UPDATE chat_sessions
          SET visual_evidence_state = $2,
              visual_evidence_run_id = $3,
              visual_evidence_detail = $4::jsonb,
              visual_evidence_updated_at = NOW()
        WHERE id = $1 AND visual_evidence_run_id = $3`,
      [next.session_id, next.state, next.id, JSON.stringify(detail)]
    );
    if (!sessionUpdate.rowCount) {
      throw new VisualEvidenceStateError(
        'stale_evidence_operation',
        'The proposal evidence owner changed while the run was updating.'
      );
    }
    return next;
  });
}

// A fire-and-forget evidence run belongs to a web process. Keep a durable
// lease while that process is alive so a rollout can be distinguished from a
// slow checkout, clone, or image build. Only the current active run may renew
// its lease; a late heartbeat cannot revive a failed or superseded run.
async function heartbeatRun(pool, runId, phase, replayProgress = null) {
  if (!/^[0-9a-f]{32}$/.test(String(runId || ''))
      || !/^[a-z][a-z0-9_-]{0,63}$/.test(String(phase || ''))) {
    throw new VisualEvidenceStateError('invalid_evidence_heartbeat', 'Evidence heartbeat identity or phase is invalid.', 400);
  }
  const progressPatch = replayProgress == null ? null : JSON.stringify({
    lastReplayEvent: replayProgress.lastReplayEvent || null,
    replayEvents: Array.isArray(replayProgress.replayEvents)
      ? replayProgress.replayEvents.slice(-40) : [],
  });
  if (progressPatch && progressPatch.length > 64_000) {
    throw new VisualEvidenceStateError('invalid_evidence_heartbeat', 'Evidence heartbeat trace is too large.', 400);
  }
  const result = await pool.query(
    `UPDATE visual_evidence_runs r
        SET updated_at = NOW(),
            trace_summary = jsonb_set(
              COALESCE(r.trace_summary, '{}'::jsonb), '{progress}',
              jsonb_build_object('phase', $2::text, 'at', NOW()), true)
              || COALESCE($3::jsonb, '{}'::jsonb)
       FROM chat_sessions s
      WHERE r.id = $1 AND s.id = r.session_id
        AND s.visual_evidence_run_id = r.id
        AND r.state IN ('provisioning','exploring','replaying','reviewing')`,
    [runId, phase, progressPatch]
  );
  return { active: (result.rowCount || 0) > 0 };
}

async function markStaleForHead(pool, sessionId, headSha, reason = 'A newer proposal revision superseded this visual change preview.') {
  if (!validSha(headSha)) throw new VisualEvidenceStateError('invalid_evidence_revision', 'A valid head SHA is required.', 400);
  return withTransaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT visual_evidence_state, visual_evidence_run_id, visual_evidence_detail
         FROM chat_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    const session = selected.rows[0];
    if (!session) throw new VisualEvidenceStateError('session_not_found', 'Proposal session not found.', 404);
    const result = await client.query(
      `UPDATE visual_evidence_runs
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
    const previous = session.visual_evidence_detail && typeof session.visual_evidence_detail === 'object'
      ? session.visual_evidence_detail : {};
    const intent = previous.intent && typeof previous.intent === 'object' ? previous.intent : null;
    const revisionChanged = previous.headSha && previous.headSha !== headSha;
    if (result.rowCount || revisionChanged) {
      let detail;
      let nextState = 'planned';
      if (intent) {
        // Keep the already-validated semantic intent while dropping every
        // run-derived field. The next exact revision needs a new plan and two
        // new clean replays, but the author should not have to restate what
        // the change is meant to prove after every push.
        const heuristicUi = previous.required === true && intent.impact === 'none';
        detail = pendingDetail(intent, { heuristicUi, headSha, reason });
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
            SET visual_evidence_state = $2,
                visual_evidence_run_id = NULL,
                visual_evidence_detail = $3::jsonb,
                visual_evidence_updated_at = NOW()
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
    throw new VisualEvidenceStateError('invalid_evidence_override', 'An authorized user and visible override reason are required.', 400);
  }
  return withTransaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT r.*, s.visual_evidence_run_id AS current_run_id
         FROM visual_evidence_runs r
         JOIN chat_sessions s ON s.id = r.session_id
        WHERE r.id = $1 FOR UPDATE OF r, s`,
      [runId]
    );
    const row = selected.rows[0];
    if (!row) throw new VisualEvidenceStateError('evidence_run_not_found', 'Visual change preview run not found.', 404);
    if (row.current_run_id !== row.id) {
      throw new VisualEvidenceStateError('stale_evidence_operation', 'Only the proposal’s current evidence run can be overridden.');
    }
    if (!['planned', 'provisioning', 'exploring', 'replaying', 'reviewing', 'failed'].includes(row.state)) {
      throw new VisualEvidenceStateError('invalid_evidence_override_state', `Evidence in state ${row.state} cannot be overridden.`);
    }
    const updated = await client.query(
      `UPDATE visual_evidence_runs
          SET state = 'overridden', override_user_id = $2, override_reason = $3,
              overridden_at = NOW(), completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [runId, Number(userId), overrideReason]
    );
    const next = updated.rows[0];
    const sessionUpdated = await client.query(
      `UPDATE chat_sessions
          SET visual_evidence_state = 'overridden', visual_evidence_run_id = $2,
              visual_evidence_detail = $3::jsonb, visual_evidence_updated_at = NOW()
        WHERE id = $1 AND visual_evidence_run_id = $2`,
      [next.session_id, next.id, JSON.stringify({ ...runSummary(next), intent: next.intent })]
    );
    if (!sessionUpdated.rowCount) {
      throw new VisualEvidenceStateError('stale_evidence_operation', 'The proposal evidence owner changed during the override.');
    }
    return next;
  });
}

async function getRun(pool, runId, { forUpdate = false } = {}) {
  if (!/^[0-9a-f]{32}$/.test(String(runId || ''))) {
    throw new VisualEvidenceStateError('invalid_evidence_run', 'Invalid visual evidence run id.', 400);
  }
  const result = await pool.query(
    `SELECT r.*, s.visual_evidence_run_id AS current_run_id,
            s.visual_evidence_state AS current_evidence_state,
            s.visual_evidence_detail AS current_evidence_detail
       FROM visual_evidence_runs r
       JOIN chat_sessions s ON s.id = r.session_id
      WHERE r.id = $1${forUpdate ? ' FOR UPDATE OF r, s' : ''}`,
    [runId]
  );
  if (!result.rows[0]) throw new VisualEvidenceStateError('evidence_run_not_found', 'Visual change preview run not found.', 404);
  return result.rows[0];
}

// A same-head retry creates a new immutable run rather than rewinding the old
// row. This preserves the failed/verified audit record while the partial
// unique index guarantees there is still one reviewer-visible owner.
async function rerunSameHead(pool, runId, {
  trigger = 'manual-rerun', intent: replacementIntent = null, authorPlan: replacementPlan = undefined,
} = {}) {
  return withTransaction(pool, async (client) => {
    const old = await getRun(client, runId, { forUpdate: true });
    if (!['failed', 'verified', 'overridden', 'not_required'].includes(old.state)) {
      throw new VisualEvidenceStateError('evidence_rerun_in_flight', 'Wait for the current evidence run to finish before rerunning it.');
    }
    if (old.current_run_id !== old.id) {
      throw new VisualEvidenceStateError('stale_evidence_operation', 'Only the proposal\'s current evidence run can be rerun.');
    }
    const intent = planContract.parseIntent(replacementIntent || old.intent);
    const authorPlan = replacementPlan === undefined ? old.author_plan
      : (replacementPlan == null ? null : planContract.parseReplayPlan(replacementPlan));
    if (authorPlan && planContract.canonicalJson(planContract.semanticIntentFromPlan(authorPlan))
        !== planContract.canonicalJson(intent)) {
      throw new VisualEvidenceStateError('evidence_intent_mismatch', 'The replacement plan changes the accepted visual evidence intent.', 400);
    }
    const heuristicUi = old.current_evidence_detail?.required === true && intent.impact === 'none';
    const required = requiredForIntent(intent, { heuristicUi });
    const initialState = intent.impact === 'none' && !required ? 'not_required' : 'planned';
    await client.query(
      `UPDATE visual_evidence_runs
          SET state = 'stale', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE id = $1`,
      [old.id]
    );
    const id = newId();
    const inserted = await client.query(
      `INSERT INTO visual_evidence_runs
         (id, session_id, base_sha, head_sha, plan_version, intent, author_plan, state,
          trigger, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $9::jsonb, $7::varchar(24), $8,
          CASE WHEN $7::varchar(24) = 'not_required' THEN NOW() END)
       RETURNING *`,
      [id, old.session_id, old.base_sha, old.head_sha, planContract.PLAN_VERSION,
       JSON.stringify(intent), initialState, clip(trigger, 32),
       authorPlan ? JSON.stringify(authorPlan) : null]
    );
    const next = inserted.rows[0];
    const updated = await client.query(
      `UPDATE chat_sessions
          SET visual_evidence_state = $2, visual_evidence_run_id = $3,
              visual_evidence_detail = $4::jsonb, visual_evidence_updated_at = NOW()
        WHERE id = $1 AND visual_evidence_run_id = $5`,
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
      throw new VisualEvidenceStateError('stale_evidence_operation', 'The proposal evidence owner changed during the rerun.');
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
                FROM visual_evidence_artifacts a WHERE a.run_id = r.id
            ), '[]'::jsonb) AS artifact_summary
       FROM visual_evidence_runs r
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
// `visual_evidence_updated_at`: that timestamp is how the reviewer surfaces
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
        SET visual_evidence_detail = COALESCE(visual_evidence_detail, '{}'::jsonb)
              || jsonb_build_object('notStartedReason', $2::text)
      WHERE id = $1
        AND visual_evidence_state = 'planned'
        AND visual_evidence_detail->>'notStartedReason' IS DISTINCT FROM $2::text
      RETURNING id`,
    [id, text]
  );
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
        SET visual_evidence_detail = visual_evidence_detail - 'notStartedReason'
      WHERE id = $1 AND jsonb_exists(visual_evidence_detail, 'notStartedReason')
      RETURNING id`,
    [id]
  );
  return { cleared: rows.length > 0 };
}

module.exports = {
  STATES,
  TRANSITIONS,
  TERMINAL_STATES,
  VisualEvidenceStateError,
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
  createRunInTransaction,
  transitionRun,
  heartbeatRun,
  markStaleForHead,
  overrideRun,
  getRun,
  rerunSameHead,
  runSummary,
  getForSession,
};
