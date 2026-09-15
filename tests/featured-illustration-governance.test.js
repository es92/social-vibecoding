// The `featured_illustration` governance kind (#2086).
//
// A featured-illustration change is a proposal now, modelled on the rename
// card: it applies when the vote passes under the app's gate, and an admin
// can force-apply it. This suite pins the apply half and the surfaces that
// have to know the kind:
//
//   * maybeApplyFeaturedIllustrationProposal (src/routes/issues.js): below
//     the gate leaves the row open and writes nothing; a passing vote moves
//     the pending bytes into app_illustrations under the SAME ids, writes the
//     proposed record onto the app, closes the issue with an audit payload
//     and announces it; a removal clears both; a locked app waits for an
//     admin up;
//   * POST /api/issues/:id/admin-apply accepts the kind and applies with the
//     gate bypassed, naming the admin;
//   * the two governance sweepers in server.js and the kind lists in
//     issues.js / shared-objects.js carry the kind, so a window-elapsed
//     proposal is applied by the ticker rather than falling through to the
//     secret-change path, and the card resolves by id and as a share;
//   * the board card renders the proposed image beside the current one, as
//     an <img> with alt text and never a link, and offers the admin the same
//     force-apply row the other kinds get.
//
// Same harness as tests/close-issue-proposal.test.js: collaborators stubbed
// via require.cache, handlers driven off the router stack.
//
// Run with: node --test tests/featured-illustration-governance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { govCardHtml } = require('./lib/dev-card-html');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ── Mock pool ─────────────────────────────────────────────────────────────
function makePool(handlers) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, rows] of handlers) {
      if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows };
    }
    return { rows: [] };
  };
  return {
    calls,
    query,
    async connect() { return { query, release() {} }; },
    issued(re) { return calls.find((c) => re.test(c.sql)); },
    issuedAll(re) { return calls.filter((c) => re.test(c.sql)); },
  };
}

const APP = { id: 9, slug: 'cool-app', name: 'Cool App', repo_url: 'https://github.com/acme/cool-app' };

function loadIssues(pool, { active = 2, locked = false, adminUp = true } = {}) {
  const realActiveUsers = require('../src/services/active-users');
  const ids = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    appAccess: require.resolve('../src/services/app-access'),
    appAdmins: require.resolve('../src/services/app-admins'),
    activeUsers: require.resolve('../src/services/active-users'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    proposals: require.resolve('../src/services/illustration-proposals'),
    subject: require.resolve('../src/routes/issues'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const spies = { systemMessages: [], issueUpdates: [], appUpdates: [] };
  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  stub(ids.pool, { getPool: () => pool });
  const realWs = orig.ws ? orig.ws.exports : require('../src/services/ws');
  stub(ids.ws, {
    ...realWs,
    sendSystemMessage: async (...args) => { spies.systemMessages.push(args); },
    pushIssueUpdate: (data) => { spies.issueUpdates.push(data); },
    pushAppUpdate: (data) => { spies.appUpdates.push(data); },
  });
  stub(ids.appAccess, {
    ACCESS_COLUMNS: '*',
    issueCollabGuard: () => (_req, _res, next) => next(),
    getAppForUser: async () => ({ ...APP }),
  });
  const realAdmins = orig.appAdmins ? orig.appAdmins.exports : require('../src/services/app-admins');
  stub(ids.appAdmins, {
    ...realAdmins,
    canForceMerge: async (_pool, _app, user) => !!(user && user.canAdminWrite),
  });
  stub(ids.activeUsers, {
    ...realActiveUsers,
    getActiveUserStats: async () => ({ active, majority: Math.floor(active / 2) + 1 }),
  });
  stub(ids.adminApproval, { isAppLocked: async () => locked, hasAdminUpVote: async () => adminUp });
  // The service reads ws at require time, so it is reloaded under the stub.
  delete require.cache[ids.proposals];
  delete require.cache[ids.subject];
  const subject = require('../src/routes/issues');
  const router = subject.issueRoutes({ databaseUrl: 'postgres://test', jwtSecret: 's' });
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.subject];
    delete require.cache[ids.proposals];
  };
  return { subject, router, spies, restore };
}

function routeHandler(router, routePath, method = 'post') {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`${method} ${routePath} route not found`);
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const NEW_ID = 'b'.repeat(32);
const NEW_DARK_ID = 'c'.repeat(32);
const OLD_ID = 'a'.repeat(32);
const CURRENT = { url: `/app-illustrations/${OLD_ID}`, darkUrl: null, zoom: 1, x: 0, y: 0, tint: 'teal' };
const PROPOSED = { url: `/app-illustrations/${NEW_ID}`, darkUrl: `/app-illustrations/${NEW_DARK_ID}`, zoom: 1.4, x: 10, y: -5, tint: 'blue' };

const PROPOSAL = (over) => ({
  id: 71, app_id: 9, created_by: 42, kind: 'featured_illustration', status: 'open',
  github_issue_number: null,
  title: 'Change the featured illustration',
  payload: { proposed: PROPOSED, current: CURRENT, remove: false },
  created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
  app_slug: 'cool-app', app_created_by: 1,
  ...over,
});

const PENDING_ROW = {
  issue_id: 71, app_id: 9,
  id: NEW_ID, content_type: 'image/png', data: Buffer.from('new-light'),
  dark_id: NEW_DARK_ID, dark_content_type: 'image/webp', dark_data: Buffer.from('new-dark'),
};
const CURRENT_ROW = {
  app_id: 9, id: OLD_ID, content_type: 'image/jpeg', data: Buffer.from('old-light'),
  dark_id: null, dark_content_type: null, dark_data: null,
};

function applyPool({ up = 2, down = 0, lockedRow, pending = PENDING_ROW, current = CURRENT_ROW } = {}) {
  return makePool([
    [/SELECT i\.\*, a\.slug AS app_slug/, [lockedRow]],
    [/vote = 'up'/, [{ cnt: String(up) }]],
    [/vote = 'down'/, [{ cnt: String(down) }]],
    [/SELECT \* FROM issues WHERE id = \$1 FOR UPDATE/, [lockedRow]],
    [/SELECT id, slug, name FROM apps WHERE id = \$1 FOR UPDATE/, [{ id: APP.id, slug: APP.slug, name: APP.name }]],
    [/SELECT \* FROM app_illustration_proposals WHERE issue_id/, pending ? [pending] : []],
    [/SELECT \* FROM app_illustrations WHERE app_id/, current ? [current] : []],
  ]);
}

// ── Vote apply ────────────────────────────────────────────────────────────

test('apply: below the gate leaves the proposal open and writes nothing', async () => {
  const proposal = PROPOSAL({ created_at: new Date().toISOString() });
  const pool = applyPool({ up: 0, lockedRow: proposal });
  const { subject, spies, restore } = loadIssues(pool, { active: 20 });
  try {
    const r = await subject.maybeApplyFeaturedIllustrationProposal(pool, proposal);
    assert.equal(r.applied, false);
    assert.ok(!pool.issued(/BEGIN/), 'no transaction opened');
    assert.ok(!pool.issued(/UPDATE apps/));
    assert.ok(!pool.issued(/INSERT INTO app_illustrations/));
    assert.equal(spies.systemMessages.length, 0);
    assert.equal(spies.appUpdates.length, 0);
  } finally { restore(); }
});

test('apply: a passing vote publishes the proposed record under the ids the card previewed', async () => {
  const proposal = PROPOSAL();
  const pool = applyPool({ up: 2, down: 0, lockedRow: proposal });
  const { subject, spies, restore } = loadIssues(pool, { active: 2 });
  try {
    const r = await subject.maybeApplyFeaturedIllustrationProposal(pool, proposal);
    assert.equal(r.applied, true);
    assert.deepEqual(r.illustration, PROPOSED);

    // Inside one transaction: the issue row locked, the pending bytes moved
    // into app_illustrations under the SAME ids (so the preview url the card
    // rendered keeps resolving), the record written, the issue closed.
    const sql = pool.calls.map((c) => c.sql);
    const at = (re) => sql.findIndex((s) => re.test(s));
    assert.ok(at(/BEGIN/) < at(/FOR UPDATE/), 'lock inside the txn');
    const upsert = pool.issued(/INSERT INTO app_illustrations/);
    assert.ok(upsert, 'illustration row upserted');
    assert.deepEqual(upsert.params.slice(0, 4), [9, NEW_ID, 'image/png', Buffer.from('new-light')]);
    assert.deepEqual(upsert.params.slice(4), [NEW_DARK_ID, 'image/webp', Buffer.from('new-dark')]);
    const write = pool.issued(/UPDATE apps SET featured_illustration = \$2::jsonb/);
    assert.ok(write, 'the app record is written');
    assert.deepEqual(write.params, [9, JSON.stringify(PROPOSED)]);
    assert.ok(pool.issued(/DELETE FROM app_illustration_proposals WHERE issue_id/), 'the pending row is retired');
    const upd = pool.issued(/UPDATE issues SET status = 'closed', payload = \$1/);
    assert.ok(upd, 'proposal closed');
    const audit = JSON.parse(upd.params[0]);
    assert.equal(audit.appliedBy, 'group-vote');
    assert.ok(audit.appliedAt);
    assert.equal(audit.upCount, 2);
    assert.deepEqual(audit.proposed, PROPOSED, 'original payload preserved');
    assert.ok(at(/UPDATE issues SET status = 'closed'/) < at(/COMMIT/), 'closed before commit');

    // Announced in group chat and in the proposal's own thread; every open
    // client is told the app changed so its caches patch themselves.
    assert.equal(spies.systemMessages.length, 2);
    assert.match(spies.systemMessages[0][2], /Featured illustration changed by group vote \(2\/2\)/);
    assert.deepEqual(spies.systemMessages[1][5], { type: 'governance', ref: 71 });
    assert.deepEqual(spies.appUpdates, [{ action: 'illustration_changed', appId: 9, slug: 'cool-app', illustration: PROPOSED }]);
    assert.deepEqual(spies.issueUpdates, [{ action: 'closed', appSlug: 'cool-app', appId: 9, issueId: 71 }]);
  } finally { restore(); }
});

test('apply: a kept image is read from the app\'s current row; a missing one fails closed', async () => {
  // A reframe: the proposal names the current url and carries no bytes.
  const reframed = { ...CURRENT, zoom: 2 };
  const proposal = PROPOSAL({ payload: { proposed: reframed, current: CURRENT, remove: false } });
  let pool = applyPool({ lockedRow: proposal, pending: null });
  let loaded = loadIssues(pool, { active: 2 });
  try {
    const r = await loaded.subject.maybeApplyFeaturedIllustrationProposal(pool, proposal);
    assert.equal(r.applied, true);
    const upsert = pool.issued(/INSERT INTO app_illustrations/);
    assert.deepEqual(upsert.params.slice(0, 4), [9, OLD_ID, 'image/jpeg', Buffer.from('old-light')]);
    assert.deepEqual(pool.issued(/UPDATE apps SET featured_illustration/).params[1], JSON.stringify(reframed));
  } finally { loaded.restore(); }
  // The bytes behind the proposed url are gone: roll back, leave it open.
  pool = applyPool({ lockedRow: PROPOSAL(), pending: null });
  loaded = loadIssues(pool, { active: 2 });
  try {
    const r = await loaded.subject.maybeApplyFeaturedIllustrationProposal(pool, PROPOSAL());
    assert.equal(r.applied, false);
    assert.match(r.error, /no longer available/);
    assert.ok(pool.issued(/ROLLBACK/));
    assert.ok(!pool.issued(/UPDATE apps/));
    assert.ok(!pool.issued(/UPDATE issues SET status = 'closed'/));
  } finally { loaded.restore(); }
});

test('apply: a removal clears the illustration and its bytes', async () => {
  const proposal = PROPOSAL({ title: 'Remove the featured illustration', payload: { proposed: null, current: CURRENT, remove: true } });
  const pool = applyPool({ lockedRow: proposal, pending: null });
  const { subject, spies, restore } = loadIssues(pool, { active: 2 });
  try {
    const r = await subject.maybeApplyFeaturedIllustrationProposal(pool, proposal);
    assert.equal(r.applied, true);
    assert.equal(r.illustration, null);
    assert.ok(pool.issued(/DELETE FROM app_illustrations WHERE app_id/));
    assert.ok(pool.issued(/UPDATE apps SET featured_illustration = NULL/));
    assert.ok(!pool.issued(/INSERT INTO app_illustrations/));
    assert.match(spies.systemMessages[0][2], /Featured illustration removed by group vote/);
    assert.deepEqual(spies.appUpdates[0], { action: 'illustration_changed', appId: 9, slug: 'cool-app', illustration: null });
  } finally { restore(); }
});

test('apply: a locked app waits for an admin up, like the rename path', async () => {
  const proposal = PROPOSAL();
  const pool = applyPool({ lockedRow: proposal });
  const { subject, restore } = loadIssues(pool, { active: 2, locked: true, adminUp: false });
  try {
    const r = await subject.maybeApplyFeaturedIllustrationProposal(pool, proposal);
    assert.equal(r.applied, false);
    assert.equal(r.awaitingAdmin, true);
    assert.ok(!pool.issued(/BEGIN/));
  } finally { restore(); }
});

test('vote route: an up-vote on the kind runs the apply and reports it as illustrationChanged', async () => {
  const proposal = PROPOSAL();
  const pool = applyPool({ lockedRow: proposal });
  const { router, restore } = loadIssues(pool, { active: 2 });
  try {
    const handler = routeHandler(router, '/api/issues/:id/vote');
    const res = mockRes();
    await handler({ params: { id: '71' }, user: { id: 5, username: 'voter' }, body: { vote: 'up' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.illustrationChanged.applied, true);
    assert.equal(res.body.secretChanged, null);
    assert.ok(pool.issued(/INSERT INTO issue_votes/));
  } finally { restore(); }
});

// ── Admin force-apply ─────────────────────────────────────────────────────

test('admin-apply: accepts the kind with the gate bypassed and names the admin; non-admin 403', async () => {
  const proposal = PROPOSAL({ created_at: new Date().toISOString() });
  const pool = applyPool({ up: 0, lockedRow: proposal });
  const { router, spies, restore } = loadIssues(pool, { active: 20, locked: true, adminUp: false });
  try {
    const handler = routeHandler(router, '/api/issues/:id/admin-apply');
    const denied = mockRes();
    await handler({ params: { id: '71' }, user: { id: 5, username: 'someone', canAdminWrite: false } }, denied);
    assert.equal(denied.statusCode, 403);
    assert.ok(!pool.issued(/UPDATE apps/));

    const res = mockRes();
    await handler({ params: { id: '71' }, user: { id: 1, username: 'root', canAdminWrite: true } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.applied.applied, true);
    assert.equal(res.body.secretChanged, null, 'the BC alias stays null for this kind');
    // Gate and lock bypassed: no votes, a locked app, and it still landed.
    assert.ok(pool.issued(/UPDATE apps SET featured_illustration = \$2::jsonb/));
    const audit = JSON.parse(pool.issued(/UPDATE issues SET status = 'closed', payload = \$1/).params[0]);
    assert.equal(audit.appliedBy, 'admin:root');
    assert.match(spies.systemMessages[0][2], /by admin override \(root\)/);
  } finally { restore(); }
});

// ── Wiring: every surface that enumerates the governance kinds ───────────

test('the sweepers, the by-id read and the share resolver carry the kind', () => {
  const server = read('server.js');
  assert.equal((server.match(/i\.kind IN \('rename', 'secret_change', 'close_issue', 'maintenance_campaign',\s*'featured_illustration'\)/g) || []).length, 2,
    'both governance sweeps select the kind');
  assert.equal((server.match(/issue\.kind === 'featured_illustration'\)\s*\{\s*(?:result = )?await issuesModule\.maybeApplyFeaturedIllustrationProposal\(pool, issue\)/g) || []).length, 2,
    'both sweeps dispatch to its own apply rather than the secret-change default');
  const issues = read('src/routes/issues.js');
  assert.match(issues, /AND i\.kind IN \('secret_change', 'rename', 'close_issue', 'maintenance_campaign',\s*'featured_illustration'\)\s*LIMIT 1/,
    'GET /api/apps/:slug/governance/:id resolves the kind');
  assert.match(issues, /module\.exports = \{[^}]*maybeApplyFeaturedIllustrationProposal,/, 'exported for the sweepers');
  const shared = read('src/services/shared-objects.js');
  assert.equal((shared.match(/'maintenance_campaign',\s*'featured_illustration'\)/g) || []).length, 2);
  // The generic create route does not accept it: the bytes travel with the
  // save, through the illustration endpoint.
  assert.match(issues, /const VALID_KINDS = \['general', 'secret_change', 'close_issue', 'maintenance_campaign'\];/);
  // And it gets no GitHub twin, like the other platform-governance kinds.
  const { shouldCreateGithubTwin } = require('../src/routes/issues');
  assert.equal(shouldCreateGithubTwin('featured_illustration'), false);
  // The schema holds the pending bytes and the one-open-per-app guard.
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS app_illustration_proposals \(\s*issue_id INTEGER PRIMARY KEY REFERENCES issues\(id\) ON DELETE CASCADE/);
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_open_featured_illustration\s+ON issues \(app_id\)\s+WHERE kind = 'featured_illustration' AND status = 'open'/);
});

test('the staging mock row is served under ?demo=1 and is what the declared checks read', () => {
  const issues = read('src/routes/issues.js');
  assert.match(issues, /mk\(9100008, 'featured_illustration', '\[Mock\] Change the featured illustration'/);
  const dapp = JSON.parse(read('dapp.json'));
  const checks = dapp.tests.filter((t) => /#2086/.test(t.name));
  assert.equal(checks.length, 2);
  for (const t of checks) {
    assert.match(t.path, /demo=1/);
    assert.match(t.expectSelector, /\[data-gov-row='9100008'\] \[data-illustration-preview\]/);
    assert.match(t.expectSelector, /img\[alt\]$/);
  }
});

// ── The card ──────────────────────────────────────────────────────────────

const APP_VIEW_SRC = read('public/js/app-view.js');
function makeAppView({ user = { id: 1, username: 'me' } } = {}) {
  const sandbox = {
    console, relTime: () => '2h ago',
    escapeHtml: (s) => String(s == null ? '' : s), escapeAttr: (s) => String(s == null ? '' : s),
    App: { user, currentApp: 'demo-app', currentSubTab: 'forum', _appUrl: () => '#x', switchTab: () => {} },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }), addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '', hash: '', href: 'http://localhost/' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  AppView._proposalsCtx = { majority: 2, activeUsers: 3 };
  AppView._govProposals = [];
  return AppView;
}

const CARD_ROW = (over) => ({
  id: 9100008, app_id: 0, kind: 'featured_illustration',
  title: 'Change the featured illustration',
  description: 'maker proposed changing the featured illustration.',
  status: 'open',
  payload: { proposed: { url: '/icons/icon-512.png', darkUrl: null, zoom: 1.2, x: 10, y: -5, tint: 'teal' },
    current: { url: '/icons/icon-192.png', darkUrl: null, zoom: 1, x: 0, y: 0 }, remove: false },
  created_by: 42, created_by_username: 'maker', created_at: new Date().toISOString(),
  up_count: 1, down_count: 0, my_vote: null, chat_count: 0, votes_required: 2, contested: false,
  ...over,
});

test('the card previews the proposed image beside the current one, as images and never links', () => {
  const AppView = makeAppView();
  const html = govCardHtml(AppView, CARD_ROW());
  assert.match(html, /data-gov-row="9100008"/);
  assert.match(html, /Change the featured illustration/);
  const preview = html.slice(html.indexOf('data-illustration-preview="1"'));
  assert.ok(preview.length > 1, 'the preview block renders');
  const current = preview.slice(preview.indexOf('data-illustration-side="current"'), preview.indexOf('data-illustration-side="proposed"'));
  const proposed = preview.slice(preview.indexOf('data-illustration-side="proposed"'));
  assert.match(current, /<img[^>]*src="\/icons\/icon-192\.png"[^>]*alt="Current featured illustration"/);
  assert.match(proposed, /<img[^>]*src="\/icons\/icon-512\.png"[^>]*alt="Proposed featured illustration"/);
  assert.match(proposed, /home-tone-teal/, 'the proposed side wears the proposed card colour');
  assert.ok(!/<a [^>]*href="\/icons/.test(html), 'an API-supplied url is never a clickable anchor');
  assert.ok(!/—/.test(html), 'no em dash in the card copy');
  // Both empty states say so in words: the app icon shows instead.
  const removal = govCardHtml(AppView, CARD_ROW({ payload: { proposed: null, current: CARD_ROW().payload.current, remove: true } }));
  assert.match(removal, /Removed, the app icon shows instead/);
  const first = govCardHtml(AppView, CARD_ROW({ payload: { proposed: CARD_ROW().payload.proposed, current: null, remove: false } }));
  assert.match(first, /No illustration, the app icon shows/);
});

test('the card offers admins the force-apply row, and the kind is in the board filter', () => {
  const admin = makeAppView({ user: { id: 1, username: 'root', canAdminWrite: true, isAdmin: true } });
  const m = admin._govCardModel(CARD_ROW());
  const menu = admin._cardMenus ? admin._cardMenus[m.rail.menuKey] : null;
  const registered = menu || (admin._cardMenuRegistry && admin._cardMenuRegistry[m.rail.menuKey]);
  const labels = (registered || []).map((x) => x.label);
  assert.ok(labels.includes('Admin merge'), `admin row offered: ${JSON.stringify(labels)}`);
  const viewer = makeAppView();
  const mv = viewer._govCardModel(CARD_ROW());
  const vmenu = (viewer._cardMenus && viewer._cardMenus[mv.rail.menuKey])
    || (viewer._cardMenuRegistry && viewer._cardMenuRegistry[mv.rail.menuKey]) || [];
  assert.ok(!vmenu.map((x) => x.label).includes('Admin merge'), 'a plain member gets no admin row');
  assert.equal(viewer._govApplyLabel('featured_illustration'), 'Updating illustration…');
  assert.match(APP_VIEW_SRC, /\|\| i\.kind === 'maintenance_campaign' \|\| i\.kind === 'featured_illustration'\);/);
  assert.match(APP_VIEW_SRC, /data\?\.campaignStarted \|\| data\?\.illustrationChanged \|\| null;/);
});
