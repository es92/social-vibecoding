// Tests for the view-only admin role (issue #311).
//
// Covers the three behavioural slices the spec calls out:
//   1. Write gates require a FULL admin (canAdminWrite) — a view-only
//      admin gets 403, a full admin passes the capability check.
//   2. Read gates stay on isAdmin — both view-only and full admins reach
//      them; a normal user is rejected.
//   3. The role-setter endpoint + its self-demotion and last-full-admin
//      invariants (counting full admins only).
//   4. admin-approval: only a FULL admin's yes-vote satisfies a locked
//      app's admin-approval requirement.
//
// Route slices are exercised end-to-end (express + a mocked pool),
// mirroring tests/visibility-pr-route.test.js. Run with:
//   node --test tests/view-only-admin.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// Override the pool BEFORE requiring the route modules (they destructure
// getPool at require time). A single swappable handler answers every SQL
// shape; `connect()` returns a client backed by the same handler so the
// advisory-lock transactions in admin.js work.
const poolMod = require('../src/db/pool');
let handler = async () => ({ rows: [] });
const sharedPool = {
  query: (sql, params) => handler(sql, params),
  async connect() {
    return { query: (sql, params) => handler(sql, params), release() {} };
  },
};
poolMod.getPool = () => sharedPool;

const { adminRoutes } = require('../src/routes/admin');
const { appRoutes } = require('../src/routes/apps');
const { voteRoutes } = require('../src/routes/votes');
const adminApproval = require('../src/services/admin-approval');
const express = require('express');

const NORMAL = { id: 9, username: 'norm', isAdmin: false, canAdminWrite: false, adminReadonly: false };
const VIEW_ADMIN = { id: 8, username: 'view', isAdmin: true, canAdminWrite: false, adminReadonly: true };
const FULL_ADMIN = { id: 1, username: 'full', isAdmin: true, canAdminWrite: true, adminReadonly: false };

let currentUser = FULL_ADMIN;
let scenario = {};

// Default handler: enough SQL shapes for the admin/apps/votes routes to
// reach (or be stopped before) their first real DB read.
function defaultHandler(sql, params = []) {
  // Transaction control — no-ops.
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) {
    return { rows: [] };
  }
  // GET /api/admin/users list.
  if (/FROM users u/.test(sql)) return { rows: scenario.userList || [] };
  // Per-user app-quota edit locks and reads the current value before writing.
  if (/SELECT id, username, app_quota FROM users/.test(sql)) {
    return { rows: [{ id: params[0], username: 'target', app_quota: 2 }] };
  }
  // Role-setter: existing-row lookup inside the demotion/transaction path.
  if (/SELECT id, is_admin, admin_readonly FROM users WHERE id = \$1/.test(sql)) {
    return { rows: scenario.targetRow ? [scenario.targetRow] : [] };
  }
  // Last-full-admin count — MUST now filter admin_readonly = FALSE.
  if (/COUNT\(\*\)::int AS n FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE/.test(sql)) {
    return { rows: [{ n: scenario.fullAdminCount ?? 5 }] };
  }
  // Role write (both the no-lock full-admin path and the demotion path).
  if (/UPDATE users SET is_admin = \$1, admin_readonly = \$2 WHERE id = \$3/.test(sql)) {
    return { rows: [{ id: params[2], username: 'target', is_admin: params[0], admin_readonly: params[1] }] };
  }
  return { rows: [] };
}

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use(adminRoutes({ jwtSecret: 'test' }));
  app.use(appRoutes({ jwtSecret: 'test' }));
  app.use(voteRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test.beforeEach(() => {
  currentUser = FULL_ADMIN;
  scenario = {};
  handler = defaultHandler;
});

function req(method, path, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ── Write gates: 403 for view-only admin, pass for full admin ──────────

test('PUT /api/admin/users/:id/app-quota — view-only admin 403, full admin ok', async () => {
  currentUser = VIEW_ADMIN;
  let res = await req('PUT', '/api/admin/users/2/app-quota', { quota: 3 });
  assert.equal(res.status, 403);

  currentUser = FULL_ADMIN;
  res = await req('PUT', '/api/admin/users/2/app-quota', { quota: 3 });
  assert.equal(res.status, 200);
});

test('DELETE /api/apps/:slug — view-only admin 403, full admin passes the gate', async () => {
  currentUser = VIEW_ADMIN;
  let res = await req('DELETE', '/api/apps/demo');
  assert.equal(res.status, 403);

  // Full admin clears the capability gate; the app doesn't exist in the
  // stub so it falls through to 404 — the point is it's NOT 403.
  currentUser = FULL_ADMIN;
  res = await req('DELETE', '/api/apps/demo');
  assert.notEqual(res.status, 403);
});

test('PUT /api/apps/:slug/secrets/:key — view-only admin 403, full admin passes the gate', async () => {
  currentUser = VIEW_ADMIN;
  let res = await req('PUT', '/api/apps/demo/secrets/FOO', { value: 'x' });
  assert.equal(res.status, 403);

  currentUser = FULL_ADMIN;
  res = await req('PUT', '/api/apps/demo/secrets/FOO', { value: 'x' });
  assert.notEqual(res.status, 403);
});

test('POST /api/sessions/:id/admin-merge — view-only admin 403, full admin passes the gate', async () => {
  currentUser = VIEW_ADMIN;
  let res = await req('POST', '/api/sessions/5/admin-merge');
  assert.equal(res.status, 403);

  currentUser = FULL_ADMIN;
  res = await req('POST', '/api/sessions/5/admin-merge');
  assert.notEqual(res.status, 403);
});

// ── Read gate: both admins pass, normal user rejected ──────────────────

test('GET /api/admin/users — view-only and full admin 200, normal user 403', async () => {
  scenario.userList = [{ id: 1, username: 'full', is_admin: true, admin_readonly: false }];

  currentUser = VIEW_ADMIN;
  assert.equal((await req('GET', '/api/admin/users')).status, 200);

  currentUser = FULL_ADMIN;
  assert.equal((await req('GET', '/api/admin/users')).status, 200);

  // A normal user is blocked by adminMiddleware (403 for /api/ paths, or a
  // redirect away otherwise) — the point is they never get the 200 payload.
  currentUser = NORMAL;
  assert.notEqual((await req('GET', '/api/admin/users')).status, 200);
});

// ── Role-setter + invariants ───────────────────────────────────────────

test('role-setter: full admin can set view_admin / admin / user', async () => {
  currentUser = FULL_ADMIN;
  scenario.targetRow = { id: 2, is_admin: true, admin_readonly: false };
  scenario.fullAdminCount = 5;

  let res = await req('POST', '/api/admin/users/2/is-admin', { role: 'admin' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, 'admin');

  res = await req('POST', '/api/admin/users/2/is-admin', { role: 'view_admin' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, 'view_admin');

  res = await req('POST', '/api/admin/users/2/is-admin', { role: 'user' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, 'user');
});

test('role-setter: back-compat { isAdmin: true/false } still works', async () => {
  currentUser = FULL_ADMIN;
  scenario.targetRow = { id: 2, is_admin: true, admin_readonly: false };
  scenario.fullAdminCount = 5;

  let res = await req('POST', '/api/admin/users/2/is-admin', { isAdmin: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, 'admin');

  res = await req('POST', '/api/admin/users/2/is-admin', { isAdmin: false });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, 'user');
});

test('role-setter: invalid role is a 400', async () => {
  currentUser = FULL_ADMIN;
  const res = await req('POST', '/api/admin/users/2/is-admin', { role: 'superadmin' });
  assert.equal(res.status, 400);
});

test('role-setter: a full admin cannot lower their own role', async () => {
  currentUser = FULL_ADMIN; // id 1
  const res = await req('POST', '/api/admin/users/1/is-admin', { role: 'user' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /your own/i);
});

test('role-setter: cannot demote the last full admin (to user)', async () => {
  currentUser = FULL_ADMIN;
  scenario.targetRow = { id: 2, is_admin: true, admin_readonly: false };
  scenario.fullAdminCount = 1;
  const res = await req('POST', '/api/admin/users/2/is-admin', { role: 'user' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /last full admin/i);
});

test('role-setter: setting the last full admin to view_admin is blocked too', async () => {
  currentUser = FULL_ADMIN;
  scenario.targetRow = { id: 2, is_admin: true, admin_readonly: false };
  scenario.fullAdminCount = 1;
  const res = await req('POST', '/api/admin/users/2/is-admin', { role: 'view_admin' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /last full admin/i);
});

test('DELETE /api/admin/users/:id: cannot delete the last full admin', async () => {
  currentUser = FULL_ADMIN;
  scenario.targetRow = { id: 2, is_admin: true, admin_readonly: false };
  scenario.fullAdminCount = 1;
  const res = await req('DELETE', '/api/admin/users/2');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /last full admin/i);
});

// ── admin-approval: only a full admin's vote satisfies a locked app ────

function approvalPool(votes, wantVote) {
  return {
    async query(sql) {
      // The gate MUST now require a full admin.
      assert.match(sql, /admin_readonly = FALSE/);
      const hit = votes.some((v) => v.vote === wantVote && v.is_admin && !v.admin_readonly);
      return { rows: hit ? [{ ok: 1 }] : [] };
    },
  };
}

test('admin-approval (PR): a full admin yes-vote satisfies, a view-only one does not', async () => {
  const fullYes = approvalPool([{ vote: 'yes', is_admin: true, admin_readonly: false }], 'yes');
  assert.equal(await adminApproval.hasAdminYesVote(fullYes, 1), true);

  const viewYes = approvalPool([{ vote: 'yes', is_admin: true, admin_readonly: true }], 'yes');
  assert.equal(await adminApproval.hasAdminYesVote(viewYes, 1), false);
});

test('admin-approval (PR): the locked-app gate is scoped to the approval epoch, not the commit', async () => {
  // #2100 / #2095: this predicate was the last tally still keyed on the
  // vote's head_sha. A mechanical sync moves the head and keeps the epoch,
  // so the admin's yes kept satisfying "enough approvals" while this gate
  // said no admin had voted — and asked the admin who had just voted yes to
  // vote yes again, which is a no-op for an unchanged vote.
  let captured = null;
  const pool = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [] };
    },
  };
  await adminApproval.hasAdminYesVote(pool, 9);
  assert.match(captured.sql, /pv\.approval_epoch = cs\.approval_epoch/,
    'counts the vote iff it belongs to the current approval epoch');
  assert.doesNotMatch(captured.sql, /head_sha/,
    'the commit the admin happened to see is not part of the rule');
  assert.deepEqual(captured.params, [9]);
});

test('admin-approval (issue): a full admin up-vote satisfies, a view-only one does not', async () => {
  const fullUp = approvalPool([{ vote: 'up', is_admin: true, admin_readonly: false }], 'up');
  assert.equal(await adminApproval.hasAdminUpVote(fullUp, 1), true);

  const viewUp = approvalPool([{ vote: 'up', is_admin: true, admin_readonly: true }], 'up');
  assert.equal(await adminApproval.hasAdminUpVote(viewUp, 1), false);
});
