// The saved build-flow preference (#1049).
//
// "Remember my choice" on the dev-chat flow picker, and the same dropdown in
// Settings, write ONE nullable column: users.dev_flow_preference. Null is
// load-bearing — it means "ask me every time", which is the default and the
// only state in which the picker renders at all.
//
// Three layers, in the shape tests/user-locale.test.js established for the
// sibling `locale` preference:
//   1. Behavioural: POST /api/me/dev-flow mounted with a stubbed pool — the
//      three allowed flows persist, null / "" / a missing body clear it, a
//      value outside the allowlist is a 400 that never reaches the database,
//      and unauthenticated is a 401.
//   2. /api/auth/me round-trips the stored value, and reports whether the
//      external flows are offerable in this deployment at all.
//   3. Source guards down the rest of the chain: the column and its CHECK,
//      the Settings dropdown, and the two client surfaces that read the
//      preference (the dev-chat picker gate, and the "+" menu entry).
//
// The three-way agreement between DEV_FLOWS, the CHECK constraint and
// DevFlowSelect.FLOWS is pinned in tests/dev-flow-select.test.js.
//
// Run with: node --test tests/dev-flow-preference.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Stub the pool BEFORE requiring the routes. `storedFlow` is what the
// /api/auth/me user lookup reports back, so the round-trip can be exercised
// without a database.
const poolMod = require('../src/db/pool');
let calls = [];
let storedFlow = null;
poolMod.getPool = () => ({
  async query(sql, params) {
    calls.push({ sql, params });
    if (/FROM users u/.test(sql)) {
      return { rows: [{ dev_flow_preference: storedFlow }] };
    }
    return { rows: [] };
  },
});

const { authRoutes, DEV_FLOWS } = require('../src/routes/auth');

// With OAuth credentials configured the hand-off is offerable; the
// no-credentials case gets its own server below.
const LINKED_CONFIG = {
  jwtSecret: 'test-secret',
  waitlistGithubClientId: 'client-id',
  waitlistGithubClientSecret: 'client-secret',
};

let server, base, bareServer, bareBase;
let user = null;

async function mount(config) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(authRoutes(config));
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  return [s, `http://127.0.0.1:${s.address().port}`];
}

test.before(async () => {
  [server, base] = await mount(LINKED_CONFIG);
  // A deployment with no GitHub OAuth credentials at all. The env can also
  // supply them, so they are cleared for the duration of this file.
  delete process.env.GITHUB_LINK_CLIENT_ID;
  delete process.env.GITHUB_LINK_CLIENT_SECRET;
  [bareServer, bareBase] = await mount({ jwtSecret: 'test-secret' });
});
test.after(() => {
  // closeAllConnections first: undici keeps the sockets alive, and a bare
  // close() would wait for them and hang the runner.
  for (const s of [server, bareServer]) {
    if (!s) continue;
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    s.close();
  }
});

test.beforeEach(() => {
  calls = [];
  storedFlow = null;
  user = { id: 42, username: 'tester', isAdmin: false, appQuota: 0, locale: null };
});

const post = (body) => fetch(`${base}/api/me/dev-flow`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const flowUpdate = () => calls.find((c) => /UPDATE users SET dev_flow_preference/.test(c.sql));

// ── 1. POST /api/me/dev-flow behaviour ──────────────────────────────────

test('401 when not authenticated', async () => {
  user = null;
  const r = await post({ flow: 'codex' });
  assert.equal(r.status, 401);
  assert.equal(flowUpdate(), undefined, 'an anonymous caller must not write a row');
});

test('each allowed flow persists and is echoed back', async () => {
  for (const flow of DEV_FLOWS) {
    calls = [];
    const r = await post({ flow });
    assert.equal(r.status, 200, `expected 200 for ${flow}`);
    assert.deepEqual(await r.json(), { ok: true, flow });
    assert.deepEqual(flowUpdate().params, [flow, 42]);
  }
});

test('null, empty string and a missing body clear it back to "ask me"', async () => {
  // Unticking "remember my choice" sends null. Clearing has to be possible:
  // a preference you cannot un-save is a trap, and null is what makes the
  // picker come back.
  for (const cleared of [{ flow: null }, { flow: '' }, {}]) {
    calls = [];
    const r = await post(cleared);
    assert.equal(r.status, 200, `expected 200 for ${JSON.stringify(cleared)}`);
    assert.deepEqual(await r.json(), { ok: true, flow: null });
    assert.deepEqual(flowUpdate().params, [null, 42]);
  }
});

test('anything outside the allowlist is a 400 and never reaches the database', async () => {
  for (const bad of [
    'claude',            // close, but not the enum value
    'CODEX',             // the column's CHECK is case-sensitive
    'platform ',
    'external',          // a real agent value, but not a pickable flow
    'DROP TABLE users',
    123,
    true,
    ['codex'],
    { flow: 'codex' },
  ]) {
    calls = [];
    const r = await post({ flow: bad });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(flowUpdate(), undefined, 'no UPDATE on invalid input');
    // The refusal names the values that would work.
    assert.match((await r.json()).error, /platform/);
  }
});

// ── 2. /api/auth/me ─────────────────────────────────────────────────────

test('/api/auth/me round-trips the stored preference', async () => {
  for (const flow of DEV_FLOWS) {
    storedFlow = flow;
    const j = await (await fetch(`${base}/api/auth/me`)).json();
    assert.equal(j.user.devFlowPreference, flow);
  }
});

test('/api/auth/me reports null when unset', async () => {
  const j = await (await fetch(`${base}/api/auth/me`)).json();
  assert.equal(j.user.devFlowPreference, null, 'unset means "ask me every time"');
});

test('a value the column should never hold is reported as null, not passed through', async () => {
  // Defence in depth: the CHECK constraint makes this unreachable through
  // the route, but the client branches on this string, and an unknown value
  // arriving there would suppress the picker while matching no flow — the
  // one state in which a user can pick nothing at all.
  storedFlow = 'something-else';
  const j = await (await fetch(`${base}/api/auth/me`)).json();
  assert.equal(j.user.devFlowPreference, null);
});

test('/api/auth/me says whether the hand-off is offerable at all', async () => {
  const linked = await (await fetch(`${base}/api/auth/me`)).json();
  assert.equal(linked.user.externalFlowsAvailable, true,
    'with GitHub OAuth configured, Claude Code / Codex can be offered');

  const bare = await (await fetch(`${bareBase}/api/auth/me`)).json();
  assert.equal(bare.user.externalFlowsAvailable, false,
    'with no GitHub credentials there is nothing to guide anyone through');
  // Still a real boolean, not a missing key the client would read as
  // undefined and render inconsistently.
  assert.equal(typeof bare.user.externalFlowsAvailable, 'boolean');
});

// ── 3. Chain source guards ──────────────────────────────────────────────

test('schema adds the nullable column and constrains its values', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS dev_flow_preference TEXT/);
  assert.match(schema, /users_dev_flow_preference_chk/,
    'the allowed values must be enforced in the database, not only in the route');
  assert.match(schema, /CHECK \(dev_flow_preference IS NULL/,
    'NULL must stay legal — it is the "ask me every time" default');
  // Re-runnable: schema.sql is applied on every boot.
  assert.match(schema, /DROP CONSTRAINT IF EXISTS users_dev_flow_preference_chk/);
});

test('Settings offers the same preference as a dropdown', () => {
  const js = read('public/js/settings.js');
  assert.match(js, /_renderDevFlowSection/);
  assert.match(js, /_saveDevFlow/);
  assert.match(js, /\/api\/me\/dev-flow/);
  assert.match(js, /id="settings-dev-flow"/);
  assert.match(js, /devFlowPreference/, 'the section must render from the /me value');
  // The shell body is frozen against tests/fixtures/pre-migration-index.html
  // (tests/shell-markup-parity.test.js), so this section is INJECTED by JS
  // rather than added to frontend/src/Shell.tsx. If that ever changes, the
  // injection can go — but silently adding static markup instead would fail
  // the parity test, so the reason is recorded where the code is.
  assert.match(js, /data-settings-section="connectors"/,
    'the injected section must land in the Connections settings section');
  const html = read('public/index.html');
  assert.ok(!html.includes('id="settings-dev-flow"'),
    'the dropdown must NOT be static markup — the shell document is frozen');
});

test('Settings disables the hand-offs when the deployment cannot offer them', () => {
  const js = read('public/js/settings.js');
  assert.match(js, /externalFlowsAvailable/,
    'a deployment with no GitHub link must not offer a preference it cannot honour');
});

test('the dev chat honours the preference instead of always asking', () => {
  const devChat = read('public/js/dev-chat.js');
  // 'platform' means "never ask again" — the picker must not render.
  assert.match(devChat, /pref === 'platform'/, 'a saved platform preference suppresses the picker');
  assert.match(devChat, /pref === 'claude-code' \|\| pref === 'codex'/,
    'a saved external preference goes straight into the walkthrough');
  assert.match(devChat, /forcePicker/,
    'the "+" menu must be able to re-ask despite a saved preference');
  assert.match(devChat, /devFlowPreference/, 'the gate reads the value from App.user');
});

test('the picker only appears where a choice is still meaningful', () => {
  // Otherwise it would sit above a conversation already in progress, or on a
  // session whose proposal exists — asking a question whose answer can no
  // longer change anything.
  const devChat = read('public/js/dev-chat.js');
  const fnStart = devChat.indexOf('_devFlowTarget() {');
  assert.ok(fnStart !== -1, '_devFlowTarget must exist');
  const fn = devChat.slice(fnStart, devChat.indexOf('\n  },', fnStart));
  assert.match(fn, /pr_number/, 'a session with a proposal is past the choice');
  assert.match(fn, /status !== 'active'/, 'an inactive session is past the choice');
  assert.match(fn, /role === 'user'/, 'a session with a typed message is past the choice');
  assert.match(fn, /externalFlowsAvailable/,
    'with no hand-off available there is no choice to offer, so nothing renders');
});

test('the "+" menu can start either flow explicitly', () => {
  const appView = read('public/js/app-view.js');
  assert.match(appView, /data-plus="proposal-external"/,
    'the "+" menu must name the hand-off, or nobody discovers it');
  assert.match(appView, /Claude Code or Codex/);
  assert.match(appView, /createProposal\(\{ pickFlow: true \}\)/,
    'that entry re-asks even for someone who saved "platform"');
});
