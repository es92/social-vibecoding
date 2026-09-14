// The session-CLI bridge opt-in (#1281).
//
// The spec puts the bridge at the bottom of its routing tree, marked
// SETTINGS-GATED and "most users: no": it is the platform dev-chat UX
// driven from your own machine, and it wants the Homeroom CLI installed and
// attached before it does anything at all. Until #1281 the only gate was
// the DEPLOYMENT's cliAuthEnabled, so the venue was offered to everyone on
// a deployment that merely supports the CLI — including, most visibly, in
// the out-of-credits card, where it sat between "use your Claude plan" and
// "use your API key" as though it were the same kind of answer.
//
// So it is a per-user opt-in now, defaulting off. Three layers, in the
// shape tests/dev-flow-preference.test.js established for its sibling:
//   1. Behavioural: POST /api/me/session-bridge against a stubbed pool.
//   2. /api/auth/me reports the stored value.
//   3. The gate itself — `local` needs the opt-in AND the deployment flag —
//      plus source guards on the Settings control that flips it.
//
// Note what is NOT asserted: that turning it on grants anything. The lease
// protocol is unchanged and still needs a real CLI token; this preference
// only decides whether the venue is OFFERED.
//
// Run with: node --test tests/session-bridge-preference.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Stub the pool BEFORE requiring the routes, exactly as the dev-flow
// preference test does — the toggle's only database contact is one UPDATE,
// and `calls` is what proves its shape. /api/auth/me reads req.user rather
// than the pool, so its round trip is driven from the stub middleware.
const poolMod = require('../src/db/pool');
let calls = [];
poolMod.getPool = () => ({
  async query(sql, params) {
    calls.push({ sql, params });
    return { rows: [] };
  },
});

const { authRoutes } = require('../src/routes/auth');
const BuildVenues = require('../public/js/build-venues.js');

let server, base;
let user = null;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(authRoutes({ jwtSecret: 'test-secret' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  if (!server) return;
  // closeAllConnections first: undici keeps the sockets alive and a bare
  // close() would wait for them and hang the runner.
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
});
test.beforeEach(() => {
  calls = [];
  user = { id: 42, username: 'tester', isAdmin: false, appQuota: 0, locale: null };
});

const post = (body) => fetch(`${base}/api/me/session-bridge`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const bridgeUpdate = () => calls.find((c) => /UPDATE users SET session_bridge_enabled/.test(c.sql));

// ── 1. The route ────────────────────────────────────────────────────────

test('401 when not authenticated, and nothing is written', async () => {
  user = null;
  const r = await post({ enabled: true });
  assert.equal(r.status, 401);
  assert.equal(bridgeUpdate(), undefined, 'an anonymous caller must not write a row');
});

test('a boolean persists for the calling user only', async () => {
  for (const enabled of [true, false]) {
    calls = [];
    const r = await post({ enabled });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, enabled });
    const write = bridgeUpdate();
    assert.ok(write, 'the toggle writes');
    assert.deepEqual(write.params, [enabled, 42], 'scoped to req.user.id, never a body field');
  }
});

test('a non-boolean is a 400 that never reaches the database', async () => {
  for (const body of [{ enabled: 'true' }, { enabled: 1 }, { enabled: null }, {}, { other: true }]) {
    calls = [];
    const r = await post(body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} must be refused`);
    assert.equal(bridgeUpdate(), undefined, 'and refused before the write');
  }
});

// ── 2. The round trip ───────────────────────────────────────────────────

test('/api/auth/me reports the stored value', async () => {
  // The payload reads req.user, which the auth middleware fills from the
  // column (asserted separately below) — so this drives req.user directly
  // rather than the pool, which is the same seam the middleware test covers
  // from the other side.
  const me = async () => {
    const r = await fetch(`${base}/api/auth/me`);
    return (await r.json()).user || {};
  };
  user.sessionBridgeEnabled = false;
  assert.equal((await me()).sessionBridgeEnabled, false, 'default off');
  user.sessionBridgeEnabled = true;
  assert.equal((await me()).sessionBridgeEnabled, true);
  // A user object that predates the column (a cached session, a stub that
  // never set it) reports false rather than undefined — the client treats
  // undefined as "not told yet" for the deployment flags around it, and
  // this one must be a definite no.
  delete user.sessionBridgeEnabled;
  assert.equal((await me()).sessionBridgeEnabled, false);
});

test('the middleware selects the column and maps it onto req.user', () => {
  const mw = read('src/middleware/auth.js');
  assert.match(mw, /u\.session_bridge_enabled/, 'the cookie-session join carries it');
  assert.match(mw, /session_bridge_enabled, locale/, 'and so does the by-id lookup');
  // Both mapping sites, or a staging by-id lookup reports a preference the
  // cookie path would have reported correctly.
  assert.match(mw, /sessionBridgeEnabled: !!rows\[0\]\.session_bridge_enabled/);
  assert.match(mw, /sessionBridgeEnabled: !!userRow\.session_bridge_enabled/);
});

test('the column defaults FALSE — an opt-in that defaults on is not one', () => {
  assert.match(
    read('src/db/schema.sql'),
    /users ADD COLUMN IF NOT EXISTS session_bridge_enabled BOOLEAN NOT NULL DEFAULT FALSE;/,
  );
});

// ── 3. The gate ─────────────────────────────────────────────────────────

test('the bridge venue needs the opt-in AND the deployment flag', () => {
  const ids = (state) => BuildVenues.venuesFor(state).map((v) => v.id);
  assert.ok(!ids({ cliAuthEnabled: true }).includes('local'),
    'the deployment flag alone must not offer it');
  assert.ok(!ids({ sessionBridgeEnabled: true }).includes('local'),
    'the opt-in alone must not offer it where there is no CLI surface');
  assert.ok(ids({ cliAuthEnabled: true, sessionBridgeEnabled: true }).includes('local'),
    'both together offer it');

  // Absent, never disabled: the kit's touch idiom is an action sheet, which
  // drops disabled rows — so a disabled entry is invisible on a phone and
  // inert-but-present on desktop. Two different products.
  for (const row of BuildVenues.venuesFor({ cliAuthEnabled: true })) {
    assert.ok(!('disabled' in row), `${row.id} must not ship a disabled flag`);
  }
});

test('the out-of-credits card does not default the opt-in to true', () => {
  const CreditOptions = require('../public/js/credit-options.js');
  const ids = (state) => CreditOptions.options(state).map((o) => o.id);
  // The flags around it default true when absent (they describe a
  // deployment, and a missing one means "not told otherwise"). This one
  // must not: a preference nobody set is off.
  assert.ok(!ids({ externalFlowsAvailable: true }).includes('local'));
  assert.ok(ids({ externalFlowsAvailable: true, sessionBridgeEnabled: true }).includes('local'));
});

// ── 4. The control that flips it ────────────────────────────────────────

test('Settings has the switch, wired to the route, with a revert on failure', () => {
  const section = read('frontend/src/features/settings/sections/experimental.tsx');
  assert.match(section, /id="session-bridge-enabled"/, 'the switch');
  assert.match(section, /id="session-bridge-status"/, 'and somewhere to report a failed save');

  const settings = read('frontend/src/features/settings/settings.js');
  assert.match(settings, /'\/api\/me\/session-bridge'/, 'POSTs to the route');
  assert.match(settings, /_saveSessionBridge\(e\.target\.checked\)/, 'on change, not on close');
  const save = settings.match(/async _saveSessionBridge\([\s\S]*?\n    \},/);
  assert.ok(save, '_saveSessionBridge must exist');
  assert.match(save[0], /toggle\.checked = !!this\.state\.sessionBridgeEnabled/,
    'a failed save reverts the checkbox rather than leaving it lying');
  // The venue pickers read App.user, not Settings.state, so the live object
  // has to move too or the next sheet opened in this same page load would
  // still be missing the row that was just enabled.
  assert.match(save[0], /App\.user\.sessionBridgeEnabled = !!enabled/);
});
