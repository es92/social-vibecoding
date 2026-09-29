'use strict';

// The preview agent's only way into the platform: three run-scoped internal
// routes (src/routes/internal.js) behind a purpose-bound evidence JWT that
// names both the proposal session and the run.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'evidence-route-test-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'evidence-route-test-secret';

// The route acquires a pool at construction, but these requests need only the
// run-scoped in-memory control. Keep the HTTP test independent of Postgres.
require('../src/db/pool').getPool = () => ({ query: async () => assert.fail('unexpected database request') });

const { internalRoutes } = require('../src/routes/internal');
const controlPlane = require('../src/services/visual-evidence-control');
const platformJwt = require('../src/services/platform-jwt');
const shots = require('../src/services/visual-evidence-shots');
const fixtures = require('./fixtures/visual-evidence');

async function listen(app, t) {
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

// Register one run and serve the internal routes the way server.js does: the
// global JSON parser runs first, so an octet-stream file must pass through it
// untouched to the shot route's own raw parser.
async function serve(t, { runId, sessionId = 42, intent = fixtures.motionIntent(), context = {}, expiresAt } = {}) {
  controlPlane._clearForTests();
  const registration = controlPlane.registerRun({
    runId, sessionId, intent, context, expiresAt: expiresAt ?? Date.now() + 60_000,
  });
  t.after(() => { registration.unregister(); controlPlane._clearForTests(); });
  const app = express();
  // Keeps Express's default handler from printing the deliberate 413 below.
  app.set('env', 'test');
  app.use(express.json());
  app.use(internalRoutes({ jwtSecret: process.env.JWT_SECRET }));
  const server = await listen(app, t);
  const base = `http://127.0.0.1:${server.address().port}/api/internal/evidence/${runId}`;
  const token = platformJwt.signEvidenceToken({ runId, sessionId });
  return { registration, base, token };
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

async function json(response) {
  return { status: response.status, body: await response.json() };
}

test('the brief is readable only with this run\'s evidence token', async (t) => {
  const runId = 'a'.repeat(32);
  const context = {
    version: 2, runId,
    addresses: { before: 'http://base.test', after: 'http://head.test' },
    origins: { base: 'http://base.test', head: 'http://head.test' },
  };
  const { registration, base, token } = await serve(t, { runId, context });
  const get = (headers = {}) => fetch(`${base}/context`, { headers });

  const read = await json(await get(bearer(token)));
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, {
    ok: true,
    context: { ...context, progress: registration.control.progress() },
  });
  assert.deepEqual(read.body.context.progress.map((entry) => entry.status), ['missing', 'missing']);

  assert.equal((await json(await get())).body.code, 'missing_auth');
  assert.equal((await get()).status, 401);
  assert.equal((await get({ authorization: 'Bearer not-a-jwt' })).status, 401);

  // An evidence token for another run, or for this run under another
  // session, never reads this brief.
  const otherRun = await json(await get(bearer(platformJwt.signEvidenceToken({ runId: 'b'.repeat(32), sessionId: 42 }))));
  assert.deepEqual([otherRun.status, otherRun.body.code], [403, 'evidence_scope_mismatch']);
  const otherSession = await json(await get(bearer(platformJwt.signEvidenceToken({ runId, sessionId: 43 }))));
  assert.deepEqual([otherSession.status, otherSession.body.code], [403, 'evidence_scope_mismatch']);

  // The session's general and narrow worker tokens are not evidence tokens.
  for (const other of [
    platformJwt.signWorkerToken({ sessionId: 42 }),
    platformJwt.signWorkerPushToken({ sessionId: 42 }),
  ]) {
    const refused = await json(await get(bearer(other)));
    assert.deepEqual([refused.status, refused.body.code], [401, 'bad_token']);
  }

  registration.unregister();
  const gone = await json(await get(bearer(token)));
  assert.deepEqual([gone.status, gone.body.code], [410, 'evidence_control_not_found']);
});

test('an expired run answers 410 even to its own token', async (t) => {
  const runId = 'f'.repeat(32);
  const { base, token } = await serve(t, { runId, expiresAt: Date.now() - 1 });
  const response = await json(await fetch(`${base}/context`, { headers: bearer(token) }));
  assert.deepEqual([response.status, response.body.code], [410, 'evidence_control_expired']);
});

test('the shot route takes the raw file and maps each refusal to a status', async (t) => {
  const runId = 'c'.repeat(32);
  const { registration, base, token } = await serve(t, { runId });
  const post = (query, body, { type = 'application/octet-stream', auth = token } = {}) => fetch(
    `${base}/shot?${new URLSearchParams(query)}`,
    { method: 'POST', headers: { ...bearer(auth), 'content-type': type }, body },
  );
  const still = { change: 'invite-suggestions', screen: 'desktop' };

  const image = fixtures.png({ width: 5, height: 4 });
  const accepted = await json(await post({ ...still, side: 'after' }, image));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.ok, true);
  assert.deepEqual({ ...accepted.body.result, progress: undefined }, {
    saved: true, change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'screen',
    bytes: image.length, width: 5, height: 4, progress: undefined,
  });
  const [stored] = registration.control.saved.values();
  assert.equal(stored.side, 'head');
  assert.ok(stored.data.equals(image), 'the stored bytes are exactly the request body');

  assert.equal((await json(await post({ ...still, side: 'before', kind: 'element' }, image))).body.result.kind,
    'element');
  const clip = await json(await post({ change: 'saved-toast', screen: 'desktop', side: 'before', kind: 'clip' },
    fixtures.webm()));
  assert.equal(clip.status, 200);
  assert.equal(clip.body.result.kind, 'clip');
  assert.equal(registration.control.saved.size, 3);

  for (const [query, body, status, code] of [
    [{ ...still, screen: 'phone', side: 'after' }, image, 400, 'unknown_screen'],
    [{ ...still, change: 'someone-elses-change', side: 'after' }, image, 400, 'unknown_change'],
    [{ ...still, side: 'middle' }, image, 400, 'invalid_side'],
    [{ ...still, side: 'after', kind: 'video' }, image, 400, 'invalid_kind'],
    [{ ...still, side: 'after', kind: 'clip' }, fixtures.webm(), 400, 'clip_not_needed'],
    [{ ...still, side: 'before' }, Buffer.from('x'.repeat(64)), 400, 'invalid_shot_image'],
    [{ ...still, side: 'before' }, image.subarray(0, image.length - 4), 400, 'invalid_shot_image'],
    [{ change: 'saved-toast', screen: 'desktop', side: 'after', kind: 'clip' }, image, 400, 'invalid_clip'],
    [{ ...still, side: 'before' }, Buffer.alloc(shots.MAX_IMAGE_BYTES + 1), 413, 'shot_too_large'],
    // The parser limit sits above the clip limit, so the structured code wins.
    [{ change: 'saved-toast', screen: 'desktop', side: 'after', kind: 'clip' },
      fixtures.webm(shots.MAX_CLIP_BYTES + 1), 413, 'clip_too_large'],
  ]) {
    const refused = await json(await post(query, body));
    assert.deepEqual([refused.status, refused.body.ok, refused.body.code], [status, false, code],
      `${JSON.stringify(query)} should be refused with ${code}`);
    assert.equal(typeof refused.body.message, 'string');
  }

  // A JSON body is parsed by the global parser and never becomes a file.
  const asJson = await json(await post({ ...still, side: 'before' }, JSON.stringify({ png: image.toString('base64') }),
    { type: 'application/json' }));
  assert.deepEqual([asJson.status, asJson.body.code], [400, 'invalid_shot_image']);
  // Beyond the parser's own limit the body is refused before the control sees it.
  const oversized = await post({ change: 'saved-toast', screen: 'desktop', side: 'after', kind: 'clip' },
    fixtures.webm(22 * 1024 * 1024));
  assert.equal(oversized.status, 413);
  await oversized.arrayBuffer();

  // A token scoped to another run cannot publish here.
  const foreign = await json(await post({ ...still, side: 'before' }, image,
    { auth: platformJwt.signEvidenceToken({ runId: 'd'.repeat(32), sessionId: 42 }) }));
  assert.deepEqual([foreign.status, foreign.body.code], [403, 'evidence_scope_mismatch']);
  const unauthenticated = await fetch(`${base}/shot?${new URLSearchParams({ ...still, side: 'before' })}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: image,
  });
  assert.equal(unauthenticated.status, 401);

  assert.equal(registration.control.saved.size, 3, 'no refused request saved anything');
  assert.equal(registration.control.lastToolFailure.operation, 'save-shot');
});

test('the skip route records a reason per change or for all, then closes the turn', async (t) => {
  const runId = 'e'.repeat(32);
  const { registration, base, token } = await serve(t, { runId });
  const skip = (body, auth = token) => fetch(`${base}/skip`, {
    method: 'POST', headers: { ...bearer(auth), 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const one = await json(await skip({ change: 'saved-toast', reason: 'Members cannot save a list here.' }));
  assert.equal(one.status, 200);
  assert.equal(one.body.result.skipped, 'saved-toast');
  assert.deepEqual(one.body.result.progress[1], {
    change: 'saved-toast', status: 'skipped', detail: 'Members cannot save a list here.',
  });

  for (const [body, code] of [
    [{ change: 'saved-toast' }, 'reason_required'],
    [{ change: 'saved-toast', reason: '   ' }, 'reason_required'],
    [{ change: 'someone-elses-change', reason: 'Not reachable.' }, 'unknown_change'],
  ]) {
    const refused = await json(await skip(body));
    assert.deepEqual([refused.status, refused.body.code], [400, code]);
  }
  const foreign = await json(await skip({ reason: 'Not mine to skip.' },
    platformJwt.signEvidenceToken({ runId, sessionId: 43 })));
  assert.deepEqual([foreign.status, foreign.body.code], [403, 'evidence_scope_mismatch']);
  assert.equal(registration.control.skippedAll, null);

  // The bridge sends change: null to skip everything.
  const all = await json(await skip({ change: null, reason: 'Every screen shows a sign-in page.' }));
  assert.equal(all.status, 200);
  assert.equal(all.body.result.skipped, 'all');
  assert.deepEqual(all.body.result.progress.map((entry) => entry.detail), [
    'Every screen shows a sign-in page.', 'Members cannot save a list here.',
  ]);

  const again = await json(await skip({ change: 'invite-suggestions', reason: 'Another try.' }));
  assert.deepEqual([again.status, again.body.code], [409, 'evidence_turn_finished']);
  const late = await json(await fetch(`${base}/shot?${new URLSearchParams({
    change: 'invite-suggestions', screen: 'desktop', side: 'after',
  })}`, {
    method: 'POST', headers: { ...bearer(token), 'content-type': 'application/octet-stream' }, body: fixtures.png(),
  }));
  assert.deepEqual([late.status, late.body.code], [409, 'evidence_turn_finished']);
  assert.equal(registration.control.saved.size, 0);
});

test('the brief, shot and skip routes are the whole evidence surface', async (t) => {
  const runId = '1'.repeat(32);
  const { base, token } = await serve(t, { runId });
  // The replay-era routes are gone, even for a valid token of this run.
  for (const route of ['reset-pair', 'reset-side', 'run-plan', 'finish', 'capture', 'block-story', 'plan', 'context']) {
    const response = await fetch(`${base}/${route}`, {
      method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 404, `POST /${route} must not exist`);
  }
  for (const route of ['shot', 'skip', 'diagnostics', 'artifacts']) {
    const response = await fetch(`${base}/${route}`, { headers: bearer(token) });
    assert.equal(response.status, 404, `GET /${route} must not exist`);
  }
});
