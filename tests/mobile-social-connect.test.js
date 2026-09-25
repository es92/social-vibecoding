'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

const poolModule = require('../src/db/pool');
const identity = require('../src/services/social-identity');
const queries = [];
let pendingOauthState = false;
const pool = { async query(sql, params = []) {
  queries.push({ sql, params });
  if (pendingOauthState && /DELETE FROM social_identity_oauth_states\s+WHERE state_hash/.test(sql)) {
    return { rows: [{ intent: 'connect', pkce_verifier: 'v'.repeat(64),
      expires_at: new Date(Date.now() + 600000) }] };
  }
  if (/FROM sessions s JOIN users u/.test(sql)) {
    const id = params[0] === 'app-account' ? 7 : 8;
    return { rows: [{ user_id: id, username: `user${id}`, has_platform_access: true,
      expires_at: new Date(Date.now() + 3600000) }] };
  }
  return { rows: [] };
} };
poolModule.getPool = () => pool;
require('../src/services/cli-auth').consumeSharedTokenBucket = async () => ({ allowed: true });
const { authMiddleware } = require('../src/middleware/auth');
const { socialIdentityRoutes } = require('../src/routes/social-identities');
const config = {
  cliAuthOrigin: 'https://social.example',
  githubLinkClientId: 'test-github', githubLinkClientSecret: 'test-github-secret',
  xLinkClientId: 'test-x', xLinkClientSecret: 'test-x-secret',
};

async function serve(t) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware(config));
  app.use(socialIdentityRoutes(config));
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    redirect: 'manual', ...options,
  });
}

for (const provider of ['github', 'x']) {
  test(`${provider}: anonymous mobile connect resumes through browser login without minting OAuth state`, async t => {
    const get = await serve(t);
    queries.length = 0;
    const target = `/api/me/social-identities/${provider}/connect?account=7`;
    const response = await get(target + '&redirect_uri=https://evil.example');
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location'), config.cliAuthOrigin);
    assert.equal(location.origin, config.cliAuthOrigin);
    assert.equal(location.hash, '#login');
    assert.equal(location.searchParams.get('return_to'), target, 'only the account expectation survives');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(queries.some(q => /INSERT INTO social_identity_oauth_states/.test(q.sql)), false);
  });

  test(`${provider}: anonymous mobile replacement keeps its intent through browser login`, async t => {
    const get = await serve(t);
    queries.length = 0;
    const target = `/api/me/social-identities/${provider}/connect?account=7&intent=replace`;
    const response = await get(target);
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location'), config.cliAuthOrigin);
    assert.equal(location.searchParams.get('return_to'), target);
    assert.equal(queries.some(q => /INSERT INTO social_identity_oauth_states/.test(q.sql)), false);
  });

  test(`${provider}: the matching browser session reaches OAuth with its existing PKCE and user binding`, async t => {
    const get = await serve(t);
    queries.length = 0;
    const response = await get(`/api/me/social-identities/${provider}/connect?account=7`, {
      headers: { Cookie: 'session=app-account' },
    });
    assert.equal(response.status, 302);
    const url = new URL(response.headers.get('location'));
    assert.equal(url.origin, provider === 'github' ? 'https://github.com' : 'https://x.com');
    assert.match(url.searchParams.get('state'), identity.STATE_RE);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(url.searchParams.get('redirect_uri'), `${config.cliAuthOrigin}/api/me/${provider}/callback`);
    assert.equal(url.searchParams.has('account'), false);
    const saved = queries.find(q => /INSERT INTO social_identity_oauth_states/.test(q.sql));
    assert.equal(saved.params[1], 7);
    assert.equal(saved.params[2], provider);
    assert.equal(saved.params[3], 'connect');
  });

  test(`${provider}: a different browser account or malformed expectation cannot start linking`, async t => {
    const get = await serve(t);
    for (const query of ['account=7', 'account=8&account=7', 'account=08', 'account=', 'account[0]=8']) {
      queries.length = 0;
      const response = await get(`/api/me/social-identities/${provider}/connect?${query}`, {
        headers: { Cookie: 'session=different-account' },
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), `${config.cliAuthOrigin}/#settings/connectors?identity=account_mismatch&provider=${provider}`);
      assert.equal(queries.some(q => /INSERT INTO social_identity_oauth_states/.test(q.sql)), false);
    }
  });
}

test('ordinary browser links still reach OAuth and unrelated anonymous API requests stay unauthorized', async t => {
  const get = await serve(t);
  const ordinary = await get('/api/me/social-identities/github/connect', {
    headers: { Cookie: 'session=app-account' },
  });
  assert.equal(new URL(ordinary.headers.get('location')).origin, 'https://github.com');
  for (const path of [
    '/api/me/social-identities/github/connect',
    '/api/me/social-identities/x/connect?account=7&account=8',
    '/api/me/social-identities/x/connect?account=bad',
    '/api/me/social-identities/github/callback?account=7',
    '/api/me/social-identities/not-a-provider/connect?account=7',
    '/api/me/social-identities?account=7',
  ]) {
    assert.equal((await get(path)).status, 401, path);
  }
  assert.equal((await get('/api/me/social-identities/github/connect?account=7', { method: 'POST' })).status, 401);
});

test('invalid social intents cannot start or survive an anonymous login handoff', async t => {
  const get = await serve(t);
  const anonymous = await get('/api/me/social-identities/github/connect?account=7&intent=steal');
  assert.equal(anonymous.status, 401);
  const authenticated = await get('/api/me/social-identities/github/connect?account=7&intent=steal', {
    headers: { Cookie: 'session=app-account' },
  });
  assert.equal(authenticated.status, 400);
});

test('social identity mutations require same-origin requests and boolean visibility', async t => {
  const get = await serve(t);
  const cases = [
    ['/api/me/social-identities/github/replacement', 'POST'],
    ['/api/me/social-identities/github/visibility', 'PATCH'],
  ];
  for (const [path, method] of cases) {
    const withoutOrigin = await get(path, {
      method,
      headers: { Cookie: 'session=app-account', 'content-type': 'application/json' },
      body: JSON.stringify({ publicVisible: true }),
    });
    assert.equal(withoutOrigin.status, 403, `${method} ${path} is CSRF-gated`);

    const invalidVisibility = await get(path, {
      method,
      headers: {
        Cookie: 'session=app-account',
        Origin: config.cliAuthOrigin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ publicVisible: 'yes' }),
    });
    assert.equal(invalidVisibility.status, 400);
    assert.equal((await invalidVisibility.json()).error, 'invalid_visibility');

    const missingVisibility = await get(path, {
      method,
      headers: {
        Cookie: 'session=app-account',
        Origin: config.cliAuthOrigin,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(missingVisibility.status, 400);
    assert.equal((await missingVisibility.json()).error, 'invalid_visibility');
  }

  const cancel = await get('/api/me/social-identities/github/replacement', {
    method: 'DELETE',
    headers: { Cookie: 'session=app-account', Origin: config.cliAuthOrigin },
  });
  assert.equal(cancel.status, 204);
});

test('both native buttons use the system browser with a fixed provider path and account expectation', async () => {
  const { openNativeSocialConnect } = await import('../frontend/src/features/settings/native-social-connect.js');
  for (const provider of ['github', 'x']) {
    const opened = [];
    await openNativeSocialConnect({
      bridge: { openExternal: async url => { opened.push(url); return true; } },
      provider, accountId: 7, origin: config.cliAuthOrigin,
    });
    assert.deepEqual(opened, [
      `${config.cliAuthOrigin}/api/me/social-identities/${provider}/connect?account=7&intent=connect`,
    ]);
  }
});

test('native refresh and replacement keep their explicit OAuth intent', async () => {
  const { openNativeSocialConnect } = await import('../frontend/src/features/settings/native-social-connect.js');
  for (const intent of ['refresh', 'replace']) {
    const opened = [];
    await openNativeSocialConnect({
      bridge: { openExternal: async url => { opened.push(url); return true; } },
      provider: 'github', intent, accountId: 7, origin: config.cliAuthOrigin,
    });
    assert.equal(new URL(opened[0]).searchParams.get('intent'), intent);
  }
});

test('native failures are actionable, and invalid account/provider values never open a browser', async () => {
  const { openNativeSocialConnect } = await import('../frontend/src/features/settings/native-social-connect.js');
  const args = { provider: 'github', accountId: 7, origin: config.cliAuthOrigin };
  for (const bridge of [null, {}]) {
    await assert.rejects(openNativeSocialConnect({ ...args, bridge }), /Update the Homeroom app/);
  }
  for (const openExternal of [async () => false, async () => { throw new Error('bridge failed'); }]) {
    await assert.rejects(openNativeSocialConnect({ ...args, bridge: { openExternal } }), /Could not open your browser/);
  }
  const bridge = { openExternal: () => assert.fail('must not launch') };
  for (const accountId of [null, undefined, '7', 0, -1, NaN, Infinity]) {
    await assert.rejects(openNativeSocialConnect({ ...args, bridge, accountId }), /account could not be identified/);
  }
  await assert.rejects(openNativeSocialConnect({ ...args, bridge, provider: '../github' }), /account could not be identified/);
  await assert.rejects(openNativeSocialConnect({ ...args, bridge, intent: 'steal' }), /account could not be identified/);
});

test('return to app refreshes status, coalesces focus/visibility events, and removes listeners on teardown', async () => {
  const { watchSocialConnectReturn } = await import('../frontend/src/features/settings/native-social-connect.js');
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.hidden = true;
  let calls = 0;
  let finish;
  const stop = watchSocialConnectReturn({ win, doc, refresh: () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  } });
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 0);
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('focus'));
  assert.equal(calls, 1);
  finish();
  await Promise.resolve();
  win.dispatchEvent(new Event('focus'));
  assert.equal(calls, 2, 'a cancelled flow can still finish on a later return');
  finish();
  await Promise.resolve();
  stop();
  win.dispatchEvent(new Event('focus'));
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 2);
});

// #3044: GitHub answers a redirect_uri that is not the registered one by
// redirecting straight back to the REGISTERED callback with
// error=redirect_uri_mismatch and the state — no GitHub page is shown. The
// state is still validated and consumed, but the result must name the
// misregistration rather than claim the viewer cancelled.
test('a provider error on the callback is reported for what it is, not as a cancellation', async t => {
  const get = await serve(t);
  pendingOauthState = true;
  t.after(() => { pendingOauthState = false; });
  const state = 'a'.repeat(43);
  const cases = [
    ['error=redirect_uri_mismatch&error_description=The+redirect_uri+MUST+match', 'callback_mismatch'],
    ['error=access_denied', 'denied'],
    ['', 'denied'],
    ['error=application_suspended', 'error'],
    ['error=%3Cscript%3E', 'error'],
  ];
  for (const [extra, status] of cases) {
    queries.length = 0;
    const response = await get(`/api/me/github/callback?state=${state}${extra ? `&${extra}` : ''}`, {
      headers: { Cookie: 'session=app-account' },
    });
    assert.equal(response.status, 302, extra);
    assert.equal(response.headers.get('location'),
      `${config.cliAuthOrigin}/#settings/connectors?identity=${status}&provider=github`, extra);
    const consumed = queries.find(q => /DELETE FROM social_identity_oauth_states\s+WHERE state_hash/.test(q.sql));
    assert.ok(consumed, 'the OAuth state is still validated and consumed');
    assert.equal(consumed.params[1], 7, 'bound to the signed-in user');
  }
});

test('the settings screen explains a callback mismatch instead of staying silent', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/features/settings/settings.js'), 'utf8');
  const start = src.indexOf('_socialIdentityCallbackStatus(status) {');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('async _unlinkGithub', start));
  assert.match(body, /callback_mismatch: `\$\{name\} did not accept Homeroom’s callback address/);
  assert.match(body, /Ask an administrator to register this site’s callback URL \(\$\{window\.location\.origin\}\)/);
});
