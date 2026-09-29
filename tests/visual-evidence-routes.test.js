'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const routes = require('../src/routes/visual-evidence');
const fixtures = require('./fixtures/visual-evidence');
const db = require('../src/db/pool');
const appAccess = require('../src/services/app-access');
const appAdmins = require('../src/services/app-admins');
const github = require('../src/services/github');
const orchestrator = require('../src/services/visual-evidence-orchestrator');
const state = require('../src/services/visual-evidence-state');

// Mounts the evidence routes over a fake pool with the given stubs, the way
// server.js does (JSON bodies parsed first), and restores every stub after.
async function serve(t, { pool, user, config = { visualEvidence: { present: true, execute: true } }, stubs = [] }) {
  const saved = [[db, 'getPool', db.getPool], ...stubs.map(([target, key]) => [target, key, target[key]])];
  db.getPool = () => pool;
  for (const [target, key, value] of stubs) target[key] = value;
  const routePath = require.resolve('../src/routes/visual-evidence');
  delete require.cache[routePath];
  const isolatedRoutes = require('../src/routes/visual-evidence');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: user() }; next(); });
  app.use(isolatedRoutes.visualEvidenceRoutes(config));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    for (const [target, key, value] of saved) target[key] = value;
    delete require.cache[routePath];
  });
  return `http://127.0.0.1:${server.address().port}/api/apps/demo/proposals/42/evidence`;
}

test('retry of a no-impact claim settles as not required without reclassifying files', async (t) => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const runId = '1'.repeat(32);
  const declaration = { version: 1, impact: 'none', rationale: 'Server-only change.', stories: [] };
  const session = {
    id: 42, app_id: 9, user_id: 7, source: 'imported', status: 'merged',
    imported_pr_head_sha: head, visual_evidence_state: 'failed', visual_evidence_run_id: runId,
  };
  const oldRun = {
    id: runId, session_id: 42, base_sha: base, head_sha: head, state: 'failed',
    intent: declaration, current_run_id: runId,
    failure_code: 'evidence_capture_incomplete',
  };
  const inserted = [];
  const sessionUpdates = [];
  const pool = { query: async (sql, params) => {
    const text = String(sql);
    if (text.includes('FROM chat_sessions cs')) return { rows: [session] };
    if (text.includes('FROM visual_evidence_runs r') && text.includes('JOIN chat_sessions s')) {
      return { rows: [oldRun] };
    }
    if (text.includes('UPDATE visual_evidence_runs')) return { rowCount: 1, rows: [] };
    if (text.includes('INSERT INTO visual_evidence_runs')) {
      const row = {
        id: params[0], session_id: params[1], base_sha: params[2], head_sha: params[3],
        intent: JSON.parse(params[5]), state: params[6], trigger: params[7],
      };
      inserted.push(row);
      return { rows: [row] };
    }
    if (text.includes('UPDATE chat_sessions')) {
      sessionUpdates.push({ state: params[1], detail: JSON.parse(params[3]) });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${text.slice(0, 80)}`);
  } };
  const saved = {
    pool: db.getPool, access: appAccess.getAppForUser, compare: github.compareRefs,
    schedule: orchestrator.scheduleForSession,
  };
  db.getPool = () => pool;
  appAccess.getAppForUser = async () => ({ id: 9, slug: 'demo', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' });
  let comparisons = 0;
  github.compareRefs = async () => { comparisons += 1; return { files: [], filesComplete: true }; };
  const scheduled = [];
  orchestrator.scheduleForSession = async (_config, options) => {
    scheduled.push(options.headSha);
    return { scheduled: false, reason: 'not_required' };
  };
  const routePath = require.resolve('../src/routes/visual-evidence');
  delete require.cache[routePath];
  const isolatedRoutes = require('../src/routes/visual-evidence');
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use(isolatedRoutes.visualEvidenceRoutes({ visualEvidence: { execute: true } }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    db.getPool = saved.pool;
    appAccess.getAppForUser = saved.access;
    github.compareRefs = saved.compare;
    orchestrator.scheduleForSession = saved.schedule;
    delete require.cache[routePath];
  });
  const url = `http://127.0.0.1:${server.address().port}/api/apps/demo/proposals/42/evidence/rerun`;
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.visualEvidenceState, 'not_required');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].state, 'not_required', 'a zero-story declaration never becomes a shots run');
  assert.equal(sessionUpdates.at(-1).state, 'not_required');
  assert.equal(sessionUpdates.at(-1).detail.required, false);
  assert.equal(comparisons, 0, 'the declaration is trusted; GitHub is not consulted');
  assert.deepEqual(scheduled, [head]);
});

test('artifact range parsing supports full, open, and suffix ranges and fails closed', () => {
  assert.equal(routes.parseRange(undefined, 100), null);
  assert.deepEqual(routes.parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(routes.parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(routes.parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(routes.parseRange('bytes=95-500', 100), { start: 95, end: 99 });
  for (const value of ['items=0-1', 'bytes=', 'bytes=20-10', 'bytes=100-', 'bytes=1-2,4-5']) {
    assert.equal(routes.parseRange(value, 100), false, value);
  }
});

test('artifact ids and proposal ids are canonical and traversal-proof', () => {
  assert.equal(routes.sessionId('42'), 42);
  assert.equal(routes.sessionId('0'), null);
  assert.equal(routes.sessionId('../42'), null);
  assert.equal(routes.sessionId(String(2 ** 40)), null);
});

test('run diagnostics are private to the author or app manager, available live, and retain retry history', async (t) => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const runId = '1'.repeat(32);
  const session = {
    id: 42, app_id: 9, user_id: 7, source: 'imported',
    imported_pr_head_sha: head, visual_evidence_state: 'failed',
    visual_evidence_run_id: runId,
  };
  const stories = [
    { id: 'invite-suggestions', status: 'ready', files: 2 },
    { id: 'empty-search', status: 'skipped', reason: 'The fixture has no list to search.' },
  ];
  const run = {
    id: runId, base_sha: base, head_sha: head, state: 'failed',
    trigger: 'preview-ready',
    fixture_fingerprint: 'fixture-1', base_image_digest: 'sha256:base',
    head_image_digest: 'sha256:head',
    created_at: new Date('2026-09-01T00:00:00Z'),
    started_at: new Date('2026-09-01T00:01:00Z'),
    completed_at: new Date('2026-09-01T00:02:00Z'),
    updated_at: new Date('2026-09-01T00:02:00Z'),
    plan_hash: 'c'.repeat(64),
    hard_verdict: { passed: true, mode: 'shots', runs: 1, stories },
    // Columns a replay-era row may still hold; none of them is read.
    replay_plan: { secret: 'must not escape' }, author_plan: { secret: 'must not escape' }, repair_attempt: 1,
    failure_code: 'evidence_capture_incomplete', failure_reason: 'The preview agent could not reach the dialog.',
    trace_summary: {
      heartbeat: { processId: 'a'.repeat(16), poolWaiting: 3 },
      idleWait: { version: 1, outcome: 'timeout', waitClass: 'evidence_recovery',
        recoveryReason: 'evidence_turn', normalLimitMs: 120000, recoveryLimitMs: 240000,
        waitedMs: 240000, polls: 481, activeTurnPresent: true,
        activeTurnMode: 'evidence', activeTurnPhase: 'cleanup_pending',
        workerInFlight: false, workerMode: null },
      agentAttempts: 1,
      agentDispatches: [{ requestedBackend: 'codex_openrouter', requestedModel: 'glm-4', backend: 'claude_code', model: 'claude-sonnet', fallbackReason: 'model_without_tools', outcome: 'completed' }],
      agentActivity: { budgetMs: 480000, events: [{ atMs: 1200, kind: 'agent_deadline' }] },
      agentFinalResponse: { excerpt: 'I could not open the dialog.', characters: 28 },
      agentFinalResponses: [{ dispatch: 1, excerpt: 'The first attempt saved nothing.', characters: 32 }],
      tokenUsage: { inputTokens: 123 }, artifactBytes: 345,
      failure: { phase: 'agent', code: 'evidence_capture_incomplete', tool: 'save_shot',
        toolCode: 'unknown_screen', toolMessage: 'Screen "tablet" is not declared.' },
      control: { saved: 2, skipped: ['empty-search'], skippedAll: false },
      // Replay-era trace fields are not passed through.
      replayPasses: [{ pass: 1, durationMs: 20 }], replayRuntime: 'kubernetes',
      replayRetries: [{ attempt: 1, pass: 1, retry: 1, kind: 'navigation_network_failure' }],
      fixtureResets: [{ pass: 1, storyId: 'invite-suggestions', viewport: 'desktop', durationMs: 8 }],
      lastReplayEvent: { pass: 2, type: 'viewport_started' },
      replayEvents: [{ pass: 2, type: 'action_started', actionId: 'open-settings' }],
      repairTrigger: { kind: 'supporting_visibility' }, repairTriggers: [{ kind: 'supporting_visibility' }],
    },
  };
  const pool = { query: async (sql, params) => {
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [session] };
    if (String(sql).includes('FROM visual_evidence_runs')) {
      assert.doesNotMatch(String(sql), /state IN/);
      assert.doesNotMatch(String(sql), /replay_plan|author_plan|repair_attempt/);
      return { rows: params[0] === runId && params[1] === session.id ? [run] : [] };
    }
    if (String(sql).includes('FROM visual_evidence_artifacts')) {
      assert.deepEqual(params, [runId]);
      return { rows: [{
        story_id: 'invite-suggestions', viewport: 'desktop', side: 'head', variant: 'context',
        media: 'png', bytes: 345, width: 640, height: 480, sha256: 'c'.repeat(64),
      }] };
    }
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  let userId = 7;
  const url = `${await serve(t, {
    pool, user: () => userId, config: { visualEvidence: { present: true } },
    stubs: [
      [appAccess, 'getAppForUser', async () => ({ id: 9, slug: 'demo' })],
      [appAdmins, 'canManageApp', async (_pool, app, user) => app.id === 9 && user.id === 8],
    ],
  })}/diagnostics`;
  const ownerResponse = await fetch(url);
  assert.equal(ownerResponse.status, 200);
  assert.match(ownerResponse.headers.get('cache-control'), /no-store/);
  const { diagnostics } = await ownerResponse.json();
  assert.equal(diagnostics.runId, runId);
  assert.equal(diagnostics.currentRun, true);
  assert.equal(diagnostics.planHash, 'c'.repeat(64));
  assert.deepEqual(diagnostics.shotResults, stories);
  for (const key of ['replayPlan', 'authorPlan', 'authorPlanSupplied', 'repairAttempt', 'diagnosticArtifacts']) {
    assert.equal(Object.hasOwn(diagnostics, key), false, key);
  }
  for (const key of ['replayPasses', 'replayRuntime', 'replayRetries', 'fixtureResets', 'lastReplayEvent',
    'replayEvents', 'repairTrigger', 'repairTriggers']) {
    assert.equal(Object.hasOwn(diagnostics.trace, key), false, `trace.${key}`);
  }
  assert.doesNotMatch(JSON.stringify(diagnostics), /must not escape/);
  assert.equal(diagnostics.trace.heartbeat.poolWaiting, 3);
  assert.equal(diagnostics.trace.idleWait.waitClass, 'evidence_recovery');
  assert.equal(diagnostics.trace.idleWait.activeTurnPhase, 'cleanup_pending');
  assert.match(diagnostics.observer.processId, /^[0-9a-f]{16}$/);
  assert.equal(diagnostics.observer.ownsRun, false);
  assert.equal(diagnostics.observer.heartbeatWrite, null);
  assert.equal(diagnostics.trace.agentDispatches[0].backend, 'claude_code');
  assert.equal(diagnostics.trace.agentDispatches[0].fallbackReason, 'model_without_tools');
  assert.equal(diagnostics.trace.agentActivity.events[0].kind, 'agent_deadline');
  assert.equal(diagnostics.trace.agentFinalResponse.excerpt, 'I could not open the dialog.');
  assert.equal(diagnostics.trace.agentFinalResponses[0].excerpt, 'The first attempt saved nothing.');
  assert.equal(diagnostics.trace.tokenUsage.inputTokens, 123);
  assert.deepEqual(diagnostics.trace.failure, run.trace_summary.failure);
  assert.deepEqual(diagnostics.trace.control, { saved: 2, skipped: ['empty-search'], skippedAll: false });
  assert.equal(diagnostics.trigger, 'preview-ready');
  assert.equal(diagnostics.provenance.fixtureFingerprint, 'fixture-1');
  assert.deepEqual(diagnostics.artifacts, [{
    storyId: 'invite-suggestions', viewport: 'desktop', side: 'head', variant: 'context',
    media: 'png', bytes: 345, width: 640, height: 480, sha256: 'c'.repeat(64),
  }]);
  assert.equal(Object.hasOwn(diagnostics.artifacts[0], 'url'), false, 'diagnostics describe files, never serve them');

  userId = 8;
  assert.equal((await fetch(url)).status, 200, 'app manager can diagnose another author’s run');
  run.state = 'exploring';
  assert.equal((await (await fetch(url)).json()).diagnostics.state, 'exploring', 'the private trace is available while a run is active');
  run.state = 'failed';
  userId = 9;
  assert.equal((await fetch(url)).status, 404);
  userId = 8;
  session.imported_pr_head_sha = 'd'.repeat(40);
  session.visual_evidence_run_id = '2'.repeat(32);
  run.state = 'stale';
  assert.equal((await fetch(url)).status, 404);
  const historical = await fetch(`${url}?runId=${runId}`);
  assert.equal(historical.status, 200);
  const historicalDiagnostics = (await historical.json()).diagnostics;
  assert.equal(historicalDiagnostics.headSha, head);
  assert.equal(historicalDiagnostics.state, 'stale');
  assert.equal(historicalDiagnostics.currentRun, false);
  assert.equal((await fetch(`${url}?runId=${'3'.repeat(32)}`)).status, 404);

  run.state = 'verified';
  run.failure_code = null;
  run.failure_reason = null;
  const verified = (await (await fetch(`${url}?runId=${runId}`)).json()).diagnostics;
  assert.equal(verified.state, 'verified');
  assert.equal(verified.failureCode, null);
  assert.equal(verified.trace.agentDispatches[0].backend, 'claude_code');
  assert.equal(verified.trace.agentFinalResponses[0].dispatch, 1);

  // A replay-era verdict has no per-change results.
  run.hard_verdict = { passed: true, runs: 2 };
  assert.deepEqual((await (await fetch(`${url}?runId=${runId}`)).json()).diagnostics.shotResults, []);

  session.visual_evidence_run_id = null;
  session.visual_evidence_state = 'planned';
  session.visual_evidence_detail = { notStartedReason: 'No staging preview was built.' };
  const notStarted = (await (await fetch(url)).json()).diagnostics;
  assert.equal(notStarted.runId, null);
  assert.equal(notStarted.notStartedReason, 'No staging preview was built.');
  assert.equal((await fetch(`${url}?runId=bad`)).status, 404);
});

test('the binary route is authenticated, current-run fenced, exact-head fenced, and private', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/visual-evidence.js'), 'utf8');
  assert.match(src, /loadContext\(pool, req\.params\.slug, id, req\.user, 'view'\)/);
  assert.match(src, /!config\.visualEvidence\?\.present/);
  assert.match(src, /s\.visual_evidence_run_id = r\.id/);
  assert.match(src, /s\.visual_evidence_state = 'verified' AND r\.state = 'verified'/);
  assert.match(src, /r\.head_sha = COALESCE/);
  assert.match(src, /Cache-Control': 'private, max-age=31536000, immutable'/);
  assert.match(src, /Vary: 'Cookie, Authorization'/);
  assert.match(src, /res\.status\(206\)/);
  assert.match(src, /res\.status\(416\)/);
  assert.doesNotMatch(src, /\/visuals\//, 'evidence never uses the public legacy media route');
});

test('the diagnostic image route and the author plan route are gone', async (t) => {
  const head = 'b'.repeat(40);
  const imageId = 'e'.repeat(32);
  const runId = '1'.repeat(32);
  const session = {
    id: 42, app_id: 9, user_id: 7, status: 'active', source: 'imported',
    imported_pr_head_sha: head, visual_evidence_run_id: runId, visual_evidence_state: 'failed',
    visual_evidence_detail: { intent: fixtures.intent() },
  };
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push(String(sql));
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [session] };
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  const scheduled = [];
  const reruns = [];
  let userId = 7;
  const base = await serve(t, {
    pool, user: () => userId,
    stubs: [
      [appAccess, 'getAppForUser', async () => ({ id: 9, slug: 'demo' })],
      [appAdmins, 'canManageApp', async () => true],
      [orchestrator, 'scheduleForSession', async (_config, options) => { scheduled.push(options); return { scheduled: true }; }],
      [state, 'rerunSameHead', async (...args) => { reruns.push(args); return { id: '3'.repeat(32), state: 'planned' }; }],
    ],
  });
  for (const user of [7, 8]) {
    userId = user;
    assert.equal((await fetch(`${base}/diagnostics/${imageId}`)).status, 404, `diagnostic image for user ${user}`);
  }
  userId = 7;
  const plan = await fetch(`${base}/plan`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ headSha: head, plan: { version: 1, stories: [] } }),
  });
  assert.equal(plan.status, 404);
  assert.deepEqual(scheduled, [], 'no submitted plan starts a run');
  assert.deepEqual(reruns, []);
  assert.ok(!queries.some((sql) => /visual_evidence_diagnostic_artifacts/.test(sql)));

  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/visual-evidence.js'), 'utf8');
  assert.doesNotMatch(src, /evidence\/plan'|evidence\/diagnostics\/:artifactId|visual_evidence_diagnostic_artifacts|authorPlan/);
});

test('rerun, stop and override keep their access rules', async (t) => {
  const head = 'b'.repeat(40);
  const runId = '2'.repeat(32);
  const session = {
    id: 42, app_id: 9, user_id: 7, status: 'active', source: 'imported',
    imported_pr_head_sha: head, visual_evidence_run_id: runId, visual_evidence_state: 'failed',
    visual_evidence_detail: { intent: fixtures.intent() },
  };
  const pool = { query: async (sql) => {
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [{ ...session }] };
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  const reruns = [];
  const scheduled = [];
  const stops = [];
  const overrides = [];
  let userId = 7;
  const base = await serve(t, {
    pool, user: () => userId,
    stubs: [
      [appAccess, 'getAppForUser', async () => ({ id: 9, slug: 'demo' })],
      // User 8 manages the app; user 9 is only a collaborator.
      [appAdmins, 'canManageApp', async (_pool, app, user) => app.id === 9 && user.id === 8],
      [state, 'rerunSameHead', async (_pool, id, options) => {
        reruns.push({ id, options });
        return { id: '3'.repeat(32), head_sha: head, state: 'planned' };
      }],
      [state, 'overrideRun', async (_pool, id, options) => {
        overrides.push({ id, options });
        return { id, state: 'overridden' };
      }],
      [orchestrator, 'scheduleForSession', async (_config, options) => { scheduled.push(options); return { scheduled: true }; }],
      [orchestrator, 'stopForSession', async (_pool, id) => { stops.push(id); return { stopped: true, runId }; }],
    ],
  });
  const post = async (route, body = {}) => {
    const res = await fetch(`${base}/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  // The author takes the shots again for the same head.
  const rerun = await post('rerun');
  assert.equal(rerun.status, 202);
  assert.deepEqual(rerun.body, { ok: true, runId: '3'.repeat(32), visualEvidenceState: 'planned' });
  assert.deepEqual(reruns, [{ id: runId, options: { trigger: 'manual-rerun', intent: null } }]);
  assert.deepEqual(scheduled.map(({ sessionId, headSha, trigger }) => ({ sessionId, headSha, trigger })),
    [{ sessionId: 42, headSha: head, trigger: 'manual-rerun' }]);

  // A replacement declaration is validated before anything is written.
  const invalid = fixtures.intent();
  invalid.stories[0].intent.startPath = 'https://evil.example/';
  const refused = await post('rerun', { visualEvidence: invalid });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'invalid_visual_evidence');
  assert.equal(reruns.length, 1);
  const replaced = await post('rerun', { visualEvidence: fixtures.motionIntent() });
  assert.equal(replaced.status, 202);
  assert.equal(reruns[1].options.intent.impact, 'motion');

  // The author and an app manager can stop a running set.
  assert.deepEqual((await post('stop')).body, { stopped: true, runId });
  userId = 8;
  assert.equal((await post('stop')).status, 200);
  assert.deepEqual(stops, [42, 42]);

  // Only an app manager can waive the shots, and with the reason given.
  userId = 7;
  assert.equal((await post('override', { reason: 'Copy-only change.' })).status, 404, 'the author cannot waive their own shots');
  userId = 8;
  const waived = await post('override', { reason: 'Copy-only change.' });
  assert.deepEqual(waived.body, { ok: true, runId, visualEvidenceState: 'overridden' });
  assert.deepEqual(overrides, [{ id: runId, options: { userId: 8, reason: 'Copy-only change.' } }]);

  // Anyone else sees no proposal at all.
  userId = 9;
  for (const route of ['rerun', 'stop', 'override']) {
    assert.equal((await post(route, { reason: 'x' })).status, 404, route);
  }
  assert.equal(reruns.length, 2);
  assert.equal(stops.length, 2);
  assert.equal(overrides.length, 1);

  // With no current run there is nothing to waive.
  userId = 8;
  session.visual_evidence_run_id = null;
  const missing = await post('override', { reason: 'Copy-only change.' });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.error, 'visual_evidence_run_missing');
});
