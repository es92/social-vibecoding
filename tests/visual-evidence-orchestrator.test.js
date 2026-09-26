'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const contract = require('../src/services/visual-evidence-plan');
const controlPlane = require('../src/services/visual-evidence-control');
const orchestrator = require('../src/services/visual-evidence-orchestrator');
const fixtures = require('./fixtures/visual-evidence');

test('evidence and staging use the same UI file classifier', () => {
  const serverOnly = [
    'src/routes/notifications.js', 'src/services/mobile-push-badge.js',
    'tests/mobile-push-badge.test.js',
  ];
  assert.equal(orchestrator.uiFileHeuristic(serverOnly), false);
  assert.equal(orchestrator.uiFileHeuristic(['frontend/src/Shell.tsx']), true);
  assert.equal(orchestrator.uiFileHeuristic(['public/js/app-view.js']), true);
  assert.equal(orchestrator.uiFileHeuristic(['src/features/widgets/icon.svg']), true);
});

test('run diagnostics retain bounded recovery and controlled-failure counts', () => {
  const navigation = orchestrator.replayProgressEvent({ type: 'navigation_completed',
    status: 200, recoveredRequestCount: 1 }, 2);
  const side = orchestrator.replayProgressEvent({ type: 'side_finished',
    controlledFailureHits: 1, expectedFailureConsoleCount: 1,
    expectedSandboxWarnings: 1, recoveredNetworkChanges: 0 }, 2);
  const stability = orchestrator.replayProgressEvent({ type: 'checkpoint_stability',
    mode: 'static', sampleCount: 3, networkQuiet: false,
    networkWaitMs: 3000, captureWaitMs: 4900,
    samples: [{ settleMs: 150, screenshotMs: 1550, hashMs: 40, distance: null },
      { settleMs: 150, screenshotMs: 1540, hashMs: 40, distance: 1 },
      { settleMs: 150, screenshotMs: 1550, hashMs: 40, distance: 0 }],
  }, 2);
  assert.equal(navigation.recoveredRequestCount, 1);
  assert.equal(side.controlledFailureHits, 1);
  assert.equal(side.expectedFailureConsoleCount, 1);
  assert.equal(side.expectedSandboxWarnings, 1);
  assert.equal(side.recoveredNetworkChanges, 0);
  assert.equal(stability.sampleCount, 3);
  assert.deepEqual(stability.samples.map((sample) => sample.distance), [undefined, 1, 0]);
  assert.equal(stability.captureWaitMs, 4900);
});

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
  const calls = { resets: 0, passes: [], stored: 0, cleaned: 0, dispatches: 0, stopClears: 0, workerReleased: 0 };
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
    identities: { mintEvidenceAuthTokens: async () => ({
      member: 'member.jwt', read_only_admin: 'admin.jwt', full_admin: 'full-admin.jwt',
    }) },
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
    worker: {
      isInFlight: () => false,
      clearPendingStop: () => { calls.stopClears += 1; },
      destroyCcVolume: async () => { calls.workerReleased += 1; },
    },
  };
  dependencies.replay.runPassCases = async (config, sessionId, input, options) => {
    const deployment = await options.prepareCase({ storyId: 'invite-suggestions', viewport: 'desktop' });
    return dependencies.replay.runPass(config, sessionId,
      { ...input, origins: deployment.origins }, options);
  };
  return { pool, run, session, app, pair, artifacts, dependencies, transitions, calls };
}

async function execute(fixture, options = {}) {
  controlPlane._clearForTests();
  return orchestrator.executeRun({
    visualEvidence: {
      maxRunMs: 60_000,
      maxAgentMs: options.maxAgentMs || 10_000,
      maxRepairAgentMs: options.maxRepairAgentMs || 10_000,
    },
  }, {
    pool: fixture.pool,
    run: fixture.run,
    session: fixture.session,
    app: fixture.app,
    revision: { baseSha: BASE, headSha: HEAD, files: [], filesComplete: true },
    ...(options.authorPlan ? { authorPlan: options.authorPlan } : {}),
    ...(options.onReplayEvent ? { onReplayEvent: options.onReplayEvent } : {}),
    ...(options.onAgentFinalResponse ? { onAgentFinalResponse: options.onAgentFinalResponse } : {}),
  }, fixture.dependencies);
}

test('a UI-classified no-story declaration fails before provisioning or agent dispatch', async () => {
  const fixture = setup();
  fixture.run.intent = contract.parseIntent({
    version: 1, impact: 'none', rationale: 'Only an error state changes.', stories: [],
  });
  await assert.rejects(execute(fixture), { code: 'visual_evidence_intent_conflict' });
  assert.equal(fixture.calls.dispatches, 0);
  assert.equal(fixture.calls.cleaned, 0);
  assert.deepEqual(fixture.transitions.map((entry) => entry.next), ['failed']);
});

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
  assert.equal(fixture.calls.workerReleased, 0, 'an active native coding session retains its memory');
});

test('imported evidence releases its temporary worker after a passing run', async () => {
  const fixture = setup();
  fixture.session.source = 'imported';
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.workerReleased, 1);
});

test('imported evidence releases its temporary worker after planner failure', async () => {
  const fixture = setup({ dispatch: async () => { throw new Error('planner failed'); } });
  fixture.session.source = 'imported';
  await assert.rejects(execute(fixture), /planner failed/);
  assert.equal(fixture.calls.workerReleased, 1);
});

test('an author plan does not tear down an imported proposal worker it never used', async () => {
  const fixture = setup();
  fixture.session.source = 'imported';
  const result = await execute(fixture, { authorPlan: fixtures.plan() });
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 0);
  assert.equal(fixture.calls.workerReleased, 0);
});

test('first hosted evidence turn does not resume the proposal coding thread', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      assert.equal(options.resumeThreadId, null);
      assert.equal(fixture.calls.stopClears, 1, 'a new run retires the previous stop before dispatch');
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      await control.runPlan(fixtures.plan());
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  fixture.session.agent_thread_id = 'coding-thread';
  fixture.session.cc_session_id = 'coding-thread';
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.deepEqual(fixture.calls.passes, [1, 2]);
  assert.equal(fixture.calls.stopClears, 1);
});

test('evidence context includes a relevant check beyond the first 80 manifest entries', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-checks-'));
  try {
    const tests = Array.from({ length: 100 }, (_, index) => ({
      name: `Generic screen ${index}`, path: `/screen-${index}`,
    }));
    tests.push({
      name: 'Workshop plus button closes the view tab strip',
      path: '/workshop', expectSelector: '.dev-ws-plus',
    });
    fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests }));
    const intent = { stories: [{
      claim: 'The Workshop plus button sits below the tab strip.',
      intent: { steps: ['Open the Workshop'] },
    }] };
    const selected = orchestrator.declaredCheckSummary(checkout, intent);
    assert.equal(selected.length, 80);
    assert.equal(selected[0].path, '/workshop');
    assert.equal(selected[0].testedAs, 'read_only_admin');
    assert.equal(orchestrator.declaredCheckSummary(checkout)[0].path, '/screen-0');
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('recorded testing route guides a vague intent to the exact declared screen', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-testing-route-'));
  const route = '/?demo=1&ws=status#app/demo/workshop';
  try {
    const tests = Array.from({ length: 100 }, (_, index) => ({
      name: `Generic screen ${index}`, path: `/screen-${index}`,
    }));
    tests.push({ name: 'View strip', path: route, expectSelector: '.dev-ws-plus' });
    fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests }));
    const context = orchestrator.evidenceContext({
      run: { id: RUN_ID },
      session: {
        pr_title: 'Small spacing change', testing_path: route,
        testing_paths: [{ path: route, viewport: 'desktop' },
          { path: '/?token=secret.jwt#app/demo/workshop', viewport: 'phone' }],
        testing_md: 'Open the Workshop and inspect the view strip.',
      },
      revision: { baseSha: BASE, headSha: HEAD, files: [], filesComplete: true },
      pair: { fixtureFingerprint: 'fixture-1', sides: {
        base: { imageDigest: 'sha256:base' },
        head: { imageDigest: 'sha256:head', checkout },
      } },
      deployment: { origins: { base: 'http://base.internal', head: 'http://head.internal' },
        availableFixtures: [{ id: 'member-session', persona: 'member', path: '/#messages/agent/9' }] },
      intent: { stories: [{ claim: 'The control has a small gap.', intent: {
        startPath: '/', steps: ['Open the changed page'], checkpoint: 'A gap is visible', focus: 'The control',
      } }] },
    });
    assert.deepEqual(context.changeContext.testingPaths, [route]);
    assert.equal(context.changeContext.testingSteps, 'Open the Workshop and inspect the view strip.');
    assert.equal(context.declaredChecks[0].path, route);
    assert.equal(context.declaredChecks[0].testedAs, 'read_only_admin');
    assert.deepEqual(context.availableFixtures, [{ id: 'member-session', persona: 'member',
      path: '/#messages/agent/9' }]);
    assert.equal(context.acceptedIntent.stories[0].intent.startPath, '/',
      'a testing hint must not rewrite the accepted claim');
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('platform waits for a background replay after the hosted planner receives its acknowledgement', async () => {
  let releaseReplay;
  const pendingReplay = new Promise((resolve) => { releaseReplay = resolve; });
  let acknowledge;
  const acknowledged = new Promise((resolve) => { acknowledge = resolve; });
  const fixture = setup({
    dispatch: async (options) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      const result = control.submitPlan(fixtures.plan());
      acknowledge(result);
      return { backend: 'claude_code', threadId: 'thread-1' };
    },
  });
  const runPass = fixture.dependencies.replay.runPass;
  fixture.dependencies.replay.runPass = async (...args) => {
    await pendingReplay;
    return runPass(...args);
  };
  const execution = execute(fixture);
  const receipt = await acknowledged;
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.duplicate, false);
  assert.equal(fixture.calls.stored, 0, 'acknowledgement cannot publish pending media');
  releaseReplay();
  const result = await execution;
  assert.equal(result.state, 'verified');
  assert.deepEqual(fixture.calls.passes, [1, 2]);
  assert.equal(fixture.calls.stored, 1);
});

test('a background locator failure starts a fresh hosted correction turn', async () => {
  const rejected = fixtures.plan();
  const corrected = fixtures.plan();
  corrected.stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  const mismatch = Object.assign(new Error('Browse matched no visible controls.'), {
    code: 'ambiguous_locator',
    detail: { side: 'base', phase: 'action', actionId: 'open-browse' },
  });
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      if (dispatchCount === 1) {
        assert.equal(control.submitPlan(rejected).accepted, true);
      } else {
        assert.equal(options.repairAttempt, 1);
        assert.equal(options.resumeThreadId, 'evidence-thread');
        assert.equal(control.getContext().repair.failure.code, 'ambiguous_locator');
        assert.equal(control.submitPlan(corrected).accepted, true);
      }
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  const runPass = fixture.dependencies.replay.runPass;
  let failed = false;
  fixture.dependencies.replay.runPass = async (...args) => {
    if (!failed) {
      failed = true;
      throw mismatch;
    }
    return runPass(...args);
  };
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  assert.equal(fixture.calls.stored, 1);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.repairCount, 1);
});

test('a replay failure survives a correction turn that submits no new plan', async () => {
  const replayError = Object.assign(new Error('open-browse matched 0 elements; exactly one is required.'), {
    code: 'ambiguous_locator', detail: { actionId: 'open-browse', count: 0 },
  });
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      if (dispatchCount === 1) {
        await assert.rejects(control.runPlan(fixtures.plan()), { code: 'ambiguous_locator' });
      } else {
        assert.equal(options.repairAttempt, 1);
      }
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
    phase: 'agent_repair', code: 'ambiguous_locator',
    message: replayError.message,
    tool: 'run-plan',
    detail: replayError.detail,
  });
  assert.deepEqual(failure.patch.traceSummary.control, {
    planCalls: 1, finishStatus: null, finishReason: null,
  });
  assert.ok(failure.patch.traceSummary.lastReplayEvent.elapsedMs >= 0);
  assert.equal(fixture.calls.dispatches, 2);
  assert.equal(fixture.calls.stored, 0);
  assert.equal(fixture.calls.cleaned, 1);
  assert.deepEqual(failure.patch.traceSummary.lastReplayEvent, {
    pass: 1, type: 'viewport_started', storyId: 'invite-suggestions', viewport: 'desktop',
    elapsedMs: failure.patch.traceSummary.lastReplayEvent.elapsedMs,
  });
});

test('replay fails closed after two unsuccessful correction turns', async () => {
  const first = fixtures.plan();
  const second = fixtures.plan();
  second.stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  const third = fixtures.plan();
  third.stories[0].replay.after.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: false,
  };
  const mismatch = Object.assign(new Error('open-members matched 0 elements; exactly one is required.'), {
    code: 'ambiguous_locator', detail: { side: 'base', actionId: 'open-members' },
  });
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      await assert.rejects(control.runPlan([first, second, third][dispatchCount - 1]), {
        code: 'ambiguous_locator',
      });
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  fixture.dependencies.replay.runPass = async () => { throw mismatch; };
  await assert.rejects(execute(fixture), { code: 'ambiguous_locator' });
  assert.equal(fixture.calls.dispatches, 3);
  assert.equal(fixture.calls.stored, 0);
  assert.equal(fixture.calls.cleaned, 1);
  assert.equal(fixture.transitions.at(-1).next, 'failed');
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.control.planCalls, 3);
});

test('a wrong locator gets one explicit agent correction and two clean replays', async () => {
  const rejected = fixtures.plan();
  const corrected = fixtures.plan();
  corrected.stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  const mismatch = Object.assign(new Error('open-members matched 0 elements; exactly one is required.'), {
    code: 'ambiguous_locator',
    detail: { storyId: 'invite-suggestions', viewport: 'desktop', side: 'base',
      phase: 'action', actionId: 'open-members' },
  });
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      if (dispatchCount === 1) {
        assert.equal(options.repairAttempt, 0);
        await assert.rejects(control.runPlan(rejected), { code: 'ambiguous_locator' });
        return { backend: 'claude_code', threadId: 'evidence-thread' };
      }
      assert.equal(dispatchCount, 2, 'only one repair turn is permitted');
      assert.equal(options.repairAttempt, 1);
      assert.equal(options.resumeThreadId, 'evidence-thread');
      assert.deepEqual(control.getContext().repair.rejectedPlan, contract.parseReplayPlan(rejected));
      assert.deepEqual(control.getContext().repair.failure.detail, mismatch.detail);
      await control.runPlan(corrected);
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  const runPass = fixture.dependencies.replay.runPass;
  let firstPass = true;
  fixture.dependencies.replay.runPass = async (...args) => {
    if (firstPass) {
      firstPass = false;
      fixture.calls.passes.push(args[2].pass);
      throw mismatch;
    }
    return runPass(...args);
  };
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  assert.deepEqual(fixture.calls.passes, [1, 1, 2]);
  assert.equal(fixture.calls.resets, 5, 'repair exploration and each replay start from a fresh paired reset');
  assert.equal(fixture.calls.stored, 1);
  assert.equal(fixture.transitions.at(-1).patch.repairAttempt, 1);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.repairCount, 1);
  assert.deepEqual(fixture.transitions.at(-1).patch.traceSummary.repairTrigger, {
    kind: 'locator', code: 'ambiguous_locator', side: 'base', actionId: 'open-members',
  });
  assert.deepEqual(fixture.transitions.map((entry) => entry.next),
    ['provisioning', 'exploring', 'replaying', 'replaying', 'reviewing', 'verified']);
});

test('a member-only API 404 with matching browser resource errors can be repaired', async () => {
  const rejected = fixtures.plan();
  const corrected = fixtures.plan();
  corrected.stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  const location = { sameOrigin: true, pathname: '/api/agent-sessions/990801' };
  const missing = Object.assign(new Error('base emitted browser errors.'), {
    code: 'browser_diagnostics',
    detail: {
      storyId: 'invite-suggestions', viewport: 'desktop', side: 'base', phase: 'browser_diagnostics',
      browserDiagnostics: {
        httpErrors: [{ status: 404, location }],
        consoleErrors: [{ source: location,
          message: 'Failed to load resource: the server responded with a status of 404 (Not Found)' }],
        pageErrors: [], failedRequests: [], blockedRequests: [],
      },
    },
  });
  const fixture = setup({ dispatch: async (options, attempt) => {
    const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
    if (attempt === 1) await assert.rejects(control.runPlan(rejected), { code: 'browser_diagnostics' });
    else {
      assert.equal(control.getContext().repair.failure.kind, 'route_data');
      await control.runPlan(corrected);
    }
    return { backend: 'claude_code', threadId: 'evidence-thread' };
  } });
  const runPass = fixture.dependencies.replay.runPass;
  let failed = false;
  fixture.dependencies.replay.runPass = async (...args) => {
    if (!failed) { failed = true; throw missing; }
    return runPass(...args);
  };
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.repairTrigger.kind, 'route_data');
});

test('unrelated browser errors never become a route-data repair', async () => {
  const fixture = setup();
  const location = { sameOrigin: true, pathname: '/api/agent-sessions/990801' };
  fixture.dependencies.replay.runPass = async () => {
    throw Object.assign(new Error('base emitted browser errors.'), {
      code: 'browser_diagnostics',
      detail: { side: 'base', phase: 'browser_diagnostics', browserDiagnostics: {
        httpErrors: [{ status: 404, location }],
        consoleErrors: [{ source: { sameOrigin: true, pathname: '/app.js' },
          message: 'Uncaught TypeError: failure' }],
        pageErrors: [], failedRequests: [], blockedRequests: [],
      } },
    });
  };
  await assert.rejects(execute(fixture), { code: 'browser_diagnostics' });
  assert.equal(fixture.calls.dispatches, 1);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.repairCount, 0);
});

test('only a loaded hosted app with blocked embedded requests may be replaced in a repair', () => {
  const plan = fixtures.plan();
  const story = plan.stories[0];
  story.replay.before.actions.push({ id: 'wait-app', stage: 'open',
    type: 'waitForHostedApp', slug: 'real-app', timeoutMs: 1000 });
  const failure = { code: 'browser_diagnostics', detail: {
    phase: 'browser_diagnostics', storyId: story.id, hostedAppSlugs: ['real-app'],
    browserDiagnostics: {
      httpErrors: [], consoleErrors: [], pageErrors: [{ message: 'App script failed' }],
      failedRequests: [], blockedRequests: [{ origin: 'https://outside.example', embedded: true }],
    },
  } };
  assert.equal(orchestrator.replayRepairKind(failure, plan), 'hosted_app');
  assert.equal(orchestrator.replayRepairKind({ ...failure,
    detail: { ...failure.detail, hostedAppSlugs: [] } }, plan), null);
  assert.equal(orchestrator.replayRepairKind({ ...failure,
    detail: { ...failure.detail, browserDiagnostics: {
      ...failure.detail.browserDiagnostics,
      blockedRequests: [{ origin: 'https://outside.example', embedded: false }],
    } } }, plan), null);
  assert.equal(orchestrator.replayRepairKind({ ...failure,
    detail: { ...failure.detail, browserDiagnostics: {
      ...failure.detail.browserDiagnostics,
      blockedRequests: [], pageErrors: [{ message: 'App script failed', sourceKind: 'hosted_app' }],
    } } }, plan), 'hosted_app');
});

test('an actually changing static checkpoint can get a bounded observed-state repair', () => {
  const plan = fixtures.plan();
  const failure = { code: 'unstable_checkpoint', detail: {
    phase: 'capture_checkpoint', storyId: plan.stories[0].id, sampleCount: 4,
  } };
  assert.equal(orchestrator.replayRepairKind(failure, plan), 'static_timing');
  assert.equal(orchestrator.replayRepairKind({ ...failure,
    detail: { ...failure.detail, sampleCount: 2 } }, plan), null);
});

test('a missing readiness locator gets one correction turn and fresh replay passes', async () => {
  const rejected = fixtures.plan();
  const corrected = fixtures.plan();
  corrected.stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  const missing = Object.assign(new Error('wait-ready did not match a visible element.'), {
    code: 'locator_not_found',
    detail: {
      storyId: 'invite-suggestions', viewport: 'desktop', side: 'base',
      phase: 'action', actionId: 'wait-ready', actionType: 'waitFor',
    },
  });
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      if (dispatchCount === 1) {
        await assert.rejects(control.runPlan(rejected), { code: 'locator_not_found' });
      } else {
        assert.equal(options.repairAttempt, 1);
        assert.equal(control.getContext().repair.failure.code, 'locator_not_found');
        await control.runPlan(corrected);
      }
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  const runPass = fixture.dependencies.replay.runPass;
  let failed = false;
  fixture.dependencies.replay.runPass = async (...args) => {
    if (!failed) {
      failed = true;
      fixture.calls.passes.push(args[2].pass);
      throw missing;
    }
    return runPass(...args);
  };
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  assert.deepEqual(fixture.calls.passes, [1, 1, 2]);
  assert.equal(fixture.calls.stored, 1);
  assert.deepEqual(fixture.transitions.at(-1).patch.traceSummary.repairTrigger, {
    kind: 'locator', code: 'locator_not_found', side: 'base', actionId: 'wait-ready',
  });
});

test('a missing positive assertion locator can receive a second bounded correction', async () => {
  const plans = [fixtures.plan(), fixtures.plan(), fixtures.plan()];
  plans[1].stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  plans[2].stories[0].replay.after.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: false,
  };
  const failures = [
    Object.assign(new Error('Action locator missing.'), {
      code: 'locator_not_found', detail: { side: 'base', phase: 'action', actionId: 'wait-ready' },
    }),
    Object.assign(new Error('visible assertion failed.'), {
      code: 'assertion_failed', detail: {
        side: 'head', phase: 'assertion', assertionIndex: 1, count: 0,
        assertion: { type: 'visible', target: { by: 'text', value: 'Ready', exact: true } },
      },
    }),
  ];
  const expectedCodes = failures.map((error) => error.code);
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      assert.equal(options.repairAttempt, dispatchCount - 1);
      if (dispatchCount > 1) {
        assert.equal(control.getContext().repair.failure.code, expectedCodes[dispatchCount - 2]);
      }
      if (dispatchCount < 3) await assert.rejects(control.runPlan(plans[dispatchCount - 1]));
      else await control.runPlan(plans[2]);
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  const runPass = fixture.dependencies.replay.runPass;
  fixture.dependencies.replay.runPass = async (...args) => {
    if (failures.length) {
      fixture.calls.passes.push(args[2].pass);
      throw failures.shift();
    }
    return runPass(...args);
  };
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 3);
  assert.deepEqual(fixture.calls.passes, [1, 1, 1, 2]);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.repairCount, 2);
  assert.deepEqual(fixture.transitions.at(-1).patch.traceSummary.repairTriggers.map((item) => item.code),
    ['locator_not_found', 'assertion_failed']);
});

test('a visible element with the wrong asserted state fails without planner repair', async () => {
  const wrongState = Object.assign(new Error('checked assertion failed.'), {
    code: 'assertion_failed', detail: {
      side: 'head', phase: 'assertion', assertionIndex: 0, count: 1,
      assertion: { type: 'checked', target: { by: 'testId', value: 'opt-in' } },
    },
  });
  const fixture = setup();
  fixture.dependencies.replay.runPass = async () => { throw wrongState; };
  await assert.rejects(execute(fixture), { code: 'assertion_failed' });
  assert.equal(fixture.calls.dispatches, 1);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.repairCount, 0);
});

test('a still-visible motion marker gets one correction that retains its assertion', async () => {
  const rejected = fixtures.plan();
  rejected.impact = 'motion';
  rejected.stories[0].intent.animation = 'motion';
  rejected.stories[0].replay.checkpoint.animation = 'motion';
  rejected.stories[0].replay.checkpoint.assertions.after = [{
    type: 'hidden', target: { by: 'css', value: '.is-animating' },
  }];
  const corrected = structuredClone(rejected);
  corrected.stories[0].replay.after.actions.push({
    id: 'wait-settled', stage: 'settled', type: 'waitFor',
    target: { by: 'css', value: '.is-animating' }, state: 'hidden', timeoutMs: 3000,
  });
  const early = Object.assign(new Error('hidden assertion failed'), {
    code: 'assertion_failed', detail: {
      storyId: 'invite-suggestions', side: 'head', phase: 'assertion', assertionIndex: 0,
      count: 1, actual: true,
      assertion: rejected.stories[0].replay.checkpoint.assertions.after[0],
    },
  });
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      if (dispatchCount === 1) {
        await assert.rejects(control.runPlan(rejected), { code: 'assertion_failed' });
      } else {
        assert.equal(control.getContext().repair.failure.kind, 'motion_timing');
        assert.deepEqual(control.getContext().repair.rejectedPlan.stories[0]
          .replay.checkpoint.assertions.after, rejected.stories[0].replay.checkpoint.assertions.after);
        await control.runPlan(corrected);
      }
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  fixture.run.intent = contract.semanticIntentFromPlan(rejected);
  const runPass = fixture.dependencies.replay.runPass;
  let failed = false;
  fixture.dependencies.replay.runPass = async (...args) => {
    if (!failed) {
      failed = true;
      fixture.calls.passes.push(args[2].pass);
      throw early;
    }
    return runPass(...args);
  };
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.deepEqual(fixture.calls.passes, [1, 1, 2]);
  assert.equal(fixture.calls.stored, 1);
  assert.deepEqual(fixture.transitions.at(-1).patch.traceSummary.repairTrigger, {
    kind: 'motion_timing', code: 'assertion_failed', side: 'head', assertionIndex: 0,
  });
});

test('a wrong-state assertion in a static flow remains a hard failure', async () => {
  const wrongState = Object.assign(new Error('hidden assertion failed'), {
    code: 'assertion_failed', detail: {
      storyId: 'invite-suggestions', side: 'base', phase: 'assertion', assertionIndex: 0,
      count: 1, actual: true,
      assertion: fixtures.plan().stories[0].replay.checkpoint.assertions.before[0],
    },
  });
  const fixture = setup();
  fixture.dependencies.replay.runPass = async () => { throw wrongState; };
  await assert.rejects(execute(fixture), { code: 'assertion_failed' });
  assert.equal(fixture.calls.dispatches, 1);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.repairCount, 0);
});

test('a correction turn has time to inspect the page after the first planner budget expires', async () => {
  const mismatch = Object.assign(new Error('heading matched 2 elements; exactly one is required.'), {
    code: 'ambiguous_locator', detail: { side: 'base', phase: 'focus', actionId: 'capture-heading' },
  });
  const corrected = fixtures.plan();
  corrected.stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      if (dispatchCount === 1) {
        await assert.rejects(control.runPlan(fixtures.plan()), { code: 'ambiguous_locator' });
        await new Promise((resolve) => setTimeout(resolve, 50));
      } else {
        assert.equal(options.repairAttempt, 1);
        assert.ok(options.timeoutMs > 0, 'repair has a separate positive time budget');
        await control.runPlan(corrected);
      }
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  const runPass = fixture.dependencies.replay.runPass;
  let failed = false;
  fixture.dependencies.replay.runPass = async (...args) => {
    if (!failed) {
      failed = true;
      fixture.calls.passes.push(args[2].pass);
      throw mismatch;
    }
    return runPass(...args);
  };

  const result = await execute(fixture, { maxAgentMs: 20, maxRepairAgentMs: 200 });
  assert.equal(result.state, 'verified');
  const dispatches = fixture.transitions.at(-1).patch.traceSummary.agentDispatches;
  assert.equal(dispatches[0].budgetMs, 20);
  assert.equal(dispatches[1].budgetMs, 200);
  assert.ok(dispatches[1].timeoutMs > 0);
  assert.deepEqual(fixture.calls.passes, [1, 1, 2]);
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
  assert.equal(fixture.calls.dispatches, 1, 'an infrastructure failure does not spend a model repair turn');
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

test('a planner timeout keeps a bounded, content-free record of its last active tool', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      options.onEvidenceDiagnostic({ kind: 'worker_prepare_start' });
      options.onEvidenceDiagnostic({ kind: 'worker_prepare_end' });
      options.onEvidenceDiagnostic({ kind: 'provider_dispatched', backend: 'claude_code', requestMode: 'agent_new' });
      options.onEvidenceDiagnostic({ kind: 'tool_start', sequence: 1,
        tool: 'browser_navigate', persona: 'member', side: 'base', routeOrdinal: 2,
        url: 'https://private.invalid/?token=secret' });
      options.onEvidenceDiagnostic({ kind: 'agent_deadline' });
      throw Object.assign(new Error('The agent timed out.'), { code: 'evidence_agent_timeout' });
    },
  });
  await assert.rejects(execute(fixture), { code: 'evidence_agent_timeout' });
  const trace = fixture.transitions.at(-1).patch.traceSummary;
  assert.equal(trace.agentActivity.budgetMs, 10_000);
  assert.equal(trace.agentActivity.counts.tool_start, 1);
  assert.equal(trace.agentActivity.toolCounts.browser_navigate, 1);
  assert.equal(trace.agentActivity.pendingTools[0].tool, 'browser_navigate');
  assert.equal(trace.agentActivity.pendingTools[0].side, 'base');
  assert.equal(trace.agentActivity.pendingTools[0].routeOrdinal, 2);
  assert.equal(trace.agentActivity.events.at(-1).kind, 'agent_deadline');
  assert.doesNotMatch(JSON.stringify(trace.agentActivity), /private|token|secret|url/i);
});

test('planner authentication records every persona and side without retaining credentials', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      for (const persona of ['member', 'admin', 'full_admin']) {
        for (const side of ['base', 'head']) {
          options.onEvidenceDiagnostic({
            kind: 'auth_bootstrap', persona, side, attempted: true,
            responseStatus: 200, sessionCookieInstalled: true,
            sessionCookiePresent: true, token: 'private-token',
            cookie: 'private-session', url: 'http://private.invalid/',
          });
        }
      }
      return { backend: 'claude_code', threadId: 'thread-1' };
    },
  });
  await assert.rejects(execute(fixture), { code: 'missing_evidence_replay' });
  const events = fixture.transitions.at(-1).patch.traceSummary.agentActivity.events
    .filter((event) => event.kind === 'auth_bootstrap');
  assert.equal(events.length, 6);
  assert.deepEqual(events.map(({ persona, side }) => [persona, side]), [
    ['member', 'base'], ['member', 'head'], ['admin', 'base'], ['admin', 'head'],
    ['full_admin', 'base'], ['full_admin', 'head'],
  ]);
  assert.ok(events.every((event) => event.responseStatus === 200
    && event.sessionCookieInstalled && event.sessionCookiePresent));
  assert.doesNotMatch(JSON.stringify(events), /private|credential|token|\.invalid/i);
});

test('planner records public-app catalog and frame loading without storing app URLs', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      options.onEvidenceDiagnostic({ kind: 'hosted_app_catalog', side: 'base',
        outcome: 'ok', httpStatus: 200, count: 1, catalogCount: 2,
        url: 'https://private.example.invalid/secret' });
      options.onEvidenceDiagnostic({ kind: 'hosted_app_catalog', side: 'head',
        outcome: 'ok', httpStatus: 200, count: 1 });
      options.onEvidenceDiagnostic({ kind: 'hosted_app_allowlist', count: 1 });
      options.onEvidenceDiagnostic({ kind: 'hosted_app_allowlist', outcome: 'loaded', count: 1 });
      options.onEvidenceDiagnostic({ kind: 'document_response', side: 'hosted',
        documentOrdinal: 3, outcome: 'ok', httpStatus: 200, durationMs: 128 });
      return { backend: 'claude_code', threadId: 'thread-1' };
    },
  });
  await assert.rejects(execute(fixture), { code: 'missing_evidence_replay' });
  const events = fixture.transitions.at(-1).patch.traceSummary.agentActivity.events;
  assert.deepEqual(events.map((event) => event.kind), [
    'hosted_app_catalog', 'hosted_app_catalog', 'hosted_app_allowlist',
    'hosted_app_allowlist', 'document_response',
  ]);
  assert.equal(events[3].outcome, 'loaded');
  assert.equal(events[0].catalogCount, 2);
  assert.equal(events[4].side, 'hosted');
  assert.doesNotMatch(JSON.stringify(events), /private|secret|url/i);
});

test('a timeout retains browser-boundary timing and document outcome without raw page data', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      options.onEvidenceDiagnostic({ kind: 'browser_call_start', persona: 'member',
        callOrdinal: 2, tool: 'browser_navigate', side: 'base', routeOrdinal: 1,
        routeHint: 'declared_check', checkRank: 3, url: 'https://private.invalid/token' });
      options.onEvidenceDiagnostic({ kind: 'document_request', side: 'base', documentOrdinal: 1 });
      options.onEvidenceDiagnostic({ kind: 'document_response', side: 'base', documentOrdinal: 1,
        outcome: 'http_error', httpStatus: 404, durationMs: 482, bodyBytes: 1274,
        text: 'private page content' });
      options.onEvidenceDiagnostic({ kind: 'browser_call_pending', persona: 'member',
        callOrdinal: 2, tool: 'browser_navigate', side: 'base', routeOrdinal: 1,
        durationMs: 30_000 });
      throw Object.assign(new Error('The agent timed out.'), { code: 'evidence_agent_timeout' });
    },
  });
  await assert.rejects(execute(fixture), { code: 'evidence_agent_timeout' });
  const activity = fixture.transitions.at(-1).patch.traceSummary.agentActivity;
  assert.equal(activity.browserCallCounts.browser_navigate, 1);
  assert.equal(activity.pendingBrowserCalls[0].durationMs, 30_000);
  assert.equal(activity.pendingBrowserCalls[0].checkRank, 3);
  assert.deepEqual(activity.pendingDocumentRequests, []);
  assert.equal(activity.events[2].httpStatus, 404);
  assert.equal(activity.events[2].durationMs, 482);
  assert.doesNotMatch(JSON.stringify(activity), /private|page content|\.invalid|\/token/i);
});

test('a timeout identifies an unfinished GLM request and its last observed stage', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      options.onEvidenceDiagnostic({ kind: 'provider_request_start', requestOrdinal: 1,
        prompt: 'private user prompt' });
      options.onEvidenceDiagnostic({ kind: 'provider_response_headers', requestOrdinal: 1,
        httpStatus: 200, durationMs: 4200, providerUrl: 'https://private.invalid' });
      options.onEvidenceDiagnostic({ kind: 'provider_request_pending', requestOrdinal: 1,
        stage: 'await_first_byte', durationMs: 45_000, output: 'private model output' });
      throw Object.assign(new Error('The agent timed out.'), { code: 'evidence_agent_timeout' });
    },
  });
  await assert.rejects(execute(fixture), { code: 'evidence_agent_timeout' });
  const activity = fixture.transitions.at(-1).patch.traceSummary.agentActivity;
  assert.equal(activity.pendingProviderRequests.length, 1);
  assert.equal(activity.pendingProviderRequests[0].requestOrdinal, 1);
  assert.equal(activity.pendingProviderRequests[0].stage, 'await_first_byte');
  assert.equal(activity.pendingProviderRequests[0].durationMs, 45_000);
  assert.equal(activity.pendingProviderRequests[0].httpStatus, 200);
  assert.doesNotMatch(JSON.stringify(activity), /private|prompt|output|\.invalid/i);
});

test('a completed planner turn without tool calls retains tool availability and resume mode', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      options.onEvidenceDiagnostic({ kind: 'provider_dispatched', backend: 'claude_code', requestMode: 'agent_resume' });
      options.onEvidenceDiagnostic({ kind: 'provider_init', mcpServerCount: 3, toolDefinitionCount: 24,
        evidenceGetContextAvailable: true, evidenceRunPlanAvailable: true,
        browserMemberToolCount: 7, browserAdminToolCount: 7 });
      options.onEvidenceDiagnostic({ kind: 'context_result', outcome: 'ok', responseCharacters: 12000,
        jsonValid: true, acceptedIntentPresent: true, originsPresent: true,
        revisionsPresent: true, storyCount: 3 });
      options.onEvidenceDiagnostic({ kind: 'first_output' });
      options.onEvidenceDiagnostic({ kind: 'provider_result', outcome: 'ok' });
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  await assert.rejects(execute(fixture), { code: 'missing_evidence_replay' });
  const trace = fixture.transitions.at(-1).patch.traceSummary;
  assert.equal(trace.control.planCalls, 0);
  assert.equal(trace.agentDispatches[0].outcome, 'completed');
  assert.deepEqual(trace.agentActivity.events.map((event) => event.kind),
    ['provider_dispatched', 'provider_init', 'context_result', 'first_output', 'provider_result']);
  assert.equal(trace.agentActivity.events[0].requestMode, 'agent_resume');
  assert.equal(trace.agentActivity.events[1].evidenceGetContextAvailable, true);
  assert.equal(trace.agentActivity.events[1].evidenceRunPlanAvailable, true);
  assert.equal(trace.agentActivity.events[1].browserMemberToolCount, 7);
  assert.equal(trace.agentActivity.events[2].responseCharacters, 12000);
  assert.equal(trace.agentActivity.events[2].storyCount, 3);
  assert.deepEqual(trace.agentActivity.toolCounts, {});
});

test('an unplanned model exit preserves its redacted final explanation for the owner', async () => {
  const observed = [];
  const fixture = setup({
    dispatch: async () => ({
      backend: 'claude_code',
      result: {
        lastResultText: 'I could not find the browser. member.jwt http://base.internal:3000 token=secret.jwt',
        resultSubtype: 'success', providerStopReason: 'end_turn', exitCode: 0,
        permissionDenialCount: 0, toolErrorCount: 0, responseTextBlockCount: 1,
        providerTurnCount: 2,
      },
    }),
  });
  await assert.rejects(execute(fixture, { onAgentFinalResponse: (summary) => observed.push(summary) }),
    { code: 'missing_evidence_replay' });
  const response = fixture.transitions.at(-1).patch.traceSummary.agentFinalResponse;
  assert.match(response.excerpt, /could not find the browser/);
  assert.doesNotMatch(response.excerpt, /member\.jwt|base\.internal|secret\.jwt/);
  assert.equal(response.stopReason, 'end_turn');
  assert.equal(response.resultSubtype, 'success');
  assert.equal(response.permissionDenialCount, 0);
  assert.deepEqual(observed, [response]);
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
  const heartbeatPool = { totalCount: 10, idleCount: 1, waitingCount: 3 };
  const heartbeat = orchestrator.startRunHeartbeat(heartbeatPool, RUN_ID, {
    heartbeatRun: async (_pool, _runId, phase, patch) => { seen.push(phase); writes.push(patch); },
  }, null, 10);
  heartbeat.onProgress({ stage: 'checkout_revisions' });
  heartbeat.onAgentDiagnostic({ version: 1, events: [{ kind: 'tool_start', tool: 'browser_navigate' }] }, 'tool_start');
  heartbeat.onAgentFinalResponse({ excerpt: 'Planner stopped.', characters: 16 });
  heartbeat.onReplayEvent({ pass: 1, type: 'action_started', side: 'base', actionId: 'open-settings' });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(seen.includes('checkout_revisions'));
  assert.equal(writes.at(-1).lastReplayEvent.actionId, 'open-settings');
  assert.equal(writes.at(-1).replayEvents.length, 1);
  assert.equal(writes.at(-1).agentActivity.events[0].tool, 'browser_navigate');
  assert.equal(writes.at(-1).agentFinalResponse.excerpt, 'Planner stopped.');
  assert.match(writes.at(-1).heartbeat.processId, /^[0-9a-f]{16}$/);
  assert.equal(writes.at(-1).heartbeat.poolTotal, 10);
  assert.equal(writes.at(-1).heartbeat.poolIdle, 1);
  assert.equal(writes.at(-1).heartbeat.poolWaiting, 3);
  const observer = orchestrator.liveRunObserver(RUN_ID, heartbeatPool);
  assert.equal(observer.ownsRun, true);
  assert.equal(observer.processId, writes.at(-1).heartbeat.processId);
  assert.equal(observer.heartbeatWrite.phase, 'checkout_revisions');
  assert.match(observer.heartbeatWrite.lastSucceededAt, /^20\d\d-/);
  assert.ok(seen.length >= 2, 'the lease renews during a slow provisioning step');
  heartbeat.stop();
  assert.equal(orchestrator.liveRunObserver(RUN_ID, heartbeatPool).ownsRun, false);
  const stoppedAt = seen.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(seen.length, stoppedAt, 'finished runs stop renewing their lease');
  assert.equal(orchestrator.progressPhase({ phase: 'build', detail: 'private output' }), 'build_build');
  assert.equal(orchestrator.progressPhase({ detail: 'private output' }), null);
});

test('private observer identifies a heartbeat write still waiting in the owner process', async () => {
  let started;
  let release;
  const writeStarted = new Promise((resolve) => { started = resolve; });
  const writeReleased = new Promise((resolve) => { release = resolve; });
  const heartbeat = orchestrator.startRunHeartbeat({}, RUN_ID, {
    heartbeatRun: async () => { started(); await writeReleased; },
  }, null, 1000);
  try {
    await writeStarted;
    const waiting = orchestrator.liveRunObserver(RUN_ID, {});
    assert.equal(waiting.ownsRun, true);
    assert.match(waiting.heartbeatWrite.startedAt, /^20\d\d-/);
    assert.equal(waiting.heartbeatWrite.lastSucceededAt, null);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    const finished = orchestrator.liveRunObserver(RUN_ID, {});
    assert.equal(finished.heartbeatWrite.startedAt, null);
    assert.match(finished.heartbeatWrite.lastSucceededAt, /^20\d\d-/);
  } finally {
    release();
    heartbeat.stop();
  }
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

test('a merged proposal permits a deliberate rerun but no automatic worker revival', async (t) => {
  const fixture = setup();
  fixture.session.status = 'merged';
  fixture.session.source = 'imported';
  fixture.session.handoff_base_sha = BASE;
  fixture.session.imported_pr_head_sha = HEAD;
  fixture.session.visual_evidence_detail = { intent: fixtures.intent() };
  fixture.pool.query = async (sql) => {
    if (/FROM chat_sessions cs/.test(String(sql))) return { rows: [{ ...fixture.session, app_name: 'Demo' }] };
    if (/SELECT active_turn/.test(String(sql))) return { rows: [{ active_turn: false }] };
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  };
  fixture.dependencies.github = { compareRefs: async () => ({ files: [], filesComplete: true }) };
  fixture.dependencies.state.createRun = async () => ({ created: true, run: fixture.run });
  fixture.dependencies.state.clearNotStarted = async () => ({ cleared: true });
  const metadata = require('../src/services/pr-metadata');
  const sync = metadata.syncEvidencePrBlock;
  metadata.syncEvidencePrBlock = async () => {};
  t.after(() => { metadata.syncEvidencePrBlock = sync; });
  controlPlane._clearForTests();
  const config = { visualEvidence: { execute: true, maxRunMs: 60_000, maxAgentMs: 10_000 } };
  const options = { pool: fixture.pool, sessionId: 42, headSha: HEAD };
  const automatic = await orchestrator.scheduleForSession(config, options, fixture.dependencies);
  assert.deepEqual(automatic, { scheduled: false, reason: 'closed' });
  assert.equal(fixture.calls.dispatches, 0);

  const manual = await orchestrator.scheduleForSession(config,
    { ...options, trigger: 'manual-rerun' }, fixture.dependencies);
  assert.equal(manual.scheduled, true);
  const result = await manual.promise;
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.workerReleased, 1);
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
      assert.equal(fixture.calls.stopClears, 1,
        'fallback is part of the same run and must not erase a newly requested stop');
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

test('a Codex planner that already explored does not launch a second model after timing out', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      options.onEvidenceDiagnostic({ kind: 'provider_dispatched', backend: 'codex_openrouter',
        requestMode: 'agent_new' });
      options.onEvidenceDiagnostic({ kind: 'tool_start', sequence: 1,
        tool: 'browser_navigate', side: 'base', routeOrdinal: 1 });
      throw Object.assign(new Error('The planner timed out.'), { code: 'evidence_agent_timeout' });
    },
  });
  fixture.session.agent_backend = 'codex_openrouter';
  await assert.rejects(execute(fixture), { code: 'evidence_agent_timeout' });
  assert.equal(fixture.calls.dispatches, 1);
  assert.equal(fixture.calls.stopClears, 1);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.agentDispatches.length, 1);
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

function stopHarness({ runState = 'exploring', turnMode = 'evidence', currentRunId = RUN_ID } = {}) {
  const calls = { transitions: [], stops: [] };
  const pool = { query: async () => ({ rows: [{ id: 42, app_id: 7, app_slug: 'demo', visual_evidence_run_id: currentRunId }] }) };
  const stateService = {
    getRun: async (_pool, runId) => ({ id: runId, current_run_id: currentRunId, state: runState, head_sha: HEAD }),
    transitionRun: async (_pool, runId, next, patch) => { calls.transitions.push({ runId, next, patch }); },
  };
  const workerApi = {
    getActiveTurnMode: () => turnMode,
    stopTurn: async (sessionId) => { calls.stops.push(sessionId); },
  };
  return { calls, pool, injected: { state: stateService, worker: workerApi } };
}

test('Stop fails the running preview as stopped and kills only an evidence turn', async () => {
  const running = stopHarness();
  assert.deepEqual(await orchestrator.stopForSession(running.pool, 42, running.injected), { stopped: true, runId: RUN_ID });
  assert.equal(running.calls.transitions.length, 1);
  assert.equal(running.calls.transitions[0].next, 'failed');
  assert.equal(running.calls.transitions[0].patch.failureCode, 'evidence_stopped');
  assert.equal(running.calls.transitions[0].patch.failureReason, orchestrator.EVIDENCE_STOPPED_REASON);
  assert.deepEqual(running.calls.stops, [42]);

  const replaying = stopHarness({ runState: 'replaying', turnMode: 'build' });
  assert.equal((await orchestrator.stopForSession(replaying.pool, 42, replaying.injected)).stopped, true);
  assert.deepEqual(replaying.calls.stops, [], 'a coding turn on the change is never killed');
});

test('Stop does nothing once the preview settled or was superseded', async () => {
  for (const options of [{ runState: 'verified' }, { runState: 'failed' }, { currentRunId: null }]) {
    const settled = stopHarness(options);
    assert.deepEqual(await orchestrator.stopForSession(settled.pool, 42, settled.injected), { stopped: false, reason: 'not_running' });
    assert.deepEqual(settled.calls.transitions, []);
    assert.deepEqual(settled.calls.stops, []);
  }
});
