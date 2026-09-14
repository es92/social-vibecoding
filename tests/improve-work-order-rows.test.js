// #1417 — an open connector work order shows in the Improve panel.
//
// Between prepare_work and the moment an agent shares or submits, the person
// who handed the work out sees nothing of it. There is no chat_sessions row
// yet — `external_agent_tasks.session_id` stays NULL until #1347's share path
// or an ordinary submit writes it — and the panel's list is exactly that
// table. The group, meanwhile, already sees the request claimed on their
// behalf (#1225), so the owner is the one person kept in the dark.
//
// The fix is a second row KIND, not a second session. What these tests
// mostly pin is why:
//
//   1. A work order costs no worker, no container and no branch, so it must
//      not be counted in the session budget the caps are denominators for.
//   2. It is never `busy`: its agent runs on the user's own machine, where
//      the platform cannot see whether a turn is in flight. A spinner
//      turning there would be an invention (#1597 made it a spinner; it
//      was a pulsing dot when this was written).
//   3. It points at the REQUEST. There is no transcript to open, and a row
//      that navigates into a dead end is worse than one that admits what it
//      is — which is why the destination travels ON the row rather than
//      being rebuilt from an id that means different things per kind.
//   4. A shared task is excluded, or one piece of work appears twice under
//      two names.
//
// Run with: node --test tests/improve-work-order-rows.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { runModules, makeStoreStub } = require('./helpers/bundle-module');

const svc = require('../src/services/external-agent-tasks');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ROUTE = read('src/routes/sessions.js');
const CONTROLLER = read('frontend/src/features/improve/improve-controller.js');
// The rows render in the hamburger DRAWER via the extracted SessionRow
// (Streamlined Concept) — the Improve panel slimmed to its two actions, and
// the board's drawer is the app's own surface.
const ROW_TSX = read('frontend/src/features/improve/session-row.tsx');
// The app's rows merged into the Improve panel — one surface for the app's
// navigation and its work. This file used to read app-context-rows.tsx.
const SHEET_TSX = read('frontend/src/features/improve/improve-panel.tsx');
const SERVICE = read('src/services/external-agent-tasks.js');

function loadImproveController(fetch) {
  const store = makeStoreStub({
    slug: 'demo', name: 'Demo app', sessions: [], otherSessions: [],
    sessionsLoaded: true, loadingSessions: false,
  });
  const sandbox = {
    console, Promise, setTimeout, clearTimeout, fetch,
    location: { search: '', hash: '' },
    URLSearchParams,
    document: { getElementById: () => null, addEventListener() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  runModules(sandbox, [['improve-controller.js', CONTROLLER]], {
    imports: {
      '../apps/app-card.js': { iconViewFor: (app) => ({ kind: 'letter', letter: app.name[0] }) },
      '../../lib/kit-surface': { adoptKitSurface: () => null },
      '../../lib/sheet-controller.js': { dismissRegisteredSheets() {} },
      './improve-store.js': { improveStore: store },
      '../../lib/shell-snapshot': { saveShellSnapshot() {} },
    },
    tail: 'window.__improve = Improve;',
  });
  return { Improve: sandbox.__improve, store };
}

// A pool that answers one query and records what it was asked, so a test
// states the shape it expects rather than an ordering.
function fakePool(rows, queries = []) {
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows };
    },
  };
}

const ROW = {
  id: 7, issue_number: 1417, branch_name: 'usernode/x',
  brief: '<untrusted-content>Show work orders in the panel</untrusted-content>\n\nbody',
  client_id: 'claude-code', created_at: '2026-08-25T10:00:00Z',
  app_slug: 'usernode-2d5619', app_name: 'Homeroom',
};

// ── The read ───────────────────────────────────────────────────────────

test('only OPEN, unexpired, unshared work orders are listed', async () => {
  const queries = [];
  await svc.listOpenWorkOrders(fakePool([ROW], queries), 42);
  const { sql, params } = queries[0];
  assert.deepEqual(params, [42], 'scoped to the one viewer');
  assert.match(sql, /status = 'open'/);
  assert.match(sql, /expires_at > NOW\(\)/);
  // The one that is easy to leave out: a task carries a session only once
  // its work has been SHARED, and that shared card is already a row in the
  // session list. Without this the panel shows it twice.
  assert.match(sql, /session_id IS NULL/,
    'a shared task is already in the session list — listing it here doubles it');
});

test('a bad user id asks the database nothing at all', async () => {
  for (const bad of [null, undefined, 0, -1, 'nope', 1.5]) {
    const queries = [];
    assert.deepEqual(await svc.listOpenWorkOrders(fakePool([ROW], queries), bad), []);
    assert.equal(queries.length, 0, `queried anyway for ${String(bad)}`);
  }
});

test('a failed lookup costs the rows, not the whole panel', async () => {
  const pool = { async query() { throw new Error('db down'); } };
  assert.deepEqual(await svc.listOpenWorkOrders(pool, 42), []);
});

test('the row carries what a panel row needs, and the agent holding it', async () => {
  const [row] = await svc.listOpenWorkOrders(fakePool([ROW]), 42);
  assert.equal(row.id, 7);
  assert.equal(row.issue_number, 1417);
  assert.equal(row.app_slug, 'usernode-2d5619');
  assert.equal(row.title, 'Show work orders in the panel');
  assert.equal(row.agent, 'claude-code');
});

// ── The title ──────────────────────────────────────────────────────────

test('the title is the request title, without the agent-prompt envelope', () => {
  // prepare_work builds the brief as title, then body, then discussion, each
  // wrapped for an agent's prompt. Those tags are not for a panel row.
  assert.equal(
    svc.workOrderTitle('<untrusted-content>Fix the header</untrusted-content>\n\nlong body', 12),
    'Fix the header'
  );
  // A bare brief (prepare_work takes one with no request) still gets a line.
  assert.equal(svc.workOrderTitle('Make the buttons bigger\nand bluer', null),
    'Make the buttons bigger');
  // Nothing usable falls back to something addressable rather than blank.
  assert.equal(svc.workOrderTitle('', 99), 'Request #99');
  assert.equal(svc.workOrderTitle('   \n  \n', null), 'Work order');
  assert.equal(svc.workOrderTitle(null, null), 'Work order');
  // Long titles are clipped, because the row truncates and a 60KB brief's
  // first line should not travel over the wire to be cut by CSS.
  assert.equal(svc.workOrderTitle('x'.repeat(500), null).length, 120);
});

// ── The endpoint ───────────────────────────────────────────────────────

test('work orders ride the call the panel already makes', () => {
  const handler = ROUTE.slice(ROUTE.indexOf("router.get('/api/me/active-sessions'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));
  assert.match(body, /listOpenWorkOrders\(pool, req\.user\.id\)/);
  assert.match(body, /res\.json\(\{[\s\S]{0,200}externalTasks/,
    'the panel makes exactly one call here; a second round trip is not needed');
});

test('the session lists are fetched before the panel is opened', () => {
  // THE LIST USED TO SNAP IN. `loadSessions()` ran only from `open()`, so the
  // panel presented with `sessionsLoaded` false — its placeholder — and the
  // real rows landed a round trip later, on top of a sheet that had already
  // finished animating in.
  //
  // Nothing about the request needs the panel: GET /api/me/active-sessions is
  // per-USER, and `_rebucket()` is what splits its answer into "this app" and
  // "everything else". So it is made as soon as there IS a target, which is
  // also the moment the button that opens the panel appears.
  assert.match(CONTROLLER, /Improve\.prefetchSessions\(\);/,
    'setTarget starts it');
  const fn = CONTROLLER.slice(CONTROLLER.indexOf('  prefetchSessions() {'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.match(body, /if \(Improve\._prefetched\) return;/,
    'ONCE — a viewer hopping between apps re-buckets the same payload, and '
    + 'a fetch per hop would be a request for a surface nobody has opened');
  assert.match(body, /state\.sessionsLoaded \|\| state\.loadingSessions/,
    'never on top of a load that has happened or is happening');
  assert.match(body, /\.catch\(\(\) => \{\}\)/,
    'fire-and-forget: a preload that fails must not break a target publish');
  // `open()` still loads — the point is that it now refreshes a list that is
  // already on screen rather than drawing one.
  const open = CONTROLLER.slice(CONTROLLER.indexOf('  open() {'));
  assert.match(open.slice(0, open.indexOf('\n  },')), /Improve\.loadSessions\(\)/);
  // …and `loadSessions` only raises the placeholder when nothing has ever
  // loaded, which is what makes the refresh invisible.
  assert.match(CONTROLLER,
    /if \(!improveStore\.get\(\)\.sessionsLoaded\) improveStore\.set\(\{ loadingSessions: true \}\)/);
});

test('a just-created session is immediate and survives an older preload', async () => {
  let releasePreload;
  const preloadResponse = new Promise((resolve) => { releasePreload = resolve; });
  const { Improve, store } = loadImproveController(() => preloadResponse);

  const staleLoad = Improve.loadSessions();
  Improve.onSessionCreated({
    id: 1596,
    status: 'active',
    created_at: '2026-09-04T10:00:00.000Z',
  }, 'demo');

  assert.equal(store.state.sessions.length, 1,
    'the first panel open can render the new session without another request');
  assert.equal(store.state.sessions[0].id, 1596);
  assert.equal(store.state.sessions[0].appSlug, 'demo');
  assert.equal(store.state.loadingSessions, false);

  releasePreload({
    ok: true,
    json: async () => ({ sessions: [], externalTasks: [] }),
  });
  await staleLoad;

  assert.equal(store.state.sessions.length, 1,
    'a response issued before creation cannot erase the optimistic row');
  assert.equal(store.state.sessions[0].id, 1596);
});

test('a work order is NOT counted against the session budget', () => {
  const handler = ROUTE.slice(ROUTE.indexOf("router.get('/api/me/active-sessions'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));
  // `totals` is the numerator for the per-user caps, and those caps exist to
  // bound HOST MEMORY (services/session-caps.js says so outright). A work
  // order's agent runs on the user's own machine. Counting it would report a
  // slot as spent that pausing nothing can free.
  const totalsAt = body.indexOf('const totals =');
  const tasksAt = body.indexOf('const externalTasks =');
  assert.ok(totalsAt !== -1 && tasksAt !== -1);
  assert.ok(totalsAt < tasksAt, 'totals are computed before the tasks exist');
  const totalsBlock = body.slice(totalsAt, tasksAt);
  assert.doesNotMatch(totalsBlock, /externalTasks/);
  // And they stay a separate field rather than being pushed into `sessions`,
  // which is what `totals` was reduced from.
  assert.doesNotMatch(body.slice(tasksAt), /sessions\.push\(/);
});

test('the staging fixture exists, because the real table is staging:private', () => {
  // external_agent_tasks carries no rows in a staging clone, so without a
  // demo row this feature is invisible to every reviewer and undeclarable as
  // a check. Same ?demo=1 convention as the mock sessions above it — and
  // gated on staging, so it is a strict no-op in production.
  const handler = ROUTE.slice(ROUTE.indexOf("router.get('/api/me/active-sessions'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));
  const fixture = body.slice(body.indexOf('const externalTasks ='));
  assert.match(fixture, /USERNODE_ENV === 'staging' && req\.query\.demo === '1'/);
  assert.match(fixture, /externalTasks\.push\(/);
  assert.match(fixture, /\[Mock\]/, 'obviously fake, per the seeding convention');
});

// ── The rows ───────────────────────────────────────────────────────────

test('a work order row points at its request, not at a session page', () => {
  const fn = CONTROLLER.slice(
    CONTROLLER.indexOf('function taskToRow('),
    CONTROLLER.indexOf('\n}', CONTROLLER.indexOf('function taskToRow('))
  );
  assert.match(fn, /dev\/issues\/\$\{task\.issue_number\}/,
    'there is no transcript to open — the request is the honest destination');
  // prepare_work accepts a bare brief with no request behind it.
  assert.match(fn, /: `#app\/\$\{task\.app_slug\}\/dev`/, 'and a fallback for one without');
  assert.match(fn, /busy: false/,
    'the agent runs where the platform cannot see it; a spinner would be invented');
  assert.match(fn, /kind: 'task'/);
});

test('the two kinds cannot collide on a React key', () => {
  // Session ids and work-order ids come from unrelated sequences, so `id`
  // alone repeats across kinds and React reuses the wrong node.
  assert.match(CONTROLLER, /key: `s\$\{session\.id\}`/);
  assert.match(CONTROLLER, /key: `t\$\{task\.id\}`/);
  assert.match(SHEET_TSX, /key=\{session\.key\}/);
  assert.doesNotMatch(SHEET_TSX, /key=\{session\.id\}/);
});

test('the row renders the destination it was given', () => {
  // The component used to build `#app/<slug>/dev/sessions/<id>` from the row.
  // Every task row would have gone to a session page that does not exist.
  assert.match(ROW_TSX, /href=\{session\.href\}/);
  assert.doesNotMatch(ROW_TSX, /href=\{`#app\/\$\{session\.appSlug\}\/dev\/sessions/);
});

test('ordering compares times, not ids from two different tables', () => {
  const fn = CONTROLLER.slice(CONTROLLER.indexOf('  _rebucket() {'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.match(body, /Number\(b\.busy\) - Number\(a\.busy\) \|\| b\.sortAt - a\.sortAt/);
  // `b.id - a.id` was a recency proxy that only held while every row came
  // from one table. Mixed, it sorts by which table a row came from.
  assert.doesNotMatch(body, /b\.id - a\.id/);
  // Both kinds land in the same two buckets by the same app rule, so a
  // viewer looks in one place for "what of mine is in flight here".
  assert.match(body, /Improve\._tasks/);
});

test('an unparseable timestamp sorts last rather than poisoning the sort', () => {
  // NaN in a comparator makes the whole ordering arbitrary, not just one row.
  assert.match(CONTROLLER, /Number\.isFinite\(t\) \? t : 0/);
});

test('a server without the field contributes no rows instead of throwing', () => {
  const fn = CONTROLLER.slice(CONTROLLER.indexOf('  async loadSessions()'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.match(body, /Array\.isArray\(data\.externalTasks\) \? data\.externalTasks : \[\]/);
});

// ── The seam it leaves for #1405 ───────────────────────────────────────

test('the row can already say "Needs you" when that state arrives', () => {
  // statusLabel maps awaiting_input / needs_input to "Needs you", which is
  // exactly the state #1405's notify_awaiting_input publishes. Recorded so
  // the next change wires a value rather than inventing a display path.
  const fn = CONTROLLER.slice(CONTROLLER.indexOf('function statusLabel('));
  assert.match(fn.slice(0, 400), /awaiting_input|needs_input/);
});

test('the service, not the route, owns the external_agent_tasks query', () => {
  assert.match(SERVICE, /FROM external_agent_tasks t/);
  const handler = ROUTE.slice(ROUTE.indexOf("router.get('/api/me/active-sessions'"));
  assert.doesNotMatch(handler.slice(0, handler.indexOf('\n  });')),
    /FROM external_agent_tasks/,
    'the table has one owner; a second copy of the filter drifts from it');
});

// ── #1948: a work order whose request has closed is not listed ─────────
//
// A work order stays `open` for its full 14 days unless the agent submits or
// shares through THAT task. When the request is built some other way — a
// platform session, another agent, a second work order — the issue closes
// and the task does not. The row still said "Handed off" and still pointed at
// `#app/<slug>/dev/issues/<n>`; the board only resolves OPEN issues, so the
// route fell back to the card list and the tap appeared to do nothing
// (reproduced on production with a puzzlechain task whose request had shipped
// two days earlier). The list now drops a task whose issue is no longer in the
// repo's open-issue list — but ONLY when that list is authoritative: a
// rate-limited, truncated or failed fetch keeps every row, because hiding
// work someone handed out on a guess is worse than a stale row.

const REPO_ROW = (over) => ({
  ...ROW,
  repo_url: 'https://github.com/Usernode-Labs/puzzlechain',
  app_slug: 'puzzlechain-6cf8ff', app_name: 'Game Corner',
  ...over,
});

function openIssues(numbers, extra = {}) {
  const calls = [];
  const fetchOpenIssues = async (owner, repo) => {
    calls.push(`${owner}/${repo}`);
    return { issues: numbers.map((number) => ({ number })), truncatedList: false, ...extra };
  };
  return { calls, fetchOpenIssues };
}

test('#1948: a task whose request has closed is dropped; an open one stays', async () => {
  const { calls, fetchOpenIssues } = openIssues([186]);
  const rows = await svc.listOpenWorkOrders(fakePool([
    REPO_ROW({ id: 1, issue_number: 185 }),
    REPO_ROW({ id: 2, issue_number: 186 }),
  ]), 42, { fetchOpenIssues });
  assert.deepEqual(rows.map((r) => r.id), [2], 'the closed request\'s row is gone');
  assert.deepEqual(calls, ['Usernode-Labs/puzzlechain'], 'one fetch per repository, not per task');
});

test('#1948: a task with no request behind it is never filtered', async () => {
  const { calls, fetchOpenIssues } = openIssues([]);
  const rows = await svc.listOpenWorkOrders(fakePool([
    REPO_ROW({ id: 3, issue_number: null, brief: 'a bare brief' }),
  ]), 42, { fetchOpenIssues });
  assert.deepEqual(rows.map((r) => r.id), [3]);
  assert.equal(calls.length, 0, 'nothing to check, so GitHub is not asked');
});

test('#1948: an unauthoritative issue list keeps every row', async () => {
  for (const extra of [{ note: 'rate limited' }, { note: 'fetch failed' }, { truncatedList: true }]) {
    const { fetchOpenIssues } = openIssues([], extra);
    const rows = await svc.listOpenWorkOrders(fakePool([REPO_ROW({ id: 4, issue_number: 185 })]), 42,
      { fetchOpenIssues });
    assert.deepEqual(rows.map((r) => r.id), [4], `kept under ${JSON.stringify(extra)}`);
  }
  const throwing = async () => { throw new Error('boom'); };
  const rows = await svc.listOpenWorkOrders(fakePool([REPO_ROW({ id: 5, issue_number: 185 })]), 42,
    { fetchOpenIssues: throwing });
  assert.deepEqual(rows.map((r) => r.id), [5], 'a throwing fetch keeps the row too');
});

test('#1948: the repository is read with the task, and never leaks into the row', async () => {
  const queries = [];
  const { fetchOpenIssues } = openIssues([185]);
  const [row] = await svc.listOpenWorkOrders(fakePool([REPO_ROW({ issue_number: 185 })], queries), 42,
    { fetchOpenIssues });
  assert.match(queries[0].sql, /a\.repo_url/);
  assert.equal(row.repo_url, undefined, 'the panel needs the destination, not the repository');
});

test('#1948: the row carries the app artwork the query already selects', async () => {
  const { fetchOpenIssues } = openIssues([1417]);
  const [emoji] = await svc.listOpenWorkOrders(fakePool([REPO_ROW({ issue_number: 1417, app_icon_emoji: '🧩' })]), 42,
    { fetchOpenIssues });
  assert.equal(emoji.app_icon_emoji, '🧩');
  const [image] = await svc.listOpenWorkOrders(fakePool([REPO_ROW({ issue_number: 1417, app_icon_url: '/app-icons/9' })]), 42,
    { fetchOpenIssues });
  assert.equal(image.app_icon_url, '/app-icons/9');
});
