// Kanban filter bar (#482): AppView._devCardMatches() is the pure per-card
// predicate behind the board's filter controls (text search, priority,
// person, "needs my vote"). It takes (kind, item, filters) with kind ∈
// 'issue' | 'proposal' | 'gov' | 'merged' | 'session' and reads no DOM or AppView
// state, so — like _bucketDevItems — we load app-view.js into a vm context
// (same harness as dev-kanban-buckets.test.js) and call it directly with
// synthetic rows.
//
// Run with: node --test tests/dev-kanban-filters.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderComponent } = require('./lib/render-tsx');
const { kanbanHtml } = require('./lib/dev-card-html');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// Minimal in-memory Web Storage stand-in (getItem/setItem/removeItem) so the
// persistence helpers can round-trip without a browser.
function makeMemoryStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

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
    sessionStorage: o.sessionStorage || makeMemoryStore(),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox;
}

function makeAppView() {
  const sandbox = makeCtx();
  // Every test here drives a board that has ALREADY loaded — filtering,
  // bucketing, counts. `_devDataReady` is what tells the view models that,
  // and without it `_kanbanView()` reports `loading` and the columns render
  // placeholders instead of cards (see card/skeleton.tsx). Set once here
  // rather than per test: an unloaded board has its own coverage in
  // tests/dev-board-loading.test.js.
  sandbox.__AppView._devDataReady = true;
  // The bar's markup is features/dev-board/kanban-filters.tsx's since #1191,
  // so a test that drives the module needs the sandbox back to see what was
  // published — and `document.activeElement`, which decides whether a select
  // the reader has open keeps its options.
  sandbox.__AppView.__sandbox = sandbox;
  return sandbox.__AppView;
}

// Default (empty) filters — the fast-path that must match everything.
const none = { q: '', priority: null, assignee: null, category: null, needsVote: false, theme: null, assignedToMe: false, createdByMe: false };

const issue = (over) => ({
  number: 42, title: 'Dark mode toggle resets', created_by_username: 'evan',
  priority: null, assignee: null,
  ...over,
});
const prop = (over) => ({
  id: 9000001, pr_number: 900101, pr_title: 'Rework the proposal card header',
  username: 'sam', status: 'promoted', my_vote: null,
  priority: null, assignee: null,
  ...over,
});
const gov = (over) => ({
  id: 7, kind: 'rename', title: 'Rename app', payload: { newName: 'Shiny App' },
  created_by_username: 'evan', my_vote: null, github_issue_number: 55,
  ...over,
});
const merged = (over) => ({
  id: 8000001, pr_number: 800101, pr_title: 'Fix leaderboard scroll jump',
  username: 'kim', priority: null, assignee: null,
  ...over,
});

// #3199: sorting is local to In review and must never become a filter.
const reviewColumn = a => a._kanbanView().cols.find(c => c.key === 'inreview');
const reviewKeys = a => Array.from(reviewColumn(a).rows, row => row.key);
function reviewBoard({ livePaint = false } = {}) {
  const a = makeAppView();
  a.appData = { slug: 'first-app' };
  a._ghIssues = [issue({ number: 1 })];
  a._envIssueNumbers = new Set();
  a._proposals = [];
  a._govProposals = [];
  a._merged = [merged({ id: 80, created_at: '2026-09-28' })];
  a._mySessions = [{ id: 90, session_title: 'Working', status: 'active' }];
  a._sharedSessions = [];
  a._kanbanFilters = { ...none };
  if (!livePaint) a._repaintBoardSurface = () => {};
  return a;
}

test('In review defaults to newest submission, independent of comments, status and old manual order', () => {
  const a = reviewBoard();
  a._proposals = [
    prop({ id: 1, promoted_at: '2026-09-01', last_message_at: '2026-09-28', status: 'merging' }),
    prop({ id: 2, promoted_at: '2026-09-20', created_at: '2026-08-01' }),
    prop({ id: 3, promoted_at: '2026-09-20' }),
    prop({ id: 4, created_at: '2026-09-10' }),
    prop({ id: 5 }),
  ];
  a._boardOrder = { issues: [], review: ['proposal:1', 'proposal:2', 'proposal:5'] };
  assert.equal(reviewColumn(a).reviewSort, 'newest');
  assert.deepEqual(reviewKeys(a), ['proposal:3', 'proposal:2', 'proposal:4', 'proposal:1', 'proposal:5']);
});

test('Vote priority orders unvoted first, then positive qualifying shortfall, enough votes, unknown', () => {
  const a = reviewBoard();
  a._proposalsCtx = {};
  a._proposals = [
    prop({ id: 1, qualified_yes_count: 1, yes_count: 99, votes_required: 5 }),
    prop({ id: 2, yes_count: 3, votes_required: 4, my_prior_vote: 'yes' }),
    prop({ id: 3, yes_count: 7, votes_required: null }),
    prop({ id: 4, yes_count: 10, votes_required: 10 }),
    prop({ id: 5, yes_count: 3, votes_required: 4, my_vote: 'yes' }),
    prop({ id: 6, yes_count: 1, votes_required: 4, my_vote: 'no' }),
    prop({ id: 7, yes_count: 20, votes_required: 10 }),
  ];
  a._setReviewSort('priority');
  assert.deepEqual(reviewKeys(a), [2, 1, 7, 4, 3, 5, 6].map(id => `proposal:${id}`));
  assert.equal(reviewColumn(a).count, 7, 'voted and already-qualified proposals remain visible');
});

test('code and governance proposals share qualifying shortfalls and newest tie breaks', () => {
  const a = reviewBoard();
  a._proposalsCtx = { majority: 4 };
  a._proposals = [
    prop({ id: 1, yes_count: 2, promoted_at: '2026-09-20' }),
    prop({ id: 2, votes_required: 4, yes_count: 2, promoted_at: '2026-09-21' }),
  ];
  a._govProposals = [gov({ id: 8, up_count: 99, qualified_yes_count: 1, approvals_required: 3,
    votes_required: 50, created_at: '2026-09-22' })];
  a._setReviewSort('priority');
  const col = reviewColumn(a);
  assert.equal(col.rows[0].card.key, a._govCardModel(a._govProposals[0]).key);
  assert.deepEqual(Array.from(col.rows.slice(1), r => r.key), ['proposal:2', 'proposal:1']);
  assert.equal(a._reviewVotesNeeded({ kind: 'gov', item: { up_count: 2, votes_required: 5 } }), 3);
});

test('changing review order leaves filters, every other column, feed and category data unchanged', () => {
  const a = reviewBoard();
  a._proposals = [prop({ id: 1, votes_required: 5, yes_count: 4, promoted_at: '2026-09-01' }),
    prop({ id: 2, votes_required: 5, yes_count: 1, promoted_at: '2026-09-20' })];
  const others = () => JSON.stringify(a._kanbanView().cols.filter(c => c.key !== 'inreview'));
  const feed = JSON.stringify(a._feedItems());
  const categories = JSON.stringify(a._bucketDevItems({ proposals: a._proposals }));
  const before = others();
  assert.deepEqual(reviewKeys(a), ['proposal:2', 'proposal:1']);
  a._setReviewSort('priority');
  assert.deepEqual(reviewKeys(a), ['proposal:1', 'proposal:2']);
  assert.equal(others(), before);
  assert.equal(JSON.stringify(a._feedItems()), feed);
  assert.equal(JSON.stringify(a._bucketDevItems({ proposals: a._proposals })), categories);
  assert.equal(a._kanbanFiltersActive(), false);
  assert.equal(a._kanbanFilterCount(), 0);
  a._kanbanFilters = { ...none, q: 'no such proposal' };
  assert.equal(reviewColumn(a).count, 0);
  assert.equal(reviewColumn(a).empty, 'No matching cards');
  assert.equal(reviewColumn(a).reviewSort, 'priority', 'empty filtered columns still offer the toggle');
});

test('review sort persists per app, survives reload, validates values and repaints once per change', () => {
  const a = reviewBoard();
  let repaints = 0;
  a._repaintBoardSurface = () => { repaints++; };
  a._setReviewSort('priority');
  a._setReviewSort('priority');
  a._setReviewSort('invalid');
  assert.equal(repaints, 1);
  const store = a.__sandbox.sessionStorage;
  const b = makeCtx({ sessionStorage: store }).__AppView;
  b.appData = { slug: 'first-app' };
  assert.equal(b._reviewSort(), 'priority');
  a.appData = { slug: 'second-app' };
  assert.equal(a._reviewSort(), 'newest');
  a.appData = { slug: 'first-app' };
  assert.equal(a._reviewSort(), 'priority');
  a._setReviewSort('newest');
  assert.equal(store.getItem(`${a.REVIEW_SORT_KEY}:first-app`), null);
  store.setItem(`${a.REVIEW_SORT_KEY}:third-app`, 'invalid');
  a.appData = { slug: 'third-app' };
  assert.equal(a._reviewSort(), 'newest');
});

test('selecting either sort immediately republishes the visible column in Workshop and standalone board', () => {
  for (const mode of ['workshop', 'kanban']) {
    const a = reviewBoard({ livePaint: true });
    a._proposals = [prop({ id: 1, votes_required: 5, yes_count: 4, promoted_at: '2026-09-01' }),
      prop({ id: 2, votes_required: 5, yes_count: 1, promoted_at: '2026-09-20' })];
    const hostId = mode === 'workshop' ? 'dev-workshop' : 'dev-kanban-board';
    a.__sandbox.document.getElementById = id => id === hostId ? {} : null;
    a._getViewMode = () => mode;
    a._getWorkshopGroup = () => 'stage';
    a._workshopView = () => ({});
    for (const fn of ['_wireFeedComments', '_fillKudosHosts', '_refreshAiAvailability',
      '_startMergeCountdownTimer', '_reanchorCardMenu']) a[fn] = () => {};
    const published = [];
    a._reactDevBoard = () => ({
      mountWorkshop() {}, publishWorkshop() {}, publishWorkshopGroup() {}, mountKanban() {},
      publishKanban(view) { published.push(view.cols.find(c => c.key === 'inreview')); },
    });
    a._setReviewSort('priority');
    assert.equal(published.length, 1, `${mode} must update without a reload`);
    assert.equal(published[0].reviewSort, 'priority');
    assert.deepEqual(Array.from(published[0].rows, r => r.key), ['proposal:1', 'proposal:2']);
    a._setReviewSort('newest');
    assert.equal(published.length, 2);
    assert.equal(published[1].reviewSort, 'newest');
    assert.deepEqual(Array.from(published[1].rows, r => r.key), ['proposal:2', 'proposal:1']);
  }
});

test('review sort still works with unavailable storage and when signed out', () => {
  const a = reviewBoard();
  a.__sandbox.sessionStorage = {
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  a.__sandbox.App.user = null;
  a._proposals = [prop({ id: 1, votes_required: 5, yes_count: 4 }),
    prop({ id: 2, votes_required: 5, yes_count: 1 })];
  assert.equal(a._reviewSort(), 'newest');
  a._setReviewSort('priority');
  assert.deepEqual(reviewKeys(a), ['proposal:1', 'proposal:2']);
  a._setReviewSort('newest');
  assert.equal(a._reviewSort(), 'newest');
});

test('only Waiting for approval renders one sort button naming the current mode and the next action', () => {
  const a = reviewBoard();
  let html = kanbanHtml(a);
  const control = h => h.match(/<button[^>]*aria-label="Sort Waiting for approval:[\s\S]*?<\/button>/g) || [];
  assert.equal(control(html).length, 1);
  assert.match(control(html)[0], /aria-label="Sort Waiting for approval: Newest\. Switch to Vote priority\."/);
  assert.match(control(html)[0], /title="Most recently submitted for review first\. Click to switch to Vote priority\."/);
  assert.match(control(html)[0], /Newest<\/button>/);
  assert.doesNotMatch(control(html)[0], /aria-pressed|aria-haspopup/);
  assert.ok(html.indexOf('id="dev-kanban-col-inreview"') < html.indexOf('aria-label="Sort Waiting for approval:'));
  assert.doesNotMatch(html, /Most recently submitted for review first\.<\/p>/);
  a._setReviewSort('priority');
  html = kanbanHtml(a);
  assert.equal(control(html).length, 1);
  assert.match(control(html)[0], /aria-label="Sort Waiting for approval: Vote priority\. Switch to Newest\."/);
  assert.match(control(html)[0], /Vote priority<\/button>/);
  assert.doesNotMatch(html, /Unvoted first, then fewest qualifying votes still needed\.<\/p>/);
  const dialog = renderComponent('frontend/src/features/dialogs/board-filters.tsx', 'BoardFiltersDialog', {});
  assert.doesNotMatch(dialog, /Already voted|Proposal order|Fewest votes needed/);
});

test('default filters match every kind', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devCardMatches('issue', issue({}), none), true);
  assert.equal(AppView._devCardMatches('proposal', prop({}), none), true);
  assert.equal(AppView._devCardMatches('gov', gov({}), none), true);
  assert.equal(AppView._devCardMatches('merged', merged({}), none), true);
  // No-filters object at all behaves the same.
  assert.equal(AppView._devCardMatches('issue', issue({}), undefined), true);
});

test('text search matches titles case-insensitively', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, q: 'DARK MODE' }), true);
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, q: 'leaderboard' }), false);
  assert.equal(AppView._devCardMatches('merged', merged({}), { ...none, q: 'leaderboard' }), true);
  // Proposal without a pr_title falls back to "Change by <username>",
  // mirroring the card renderer.
  assert.equal(
    AppView._devCardMatches('proposal', prop({ pr_title: null }), { ...none, q: 'change by sam' }),
    true
  );
  // Gov rename searches the new name, mirroring _renderGovCard's title.
  assert.equal(AppView._devCardMatches('gov', gov({}), { ...none, q: 'shiny' }), true);
  assert.equal(
    AppView._devCardMatches('gov', gov({ kind: 'secret_change', title: 'Set STRIPE_KEY', payload: null }),
      { ...none, q: 'stripe' }),
    true
  );
});

test('text search matches author names', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, q: 'Evan' }), true);
  assert.equal(AppView._devCardMatches('proposal', prop({}), { ...none, q: 'sam' }), true);
  assert.equal(AppView._devCardMatches('proposal', prop({}), { ...none, q: 'evan' }), false);
  // Issues without a resolved creator fall back to the GitHub login.
  assert.equal(
    AppView._devCardMatches('issue', issue({ created_by_username: null, user: 'octocat' }),
      { ...none, q: 'octo' }),
    true
  );
});

test('text search matches issue/PR numbers, with or without a leading #', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devCardMatches('proposal', prop({}), { ...none, q: '900101' }), true);
  assert.equal(AppView._devCardMatches('proposal', prop({}), { ...none, q: '#900101' }), true);
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, q: '#42' }), true);
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, q: '#43' }), false);
  assert.equal(AppView._devCardMatches('merged', merged({}), { ...none, q: '800101' }), true);
});

// Applied close-issue rows in the Done column (row_type='close_issue'):
// text search reads the target issue's title/number and the proposer,
// mirroring _renderCompletedCloseIssueCard; attribute filters exclude them
// (they carry no priority/assignee/category), and needs-vote never matches
// a settled row.
const closedIssue = (over) => ({
  id: 77, row_type: 'close_issue', kind: 'close_issue', status: 'closed',
  title: 'Close issue #12: "Dark mode toggle resets"',
  payload: { issueNumber: 12, issueTitle: 'Dark mode toggle resets', appliedAt: '2026-01-15T00:00:00.000Z', appliedBy: 'group-vote' },
  created_by_username: 'casey',
  ...over,
});

test('merged close-issue rows match by target issue title, proposer, and number', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), none), true);
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, q: 'dark mode' }), true);
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, q: 'casey' }), true);
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, q: '#12' }), true);
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, q: 'leaderboard' }), false);
  // Attribute filters exclude them (no chips), like any card lacking the value.
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, priority: 'high' }), false);
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, needsVote: true }), false);
});

test('priority filter matches the top-voted value; unset and gov cards fail', () => {
  const AppView = makeAppView();
  const f = { ...none, priority: 'high' };
  assert.equal(AppView._devCardMatches('issue', issue({ priority: { top: 'high', count: 2 } }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ priority: { top: 'low', count: 1 } }), f), false);
  assert.equal(AppView._devCardMatches('issue', issue({ priority: null }), f), false);
  assert.equal(AppView._devCardMatches('proposal', prop({ priority: { top: 'high', count: 1 } }), f), true);
  // Gov cards never carry priority — excluded by design under this filter.
  assert.equal(AppView._devCardMatches('gov', gov({}), f), false);
});

test('category filter matches the top-voted value; unset and gov cards fail', () => {
  const AppView = makeAppView();
  const f = { ...none, category: 'bug' };
  assert.equal(AppView._devCardMatches('issue', issue({ category: { top: 'bug', count: 2 } }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ category: { top: 'feature', count: 1 } }), f), false);
  assert.equal(AppView._devCardMatches('issue', issue({ category: null }), f), false);
  assert.equal(AppView._devCardMatches('proposal', prop({ category: { top: 'bug', count: 1 } }), f), true);
  // Gov cards never carry a category — excluded by design under this filter.
  assert.equal(AppView._devCardMatches('gov', gov({}), f), false);
});

test('category filter composes with priority, assignee and search', () => {
  const AppView = makeAppView();
  const card = prop({
    pr_title: 'Tighten card spacing',
    priority: { top: 'high', count: 2 },
    assignee: { top: 'sam', count: 1 },
    category: { top: 'improvement', count: 3 },
    my_vote: null,
  });
  const f = { q: 'spacing', priority: 'high', assignee: 'sam', category: 'improvement', needsVote: true };
  assert.equal(AppView._devCardMatches('proposal', card, f), true);
  assert.equal(AppView._devCardMatches('proposal', card, { ...f, category: 'bug' }), false);
});

// #780: custom categories are per-app options stored as ordinary slugs, so
// the predicate needs no special case — filtering by one just works.
test('category filter matches a CUSTOM category slug like a built-in', () => {
  const AppView = makeAppView();
  const f = { ...none, category: 'dev experience' };
  assert.equal(AppView._devCardMatches('issue', issue({ category: { top: 'dev experience', count: 2 } }), f), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ category: { top: 'dev experience', count: 1 } }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ category: { top: 'bug', count: 5 } }), f), false);
});

// #780: the category vocabulary is built from the app's registry — built-ins
// first, then customs — instead of the hardcoded six. The Streamlined
// Concept moved the select into the Filters dialog, so the vocabulary is
// DATA now (_kanbanCategoryChoices feeds the dialog's payload); the "Any
// category" default is the dialog's own leading option, not an entry here.
test('category choices list built-ins then the app custom categories', () => {
  const AppView = makeAppView();
  AppView._kanbanFilters = { ...none };
  AppView._appCategories = [
    ...AppView.ATTR_CATEGORY_VALUES.map((v) => ({ value: v, label: v, custom: false })),
    { value: 'dev experience', label: 'Dev Experience', custom: true },
    { value: 'performance', label: 'Performance', custom: true },
  ];
  const choices = Array.from(AppView._kanbanCategoryChoices());
  assert.deepEqual(
    Array.from(choices, (c) => c.value),
    [...Array.from(AppView.ATTR_CATEGORY_VALUES), 'dev experience', 'performance'],
    'built-ins precede the customs, in registry order'
  );
  assert.equal(
    choices.find((c) => c.value === 'dev experience').label,
    'Dev Experience',
    'a custom choice shows its registered label'
  );

  // With no vocabulary loaded it degrades to built-ins only (pre-#780 view).
  AppView._appCategories = null;
  assert.deepEqual(
    Array.from(AppView._kanbanCategoryChoices(), (c) => c.value),
    Array.from(AppView.ATTR_CATEGORY_VALUES)
  );
});

// Mirrors the assignee list's rule: an active selection is never dropped
// from the vocabulary, so a filter can't silently self-clear on a refresh.
test('category choices keep an active selection that left the vocabulary', () => {
  const AppView = makeAppView();
  AppView._appCategories = null;
  AppView._kanbanFilters = { ...none, category: 'retired category' };
  const values = Array.from(AppView._kanbanCategoryChoices(), (c) => c.value);
  assert.ok(values.includes('retired category'), 'the active filter survives');
});

// The Filters dialog's write-back merges the dialog-owned keys over the
// current set — search stays the bar's own — and repaints through the
// normal surface path.
test('applyKanbanFilters merges dialog keys and preserves the search text', () => {
  const AppView = makeAppView();
  let repainted = 0;
  AppView._repaintBoardSurface = () => { repainted += 1; };
  AppView._kanbanFilters = { ...none, q: 'ripple', priority: 'low' };
  AppView.applyKanbanFilters({ priority: 'high', category: 'bug', assignee: null, needsVote: true });
  // Field-by-field (the object comes from the vm realm, so deepEqual would
  // trip on its foreign Object prototype rather than its contents).
  const f = AppView._kanbanFilters;
  assert.equal(f.q, 'ripple', 'search text is preserved');
  assert.equal(f.priority, 'high');
  assert.equal(f.category, 'bug');
  assert.equal(f.assignee, null);
  assert.equal(f.needsVote, true);
  assert.equal(repainted, 1, 'one repaint per apply');
});

// The bar itself is features/dev-board/kanban-filters.tsx's — search, the
// `Filters (n)` chip that opens the dialog, and one dismissable chip per
// active filter. The selects it used to render live in the dialog now.
test('the bar renders search, the Filters chip, and dismissable active chips', () => {
  const html = renderComponent(
    'frontend/src/features/dev-board/kanban-filters.tsx', 'KanbanFiltersView',
    {
      mounted: true,
      q: '',
      seq: 0,
      count: 2,
      chips: [
        { key: 'priority', label: 'High priority' },
        { key: 'needsVote', label: 'Waiting on you' },
      ],
    },
  );
  assert.match(html, /id="dev-kanban-search"[^>]*placeholder="Search cards, comments, or #"/);
  assert.match(html, /id="dev-kanban-filters-btn"[^>]*aria-haspopup="dialog"/);
  assert.match(html, />Filters \(2\)</, 'the chip counts the dialog-owned filters');
  // The chip reads as SET while any dialog filter is on — the filled tonal state.
  assert.match(html, /id="dev-kanban-filters-btn"[^>]*bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900/);
  assert.match(html, /data-filter-chip="priority"/);
  assert.match(html, /aria-label="Remove filter: High priority"/);
  assert.match(html, /data-filter-chip="needsVote"/);
  // No select survives in the strip.
  assert.ok(!/<select/.test(html), 'the selects moved into the Filters dialog');
});

test('person filter matches either the top-voted assignee or the author', () => {
  const AppView = makeAppView();
  const f = { ...none, assignee: 'sam' };
  // Explicit assignment still matches even when someone else authored it.
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: { top: 'sam', count: 3 } }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: { top: 'kim', count: 1 } }), f), false);
  // Authored-but-unassigned is the behavior this change adds.
  assert.equal(AppView._devCardMatches('proposal', prop({ assignee: null }), f), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ username: 'kim', assignee: null }), f), false);
});

test('person filter uses every card kind\'s existing author field', () => {
  const AppView = makeAppView();
  const by = (name) => ({ ...none, assignee: name });
  assert.equal(AppView._devCardMatches('issue', issue({ created_by_username: 'evan' }), by('evan')), true);
  assert.equal(AppView._devCardMatches('issue',
    issue({ created_by_username: null, user: 'octocat' }), by('octocat')), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ username: 'sam' }), by('sam')), true);
  assert.equal(AppView._devCardMatches('gov', gov({ created_by_username: 'evan' }), by('evan')), true);
  assert.equal(AppView._devCardMatches('merged', merged({ username: 'kim' }), by('kim')), true);
  assert.equal(AppView._devCardMatches('merged', closedIssue({ created_by_username: 'casey' }), by('casey')), true);
  assert.equal(AppView._devCardMatches('session', { username: 'maya' }, by('maya')), true);
  assert.equal(AppView._devCardMatches('session', { username: 'maya' }, by('someone-else')), false);
});

test('Unassigned sentinel matches only cards with no top assignee; gov excluded', () => {
  const AppView = makeAppView();
  const f = { ...none, assignee: AppView.KANBAN_ASSIGNEE_UNASSIGNED };
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: null }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: { top: null, count: 0 } }), f), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ assignee: null }), f), true);
  assert.equal(AppView._devCardMatches('merged', merged({ assignee: null }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: { top: 'sam', count: 1 } }), f), false);
  assert.equal(AppView._devCardMatches('proposal', prop({ assignee: { top: 'kim', count: 2 } }), f), false);
  assert.equal(AppView._devCardMatches('merged', merged({ assignee: { top: 'zoe', count: 1 } }), f), false);
  // Gov cards never carry an assignee — excluded under Unassigned too,
  // mirroring the named-assignee rule.
  assert.equal(AppView._devCardMatches('gov', gov({}), f), false);
});

test('Unassigned sentinel composes with priority and search', () => {
  const AppView = makeAppView();
  const un = AppView.KANBAN_ASSIGNEE_UNASSIGNED;
  const card = issue({ priority: { top: 'high', count: 1 }, assignee: null });
  assert.equal(AppView._devCardMatches('issue', card, { ...none, assignee: un, priority: 'high' }), true);
  assert.equal(AppView._devCardMatches('issue', card, { ...none, assignee: un, priority: 'low' }), false);
  assert.equal(AppView._devCardMatches('issue', card, { ...none, assignee: un, q: 'dark mode' }), true);
  assert.equal(AppView._devCardMatches('issue', card, { ...none, assignee: un, q: 'leaderboard' }), false);
});

test('needsVote keeps only unvoted promoted proposals and unvoted gov proposals', () => {
  const AppView = makeAppView();
  const f = { ...none, needsVote: true };
  assert.equal(AppView._devCardMatches('proposal', prop({ my_vote: null }), f), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ my_vote: 'yes' }), f), false);
  // Non-promoted (e.g. merging) proposals are no longer votable.
  assert.equal(AppView._devCardMatches('proposal', prop({ status: 'merging', my_vote: null }), f), false);
  assert.equal(AppView._devCardMatches('gov', gov({ my_vote: null }), f), true);
  assert.equal(AppView._devCardMatches('gov', gov({ my_vote: 'up' }), f), false);
  // Issues and merged cards are never votable.
  assert.equal(AppView._devCardMatches('issue', issue({}), f), false);
  assert.equal(AppView._devCardMatches('merged', merged({}), f), false);
});

test('filters AND together', () => {
  const AppView = makeAppView();
  const card = prop({
    pr_title: 'Tighten card spacing',
    priority: { top: 'high', count: 2 },
    assignee: { top: 'sam', count: 1 },
    my_vote: null,
  });
  const f = { q: 'spacing', priority: 'high', assignee: 'sam', needsVote: true };
  assert.equal(AppView._devCardMatches('proposal', card, f), true);
  assert.equal(AppView._devCardMatches('proposal', card, { ...f, q: 'leaderboard' }), false);
  assert.equal(AppView._devCardMatches('proposal', card, { ...f, priority: 'low' }), false);
  assert.equal(AppView._devCardMatches('proposal', card, { ...f, assignee: 'kim' }), false);
  assert.equal(
    AppView._devCardMatches('proposal', { ...card, my_vote: 'yes' }, f),
    false
  );
});

test('_kanbanFiltersActive reflects any non-default filter', () => {
  const AppView = makeAppView();
  AppView._kanbanFilters = { q: '', priority: null, assignee: null, needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), false);
  AppView._kanbanFilters = { q: '   ', priority: null, assignee: null, needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), false, 'whitespace-only search is not active');
  AppView._kanbanFilters = { q: 'x', priority: null, assignee: null, needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), true);
  AppView._kanbanFilters = { q: '', priority: 'high', assignee: null, needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), true);
  AppView._kanbanFilters = { q: '', priority: null, assignee: 'sam', needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), true);
  AppView._kanbanFilters = { q: '', priority: null, assignee: null, category: 'bug', needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), true, 'an active category filter counts');
  AppView._kanbanFilters = { q: '', priority: null, assignee: null, needsVote: true };
  assert.equal(AppView._kanbanFiltersActive(), true);
});

test('_kanbanAssigneeOptions unions assignees and authors and keeps the current selection', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [
    issue({ number: 1, assignee: { top: 'zoe', count: 1 } }),
    issue({ number: 2, assignee: null }),
  ];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [prop({ assignee: { top: 'sam', count: 2 } })];
  AppView._govProposals = [gov({ created_by_username: 'casey' })];
  AppView._merged = [merged({ assignee: { top: 'kim', count: 1 } })];
  AppView._mySessions = [{ username: 'maya' }];
  AppView._sharedSessions = [{ username: 'evan' }];
  AppView._kanbanFilters = { q: '', priority: null, assignee: null, needsVote: false };
  // Options come back as the vm realm's Array — map into the host realm
  // before comparing (same trick as dev-kanban-buckets' numbersOf/idsOf).
  const names = () => Array.from(AppView._kanbanAssigneeOptions());
  assert.deepEqual(names(), ['casey', 'evan', 'kim', 'maya', 'sam', 'zoe']);
  // A selected assignee that vanished from the data stays listed so the
  // active filter never silently self-clears.
  AppView._kanbanFilters.assignee = 'alex';
  assert.deepEqual(names(), ['alex', 'casey', 'evan', 'kim', 'maya', 'sam', 'zoe']);
  // The Unassigned sentinel is a fixed dropdown option, never a name —
  // an active Unassigned filter must not leak into the alphabetized list.
  // (The "Anyone" / "Unassigned" leading options are the Filters dialog's
  // own now — this list is just the names its payload carries.)
  AppView._kanbanFilters.assignee = AppView.KANBAN_ASSIGNEE_UNASSIGNED;
  assert.deepEqual(names(), ['casey', 'evan', 'kim', 'maya', 'sam', 'zoe']);
});

// ── Persistence helpers (sessionStorage-backed, per app slug) ──────────

// Objects come back from the vm realm with a foreign Object.prototype, which
// trips deepStrictEqual — copy into the host realm before comparing (same
// realm-crossing trick the assignee-options test uses for arrays).
const plain = (o) => ({ ...o });

test('_loadKanbanFilters returns defaults for unknown slug / empty store', () => {
  const AppView = makeAppView();
  assert.deepEqual(plain(AppView._loadKanbanFilters('nope')), none);
  // A falsy slug never touches storage.
  assert.deepEqual(plain(AppView._loadKanbanFilters('')), none);
  assert.deepEqual(plain(AppView._loadKanbanFilters(null)), none);
});

test('_saveKanbanFilters round-trips through _loadKanbanFilters under the slug', () => {
  const AppView = makeAppView();
  AppView._kanbanFilters = { q: 'dark', priority: 'high', assignee: 'sam', category: 'bug', needsVote: true };
  AppView._saveKanbanFilters('my-app');
  assert.deepEqual(plain(AppView._loadKanbanFilters('my-app')),
    { q: 'dark', priority: 'high', assignee: 'sam', category: 'bug', needsVote: true, theme: null, assignedToMe: false, createdByMe: false });
});

test('_saveKanbanFilters clears the key when filters are at defaults', () => {
  const store = makeMemoryStore();
  const AppView = makeCtx({ sessionStorage: store }).__AppView;
  const key = `${AppView.KANBAN_FILTERS_KEY}:my-app`;
  // First persist an active filter, then clear it — the key must be removed
  // rather than left holding an empty object (no residue for a cleared board).
  AppView._kanbanFilters = { q: 'dark', priority: null, assignee: null, needsVote: false };
  AppView._saveKanbanFilters('my-app');
  assert.notEqual(store.getItem(key), null);
  AppView._kanbanFilters = AppView._defaultKanbanFilters();
  AppView._saveKanbanFilters('my-app');
  assert.equal(store.getItem(key), null);
});

test('persisted filters are isolated per app slug', () => {
  const AppView = makeAppView();
  AppView._kanbanFilters = { q: 'alpha', priority: null, assignee: null, needsVote: false };
  AppView._saveKanbanFilters('app-a');
  AppView._kanbanFilters = { q: 'beta', priority: null, assignee: null, needsVote: false };
  AppView._saveKanbanFilters('app-b');
  assert.equal(AppView._loadKanbanFilters('app-a').q, 'alpha');
  assert.equal(AppView._loadKanbanFilters('app-b').q, 'beta');
});

test('_loadKanbanFilters merges over defaults for a partial stored object', () => {
  const store = makeMemoryStore();
  const AppView = makeCtx({ sessionStorage: store }).__AppView;
  store.setItem(`${AppView.KANBAN_FILTERS_KEY}:my-app`, JSON.stringify({ q: 'hi' }));
  // Missing fields fall back to their defaults rather than becoming undefined.
  assert.deepEqual(plain(AppView._loadKanbanFilters('my-app')),
    { q: 'hi', priority: null, assignee: null, category: null, needsVote: false, theme: null, assignedToMe: false, createdByMe: false });
});

test('_loadKanbanFilters yields defaults on corrupt stored JSON', () => {
  const store = makeMemoryStore();
  const AppView = makeCtx({ sessionStorage: store }).__AppView;
  store.setItem(`${AppView.KANBAN_FILTERS_KEY}:my-app`, '{not valid json');
  assert.deepEqual(plain(AppView._loadKanbanFilters('my-app')), none);
});

test('persistence helpers survive a storage-less environment', () => {
  // Simulate sessionStorage throwing (private-window / disabled storage):
  // load falls back to defaults and save is a silent no-op, never throwing.
  const throwing = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  const AppView = makeCtx({ sessionStorage: throwing }).__AppView;
  assert.deepEqual(plain(AppView._loadKanbanFilters('my-app')), none);
  AppView._kanbanFilters = { q: 'dark', priority: null, assignee: null, needsVote: false };
  assert.doesNotThrow(() => AppView._saveKanbanFilters('my-app'));
});

test('?q= seeds the search on the first load, and only the first (#2090)', () => {
  const store = makeMemoryStore();
  const sandbox = makeCtx({ sessionStorage: store });
  const AppView = sandbox.__AppView;
  const key = `${AppView.KANBAN_FILTERS_KEY}:my-app`;
  // The sandbox has no URL of its own; hand it the deep link.
  sandbox.location = { search: '?demo=1&q=%20ripple%20' };
  sandbox.URLSearchParams = URLSearchParams;
  // A falsy slug never touches storage — and does not spend the seed either.
  assert.deepEqual(plain(AppView._loadKanbanFilters('')), none);
  assert.equal(AppView._loadKanbanFilters('my-app').q, 'ripple', 'trimmed, over the stored set');
  // Written straight to storage, so a surface switch restores it exactly as
  // it would a typed search…
  assert.equal(JSON.parse(store.getItem(key)).q, 'ripple');
  // …and the viewer's clearing of it is the last word, though the URL still
  // says `?q=ripple` on every one of these loads. Held rather than consumed,
  // the seed would put the search straight back — #2090 in a new coat.
  AppView._kanbanFilters = AppView._defaultKanbanFilters();
  AppView._saveKanbanFilters('my-app');
  assert.equal(AppView._loadKanbanFilters('my-app').q, '', 'a cleared search stays cleared');
  assert.equal(AppView._loadKanbanFilters('other-app').q, '', 'and no other app inherits it');
  // Blank is absent: nothing seeded, nothing written.
  const blank = makeCtx({ sessionStorage: makeMemoryStore() });
  blank.location = { search: '?q=%20%20' };
  blank.URLSearchParams = URLSearchParams;
  assert.deepEqual(plain(blank.__AppView._loadKanbanFilters('my-app')), none);
  assert.equal(blank.sessionStorage.getItem(`${blank.__AppView.KANBAN_FILTERS_KEY}:my-app`), null);
});

// ── Session cards have only the filters their data supports ─────────────────
// The In progress column now holds the viewer's pinned sessions (top) and
// other users' shared sessions (bottom). The filter bar's vocabulary
// Priority/category do not apply to sessions; text and the person filter do.

test('a text filter now applies to session cards too (they used to be exempt)', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [
    issue({ number: 5, title: 'beta bug', headless: { status: 'generating' } }),
  ];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._mySessions = [
    { id: 51, session_title: 'My pinned session', status: 'active',
      created_at: '2026-06-01T01:00:00Z', last_activity_at: '2026-06-01T01:00:00Z' },
  ];
  AppView._sharedSessions = [
    { id: 71, session_title: 'Shared by them', status: 'paused', username: 'them',
      user_id: 9, shared_at: '2026-06-01T01:00:00Z', created_at: '2026-06-01T01:00:00Z',
      chat_count: 2 },
  ];
  AppView._archivedSessions = [];
  AppView._kanbanFilters = { q: 'zzz-no-match', priority: null, assignee: null, needsVote: false };
  const html = kanbanHtml(AppView);
  // Session cards used to be EXEMPT from the filter bar entirely — type a
  // search term and they just sat there unexplained. Now they filter on
  // their displayed label like every other card.
  assert.doesNotMatch(html, /My pinned session/, 'a non-matching own session is filtered out');
  assert.doesNotMatch(html, /Shared by them/, 'a non-matching shared session is filtered out');
  assert.doesNotMatch(html, /beta bug/, 'non-matching issue card is filtered out');
  // Every card gone, so the column reads as filtered rather than empty.
  assert.match(html, /No matching cards/);
});

test('a session matches on its LABEL and on the issue numbers it links', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._archivedSessions = [];
  AppView._sharedSessions = [];
  AppView._mySessions = [
    { id: 51, session_title: 'Dark mode work', status: 'active', linked_issues: [900002],
      created_at: '2026-06-01T01:00:00Z', last_activity_at: '2026-06-01T01:00:00Z' },
  ];

  const byTitle = { q: 'dark', priority: null, category: null, assignee: null, needsVote: false };
  AppView._kanbanFilters = byTitle;
  assert.match(kanbanHtml(AppView), /Dark mode work/, 'matches its displayed label');

  AppView._kanbanFilters = { ...byTitle, q: '#900002' };
  assert.match(kanbanHtml(AppView), /Dark mode work/, 'matches a linked issue number');

  AppView._kanbanFilters = { ...byTitle, q: '#900999' };
  assert.doesNotMatch(kanbanHtml(AppView), /Dark mode work/, 'an unrelated number does not');
});

test('priority / category are a VISIBLE no-op on session cards', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._archivedSessions = [];
  AppView._sharedSessions = [];
  AppView._mySessions = [
    { id: 51, session_title: 'Dark mode work', status: 'active',
      created_at: '2026-06-01T01:00:00Z', last_activity_at: '2026-06-01T01:00:00Z' },
  ];
  AppView._kanbanFilters = { q: '', priority: 'high', category: null, assignee: null, needsVote: false };
  const html = kanbanHtml(AppView);
  // A dev session carries no such metadata, so hiding it would be silently
  // wrong — it stays, and the column SAYS why the filter didn't apply.
  assert.match(html, /Dark mode work/, 'the session survives an inapplicable filter');
  assert.match(html, /Agent sessions don&#x27;t carry priority, category or assignee/);
  assert.match(html, /not filtered by priority/);

  // The predicate itself keeps the attribute filters as an explicit no-op.
  assert.equal(
    AppView._devCardMatches('session', { session_title: 'x' },
      { priority: 'high', category: 'bug' }),
    true
  );
});

test('a named person filters sessions by author while Unassigned stays a no-op', () => {
  const AppView = makeAppView();
  const session = { session_title: 'Dark mode work', username: 'maya' };
  assert.equal(AppView._devCardMatches('session', session, { ...none, assignee: 'maya' }), true);
  assert.equal(AppView._devCardMatches('session', session, { ...none, assignee: 'sam' }), false);
  assert.equal(AppView._devCardMatches('session', session,
    { ...none, assignee: AppView.KANBAN_ASSIGNEE_UNASSIGNED }), true);
});

test('an imported Underway PR uses proposal attributes, not regular-session exemptions', () => {
  const AppView = makeAppView();
  const imported = {
    id: 88,
    source: 'imported',
    session_title: 'Imported checks work',
    username: 'maya',
    priority: { top: 'high', count: 1 },
    category: { top: 'bug', count: 1 },
    assignee: { top: 'sam', count: 1 },
  };
  assert.equal(AppView._devCardMatches('session', imported,
    { ...none, priority: 'high', category: 'bug', assignee: 'sam' }), true);
  assert.equal(AppView._devCardMatches('session', imported,
    { ...none, priority: 'low' }), false);
  assert.equal(AppView._devCardMatches('session', imported,
    { ...none, assignee: AppView.KANBAN_ASSIGNEE_UNASSIGNED }), false);
  assert.equal(AppView._devCardMatches('session', imported,
    { ...none, needsVote: true }), false, 'voting has not started yet');
});

test('imported Underway cards do not trigger the regular-session filter exception note', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._archivedSessions = [];
  AppView._sharedSessions = [];
  AppView._mySessions = [{
    id: 88, source: 'imported', session_title: 'Imported checks work', status: 'active',
    priority: { top: 'high', count: 1 },
    created_at: '2026-06-01T01:00:00Z', last_activity_at: '2026-06-01T01:00:00Z',
  }];
  AppView._kanbanFilters = { ...none, priority: 'high' };
  const html = kanbanHtml(AppView);
  assert.match(html, /Imported checks work/);
  assert.doesNotMatch(html, /Regular dev sessions don&#x27;t carry/);
});

// ── #1112: the column is titled "Underway", keyed `inprogress` ─────────────
// "In progress" was the column title, the chip on every card in it, and the
// label on the button that put a card there — three different meanings of one
// phrase. The title changed; the KEY did not, because it is the stored kanban
// column_key, the element id and the `?col=` deep-link value.

test('the second column reads "Underway" but keeps its inprogress key and id', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [
    issue({ number: 5, title: 'beta bug', headless: { status: 'generating' } }),
  ];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._mySessions = [];
  AppView._sharedSessions = [];
  AppView._archivedSessions = [];
  AppView._kanbanFilters = { q: '', priority: null, category: null, assignee: null, needsVote: false };
  const html = kanbanHtml(AppView);

  assert.match(html, /Underway <span[^>]*>· 1<\/span>/, 'column head retitled');
  assert.ok(!/In progress <span/.test(html), 'the old title is gone');
  // Load-bearing and unchanged: the key, the id and the tab wiring.
  assert.match(html, /id="dev-kanban-col-inprogress"/);
  assert.match(html, /data-kanban-col="inprogress"/);
  assert.match(html, /aria-controls="dev-kanban-col-inprogress"/);
  // The tab strip reads the same title, so the two surfaces cannot drift.
  const tab = html.match(/id="dev-kanban-tab-inprogress"[\s\S]*?<\/button>/);
  assert.ok(tab && /Underway/.test(tab[0]), 'the mobile tab is retitled too');
  // One-line hover explanation on the column head — the column name alone
  // still cannot say what the five underway states have in common.
  const head = html.match(/id="dev-kanban-col-inprogress"[\s\S]*?dev-kanban-col-head[^>]*title="([^"]+)"/);
  assert.ok(head, 'the column head carries a title attribute');
  assert.match(head[1], /auto-solving/i);
  assert.match(head[1], /paused/i);
  // …and only that column has one, so the other three heads are unchanged.
  assert.equal((html.match(/dev-kanban-col-head[^>]*title="/g) || []).length, 1);
});

// ── The bar itself (#1191, then Streamlined Concept) ────────────────────
//
// The strip was an `innerHTML` template plus six re-bound listeners; #1191
// made it React's, and the Streamlined Concept slimmed it to search + the
// `Filters (n)` chip + the active-filter chips. One property carried through
// every shape and still needs pinning:
//
//   An ordinary board repaint must NOT disturb the search box. That is why
//   `#dev-kanban-filterbar` was left untouched while `#dev-kanban-board` was
//   rewritten around it — a rebuild would have taken the caret with it. The
//   box is uncontrolled for the same reason, and dismissing the Search chip
//   is the one path allowed to replace it (through a `seq` that is its React
//   key).

test('the search box survives a repaint; only its chip dismissal replaces it', () => {
  // Uncontrolled: the typed text is the DOM's, seeded once. A `value` prop
  // here would re-render the box on every repaint and move the caret.
  const html = renderComponent(
    'frontend/src/features/dev-board/kanban-filters.tsx', 'KanbanFiltersView',
    { mounted: true, q: 'photo', seq: 0, count: 0, chips: [] },
  );
  assert.match(html, /id="dev-kanban-search"[^>]*value="photo"/);
  const tsx = read('frontend/src/features/dev-board/kanban-filters.tsx');
  assert.match(tsx, /defaultValue=\{q\}/, 'the search field is uncontrolled');
  assert.doesNotMatch(tsx, /\bvalue=\{q\}/, 'a controlled one would move the caret on every repaint');
  assert.match(tsx, /key=\{`q\$\{seq\}`\}/, 'and its identity is the seq the dismissal bumps');

  // Dismissing the Search chip bumps that seq — the one write that empties
  // the box. The dialog-owned keys just null out, seq untouched.
  const AppView = makeAppView();
  AppView._repaintBoardSurface = () => {};
  AppView._kanbanFilters = { ...none, q: 'photo', priority: 'high' };
  const seq0 = AppView._kanbanFilterSeq;
  AppView._dismissKanbanFilter('priority');
  assert.equal(AppView._kanbanFilters.priority, null);
  assert.equal(AppView._kanbanFilterSeq, seq0, 'a non-search dismissal leaves the box alone');
  AppView._dismissKanbanFilter('q');
  assert.equal(AppView._kanbanFilters.q, '');
  assert.equal(AppView._kanbanFilterSeq, seq0 + 1, 'the Search dismissal re-keys the field');
});

test('a repaint republishes the whole strip: count and chips track the filters', () => {
  const AppView = makeAppView();
  AppView._kanbanFilters = {
    ...none, q: ' ripple ', priority: 'high', assignee: AppView.KANBAN_ASSIGNEE_UNASSIGNED, needsVote: true,
  };
  const seen = [];
  AppView._reactDevBoard = () => ({ publishKanbanFilters: (p) => seen.push(p) });
  // `_updateKanbanFilterBarUI` bails when the host is absent, so give it one.
  AppView.__sandbox.document.getElementById =
    (id) => (id === 'dev-kanban-filterbar' ? { id } : null);
  AppView._updateKanbanFilterBarUI();
  const view = seen[0];
  assert.equal(view.count, 3, 'search stays out of the Filters (n) count');
  // One chip per active filter, in the module's fixed order, labels resolved.
  assert.deepEqual(
    Array.from(view.chips, (c) => ({ ...c })),
    [
      { key: 'q', label: 'Search: ripple' },
      { key: 'priority', label: 'High priority' },
      { key: 'assignee', label: 'Nobody yet' },
      { key: 'needsVote', label: 'Waiting on you' },
    ],
  );
});

// #2089: the search reads past the title — the bodies the board payload
// already carries, and the discussion under a card, which the server
// answers per query and the paint folds in as `commentHits`.
test('text search reads an issue body and a proposal summary or PR body (#2089)', () => {
  const AppView = makeAppView();
  const body = 'On a 360px-wide viewport the action buttons push past the card edge.';
  assert.equal(AppView._devCardMatches('issue', issue({ body }), { ...none, q: 'VIEWPORT' }), true);
  assert.equal(AppView._devCardMatches('issue', issue({ body }), { ...none, q: 'leaderboard' }), false);
  assert.equal(AppView._devCardMatches('issue', issue({ body: null }), { ...none, q: 'viewport' }), false);
  assert.equal(
    AppView._devCardMatches('proposal', prop({ pr_summary_md: 'Cards now wrap on phones.' }), { ...none, q: 'phones' }),
    true
  );
  assert.equal(
    AppView._devCardMatches('proposal', prop({ pr_body: '## Testing\nOpen the board at 360px.' }), { ...none, q: '360px' }),
    true
  );
  assert.equal(
    AppView._devCardMatches('merged', merged({ pr_body: 'Restores the scroll offset.' }), { ...none, q: 'offset' }),
    true
  );
  assert.equal(AppView._devCardMatches('gov', gov({ body: 'Rename because the old name confused people.' }), { ...none, q: 'confused' }), true);
  // Sessions ship no spec, so a body-only query does not match one.
  assert.equal(
    AppView._devCardMatches('session', { id: 5, session_title: 'Fix header', username: 'sam', spec_md: 'viewport' }, { ...none, q: 'viewport' }),
    false
  );
});

test('comment hits match cards by their thread key (#2089)', () => {
  const AppView = makeAppView();
  const hits = { issues: [42], sessions: [9000001], gov: [7] };
  const f = { ...none, q: 'flaky', commentHits: hits };
  assert.equal(AppView._devCardMatches('issue', issue({}), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ number: 43 }), f), false);
  assert.equal(AppView._devCardMatches('proposal', prop({}), f), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ id: 9000002 }), f), false);
  assert.equal(AppView._devCardMatches('merged', merged({ id: 9000001 }), f), true);
  assert.equal(AppView._devCardMatches('session', { id: 9000001, session_title: 'Work', username: 'sam' }, f), true);
  assert.equal(AppView._devCardMatches('gov', gov({}), f), true);
  assert.equal(AppView._devCardMatches('gov', gov({ id: 8 }), f), false);
  // Hits are per query: with none supplied, the same cards do not match.
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, q: 'flaky' }), false);
  // Hits widen the match; they never narrow a title hit.
  assert.equal(AppView._devCardMatches('issue', issue({ number: 43 }), { ...f, q: 'dark mode' }), true);
});

test('_kanbanMatchFilters asks the server once per query and folds the answer in (#2089)', async () => {
  const calls = [];
  let answer = { issues: [42], sessions: [], gov: [] };
  const sandbox = makeCtx({
    fetch: async (url) => { calls.push(url); return { ok: true, json: async () => answer }; },
  });
  const AppView = sandbox.__AppView;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.App.currentApp = 'demo-app';
  sandbox.location = { search: '?demo=1' };
  let repaints = 0;
  AppView._repaintBoardSurface = () => { repaints += 1; };

  // Below the floor nothing is asked.
  AppView._kanbanFilters = { ...none, q: 'f' };
  assert.equal(AppView._kanbanMatchFilters().commentHits, null);
  assert.deepEqual(calls, []);

  AppView._kanbanFilters = { ...none, q: 'Flaky ' };
  assert.equal(AppView._kanbanMatchFilters().commentHits, null, 'unknown until the answer lands');
  assert.equal(calls.length, 1);
  AppView._kanbanMatchFilters();
  assert.equal(calls.length, 1, 'a second paint while the answer is in flight does not ask again');
  assert.match(calls[0], /^\/api\/apps\/demo-app\/board-search\?q=flaky&demo=1$/);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(repaints, 1, 'an answer naming a card repaints');
  const f = AppView._kanbanMatchFilters();
  assert.deepEqual(Array.from(f.commentHits.issues), [42]);
  assert.equal(calls.length, 1, 'the same query is not asked twice');

  // A different query asks again; an empty answer folds in without a repaint.
  answer = { issues: [], sessions: [], gov: [] };
  AppView._kanbanFilters = { ...none, q: 'quiet' };
  AppView._kanbanMatchFilters();
  assert.equal(calls.length, 2);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(repaints, 1);
  assert.deepEqual(Array.from(AppView._kanbanMatchFilters().commentHits.issues), []);

  // Clearing the box drops the hits.
  AppView._kanbanFilters = { ...none, q: '' };
  assert.equal(AppView._kanbanMatchFilters().commentHits, null);
  assert.equal(AppView._kanbanCommentHits, null);
});


// ─── #1935: "Assigned to you" / "Created by you" quick toggles ─────────────

test('Created by you keeps what the viewer authored, on every kind (#1935)', () => {
  const AppView = makeAppView();
  AppView.__sandbox.App.user = { id: 1, username: 'evan' };
  const f = { ...none, createdByMe: true };
  assert.equal(AppView._devCardMatches('issue', issue({ created_by_username: 'evan' }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ created_by_username: 'sam' }), f), false);
  assert.equal(AppView._devCardMatches('proposal', prop({ username: 'evan' }), f), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ username: 'sam' }), f), false);
  assert.equal(AppView._devCardMatches('gov', gov({ created_by_username: 'evan' }), f), true);
  assert.equal(AppView._devCardMatches('merged', merged({ username: 'kim' }), f), false);
  assert.equal(AppView._devCardMatches('session', { username: 'evan' }, f), true);
  assert.equal(AppView._devCardMatches('session', { username: 'sam' }, f), false);
});

test('Assigned to you reads the voted assignee on issues, authorship where nothing is assignable (#1935)', () => {
  const AppView = makeAppView();
  AppView.__sandbox.App.user = { id: 1, username: 'evan' };
  const f = { ...none, assignedToMe: true };
  // Issues: the community-voted assignee, not who filed it.
  assert.equal(AppView._devCardMatches('issue', issue({ created_by_username: 'sam', assignee: { top: 'evan' } }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ created_by_username: 'evan', assignee: { top: 'sam' } }), f), false);
  assert.equal(AppView._devCardMatches('issue', issue({ created_by_username: 'evan' }), f), false,
    'filing an issue does not assign it to you');
  // A proposal or session has no assignee: whoever opened it is doing it.
  assert.equal(AppView._devCardMatches('proposal', prop({ username: 'evan' }), f), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ username: 'sam' }), f), false);
  assert.equal(AppView._devCardMatches('session', { username: 'evan' }, f), true);
  // Governance rows are never assigned.
  assert.equal(AppView._devCardMatches('gov', gov({ created_by_username: 'evan' }), f), false);
});

test('signed out, a persisted quick toggle matches nothing and the strip hides both (#1935)', () => {
  const AppView = makeAppView();
  AppView.__sandbox.App.user = null;
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: { top: 'evan' } }), { ...none, assignedToMe: true }), false);
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, createdByMe: true }), false);
  assert.equal(AppView._kanbanFilterView().quick, null);
  AppView.__sandbox.App.user = { id: 1, username: 'evan' };
  assert.deepEqual(plain(AppView._kanbanFilterView().quick), { assignedToMe: false, createdByMe: false });
});

test('a quick toggle flips, counts as an active filter, and persists like the rest (#1935)', () => {
  const store = makeMemoryStore();
  const sandbox = makeCtx({ sessionStorage: store });
  const AppView = sandbox.__AppView;
  sandbox.App.user = { id: 1, username: 'evan' };
  sandbox.App.currentApp = 'my-app';
  AppView._kanbanFilters = AppView._defaultKanbanFilters();
  let repaints = 0;
  AppView._repaintBoardSurface = () => { repaints += 1; AppView._saveKanbanFilters('my-app'); };
  AppView._toggleKanbanQuickFilter('createdByMe');
  assert.equal(AppView._kanbanFilters.createdByMe, true);
  assert.equal(AppView._kanbanFiltersActive(), true);
  assert.equal(repaints, 1);
  assert.equal(AppView._loadKanbanFilters('my-app').createdByMe, true, 'it survives a reload of the surface');
  AppView._toggleKanbanQuickFilter('createdByMe');
  assert.equal(AppView._kanbanFiltersActive(), false);
  AppView._toggleKanbanQuickFilter('priority');
  assert.equal(AppView._kanbanFilters.priority, null, 'only the two quick keys toggle');
});

test('the strip draws the two quick toggles as pressed chips, only with a viewer (#1935)', () => {
  const base = { mounted: true, q: '', seq: 0, count: 0, chips: [] };
  const on = renderComponent('frontend/src/features/dev-board/kanban-filters.tsx', 'KanbanFiltersView',
    { ...base, quick: { assignedToMe: true, createdByMe: false } });
  assert.match(on, /data-quick-filter="assignedToMe"[^>]*aria-pressed="true"[^>]*bg-zinc-900 text-white/);
  assert.match(on, />Assigned to you</);
  assert.match(on, /data-quick-filter="createdByMe"[^>]*aria-pressed="false"/);
  assert.match(on, />Created by you</);
  const anon = renderComponent('frontend/src/features/dev-board/kanban-filters.tsx', 'KanbanFiltersView',
    { ...base, quick: null });
  assert.doesNotMatch(anon, /data-quick-filter/);
});

// ── When the two quick filters will not fit on one line ────────────────
//
// They move into the Filters dialog. The STRIP is the only thing that can
// tell — whether they fit is a question about the row's contents at a width,
// not about the width, so three active filter chips at 1000px overflow where
// none does at 700 — and it measures its own row and reports through
// `_setQuickFiltersInDialog`. Everything downstream of that decision is in
// app-view.js, which is what these exercise; the measurement itself needs a
// browser and was driven in one (a 300-width sweep, ten passes each, no
// oscillation) rather than asserted here.

test('the dialog owns the two quick filters only when the strip hands them over', () => {
  const AppView = makeAppView();
  AppView.__sandbox.App.user = { id: 1, username: 'evan' };
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), assignedToMe: true, createdByMe: true };

  // Strip's, by default: the bar draws the toggles and the dialog offers none.
  assert.equal(AppView._quickFiltersInDialog, false);
  assert.deepEqual(plain(AppView._kanbanFilterView().quick),
    { assignedToMe: true, createdByMe: true });
  assert.equal(AppView._kanbanFilterCount(), 0,
    'the count does not report a filter whose own toggle is on screen');
  assert.equal(AppView._kanbanActiveChips().map((c) => c.key).join(','), '',
    'and nor does the chip row');

  // Handed over: the bar stops drawing them, and the count and the chip row
  // pick them up — which is how every other dialog-owned filter surfaces.
  let published = 0;
  AppView._reactDevBoard = () => ({ publishKanbanFilters: () => { published += 1; } });
  AppView._setQuickFiltersInDialog(true);
  assert.equal(published, 1, 'reporting republishes the bar');
  assert.equal(AppView._kanbanFilterView().quick, null);
  assert.equal(AppView._kanbanFilterCount(), 2);
  assert.equal(AppView._kanbanActiveChips().map((c) => c.key).join(','),
    'assignedToMe,createdByMe');
  // Idempotent: a re-measure that reaches the same answer publishes nothing,
  // which is what keeps the report out of a loop with the render that made it.
  AppView._setQuickFiltersInDialog(true);
  assert.equal(published, 1);
});

test('a dismissable chip for a quick filter clears it, rather than nulling it', () => {
  const AppView = makeAppView();
  AppView.__sandbox.App.user = { id: 1, username: 'evan' };
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), assignedToMe: true };
  AppView._quickFiltersInDialog = true;
  let repaints = 0;
  AppView._repaintBoardSurface = () => { repaints += 1; };
  AppView._dismissKanbanFilter('assignedToMe');
  assert.equal(AppView._kanbanFilters.assignedToMe, false,
    'false, not null — every reader of these two treats them as booleans');
  assert.equal(repaints, 1);
});

test('the dialog payload offers the switches only when it owns them, and Done respects that', () => {
  const AppView = makeAppView();
  AppView.__sandbox.App.user = { id: 1, username: 'evan' };
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), assignedToMe: true };
  let opened = null;
  AppView.__sandbox.window.UsernodeReact = {
    dialogs: { boardFilters: { open: (p) => { opened = p; } } },
  };
  AppView._repaintBoardSurface = () => {};

  AppView._openKanbanFiltersDialog();
  assert.equal(opened.quick, false, 'the strip has them, so the dialog does not offer them');
  assert.equal(opened.filters.assignedToMe, true, 'but the snapshot still carries their state');

  // WHILE THE STRIP OWNS THEM, Done must not write its snapshot back: it was
  // taken at open, and the reader may have flipped a toggle since.
  AppView.applyKanbanFilters({ priority: 'high', assignedToMe: false, createdByMe: true });
  assert.equal(AppView._kanbanFilters.priority, 'high');
  assert.equal(AppView._kanbanFilters.assignedToMe, true, 'untouched');
  assert.equal(AppView._kanbanFilters.createdByMe, false, 'untouched');

  // Once it owns them, the same call is authoritative.
  AppView._quickFiltersInDialog = true;
  AppView._openKanbanFiltersDialog();
  assert.equal(opened.quick, true);
  AppView.applyKanbanFilters({ priority: null, assignedToMe: false, createdByMe: true });
  assert.equal(AppView._kanbanFilters.assignedToMe, false);
  assert.equal(AppView._kanbanFilters.createdByMe, true);

  // Signed out there is no "you", so neither surface offers them however the
  // measurement came out.
  AppView.__sandbox.App.user = null;
  AppView._openKanbanFiltersDialog();
  assert.equal(opened.quick, false);
});

test('the strip measures its own row, and cannot be read as a breakpoint', () => {
  const SRC = read('frontend/src/features/dev-board/kanban-filters.tsx');
  // The search field counts as its MINIMUM, not the width it happens to have:
  // it is `flex-1`, so its current width says nothing about whether the row
  // fits. Both numbers are the literals in the class strings.
  assert.match(SRC, /const ROW_GAP_PX = 8;/);
  assert.match(SRC, /const SEARCH_MIN_PX = 160;/);
  assert.match(SRC, /const SEARCH_CLS = [\s\S]*?min-w-\[10rem\]/,
    'and the field still declares that minimum');
  assert.match(SRC, /className="flex flex-wrap items-center gap-2"/, 'and the row that gap');
  // The full one-line requirement is computed every time, INCLUDING the two
  // chips when they are not rendered — which is what stops the decision
  // feeding back into itself. `pairRef` is that cache.
  assert.match(SRC, /if \(!quickShownNow\) needed \+= pairRef\.current \?\? 0;/);
  // `#dev-kanban-active-chips` is `display: contents`, so its chips are the
  // row's own flex items and the span itself has no box to measure.
  assert.match(SRC, /child\.id === 'dev-kanban-active-chips'/);
  assert.match(SRC, /className="contents"/);
  // A LAYOUT effect, so the correction lands before the browser paints rather
  // than as a visible flicker on a narrow window.
  assert.ok(!/useEffect\(/.test(SRC), 'no passive effect decides what is drawn');
  assert.match(SRC, /useLayoutEffect\(\(\) => \{\s*if \(!mounted\) return;/);
  // And no media query anywhere near it.
  assert.ok(!/matchMedia|min-width/.test(SRC), 'the decision is measured, never a breakpoint');
});

test('the Filters dialog draws the two switches only when the payload says so', () => {
  const SRC = read('frontend/src/features/dialogs/board-filters.tsx');
  assert.match(SRC, /\{quick \? \(/, 'gated on the payload');
  for (const id of ['board-filters-assignedtome', 'board-filters-createdbyme']) {
    assert.ok(SRC.includes(id), `${id} is the switch's id`);
  }
  // Switches, like the dialog's other boolean — not a copy of the strip's
  // chips. One kind of control reads as one list of conditions, which is what
  // the subtitle at the top of the card promises.
  assert.match(SRC, /<Switch\s+id="board-filters-assignedtome"/);
  assert.match(SRC, /<Switch\s+id="board-filters-createdbyme"/);
  // They are absent from the prerender (`quick` starts false), so they are
  // deliberately NOT in the shell's id inventory — see
  // tests/shell-id-inventory.test.js, which requires every ADDED_IDS entry to
  // be present in the shipped document.
  const SHELL = read('public/index.html');
  assert.ok(!SHELL.includes('board-filters-assignedtome'));
});

test('a declared check reading the filter bar asks for the All-items sub-view (ws=all)', () => {
  // The bug this pins cost a check round. `#app/<slug>/workshop` opens the
  // Workshop LANDER; the board's search-and-filter bar lives in the head of
  // the All-items pane, which mounts only under `ws=all`. Three checks named
  // the bare workshop route and read `#dev-filter-row`, so the element they
  // wanted had never been rendered — a selector that resolves perfectly
  // against a page the runner was never on.
  //
  // tests/dapp-selectors-resolve.test.js cannot catch this: it resolves
  // selectors against the STATIC shell, and every one of these nodes is
  // rendered at runtime by React. The invariant is about the ROUTE, so it is
  // checked here instead — any declared check whose selector names a node the
  // All-items sub-view owns must carry `ws=all` when it loads the workshop
  // route.
  const DAPP = JSON.parse(read('dapp.json'));
  // Ids and attributes that exist only inside the All-items pane. Deliberately
  // not `#dev-workshop` itself, which the lander renders too.
  const ALL_ITEMS_ONLY = [
    '#dev-filter-row', '#dev-kanban-filterbar', '#dev-kanban-search',
    '#dev-kanban-filters-btn', 'data-quick-filter', 'data-ws-pane',
    'dev-ws-group',
  ];
  const offenders = [];
  for (const t of DAPP.tests) {
    const p = t.path || '';
    if (!/#app\/[^/]+\/workshop\b/.test(p)) continue;
    const sel = t.expectSelector || t.expectNoSelector || '';
    if (!ALL_ITEMS_ONLY.some((n) => sel.includes(n))) continue;
    if (!/[?&]ws=all(&|$|#)/.test(p)) offenders.push(`${t.name} → ${p}`);
  }
  assert.deepEqual(offenders.join('\n'), '',
    'these workshop-route checks read All-items nodes without ws=all');
});
