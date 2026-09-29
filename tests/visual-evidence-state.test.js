'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const state = require('../src/services/visual-evidence-state');
const contract = require('../src/services/visual-evidence-plan');
const shots = require('../src/services/visual-evidence-shots');
const { intent, motionIntent } = require('./fixtures/visual-evidence');

const RUN_ID = 'e'.repeat(32);
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const MANIFEST_HASH = 'c'.repeat(64);

// A shots verdict as the orchestrator folds it: one change ready, one skipped.
function shotsVerdict(stories = [
  { id: 'invite-suggestions', status: 'ready', files: 2 },
]) {
  return { passed: stories.some((story) => story.status === 'ready'), mode: shots.SHOTS_MODE, runs: 1, stories };
}

// A transaction-less pool over one run row. It answers the transition's
// locking SELECT, applies the UPDATE's patch back onto the row, and records
// every statement so a refused payload can be shown to write nothing.
function runPool(row) {
  const statements = [];
  const pool = { query: async (sql, values) => {
    statements.push({ sql: String(sql), values });
    if (/SELECT r\.\*/.test(sql)) return { rows: [row] };
    if (/UPDATE visual_evidence_runs/.test(sql)) {
      Object.assign(row, { state: values[1] });
      return { rows: [{ ...row }] };
    }
    if (/FROM visual_evidence_artifacts/.test(sql)) return { rows: [] };
    if (/UPDATE chat_sessions/.test(sql)) return { rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  return { pool, statements };
}

function runRow(overrides = {}) {
  return {
    id: RUN_ID, session_id: 42, current_run_id: RUN_ID, state: 'exploring',
    base_sha: BASE_SHA, head_sha: HEAD_SHA, intent: intent(),
    plan_hash: null, hard_verdict: null, semantic_verdict: null,
    updated_at: new Date('2026-09-22T00:00:00Z'),
    ...overrides,
  };
}

test('controlled failure evidence is clearly labeled in reviewer-visible flow', () => {
  const declaration = intent();
  declaration.stories[0].intent.controlledFailurePath = '/api/lists/demo';
  declaration.stories[0].intent.steps.unshift(contract.CONTROLLED_FAILURE_LABEL);
  const claims = state.claimsFromIntent(contract.parseIntent(declaration));
  assert.equal(claims[0].steps[0], contract.CONTROLLED_FAILURE_LABEL);
});

test('a run moves exploring -> reviewing -> verified and nothing re-enters replaying', () => {
  const allowed = [
    ['planned', 'provisioning'],
    ['provisioning', 'exploring'],
    ['exploring', 'reviewing'],
    ['reviewing', 'verified'],
    ['verified', 'stale'],
    ['failed', 'stale'],
    ['exploring', 'failed'],
    ['exploring', 'cancelled'],
    ['reviewing', 'failed'],
    ['reviewing', 'cancelled'],
  ];
  for (const [from, to] of allowed) assert.doesNotThrow(() => state.assertTransition(from, to), `${from} -> ${to}`);
  for (const [from, to] of [
    // The retired replay loop.
    ['exploring', 'replaying'], ['replaying', 'replaying'], ['replaying', 'reviewing'],
    ['reviewing', 'replaying'], ['replaying', 'verified'],
    // Shots are always stored (reviewing) before they are published.
    ['provisioning', 'reviewing'], ['exploring', 'verified'], ['planned', 'verified'],
    ['failed', 'planned'], ['stale', 'verified'], ['cancelled', 'planned'],
    ['verified', 'reviewing'], ['exploring', 'nonsense'],
  ]) {
    assert.throws(() => state.assertTransition(from, to), { code: 'invalid_evidence_transition' }, `${from} -> ${to}`);
  }
});

test('a legacy replaying row can only be failed or cancelled by recovery', () => {
  assert.ok(state.STATES.includes('replaying'));
  assert.deepEqual([...state.TRANSITIONS.replaying].sort(), ['cancelled', 'failed']);
  for (const [from, targets] of Object.entries(state.TRANSITIONS)) {
    if (from === 'replaying') continue;
    assert.equal(targets.has('replaying'), false, `${from} must not lead to replaying`);
  }
});

test('storing shots (reviewing) requires a verdict with at least one ready change', async () => {
  for (const hardVerdict of [undefined, null, { passed: false, mode: 'shots', runs: 1, stories: [] },
    shotsVerdict([{ id: 'invite-suggestions', status: 'skipped', reason: 'Members is not reachable.' }])]) {
    const { pool, statements } = runPool(runRow());
    await assert.rejects(state.transitionRun(pool, RUN_ID, 'reviewing', {
      ...(hardVerdict === undefined ? {} : { hardVerdict }), planHash: MANIFEST_HASH,
    }), { code: 'evidence_hard_verdict_required' });
    assert.equal(statements.filter(({ sql }) => /^\s*UPDATE/.test(sql)).length, 0, 'a refused payload writes nothing');
  }

  const { pool, statements } = runPool(runRow());
  const verdict = shotsVerdict();
  const next = await state.transitionRun(pool, RUN_ID, 'reviewing', { hardVerdict: verdict, planHash: MANIFEST_HASH });
  assert.equal(next.state, 'reviewing');
  const update = statements.find(({ sql }) => /UPDATE visual_evidence_runs/.test(sql));
  assert.match(update.sql, /hard_verdict = \$\d+::jsonb/);
  assert.match(update.sql, /plan_hash = \$\d+/);
  assert.ok(update.values.includes(JSON.stringify(verdict)));
  assert.ok(update.values.includes(MANIFEST_HASH));
});

test('publishing (verified) requires the stored manifest hash and a passing verdict', async () => {
  const missingHash = runPool(runRow({ state: 'reviewing', hard_verdict: shotsVerdict() }));
  await assert.rejects(state.transitionRun(missingHash.pool, RUN_ID, 'verified'), { code: 'evidence_verdict_required' });
  assert.equal(missingHash.statements.length, 1, 'only the locking read ran');

  const notPassed = runPool(runRow({
    state: 'reviewing', plan_hash: MANIFEST_HASH, hard_verdict: { ...shotsVerdict(), passed: false },
  }));
  await assert.rejects(state.transitionRun(notPassed.pool, RUN_ID, 'verified'), { code: 'evidence_verdict_required' });

  const ready = runPool(runRow({ state: 'reviewing', plan_hash: MANIFEST_HASH, hard_verdict: shotsVerdict() }));
  const published = await state.transitionRun(ready.pool, RUN_ID, 'verified');
  assert.equal(published.state, 'verified');
  const update = ready.statements.find(({ sql }) => /UPDATE visual_evidence_runs/.test(sql));
  assert.match(update.sql, /completed_at = \$\d+/, 'publishing stamps completion');
  // No model grades the shots: people judge them.
  assert.doesNotMatch(update.sql, /semantic_verdict/);
  const session = ready.statements.find(({ sql }) => /UPDATE chat_sessions/.test(sql));
  const detail = JSON.parse(session.values[3]);
  assert.equal(detail.verifiedReason, null);
  assert.deepEqual(detail.shotResults, [{ id: 'invite-suggestions', status: 'ready', reason: null }]);
  assert.deepEqual(detail.intent, intent());
});

test('a failed run needs a bounded, person-readable reason', async () => {
  const silent = runPool(runRow());
  await assert.rejects(state.transitionRun(silent.pool, RUN_ID, 'failed', { failureCode: 'evidence_capture_incomplete' }),
    { code: 'evidence_failure_reason_required' });
  assert.equal(silent.statements.length, 1);

  const blank = runPool(runRow());
  await assert.rejects(state.transitionRun(blank.pool, RUN_ID, 'failed', { failureReason: '   ' }),
    { code: 'evidence_failure_reason_required' });

  const long = runPool(runRow());
  await state.transitionRun(long.pool, RUN_ID, 'failed', {
    failureCode: 'evidence_capture_incomplete', failureReason: `  ${'x'.repeat(3000)}  `,
  });
  const update = long.statements.find(({ sql }) => /UPDATE visual_evidence_runs/.test(sql));
  assert.ok(update.values.includes('x'.repeat(2000)), 'the reason is trimmed and clipped to 2000 characters');
  assert.match(update.sql, /completed_at = \$\d+/);

  // A reason the run already carries (a recovery write) satisfies the rule.
  const carried = runPool(runRow({ failure_reason: 'The preview agent timed out.' }));
  await state.transitionRun(carried.pool, RUN_ID, 'failed', { failureCode: 'evidence_run_interrupted' });
  assert.equal(carried.statements.filter(({ sql }) => /UPDATE visual_evidence_runs/.test(sql)).length, 1);
});

test('a run that lost its proposal slot cannot move at all', async () => {
  const { pool, statements } = runPool(runRow({ current_run_id: 'f'.repeat(32) }));
  await assert.rejects(state.transitionRun(pool, RUN_ID, 'failed', { failureReason: 'late' }),
    { code: 'stale_evidence_operation' });
  assert.equal(statements.length, 1);
  await assert.rejects(state.transitionRun(pool, 'not-a-run', 'failed'), { code: 'invalid_evidence_run' });
});

test('terminal-state and required-evidence policy distinguish an explicit no-impact rationale', () => {
  assert.equal(state.isTerminal('verified'), true);
  assert.equal(state.isTerminal('reviewing'), false);
  const none = { version: 1, impact: 'none', rationale: 'Backend-only.', stories: [] };
  assert.equal(state.requiredForIntent(none), false);
  assert.equal(state.requiredForIntent(none, { heuristicUi: true }), false);
  assert.equal(state.requiredForIntent(null, { heuristicUi: true }), true);
  assert.equal(state.requiredForIntent(null), false);
  assert.equal(state.requiredForIntent({ ...none, impact: 'ui' }), true);
  assert.deepEqual(state.missingIntentDetail({ headSha: 'a'.repeat(40) }), {
    version: 1,
    required: true,
    impact: null,
    rationale: null,
    claims: [],
    headSha: 'a'.repeat(40),
    reason: 'This proposal appears to change the UI but has not declared the change for before/after shots yet.',
  });
});

test('an intent conflict does not offer a retry that would repeat the same failure', () => {
  const row = {
    state: 'failed', failure_code: 'visual_evidence_intent_conflict',
    intent: { version: 1, impact: 'none', rationale: 'Error UI changed.', stories: [] },
    base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
  };
  assert.equal(state.runSummary(row).repairAvailable, false);
  assert.equal(state.runSummary({ ...row, failure_code: 'evidence_capture_incomplete' }).repairAvailable, true);
  assert.equal(state.runSummary({ ...row, state: 'exploring', failure_code: null }).repairAvailable, false);
});

test('evidence heartbeat renews only the current active run and stores a bounded stage', async () => {
  let statement;
  const pool = { query: async (sql, values) => {
    statement = { sql: String(sql), values };
    return { rowCount: 1 };
  } };
  const id = 'f'.repeat(32);
  assert.deepEqual(await state.heartbeatRun(pool, id, 'checkout_revisions'), { active: true });
  assert.deepEqual(statement.values, [id, 'checkout_revisions', null]);
  assert.match(statement.sql, /s\.visual_evidence_run_id = r\.id/);
  assert.match(statement.sql, /r\.state IN \('provisioning','exploring','replaying','reviewing'\)/);
  assert.match(statement.sql, /trace_summary = jsonb_set/);
  await state.heartbeatRun(pool, id, 'agent_exploration', {
    agentActivity: { version: 1, events: [{ kind: 'tool_start', tool: 'browser_navigate' }] },
    agentFinalResponse: { excerpt: 'Preview agent stopped.', characters: 22 },
  });
  assert.deepEqual(JSON.parse(statement.values[2]), {
    agentActivity: { version: 1, events: [{ kind: 'tool_start', tool: 'browser_navigate' }] },
    agentFinalResponse: { excerpt: 'Preview agent stopped.', characters: 22 },
  });
  await state.heartbeatRun(pool, id, 'clone_base', {
    heartbeat: { processId: 'a'.repeat(16), poolTotal: 10, poolIdle: 0, poolWaiting: 8 },
  });
  assert.deepEqual(JSON.parse(statement.values[2]), {
    heartbeat: { processId: 'a'.repeat(16), poolTotal: 10, poolIdle: 0, poolWaiting: 8 },
  });
  await assert.rejects(state.heartbeatRun(pool, id, 'agent_exploration', {
    agentFinalResponse: { excerpt: 'x'.repeat(70_000) },
  }), { code: 'invalid_evidence_heartbeat' });
  await assert.rejects(state.heartbeatRun(pool, id, 'https://private.internal'), {
    code: 'invalid_evidence_heartbeat',
  });
});

test('interrupted recovery rechecks the heartbeat under the transition lock', async () => {
  const id = 'f'.repeat(32);
  const pool = { query: async (sql) => {
    if (String(sql).includes('FOR UPDATE OF r, s')) {
      return { rows: [{ id, current_run_id: id, state: 'provisioning', updated_at: new Date() }] };
    }
    throw new Error('a renewed run must not be updated');
  } };
  await assert.rejects(state.transitionRun(pool, id, 'failed', {
    failureCode: 'evidence_run_interrupted',
    failureReason: 'Worker stopped.',
    recoveryMinIdleMs: 60_000,
  }), { code: 'evidence_run_active' });
});

test('recordIntentInTransaction reuses its caller-owned client without reconnecting or releasing it', async () => {
  const queries = [];
  let connectCalls = 0;
  let releaseCalls = 0;
  const client = {
    async connect() {
      connectCalls += 1;
      throw new Error('a checked-out PoolClient must not be connected again');
    },
    release() { releaseCalls += 1; },
    async query(sql, values) {
      queries.push({ sql: String(sql), values });
      if (/SELECT visual_evidence_state/.test(String(sql))) {
        return {
          rows: [{
            visual_evidence_state: null,
            visual_evidence_run_id: null,
            visual_evidence_detail: null,
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const result = await state.recordIntentInTransaction(
    client, 42, intent(), { headSha: 'a'.repeat(40) }
  );

  assert.equal(result.accepted, true);
  assert.equal(result.state, 'planned');
  assert.equal(connectCalls, 0, 'the route already checked this client out');
  assert.equal(releaseCalls, 0, 'the route retains ownership of its client');
  assert.deepEqual(
    queries.map(({ sql }) => sql.trim().split(/\s+/)[0]),
    ['SELECT', 'UPDATE', 'UPDATE'],
    'only the evidence statements run inside the existing transaction'
  );
  assert.ok(!queries.some(({ sql }) => /^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())),
    'the caller owns the surrounding transaction boundary');
});

test('createRun opens a run for the exact revisions and publishes no private field', async () => {
  const statements = [];
  const pool = { query: async (sql, values) => {
    statements.push({ sql: String(sql), values });
    if (/SELECT id FROM chat_sessions/.test(sql)) return { rows: [{ id: 42 }] };
    if (/SELECT \* FROM visual_evidence_runs/.test(sql)) return { rows: [] };
    if (/INSERT INTO visual_evidence_runs/.test(sql)) {
      return { rows: [{
        id: values[0], session_id: values[1], base_sha: values[2], head_sha: values[3],
        intent: JSON.parse(values[5]), state: values[6], trigger: values[7],
      }] };
    }
    return { rows: [], rowCount: 1 };
  } };
  const created = await state.createRun(pool, {
    sessionId: 42, baseSha: BASE_SHA, headSha: HEAD_SHA, intent: intent(), trigger: `pr-import-${'x'.repeat(40)}`,
  });
  assert.equal(created.created, true);
  assert.equal(created.run.state, 'planned');
  assert.deepEqual(created.run.intent, contract.parseIntent(intent()));
  assert.equal(created.run.trigger.length, 32, 'the trigger label is bounded');

  const insert = statements.find(({ sql }) => /INSERT INTO visual_evidence_runs/.test(sql));
  assert.doesNotMatch(insert.sql, /author_plan|replay_plan|repair_attempt/);
  // Older-head work is cancelled or staled before the session pointer moves.
  const cancel = statements.findIndex(({ sql }) => /UPDATE visual_evidence_runs/.test(sql));
  const pointer = statements.findIndex(({ sql }) => /UPDATE chat_sessions/.test(sql));
  assert.ok(cancel >= 0 && cancel < pointer);
  assert.match(statements[cancel].sql, /head_sha <> \$2/);
  const detail = JSON.parse(statements[pointer].values[3]);
  assert.equal(detail.runId, created.run.id);
  assert.equal(detail.baseSha, BASE_SHA);
  assert.equal(detail.headSha, HEAD_SHA);
  assert.equal(detail.state, 'planned');
  for (const key of ['authorPlan', 'replayPlan', 'fixtureFingerprint']) {
    assert.equal(Object.hasOwn(detail, key), false, key);
  }
});

test('createRun reuses the live run for the same head and refuses inexact revisions', async () => {
  const existing = runRow({ state: 'reviewing' });
  const statements = [];
  const pool = { query: async (sql, values) => {
    statements.push({ sql: String(sql), values });
    if (/SELECT id FROM chat_sessions/.test(sql)) return { rows: [{ id: 42 }] };
    if (/SELECT \* FROM visual_evidence_runs/.test(sql)) return { rows: [existing] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  assert.deepEqual(await state.createRun(pool, {
    sessionId: 42, baseSha: BASE_SHA, headSha: HEAD_SHA, intent: intent(),
  }), { created: false, run: existing });
  assert.equal(statements.length, 2);

  const refused = { query: async () => { throw new Error('must not query'); } };
  for (const [baseSha, headSha] of [['main', HEAD_SHA], [BASE_SHA, 'B'.repeat(40)], [BASE_SHA, 'b'.repeat(39)]]) {
    await assert.rejects(state.createRun(refused, { sessionId: 42, baseSha, headSha, intent: intent() }),
      { code: 'invalid_evidence_revision' });
  }
});

test('the UI heuristic durably enrolls a missing declaration instead of allowing a gate bypass', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql: String(sql), values });
      if (/SELECT visual_evidence_state/.test(String(sql))) {
        return { rows: [{ visual_evidence_state: null, visual_evidence_run_id: null, visual_evidence_detail: null }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const result = await state.requireIntentForUiChange(pool, 42, { headSha: 'b'.repeat(40) });
  assert.equal(result.changed, true);
  assert.equal(result.required, true);
  assert.equal(result.detail.headSha, 'b'.repeat(40));
  assert.match(queries[1].sql, /UPDATE visual_evidence_runs/);
  assert.match(queries[2].sql, /visual_evidence_state = 'planned'/);
  assert.equal(JSON.parse(queries[2].values[1]).required, true);
});

test('schema carries private revision-scoped runs, artifacts, session pointers and stale uniqueness', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS visual_evidence_runs/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS visual_evidence_artifacts/);
  assert.match(schema, /visual_evidence_runs_verified_integrity_check/);
  assert.doesNotMatch(schema, /AND semantic_verdict IS NOT NULL AND completed_at/);
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS visual_evidence_state/);
  assert.match(schema, /idx_visual_evidence_runs_current_head[\s\S]*state NOT IN \('stale', 'cancelled'\)/);
  assert.match(schema, /COMMENT ON TABLE visual_evidence_runs IS 'staging:private'/);
  assert.match(schema, /COMMENT ON TABLE visual_evidence_artifacts IS 'staging:private'/);
});

// ── storeArtifacts: the fence between a run and the proposal's slot ──────

// A pool whose SELECT answers the fence from one run's current columns, so a
// test can move the run out of 'reviewing', onto another head, or out of the
// proposal's slot and see the write refused.
function storePool(run) {
  const statements = [];
  let released = 0;
  const client = {
    async query(sql, values) {
      const text = String(sql).trim();
      statements.push({ sql: text, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return {};
      if (/SELECT r\.id/.test(text)) {
        const [id, headSha, planHash] = values;
        const owns = run.id === id && run.head_sha === headSha && run.plan_hash === planHash
          && run.state === 'reviewing' && run.session_run_id === run.id
          && run.session_state === 'reviewing';
        return { rows: owns ? [{ id }] : [], rowCount: owns ? 1 : 0 };
      }
      if (/DELETE FROM visual_evidence_artifacts/.test(text)) return { rowCount: 0 };
      if (/INSERT INTO visual_evidence_artifacts/.test(text)) return { rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    release() { released += 1; },
  };
  const pool = {
    query: async () => { throw new Error('storage must run inside its own transaction'); },
    connect: async () => client,
  };
  return { pool, statements, released: () => released };
}

function reviewingRun(overrides = {}) {
  return {
    id: RUN_ID, head_sha: HEAD_SHA, plan_hash: MANIFEST_HASH,
    state: 'reviewing', session_run_id: RUN_ID, session_state: 'reviewing',
    ...overrides,
  };
}

function storedFiles() {
  const declaration = contract.parseIntent(intent());
  const { png } = require('./fixtures/visual-evidence');
  return ['base', 'head'].map((side, index) => {
    const buffer = png({ shade: index * 100 });
    const target = shots.shotTarget(declaration, { change: 'invite-suggestions', screen: 'desktop', side, kind: 'screen' });
    return shots.stored(target, buffer, shots.inspectImage(buffer));
  });
}

test('storeArtifacts publishes a reviewing run\'s files in one fenced transaction', async () => {
  const { pool, statements, released } = storePool(reviewingRun());
  const files = storedFiles();
  assert.equal(await state.storeArtifacts(pool, RUN_ID, files, { headSha: HEAD_SHA, planHash: MANIFEST_HASH }), 2);

  assert.deepEqual(statements.map(({ sql }) => sql.split(/\s+/)[0]),
    ['BEGIN', 'SELECT', 'DELETE', 'INSERT', 'INSERT', 'COMMIT']);
  const fence = statements[1];
  assert.deepEqual(fence.values, [RUN_ID, HEAD_SHA, MANIFEST_HASH]);
  assert.match(fence.sql, /r\.head_sha = \$2 AND r\.plan_hash = \$3/);
  assert.match(fence.sql, /r\.state = 'reviewing'/);
  assert.match(fence.sql, /s\.visual_evidence_run_id = r\.id/);
  assert.match(fence.sql, /s\.visual_evidence_state = 'reviewing'/);
  assert.match(fence.sql, /FOR UPDATE/);
  assert.deepEqual(statements[2].values, [RUN_ID], 'a retried store replaces rather than duplicates');

  const [inserted] = statements.filter(({ sql }) => /^INSERT/.test(sql));
  assert.match(inserted.values[0], /^[0-9a-f]{32}$/);
  assert.deepEqual(inserted.values.slice(1, 8),
    [RUN_ID, 'invite-suggestions', 'desktop', 'base', 'context', 'png', 'image/png']);
  assert.equal(inserted.values[8], files[0].data);
  assert.equal(inserted.values[12], files[0].sha256);
  assert.equal(inserted.values[13], null);
  assert.equal(released(), 1);
});

test('storeArtifacts refuses a run that is not reviewing or no longer owns the slot', async () => {
  for (const [label, run] of [
    ['still exploring', reviewingRun({ state: 'exploring' })],
    ['already verified', reviewingRun({ state: 'verified' })],
    ['cancelled by a stop', reviewingRun({ state: 'cancelled' })],
    ['superseded by a newer head', reviewingRun({ head_sha: 'd'.repeat(40) })],
    ['a different manifest', reviewingRun({ plan_hash: 'f'.repeat(64) })],
    ['the slot moved to another run', reviewingRun({ session_run_id: 'f'.repeat(32) })],
    ['the session left reviewing', reviewingRun({ session_state: 'cancelled' })],
  ]) {
    const { pool, statements, released } = storePool(run);
    await assert.rejects(state.storeArtifacts(pool, RUN_ID, storedFiles(), {
      headSha: HEAD_SHA, planHash: MANIFEST_HASH,
    }), { code: 'stale_evidence_operation' }, label);
    assert.ok(!statements.some(({ sql }) => /^(DELETE|INSERT)/.test(sql)), `${label}: nothing is written`);
    assert.equal(statements.at(-1).sql, 'ROLLBACK', label);
    assert.equal(released(), 1, label);
  }
});

test('storeArtifacts requires the exact head sha and manifest hash before touching the database', async () => {
  const pool = {
    query: async () => { throw new Error('must not query'); },
    connect: async () => { throw new Error('must not connect'); },
  };
  await assert.rejects(state.storeArtifacts(pool, 'nope', [], { headSha: HEAD_SHA, planHash: MANIFEST_HASH }),
    { code: 'invalid_evidence_run' });
  for (const fence of [
    {}, { headSha: HEAD_SHA }, { planHash: MANIFEST_HASH },
    { headSha: 'main', planHash: MANIFEST_HASH },
    { headSha: HEAD_SHA, planHash: 'C'.repeat(64) },
    { headSha: HEAD_SHA, planHash: 'c'.repeat(63) },
  ]) {
    await assert.rejects(state.storeArtifacts(pool, RUN_ID, [], fence), { code: 'invalid_artifact_fence' },
      JSON.stringify(fence));
  }
});

// ── The public summary ──────────────────────────────────────────────────

test('public run summary includes claims, artifact metadata and shot results but no plan or internal fixture', () => {
  const summary = state.runSummary({
    state: 'verified', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
    intent: {
      version: 1, impact: 'ui', rationale: 'Visible change',
      stories: [{
        id: 'dialog', claim: 'The dialog is usable.', persona: 'member',
        viewports: [{ name: 'desktop' }],
        intent: { steps: ['Open dialog'], animation: 'none' },
      }, {
        id: 'toast', claim: 'A toast confirms saving.', persona: 'member',
        viewports: [{ name: 'desktop' }],
        intent: { steps: ['Press Save'], animation: 'none' },
      }],
    },
    hard_verdict: shotsVerdict([
      { id: 'dialog', status: 'ready', files: 2 },
      { id: 'toast', status: 'skipped', reason: 'Saving needs a list the fixture does not have.' },
    ]),
    semantic_verdict: null,
    trace_summary: { runs: 2, relativePointer: true, captureMode: 'capture', progress: { phase: 'store_shots', at: 'now' } },
    repair_attempt: 1, plan_hash: 'c'.repeat(64), updated_at: new Date('2026-09-17T00:00:00Z'),
    replay_plan: { secret: 'must not escape' }, author_plan: { secret: 'must not escape' },
    fixture_fingerprint: 'private-fixture',
  }, [{ id: 'd'.repeat(32), storyId: 'dialog', side: 'base', variant: 'focus', media: 'png' }]);
  assert.equal(summary.state, 'verified');
  assert.equal(summary.claims[0].claim, 'The dialog is usable.');
  assert.equal(summary.artifactSummary.length, 1);
  assert.equal(summary.planHash, 'c'.repeat(64));
  assert.deepEqual(summary.progress, { phase: 'store_shots', at: 'now' });
  assert.deepEqual(summary.shotResults, [
    { id: 'dialog', status: 'ready', reason: null },
    { id: 'toast', status: 'skipped', reason: 'Saving needs a list the fixture does not have.' },
  ]);
  assert.equal(summary.verifiedReason, null);
  for (const key of ['replayCount', 'repairCount', 'relativePointer', 'captureMode', 'claimResults', 'mode',
    'replayPlan', 'authorPlan', 'fixtureFingerprint', 'hardVerdict', 'traceSummary']) {
    assert.equal(Object.hasOwn(summary, key), false, key);
  }
  assert.doesNotMatch(JSON.stringify(summary), /must not escape|private-fixture/);
});

test('shot results come only from a shots verdict and carry nothing but id, status and reason', () => {
  const base = { state: 'verified', base_sha: BASE_SHA, head_sha: HEAD_SHA, intent: intent() };
  // Runs from before shots (replay verdicts) and runs without a verdict.
  for (const hard_verdict of [null, undefined, { passed: true, runs: 2 }, { passed: true, mode: 'replay', stories: [
    { id: 'invite-suggestions', status: 'ready' },
  ] }, 'shots']) {
    assert.deepEqual(state.runSummary({ ...base, hard_verdict }).shotResults, [], JSON.stringify(hard_verdict));
  }
  assert.deepEqual(state.runSummary({ ...base, hard_verdict: { mode: 'shots', passed: false } }).shotResults, []);

  const odd = state.runSummary({ ...base, hard_verdict: shotsVerdict([
    { id: 'ready-with-reason', status: 'ready', reason: 'ignored', files: 4 },
    { id: 'unknown-status', status: 'published' },
    { id: 'skipped-silently', status: 'skipped' },
  ]) });
  assert.deepEqual(odd.shotResults, [
    { id: 'ready-with-reason', status: 'ready', reason: null },
    { id: 'unknown-status', status: 'skipped', reason: null },
    { id: 'skipped-silently', status: 'skipped', reason: null },
  ]);
});

// ── Taking the shots again ──────────────────────────────────────────────

function rerunPool(old, { sessionRowCount = 1 } = {}) {
  const statements = [];
  const pool = { query: async (sql, values) => {
    statements.push({ sql: String(sql), values });
    if (/SELECT r\.\*/.test(sql)) return { rows: [old] };
    if (/UPDATE visual_evidence_runs/.test(sql)) return { rowCount: 1 };
    if (/INSERT INTO visual_evidence_runs/.test(sql)) {
      return { rows: [{
        id: values[0], session_id: values[1], base_sha: values[2], head_sha: values[3],
        intent: JSON.parse(values[5]), state: values[6], trigger: values[7],
      }] };
    }
    if (/UPDATE chat_sessions/.test(sql)) return { rowCount: sessionRowCount };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  return { pool, statements };
}

test('rerunSameHead stales the finished run and opens a new one for the same revisions', async () => {
  const old = runRow({ state: 'failed', failure_code: 'evidence_capture_incomplete' });
  const { pool, statements } = rerunPool(old);
  const next = await state.rerunSameHead(pool, RUN_ID);
  assert.match(next.id, /^[0-9a-f]{32}$/);
  assert.notEqual(next.id, RUN_ID);
  assert.equal(next.state, 'planned');
  assert.equal(next.trigger, 'manual-rerun');
  assert.equal(next.base_sha, BASE_SHA);
  assert.equal(next.head_sha, HEAD_SHA);
  assert.deepEqual(next.intent, contract.parseIntent(intent()));

  assert.match(statements[0].sql, /FOR UPDATE OF r, s/);
  const stale = statements.find(({ sql }) => /UPDATE visual_evidence_runs/.test(sql));
  assert.match(stale.sql, /SET state = 'stale'/);
  assert.deepEqual(stale.values, [RUN_ID]);
  const insert = statements.find(({ sql }) => /INSERT INTO visual_evidence_runs/.test(sql));
  assert.doesNotMatch(insert.sql, /author_plan|replay_plan|repair_attempt/);
  // The session pointer moves only if it still names the run being retried.
  const pointer = statements.find(({ sql }) => /UPDATE chat_sessions/.test(sql));
  assert.match(pointer.sql, /visual_evidence_run_id = \$5/);
  assert.equal(pointer.values[2], next.id);
  assert.equal(pointer.values[4], RUN_ID);
  const detail = JSON.parse(pointer.values[3]);
  assert.equal(detail.state, 'planned');
  assert.equal(detail.required, true);
  assert.equal(detail.impact, 'ui');
  assert.deepEqual(detail.shotResults, []);
});

test('rerunSameHead takes a trigger and a replacement declaration', async () => {
  const { pool, statements } = rerunPool(runRow({ state: 'verified' }));
  const next = await state.rerunSameHead(pool, RUN_ID, {
    trigger: `recovery-${'x'.repeat(40)}`, intent: motionIntent(),
  });
  assert.equal(next.trigger.length, 32);
  assert.deepEqual(next.intent, contract.parseIntent(motionIntent()));
  const detail = JSON.parse(statements.find(({ sql }) => /UPDATE chat_sessions/.test(sql)).values[3]);
  assert.equal(detail.impact, 'motion');
  assert.equal(detail.claims[1].animation, 'motion');

  const none = rerunPool(runRow({ state: 'overridden' }));
  const quiet = await state.rerunSameHead(none.pool, RUN_ID, {
    intent: { version: 1, impact: 'none', rationale: 'Only the retry counter changed.', stories: [] },
  });
  assert.equal(quiet.state, 'not_required');
  const quietDetail = JSON.parse(none.statements.find(({ sql }) => /UPDATE chat_sessions/.test(sql)).values[3]);
  assert.equal(quietDetail.required, false);

  const invalid = rerunPool(runRow({ state: 'failed' }));
  const broken = intent();
  broken.stories[0].intent.startPath = 'https://evil.example/';
  await assert.rejects(state.rerunSameHead(invalid.pool, RUN_ID, { intent: broken }), { code: 'invalid_visual_evidence' });
  assert.equal(invalid.statements.length, 1, 'an invalid declaration writes nothing');
});

test('rerunSameHead refuses a run still in flight, a superseded run and a lost race', async () => {
  for (const inFlight of ['planned', 'provisioning', 'exploring', 'replaying', 'reviewing']) {
    const { pool, statements } = rerunPool(runRow({ state: inFlight }));
    await assert.rejects(state.rerunSameHead(pool, RUN_ID), { code: 'evidence_rerun_in_flight' }, inFlight);
    assert.equal(statements.length, 1, inFlight);
  }
  const superseded = rerunPool(runRow({ state: 'failed', current_run_id: 'f'.repeat(32) }));
  await assert.rejects(state.rerunSameHead(superseded.pool, RUN_ID), { code: 'stale_evidence_operation' });
  assert.equal(superseded.statements.length, 1);

  const race = rerunPool(runRow({ state: 'failed' }), { sessionRowCount: 0 });
  await assert.rejects(state.rerunSameHead(race.pool, RUN_ID), { code: 'stale_evidence_operation' });

  await assert.rejects(state.rerunSameHead(rerunPool(runRow()).pool, 'nope'), { code: 'invalid_evidence_run' });
});

test('ids and revision checks are strict', () => {
  assert.match(state.newId(), /^[0-9a-f]{32}$/);
  assert.equal(state.validSha('a'.repeat(40)), true);
  assert.equal(state.validSha('A'.repeat(40)), false);
  assert.equal(state.validSha('a'.repeat(39)), false);
});

// ── #2601/#2558: recording why a run never started ───────────────────────
test('the not-started note is fenced to a planned session and never restarts the idle clock', async () => {
  const seen = [];
  const pool = { query: async (sql, values) => { seen.push({ sql: String(sql), values }); return { rows: [{ id: 42 }] }; } };

  const written = await state.recordNotStarted(pool, 42, '  Previews are switched off here.  ');
  assert.equal(written.recorded, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].values, [42, 'Previews are switched off here.']);
  // Only while the session still reads 'planned': a run that has moved on
  // owns its own state and must not be annotated by a late refusal.
  assert.match(seen[0].sql, /visual_evidence_state = 'planned'/);
  // The idle rule the reviewer surfaces apply is measured off this column.
  // Touching it on every refusal would keep a stuck run looking fresh for
  // as long as anything kept refusing it — which is the bug, not the fix.
  assert.ok(!/visual_evidence_updated_at/.test(seen[0].sql),
    'the note must not bump the timestamp the idle rule measures');
  // The same reason twice is not a write.
  assert.match(seen[0].sql, /IS DISTINCT FROM/);
  // And it merges into the detail rather than replacing it.
  assert.match(seen[0].sql, /COALESCE\(visual_evidence_detail, '\{\}'::jsonb\)\s*\|\|/);
});

test('an empty reason or a bad session id writes nothing at all', async () => {
  const pool = { query: async () => { throw new Error('must not query'); } };
  for (const reason of ['', '   ', null, undefined]) {
    assert.deepEqual(await state.recordNotStarted(pool, 42, reason), { recorded: false });
  }
  for (const id of [0, -1, NaN, null, 'nope']) {
    assert.deepEqual(await state.recordNotStarted(pool, id, 'a reason'), { recorded: false });
  }
});

test('a run that starts drops the note the attempt before it left', async () => {
  const seen = [];
  const pool = { query: async (sql, values) => { seen.push({ sql: String(sql), values }); return { rows: [{ id: 42 }] }; } };
  assert.deepEqual(await state.clearNotStarted(pool, 42), { cleared: true });
  assert.match(seen[0].sql, /visual_evidence_detail - 'notStartedReason'/);
  // The function form, never the `?` containment operator: nothing in the
  // driver or the SQL tooling can then read it as a placeholder.
  assert.match(seen[0].sql, /jsonb_exists\(visual_evidence_detail, 'notStartedReason'\)/);
  assert.deepEqual(seen[0].values, [42]);
  assert.ok(!/visual_evidence_updated_at/.test(seen[0].sql));
});

test('a stored reason is bounded, so no log line or upstream message can grow the row', async () => {
  const seen = [];
  const pool = { query: async (_sql, values) => { seen.push(values); return { rows: [] }; } };
  await state.recordNotStarted(pool, 42, 'x'.repeat(5000));
  assert.equal(seen[0][1].length, 300);
});
