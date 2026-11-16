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
// 16 Nov 2026: the CLIENT rows are retired. The Improve controller's list of
// the viewer's changes and work orders lost its last surface, Messages'
// Agents section, and went with it (session-row.tsx, the controller's
// loadSessions and its rows). What stays pinned here is the server half,
// which GET /api/me/active-sessions still serves: points 1 and 4, the
// title, and #1948's filter.
//
// Run with: node --test tests/improve-work-order-rows.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../src/services/external-agent-tasks');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ROUTE = read('src/routes/sessions.js');
// The bell: it listed these rows once (#2815) and does not now (#5289).
const SHEET_TSX = read('frontend/src/features/notifications/notifications-sheet.tsx');
const SERVICE = read('src/services/external-agent-tasks.js');

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

test('no client surface draws the rows any more (16 Nov 2026)', () => {
  // The row component and the controller's rows went with Messages' Agents
  // section, their last surface; the bell had stopped listing them (#5289).
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'frontend/src/features/improve/session-row.tsx')), false);
  const controller = read('frontend/src/features/improve/improve-controller.js');
  assert.doesNotMatch(controller, /taskToRow|externalTasks|fetch\(`\/api\/me\/active-sessions/, 'the controller neither fetches nor builds them');
  assert.doesNotMatch(SHEET_TSX, /<SessionRow|key=\{session\.id\}/);
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
