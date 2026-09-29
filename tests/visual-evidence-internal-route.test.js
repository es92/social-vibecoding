'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'evidence-route-test-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'evidence-route-test-secret';

// The route acquires a pool at construction, but this request needs only the
// run-scoped in-memory control. Keep the HTTP test independent of Postgres.
require('../src/db/pool').getPool = () => ({ query: async () => assert.fail('unexpected database request') });

const { internalRoutes } = require('../src/routes/internal');
const controlPlane = require('../src/services/visual-evidence-control');
const platformJwt = require('../src/services/platform-jwt');
const contract = require('../src/services/visual-evidence-plan');
const fixtures = require('./fixtures/visual-evidence');

async function listen(app, t) {
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test('the authenticated pair reset endpoint returns both replacement origins atomically', async (t) => {
  controlPlane._clearForTests();
  const runId = 'b'.repeat(32);
  const sessionId = 43;
  let resets = 0;
  const registration = controlPlane.registerRun({
    runId,
    sessionId,
    intent: fixtures.intent(),
    context: {},
    expiresAt: Date.now() + 10_000,
    resetPair: async () => {
      resets += 1;
      return {
        origins: {
          base: `http://base-${resets}.test`,
          head: `http://head-${resets}.test`,
        },
        bothSidesReset: true,
      };
    },
    runPlan: async () => assert.fail('unexpected replay'),
  });
  t.after(() => { registration.unregister(); controlPlane._clearForTests(); });

  const app = express();
  app.use(express.json());
  app.use(internalRoutes({ jwtSecret: process.env.JWT_SECRET }));
  const server = await listen(app, t);
  const token = platformJwt.signEvidenceToken({ runId, sessionId });
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/internal/evidence/${runId}/reset-pair`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    result: {
      origins: { base: 'http://base-1.test', head: 'http://head-1.test' },
      bothSidesReset: true,
    },
  });
  assert.equal(resets, 1);
});

test('the authenticated plan endpoint responds before paired replay finishes', async (t) => {
  controlPlane._clearForTests();
  const runId = 'a'.repeat(32);
  const sessionId = 42;
  let releaseReplay;
  const pendingReplay = new Promise((resolve) => { releaseReplay = resolve; });
  t.after(() => { releaseReplay(); controlPlane._clearForTests(); });
  let replayCalls = 0;
  const registration = controlPlane.registerRun({
    runId, sessionId, intent: fixtures.intent(), context: {},
    expiresAt: Date.now() + 10_000,
    runPlan: async (plan) => {
      replayCalls += 1;
      await pendingReplay;
      return { hardVerdict: { passed: true }, planHash: contract.planHash(plan) };
    },
  });
  t.after(() => registration.unregister());

  const app = express();
  app.use(express.json());
  app.use(internalRoutes({ jwtSecret: process.env.JWT_SECRET }));
  const server = await listen(app, t);

  const url = `http://127.0.0.1:${server.address().port}/api/internal/evidence/${runId}/run-plan`;
  const token = platformJwt.signEvidenceToken({ runId, sessionId });
  const replays = [{ id: 'invite-suggestions', replay: fixtures.plan().stories[0].replay }];
  const submit = async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ replays }),
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const first = await submit();
  assert.equal(first.ok, true);
  assert.equal(first.result.accepted, true);
  assert.equal(first.result.duplicate, false);
  assert.equal(registration.control.latestHard, null);
  const retry = await submit();
  assert.equal(retry.result.duplicate, true);
  assert.equal(registration.control.planCalls, 1);
  releaseReplay();
  await registration.control.waitForPlan();
  assert.equal(replayCalls, 1);
  assert.equal(registration.control.latestHard.passed, true);
});

test('capture mode accepts an agent screenshot as a raw PNG body and a per-claim blocker', async (t) => {
  const { PNG } = require('pngjs');
  controlPlane._clearForTests();
  const runId = 'c'.repeat(32);
  const sessionId = 44;
  const registration = controlPlane.registerRun({
    runId, sessionId, intent: fixtures.intent(), context: {}, mode: 'capture',
    expiresAt: Date.now() + 10_000,
  });
  t.after(() => { registration.unregister(); controlPlane._clearForTests(); });
  const app = express();
  // The global JSON parser runs first in production; an octet-stream body
  // must pass through it untouched to the route's own raw parser.
  app.use(express.json());
  app.use(internalRoutes({ jwtSecret: process.env.JWT_SECRET }));
  const server = await listen(app, t);
  const token = platformJwt.signEvidenceToken({ runId, sessionId });
  const base = `http://127.0.0.1:${server.address().port}/api/internal/evidence/${runId}`;
  const image = new PNG({ width: 5, height: 4 });
  image.data.fill(40);
  const body = PNG.sync.write(image);
  const post = (query, payload, type = 'application/octet-stream') => fetch(`${base}/capture?${query}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: payload,
  });

  const accepted = await post('storyId=invite-suggestions&viewport=desktop&side=head', body);
  assert.equal(accepted.status, 200);
  const payload = await accepted.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.result.width, 5);
  assert.equal(payload.result.variant, 'context');
  assert.equal(registration.control.captures.size, 1);

  const wrongViewport = await post('storyId=invite-suggestions&viewport=phone&side=head', body);
  assert.equal(wrongViewport.status, 400);
  assert.equal((await wrongViewport.json()).code, 'unknown_capture_viewport');
  const notPng = await post('storyId=invite-suggestions&viewport=desktop&side=base', Buffer.from('x'.repeat(64)));
  assert.equal((await notPng.json()).code, 'invalid_capture_image');

  const blocker = await fetch(`${base}/block-story`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ storyId: 'invite-suggestions', reason: 'Base shows a sign-in page.' }),
  });
  assert.equal(blocker.status, 200);
  assert.equal(registration.control.storyBlockers.get('invite-suggestions'), 'Base shows a sign-in page.');

  const other = platformJwt.signEvidenceToken({ runId: 'd'.repeat(32), sessionId });
  const foreign = await fetch(`${base}/capture?storyId=invite-suggestions&viewport=desktop&side=base`, {
    method: 'POST', headers: { authorization: `Bearer ${other}`, 'content-type': 'application/octet-stream' }, body,
  });
  assert.equal(foreign.status, 403, 'a token scoped to another run cannot publish here');
});
