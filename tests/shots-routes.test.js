'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const routes = require('../src/routes/shots');
const media = require('../src/services/media-store');
const fixtures = require('./fixtures/shots');
const db = require('../src/db/pool');
const appAccess = require('../src/services/app-access');
const appAdmins = require('../src/services/app-admins');
const state = require('../src/services/shots-state');

test('keyed shots stream ranges with the same headers, and refuse access before reading storage', async (t) => {
  const media = require('../src/services/media-store');
  const store = require('./lib/media-store').useMemoryMedia(t);
  const clip = fixtures.webm();
  const key = media.objectKey(clip);
  await store.putObject(key, clip, 'video/webm');
  let allowed = true;
  const pool = { query: async (sql) => {
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [{ id: 42, app_id: 9 }] };
    if (String(sql).includes('FROM shot_artifacts a')) return { rows: [{ data: null, object_key: key,
      sha256: key.slice(media.PREFIX.length), bytes: clip.length, content_type: 'video/webm', variant: 'animation' }] };
    throw new Error('Unexpected query');
  } };
  const url = `${await serve(t, { pool, user: () => 7,
    stubs: [[appAccess, 'getAppForUser', async () => allowed ? { id: 9, slug: 'demo' } : null]],
  })}/${'1'.repeat(32)}`;
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('etag'), `"${key.slice(media.PREFIX.length)}"`);
  assert.equal(full.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(full.headers.get('vary'), 'Cookie, Authorization');
  assert.equal(full.headers.get('content-length'), String(clip.length));
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), clip);
  const part = await fetch(url, { headers: { range: 'bytes=10-29' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-29/${clip.length}`);
  assert.equal(part.headers.get('content-length'), '20');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), clip.subarray(10, 30));
  assert.deepEqual(store.calls.filter((c) => c.op === 'get').map((c) => c.range), [null, { start: 10, end: 29 }]);
  assert.equal((await fetch(url, { headers: { range: 'bytes=9999-' } })).status, 416);
  allowed = false;
  assert.equal((await fetch(url)).status, 404);
  assert.equal(store.calls.filter((c) => c.op === 'get').length, 2, 'neither invalid ranges nor denied requests touch storage');
});

test('a missing keyed object fails instead of serving old bytes or caching an error as immutable', async (t) => {
  const media = require('../src/services/media-store');
  require('./lib/media-store').useMemoryMedia(t);
  const pool = { query: async (sql) => ({ rows: String(sql).includes('FROM chat_sessions cs') ? [{ id: 42, app_id: 9 }]
    : [{ data: Buffer.from('old bytes'), object_key: media.objectKey(Buffer.from('absent')), bytes: 6,
      sha256: 'a'.repeat(64), content_type: 'image/png' }] }) };
  const url = `${await serve(t, { pool, user: () => 7,
    stubs: [[appAccess, 'getAppForUser', async () => ({ id: 9, slug: 'demo' })]],
  })}/${'1'.repeat(32)}`;
  const res = await fetch(url);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('cache-control'), null);
  assert.notEqual(res.headers.get('etag'), `"${'a'.repeat(64)}"`);
  assert.deepEqual(await res.json(), { error: 'Internal server error' });
});

// Mounts the shots routes over a fake pool with the given stubs, the way
// server.js does (JSON bodies parsed first), and restores every stub after.
async function serve(t, { pool, user, config = { shots: { present: true, execute: true } }, stubs = [] }) {
  const saved = [[db, 'getPool', db.getPool], ...stubs.map(([target, key]) => [target, key, target[key]])];
  db.getPool = () => pool;
  for (const [target, key, value] of stubs) target[key] = value;
  const routePath = require.resolve('../src/routes/shots');
  delete require.cache[routePath];
  const isolatedRoutes = require('../src/routes/shots');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: user() }; next(); });
  app.use(isolatedRoutes.shotsRoutes(config));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    for (const [target, key, value] of saved) target[key] = value;
    delete require.cache[routePath];
  });
  return `http://127.0.0.1:${server.address().port}/api/apps/demo/proposals/42/shots`;
}

test('a retry hands the shots machine the declaration it was given, validated, and answers its outcome', async (t) => {
  // What a retry of a no-impact declaration settles as is the machine's
  // (tests/workflow-shots-postgres.test.js S18); the route validates and asks.
  const session = {
    id: 42, app_id: 9, user_id: 7, source: 'imported', status: 'merged',
    imported_pr_head_sha: 'b'.repeat(40), shots_state: 'failed', shots_run_id: '1'.repeat(32),
    shots_detail: { intent: { version: 1, impact: 'none', rationale: 'Server-only change.', stories: [] } },
  };
  const pool = { query: async (sql) => {
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [session] };
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  const asked = [];
  const url = await serve(t, {
    pool, user: () => 7,
    stubs: [
      [appAccess, 'getAppForUser', async () => ({ id: 9, slug: 'demo' })],
      [state, 'retryShots', async (r) => { asked.push(r); return { status: 'accepted', reply: { state: 'not_required', runId: null } }; }],
    ],
  });
  const response = await fetch(`${url}/rerun`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, runId: null, shotsState: 'not_required' });
  assert.deepEqual(asked, [{ sessionId: 42, appId: 9, intent: null, actor: 'user:7' }]);
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
    imported_pr_head_sha: head, shots_state: 'failed',
    shots_run_id: runId,
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
    hard_verdict: { passed: true, mode: 'shots', runs: 1, stories, notices: [
      { text: 'The sort control overlaps a heading.', change: 'invite-suggestions', screen: 'desktop', shot: null, alsoBefore: 'unknown' },
    ] },
    // Columns a replay-era row may still hold; none of them is read.
    replay_plan: { secret: 'must not escape' }, author_plan: { secret: 'must not escape' }, repair_attempt: 1,
    failure_code: 'shots_capture_incomplete', failure_reason: 'The shots agent could not reach the dialog.',
    trace_summary: {
      heartbeat: { processId: 'a'.repeat(16), poolWaiting: 3 },
      idleWait: { version: 1, outcome: 'timeout', waitClass: 'shots_recovery',
        recoveryReason: 'shots_turn', normalLimitMs: 120000, recoveryLimitMs: 240000,
        waitedMs: 240000, polls: 481, activeTurnPresent: true,
        activeTurnMode: 'shots', activeTurnPhase: 'cleanup_pending',
        workerInFlight: false, workerMode: null },
      agentAttempts: 1,
      agentDispatches: [{ requestedBackend: 'codex_openrouter', requestedModel: 'glm-4', backend: 'claude_code', model: 'claude-sonnet', fallbackReason: 'model_without_tools', outcome: 'completed' }],
      agentActivity: { budgetMs: 480000, events: [{ atMs: 1200, kind: 'agent_deadline' }] },
      agentFinalResponse: { excerpt: 'I could not open the dialog.', characters: 28 },
      agentFinalResponses: [{ dispatch: 1, excerpt: 'The first attempt saved nothing.', characters: 32 }],
      tokenUsage: { inputTokens: 123 }, artifactBytes: 345,
      failure: { phase: 'agent', code: 'shots_capture_incomplete', tool: 'save_shot',
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
    if (String(sql).includes('FROM shot_runs')) {
      assert.doesNotMatch(String(sql), /state IN/);
      assert.doesNotMatch(String(sql), /replay_plan|author_plan|repair_attempt/);
      return { rows: params[0] === runId && params[1] === session.id ? [run] : [] };
    }
    if (String(sql).includes('FROM shot_artifacts')) {
      assert.deepEqual(params, [runId]);
      return { rows: [{
        story_id: 'invite-suggestions', viewport: 'desktop', side: 'head', variant: 'context',
        media: 'png', bytes: 345, width: 640, height: 480, sha256: 'c'.repeat(64),
      }] };
    }
    // What the agent is doing now, from the run's workspace.
    if (String(sql).includes('FROM shot_run_control')) {
      return { rows: params[0] === runId ? [{ progress: { agentActivity: { events: [{ kind: 'tool_start' }] } } }] : [] };
    }
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  let userId = 7;
  const url = `${await serve(t, {
    pool, user: () => userId, config: { shots: { present: true } },
    stubs: [
      [appAccess, 'getAppForUser', async () => ({ id: 9, slug: 'demo' })],
      [appAdmins, 'canManageApp', async (_pool, app, user) => app.id === 9 && user.id === 8],
    ],
  })}/diagnostics`;
  const ownerResponse = await fetch(url);
  assert.equal(ownerResponse.status, 200);
  assert.match(ownerResponse.headers.get('cache-control'), /no-store/);
  // A tab still running the previous shell asks under the old name.
  const legacy = await fetch(url.replace('/shots/diagnostics', '/evidence/diagnostics'));
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).diagnostics.runId, runId);
  const { diagnostics } = await ownerResponse.json();
  assert.equal(diagnostics.runId, runId);
  assert.equal(diagnostics.currentRun, true);
  assert.equal(diagnostics.planHash, 'c'.repeat(64));
  assert.deepEqual(diagnostics.shotResults, stories);
  assert.deepEqual(diagnostics.shotNotices, run.hard_verdict.notices, 'what the agent noticed, as stored');
  for (const key of ['replayPlan', 'authorPlan', 'authorPlanSupplied', 'repairAttempt', 'diagnosticArtifacts']) {
    assert.equal(Object.hasOwn(diagnostics, key), false, key);
  }
  for (const key of ['replayPasses', 'replayRuntime', 'replayRetries', 'fixtureResets', 'lastReplayEvent',
    'replayEvents', 'repairTrigger', 'repairTriggers']) {
    assert.equal(Object.hasOwn(diagnostics.trace, key), false, `trace.${key}`);
  }
  assert.doesNotMatch(JSON.stringify(diagnostics), /must not escape/);
  assert.equal(diagnostics.trace.heartbeat.poolWaiting, 3);
  assert.equal(diagnostics.trace.idleWait.waitClass, 'shots_recovery');
  assert.equal(diagnostics.trace.idleWait.activeTurnPhase, 'cleanup_pending');
  assert.equal(Object.hasOwn(diagnostics, 'observer'), false, 'no process owns a run any more');
  assert.equal(diagnostics.agentProgress.agentActivity.events[0].kind, 'tool_start', 'read from the run\'s workspace, in any process');
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
  session.shots_run_id = '2'.repeat(32);
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

  session.shots_run_id = null;
  session.shots_state = 'planned';
  session.shots_detail = { notStartedReason: 'No staging preview was built.' };
  const notStarted = (await (await fetch(url)).json()).diagnostics;
  assert.equal(notStarted.runId, null);
  assert.equal(notStarted.notStartedReason, 'No staging preview was built.');
  assert.equal((await fetch(`${url}?runId=bad`)).status, 404);
});

test('the binary route is authenticated, current-run fenced, exact-head fenced, and private', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/shots.js'), 'utf8');
  assert.match(src, /loadContext\(pool, req\.params\.slug, id, req\.user, 'view'\)/);
  assert.match(src, /!config\.shots\?\.present/);
  assert.match(src, /s\.shots_run_id = r\.id/);
  assert.match(src, /s\.shots_state = 'verified' AND r\.state = 'verified'/);
  assert.match(src, /r\.head_sha = COALESCE/);
  assert.match(src, /Cache-Control': 'private, max-age=31536000, immutable'/);
  assert.match(src, /Vary: 'Cookie, Authorization'/);
  assert.match(src, /res\.status\(206\)/);
  assert.match(src, /res\.status\(416\)/);
  assert.doesNotMatch(src, /\/visuals\//, 'shots never uses the public legacy media route');
});

test('the diagnostic image route and the author plan route are gone', async (t) => {
  const head = 'b'.repeat(40);
  const imageId = 'e'.repeat(32);
  const runId = '1'.repeat(32);
  const session = {
    id: 42, app_id: 9, user_id: 7, status: 'active', source: 'imported',
    imported_pr_head_sha: head, shots_run_id: runId, shots_state: 'failed',
    shots_detail: { intent: fixtures.intent() },
  };
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push(String(sql));
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [session] };
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  const reruns = [];
  let userId = 7;
  const base = await serve(t, {
    pool, user: () => userId,
    stubs: [
      [appAccess, 'getAppForUser', async () => ({ id: 9, slug: 'demo' })],
      [appAdmins, 'canManageApp', async () => true],
      [state, 'retryShots', async (...args) => { reruns.push(args); return { status: 'accepted', reply: {} }; }],
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
  assert.deepEqual(reruns, [], 'no submitted plan starts a run');
  assert.ok(!queries.some((sql) => /shot_diagnostic_artifacts/.test(sql)));

  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/shots.js'), 'utf8');
  assert.doesNotMatch(src, /shots\/plan'|shots\/diagnostics\/:artifactId|shot_diagnostic_artifacts|authorPlan/);
});

test('rerun, stop and override keep their access rules', async (t) => {
  const head = 'b'.repeat(40);
  const runId = '2'.repeat(32);
  const session = {
    id: 42, app_id: 9, user_id: 7, status: 'active', source: 'imported',
    imported_pr_head_sha: head, shots_run_id: runId, shots_state: 'failed',
    shots_detail: { intent: fixtures.intent() },
  };
  const pool = { query: async (sql) => {
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [{ ...session }] };
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  const reruns = [];
  const stops = [];
  const overrides = [];
  let userId = 7;
  const base = await serve(t, {
    pool, user: () => userId,
    stubs: [
      [appAccess, 'getAppForUser', async () => ({ id: 9, slug: 'demo' })],
      // User 8 manages the app; user 9 is only a collaborator.
      [appAdmins, 'canManageApp', async (_pool, app, user) => app.id === 9 && user.id === 8],
      [state, 'retryShots', async (r) => {
        reruns.push(r);
        return { status: 'accepted', reply: { runId: '3'.repeat(32), state: 'provisioning' } };
      }],
      [state, 'waiveShots', async (r) => {
        overrides.push(r);
        return { status: 'accepted', reply: { runId, state: 'overridden' } };
      }],
      [state, 'stopShots', async (r) => { stops.push(r.sessionId); return { status: 'accepted', reply: { runId } }; }],
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
  assert.deepEqual(rerun.body, { ok: true, runId: '3'.repeat(32), shotsState: 'provisioning' });
  assert.deepEqual(reruns, [{ sessionId: 42, appId: 9, intent: null, actor: 'user:7' }]);

  // A replacement declaration is validated before anything is written.
  const invalid = fixtures.intent();
  invalid.stories[0].intent.startPath = 'https://evil.example/';
  const refused = await post('rerun', { visibleChanges: invalid });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'invalid_visible_changes');
  assert.equal(reruns.length, 1);
  // The name the declaration had before the rename is still read.
  const replaced = await post('rerun', { visualEvidence: fixtures.motionIntent() });
  assert.equal(replaced.status, 202);
  assert.equal(reruns[1].intent.impact, 'motion');

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
  assert.deepEqual(waived.body, { ok: true, runId, shotsState: 'overridden' });
  assert.deepEqual(overrides, [{ sessionId: 42, appId: 9, userId: 8, reason: 'Copy-only change.' }]);

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
  session.shots_run_id = null;
  const missing = await post('override', { reason: 'Copy-only change.' });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.error, 'shots_run_missing');
});

test('a dense still is served only at its own address, and only to an account in the experiment', async (t) => {
  const session = { id: 42, app_id: 9, user_id: 7, source: 'imported', imported_pr_head_sha: 'b'.repeat(40), shots_state: 'verified' };
  const FLAT = Buffer.from('flat-png');
  const DENSE = Buffer.from('dense-png-at-2x');
  const store = require('./lib/media-store').useMemoryMedia(t);
  await store.putObject(media.objectKey(FLAT), FLAT, 'image/png');
  await store.putObject(media.objectKey(DENSE), DENSE, 'image/png');
  const asked = [];
  const pool = { query: async (sql, params) => {
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [session] };
    if (String(sql).includes('review_flow_enabled')) return { rows: [{ review_flow_enabled: params[0] === 7 }] };
    if (String(sql).includes('FROM shot_artifacts a')) {
      asked.push(params[3]);
      // The query's CASE: the original only when asked for, the 1x copy otherwise.
      return { rows: [{ object_key: media.objectKey(params[3] ? DENSE : FLAT), sha256: (params[3] ? 'd' : 'f').repeat(64), content_type: 'image/png', bytes: (params[3] ? DENSE : FLAT).length }] };
    }
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  let userId = 7;
  const url = `${await serve(t, {
    pool, user: () => userId, config: { shots: { present: true } },
    stubs: [[appAccess, 'getAppForUser', async () => ({ id: 9, slug: 'demo' })]],
  })}/${'1'.repeat(32)}`;
  const body = async (address) => {
    const res = await fetch(address);
    assert.equal(res.status, 200);
    return [Buffer.from(await res.arrayBuffer()).toString(), res.headers.get('etag')];
  };
  // In the experiment: its own address serves the original; the plain one the 1x copy.
  assert.deepEqual(await body(`${url}?density=device`), ['dense-png-at-2x', `"${'d'.repeat(64)}"`]);
  assert.deepEqual(await body(url), ['flat-png', `"${'f'.repeat(64)}"`]);
  // Anyone else asking for the dense address gets the 1x copy.
  userId = 8;
  assert.deepEqual(await body(`${url}?density=device`), ['flat-png', `"${'f'.repeat(64)}"`]);
  assert.deepEqual(asked, [true, false, false]);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/shots.js'), 'utf8');
  assert.match(src, /CASE WHEN \$4 THEN COALESCE\(a\.dense_object_key, a\.object_key\) ELSE a\.object_key END AS object_key/);
});

test('a close-up is served only to an account in the experiment, at its own address', async (t) => {
  const session = { id: 42, app_id: 9, user_id: 7, source: 'imported', imported_pr_head_sha: 'b'.repeat(40), shots_state: 'verified' };
  const store = require('./lib/media-store').useMemoryMedia(t);
  const data = Buffer.from('closeup-png');
  await store.putObject(media.objectKey(data), data, 'image/png');
  const pool = { query: async (sql, params) => {
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [session] };
    if (String(sql).includes('review_flow_enabled')) return { rows: [{ review_flow_enabled: params[0] === 7 }] };
    if (String(sql).includes('FROM shot_artifacts a')) {
      return { rows: [{ object_key: media.objectKey(data), sha256: 'e'.repeat(64), content_type: 'image/png', bytes: 11, variant: 'closeup' }] };
    }
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  let userId = 7;
  const url = `${await serve(t, {
    pool, user: () => userId, config: { shots: { present: true } },
    stubs: [[appAccess, 'getAppForUser', async () => ({ id: 9, slug: 'demo' })]],
  })}/${'1'.repeat(32)}`;
  const ok = await fetch(`${url}?density=device`);
  assert.equal(ok.status, 200);
  assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'closeup-png');
  assert.equal((await fetch(url)).status, 404, 'not at the plain address');
  userId = 8;
  assert.equal((await fetch(`${url}?density=device`)).status, 404, 'not to anyone else');
});
