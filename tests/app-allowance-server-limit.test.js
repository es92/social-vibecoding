// QA 2026-09-24 Q33b: the server-wide app limit (MAX_APPS) shows up front.
//
// Every step of the create dialog said "0 of 2 app slots used · 2 slots
// available", and only Create learned that the SERVER was full: "This server
// is at its app limit (50). Ask an admin…". The allowance read now carries
// the server's cap as the viewer meets it, beside (not inside) their own
// quota, and the panel says so when it is the limit they run into first.
//
// Run with: node --test tests/app-allowance-server-limit.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

// ── The service ───────────────────────────────────────────────────

let active = 52;
const pool = {
  async query(sql) {
    if (/AS app_quota_used/.test(sql)) return { rows: [{ app_quota_used: 0, app_quota: 2, app_quota_requested_at: null }] };
    if (/SELECT COUNT\(\*\)::int AS n FROM apps WHERE status <> 'error'/.test(sql)) return { rows: [{ n: active }] };
    return { rows: [] };
  },
};
require('../src/db/pool').getPool = () => pool;
const allowance = require('../src/services/app-allowance');

const member = { id: 2, username: 'member', isAdmin: false, canAdminWrite: false, appQuota: 2 };
const admin = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };

test('serverCapacity counts non-errored apps against MAX_APPS, as the write routes do', async () => {
  active = 52;
  assert.deepEqual(await allowance.serverCapacity(pool, member, 50), { used: 52, limit: 50, remaining: 0, full: true });
  active = 49;
  assert.deepEqual(await allowance.serverCapacity(pool, member, 50), { used: 49, limit: 50, remaining: 1, full: false });
  // No cap configured, and full admins (who bypass it on POST /api/apps and
  // /fork), meet no server limit at all.
  assert.equal(await allowance.serverCapacity(pool, member, 0), null);
  assert.equal(await allowance.serverCapacity(pool, admin, 50), null);
  // A view-only admin does not bypass the cap on the write routes, so meets it here.
  assert.ok(await allowance.serverCapacity(pool, { ...admin, canAdminWrite: false }, 50));
});

test('read() adds `server` only when asked, and never folds it into the personal answer', async () => {
  active = 52;
  const plain = await allowance.read(pool, member);
  assert.equal('server' in plain, false, 'callers that pass nothing keep the shape they had');
  const withServer = await allowance.read(pool, member, { maxApps: 50 });
  assert.deepEqual(withServer.server, { used: 52, limit: 50, remaining: 0, full: true });
  assert.deepEqual(withServer.quota, { used: 0, limit: 2, remaining: 2 });
  assert.equal(withServer.canCreateApps, true, 'the personal verdict, which the 403 refusal copy is about');
});

test('a failed server count leaves the allowance readable', async () => {
  const broken = {
    async query(sql) {
      if (/COUNT\(\*\)::int AS n FROM apps/.test(sql)) throw new Error('count failed');
      return pool.query(sql);
    },
  };
  const result = await allowance.read(broken, member, { maxApps: 50 });
  assert.equal(result.server, null);
  assert.deepEqual(result.quota, { used: 0, limit: 2, remaining: 2 });
});

test('/api/auth/me seeds the panel with the server capacity', async () => {
  active = 52;
  const { authRoutes } = require('../src/routes/auth');
  const app = express();
  app.use((req, _res, next) => { req.user = member; next(); });
  app.use(authRoutes({ jwtSecret: 'test-secret', maxApps: 50 }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/me`);
    const { user } = await res.json();
    assert.deepEqual(user.appServerCapacity, { used: 52, limit: 50, remaining: 0, full: true });
    assert.deepEqual(user.appCreationQuota, { used: 0, limit: 2, remaining: 2 });
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  }
});

test('the allowance routes pass the effective app limit through', () => {
  // The admin's setting when one is stored, else MAX_APPS
  // (services/app-limit.js) — the same cap the create route refuses with.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/routes/apps.js'), 'utf8');
  assert.match(src, /appAllowance\.read\(pool, req\.user, \{ maxApps: await appLimit\.effective\(pool, config\) \}\)/);
  assert.match(src, /appAllowance\.requestMore\(pool, req\.user, \{ maxApps: await appLimit\.effective\(pool, config\) \}\)/);
});

// ── The store ─────────────────────────────────────────────────────

test('the store normalises the server cap and treats a malformed one as no cap', async () => {
  const model = loadTsx('frontend/src/features/dialogs/app-allowance-store.js');
  assert.deepEqual(model.normalizeServer({ used: 52, limit: 50, remaining: 0 }), { used: 52, limit: 50, remaining: 0, full: true });
  assert.deepEqual(model.normalizeServer({ used: 3, limit: 50, remaining: 47 }), { used: 3, limit: 50, remaining: 47, full: false });
  for (const bad of [null, undefined, {}, { used: -1, limit: 50, remaining: 0 }, { used: 1, limit: 0, remaining: 0 }, { used: '1', limit: 50, remaining: 49 }]) {
    assert.equal(model.normalizeServer(bad), null, JSON.stringify(bad));
  }
  model.seedAppAllowance({ appCreationQuota: { used: 0, limit: 2, remaining: 2 }, appServerCapacity: { used: 50, limit: 50, remaining: 0 } });
  assert.equal(model.appAllowanceStore.get().server.full, true);
  await model.refreshAppAllowance(async () => ({
    ok: true,
    json: async () => ({ quota: { used: 0, limit: 2, remaining: 2 }, server: { used: 10, limit: 50, remaining: 40 }, requestedAt: null }),
  }));
  assert.deepEqual(model.appAllowanceStore.get().server, { used: 10, limit: 50, remaining: 40, full: false });
});

// ── The panel ─────────────────────────────────────────────────────

function renderPanel(state, props = {}) {
  const store = { get: () => ({ loading: false, error: '', requestedAt: null, ...state }), subscribe: () => () => {} };
  const mod = loadTsx('frontend/src/features/dialogs/app-allowance.tsx', {
    stubs: {
      './app-allowance-store.js': { appAllowanceStore: store, refreshAppAllowance() {}, requestMoreApps() {} },
    },
  });
  return { html: renderToHtml(createElement(mod.AppAllowance, { id: 'create-app-quota', surface: 'pane', ...props })), mod };
}

const QUOTA = { used: 0, limit: 2, remaining: 2 };

test('a full server is the headline, with the words the write route refuses with', () => {
  const { html } = renderPanel({ quota: QUOTA, server: { used: 52, limit: 50, remaining: 0, full: true } });
  assert.match(html, /data-quota-state="server-full"/);
  assert.match(html, />Server is full</);
  assert.match(html, /id="create-app-quota-server" data-server-full="true"/);
  assert.ok(html.includes('This server is at its app limit (50). Ask an admin to remove an app or raise the limit.'));
  assert.match(html, /Your own allowance: 2 slots free\./);
  assert.doesNotMatch(html, /Request more/, 'more personal slots would not help');
  assert.doesNotMatch(html, /—/);
});

test('a nearly full server is mentioned only when it binds first', () => {
  const binding = renderPanel({ quota: QUOTA, server: { used: 49, limit: 50, remaining: 1, full: false } }).html;
  assert.match(binding, /data-quota-state="available"/);
  assert.match(binding, /0 of 2 app slots used/);
  assert.match(binding, /This server has room for 1 more app \(limit 50\)\./);
  assert.match(binding, /Request more/);
  const roomy = renderPanel({ quota: QUOTA, server: { used: 10, limit: 50, remaining: 40, full: false } }).html;
  assert.doesNotMatch(roomy, /create-app-quota-server/, 'a server with room says nothing');
  const none = renderPanel({ quota: QUOTA, server: null }).html;
  assert.doesNotMatch(none, /create-app-quota-server/);
});

test('a full server blocks creation like a spent allowance, and both shots pin the panel', () => {
  const { mod } = renderPanel({ quota: QUOTA, server: null });
  assert.equal(mod.serverBinds(QUOTA, { used: 50, limit: 50, remaining: 0, full: true }), true);
  assert.equal(mod.serverBinds(QUOTA, { used: 49, limit: 50, remaining: 1, full: false }), true);
  assert.equal(mod.serverBinds(QUOTA, { used: 10, limit: 50, remaining: 40, full: false }), false);
  assert.equal(mod.serverBinds({ used: 3, limit: null, remaining: null }, { used: 10, limit: 50, remaining: 40, full: false }), true);
  assert.equal(mod.serverBinds(QUOTA, null), false);
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../frontend/src/features/dialogs/app-allowance.tsx'), 'utf8');
  assert.match(src, /const blocked = spent \|\| serverFull;/);
  // ?shot=create-quota keeps the #1611 check deterministic on a full server.
  assert.match(src, /shot === 'create-quota'\) \{\s*quota = \{ used: 1, limit: 2, remaining: 1 \};\s*server = null;/);
  assert.match(src, /shot === 'create-server-full'\) \{\s*quota = \{ used: 0, limit: 2, remaining: 2 \};\s*server = \{ used: 50, limit: 50, remaining: 0, full: true \};/);
});

// ── #23: quiet in the create dialog ──────────────────────────────

test('quiet, the create dialog\'s card shows only when the allowance bears on what happens next (D7)', () => {
  const quiet = (state) => renderPanel(state, { quiet: true }).html;
  // 0 of 2: nothing to say, on any step.
  assert.equal(quiet({ quota: { used: 0, limit: 2, remaining: 2 }, server: null }), '');
  // 1 of 2: one slot left, so it is worth knowing before it is spent.
  const one = quiet({ quota: { used: 1, limit: 2, remaining: 1 }, server: null });
  assert.match(one, /id="create-app-quota"/);
  assert.match(one, /1 of 2 app slots used/);
  // Spent, a full server, a server that binds first, a pending request and a
  // failed read each show it; an unlimited allowance never does.
  assert.match(quiet({ quota: { used: 2, limit: 2, remaining: 0 }, server: null }), /data-quota-state="spent"/);
  assert.match(quiet({ quota: QUOTA, server: { used: 50, limit: 50, remaining: 0, full: true } }), /data-quota-state="server-full"/);
  assert.match(quiet({ quota: QUOTA, server: { used: 49, limit: 50, remaining: 1, full: false } }), /create-app-quota-server/);
  assert.match(quiet({ quota: QUOTA, server: null, requestedAt: '2026-10-03T10:00:00Z' }), /Request pending/);
  assert.match(quiet({ quota: null, server: null, error: 'Could not load your app allowance.' }), /role="alert"/);
  assert.equal(quiet({ quota: { used: 7, limit: null, remaining: null }, server: null }), '');
  // Not quiet (the fork dialog), 0 of 2 still shows as it always did.
  assert.match(renderPanel({ quota: QUOTA, server: null }, { surface: 'inset' }).html, /0 of 2 app slots used/);
});

test('allowanceWorthShowing is pure, and the make screen is the one surface that is quiet', () => {
  const { allowanceWorthShowing } = renderPanel({ quota: QUOTA, server: null }).mod;
  const roomy = { used: 10, limit: 50, remaining: 40, full: false };
  assert.equal(allowanceWorthShowing(QUOTA, null, null, ''), false);
  assert.equal(allowanceWorthShowing(QUOTA, roomy, null, ''), false, 'a roomy server says nothing');
  assert.equal(allowanceWorthShowing({ used: 1, limit: 2, remaining: 1 }, null, null, ''), true, 'remaining <= 1');
  assert.equal(allowanceWorthShowing({ used: 0, limit: 1, remaining: 1 }, null, null, ''), true);
  assert.equal(allowanceWorthShowing({ used: 2, limit: 2, remaining: 0 }, null, null, ''), true, 'spent');
  assert.equal(allowanceWorthShowing({ used: 0, limit: 0, remaining: 0 }, null, null, ''), true, 'no slots at all');
  assert.equal(allowanceWorthShowing(QUOTA, { used: 50, limit: 50, remaining: 0, full: true }, null, ''), true);
  assert.equal(allowanceWorthShowing(QUOTA, { used: 49, limit: 50, remaining: 1, full: false }, null, ''), true);
  assert.equal(allowanceWorthShowing(QUOTA, null, '2026-10-03T10:00:00Z', ''), true);
  assert.equal(allowanceWorthShowing(QUOTA, null, null, 'boom'), true);
  assert.equal(allowanceWorthShowing({ used: 7, limit: null, remaining: null }, null, null, ''), false, 'unlimited');
  assert.equal(allowanceWorthShowing({ used: null, limit: 2, remaining: null }, null, null, ''), false,
    'an unknown count is not read as one slot left');
  assert.equal(allowanceWorthShowing(null, null, null, ''), false);
  const read = (rel) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', rel), 'utf8');
  // The retired create dialog's quiet row, on Create's make screen now.
  assert.match(read('frontend/src/features/first-session/make.tsx'), /<AppAllowance id="make-app-quota" surface="pane" quiet \/>/);
  assert.match(read('frontend/src/features/dialogs/fork-app.tsx'), /<AppAllowance \/>/, 'the fork dialog is unchanged');
});

test('"Request more" is the neutral pill on the create dialog, not the accent', () => {
  const html = renderPanel({ quota: { used: 1, limit: 2, remaining: 1 }, server: null }, { quiet: true }).html;
  const button = html.match(/<button[^>]*>Request more<\/button>/);
  assert.ok(button, 'the request button renders');
  assert.doesNotMatch(button[0], /bg-violet-600/, 'a secondary act does not wear the accent');
  assert.match(button[0], /rounded-full bg-zinc-100/, 'the neutral pill');
  assert.match(button[0], /text-zinc-900/, 'with the neutral ink, not white on grey');
  // The fork dialog's inset keeps the button it had.
  const inset = renderPanel({ quota: { used: 1, limit: 2, remaining: 1 }, server: null }, { surface: 'inset' }).html;
  assert.match(inset.match(/<button[^>]*>Request more<\/button>/)[0], /rounded-lg bg-violet-600/);
});
