// Guests at a public app's own address (P15): people with no Homeroom
// account may look around every public app, read-only; every write needs
// an account and asks for one.
//
// What it pins, by running the real code:
//   * the guest token: ES256 under a key of its own, audience
//     `usernode:app:<id>:guest`, `pur: 'guest'`, `guest: true`, no id or
//     username, and refused by EVERY verifier written for a person's token,
//     the frozen pre-cutover scaffold (no options at all) included;
//   * the app-host gate (src/services/edge-gate.js): a guest is admitted to
//     every view-public app at its production address, never to a private
//     app or a preview, and no dapp.json key turns that off; a guest's
//     browser write is refused with 401 account_required; the account links
//     go to the platform and come back through the authorize hop;
//   * the platform's own services (AI, storage, the user directory) refuse a
//     guest token with account_required;
//   * the scaffold: a guest reads, a guest's write is 401 account_required;
//   * the bridge sheet appears on account_required (unit level).
//
// Run with: node --test tests/app-host-guests.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

process.env.EDGE_JWT_SECRET = 'app-host-guests-test-edge-secret';
delete process.env.APP_HOST_SIGNIN;
const keys = require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const DOMAIN = 'social-vibecoding.usernodelabs.org';
const GUEST_HOST = `guestapp.${DOMAIN}`;
const PLAIN_HOST = `pubapp.${DOMAIN}`;
const PRIV_HOST = `privapp.${DOMAIN}`;
const GUEST_APP_ID = 3;
const PUB_APP_ID = 1;
const PRIV_APP_ID = 7;
const MEMBER_ID = 10;
const SESSION_TOKEN = 'a'.repeat(64);
const SID = crypto.createHash('sha256').update(SESSION_TOKEN).digest('hex');

// ── The guest token ────────────────────────────────────────────────────

test('a guest token names no person and only a guest verifier accepts it', () => {
  const g = platformJwt.signGuestToken({ appId: GUEST_APP_ID });
  const header = JSON.parse(Buffer.from(g.split('.')[0], 'base64url'));
  assert.equal(header.alg, 'ES256');
  const claims = platformJwt.verifyGuestToken(g, { appId: GUEST_APP_ID });
  assert.equal(claims.guest, true);
  assert.equal(claims.pur, 'guest');
  assert.equal(claims.aud, `usernode:app:${GUEST_APP_ID}:guest`);
  assert.equal(claims.id, undefined);
  assert.equal(claims.username, undefined);

  assert.throws(() => platformJwt.verifyAppIdentityToken(g, { appId: GUEST_APP_ID }), 'the platform’s person verifier');
  assert.throws(() => jwt.verify(g, keys.IFRAME_JWT_PUBLIC_KEY,
    { algorithms: ['RS256'], issuer: 'usernode', audience: `usernode:app:${GUEST_APP_ID}` }), 'the current scaffold’s');
  assert.throws(() => jwt.verify(g, keys.IFRAME_JWT_PUBLIC_KEY), 'a pre-cutover scaffold’s, which checks nothing but the signature');
  assert.throws(() => platformJwt.verifyGuestToken(g, { appId: GUEST_APP_ID + 1 }), 'another app');
  assert.throws(() => platformJwt.verifyGuestToken(
    platformJwt.signAppIdentityToken({ appId: GUEST_APP_ID, user: { id: 1, username: 'a' } }), { appId: GUEST_APP_ID },
  ), 'a person’s token is not a guest token');
});

test('the guest key is derived, not stored: every platform process signs alike', () => {
  const pem = platformJwt.guestPublicKeyPem();
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----/);
  delete require.cache[require.resolve('../src/services/platform-jwt')];
  const again = require('../src/services/platform-jwt');
  assert.equal(again.guestPublicKeyPem(), pem);
  const { appIdentityEnv } = require('../src/services/app-identity-env');
  assert.equal(appIdentityEnv({ id: 9 }).USERNODE_GUEST_JWT_PUBLIC_KEY, pem, 'apps are given its public half');
  const manifest = require('../src/services/app-manifest');
  assert.ok(manifest.RESERVED_KEYS.has('USERNODE_GUEST_JWT_PUBLIC_KEY'), 'and no dapp.json can shadow it');
});

test('there is no opt-in: a dapp.json `guests` key turns nothing on or off', () => {
  const manifest = require('../src/services/app-manifest');
  assert.equal(manifest.readGuests, undefined, 'no reader for it');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'guests-'));
  for (const v of [true, false]) {
    fs.writeFileSync(path.join(dir, 'dapp.json'), JSON.stringify({ guests: v, secrets: [] }));
    assert.equal('guests' in manifest.read(dir), false, `guests: ${v} is not carried into the manifest`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'edge-gate.js'), 'utf8'), /manifest_snapshot/,
    'the gate reads no per-app switch');
});

// ── The gate ───────────────────────────────────────────────────────────

const APPS = {
  guestapp: { id: GUEST_APP_ID, view_visibility: 'public' },
  pubapp: { id: PUB_APP_ID, view_visibility: 'public' },
  privapp: { id: PRIV_APP_ID, view_visibility: 'private' },
};
const byId = (id) => Object.values(APPS).find((a) => a.id === Number(id));
const live = new Set([`${SID}:${MEMBER_ID}`]);
const fakePool = {
  async query(sql, params = []) {
    if (/FROM user_app_blocks/.test(sql)) return { rows: [] };
    if (/SELECT id, view_visibility, moderation_suspended_at FROM apps WHERE slug/.test(sql)) {
      const a = APPS[params[0]];
      return { rows: a ? [{ id: a.id, view_visibility: a.view_visibility }] : [] };
    }
    if (/SELECT view_visibility, moderation_suspended_at FROM apps WHERE id/.test(sql)) {
      const a = byId(params[0]);
      return { rows: a ? [{ view_visibility: a.view_visibility }] : [] };
    }
    if (/FROM app_collaborators WHERE app_id = \$1 AND status = 'member'/.test(sql)) return { rows: [{ user_id: MEMBER_ID }] };
    if (/SELECT is_admin FROM users WHERE id/.test(sql)) return { rows: [{ is_admin: false }] };
    if (/FROM sessions\s+WHERE encode/.test(sql)) return { rows: live.has(`${params[0]}:${params[1]}`) ? [{}] : [] };
    if (/SELECT id, username, usernode_pubkey, locale, is_synthetic,\s+username_provisional_since IS NOT NULL AS provisional\s+FROM users/.test(sql)) {
      return { rows: [{ id: params[0], username: `u${params[0]}`, is_synthetic: false }] };
    }
    if (/INSERT INTO edge_grant_redemptions/.test(sql)) return { rows: [{ jti: params[0] }] };
    throw new Error(`guests stub: unexpected query: ${sql}`);
  },
};
const poolPath = require.resolve('../src/db/pool');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => fakePool } };
for (const m of ['../src/services/app-access', '../src/services/edge-gate', '../src/routes/internal']) {
  delete require.cache[require.resolve(m)];
}
const appAccess = require('../src/services/app-access');
const edgeGate = require('../src/services/edge-gate');
const { internalRoutes } = require('../src/routes/internal');

let server; let baseUrl;
test.before(async () => {
  const app = express();
  app.use(cookieParser());
  app.use(internalRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  appAccess.invalidateAllVisibility();
  edgeGate._resetCachesForTest();
  delete process.env.APP_HOST_SIGNIN;
});

function gate({ host, uri = '/', method = 'GET', cookie, token, authorization, dest, site, origin } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/__caddy/access`, {
      headers: {
        Host: host, 'X-Forwarded-Host': host, 'X-Forwarded-Method': method, 'X-Forwarded-Uri': uri,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { 'x-usernode-token': token } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
        ...(dest ? { 'Sec-Fetch-Dest': dest } : {}),
        ...(site ? { 'Sec-Fetch-Site': site } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const guestOf = (r) => r.headers['x-usernode-identity']
  && platformJwt.orNull(() => platformJwt.verifyGuestToken(r.headers['x-usernode-identity'], { appId: GUEST_APP_ID }));
const memberCookie = (host, appId) => `__usernode_access=${platformJwt.signEdgeCookie({ uid: MEMBER_ID, appId, host, sid: SID })}`;

test('a visitor with no account is admitted to a public app, as a guest', async () => {
  const r = await gate({ host: GUEST_HOST, site: 'same-origin', dest: 'empty', cookie: '__usernode_anon=1' });
  assert.equal(r.status, 200);
  assert.ok(guestOf(r), 'a guest token for this app');
  // A visit after the hop answered "no session" opens the page as a guest.
  const page = await gate({ host: GUEST_HOST, dest: 'document', site: 'none', cookie: '__usernode_anon=1' });
  assert.equal(page.status, 200);
  assert.ok(guestOf(page));
  // The first visit still asks the apex whether they are signed in.
  const first = await gate({ host: GUEST_HOST, dest: 'document' });
  assert.equal(first.status, 302);
});

test('every public app has guests; never a private app, a preview or a sibling request', async () => {
  const plain = await gate({ host: PLAIN_HOST, site: 'same-origin' });
  assert.equal(plain.status, 200);
  assert.ok(platformJwt.orNull(() => platformJwt.verifyGuestToken(plain.headers['x-usernode-identity'], { appId: PUB_APP_ID })),
    'any public app, with nothing in its dapp.json');
  const priv = await gate({ host: PRIV_HOST, site: 'same-origin' });
  assert.equal(priv.status, 302, 'a private app stays members-only');
  const preview = await gate({ host: `guestapp--s42.${DOMAIN}`, site: 'same-origin' });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['x-usernode-identity'], undefined, 'a preview never admits guests');
  const sibling = await gate({ host: GUEST_HOST, site: 'same-site', dest: 'empty', origin: `https://evil.${DOMAIN}` });
  assert.equal(sibling.headers['x-usernode-identity'], undefined, 'not on a sibling app’s request');
  process.env.APP_HOST_SIGNIN = 'off';
  edgeGate._resetCachesForTest();
  assert.equal((await gate({ host: GUEST_HOST, site: 'same-origin' })).headers['x-usernode-identity'], undefined);
});

test('a guest’s write is refused with 401 account_required', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await gate({ host: GUEST_HOST, method, origin: `https://${GUEST_HOST}`, site: 'same-origin' });
    assert.equal(r.status, 401, method);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(r.body), { error: 'account_required', message: 'Make an account to continue.' });
  }
});

test('a request carrying its own credential is the app’s to judge, valid or not', async () => {
  // Guests are on for every public app, so the gate must not second-guess
  // how an existing app sends its person's token: anything carried passes
  // untouched, exactly as before guests existed, and the app decides. A
  // carried guest token is refused by the app itself (the scaffold test).
  const origin = `https://${GUEST_HOST}`;
  for (const [label, opts] of [
    ['a guest token', { token: platformJwt.signGuestToken({ appId: GUEST_APP_ID }) }],
    ['an expired or foreign token', { token: 'not-a-token' }],
    ['an iframe token in the query', { uri: '/api/save?token=x' }],
    ['an Authorization header', { authorization: 'Bearer abc' }],
  ]) {
    const r = await gate({ host: GUEST_HOST, method: 'POST', origin, site: 'same-origin', ...opts });
    assert.equal(r.status, 200, label);
    assert.equal(r.headers['x-usernode-identity'], undefined, `${label}: nothing is added over it`);
  }
});

test('what still writes: a person, a server-to-server call, a preflight', async () => {
  const person = await gate({
    host: GUEST_HOST, method: 'POST', origin: `https://${GUEST_HOST}`, site: 'same-origin',
    cookie: memberCookie(GUEST_HOST, GUEST_APP_ID),
  });
  assert.equal(person.status, 200);
  assert.equal(platformJwt.verifyAppIdentityToken(person.headers['x-usernode-identity'], { appId: GUEST_APP_ID }).id, MEMBER_ID);
  const ownToken = await gate({
    host: GUEST_HOST, method: 'POST', origin: `https://${GUEST_HOST}`,
    token: platformJwt.signAppIdentityToken({ appId: GUEST_APP_ID, user: { id: MEMBER_ID, username: 'm' } }),
  });
  assert.equal(ownToken.status, 200, 'the shell’s frame forwarding a person’s token');
  const webhook = await gate({ host: GUEST_HOST, method: 'POST' });
  assert.equal(webhook.status, 200, 'no Origin, no Sec-Fetch-Site: the app’s to answer');
  assert.equal(webhook.headers['x-usernode-identity'], undefined);
  assert.equal((await gate({ host: GUEST_HOST, method: 'OPTIONS', origin: 'https://x.example' })).status, 200);
});

test('the anonymous answer marks a guest for the bridge; signing in clears it', async () => {
  const anon = platformJwt.signEdgeAnon({ host: GUEST_HOST });
  const r = await gate({ host: GUEST_HOST, uri: `/__usernode_access?anon=${encodeURIComponent(anon)}&next=%2F` });
  const hint = (r.headers['set-cookie'] || []).find((c) => c.startsWith('__usernode_guest=1'));
  assert.ok(hint, 'the hint is set');
  assert.doesNotMatch(hint, /HttpOnly/, 'readable by the bridge, on purpose');
  const plain = await gate({ host: PLAIN_HOST, uri: `/__usernode_access?anon=${encodeURIComponent(platformJwt.signEdgeAnon({ host: PLAIN_HOST }))}&next=%2F` });
  assert.ok((plain.headers['set-cookie'] || []).some((c) => c.startsWith('__usernode_guest=1')), 'on every public app');
  const priv = await gate({ host: PRIV_HOST, uri: `/__usernode_access?anon=${encodeURIComponent(platformJwt.signEdgeAnon({ host: PRIV_HOST }))}&next=%2F` });
  assert.ok(!(priv.headers['set-cookie'] || []).some((c) => c.startsWith('__usernode_guest=')), 'never on a private app');

  const code = platformJwt.signEdgeGrant({ uid: MEMBER_ID, appId: GUEST_APP_ID, host: GUEST_HOST, sid: SID });
  const signedIn = await gate({ host: GUEST_HOST, uri: `/__usernode_access?code=${encodeURIComponent(code)}&next=%2F` });
  assert.ok((signedIn.headers['set-cookie'] || []).some((c) => /^__usernode_guest=;/.test(c)), 'cleared on sign-in');
});

test('the account links go to the platform and come back through the authorize hop', async () => {
  const up = await gate({ host: GUEST_HOST, uri: '/__usernode_access?account=signup&next=%2Fphotos%3Fp%3D2' });
  assert.equal(up.status, 302);
  const loc = new URL(up.headers.location);
  assert.equal(loc.origin, `https://${DOMAIN}`);
  assert.equal(loc.hash, '#signup');
  const back = new URL(loc.searchParams.get('return_to'), `https://${DOMAIN}`);
  assert.equal(back.pathname, '/__access/authorize');
  assert.equal(back.searchParams.get('host'), GUEST_HOST);
  assert.equal(back.searchParams.get('next'), '/photos?p=2');
  const inn = await gate({ host: GUEST_HOST, uri: '/__usernode_access?account=signin&next=%2F' });
  assert.equal(new URL(inn.headers.location).hash, '#login');
  const evil = await gate({ host: GUEST_HOST, uri: '/__usernode_access?account=signup&next=%2F%2Fevil.com' });
  assert.equal(new URL(new URL(evil.headers.location).searchParams.get('return_to'), `https://${DOMAIN}`).searchParams.get('next'), '/');
  const preview = await gate({ host: `guestapp--s42.${DOMAIN}`, uri: '/__usernode_access?account=signup&next=%2F' });
  assert.equal(preview.headers.location, `https://${DOMAIN}/`);
});

test('the platform’s sign-in returns to the authorize hop, and only by its path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'auth-screens.js'), 'utf8');
  const list = src.match(/const RETURN_TO_PATHS = \[([\s\S]*?)\];/)[1];
  assert.match(list, /'\/__access\/authorize'/);
});

// ── The platform's own services ────────────────────────────────────────

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const APP_TOKEN = 'c'.repeat(64);
const servicePool = {
  async query(sql, params) {
    if (/FROM apps WHERE (llm_proxy_token|storage_api_token)/.test(sql)) {
      return { rows: params[0] === APP_TOKEN
        ? [{ id: GUEST_APP_ID, slug: 'guestapp', llm_proxy_token: APP_TOKEN, storage_api_token: APP_TOKEN }]
        : [] };
    }
    if (/SELECT id, slug FROM apps WHERE id = \$1/.test(sql)) return { rows: [{ id: GUEST_APP_ID, slug: 'guestapp' }] };
    return { rows: [] };
  },
};
async function runMw(mw, headers) {
  const res = fakeRes();
  let nexted = false;
  await mw({ headers, socket: { remoteAddress: '10.0.0.5' }, path: '/x' }, res, () => { nexted = true; });
  return { res, nexted };
}

test('AI, storage and the user directory refuse a guest with account_required', async () => {
  delete require.cache[require.resolve('../src/middleware/app-llm-auth')];
  delete require.cache[require.resolve('../src/middleware/app-storage-auth')];
  const { appLlmAuth, appPlatformAuth } = require('../src/middleware/app-llm-auth');
  const { appStorageAuth } = require('../src/middleware/app-storage-auth');
  const guest = platformJwt.signGuestToken({ appId: GUEST_APP_ID });
  const headers = { 'x-usernode-app-token': APP_TOKEN, 'x-usernode-user-token': guest };
  for (const [label, mw] of [
    ['AI', appLlmAuth(servicePool)],
    ['storage', appStorageAuth(servicePool)],
    ['platform API with an app token', appPlatformAuth(servicePool, { requireUser: true })],
  ]) {
    const { res, nexted } = await runMw(mw, headers);
    assert.equal(nexted, false, label);
    assert.equal(res.statusCode, 401, label);
    assert.equal(res.body.code, 'account_required', label);
  }
  const directory = appPlatformAuth(servicePool, { requireUser: true, allowUserTokenOnly: true });
  const { res, nexted } = await runMw(directory, { 'x-usernode-user-token': guest });
  assert.equal(nexted, false);
  assert.equal(res.body.code, 'account_required', 'the user directory, user-token-only (previews)');
});

// ── The scaffold ───────────────────────────────────────────────────────

function loadScaffoldMiddleware(source, env) {
  const middlewares = [];
  const routes = [];
  const app = {
    use: (...args) => { const fn = args[args.length - 1]; if (typeof fn === 'function' && fn.length >= 3) middlewares.push(fn); },
    get: (p, ...h) => routes.push(['GET', p, h[h.length - 1]]),
    post: () => {},
    listen: (_port, cb) => { if (typeof cb === 'function') cb(); return {}; },
  };
  const expressStub = () => app;
  expressStub.json = () => '__json__';
  expressStub.static = () => '__static__';
  const fakeRequire = (id) => {
    if (id === 'express') return expressStub;
    if (id === 'path') return require('path');
    if (id === 'jsonwebtoken') return jwt;
    if (id === 'pg') return { Pool: class { async query() { return { rows: [] }; } } };
    throw new Error(`scaffold sandbox: unexpected require(${id})`);
  };
  // eslint-disable-next-line no-new-func
  new Function('require', 'process', '__dirname', 'console', source)(
    fakeRequire, { env, exit: () => {}, cwd: () => process.cwd(), on: () => {} }, __dirname, { log: () => {}, error: () => {}, warn: () => {} }
  );
  return { auth: middlewares[0], routes };
}

function call(mw, { method = 'GET', path: p = '/', token } = {}) {
  const req = { query: {}, headers: token ? { 'x-usernode-token': token } : {}, method, path: p };
  const out = { status: null, body: null, next: false };
  const res = {
    status(s) { out.status = s; return res; }, json(b) { out.body = b; return res; },
    send() { return res; }, redirect() { return res; }, sendFile() { return res; }, type() { return res; },
  };
  mw(req, res, () => { out.next = true; });
  return { ...out, req };
}

test('the scaffold: a guest reads, a guest’s write is account_required, a forged guest is nobody', () => {
  const { getTemplateFiles } = require('../src/services/template.js');
  const { appIdentityEnv } = require('../src/services/app-identity-env');
  const files = getTemplateFiles('Guests', 'guests-1a2b3c', 'postgres://x', null, {});
  assert.equal('guests' in JSON.parse(files.find((f) => f.path === 'dapp.json').content), false, 'nothing to opt in to');
  const source = files.find((f) => f.path === 'server.js').content;
  const env = { PORT: '3000', DATABASE_URL: 'postgres://x', ...appIdentityEnv({ id: GUEST_APP_ID }) };
  const { auth } = loadScaffoldMiddleware(source, env);
  const guest = platformJwt.signGuestToken({ appId: GUEST_APP_ID });

  const read = call(auth, { path: '/api/leaderboard', token: guest });
  assert.equal(read.next, true);
  assert.equal(read.req.guest, true);
  assert.equal(read.req.user, undefined, 'a guest is never req.user');
  const write = call(auth, { method: 'POST', path: '/api/press', token: guest });
  assert.equal(write.status, 401);
  assert.deepEqual(write.body, { error: 'account_required' });
  const other = call(auth, { path: '/api/leaderboard', token: platformJwt.signGuestToken({ appId: GUEST_APP_ID + 1 }) });
  assert.equal(other.status, 401, 'another app’s guest is nobody here');
  assert.deepEqual(other.body, { error: 'Not authenticated' });
  const person = call(auth, { method: 'POST', path: '/api/press', token: platformJwt.signAppIdentityToken({ appId: GUEST_APP_ID, user: { id: 4, username: 'p' } }) });
  assert.equal(person.next, true);
  assert.equal(person.req.user.id, 4);
});

test('starter read routes do not assume a person', () => {
  // The four starters under app-templates/ were deleted with the create
  // dialog (tests/app-templates.test.js); a starter that comes back is held
  // to the same rule, so the loop reads whatever directories are there.
  const dir = path.join(__dirname, '..', 'app-templates');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (const name of names) {
    const src = fs.readFileSync(path.join(dir, name, 'api.js'), 'utf8');
    for (const m of src.matchAll(/app\.get\([^]*?\n {2}\}\);/g)) {
      assert.doesNotMatch(m[0].replace(/req\.user \? req\.user\.(id|username) : null|!!req\.user && [^,]+|req\.user \? \{[^}]*\} : null/g, ''),
        /req\.user\./, `${name}: a read route reads req.user without a guard`);
    }
  }
});

// ── The bridge sheet (unit level) ──────────────────────────────────────

const BRIDGE = ['public/usernode-bridge/v1/bridge.js', 'public/usernode-bridge.js'];
function guestBlock(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const a = src.indexOf('/* __USERNODE_GUEST_START__ */');
  const b = src.indexOf('/* __USERNODE_GUEST_END__ */');
  assert.ok(a > 0 && b > a, `${file}: guest block markers`);
  return src.slice(a, b);
}

function makeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(), children: [], parentNode: null, attributes: {}, listeners: {},
    hidden: false, textContent: '', className: '', id: '',
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    click() { for (const fn of this.listeners.click || []) fn({}); },
    focus() {},
  };
  if (tag === 'div') {
    el.attachShadow = function attachShadow() {
      this._shadow = { children: [], appendChild(c) { this.children.push(c); return c; } };
      return this._shadow;
    };
  }
  return el;
}
const tick = () => new Promise((r) => setImmediate(r));

async function runBridge(file, { inIframe = false, cookie = '', responses = {} } = {}) {
  const body = makeElement('body');
  const listeners = {};
  const document = {
    body, cookie, title: 'Photo Wall', readyState: 'complete',
    createElement: makeElement,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
  };
  const location = { href: 'https://photo-wall.example.org/feed?x=1', origin: 'https://photo-wall.example.org', pathname: '/feed', search: '?x=1' };
  const makeRes = (url) => {
    const r = responses[url] || { status: 200, type: 'application/json', body: {} };
    return {
      status: r.status,
      headers: { get: (n) => (n.toLowerCase() === 'content-type' ? r.type : null) },
      clone() { return { json: async () => r.body }; },
      json: async () => r.body,
    };
  };
  const window = {
    document, location, URL,
    fetch: (url) => Promise.resolve(makeRes(new URL(url, location.href).href)),
    usernode: {},
  };
  window.window = window;
  const sandbox = { window, document, location, URL, Promise, setImmediate };
  vm.createContext(sandbox);
  vm.runInContext(`(function (_inIframe, _hasNativeChannel) {\n${guestBlock(file)}\n})(${inIframe}, false);`, sandbox);
  const host = () => body.children.find((c) => c.id === '__un-guest') || null;
  const parts = () => {
    const h = host();
    if (!h) return null;
    const all = h._shadow.children.flatMap(function walk(c) { return [c, ...c.children.flatMap(walk)]; });
    const by = (cls) => all.find((e) => e.className === cls);
    return { all, sheet: by('sheet'), strip: by('strip'), title: by('title'), text: by('text') };
  };
  return { window, parts, tick };
}

for (const file of BRIDGE) {
  test(`${file}: an account_required answer to the app’s own request opens the sheet`, async () => {
    const env = await runBridge(file, {
      responses: { 'https://photo-wall.example.org/api/photos': { status: 401, type: 'application/json', body: { error: 'account_required' } } },
    });
    assert.equal(env.parts(), null, 'nothing until it is needed');
    const res = await env.window.fetch('/api/photos', { method: 'POST' });
    assert.equal(res.status, 401, 'the app still gets its answer, untouched');
    for (let i = 0; i < 5; i += 1) await tick();
    const p = env.parts();
    assert.ok(p, 'drawn');
    assert.equal(p.sheet.hidden, false);
    assert.equal(p.title.textContent, 'Make an account to continue');
    assert.equal(p.text.textContent, 'It takes a minute, and you’ll come straight back to Photo Wall.'.replace('’', "'"));
    const labels = p.all.filter((e) => e.className.startsWith('btn')).map((e) => e.textContent);
    assert.deepEqual(labels, ['Continue with email', 'I have an account', 'Keep looking around']);
    const email = p.all.find((e) => e.textContent === 'Continue with email');
    assert.equal(email.href, '/__usernode_access?account=signup&next=%2Ffeed%3Fx%3D1', 'back to this very page');
    assert.equal(p.all.find((e) => e.textContent === 'I have an account').href, '/__usernode_access?account=signin&next=%2Ffeed%3Fx%3D1');
    p.all.find((e) => e.textContent === 'Keep looking around').click();
    assert.equal(p.sheet.hidden, true, 'and it lets them keep looking');
  });
}

test('the sheet names the action when the app does, and ignores everything else', async () => {
  const env = await runBridge(BRIDGE[0], {
    responses: {
      'https://photo-wall.example.org/api/a': { status: 401, type: 'application/json', body: { error: 'account_required', action: 'post a photo' } },
      'https://photo-wall.example.org/api/b': { status: 401, type: 'application/json', body: { error: 'Not authenticated' } },
      'https://photo-wall.example.org/api/c': { status: 403, type: 'application/json', body: { error: 'account_required' } },
      'https://other.example/api/d': { status: 401, type: 'application/json', body: { error: 'account_required' } },
    },
  });
  for (const u of ['/api/b', '/api/c', 'https://other.example/api/d']) await env.window.fetch(u);
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(env.parts(), null, 'other errors, other statuses and other origins open nothing');
  await env.window.fetch('/api/a');
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(env.parts().title.textContent, 'Make an account to post a photo');
});

test('the app can ask for it, and the strip shows for a marked guest', async () => {
  const env = await runBridge(BRIDGE[0], { cookie: 'theme=dark; __Host-usernode_guest=1' });
  const p = env.parts();
  assert.ok(p, 'the strip is drawn for a guest');
  assert.equal(p.strip.hidden, false);
  assert.match(p.all.map((e) => e.textContent).join('|'), /You're looking around\. Make an account to join in\./);
  assert.equal(env.window.usernode.askForAccount({ action: 'join the game' }), true);
  assert.equal(env.parts().title.textContent, 'Make an account to join the game');
});

test('never inside the platform’s frame', async () => {
  const env = await runBridge(BRIDGE[0], {
    inIframe: true, cookie: '__Host-usernode_guest=1',
    responses: { 'https://photo-wall.example.org/api/a': { status: 401, type: 'application/json', body: { error: 'account_required' } } },
  });
  await env.window.fetch('/api/a');
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(env.parts(), null);
  assert.equal(env.window.usernode.askForAccount, undefined);
});

test('the bridge copy carries no em dash', () => {
  const block = guestBlock(BRIDGE[0]).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(block, /—|\\u2014/);
});
