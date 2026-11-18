// Tests for the app-storage auth middleware (#752) —
// src/middleware/app-storage-auth.js. Sibling of
// tests/app-llm-proxy-auth.test.js, minus the grant matrix (storage has
// no per-user consent grant). Covers: private-IP gate, bad/missing app
// token (a staging caller never receives one, so missing == staging
// rejected), expired/garbage/wrong-scope user token, and the success
// path populating req.appStorage.
//
// Run with: node --test tests/app-storage-auth.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const keys = require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const { appStorageAuth } = require('../src/middleware/app-storage-auth');

const APP_TOKEN = 'b'.repeat(64);
const APP_ID = 11;

const state = {
  userExists: true,
  app: { id: APP_ID, slug: 'demo-app', storage_api_token: APP_TOKEN },
};

const pool = {
  async query(sql, params) {
    if (/SELECT id FROM users WHERE id = \$1/.test(sql)) return { rows: state.userExists ? [{ id: params[0] }] : [] };
    if (/FROM apps WHERE storage_api_token/.test(sql)) {
      return { rows: params[0] === state.app.storage_api_token ? [state.app] : [] };
    }
    return { rows: [] };
  },
};

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function makeReq({ ip = '10.0.0.5', appToken = APP_TOKEN, userToken } = {}) {
  const headers = {};
  if (appToken != null) headers['x-usernode-app-token'] = appToken;
  if (userToken != null) headers['x-usernode-user-token'] = userToken;
  // #2506: the gate reads the SOCKET PEER now, not req.clientIp — the whole
  // point is that `clientIp` can be the ingress's address on a trusted-proxy
  // DNS failure. A real request always has a socket peer; a fixture that set
  // only `clientIp` was describing a request that cannot exist.
  return { clientIp: ip, headers, socket: { remoteAddress: ip }, path: '/api/app-storage/files' };
}

// A real platform-minted user identity for THIS app.
function userJwt(user = { id: 7, username: 'tester' }, { appId = APP_ID, ttl } = {}) {
  return platformJwt.signAppIdentityToken({ appId, user, ttl });
}

// Hand-forged with the real private key so algorithm, issuer, audience and
// `pur` all pass — only the claim shape is wrong. The sole route to the
// middleware's belt-and-braces branch now that infrastructure tokens are a
// separate authority. See tests/app-llm-proxy-auth.test.js.
function forgedIdentity(extra) {
  return jwt.sign(
    { id: 7, username: 'tester', pur: 'iframe', env: 'production', ...extra },
    keys.IFRAME_JWT_PRIVATE_KEY,
    {
      algorithm: 'RS256',
      issuer: 'usernode',
      audience: `usernode:app:${APP_ID}`,
      expiresIn: '1h',
    }
  );
}

async function run(req) {
  const res = makeRes();
  let nexted = false;
  const mw = appStorageAuth(pool, {});
  await mw(req, res, () => { nexted = true; });
  return { res, nexted, req };
}

test('non-private source IP is rejected', async () => {
  const { res, nexted } = await run(makeReq({ ip: '8.8.8.8', userToken: userJwt() }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'forbidden_ip');
});

test('missing app token (the staging case) is rejected', async () => {
  const { res, nexted } = await run(makeReq({ appToken: null, userToken: userJwt() }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'missing_app_token');
});

test('malformed app token is rejected before any lookup', async () => {
  const { res } = await run(makeReq({ appToken: 'not-64-hex', userToken: userJwt() }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'missing_app_token');
});

test('unknown app token is rejected', async () => {
  const { res } = await run(makeReq({ appToken: 'c'.repeat(64), userToken: userJwt() }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_app_token');
});

test('missing user token is rejected', async () => {
  const { res } = await run(makeReq({}));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'missing_user_token');
});

test('garbage user token is rejected', async () => {
  const { res } = await run(makeReq({ userToken: 'garbage' }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_user_token');
});

test('expired user token is rejected', async () => {
  const token = userJwt({ id: 7 }, { ttl: '-1s' });
  const { res } = await run(makeReq({ userToken: token }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_user_token');
});

// A worker token is HS256 under its own key with its own audience — a
// separate authority since key separation, so it dies at the verifier.
test('a worker token is not a user token', async () => {
  const { res } = await run(makeReq({ userToken: platformJwt.signWorkerToken({ sessionId: 5 }) }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_user_token');
});

test('a correctly-signed identity carrying a scope claim is still refused', async () => {
  const { res } = await run(makeReq({ userToken: forgedIdentity({ scope: 'worker:session' }) }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'bad_user_token');
});

test('non-numeric id claim is rejected', async () => {
  const { res } = await run(makeReq({ userToken: forgedIdentity({ id: 'seven' }) }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'bad_user_token');
});

// The cross-app replay hole the RSA cutover closes: app 11 presenting an
// identity the user only ever handed to app 12, to write files (and burn
// storage quota) as them.
test('a user token minted for a DIFFERENT app is rejected', async () => {
  const { res, nexted } = await run(makeReq({
    userToken: userJwt({ id: 7, username: 'tester' }, { appId: 12 }),
  }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_user_token');
});

test('success path attaches req.appStorage', async () => {
  const { res, nexted, req } = await run(makeReq({ userToken: userJwt({ id: 7 }) }));
  assert.equal(res.statusCode, 200);
  assert.equal(nexted, true);
  assert.deepEqual(req.appStorage, { appId: APP_ID, appSlug: 'demo-app', userId: 7 });
});


test('a still-valid JWT cannot upload after its user is deleted', async () => {
  const token = userJwt();
  state.userExists = false;
  try {
    const { res, nexted } = await run(makeReq({ userToken: token }));
    assert.equal(res.statusCode, 401);
    assert.equal(nexted, false);
  } finally { state.userExists = true; }
});


test('a preview identity is rejected even with the production app credential', async () => {
  const userToken = platformJwt.signAppIdentityToken({ appId: APP_ID, user: { id: 7, username: 'tester' }, environment: 'preview' });
  const { res, nexted } = await run(makeReq({ userToken }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_user_token');
});

// ── The app acting for itself (userOptional routes) ─────────────────

async function runOptional(req) {
  const res = makeRes();
  let nexted = false;
  await appStorageAuth(pool, {}, { userOptional: true })(req, res, () => { nexted = true; });
  return { res, nexted, req };
}

test('userOptional: the app token alone passes as the app, with no user', async () => {
  const { res, nexted, req } = await runOptional(makeReq({}));
  assert.equal(res.statusCode, 200);
  assert.equal(nexted, true);
  assert.deepEqual(req.appStorage, { appId: APP_ID, appSlug: 'demo-app', userId: null });
});

test('userOptional: a user token that is sent must still be good', async () => {
  const { res, nexted } = await runOptional(makeReq({ userToken: 'garbage' }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'bad_user_token');
  const ok = await runOptional(makeReq({ userToken: userJwt({ id: 7 }) }));
  assert.equal(ok.req.appStorage.userId, 7);
});

test('userOptional: the app token is still required and checked', async () => {
  const missing = await runOptional(makeReq({ appToken: null }));
  assert.equal(missing.res.body.code, 'missing_app_token');
  const unknown = await runOptional(makeReq({ appToken: 'c'.repeat(64) }));
  assert.equal(unknown.res.body.code, 'bad_app_token');
  const outside = await runOptional(makeReq({ ip: '8.8.8.8' }));
  assert.equal(outside.res.body.code, 'forbidden_ip');
});
