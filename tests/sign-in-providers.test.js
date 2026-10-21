'use strict';

// Apple and Google sign-in (src/services/sign-in-providers.js,
// src/routes/sign-in-providers.js), set up in Admin → Sign-in providers
// (frontend/src/features/admin/admin-sign-in.tsx) and offered on the sign-in
// sheet (frontend/src/features/auth/sign-in-sheet.tsx). The parts that need
// no database: the settings and their secrets, the round trip's state, the
// exchange and the ID token's checks, the route wiring and the sheet.
// The account rules run against PostgreSQL in
// tests/sign-in-providers-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const providers = require('../src/services/sign-in-providers');

const CONFIG = Object.freeze({ cliAuthOrigin: 'https://app.example', dataEncryptionKey: 'sign-in-test-key' });

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

function appleKeyPem() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey };
}

/**
 * Just enough of the three tables, in memory, for the statements the
 * service sends: the settings upsert (COALESCE keeps a secret), the round
 * trip's insert and single-use delete.
 */
class FakeDb {
  constructor() {
    this.providers = new Map();
    this.states = new Map();
    this.tokens = new Map();
    this.sql = [];
  }

  async query(sql, params = []) {
    this.sql.push(sql);
    if (/FROM sign_in_providers s/.test(sql)) {
      return { rows: [...this.providers.values()].map((r) => ({ ...r, updated_by: null })) };
    }
    if (/^\s*INSERT INTO sign_in_providers/.test(sql)) {
      const [provider, enabled, clientId, teamId, keyId, appClientIds, secretEnc] = params;
      const prior = this.providers.get(provider);
      this.providers.set(provider, {
        provider, enabled, client_id: clientId, team_id: teamId, key_id: keyId, app_client_ids: appClientIds,
        secret_enc: secretEnc || (prior ? prior.secret_enc : null), updated_at: new Date(),
      });
      return { rows: [] };
    }
    if (/^\s*DELETE FROM sign_in_providers WHERE provider/.test(sql)) {
      this.providers.delete(params[0]);
      return { rows: [] };
    }
    if (/^\s*INSERT INTO oauth_sign_in_states/.test(sql) && /\bnative\b/.test(sql)) {
      const [stateHash, provider, binderHash, nonce, follow, from, expiresAt] = params;
      this.states.set(stateHash, {
        provider, binder_hash: binderHash, nonce, code_verifier: null, follow_invite: follow,
        started_from: from, return_to: '/', expires_at: expiresAt, native: true,
      });
      return { rows: [] };
    }
    if (/^\s*INSERT INTO oauth_sign_in_states/.test(sql)) {
      const [stateHash, provider, binderHash, nonce, verifier, follow, from, returnTo, expiresAt] = params;
      this.states.set(stateHash, {
        provider, binder_hash: binderHash, nonce, code_verifier: verifier, follow_invite: follow,
        started_from: from, return_to: returnTo, expires_at: expiresAt, native: false,
      });
      return { rows: [] };
    }
    if (/DELETE FROM oauth_sign_in_states\s+WHERE state_hash/.test(sql)) {
      const row = this.states.get(params[0]);
      if (!row || row.provider !== params[1] || row.native !== params[2]) return { rows: [] };
      this.states.delete(params[0]);
      return { rows: [row] };
    }
    if (/^\s*INSERT INTO native_sign_in_tokens/.test(sql)) {
      if (this.tokens.has(params[0])) return { rows: [] };
      this.tokens.set(params[0], { provider: params[1], expires_at: params[2] });
      return { rows: [{ token_hash: params[0] }] };
    }
    if (/DELETE FROM (oauth_sign_in_states|oauth_signup_sessions|native_sign_in_tokens) WHERE expires_at/.test(sql)) return { rows: [] };
    throw new Error(`FakeDb: unexpected SQL ${sql.slice(0, 80)}`);
  }
}

async function setUpGoogle(db, config = CONFIG) {
  return providers.saveProvider(db, config, 'google', {
    clientId: '123-abc.apps.googleusercontent.com', secret: 'GOCSPX-test_secret-1', enabled: true,
  }, 1);
}

test('nothing is offered until a provider is complete, switched on, and the server has its own origin', async () => {
  const db = new FakeDb();
  assert.deepEqual(await providers.offeredProviders(db, CONFIG), []);
  await providers.saveProvider(db, CONFIG, 'google', { clientId: '123-abc.apps.googleusercontent.com' }, 1);
  assert.deepEqual(await providers.offeredProviders(db, CONFIG), [], 'no secret, not on');
  await setUpGoogle(db);
  assert.deepEqual(await providers.offeredProviders(db, CONFIG), ['google']);
  // A staging preview has no canonical origin, so nothing is offered there.
  assert.deepEqual(await providers.offeredProviders(new FakeDb(), { ...CONFIG, cliAuthOrigin: null }), []);
  const { pem } = appleKeyPem();
  await providers.saveProvider(db, CONFIG, 'apple', {
    clientId: 'com.example.web', teamId: 'abcde12345', keyId: 'XYZ9876543', secret: pem, enabled: true,
  }, 1);
  assert.deepEqual(await providers.offeredProviders(db, CONFIG), ['apple', 'google'], 'Apple first');
  await providers.saveProvider(db, CONFIG, 'google', { enabled: false }, 1);
  assert.deepEqual(await providers.offeredProviders(db, CONFIG), ['apple']);
});

test('a secret goes in encrypted, is kept when left out, and never comes back out', async () => {
  const db = new FakeDb();
  const view = await setUpGoogle(db);
  const stored = db.providers.get('google');
  assert.match(stored.secret_enc, /^v1:/, 'AES-GCM envelope from services/secrets.js');
  assert.ok(!stored.secret_enc.includes('GOCSPX'), 'never stored in the clear');
  assert.ok(!JSON.stringify(view).includes('GOCSPX'), 'never in the console view');
  const google = view.providers.find((p) => p.provider === 'google');
  assert.equal(google.secretSaved, true);
  assert.equal(google.offered, true);
  assert.equal(google.callbackUrl, 'https://app.example/api/auth/oauth/google/callback');
  // Saving the IDs again without a secret keeps it.
  await providers.saveProvider(db, CONFIG, 'google', { clientId: '456-def.apps.googleusercontent.com' }, 1);
  assert.equal(db.providers.get('google').secret_enc, stored.secret_enc);
  // Another data key cannot read it: saved, but not offered.
  const elsewhere = await providers.adminView(db, { ...CONFIG, dataEncryptionKey: 'another-key' });
  const unreadable = elsewhere.providers.find((p) => p.provider === 'google');
  assert.equal(unreadable.secretUnreadable, true);
  assert.equal(unreadable.offered, false);
  assert.match(unreadable.missing.join(), /cannot read it/);
});

test('switching on an incomplete provider is refused, naming what is missing', async () => {
  const db = new FakeDb();
  await assert.rejects(
    providers.saveProvider(db, CONFIG, 'apple', { clientId: 'com.example.web', enabled: true }, 1),
    (err) => err.code === 'incomplete' && /Team ID, Key ID, Private key/.test(err.message),
  );
  assert.equal(db.providers.size, 0, 'nothing saved');
  await assert.rejects(providers.saveProvider(db, CONFIG, 'github', {}, 1), { code: 'unknown_provider' });
});

test('Apple takes a P-256 PKCS#8 key and ten-character IDs; Google a plain client secret', async () => {
  const db = new FakeDb();
  await assert.rejects(providers.saveProvider(db, CONFIG, 'apple', { teamId: 'short' }, 1), { code: 'invalid_team_id' });
  await assert.rejects(providers.saveProvider(db, CONFIG, 'apple', { keyId: 'ABC-123456' }, 1), { code: 'invalid_key_id' });
  await assert.rejects(providers.saveProvider(db, CONFIG, 'apple', { secret: 'not a key' }, 1), { code: 'invalid_private_key' });
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  await assert.rejects(providers.saveProvider(db, CONFIG, 'apple', { secret: rsa }, 1), { code: 'invalid_private_key' });
  await assert.rejects(providers.saveProvider(db, CONFIG, 'google', { secret: 'has spaces in it' }, 1), { code: 'invalid_secret' });
  await assert.rejects(providers.saveProvider(db, CONFIG, 'google', { clientId: 'bad id!' }, 1), { code: 'invalid_client_id' });
  // Lower case IDs are stored as Apple writes them.
  await providers.saveProvider(db, CONFIG, 'apple', { teamId: 'abcde12345' }, 1);
  assert.equal(db.providers.get('apple').team_id, 'ABCDE12345');
  // No data key, no secret.
  await assert.rejects(
    providers.saveProvider(new FakeDb(), { ...CONFIG, dataEncryptionKey: '' }, 'google', { secret: 'GOCSPX-abcdefgh' }, 1),
    { code: 'no_data_key' },
  );
});

test('Remove deletes the provider\'s row, keys and all', async () => {
  const db = new FakeDb();
  await setUpGoogle(db);
  const view = await providers.saveProvider(db, CONFIG, 'google', { clear: true }, 1);
  assert.equal(db.providers.has('google'), false);
  assert.equal(view.providers.find((p) => p.provider === 'google').secretSaved, false);
});

test('the trip starts with a hashed single-use state, a nonce, PKCE for Google and a form POST for Apple', async () => {
  const db = new FakeDb();
  await setUpGoogle(db);
  const { pem } = appleKeyPem();
  await providers.saveProvider(db, CONFIG, 'apple', {
    clientId: 'com.example.web', teamId: 'ABCDE12345', keyId: 'XYZ9876543', secret: pem, enabled: true,
  }, 1);

  const google = await providers.beginSignIn(db, CONFIG, 'google', {
    from: 'invite', followInvite: true, returnTo: '/invite/AAAAAAAAAAAAAAAAAAAAAA',
  });
  const url = new URL(google.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = url.searchParams;
  assert.equal(q.get('client_id'), '123-abc.apps.googleusercontent.com');
  assert.equal(q.get('redirect_uri'), 'https://app.example/api/auth/oauth/google/callback');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'openid email profile');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('prompt'), 'select_account');
  const row = db.states.get(sha256(q.get('state')));
  assert.ok(row, 'the state is stored only as its hash');
  assert.equal(row.binder_hash, sha256(google.binder));
  assert.equal(row.nonce, q.get('nonce'));
  assert.equal(q.get('code_challenge'), crypto.createHash('sha256').update(row.code_verifier).digest('base64url'));
  assert.equal(row.follow_invite, true);
  assert.equal(row.started_from, 'invite');
  assert.equal(row.return_to, '/invite/AAAAAAAAAAAAAAAAAAAAAA');

  const apple = new URL((await providers.beginSignIn(db, CONFIG, 'apple', { from: 'nowhere', returnTo: 'https://evil.example/' })).url);
  assert.equal(apple.origin + apple.pathname, 'https://appleid.apple.com/auth/authorize');
  assert.equal(apple.searchParams.get('scope'), 'name email');
  assert.equal(apple.searchParams.get('response_mode'), 'form_post');
  assert.equal(apple.searchParams.get('code_challenge'), null);
  const appleRow = db.states.get(sha256(apple.searchParams.get('state')));
  assert.equal(appleRow.return_to, '/', 'only a path on this origin comes back');
  assert.equal(appleRow.started_from, null);

  await assert.rejects(providers.beginSignIn(new FakeDb(), CONFIG, 'google', {}), { code: 'not_offered' });
});

test('a state is spent once, counts only in the browser that started it, and expires', async () => {
  const db = new FakeDb();
  await setUpGoogle(db);
  const { url, binder } = await providers.beginSignIn(db, CONFIG, 'google', {});
  const state = new URL(url).searchParams.get('state');
  assert.equal(await providers.consumeState(db, 'apple', state, binder), null, 'another provider');
  const ok = await providers.consumeState(db, 'google', state, binder);
  assert.ok(ok && !ok.mismatch && ok.code_verifier);
  assert.equal(await providers.consumeState(db, 'google', state, binder), null, 'single use');

  const second = await providers.beginSignIn(db, CONFIG, 'google', {});
  const s2 = new URL(second.url).searchParams.get('state');
  assert.deepEqual(await providers.consumeState(db, 'google', s2, 'somebody-elses-binder'), { mismatch: true, return_to: '/' });
  assert.equal(await providers.consumeState(db, 'google', s2, second.binder), null, 'spent by the mismatch too');

  const third = await providers.beginSignIn(db, CONFIG, 'google', {});
  const s3 = new URL(third.url).searchParams.get('state');
  db.states.get(sha256(s3)).expires_at = new Date(Date.now() - 1000);
  assert.equal(await providers.consumeState(db, 'google', s3, third.binder), null, 'expired');
});

test('Apple\'s client secret is a five-minute ES256 JWT signed by the team\'s key', async () => {
  const { jwtVerify, decodeProtectedHeader } = await import('jose');
  const { pem, publicKey } = appleKeyPem();
  const row = { clientId: 'com.example.web', teamId: 'ABCDE12345', keyId: 'XYZ9876543', secret: pem };
  const jwt = await providers.appleClientSecret(row, Date.now());
  assert.deepEqual(decodeProtectedHeader(jwt), { alg: 'ES256', kid: 'XYZ9876543' });
  const { payload } = await jwtVerify(jwt, publicKey, {
    issuer: 'ABCDE12345', subject: 'com.example.web', audience: 'https://appleid.apple.com',
  });
  assert.equal(payload.exp - payload.iat, 300);
});

async function idTokenKit() {
  const { SignJWT, exportJWK, createLocalJWKSet } = await import('jose');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims, { issuer = 'https://accounts.google.com', audience = '123-abc.apps.googleusercontent.com' } = {}) => new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('5m')
    .sign(privateKey);
  return { jwks, sign };
}

test('the ID token is checked: signature, issuer, audience and nonce', async () => {
  const { jwks, sign } = await idTokenKit();
  const aud = '123-abc.apps.googleusercontent.com';
  const good = await sign({ sub: '1001', email: 'Ada@Example.com', email_verified: true, nonce: 'n1', name: 'Ada' });
  assert.deepEqual(await providers.verifyIdToken('google', aud, good, 'n1', { jwks }), {
    subject: '1001', email: 'ada@example.com', emailVerified: true, name: 'Ada',
  });
  await assert.rejects(providers.verifyIdToken('google', aud, good, 'other-nonce', { jwks }), { code: 'bad_token' });
  await assert.rejects(providers.verifyIdToken('google', 'another-client', good, 'n1', { jwks }), { code: 'bad_token' });
  const wrongIssuer = await sign({ sub: '1', nonce: 'n1' }, { issuer: 'https://evil.example' });
  await assert.rejects(providers.verifyIdToken('google', aud, wrongIssuer, 'n1', { jwks }), { code: 'bad_token' });
  const forged = `${good.slice(0, good.lastIndexOf('.'))}.${Buffer.from('nope').toString('base64url')}`;
  await assert.rejects(providers.verifyIdToken('google', aud, forged, 'n1', { jwks }), { code: 'bad_token' });
  // Apple says "true" as a string, and only Apple's issuer counts for Apple.
  const apple = await sign({ sub: '000.abc', email: 'x@privaterelay.appleid.com', email_verified: 'true', nonce: 'n2' },
    { issuer: 'https://appleid.apple.com', audience: 'com.example.web' });
  const claims = await providers.verifyIdToken('apple', 'com.example.web', apple, 'n2', { jwks });
  assert.equal(claims.emailVerified, true);
  await assert.rejects(providers.verifyIdToken('google', 'com.example.web', apple, 'n2', { jwks }), { code: 'bad_token' });
});

async function setUpNative(db, config = CONFIG) {
  await setUpGoogle(db, config);
  await providers.saveProvider(db, config, 'google', { appClientIds: '123-ios.apps.googleusercontent.com' }, 1);
  const { pem } = appleKeyPem();
  await providers.saveProvider(db, config, 'apple', {
    clientId: 'com.example.web', teamId: 'ABCDE12345', keyId: 'XYZ9876543', secret: pem,
    appClientIds: ['com.onhomeroom.app'], enabled: true,
  }, 1);
}

test('the app\'s client IDs: a list, checked, and offered to the app only beside a complete setup', async () => {
  const db = new FakeDb();
  await setUpGoogle(db);
  assert.deepEqual(await providers.offeredNativeProviders(db, CONFIG), [], 'no app client IDs yet');
  let view = await providers.saveProvider(db, CONFIG, 'google', { appClientIds: ' 123-ios.apps.googleusercontent.com\n\n123-ios.apps.googleusercontent.com, ' }, 1);
  let google = view.providers.find((p) => p.provider === 'google');
  assert.deepEqual(google.appClientIds, ['123-ios.apps.googleusercontent.com'], 'split, trimmed, once');
  assert.equal(google.nativeOffered, true);
  assert.deepEqual(await providers.offeredNativeProviders(db, CONFIG), ['google']);
  // Left out keeps them; a save that switches the provider off stops the app too.
  view = await providers.saveProvider(db, CONFIG, 'google', { enabled: false }, 1);
  google = view.providers.find((p) => p.provider === 'google');
  assert.deepEqual(google.appClientIds, ['123-ios.apps.googleusercontent.com']);
  assert.equal(google.nativeOffered, false);
  assert.deepEqual(await providers.offeredNativeProviders(db, CONFIG), []);
  await assert.rejects(providers.saveProvider(db, CONFIG, 'apple', { appClientIds: 'com.onhomeroom.app with spaces/' }, 1),
    { code: 'invalid_app_client_ids' });
  await assert.rejects(providers.saveProvider(db, CONFIG, 'google', { appClientIds: ['a', 'b', 'c', 'd', 'e', 'f'] }, 1),
    { code: 'invalid_app_client_ids' });
  await assert.rejects(providers.saveProvider(db, CONFIG, 'google', { appClientIds: 5 }, 1), { code: 'invalid_app_client_ids' });
  // Google's native tokens may also carry the web client (Android); Apple's carry the app alone.
  assert.deepEqual(providers.nativeAudiences('google', { clientId: 'web', appClientIds: ['ios'] }), ['ios', 'web']);
  assert.deepEqual(providers.nativeAudiences('apple', { clientId: 'com.example.web', appClientIds: ['com.onhomeroom.app'] }), ['com.onhomeroom.app']);
});

test('a native sign-in\'s state: hashed, single use, and spent only by the native route', async () => {
  const db = new FakeDb();
  await setUpGoogle(db);
  await assert.rejects(providers.beginNativeSignIn(db, CONFIG, 'google', {}), { code: 'not_offered' });
  await setUpNative(db);
  const begun = await providers.beginNativeSignIn(db, CONFIG, 'apple', { from: 'invite', followInvite: true });
  assert.match(begun.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(begun.nonce, /^[A-Za-z0-9_-]{22}$/);
  const row = db.states.get(sha256(begun.state));
  assert.deepEqual([row.native, row.follow_invite, row.started_from, row.nonce], [true, true, 'invite', begun.nonce]);
  assert.equal(await providers.consumeState(db, 'apple', begun.state, begun.binder), null, 'the web callback cannot spend it');
  const spent = await providers.consumeState(db, 'apple', begun.state, begun.binder, { native: true });
  assert.equal(spent.nonce, begun.nonce);
  assert.equal(await providers.consumeState(db, 'apple', begun.state, begun.binder, { native: true }), null, 'once');
  const web = await providers.beginSignIn(db, CONFIG, 'google', {});
  const webState = new URL(web.url).searchParams.get('state');
  assert.equal(await providers.consumeState(db, 'google', webState, web.binder, { native: true }), null, 'nor the other way round');
});

test('the native ID token: an app audience, the nonce as given or hashed, and spent once', async () => {
  const db = new FakeDb();
  await setUpNative(db);
  const { jwks, sign } = await idTokenKit();
  const state = { nonce: 'raw-nonce-1' };
  const apple = (claims, audience = 'com.onhomeroom.app') => sign(
    { sub: '000.abc', email: 'x@privaterelay.appleid.com', email_verified: 'true', ...claims },
    { issuer: 'https://appleid.apple.com', audience });
  // Apple: the SHA-256 of the nonce, as the app's sheet passes it.
  const good = await apple({ nonce: sha256('raw-nonce-1') });
  const claims = await providers.verifyNativeIdToken(db, CONFIG, 'apple', good, state, { jwks });
  assert.deepEqual(claims, { subject: '000.abc', email: 'x@privaterelay.appleid.com', emailVerified: true, name: null });
  await assert.rejects(providers.verifyNativeIdToken(db, CONFIG, 'apple', good, state, { jwks }), { code: 'bad_token' },
    'the same token twice');
  await assert.rejects(providers.verifyNativeIdToken(db, CONFIG, 'apple', await apple({ nonce: 'raw-nonce-2' }), state, { jwks }),
    { code: 'bad_token' }, 'another nonce');
  await assert.rejects(providers.verifyNativeIdToken(db, CONFIG, 'apple', await apple({}), state, { jwks }),
    { code: 'bad_token' }, 'Apple always carries the nonce');
  await assert.rejects(providers.verifyNativeIdToken(db, CONFIG, 'apple', await apple({ nonce: 'raw-nonce-1' }, 'com.example.web'), state, { jwks }),
    { code: 'bad_token' }, 'the web Services ID is not the app');
  // Google: the iOS client or the web client (Android), the nonce as given.
  const google = (claims, audience = '123-ios.apps.googleusercontent.com') => sign(
    { sub: 'g-1', email: 'ada@example.com', email_verified: true, ...claims }, { audience });
  assert.equal((await providers.verifyNativeIdToken(db, CONFIG, 'google', await google({ nonce: 'raw-nonce-1' }), state, { jwks })).subject, 'g-1');
  assert.equal((await providers.verifyNativeIdToken(db, CONFIG, 'google',
    await google({ nonce: 'raw-nonce-1' }, '123-abc.apps.googleusercontent.com'), state, { jwks })).subject, 'g-1');
  await assert.rejects(providers.verifyNativeIdToken(db, CONFIG, 'google', await google({ nonce: 'x' }), state, { jwks }), { code: 'bad_token' });
  await assert.rejects(providers.verifyNativeIdToken(db, CONFIG, 'google', await google({}, 'someone-else'), state, { jwks }), { code: 'bad_token' });
  // A Google sheet that carried no nonce: only while the token is fresh.
  const plain = await google({});
  assert.equal((await providers.verifyNativeIdToken(db, CONFIG, 'google', plain, state, { jwks })).subject, 'g-1');
  const later = Date.now() + (providers.NATIVE_FRESH_S + 30) * 1000;
  await assert.rejects(providers.verifyNativeIdToken(db, CONFIG, 'google', await google({}), state, { jwks, now: later }),
    { code: 'bad_token' }, 'too old to take without a nonce');
  await assert.rejects(providers.verifyNativeIdToken(db, CONFIG, 'google', 'not.a.token', state, { jwks }), { code: 'bad_token' });
  await assert.rejects(providers.verifyNativeIdToken(db, CONFIG, 'google', 'x'.repeat(9000), state, { jwks }), { code: 'bad_token' });
});

test('the exchange sends the code, the verifier and the client secret, and returns the verified claims', async () => {
  const db = new FakeDb();
  await setUpGoogle(db);
  const { jwks, sign } = await idTokenKit();
  const { url, binder } = await providers.beginSignIn(db, CONFIG, 'google', {});
  const state = await providers.consumeState(db, 'google', new URL(url).searchParams.get('state'), binder);
  const calls = [];
  const fetch = async (to, init) => {
    calls.push({ to, body: new URLSearchParams(init.body) });
    return { ok: true, status: 200, json: async () => ({ id_token: await sign({ sub: '42', email: 'b@example.com', email_verified: true, nonce: state.nonce }) }) };
  };
  const claims = await providers.exchangeCode(db, CONFIG, 'google', { code: 'the-code', state }, { fetch, jwks });
  assert.equal(claims.subject, '42');
  assert.equal(calls[0].to, 'https://oauth2.googleapis.com/token');
  const body = calls[0].body;
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'the-code');
  assert.equal(body.get('code_verifier'), state.code_verifier);
  assert.equal(body.get('client_secret'), 'GOCSPX-test_secret-1');
  assert.equal(body.get('redirect_uri'), 'https://app.example/api/auth/oauth/google/callback');

  const refusing = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  await assert.rejects(providers.exchangeCode(db, CONFIG, 'google', { code: 'x', state }, { fetch: refusing, jwks }), { code: 'provider_refused' });
  const down = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(providers.exchangeCode(db, CONFIG, 'google', { code: 'x', state }, { fetch: down, jwks }), { code: 'provider_unreachable' });
});

test('the console\'s check reads invalid_grant as credentials the provider accepts', async () => {
  const db = new FakeDb();
  assert.equal((await providers.checkSetup(db, CONFIG, 'google')).ok, false, 'nothing set up');
  await setUpGoogle(db);
  const answer = (status, error) => async () => ({ ok: false, status, json: async () => ({ error }) });
  assert.deepEqual(await providers.checkSetup(db, CONFIG, 'google', { fetch: answer(400, 'invalid_grant') }),
    { ok: true, message: 'Google accepts these credentials.' });
  const refused = await providers.checkSetup(db, CONFIG, 'google', { fetch: answer(401, 'invalid_client') });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /does not accept/);
});

test('the routes: public, guarded against a live session, admin-gated, and Apple\'s POST turned into the GET', () => {
  const routes = read('src/routes/sign-in-providers.js');
  assert.match(routes, /router\.get\('\/api\/auth\/oauth\/:provider\/start', oauthSignInLimiter,/);
  assert.match(routes, /router\.get\('\/api\/auth\/oauth\/:provider\/callback', oauthSignInLimiter,/);
  assert.match(routes, /'\/api\/auth\/oauth\/apple\/callback',\s+oauthSignInLimiter,\s+express\.urlencoded\(\{ extended: false, limit: '16kb' \}\),/);
  assert.match(routes, /return res\.redirect\(303, `\$\{providers\.callbackPath\('apple'\)\}\?\$\{params\.toString\(\)\}`\);/);
  assert.match(routes, /router\.post\('\/api\/auth\/oauth\/finish', otpVerifyLimiter,/);
  assert.match(routes, /router\.get\('\/api\/admin\/sign-in-providers', adminMiddleware,/);
  assert.match(routes, /router\.put\('\/api\/admin\/sign-in-providers\/:provider', adminMiddleware, requireAdminWrite,/);
  assert.match(routes, /router\.post\('\/api\/admin\/sign-in-providers\/:provider\/check', adminMiddleware, requireAdminWrite,/);
  // The invite is followed exactly as the email code follows it.
  assert.match(routes, /const consented = result\.created \|\| state\.follow_invite === true;/);
  // A new account is a sign-up in the events log, as an email code's,
  // an activation code's and a wallet's are (#4039).
  assert.match(routes, /events\.record\(pool, \{ type: events\.EVENT_TYPES\.USER_SIGNED_UP, userId: result\.userId, metadata: \{ via: provider \} \}\);/);
  assert.match(read('src/routes/auth.js'),
    /if \(verified\.created\) \{[\s\S]{0,400}events\.record\(pool, \{ type: events\.EVENT_TYPES\.USER_SIGNED_UP, userId: verified\.userId, metadata: \{ via: 'email' \} \}\);\s+\}/);
  // The outcome rides in a cookie, never the URL.
  assert.match(routes, /return res\.redirect\(303, providers\.safeReturnTo\(returnTo\)\);/);
  assert.match(read('server.js'), /app\.use\(authRoutes\(config\)\);\n\/\/ [^\n]+\napp\.use\(require\('\.\/src\/routes\/sign-in-providers'\)\.signInProviderRoutes\(config\)\);/);
  assert.match(read('src/middleware/auth.js'), /'\/api\/auth\/oauth\/',/);
  const mint = /const SESSION_MINT_PATHS = \[([\s\S]*?)\];/.exec(read('src/routes/auth.js'))[1];
  assert.match(mint, /'\/api\/auth\/oauth\/finish',/);
  assert.match(read('src/routes/public-api.js'), /sign_in_providers: await signInProviders\.offeredProviders\(pool, config\),/);
  // Inside the app: a state to start, the ID token to finish, which mints a
  // session like the email code, behind the same live-session refusal.
  assert.match(routes, /router\.post\('\/api\/auth\/oauth\/:provider\/native\/start', oauthSignInLimiter,/);
  assert.match(routes, /if \(typeof req\.body\?\.from !== 'string'\) return res\.status\(400\)/,
    'a form another site posts cannot start one');
  assert.match(routes, /router\.post\('\/api\/auth\/oauth\/:provider\/native', oauthSignInLimiter,/);
  assert.match(routes, /providers\.consumeState\(pool, provider, req\.body\?\.state, binder, \{ native: true \}\)/);
  assert.match(routes, /await afterSignIn\(req, res, provider, state, result\);/);
  assert.equal((routes.match(/await afterSignIn\(req, res, provider, state, result\);/g) || []).length, 2,
    'the web callback and the app do the same once the account is found or made');
  assert.match(mint, /'\/api\/auth\/oauth\/:provider\/native',/);
  assert.match(read('src/routes/public-api.js'), /native_sign_in_providers: await signInProviders\.offeredNativeProviders\(pool, config\),/);
});

test('the secrets stay out of the debug role, the SQL console, staging and a merge', () => {
  const schema = read('src/db/schema.sql');
  for (const table of ['sign_in_providers', 'user_oauth_identities', 'oauth_sign_in_states', 'oauth_signup_sessions', 'native_sign_in_tokens']) {
    assert.match(schema, new RegExp(`COMMENT ON TABLE ${table} IS 'staging:private';`));
  }
  const debugAccess = require('../src/services/debug-access');
  for (const table of ['sign_in_providers', 'oauth_sign_in_states', 'oauth_signup_sessions', 'native_sign_in_tokens']) {
    assert.ok(debugAccess.DENIED_TABLES.has(table), table);
  }
  assert.match(read('src/services/topochain/db-console-scope.js'), /sign_in_providers: \['secret_enc'\],/);
  assert.match(read('src/services/user-merge.js'), /'oauth_signup_sessions',/);
});

test('the sheet: Apple and Google first when offered, then email; the trip carries what the sheet knew', () => {
  const sheet = loadTsx('frontend/src/features/auth/sign-in-sheet.tsx');
  assert.equal(
    sheet.providerStartUrl('google', { from: 'invite', followInvite: true, returnTo: '/invite/AAAAAAAAAAAAAAAAAAAAAA' }),
    '/api/auth/oauth/google/start?from=invite&return=%2Finvite%2FAAAAAAAAAAAAAAAAAAAAAA&follow=1',
  );
  assert.equal(sheet.providerStartUrl('apple', { from: 'story', followInvite: false, returnTo: '/' }),
    '/api/auth/oauth/apple/start?from=story&return=%2F');
  assert.equal(sheet.resumeError('username'), null);
  assert.equal(sheet.resumeError('error-cancelled'), 'Sign-in was cancelled.');
  assert.match(sheet.resumeError('error-no_verified_email'), /no verified email/);
  assert.equal(sheet.resumeError('error-something_new'), 'That did not work. Try again, or use your email.');
  const src = read('frontend/src/features/auth/sign-in-sheet.tsx');
  // Apple and Google first, unless the invite's Join starts with the phone
  // (tests/phone-invite-join.test.js), when they sit under it past an "or".
  assert.match(src, /const otherWays: Step = providers\.length \? 'choose' : 'email';\s+const firstStep: Step = phone \? 'phone' : otherWays;/);
  assert.match(src, /\{t\('auth:signInSheet\.continueWith', \{ provider: PROVIDER_LABEL\[provider\] \}\)\}/);
  assert.equal(message('auth:signInSheet.continueWith', { provider: 'Apple' }), 'Continue with Apple');
  assert.match(src, /: t\('auth:signInSheet\.continueWithEmail'\)\}/);
  assert.equal(message('auth:signInSheet.continueWithEmail'), 'Continue with email');
  assert.match(src, /fetchSessionMint\(usernameVia === 'phone' \? '\/api\/auth\/phone\/finish' : '\/api\/auth\/oauth\/finish',/);
  const icons = read('frontend/@/components/ui/icons.tsx');
  assert.match(icons, /export const AppleIcon = filled\(/);
  assert.match(icons, /export const GoogleIcon = \(/);
});

test('the landing offers what the options list, never inside the app, and reopens the sheet on the way back', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /if \(!list\.length \|\| typeof window === 'undefined' \|\| isNative\(\)\) return \[\];/);
  assert.match(landing, /return \(\['apple', 'google'\] as const\)\.filter\(\(p\) => list\.includes\(p\)\);/);
  assert.match(landing, /document\.cookie = `\$\{PROVIDER_RESULT_COOKIE\}=; Max-Age=0; path=\/`;/);
  assert.match(landing, /setSheet\(inviteTokenFrom\(location\.pathname\) \? 'join' : 'start'\);/);
  assert.match(landing, /from="invite"\s+returnTo=\{location\.pathname\}/);
  // Back to Home, or to the public project's page the sheet was opened over
  // (features/guest), so a provider's trip lands where the visitor was.
  assert.match(landing, /from=\{sheet === 'signin' \? 'signin' : 'story'\}\s+returnTo=\{guestProject \? `\/\$\{projectHash\(guestProject\.slug\)\}` : '\/'\}/);
  assert.match(landing, /from="signin"\s+returnTo=\{`\/\$\{projectHash\(intent\.app\.slug\)\}`\}/,
    'a project page\'s Join, Vote or Ask comes back to that page');
});

test('inside the app: the app\'s own sheet, offered where the server lists it and the build can show it', async () => {
  const landing = loadTsx('frontend/src/features/auth/landing.tsx');
  const options = { sign_in_providers: ['apple', 'google'], native_sign_in_providers: ['apple', 'google'] };
  assert.deepEqual(landing.nativeSignInProvidersFrom(options, ['signInWithApple', 'signInWithGoogle']), ['apple', 'google']);
  assert.deepEqual(landing.nativeSignInProvidersFrom(options, ['signInWithGoogle']), ['google'], 'only what this build can show');
  assert.deepEqual(landing.nativeSignInProvidersFrom({ native_sign_in_providers: ['google'] }, ['signInWithApple', 'signInWithGoogle']), ['google'],
    'only what the server lists');
  assert.deepEqual(landing.nativeSignInProvidersFrom(null, ['signInWithApple']), []);
  const src = read('frontend/src/features/auth/landing.tsx');
  assert.match(src, /const providers = nativeSignIn \? nativeProviders : webProviders;/);
  assert.equal((src.match(/native=\{nativeSignIn\}/g) || []).length, 4, 'all four sheets: the invite\'s, the story\'s, a shared link\'s (#5264) and a public project page\'s (features/guest)');

  // The sheet's native path: start, the app's sheet with the nonce, the token back.
  const sheet = loadTsx('frontend/src/features/auth/sign-in-sheet.tsx');
  const calls = [];
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  let bridgeAnswer = async () => ({ idToken: 'id.token.here' });
  globalThis.window = { usernode: { isNative: false, signInWithProvider: (o) => { calls.push(['bridge', o]); return bridgeAnswer(); } } };
  const replies = [];
  globalThis.fetch = async (url, init) => {
    calls.push(['fetch', url, JSON.parse(init.body)]);
    const [status, body] = replies.shift();
    return { ok: status < 400, status, json: async () => body };
  };
  try {
    replies.push([200, { state: 's1', nonce: 'n1' }], [200, { next: 'signed-in', created: false }]);
    assert.deepEqual(await sheet.signInNatively('apple', { from: 'invite', followInvite: true }), { next: 'signed-in', created: false });
    assert.deepEqual(calls, [
      ['fetch', '/api/auth/oauth/apple/native/start', { from: 'invite', follow: true }],
      ['bridge', { provider: 'apple', nonce: 'n1' }],
      ['fetch', '/api/auth/oauth/apple/native', { state: 's1', idToken: 'id.token.here' }],
    ]);
    replies.push([200, { state: 's2', nonce: 'n2' }], [200, { next: 'username', created: true }]);
    assert.deepEqual(await sheet.signInNatively('google', { from: 'story', followInvite: false }), { next: 'username' });
    replies.push([200, { state: 's3', nonce: 'n3' }], [422, { code: 'no_verified_email' }]);
    assert.match((await sheet.signInNatively('google', { from: 'story', followInvite: false })).error, /no verified email/);
    // Closing the app's sheet says nothing.
    bridgeAnswer = async () => { const err = new Error('closed'); err.usernodeCode = 'cancelled'; throw err; };
    replies.push([200, { state: 's4', nonce: 'n4' }]);
    assert.deepEqual(await sheet.signInNatively('apple', { from: 'story', followInvite: false }), { error: null });
    replies.push([409, { code: 'logout_required' }]);
    assert.match((await sheet.signInNatively('apple', { from: 'story', followInvite: false })).error, /already signed in/);
  } finally {
    globalThis.window = priorWindow;
    globalThis.fetch = priorFetch;
  }
  const sheetSrc = read('frontend/src/features/auth/sign-in-sheet.tsx');
  assert.match(sheetSrc, /if \(!native\) \{\n\s+window\.location\.assign\(providerStartUrl/);
  assert.match(sheetSrc, /await finish\(outcome\.created \? 'new' : 'existing'\);/);
});

test('the console section is registered like its neighbours', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  assert.match(consoleJs, /\{ key: 'sign-in', label: 'Sign-in providers', group: 'Platform' \}/);
  assert.match(consoleJs, /'sign-in': 'AdminSignIn'/);
  assert.match(consoleJs, /'sign-in': '<svg/);
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-sign-in\.tsx';/);
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/sign-in' \}/);
  assert.match(audit, /'#admin\/sign-in'/);
  const section = read('frontend/src/features/admin/admin-sign-in.tsx');
  // The callback address is for pasting, never a link.
  assert.doesNotMatch(section, /<a\s/);
  assert.match(section, /<code id=\{`\$\{id\}-callback`\}/);
});
