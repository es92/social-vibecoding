// Tests for POST /api/apps/:slug/admins-pr (issue #788 follow-up: the
// Members panel's App-admins editor) — the vote-gated dapp.json
// proposal that rewrites the top-level `admins` array — plus the
// openProposal pointer GET /api/apps/:slug/admins now returns.
//
// Exercises the routes end-to-end (express + mocked pool + stubbed
// GitHub service), mirroring tests/visibility-pr-route.test.js.
//
// Run with: node --test tests/admins-pr-route.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// Override the pool BEFORE requiring the route module: apps.js
// destructures getPool at require time. The pool delegates to a
// swappable handler so individual tests can answer specific SQL shapes
// (default: empty result for everything).
const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(sql, params) });

// Stub the GitHub service: enabled, with recordable branch/push/PR calls.
const github = require('../src/services/github');
let ghCalls;
let ghEnabled = true;
const ghManifestOnMain = JSON.stringify({
  name: 'Demo',
  secrets: [{ key: 'FOO_KEY', description: 'x' }],
  visibility: { build: 'public', view: 'public' },
});
github.isEnabled = () => ghEnabled;
github.getFileContent = async () => ghManifestOnMain;
github.createBranch = async (owner, repo, branch) => { ghCalls.push({ op: 'branch', branch }); };
github.pushFiles = async (owner, repo, files, opts) => { ghCalls.push({ op: 'push', files, opts }); };
github.createPR = async (owner, repo, { branch, title, body }) => {
  ghCalls.push({ op: 'pr', branch, title, body });
  return { number: 777, html_url: 'https://github.com/o/r/pull/777' };
};

process.env.GITHUB_BOT_TOKEN = process.env.GITHUB_BOT_TOKEN || 'test-token';

const appAdminsSvc = require('../src/services/app-admins');
const { appRoutes } = require('../src/routes/apps');
const express = require('express');

const APP_ROW = {
  id: 21,
  slug: 'demo',
  name: 'Demo',
  created_by: 1,
  self_hosted: false,
  repo_url: 'https://github.com/o/r',
  collab_visibility: 'public',
  view_visibility: 'public',
  admin_usernames: [],
};

let currentUser = { id: 1, username: 'creator', isAdmin: false };
let appRow;
let openAdminsSession;
let sqlCalls;

function defaultHandler() {
  return async (sql, params) => {
    sqlCalls.push({ sql, params });
    if (/FROM apps WHERE slug = \$1/.test(sql)) {
      return { rows: appRow ? [appRow] : [] };
    }
    if (/branch_name LIKE 'admins\/%'/.test(sql)) {
      return { rows: openAdminsSession ? [openAdminsSession] : [] };
    }
    if (/INSERT INTO chat_sessions/.test(sql)) {
      return { rows: [{ id: 5151 }] };
    }
    if (/COUNT\(DISTINCT a\.user_id\) AS cnt/.test(sql)) {
      return { rows: [{ cnt: '3' }] };
    }
    return { rows: [] };
  };
}

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test.beforeEach(() => {
  ghCalls = [];
  sqlCalls = [];
  ghEnabled = true;
  appRow = { ...APP_ROW, admin_usernames: [] };
  openAdminsSession = null;
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  poolQueryHandler = defaultHandler();
  // The app-admins service TTL-caches app_admins rosters per app —
  // flush between tests so one test's cached roster can't leak.
  appAdminsSvc.invalidateAppAdmins(APP_ROW.id);
});

function propose(body) {
  return fetch(`${base}/api/apps/demo/admins-pr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── validation ───────────────────────────────────────────────────────

test('non-array / non-string admins are rejected with 400', async () => {
  let res = await propose({ admins: 'alice' });
  assert.equal(res.status, 400);
  res = await propose({});
  assert.equal(res.status, 400);
  res = await propose({ admins: ['alice', 42] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /array of usernames/);
});

test('more than 20 admins is a 400 naming the cap', async () => {
  const admins = Array.from({ length: 21 }, (_, i) => `user${i}`);
  const res = await propose({ admins });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at most 20 admins/);
});

test('an over-long username entry is a 400', async () => {
  const res = await propose({ admins: ['a'.repeat(256)] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /capped at 255 characters/);
});

test('an unchanged roster is a 400 — including pure re-ordering and re-casing', async () => {
  appRow.admin_usernames = ['Alice', 'bob'];
  let res = await propose({ admins: ['Alice', 'bob'] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /already declares those admins/);
  // Re-ordering is not a change.
  res = await propose({ admins: ['bob', 'Alice'] });
  assert.equal(res.status, 400);
  // Re-casing is not a change.
  res = await propose({ admins: ['ALICE', 'Bob'] });
  assert.equal(res.status, 400);
  // Duplicates collapse before comparing.
  res = await propose({ admins: ['alice', '@Alice', 'bob'] });
  assert.equal(res.status, 400);
});

// ── gates ────────────────────────────────────────────────────────────

test('non-creator non-admin gets 403', async () => {
  currentUser = { id: 99, username: 'rando', isAdmin: false };
  const res = await propose({ admins: ['alice'] });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /app creator or an app admin/);
});

test('a non-viewer of a private app gets the existence-hiding 404', async () => {
  appRow.collab_visibility = 'private';
  appRow.view_visibility = 'private';
  currentUser = { id: 99, username: 'stranger', isAdmin: false };
  const res = await propose({ admins: ['alice'] });
  assert.equal(res.status, 404);
});

test('the self-hosted platform app is refused with 403 (reconcile skips it)', async () => {
  appRow.self_hosted = true;
  const res = await propose({ admins: ['alice'] });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /does not apply to the self-app row/);
});

test('GitHub disabled means 503', async () => {
  ghEnabled = false;
  const res = await propose({ admins: ['alice'] });
  assert.equal(res.status, 503);
});

test('no repo_url means 400', async () => {
  appRow.repo_url = null;
  const res = await propose({ admins: ['alice'] });
  assert.equal(res.status, 400);
});

test('an open admins PR dedupes to 409 with a pointer at it', async () => {
  openAdminsSession = { id: 88, pr_number: 654, pr_url: 'https://github.com/o/r/pull/654' };
  const res = await propose({ admins: ['alice'] });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.sessionId, 88);
  assert.equal(body.prNumber, 654);
  assert.match(body.error, /already waiting for approval/);
});

// ── success paths ────────────────────────────────────────────────────

test('success: opens an admins/ branch PR editing dapp.json, normalized, other keys preserved', async () => {
  const res = await propose({ admins: ['@Bob', ' alice ', 'ALICE', ''] });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.sessionId, 5151);
  assert.equal(body.prNumber, 777);

  const branchCall = ghCalls.find((c) => c.op === 'branch');
  assert.match(branchCall.branch, /^admins\/demo-\d+$/);

  const push = ghCalls.find((c) => c.op === 'push');
  assert.equal(push.files[0].path, 'dapp.json');
  const written = JSON.parse(push.files[0].content);
  // Normalized: @ stripped, trimmed, case-insensitive dedupe keeping
  // first-occurrence display casing.
  assert.deepEqual(written.admins, ['Bob', 'alice']);
  // Existing manifest fields are preserved; only the block is added.
  assert.equal(written.name, 'Demo');
  assert.equal(written.secrets[0].key, 'FOO_KEY');
  assert.deepEqual(written.visibility, { build: 'public', view: 'public' });

  const pr = ghCalls.find((c) => c.op === 'pr');
  assert.equal(pr.title, 'Change app admins: @Bob, @alice');
  assert.match(pr.body, /`admins` array in `dapp\.json`/);
  assert.match(pr.body, /only a platform admin/);
});

test('success stamps requires_explicit_approval = true / reason = admins on the session', async () => {
  const res = await propose({ admins: ['alice'] });
  assert.equal(res.status, 201);
  const stamp = sqlCalls.find((c) => /requires_explicit_approval/.test(c.sql)
    && /UPDATE chat_sessions/.test(c.sql));
  assert.ok(stamp, 'the explicit-approval UPDATE was issued');
  assert.deepEqual(stamp.params, [5151, true, 'admins']);
});

test('an empty array succeeds when the current roster is non-empty (revocation stays expressible)', async () => {
  appRow.admin_usernames = ['alice', 'bob'];
  const res = await propose({ admins: [] });
  assert.equal(res.status, 201);
  const push = ghCalls.find((c) => c.op === 'push');
  const written = JSON.parse(push.files[0].content);
  assert.deepEqual(written.admins, []);
  const pr = ghCalls.find((c) => c.op === 'pr');
  assert.match(pr.title, /no per-app admins/);
});

test('a full platform admin can propose on apps they did not create', async () => {
  currentUser = { id: 50, username: 'boss', isAdmin: true, canAdminWrite: true };
  const res = await propose({ admins: ['alice'] });
  assert.equal(res.status, 201);
});

// ── GET /admins openProposal pointer ─────────────────────────────────

test('GET /admins returns openProposal when an admins PR is up for vote, null otherwise', async () => {
  appRow.admin_usernames = ['alice'];
  let res = await fetch(`${base}/api/apps/demo/admins`);
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.openProposal, null);
  assert.deepEqual(body.declared, ['alice']);
  assert.equal(body.canManage, true);

  openAdminsSession = { id: 88, pr_number: 654, pr_url: 'https://github.com/o/r/pull/654' };
  res = await fetch(`${base}/api/apps/demo/admins`);
  body = await res.json();
  assert.deepEqual(body.openProposal,
    { sessionId: 88, prNumber: 654, prUrl: 'https://github.com/o/r/pull/654' });
});
