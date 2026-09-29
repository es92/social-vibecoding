'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const contract = require('../src/services/visual-evidence-plan');
const controlPlane = require('../src/services/visual-evidence-control');
const shots = require('../src/services/visual-evidence-shots');
const orchestrator = require('../src/services/visual-evidence-orchestrator');
const logger = require('../src/services/logger');
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

const RUN_ID = '1'.repeat(32);
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const ORIGINS = { base: 'http://base.internal:3000', head: 'http://head.internal:3000' };
const TOKENS = { member: 'member.jwt', read_only_admin: 'admin.jwt', full_admin: 'full-admin.jwt' };
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

// Saves a before and an after screen shot on every declared screen of one
// change, as the shots bridge does after browser_take_screenshot.
function saveStills(control, change) {
  const story = control.intent.stories.find((candidate) => candidate.id === change);
  for (const viewport of story.viewports) {
    control.saveShot({ change, screen: viewport.name, side: 'before', kind: 'screen' },
      fixtures.png({ shade: 10 }));
    control.saveShot({ change, screen: viewport.name, side: 'after', kind: 'screen' },
      fixtures.png({ shade: 200 }));
  }
}

function saveClips(control, change) {
  const story = control.intent.stories.find((candidate) => candidate.id === change);
  for (const viewport of story.viewports) {
    control.saveShot({ change, screen: viewport.name, side: 'before', kind: 'clip' }, fixtures.webm(2048, 1));
    control.saveShot({ change, screen: viewport.name, side: 'after', kind: 'clip' }, fixtures.webm(4096, 2));
  }
}

// The control plane the preview agent reaches through the internal routes.
function controlFor(options) {
  return controlPlane.forRequest({ runId: options.runId, sessionId: 42 });
}

function twoChangeIntent() {
  const declared = fixtures.intent();
  return contract.parseIntent({
    ...declared,
    stories: [
      declared.stories[0],
      { ...declared.stories[0], id: 'invite-empty', claim: 'An empty search says no users match.' },
    ],
  });
}

function setup({ dispatch, storeArtifacts } = {}) {
  const transitions = [];
  // One ordered record of state writes, storage and teardown, so a test can
  // pin that the builds are gone before a run is published.
  const order = [];
  const calls = {
    resets: 0, stored: 0, cleaned: 0, dispatches: 0, minted: 0,
    stopClears: 0, workerReleased: 0, turnStops: [],
  };
  let currentState = 'planned';
  let turnMode = null;
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
  const dependencies = {
    state: {
      transitionRun: async (_pool, _runId, next, patch) => {
        // Like the database, a settled run refuses any further transition.
        if (['failed', 'verified', 'cancelled'].includes(currentState)) {
          throw Object.assign(new Error('The run already settled.'), { code: 'invalid_evidence_transition' });
        }
        transitions.push({ next, patch });
        order.push(`state:${next}`);
        currentState = next;
        return { ...run, state: next };
      },
      storeArtifacts: async (...args) => {
        order.push('store');
        if (storeArtifacts) return storeArtifacts(...args);
        calls.stored += 1;
        return undefined;
      },
      getForSession: async () => ({ state: currentState, headSha: HEAD }),
      getRun: async () => ({ ...run, state: currentState, current_run_id: RUN_ID }),
    },
    environment: {
      preparePair: async () => pair,
      resetPair: async () => {
        calls.resets += 1;
        return { origins: { ...ORIGINS }, ...provenance };
      },
      cleanupPair: async () => { calls.cleaned += 1; order.push('cleanup'); },
    },
    identities: { mintEvidenceAuthTokens: async () => { calls.minted += 1; return { ...TOKENS }; } },
    evidenceAgent: {
      dispatch: async (_config, options) => {
        calls.dispatches += 1;
        if (dispatch) return dispatch(options, calls.dispatches);
        const control = controlFor(options);
        for (const story of control.intent.stories) saveStills(control, story.id);
        return { backend: 'claude_code', threadId: 'thread-1' };
      },
    },
    evidenceControl: controlPlane,
    worker: {
      isInFlight: () => false,
      getActiveTurnMode: () => turnMode,
      stopTurn: async (sessionId) => { calls.turnStops.push(sessionId); },
      clearPendingStop: () => { calls.stopClears += 1; },
      destroyCcVolume: async () => { calls.workerReleased += 1; },
    },
  };
  return {
    pool, run, session, app, pair, dependencies, transitions, order, calls,
    current: () => currentState,
    setTurnMode: (mode) => { turnMode = mode; },
  };
}

async function execute(fixture, options = {}) {
  controlPlane._clearForTests();
  return orchestrator.executeRun({
    visualEvidence: {
      maxRunMs: 60_000,
      maxAgentMs: options.maxAgentMs || 10_000,
    },
  }, {
    pool: fixture.pool,
    run: fixture.run,
    session: fixture.session,
    app: fixture.app,
    revision: { baseSha: BASE, headSha: HEAD, files: [], filesComplete: true },
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.onAgentFinalResponse ? { onAgentFinalResponse: options.onAgentFinalResponse } : {}),
  }, fixture.dependencies);
}

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
  assert.deepEqual(fixture.transitions.map((entry) => entry.next), ['failed']);
  const trace = fixture.transitions.at(-1).patch.traceSummary;
  assert.deepEqual(trace.idleWait, timeout);
  // The error's own detail is kept, bounded, for the owner's diagnostics.
  assert.deepEqual(trace.failure, {
    phase: 'wait_for_idle', code: 'evidence_agent_busy',
    message: 'The previous evidence worker is still clearing.',
    detail: { idleWait: timeout },
  });
  assert.equal(Object.hasOwn(trace, 'control'), false, 'no run control existed yet');
  assert.equal(fixture.calls.dispatches, 0);
  assert.equal(fixture.calls.minted, 0);
});

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

// ── One run, end to end: the preview agent saves through RunControl ─────

test('every declared change saved publishes the ready files, tears the builds down, then verifies', async () => {
  let stored = null;
  let dispatchOptions = null;
  const progress = [];
  const fixture = setup({
    storeArtifacts: async (_pool, runId, artifacts, fence) => { stored = { runId, artifacts, fence }; },
    dispatch: async (options) => {
      dispatchOptions = options;
      const control = controlFor(options);
      saveStills(control, 'invite-suggestions');
      control.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'element' },
        fixtures.png({ shade: 90 }));
      saveStills(control, 'invite-empty');
      return { backend: 'claude_code', threadId: 'shots-thread' };
    },
  });
  fixture.run.intent = twoChangeIntent();
  const result = await execute(fixture, { onProgress: (event) => progress.push(event) });

  assert.equal(result.state, 'verified');
  assert.deepEqual(fixture.transitions.map((entry) => entry.next),
    ['provisioning', 'exploring', 'reviewing', 'verified']);
  assert.deepEqual(fixture.order, [
    'state:provisioning', 'state:exploring', 'state:reviewing', 'store', 'cleanup', 'state:verified',
  ], 'the before/after builds are torn down before the shots become visible');
  assert.equal(fixture.calls.cleaned, 1, 'a published run is not cleaned up a second time');
  assert.equal(fixture.calls.resets, 1, 'nothing is replayed, so the builds reset once');
  assert.equal(fixture.calls.dispatches, 1);
  assert.equal(fixture.calls.workerReleased, 0, 'an active native coding session retains its memory');

  assert.equal(dispatchOptions.runId, RUN_ID);
  assert.deepEqual(dispatchOptions.origins, ORIGINS);
  assert.equal(dispatchOptions.recordClips, false, 'no declared change is motion');
  assert.equal(dispatchOptions.resumeThreadId, null);
  assert.equal(dispatchOptions.forceBackend, null);
  assert.ok(dispatchOptions.timeoutMs > 0 && dispatchOptions.timeoutMs <= 10_000);
  assert.deepEqual(dispatchOptions.navigationHints.intentPaths, ['/lists/demo', '/lists/demo']);

  const reviewing = fixture.transitions.find((entry) => entry.next === 'reviewing').patch;
  assert.deepEqual(reviewing.hardVerdict, {
    passed: true, mode: shots.SHOTS_MODE, runs: 1,
    stories: [
      { id: 'invite-suggestions', status: 'ready', files: 3 },
      { id: 'invite-empty', status: 'ready', files: 2 },
    ],
  });
  assert.equal(shots.isShotsVerdict(reviewing.hardVerdict), true);

  assert.equal(stored.runId, RUN_ID);
  assert.deepEqual(stored.artifacts.map(({ storyId, side, variant, media }) =>
    `${storyId}:${side}:${variant}:${media}`).sort(), [
    'invite-empty:base:context:png', 'invite-empty:head:context:png',
    'invite-suggestions:base:context:png', 'invite-suggestions:head:context:png',
    'invite-suggestions:head:focus:png',
  ]);
  for (const file of stored.artifacts) {
    assert.equal(file.contentType, 'image/png');
    assert.equal(file.sha256, crypto.createHash('sha256').update(file.data).digest('hex'));
  }

  // The plan hash is the manifest hash: it fences storage and names exactly
  // the files that were published.
  const manifest = stored.artifacts
    .map(({ storyId, viewport, side, variant, sha256 }) => ({ storyId, viewport, side, variant, sha256 }))
    .sort((a, b) => shots.slotKey(a).localeCompare(shots.slotKey(b)));
  const manifestHash = crypto.createHash('sha256').update(contract.canonicalJson({
    mode: shots.SHOTS_MODE, intent: fixture.run.intent, manifest,
  })).digest('hex');
  assert.equal(reviewing.planHash, manifestHash);
  assert.deepEqual(stored.fence, { headSha: HEAD, planHash: manifestHash });
  const verified = fixture.transitions.at(-1).patch;
  assert.equal(verified.planHash, manifestHash);
  assert.deepEqual(verified.hardVerdict, reviewing.hardVerdict);
  assert.equal(verified.traceSummary.planHash, manifestHash);
  assert.equal(verified.traceSummary.runs, 1);
  assert.equal(verified.traceSummary.planSource, 'preview_agent');
  assert.equal(verified.traceSummary.terminalFailureClass, null);
  assert.equal(verified.traceSummary.artifactBytes,
    stored.artifacts.reduce((sum, file) => sum + file.bytes, 0));

  // These are the phase names the heartbeat persists while the run is live.
  assert.deepEqual(progress.filter((event) => event && typeof event === 'object')
    .map((event) => event.stage), [
    'wait_for_idle', 'prepare_pair', 'exploration_reset', 'mint_fixture_identities',
    'persist_exploration', 'exploring', 'register_control', 'agent_exploration',
    'persist_shots', 'store_artifacts', 'cleanup', 'verify',
  ]);
});

test('one change saved and another skipped still publishes, with the skip and its reason', async () => {
  let stored = null;
  const fixture = setup({
    storeArtifacts: async (_pool, _runId, artifacts) => { stored = artifacts; },
    dispatch: async (options) => {
      const control = controlFor(options);
      saveStills(control, 'invite-suggestions');
      // A lone after shot is not a before/after set; it must not be stored.
      control.saveShot({ change: 'invite-empty', screen: 'desktop', side: 'after', kind: 'screen' },
        fixtures.png({ shade: 30 }));
      control.skipChange({ change: 'invite-empty', reason: 'The member fixture has no list to search.' });
      return { backend: 'claude_code', threadId: 'shots-thread' };
    },
  });
  fixture.run.intent = twoChangeIntent();
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  const verdict = fixture.transitions.find((entry) => entry.next === 'reviewing').patch.hardVerdict;
  assert.equal(verdict.passed, true);
  assert.deepEqual(verdict.stories, [
    { id: 'invite-suggestions', status: 'ready', files: 2 },
    { id: 'invite-empty', status: 'skipped', reason: 'The member fixture has no list to search.' },
  ]);
  assert.deepEqual(stored.map(({ storyId, side }) => `${storyId}:${side}`).sort(),
    ['invite-suggestions:base', 'invite-suggestions:head']);
  assert.deepEqual(fixture.transitions.at(-1).patch.traceSummary.stories, verdict.stories);
});

test('nothing saved and a change skipped fails as incomplete with the skip reason', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      controlFor(options).skipChange({
        change: 'invite-suggestions', reason: 'Before never loads the members list.',
      });
      return { backend: 'claude_code', threadId: 'shots-thread' };
    },
  });
  await assert.rejects(execute(fixture), (error) => {
    assert.equal(error.code, 'evidence_capture_incomplete');
    assert.match(error.message, /Before never loads the members list/);
    return true;
  });
  assert.deepEqual(fixture.transitions.map((entry) => entry.next), ['provisioning', 'exploring', 'failed']);
  const failed = fixture.transitions.at(-1).patch;
  assert.equal(failed.failureCode, 'evidence_capture_incomplete');
  assert.match(failed.failureReason, /Before never loads the members list/);
  assert.equal(failed.traceSummary.failure.phase, 'agent_exploration');
  assert.deepEqual(failed.traceSummary.control, { savedFiles: 0, skippedChanges: 1, skippedAll: false });
  assert.equal(fixture.calls.stored, 0);
  assert.equal(fixture.calls.cleaned, 1, 'the builds are torn down after a failed run too');
});

test('skipping every change at once fails with the one shared reason', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      controlFor(options).skipChange({ reason: 'Every screen shows the sign-in page.' });
      return { backend: 'claude_code', threadId: 'shots-thread' };
    },
  });
  fixture.run.intent = twoChangeIntent();
  await assert.rejects(execute(fixture), { code: 'evidence_capture_incomplete' });
  const failed = fixture.transitions.at(-1).patch;
  assert.equal(failed.failureReason, 'Every screen shows the sign-in page.',
    'the shared reason is said once, not once per change');
  assert.deepEqual(failed.traceSummary.control, { savedFiles: 0, skippedChanges: 0, skippedAll: true });
});

test('nothing saved, nothing skipped and a failed agent keeps the agent\'s own error', async () => {
  const fixture = setup({
    dispatch: async () => {
      throw Object.assign(new Error('The preview agent exceeded its bounded time.'),
        { code: 'evidence_agent_timeout' });
    },
  });
  await assert.rejects(execute(fixture), { code: 'evidence_agent_timeout' });
  const failed = fixture.transitions.at(-1).patch;
  assert.equal(failed.failureCode, 'evidence_agent_timeout');
  assert.match(failed.failureReason, /bounded time/);
  assert.equal(failed.traceSummary.agentDispatches[0].outcome, 'failed');
  assert.equal(failed.traceSummary.agentDispatches[0].code, 'evidence_agent_timeout');
  assert.equal(fixture.calls.dispatches, 1, 'a Claude turn is not retried');
  assert.equal(fixture.calls.cleaned, 1);
});

test('a failed agent that explained a skip reports the skip rather than its error', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      controlFor(options).skipChange({ change: 'invite-suggestions', reason: 'The invite button is hidden for members.' });
      throw Object.assign(new Error('The preview agent exceeded its bounded time.'),
        { code: 'evidence_agent_timeout' });
    },
  });
  await assert.rejects(execute(fixture), { code: 'evidence_capture_incomplete' });
  assert.match(fixture.transitions.at(-1).patch.failureReason, /invite button is hidden/);
});

test('a complete before/after set is published even when the agent then runs out of time', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      saveStills(controlFor(options), 'invite-suggestions');
      throw Object.assign(new Error('The preview agent exceeded its bounded time.'),
        { code: 'evidence_agent_timeout' });
    },
  });
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.stored, 1);
  const trace = fixture.transitions.at(-1).patch.traceSummary;
  assert.equal(trace.agentDispatches[0].outcome, 'failed');
  assert.equal(trace.agentDispatches[0].code, 'evidence_agent_timeout');
});

test('a motion change with stills but no clips is skipped for its missing clips', async () => {
  let dispatchOptions = null;
  let stored = null;
  const fixture = setup({
    storeArtifacts: async (_pool, _runId, artifacts) => { stored = artifacts; },
    dispatch: async (options) => {
      dispatchOptions = options;
      const control = controlFor(options);
      saveStills(control, 'invite-suggestions');
      saveStills(control, 'saved-toast');
      return { backend: 'claude_code', threadId: 'shots-thread' };
    },
  });
  fixture.run.intent = contract.parseIntent(fixtures.motionIntent());
  const result = await execute(fixture);
  assert.equal(result.state, 'verified', 'the still change is still published');
  assert.equal(dispatchOptions.recordClips, true, 'the browsers record only when a change is motion');
  const verdict = fixture.transitions.find((entry) => entry.next === 'reviewing').patch.hardVerdict;
  assert.deepEqual(verdict.stories[0], { id: 'invite-suggestions', status: 'ready', files: 2 });
  assert.equal(verdict.stories[1].id, 'saved-toast');
  assert.equal(verdict.stories[1].status, 'skipped');
  assert.match(verdict.stories[1].reason, /did not save the before clip on desktop, the after clip on desktop/);
  assert.deepEqual([...new Set(stored.map((file) => file.storyId))], ['invite-suggestions'],
    'the motion change\'s stills are not published without its clips');
});

test('a motion change with a clip per side is published with both clips', async () => {
  let stored = null;
  const fixture = setup({
    storeArtifacts: async (_pool, _runId, artifacts) => { stored = artifacts; },
    dispatch: async (options) => {
      const control = controlFor(options);
      saveStills(control, 'invite-suggestions');
      saveStills(control, 'saved-toast');
      saveClips(control, 'saved-toast');
      return { backend: 'claude_code', threadId: 'shots-thread' };
    },
  });
  fixture.run.intent = contract.parseIntent(fixtures.motionIntent());
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  const verdict = fixture.transitions.find((entry) => entry.next === 'reviewing').patch.hardVerdict;
  assert.deepEqual(verdict.stories.map(({ id, status }) => `${id}:${status}`),
    ['invite-suggestions:ready', 'saved-toast:ready']);
  const clips = stored.filter((file) => file.variant === 'animation');
  assert.deepEqual(clips.map(({ storyId, side, media, contentType }) =>
    `${storyId}:${side}:${media}:${contentType}`).sort(),
  ['saved-toast:base:webm:video/webm', 'saved-toast:head:webm:video/webm']);
});

test('an agent opinion cannot veto a complete before/after set meant for people to judge', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      const control = controlFor(options);
      saveStills(control, 'invite-suggestions');
      control.skipChange({ reason: 'The crop may hide the changed list.' });
      return { backend: 'claude_code', threadId: 'shots-thread' };
    },
  });
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.deepEqual(fixture.transitions.at(-1).patch.hardVerdict.stories,
    [{ id: 'invite-suggestions', status: 'ready', files: 2 }]);
});

test('a refused save stays diagnosable after the agent ends its turn', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      const control = controlFor(options);
      assert.throws(() => control.saveShot(
        { change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'clip' },
        fixtures.webm()
      ), { code: 'clip_not_needed' });
      control.skipChange({ change: 'invite-suggestions', reason: 'The dialog never opened.' });
      return { backend: 'claude_code', threadId: 'shots-thread' };
    },
  });
  await assert.rejects(execute(fixture), { code: 'evidence_capture_incomplete' });
  const failure = fixture.transitions.at(-1).patch.traceSummary.failure;
  assert.equal(failure.phase, 'agent_exploration');
  assert.equal(failure.code, 'evidence_capture_incomplete');
  // The later, successful skip does not erase the last refused call.
  assert.equal(failure.tool, 'save-shot');
  assert.equal(failure.toolCode, 'clip_not_needed');
  assert.match(failure.toolMessage, /not declared as motion/);
});

// ── Provisioning, provenance and fixture sign-in ─────────────────────────

test('a build that cannot be prepared fails before sign-in, with nothing to tear down', async () => {
  const fixture = setup();
  fixture.dependencies.environment.preparePair = async () => {
    throw Object.assign(new Error('The before image did not build.'), { code: 'evidence_build_failed' });
  };
  await assert.rejects(execute(fixture), { code: 'evidence_build_failed' });
  assert.deepEqual(fixture.transitions.map((entry) => entry.next), ['provisioning', 'failed']);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.failure.phase, 'prepare_pair');
  assert.equal(fixture.calls.cleaned, 0);
  assert.equal(fixture.calls.minted, 0);
  assert.equal(fixture.calls.dispatches, 0);
});

test('a failed reset tears the prepared builds down and never signs anyone in', async () => {
  const fixture = setup();
  fixture.dependencies.environment.resetPair = async () => {
    throw Object.assign(new Error('The fixture clone timed out.'), { code: 'evidence_reset_failed' });
  };
  await assert.rejects(execute(fixture), { code: 'evidence_reset_failed' });
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.failure.phase, 'exploration_reset');
  assert.equal(fixture.calls.cleaned, 1);
  assert.equal(fixture.calls.minted, 0);
  assert.equal(fixture.calls.dispatches, 0);
});

test('builds that do not match their fixture and images fail before any token is minted', async () => {
  const fixture = setup();
  fixture.dependencies.environment.resetPair = async () => ({
    origins: { ...ORIGINS }, ...provenance, headImageDigest: 'sha256:other',
  });
  await assert.rejects(execute(fixture), { code: 'evidence_provenance_mismatch' });
  assert.deepEqual(fixture.transitions.map((entry) => entry.next), ['provisioning', 'failed']);
  assert.equal(fixture.calls.minted, 0);
  assert.equal(fixture.calls.dispatches, 0);
  assert.equal(fixture.calls.cleaned, 1);
});

test('fixture sign-in tokens are minted for this app once and reach only the agent dispatch', async () => {
  const minted = [];
  let brief = null;
  let dispatchTokens = null;
  const fixture = setup({
    dispatch: async (options) => {
      dispatchTokens = options.authTokens;
      const control = controlFor(options);
      brief = control.getContext();
      // The run-scoped control answers only this proposal's session.
      assert.throws(() => controlPlane.forRequest({ runId: options.runId, sessionId: 43 }),
        { code: 'evidence_scope_mismatch' });
      saveStills(control, 'invite-suggestions');
      return { backend: 'claude_code', threadId: 'shots-thread' };
    },
  });
  fixture.dependencies.identities.mintEvidenceAuthTokens = async (pool, appId, ...rest) => {
    minted.push({ pool, appId, rest, state: fixture.current() });
    return { ...TOKENS };
  };
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(minted.length, 1);
  assert.equal(minted[0].pool, fixture.pool);
  assert.equal(minted[0].appId, 9, 'tokens are minted for the proposal\'s own app');
  assert.deepEqual(minted[0].rest, []);
  assert.equal(minted[0].state, 'provisioning', 'minted after the builds matched, before exploring');
  assert.deepEqual(dispatchTokens, TOKENS);
  assert.equal(brief.runId, RUN_ID);
  assert.doesNotMatch(JSON.stringify(brief), /member\.jwt|admin\.jwt/,
    'the brief the agent reads carries no sign-in material');
  assert.doesNotMatch(JSON.stringify(fixture.transitions), /member\.jwt|admin\.jwt/,
    'no durable trace carries sign-in material');
  assert.throws(() => controlPlane.forRequest({ runId: RUN_ID, sessionId: 42 }),
    { code: 'evidence_control_not_found' }, 'the control is unregistered once the run ends');
});

test('slow paired environment provisioning does not consume the agent budget', async () => {
  const fixture = setup();
  const preparePair = fixture.dependencies.environment.preparePair;
  fixture.dependencies.environment.preparePair = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 70));
    return preparePair(...args);
  };
  const result = await execute(fixture, { maxAgentMs: 20 });
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 1);
  const dispatch = fixture.transitions.at(-1).patch.traceSummary.agentDispatches[0];
  assert.equal(dispatch.budgetMs, 20);
  assert.ok(dispatch.timeoutMs > 0 && dispatch.timeoutMs <= 20);
});

// ── The shots brief ──────────────────────────────────────────────────────

test('evidence brief ranks a relevant check beyond the first 80 manifest entries', () => {
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

test('the brief names the declared changes, both addresses and revisions, and no fixture secrets', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-testing-route-'));
  const route = '/?demo=1&ws=status#app/demo/workshop';
  try {
    const tests = Array.from({ length: 100 }, (_, index) => ({
      name: `Generic screen ${index}`, path: `/screen-${index}`,
    }));
    tests.push({ name: 'View strip', path: route, expectSelector: '.dev-ws-plus' });
    fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests }));
    const intent = contract.parseIntent(fixtures.intent());
    const fixtureEnv = { SESSION_SECRET: 'fixture-session-secret' };
    const brief = orchestrator.shotsBrief({
      run: { id: RUN_ID },
      session: {
        pr_title: 'Small spacing change', testing_path: route,
        testing_paths: [{ path: route, viewport: 'desktop' },
          { path: '/?token=secret.jwt#app/demo/workshop', viewport: 'phone' }],
        testing_md: 'Open the Workshop and inspect the view strip.',
      },
      revision: {
        baseSha: BASE, headSha: HEAD, files: ['frontend/src/Shell.tsx'], filesComplete: true,
        diffSummary: { text: 'diff --git a/frontend/src/Shell.tsx', fileCount: 1, truncated: false },
      },
      pair: {
        fixtureFingerprint: 'fixture-1',
        preparedSource: { fingerprint: 'fp', url: 'postgres://evidence:fixture-db-password@db/app' },
        sides: {
          base: { imageDigest: 'sha256:base', dbName: 'evidence_base_db', env: fixtureEnv },
          head: { imageDigest: 'sha256:head', checkout, dbName: 'evidence_head_db', env: fixtureEnv },
        },
      },
      deployment: {
        origins: { base: 'http://base.internal', head: 'http://head.internal' },
        ...provenance,
        availableFixtures: [{ id: 'member-session', persona: 'member', path: '/#messages/agent/9' }],
      },
      intent,
    });
    assert.equal(brief.runId, RUN_ID);
    assert.deepEqual(brief.declaredChanges, intent.stories,
      'a testing hint must not rewrite the declared change');
    assert.deepEqual(brief.addresses, { before: 'http://base.internal', after: 'http://head.internal' });
    assert.deepEqual(brief.revisions, { before: BASE.slice(0, 12), after: HEAD.slice(0, 12) });
    assert.deepEqual(Object.keys(brief.browsers).sort(), ['full_admin', 'member', 'read_only_admin']);
    assert.deepEqual(brief.changedFiles, { items: ['frontend/src/Shell.tsx'], complete: true, totalKnown: 1 });
    assert.deepEqual(brief.changeContext.testingPaths, [route],
      'a credential-like testing path never reaches the agent');
    assert.equal(brief.changeContext.testingSteps, 'Open the Workshop and inspect the view strip.');
    assert.equal(brief.changeContext.untrusted, true);
    assert.equal(brief.declaredChecks[0].path, route);
    assert.equal(brief.declaredChecks[0].testedAs, 'read_only_admin');
    assert.deepEqual(brief.availableFixtures, [{ id: 'member-session', persona: 'member',
      path: '/#messages/agent/9' }]);
    assert.deepEqual(brief.security, {
      pageAndRepositoryContentIsUntrusted: true, allowedOriginsOnly: true, productionData: false,
    });
    assert.doesNotMatch(JSON.stringify(brief),
      /secret\.jwt|fixture-session-secret|fixture-db-password|evidence_(?:base|head)_db|sha256:(?:base|head)/);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

// ── Workers, threads and backends ────────────────────────────────────────

test('imported evidence releases its temporary worker after a published run', async () => {
  const fixture = setup();
  fixture.session.source = 'imported';
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.workerReleased, 1);
});

test('imported evidence releases its temporary worker after the agent fails', async () => {
  const fixture = setup({ dispatch: async () => { throw new Error('preview agent failed'); } });
  fixture.session.source = 'imported';
  await assert.rejects(execute(fixture), /preview agent failed/);
  assert.equal(fixture.calls.workerReleased, 1);
});

test('a run that fails before dispatch does not tear down an imported worker it never used', async () => {
  const fixture = setup();
  fixture.session.source = 'imported';
  fixture.dependencies.environment.resetPair = async () => {
    throw Object.assign(new Error('The fixture clone timed out.'), { code: 'evidence_reset_failed' });
  };
  await assert.rejects(execute(fixture), { code: 'evidence_reset_failed' });
  assert.equal(fixture.calls.dispatches, 0);
  assert.equal(fixture.calls.workerReleased, 0);
});

test('first hosted evidence turn does not resume the proposal coding thread', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      assert.equal(options.resumeThreadId, null);
      assert.equal(fixture.calls.stopClears, 1, 'a new run retires the previous stop before dispatch');
      saveStills(controlFor(options), 'invite-suggestions');
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  fixture.session.agent_thread_id = 'coding-thread';
  fixture.session.cc_session_id = 'coding-thread';
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.stopClears, 1);
});

test('a Codex model that fails before saving anything falls back to the platform preview agent', async () => {
  const fixture = setup({
    dispatch: async (options, attempt) => {
      assert.equal(fixture.calls.stopClears, 1,
        'fallback is part of the same run and must not erase a newly requested stop');
      if (attempt === 1) {
        assert.equal(options.forceBackend, null);
        throw Object.assign(new Error('model cannot use browser tools'), { code: 'evidence_agent_failed' });
      }
      assert.equal(options.forceBackend, 'claude_code');
      assert.ok(options.timeoutMs > 0, 'the fallback shares what is left of the agent budget');
      saveStills(controlFor(options), 'invite-suggestions');
      return { backend: 'claude_code', threadId: 'fallback-thread' };
    },
  });
  fixture.session.agent_backend = 'codex_openrouter';
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 2);
  const dispatches = fixture.transitions.at(-1).patch.traceSummary.agentDispatches;
  assert.deepEqual(dispatches.map(({ requestedBackend, outcome }) => `${requestedBackend}:${outcome}`),
    ['codex_openrouter:failed', 'claude_code:completed']);
});

test('a Codex agent that already explored does not launch a second model after timing out', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      options.onEvidenceDiagnostic({ kind: 'provider_dispatched', backend: 'codex_openrouter',
        requestMode: 'agent_new' });
      options.onEvidenceDiagnostic({ kind: 'tool_start', sequence: 1,
        tool: 'browser_navigate', side: 'base', routeOrdinal: 1 });
      throw Object.assign(new Error('The preview agent timed out.'), { code: 'evidence_agent_timeout' });
    },
  });
  fixture.session.agent_backend = 'codex_openrouter';
  await assert.rejects(execute(fixture), { code: 'evidence_agent_timeout' });
  assert.equal(fixture.calls.dispatches, 1);
  assert.equal(fixture.calls.stopClears, 1);
  assert.equal(fixture.transitions.at(-1).patch.traceSummary.agentDispatches.length, 1);
});

test('a Codex agent that saved a shot keeps its run rather than launching a second model', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      controlFor(options).saveShot(
        { change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'screen' }, fixtures.png()
      );
      throw Object.assign(new Error('model stopped responding'), { code: 'evidence_agent_failed' });
    },
  });
  fixture.session.agent_backend = 'codex_openrouter';
  await assert.rejects(execute(fixture), { code: 'evidence_agent_failed' });
  assert.equal(fixture.calls.dispatches, 1);
  assert.deepEqual(fixture.transitions.at(-1).patch.traceSummary.control,
    { savedFiles: 1, skippedChanges: 0, skippedAll: false });
});

// ── Agent diagnostics and trace privacy ─────────────────────────────────

test('an agent timeout keeps a bounded, content-free record of its last active tool', async () => {
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

test('agent sign-in records every persona and side without retaining credentials', async () => {
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
  await assert.rejects(execute(fixture), { code: 'evidence_capture_incomplete' });
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

test('agent records public-app catalog and frame loading without storing app URLs', async () => {
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
  await assert.rejects(execute(fixture), { code: 'evidence_capture_incomplete' });
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

test('a completed agent turn without tool calls retains the shots tool surface and brief read', async () => {
  const fixture = setup({
    dispatch: async (options) => {
      options.onEvidenceDiagnostic({ kind: 'provider_dispatched', backend: 'claude_code', requestMode: 'agent_new' });
      options.onEvidenceDiagnostic({ kind: 'provider_init', mcpServerCount: 4, toolDefinitionCount: 26,
        briefToolAvailable: true, saveShotToolAvailable: true, skipChangeToolAvailable: true,
        browserMemberToolCount: 7, browserAdminToolCount: 7, browserFullAdminToolCount: 7 });
      options.onEvidenceDiagnostic({ kind: 'provider_tool_config', mcpServerCount: 4,
        toolDefinitionCount: 12, topLevelFunctionToolCount: 8,
        topLevelNamespaceToolCount: 3, topLevelOtherToolCount: 1,
        nestedToolDefinitionCount: 26, nestedFunctionToolCount: 26,
        shotsToolDefinitionCount: 5, forwardedToolDefinitionCount: 12,
        briefToolAvailable: true, saveShotToolAvailable: true, skipChangeToolAvailable: true });
      options.onEvidenceDiagnostic({ kind: 'context_result', outcome: 'ok', responseCharacters: 12000,
        jsonValid: true, declaredChangesPresent: true, addressesPresent: true,
        revisionsPresent: true, storyCount: 3 });
      options.onEvidenceDiagnostic({ kind: 'first_output' });
      options.onEvidenceDiagnostic({ kind: 'provider_result', outcome: 'ok' });
      return { backend: 'claude_code', threadId: 'evidence-thread' };
    },
  });
  await assert.rejects(execute(fixture), { code: 'evidence_capture_incomplete' });
  const trace = fixture.transitions.at(-1).patch.traceSummary;
  assert.deepEqual(trace.control, { savedFiles: 0, skippedChanges: 0, skippedAll: false });
  assert.equal(trace.agentDispatches[0].outcome, 'completed');
  assert.deepEqual(trace.agentActivity.events.map((event) => event.kind),
    ['provider_dispatched', 'provider_init', 'provider_tool_config',
      'context_result', 'first_output', 'provider_result']);
  assert.equal(trace.agentActivity.events[0].requestMode, 'agent_new');
  assert.equal(trace.agentActivity.events[1].briefToolAvailable, true);
  assert.equal(trace.agentActivity.events[1].saveShotToolAvailable, true);
  assert.equal(trace.agentActivity.events[1].browserFullAdminToolCount, 7);
  assert.equal(trace.agentActivity.events[3].responseCharacters, 12000);
  assert.equal(trace.agentActivity.events[3].declaredChangesPresent, true);
  assert.equal(trace.agentActivity.events[3].storyCount, 3);
  assert.equal(trace.agentActivity.providerToolConfigs.length, 1);
  assert.equal(trace.agentActivity.providerToolConfigs[0].shotsToolDefinitionCount, 5);
  assert.equal(trace.agentActivity.providerToolConfigs[0].skipChangeToolAvailable, true);
  assert.equal(trace.agentActivity.providerToolConfigs[0].topLevelNamespaceToolCount, 3);
  assert.deepEqual(trace.agentActivity.toolCounts, {});
});

// The log ring entry this test wrote, never an earlier run's line.
function newLog(before, message) {
  return logger.tail(200).find((entry) => !before.has(entry)
    && entry.message === message && entry.data?.runId === RUN_ID);
}

test('a model exit without shots keeps its redacted final words for the owner and out of the log', async () => {
  logger.setLevel('INFO');
  const before = new Set(logger.tail(200));
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
    { code: 'evidence_capture_incomplete' });
  const trace = fixture.transitions.at(-1).patch.traceSummary;
  const response = trace.agentFinalResponse;
  assert.match(response.excerpt, /could not find the browser/);
  assert.doesNotMatch(response.excerpt, /member\.jwt|base\.internal|secret\.jwt/);
  assert.equal(response.stopReason, 'end_turn');
  assert.equal(response.resultSubtype, 'success');
  assert.equal(response.permissionDenialCount, 0);
  assert.deepEqual(observed, [response]);
  assert.equal(trace.agentFinalResponses.length, 1);
  assert.equal(trace.agentFinalResponses[0].dispatch, 1);

  const logged = newLog(before, 'Before/after run ended without shots');
  assert.ok(logged, 'the failure is logged');
  assert.equal(logged.data.code, 'evidence_capture_incomplete');
  assert.equal(Object.hasOwn(logged.data.trace, 'agentFinalResponse'), false);
  assert.equal(Object.hasOwn(logged.data.trace, 'agentFinalResponses'), false);
  assert.doesNotMatch(JSON.stringify(logged), /could not find the browser/);
});

test('a published run keeps the agent\'s final words in its private trace, not the log', async () => {
  logger.setLevel('INFO');
  const before = new Set(logger.tail(200));
  const fixture = setup({
    dispatch: async (options) => {
      saveStills(controlFor(options), 'invite-suggestions');
      return {
        backend: 'claude_code',
        result: { lastResultText: 'Saved the invite dialog before and after.', exitCode: 0 },
      };
    },
  });
  const result = await execute(fixture);
  assert.equal(result.state, 'verified');
  const trace = fixture.transitions.at(-1).patch.traceSummary;
  assert.equal(trace.agentFinalResponses[0].excerpt, 'Saved the invite dialog before and after.');
  const logged = newLog(before, 'Before/after shots published');
  assert.ok(logged, 'the publication is logged');
  assert.equal(Object.hasOwn(logged.data.trace, 'agentFinalResponses'), false);
  assert.doesNotMatch(JSON.stringify(logged), /Saved the invite dialog/);
});

// ── Heartbeat, terminal metadata and storage fencing ────────────────────

test('background evidence heartbeat records progress and stops when the run ends', async () => {
  const seen = [];
  const writes = [];
  const heartbeatPool = { totalCount: 10, idleCount: 1, waitingCount: 3 };
  const heartbeat = orchestrator.startRunHeartbeat(heartbeatPool, RUN_ID, {
    heartbeatRun: async (_pool, _runId, phase, patch) => { seen.push(phase); writes.push(patch); },
  }, null, 10);
  heartbeat.onProgress({ stage: 'checkout_revisions' });
  heartbeat.onAgentDiagnostic({ version: 1, events: [{ kind: 'tool_start', tool: 'save_shot' }] }, 'tool_start');
  heartbeat.onAgentFinalResponse({ excerpt: 'Preview agent stopped.', characters: 22 });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(seen.includes('checkout_revisions'));
  assert.equal(writes.at(-1).agentActivity.events[0].tool, 'save_shot');
  assert.equal(writes.at(-1).agentFinalResponse.excerpt, 'Preview agent stopped.');
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
    getRun: async () => ({ id: RUN_ID, current_run_id: RUN_ID, state: 'exploring' }),
    transitionRun: async (_pool, _runId, next, patch) => { persisted = { next, patch }; },
  });
  assert.equal(updated, true);
  assert.equal(persisted.next, 'failed');
  assert.equal(persisted.patch.failureCode, 'visual_evidence_failed');
  assert.doesNotMatch(persisted.patch.failureReason, /secret\.jwt|topsecret/);
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

// ── Scheduling and claiming ──────────────────────────────────────────────

// Wires a setup() fixture for scheduleForSession: the session loads from
// the pool, GitHub answers the comparison and the durable run already exists.
function scheduleFixture(fixture, t) {
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
  return { visualEvidence: { execute: true, maxRunMs: 60_000, maxAgentMs: 10_000 } };
}

test('competing schedulers claim a planned run only once before building the pair', async (t) => {
  const fixture = setup();
  const config = scheduleFixture(fixture, t);
  let claimed = false;
  const transitionRun = fixture.dependencies.state.transitionRun;
  fixture.dependencies.state.transitionRun = async (...args) => {
    if (args[2] === 'provisioning') {
      if (claimed) throw Object.assign(new Error('Already claimed'), { code: 'invalid_evidence_transition' });
      claimed = true;
    }
    return transitionRun(...args);
  };
  const options = { pool: fixture.pool, sessionId: 42, headSha: HEAD };
  const results = await Promise.all([
    orchestrator.scheduleForSession(config, options, fixture.dependencies),
    orchestrator.scheduleForSession(config, options, fixture.dependencies),
  ]);
  assert.equal(results.filter((result) => result.scheduled).length, 1);
  assert.equal(results.filter((result) => result.reason === 'already_running').length, 1);
  const result = await results.find((entry) => entry.scheduled).promise;
  assert.equal(result.state, 'verified');
  assert.equal(fixture.calls.dispatches, 1);
  assert.equal(fixture.calls.stored, 1);
  assert.deepEqual(fixture.transitions.map((entry) => entry.next),
    ['provisioning', 'exploring', 'reviewing', 'verified']);
  assert.deepEqual(orchestrator.inFlightSnapshot(), [], 'a settled run leaves the in-flight registry');
});

test('a merged proposal permits a deliberate rerun but no automatic worker revival', async (t) => {
  const fixture = setup();
  fixture.session.status = 'merged';
  fixture.session.source = 'imported';
  const config = scheduleFixture(fixture, t);
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

test('a Stop during the preview turn keeps the Codex fallback from starting a second model', async (t) => {
  const fixture = setup({
    dispatch: async () => {
      fixture.setTurnMode('evidence');
      const stopped = await orchestrator.stopForSession(fixture.pool, 42, fixture.dependencies);
      assert.deepEqual(stopped, { stopped: true, runId: RUN_ID });
      fixture.setTurnMode(null);
      // The killed worker ends the turn before any provider request.
      throw Object.assign(new Error('The preview agent was stopped.'), { code: 'evidence_agent_failed' });
    },
  });
  fixture.session.agent_backend = 'codex_openrouter';
  fixture.session.visual_evidence_run_id = RUN_ID;
  const config = scheduleFixture(fixture, t);
  const scheduled = await orchestrator.scheduleForSession(config,
    { pool: fixture.pool, sessionId: 42, headSha: HEAD }, fixture.dependencies);
  assert.equal(scheduled.scheduled, true);
  await assert.rejects(scheduled.promise, { code: 'evidence_stopped' });
  assert.equal(fixture.calls.dispatches, 1, 'no fallback model is dispatched after a Stop');
  assert.deepEqual(fixture.calls.turnStops, [42]);
  assert.deepEqual(fixture.transitions.map((entry) => entry.next), ['provisioning', 'exploring', 'failed']);
  assert.equal(fixture.transitions.at(-1).patch.failureCode, 'evidence_stopped');
  assert.equal(fixture.calls.cleaned, 1);
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

  // No declared change recorded: there is nothing to shoot.
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

// ── Stop ─────────────────────────────────────────────────────────────────

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

test('Stop fails the running shots as stopped and kills only an evidence turn', async () => {
  const running = stopHarness();
  assert.deepEqual(await orchestrator.stopForSession(running.pool, 42, running.injected), { stopped: true, runId: RUN_ID });
  assert.equal(running.calls.transitions.length, 1);
  assert.equal(running.calls.transitions[0].next, 'failed');
  assert.equal(running.calls.transitions[0].patch.failureCode, 'evidence_stopped');
  assert.equal(running.calls.transitions[0].patch.failureReason, orchestrator.EVIDENCE_STOPPED_REASON);
  assert.deepEqual(running.calls.stops, [42]);

  const saving = stopHarness({ runState: 'reviewing', turnMode: 'build' });
  assert.equal((await orchestrator.stopForSession(saving.pool, 42, saving.injected)).stopped, true);
  assert.deepEqual(saving.calls.stops, [], 'a coding turn on the change is never killed');
});

test('Stop does nothing once the shots settled or were superseded', async () => {
  for (const options of [{ runState: 'verified' }, { runState: 'failed' }, { currentRunId: null }]) {
    const settled = stopHarness(options);
    assert.deepEqual(await orchestrator.stopForSession(settled.pool, 42, settled.injected), { stopped: false, reason: 'not_running' });
    assert.deepEqual(settled.calls.transitions, []);
    assert.deepEqual(settled.calls.stops, []);
  }
});
