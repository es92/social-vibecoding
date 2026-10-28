'use strict';

// #5048: private requests, which only platform admins can see
// (src/routes/private-requests.js).
//
// The wall is the load-bearing part: every route answers a non-admin exactly
// as it answers an id that does not exist (404), so nobody else can learn
// that one exists, and a view-only admin reads but cannot file, comment or
// close. Also pinned: the tables are staging:private, the dialog's private
// submit never reaches /api/feedback or the outbox (both file a public
// GitHub issue), and the Workshop section draws nothing on its first pass.
//
// Stubbed-pool + real-express pattern, cf. tests/admin-storage-route.test.js.
//
// Run with: node --test tests/private-requests.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

const apps = [
  { id: 1, slug: 'homeroom', name: 'Homeroom', self_hosted: true },
  { id: 2, slug: 'notes', name: 'Notes', self_hosted: false },
];
const users = { 10: 'ada', 11: 'viewer', 12: 'member' };
let requests = [];
let comments = [];

function requestRow(r) {
  return {
    ...r,
    created_by_username: users[r.created_by] || null,
    closed_by_username: users[r.closed_by] || null,
    comment_count: comments.filter((c) => c.private_request_id === r.id).length,
  };
}

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query(sql, params = []) {
    const q = norm(sql);
    if (q.startsWith('SELECT id, slug, name FROM apps WHERE slug = $1')) {
      return { rows: apps.filter((a) => a.slug === params[0]) };
    }
    if (q.startsWith('SELECT id, slug, name FROM apps WHERE self_hosted = TRUE')) {
      return { rows: apps.filter((a) => a.self_hosted) };
    }
    if (q.includes('FROM private_requests pr') && q.includes('pr.id = $2')) {
      const r = requests.find((x) => x.app_id === params[0] && x.id === params[1]);
      return { rows: r ? [requestRow(r)] : [] };
    }
    if (q.includes('FROM private_requests pr') && q.includes('pr.status = $2')) {
      return {
        rows: requests.filter((x) => x.app_id === params[0] && x.status === params[1])
          .sort((a, b) => b.id - a.id).map(requestRow),
      };
    }
    if (q.startsWith('SELECT c.id, c.body, c.created_at, u.username FROM private_request_comments')) {
      return {
        rows: comments.filter((c) => c.private_request_id === params[0])
          .map((c) => ({ ...c, username: users[c.user_id] || null })),
      };
    }
    if (q.startsWith('INSERT INTO private_requests')) {
      const id = requests.length + 1;
      requests.push({
        id, app_id: params[0], title: params[1], description: params[2], created_by: params[3],
        status: 'open', created_at: '2026-10-14T10:00:00Z', updated_at: '2026-10-14T10:00:00Z',
        closed_by: null, closed_at: null,
      });
      return { rows: [{ id }] };
    }
    if (q.startsWith('INSERT INTO private_request_comments')) {
      const c = { id: comments.length + 1, private_request_id: params[0], user_id: params[1], body: params[2], created_at: '2026-10-14T11:00:00Z' };
      comments.push(c);
      return { rows: [{ id: c.id, body: c.body, created_at: c.created_at }] };
    }
    if (q.startsWith('UPDATE private_requests SET updated_at = NOW() WHERE id = $1')) return { rows: [], rowCount: 1 };
    if (q.startsWith("UPDATE private_requests SET status = 'closed'")) {
      const r = requests.find((x) => x.app_id === params[0] && x.id === params[1]);
      if (!r) return { rows: [], rowCount: 0 };
      Object.assign(r, { status: 'closed', closed_by: params[2], closed_at: '2026-10-14T12:00:00Z' });
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE private_requests SET status = 'open'")) {
      const r = requests.find((x) => x.app_id === params[0] && x.id === params[1]);
      if (!r) return { rows: [], rowCount: 0 };
      Object.assign(r, { status: 'open', closed_by: null, closed_at: null });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${q}`);
  },
});

const express = require('express');
const {
  privateRequestRoutes, deriveTitle, parseNewRequest, shapeRequest,
} = require('../src/routes/private-requests');

const PEOPLE = {
  full: { id: 10, username: 'ada', isAdmin: true, canAdminWrite: true },
  viewonly: { id: 11, username: 'viewer', isAdmin: true, canAdminWrite: false },
  member: { id: 12, username: 'member', isAdmin: false, canAdminWrite: false },
};
const bases = {};
const servers = [];

test.before(async () => {
  for (const [key, user] of Object.entries(PEOPLE)) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use(privateRequestRoutes({}));
    const server = app.listen(0);
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    bases[key] = `http://127.0.0.1:${server.address().port}`;
  }
});
test.after(() => { for (const s of servers) s.close(); });
test.beforeEach(() => { requests = []; comments = []; });

const post = (base, url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

test('deriveTitle takes the first non-empty line and cuts it on a word', () => {
  assert.equal(deriveTitle('\n\n  Rotate   the key \nmore'), 'Rotate the key');
  const long = `${'word '.repeat(30)}end`;
  const title = deriveTitle(long);
  assert.ok(title.length <= 80, title);
  assert.ok(title.endsWith('…'));
  assert.ok(!title.includes('wor…'), 'cut on a word boundary');
});

test('parseNewRequest validates and defaults', () => {
  assert.equal(parseNewRequest({}).ok, false);
  assert.equal(parseNewRequest({ description: '   ' }).ok, false);
  assert.equal(parseNewRequest({ description: 'x', title: 5 }).ok, false);
  assert.equal(parseNewRequest({ description: 'x', title: 'y'.repeat(201) }).ok, false);
  assert.equal(parseNewRequest({ description: 'x', target: 'app' }).ok, false, 'app needs a slug');
  assert.deepEqual(parseNewRequest({ description: ' Leak in logs ', target: 'nope' }), {
    ok: true, title: 'Leak in logs', description: 'Leak in logs', target: 'platform', appSlug: null,
  });
  assert.equal(parseNewRequest({ description: 'd', title: '  T  ', target: 'app', appSlug: 'notes' }).title, 'T');
});

test('shapeRequest never reports anything but open or closed', () => {
  assert.equal(shapeRequest({ id: 1, status: 'weird' }).status, 'open');
  assert.equal(shapeRequest({ id: 1, status: 'closed', comment_count: '3' }).commentCount, 3);
});

test('a non-admin gets 404 from every route, whether or not the request exists', async () => {
  const filed = await post(bases.full, '/api/private-requests', { target: 'app', appSlug: 'notes', description: 'Secret' });
  assert.equal(filed.status, 201);
  const { request } = await filed.json();
  const tries = [
    fetch(`${bases.member}/api/apps/notes/private-requests`),
    fetch(`${bases.member}/api/apps/notes/private-requests/${request.id}`),
    fetch(`${bases.member}/api/apps/notes/private-requests/999`),
    post(bases.member, '/api/private-requests', { target: 'app', appSlug: 'notes', description: 'x' }),
    post(bases.member, `/api/apps/notes/private-requests/${request.id}/comments`, { body: 'hi' }),
    post(bases.member, `/api/apps/notes/private-requests/${request.id}/close`),
    post(bases.member, `/api/apps/notes/private-requests/${request.id}/reopen`),
  ];
  for (const res of await Promise.all(tries)) {
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found' });
  }
  assert.equal(requests.length, 1, 'the member filed nothing');
  assert.equal(comments.length, 0);
  assert.equal(requests[0].status, 'open');
});

test('a full admin files, lists, reads, comments, closes and reopens', async () => {
  let res = await post(bases.full, '/api/private-requests', {
    target: 'app', appSlug: 'notes', title: 'Token in a log line', description: 'Found it in the worker logs.',
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.appSlug, 'notes');
  assert.equal(created.request.title, 'Token in a log line');
  assert.equal(created.request.createdBy, 'ada');
  const id = created.request.id;

  res = await fetch(`${bases.full}/api/apps/notes/private-requests`);
  let body = await res.json();
  assert.equal(body.canWrite, true);
  assert.deepEqual(body.requests.map((r) => r.id), [id]);

  res = await post(bases.full, `/api/apps/notes/private-requests/${id}/comments`, { body: '  Rotating now  ' });
  assert.equal(res.status, 201);
  assert.deepEqual((await res.json()).comment.body, 'Rotating now');

  body = await (await fetch(`${bases.full}/api/apps/notes/private-requests/${id}`)).json();
  assert.equal(body.request.commentCount, 1);
  assert.deepEqual(body.comments.map((c) => [c.author, c.body]), [['ada', 'Rotating now']]);

  res = await post(bases.full, `/api/apps/notes/private-requests/${id}/close`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).request.status, 'closed');
  body = await (await fetch(`${bases.full}/api/apps/notes/private-requests`)).json();
  assert.deepEqual(body.requests, [], 'a closed request leaves the open list');
  body = await (await fetch(`${bases.full}/api/apps/notes/private-requests?state=closed`)).json();
  assert.deepEqual(body.requests.map((r) => [r.id, r.closedBy]), [[id, 'ada']]);

  res = await post(bases.full, `/api/apps/notes/private-requests/${id}/reopen`);
  assert.equal((await res.json()).request.status, 'open');
});

test('a platform request lands on the self-hosted project', async () => {
  const res = await post(bases.full, '/api/private-requests', { target: 'platform', description: 'Platform secret' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).appSlug, 'homeroom');
  assert.equal(requests[0].app_id, 1);
});

test('a request is scoped to its app', async () => {
  await post(bases.full, '/api/private-requests', { target: 'app', appSlug: 'notes', description: 'On notes' });
  const res = await fetch(`${bases.full}/api/apps/homeroom/private-requests/1`);
  assert.equal(res.status, 404);
});

test('a view-only admin reads but cannot file, comment or close', async () => {
  await post(bases.full, '/api/private-requests', { target: 'app', appSlug: 'notes', description: 'Read me' });
  let res = await fetch(`${bases.viewonly}/api/apps/notes/private-requests`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).canWrite, false);
  res = await fetch(`${bases.viewonly}/api/apps/notes/private-requests/1`);
  assert.equal(res.status, 200);
  for (const r of await Promise.all([
    post(bases.viewonly, '/api/private-requests', { target: 'app', appSlug: 'notes', description: 'x' }),
    post(bases.viewonly, '/api/apps/notes/private-requests/1/comments', { body: 'x' }),
    post(bases.viewonly, '/api/apps/notes/private-requests/1/close'),
  ])) assert.equal(r.status, 403);
  assert.equal(requests.length, 1);
  assert.equal(comments.length, 0);
  assert.equal(requests[0].status, 'open');
});

test('bad input is refused before anything is written', async () => {
  for (const r of await Promise.all([
    post(bases.full, '/api/private-requests', { target: 'app', appSlug: 'notes' }),
    post(bases.full, '/api/private-requests', { target: 'app', appSlug: 'notes', description: 'x'.repeat(20001) }),
  ])) assert.equal(r.status, 400);
  assert.equal((await post(bases.full, '/api/private-requests', { target: 'app', appSlug: 'nope', description: 'x' })).status, 404);
  await post(bases.full, '/api/private-requests', { target: 'app', appSlug: 'notes', description: 'x' });
  assert.equal((await post(bases.full, '/api/apps/notes/private-requests/1/comments', { body: '  ' })).status, 400);
  assert.equal((await fetch(`${bases.full}/api/apps/notes/private-requests/abc`)).status, 404);
  assert.equal(requests.length, 1);
  assert.equal(comments.length, 0);
});

test('a write from another origin on the same site is refused before anything is written', async () => {
  await post(bases.full, '/api/private-requests', { target: 'app', appSlug: 'notes', description: 'x' });
  const crossSite = (url, body) => fetch(`${bases.full}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' },
    body: JSON.stringify(body || {}),
  });
  for (const r of await Promise.all([
    crossSite('/api/private-requests', { target: 'app', appSlug: 'notes', description: 'y' }),
    crossSite('/api/apps/notes/private-requests/1/comments', { body: 'z' }),
    crossSite('/api/apps/notes/private-requests/1/close'),
  ])) assert.equal(r.status, 403);
  assert.equal(requests.length, 1);
  assert.equal(comments.length, 0);
  assert.equal(requests[0].status, 'open');
  const ok = await fetch(`${bases.full}/api/apps/notes/private-requests/1/close`, {
    method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(ok.status, 200, 'the Homeroom page itself still can');
});

test('the production debugging role can never read them', () => {
  const src = read('src/services/debug-access.js');
  assert.match(src, /'private_requests',/);
  assert.match(src, /'private_request_comments',/);
});

test('the admin console may read them', () => {
  const scope = read('src/services/topochain/db-console-scope.js');
  assert.match(scope, /'private_requests',\n  'private_request_comments',\n\]\);/);
});

test('both tables are staging:private and the route is mounted', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /COMMENT ON TABLE private_requests IS 'staging:private';/);
  assert.match(schema, /COMMENT ON TABLE private_request_comments IS 'staging:private';/);
  assert.match(read('server.js'), /require\('\.\/src\/routes\/private-requests'\)\.privateRequestRoutes\(config\)/);
});

test('the staging seed is a no-op outside staging and runs after the self app', () => {
  const migrate = read('src/db/migrate.js');
  const fn = migrate.slice(migrate.indexOf('async function seedStagingPrivateRequest'));
  assert.match(fn.slice(0, 400), /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/);
  assert.ok(migrate.indexOf('await seedSelfApp(pool, config);') < migrate.indexOf('await seedStagingPrivateRequest(pool);'));
});

test("the dialog's private submit never takes the public paths", () => {
  const src = read('frontend/src/features/dialogs/feedback-controller.js');
  const fn = src.slice(src.indexOf('const submitPrivate = async'), src.indexOf('const submitErrorText = (status, error) => {'));
  assert.ok(fn.length > 100, 'submitPrivate is defined just before submitErrorText');
  assert.match(fn, /fetch\('\/api\/private-requests'/);
  assert.doesNotMatch(fn, /\/api\/feedback|saveForLater/, 'no GitHub issue and no outbox');
  // The branch comes before the outbox and the /api/feedback POST.
  const branch = src.indexOf('if (privateChosen()) {\n          await submitPrivate(');
  assert.ok(branch > 0);
  assert.ok(branch < src.indexOf("res = await fetch('/api/feedback'"));
  assert.ok(branch < src.indexOf('if (await saveForLater(body))'));
  // Offered to full admins only.
  assert.match(src, /privateRow\.classList\.toggle\('hidden', !App\.user\?\.canAdminWrite\)/);
});

test('the Workshop section reads admin status in an effect and renders nothing first', () => {
  const src = read('frontend/src/features/dev-board/workshop/private-requests.tsx');
  assert.match(src, /useEffect\(\(\) => \{ setAdmin\(viewerIsAdmin\(\)\); \}, \[\]\);/);
  assert.match(src, /const \[admin, setAdmin\] = useState\(false\);/);
  assert.match(src, /if \(!admin \|\| !requests\.length\) return null;/);
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'), /<PrivateRequests slug=\{slug\} \/>/);
});
