'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

const poolModule = require('../src/db/pool');
const identity = require('../src/services/social-identity');
const queries = [];
const pool = { async query(sql, params = []) {
  queries.push({ sql, params });
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

test('both native buttons use the system browser with a fixed provider path and account expectation', async () => {
  const { openNativeSocialConnect } = await import('../frontend/src/features/settings/native-social-connect.js');
  for (const provider of ['github', 'x']) {
    const opened = [];
    await openNativeSocialConnect({
      bridge: { openExternal: async url => { opened.push(url); return true; } },
      provider, accountId: 7, origin: config.cliAuthOrigin,
    });
    assert.deepEqual(opened, [`${config.cliAuthOrigin}/api/me/social-identities/${provider}/connect?account=7`]);
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
