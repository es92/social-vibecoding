// Kanban view-mode: AppView._bucketDevItems() sorts the cached dev data
// into the four lifecycle columns shown on the board:
//
//   issues     — open GitHub issues with no work under way (headless none/
//                failed/absent, no claim, no live session, no proposal)
//   inProgress — open issues with work under way: a generating/ready
//                headless run, a claim/live session, or an open proposal
//   inReview   — promoted PR proposals + governance proposals
//   done       — merged proposals
//
// The helper is pure (data in → buckets out, no DOM, no AppView state), so
// we load app-view.js into a vm context the same way feed-merge-pin-order
// does and call it directly with synthetic rows.
//
// Run with: node --test tests/dev-kanban-buckets.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { kanbanHtml } = require('./lib/dev-card-html');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// Build a vm sandbox with app-view.js loaded. `over` can supply a custom
// `document`, `fetch`, `localStorage`, or `matchMedia` so tests that exercise
// the DOM-touching render paths (e.g. loadMoreMerged) can capture writes /
// steer the view mode / fake the viewport width. matchMedia is absent unless
// supplied — mirroring old browsers, and pinning the _getViewMode guard.
// Returns the sandbox; AppView is at sandbox.__AppView.
function makeCtx(over) {
  const o = over || {};
  const sandbox = {
    matchMedia: o.matchMedia,
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: o.document || {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: o.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: o.localStorage || { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox;
}

function makeAppView() {
  return makeCtx().__AppView;
}

// Distinct, non-equal activity timestamps so recency ordering is unambiguous.
const at = (h) => `2026-06-01T${String(h).padStart(2, '0')}:00:00Z`;

const issue = (over) => ({
  number: over.number, title: `Issue ${over.number}`,
  updatedAt: at(1), lastMessageAt: at(1), headless: null,
  ...over,
});
const prop = (over) => ({
  id: over.id, pr_number: over.id * 10, pr_title: `PR ${over.id}`,
  username: 'me', user_id: 1, status: 'promoted', linked_issues: [],
  created_at: at(1), promoted_at: at(1), last_message_at: at(1),
  ...over,
});

// Buckets returned from the vm realm hold that realm's objects — compare by
// stable scalar keys mapped into the host realm.
const numbersOf = (items) => Array.from(items, (i) => i.number);
const idsOf = (items) => Array.from(items, (i) => i.id);
const reviewOf = (items) => Array.from(items, (x) => `${x.kind}:${x.item.id}`);
// In progress entries are TYPED ({kind, item}) since sessions moved into
// the column: my-session / issue / shared-session.
const inProgOf = (items) => Array.from(items, (x) => `${x.kind}:${x.item.number != null ? x.item.number : x.item.id}`);

const mySess = (over) => ({
  id: over.id, session_title: `Session ${over.id}`, status: 'active',
  created_at: at(1), last_activity_at: at(1),
  ...over,
});
const sharedSess = (over) => ({
  id: over.id, session_title: `Shared ${over.id}`, status: 'active',
  username: 'them', user_id: 99, created_at: at(1), shared_at: at(1),
  ...over,
});

test('headless none/failed/absent → Issues; generating/ready → In progress', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [
      issue({ number: 1, headless: null }),
      issue({ number: 2, headless: { status: 'failed' } }),
      issue({ number: 3, headless: { status: 'generating' } }),
      issue({ number: 4, headless: { status: 'ready' } }),
    ],
    proposals: [],
    gov: [],
    merged: [],
  });
  assert.deepEqual(numbersOf(b.issues).sort(), [1, 2]);
  assert.deepEqual(inProgOf(b.inProgress).sort(), ['issue:3', 'issue:4']);
});

// #1251: an issue an open promoted proposal addresses stays ON the board,
// in the In progress column. It used to be dropped from both issue columns
// — which made it visible in the list feed (which never deduped) and
// findable nowhere on the board.
test('issues linked to an open promoted proposal go to In progress, not off the board', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [
      // 10 carries no in-progress signal of its own — only the proposal.
      issue({ number: 10, headless: null }),
      issue({ number: 11, headless: { status: 'ready' } }),
      issue({ number: 12, headless: null }),
    ],
    proposals: [prop({ id: 100, linked_issues: [10, 11] })],
    gov: [],
    merged: [],
  });
  assert.deepEqual(numbersOf(b.issues), [12], 'only the untouched issue sits in Issues');
  assert.deepEqual(inProgOf(b.inProgress).sort(), ['issue:10', 'issue:11'],
    'both linked issues are in the In progress column');
  assert.deepEqual(reviewOf(b.inReview), ['proposal:100']);
  // The proposal card is in a DIFFERENT column, so nothing doubles up.
  assert.equal(
    numbersOf(b.issues).concat(inProgOf(b.inProgress)).length, 3,
    'every input issue appears exactly once across the two issue columns'
  );
});

// The regression the fix is really about: whatever the bucketing, every
// visible issue must land in SOME column — the list feed shows them all.
test('no visible issue is dropped from the board', () => {
  const AppView = makeAppView();
  const issues = [
    issue({ number: 20, headless: null }),
    issue({ number: 21, headless: { status: 'generating' } }),
    issue({ number: 22, in_progress: { count: 1, users: ['them'], claims: [] } }),
    issue({ number: 23, headless: null }),
  ];
  const b = AppView._bucketDevItems({
    issues,
    proposals: [prop({ id: 200, linked_issues: [23] })],
    gov: [],
    merged: [],
  });
  const onBoard = numbersOf(b.issues)
    .concat(b.inProgress.filter((e) => e.kind === 'issue').map((e) => e.item.number))
    .sort((a, c) => a - c);
  assert.deepEqual(onBoard, [20, 21, 22, 23]);
});

test('In progress: own sessions pinned first, issues middle, shared sessions last', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [issue({ number: 3, headless: { status: 'generating' } })],
    proposals: [],
    gov: [],
    merged: [],
    mySessions: [
      mySess({ id: 51, last_activity_at: at(2) }),
      mySess({ id: 52, last_activity_at: at(6) }),
    ],
    sharedSessions: [
      sharedSess({ id: 71, shared_at: at(5) }),
      sharedSess({ id: 72, shared_at: at(3) }),
    ],
  });
  // Own sessions most-recent-activity first; shared sessions oldest
  // shared_at first (newly shared rows append at the bottom).
  assert.deepEqual(inProgOf(b.inProgress), [
    'my-session:52', 'my-session:51',
    'issue:3',
    'shared-session:72', 'shared-session:71',
  ]);
});

test('sessions never leak into the other columns', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [issue({ number: 1, headless: null })],
    proposals: [prop({ id: 100 })],
    gov: [],
    merged: [{ id: 200, created_at: at(2), last_message_at: at(2) }],
    mySessions: [mySess({ id: 51 })],
    sharedSessions: [sharedSess({ id: 71 })],
  });
  assert.deepEqual(numbersOf(b.issues), [1]);
  assert.deepEqual(reviewOf(b.inReview), ['proposal:100']);
  assert.deepEqual(idsOf(b.done), [200]);
  assert.deepEqual(inProgOf(b.inProgress), ['my-session:51', 'shared-session:71']);
});

test('In review holds promoted proposals + governance proposals', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [],
    proposals: [prop({ id: 1 }), prop({ id: 2 })],
    gov: [{ id: 9, kind: 'rename', created_at: at(1), last_message_at: at(1) }],
    merged: [],
  });
  const tags = reviewOf(b.inReview).sort();
  assert.deepEqual(tags, ['gov:9', 'proposal:1', 'proposal:2']);
});

test('In review: pinned pipeline states sort above normal, gov in the normal tier', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [],
    proposals: [
      prop({ id: 'normal', created_at: at(9), promoted_at: at(9), last_message_at: at(9) }),
      prop({ id: 'merging', status: 'merging', created_at: at(1), promoted_at: at(1), last_message_at: at(1) }),
    ],
    gov: [{ id: 'gov', kind: 'rename', created_at: at(8), last_message_at: at(8) }],
    merged: [],
  });
  // merging pins first; then the normal tier (rank 3) by recency: the
  // newest normal proposal (at 9) then the gov proposal (at 8).
  assert.deepEqual(reviewOf(b.inReview), ['proposal:merging', 'proposal:normal', 'gov:gov']);
});

test('Done holds merged rows, most-recent-activity first', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [],
    proposals: [],
    gov: [],
    merged: [
      { id: 1, created_at: at(2), last_message_at: at(2) },
      { id: 2, created_at: at(7), last_message_at: at(7) },
      { id: 3, created_at: at(5), last_message_at: at(5) },
    ],
  });
  assert.deepEqual(idsOf(b.done), [2, 3, 1]);
});

test('Done interleaves applied close-issue rows with merged PRs by activity', () => {
  // The /merged stream now mixes row_type 'pr' and 'close_issue'; the done
  // bucket sorts them together on the same created_at/last_message_at key.
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [],
    proposals: [],
    gov: [],
    merged: [
      { id: 1, row_type: 'pr', created_at: at(2), last_message_at: at(2) },
      {
        id: 9, row_type: 'close_issue', created_at: at(6), last_message_at: at(6),
        kind: 'close_issue', status: 'closed',
        payload: { issueNumber: 12, issueTitle: 'Broken thing', appliedAt: at(6), appliedBy: 'group-vote' },
      },
      { id: 2, row_type: 'pr', created_at: at(7), last_message_at: at(7) },
    ],
  });
  assert.deepEqual(idsOf(b.done), [2, 9, 1]);
  assert.equal(b.done[1].row_type, 'close_issue');
});

// ── #1112: the chip got seven states; the buckets got none ─────────────────
// The whole point of the change was that the card SAYS more, not that it MOVES.
// _issueInProgress stayed byte-identical, so these two tests are the guard
// against a later "tidy-up" folding the new state list into the predicate.

test('all seven work states land the issue in the same Underway bucket', () => {
  const AppView = makeAppView();
  const sess = (over) => ({
    sessionId: 1, username: 'erin', mine: false, status: 'active',
    busy: false, lastActivityAt: at(1), ...over,
  });
  const cases = {
    in_review: { in_progress: { count: 1, users: ['erin'], claims: [], sessions: [sess({ status: 'promoted' })] } },
    working: { in_progress: { count: 1, users: ['erin'], claims: [], sessions: [sess()] } },
    paused: { in_progress: { count: 1, users: ['erin'], claims: [], sessions: [sess({ status: 'paused' })] } },
    claimed: { in_progress: { count: 0, users: [], claims: [{ username: 'erin', mine: false }], sessions: [] } },
    auto_solving: { headless: { status: 'generating' } },
    answer_needed: { headless: { status: 'ready', outcome: 'question' } },
    draft_ready: { headless: { status: 'ready', outcome: 'spec' } },
  };
  for (const [key, fields] of Object.entries(cases)) {
    const b = AppView._bucketDevItems({
      issues: [issue({ number: 3, ...fields })], proposals: [], gov: [], merged: [],
    });
    assert.deepEqual(inProgOf(b.inProgress), ['issue:3'], `${key} is underway`);
    assert.deepEqual(numbersOf(b.issues), [], `${key} left the Issues column`);
    // …and the chip really is showing that state, so the case is meaningful.
    assert.equal(AppView._issueWorkState(issue({ number: 3, ...fields })).key, key);
  }
});

test('the new sessions[]/peopleTotal fields never move a card by themselves', () => {
  const AppView = makeAppView();
  // No in_progress payload and no headless run: still the Issues column.
  const b = AppView._bucketDevItems({
    issues: [issue({ number: 1, in_progress: null })], proposals: [], gov: [], merged: [],
  });
  assert.deepEqual(numbersOf(b.issues), [1], 'stays in Issues');
  assert.deepEqual(inProgOf(b.inProgress), []);
  assert.equal(AppView._issueWorkState(b.issues[0]), null, 'and shows no chip');

  // The predicate is unchanged, which means it still routes on the PRESENCE of
  // the object — the route returns null rather than an all-zero payload, so
  // this shape only reaches the board from a hand-built fixture. #1112 did not
  // tighten it: only the chip reads the fields inside.
  const empty = { count: 0, users: [], claims: [], sessions: [], peopleTotal: 0 };
  const b2 = AppView._bucketDevItems({
    issues: [issue({ number: 1, in_progress: empty })], proposals: [], gov: [], merged: [],
  });
  assert.deepEqual(inProgOf(b2.inProgress), ['issue:1'], 'same column as before #1112');
  assert.equal(AppView._issueWorkState(b2.inProgress[0].item), null,
    'and no chip, because there is no state to name');

  // peopleTotal is a headcount for the `+N` suffix — never a state on its own.
  const b3 = AppView._bucketDevItems({
    issues: [issue({ number: 1, in_progress: { ...empty, peopleTotal: 9 } })],
    proposals: [], gov: [], merged: [],
  });
  assert.deepEqual(inProgOf(b3.inProgress), ['issue:1']);
  assert.equal(AppView._issueWorkState(b3.inProgress[0].item), null);
});

test('issue columns sort newest-activity first', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [
      issue({ number: 1, updatedAt: at(2), lastMessageAt: at(2) }),
      issue({ number: 2, updatedAt: at(6), lastMessageAt: at(6) }),
      issue({ number: 3, updatedAt: at(4), lastMessageAt: at(4) }),
    ],
    proposals: [],
    gov: [],
    merged: [],
  });
  assert.deepEqual(numbersOf(b.issues), [2, 3, 1]);
});

test('empty / missing inputs yield four empty columns', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({});
  // The result is a vm-realm object, so compare each column's length in the
  // host realm rather than deep-equalling the whole object across realms.
  assert.equal(b.issues.length, 0);
  assert.equal(b.inProgress.length, 0);
  assert.equal(b.inReview.length, 0);
  assert.equal(b.done.length, 0);
});

// ── Kanban "Done" column footer: expandable Load more (spec: make the Done
// column reach its remaining completed items in place) ─────────────────────

const mergedRow = (id, h) => ({
  id, pr_number: id * 10, pr_title: `PR ${id}`, username: 'me',
  created_at: at(h), status: 'merged',
});

// Seed the cached dev data the kanban renderer reads, with a Done column that
// has loaded fewer rows than the server total.
const seedDone = (AppView, { loaded, total, hasMore, loading }) => {
  AppView._ghIssues = [];
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = Array.from({ length: loaded }, (_, i) => mergedRow(i + 1, (i % 23) + 1));
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = total;
  AppView._mergedHasMore = hasMore;
  AppView._mergedLoadingMore = loading;
};

test('Kanban Done footer is a clickable Load more button when more pages exist', () => {
  const AppView = makeAppView();
  seedDone(AppView, { loaded: 2, total: 25, hasMore: true, loading: false });
  const html = kanbanHtml(AppView);
  // The handler is a closure on the React footer now, so the wiring is read
  // off the view model and the markup is checked for what it draws.
  const done = AppView._kanbanView().cols.find((c) => c.key === 'done');
  assert.deepEqual(JSON.parse(JSON.stringify(done.footer)),
    { kind: 'loadMerged', loading: false, n: 23 }, 'wired to the pager');
  assert.match(html, /Load more \(23\)/, 'shows remaining count');
  assert.match(html, /class="gc-vote-btn"/, 'uses the shared button class');
  assert.doesNotMatch(html, /more completed/, 'no dead static hint when expandable');
});

test('Kanban Done Load more button is disabled with a Loading state while fetching', () => {
  const AppView = makeAppView();
  seedDone(AppView, { loaded: 2, total: 25, hasMore: true, loading: true });
  const html = kanbanHtml(AppView);
  const done = AppView._kanbanView().cols.find((c) => c.key === 'done');
  assert.equal(done.footer.kind, 'loadMerged');
  assert.equal(done.footer.loading, true);
  assert.match(html, /Loading…/);
  assert.match(html, /disabled/);
});

test('Kanban Done footer falls back to the static hint when the server has no more pages', () => {
  const AppView = makeAppView();
  // total exceeds loaded but hasMore=false — degenerate; keep a hint, no dead button.
  seedDone(AppView, { loaded: 1, total: 5, hasMore: false, loading: false });
  const html = kanbanHtml(AppView);
  assert.match(html, /\+4 more completed/);
  assert.doesNotMatch(html, /loadMoreMerged/);
});

test('Kanban Done footer is absent once every completed item is loaded', () => {
  const AppView = makeAppView();
  seedDone(AppView, { loaded: 3, total: 3, hasMore: false, loading: false });
  const html = kanbanHtml(AppView);
  assert.doesNotMatch(html, /loadMoreMerged/);
  assert.doesNotMatch(html, /more completed/);
});

// ── loadMoreMerged re-render is view-mode aware ────────────────────────────

// A capturing #gc-merged element; records innerHTML writes and no-ops the
// querySelector calls _applyExploreChatAvailability makes.
const captureEl = (sink) => ({
  set innerHTML(v) { sink.push(v); },
  querySelector: () => null,
  querySelectorAll: () => ({ forEach: () => {} }),
});

const docWithGcMerged = (gcEl) => ({
  getElementById: (id) => (id === 'gc-merged' ? gcEl : null),
  querySelector: () => null,
  querySelectorAll: () => ({ forEach: () => {} }),
  addEventListener: () => {},
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
  body: { appendChild: () => {} },
});

const primePager = (AppView) => {
  AppView.appData = { slug: 'demo' };
  AppView._merged = [mergedRow(1, 1)];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedHasMore = true;
  AppView._mergedLoadingMore = false;
  AppView._mergedCursor = { created_at: at(1), id: 1 };
};

test('loadMoreMerged repaints the board (not #gc-merged) in kanban mode', async () => {
  const writes = [];
  const ctx = makeCtx({
    localStorage: { getItem: () => 'kanban', setItem: () => {} },
    document: docWithGcMerged(captureEl(writes)),
    fetch: async () => ({ ok: true, json: async () => ({ merged: [], hasMore: false, total: 1 }) }),
  });
  const AppView = ctx.__AppView;
  let repaints = 0;
  AppView._repaintDevBody = () => { repaints += 1; };
  primePager(AppView);
  await AppView.loadMoreMerged();
  assert.ok(repaints >= 1, 'kanban mode repaints the whole board');
  assert.equal(writes.length, 0, '#gc-merged is never touched in kanban mode');
});

test('loadMoreMerged repaints the body in Workshop mode too, and never #gc-merged', async () => {
  // This used to assert the OPPOSITE: the retired List view kept its completed
  // rows in a separate #gc-merged block that this patched in place, without
  // repainting the board. THE UI OVERHAUL folded completed work into the
  // Feed's own stream, and the Workshop keeps that, so there is no such
  // block in either mode and both go through _repaintDevBody.
  const writes = [];
  const ctx = makeCtx({
    localStorage: { getItem: () => 'workshop', setItem: () => {} },
    document: docWithGcMerged(captureEl(writes)),
    fetch: async () => ({ ok: true, json: async () => ({ merged: [], hasMore: false, total: 1 }) }),
  });
  const AppView = ctx.__AppView;
  let repaints = 0;
  AppView._repaintDevBody = () => { repaints += 1; };
  primePager(AppView);
  await AppView.loadMoreMerged();
  assert.ok(repaints >= 1, 'Workshop mode repaints the body');
  assert.equal(writes.length, 0, '#gc-merged is never touched — it does not exist');
});

// ── _getViewMode default: explicit preference, else the Workshop ─────────
//
// The #462 width default (kanban when wide, the list when narrow) retired
// with the Activity feed. The Workshop is the lander on every width; only an
// explicit preference or a ?view= override moves the board off it.

test('no stored value → the Workshop, whatever the viewport', () => {
  for (const wide of [true, false]) {
    const ctx = makeCtx({
      localStorage: { getItem: () => null, setItem: () => {} },
      matchMedia: () => ({ matches: wide }),
    });
    assert.equal(ctx.__AppView._getViewMode(), 'workshop', `wide=${wide}`);
  }
});

test("a stored 'list' or 'feed' migrates to the Workshop", () => {
  // Both are retired names for the surface the Workshop replaced, so a
  // viewer who last left the board there must land on the Workshop rather
  // than read their setting as forgotten.
  for (const stored of ['list', 'feed']) {
    const ctx = makeCtx({
      localStorage: { getItem: () => stored, setItem: () => {} },
      matchMedia: () => ({ matches: true }),
    });
    assert.equal(ctx.__AppView._getViewMode(), 'workshop', `${stored} → workshop`);
  }
});

test('a stored pm / report preference migrates onto the one surviving mode', () => {
  // The two retired overviews were board-shaped, so they used to resolve to
  // the Board. The Board VIEW MODE has retired in turn — its columns are the
  // Workshop's "By stage" pane — so the chain ends at the Workshop. Anything
  // else would read as "my setting was forgotten".
  for (const stored of ['pm', 'report']) {
    const ctx = makeCtx({
      localStorage: { getItem: () => stored, setItem: () => {} },
      matchMedia: () => ({ matches: false }),
    });
    assert.equal(ctx.__AppView._getViewMode(), 'workshop', `${stored} → workshop`);
  }
});

test('a stored kanban preference migrates rather than being forgotten', () => {
  // The value a viewer who last left the Dev screen on the Board still has.
  // It names a mode that no longer exists, so RETIRED_VIEW_MODES carries it
  // onto the Workshop, whose stage pane IS those columns.
  const ctx = makeCtx({
    localStorage: { getItem: () => 'kanban', setItem: () => {} },
    matchMedia: () => ({ matches: false }),
  });
  assert.equal(ctx.__AppView._getViewMode(), 'workshop');
});

test('no matchMedia in the environment → the Workshop (nothing to consult)', () => {
  const ctx = makeCtx({
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  assert.equal(ctx.__AppView._getViewMode(), 'workshop');
});

test('unrecognized stored garbage falls through to the Workshop', () => {
  const ctx = makeCtx({
    localStorage: { getItem: () => 'banana', setItem: () => {} },
    matchMedia: () => ({ matches: true }),
  });
  assert.equal(ctx.__AppView._getViewMode(), 'workshop');
});

test('the default never measures the viewport', () => {
  let consulted = 0;
  const ctx = makeCtx({
    localStorage: { getItem: () => null, setItem: () => {} },
    matchMedia: () => { consulted += 1; return { matches: true }; },
  });
  const AppView = ctx.__AppView;
  assert.equal(AppView._getViewMode(), 'workshop');
  assert.equal(AppView._getViewMode(), 'workshop');
  assert.equal(consulted, 0, 'matchMedia is not consulted at all');
});

test('auto-default is never written back to localStorage', () => {
  const writes = [];
  const ctx = makeCtx({
    localStorage: { getItem: () => null, setItem: (k, v) => writes.push([k, v]) },
    matchMedia: () => ({ matches: true }),
  });
  assert.equal(ctx.__AppView._getViewMode(), 'workshop');
  assert.equal(writes.length, 0, 'reading the mode must not persist the default');
});
