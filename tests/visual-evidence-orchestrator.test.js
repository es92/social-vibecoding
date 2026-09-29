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

test('only a pure network-change browser failure qualifies for a deterministic replay retry', () => {
  const failure = {
    code: 'locator_not_found',
    detail: {
      storyId: 'approve-blank', side: 'base', phase: 'action',
      browserDiagnostics: {
        httpErrorCount: 0, blockedRequestCount: 0,
        failedRequests: [
          { error: 'net::ERR_NETWORK_CHANGED', location: { pathname: '/shell/assets/shell.js' } },
          { error: 'net::ERR_NETWORK_CHANGED', location: { pathname: '/usernode-native/v1/native.js' } },
        ],
        consoleErrors: [
          { message: 'Failed to load resource: net::ERR_NETWORK_CHANGED' },
        ],
        pageErrors: [{ message: 'Home is not defined', sourceKind: 'platform' }],
        httpErrors: [], blockedRequests: [],
      },
    },
  };
  assert.deepEqual(orchestrator.transientNetworkReplayFailure(failure), {
    kind: 'network_changed', code: 'locator_not_found', storyId: 'approve-blank',
    side: 'base', failedRequestCount: 2, consoleErrorCount: 1, pageErrorCount: 1,
  });
  assert.equal(orchestrator.replayRepairKind(failure, fixtures.plan()), null);
  assert.equal(orchestrator.transientNetworkReplayFailure({
    ...failure,
    detail: { ...failure.detail, browserDiagnostics: {
      ...failure.detail.browserDiagnostics,
      failedRequests: [
        ...failure.detail.browserDiagnostics.failedRequests,
        { error: 'net::ERR_CONNECTION_RESET' },
      ],
    } },
  }), null);
  assert.equal(orchestrator.transientNetworkReplayFailure({
    ...failure,
    detail: { ...failure.detail, browserDiagnostics: {
      ...failure.detail.browserDiagnostics,
      httpErrorCount: 1, httpErrors: [{ status: 503 }],
    } },
  }), null);
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

function virtualWaitClock() {
  let timeMs = 0;
  return {
    now: () => timeMs,
    wait: async (delayMs) => { timeMs += delayMs; },
  };
}

test('an ordinary coding turn keeps the normal evidence start deadline', async () => {
  const clock = virtualWaitClock();
  const pool = { query: async () => ({ rows: [{ active_turn: {
    mode: 'build', phase: 'executing',
  } }] }) };
  await assert.rejects(orchestrator.waitForSessionIdle(pool, 42, {
    timeoutMs: 20,
    recoveryTimeoutMs: 50,
    intervalMs: 10,
    now: clock.now,
    wait: clock.wait,
    workerService: { isInFlight: () => true, getActiveTurnMode: () => 'build' },
  }), (error) => {
    assert.equal(error.code, 'evidence_agent_busy');
    assert.deepEqual(error.detail.idleWait, {
      version: 1, outcome: 'timeout', waitClass: 'session_busy', recoveryReason: null,
      normalLimitMs: 20, recoveryLimitMs: 50, waitedMs: 20, polls: 3,
      activeTurnPresent: true, activeTurnMode: 'build', activeTurnPhase: 'executing',
      workerInFlight: true, workerMode: 'build',
    });
    return true;
  });
});

test('an interrupted evidence turn may finish cleanup after the normal deadline', async () => {
  const clock = virtualWaitClock();
  const pool = { query: async () => ({ rows: [{
    active_turn: clock.now() < 30
      ? { mode: 'evidence', phase: 'cleanup_pending' }
      : null,
  }] }) };
  const result = await orchestrator.waitForSessionIdle(pool, 42, {
    timeoutMs: 20,
    recoveryTimeoutMs: 50,
    intervalMs: 10,
    now: clock.now,
    wait: clock.wait,
    workerService: { isInFlight: () => false, getActiveTurnMode: () => null },
  });
  assert.deepEqual(result, {
    version: 1, outcome: 'idle', waitClass: 'evidence_recovery',
    recoveryReason: 'evidence_turn', normalLimitMs: 20, recoveryLimitMs: 50,
    waitedMs: 30, polls: 4, activeTurnPresent: false,
    activeTurnMode: null, activeTurnPhase: null, workerInFlight: false, workerMode: null,
  });
});

test('a stuck evidence cleanup fails at the extended deadline with diagnostics', async () => {
  const clock = virtualWaitClock();
  const observations = [];
  const pool = { query: async () => ({ rows: [{ active_turn: {
    mode: 'evidence', phase: 'cleanup_pending',
  } }] }) };
  await assert.rejects(orchestrator.waitForSessionIdle(pool, 42, {
    timeoutMs: 20,
    recoveryTimeoutMs: 40,
    intervalMs: 10,
    now: clock.now,
    wait: clock.wait,
    onObservation: (observation) => observations.push(observation),
    workerService: { isInFlight: () => false, getActiveTurnMode: () => null },
  }), (error) => {
    assert.equal(error.code, 'evidence_agent_busy');
    assert.equal(error.detail.idleWait.waitClass, 'evidence_recovery');
    assert.equal(error.detail.idleWait.waitedMs, 40);
    assert.equal(error.detail.idleWait.polls, 5);
    assert.equal(error.detail.idleWait.outcome, 'timeout');
    return true;
  });
  assert.equal(observations.at(-1).outcome, 'timeout');
});

test('an idle-wait failure is retained in the durable run trace before any model call', async () => {
  const fixture = setup();
  const waiting = {
    version: 1, outcome: 'waiting', waitClass: 'evidence_recovery',
    recoveryReason: 'evidence_turn', normalLimitMs: 120_000, recoveryLimitMs: 240_000,
    waitedMs: 239_500, polls: 480, activeTurnPresent: true,
    activeTurnMode: 'evidence', activeTurnPhase: 'cleanup_pending',
    workerInFlight: false, workerMode: null,
  };
  const timeout = { ...waiting, outcome: 'timeout', waitedMs: 240_000, polls: 481 };
  fixture.dependencies.waitForSessionIdle = async (_pool, _sessionId, options) => {
    options.onObservation(waiting);
    throw Object.assign(new Error('The previous evidence worker is still clearing.'), {
      code: 'evidence_agent_busy', detail: { idleWait: timeout },
    });
  };

  await assert.rejects(execute(fixture), { code: 'evidence_agent_busy' });
  const failure = fixture.transitions.at(-1);
  assert.equal(failure.next, 'failed');
  assert.deepEqual(failure.patch.traceSummary.idleWait, timeout);
  assert.equal(failure.patch.traceSummary.failure.phase, 'wait_for_idle');
  assert.deepEqual(failure.patch.traceSummary.failure.detail.idleWait, timeout);
  assert.equal(fixture.calls.dispatches, 0);
});

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
      ...(options.captureMode ? { captureMode: true } : {}),
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

const { PNG } = require('pngjs');

function capturePng(shade = 0) {
  const image = new PNG({ width: 8, height: 6 });
  image.data.fill(shade);
  return PNG.sync.write(image);
}

function twoClaimIntent() {
  const semantic = fixtures.intent();
  return contract.parseIntent({
    ...semantic,
    stories: [
      semantic.stories[0],
      { ...semantic.stories[0], id: 'invite-empty', claim: 'An empty search says no users match.' },
    ],
  });
}

test('capture mode publishes the agent\'s own screenshots without replaying a plan', async () => {
  let stored = null;
  let dispatchOptions = null;
  const fixture = setup({
    storeArtifacts: async (_pool, runId, artifacts, fence) => { stored = { runId, artifacts, fence }; },
    dispatch: async (options) => {
      dispatchOptions = options;
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      assert.equal(control.getContext().mode, 'capture');
      control.submitCapture({ storyId: 'invite-suggestions', viewport: 'desktop', side: 'base' }, capturePng(10));
      control.submitCapture({ storyId: 'invite-suggestions', viewport: 'desktop', side: 'head' }, capturePng(200));
      control.submitCapture({ storyId: 'invite-suggestions', viewport: 'desktop', side: 'head', variant: 'focus' }, capturePng(90));
      return { backend: 'claude_code', threadId: 'capture-thread' };
    },
  });
  const result = await execute(fixture, { captureMode: true });
  assert.equal(result.state, 'verified');
  assert.equal(dispatchOptions.captureMode, true);
  assert.deepEqual(fixture.calls.passes, [], 'nothing is replayed');
  assert.equal(fixture.calls.resets, 1, 'only the exploration reset');
  assert.deepEqual(fixture.transitions.map((entry) => entry.next),
    ['provisioning', 'exploring', 'reviewing', 'verified']);
  const reviewing = fixture.transitions.find((entry) => entry.next === 'reviewing').patch;
  assert.equal(reviewing.hardVerdict.mode, 'agent_capture');
  assert.equal(reviewing.hardVerdict.runs, 1);
  assert.deepEqual(reviewing.hardVerdict.stories, [{ id: 'invite-suggestions', status: 'captured', captures: 3 }]);
  assert.equal(stored.runId, RUN_ID);
  assert.deepEqual(stored.fence, { headSha: HEAD, planHash: reviewing.planHash });
  assert.deepEqual(stored.artifacts.map(({ side, variant, media }) => `${side}:${variant}:${media}`).sort(),
    ['base:context:png', 'head:context:png', 'head:focus:png']);
  const verified = fixture.transitions.at(-1).patch;
  assert.equal(verified.planHash, reviewing.planHash);
  assert.equal(verified.traceSummary.runs, 1);
  assert.equal(verified.traceSummary.planSource, 'agent_capture');
  assert.equal(fixture.calls.cleaned, 1);
});

test('capture mode publishes the claims it reached and explains the blocked one', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      control.submitCapture({ storyId: 'invite-suggestions', viewport: 'desktop', side: 'base' }, capturePng(1));
      control.submitCapture({ storyId: 'invite-suggestions', viewport: 'desktop', side: 'head' }, capturePng(2));
      control.blockStory({ storyId: 'invite-empty', reason: 'The member fixture has no list to search.' });
      return { backend: 'claude_code', threadId: 'capture-thread' };
    },
  });
  fixture.run.intent = twoClaimIntent();
  const result = await execute(fixture, { captureMode: true });
  assert.equal(result.state, 'verified');
  const verdict = fixture.transitions.find((entry) => entry.next === 'reviewing').patch.hardVerdict;
  assert.deepEqual(verdict.stories.map(({ id, status }) => `${id}:${status}`),
    ['invite-suggestions:captured', 'invite-empty:blocked']);
  assert.equal(verdict.stories[1].reason, 'The member fixture has no list to search.');
});

test('capture mode with nothing publishable fails with each claim\'s reason', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      control.submitCapture({ storyId: 'invite-suggestions', viewport: 'desktop', side: 'head' }, capturePng(3));
      control.blockStory({ storyId: 'invite-suggestions', reason: 'Base never loads the members list.' });
      return { backend: 'claude_code', threadId: 'capture-thread' };
    },
  });
  await assert.rejects(execute(fixture, { captureMode: true }), (error) => {
    assert.equal(error.code, 'evidence_capture_incomplete');
    assert.match(error.message, /Base never loads the members list/);
    return true;
  });
  assert.deepEqual(fixture.transitions.map((entry) => entry.next), ['provisioning', 'exploring', 'failed']);
  assert.equal(fixture.calls.stored, 0);
});

test('capture mode surfaces a planner timeout when nothing was captured or explained', async () => {
  const fixture = setup({
    dispatch: async () => {
      throw Object.assign(new Error('The visual evidence agent exceeded its bounded exploration time.'),
        { code: 'evidence_agent_timeout' });
    },
  });
  await assert.rejects(execute(fixture, { captureMode: true }), { code: 'evidence_agent_timeout' });
  assert.equal(fixture.calls.dispatches, 1, 'a capture turn is not followed by a replay reminder');
});

test('an author plan still replays twice while capture mode is on', async () => {
  const fixture = setup();
  const result = await execute(fixture, { captureMode: true, authorPlan: fixtures.plan() });
  assert.equal(result.state, 'verified');
  assert.deepEqual(fixture.calls.passes, [1, 2]);
  assert.equal(fixture.calls.dispatches, 0);
});

test('a pure network change retries the same pass without spending a model repair', async () => {
  const networkChanged = Object.assign(new Error('The page bundle changed network during startup.'), {
    code: 'locator_not_found',
    detail: {
      storyId: 'invite-suggestions', viewport: 'desktop', side: 'base',
      phase: 'action', actionId: 'open-members',
      browserDiagnostics: {
        httpErrorCount: 0, blockedRequestCount: 0,
        failedRequests: [{ error: 'net::ERR_NETWORK_CHANGED',
          location: { sameOrigin: true, pathname: '/shell/assets/shell.js' } }],
        consoleErrors: [{ message: 'Failed to load resource: net::ERR_NETWORK_CHANGED' }],
        pageErrors: [{ message: 'Home is not defined', sourceKind: 'platform' }],
        httpErrors: [], blockedRequests: [],
      },
    },
  });
  const fixture = setup();
  const runPass = fixture.dependencies.replay.runPass;
  let failed = false;
  fixture.dependencies.replay.runPass = async (...args) => {
    if (!failed) {
      failed = true;
      fixture.calls.passes.push(args[2].pass);
      throw networkChanged;
    }
    return runPass(...args);
  };
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 1);
  assert.deepEqual(fixture.calls.passes, [1, 1, 2]);
  assert.equal(fixture.calls.resets, 4);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.repairCount, 0);
  const retry = fixture.transitions.at(-1).patch.traceSummary.replayRetries[0];
  assert.deepEqual(retry, {
    attempt: 1, pass: 1, retry: 1, durationMs: retry.durationMs,
    kind: 'network_changed', code: 'locator_not_found', storyId: 'invite-suggestions',
    side: 'base', failedRequestCount: 1, consoleErrorCount: 1, pageErrorCount: 1,
  });
});

test('a repeated pure network change fails without asking the model to edit the plan', async () => {
  const networkChanged = Object.assign(new Error('The page bundle changed network during startup.'), {
    code: 'locator_not_found',
    detail: {
      storyId: 'invite-suggestions', side: 'base', phase: 'action', actionId: 'open-members',
      browserDiagnostics: {
        httpErrorCount: 0, blockedRequestCount: 0,
        failedRequests: [{ error: 'net::ERR_NETWORK_CHANGED' }],
        consoleErrors: [{ message: 'Failed to load resource: net::ERR_NETWORK_CHANGED' }],
        pageErrors: [], httpErrors: [], blockedRequests: [],
      },
    },
  });
  const fixture = setup();
  fixture.dependencies.replay.runPass = async (_config, _sessionId, input) => {
    fixture.calls.passes.push(input.pass);
    throw networkChanged;
  };
  await assert.rejects(execute(fixture), { code: 'locator_not_found' });
  assert.equal(fixture.calls.dispatches, 1);
  assert.deepEqual(fixture.calls.passes, [1, 1]);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.repairCount, 0);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.replayRetries.length, 1);
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
        if (dispatchCount === 3) {
          assert.equal(options.completionReminder, true);
          assert.equal(options.resumeThreadId, 'thread-1');
        }
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
  assert.equal(fixture.calls.dispatches, 3);
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

test('only an actionability timeout on one attached visible target may be repaired', () => {
  const plan = fixtures.plan();
  const detail = {
    phase: 'action', side: 'base', actionId: 'open-app', actionType: 'click',
    targetStates: [{ matchedCount: 1, visibleCount: 1, attachedCount: 1 }],
    pageState: { visibleDialogCount: 1 },
  };
  const failure = Object.assign(
    new Error('locator.click: Timeout 10000ms exceeded. Call log: target intercepted pointer events'),
    { code: 'replay_failed', detail }
  );
  assert.equal(orchestrator.replayRepairKind(failure, plan), 'actionability');
  assert.equal(orchestrator.replayRepairKind(Object.assign(
    new Error('locator.click: Timeout 10000ms exceeded.'),
    { code: 'replay_failed', detail: { ...detail,
      targetStates: [{ matchedCount: 0, visibleCount: 0, attachedCount: 0 }] } }
  ), plan), null);
  assert.equal(orchestrator.replayRepairKind(Object.assign(
    new Error('browser was closed'), { code: 'replay_failed', detail }
  ), plan), null);
  assert.equal(orchestrator.replayRepairKind(Object.assign(
    new Error('locator.click: Timeout 10000ms exceeded.'),
    { code: 'replay_failed', detail: { ...detail, actionType: 'navigate' } }
  ), plan), null);
});

test('a blocked visible action starts a correction turn and two clean replays', async () => {
  const rejected = fixtures.plan();
  // The fixture deliberately shares its before/after action array. A real
  // parsed plan has independent JSON arrays, so mirror that shape here before
  // adding the setup action to both sides.
  const corrected = JSON.parse(JSON.stringify(fixtures.plan()));
  const dismissal = {
    id: 'dismiss-blocker', stage: 'setup', type: 'click',
    target: { by: 'role', role: 'button', name: 'Skip tour', exact: true },
  };
  corrected.stories[0].replay.before.actions.unshift(dismissal);
  corrected.stories[0].replay.after.actions.unshift({ ...dismissal });
  const blocked = Object.assign(
    new Error('locator.click: Timeout 10000ms exceeded. Call log: target intercepted pointer events'),
    { code: 'replay_failed', detail: {
      storyId: 'invite-suggestions', viewport: 'desktop', side: 'base',
      phase: 'action', actionId: 'open-members', actionType: 'click',
      targetStates: [{ matchedCount: 1, visibleCount: 1, attachedCount: 1 }],
      pageState: { visibleDialogCount: 1, visibleLandmarkIds: ['home-tour'] },
    } }
  );
  const fixture = setup({ dispatch: async (options, dispatchCount) => {
    const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
    if (dispatchCount === 1) {
      await assert.rejects(control.runPlan(rejected), { code: 'replay_failed' });
    } else {
      assert.equal(options.repairAttempt, 1);
      assert.equal(control.getContext().repair.failure.kind, 'actionability');
      assert.equal(control.getContext().repair.failure.detail.actionId, 'open-members');
      await control.runPlan(corrected);
    }
    return { backend: 'claude_code', threadId: 'evidence-thread' };
  } });
  const runPass = fixture.dependencies.replay.runPass;
  let failed = false;
  fixture.dependencies.replay.runPass = async (...args) => {
    if (!failed) {
      failed = true;
      fixture.calls.passes.push(args[2].pass);
      throw blocked;
    }
    return runPass(...args);
  };
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  assert.deepEqual(fixture.calls.passes, [1, 1, 2]);
  assert.equal(fixture.calls.stored, 1);
  assert.deepEqual(fixture.transitions.at(-1).patch.traceSummary.repairTrigger, {
    kind: 'actionability', code: 'replay_failed', side: 'base', actionId: 'open-members',
  });
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

test('only exact positive assertion locator mismatches become constrained repairs', () => {
  const plan = fixtures.plan();
  const story = plan.stories[0];
  const failure = (assertion, count, actual = null) => {
    story.replay.checkpoint.assertions.before[0] = assertion;
    return {
      code: 'assertion_failed',
      detail: {
        storyId: story.id, phase: 'assertion', side: 'base', assertionIndex: 0,
        count, actual, assertion,
      },
    };
  };
  const target = { by: 'css', value: '[data-step="approve"]' };
  const assertions = [
    { type: 'visible', target },
    { type: 'hidden', target },
    { type: 'attached', target },
    { type: 'checked', target },
    { type: 'text', target, value: 'Approved', exact: true },
    { type: 'value', target, value: 'approved' },
    { type: 'focusWithin', target },
  ];
  for (const assertion of assertions) {
    assert.equal(orchestrator.replayRepairKind(failure(assertion, 2), plan),
      'assertion_locator', assertion.type);
  }
  assert.equal(orchestrator.replayRepairKind(failure({ type: 'attached', target }, 0), plan),
    'assertion_locator');
  assert.equal(orchestrator.replayRepairKind(failure({ type: 'hidden', target }, 1, true), plan), null);
  assert.equal(orchestrator.replayRepairKind(failure({ type: 'detached', target }, 2), plan), null);
  assert.equal(orchestrator.replayRepairKind(failure({ type: 'count', count: 1, target }, 0), plan),
    'assertion_locator');
  assert.equal(orchestrator.replayRepairKind(failure({ type: 'count', count: 1, target }, 2), plan),
    'assertion_locator');
  assert.equal(orchestrator.replayRepairKind(failure({ type: 'count', count: 0, target }, 1), plan), null);

  const exact = { type: 'visible', target };
  const mismatch = failure(exact, 0);
  mismatch.detail.assertion = { ...exact, target: { by: 'css', value: '.different' } };
  assert.equal(orchestrator.replayRepairKind(mismatch, plan), null,
    'the browser failure must identify the exact assertion in the submitted plan');
});

test('only a hidden supporting base assertion beside an absence proof gets a correction', () => {
  const plan = fixtures.plan();
  const story = plan.stories[0];
  story.intent.baseState = 'not_present';
  const supporting = {
    type: 'visible', target: { by: 'css', value: '#admin-merges-runs' },
  };
  story.replay.checkpoint.assertions.before.unshift(supporting);
  const failure = {
    code: 'assertion_failed',
    detail: {
      storyId: story.id, side: 'base', phase: 'assertion', assertionIndex: 0,
      count: 1, actual: null, assertion: supporting,
      targetStates: [{ matchedCount: 1, visibleCount: 0, attachedCount: 1 }],
    },
  };
  assert.equal(orchestrator.replayRepairKind(failure, plan), 'supporting_visibility');
  assert.equal(orchestrator.replayRepairKind({ ...failure,
    detail: { ...failure.detail, side: 'head' } }, plan), null);
  story.intent.baseState = 'present';
  assert.equal(orchestrator.replayRepairKind(failure, plan), null);
  story.intent.baseState = 'not_present';
  story.replay.checkpoint.assertions.before.splice(1, 1);
  assert.equal(orchestrator.replayRepairKind(failure, plan), null);
});

test('a hidden supporting base assertion gets one bounded correction and fresh passes', async () => {
  const rejected = fixtures.plan();
  const story = rejected.stories[0];
  story.intent.baseState = 'not_present';
  const supporting = {
    type: 'visible', target: { by: 'css', value: '#admin-merges-runs' },
  };
  story.replay.checkpoint.assertions.before.unshift(supporting);
  const corrected = JSON.parse(JSON.stringify(rejected));
  corrected.stories[0].replay.checkpoint.assertions.before.shift();
  const failure = Object.assign(new Error('visible assertion failed.'), {
    code: 'assertion_failed',
    detail: {
      storyId: story.id, side: 'base', phase: 'assertion', assertionIndex: 0,
      count: 1, actual: null, assertion: supporting,
      targetStates: [{ matchedCount: 1, visibleCount: 0, attachedCount: 1 }],
    },
  });
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      if (dispatchCount === 1) await assert.rejects(control.runPlan(rejected));
      else {
        assert.equal(control.getContext().repair.failure.kind, 'supporting_visibility');
        await control.runPlan(corrected);
      }
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  fixture.run.intent = contract.parseIntent(contract.semanticIntentFromPlan(rejected));
  const runPass = fixture.dependencies.replay.runPass;
  let failed = false;
  fixture.dependencies.replay.runPass = async (...args) => {
    if (!failed) {
      failed = true;
      fixture.calls.passes.push(args[2].pass);
      throw failure;
    }
    return runPass(...args);
  };
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  assert.deepEqual(fixture.calls.passes, [1, 1, 2]);
  assert.deepEqual(fixture.transitions.at(-1).patch.traceSummary.repairTrigger, {
    kind: 'supporting_visibility', code: 'assertion_failed', side: 'base', assertionIndex: 0,
  });
});

test('a positive count assertion with the wrong accessible target gets one constrained correction', async () => {
  const rejected = fixtures.plan();
  const failedAssertion = {
    type: 'count',
    target: {
      by: 'role', role: 'status', name: 'Paused live view · Checks passing', exact: true,
    },
    count: 1,
  };
  rejected.stories[0].replay.checkpoint.assertions.after.push(failedAssertion);
  const corrected = structuredClone(rejected);
  corrected.stories[0].replay.checkpoint.assertions.after[1].target = {
    by: 'css', value: '#admin-merges-paused-live',
  };
  const failure = Object.assign(new Error('count assertion failed.'), {
    code: 'assertion_failed',
    detail: {
      storyId: rejected.stories[0].id, side: 'head', phase: 'assertion',
      assertionIndex: 1, assertionType: 'count', count: 0, actual: 0,
      assertion: failedAssertion,
      targetStates: [{
        kind: 'role', role: 'status', matchedCount: 0, attachedCount: 0, visibleCount: 0,
        roleHints: {
          candidateCount: 2,
          candidates: [{ name: '- status: Paused live view · Checks passing', visible: true }],
        },
      }],
    },
  });
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      if (dispatchCount === 1) await assert.rejects(control.runPlan(rejected));
      else {
        assert.equal(control.getContext().repair.failure.kind, 'assertion_locator');
        await control.runPlan(corrected);
      }
      return { backend: 'codex_openrouter', agentThreadId: 'evidence-thread' };
    },
  });
  fixture.run.intent = contract.parseIntent(contract.semanticIntentFromPlan(rejected));
  const runPass = fixture.dependencies.replay.runPass;
  let failed = false;
  fixture.dependencies.replay.runPass = async (...args) => {
    if (!failed) {
      failed = true;
      fixture.calls.passes.push(args[2].pass);
      throw failure;
    }
    return runPass(...args);
  };
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  assert.deepEqual(fixture.calls.passes, [1, 1, 2]);
  assert.deepEqual(fixture.transitions.at(-1).patch.traceSummary.repairTrigger, {
    kind: 'assertion_locator', code: 'assertion_failed', side: 'head', assertionIndex: 1,
  });
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
  const plans = [fixtures.plan(), fixtures.plan()];
  plans[1].stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  plans.push(structuredClone(plans[1]));
  plans[2].stories[0].replay.checkpoint.assertions.after[0].target = {
    by: 'css', value: '[role="listbox"]:not([hidden])',
  };
  const failedAssertion = contract.parseReplayPlan(plans[1])
    .stories[0].replay.checkpoint.assertions.after[0];
  const failures = [
    Object.assign(new Error('Action locator missing.'), {
      code: 'locator_not_found', detail: { side: 'base', phase: 'action', actionId: 'wait-ready' },
    }),
    Object.assign(new Error('visible assertion failed.'), {
      code: 'assertion_failed', detail: {
        storyId: 'invite-suggestions', side: 'head', phase: 'assertion',
        assertionIndex: 0, count: 0, assertion: failedAssertion,
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

test('an ambiguous assertion locator can receive the remaining bounded correction', async () => {
  const plans = [fixtures.plan(), fixtures.plan()];
  plans[1].stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  plans.push(structuredClone(plans[1]));
  plans[2].stories[0].replay.checkpoint.assertions.before[0].target = {
    by: 'css', value: '[role="listbox"]:not([hidden])',
  };
  const failedAssertion = contract.parseReplayPlan(plans[1])
    .stories[0].replay.checkpoint.assertions.before[0];
  const ambiguousAssertion = {
    storyId: 'invite-suggestions', side: 'base', phase: 'assertion', assertionIndex: 0,
    count: 2, actual: null,
    assertion: failedAssertion,
  };
  const failures = [
    Object.assign(new Error('Action locator missing.'), {
      code: 'locator_not_found', detail: { side: 'base', phase: 'action', actionId: 'wait-ready' },
    }),
    Object.assign(new Error('hidden assertion failed.'), {
      code: 'assertion_failed', detail: ambiguousAssertion,
    }),
  ];
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      assert.equal(options.repairAttempt, dispatchCount - 1);
      if (dispatchCount === 3) {
        assert.deepEqual(control.getContext().repair.failure, {
          kind: 'assertion_locator', code: 'assertion_failed',
          message: 'hidden assertion failed.', detail: ambiguousAssertion,
        });
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
  assert.deepEqual(fixture.transitions.at(-1).patch.traceSummary.repairTriggers, [
    { kind: 'locator', code: 'locator_not_found', side: 'base', actionId: 'wait-ready' },
    { kind: 'assertion_locator', code: 'assertion_failed', side: 'base', assertionIndex: 0 },
  ]);
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

test('a timed-out correction uses its reserved terminal-only reminder without extending the repair budget', async () => {
  const mismatch = Object.assign(new Error('Outcome did not match an element.'), {
    code: 'locator_not_found', detail: {
      side: 'base', phase: 'action', actionId: 'select-outcome', kind: 'label',
      matchedCount: 0, visibleCount: 0, attachedCount: 0,
    },
  });
  const corrected = fixtures.plan();
  corrected.stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  const dispatchOptions = [];
  const fixture = setup({
    dispatch: async (options, dispatchCount) => {
      dispatchOptions.push(options);
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      if (dispatchCount === 1) {
        await assert.rejects(control.runPlan(fixtures.plan()), { code: 'locator_not_found' });
        return { backend: 'codex_openrouter', threadId: 'evidence-thread', result: { exitCode: 0 } };
      }
      if (dispatchCount === 2) {
        assert.equal(options.repairAttempt, 1);
        assert.equal(options.completionReminder, false);
        throw Object.assign(new Error('The repair exploration timed out.'), {
          code: 'evidence_agent_timeout',
        });
      }
      assert.equal(options.repairAttempt, 1);
      assert.equal(options.completionReminder, true);
      assert.equal(options.resumeThreadId, 'evidence-thread');
      await control.runPlan(corrected);
      return { backend: 'codex_openrouter', threadId: 'evidence-thread', result: { exitCode: 0 } };
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

  const result = await execute(fixture, { maxRepairAgentMs: 200 });
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 3);
  assert.equal(dispatchOptions[1].timeoutMs, 100);
  assert.ok(dispatchOptions[2].timeoutMs > 0 && dispatchOptions[2].timeoutMs <= 100);
  const dispatches = fixture.transitions.at(-1).patch.traceSummary.agentDispatches;
  assert.equal(dispatches[1].budgetMs, 200);
  assert.equal(dispatches[1].completionReserveMs, 100);
  assert.equal(dispatches[1].code, 'evidence_agent_timeout');
  assert.equal(dispatches[2].completionReminder, true);
  assert.equal(dispatches[2].repairAttempt, 1);
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
      options.onEvidenceDiagnostic({ kind: 'provider_tool_config', mcpServerCount: 3,
        toolDefinitionCount: 12, topLevelFunctionToolCount: 8,
        topLevelNamespaceToolCount: 3, topLevelOtherToolCount: 1,
        nestedToolDefinitionCount: 24, nestedFunctionToolCount: 24,
        evidenceToolDefinitionCount: 4, forwardedToolDefinitionCount: 12,
        evidenceGetContextAvailable: true,
        evidenceRunPlanAvailable: true, evidenceReportBlockerAvailable: true,
        browserMemberToolCount: 7, browserAdminToolCount: 7,
        completionReminder: false, terminalToolChoiceRequired: false,
        toolSurfaceFiltered: false });
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
    ['provider_dispatched', 'provider_init', 'provider_tool_config',
      'context_result', 'first_output', 'provider_result']);
  assert.equal(trace.agentActivity.events[0].requestMode, 'agent_resume');
  assert.equal(trace.agentActivity.events[1].evidenceGetContextAvailable, true);
  assert.equal(trace.agentActivity.events[1].evidenceRunPlanAvailable, true);
  assert.equal(trace.agentActivity.events[1].browserMemberToolCount, 7);
  assert.equal(trace.agentActivity.events[3].responseCharacters, 12000);
  assert.equal(trace.agentActivity.events[3].storyCount, 3);
  assert.equal(trace.agentActivity.providerToolConfigs.length, 1);
  assert.equal(trace.agentActivity.providerToolConfigs[0].evidenceReportBlockerAvailable, true);
  assert.equal(trace.agentActivity.providerToolConfigs[0].topLevelNamespaceToolCount, 3);
  assert.equal(trace.agentActivity.providerToolConfigs[0].nestedToolDefinitionCount, 24);
  assert.equal(trace.agentActivity.providerToolConfigs[0].evidenceToolDefinitionCount, 4);
  assert.equal(trace.agentActivity.providerToolConfigs[0].toolSurfaceFiltered, false);
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

test('a normal model exit that forgot the plan gets one reminder in the same bounded thread', async () => {
  const dispatchOptions = [];
  const fixture = setup({
    dispatch: async (options, count) => {
      dispatchOptions.push(options);
      if (count === 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          backend: 'claude_code', threadId: 'evidence-thread',
          result: { lastResultText: 'Submitting the validated plan now.', exitCode: 0 },
        };
      }
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      await control.runPlan(fixtures.plan());
      return { backend: 'claude_code', threadId: 'evidence-thread', result: { exitCode: 0 } };
    },
  });

  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  assert.equal(dispatchOptions[0].completionReminder, false);
  assert.equal(dispatchOptions[1].completionReminder, true);
  assert.equal(dispatchOptions[1].resumeThreadId, 'evidence-thread');
  const dispatches = fixture.transitions.at(-1).patch.traceSummary.agentDispatches;
  assert.equal(dispatches[0].completionReminder, undefined);
  assert.equal(dispatches[1].completionReminder, true);
  assert.ok(dispatches[1].timeoutMs < dispatches[0].timeoutMs,
    'the reminder spends only what remains of the original agent budget');
  const responses = fixture.transitions.at(-1).patch.traceSummary.agentFinalResponses;
  assert.equal(responses.length, 1);
  assert.equal(responses[0].dispatch, 1);
  assert.equal(responses[0].excerpt, 'Submitting the validated plan now.');
  assert.deepEqual(fixture.calls.passes, [1, 2]);
});

test('the completion retry may report a concrete blocker instead of fabricating a plan', async () => {
  const fixture = setup({
    dispatch: async (options, count) => {
      if (count === 1) {
        return {
          backend: 'codex_openrouter', threadId: 'evidence-thread',
          result: { lastResultText: 'I cannot submit this flow yet.', exitCode: 0 },
        };
      }
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      control.finish({
        status: 'failed',
        reason: 'The accepted full-admin screen has no selectable proposal row in either revision.',
      });
      return { backend: 'codex_openrouter', threadId: 'evidence-thread', result: { exitCode: 0 } };
    },
  });

  await assert.rejects(execute(fixture), (error) => {
    assert.equal(error.code, 'evidence_agent_reported_failure');
    assert.match(error.message, /no selectable proposal row/i);
    return true;
  });
  const trace = fixture.transitions.at(-1).patch.traceSummary;
  assert.equal(trace.control.planCalls, 0);
  assert.equal(trace.control.finishStatus, 'failed');
  assert.match(trace.control.finishReason, /no selectable proposal row/i);
  assert.equal(trace.agentFinalResponses.length, 2);
});

test('a concrete blocker reported during exploration does not trigger a redundant reminder', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      const control = controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
      control.finish({ status: 'failed', reason: 'The required fixture record is absent on both revisions.' });
      return { backend: 'codex_openrouter', threadId: 'evidence-thread', result: { exitCode: 0 } };
    },
  });
  await assert.rejects(execute(fixture), { code: 'evidence_agent_reported_failure' });
  assert.equal(fixture.calls.dispatches, 1);
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
