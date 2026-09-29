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
const planContract = require('../src/services/visual-evidence-plan');

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
    intent: declaration, author_plan: null, current_run_id: runId,
    failure_code: 'missing_evidence_replay', repair_attempt: 0,
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
        intent: JSON.parse(params[5]), author_plan: null, state: params[6], trigger: params[7],
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
  assert.equal(inserted[0].state, 'not_required', 'a zero-story declaration never becomes a planner run');
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
  const run = {
    id: runId, base_sha: base, head_sha: head, state: 'failed',
    trigger: 'preview-ready', author_plan_supplied: false,
    fixture_fingerprint: 'fixture-1', base_image_digest: 'sha256:base',
    head_image_digest: 'sha256:head', repair_attempt: 1,
    created_at: new Date('2026-09-01T00:00:00Z'),
    started_at: new Date('2026-09-01T00:01:00Z'),
    completed_at: new Date('2026-09-01T00:02:00Z'),
    updated_at: new Date('2026-09-01T00:02:00Z'),
    replay_plan: fixtures.plan(), plan_hash: planContract.planHash(fixtures.plan()),
    failure_code: 'assertion_failed', failure_reason: 'Sort was not visible.',
    trace_summary: {
      heartbeat: { processId: 'a'.repeat(16), poolWaiting: 3 },
      idleWait: { version: 1, outcome: 'timeout', waitClass: 'evidence_recovery',
        recoveryReason: 'evidence_turn', normalLimitMs: 120000, recoveryLimitMs: 240000,
        waitedMs: 240000, polls: 481, activeTurnPresent: true,
        activeTurnMode: 'evidence', activeTurnPhase: 'cleanup_pending',
        workerInFlight: false, workerMode: null },
      replayPasses: [{ pass: 1, durationMs: 20 }], replayRuntime: 'kubernetes', agentAttempts: 1,
      replayRetries: [{ attempt: 1, pass: 1, retry: 1, kind: 'navigation_network_failure' }],
      fixtureResets: [{ pass: 1, storyId: 'invite-suggestions', viewport: 'desktop', durationMs: 8 }],
      agentDispatches: [{ requestedBackend: 'codex_openrouter', requestedModel: 'glm-4', backend: 'claude_code', model: 'claude-sonnet', fallbackReason: 'model_without_tools', outcome: 'completed' }],
      agentActivity: { budgetMs: 240000, events: [{ atMs: 1200, kind: 'agent_deadline' }] },
      agentFinalResponse: { excerpt: 'The model stopped after context.', characters: 32 },
      agentFinalResponses: [{ dispatch: 1, excerpt: 'The first plan failed.', characters: 22 }],
      lastReplayEvent: { pass: 2, type: 'viewport_started', storyId: 'invite-suggestions', viewport: 'desktop' },
      replayEvents: [{ pass: 2, type: 'action_started', actionId: 'open-settings', side: 'head' }],
      repairCount: 1,
      repairTrigger: { kind: 'supporting_visibility', code: 'assertion_failed', side: 'base', assertionIndex: 1 },
      repairTriggers: [{ kind: 'supporting_visibility', code: 'assertion_failed', side: 'base', assertionIndex: 1 }],
      planSource: 'hosted_planner', tokenUsage: { inputTokens: 123 }, artifactBytes: 345,
      failure: { phase: 'pass_2', code: 'assertion_failed', detail: { side: 'head', phase: 'assertion' } },
      control: { planCalls: 1, finishStatus: 'failed', finishReason: 'The checkpoint did not render.' },
    },
  };
  const pool = { query: async (sql, params) => {
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [session] };
    if (String(sql).includes('FROM visual_evidence_runs')) {
      assert.doesNotMatch(String(sql), /state IN/);
      return { rows: params[0] === runId && params[1] === session.id ? [run] : [] };
    }
    if (String(sql).includes('FROM visual_evidence_artifacts')) {
      assert.deepEqual(params, [runId]);
      return { rows: [{
        story_id: 'invite-suggestions', viewport: 'desktop', side: 'head', variant: 'focus',
        media: 'png', bytes: 345, width: 640, height: 480, sha256: 'c'.repeat(64),
      }] };
    }
    if (String(sql).includes('FROM visual_evidence_diagnostic_artifacts')) {
      assert.deepEqual(params, [runId]);
      return { rows: [{
        id: 'e'.repeat(32), attempt: 1, pass: 1,
        story_id: 'invite-suggestions', viewport: 'desktop', side: 'head', variant: 'context',
        bytes: 123, width: 640, height: 480, sha256: 'f'.repeat(64),
      }] };
    }
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  const savedPool = db.getPool;
  const savedAccess = appAccess.getAppForUser;
  const savedManage = appAdmins.canManageApp;
  db.getPool = () => pool;
  appAccess.getAppForUser = async () => ({ id: 9, slug: 'demo' });
  appAdmins.canManageApp = async (_pool, app, user) => app.id === 9 && user.id === 8;
  const routePath = require.resolve('../src/routes/visual-evidence');
  delete require.cache[routePath];
  const isolatedRoutes = require('../src/routes/visual-evidence');
  let userId = 7;
  const app = express();
  app.use((req, _res, next) => { req.user = { id: userId }; next(); });
  app.use(isolatedRoutes.visualEvidenceRoutes({ visualEvidence: { present: true } }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    db.getPool = savedPool;
    appAccess.getAppForUser = savedAccess;
    appAdmins.canManageApp = savedManage;
    delete require.cache[routePath];
  });
  const url = `http://127.0.0.1:${server.address().port}/api/apps/demo/proposals/42/evidence/diagnostics`;
  const ownerResponse = await fetch(url);
  assert.equal(ownerResponse.status, 200);
  assert.match(ownerResponse.headers.get('cache-control'), /no-store/);
  const { diagnostics } = await ownerResponse.json();
  assert.equal(diagnostics.runId, runId);
  assert.equal(diagnostics.currentRun, true);
  assert.equal(diagnostics.replayPlan.stories[0].id, fixtures.plan().stories[0].id);
  assert.deepEqual(diagnostics.trace.replayPasses, [{ pass: 1, durationMs: 20 }]);
  assert.equal(diagnostics.trace.replayRetries[0].kind, 'navigation_network_failure');
  assert.equal(diagnostics.trace.fixtureResets[0].durationMs, 8);
  assert.equal(diagnostics.trace.heartbeat.poolWaiting, 3);
  assert.equal(diagnostics.trace.idleWait.waitClass, 'evidence_recovery');
  assert.equal(diagnostics.trace.idleWait.activeTurnPhase, 'cleanup_pending');
  assert.match(diagnostics.observer.processId, /^[0-9a-f]{16}$/);
  assert.equal(diagnostics.observer.ownsRun, false);
  assert.equal(diagnostics.observer.heartbeatWrite, null);
  assert.equal(diagnostics.trace.agentDispatches[0].backend, 'claude_code');
  assert.equal(diagnostics.trace.agentDispatches[0].fallbackReason, 'model_without_tools');
  assert.equal(diagnostics.trace.agentActivity.events[0].kind, 'agent_deadline');
  assert.equal(diagnostics.trace.agentFinalResponse.excerpt, 'The model stopped after context.');
  assert.equal(diagnostics.trace.agentFinalResponses[0].excerpt, 'The first plan failed.');
  assert.deepEqual(diagnostics.trace.repairTrigger,
    { kind: 'supporting_visibility', code: 'assertion_failed', side: 'base', assertionIndex: 1 });
  assert.deepEqual(diagnostics.trace.repairTriggers, [
    { kind: 'supporting_visibility', code: 'assertion_failed', side: 'base', assertionIndex: 1 },
  ]);
  assert.equal(diagnostics.trace.lastReplayEvent.pass, 2);
  assert.equal(diagnostics.trace.replayEvents[0].actionId, 'open-settings');
  assert.equal(diagnostics.trace.replayRuntime, 'kubernetes');
  assert.equal(diagnostics.trace.planSource, 'hosted_planner');
  assert.equal(diagnostics.trace.tokenUsage.inputTokens, 123);
  assert.equal(diagnostics.trigger, 'preview-ready');
  assert.equal(diagnostics.repairAttempt, 1);
  assert.equal(diagnostics.provenance.fixtureFingerprint, 'fixture-1');
  assert.equal(diagnostics.artifacts[0].bytes, 345);
  assert.equal(diagnostics.diagnosticArtifacts[0].pass, 1);
  assert.equal(diagnostics.diagnosticArtifacts[0].url,
    `/api/apps/demo/proposals/42/evidence/diagnostics/${'e'.repeat(32)}`);
  assert.equal(diagnostics.trace.failure.detail.side, 'head');
  assert.equal(diagnostics.trace.control.planCalls, 1);

  userId = 8;
  assert.equal((await fetch(url)).status, 200, 'app manager can diagnose another author’s run');
  run.state = 'replaying';
  assert.equal((await (await fetch(url)).json()).diagnostics.state, 'replaying', 'the private trace is available while a run is active');
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
  assert.equal((await fetch(`${url}?runId=${'3'.repeat(32)}`)).status, 404);

  run.state = 'verified';
  run.failure_code = null;
  run.failure_reason = null;
  const verified = (await (await fetch(`${url}?runId=${runId}`)).json()).diagnostics;
  assert.equal(verified.state, 'verified');
  assert.equal(verified.failureCode, null);
  assert.equal(verified.trace.agentDispatches[0].backend, 'claude_code');
  assert.equal(verified.trace.repairTrigger.kind, 'supporting_visibility');
  assert.equal(verified.trace.agentFinalResponses[0].dispatch, 1);
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

test('failed comparison PNGs are available only to the author or app manager', async (t) => {
  const imageId = 'e'.repeat(32);
  const runId = '1'.repeat(32);
  const data = Buffer.from('private diagnostic png');
  const session = { id: 42, app_id: 9, user_id: 7, visual_evidence_run_id: runId,
    visual_evidence_state: 'failed' };
  const pool = { query: async (sql, params) => {
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [session] };
    if (String(sql).includes('FROM visual_evidence_diagnostic_artifacts a')) {
      assert.deepEqual(params, [imageId, 42]);
      return { rows: [{ data, bytes: data.length, sha256: 'f'.repeat(64) }] };
    }
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  const savedPool = db.getPool;
  const savedAccess = appAccess.getAppForUser;
  const savedManage = appAdmins.canManageApp;
  db.getPool = () => pool;
  appAccess.getAppForUser = async () => ({ id: 9, slug: 'demo' });
  appAdmins.canManageApp = async (_pool, app, user) => app.id === 9 && user.id === 8;
  const routePath = require.resolve('../src/routes/visual-evidence');
  delete require.cache[routePath];
  const app = express();
  let userId = 7;
  app.use((req, _res, next) => { req.user = { id: userId }; next(); });
  app.use(require('../src/routes/visual-evidence').visualEvidenceRoutes({ visualEvidence: { present: true } }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close(); db.getPool = savedPool; appAccess.getAppForUser = savedAccess;
    appAdmins.canManageApp = savedManage; delete require.cache[routePath];
  });
  const url = `http://127.0.0.1:${server.address().port}/api/apps/demo/proposals/42/evidence/diagnostics/${imageId}`;
  const owner = await fetch(url);
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get('content-type'), 'image/png');
  assert.match(owner.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await owner.arrayBuffer()), data);
  userId = 8;
  assert.equal((await fetch(url)).status, 200);
  userId = 9;
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(`${url}bad`)).status, 404);
});

for (const status of ['active', 'paused', 'promoted']) {
  test(`${status}: only the change author can submit a matching plan for the current revision`, async (t) => {
    const head = 'b'.repeat(40);
    const session = {
      id: 42, user_id: 7, app_id: 9, status, source: 'imported',
      imported_pr_head_sha: head, visual_evidence_state: 'planned',
      visual_evidence_run_id: null, visual_evidence_detail: { intent: fixtures.intent() },
    };
    const pool = { query: async () => ({ rows: [{ ...session }] }) };
    const savedPool = db.getPool;
    const savedAccess = appAccess.getAppForUser;
    const savedSchedule = orchestrator.scheduleForSession;
    const savedRerun = state.rerunSameHead;
    db.getPool = () => pool;
    appAccess.getAppForUser = async () => ({ id: 9, slug: 'demo' });
    const scheduled = [];
    orchestrator.scheduleForSession = async (_config, options) => {
      scheduled.push(options);
      return { scheduled: true, runId: '1'.repeat(32) };
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
      db.getPool = savedPool;
      appAccess.getAppForUser = savedAccess;
      orchestrator.scheduleForSession = savedSchedule;
      state.rerunSameHead = savedRerun;
      delete require.cache[routePath];
    });
    const submit = async (body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/proposals/42/evidence/plan`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const stale = await submit({ headSha: 'c'.repeat(40), plan: fixtures.plan() });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'evidence_head_moved');
    const changed = fixtures.plan({ rationale: 'A different claim' });
    const mismatch = await submit({ headSha: head, plan: changed });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error, 'evidence_intent_mismatch');
    const accepted = await submit({ headSha: head, plan: fixtures.plan() });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.runId, '1'.repeat(32));
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].headSha, head);
    assert.equal(scheduled[0].authorPlan.version, 1);
    assert.equal(session.status, status, 'evidence submission does not resume coding');
    for (const closed of ['archived', 'merged', 'merging']) {
      session.status = closed;
      assert.equal((await submit({ headSha: head, plan: fixtures.plan() })).body.error, 'proposal_not_open');
    }
    session.status = status;
    session.visual_evidence_run_id = '4'.repeat(32);
    session.visual_evidence_state = 'provisioning';
    assert.equal((await submit({ headSha: head, plan: fixtures.plan() })).body.error, 'evidence_run_in_progress');
    session.user_id = 8;
    const otherUser = await submit({ headSha: head, plan: fixtures.plan() });
    assert.equal(otherUser.status, 404);
    assert.equal(scheduled.length, 1);
    session.user_id = 7;
    session.visual_evidence_state = 'failed';
    session.visual_evidence_run_id = '2'.repeat(32);
    const retries = [];
    state.rerunSameHead = async (_pool, runId, options) => {
      retries.push({ runId, options });
      return { id: '3'.repeat(32), head_sha: head, state: 'planned' };
    };
    const retry = await submit({ headSha: head, plan: fixtures.plan() });
    assert.equal(retry.status, 202);
    assert.deepEqual(retries, [{ runId: '2'.repeat(32), options: {
      trigger: 'author-plan', authorPlan: planContract.parseReplayPlan(fixtures.plan()),
    } }]);
    assert.equal(scheduled.length, 2);
  });
}
