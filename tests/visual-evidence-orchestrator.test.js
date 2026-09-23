'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../src/services/visual-evidence-plan');
const controlPlane = require('../src/services/visual-evidence-control');
const orchestrator = require('../src/services/visual-evidence-orchestrator');
const fixtures = require('./fixtures/visual-evidence');

const RUN_ID = '1'.repeat(32);
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const provenance = {
  baseSha: BASE,
  headSha: HEAD,
  fixtureFingerprint: 'fixture-1',
  baseImageDigest: 'sha256:base',
  headImageDigest: 'sha256:head',
};

function setup({ dispatch, storeArtifacts } = {}) {
  const transitions = [];
  const calls = { resets: 0, passes: [], stored: 0, cleaned: 0, dispatches: 0 };
  let currentState = 'planned';
  const pool = {
    query: async (sql) => {
      if (/SELECT active_turn/.test(String(sql))) return { rows: [{ active_turn: false }] };
      throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
    },
  };
  const run = {
    id: RUN_ID, session_id: 42, state: 'planned', base_sha: BASE, head_sha: HEAD,
    intent: contract.parseIntent(fixtures.intent()),
  };
  const session = {
    id: 42, user_id: 7, app_id: 9, app_slug: 'demo', branch_name: 'proposal',
    repo_url: 'https://github.com/acme/demo.git', agent_backend: 'claude_code',
  };
  const app = { id: 9, slug: 'demo', repo_url: session.repo_url };
  const pair = {
    fixtureFingerprint: provenance.fixtureFingerprint,
    sides: {
      base: { imageDigest: provenance.baseImageDigest, checkout: '/tmp/base' },
      head: { imageDigest: provenance.headImageDigest, checkout: '/tmp/head' },
    },
  };
  const artifacts = [{
    storyId: 'invite-suggestions', viewport: 'desktop', side: 'head',
    variant: 'focus', media: 'png', contentType: 'image/png', data: Buffer.from('png'),
  }];
  const dependencies = {
    state: {
      transitionRun: async (_pool, _runId, next, patch) => {
        transitions.push({ next, patch });
        currentState = next;
        return { ...run, state: next };
      },
      getForSession: async () => ({ state: currentState, headSha: HEAD }),
      getRun: async () => ({ ...run, state: currentState, current_run_id: RUN_ID }),
    },
    environment: {
      preparePair: async () => pair,
      resetPair: async () => {
        calls.resets += 1;
        return {
          origins: { base: 'http://base.internal:3000', head: 'http://head.internal:3000' },
          ...provenance,
        };
      },
      cleanupPair: async () => { calls.cleaned += 1; },
    },
    identities: { mintEvidenceAuthTokens: async () => ({ member: 'member.jwt', read_only_admin: 'admin.jwt' }) },
    replay: {
      runPass: async (_config, _sessionId, input) => {
        calls.passes.push(input.pass);
        return {
          result: { passed: true, pass: input.pass, planHash: contract.planHash(input.plan) },
          artifacts: input.pass === 2 ? artifacts : [],
        };
      },
      comparePasses: (_first, second, { plan }) => ({
        passed: true, runs: 2, stories: [{ id: 'invite-suggestions', viewport: 'desktop' }],
        relativePointer: false, planHash: contract.planHash(plan || fixtures.plan()),
      }),
      storeArtifacts: storeArtifacts || (async () => { calls.stored += 1; }),
    },
    reviewer: { review: async () => { throw new Error('no model reviewer should run'); } },
    evidenceAgent: {
      dispatch: async (_config, options) => {
        calls.dispatches += 1;
        if (dispatch) return dispatch(options, calls.dispatches);
        const control = controlPlane.forRequest({ runId: options.runId, sessionId: session.id });
        await control.runPlan(fixtures.plan());
        return { backend: 'claude_code', threadId: 'thread-1' };
      },
    },
    evidenceControl: controlPlane,
    worker: { isInFlight: () => false },
  };
  return { pool, run, session, app, pair, artifacts, dependencies, transitions, calls };
}

async function execute(fixture, options = {}) {
  controlPlane._clearForTests();
  return orchestrator.executeRun({
    visualEvidence: { maxRunMs: 60_000, maxAgentMs: options.maxAgentMs || 10_000 },
  }, {
    pool: fixture.pool,
    run: fixture.run,
    session: fixture.session,
    app: fixture.app,
    revision: { baseSha: BASE, headSha: HEAD, files: [], filesComplete: true },
    ...(options.authorPlan ? { authorPlan: options.authorPlan } : {}),
    ...(options.onReplayEvent ? { onReplayEvent: options.onReplayEvent } : {}),
  }, fixture.dependencies);
}

test('a successful agent plan publishes captured media without a model verdict', async () => {
  const fixture = setup();
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.deepEqual(fixture.calls.passes, [1, 2]);
  assert.equal(fixture.calls.resets, 3, 'one exploration reset and one per clean replay');
  assert.equal(fixture.calls.stored, 1, 'only the second pass media is stored');
  assert.equal(fixture.calls.cleaned, 1);
  assert.deepEqual(fixture.transitions.map((entry) => entry.next),
    ['provisioning', 'exploring', 'replaying', 'reviewing', 'verified']);
  assert.equal(Object.hasOwn(fixture.transitions.at(-1).patch, 'semanticVerdict'), false);
});

test('a replay tool failure survives a successful planner exit with its original code and phase', async () => {
  const replayError = Object.assign(new Error('open-browse matched 0 elements; exactly one is required.'), {
    code: 'ambiguous_locator', detail: { actionId: 'open-browse', count: 0 },
  });
  const fixture = setup({
    dispatch: async (options) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      await assert.rejects(control.runPlan(fixtures.plan()), { code: 'ambiguous_locator' });
      // The planner can finish its turn normally after receiving the tool
      // error. That must not replace the platform's actual replay failure.
      return { backend: 'claude_code', threadId: 'thread-1' };
    },
  });
  fixture.dependencies.replay.runPass = async (_config, _sessionId, _input, options) => {
    options.onEvent({ type: 'viewport_started', storyId: 'invite-suggestions', viewport: 'desktop' });
    throw replayError;
  };
  await assert.rejects(execute(fixture), { code: 'ambiguous_locator' });
  const failure = fixture.transitions.at(-1);
  assert.equal(failure.next, 'failed');
  assert.equal(failure.patch.failureCode, 'ambiguous_locator');
  assert.match(failure.patch.failureReason, /open-browse matched 0/);
  assert.deepEqual(failure.patch.traceSummary.failure, {
    phase: 'pass_1', code: 'ambiguous_locator',
    message: replayError.message,
    tool: 'run-plan',
    detail: replayError.detail,
  });
  assert.deepEqual(failure.patch.traceSummary.control, {
    planCalls: 1, finishStatus: null, finishReason: null,
  });
  assert.ok(failure.patch.traceSummary.lastReplayEvent.elapsedMs >= 0);
  assert.deepEqual(failure.patch.traceSummary.lastReplayEvent, {
    pass: 1, type: 'viewport_started', storyId: 'invite-suggestions', viewport: 'desktop',
    elapsedMs: failure.patch.traceSummary.lastReplayEvent.elapsedMs,
  });
});

test('a retry after a failed replay cannot replace the browser error with the plan limit', async () => {
  const replayError = Object.assign(new Error('The browser Job ended without a verdict.'), {
    code: 'missing_replay_result',
    detail: { execution: { partial: true, partialReason: 'capture OOM killed' } },
  });
  const fixture = setup({
    dispatch: async (options) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      await assert.rejects(control.runPlan(fixtures.plan()), { code: 'missing_replay_result' });
      await assert.rejects(control.runPlan(fixtures.plan()), { code: 'evidence_plan_attempt_exhausted' });
      return { backend: 'claude_code', threadId: 'thread-1' };
    },
  });
  fixture.dependencies.replay.runPass = async (_config, _sessionId, _input, options) => {
    options.onEvent({
      type: 'result', passed: false, code: 'missing_replay_result',
      message: replayError.message, detail: replayError.detail,
    });
    throw replayError;
  };

  await assert.rejects(execute(fixture), { code: 'missing_replay_result' });
  const failure = fixture.transitions.at(-1);
  assert.equal(failure.patch.failureCode, 'missing_replay_result');
  assert.deepEqual(failure.patch.traceSummary.failure, {
    phase: 'pass_1', code: 'missing_replay_result', message: replayError.message,
    tool: 'run-plan', detail: replayError.detail,
  });
  assert.equal(failure.patch.traceSummary.control.planCalls, 1);
  assert.ok(failure.patch.traceSummary.lastReplayEvent.elapsedMs >= 0);
  assert.deepEqual(failure.patch.traceSummary.lastReplayEvent, {
    pass: 1, type: 'result', passed: false, code: 'missing_replay_result',
    message: replayError.message, detail: replayError.detail,
    elapsedMs: failure.patch.traceSummary.lastReplayEvent.elapsedMs,
  });
});

test('a rejected plan remains diagnosable when the planner exits without replaying', async () => {
  const invalidPlan = fixtures.plan();
  invalidPlan.stories[0].replay.before.actions[0].type = 'invalid';
  const fixture = setup({
    dispatch: async (options) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      await assert.rejects(control.runPlan(invalidPlan), { code: 'invalid_visual_evidence' });
      return { backend: 'claude_code', threadId: 'thread-1' };
    },
  });
  await assert.rejects(execute(fixture), { code: 'invalid_visual_evidence' });
  const failure = fixture.transitions.at(-1);
  assert.equal(failure.patch.failureCode, 'invalid_visual_evidence');
  assert.equal(failure.patch.traceSummary.failure.phase, 'plan_validation');
  assert.equal(failure.patch.traceSummary.failure.tool, 'run-plan');
  assert.equal(failure.patch.traceSummary.control.planCalls, 0);
  assert.deepEqual(fixture.calls.passes, []);
});

test('an author plan uses the same two clean replays without a second model call', async () => {
  const fixture = setup();
  const result = await execute(fixture, { authorPlan: fixtures.plan() });
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 0, 'the implementing agent already supplied the flow');
  assert.deepEqual(fixture.calls.passes, [1, 2]);
  assert.equal(fixture.calls.stored, 1);
  assert.equal(fixture.transitions.at(-1).next, 'verified');
  assert.equal(Object.hasOwn(fixture.transitions.at(-1).patch, 'semanticVerdict'), false);
});

test('replay action progress reaches the durable trace without carrying plan values', async () => {
  const fixture = setup();
  const original = fixture.dependencies.replay.runPass;
  const observed = [];
  fixture.dependencies.replay.runPass = async (...args) => {
    const input = args[2];
    args[3].onEvent({
      type: 'action_completed', storyId: 'invite-suggestions', viewport: 'desktop',
      side: 'head', actionId: 'open-settings', actionStage: 'settings',
      actionType: 'click', durationMs: 43, value: 'secret-form-value',
      location: { sameOrigin: true, pathname: '/settings', hash: '#token=secret.jwt', queryKeys: ['shot'] },
    });
    return original(...args);
  };
  await execute(fixture, { authorPlan: fixtures.plan(), onReplayEvent: (event) => observed.push(event) });
  const trace = fixture.transitions.at(-1).patch.traceSummary;
  assert.equal(trace.planSource, 'author');
  assert.equal(trace.replayEvents.length, 2);
  assert.deepEqual(trace.replayEvents.map((event) => event.pass), [1, 2]);
  assert.equal(trace.lastReplayEvent.actionId, 'open-settings');
  assert.deepEqual(observed, trace.replayEvents);
  assert.doesNotMatch(JSON.stringify(trace), /secret-form-value|secret\.jwt/);
});

test('a persisted author plan survives scheduling without a separate author request', async () => {
  const fixture = setup();
  fixture.run.author_plan = fixtures.plan();
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 0);
  assert.deepEqual(fixture.calls.passes, [1, 2]);
});

test('slow paired environment provisioning does not consume the agent exploration budget', async () => {
  const fixture = setup();
  const preparePair = fixture.dependencies.environment.preparePair;
  fixture.dependencies.environment.preparePair = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 70));
    return preparePair(...args);
  };
  const result = await execute(fixture, { maxAgentMs: 20 });
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 1);
});

test('background evidence heartbeat records progress and stops when the run ends', async () => {
  const seen = [];
  const writes = [];
  const heartbeat = orchestrator.startRunHeartbeat({}, RUN_ID, {
    heartbeatRun: async (_pool, _runId, phase, patch) => { seen.push(phase); writes.push(patch); },
  }, null, 10);
  heartbeat.onProgress({ stage: 'checkout_revisions' });
  heartbeat.onReplayEvent({ pass: 1, type: 'action_started', side: 'base', actionId: 'open-settings' });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(seen.includes('checkout_revisions'));
  assert.equal(writes.at(-1).lastReplayEvent.actionId, 'open-settings');
  assert.equal(writes.at(-1).replayEvents.length, 1);
  assert.ok(seen.length >= 2, 'the lease renews during a slow provisioning step');
  heartbeat.stop();
  const stoppedAt = seen.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(seen.length, stoppedAt, 'finished runs stop renewing their lease');
  assert.equal(orchestrator.progressPhase({ phase: 'build', detail: 'private output' }), 'build_build');
  assert.equal(orchestrator.progressPhase({ detail: 'private output' }), null);
});

test('terminal failure metadata fits the database and redacts credentials before persistence', async () => {
  let persisted;
  const error = Object.assign(new Error('Request failed: token=secret.jwt api_key=topsecret'), {
    code: 'bad-code-with-punctuation',
  });
  const updated = await orchestrator.failCurrentRun({}, RUN_ID, error, {
    getRun: async () => ({ id: RUN_ID, current_run_id: RUN_ID, state: 'replaying' }),
    transitionRun: async (_pool, _runId, next, patch) => { persisted = { next, patch }; },
  });
  assert.equal(updated, true);
  assert.equal(persisted.next, 'failed');
  assert.equal(persisted.patch.failureCode, 'visual_evidence_failed');
  assert.doesNotMatch(persisted.patch.failureReason, /secret\.jwt|topsecret/);
});

test('competing schedulers claim a planned run only once before launching paired replay', async (t) => {
  const fixture = setup();
  fixture.session.handoff_base_sha = BASE;
  fixture.session.imported_pr_head_sha = HEAD;
  fixture.session.source = 'imported';
  fixture.session.visual_evidence_detail = { intent: fixtures.intent() };
  fixture.pool.query = async (sql) => {
    if (/FROM chat_sessions cs/.test(String(sql))) return { rows: [{ ...fixture.session, app_name: 'Demo' }] };
    if (/SELECT active_turn/.test(String(sql))) return { rows: [{ active_turn: false }] };
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  };
  fixture.dependencies.github = { compareRefs: async () => ({ files: [], filesComplete: true }) };
  fixture.dependencies.state.createRun = async () => ({ created: true, run: fixture.run });
  fixture.dependencies.state.clearNotStarted = async () => ({ cleared: true });
  let claimed = false;
  const transitionRun = fixture.dependencies.state.transitionRun;
  fixture.dependencies.state.transitionRun = async (...args) => {
    if (args[2] === 'provisioning') {
      if (claimed) throw Object.assign(new Error('Already claimed'), { code: 'invalid_evidence_transition' });
      claimed = true;
    }
    return transitionRun(...args);
  };
  const metadata = require('../src/services/pr-metadata');
  const sync = metadata.syncEvidencePrBlock;
  metadata.syncEvidencePrBlock = async () => {};
  t.after(() => { metadata.syncEvidencePrBlock = sync; });
  controlPlane._clearForTests();
  const config = { visualEvidence: { execute: true, maxRunMs: 60_000, maxAgentMs: 10_000 } };
  const options = { pool: fixture.pool, sessionId: 42, headSha: HEAD };
  const results = await Promise.all([
    orchestrator.scheduleForSession(config, options, fixture.dependencies),
    orchestrator.scheduleForSession(config, options, fixture.dependencies),
  ]);
  assert.equal(results.filter((result) => result.scheduled).length, 1);
  assert.equal(results.filter((result) => result.reason === 'already_running').length, 1);
  await results.find((result) => result.scheduled).promise;
  assert.deepEqual(fixture.calls.passes, [1, 2]);
  assert.equal(fixture.transitions.filter((entry) => entry.next === 'provisioning').length, 1);
});

test('an agent opinion cannot veto replay-checked captures meant for human review', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      await control.runPlan(fixtures.plan());
      control.finish({ status: 'not_relevant', reason: 'The crop may hide the changed list.' });
      return { backend: 'claude_code', threadId: 'old-worker-thread' };
    },
  });
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 1);
  assert.deepEqual(fixture.calls.passes, [1, 2]);
  assert.equal(fixture.transitions.at(-1).patch.repairAttempt, 0);
});

test('a Codex model that fails before submitting a plan falls back to the platform planner', async () => {
  const fixture = setup({
    dispatch: async (options, attempt) => {
      if (attempt === 1) throw Object.assign(new Error('model cannot use browser tools'), { code: 'evidence_agent_failed' });
      assert.equal(options.forceBackend, 'claude_code');
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      await control.runPlan(fixtures.plan());
      return { backend: 'claude_code', threadId: 'fallback-thread' };
    },
  });
  fixture.session.agent_backend = 'codex_openrouter';
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  assert.deepEqual(fixture.calls.passes, [1, 2]);
});

test('a stale artifact fence cannot publish or transition the superseded run to verified', async () => {
  const stale = Object.assign(new Error('The proposal head moved.'), { code: 'stale_evidence_operation' });
  const fixture = setup({ storeArtifacts: async () => { throw stale; } });
  fixture.dependencies.state.getRun = async () => ({
    ...fixture.run, state: 'reviewing', current_run_id: '2'.repeat(32),
  });
  await assert.rejects(execute(fixture), { code: 'stale_evidence_operation' });
  assert.equal(fixture.calls.cleaned, 1);
  assert.equal(fixture.transitions.some((entry) => entry.next === 'verified'), false);
  assert.equal(fixture.transitions.some((entry) => entry.next === 'failed'), false,
    'the newer run owns the state slot and must not be overwritten');
});

test('revision resolution prefers the immutable recorded base and reviewed head', async () => {
  assert.equal(orchestrator.headForSession({
    reviewed_head_sha: HEAD,
    handoff_head_sha: 'c'.repeat(40),
    checks_commit_sha: 'd'.repeat(40),
  }), HEAD);
  let repoHeadCalls = 0;
  const refs = [];
  const result = await orchestrator.resolveRevisionContext({
    repo_url: 'https://github.com/acme/demo.git',
    handoff_base_sha: BASE,
    reviewed_head_sha: HEAD,
  }, null, {
    getRepoHead: async () => { repoHeadCalls += 1; throw new Error('must not move the base'); },
    compareRefs: async (_owner, _repo, ref) => {
      refs.push(ref);
      return { files: ['frontend/dialog.tsx'], filesComplete: true };
    },
    getProposalDiff: async (_owner, _repo, ref, budget) => {
      assert.equal(ref, `${BASE}...${HEAD}`);
      assert.equal(budget, 8000);
      return { diff: 'diff --git a/frontend/dialog.tsx b/frontend/dialog.tsx', fileCount: 1, truncated: false };
    },
  });
  assert.equal(repoHeadCalls, 0);
  assert.deepEqual(refs, [`${BASE}...${HEAD}`]);
  assert.equal(result.baseSha, BASE);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.diffSummary.fileCount, 1);
  assert.match(result.diffSummary.text, /frontend\/dialog\.tsx/);
});

test('paired resets are fenced by both exact revisions and immutable fixture provenance', () => {
  assert.equal(orchestrator.sameProvenance(provenance, provenance), true);
  assert.equal(orchestrator.sameProvenance({ ...provenance, headSha: 'c'.repeat(40) }, provenance), false);
  assert.equal(orchestrator.sameProvenance({ ...provenance, baseImageDigest: 'sha256:other' }, provenance), false);
});

// ── #2601/#2558: a run that never starts says why ────────────────────────
//
// Every proposal submitted through the connector sat at 'planned' from
// submission to merge, because `recordIntent` writes that state and only a
// scheduled run moves it on. When scheduling was refused the reason was a
// return value the caller logged at warn and dropped, so the reviewer
// surfaces had nothing to show and span indefinitely.
test('a refused schedule records why on the proposal and returns its reason', async () => {
  const notStarted = [];
  const cleared = [];
  const injected = {
    state: {
      recordNotStarted: async (_pool, sessionId, reason) => {
        notStarted.push({ sessionId, reason });
        return { recorded: true };
      },
      clearNotStarted: async (_pool, sessionId) => { cleared.push(sessionId); return { cleared: true }; },
    },
  };

  // Execution switched off: refused before any session is even loaded, so
  // this is the one refusal a pool lookup can never explain.
  const disabledPool = {
    query: async () => { throw new Error('must not load a session when execution is off'); },
  };
  const disabled = await orchestrator.scheduleForSession(
    { visualEvidence: { execute: false } },
    { pool: disabledPool, sessionId: 42 },
    injected
  );
  assert.equal(disabled.scheduled, false);
  assert.equal(disabled.reason, 'disabled');

  // No claim recorded: there is nothing to run.
  const noIntentPool = {
    query: async () => ({ rows: [{ id: 42, app_id: 9, app_slug: 'demo', visual_evidence_detail: null }] }),
  };
  const missing = await orchestrator.scheduleForSession(
    { visualEvidence: { execute: true } },
    { pool: noIntentPool, sessionId: 42 },
    injected
  );
  assert.equal(missing.scheduled, false);
  assert.equal(missing.reason, 'missing_intent');

  assert.deepEqual(notStarted.map((n) => n.sessionId), [42, 42]);
  assert.deepEqual(
    notStarted.map((n) => n.reason),
    [orchestrator.NOT_STARTED_REASONS.disabled, orchestrator.NOT_STARTED_REASONS.missing_intent]
  );
  assert.deepEqual(cleared, [], 'nothing started, so nothing to clear');
  for (const note of notStarted) {
    assert.ok(note.reason.length > 20, 'the stored reason is a sentence a reviewer can read');
    assert.ok(!note.reason.includes('_'), `no bare refusal code reaches a reviewer: ${note.reason}`);
  }
});

test('an asynchronous schedule cannot launch evidence for a head that moved meanwhile', async () => {
  const pool = {
    query: async () => ({ rows: [{
      id: 42, app_id: 9, app_slug: 'demo', source: 'imported',
      imported_pr_head_sha: HEAD, visual_evidence_detail: { intent: fixtures.intent() },
    }] }),
  };
  const result = await orchestrator.scheduleForSession(
    { visualEvidence: { execute: true } },
    { pool, sessionId: 42, headSha: 'c'.repeat(40) }
  );
  assert.deepEqual(result, { scheduled: false, reason: 'head_moved' });
});

test('the refusal reasons are a closed set, and the two non-failures are absent', () => {
  assert.deepEqual(Object.keys(orchestrator.NOT_STARTED_REASONS).sort(),
    ['disabled', 'missing_intent', 'no_revision', 'no_staging_preview']);
  // `already_running` is a run that IS going and `not_required` is a
  // settled verdict; neither is a run that failed to start, so neither may
  // ever write a "not started" note over a state that says more.
  assert.equal(orchestrator.NOT_STARTED_REASONS.already_running, undefined);
  assert.equal(orchestrator.NOT_STARTED_REASONS.not_required, undefined);
});

test('an unknown refusal logs but writes nothing, so no proposal carries an empty reason', async () => {
  let recorded = 0;
  await orchestrator.noteNotStarted({}, 42, 'something_new', {
    state: { recordNotStarted: async () => { recorded += 1; return { recorded: true }; } },
  });
  assert.equal(recorded, 0);
});
