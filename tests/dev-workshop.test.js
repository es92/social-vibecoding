// The Workshop — the Dev screen's lander, which replaced the Activity feed.
//
// What is pinned here, and why each would fail silently if it drifted:
//
//   * The view model (`AppView._workshopView`) groups the SAME cards the
//     Board draws by the server's themes, keyed the way the server keys them,
//     and never loses a card: one the server has not placed yet lands under
//     "Being placed" (marked on the row), one its placer declined under "Not
//     yet grouped", one they name but the board no longer has is not drawn,
//     and the viewer's own private session is placed by the issue it links.
//   * The strips, in the order a returning member reads them: what changed
//     since they were last here, the app's state folded into a dashboard,
//     the proposals waiting on THIS viewer's vote (pinned whatever the
//     filters say) and one unclaimed issue to pick up. The baseline "since"
//     is measured against is read once per page session.
//   * The shared filter bar narrows the themes, and the Workshop's own
//     `theme` filter is what "Open on Board" hands the kanban.
//   * A row unfolds into the Activity entry byte-for-byte — `.dev-feed-entry`
//     around the dense card, the GitHub slot and the app thread — so the
//     sheet CSS and the module's two fillers find the markup they expect.
//   * The modes, the routes and the declared checks name the Workshop and
//     resolve the retired names (feed, list, /activity) onto it.
//
// Run with: node --test tests/dev-workshop.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { workshopHtml, kanbanHtml, api: devCardApi } = require('./lib/dev-card-html');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

// #4457: each week is ONE ROW of Week by week, which opens the week's own
// page in the tab (./week-pages.tsx). `weekRow` renders one row, `weekPage`
// one page, for the tests that want a given week drawn.
const weekRow = (week) => {
  const { WeekRow } = loadTsx('frontend/src/features/dev-board/workshop/week-pages.tsx');
  return renderToHtml(createElement(WeekRow, {
    week: { fresh: [], seen: [], live: week.key === 'thisWeek', ...week }, onOpen: () => {},
  }));
};
const weekPage = (week) => {
  const { WeekPage } = loadTsx('frontend/src/features/dev-board/workshop/week-pages.tsx');
  return renderToHtml(createElement(WeekPage, {
    week: { fresh: [], seen: [], live: week.key === 'thisWeek', ...week },
    slug: 'demo-app', openKey: null, onOpen: () => {}, onBack: () => {},
  }));
};
const { tokenize } = require('./helpers/html-tokens');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const APP_VIEW_SRC = read('public/js/app-view.js');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
// The scroller the rail sticks inside: it carries `.platform-safe-scroll`,
// which is what reserves the home-indicator strip the gap must NOT re-add.
const BOARD_FRAME = read('frontend/src/features/dev-board/board-frame.tsx');
// The shell tree, for the out-of-frost portal host the fixed rail needs.
const SHELL = read('frontend/src/Shell.tsx');
// The row, the open sheet and the fold between them: shared with the Board's columns.
const FOLD = read('frontend/src/features/dev-board/card/fold.tsx');
const CARD_TSX = read('frontend/src/features/dev-board/card/dev-card.tsx');
const CSS = read('public/css/app.css');
const SHEET_TSX = read('frontend/src/features/app-context/app-context-sheet.tsx');
// The toolbar, which renders the shared filter strip's host inside this pane,
// and the "+" that closes the tab strip.
const ACTIONS_ROW = read('frontend/src/features/dev-board/actions-row.tsx');
const dapp = JSON.parse(read('dapp.json'));

// The "+" and the Workshop's two empty-state notes read the toolbar's props
// from the actions store (frontend/src/features/dev-board/actions-store.ts),
// which keeps its one instance on `globalThis` — so the copy loaded here is
// the one the rendered Workshop reads. Publish for the length of `fn`, then
// put the defaults back so no other test inherits a read-only viewer.
const { publishDevActions, DEFAULT_DEV_ACTIONS } = loadTsx('frontend/src/features/dev-board/actions-store.ts');
function withDevActions(over, fn) {
  publishDevActions({ ...DEFAULT_DEV_ACTIONS, ...over });
  try { return fn(); } finally { publishDevActions(DEFAULT_DEV_ACTIONS); }
}

function makeAppView(over) {
  const o = over || {};
  const store = o.localStorage || {};
  const sandbox = {
    console,
    Date,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: o.App || { user: { id: 1, username: 'me' }, currentApp: 'demo-app', currentSubTab: 'forum' },
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
    setTimeout: o.setTimeout || setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    // A no-op by default, as it always was. `sessionStore` opts one test
    // group into a REAL one: the per-app filter set lives here, so whether a
    // filter change is persisted is only observable against a store that
    // remembers (#1787).
    sessionStorage: o.sessionStore ? {
      getItem: (k) => (k in o.sessionStore ? o.sessionStore[k] : null),
      setItem: (k, v) => { o.sessionStore[k] = String(v); },
      removeItem: (k) => { delete o.sessionStore[k]; },
    } : {
      getItem: () => null, setItem: () => {}, removeItem: () => {},
    },
    location: o.location || { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
    // Globals a code path reads as bare identifiers at call time — the "+"
    // wiring wants the real AbortController and a PlatformUI to ask about
    // touch. Absent by default, as they always were.
    ...(o.globals || {}),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  return AppView;
}

// #2176: the dashboard counts CALENDAR weeks (Monday 00:00 UTC), so a
// fixture "two days ago" would land in last week on a Monday and in this
// week on a Wednesday. The clock is held at a Wednesday noon for the whole
// file, in the host (these helpers) and in every sandbox (makeAppView), so
// the fixtures mean the same thing whatever day the suite runs on.
const FIXED_NOW = Date.parse('2026-09-16T12:00:00Z');
// Freeze Date construction too: the rendered relative timestamp uses new Date().
test.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW });
test.after(() => test.mock.timers.reset());
const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

// Values built inside the vm realm carry that realm's prototypes, which trips
// deepStrictEqual — round-trip through JSON before comparing.
const plain = (v) => JSON.parse(JSON.stringify(v));

// The board's own routing, over the seeded module state — used to show the
// mine strip ADDS a place an issue appears without MOVING it.
function bucketsUnderwayIssue(AppView, number) {
  return AppView._bucketDevItems({
    issues: AppView._ghIssues || [], proposals: AppView._proposals || [],
    gov: AppView._govProposals || [], merged: AppView._merged || [],
    mySessions: AppView._mySessions || [], sharedSessions: AppView._sharedSessions || [],
  }).inProgress.some((e) => e.kind === 'issue' && e.item.number === number);
}

/** A loaded board: two issues, a proposal awaiting the viewer's vote, a merge. */
function seed(AppView) {
  AppView._ghIssues = [
    { number: 12, title: 'Dark mode resets', createdAt: at(2), updatedAt: at(1), lastMessageAt: at(1), user: 'alice', htmlUrl: 'https://github.com/x/y/issues/12' },
    { number: 13, title: 'Keyboard voting', createdAt: at(20), updatedAt: at(9), lastMessageAt: null, user: 'bob', htmlUrl: 'https://github.com/x/y/issues/13' },
  ];
  AppView._proposals = [{
    id: 34, pr_number: 41, pr_title: 'Persist the theme', status: 'promoted', username: 'carol',
    created_at: at(3), promoted_at: at(3), last_message_at: at(3), linked_issues: [], my_vote: null,
    votes_for: 1, votes_against: 0, yes_count: 1, no_count: 0,
  }];
  AppView._govProposals = [];
  AppView._merged = [{
    id: 78, pr_number: 40, pr_title: 'Landed thing', status: 'merged', username: 'alice',
    created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr',
  }];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 1;
  AppView._mergedHasMore = false;
  AppView._mySessions = [];
  AppView._sharedSessions = [];
  AppView._devDataReady = true;
}

// RELATIVE TO NOW, NOT A WALL-CLOCK DATE. These two stamps were pinned to
// 2026-09-06, which was inside `relStamp`'s seven-day relative window on the
// day they were written and outside it a week later: the footnote assertion
// wants "drafted 2d ago" and started getting "drafted Sep 6" at exactly the
// REL_FLOOR_MS boundary, with nothing about the grouping having changed. A
// suite that starts failing because time passed blocks every merge in the
// repository, so the fixture moves with the clock and only the copy is pinned.
const themes = (list, extra) => ({
  slug: 'demo-app', source: 'ai', generatedAt: at(2), discoveredAt: at(2),
  stale: false, pending: false, pendingStage: null, lastError: null, coverage: null, unplaced: [],
  at: Date.now(), themes: list, ...(extra || {}),
});

// ── item keys ────────────────────────────────────────────────────────

test('_workshopItemKey speaks the server\'s vocabulary', () => {
  const AppView = makeAppView();
  assert.equal(AppView._workshopItemKey('issue', { number: 12 }), 'issue:12');
  assert.equal(AppView._workshopItemKey('proposal', { id: 34 }), 'session:34');
  assert.equal(AppView._workshopItemKey('shared-session', { id: 56 }), 'session:56');
  assert.equal(AppView._workshopItemKey('my-session', { id: 57 }), 'session:57');
  assert.equal(AppView._workshopItemKey('gov', { id: 5 }), 'gov:5');
  assert.equal(AppView._workshopItemKey('merged', { id: 78, row_type: 'pr' }), 'session:78');
  assert.equal(AppView._workshopItemKey('merged', { id: 9, row_type: 'close_issue', payload: { issueNumber: 12 } }), 'issue:12');
  assert.equal(AppView._workshopItemKey('issue', {}), null);
});

// ── grouping ─────────────────────────────────────────────────────────

test('cards land in their theme, by lane, and nothing is lost', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 'theming', name: 'Theming', description: 'Looks.', saying: 'Dark mode should stick.', items: ['issue:12', 'session:34', 'session:78'] },
    { id: 'ghost', name: 'Ghost', description: '', saying: '', items: ['issue:999'] },
  ]);
  const v = AppView._workshopView();
  assert.equal(v.loading, false);
  assert.equal(v.slug, 'demo-app');
  assert.equal(v.canPost, true);
  const names = v.themes.map((t) => t.name);
  assert.deepEqual(names, ['Theming', 'Being placed'],
    'a theme whose every card is gone is not drawn; the card the server has not placed yet is on its way');
  const theming = v.themes[0];
  assert.equal(theming.saying, 'Dark mode should stick.');
  const lane = (t, k) => t.lanes.find((l) => l.key === k);
  assert.deepEqual(plain(lane(theming, 'review').rows.map((r) => r.key)), ['proposal:34']);
  assert.deepEqual(plain(lane(theming, 'open').rows.map((r) => r.key)), ['issue:12']);
  assert.deepEqual(plain(lane(theming, 'shipped').rows.map((r) => r.key)), ['merged:78']);
  assert.deepEqual(plain(theming.counts), { open: 1, underway: 0, review: 1, shipped: 1, fresh: 0 });
  assert.deepEqual(plain(theming.people), ['alice', 'carol'], 'alice filed and shipped, carol proposed');
  const rest = v.themes[1];
  assert.equal(rest.ungrouped, true);
  assert.equal(rest.placing, 1);
  assert.deepEqual(plain(lane(rest, 'open').rows.map((r) => r.key)), ['issue:13']);
  assert.equal(lane(rest, 'open').rows[0].placing, true, 'the row says so');
  assert.equal(v.meta.placing, 1);
  // Lanes are in stage order, review first.
  assert.deepEqual(plain(theming.lanes.map((l) => l.key)), ['review', 'underway', 'open', 'shipped']);

  // The server's placer declined it: not on its way, not yet grouped.
  AppView._workshopThemes.unplaced = ['issue:13'];
  const declined = AppView._workshopView();
  assert.deepEqual(declined.themes.map((t) => t.name), ['Theming', 'Not yet grouped']);
  assert.equal(declined.themes[1].placing, 0);
  assert.equal(lane(declined.themes[1], 'open').rows[0].placing, undefined);
  assert.match(declined.themes[1].description, /count towards the next re-draft/);
});

test('the viewer\'s own private session is its request\'s tag; without one it waits on its own, unmarked (#4486)', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._mySessions = [
    { id: 57, session_title: 'Fixing dark mode', status: 'active', linked_issues: ['12'], created_at: at(1), last_activity_at: at(0) },
    { id: 58, session_title: 'Something else', status: 'active', linked_issues: [], created_at: at(1), last_activity_at: at(0) },
  ];
  AppView._workshopThemes = themes([{ id: 'theming', name: 'Theming', items: ['issue:12', 'session:34', 'session:78', 'issue:13'] }]);
  const v = AppView._workshopView();
  const lane = (t, k) => t.lanes.find((l) => l.key === k);
  assert.deepEqual(v.themes.map((t) => t.name), ['Theming', 'Not yet grouped']);
  // #4486: the session on #12 folds into #12's row, in #12's category, as
  // its "Spec draft · only you" tag: one item, not a second one underway.
  assert.deepEqual(plain(lane(v.themes[0], 'underway').rows.map((r) => r.key)), [],
    'the linked session is not a second item beside its issue');
  const req = v.themes[0].lanes.flatMap((l) => l.rows).find((r) => r.key === 'issue:12');
  assert.ok(req && req.brief.tags.some((t) => t.label === 'Spec draft · only you'),
    'it is the issue\u2019s tag, though the server never saw it');
  assert.deepEqual(plain(lane(v.themes[1], 'underway').rows.map((r) => r.key)), ['my-session:58']);
  assert.equal(lane(v.themes[1], 'underway').rows[0].placing, undefined, 'a private session is never "being placed": the server cannot see it');
  assert.equal(v.themes[1].placing, 0);
});

test('a failed themes fetch is no themes, not themes that cover nothing', async () => {
  const AppView = makeAppView({ fetch: async () => { throw new Error('offline'); } });
  seed(AppView);
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(AppView._workshopThemes.failed, true);
  assert.equal(AppView._workshopThemeData(), null);
  const v = AppView._workshopView();
  assert.deepEqual(plain(v.themes.map((t) => t.name)), ['Everything on the board']);
  assert.equal(v.meta.source, null);
});

test('before the themes arrive, everything sits under one group rather than a false "not yet grouped"', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = null;
  const v = AppView._workshopView();
  assert.equal(v.themes.length, 1);
  assert.equal(v.themes[0].name, 'Everything on the board');
  assert.equal(v.meta.source, null);
});

test('another app\'s themes never group this app\'s cards', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = { ...themes([{ id: 'x', name: 'X', items: ['issue:12'] }]), slug: 'other-app' };
  const v = AppView._workshopView();
  assert.equal(v.themes[0].name, 'Everything on the board');
});

test('a row carries the thread and the GitHub slot the Activity entry carried', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12', 'session:34'] }]);
  const v = AppView._workshopView();
  const t = v.themes[0];
  const issue = t.lanes.find((l) => l.key === 'open').rows[0];
  assert.equal(issue.commentsFor, 12);
  assert.deepEqual(plain(issue.thread), { type: 'issue', ref: 12 });
  const proposal = t.lanes.find((l) => l.key === 'review').rows[0];
  assert.deepEqual(plain(proposal.thread), { type: 'session', ref: 34 });
  assert.equal(proposal.commentsFor, undefined, 'only an issue has a repository conversation');
});

test('the lane cap counts what it hides, for "Open on Board"', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._ghIssues = Array.from({ length: 12 }, (_, i) => ({
    number: 100 + i, title: `Issue ${i}`, createdAt: at(30), updatedAt: at(30), user: 'bob',
  }));
  AppView._workshopThemes = null;
  const v = AppView._workshopView();
  const open = v.themes[0].lanes.find((l) => l.key === 'open');
  assert.equal(open.rows.length, AppView.WORKSHOP_LANE_MAX);
  assert.equal(open.more, 12 - AppView.WORKSHOP_LANE_MAX);
  assert.equal(v.themes[0].counts.open, 12, 'the count is the true one');
});

// ── the strips ───────────────────────────────────────────────────────

test('the vote strip pins what is owed to the viewer, whatever the filters say', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = null;
  let v = AppView._workshopView();
  assert.equal(v.votes.count, 1);
  assert.deepEqual(plain(v.votes.rows.map((r) => r.key)), ['vote:proposal:34']);
  // #1902: the row carries its thread, so the open card draws a reply box —
  // the same shape the "mine" lane's rows have.
  assert.deepEqual(plain(v.votes.rows[0].thread), { type: 'session', ref: 34 });
  // Voted → not owed.
  AppView._proposals[0].my_vote = 'yes';
  v = AppView._workshopView();
  assert.equal(v.votes.count, 0);
  // Owed but filtered out of the themes: still owed.
  AppView._proposals[0].my_vote = null;
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'dark mode' };
  v = AppView._workshopView();
  assert.equal(v.votes.count, 1, 'a vote owed is owed whatever the board is narrowed to');
  assert.equal(v.meta.filtered, true);
  assert.equal(v.themes[0].lanes.find((l) => l.key === 'review').rows.length, 0,
    'while the theme itself is narrowed');
  // #2915: the discussion row used to be dropped under a filter, as the feed
  // dropped it. The search narrows All items alone now, and this is not on it.
  assert.equal(v.discussion && v.discussion.key, 'discussion',
    'and the discussion row stays: the search is All items\' alone');
});

test('the dashboard is drawn every visit; "since" needs a baseline read once', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const first = AppView._workshopView();
  assert.equal(first.since, null, 'a first visit has nothing to be since');
  // #1787: this was `welcome`, and it was drawn ONLY here. "What is this
  // project working on" is a returning member's question too, so the same
  // numbers are drawn every visit, folded, with the rest of the app's state.
  assert.equal(first.dashboard.open, 3);
  assert.equal(first.dashboard.themes, 1);
  assert.equal(first.dashboard.votesWaiting, 1);
  assert.equal(first.dashboard.shippedWeek, 1);
  assert.equal(first.dashboard.people, 1, 'from the merge context, not a new request');

  // A new page session, a week later than the stamp the first one wrote.
  const store = {};
  store[`${AppView.WORKSHOP_SEEN_KEY}:demo-app`] = String(Date.now() - 5 * 86400000);
  const Later = makeAppView({ localStorage: store });
  seed(Later);
  Later._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const v = Later._workshopView();
  assert.ok(v.dashboard, 'and it is still there on a return visit');
  assert.ok(v.since, 'a baseline exists');
  assert.equal(v.since.opened, 1, 'issue 12 was filed two days ago; issue 13 twenty days ago');
  assert.equal(v.since.proposed, 1);
  assert.equal(v.since.shipped, 1);
  assert.deepEqual(plain(v.since.rows.map((r) => r.key).sort()), ['since:issue:12', 'since:merged:78', 'since:proposal:34']);
  assert.equal(v.themes[0].counts.fresh, 1, 'and the theme counts its new arrivals');
  assert.equal(v.themes[0].lanes.find((l) => l.key === 'open').rows[0].fresh, true);
  // The stamp advanced on that first read, and the baseline is held for the
  // page session: a later repaint compares against the same point.
  assert.ok(Number(store[`${Later.WORKSHOP_SEEN_KEY}:demo-app`]) > Date.now() - 1000);
  assert.equal(Later._workshopView().since.opened, 1);
});

test('the discussion opens from Messages, and from nowhere on this tab', () => {
  const AppView = makeAppView();
  seed(AppView);
  const html = workshopHtml(AppView);
  // IT HAD A SECTION, then a row at the foot of the dashboard pane, and now
  // neither (#2718 review). The section went because three surfaces around
  // one navigating row is two too many; the row goes because the pane it sat
  // in says WHERE THE APP IS, and a door out to a chat screen is not a fact
  // about where the app is.
  //
  // It lost nothing by going: the app's discussion is a row in Messages, the
  // platform's one inbox, beside the people and the agent chats — which is
  // the list somebody looking for "what was said" actually opens. One
  // destination, one place that offers it.
  assert.ok(!html.includes('data-ws-discussion'), 'the section is gone');
  assert.ok(!html.includes('Talk about the app'), 'and so is its eyebrow');
  assert.ok(!html.includes('data-discussion-row'), 'and so is the row that replaced it');
  assert.ok(!html.includes('dev-ws-chat-row'), 'with the surface it drew');
  // The MODEL stays published — app-view.js `_discussionCardModel` — because
  // the board's own surfaces draw from it. What went is this screen's copy.
  const appView = read('public/js/app-view.js');
  assert.ok(appView.includes('_discussionCardModel'), 'the card model is not retired with it');
});

test('the discussion row is drawn as a row of its own', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = null;
  const v = AppView._workshopView();
  assert.equal(v.discussion.key, 'discussion');
  assert.equal(v.discussion.card.attrs['data-discussion-row'], '1');
});

test('the discussion row leads with what it is, not with the last thing said', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._discussionSummary = {
    slug: 'demo-app', content: 'Should the board default to the workshop?',
    username: 'dana', createdAt: at(0),
  };
  const card = AppView._workshopView().discussion.card;
  // The Board's card has always been this way round; the row was inside out,
  // so the one heading on the lander that never changes changed every time
  // somebody spoke (#1787).
  assert.equal(card.title.text, 'General discussion');
  assert.equal(plain(card.meta)[0].s, 'dana: Should the board default to the workshop?');

  AppView._discussionSummary = null;
  assert.equal(plain(AppView._workshopView().discussion.card.meta)[0].s,
    'Talk with everyone building this app',
    'and with nothing said yet the standing description takes the preview line');
});

test('the capture deep link names the first issue row to unfold', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['session:34', 'issue:12'] }]);
  assert.equal(AppView._workshopView().autoExpand, null);
  AppView._workshopShot = 'feed-comments';
  assert.deepEqual(plain(AppView._workshopView().autoExpand), { theme: 't', key: 'issue:12' });
});

test('every return path states `loading`, because the store merges', () => {
  const AppView = makeAppView();
  AppView._devDataReady = false;
  assert.equal(AppView._workshopView().loading, true);
  seed(AppView);
  assert.equal(AppView._workshopView().loading, false);
});

// ── the theme filter ─────────────────────────────────────────────────

test('the theme filter narrows by membership, and widens when it cannot be applied', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  const f = { ...AppView._defaultKanbanFilters(), theme: 't' };
  assert.equal(AppView._devCardMatches('issue', AppView._ghIssues[0], f), true);
  assert.equal(AppView._devCardMatches('issue', AppView._ghIssues[1], f), false);
  assert.equal(AppView._devCardMatches('proposal', AppView._proposals[0], f), false);
  assert.equal(AppView._devCardMatches('proposal', { id: 99, linked_issues: ['12'], status: 'promoted' }, f), true,
    'a card the themes do not name is in the theme of the issue it links, as on the Workshop');
  assert.equal(AppView._devCardMatches('proposal', { id: 98, linked_issues: [] }, f), false);
  AppView._workshopThemes = null;
  assert.equal(AppView._devCardMatches('issue', AppView._ghIssues[1], f), true,
    'no themes loaded → the filter cannot hide anything');
  AppView._kanbanFilters = f;
  assert.equal(AppView._kanbanFiltersActive(), true);
  assert.equal(AppView._kanbanFilterCount(), 1);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  assert.deepEqual(plain(AppView._kanbanActiveChips().map((c) => [c.key, c.label])), [['theme', 'Category: Theming']]);
  AppView._dismissKanbanFilter('theme');
  assert.equal(AppView._kanbanFilters.theme, null);
});

// ── the follow-up to #1787: two panes, and a described app ───────────

test('the numbers are tiles, and the pane always has a sentence under them', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13'] }]);
  const html = workshopHtml(AppView, 'workshop');
  // Four integers read out as prose is the slowest form they can take, so
  // they are figures. The ORDER is an argument: the backlog, the part of it
  // nobody has taken, the decision waiting on you, then what landed — it
  // reads as a progression and ends on the one number that says the app is
  // moving. The old order put the outcome second and left the unclaimed
  // count at the far end, away from the total it qualifies.
  const order = [...html.matchAll(/data-ws-dash-cell="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['open', 'unclaimed', 'votes', 'shipped']);
  assert.match(html, /data-ws-dash-cell="open"[^>]*><b>3<\/b>/);
  assert.match(html, /data-ws-dash-cell="unclaimed"[^>]*><b>2<\/b>/);
  assert.match(html, /data-ws-dash-cell="votes"[^>]*><b>1<\/b>/);
  assert.match(html, /data-ws-dash-cell="shipped"[^>]*><b>1<\/b>/);
  assert.match(html, /nobody on them/);
  assert.match(html, /waiting on a vote/);
  // TONE IS CARRIED TWICE: a mark beside the label, and the same hue on the
  // figure. The mark is what makes the colour affordable. The original
  // `dev-ws-dash-good`/`-warn` painted the integer and nothing else, which
  // is state carried by hue ALONE — invisible to a reader who cannot
  // separate the two, and a status colour on bare text. Adding the dot fixed
  // that, and the fix was over-applied: the number went back to ink at the
  // same time, so the one thing the eye actually lands on in this row went
  // grey while a 5px mark two lines down carried the whole signal. With the
  // dot present the hue is REDUNDANT rather than load-bearing, so it is free
  // — the row still reads correctly in greyscale, and reads faster in
  // colour. Both halves are pinned here so neither can be dropped as the
  // duplicate it looks like.
  assert.match(html, /class="dev-ws-dash-cell dev-ws-dash-cell-good"[^>]*data-ws-dash-cell="shipped"/);
  assert.match(html, /class="dev-ws-dash-cell dev-ws-dash-cell-warn"[^>]*data-ws-dash-cell="votes"/);
  assert.match(CSS, /\.dev-ws-dash-cell-good b \{ color: var\(--state-ok\); \}/);
  assert.match(CSS, /\.dev-ws-dash-cell-warn b \{ color: var\(--state-attention\); \}/);
  assert.match(html, /data-ws-dash-cell="shipped"[\s\S]{0,200}?dev-ws-dash-dot-good/);
  assert.match(html, /data-ws-dash-cell="votes"[\s\S]{0,200}?dev-ws-dash-dot-warn/);
  // The mark and the figure take their colour from ONE token each, so they
  // cannot drift into two greens.
  assert.match(CSS, /\.dev-ws-dash-dot-good \{[^}]*var\(--state-ok\)/);
  assert.match(CSS, /\.dev-ws-dash-dot-warn \{[^}]*var\(--state-attention\)/);
  // Only the two that are a CALL wear one. "Nobody on them" is a fact about
  // the backlog, not an alarm; it had no tone before and gains none.
  const unclaimed = html.slice(html.indexOf('data-ws-dash-cell="unclaimed"'));
  assert.ok(!unclaimed.slice(0, unclaimed.indexOf('data-ws-dash-cell="votes"')).includes('dev-ws-dash-dot'),
    'the unclaimed figure carries no mark');

  // AND A ZERO IS NOT A STATE. Nothing waiting on a vote and nothing shipped
  // are the resting values of these two, not an alarm and not an
  // achievement — a green 0 beside "shipped this week" congratulates a
  // quiet Monday, and it only became possible to draw once the hue went back
  // on the figure.
  const quiet = makeAppView();
  seed(quiet);
  quiet._proposals = [];
  quiet._merged = [];
  quiet._mergedTotal = 0;
  const calm = workshopHtml(quiet, 'workshop');
  assert.match(calm, /data-ws-dash-cell="votes"[^>]*><b>0<\/b>/);
  assert.match(calm, /data-ws-dash-cell="shipped"[^>]*><b>0<\/b>/);
  assert.ok(!/dev-ws-dash-cell-(good|warn)/.test(calm), 'no tone on a resting figure');
  assert.ok(!calm.includes('dev-ws-dash-dot'), 'and no mark either');

  // And the derived sentence is back UNDER them. Round four trimmed it to
  // the two things a tile cannot show and let it render nothing when it
  // could say neither — right about the duplication, wrong about the
  // outcome: an app can sit a long time with no model paragraph, and a
  // heading over four tiles and no sentence reads as a broken feature
  // rather than a deliberate silence.
  assert.match(html, /class="dev-ws-open-line"[^>]*>3 open items across 1 category\./);
  assert.ok(!html.includes('most of the movement'),
    'but still no unearned superlative: two untouched issues are the absence of movement');
});

test('the derived sentence says something even when it can compare nothing', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  // A paged history refuses to compare weeks and this board has no busiest,
  // so the two clauses round four kept are both silent. The pane still has
  // a sentence.
  AppView._mergedHasMore = true;
  const html = workshopHtml(AppView, 'workshop');
  assert.match(html, /data-ws-dash-cell="open"/, 'the figures carry the state');
  assert.match(html, /class="dev-ws-open-line"[^>]*>[^<]+/, 'and the paragraph is rendered');
  assert.match(html, /At least 1 change landed this week\./, 'a floor, and no rate');
});

test('a paged merge history states a floor and no rate at all', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);

  // Both weeks are counted from the same page, and the EARLIER one is the
  // half that falls off the end. So a truncated page used to read as a
  // drought that never happened: an app merging twenty a week was told "20
  // landed this week, the first in a fortnight". `At least` was already on
  // the count and never helped, because the fault was in the comparison.
  AppView._mergedHasMore = true;
  const paged = workshopHtml(AppView, 'workshop');
  assert.ok(!paged.includes('fortnight'), 'no drought is claimed off a partial page');
  assert.ok(!paged.includes('the week before'), 'and no rate either');
  // The floor is said in one character, on the tile itself.
  assert.match(paged, /data-ws-dash-cell="shipped"[^>]*><b>1\+<\/b>/);
  assert.match(paged, /title="At least this many/);

  // With the whole history in hand the comparison is real, and stands.
  AppView._mergedHasMore = false;
  const whole = workshopHtml(AppView, 'workshop');
  assert.match(whole, /data-ws-dash-cell="shipped"[^>]*><b>1<\/b>/, 'no marker');
  assert.ok(!whole.includes('title="At least this many'), 'and no floor tooltip');
  assert.match(whole, /1 change landed this week, the first in a fortnight\./);
});

test('busiest names the theme that is MOVING, and stays quiet without a clear leader', () => {
  const AppView = makeAppView();
  const t = (name, counts) => ({ name, counts: { open: 0, underway: 0, review: 0, shipped: 0, fresh: 0, ...counts } });

  // The bug: it sorted on `lastActive`, so ONE comment ten minutes ago on a
  // ten-item theme beat a hundred-item one and the sentence told the group
  // their work was somewhere it was not.
  assert.equal(
    AppView._busiestTheme([t('Quiet', { open: 90 }), t('Busy', { underway: 4, review: 2 })]),
    'Busy',
    'a big backlog is not movement; four underway and two in review is',
  );

  // Open items alone never win it.
  assert.equal(AppView._busiestTheme([t('Backlog', { open: 200 })]), null);

  // Neither does a near-tie: "most of the movement" is a strong claim.
  assert.equal(
    AppView._busiestTheme([t('A', { underway: 4 }), t('B', { underway: 3 })]),
    null,
    'within 1.5x is not "most"',
  );
  assert.equal(AppView._busiestTheme([t('A', { underway: 6 }), t('B', { underway: 3 })]), 'A');

  // Nor a board where almost nothing is in flight at all.
  assert.equal(AppView._busiestTheme([t('A', { shipped: 2 })]), null, 'under the floor');
  assert.equal(AppView._busiestTheme([t('A', { shipped: 3 })]), 'A');
  assert.equal(AppView._busiestTheme([]), null);
});

test('the model\'s paragraph is what the pane says, when there is one', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes(
    [{ id: 't', name: 'Theming', items: ['issue:12'] }],
    { digest: 'In the last week, alice finished the sign-in work. Bob is on the mail templates now.' },
  );
  const html = workshopHtml(AppView, 'workshop');
  assert.match(html, /In the last week, alice finished the sign-in work\. Bob is on the mail templates now\./);
  // …and the derived sentence is what runs when there is none: no model, no
  // draft yet, or a call that failed. Same relationship the category grouping
  // has to the drafted themes.
  assert.ok(!html.includes('open items across'), 'the derived one stands down');
  // And the footnote says which of the two is on screen, so "the summarizer
  // looks broken" and "no draft yet" are distinguishable without reading the
  // database.
  // The healthy case says NOTHING now: provenance under every working board
  // answered a question nobody had asked and cost a line to do it.
  assert.ok(!html.includes('data-ws-digest-note'), 'no caption on the ordinary case');

  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  const derived = workshopHtml(AppView, 'workshop');
  assert.match(derived, /3 open items across 1 category\./);
  assert.match(derived, /Worked out from the board; the model writes one on the next pass\./);

  // And when the last attempt FAILED, the footnote says why. That failure
  // used to be a log line and a day of silence, which is what the report
  // "could something be up with the summarizer?" cost to answer.
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }],
    { digestError: 'Workshop digest response hit the output limit before it finished' });
  const failed = workshopHtml(AppView, 'workshop');
  assert.match(failed, /could not be written \(Workshop digest response hit the output limit before it finished\); it is retried within the hour/);
  assert.ok(!failed.includes('the model writes one on the next pass'), 'not also the neutral line');
});

test('the digest survives the fetch that loads it', async () => {
  // The seam every test above steps over. They seed `_workshopThemes` with
  // the CACHE shape directly, so `_loadWorkshopThemes` — the only thing that
  // writes that cache in a browser — is never on the path, and the field it
  // dropped was the one field the pane degrades silently on. #1803 shipped
  // the consumer (`tData.digest`) without the producer, and the derived
  // sentence made a paragraph that never arrived look exactly like a model
  // that had not run yet, through two rounds of fixes to the stages above.
  //
  // So this one asserts ACROSS the normaliser, not beside it: the response
  // body goes in, the rendered pane comes out.
  const digest = 'In the last week, alice finished the sign-in work. Bob is on the mail templates now.';
  const body = {
    themes: [{ id: 't', name: 'Theming', items: ['issue:12'] }],
    source: 'ai', generatedAt: '2026-09-06T00:00:00Z', discoveredAt: '2026-09-06T00:00:00Z',
    stale: false, pending: false, pendingStage: null, lastError: null,
    coverage: null, unplaced: [], digest, digestError: null,
  };
  const AppView = makeAppView({ fetch: async () => ({ ok: true, json: async () => body }) });
  seed(AppView);
  // The load repaints the live surface on the way out; this test is about
  // what it CACHED and what the pane makes of it, not about the DOM.
  AppView._repaintBoardSurface = () => {};
  await AppView._loadWorkshopThemes('demo-app');

  assert.equal(AppView._workshopThemes.digest, digest, 'the normaliser keeps it');
  const html = workshopHtml(AppView, 'workshop');
  assert.match(html, /alice finished the sign-in work/);
  assert.ok(!html.includes('open items across'), 'and the derived sentence stands down');
  // The healthy case says NOTHING now: provenance under every working board
  // answered a question nobody had asked and cost a line to do it.
  assert.ok(!html.includes('data-ws-digest-note'), 'no caption on the ordinary case');

  // A response with no paragraph still reads as one: null, not undefined,
  // so the footnote picks the neutral line rather than the failure one.
  const empty = makeAppView({ fetch: async () => ({ ok: true, json: async () => ({ ...body, digest: null }) }) });
  seed(empty);
  empty._repaintBoardSurface = () => {};
  await empty._loadWorkshopThemes('demo-app');
  assert.equal(empty._workshopThemes.digest, null);
  assert.match(workshopHtml(empty, 'workshop'), /3 open items across 1 category\./);
});

// ── the three digest cards ───────────────────────────────────────────

/** A workshop-themes response body, with whatever digest shape a test wants. */
const responseBody = (over) => ({
  themes: [{ id: 't', name: 'Theming', items: ['issue:12'] }],
  source: 'ai', generatedAt: '2026-09-06T00:00:00Z', discoveredAt: '2026-09-06T00:00:00Z',
  stale: false, pending: false, pendingStage: null, lastError: null,
  coverage: null, unplaced: [], digest: null, digestCards: null, digestError: null,
  ...(over || {}),
});

async function loadWith(body) {
  const AppView = makeAppView({ fetch: async () => ({ ok: true, json: async () => body }) });
  seed(AppView);
  AppView._repaintBoardSurface = () => {};
  await AppView._loadWorkshopThemes('demo-app');
  return AppView;
}

test('All items leads with the open line, and the weeks head the since list, the live one open', async () => {
  const cards = {
    lastWeek: 'Kubernetes deploys, staging previews and email recovery, plus a Workshop pass.',
    thisWeek: 'The Workshop summary became three cards and mail now sends from a no-reply address.',
    open: 'Mostly mobile layout, the voting flow and a long tail of preview reliability.',
  };
  const AppView = await loadWith(responseBody({ cards: undefined, digestCards: cards }));
  assert.deepEqual(plain(AppView._workshopThemes.digestCards),
    { ...cards, older: [], firstWeek: null },
    'the normaliser keeps all three, and says there are no earlier weeks');

  const html = workshopHtml(AppView, 'workshop');
  // `open` IS NOT A WINDOW. It is All items' lead paragraph: what the open
  // work is about, beside the figure that raises the question.
  assert.match(html, new RegExp(`class="dev-ws-open-line"[^>]*>${cards.open.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}`),
    'the open line leads the pane');
  assert.ok(!html.includes('data-ws-since-week="open"'), 'and is not a week');
  assert.ok(!html.includes('Open issues'), 'nor titled as one');

  // #4457: WEEK BY WEEK, one row a week, under Since your last visit: each
  // row its name, dates and line, and nothing unfolds under it.
  const order = [...html.matchAll(/data-ws-week="([a-zA-Z:0-9]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['thisWeek', 'lastWeek'], 'a row for each week, newest first');
  assert.ok(html.includes(cards.thisWeek) && html.includes(cards.lastWeek), 'each with its line');
  assert.ok(!html.includes('data-ws-since-week'), 'no week unfolds inside the since list');
  assert.ok(!html.includes('data-ws-cards') && !html.includes('data-ws-week-more'), 'the walk is gone');
  assert.ok(html.indexOf('data-ws-dashboard') < html.indexOf('data-ws-since=""')
    && html.indexOf('data-ws-since=""') < html.indexOf('data-ws-weeks=""'), 'All items, then what changed, then the weeks');

  // The weeks themselves are the view model's, so the order and the titles
  // are pinned where the component cannot quietly re-sort them.
  const dash = AppView._workshopView().dashboard;
  assert.deepEqual(plain(dash.weeks.map((w) => w.key)), ['thisWeek', 'lastWeek'],
    'weeks only — `open` is not a window');
  assert.deepEqual(plain(dash.weeks.map((w) => w.title)), ['This week', ''],
    'and only the live one keeps a word; the rest are named by their dates');
  assert.equal(dash.openLine, cards.open, 'the open line is its own field');

  // The tiles stay, and the line sits under them.
  assert.match(html, /data-ws-dash-cell="open"/);
  assert.ok(html.indexOf('class="dev-ws-dash"') < html.indexOf('class="dev-ws-open-line"'));
  assert.ok(!html.includes('open items across'), 'no count sentence beside the lines');
  assert.ok(!html.includes('data-ws-digest-note'), 'no caption on the ordinary case');
});

test('the lead block names what its sentence is about, and the walk’s way back went with the walk', async () => {
  const AppView = await loadWith(responseBody({
    digestCards: {
      lastWeek: 'The vote counter was rebuilt and two preview races were closed.',
      thisWeek: 'Kubernetes deploys stopped racing the health check.',
      open: 'The domain migration and a long tail of preview reliability.',
    },
  }));
  const html = workshopHtml(AppView, 'workshop');
  // A HEADING OVER THE SENTENCE. The pane's lead paragraph is about the
  // OPEN work, and under four figures a bare sentence reads as a summary of
  // the pane, which it is not: it never mentions what landed.
  assert.match(html, /class="dev-ws-lead-title">Open items</, 'the lead block is titled');
  assert.ok(html.indexOf('dev-ws-lead-title') < html.indexOf('dev-ws-open-line'),
    'and the title comes first');
  assert.match(CSS, /\.dev-ws-lead-title \{[^}]*font-size: 13px/);
  // "Hide past weeks" folded the walk that was under this block. The weeks
  // are the since list's now, whose Clear folds it back.
  assert.ok(!html.includes('data-ws-week-less'));
  assert.ok(!WORKSHOP.includes('data-ws-week-less') && !WORKSHOP.includes('<WeekWalk'));
});

test('the since list files each row under the week it moved in, and opens down to the newest news', () => {
  const { sinceWeeks, sinceWeeksOpen, sinceNewFurther, mondayUtc } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  const WEEK = 7 * 86400000;
  const monday = Date.UTC(2026, 8, 14); // this week's, under FIXED_NOW
  assert.equal(mondayUtc(FIXED_NOW), monday, 'the weeks’ own anchor: Monday 00:00 UTC');
  const row = (key, ms) => ({ t: 'card', key, card: {}, at: ms });
  const weeks = [
    { key: 'thisWeek', title: 'This week', startMs: monday, endMs: FIXED_NOW, line: 'Now.', counts: { closed: 2, partial: false } },
    { key: 'lastWeek', title: '', startMs: monday - WEEK, endMs: monday, line: 'Last.', counts: null },
    { key: `week:${monday - 3 * WEEK}`, title: '', startMs: monday - 3 * WEEK, endMs: monday - 2 * WEEK, line: 'Long ago.', counts: null },
  ];
  const since = {
    baseline: 0, through: 0, total: 3, shipped: 0, opened: 0, proposed: 0,
    rows: [row('since:a', FIXED_NOW - 3600000), row('since:b', monday - 2 * 86400000), row('since:c', FIXED_NOW + 60000)],
    seen: { total: 2, rows: [row('seen:d', monday - WEEK - 3600000), row('seen:e', monday - 2 * WEEK + 3600000)] },
  };
  const list = sinceWeeks(since, weeks, FIXED_NOW);
  assert.deepEqual(list.map((w) => w.key), ['thisWeek', 'lastWeek', `week:${monday - 2 * WEEK}`, `week:${monday - 3 * WEEK}`],
    'newest first, and a week the digest skipped gets a heading of its own dates');
  assert.deepEqual(list.map((w) => w.fresh.map((r) => r.key)), [['since:a', 'since:c'], ['since:b'], [], []],
    'a row a server clock put a moment ahead files under this week, not a week that has not started');
  assert.deepEqual(list.map((w) => w.seen.map((r) => r.key)), [[], [], ['seen:d', 'seen:e'], []],
    'what was seen files the same way');
  assert.equal(list[2].line, '', 'a week the digest has no line for draws none');
  assert.equal(list[3].line, 'Long ago.', 'and a digest week with no rows keeps its line: it is the history');
  // #4457: the weeks are rows that open a page; nothing about the list
  // opens week by week any more, so the counters that did are gone.
  assert.ok(!/sinceWeeksOpen|sinceNewFurther|setSinceExtra|setSinceMore/.test(WORKSHOP), 'the nested reveals\' state is gone');
});

test('a week unfolded before the digest lands stays unfolded when the digest re-keys it', () => {
  // The board paints first and the week summaries ride in behind it: until
  // then this week is `week:<Monday>`, after it `thisWeek`. What is unfolded
  // is remembered by the Monday both share, so the re-key does not fold it.
  const { sinceWeeks, sinceWeekStateKey } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  const WEEK = 7 * 86400000;
  const monday = Date.UTC(2026, 8, 14);
  const row = (key, ms) => ({ t: 'card', key, card: {}, at: ms });
  const since = {
    baseline: 0, through: 0, total: 1, shipped: 0, opened: 0, proposed: 0,
    rows: [row('since:a', FIXED_NOW - 3600000)],
    seen: { total: 1, rows: [row('seen:b', monday - WEEK + 3600000)] },
  };
  const before = sinceWeeks(since, null, FIXED_NOW);
  assert.deepEqual(before.map((w) => w.key), [`week:${monday}`, `week:${monday - WEEK}`]);
  const open = { [sinceWeekStateKey(before[1])]: true };
  const after = sinceWeeks(since, [
    { key: 'thisWeek', title: 'This week', startMs: monday, endMs: FIXED_NOW, line: 'Now.', counts: null },
    { key: 'lastWeek', title: '', startMs: monday - WEEK + 7200000, endMs: monday, line: 'Last.', counts: null },
  ], FIXED_NOW);
  assert.deepEqual(after.map((w) => w.key), ['thisWeek', 'lastWeek'], 'the digest re-keys the same weeks');
  assert.equal(open[sinceWeekStateKey(after[1])], true, 'and the unfolded one is still found open');
  assert.ok(!open[sinceWeekStateKey(after[0])], 'while its neighbour stays folded');
  // The open week's page and the React key both read the Monday.
  assert.match(WORKSHOP, /weeks\.find\(\(w\) => sinceWeekStateKey\(w\) === openWeek\)/);
  assert.match(WORKSHOP, /<WeekRow key=\{sinceWeekStateKey\(w\)\} week=\{w\} onOpen=\{\(\) => openWeekPage\(sinceWeekStateKey\(w\)\)\} \/>/);
});

// ── #3293: the list reaches back to the project's start ──────────────

test('#3293: the weeks go back, one at a time, to the project’s start', async () => {
  const WEEK = 7 * 86400000;
  const monday = Date.UTC(2026, 8, 14); // this week's, under FIXED_NOW
  const iso = (ms) => new Date(ms).toISOString();
  const cards = {
    lastWeek: 'The vote counter was rebuilt and two preview races were closed.',
    thisWeek: 'Kubernetes deploys stopped racing the health check.',
    open: 'The domain migration and a long tail of preview reliability.',
    // Oldest first on the wire, on purpose: the order is the client's to set.
    older: [
      { start: iso(monday - 5 * WEEK), closed: 1, line: 'The first proposal went in.' },
      { start: iso(monday - 2 * WEEK), closed: 7, line: 'Dark mode; Keyboard voting; Mobile layout; and 4 more.' },
    ],
    // Created a week before anything landed: that week held nothing, so it
    // has no line, and it is still where the list ends.
    firstWeek: iso(monday - 6 * WEEK),
  };
  const AppView = await loadWith(responseBody({ digestCards: cards }));
  assert.deepEqual(plain(AppView._workshopThemes.digestCards.older.map((w) => w.closed)), [7, 1],
    'the normaliser keeps each week’s count, newest first');

  const dash = AppView._workshopView().dashboard;
  assert.deepEqual(plain(dash.weeks.map((w) => w.key)),
    ['thisWeek', 'lastWeek', `week:${monday - 2 * WEEK}`, `week:${monday - 5 * WEEK}`],
    'past last week, on to the oldest week anything landed in, and no window for the empty weeks between');
  assert.deepEqual(plain(dash.weeks.slice(2).map((w) => w.counts)),
    [{ closed: 7, partial: false }, { closed: 1, partial: false }]);
  assert.equal(dash.firstWeek, monday - 6 * WEEK);

  const third = weekRow(plain(dash.weeks[2]));
  assert.match(third, /<b>Aug 31 – Sep 6<\/b>/, 'an older week is its dates');
  assert.match(third, /<span class="dev-ws-week-n"><b>7<\/b> live<\/span>/, 'with its figure');
  assert.match(third, /Dark mode; Keyboard voting; Mobile layout; and 4 more\./, 'and what landed in it');

  // The list opens on two weeks, and Show earlier weeks adds more rows.
  const html = workshopHtml(AppView, 'workshop');
  assert.equal([...html.matchAll(/data-ws-week="/g)].length, 2);
  assert.match(html, /data-ws-weeks-more="">/, 'live while there is more');
  assert.ok(!html.includes('data-ws-week-start'), 'with no floor drawn mid-list');
  // THE BEGINNING, SAID, once the list is walked to its end, and only then.
  assert.match(WORKSHOP, /\) : firstWeek \? \(\s*<p className="dev-ws-week-note" data-ws-week-start="">\s*\{`This project started the week of \$\{weekDate\(firstWeek\)\}\.`\}/);

  // A cache written before the counts existed carries none, and the week
  // draws its line alone rather than a zero.
  const legacy = plain(AppView._workshopWeeks({ ...cards, older: [{ start: monday - 3 * WEEK, line: 'Old.' }] },
    FIXED_NOW, null));
  assert.equal(legacy[legacy.length - 1].counts, null);
  assert.ok(!weekRow(legacy[legacy.length - 1]).includes('dev-ws-week-n'));
});

test('#3293: a week from another year says which year', () => {
  const WEEK = 7 * 86400000;
  const jan = weekRow({ key: 'week:a', title: '', startMs: Date.UTC(2026, 0, 12), endMs: Date.UTC(2026, 0, 12) + WEEK, counts: null, line: 'January.' });
  const dec = weekRow({ key: 'week:b', title: '', startMs: Date.UTC(2025, 11, 29), endMs: Date.UTC(2025, 11, 29) + WEEK, counts: null, line: 'Across the new year.' });
  assert.match(jan, /<b>Jan 12 – Jan 18<\/b>/, 'this year: no year');
  assert.match(dec, /<b>Dec 29, 2025 – Jan 4<\/b>/, 'last year: named');
});

test('#4457: a week is one row that opens its own page, grouped, with the way back', async () => {
  const AppView = await loadWith(responseBody({
    digestCards: {
      lastWeek: 'the Dev screen became a styled Workshop, alongside many bug fixes.',
      thisWeek: 'summary cards got shorter, plus preview and sign-in work.',
      open: 'mostly QA triage, with older proposals still awaiting votes.',
    },
  }));
  const [live, last] = plain(AppView._workshopView().dashboard.weeks);
  // THE ROW: its name, its range, the line, how many went live, a chevron.
  const html = weekRow(live);
  assert.match(html, /^<button type="button" class="dev-ws-week" data-ws-week="thisWeek">/, 'one row, a button');
  assert.match(html, /<span class="dev-ws-week-head"><b>This week<\/b><span>[^<]*→ now<\/span><\/span>/,
    'the live week: a name, then a range that runs to now');
  assert.match(html, /<span class="dev-ws-week-line">summary cards got shorter/);
  assert.match(html, /<span class="dev-ws-week-n"><b>\d+<\/b> live<\/span>/, 'what went live, in green');
  assert.match(weekRow(last), /<b>Last week<\/b><span>[A-Z][a-z]{2} \d+ – /, 'last week by name, with its dates');
  // "N new" counts what OTHER people did since your last visit.
  const brief = (over) => ({ kind: 'request', noun: 'Request', n: 1, by: 'maya', mine: false, category: '', replies: 0, linked: [], closed: [], stage: 'request', at: live.startMs + 1000, tags: [], vote: null, ...over });
  const row = (key, over) => ({ t: 'card', key, card: AppView._issueCardModel(AppView._ghIssues[0]), at: FIXED_NOW - 3600000, brief: brief(over) });
  const withNew = { ...live, fresh: [row('since:a'), row('since:b', { mine: true })] };
  assert.match(weekRow(withNew), /<span class="dev-ws-week-fresh">1 new<\/span>/, 'yours is not news to you');

  // THE PAGE: ‹ Workshop and the week's name, its range and line, then its
  // groups, empty ones left out. Nothing unfolds inside anything.
  const full = {
    ...live,
    fresh: [row('since:n', { by: 'maya' })],
    seen: [
      row('seen:v', { kind: 'change', noun: 'Change', stage: 'vote', vote: { yes: 0, need: 1, ask: true } }),
      row('seen:l', { kind: 'live', noun: 'Change', stage: 'live' }),
      row('seen:r', { stage: 'request' }),
      row('seen:w', { stage: 'worked', at: live.startMs - 86400000 }),
    ],
  };
  const page = weekPage(full);
  assert.match(page, /^<div class="dev-ws-weekpage" data-ws-week-page="thisWeek"><div class="dev-ws-pagehead" data-ws-pagehead="">/);
  assert.match(page, /<span class="dev-ws-pagehead-over">Workshop<\/span><h2 class="dev-ws-pagehead-title">This week<\/h2>/);
  const groups = [...page.matchAll(/data-ws-week-group="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ['new', 'votes', 'live', 'requests', 'worked']);
  for (const t of ['New since your last visit', 'Waiting for votes', 'Went live', 'New requests', 'Being worked on']) {
    assert.ok(page.includes(`>${t}</span>`), t);
  }
  assert.ok(!/data-ws-since-seen|dev-ws-since-nest|data-ws-since-week-more/.test(page), 'the nested folds are gone');
  const { weekGroups } = loadTsx('frontend/src/features/dev-board/workshop/week-pages.tsx');
  assert.deepEqual(weekGroups({ ...live, fresh: [], seen: [row('seen:r', { stage: 'vote' })] }).map((g) => g.key), ['requests'],
    'a request waiting on a change is the week\'s request, not a second vote');

  // THE FIGURES ARE NOT CARDS EITHER: hairlines between them, and nothing else.
  const dashRule = CSS.slice(CSS.indexOf('.dev-ws-dash-cell {'));
  const dashBody = dashRule.slice(0, dashRule.indexOf('}'));
  assert.ok(!/box-shadow/.test(dashBody), 'the figures are not cards');
  assert.match(dashBody, /border-left: 1px solid var\(--app-sheet-line\);/, 'a rule between them');
  // FOUR ACROSS AT EVERY WIDTH (5 Oct 2026): one row on an iPhone 13 mini,
  // not the 2x2 grid it was under 420px. A phone draws them closer and a
  // size smaller instead, and a label wraps rather than being cut short.
  assert.match(CSS, /\.dev-ws-dash \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.ok(!/\.dev-ws-dash \{[^}]*repeat\(2,/.test(CSS), 'no two-up grid on a phone');
  assert.ok(!/\.dev-ws-dash-cell:nth-child/.test(CSS), 'and no second row to rule off');
  assert.match(dashBody, /padding: 2px 8px;/, 'closer on a phone');
  assert.match(CSS, /@media \(min-width: 420px\) \{\n\s*\.dev-ws-dash-cell \{ padding-left: 14px; padding-right: 14px; \}\n\}/,
    'the wider spacing from 420px');
  assert.match(CSS, /\.dev-ws-dash-cell:first-child \{ border-left: 0; padding-left: 2px; \}/);
  assert.match(CSS, /\.dev-ws-dash-cell:last-child \{ padding-right: 2px; \}/);
  assert.match(CSS, /\.dev-ws-dash-cell b \{[^}]*font-size: 20px;/, 'a size smaller on a phone');
  assert.match(CSS, /@media \(min-width: 420px\) \{\n\s*\.dev-ws-dash-cell b \{ font-size: 24px; \}\n\}/,
    'and the full size from 420px');
  assert.ok(!/text-overflow|white-space: nowrap/.test(dashBody), 'a label wraps; it is never cut short');
  // An exclusive end is captioned with the Sunday before it.
  assert.match(read('frontend/src/features/dev-board/workshop/week-pages.tsx'), /endMs - 86400000/);
});

test('an empty window is no week at all', async () => {
  // An empty string is how the server says the window held nothing, and a
  // week saying "nothing landed" is worse than none: the same space to say less.
  const AppView = await loadWith(responseBody({
    digestCards: { lastWeek: 'Kubernetes deploys and staging previews.', thisWeek: '', open: '' },
  }));
  assert.deepEqual(plain(AppView._workshopView().dashboard.weeks.map((w) => w.key)), ['lastWeek'],
    'no window for a week with nothing in it');
  const html = workshopHtml(AppView, 'workshop');
  assert.match(html, /data-ws-week="lastWeek"/);
  assert.ok(!html.includes('data-ws-week="thisWeek"'), 'and none is drawn');
  assert.ok(!html.includes('class="dev-ws-open-line"'), 'and no lead line for an empty one');
  assert.ok(!html.includes('open items across'), 'and still no derived sentence');

  // All three empty is not a card set at all, and a first visit then has no
  // weeks and no since list to draw.
  const none = await loadWith(responseBody({ digestCards: { lastWeek: '', thisWeek: '', open: '' } }));
  assert.equal(none._workshopThemes.digestCards, null);
  assert.ok(!workshopHtml(none, 'workshop').includes('data-ws-week='));
  assert.match(workshopHtml(none, 'workshop'), /3 open items across 1 category\./, 'the derived sentence is back');
});

test('a row written before the cards still says its paragraph', async () => {
  // The rolling-deploy state: `digest` alone has to keep working. Paragraph
  // over derived sentence, cards over paragraph.
  const AppView = await loadWith(responseBody({
    digest: 'In the last week, alice finished the sign-in work. Bob is on the mail templates now.',
  }));
  const html = workshopHtml(AppView, 'workshop');
  assert.ok(!html.includes('data-ws-week='), 'no weeks to walk');
  assert.match(html, /class="dev-ws-open-line"[^>]*>[^<]*alice finished the sign-in work/);
  assert.ok(!html.includes('data-ws-digest-note'), 'no caption on the ordinary case');

  // And when a row has both, the cards win.
  const both = await loadWith(responseBody({
    digest: 'The flattened paragraph.',
    digestCards: { lastWeek: 'The last-week line.', thisWeek: '', open: '' },
  }));
  const bothHtml = workshopHtml(both, 'workshop');
  assert.ok(!bothHtml.includes('The flattened paragraph.'), 'the prose form is not drawn beside them');
  assert.ok(!bothHtml.includes('data-ws-digest-note'), 'and no provenance caption');
  assert.match(bothHtml, /The last-week line\./, 'the week carries it');
});

test('a malformed digestCards is no cards, not a broken pane', async () => {
  // Everything the server sends is normalised field by field here, and this
  // is the reason: a shape the renderer did not expect must degrade to the
  // paragraph, never throw inside the pane.
  for (const bad of ['a string', 42, [], { lastWeek: 7 }, { nope: 'x' }]) {
    const AppView = await loadWith(responseBody({ digestCards: bad, digest: 'The paragraph.' }));
    assert.equal(AppView._workshopThemes.digestCards, null, `${JSON.stringify(bad)} is not a card set`);
    assert.match(workshopHtml(AppView, 'workshop'), /The paragraph\./);
  }
});

test('themes all start collapsed, and a deep link is what opens one', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13'] }]);
  // The first theme used to open itself. A lander whose every theme is shut
  // IS a list of headings, and a list of headings is what this screen is for.
  const shut = workshopHtml(AppView, 'all');
  assert.match(shut, /data-ws-theme="t"/);
  assert.ok(!shut.includes('dev-ws-theme-body'), 'nothing is opened for you');
  assert.ok(!shut.includes('dev-ws-theme-open'));

  // Which means the lanes are only reachable by tapping — so there is a URL
  // that reaches them, and the declared check for them rides it.
  AppView._workshopShot = 'themes';
  const open = workshopHtml(AppView, 'all');
  assert.match(open, /dev-ws-theme dev-ws-theme-open/);
  assert.match(open, /data-ws-lane="open"[\s\S]{0,400}?class="dev-ws-wrow dev-ws-brow"/);
  assert.ok(!open.includes('dev-feed-entry'), 'the theme only, its items the board\u2019s rows: nothing unfolds in place (#4486)');
  const check = dapp.tests.find((t) => /dev-ws-theme-body/.test(t.expectSelector || ''));
  assert.match(check.path, /shot=themes/);
});

test('since-your-last-visit sits with the other things addressed to you', () => {
  const store = {};
  store['workshopSeen:demo-app'] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const html = workshopHtml(AppView, 'workshop');
  // Its own section on the Workshop page, under your work: what you are
  // doing, then what everybody else did. The hub says it in a sentence.
  assert.ok(html.indexOf('data-ws-dashboard') < html.indexOf('data-ws-since=""'), 'its own section, under the board');
  assert.ok(!workshopHtml(AppView).includes('data-ws-since=""'), 'and not on the hub any more');
  assert.ok(html.indexOf('data-ws-mine=""') < html.indexOf('data-ws-since=""'));
  // #4457: SHOWN, as rows: the heading, its
  // count, Clear, a sentence, then the same rows Your work draws.
  assert.match(html, /<section class="dev-ws-strip" data-ws-since=""><div class="dev-ws-head" data-ws-since-head=""><span class="dev-ws-head-title">Since your last visit<\/span><span class="dev-ws-head-n">\d+<\/span><button type="button" class="dev-ws-since-clear un-touch-target" data-ws-since-clear="">Clear<\/button><\/div>/);
  assert.match(html, /<p class="dev-ws-since-sum" data-ws-since-sum="">[^<]+\.<\/p><div class="dev-ws-wlist">/);
  assert.ok((html.match(/data-ws-row="since:/g) || []).length >= 1, 'the rows are out');
  assert.ok(!/data-ws-since-week|data-ws-since-seen|data-ws-since-more-new/.test(html), 'no weeks and no folds inside it');
  assert.ok(!html.includes('data-ws-since-btn'), 'the disclosure is gone');
  assert.ok(!/\.dev-ws-since-row/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')), 'the pressable row rule went with it');
  // Nothing new is ONE line. Clear moves the line to now.
  assert.match(WORKSHOP, /<p className="dev-ws-none" data-ws-since-none="">Nothing new since you were last here\.<\/p>/);
  assert.match(WORKSHOP, /callAppView\('_workshopClearSince', slug, v\.since\.through\)/);
  // Own ongoing work is not repeated; its merged outcomes are retained.
  // #4538: nor is a bot change built from the viewer's request, while Your
  // work is showing it.
  assert.match(WORKSHOP, /!\(r\.brief\.mine \|\| r\.brief\.requested\) \|\| r\.brief\.stage === 'live'/);
  // The reveals keep their own shape.
  assert.match(CSS, /\.dev-ws-reveal-start \{[^}]*justify-content: flex-start;/);
  assert.match(CSS, /\.dev-ws-reveal \{[^}]*justify-content: center;/);
});

test('#4505: catch-up retains your recently merged contributions, not your ongoing work', () => {
  const store = { 'workshopSeen:demo-app': String(Date.now() - 3.5 * 86400000) };
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  AppView._merged = [
    { ...AppView._merged[0], username: 'me', pr_title: 'My recent live contribution', live_at: at(1) },
    { ...AppView._merged[0], id: 79, pr_number: 42, username: 'me', pr_title: 'My merge going live', live_at: null },
    { ...AppView._merged[0], id: 80, pr_number: 43, username: 'me', pr_title: 'My older contribution', merged_at: at(8), last_message_at: at(8) },
  ];
  AppView._mySessions = [{ id: 81, status: 'active', username: 'me', session_title: 'My ongoing contribution', created_at: at(1), last_activity_at: at(1) }];
  const html = workshopHtml(AppView, 'workshop');
  const since = html.split('data-ws-since=""')[1].split('data-ws-weeks=""')[0];
  assert.match(since, /My recent live contribution/);
  assert.match(since, /My merge going live/);
  assert.ok(!since.includes('My older contribution'), 'old merges stay in their week');
  assert.ok(!since.includes('My ongoing contribution'), 'ongoing work stays in Your work');
  assert.match(html.split('data-ws-mine=""')[1].split('data-ws-since=""')[0], /My ongoing contribution/);
  assert.match(since, /1 change waiting for your vote, 2 changes live/);
  assert.match(since, /dev-ws-head-n">4<\/span>/, 'heading counts both merges, request and vote');
  AppView._workshopClearSince('demo-app', AppView._workshopView().since.through);
  const cleared = workshopHtml(AppView, 'workshop').split('data-ws-since=""')[1].split('data-ws-weeks=""')[0];
  assert.match(cleared, /Nothing new since you were last here/);
  assert.ok(!cleared.includes('My recent live contribution'));
});

test('#4457: the sentence over Since your last visit counts the rows under it', () => {
  const { sinceSentence } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  const r = (kind, stage, ask) => ({ brief: { kind, stage, vote: ask == null ? null : { ask } } });
  assert.equal(sinceSentence([r('request', 'request'), r('change', 'vote', true), r('live', 'live')]),
    '1 new request, 1 change waiting for your vote, 1 change live.');
  assert.equal(sinceSentence([r('change', 'vote', false), r('change', 'vote', false), r('change', 'worked')]),
    '2 changes up for a vote, 1 change being made.');
  assert.equal(sinceSentence([]), '');
});

test('the vote deck is its own tab; the unclaimed suggestion stays with the status', () => {
  const AppView = makeAppView();
  seed(AppView);
  const html = workshopHtml(AppView);
  // Voting is a SCREEN now. A decision deserves the whole of one and nothing
  // else competing for the tap; as one lane of three it read as one errand
  // among several. What is left in this strip is the thing that is not a
  // decision — an issue nobody has claimed.
  assert.ok(!html.includes('data-ws-votes'), 'the vote lane is gone from the status tab');
  assert.ok(!html.includes('data-ws-lane="next"'), 'and so is the free-to-take lane');
  assert.ok(!html.includes('data-ws-needs'), 'the deck is not drawn here either');
  // Both are QUESTIONS, so both are the Needs-you queue: the proposals owed
  // a vote first, the unclaimed issues behind them.
  const q = AppView._workshopView().queue;
  assert.deepEqual(plain(q.map((r) => r.kind)), ['vote', 'claim', 'claim']);
  // The claim question INVITES rather than interrogates: "Do you want to pick
  // this up?" reads as a duty being assigned, and the thing on offer is a
  // try, not a commitment.
  assert.deepEqual(plain(q.map((r) => r.ask)),
    ['Should this change go in?', 'Want to give this one a try?', 'Want to give this one a try?']);
  // And a claim carries ONE positive answer, not a pair. "No" and "Skip" were
  // the same press wearing two labels — neither recorded anything, both moved
  // the deck on — so the row no longer offers a `no` at all.
  assert.deepEqual(plain(q.filter((r) => r.kind === 'claim').map((r) => r.no)), [null, null]);
  assert.deepEqual(plain(q.filter((r) => r.kind === 'claim').map((r) => r.yes && r.yes.label)),
    ["Let's take it", "Let's take it"]);
  // The heading states the fact; the offer is the line under it. "Why not
  // give it a try?" did both at once and coaxed while it did.
  assert.ok(!html.includes('Free to take, if you want to try solving an issue.'),
    'the lane and its offer line went with it');
  // The declared check walks to a vote button; it rides the Needs-you tab
  // now, which `?ws=needs` reaches.
  const needs = workshopHtml(AppView, 'needs');
  assert.match(needs, /data-ws-needs=""[\s\S]*?data-ws-rail-btn="vote"/);
});

test('a quiet theme is not told it has never been built in', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12', 'issue:13', 'session:78'] }]);
  const html = workshopHtml(AppView, 'all');
  // "nobody building yet" said something the data cannot know: the condition
  // is only that nothing is in flight RIGHT NOW, so a theme that shipped a
  // dozen changes read identically to one nobody has ever touched.
  assert.ok(!html.includes('nobody building yet'));
  assert.match(html, /1 went live this week, nothing in progress now/);

  // …and with nothing shipped either, it says only what it knows.
  AppView._merged = [];
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  assert.match(workshopHtml(AppView, 'all'), /1 involved · nothing in flight right now/);
});

// ── the stylesheet has to PARSE, not merely contain the right text ───

test('no comment in app.css closes early, and no rule has prose for a selector', () => {
  // #1793 shipped an open-state block whose comment carried a second
  // terminator. The comment closed four lines early, the prose that followed
  // became a qualified rule's prelude — and a prelude runs to the first brace,
  // so it swallowed the three rules under it as one invalid selector and the
  // browser dropped all of them. The open row kept its four corners and the
  // entry kept its own frosted ring: the two boxes the block was written to
  // remove, shipped as the fix for them.
  //
  // Every other CSS assertion in this file is a regex over the TEXT, so they
  // all matched while the browser was discarding the rules. These two look at
  // the structure instead.
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(!stripped.includes('*/'),
    'a comment terminator outside a comment means an earlier comment closed before it meant to');

  const bad = [];
  let depth = 0;
  let buf = '';
  for (const ch of stripped) {
    if (ch === '{') {
      if (depth === 0 && /[`—]/.test(buf)) bad.push(buf.trim().replace(/\s+/g, ' ').slice(0, 70));
      depth += 1;
      buf = '';
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      buf = '';
    } else if (depth === 0) {
      buf += ch;
    }
  }
  // A backtick or an em dash is prose. Neither can appear in a CSS selector,
  // and both are everywhere in this file's comments — so one in a prelude is
  // a comment that leaked into the cascade.
  assert.deepEqual(bad, [], 'these selectors are prose, so the rules under them are being dropped');
});

// ── #1787: the dashboard, and the one thing to pick up ───────────────

test('the dashboard reads a rate, not just a count, and says when it is a floor', () => {
  const AppView = makeAppView();
  seed(AppView);
  // #2176: the weeks are calendar weeks (Monday 00:00 UTC), so the fixtures
  // sit relative to this week's Monday rather than to today.
  const monday = AppView._weekStart(Date.now());
  const iso = (ms) => new Date(ms).toISOString();
  AppView._merged = [
    { id: 78, pr_number: 40, pr_title: 'This week', status: 'merged', username: 'alice', merged_at: iso(monday + 3600000), created_at: iso(monday + 3600000), row_type: 'pr' },
    { id: 79, pr_number: 39, pr_title: 'Also this week', status: 'merged', username: 'bob', merged_at: iso(monday + 7200000), created_at: iso(monday + 7200000), row_type: 'pr' },
    { id: 80, pr_number: 38, pr_title: 'Last week', status: 'merged', username: 'bob', merged_at: iso(monday - 3 * 86400000), created_at: iso(monday - 3 * 86400000), row_type: 'pr' },
  ];
  const d = AppView._workshopView().dashboard;
  assert.equal(d.shippedWeek, 2);
  assert.equal(d.shippedPrevWeek, 1, 'the week before, from the same source, so the two compare');
  assert.equal(d.partial, false);

  // The merged history is paged. With more behind it the counts are floors,
  // and the view has to say so rather than reporting a page as the record.
  AppView._mergedHasMore = true;
  assert.equal(AppView._workshopView().dashboard.partial, true);
});

test('#1922: the server\'s whole-history week counts replace the page count and its "+"', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  // A full page with more behind it — the case that used to read "20+".
  AppView._mergedHasMore = true;
  AppView._mergedShipped = { week: 34, prevWeek: 27 };
  const d = AppView._workshopView().dashboard;
  assert.equal(d.shippedWeek, 34, 'the real number, not what the page holds');
  assert.equal(d.shippedPrevWeek, 27, 'the week before, from the same count');
  assert.equal(d.partial, false, 'an exact count is never a floor');
  const html = workshopHtml(AppView, 'workshop');
  assert.match(html, /data-ws-dash-cell="shipped"[^>]*><b>34<\/b>/, 'no "+" on the tile');
  assert.ok(!html.includes('title="At least this many'), 'and no floor tooltip');

  // An older server sends no counts: the page is counted and flagged, as before.
  AppView._mergedShipped = null;
  const fallback = AppView._workshopView().dashboard;
  assert.equal(fallback.partial, true);
  assert.notEqual(fallback.shippedWeek, 34);
});

test('#1922: the loader keeps the server\'s week counts, and only well-formed ones', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public/js/app-view.js'), 'utf8');
  assert.match(src, /const shipped = mergedData\.shipped;\s*AppView\._mergedShipped = shipped\s*&& Number\.isFinite\(shipped\.week\) && Number\.isFinite\(shipped\.prevWeek\)/);
  assert.match(src, /partial: !serverShipped && !!AppView\._mergedHasMore,/);
});

// ── #2573: the prompt to start on an app nobody has started ──────────
//
// Two facts make that state, and it takes BOTH: nothing open, and nothing
// ever landed. Each half alone is a different app — one that has finished
// everything, or one whose board is full of work nobody has picked up — and
// the banner is wrong on both.

/** A loaded board with nothing on it and nothing behind it. */
function seedUntouched(AppView) {
  AppView._ghIssues = [];
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._mySessions = [];
  AppView._sharedSessions = [];
  AppView._devDataReady = true;
}

const ONE_ISSUE = {
  number: 12, title: 'Dark mode resets', createdAt: at(2), updatedAt: at(1),
  lastMessageAt: at(1), user: 'alice', htmlUrl: 'https://github.com/x/y/issues/12',
};

test('#2573: "ever shipped" is the whole Done column, not this week\'s window', () => {
  const AppView = makeAppView();
  seedUntouched(AppView);
  assert.equal(AppView._workshopView().dashboard.everShipped, false);

  // THE CASE `shippedWeek` CANNOT ANSWER: a busy app having a quiet week.
  // Nothing merged inside either window, and the column is far from empty —
  // so a banner keyed on the week count would land on an app with thirty-one
  // changes behind it.
  AppView._mergedTotal = 31;
  const d = AppView._workshopView().dashboard;
  assert.equal(d.shippedWeek, 0, 'nothing landed in this week\'s window');
  assert.equal(d.everShipped, true, 'and the app has still shipped thirty-one things');
});

test('#2573: the status tab offers to start an app with nothing open and nothing shipped', () => {
  const AppView = makeAppView();
  seedUntouched(AppView);
  const html = workshopHtml(AppView);
  assert.match(html, /data-ws-start-here=""/, 'the banner is up');
  assert.match(html, /Start working on this app/, 'with the heading the request names');
  assert.match(html, /Nothing is open and nothing has shipped yet/, 'and one line saying why');
  assert.match(html, /data-ws-start-here-btn=""[^>]*>Start a new change</,
    'and the action, labelled as the Homeroom menu labels it');

  // AT THE TOP OF THE HUB, ahead of the no-items note and the hub's own
  // cards. The note answers what the board HOLDS and points at the ⋯;
  // this answers what to do about an app nobody has started.
  const order = ['data-ws-band', 'data-ws-start-here', 'data-ws-empty'].map((k) => html.indexOf(k));
  assert.ok(order.every((i) => i >= 0), `each is drawn: ${JSON.stringify(order)}`);
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'and the prompt leads, under the tabs');
  // The hub's own last line is the same action (#852), and stands down under
  // the banner that already leads with it.
  assert.ok(!html.includes('data-ws-start-change'), 'one Start a new change, not two');
});

test('#2573: the prompt stands down for an app with open work, or with a history', () => {
  const withOpen = makeAppView();
  seedUntouched(withOpen);
  withOpen._ghIssues = [ONE_ISSUE];
  assert.ok(!workshopHtml(withOpen).includes('data-ws-start-here'),
    'somebody has already started it: there is something open');

  const shipped = makeAppView();
  seedUntouched(shipped);
  shipped._mergedTotal = 4;
  assert.ok(!workshopHtml(shipped).includes('data-ws-start-here'),
    'an app with nothing left open but four changes behind it is finished, not unstarted');
});

test('#2573: a filter that hides everything is not an app nobody has started', () => {
  const AppView = makeAppView();
  seedUntouched(AppView);
  AppView._ghIssues = [ONE_ISSUE];
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'nothing matches this' };
  const v = AppView._workshopView();
  // #2915: the tiles counted what survived the filter, so this banner had to
  // wait for the filter to come off. The search is All items' alone now: the
  // tile counts the app, and the app has an open item.
  assert.equal(v.dashboard.open, 1, 'the tiles count the app, not what All items\' search kept');
  assert.equal(v.meta.filtered, true);
  assert.equal(v.themes.length, 0, 'while All items itself is narrowed to nothing');
  assert.ok(!workshopHtml(AppView).includes('data-ws-start-here'),
    'the prompt is a claim about the APP, and the app has something open');
});

test('#2915: an unstarted app gets the start-here prompt whatever All items is searched for', () => {
  const AppView = makeAppView();
  seedUntouched(AppView);
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'nothing matches this' };
  const html = workshopHtml(AppView, 'status');
  assert.match(html, /data-ws-start-here=""/, 'the search is on All items, not on this claim');
  assert.doesNotMatch(html, /Nothing here matches/, 'and the status tab blames no search for an empty board');
  const gate = WORKSHOP.slice(WORKSHOP.indexOf('const startHere = '), WORKSHOP.indexOf(';', WORKSHOP.indexOf('const startHere = ')));
  assert.ok(gate && !/filtered/.test(gate), 'the banner carries no filter condition');
});

test('#2573: the button is offered on the gate the Improve panel offers New change on', () => {
  const { improveStore } = devCardApi();
  const AppView = makeAppView();
  seedUntouched(AppView);
  const before = improveStore.get().readOnly;
  try {
    // The same field, on the same store instance, that the Improve panel
    // reads to decide whether to draw `#improve-row-new-session` at all.
    improveStore.set({ readOnly: true });
    const html = workshopHtml(AppView);
    assert.match(html, /data-ws-start-here=""/,
      'a read-only viewer is still told what state the app is in');
    assert.ok(!html.includes('data-ws-start-here-btn'),
      'but is not offered a change they could not start from the menu either');
  } finally {
    improveStore.set({ readOnly: before });
  }
  assert.match(workshopHtml(AppView), /data-ws-start-here-btn=""/,
    'and a collaborator gets it back');
});

// The entry point is BORROWED, not rebuilt: two copies of "navigate to the
// app, then create a proposal" is the duplication this reuses away.
test('#2573: the banner presses the same Start a new change the menu does', () => {
  assert.match(WORKSHOP, /import \{ Improve \} from '\.\.\/\.\.\/improve\/improve-controller\.js'/);
  assert.match(WORKSHOP, /onClick=\{\(\) => Improve\.startSession\(\)\}/);
  // The other one was the Improve panel's row, then the mark menu's button;
  // since the UI overhaul it is "Start a new change" under the menu's Agent
  // sessions. Same method, which is the whole point of asserting both: two
  // controls saying "start a new change" have to mean it.
  assert.match(SHEET_TSX, /id="improve-row-new-session"[\s\S]*?onClick=\{\(\) => Improve\.startSession\(\)\}/,
    'which is the method the menu\'s row calls');
});

test('"try taking this one next" names an open issue nobody is on', () => {
  const AppView = makeAppView();
  seed(AppView);
  // Issue 12 is the more recent of the two, so it is the one offered.
  assert.equal(AppView._workshopView().nextUp.key, 'next:issue:12');
  assert.equal(AppView._workshopView().dashboard.unclaimed, 2);

  // A live claim, a running session or an assignee all take it out.
  AppView._ghIssues[0].in_progress = { claims: [{ username: 'dana' }] };
  assert.equal(AppView._workshopView().nextUp.key, 'next:issue:13', 'the claimed one is skipped');
  AppView._ghIssues[1].assignee = { top: 'erin' };
  assert.equal(AppView._workshopView().nextUp, null);
  assert.equal(AppView._workshopView().dashboard.unclaimed, 0);
});

test('#1934: the rest of the unclaimed issues are the rest of the deck', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12', 'issue:13'] }]);
  const v = AppView._workshopView();
  // Two unclaimed issues: 12 is offered, 13 is the "more".
  assert.equal(v.nextUp.key, 'next:issue:12');
  // Joined: the arrays come from the AppView sandbox's own realm.
  assert.equal(v.nextMore.map((r) => r.key).join(','), 'next:issue:13', 'same order, same next: keys');
  // #1934's "Show N more" list became a sideways deck, and then the whole
  // lane moved: an unclaimed issue asks "will you take this?", which is the
  // same shape of question as "should this go in?", so both are the
  // Needs-you queue with the issues behind the proposals.
  assert.ok(!workshopHtml(AppView).includes('data-ws-lane="next"'),
    'nothing on the status tab any more');
  assert.deepEqual(plain(v.queue.filter((r) => r.kind === 'claim').map((r) => r.key)),
    ['need:issue:12', 'need:issue:13'], 'same order, behind the votes');
  // The feed draws EVERY item (the fillers and the deep links need the rows
  // in the DOM), votes first. The question itself is on the Vote sheet,
  // which opens on a press; at rest an item says what kind of thing it is.
  const needs = workshopHtml(AppView, 'needs');
  assert.match(needs, /data-ws-item="vote:[^"]+" data-ws-kind="vote"[\s\S]*?Change · Waiting for your approval/, 'the first item is a vote');
  assert.match(needs, /data-ws-kind="claim"[\s\S]*?>Request</, 'the claims follow');
  assert.ok(!needs.includes('data-ws-ask-q'), 'the question is on the sheet, not on the item');
  assert.ok(!needs.includes('data-ws-next-more'), 'the vertical reveal is long retired');

  // Capped like a theme lane.
  assert.match(require('fs').readFileSync(require('path').join(__dirname, '..', 'public/js/app-view.js'), 'utf8'),
    /idle\.slice\(1, 1 \+ AppView\.WORKSHOP_LANE_MAX\)/);

  // One unclaimed issue → one claim question in the queue.
  AppView._ghIssues[1].assignee = { top: 'erin' };
  const one = AppView._workshopView();
  assert.equal(one.nextMore.length, 0);
  assert.equal(one.queue.filter((r) => r.kind === 'claim').length, 1);
});

test('#1934: All items\' search leaves the "more" alone, and the claim questions with it (#2915)', () => {
  const AppView = makeAppView();
  seed(AppView);
  // "dark" keeps issue 12 on All items and hides issue 13. A filter used to
  // drop the "more" along with the suggestion, and the Needs-you claim rows
  // were built from the same narrowed list; both are off All items, so the
  // search that narrows it reaches neither now.
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'dark' };
  const v = AppView._workshopView();
  assert.equal(v.meta.filtered, true);
  assert.equal(v.nextMore.map((r) => r.key).join(','), 'next:issue:13', 'the issue the search hides is still next');
  assert.deepEqual(plain(v.queue.filter((r) => r.kind === 'claim').map((r) => r.key)),
    ['need:issue:12', 'need:issue:13'], 'and Needs you still asks about both');
});

test('an issue already being worked on is never the one offered', () => {
  const AppView = makeAppView();
  seed(AppView);
  // A promoted proposal against issue 12 moves it into the `underway` lane.
  // It carries no claim and no assignee, so only the LANE rules it out — and
  // offering it would name a card the viewer can see being built two strips
  // further down the same page.
  AppView._proposals[0].linked_issues = ['12'];
  const v = AppView._workshopView();
  assert.equal(v.nextUp.key, 'next:issue:13', 'the quiet one, not the busy one');
  assert.equal(v.dashboard.unclaimed, 1);
});

test('the suggestion does not follow All items\' search to the other tabs (#2915)', () => {
  const AppView = makeAppView();
  seed(AppView);
  // It stood down while a filter was active, on the reasoning that a
  // narrowed board is somebody looking for something specific. The search
  // narrows All items alone now, so the suggestion is the app's, whatever
  // that tab is narrowed to — here, the very issue the search hides.
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'keyboard' };
  const v = AppView._workshopView();
  assert.equal(v.meta.filtered, true);
  assert.equal(v.nextUp.key, 'next:issue:12');
  const all = v.themes.flatMap((t) => t.lanes.flatMap((l) => l.rows.map((r) => r.key)));
  assert.ok(!all.includes('issue:12'), 'while All items, which the search does narrow, hides it');
});

test('the hub is ordered for a returning member: the tabs, then what is owed; the Workshop page is your work, All items, then what changed', () => {
  const store = {};
  // Keep the three-day-old proposal strictly after the last visit instead
  // of relying on whether seed() happens in a later clock millisecond.
  store[`${'workshopSeen'}:demo-app`] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const html = workshopHtml(AppView);
  // THE HUB (#852): the tabs, then (after the hero and the summary card,
  // which wait on their own reads, none in this render) the votes you owe as
  // one row, and your work when you have some. Start a new change is the
  // hero's ⋯ now (#852 review). The since list, your work in full and the
  // board are the Workshop page's.
  const order = ['data-ws-band', 'data-ws-hub-needs'].map((k) => html.indexOf(k));
  assert.ok(order.every((i) => i >= 0), `each is drawn: ${JSON.stringify(order)}`);
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'the tabs, then what is owed');
  assert.ok(!html.includes('data-ws-start-change'), 'no Start a new change at the foot');
  assert.ok(!html.includes('data-ws-workshop-door'), 'no door to the Workshop: it opens from the summary card');
  assert.ok(!html.includes('data-ws-since=""') && !html.includes('data-ws-mine=""') && !html.includes('data-ws-dashboard'),
    'the since list, your work in full and the board are the Workshop page\'s');
  const workshop = workshopHtml(AppView, 'workshop');
  const wsOrder = ['data-ws-dashboard', 'data-ws-mine=""', 'data-ws-since-head'].map((k) => workshop.indexOf(k));
  assert.ok(wsOrder.every((i) => i >= 0), `every section is drawn: ${JSON.stringify(wsOrder)}`);
  assert.deepEqual(wsOrder.slice().sort((a, b) => a - b), wsOrder,
    'the Workshop page: All items, your work, then what changed (5 Oct 2026)');
  assert.ok(!html.includes('data-ws-discussion'), 'and the old discussion section is gone');
  assert.ok(!html.includes('data-discussion-row'), 'nor its row');
  assert.ok(!/class="dev-ws-link"[^>]*aria-expanded/.test(workshop), 'no unsized text link toggles this pane');
  assert.match(workshop, /class="dev-ws-head" data-ws-since-head=""><span class="dev-ws-head-title">Since your last visit<\/span><span class="dev-ws-head-n">\d+</,
    'the since block is a pane with a heading and its count, not a disclosure');
  assert.equal(AppView._workshopView().since.total, 3, 'the view model still counts the whole population');
  assert.ok(!workshop.includes('waiting on votes ·'), 'and the bare number line is gone');
});

// ── #1787: the row is the card, folded ───────────────────────────────

test('a lane row\'s last line carries the card\'s state, in the tone the pill already had, with the vote at its right', () => {
  const AppView = makeAppView();
  seed(AppView);
  // #1442's case: green checks on a proposal that no longer merges. The one
  // fact that decides whether it can land at all.
  AppView._proposals[0].mergeability = 'conflict';
  AppView._proposals[0].mergeability_files = ['src/a.js', 'src/b.js'];
  // The lanes draw the board's rows (#4486), and a theme ships shut —
  // `?shot=themes` is the URL that opens the first one, which is what the
  // declared check for the lanes rides.
  AppView._workshopShot = 'themes';
  const html = workshopHtml(AppView, 'all');

  assert.match(html, /<span class="dev-ws-row-band">/,
    'the row has a last line of its own: the card\'s status row and facts row in one');
  // The row's state line is the BAR, and the bar is the vote. The fact that
  // decides whether it can land at all rides beside it as a red tag — which
  // the row already had a seat for, because RowBand draws the card's state
  // chips after the pill at both sizes.
  assert.match(html, /class="dev-ws-row-state dev-ws-row-state-progress"[^>]*>Vote · \d+\/\d+</,
    'the state line carries the vote, in the vote\u2019s tone');
  // The blocker is a tag on the row's tags line (#4486: the brief's words for
  // the card's status tags) — not on the band. The band is the vote and the
  // Vote button.
  // #2222: amber. A predicted conflict the platform resolves by itself is not
  // the reader's move, so it reads as worth knowing, not as a failure.
  assert.match(html, /<span class="dev-ws-tag" data-tone="warn"[^>]*>Conflicts with main · 2 files<\/span>/);
  assert.ok(html.indexOf('Conflicts with main') < html.indexOf('dev-ws-row-band'),
    'the tag is above the band, on the meta line');
  assert.ok(!html.includes('dev-ws-row-pill'),
    'it is no longer flattened to plain text in the grey the author\'s name wears');

  // The line is clipped to one for the same reason the dense card's rows are:
  // a row that grew with its state would break the column's rhythm. The vote
  // button sits at its right end, where the card's bar puts it.
  assert.match(CSS, /\.dev-ws-row-band \{[^}]*flex-wrap: nowrap;[^}]*overflow: hidden;/);
  assert.match(CSS, /\.dev-ws-row-band > \.dev-ws-row-trailing \{ margin-left: auto; \}/);
  assert.match(html, /<span class="dev-ws-row-band">[\s\S]*?<span class="dev-ws-row-trailing"><button [^>]*class="dev-vote-btn"/,
    'the vote rides the last line, not the row\'s middle-right');
  // It does NOT stand down when the row opens any more — see the open-state
  // test below. The head is identical in both sizes, and the duplicate is the
  // card's band, not this one.
  assert.ok(!/\.dev-ws-row-open \.dev-ws-row-band \{ display: none/.test(CSS));
});

test('an open row IS the Board\'s card, not a headless copy under a row', () => {
  const unfolded = FOLD.slice(FOLD.indexOf('function UnfoldedRow'), FOLD.indexOf('function voteSpecs'));
  assert.match(unfolded, /<DevCard model=\{card\} actionEnd=\{placement \? openBtn : undefined\} headEnd=\{<FoldMark open onClick=\{onFold\} \/>\} \/>/);

  // #1799 kept the compressed row as a head and hid the card's head, meta and
  // status band so they would not repeat it — which made the open state a
  // third object belonging to neither size. Those rules are GONE, and the card
  // keeps every bit of chrome the Board gives it.
  assert.ok(!/\.dev-ws-rowwrap-open[^{]*\.dev-card-head/.test(CSS), 'the head is drawn');
  assert.ok(!/\.dev-ws-rowwrap-open[^{]*\.dev-card-meta/.test(CSS), 'the meta line is drawn');
  assert.ok(!/\.dev-ws-rowwrap-open[^{]*\.dev-card-status/.test(CSS), 'the status band is drawn');
  assert.ok(!/dev-ws-rowwrap-open > \.dev-feed-entry > div:is\(\.dev-card-dense\)/.test(CSS),
    'and the card is not de-chromed');

  // The wrapper renders ONE of the two, never both.
  const wrap = FOLD.slice(FOLD.indexOf('function CardRowView'));
  assert.match(wrap, /\{open \? \(/);
  assert.match(wrap, /<UnfoldedRow row=\{row\}/);
  assert.match(wrap, /<FoldedRow row=\{row\}/);
  assert.ok(wrap.indexOf('<UnfoldedRow') < wrap.indexOf('<FoldedRow'), 'open first, folded in the else');

  // Clicking the open card closes it. The delegated #dev-body handler is
  // bound BELOW the portal's React root, so a synthetic stopPropagation here
  // would arrive after it had navigated; the hooks used to come off the open
  // card's model for that reason. The handler now stands aside for any click
  // inside a fold wrapper instead, so the model keeps the hooks the checks
  // select on, at BOTH sizes, and the Board's columns can fold the same way.
  assert.match(APP_VIEW_SRC, /if \(AppView\._inFoldWrapper\(e\)\) return;/);
  assert.ok(!/function withoutOpenHooks/.test(FOLD) && !/withoutOpenHooks/.test(WORKSHOP), 'nothing strips them any more');
  assert.match(FOLD, /\{\.\.\.itemHooks\(c\)\}/, 'the folded row carries the item\u2019s hooks too');
  assert.ok(!/onCollapse/.test(FOLD), 'and there is no Collapse control');
});

test('a theme head counts its people AND how much is still open in it', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13', 'session:34', 'session:78'] }]);
  const html = workshopHtml(AppView, 'all');
  // Two issues open + one proposal in review = 3. The merge is NOT counted:
  // the number answers "how much is left in here", and shipped work is not.
  assert.match(
    html,
    /<span class="dev-ws-stat"><b>\d+<\/b>(?:person|people)<\/span><span class="dev-ws-stat"><b>3<\/b>items<\/span>/,
    'people and items, side by side',
  );
  assert.match(CSS, /\.dev-ws-stat \+ \.dev-ws-stat \{[^}]*border-left:/, 'divided by a hairline');
});

test('a theme wears the glyph the model chose, or its initial when there is none', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Game Corner', icon: '🎮', items: ['issue:12'] }]);
  assert.match(workshopHtml(AppView, 'all'), /<span class="dev-ws-theme-icon" aria-hidden="true">🎮<\/span>Game Corner/);

  // A row written before icons existed, or an answer the sanitiser rejected:
  // the initial on the name's own swatch, which reads as chosen where a
  // hashed-from-the-name emoji would be stable and meaningless.
  AppView._workshopThemes = themes([{ id: 't', name: 'Game Corner', items: ['issue:12'] }]);
  assert.match(
    workshopHtml(AppView, 'all'),
    /class="dev-ws-theme-icon dev-ws-theme-icon-letter"[^>]*>G<\/span>Game Corner/,
  );
});

test('"Shipped this week" opens folded, so a theme opens on what still needs someone', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13', 'session:34', 'session:78'] }]);
  // Every theme starts shut, so the lanes are only on the page behind the
  // deep link that opens one. It names a theme and no row, which is exactly
  // the state this is about.
  AppView._workshopShot = 'themes';
  const html = workshopHtml(AppView, 'all');
  assert.match(html, /data-ws-lane="shipped"/, 'the lane is still drawn — the fold is not a removal');
  assert.match(html, /<h4 class="dev-ws-lane-title" role="button" tabindex="0" aria-expanded="false">/,
    'and it is a disclosure, closed');
  assert.ok(!html.includes('Landed thing'),
    'the merge it holds is not in the DOM until someone opens the lane');
  assert.match(html, /<span class="dev-ws-lane-n">1<\/span>/,
    'but the count rides in the heading, so the fold never hides how much is in there');
  // Every other lane is unaffected.
  assert.match(html, /data-ws-lane="open"[\s\S]{0,400}?class="dev-ws-wrow dev-ws-brow"/);
});

// ── #1787: a filter changed ON THE WORKSHOP has to stick ─────────────
//
// Both halves of a filter change — persist it, and tell the bar what it now
// says — used to sit inside `_repaintKanbanBoard`, which the Workshop never
// reaches. So on this surface a filter was a scratch value: nothing saved it,
// the next `_repaintDevBody` reloaded the stored set over it, and the chip row
// never moved, so a chip's × widened the themes and stayed on screen.

test('a filter set on the Workshop is persisted, and clearing it is persisted too', () => {
  const store = {};
  const AppView = makeAppView({ sessionStore: store });
  seed(AppView);
  assert.equal(AppView._getViewMode(), 'workshop', 'the Workshop is the default surface');

  AppView._kanbanFilters.priority = 'high';
  AppView._repaintBoardSurface();
  assert.equal(AppView._loadKanbanFilters('demo-app').priority, 'high',
    'the Workshop path saves — _repaintKanbanBoard is not the only funnel');

  AppView._dismissKanbanFilter('priority');
  assert.equal(AppView._loadKanbanFilters('demo-app').priority, null,
    'and the clear is saved, so the next repaint cannot put it back');
});

test('the Workshop republishes the filter bar, so a chip\'s × actually clears the chip', () => {
  const AppView = makeAppView({
    document: {
      getElementById: (id) => (id === 'dev-kanban-filterbar' ? {} : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
  });
  seed(AppView);
  const published = [];
  AppView._publishKanbanFilters = (v) => published.push(plain(v));

  AppView._kanbanFilters.priority = 'high';
  AppView._repaintBoardSurface();
  assert.equal(published.length, 1, 'the Workshop tells the bar a filter went on');
  assert.equal(published[0].count, 1);

  AppView._dismissKanbanFilter('priority');
  assert.equal(published.length, 2);
  assert.equal(published[1].count, 0, 'and that it came back off');
  assert.deepEqual(published[1].chips, [], 'the chip row is emptied, not left showing a dead chip');
});

test('the Workshop restores the stored filters on an app switch, not on every repaint', () => {
  const AppView = makeAppView();
  // The slug the in-memory set belongs to is what tells a repaint apart from
  // an app switch. Unguarded, `_repaintDevBody` reloaded on every paint and
  // discarded whatever the viewer had just done here.
  assert.equal(AppView._kanbanFiltersSlug, null, 'nothing loaded yet');
  const branch = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('<div id="dev-workshop"></div>'));
  assert.match(branch.slice(0, branch.indexOf('_rerenderWorkshop();')),
    /if \(AppView\._kanbanFiltersSlug !== App\.currentApp\) \{\s*\n\s*AppView\._kanbanFilters = AppView\._loadKanbanFilters\(App\.currentApp\);/,
    'the reload is behind the slug guard');
});

test('the theme filter constrains sessions too, not just issues and proposals', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  const f = { ...AppView._defaultKanbanFilters(), theme: 't' };
  // A session sits in a theme by the issue it links, exactly as the Workshop
  // places it. It used to return `true` before the theme check ran at all, so
  // with a theme selected every session matched every theme and a theme's
  // Underway lane showed other themes' work.
  assert.equal(AppView._devCardMatches('session', { id: 90, linked_issues: ['12'] }, f), true);
  assert.equal(AppView._devCardMatches('session', { id: 91, linked_issues: ['13'] }, f), false);
  assert.equal(AppView._devCardMatches('session', { id: 92, linked_issues: [] }, f), false);
  // Priority and category stay a no-op there — a session carries neither.
  const byPriority = { ...AppView._defaultKanbanFilters(), priority: 'high' };
  assert.equal(AppView._devCardMatches('session', { id: 93, linked_issues: [] }, byPriority), true);
});

test('"Open on Board" narrows the board to the theme and goes there by hash', () => {
  const AppView = makeAppView({ location: { search: '', hash: '', href: 'http://localhost/' } });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  AppView.openBoardForTheme('t');
  assert.equal(AppView._kanbanFilters.theme, 't');
  assert.equal(AppView._loadKanbanFilters('demo-app').theme, null,
    'sessionStorage is stubbed empty here; the write is the module\'s _saveKanbanFilters');
});

// ── the component ────────────────────────────────────────────────────

test('the Workshop renders its strips, its themes and their rows', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'Looks.', saying: 'Dark mode should stick.', items: ['issue:12', 'session:34', 'session:78'] }]);
  // Themes start shut; `?shot=themes` is the URL that opens one with every
  // row in it still folded, which is what the lanes below are asserted on.
  AppView._workshopShot = 'themes';
  const html = workshopHtml(AppView, 'all');
  // The folded row is a row and not a card: the card's own Vote button sits
  // INSIDE it at the trailing edge, which is why the row is a div with the
  // button role and not a <button>. A proposal row lives in its theme's
  // review lane now that the vote strip is a tab of its own.
  assert.match(html, /<div class="dev-ws-wrow dev-ws-brow" data-ws-row="proposal:34"[\s\S]*?<span class="dev-ws-row-trailing"><button [^>]*class="dev-vote-btn"/,
    'a proposal row is the board\u2019s row (#4486) with the card\u2019s vote button on it');
  assert.ok(!/<button[^>]*>[^<]*<button/.test(html), 'and no button nests in a button');
  // "Open on Board" sits at the bottom of the theme, not under a lane.
  assert.match(html, /<div class="dev-ws-theme-more">[\s\S]*?Open on Board ›/);
  assert.ok(!/dev-ws-more[\s\S]{0,80}Open on Board/.test(html), 'no lane carries its own');
  // The dashboard and the discussion are the OTHER tab's; this one is the
  // board and only the board.
  assert.ok(!html.includes('data-ws-dashboard'), 'the dashboard is not on this tab');
  assert.ok(!html.includes('data-discussion-row'), 'nor the discussion row');
  assert.match(workshopHtml(AppView, 'workshop'), /data-ws-dashboard=""/, 'it is on the Workshop tab');
  assert.match(html, /data-ws-theme="t"/, 'the theme');
  assert.match(html, /Dark mode should stick\./, 'with its saying');
  // The deep link opens the first theme, and its rows are the board's rows
  // (#4486). Each carries the item's own hook — `data-issue-row` on an
  // issue's — so the lookups and the checks that name an item by it find the
  // row too; the delegated #dev-body handler stands aside inside a row
  // (AppView._inFoldWrapper), whose own link opens the item's page.
  assert.match(html, /<div class="dev-ws-wrow dev-ws-brow" data-ws-row="issue:12"/);
  assert.match(html, /<div class="dev-ws-wrow dev-ws-brow" data-ws-row="issue:12"[^>]*data-issue-row="12"/, 'the row carries the issue-row hook');
  assert.match(html, /data-ws-lane="review"/);
  assert.match(html, /data-ws-lane="shipped"/);
  assert.ok(!html.includes('dev-feed-entry'), 'nothing is unfolded on a plain paint');
  assert.match(html, /aria-pressed="true">By people</, 'the default order is by people');
});

test('a folded row wears the card\u2019s own edge, number and glyph, and no chevron', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'session:34'] }]);
  AppView._workshopShot = 'themes';
  const page = workshopHtml(AppView, 'all');
  // The fold lives on where it is still drawn, the hub's Your work (#4486:
  // By category and the board draw the Workshop's row); its rows drawn here
  // through the same fold, folded.
  const { ListRowView } = loadTsx('tests/fixtures/dev-card-api.ts');
  const html = AppView._workshopView().themes.flatMap((t) => t.lanes.flatMap((l) => l.rows))
    .filter((r) => r.t === 'card')
    .map((row) => renderToHtml(createElement(ListRowView, {
      row, fold: { slug: 'demo-app', canPost: true, open: false, onToggle: () => {} },
    }))).join('');

  // The EDGE, from the card's own edgeFor: an issue with no state wears its
  // type's amber, a proposal wears its BAR's tone. The row used to carry that
  // colour as a tinted icon tile the card does not have, so one item opened
  // on a different mark at each size.
  //
  // This proposal is mid-checks and used to wear `neutral`, because the bar
  // said "Checks starting…". The bar is the vote now, so the edge follows the
  // vote — which is the edge doing its job, not a regression: the colour down
  // the side of a row answers the same question the bar does.
  assert.match(html, /class="dev-ws-row[^"]*"[^>]*data-edge="attention"[^>]*data-ws-row="issue:12"/);
  assert.match(html, /class="dev-ws-row[^"]*"[^>]*data-edge="vote"[^>]*data-ws-row="proposal:34"/);
  assert.match(CSS, /\.dev-ws-row\[data-edge="vote"\]\s+\{ --dev-edge: var\(--accent\); \}/);
  assert.match(CSS, /\.dev-ws-row \{[^}]*inset var\(--dev-edge-w\) 0 0 color-mix/,
    'drawn as the card draws it: an inset shadow at the same width, not a border');

  // The NUMBER: the card's own meta line, node for node (metaLineNodes), so
  // the row's number is the same link the card's is, "PR#41" and "#12" alike.
  // (The row used to re-derive it and matched only "#41", so every proposal
  // row was missing the thing people cite it by.)
  assert.match(html, /<span class="dev-ws-row-meta"><a href="[^"]*" target="_blank" rel="noopener" class="font-mono[^"]*"[^>]*>PR#41<\/a>/);
  assert.match(html, /<span class="dev-ws-row-meta"><a href="[^"]*" target="_blank" rel="noopener" class="font-mono[^"]*"[^>]*>#12<\/a>/, 'and an issue is unchanged');
  assert.match(FOLD, /<span className="dev-ws-row-meta">\{metaLineNodes\(c\)\}<\/span>/, 'one builder for both sizes');
  assert.match(FOLD, /closest\('a, button'\)\) return;/, 'a click on the link is the link\'s, not the row\'s');

  // The GLYPH. Same 22px box, no tile, same 18px mark as the card's.
  assert.match(CSS, /\.dev-ws-row-head > \.dev-card-icon \{[^}]*width: 22px;[^}]*background: transparent/);
  assert.match(CSS, /\.dev-ws-row-head > \.dev-card-icon > svg \{ width: 18px; height: 18px; \}/);

  // And no chevron: it promises a destination the row does not have.
  const rows = html.split('data-ws-row="').slice(1);
  assert.ok(rows.length, 'there are folded rows to check');
  for (const r of rows) {
    assert.ok(!r.slice(0, r.indexOf('</div>')).includes('dev-ws-chev'), 'a folded row draws no chevron');
  }
  assert.match(page, /dev-ws-theme-foot[\s\S]*?dev-ws-chev/, 'a theme header still does');
});

test('the card\u2019s facts line keeps its chips instead of flattening them', () => {
  // "Closes #1575 · @alice · design" was drawn as muted text with a dot
  // between, so the two facts most worth not skipping on a proposal card
  // read as a byline. The Workshop's folded row kept them as chips, which
  // is the treatment that won.
  assert.ok(!/\.dev-card-status > \.dev-badge \{[^}]*background: transparent/.test(CSS),
    'the flattening is gone');
  assert.ok(!/\.dev-card-status > \.dev-badge \+ \.dev-badge::before/.test(CSS),
    'and so is the dot that stood in for the gap between pills');
  assert.match(CSS, /:is\(\.dev-card-status, \.dev-card-facts\) > \.dev-badge \{\s*height: 19px;/);
  // The facts are a row of their own under the status row now, clipped at
  // one line and tabbed in with the meta line; the one band with a break in
  // it, and the 60px it clipped at, are gone.
  assert.match(CSS, /\.dev-card-badges\.dev-card-facts \{[^}]*max-height: 22px;/);
  assert.match(CSS, /\.dev-card-head:has\(> \.dev-card-icon\) ~ \.dev-card-facts \{ padding-left: 30px; \}/);
  assert.ok(!/max-height: 60px;/.test(CSS));
  assert.ok(!/dev-card-band-break|dev-card-status-end/.test(CSS));
});

test('Open card goes to the item\u2019s page, from the Workshop as from the Board', () => {
  // This used to assert the opposite: "Open card" built the topic screen's
  // sections from `_workshopCardBody` and opened them in place, and the pill
  // only became the link on a second tap ("Open page \u203a", #1886). #1884
  // round two retires that. One word meant an in-place open on the Workshop
  // and a navigation on the Board, and which one you got depended on the
  // screen you had reached the same card from — the last thing about the
  // card the two surfaces still disagreed on.
  //
  // What that costs is reading the ledger and the transcript without leaving
  // the lander. What it buys is that the label means one thing. The sections
  // are unchanged and still drawn by topic-head.tsx; the page is where they
  // live, and the pill goes there.
  const AppView = makeAppView();
  seed(AppView);
  assert.equal(typeof AppView._workshopCardBody, 'undefined',
    'the in-place builder is retired, not left with no caller');

  const unfolded = FOLD.slice(FOLD.indexOf('export function UnfoldedRow'), FOLD.indexOf('export function voteSpecs'));
  assert.match(unfolded, /actionEnd=\{placement \? openBtn : undefined\}/, 'the band seat, on both surfaces');
  assert.match(unfolded, /detail: placement = 'actions',/, 'and it is the default, so the Workshop passes nothing');
  assert.match(unfolded, /const openBtn = placement && href\s*\? <a className="gc-vote-btn dev-ws-open-btn" href=\{href\} data-ws-open-card=\{row\.key\}>Open card<\/a>/,
    'one anchor, one label');
  assert.ok(!/TopicBodySections|readAppView|useState/.test(unfolded),
    'nothing left that built or held an in-place body');
  assert.equal(AppView._devTopic, null, 'and reading the source navigated nothing');
});

test('the open card collapses on a click at the card, not at what it opened', () => {
  // The wrapper's click closes the row. With a thread and a comment list open
  // under the card there is a lot of prose to land on, and collapsing the
  // item because somebody selected a word in it loses their place — so the
  // two regions below the card are excluded alongside the controls.
  // `details` is the merge-requirements checklist (#2128): a disclosure the
  // reader taps open, not a place to fold from. (There were three regions
  // until #1884 round two sent "Open card" to the item's page on both
  // surfaces; the ledger is on that page now, not under the card.)
  const view = FOLD.slice(FOLD.indexOf('function CardRowView'));
  for (const sel of ['a', 'button', 'input', 'textarea', 'select', 'form', 'details',
    '\\[data-attr-chip\\]', '\\[data-issue-chip\\]',
    '\\.dev-feed-thread', '\\.dev-feed-comments']) {
    assert.match(view, new RegExp(sel), `the guard excludes ${sel}`);
  }
  assert.match(view, /el\.closest\(/, 'and it is a closest() test, not a target equality one');
});

test('the vote badge is a ring AND the count in words, and cannot be closed', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._proposals = [
    { id: 71, pr_number: 71, pr_title: 'A', status: 'promoted', username: 'carol', user_id: 9,
      created_at: at(3), promoted_at: at(3), linked_issues: [], my_vote: 'yes' },
    { id: 72, pr_number: 72, pr_title: 'B', status: 'promoted', username: 'carol', user_id: 9,
      created_at: at(3), promoted_at: at(3), linked_issues: [], my_vote: null },
    { id: 73, pr_number: 73, pr_title: 'C', status: 'promoted', username: 'carol', user_id: 9,
      created_at: at(3), promoted_at: at(3), linked_issues: [], my_vote: null },
  ];
  const v = AppView._workshopView();
  assert.equal(v.votes.count, 2);
  assert.equal(v.votes.total, 3);

  const html = workshopHtml(AppView, 'needs');
  // THE RING IS GONE, and so are the words that counted the debt. A feed
  // has one counter — where you are in it — and the eyebrow says what the
  // item in front of you IS, not how many are behind it. The total shows
  // once, on the end card, which is the only place it is news.
  assert.ok(!html.includes('dev-ws-vote-ring'), 'no ring');
  assert.ok(!/proposals? needs? your vote</.test(html), 'no debt in words');
  assert.match(html, /class="dev-ws-eyebrow">Change · Waiting for your approval</, 'the kind, per item, in the change page\'s words');
  assert.match(html, /class="dev-ws-item-of">1 \/ \d+</, 'and the place in the feed');
  assert.ok(!html.includes('dev-ws-needs-count'), 'the strip-head pair is retired');
  assert.ok(!CSS.includes('.dev-ws-needs-count {'), 'and so is its rule');
  assert.ok(!CSS.includes('.dev-ws-needs-end {'), 'and the wrapper it sat in');
  assert.ok(!CSS.includes('.dev-ws-vote-ring {'), 'and the ring\'s');

  // And no ×. A count that can be closed is a count somebody stops seeing
  // while it is still true.
  assert.ok(!html.includes('data-ws-needs-close'), 'the dismissal is gone');
  assert.ok(!WORKSHOP.includes('ws-needs-you-dismissed'), 'and so is the key it wrote');
});

test('an item names its kind; no sentence counts what is owed', () => {
  const AppView = makeAppView();
  seed(AppView);
  const html = workshopHtml(AppView, 'needs');
  assert.match(html, /class="dev-ws-eyebrow">Change · Waiting for your approval</);
  assert.ok(!/1 proposal needs your vote</.test(html), 'the sentence that counted the debt is gone');
  assert.ok(!/needs your vote</.test(html), 'nor the old eyebrow');
});

test('a Needs-you item reads as its change page: "Homeroom bot · made", and the count in words', () => {
  // First-session run-through, 5 Oct 2026: a flatmate's Needs you read
  // "homeroom_bot · proposed 29m ago" over "0 of 2 yes", while the change's
  // own page said "Homeroom bot · made 29m ago" (#3854).
  const AppView = makeAppView();
  seed(AppView);
  AppView._proposals[0].username = 'homeroom_bot';
  const html = workshopHtml(AppView, 'needs');
  const by = /<p class="dev-ws-item-by">[\s\S]*?<\/p>/.exec(html);
  assert.ok(by, 'the item has its by-line');
  assert.match(by[0], /aria-hidden="true">H<\/span><span><b>Homeroom bot<\/b> · made /, 'the bot by its name, and what it did');
  assert.doesNotMatch(by[0], /homeroom_bot|proposed/, 'not its account, not "proposed"');
  // The count against the threshold, in the words an at-least-N pill uses
  // on the change page ("1 of 2 approvals"), and no bare "1/2" beside it.
  const facts = /<button type="button" class="dev-ws-item-facts"[^>]*>([\s\S]*?)<\/button>/.exec(html);
  assert.ok(facts, 'the facts line');
  assert.match(facts[1], />1 of \d+ approvals?</);
  assert.doesNotMatch(facts[1], / yes<|\d\/\d|\d \/ \d/, 'no "1 of 2 yes", no bare fraction');

  // A person's change keeps their name and "proposed", as its page does.
  const People = makeAppView();
  seed(People);
  const theirs = workshopHtml(People, 'needs');
  assert.match(theirs, /<b>carol<\/b> · proposed /);
});

test('the viewer\u2019s own work in flight leads the lander', () => {
  const AppView = makeAppView();
  seed(AppView);
  // A session of mine, a proposal of mine, and one of somebody else's.
  AppView._mySessions = [{ id: 51, session_title: 'Bottom tabs', pr_number: null, last_activity_at: at(0) }];
  AppView._proposals = [
    { id: 61, pr_number: 61, pr_title: 'Mine', status: 'promoted', username: 'me', user_id: 1,
      created_at: at(2), promoted_at: at(2), last_message_at: at(2), linked_issues: [], my_vote: null },
    { id: 62, pr_number: 62, pr_title: 'Theirs', status: 'promoted', username: 'carol', user_id: 9,
      created_at: at(1), promoted_at: at(1), last_message_at: at(1), linked_issues: [], my_vote: null },
  ];
  const v = AppView._workshopView();
  assert.equal(v.mine.count, 2, 'my session and my proposal, not theirs');
  // And the vote strip does not repeat it. "Waiting on you" asks whether you
  // have voted, not whose it is, so a promoted proposal of your own answered
  // both panes and appeared twice, one under the other.
  assert.ok(!plain(v.votes.rows).some((r) => r.key.includes('proposal:61')),
    'your own proposal is not also owed a vote from you');
  assert.equal(v.votes.count, 1, 'only theirs');
  assert.equal(v.mine.shown, AppView.WORKSHOP_MINE_MAX);
  assert.deepEqual(plain(v.mine.rows).map((r) => r.key), ['mine:my-session:51', 'mine:proposal:61'],
    'most recently active first, and keyed apart from the same card elsewhere');

  const html = workshopHtml(AppView, 'workshop');
  // ON THE WORKSHOP PAGE, in full: the hub shows the first two of it, and
  // this is where its door goes. It follows All items (and the approval
  // rules, which wait on a read this render does not make), 5 Oct 2026.
  assert.ok(html.indexOf('data-ws-dashboard') >= 0 && html.indexOf('data-ws-dashboard') < html.indexOf('data-ws-mine=""'));
  assert.ok(!html.includes('data-ws-mine-more'), 'nothing of it waits behind a reveal');
  assert.match(html, /data-ws-lane="mine"/);
  assert.match(html, /<span class="dev-ws-head-title">Your work<\/span>/);

  // ON THE HUB, the first two, and the rest in place under "Show N more".
  const hub = workshopHtml(AppView, 'status');
  assert.match(hub, /data-ws-mine-card=""/);
  assert.equal((hub.match(/data-ws-row="mine:/g) || []).length, 2);
  assert.ok(!hub.includes('data-ws-mine-more'), 'two rows, nothing to reveal');
  AppView._mySessions.push({ id: 52, session_title: 'Kudos', pr_number: null, last_activity_at: at(0.5) });
  const three = workshopHtml(AppView, 'status');
  assert.equal((three.match(/data-ws-row="mine:/g) || []).length, 2, 'the first two');
  assert.match(three, /data-ws-mine-more="" aria-expanded="false"[^>]*>[\s\S]*?Show 1 more<\/button>/, 'and the rest a press away');

  // Unfiltered, exactly like the vote strip: a filter that hid your own work
  // would hide the one thing on this screen you cannot find another way.
  AppView._kanbanFilters = { ...AppView._kanbanFilters, q: 'nothing matches this' };
  assert.equal(AppView._workshopView().mine.count, 3, 'a search does not hide your own work (the two, and the third session above)');
});

test('#4538: a change Homeroom bot built from your request is Your work, still by the bot', () => {
  const AppView = makeAppView();
  seed(AppView);
  // The bot's change from request #208 sits up for a vote. Its author is
  // the bot's account, so the plain "yours" test fails it; the payload's
  // `requested_by_me` is what brings it in.
  AppView._proposals = [
    { id: 71, pr_number: 212, pr_title: 'Dark mode toggle', status: 'promoted', username: 'homeroom_bot',
      user_id: 900, requested_by_me: true, created_at: at(1), promoted_at: at(1),
      last_message_at: at(1), linked_issues: [208], my_vote: null },
    { id: 72, pr_number: 213, pr_title: 'Theirs by the bot', status: 'promoted', username: 'homeroom_bot',
      user_id: 900, created_at: at(0.5), promoted_at: at(0.5),
      last_message_at: at(0.5), linked_issues: [209], my_vote: null },
  ];
  const v = AppView._workshopView();
  assert.deepEqual(plain(v.mine.rows).map((r) => r.key), ['mine:proposal:71'],
    'the bot change from the viewer\'s request is in Your work; the bot\'s other one is not');

  const html = workshopHtml(AppView, 'workshop');
  const lane = html.split('data-ws-lane="mine"')[1] || '';
  // The row names the bot as its maker and the request it is for — never
  // "yours", because the bot made it. #4486: in the board's words, with its
  // PR number and its age.
  assert.match(lane, /Dark mode toggle/);
  assert.match(lane, /<span class="dev-ws-wrow-sub">PR #212 · Homeroom bot · for #208 · [^<]+ ago<\/span>/);
  assert.ok(!lane.includes('yours'), 'the bot made it, so the line does not say yours');
  // The other bot change keeps working as somebody's owed vote.
  assert.match(workshopHtml(AppView, 'needs'), /Theirs by the bot/,
    'a bot change from somebody else\'s request is still owed this viewer\'s vote');

  // And the de-dup holds: your vote on it still counts, but it is not
  // listed a second time among the votes the project needs from you.
  assert.ok(!plain(v.votes.rows).some((r) => r.key.includes('proposal:71')),
    'the bot change is not also in the vote deck');
  assert.equal(v.votes.count, 1, 'only the bot change nobody asked this viewer for');

  // Since your last visit does not repeat it while Your work shows it.
  const seen = 'workshopSeen:demo-app';
  const store = { [seen]: String(Date.now() - 3.5 * 86400000) };
  const Since = makeAppView({ localStorage: store });
  seed(Since);
  Since._proposals = AppView._proposals;
  const sinceHtml = workshopHtml(Since, 'workshop').split('data-ws-since=""')[1] || '';
  assert.ok(!sinceHtml.includes('Dark mode toggle'), 'in review, it is Yours work\'s row, not the since list\'s');
});

test('#2496: an issue you are working on joins "What you are working on"', () => {
  const AppView = makeAppView();
  seed(AppView);
  // Issue 12 carries a live claim by the viewer; issue 13 somebody else's.
  // Both shapes are what GET /github-issues composes: `mine` is the
  // server's per-viewer answer, `target` rides along on real payloads.
  AppView._ghIssues[0].in_progress = {
    count: 0, users: [], peopleTotal: 1, mine: true, sessions: [],
    claims: [{ username: 'me', userId: 1, mine: true,
      claimedAt: at(1), expiresAt: at(1 + 7 * 24) }],
    target: null,
  };
  AppView._ghIssues[1].in_progress = {
    count: 0, users: [], peopleTotal: 1, mine: false, sessions: [],
    claims: [{ username: 'erin', userId: 9, mine: false,
      claimedAt: at(2), expiresAt: at(2 + 7 * 24) }],
    target: null,
  };
  const v = AppView._workshopView();
  const mineKeys = plain(v.mine.rows).map((r) => r.key);
  assert.ok(mineKeys.includes('mine:issue:12'), 'your claimed issue is in the strip');
  assert.ok(!mineKeys.includes('mine:issue:13'), 'a claim by somebody else is not');
  // It did not vanish from where it already lived: the bucket still routes
  // it to Underway, so the issue is drawn exactly once per surface.
  assert.ok(bucketsUnderwayIssue(AppView, 12), 'still on the board, Underway');
  assert.ok(bucketsUnderwayIssue(AppView, 13), 'theirs is underway on the board all the same — the strip adds a place, it moves nothing');

  // Rendered, keyed apart from the same card elsewhere in the pane.
  const html = workshopHtml(AppView, 'workshop');
  assert.match(html, /data-ws-row="mine:issue:12"/);
});

test('#4457: Your work is rows in words, and a request your change addresses is that change', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._ghIssues[0].in_progress = {
    count: 0, users: [], peopleTotal: 1, mine: true, sessions: [],
    claims: [{ username: 'me', userId: 1, mine: true, claimedAt: at(1), expiresAt: at(1 + 7 * 24) }],
    target: null,
  };
  const claimed = AppView._workshopView().mine.rows.find((r) => r.key === 'mine:issue:12');
  assert.ok(claimed, 'your claimed request is your work');
  assert.deepEqual(plain(claimed.brief.tags), [{ label: 'Picked up · you', tone: 'plain' }], 'its tag says who is on it (#4486)');
  assert.equal(claimed.brief.kind, 'request');
  assert.equal(claimed.brief.n, 12);

  // A change of yours for that request: the request is drawn as the change.
  AppView._mySessions = [{ id: 51, session_title: 'Bottom tabs', status: 'paused', pr_number: null, linked_issues: [12],
    created_at: at(1), last_activity_at: at(0) }];
  const v = AppView._workshopView();
  const keys = plain(v.mine.rows).map((r) => r.key);
  assert.ok(keys.includes('mine:my-session:51'));
  assert.ok(!keys.includes('mine:issue:12'), 'not twice');
  const change = v.mine.rows.find((r) => r.key === 'mine:my-session:51');
  assert.deepEqual(plain(change.brief.linked), [12]);
  assert.equal(change.brief.mine, true);
  // #4486: the line is the board's words — the number, who made it, what a
  // change is for or a live one closed, and when, as the card's meta line
  // dates it. The category and the replies are the coloured chip and the 💬
  // count on the tags line, so they are not said here too.
  const { rowWords } = loadTsx('frontend/src/features/dev-board/workshop/work-row.tsx');
  assert.equal(typeof change.brief.ago, 'string', 'the brief carries the card\u2019s own age');
  const b = { ...plain(change.brief), by: 'evan', ago: '' };
  assert.equal(rowWords(b), 'Change · evan · for #12', 'a change with no number yet');
  assert.equal(rowWords({ ...b, n: 4456, linked: [4455, 4452], ago: '4m ago' }), 'PR #4456 · evan · for #4455 and #4452 · 4m ago');
  assert.equal(rowWords({ ...plain(claimed.brief), by: 'evan', category: 'Bug', replies: 3, ago: '8h ago' }), '#12 · evan · 8h ago');
  assert.equal(rowWords({ ...b, kind: 'live', linked: [], closed: [4453], n: 4454, ago: '1h ago' }), 'PR #4454 · evan · closed #4453 · 1h ago');
  assert.equal(rowWords({ ...b, kind: 'vote', noun: 'Vote', linked: [], n: 7 }), 'Vote #7 · evan');
  // #4485 took "yours" off Your work; the board's words never say it at all:
  // a row of yours names you as its maker, as every other row names its own.
  assert.equal(b.mine, true);
  assert.doesNotMatch(rowWords(b), /yours/);
  assert.doesNotMatch(rowWords({ ...plain(claimed.brief), mine: true, by: 'evan' }), /yours/);

  // Drawn: one hairline list, the row a link to the item's page, no card
  // chrome — no edge, no coloured glyph, no @ chip, no 💬, no fold.
  const html = workshopHtml(AppView, 'workshop');
  const lane = html.slice(html.indexOf('data-ws-lane="mine"'), html.indexOf('data-ws-since=""'));
  assert.match(lane, /<div class="dev-ws-wlist"><div class="dev-ws-wrow" data-ws-row="mine:/);
  assert.match(lane, /<a class="dev-ws-wrow-link" href="#app\/demo-app\/dev\/proposals\/51">Bottom tabs<\/a><span class="dev-ws-wrow-sub">Change(?: · [^<·]+)? · for #12 · [^<]+ ago<\/span><span class="dev-ws-wrow-status"><span class="dev-ws-tag" data-tone="plain" title="[^"]+"><svg[\s\S]*?<\/svg>Only you<\/span><span class="dev-ws-tag" data-tone="plain">Started<\/span><\/span><\/span>/,
    'a private session says Only you, with a lock (#4486)');
  assert.ok(!/<span class="dev-ws-wrow-sub">[^<]*yours/.test(lane), 'no "yours" on Your work (#4485)');
  assert.ok(!/data-edge=|dev-card-icon|dev-fold-mark|aria-expanded|data-issue-row|data-session-chip/.test(lane),
    'none of the card\'s chrome, and none of the hooks the Board\'s handler opens a card on');
});

test('#4457, #4485, #4486: a change up for a vote keeps its vote at the end of the tags\' line: the card\'s bar with its own words, and its Vote', () => {
  const { WorkRow } = loadTsx('frontend/src/features/dev-board/workshop/work-row.tsx');
  const AppView = makeAppView();
  seed(AppView);
  const v = AppView._workshopView();
  const row = [...v.votes.rows, ...(v.since ? v.since.rows : [])].find((r) => r.t === 'card' && r.card.attrs['data-proposal-row']);
  assert.ok(row, 'a proposal row');
  const brief = { kind: 'change', noun: 'Change', n: 34, by: 'bob', mine: false, category: '', replies: 0, linked: [], closed: [], stage: 'vote', at: 0,
    tags: [{ label: 'Checks running…', tone: 'run' }, { label: 'Preview ready', tone: 'plain', glyph: 'eye' }], vote: { yes: 1, need: 3, ask: true } };
  const html = renderToHtml(createElement(WorkRow, { row: { ...row, brief }, slug: 'demo-app' }));
  assert.match(html, /<span class="dev-ws-tag" data-tone="run"><span class="dc-status-spinner-arc" aria-hidden="true"><\/span>Checks running…<\/span>/);
  // #4499: once the run knows its total, the tag carries a bar instead of
  // "619/732", with the count as its tooltip and the bar's name.
  const runningBrief = { ...brief, tags: [{ label: 'Checks', tone: 'run', title: '619 of 732 checks done. Automated tests are still running.', progress: { done: 619, total: 732, text: '619 of 732 checks done' } }] };
  const running = renderToHtml(createElement(WorkRow, { row: { ...row, brief: runningBrief }, slug: 'demo-app' }));
  assert.match(running, /<span class="dev-ws-tag" data-tone="run" title="619 of 732 checks done\. Automated tests are still running\."><span class="dc-status-spinner-arc" aria-hidden="true"><\/span>Checks<span class="checks-chip-bar" role="progressbar" aria-valuemin="0" aria-valuemax="732" aria-valuenow="619" aria-label="619 of 732 checks done"><span class="checks-chip-bar-fill" style="width:85%"><\/span><\/span><\/span>/);
  // #4486: the thin bar and its "1 of 3 yes" went; the card's own status
  // pill says it in its own words, at its words' width plus 56px (app.css).
  const pill = row.card.pill.state;
  assert.match(html, new RegExp(`<span class="dev-ws-wvote" data-ws-vote=""><span class="dev-ws-row-state dev-ws-row-state-${pill.tone} dev-ws-wvote-state"[^>]*>${pill.label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}</span><span class="dev-ws-wvote-btn">`),
    'the bar, then Vote');
  assert.ok(!/dev-ws-wvote-bar|dev-ws-wvote-n|dev-ws-wvote-cell/.test(html), 'no thin bar, no count beside it');
  assert.match(CSS, /\.dev-ws-wvote-state \{ flex: none; padding: 0 calc\(10px \+ 56px\) 0 10px; \}/);
  // #4485: the vote shares the tags' line, at its far end, on every width:
  // no phone rule gives it a line of its own (it wraps only when the line
  // has no room). So the longest tags say less on a row, the full words
  // their tooltip and what a screen reader reads.
  assert.match(html, /<span class="dev-ws-tag" data-tone="plain"><svg[^>]*>.*?<\/svg>Preview ready<\/span><span class="dev-ws-wvote" data-ws-vote="">/, 'a tag without short words draws its label, and the vote follows the tags on their line');
  assert.match(CSS, /\.dev-ws-wvote \{\s*position: relative; z-index: 1; margin-left: auto;/);
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ' '), /\.dev-ws-wvote \{ margin-left: 0; width: 100%; \}/, 'no line of its own on a phone');
  const short = { ...brief, tags: [{ label: 'Taking before & after shots', short: 'Taking shots', tone: 'run' }, { label: 'Preview ready', short: 'Preview', tone: 'plain', glyph: 'eye' }] };
  const shortHtml = renderToHtml(createElement(WorkRow, { row: { ...row, brief: short }, slug: 'demo-app' }));
  assert.match(shortHtml, /<span class="dev-ws-tag" data-tone="run" title="Taking before &amp; after shots"><span class="dc-status-spinner-arc" aria-hidden="true"><\/span><span aria-hidden="true">Taking shots<\/span><span class="sr-only">Taking before &amp; after shots<\/span><\/span>/);
  assert.match(shortHtml, /title="Preview ready">.*<span aria-hidden="true">Preview<\/span><span class="sr-only">Preview ready<\/span><\/span>/);
  const { voteSpecs } = loadTsx('frontend/src/features/dev-board/card/fold.tsx');
  assert.ok(voteSpecs(row.card), 'the fixture can vote');
  assert.match(html, /<span class="dev-ws-wvote-btn"><button type="button" class="dev-vote-btn" data-vote-btn="open"/, 'the card\'s own Vote button');
  const { topicRef } = loadTsx('frontend/src/features/dev-board/workshop/work-row.tsx');
  assert.deepEqual(plain(topicRef({ attrs: { 'data-issue-row': '12' } })), { kind: 'issue', id: 12 });
  assert.deepEqual(plain(topicRef({ attrs: { 'data-session-chip': '51' } })), { kind: 'proposal', id: 51 });
  assert.deepEqual(plain(topicRef({ attrs: { 'data-gov-row': '7' } })), { kind: 'gov', id: 7 });
  assert.equal(topicRef({ attrs: {} }), null);
});

test('#4457: a row opens its page beside the list on a wide window, and that page is the topic page itself', () => {
  const PANEL = read('frontend/src/features/dev-board/workshop/side-panel.tsx');
  // The panel hosts the SAME page: the host the full page's frame renders,
  // keyed by the item, filled by AppView exactly as the full page is.
  assert.match(PANEL, /<div key=\{`\$\{item\.kind\}:\$\{item\.id\}`\} id="dev-topic-thread" className="dev-ws-side-page" \/>/);
  assert.match(PANEL, /callAppView\('openTopicInPanel', item\.kind, item\.id\)/);
  assert.match(PANEL, /return \(\) => \{ callAppView\('closeTopicPanel', item\.kind, item\.id\); \};/);
  assert.match(PANEL, /callAppView\('openTopic', item\.kind, item\.id\)/, 'Open as a page is the page\'s own route');
  const open = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('async openTopicInPanel(kind, id) {'), APP_VIEW_SRC.indexOf('closeTopicPanel(kind, id) {'));
  assert.match(open, /AppView\._devTopic = \{ kind, id \};/);
  assert.match(open, /AppView\._mountTopicThread\(\);\s*AppView\._renderTopicHead\(\);/, 'the full page\'s own mount and paint');
  assert.match(APP_VIEW_SRC, /if \(subTab !== 'topic'\) \{ AppView\._devTopic = null; AppView\._devTopicInPanel = false; \}/,
    'a move to another sub-view lets it go');
  // A plain click on a wide window; anything else is the row's own link.
  assert.match(WORKSHOP, /const SIDE_QUERY = '\(min-width: 1180px\)';/);
  assert.match(WORKSHOP, /if \(!sideWide\) return;\s*event\.preventDefault\(\);/);
  assert.match(WORKSHOP, /\{\(tab === 'workshop' \|\| tab === 'all'\) && sideItem \? <TopicSidePanel item=\{sideItem\} onClose=\{closeSide\} \/> : null\}/,
    'from the Workshop tab\u2019s lists, and from All items (#4486)');
  // The list makes room and keeps its place; the open row is lit.
  assert.match(CSS, /#dev-workshop:has\(> \.dev-ws\[data-ws-side-open\]\) \{/);
  assert.match(CSS, /\.dev-ws-wrow\[data-on\] \{ background: var\(--lit-tint\); \}/);
});

test('#4480: a page opened from the side panel keeps its thread when the panel goes', () => {
  // The panel's change page is up; its "Addresses #77" chip opens the
  // request's page. The panel outlives the switch (its host is detached but
  // not yet swept), and its cleanup runs only when the request page's first
  // portal mount sweeps it: after GroupChat.mountThread has made the
  // request's thread the active one.
  let unmounts = 0;
  const GroupChat = { activeThread: null, unmountThread() { unmounts += 1; this.activeThread = null; } };
  const App = { user: { id: 1, username: 'me' }, currentApp: 'demo-app', currentSubTab: 'forum' };
  const AppView = makeAppView({ App, globals: { GroupChat } });
  AppView._devTopic = { kind: 'proposal', id: 51 };
  AppView._devTopicInPanel = true;

  // What renderDevView('topic') and _renderTopicSubView do on the way in.
  App.currentSubTab = 'topic';
  const view = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('async renderDevView(subTab, ref) {'));
  assert.match(view, /if \(subTab !== 'topic'\) \{ AppView\._devTopic = null; AppView\._devTopicInPanel = false; \}\n(?:\s*\/\/[^\n]*\n)*\s*else AppView\._devTopicInPanel = false;/,
    'a topic page takes the topic from the panel');
  AppView._devTopicInPanel = false;
  AppView._devTopic = { kind: 'issue', id: 77 };
  GroupChat.activeThread = { type: 'issue', ref: 77 };

  // The panel's cleanup, as side-panel.tsx calls it.
  AppView.closeTopicPanel('proposal', 51);
  assert.equal(unmounts, 0, 'the request\'s thread stays mounted');
  assert.deepEqual(plain(GroupChat.activeThread), { type: 'issue', ref: 77 });
  assert.deepEqual(plain(AppView._devTopic), { kind: 'issue', id: 77 });

  // Even with the flag still up, a panel only closes its own item.
  AppView._devTopicInPanel = true;
  AppView.closeTopicPanel('proposal', 51);
  assert.equal(unmounts, 0, 'another topic is not the panel\'s to close');
  assert.equal(AppView._devTopicInPanel, true);

  // Its own item it still takes down, as ✕ does.
  App.currentSubTab = 'forum';
  AppView._devTopic = { kind: 'proposal', id: 51 };
  AppView.closeTopicPanel('proposal', 51);
  assert.equal(unmounts, 1);
  assert.equal(AppView._devTopicInPanel, false);
  assert.equal(AppView._devTopic, null);
});

test('#2496: the mine-ness predicate reads every live mark the board writes', () => {
  const AppView = makeAppView();
  seed(AppView);
  // A live session of yours against the issue (the automatic half of
  // issue-progress), with `mine` composed per session.
  assert.equal(AppView._issueIsMine({
    in_progress: { mine: false, sessions: [
      { sessionId: 7, username: 'me', mine: true, status: 'active' },
    ], claims: [] },
  }), true, 'your live session counts');
  // Paused counts too — it is still your work, which is what the strip says.
  assert.equal(AppView._issueIsMine({
    in_progress: { mine: false, sessions: [
      { sessionId: 7, username: 'me', mine: true, status: 'paused' },
    ], claims: [] },
  }), true, 'a paused session of yours still counts');
  // A claim fixture without the per-claim `mine` flag (an older cache)
  // still names you by username.
  assert.equal(AppView._issueIsMine({
    in_progress: { claims: [{ username: 'me', mine: false }] },
  }), true, 'a claim naming you counts even without the flag');
  // The boolean alone, on a payload that carries no detail lists.
  assert.equal(AppView._issueIsMine({ in_progress: { mine: true } }), true);
  // The board's "assigned to you" reading: the community assignee chip.
  assert.equal(AppView._issueIsMine({ assignee: { top: 'me' } }), true);
  // And the negatives: somebody else's claim, their assignee mark, nothing.
  assert.equal(AppView._issueIsMine({
    in_progress: { mine: false, sessions: [
      { sessionId: 7, username: 'erin', mine: false, status: 'active' },
    ], claims: [] },
  }), false, 'somebody else\u2019s session is not yours');
  assert.equal(AppView._issueIsMine({ assignee: { top: 'erin' } }), false);
  assert.equal(AppView._issueIsMine({}), false);
  // A guest has no self to match, so nothing is mine — the same answer the
  // quick filters give (`_viewerUsername` is null signed out).
  const guest = makeAppView({ App: { user: null, currentApp: 'demo-app', currentSubTab: 'forum' } });
  assert.equal(guest._issueIsMine({ assignee: { top: 'me' } }), false);
});

test('#1887: a card about your own session opens the CARD, with the session a link inside it', () => {
  // Opening a card about your own session used to navigate to the session
  // — the row's page link and the delegated #dev-body handler both went to
  // /dev/sessions/<id>. It is a card like every other now: the row unfolds
  // it in place, the change's page is the open card's pill (#1886), and the
  // session is a link INSIDE the open card — the one line under the sheet.
  const mine = { id: 51, session_title: 'Bottom tabs', status: 'active', pr_number: null, linked_issues: [],
    created_at: at(1), last_activity_at: at(0) };
  const AppView = makeAppView();
  seed(AppView);
  AppView._mySessions = [{ ...mine }];
  const v = AppView._workshopView();
  const row = v.mine.rows.find((r) => r.t === 'card' && r.card.attrs['data-session-chip'] === '51');
  assert.ok(row, 'the session is on the lander, carrying the hook the checks name it by');
  assert.equal(row.key, 'mine:my-session:51');

  // #4457: on the Workshop tab your work is a list of rows that open the
  // item's page, the change's for a session of yours, never the session.
  const tabRow = workshopHtml(AppView, 'workshop');
  assert.match(tabRow, /<div class="dev-ws-wrow" data-ws-row="mine:my-session:51" data-ws-kind="change" data-ws-open="proposal:51">[\s\S]*?<a class="dev-ws-wrow-link" href="#app\/demo-app\/dev\/proposals\/51">Bottom tabs<\/a>/);
  assert.ok(!tabRow.includes('/dev/sessions/51'), 'the session is linked from nowhere on the tab');

  // On the hub's Your work it is still a disclosure like every other row:
  // no destination of its own, and nothing links to the session.
  const folded = workshopHtml(AppView, 'status');
  assert.match(folded, /class="dev-ws-row[^"]*"[^>]*aria-expanded="false"[^>]*data-ws-row="mine:my-session:51"[^>]*data-session-chip="51"/);
  assert.ok(!folded.includes('/dev/sessions/51'), 'folded, the session is linked from nowhere');
  assert.ok(!folded.includes('dev-ws-sheet-actions'), 'and there is no line under a row to carry a link');

  // Unfolded — through the deep link the declared check uses — it is the
  // card: its pill in the action band, and under the sheet one line, the
  // session's.
  AppView._workshopShot = 'mine-session';
  assert.deepEqual(plain(AppView._workshopView().autoExpand), { theme: 'mine', key: 'mine:my-session:51' });
  const open = workshopHtml(AppView, 'status');
  assert.match(open, /data-ws-lane="mine-hub"><div class="dev-ws-rowwrap dev-ws-rowwrap-open"><div class="dev-feed-entry dev-ws-sheet" data-ws-sheet="mine:my-session:51"><div class="[^"]*dev-card-dense"[^>]*data-session-chip="51"/,
    'the open card, hook intact');
  // The change's page is the pill's, not a line under the sheet (#1886) —
  // and since #1884 round two the pill IS that link on its first tap, here
  // as on the Board, rather than opening the sections in place and becoming
  // the link on a second.
  assert.match(open, /<a class="gc-vote-btn dev-ws-open-btn" href="#app\/demo-app\/dev\/proposals\/51" data-ws-open-card="mine:my-session:51">Open card<\/a>/,
    'the open card carries the pill, and it is the page link');
  assert.ok(!open.includes('Open on its own page'), 'no page link under the sheet');
  assert.ok(!open.includes('Open page ›'), 'and no second step to reach one');
  // Under the sheet, the session — alone. #2030's point was that two
  // controls both reading "Open" confused; the session is a different
  // destination from the page the pill opens, so it keeps its own link,
  // and it is the one thing the line holds: no separator, nothing beside it.
  assert.match(open, /<div class="dev-ws-sheet-actions"><a href="#app\/demo-app\/dev\/sessions\/51" class="dev-ws-link" data-ws-open-session="mine:my-session:51">Open session ›<\/a><\/div><\/div>/,
    'the session link is the line under the sheet, and the last thing in it');
  assert.equal((open.match(/class="dev-ws-link"/g) || []).length, 1, 'one link under the sheet');
  assert.equal((open.match(/\/dev\/sessions\/51/g) || []).length, 1, 'the session is linked once, inside the open card');
  assert.ok(!open.includes('dev-ws-sheet-sep') && !FOLD.includes('dev-ws-sheet-sep') && !/dev-ws-sheet-sep/.test(CSS),
    'the separator went with the second link');
  assert.match(CSS, /\.dev-ws-sheet-actions \{ display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; \}/,
    'the line keeps its rule — #1886 dropped it with the page link; this link is why it is back');

  // The helpers, from the bundle: the card's page is the change's, and only
  // a hook for one of YOUR sessions names a session — an imported PR of
  // yours has no dev chat, and nobody else's session is yours to open.
  const { openHref, sessionHref } = loadTsx('frontend/src/features/dev-board/card/fold.tsx');
  assert.equal(openHref('demo-app', row.card), '#app/demo-app/dev/proposals/51');
  assert.equal(sessionHref('demo-app', row.card), '#app/demo-app/dev/sessions/51');
  for (const hook of ['data-shared-session-row', 'data-proposal-row', 'data-issue-row', 'data-gov-row']) {
    assert.equal(sessionHref('demo-app', { attrs: { [hook]: '51' } }), null, `${hook} is not a session of yours`);
  }
  assert.equal(sessionHref('', row.card), null, 'and no app, no route');

  // A tap outside a fold — the delegated #dev-body handler — opens the
  // change's page too, never the session (#2020). The session's own route
  // stays for the links that hold it: the one above, and a bookmark.
  const click = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf("const sessionChip = e.target.closest('[data-session-chip]');"));
  assert.match(click.slice(0, 400), /AppView\.openTopic\('proposal', parseInt\(sessionChip\.dataset\.sessionChip, 10\)\);/);
  assert.ok(!/switchTab\('dev', parseInt\((?:sessionChip|el)\.dataset\.sessionChip, 10\), 'sessions'\)/.test(APP_VIEW_SRC),
    'no card hook navigates to the session any more');

  // On the Board the open card's "Open card" is the change's page as well,
  // and there is no line under the card: that page carries the workspace.
  const board = makeAppView({ location: { search: '?cards=open', hash: '', href: 'http://localhost/?cards=open' } });
  seed(board);
  board._mySessions = [{ ...mine }];
  const bh = kanbanHtml(board);
  assert.match(bh, /<a class="gc-vote-btn dev-ws-open-btn" href="#app\/demo-app\/dev\/proposals\/51" data-ws-open-card="my-session:51">Open card<\/a>/);
  assert.ok(!bh.includes('/dev/sessions/51'), 'the Board links the session from nowhere');

  // Declared: the deep link, on the Workshop, reaching the link. RETARGETED
  // from the text-only board check that owned the busy mock row rather than
  // added: the manifest sits at its ceiling (services/app-manifest.js keeps
  // 20 slots clear of MAX_DECLARED_TESTS), so one check owns that row before
  // and after — as the card it opens into, with the session inside it. The
  // selector walks the markup above: the lane, the open wrapper, the sheet,
  // the card by its hook, and the line under it — a later sibling of the
  // card, past the thread — holding the session link alone (the page link
  // it once had to pass on the way is the pill's now, #1886).
  const check = dapp.tests.find((t) => /#1887/.test(t.name));
  assert.ok(check, 'a declared check pins it');
  // On the hub's Your work, which unfolds its rows: the Workshop tab's
  // rows open the item's page instead (#4457).
  assert.equal(check.path, '/?demo=1&shot=mine-session&ws=status#app/usernode-2d5619/workshop');
  assert.equal(check.expectSelector,
    '#dev-workshop [data-ws-lane="mine-hub"] > .dev-ws-rowwrap-open > .dev-ws-sheet > .dev-card-dense[data-session-chip] ~ .dev-ws-sheet-actions > a.dev-ws-link[data-ws-open-session][href*="/dev/sessions/"]');
  assert.equal(check.expectText, '[Mock] Busy own session', 'the busy mock row, which the retargeted check always read');
  assert.ok(!dapp.tests.some((t) => /Busy own session card renders/.test(t.name)), 'retargeted, not duplicated');
  assert.match(APP_VIEW_SRC, /if \(shot === 'mine-session'\) \{\s*AppView\._workshopShot = 'mine-session';\s*\}/,
    'the shot is read where the other Workshop shots are');
});

test('#3081: an agent session\'s change card opens the AGENT SESSION, not its old dev chat', () => {
  // A change started from an agent session is revised in that conversation;
  // its dev chat at /dev/sessions/<id> only shows a strip leading there. The
  // open card's "Open session ›" went to the dev chat all the same — the old
  // screen, and not one the owner could type into. It goes where the change
  // page's door (`_buildDoorView`) already sends the owner.
  const mine = { id: 52, session_title: 'Agent-built change', status: 'active', pr_number: null, linked_issues: [],
    agent_session_id: 7301, created_at: at(1), last_activity_at: at(0) };
  const AppView = makeAppView();
  seed(AppView);
  AppView._mySessions = [{ ...mine }];
  AppView._workshopShot = 'mine-session';
  const row = AppView._workshopView().mine.rows
    .find((r) => r.t === 'card' && r.card.attrs['data-session-chip'] === '52');
  assert.ok(row, 'the change is on the lander with its usual hook');
  assert.equal(row.card.attrs['data-session-agent'], '7301', 'the card names the conversation it was started from');

  const open = workshopHtml(AppView, 'status');
  assert.match(open, /<div class="dev-ws-sheet-actions"><a href="#messages\/agent\/7301" class="dev-ws-link" data-ws-open-session="mine:my-session:52">Open session ›<\/a><\/div>/,
    'the link under the open card is the agent session');
  assert.ok(!open.includes('/dev/sessions/52'), 'and nothing on the card leads to the old dev chat');
  assert.match(open, /href="#app\/demo-app\/dev\/proposals\/52" data-ws-open-card="mine:my-session:52">Open card<\/a>/,
    'the change page is still the pill');

  const { sessionHref } = loadTsx('frontend/src/features/dev-board/card/fold.tsx');
  assert.equal(sessionHref('demo-app', row.card), '#messages/agent/7301');
  // A session with no agent conversation keeps its dev chat.
  assert.equal(sessionHref('demo-app', { attrs: { 'data-session-chip': '52' } }), '#app/demo-app/dev/sessions/52');

  // Only the viewer's own, non-imported session carries the mark.
  const imported = AppView._mySessionCardModel({ ...mine, source: 'imported' });
  assert.equal(imported.attrs['data-session-agent'], undefined);
  const plainSession = AppView._mySessionCardModel({ ...mine, agent_session_id: null });
  assert.equal(plainSession.attrs['data-session-agent'], undefined);
});

test('the band is Open card\u2019s one seat: the facts-line seat and its inline-actions path are gone', () => {
  // `statusLead` put a caller's control at the right end of the facts line
  // and moved the card's own pills up beside it. Nothing passed one once the
  // Workshop's open card took the band seat, and with the facts as a row of
  // their own there is no line for it to end. One seat, one drawing.
  assert.ok(!CARD_TSX.includes('statusLead'));
  assert.ok(!CARD_TSX.includes('inlineActions'));
  assert.ok(!CARD_TSX.includes('dev-card-status-end'));
  assert.match(FOLD, /export type DetailPlacement = 'actions' \| false;/);
});

test('the status row and the facts row are two elements, not one band with a break in it', () => {
  // The bar with the vote at its right spans the card; the facts under it
  // are tabbed in. A dense card always emits the status row (flagged empty
  // when it has no bar and no vote, so the sibling chain the checks walk
  // stays intact) and the facts row only with something visible in it.
  assert.match(CARD_TSX, /<div className="dev-card-badges dev-card-status" data-empty=\{pill \|\| voteBtn \? undefined : '1'\}>\{pill\}\{voteBtn\}<\/div>/);
  assert.match(CARD_TSX, /const factsShown = kept\.length > 0;/);
  assert.match(CARD_TSX, /const factsRow = dense && factsShown \? \(\s*<div className="dev-card-badges dev-card-facts">/);
  assert.ok(!CARD_TSX.includes('dev-card-band-break'));
});

test('one hover for both sizes, and a facts line that is not clipped', () => {
  // The row took `--state-neutral-bg` and the card took `hover:bg-zinc-50`,
  // so two sizes of one object hovered to two different greys. Hard-coding
  // the colour in app.css could not have fixed it: `zinc` is overridden in
  // tailwind.config.js, so a hex from the stock palette would be a THIRD
  // grey. The row wears the card's own utilities instead.
  assert.match(FOLD, /className=\{`dev-ws-row hover:bg-zinc-50 dark:hover:bg-zinc-800/);
  assert.ok(!/\.dev-ws-row:hover \{[^}]*background:/.test(CSS), 'app.css no longer sets the fill');
  assert.ok(!/\.dev-ws-row:hover \{/.test(CSS), 'and no hover rule of its own at all: the fill utility is the whole hover, as it is on the card');

  // The card's status row clips at the bar's 30px and its facts row at one
  // 22px line; each is its own element, so neither can clip the other's
  // bottom edge the way the one wrapping band with a break in it once did.
  assert.match(CSS, /\.dev-card-badges\.dev-card-status \{[^}]*max-height: 30px;/);
  assert.match(CSS, /\.dev-card-badges\.dev-card-facts \{[^}]*max-height: 22px;/);
  assert.ok(!/dev-card-band-break/.test(CSS), 'the break, and the line it cost, are gone');
});

test('every owed vote is in the deck, not on a filtered board', () => {
  const AppView = makeAppView();
  seed(AppView);
  // Five owed proposals against a cap of three.
  AppView._proposals = [1, 2, 3, 4, 5].map((n) => ({
    id: 100 + n, pr_number: 200 + n, pr_title: `Waiting ${n}`, status: 'promoted', username: 'carol',
    created_at: at(3), promoted_at: at(3), last_message_at: at(3), linked_issues: [], my_vote: null,
    votes_for: 1, votes_against: 0, yes_count: 1, no_count: 0,
  }));
  const v = AppView._workshopView();
  assert.equal(v.votes.count, 5);
  assert.equal(v.votes.shown, AppView.WORKSHOP_VOTES_MAX);
  assert.equal(v.votes.rows.length, 5, 'EVERY owed row is published, not just the visible ones');

  const html = workshopHtml(AppView, 'needs');
  // ONE at a time, and the deck says how many there are. The cap that drew
  // three and hid two behind "2 more waiting on you" is gone, and so is the
  // list: a decision gets the whole screen, and `votes.shown` no longer
  // decides anything that is drawn (it stays on the view model).
  // Seven: five proposals owed a vote, then the two unclaimed issues behind
  // them. The deck is one queue of questions, not two lists.
  // Seven in the queue, and the count rides the head: the back/forward pair
  // is gone, because Skip is the only way forward a decision screen needs.
  assert.match(html, /class="dev-ws-item-of">1 \/ 7</, 'the feed counts the whole queue');
  assert.equal((html.match(/ data-ws-item="(?:vote|need):/g) || []).length, 7, 'and every item is in the DOM');
  // Plus the end card after them (#2172): one more snap slot, not a footer,
  // and not one of the seven the counter counts.
  assert.equal((html.match(/ data-ws-item="/g) || []).length, 8, 'and the end card is the slot after the last');
  assert.ok(!html.includes('data-ws-needs-nav'), 'no pager under the answers');
  assert.equal((html.match(/dev-card-dense|dev-card-topic/g) || []).length, 0,
    'and no dense card: an item is its title, the sentence a voter reads, and the caption');
  assert.ok(!html.includes('data-ws-votes-more'), 'and there is no second disclosure');
  assert.ok(!/5 proposals need your vote/.test(html), 'no count in words: the counter is the count');

  // Every row in the DOM is also what keeps the two legacy fillers working:
  // `_wireFeedComments` observes hosts it can only find if they are rendered,
  // and the `?shot=` deep link can name a row that is not the visible one.
  assert.match(WORKSHOP, /every row stays in the DOM/);

  // It used to set a board filter and navigate: it left the lander, changed
  // the view mode, and Back was the only way home — to read a list the strip
  // was already showing the top of.
  assert.ok(!APP_VIEW_SRC.includes('openBoardNeedingVote'), 'the navigation is gone');
  assert.ok(!WORKSHOP.includes('openBoardNeedingVote'), 'and nothing still calls it');
});

test('#2172: one card past the last item is the summary, and it is the screen when there is nothing', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._proposals = [1, 2, 3].map((n) => ({
    id: 100 + n, pr_number: 200 + n, pr_title: `Waiting ${n}`, status: 'promoted', username: 'carol',
    created_at: at(3), promoted_at: at(3), last_message_at: at(3), linked_issues: [], my_vote: null,
    votes_for: 1, votes_against: 0, yes_count: 1, no_count: 0,
  }));
  const v = AppView._workshopView();
  assert.equal(v.queue.length, 5, 'three votes and the two unclaimed issues');
  const html = workshopHtml(AppView, 'needs');
  // THE LAST SLOT IN THE SCROLLER, after every item, with the item's own
  // class so it is the same height and the same snap point: a swipe past the
  // end lands on it the way a swipe landed on each decision.
  const scroll = /data-ws-feed=""[\s\S]*?<\/section><\/div>/.exec(html);
  assert.ok(scroll, 'the scroller');
  const slots = scroll[0].match(/<section class="dev-ws-item[^"]*" data-ws-item="([^"]+)"/g);
  assert.equal(slots.length, 6, 'five items and the end card');
  assert.match(slots[5], /class="dev-ws-item dev-ws-needs-done" data-ws-item="done"/, 'and the end card is LAST');
  assert.match(html, /data-ws-item="done" data-ws-kind="done" data-ws-done-acted="0" data-ws-done-left="5"/,
    'it says how many this pass answered and how many it passed over');
  // The counter and the progress line count the decisions only: the end card
  // is where you are once they are behind you, not a sixth decision.
  assert.match(html, /class="dev-ws-item-of">1 \/ 5</);
  assert.ok(!/class="dev-ws-item-of">6 \//.test(html), 'the end card has no counter');
  // Nothing answered yet and five passed over: the headline says "for now",
  // the line under it says what was skipped, and there is a way back to it
  // as well as the way back to the lander.
  //
  // #3526: SKIPPED, NOT "STILL WAITING ON YOU". A vote swiped past is seen
  // now and every badge stops counting it, so the line that used to say
  // "5 are still waiting on you above" sat under a Needs you count that had
  // just dropped by five. It says what the reader did, and that the items
  // are still there to change their mind about.
  assert.match(html, /dev-ws-needs-done-line">That’s it for now\.</);
  assert.match(html, /dev-ws-needs-done-sub">You skipped 5\. They stay above if you change your mind\.</);
  assert.match(html, /dev-ws-done-cta"[^>]*>See what changed this week</, 'the way back to the lander');
  assert.match(html, /dev-ws-done-back" data-ws-done-back=""[^>]*>Back to the first one you skipped</, 'and back up the feed');
  // The ring states where the viewer stands against everything they could
  // vote on: three promoted, none answered.
  assert.match(html, /dev-ws-done-ring[\s\S]*?aria-label="0 of 3 open changes voted on"/);
  // THE RAIL ON THE END CARD is the move pair alone, so the way back up stays
  // where the thumb learned it is and the stage keeps its width on a wide
  // window; the item rail is drawn only for an item.
  assert.match(WORKSHOP, /<aside className="dev-ws-rail dev-ws-rail-end" data-ws-rail="" aria-label="The end of the feed">\s*\{moveRow\}/);
  assert.match(WORKSHOP, /const row = i < n \? items\[i\] : null;/, 'index n is the end card, with no row');
  assert.match(WORKSHOP, /const idx = key === END_KEY \? items\.length : items\.findIndex/,
    'a reader on the end card stays on it when rows arrive or leave above');
  assert.match(WORKSHOP, /const c = Math\.min\(Math\.max\(idx, 0\), items\.length\);/, 'a swipe can land on it');
  // The way the check reaches it: the route opens ON the end card, instantly.
  assert.match(WORKSHOP, /\.get\('shot'\) === 'needs-end'/);
  assert.match(WORKSHOP, /const \[endOnOpen\] = useState\(wantsEnd\);/, 'read once, at mount');
  assert.match(WORKSHOP, /useRef<string \| null>\(endOnOpen \? END_KEY : null\)/);
  const check = dapp.tests.find((t) => /shot=needs-end/.test(t.path));
  assert.ok(check, 'a declared check rides that route');
  assert.match(check.expectSelector, /\[data-ws-kind="vote"\] ~ \[data-ws-item="done"\]\[data-ws-kind="done"\]/,
    'and walks past a vote item to the end card');
  // The copy: no em dashes, and each class the card emits has a rule.
  const card = /<section class="dev-ws-item dev-ws-needs-done"[\s\S]*?<\/section>/.exec(html)[0];
  assert.ok(!card.includes('—'), 'no em dash in what the reader is shown');
  for (const cls of ['dev-ws-needs-done', 'dev-ws-done-ring', 'dev-ws-needs-done-line', 'dev-ws-needs-done-sub', 'dev-ws-done-cta', 'dev-ws-done-back']) {
    assert.ok(new RegExp(`\\.${cls}\\b[^{]*\\{`).test(CSS), `${cls} has a rule`);
  }

  // WITH NOTHING IN THE QUEUE it is the whole screen, as the empty state was:
  // the caught-up line, no way back up (there is nothing above), no rail.
  AppView._proposals = [];
  AppView._ghIssues = [];
  const empty = workshopHtml(AppView, 'needs');
  const only = empty.match(/ data-ws-item="/g) || [];
  assert.equal(only.length, 1, 'the end card alone');
  assert.match(empty, /dev-ws-needs-done-line">You’re all caught up\.</);
  assert.match(empty, /Every change you can vote on has your answer, and every open request has somebody on it\./);
  // Plain words (#3861 follow-up, 5 Oct 2026 run): the end card says changes, as the cards above it do.
  assert.match(WORKSHOP, /You voted on \$\{plural\(acted, 'change', 'changes'\)\} this time\./);
  assert.ok(!/open proposals voted on|Every proposal you can vote on|'proposal', 'proposals'\) this time/.test(WORKSHOP), 'no proposal wording left on the end card');
  assert.ok(!empty.includes('data-ws-done-back'), 'nothing to go back to');
  assert.ok(!empty.includes('data-ws-rail'), 'and no rail');
});

test('the footnote says what is actually happening to the grouping', () => {
  // The first cut said "once an AI model is available" while the model was
  // mid-draft — on exactly the first visit after a deploy. Four states now.
  const AppView = makeAppView();
  seed(AppView);
  const cat = (extra) => ({
    slug: 'demo-app', source: 'category', generatedAt: null, stale: true, pending: false, lastError: null,
    at: Date.now(), themes: [{ id: 'c', name: 'Uncategorised', description: '', saying: '', items: ['issue:12', 'issue:13', 'session:34', 'session:78'] }],
    ...extra,
  });
  AppView._workshopThemes = cat({ pending: true });
  let html = workshopHtml(AppView, 'all');
  assert.match(html, /drafting categories…/, 'pending on the grouping says so in the eyebrow');
  assert.match(html, /Categories are being drafted from the board now\./);
  assert.ok(!html.includes('regrouping…'), 'and does not claim a regroup of categories that do not exist yet');

  AppView._workshopThemes = cat({ lastError: 'boom' });
  html = workshopHtml(AppView, 'all');
  assert.match(html, /The last attempt to draft categories failed \(boom\)\./);

  AppView._workshopThemes = cat({});
  html = workshopHtml(AppView, 'all');
  assert.match(html, /No AI model is configured, so items are grouped by the categories the group has voted for\./);
  assert.ok(!html.includes('drafted once an AI model is available'), 'the misleading copy is gone');

  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'd', saying: 's', items: ['issue:12'] }],
    { pending: true, pendingStage: 'placement', coverage: { total: 4, placed: 1, unplaced: 0, pending: 3 } });
  html = workshopHtml(AppView, 'all');
  assert.match(html, /placing new cards…/, 'pending placement on real categories says so');
  // The stamp has to sit inside `relStamp`'s relative window for that copy to
  // be the copy under test at all. Pinned here so a fixture that drifts out of
  // it fails as "the fixture went stale" rather than as a grouping bug — which
  // is how it read the first time, a week after the date was hardcoded.
  const REL_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;
  const stamp = Date.parse(themes([], {}).discoveredAt);
  assert.ok(Date.now() - stamp < REL_FLOOR_MS,
    'the fixture stamp is relative to now, not a wall-clock date that ages out');
  assert.match(APP_VIEW_SRC, /const REL_FLOOR_MS = 7 \* 24 \* 60 \* 60 \* 1000;/,
    'and that window is still seven days where relStamp defines it');
  assert.match(html, /Categories were drafted \d+[hd] ago and are re-drafted daily, or sooner when a tenth of the board changes\./);
  assert.match(html, /3 new cards are being placed\./);
  // The name is preceded by the theme's glyph now (#1787); the pin is still
  // on the COPY, which is what these four states are about.
  assert.match(html, /<div class="dev-ws-theme-name">(?:<span class="dev-ws-theme-icon[^>]*>[^<]*<\/span>)?Being placed<\/div>/);
  // The row's marker: the pseudo-theme is folded on a plain paint, so the
  // marker is pinned at the source, on the folded row.
  assert.match(FOLD, /\{row\.placing \? <span className="dev-ws-placing"[^>]*>placing…<\/span> : null\}/);
  assert.match(CSS, /\.dev-ws-placing \{/);

  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'd', saying: 's', items: ['issue:12'] }],
    { pending: true, pendingStage: 'discovery', unplaced: ['issue:13', 'session:34', 'session:78'], coverage: { total: 4, placed: 1, unplaced: 3, pending: 0 }, lastError: 'placement: boom' });
  html = workshopHtml(AppView, 'all');
  assert.match(html, /re-drafting categories…/, 'a pending discovery on real categories is a re-draft');
  assert.match(html, /3 cards did not fit a category and wait for the next draft\./);
  assert.match(html, /The last attempt failed \(placement: boom\); it is retried shortly\./);
  assert.match(html, /<div class="dev-ws-theme-name">(?:<span class="dev-ws-theme-icon[^>]*>[^<]*<\/span>)?Not yet grouped<\/div>/);
  assert.ok(!html.includes('dev-ws-placing'), 'declined cards wear no marker');
});

test('a workshop_update over the WS re-fetches past the throttle, for the open app only', async () => {
  let calls = 0;
  const AppView = makeAppView({
    fetch: async () => { calls++; return { ok: true, json: async () => ({ themes: [], source: 'ai', pending: false, coverage: { total: 0, placed: 0, unplaced: 0, pending: 0 }, unplaced: [] }) }; },
  });
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1);
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1, 'a fresh answer is not re-fetched inside the throttle');
  AppView.applyWorkshopUpdate({ appSlug: 'other-app', stage: 'placement' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1, 'another app\'s grouping is not this page\'s');
  AppView.applyWorkshopUpdate({ appSlug: 'demo-app', stage: 'placement' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2, 'the server wrote a grouping: fetch it now');
  assert.deepEqual(plain(AppView._workshopThemes.coverage), { total: 0, placed: 0, unplaced: 0, pending: 0 });
  // And the WS dispatch reaches it.
  const APP_SRC = read('public/js/app.js');
  assert.match(APP_SRC, /case 'workshop_update':\s*App\.handleWorkshopUpdate\(data\);/);
  assert.match(APP_SRC, /AppView\.applyWorkshopUpdate\(data\)/);
  const WS_SRC = read('src/services/ws.js');
  assert.match(WS_SRC, /function pushWorkshopUpdate\(data\) \{\s*broadcastGlobalScoped\(\{ type: 'workshop_update'/);
  assert.match(WS_SRC, /function pushSessionUpdate\(data\) \{[\s\S]*?noteBoardChange\(data\);\s*\}/, 'a session change reaches the board listeners');
  assert.match(WS_SRC, /function pushIssueUpdate\(data\) \{[\s\S]*?noteBoardChange\(data\);\s*\}/, 'and so does an issue change');
});

test('the theme poll follows a widening schedule that outlasts a full draft, then stops', async () => {
  // Haiku takes tens of seconds on a full board; four polls six seconds apart
  // gave up first and left the category grouping in place until the next
  // navigation.
  const total = AppView_pollTotal();
  assert.ok(total >= 120000, `the schedule must cover well over a minute, got ${total}ms`);
  assert.ok(total <= 5 * 60000, 'and stop within a few minutes');
  assert.match(APP_VIEW_SRC, /n < AppView\.WORKSHOP_POLL_MS\.length/, 'the poll count is the schedule length');
  assert.match(APP_VIEW_SRC, /AppView\.WORKSHOP_POLL_MS\[n\]/, 'and each wait reads its slot');

  const timers = [];
  let calls = 0;
  const AppView = makeAppView({
    fetch: async () => { calls++; return { ok: true, json: async () => ({ themes: [], source: 'category', pending: true, lastError: 'boom' }) }; },
    // Capture the scheduled waits instead of sleeping through them.
    setTimeout: (_fn, ms) => { timers.push(ms); return 0; },
  });
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1);
  assert.equal(AppView._workshopThemes.lastError, 'boom', 'the failure reason is carried');
  assert.deepEqual(timers, [AppView.WORKSHOP_POLL_MS[0]]);
  AppView._workshopThemes = null;
  await AppView._loadWorkshopThemes('demo-app', AppView.WORKSHOP_POLL_MS.length);
  assert.equal(calls, 2);
  assert.deepEqual(timers, [AppView.WORKSHOP_POLL_MS[0]], 'past the schedule, no further poll');
});

test('a board reload during a draft joins the running poll chain instead of starting another', async () => {
  // Every WS-driven _loadDevFeed lands at attempt 0. While a draft is pending
  // and a re-fetch is already scheduled, that call must not fetch again or
  // schedule a second chain — the themes endpoint rebuilds the server's
  // input on every GET, which is what the per-slug throttle exists to bound.
  const timers = [];
  let calls = 0;
  let nextId = 1;
  const AppView = makeAppView({
    fetch: async () => { calls++; return { ok: true, json: async () => ({ themes: [], source: 'category', pending: true }) }; },
    setTimeout: (_fn, ms) => { timers.push(ms); return nextId++; },
  });
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1);
  assert.equal(timers.length, 1);
  await AppView._loadWorkshopThemes('demo-app', 0);
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1, 'the reloads did not fetch again');
  assert.equal(timers.length, 1, 'and scheduled nothing');
  // The chain itself advances: the scheduled step clears the timer first.
  AppView._workshopPollTimer = null;
  await AppView._loadWorkshopThemes('demo-app', 1);
  assert.equal(calls, 2);
  assert.deepEqual(timers, [AppView.WORKSHOP_POLL_MS[0], AppView.WORKSHOP_POLL_MS[1]]);
  // A different app is never held back by this one's chain.
  AppView._workshopThemes = { ...AppView._workshopThemes, slug: 'other-app' };
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 3);
});

function AppView_pollTotal() {
  const m = APP_VIEW_SRC.match(/WORKSHOP_POLL_MS:\s*\[([^\]]+)\]/);
  assert.ok(m, 'WORKSHOP_POLL_MS is a literal array');
  return m[1].split(',').map((x) => parseInt(x.trim(), 10)).reduce((a, b) => a + b, 0);
}

test('an unfolded row is the Activity entry: the sheet, the card, the slot, the thread', () => {
  // The component unfolds from state, so pin the markup at the source: the
  // entry wrapper and its three children, in the order the feed drew them.
  const unfolded = FOLD.slice(FOLD.indexOf('function UnfoldedRow'), FOLD.indexOf('function voteSpecs'));
  assert.match(unfolded, /className="dev-feed-entry dev-ws-sheet"/, 'the sheet wrapper the feed used');
  assert.match(unfolded, /<DevCard model=\{card\} actionEnd=\{placement \? openBtn : undefined\} headEnd=\{<FoldMark open onClick=\{onFold\} \/>\} \/>/, 'the same card builder');
  // Minus the rail chevron: inside a fold a click on the card folds it, so the
  // Board's "this opens" mark would promise a destination the card no longer
  // has. Everything else on the model is the Board's, untouched.
  assert.match(unfolded, /const card: DevCardModel = \{ \.\.\.row\.card, rail: \{ \.\.\.row\.card\.rail, chevron: false \} \};/);
  assert.match(unfolded, /className="dev-feed-comments" data-comments-for=\{String\(row\.commentsFor\)\}/,
    'the GitHub slot, rendered empty for _fillFeedComments');
  assert.match(unfolded, /<FeedThread slug=\{slug\} type=\{row\.thread\.type\} refId=\{row\.thread\.ref\} canPost=\{canPost\} \/>/,
    'the app thread with its reply box');
  assert.ok(unfolded.indexOf('<DevCard') < unfolded.indexOf('dev-feed-comments')
    && unfolded.indexOf('dev-feed-comments') < unfolded.indexOf('<FeedThread'), 'in the feed\'s order');
  // And the module's fillers are re-run when the set of unfolded rows changes.
  assert.match(WORKSHOP, /callAppView\('_wireFeedComments', host\)/);
  assert.match(WORKSHOP, /callAppView\('_fillKudosHosts', host\)/);
});

test('the open sheet is a DIRECT child of the wrapper, the way the check selects it', () => {
  // The declared check reads
  //
  //   #dev-workshop .dev-ws-rowwrap-open > .dev-feed-entry
  //     > .gc-vote-item.dev-card-dense[data-edge] ~ .dev-feed-thread ...
  //
  // and the two `>` in it are the whole point of this test. Hanging the
  // close-on-click handler on a plain <div> wrapped around the sheet is a
  // one-line change that renders identically, reviews as harmless and breaks
  // that selector — it did, on the first submission of #1787's third round.
  // The source-text test above cannot see it, because the extra element is in
  // CardRowView and not in UnfoldedRow. So resolve the spine against the real
  // markup instead: nothing may sit between the wrapper, the sheet and the
  // card.
  // #4486: the checks read it on the board with its cards open, which is
  // where a card is drawn unfolded now (By category unfolds nothing).
  const AppView = makeAppView();
  seed(AppView);
  AppView._getWorkshopGroup = () => 'stage';
  AppView._cardsOpen = () => true;
  AppView._workshopShot = 'feed-comments';

  const els = tokenize(workshopHtml(AppView, 'all')).filter((t) => t.kind === 'open');
  const classOf = (t) => {
    const a = (t.attrs || []).find((x) => x.name.toLowerCase() === 'class');
    return a ? String(a.value).split(/\s+/) : [];
  };
  const attr = (t, n) => (t.attrs || []).some((x) => x.name.toLowerCase() === n);

  const i = els.findIndex((t) => classOf(t).includes('dev-ws-rowwrap-open'));
  assert.ok(i >= 0, 'the capture deep link opens a row');

  const sheet = els[i + 1];
  assert.ok(classOf(sheet).includes('dev-feed-entry'),
    'the sheet is the wrapper\'s first child, with no element between them');

  const card = els[i + 2];
  assert.ok(classOf(card).includes('dev-card-dense'),
    'and the Board\'s dense card is the sheet\'s first child');
  assert.ok(attr(card, 'data-edge'), 'still carrying its state edge');

  // The fold is the other half: while a row is open its compressed form is
  // not drawn at all, so nothing can match `.dev-ws-rowwrap-open .dev-ws-row`.
  const inside = els.slice(i + 1).findIndex((t) => classOf(t).includes('dev-ws-rowwrap'));
  const end = inside === -1 ? els.length : i + 1 + inside;
  assert.ok(!els.slice(i, end).some((t) => classOf(t).includes('dev-ws-row')),
    'the compressed row is gone while the card is up');
});

test('the Workshop\'s inline comments clamp a long one at four lines (#2556)', () => {
  const AppView = makeAppView();
  const long = AppView._feedCommentsHtml([
    { author: 'alice', body: 'short one', createdAt: at(1) },
    { author: 'bob', body: 'word '.repeat(400), createdAt: at(1) },
  ]);
  // The clamp wraps the author AND the body, because the body renders inline
  // after the name on this surface — see the rule in app.css.
  assert.equal((long.match(/class="dev-feed-comment-clamp"/g) || []).length, 2,
    'every comment in the tail is clamped, long or short');
  assert.match(long, /<span class="dev-feed-comment-clamp">\s*<span class="dev-feed-comment-author">alice/);
  // The control ships hidden: only `_clampFeedComments` has a laid-out box,
  // and a comment that fits in four lines never gets one at all.
  assert.equal((long.match(/class="dev-feed-comment-toggle [^"]+" aria-expanded="false" hidden>Show more<\/button>/g) || []).length, 2);
  // The age still lands outside the clamp, where the #1585 check looks.
  assert.match(long, /<\/span>\s*<span class="dev-feed-comment-time"/);
});

test('the sheet CSS moved host with the entry, and the Workshop has its own', () => {
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => /^\s*(\.dark\s+)?#dev-feed\b/.test(l));
  assert.deepEqual(rules, [], 'no rule is scoped to the retired #dev-feed');
  assert.match(CSS, /:is\(#dev-workshop, #dev-kanban\) \.dev-feed-entry \{/);
  // #1884: the thread and the comment tail are scoped to BOTH card hosts now,
  // so the same card opened on the Board reads the same as on the Workshop.
  // `:is()` takes its specificity from its most specific argument, so the rule
  // still weighs what it did when the id stood alone.
  assert.match(CSS, /:is\(#dev-workshop, #dev-kanban\) \.dev-feed-thread \{/);
  assert.match(CSS, /:is\(#dev-workshop, #dev-kanban\) \.dev-feed-comments:empty \{ display: none; \}/);
  // The bottom is `--ws-gap` now, not 12px: it is the same air the sticky rail
  // rests on, so the gap under the bar is identical whether the lander fills
  // the scroller (rail at its bottom edge, padding decides) or overflows it
  // (rail stuck, `bottom` decides). At 12 against 8 they differed by 4px
  // depending on the tab. The sides are unchanged.
  assert.match(CSS, /#dev-body:has\(> #dev-workshop\) \{ padding: 8px 4px var\(--ws-gap, 8px\); \}/);
  assert.match(CSS, /\.dev-ws-theme-head \{/);
  assert.match(CSS, /\.dev-ws-row \{/);
});

// ── modes, routes, the strip, the checks ─────────────────────────────

test('workshop replaced feed as a mode, and the retired names resolve onto it', () => {
  const AppView = makeAppView();
  assert.deepEqual(plain(AppView.VIEW_MODES), ['workshop']);
  assert.equal(AppView._migrateViewMode('feed'), 'workshop');
  assert.equal(AppView._migrateViewMode('list'), 'workshop');
  // 'pm' and 'report' were board-shaped and resolved to the Board; the Board
  // mode has retired in turn, so the chain ends at the one mode left — as does
  // 'kanban' itself, which is what a viewer who last left the Dev screen on
  // the Board still has stored.
  assert.equal(AppView._migrateViewMode('pm'), 'workshop');
  assert.equal(AppView._migrateViewMode('report'), 'workshop');
  assert.equal(AppView._migrateViewMode('kanban'), 'workshop');
  assert.equal(AppView._getViewMode(), 'workshop', 'the default on every width');
  assert.ok(!APP_VIEW_SRC.includes('_rerenderFeed()'), 'the feed renderer is gone');
  assert.ok(!APP_VIEW_SRC.includes('_feedView()'), 'and its view model');
  assert.match(APP_VIEW_SRC, /_rerenderWorkshop\(\)/);
});

test('the Workshop is a menu row, and an anchor at its route (#2761)', () => {
  assert.match(SHEET_TSX, /id="app-menu-row-workshop"\s+dataContextRow="workshop"/);
  assert.match(SHEET_TSX, /href=\{slug \? `#app\/\$\{encodeURIComponent\(slug\)\}\/workshop` : '#'\}/);
  assert.ok(!SHEET_TSX.includes('data-context-row="activity"'), 'the Activity segment retired');
  assert.ok(!/data-context-row="board"|dataContextRow="board"/.test(SHEET_TSX),
    'and the Board segment after it — the Workshop and the kanban are one '
    + 'screen in two layouts, so the layout is not a destination in the menu');
  assert.match(SHEET_TSX, /label="Go to community"/);
});

test('the declared checks cover the lander, its strips and an unfolded row', () => {
  const byName = (re) => dapp.tests.find((t) => re.test(t.name || ''));
  const lands = byName(/Workshop tab holds All items' number tiles/);
  assert.ok(lands && lands.expectSelector.includes('#dev-workshop'));
  // Extended rather than added: the manifest keeps 20 of its 580 slots clear
  // and was already at that working ceiling, so a new entry would have failed
  // the check-count guard. Same intent, one level deeper.
  assert.match(lands.expectSelector, /\[data-ws-dash-cell="open"\]/);
  // The chain follows the figures' ORDER, so a reshuffle cannot pass it
  // silently: open, then unclaimed beside it, with shipped further along.
  assert.match(lands.expectSelector,
    /\[data-ws-dash-cell="open"\] \+ \[data-ws-dash-cell="unclaimed"\] ~ \[data-ws-dash-cell="shipped"\]/);
  // The summary cards ride the ROUTE check rather than a slot of their own:
  // the manifest keeps 20 of its 580 clear and was already at that working
  // ceiling, so a new entry would fail the check-count guard in
  // tests/proposal-tests-manifest.test.js. Deepening the check that already
  // owns "this route lands on the lander" is the same claim, further in.
  //
  // What it pins moved with the feature, twice. It was the three windows
  // in order, all drawn at once; then `open` alone with the step back above
  // it. `open` is not a window at all now — it is the pane's lead line,
  // outside the walk — so the gate selects THAT. It is the right thing to
  // pin either way: it is the one sentence the pane always shows, and
  // asserting anything inside the walk would mean scripting a press in a
  // check that can only select.
  //
  // A PLAIN CHAIN, deliberately. The `:has()` note below is not about that
  // one selector — it is the standing rule for this manifest, learned from
  // six straight gate failures against a selector that resolved perfectly in
  // this repo's own Chromium.
  const route = byName(/Workshop tab leads All items with its one line/);
  assert.ok(route && /\[data-ws-dashboard\] > \[data-ws-open-line\]/
    .test(route.expectSelector), 'the lead line is what the gate can select');
  assert.ok(!route.expectSelector.includes(':has('), 'no :has() on a gate that blocks merge');
  assert.match(route.expectSelector, /#dev-workshop \[data-ws-dashboard\] > \[data-ws-open-line\]$/);
  // THE PAGE'S ORDER (5 Oct 2026): All items, then the approval rules, then
  // your work. The notices panel rode the line's check while it sat above
  // All items; a plain chain only steps forward, so it rides the approval
  // rules' check now, as the sibling straight after them. The staging demo
  // gives it a Friday card and a setting changed (services/app-notices.js).
  const rules = byName(/The Workshop tab leads with All items, then the approval rules/);
  assert.ok(rules, 'the order is a declared check');
  assert.match(rules.expectSelector,
    /> \.dev-ws-tabbody > \[data-ws-dashboard\]:first-child \+ \[data-ws-approval-rules\]:has\(> ol\[data-ws-community-rule\] > li\.dev-ws-rule-step \+ li\.dev-ws-rule-join \+ li\[data-ws-rule-people\]\) \+ \[data-ws-notices\]$/);
  // #4457: the rule is drawn as its three steps, read off the card.
  assert.equal(rules.expectText, 'It goes live', 'and the rule itself is on the page');
  const work = byName(/Your work stays on screen when it is empty/);
  assert.match(work.expectSelector,
    /\.dev-ws-tabbody > \[data-ws-approval-rules\] ~ \[data-ws-mine\] \[data-ws-lane="mine"\] > \[data-ws-mine-empty\]$/,
    'your work comes after the approval rules');
  assert.ok(!work.expectSelector.includes(':has('), 'a plain chain');

  const themesCheck = byName(/renders its themes in #dev-workshop/);
  assert.ok(themesCheck && /\.dev-ws-wrow\.dev-ws-brow:not\(:has\(\.dev-ws-wrow-tile, \[data-attr-field="category"\]\)\)/.test(themesCheck.expectSelector),
    'its items the board\u2019s rows, no tile and no category chip (#4486)');
  const demo = byName(/A demo theme names the mock rows/);
  assert.ok(demo && demo.expectSelector.includes('[data-ws-theme="demo-voting"]'));
  // The vote gate rides the Needs-you tab now, which `?ws=` reaches — the
  // platform's own rule for a screen that is otherwise behind a tap.
  const votes = byName(/Needs-you tab is a feed of one decision per screen/);
  assert.ok(votes && /\[data-ws-needs\] > \[data-ws-rail\] > button\[data-ws-rail-btn="vote"\]/.test(votes.expectSelector));
  assert.match(votes.path, /[?&]ws=needs/, 'and the URL names the tab');
  const unfolded = byName(/the board draws each as the Activity sheet/);
  assert.ok(unfolded && /shot=feed-comments/.test(unfolded.path), 'the unfolded-card checks ride the capture deep link');
  assert.match(unfolded.path, /[?&]group=stage&cards=open&/, 'on the board with its cards open (#4486)');
  // NOT extended with a `:has()` for the Open card toggle, though it was
  // once. That selector resolves in this repo's own Chromium against the
  // component's real markup — verified — and failed 6 of 6 runs on the
  // proposal gate, where the plain chain around it had passed for two
  // rounds. The difference was never reproduced here, and a gate that
  // blocks merge is the wrong place to keep a selector nobody can explain.
  // The toggle is pinned against rendered markup in this file instead.
  assert.ok(!unfolded.expectSelector.includes('data-ws-open-card'));

  // The preview moved to the facts line and then back to the action band —
  // at its right end, just before the hamburger — and the declared check
  // moved with it each time. This is the sweep that was missed the first time: the unit
  // tests for the new position were all updated and dapp.json was not, so
  // the gate found it instead.
  const preview = byName(/Preview is a labelled pill/);
  assert.ok(preview, 'the board still pins where the preview lives');
  assert.match(preview.expectSelector, /\.gc-card-actions > \.gc-vote-btn-preview:not\(\.gc-vote-btn-icon\) \+ \.dev-card-menu-btn\[data-card-menu\]:last-child/);
  for (const t of dapp.tests) {
    assert.ok(!/dev-card-status-end[^,]*gc-vote-btn-preview/.test(t.expectSelector || ''),
      `${t.name}: no check still looks for the preview on the facts line`);
    assert.ok(!/#dev-(kanban|body)[^,]*gc-explore-chat-btn/.test(t.expectSelector || ''),
      `${t.name}: nor for Explore on a card face`);
  }
  // #2761: the App | Workshop strip retired to a plain "Go to workshop" row,
  // so the order check and the board route's "never blank" check went with
  // the segmented control they were about. What replaced them pins the row.
  const row = byName(/offers the Workshop as a plain row/);
  assert.ok(row && /#app-menu-row-workshop/.test(row.expectSelector)
    && !/board/.test(row.expectSelector),
    'the Workshop is a row in the menu, with no Board beside it');
  assert.ok(!byName(/marks Workshop on the board route/),
    'no check pins a selected segment the menu no longer has');
  // A PLAIN CHAIN, for the reason this file gives above: `:has()` resolved
  // perfectly in this repo's own Chromium and failed 6 of 6 runs on the gate.
  assert.ok(!row.expectSelector.includes(':has('),
    'no :has() on a gate that blocks merge');
  for (const t of dapp.tests) {
    assert.ok(!/#dev-feed\b/.test(t.expectSelector || ''), `${t.name}: no check selects the retired #dev-feed`);
  }
});

// A check that names ONE card's text cannot ride the lander's route.
// ThemeCard draws its lanes only while it is unfolded, and DevWorkshop
// unfolds exactly the first theme, so at most a quarter of the board's cards
// are in the DOM here. Which quarter is not fixed either: the staging demo
// grouping deals the real items round-robin into four themes
// (services/workshop-themes.js) and sortThemes puts whichever of them has the
// most distinct people first, both of which move as the board moves.
//
// So such a check passes or fails by the hour rather than by the diff. #1704
// moved thirty-seven board-card checks onto #app/<slug>/board for exactly
// this reason and left five behind; two of them ("Shared demo session renders
// in the In progress area" and "Shared session cards show the owner
// subtitle") passed on #1704 and #1709 and were red on #1623 and #1710 with
// the same manifest. The Board's In-progress column renders every card, which
// is what all five names describe.
test('no declared check asserts a card\'s text at the lander\'s own route', () => {
  const lander = /^\/\?demo=1#app\/[\w-]+\/(dev|workshop)$/;
  const offenders = dapp.tests
    .filter((t) => lander.test(t.path) && t.expectText && !t.expectSelector)
    .map((t) => `${t.name} (${t.path})`);
  assert.deepEqual(offenders, [],
    'these assert one card\'s text where only the first theme\'s rows render — address the Board route');
});

// ── The grouping tabs: the same board, two ways ──────────────────────────
//
// The eyebrow here used to be a bare "12 themes" — a count of a grouping
// the viewer had no say in. These cover the control it became, and the one
// thing that makes the stage pane cheap: it renders the SAME <DevKanban/> the
// Board view mode does, from the same published view model, so nothing about
// the board is re-derived or duplicated.

test('the grouping is a two-tab control, and category is what an untouched Workshop shows', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
  ]);
  assert.equal(AppView._getWorkshopGroup(), 'category');
  const html = workshopHtml(AppView, 'all');
  const cat = html.indexOf('data-ws-group="category"');
  const stage = html.indexOf('data-ws-group="stage"');
  assert.ok(cat > 0 && stage > cat, 'both tabs render, category first');
  assert.match(html.slice(cat, cat + 400), /aria-selected="true"/,
    'the category tab is the selected one by default');
  assert.ok(html.includes('By category') && html.includes('By stage'), 'the labels');
  // The tabs sit UNDER the general discussion and the summary strip, which is
  // the whole arrangement: those are facts about the app, not about how you
  // are sorting it, so they do not move when the pane does.
  assert.ok(html.indexOf('data-ws-dashboard') < cat,
    'the summary strip is above the tabs');
  // ...and the category pane is unchanged: its own sort chips and its themes.
  assert.ok(html.includes('dev-ws-themes'), 'the theme list still renders');
  assert.ok(html.includes('dev-ws-sort-opts'), 'and its sort chips');

  // NO TITLE LINE IN THE HEAD. It used to open with an "All items" eyebrow,
  // on the argument that the tabs named the CHOICE without naming what the
  // choice was being made about. The selected TAB says it — it is the thing
  // reading "All items", one line above — so the eyebrow was the same word
  // twice and the head leads with the tools now.
  assert.ok(!html.includes('dev-ws-pane-eyebrow'), 'the eyebrow is gone');
  assert.ok(!/\.dev-ws-pane-eyebrow/.test(CSS), 'and so is the rule that styled it');
  // THE STRIP LEADS THE PANE HEAD AT EVERY WIDTH (#852). It used to leave
  // the head above 768px for an "ear" on the pane's right shoulder; the ear
  // is gone, so the narrow render the suite draws (node has no `matchMedia`)
  // is the one every width shows: the strip, then the tools.
  // #4486: in ONE ROW with the page's way back and its name, which lead it.
  assert.match(html, /class="dev-ws-pane-head"><div class="dev-ws-allbar" data-ws-allbar=""><div class="dev-ws-pagehead" data-ws-pagehead="">[\s\S]*?<h2 class="dev-ws-pagehead-title">All items<\/h2><\/div><\/div><div class="dev-ws-group"[\s\S]*?<\/div><div id="dev-actions"/);
  assert.ok(!html.includes('dev-ws-pagehead-over'), 'and no "Workshop" eyebrow over the name');
  // The declared checks run at the capture's 1280px viewport, so they now
  // gate on the same arrangement: nothing names an ear any more.
  assert.ok(
    !dapp.tests.some((t) => /data-ws-ear/.test(t.expectSelector || '')),
    'no declared check names the ear',
  );
  assert.ok(
    dapp.tests.some((t) => /\.dev-ws-pane-head > \.dev-ws-allbar > \[data-ws-pagehead\]:first-child \+ \.dev-ws-group\[role="tablist"\]/.test(t.expectSelector || '')),
    'one names the strip after the page\u2019s way back in the head\u2019s one row',
  );
  assert.ok(
    dapp.tests.some((t) => /\.dev-ws-allbar:not\(:has\(\.dev-ws-pagehead-over, \.dev-ws-eyebrow\)\) > \.dev-ws-group \+ #dev-actions/
      .test(t.expectSelector || '')),
    'and one names the tools straight after it, with no title line',
  );

  // The sort row's eyebrow leads with the count of NAMED categories —
  // "Not yet grouped" is a holding pen, not one of them. (This fixture's
  // themes are shaped for the tab assertions above and name no drawable
  // card, so the count here is 0; the singular/plural agreement is pinned
  // in the test below, against a board that has one.)
  const sort = html.slice(html.indexOf('class="dev-ws-sort"'), html.indexOf('dev-ws-themes'));
  assert.match(sort, /class="dev-ws-eyebrow">\d+ categor/);
});

test('the sort row reports the state of the grouping after the count', () => {
  // The second half of that eyebrow: the part the list under it cannot say
  // for itself. Appended to the count, one clause per thing to report.
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = { ...themes([{ id: 't', name: 'T', items: ['issue:12'] }]), source: 'category' };
  assert.match(workshopHtml(AppView, 'all'), /class="dev-ws-eyebrow">1 category · grouped by category for now</);
  AppView._workshopThemes = { ...themes([{ id: 't', name: 'T', items: ['issue:12'] }]), pending: true };
  assert.match(workshopHtml(AppView, 'all'), /class="dev-ws-eyebrow">1 category · re-drafting categories…</);
  AppView._workshopThemes = {
    ...themes([{ id: 't', name: 'T', items: ['issue:12'] }]), pending: true, pendingStage: 'placement',
  };
  assert.match(workshopHtml(AppView, 'all'), /class="dev-ws-eyebrow">1 category · placing new cards…</);
});

test('"By stage" swaps the pane for the board\'s own columns, and keeps everything above it', () => {
  const store = { devWorkshopGroup: 'stage' };
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
  ]);
  assert.equal(AppView._getWorkshopGroup(), 'stage');
  const html = workshopHtml(AppView, 'all');
  // The board, rendered INSIDE the Workshop — the same node ids the standalone
  // Board mode draws, because it is the same component.
  assert.ok(html.includes('id="dev-kanban"'), 'the board renders in the pane');
  assert.ok(html.includes('data-ws-stage'), 'inside the stage wrapper');
  const stage = html.indexOf('data-ws-group="stage"');
  assert.match(html.slice(stage, stage + 400), /aria-selected="true"/,
    'and the stage tab is the selected one');
  // The category pane is GONE, not merely hidden: two groupings of one board
  // on screen at once is the thing the tabs exist to stop.
  assert.ok(!html.includes('dev-ws-themes'), 'no theme list under the stage tab');
  assert.ok(!html.includes('dev-ws-sort-opts'), 'and no category sort chips');
  // The tiles and the discussion used to sit above this pane on the same
  // scroll, and the assertion here was that switching grouping did not cost
  // them. They are a TAB of their own now — the lander's three destinations
  // are the bar at the bottom — so what has to hold is that the grouping
  // choice is a control WITHIN one destination and does not move you off it.
  assert.ok(!html.includes('data-ws-dashboard'), 'the status strip is the Workshop page\'s');
  assert.match(html, /data-ws-band=""[\s\S]*?data-ws-tab-btn="workshop" aria-selected="true"[\s\S]*?data-ws-allbar=""/,
    'and you are still on All items: the Workshop tab lit, the page\'s way back in the head under it (#852, #4486)');
});

test('the stage pane is the SAME board component, not a second one', () => {
  const AppView = makeAppView({ localStorage: { devWorkshopGroup: 'stage' } });
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
  ]);
  // Rendered standalone (the Board view mode) and nested (the stage pane), the
  // columns are byte-identical — so every card action, the mobile column tabs
  // and the filter bar work on both without a line of their own.
  const nested = workshopHtml(AppView, 'all');
  const standalone = kanbanHtml(AppView);
  const board = standalone.slice(standalone.indexOf('<div id="dev-kanban"'));
  assert.ok(board.length > 200, 'the standalone board rendered something');
  assert.ok(nested.includes(board), 'the nested pane contains it verbatim');
  // And the source says so: one import of the board component, no re-derived
  // columns of the Workshop's own.
  assert.match(WORKSHOP, /import \{ DevKanban, StageStrip, syncStrip \} from '\.\.\/card\/dev-kanban'/);
});

test('the board view model is built only for the pane that shows it', () => {
  // `_kanbanView()` buckets, orders and filters every card on the board.
  // Doing that on every Workshop repaint for a pane nobody is looking at is
  // the regression this guards.
  const src = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _rerenderWorkshop()'));
  const body = src.slice(0, src.indexOf('\n  _fmtCountdown('));
  const call = body.indexOf('AppView._kanbanView()');
  assert.ok(call > 0, '_rerenderWorkshop publishes the board');
  const guard = body.lastIndexOf("if (group === 'stage')", call);
  assert.ok(guard > 0 && guard < call, 'behind the stage guard');
  // Published BEFORE the Workshop mounts: the board draws from inside the
  // Workshop's tree, so a store still holding the previous board would paint
  // one frame of it.
  assert.ok(call < body.indexOf('react.mountWorkshop('),
    'and published before the mount');
});

test('the tabs are no longer additive: the Board view mode retired onto them', () => {
  // The #1995-era decision was that the grouping tabs were ADDITIVE and the
  // standalone board was untouched, and this test existed because "the next
  // change to this screen is the one that would quietly drop the standalone
  // board". That change is this one, and it is not quiet: the stage pane
  // renders the same <DevKanban/> from the same published view model, so the
  // Board view mode was a second surface for something the lander contains.
  assert.match(APP_VIEW_SRC, /VIEW_MODES: \['workshop'\]/, 'one dev view mode');
  assert.ok(!/VIEW_MODES: \['workshop', 'kanban'\]/.test(APP_VIEW_SRC),
    'the Board mode is gone from the list, not merely unreachable by default');
  assert.match(APP_VIEW_SRC, /kanban: 'workshop'/,
    'and a stored preference naming it migrates rather than being forgotten');
  assert.ok(!/data-context-row="board"|dataContextRow="board"/.test(SHEET_TSX),
    'the app menu offers no Board destination');
  // WHAT IS NOT REMOVED. The columns, the route and the old deep link all
  // still resolve — onto the stage pane — and the standalone surface's own
  // code is still here, now unreachable, to be swept separately rather than
  // torn out alongside a routing change.
  assert.match(APP_VIEW_SRC, /body\.innerHTML = '<div id="dev-kanban-board"><\/div>'/);
  assert.match(APP_VIEW_SRC, /body\.innerHTML = '<div id="dev-workshop"><\/div>'/);
  assert.match(APP_VIEW_SRC, /_overrideWorkshopGroup\(group\) \{/,
    'the retired board ROUTE has a landing');
  const board = dapp.tests.find((t) => /board resolves onto the stage pane/.test(t.name || ''));
  assert.ok(board && /\[data-ws-stage\]/.test(board.expectSelector),
    'and a declared check proves that landing draws the columns');
});

test('the grouping preference lasts, and an unknown stored value is category', () => {
  const store = {};
  const AppView = makeAppView({ localStorage: store });
  AppView._setWorkshopGroup('stage');
  assert.equal(store.devWorkshopGroup, 'stage', 'persisted, and to localStorage');
  assert.equal(AppView._getWorkshopGroup(), 'stage');
  AppView._setWorkshopGroup('nonsense');
  assert.equal(AppView._getWorkshopGroup(), 'category', 'an unknown mode falls back');
  store.devWorkshopGroup = 'themes';
  assert.equal(AppView._getWorkshopGroup(), 'category', 'and so does an unknown stored one');
});

test('a retired Board preference opens on the columns, not on the categories', () => {
  // The other half of retiring the Board VIEW MODE. RETIRED_VIEW_MODES stops a
  // stored 'kanban' naming a mode that no longer exists — but on its own it
  // forgets what the viewer actually chose, which was the COLUMNS, and hands
  // them the categories instead. The three board-shaped values therefore open
  // on the stage pane.
  for (const mode of ['kanban', 'pm', 'report']) {
    const AppView = makeAppView({ localStorage: { devViewMode: mode } });
    assert.equal(AppView._getViewMode(), 'workshop', `${mode} migrates to the one mode left`);
    assert.equal(AppView._getWorkshopGroup(), 'stage', `${mode} still opens on the columns`);
  }
  // The Workshop's own predecessors get its own default pane: those viewers
  // never chose columns.
  for (const mode of ['feed', 'list', 'workshop']) {
    const AppView = makeAppView({ localStorage: { devViewMode: mode } });
    assert.equal(AppView._getWorkshopGroup(), 'category', `${mode} lands on the lander`);
  }
  // A grouping the viewer actually chose outranks the migration — it is read
  // first, so the migration only ever fills a gap.
  const chosen = makeAppView({
    localStorage: { devViewMode: 'kanban', devWorkshopGroup: 'category' },
  });
  assert.equal(chosen._getWorkshopGroup(), 'category');
  // READ-TIME, like every other migration here: nothing is written back, so
  // the day they pick a pane that choice is what persists.
  const store = { devViewMode: 'kanban' };
  const fresh = makeAppView({ localStorage: store });
  assert.equal(fresh._getWorkshopGroup(), 'stage');
  assert.ok(!('devWorkshopGroup' in store), 'the migration stores nothing');
});

test('reaching the retired Board takes BOTH answers: the All items tab and the stage pane', () => {
  // THE BUG THIS GUARDS, which cost a full round of the merge gate. Those
  // columns are the `stage` grouping OF THE `all` TAB. A first attempt set the
  // grouping alone — and the lander then opens on its DEFAULT tab, where the
  // grouping control is not rendered at all, so the pane never mounts and all
  // 69 declared checks that select #dev-kanban on a board route failed at once.
  // Every way in has to supply both halves, and the test above proves that
  // ('all', 'stage') is what puts the board's own markup on screen verbatim.
  const at = (o) => {
    const A = makeAppView(o);
    return [A._workshopTab(), A._getWorkshopGroup()].join('/');
  };
  const loc = (search) => ({
    location: { search, hash: '', href: `http://localhost/${search}` },
  });

  // 1. The route alias, driven exactly as app.js's restoreFromHash drives it.
  const route = makeAppView({ localStorage: {} });
  route._overrideWorkshopTab('all');
  route._overrideWorkshopGroup('stage');
  assert.equal([route._workshopTab(), route._getWorkshopGroup()].join('/'),
    'all/stage', '#app/<slug>/board');

  // 2. The retired deep link, which named one thing and meant two.
  assert.equal(at(loc('?view=kanban')), 'all/stage', '?view=kanban');

  // 3. The stored preference of somebody who last left the Dev screen on it.
  for (const mode of ['kanban', 'pm', 'report']) {
    assert.equal(at({ localStorage: { devViewMode: mode } }), 'all/stage', mode);
  }

  // ...and none of those three may drag anybody else onto the board.
  assert.equal(at({ localStorage: {} }), 'status/category', 'the lander default');
  assert.equal(at({ localStorage: { devViewMode: 'feed' } }), 'status/category',
    'the Workshop replaced feed: that viewer never chose columns');

  // The parameters still being offered, and the viewer's own taps, outrank
  // every hop above — each half independently.
  assert.equal(at(loc('?view=kanban&ws=needs')), 'needs/stage', 'an explicit tab wins');
  assert.equal(at(loc('?view=kanban&group=category')), 'all/category', 'an explicit pane wins');
  assert.equal(at({
    localStorage: { devViewMode: 'kanban', devWorkshopTab: 'needs', devWorkshopGroup: 'category' },
  }), 'needs/category', 'and choices they have actually made win over the migration');
});

test('the grouping strip is the lander\'s own tab control, not a second vocabulary', () => {
  // Two tab strips two rows apart on one screen. They were drawn in two
  // vocabularies: the bar above in a raised track with a periwinkle selected
  // pill, this one in a recessed `--dc-strip` rail with a hairline and a
  // selected half painted in the plain sheet with a drop shadow. The geometry
  // already agreed (round rail, 2px between the halves) — only the colour did
  // not, which is the half a reader actually sees.
  assert.match(CSS, /\.dev-ws-group \{[^}]*border-radius: 999px/);
  assert.match(CSS, /\.dev-ws-group \{[^}]*background: var\(--dc-sheet-raise\)/,
    'the same track surface as .dev-ws-tabtrack');
  const track = /\.dev-ws-group \{([^}]*)\}/.exec(CSS);
  assert.ok(track, 'the rail rule exists');
  assert.ok(!/box-shadow/.test(track[1]), 'and no ring around it, as the bar has none');
  // THE SELECTED HALF IS THE BAR'S OWN THREE TOKENS, so the two controls
  // cannot drift apart the next time either is tuned. The bar spends them
  // across two rules since #2063 — the ink on the selected tab, the fill and
  // the hairline on the marker that slides between them — and this strip
  // paints all three on the selected half itself. That difference is
  // deliberate and is the whole of it: a two-state switch has neither the
  // measuring machinery the sliding marker needs nor a use for it.
  const on = /\.dev-ws-group-tab\[aria-selected="true"\] \{([^}]*)\}/.exec(CSS);
  const barOn = /\.dev-ws-tab\[aria-selected="true"\] \{([^}]*)\}/.exec(CSS);
  const marker = /\.dev-ws-tab-marker \{([^}]*)\}/.exec(CSS);
  assert.ok(on && barOn && marker, 'all three rules exist');
  assert.ok(on[1].includes('color: var(--lit-ink)'));
  assert.ok(barOn[1].includes('color: var(--lit-ink)'), 'which is the bar\'s own ink');
  for (const decl of ['background: var(--lit-tint)', 'box-shadow: inset 0 0 0 1px var(--lit-line)']) {
    assert.ok(on[1].includes(decl), `the grouping tab carries \`${decl}\``);
    assert.ok(marker[1].includes(decl), 'and so does the marker, which is where it comes from');
  }
  assert.ok(!/var\(--dc-sheet\)/.test(on[1]), 'the plain-sheet fill is gone');
  // WHAT STAYS DIFFERENT IS THE WIDTH, and that is the real distinction from
  // the sort chips a row below: full width of the reading column, split
  // evenly. `flex: 1 1 0`, not `1 1 auto` — on `auto` the halves would be
  // sized by their labels, so "By category" would take more than "By stage".
  assert.match(CSS, /\.dev-ws-group-tab \{[^}]*flex: 1 1 0/);
  assert.ok(!/\.dev-ws-group \{[^}]*align-self: flex-start/.test(CSS),
    'and the rail itself is not shrunk to its content');
  // A token that does not resolve is a silently wrong colour, not an error —
  // and inside a box-shadow list one bad var() voids the whole declaration.
  for (const token of ['--dc-sheet-raise', '--lit-tint', '--lit-ink', '--lit-line',
    '--text-muted', '--text-primary']) {
    assert.ok(CSS.includes(`${token}:`), `${token} is defined`);
  }
});

test('?group=stage is a deep link to the pane, and a tap retires it', () => {
  const store = {};
  const AppView = makeAppView({
    localStorage: store,
    location: { search: '?group=stage', hash: '', href: 'http://localhost/?group=stage' },
  });
  assert.equal(AppView._getWorkshopGroup(), 'stage', 'the URL wins over the empty preference');
  // The preference still wins once the viewer states one — otherwise ?group=
  // would keep overriding every later tap, which is the bug `_setViewMode`
  // already carries a comment about.
  AppView._setWorkshopGroup('category');
  assert.equal(AppView._getWorkshopGroup(), 'category', 'a tap retires the override');
  assert.equal(store.devWorkshopGroup, 'category');
  // A junk value is not a pane. The retired spelling 'category' IS one — it
  // resolves to 'category' — but 'lanes' was never a grouping.
  const junk = makeAppView({ location: { search: '?group=lanes', hash: '', href: 'http://x/' } });
  assert.equal(junk._getWorkshopGroup(), 'category');
});

test('what app.css reads off the page\'s hosts is a class, never a :has() that looks inside them', () => {
  // Three facts decide how the hosts are laid out: the board is up, the Needs
  // tab is up, there is a band. app.css used to ask for each with a `:has()`
  // on the host, on rules that go on to pick what is INSIDE it. Asked that
  // way the answer can change with any node added anywhere under the host,
  // so the browser re-applied the stylesheet to everything the rule could
  // reach after every such write. Measured on this repository's own board
  // with every card open (October 2026): 43 passes over about 9,000 elements
  // in one load, 2.9 of the 3.1 seconds the page spent on style.
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const gone of [
    '#dev-workshop:has(.dev-ws-board)',
    '#dev-workshop:has(.dev-ws[data-ws-tab="needs"])',
    '#dev-forum-scroll:not(:has(.dev-ws-band))',
  ]) {
    assert.ok(!rules.includes(gone), `${gone} is a class on the host now`);
  }
  // The general form of the same mistake, on the three nodes that hold the
  // board. `:has(> …)` is fine and stays: it only ever looks at children, so
  // a comment written into a card cannot change its answer.
  assert.doesNotMatch(rules, /#dev-(?:forum-scroll|body|workshop)(?::not\()?:has\(\s*[^>\s]/,
    'a :has() on a board host starts with the child combinator, or is a class instead');

  // The Workshop says so itself, on nodes it does not render: classList in a
  // layout effect, so the classes are right before the frame is shown.
  const cls = (name) => {
    const m = WORKSHOP.match(new RegExp(`const ${name} = '([a-z-]+)';`));
    assert.ok(m, `workshop.tsx names ${name}`);
    return m[1];
  };
  const board = cls('HOST_HAS_BOARD');
  const needs = cls('HOST_ON_NEEDS');
  const band = cls('SCROLLER_HAS_BAND');
  assert.match(WORKSHOP, /const workshop = el\.closest\('#dev-workshop'\);\s*if \(workshop\) \{\s*workshop\.classList\.toggle\(HOST_HAS_BOARD, board\);\s*workshop\.classList\.toggle\(HOST_ON_NEEDS, needs\);\s*\}/);
  assert.match(WORKSHOP, /const scroller = el\.closest\('#dev-forum-scroll'\);\s*if \(scroller\) scroller\.classList\.toggle\(SCROLLER_HAS_BAND, band\);/);
  // AS EARLY AS THE COMMIT ALLOWS. Putting a class on a host is one pass over
  // everything under it. A layout effect on the Workshop runs after the layout
  // effects of the cards the same commit mounted, and their first measurement
  // has already drawn the board; the class then drew it a second time (9,000
  // elements, 72ms, measured). An insertion effect runs before every layout
  // effect of the commit, so the first pass already has the class. The root
  // is not attached on the very first mount, which the layout effect covers.
  assert.match(WORKSHOP, /import \{[^}]*\buseInsertionEffect\b[^}]*\} from 'react';/);
  assert.match(WORKSHOP, /useInsertionEffect\(\(\) => \{\s*syncWorkshopHosts\(hostRef\.current, band, board, needs\);\s*\}, \[hostRef, band, board, needs\]\);\s*useLayoutEffect\(\(\) => \{\s*syncWorkshopHosts\(hostRef\.current, band, board, needs\);\s*\}, \[hostRef, band, board, needs\]\);/);
  // ...and takes them off on the way out, in an effect of its own so that a
  // tab change does not remove and re-add them.
  assert.match(WORKSHOP, /return \(\) => \{\s*if \(workshop\) workshop\.classList\.remove\(HOST_HAS_BOARD, HOST_ON_NEEDS\);\s*if \(scroller\) scroller\.classList\.remove\(SCROLLER_HAS_BAND\);\s*\};\s*\}, \[hostRef\]\);/);
  // What each one means. The skeleton has no band, no board and no tab; the
  // board is the All items page read by stage and nothing else draws one.
  assert.match(WORKSHOP, /useWorkshopHostState\(\s*hostRef,\s*!v\.loading,\s*!v\.loading && tab === 'all' && group === 'stage',\s*!v\.loading && tab === 'needs',\s*\);/);
  assert.match(WORKSHOP, /\{group === 'stage' \? \(\s*<div className="dev-ws-board"/, 'the pane the class stands for');

  // The stylesheet reads exactly those three, with the weight the `:has()`
  // forms had (a `:has()` weighs what its argument weighs). The one
  // exception is the column's release on Needs, which now weighs what the
  // board's release always has; `#dev-workshop { max-width: 760px }` is the
  // only rule either has to beat.
  assert.equal(board, 'dev-ws-has-board');
  assert.equal(needs, 'dev-ws-on-needs');
  assert.equal(band, 'dev-ws-has-band');
  assert.match(rules, /#dev-workshop\.dev-ws-on-needs \{ max-width: none; \}/);
  assert.match(rules, /#dev-workshop\.dev-ws-on-needs > \.dev-ws\[data-ws-tab="needs"\] > :not\(\.dev-ws-tabbody\) \{/);
  assert.match(rules, /#dev-forum-scroll:not\(\.dev-ws-has-band\) > \* \{/);
  // The scroller outlives a body that is replaced without unmounting the
  // Workshop, so the pull asks again as it starts (tests/community-hub.test.js
  // pins the call); the class it writes is the one the Workshop writes.
  assert.match(APP_VIEW_SRC, /devScroll\.classList\.toggle\('dev-ws-has-band', !!band\);/);
});

test('the stage pane runs edge to edge, and not by a 100vw full-bleed', () => {
  // #dev-workshop is a 760px reading column, which is right for one-line
  // rows and wrong for four side-by-side columns: bounded there the board is
  // a horizontal scroller before it is a board.
  assert.match(CSS, /#dev-workshop \{ max-width: 760px/, 'the column bound exists');
  assert.match(CSS, /#dev-workshop\.dev-ws-has-board \{ max-width: none; \}/,
    'and comes off when the board is up');
  // ...and goes back on to every OTHER child, so only the working PANE widens
  // — the toolbar, the tabs and the board travel together now, so the pane is
  // the unit that grows rather than the board wrapper inside it.
  //
  // IT HAS TO REACH THROUGH THE TAB BODY, and that is the bug this pins. The
  // rule once bound every direct child of `.dev-ws` except the pane; the tabs
  // put the pane one level deeper, inside `.dev-ws-tabbody`, so the bound
  // landed on the WRAPPER and the board was cramped to the reading column
  // from outside it. Measured at 1440: the pane stayed 760 while `.dev-ws`
  // itself had already widened to 1432, which is the shape of a bound applied
  // one level too high. Both halves are asserted, because dropping either
  // brings it back — the first for the rail and anything else that stays a
  // direct child, the second for the pane inside the body.
  assert.match(CSS,
    /#dev-workshop\.dev-ws-has-board > \.dev-ws > :not\(\.dev-ws-tabbody\),/);
  assert.match(CSS,
    /#dev-workshop\.dev-ws-has-board > \.dev-ws > \.dev-ws-tabbody > :not\(\.dev-ws-pane\) \{[^}]*max-width: 760px/);
  // Widening it must not DISSOLVE it. An earlier cut stripped the pane's sheet,
  // radius and padding on By stage, on the argument that a card face is a
  // frame drawn around the whole window; what that produced was the pane
  // vanishing and the sticky head's fill left behind as a bare rectangle over
  // the controls alone, with the board below belonging to no pane at all.
  const stageRules = CSS.slice(CSS.indexOf('#dev-workshop.dev-ws-has-board { max-width: none; }'),
    CSS.indexOf('.dev-ws-sort {'));
  assert.ok(!/\.dev-ws-pane \{[^}]*(border-radius: 0|background: none|padding: 0)/.test(stageRules),
    'the pane keeps its card face at every width');
  // The rejected alternative, pinned so it does not come back: 100vw counts
  // the scrollbar #dev-forum-scroll always has, so a negative-margin
  // full-bleed overflows by its width and adds a horizontal scrollbar.
  // Comments stripped first — the block explains WHY 100vw was rejected, and
  // the prose naming it is not the declaration this forbids.
  const block = CSS.slice(CSS.indexOf('.dev-ws-group {'), CSS.indexOf('.dev-ws-sort {'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\d+vw/.test(block), 'no viewport-width full-bleed declaration');
  // #dev-body drops to 4px of side padding for the Workshop, which reads as
  // a clipped edge once the board spans the window: 4 + 8 restores the 12px
  // the standalone board gets from #dev-body's own px-3.
  // The bottom is `--ws-gap` now, not 12px: it is the same air the sticky rail
  // rests on, so the gap under the bar is identical whether the lander fills
  // the scroller (rail at its bottom edge, padding decides) or overflows it
  // (rail stuck, `bottom` decides). At 12 against 8 they differed by 4px
  // depending on the tab. The sides are unchanged.
  assert.match(CSS, /#dev-body:has\(> #dev-workshop\) \{ padding: 8px 4px var\(--ws-gap, 8px\); \}/);
  assert.match(CSS, /\.dev-ws-board \{ padding: 2px 8px 0; \}/);
});

// ── The working pane: the controls, the switch, and what they act on ─────

test('the toolbar renders inside the Workshop pane, above the tabs', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
  ]);
  const html = workshopHtml(AppView, 'all');
  const pane = html.indexOf('data-ws-pane');
  const head = html.indexOf('dev-ws-pane-head');
  const actions = html.indexOf('id="dev-actions"');
  const tabs = html.indexOf('data-ws-group="category"');
  const themesList = html.indexOf('dev-ws-themes');
  assert.ok(pane > 0, 'the pane renders');
  assert.ok(pane < head && head < tabs, 'the sticky head is the pane’s first child');
  // THE TABS LEAD. They decide what the search is searching, so the control
  // that sets the scope comes before the one that acts within it; the other
  // way round the pane had to be read bottom-up.
  assert.ok(tabs < actions, 'the tab strip sits above the toolbar');
  assert.ok(actions < themesList, 'and both above what they act on');
  // The control the toolbar exists for: the search and the filters.
  assert.ok(html.includes('id="dev-kanban-filterbar"'), 'the filter host comes with it');
  // NOT the "+", which rode at the end of this row, then closed the tab
  // strip, and is the hub hero's ⋯ now. All items draws none of its own.
  assert.ok(!html.includes('id="dev-plus-btn"'), 'the ⋯ is the hub\'s, not the toolbar\'s');
  // Everything ABOVE the pane stays outside it: those strips are facts about
  // the app, not things the search narrows.
  assert.ok(html.indexOf('data-ws-dashboard') < pane, 'the summary strip is above the pane');
  assert.ok(html.indexOf('data-discussion-row') < pane, 'and so is the discussion');
});

test('a search that matches nothing keeps the pane on screen, with the search box in it (#2090)', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't1', name: 'Voting', items: ['issue:12'] }]);
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'nothing matches this' };
  const v = AppView._workshopView();
  assert.equal(v.themes.length, 0, 'no theme has a row left to draw');
  assert.equal(v.meta.filtered, true);
  const html = workshopHtml(AppView, 'all');
  // THE PANE STAYS. It was gated on having a theme to draw, so a search that
  // matched nothing unmounted the whole pane — the grouping tabs, the "+",
  // and the toolbar whose host the search field lives in. The one control
  // that could undo the search left the screen with the rows, and the viewer
  // was stuck on a board they could not widen back out.
  assert.ok(html.includes('data-ws-pane'), 'the pane renders');
  assert.ok(html.includes('id="dev-actions"'), 'with its toolbar');
  assert.ok(html.includes('id="dev-kanban-filterbar"'), 'and the host the search box fills');
  assert.ok(html.includes('data-ws-tab-btn="workshop"'), 'and the project\'s tabs above it');
  assert.ok(html.includes('data-ws-group="category"'), 'and the grouping tabs');
  // The rows' place says why they are gone, UNDER the controls it is about.
  assert.match(html, /data-ws-empty=""[^>]*>Nothing here matches the current search and filters\./);
  assert.ok(html.indexOf('id="dev-actions"') < html.indexOf('data-ws-empty'), 'beneath the toolbar');
  assert.ok(html.indexOf('dev-ws-pane-body') < html.indexOf('data-ws-empty'), 'in the pane body');
  // And nothing pretends there is a list: no sort row over an empty list, no
  // "0 categories", no footnote about how they were drafted.
  assert.ok(!html.includes('dev-ws-sort'), 'no sort row');
  assert.ok(!html.includes('dev-ws-themes'), 'no empty theme list');
  assert.ok(!html.includes('dev-ws-foot-note'), 'no grouping footnote');
  // Widen the search back out and the list is back, the note gone.
  AppView._kanbanFilters = AppView._defaultKanbanFilters();
  const back = workshopHtml(AppView, 'all');
  assert.ok(back.includes('dev-ws-themes'), 'the themes return');
  assert.ok(!back.includes('data-ws-empty'), 'and the note goes');
  // The declared check runs this state in a browser: the pane opened already
  // narrowed to a search nothing matches, through `?q=` (app-view.js, where
  // the seed is consumed on the first load so it can never hold a cleared
  // search). The note is what proves the search applied — without it the box
  // alone would pass on a pane the URL never narrowed.
  const check = dapp.tests.find((t) => /[?&]q=/.test(t.path || ''));
  assert.ok(check, 'a declared check opens the pane narrowed by ?q=');
  assert.match(check.path, /[?&]ws=all\b/, 'on All items');
  assert.match(check.expectSelector, /\[data-ws-pane\] > \.dev-ws-pane-head #dev-actions #dev-kanban-filterbar #dev-kanban-search$/,
    'and expects the search box, in the pane head');
  assert.equal(check.expectText, 'Nothing here matches the current search and filters.');
});

// ── #2915: the search and filters are All items' alone ──────────────────
//
// The search box and the filters are drawn in All items' pane head and
// nowhere else, but they used to narrow every card before the view model
// was built, so a search typed there quietly followed the viewer to Current
// status ("open items" 146 → 2, "waiting on votes" untouched) and Needs you,
// neither of which has a search box to say why. They narrow All items alone
// now, and a dot on that tab says a search is waiting there.

test('#2915: a search narrows All items, and leaves Current status and Needs you whole', () => {
  const store = {};
  // A baseline, so "since your last visit" has rows to lose.
  store[`${'workshopSeen'}:demo-app`] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 'look', name: 'Look', items: ['issue:12', 'session:34', 'session:78'] },
    { id: 'keys', name: 'Keys', items: ['issue:13'] },
  ]);
  const whole = AppView._workshopView();
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'nothing matches this' };
  const v = AppView._workshopView();

  // ALL ITEMS is narrowed, exactly as before: nothing left to group.
  assert.equal(v.meta.filtered, true);
  assert.equal(v.themes.length, 0, 'All items\' themes are what the search kept');
  assert.equal(whole.themes.length, 2);

  // CURRENT STATUS is the app's, whatever All items is searched for: the
  // tiles, the categories behind them, the unclaimed, the since list and the
  // suggestion are the same numbers and rows with the search on and off.
  assert.deepEqual(plain(v.dashboard), plain(whole.dashboard), 'the dashboard is untouched');
  assert.equal(v.dashboard.open, 3);
  assert.equal(v.dashboard.themes, 2, 'every category counts, not only the ones the search left');
  assert.equal(v.dashboard.unclaimed, 2);
  assert.ok(whole.since && whole.since.total > 0, 'the fixture has a since list to lose');
  assert.deepEqual(plain(v.since), plain(whole.since), '"since your last visit" is untouched');
  assert.equal(v.nextUp && v.nextUp.key, whole.nextUp.key);
  assert.deepEqual(plain(v.nextMore.map((r) => r.key)), plain(whole.nextMore.map((r) => r.key)));
  assert.equal(v.discussion && v.discussion.key, 'discussion');
  assert.equal(v.emptyNote, null, 'and no "nothing here" note: the board has plenty');

  // NEEDS YOU: the whole queue, votes and claims alike.
  assert.deepEqual(plain(v.queue.map((r) => r.key)), plain(whole.queue.map((r) => r.key)));
  assert.ok(v.queue.some((r) => r.kind === 'claim'), 'the unclaimed issues are still asked about');

  // Drawn: the hub and the Workshop tab blame no search, and the Workshop
  // tab has its tiles; All items says why it is empty, under the controls
  // that emptied it.
  const status = workshopHtml(AppView, 'status');
  const workshop = workshopHtml(AppView, 'workshop');
  assert.ok(workshop.includes('data-ws-dashboard'), 'the Workshop tab draws the dashboard');
  assert.doesNotMatch(status + workshop, /data-ws-empty/, 'and no empty note over either');
  assert.match(workshopHtml(AppView, 'all'), /data-ws-empty=""[^>]*>Nothing here matches the current search and filters\./);
});

test('#2915: while a search or filter is on, a dot on the way to All items says so, from everywhere but All items', () => {
  const AppView = makeAppView();
  seed(AppView);
  for (const tab of ['status', 'workshop', 'needs', 'all']) {
    assert.doesNotMatch(workshopHtml(AppView, tab), /data-ws-filtered/, `${tab}: no dot without a search`);
  }
  // Any of the filters, not only the search: a quick toggle counts too. It
  // rides the Workshop tab (#852: All items is the Workshop's page, reached
  // by its See all) and that See all, the two ways to the page it narrows,
  // and leaves while All items itself is up, where the search box says so.
  for (const over of [{ q: 'dark' }, { assignedToMe: true }, { priority: 'high' }]) {
    AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), ...over };
    for (const tab of ['status', 'needs', 'workshop']) {
      assert.match(workshopHtml(AppView, tab), /data-ws-tab-btn="workshop"[^>]*><span class="dev-ws-ctab-text"><span class="dev-ws-ctab-label">Workshop<\/span><span class="dev-ws-filter-dot" data-ws-filtered="" aria-hidden="true"><\/span><\/span><span class="sr-only"> \(filtered\)<\/span>/,
        `${tab} / ${JSON.stringify(over)}: the dot on the Workshop tab, and its words`);
    }
    const ws = workshopHtml(AppView, 'workshop');
    assert.match(ws, /data-ws-all-open="">See all<span class="dev-ws-filter-dot" data-ws-filtered="" aria-hidden="true"><\/span><span class="sr-only"> \(filtered\)<\/span>/,
      `workshop / ${JSON.stringify(over)}: on See all`);
    assert.doesNotMatch(workshopHtml(AppView, 'all'), /data-ws-filtered/, 'not while All items is up');
  }
  // Cleared, it goes.
  AppView._kanbanFilters = AppView._defaultKanbanFilters();
  assert.doesNotMatch(workshopHtml(AppView, 'status'), /data-ws-filtered/);
  // The accent, a 6px round.
  assert.match(CSS, /\.dev-ws-filter-dot \{ flex: none; width: 6px; height: 6px; border-radius: 999px; background: var\(--accent\); \}/);
});

test('the tabs are a band in the community\'s colour, not the old pill: nothing slides', () => {
  // The hub and the Workshop were two tabs under a segmented control with a
  // sliding marker, and then no tabs at all. #852 brings back four (Hub,
  // Discussion, Needs you, Workshop) as a band under the coloured header,
  // with an underline rather than a marker; All items is the Workshop's page.
  assert.doesNotMatch(WORKSHOP, /useTabMarker|data-ws-tab-marker|role="tablist" aria-label="Workshop sections"/);
  assert.match(WORKSHOP, /<ProjectBand\s+tab=\{tab\}\s+owed=\{owed\}/);
  assert.ok(!/dev-ws-pagebar/.test(WORKSHOP),
    'All items has no back bar of its own: its way back is in its pinned head (#4486)');
  const band = read('frontend/src/features/dev-board/workshop/project-band.tsx');
  assert.match(band, /className="dev-ws-tabs dev-ws-band"/, 'and so does the band');
  assert.match(band, /<div className="dev-ws-tabtrack" role="tablist" aria-label="Project"/);
});

test('#2915: declared checks open the Workshop page and the hub with a search on', () => {
  const searched = (tab) => dapp.tests.filter((t) => new RegExp(`[?&]ws=${tab}\\b`).test(t.path || '') && /[?&]q=/.test(t.path || ''));
  const whole = searched('workshop').find((t) => /\[data-ws-dashboard\]/.test(t.expectSelector || ''));
  assert.ok(whole, 'a check opens the Workshop tab narrowed by ?q=');
  assert.match(whole.expectSelector, /\.dev-ws\[data-ws-tab="workshop"\]:not\(:has\(\[data-ws-empty\]\)\)/,
    'and expects no "nothing here" note on it');
  const dot = searched('status').find((t) => /data-ws-filtered/.test(t.expectSelector || ''));
  assert.ok(dot, 'and one expects the dot on the Workshop tab from the hub');
  assert.match(dot.expectSelector, /\.dev-ws\[data-ws-tab="status"\] \[data-ws-band\] \[data-ws-tab-btn="workshop"\] \[data-ws-filtered\]/);
});

test('an empty board still gets the All items pane, and the note names the ⋯ and where it is', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._ghIssues = [];
  AppView._proposals = [];
  AppView._merged = [];
  AppView._mergedTotal = 0;
  const v = AppView._workshopView();
  assert.equal(v.themes.length, 0);
  assert.deepEqual(plain(v.emptyNote), { loadFailed: false, filtered: false });
  const html = workshopHtml(AppView, 'all');
  assert.ok(html.includes('data-ws-pane'), 'the pane renders');
  assert.ok(html.includes('id="dev-kanban-filterbar"'), 'with the toolbar');
  assert.match(html, /data-ws-empty=""[^>]*>Nothing on the board yet\. Press <span[^>]*>⋯<\/span> on the hub /,
    'the ⋯ is the hub\'s, so the note says where');
  assert.doesNotMatch(html, /Nothing here matches/, 'no filter is on, so it does not blame one');
  // The status tab keeps its own copy of the note, over the strips.
  const status = workshopHtml(AppView, 'status');
  assert.match(status, /data-ws-empty=""[^>]*>Nothing on the board yet\. Press /);
  assert.ok(!status.includes('data-ws-pane'), 'and no pane: that is the All items tab');
  // BUG g, the first half: the note told the viewer to press a "+" that was
  // not on screen. On the hub the ⋯ it names is in the hero above it (drawn
  // once the community record has answered, which this render has not).
  assert.match(WORKSHOP, /menu=\{\(\s*<DevPlusMenu[\s\S]*?inHero\b[\s\S]*?\/>\s*\)\}/, 'the ⋯ the note names is the hub hero\'s');
  assert.doesNotMatch(status, /Press <span[^>]*>⋯<\/span> on the hub/, 'so on the hub it does not say where');
});

test('bug g: the empty-board note says what the ⋯ holds, and sends "make one yourself" to its Build it now', () => {
  // The second half: "Press + to propose a change or file an issue". The "+"
  // has had no propose row since New change moved to Improve (#1490) and
  // then to the Homeroom menu's New change button — an owner decision
  // (#2740 review) this does not undo. So the note names the "+"'s real rows.
  // "Make one yourself" went to the Homeroom menu's Start a new change, then
  // to the ⋯'s own Build it now once the menu's row showed only for
  // somebody who has had an agent session (first-session run-through, 5 Oct
  // 2026): the ⋯ has it for every writer the note is shown to.
  const ROW = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.match(ROW, /\{readOnly \? null : \([\s\S]*?data-plus="new-change"[\s\S]*?title="Build it now"/,
    'the ⋯ carries Build it now for every writer');
  const empty = (over) => {
    const AppView = makeAppView();
    seed(AppView);
    AppView._ghIssues = [];
    AppView._proposals = [];
    AppView._merged = [];
    AppView._mergedTotal = 0;
    Object.assign(AppView, over || {});
    return AppView;
  };
  const NOTE = (tail) => new RegExp(`data-ws-empty=""[^>]*>Nothing on the board yet\\. Press <span[^>]*>⋯<\\/span>${tail}<\\/div>`);
  // The ⋯'s own row, named in the same sentence as the ⋯.
  const START = '; to make one yourself, use Build it now there\\.';

  // ALL ITEMS, where no banner offers New change: the whole sentence, and
  // where the ⋯ is, since it is the hub's.
  const fresh = empty();
  const all = workshopHtml(fresh, 'all');
  assert.doesNotMatch(all, /propose a change/, 'no promise of a propose row the "+" does not have');
  assert.match(all, NOTE(` on the hub to suggest an improvement${START}`), "a writer's note: the ⋯ suggests an improvement");
  withDevActions({ canCollaborate: true }, () => {
    assert.match(workshopHtml(fresh, 'all'), NOTE(` on the hub to suggest an improvement or import a PR${START}`),
      "a collaborator's ⋯ also imports a PR, so the note says so");
  });

  // CURRENT STATUS on an app nobody has started: #2573's banner leads the tab
  // with its own New change, so the note stops at the "+" rather than sending
  // the reader to a menu for the button just above it.
  const status = workshopHtml(fresh, 'status');
  assert.match(status, /data-ws-start-here-btn=""[^>]*>Start a new change</, 'the banner offers Start a new change');
  assert.match(status, NOTE(' to suggest an improvement\\.'), 'and the note under it names the ⋯ alone');
  assert.doesNotMatch(status, /propose a change/);
  // ...and "What you are working on", on the Workshop tab beside it, states
  // the fact alone too: the board has no open item to pick up, and New
  // change is the banner's.
  assert.match(workshopHtml(fresh, 'workshop'), /data-ws-mine-empty="">You have no work going on\.<\/p>/);
  // With no banner — an app with a history the page has not loaded rows for —
  // the status tab's note says the whole thing too.
  const finished = empty({ _mergedTotal: 3 });
  const bare = workshopHtml(finished, 'status');
  assert.ok(!bare.includes('data-ws-start-here'), 'no banner on an app that has shipped');
  assert.match(bare, NOTE(` to suggest an improvement${START}`));

  // Nothing sends a writer to the Homeroom menu's row, which a newcomer
  // does not have.
  for (const html of [all, status, bare]) assert.doesNotMatch(html, /Homeroom menu/);
  // A read-only viewer's "+" holds Fork alone and their menu has no New
  // change, so there is nothing to press: the note states the fact.
  withDevActions({ readOnly: true }, () => {
    for (const html of [workshopHtml(fresh, 'all'), workshopHtml(fresh, 'status'), workshopHtml(finished, 'status')]) {
      assert.match(html, /data-ws-empty=""[^>]*>Nothing on the board yet\.<\/div>/, 'the read-only note');
      assert.doesNotMatch(html, /Homeroom menu/, 'and no door the reader cannot open');
    }
  });
  // Both notes are one component, so the two tabs cannot drift apart, and the
  // banner's condition is written once, for the banner and the note alike.
  assert.equal((WORKSHOP.match(/'Nothing on the board yet\. Press '/g) || []).length, 1);
  assert.match(WORKSHOP, /\{startHere \? <StartHereBanner \/> : null\}/);
  assert.match(WORKSHOP, /<EmptyNote\s+filtered=\{!!v\.emptyNote\.filtered\}\s+loadFailed=\{v\.emptyNote\.loadFailed\}\s+underStartHere=\{startHere\}\s+onHub\s*\/>/);
});

test('exactly one surface draws the toolbar, so its ids stay unique', () => {
  // #dev-actions, #dev-plus-btn and #dev-plus-menu are ids. Two copies on
  // screen would break _wirePlusMenu, which looks both up by getElementById.
  const FRAME = read('frontend/src/features/dev-board/board-frame.tsx');
  assert.match(FRAME, /mode === 'workshop' \? null : \(\s*<DevActionsRow/,
    'the frame draws none on the Workshop');
  assert.match(WORKSHOP, /<DevActionsRow/, 'and the Workshop draws its own');
  // ...WITHOUT its "+": the Workshop's row passes `withPlus={false}`, and the
  // Workshop draws the "+" once, in its tab strip. Two "+"s on one screen
  // would be two #dev-plus-btn.
  assert.match(WORKSHOP, /<DevActionsRow[^>]*withPlus=\{false\}/, 'the pane-head row carries no "+"');
  assert.equal((WORKSHOP.match(/<DevPlusMenu\b/g) || []).length, 1, 'the strip draws the one "+"');
  // Neither file spells the markup itself any more.
  const ACTIONS = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.match(ACTIONS, /id="dev-actions"/, 'the markup has one home');
  assert.ok(!FRAME.includes('id="dev-actions"'), 'not the frame');
  assert.ok(!WORKSHOP.includes('id="dev-actions"'), 'and not the Workshop');
});

// ── The "+" closes the view-tab strip ────────────────────────────────────
//
// Current status · Needs you · All items · +, on every tab of an app's
// Workshop. The prototype's `wsTabs` ends its `.tabs` row with a `.tplus`
// holding Add and Manage, and the spec says "a plus at the end of the tab
// strip". The product kept the old board "+" at the end of All items' search
// row, so two of the three tabs had no way to file an issue or reach the
// app's settings, while their empty-state notes pointed at it.

/** The hero, drawn after the community read has answered (fetch stubbed). */
async function heroWithMenu(menuProps, over) {
  const card = loadTsx('frontend/src/features/dev-board/workshop/community-card.tsx');
  const row = loadTsx('frontend/src/features/dev-board/actions-row.tsx');
  const payload = {
    slug: 'garden', name: 'Garden', member_count: 12, is_member: true, is_creator: false,
    audience: 'open', audience_label: 'Public community', members: [{ id: 1, username: 'ada' }],
    channel: null, activity: null,
    approval: { policy: 'anyone', approvals_required: null, electorate: 12, required: 5 }, ...(over || {}),
  };
  const prev = { fetch: globalThis.fetch, window: globalThis.window };
  globalThis.fetch = async () => ({ ok: true, json: async () => payload });
  globalThis.window = { AppView: { _plusMenuShowsMembers: () => true } };
  try {
    await card.reloadCommunity('garden');
    return renderToHtml(createElement(card.CommunityCard, {
      slug: 'garden', name: 'Garden',
      menu: createElement(row.DevPlusMenu, {
        selfHosted: false, readOnly: false, canCollaborate: true, showsMembers: true, inHero: true, ...(menuProps || {}),
      }),
    }));
  } finally {
    globalThis.fetch = prev.fetch;
    if (prev.window === undefined) delete globalThis.window; else globalThis.window = prev.window;
  }
}

test('the ⋯ is the hub hero’s: once, at the end of its actions, and no page draws another', async () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
  ]);
  // The "+" closed a tab strip on every tab. The strip is gone: the ⋯ is the
  // project's own menu, on the project's own card, and a page has only its
  // way back.
  for (const tab of ['workshop', 'needs', 'all']) {
    assert.ok(!workshopHtml(AppView, tab).includes('id="dev-plus-btn"'), `${tab}: no ⋯ of its own`);
  }
  const html = await heroWithMenu({ onLeave: () => {}, appName: 'Garden' });
  assert.match(html,
    /<div class="dev-ws-hero-row"><div class="dev-ws-hero-actions">[\s\S]*?data-ws-community-invite=""[^>]*>Invite<\/button><div class="dev-ws-plus ?"><button id="dev-plus-btn"/,
    'Invite, then the ⋯, ending the actions');
  assert.equal(html.split('id="dev-plus-btn"').length - 1, 1, 'one ⋯');
  // The menu comes with it, leading with the ask, then Settings & rules.
  assert.match(html, /id="dev-plus-menu"[\s\S]*?data-plus="issue"[\s\S]*?>Suggest an improvement<[\s\S]*?data-plus-group="settings"/);
  // #4045: no Joined across from them; Leave is a row of the ⋯.
  assert.doesNotMatch(html, /data-ws-community-leave=""|class="dev-ws-hero-member"/);
  assert.match(html, /id="dev-plus-menu"[\s\S]*?data-plus="leave"[^>]*>[\s\S]*?>Leave Garden</);
  // The same props the toolbar row reads, from the same store, so the gates
  // (import on canCollaborate, the members row, Fork for a read-only viewer)
  // are the ones the menu always had.
  assert.match(WORKSHOP,
    /menu=\{\(\s*<DevPlusMenu\s+illustrationApp=\{actions\.illustrationApp\}\s+canManageIllustration=\{actions\.canManageIllustration\}\s+selfHosted=\{actions\.selfHosted\}\s+readOnly=\{actions\.readOnly\}\s+canCollaborate=\{actions\.canCollaborate\}\s+showsMembers=\{actions\.showsMembers\}\s+inHero\b[\s\S]*?onMakePrivate=\{canMakePrivate\(community\)[\s\S]*?onMakePublic=\{canMakePublic\(community\)[\s\S]*?onLeave=\{canLeave\(community\)[\s\S]*?\/>\s*\)\}/);
  assert.equal((WORKSHOP.match(/<DevPlusMenu\b/g) || []).length, 1, 'rendered in one place on this surface');
});

test('a read-only viewer of the self-hosted app gets no ⋯', async () => {
  // The menu would be empty (no board writes, and the platform is not
  // forkable), so the wrapper is hidden outright, as it always was.
  const html = await heroWithMenu({ readOnly: true, selfHosted: true, canCollaborate: false });
  assert.match(html, /<div class="dev-ws-plus hidden"><button id="dev-plus-btn"/);
});

test('the ⋯ is drawn as Invite’s pill, a circle, and its menu hangs over the cards', () => {
  const decls = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  // Invite's fill (`pillNeutral`), on the button itself, as a 32px circle.
  assert.match(ACTIONS_ROW, /const HERO_BTN_CLS = 'dev-ws-plus-btn dev-ws-plus-btn-hero un-touch-target '\s*\+ 'bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100';/);
  assert.match(ACTIONS_ROW, /className=\{inHero \? HERO_BTN_CLS : 'dev-ws-plus-btn un-touch-target'\}/, 'still a 44px hit box');
  assert.match(decls, /\.dev-ws-hero \.dev-ws-plus-btn \{ width: 32px; height: 32px; \}/);
  // A ⋯, not a "+": on the hub it holds the project's settings as much as
  // anything to add, and a "+" beside Invite read as "add a member".
  assert.match(ACTIONS_ROW, /<EllipsisHorizontalIcon className="dev-ws-plus-glyph" aria-hidden="true" \/>/);
  assert.ok(!/PlusIcon/.test(ACTIONS_ROW), 'no plus glyph');
  // Open, it wears the lit tint and ring, as before.
  assert.match(decls,
    /\.dev-ws-plus-btn\[aria-expanded="true"\] \{\s*background: var\(--lit-tint\);\s*box-shadow: inset 0 0 0 1px var\(--lit-line\);\s*\}/);
  // The violet filled square is gone from the component.
  assert.ok(!ACTIONS_ROW.includes('bg-violet-600'), 'no primary fill on the ⋯');
  // The dropdown hangs 8px under it, opening leftward from the row's end,
  // and the hero lifts over the cards under it while it is open.
  assert.match(ACTIONS_ROW, /id="dev-plus-menu"\s+className="hidden absolute right-0 top-full mt-2 z-30 w-64 /);
  assert.match(decls, /\.dev-ws-hero:has\(#dev-plus-menu:not\(\.hidden\)\) \{ position: relative; z-index: 5; \}/);
  assert.match(decls, /\.dev-ws-plus \{ position: relative; flex: none; display: flex; \}/,
    "the dropdown's containing block, never squeezed");
});

test('#2934: the "+" is a round button of its own, a small gap after the tab pill', () => {
  // #2914 put the "+" INSIDE the pill as its last cell, and it read as a
  // fourth tab. The owner kept its row, place and behaviour and asked for a
  // visible gap, so the pill's material moved from the box that held both
  // onto each of them: the tab list is the pill, the "+"'s wrapper is a
  // circle, and the row between them is air. No node moved (the markup
  // assertions above and dapp.json's selectors still hold).
  const decls = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

  // THE PHONE. The nav is a row: position and gap, no surface of its own.
  const rail = /\n\.dev-ws-tabs \{([\s\S]*?)\n\}/.exec(decls);
  assert.ok(rail, 'the rail rule exists');
  assert.match(rail[1], /display: flex; gap: 6px;/, 'a 6px gap between the pill and the "+"');
  assert.ok(!/background|border|padding|backdrop-filter/.test(rail[1]),
    'the nav draws nothing, or the gap would be filled in');
  // Both items wear what the nav used to: a 4px ring, the hairline, the fill
  // and the round ends, so the "+" is as tall as the pill (1 + 4 + 40 + 4 + 1).
  const surface = /\n\.dev-ws-tablist, \.dev-ws-tabtrack > \.dev-ws-plus \{([\s\S]*?)\n\}/.exec(decls);
  assert.ok(surface, 'the tab list and the "+" share one surface rule');
  // Scoped to the strip's "+": the unreachable Board renders the same
  // wrapper at the end of `#dev-actions`, and that surface stays as it was.
  assert.match(decls, /\n\.dev-ws-plus \{ position: relative; flex: none; display: flex; \}/,
    'the bare wrapper rule draws nothing');
  assert.match(surface[1], /padding: 4px;/);
  assert.match(surface[1], /border-radius: 999px;/);
  assert.match(surface[1], /border: 1px solid var\(--app-sheet-line\);/);
  assert.match(surface[1], /background-color: var\(--dc-sheet-fill\);/);
  // NO FROST on the tab list: a backdrop-filter would make it a stacking
  // context, and the marker, painted before it at z-index 0, would go under
  // its fill.
  assert.ok(!/backdrop-filter/.test(surface[1]), 'the tab list must not become a stacking context');

  // A WIDE WINDOW. The track only lines the two up, 6px apart; each draws the
  // raised sheet in a 2px ring, so the pill stays 36px and the "+" is a
  // 36px circle beside it.
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  const wideDecls = wide[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(wideDecls, /\.dev-ws-tabtrack \{\s*display: inline-flex; align-items: center; gap: 6px;\s*\}/);
  const wideSurface = /\n  \.dev-ws-tablist, \.dev-ws-tabtrack > \.dev-ws-plus \{([\s\S]*?)\n  \}/.exec(wideDecls);
  assert.ok(wideSurface, 'restated at this width');
  assert.match(wideSurface[1], /padding: 2px;/);
  assert.match(wideSurface[1], /border: 0;/, 'no hairline, as the track had none');
  assert.match(wideSurface[1], /background-color: var\(--dc-sheet-raise\);/);

  // The marker still measures against the nav: the surface rules position
  // nothing. (The "+"'s wrapper is positioned by its own rule, as the
  // dropdown's containing block, and holds no tab.)
  assert.ok(!/position/.test(surface[1]) && !/position/.test(wideSurface[1]),
    'the surfaces add no containing block of their own');
});

test('while the "+" menu is open the strip outranks the pane head, and only then', () => {
  // The dropdown hangs out of the strip over the tab body, and the strip is a
  // stacking context (sticky wide, frosted narrow), so the menu's own z-30
  // counted only inside it: the pinned pane head painted over its rows on
  // All items. Measured before this rule, every row's centre hit the head.
  const decls = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(decls, /\.dev-ws-tabs:has\(#dev-plus-menu:not\(\.hidden\)\) \{ z-index: 32; \}/);
  const headZ = Number(/#dev-workshop \.dev-ws-pane-head \{[^}]*z-index: (\d+)/.exec(decls)[1]);
  assert.ok(32 > headZ, 'above the head while open');
  // At rest nothing raises the strip: the head keeps its place above it.
  const raised = [...decls.matchAll(/([^{}]*\.dev-ws-tabs[^{}]*)\{[^}]*z-index: (\d+)/g)]
    .filter((m) => /\.dev-ws-tabs(?![-\w])/.test(m[1]) && Number(m[2]) >= 31);
  assert.deepEqual(raised.map((m) => m[1].trim()), ['.dev-ws-tabs:has(#dev-plus-menu:not(.hidden))'],
    'the one rule that lifts the strip past the head is the open-menu rule');
});

test('the "+" is re-wired when the toolbar changes surface', () => {
  // _wirePlusMenu ran ONCE, from renderDevView, because the row never moved.
  // It has two homes now, so a view switch unmounts one button and mounts
  // another and the listeners are left on a node that is gone — a "+" that
  // silently stops opening.
  assert.match(APP_VIEW_SRC, /_rewirePlusMenu\(\) \{/, 'there is a re-wire');
  const body = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _repaintDevBody() {'));
  const scoped = body.slice(0, body.indexOf('\n  _rewirePlusMenu() {'));
  assert.equal((scoped.match(/AppView\._rewirePlusMenu\(\)/g) || []).length, 2,
    'called on BOTH branches — either switch can move the row');
  // Idempotent by construction: it aborts the previous controller first.
  assert.match(APP_VIEW_SRC, /AppView\._plusMenuAbort\?\.abort\(\);/);
});

test('the toolbar’s props cross roots through a store, not the view model', () => {
  // The Workshop is a separate React root from the frame that receives those
  // props, so they are published once at mountBoard.
  const MOUNT = read('frontend/src/features/dev-board/mount.ts');
  const STORE = read('frontend/src/features/dev-board/actions-store.ts');
  assert.match(MOUNT, /publishDevActions\(\{/, 'seeded where the frame is mounted');
  assert.match(WORKSHOP, /useDevActions\(\)/, 'and read by the Workshop');
  // Identity-cached: mountBoard runs on every navigation back onto the Dev
  // screen, and a fresh object each time would re-render the "+" menu for no
  // change. (A snapshot that is !== the last one is what re-renders.)
  assert.match(STORE, /if \(same\) return;/, 'unchanged props publish nothing');
  // NOT folded into _workshopView(): those are app permissions, and that view
  // model is rebuilt from the card caches on every repaint.
  assert.ok(!/canCollaborate/.test(APP_VIEW_SRC.slice(
    APP_VIEW_SRC.indexOf('  _workshopView()'),
    APP_VIEW_SRC.indexOf('  _workshopView()') + 4000)),
    'the workshop view model carries no permission flags');
});

test('the pane head pins, and the pane does not clip what must escape it', () => {
  assert.match(CSS, /\.dev-ws-pane-head \{[^}]*position: sticky/);
  assert.match(CSS, /\.dev-ws-pane-head \{[^}]*top: 0/);
  // The head wears the PANE'S OWN face, not a solid fill: this is one surface
  // with a part of it pinned, not a separate bar laid over it. What passes
  // under stays readable because the frost blurs it — and the filter has to be
  // RE-DECLARED here, not inherited, because a backdrop-filter applies to what
  // is behind the element it is set on, and these rows are inside the pane.
  // ONE FACE, painted by the two PARTS and not by the pane. A fill on the pane
  // with a second one on the head stacked 50% on 50% — measurably lighter
  // across the controls (251,251,252 against the body's 250,250,252) — and
  // because a backdrop-filter makes an element a backdrop root, the head's
  // frost was a SECOND frost over the pane's, so the two could not be squared
  // by tuning the fill either. Head and body now carry the same fill over the
  // same backdrop, which makes them equal by construction.
  assert.match(CSS,
    /\.dev-ws-pane-head, \.dev-ws-pane-body \{[^}]*background-color: var\(--dc-sheet-fill\)[^}]*backdrop-filter: var\(--dc-frost\)/);
  const paneDecls = CSS.slice(CSS.indexOf('.dev-ws-pane {'),
    CSS.indexOf('}', CSS.indexOf('.dev-ws-pane {')));
  assert.ok(!/background|backdrop-filter/.test(paneDecls),
    'the pane paints nothing itself — that is what stops the two stacking');
  // The head's frost still works on the rows, because the body is its SIBLING:
  // what scrolls inside the body passes through the head's backdrop.
  assert.match(WORKSHOP, /className="dev-ws-pane-head"[\s\S]*?className="dev-ws-pane-body"/,
    'head and body are siblings, head first');
  for (const token of ['--dc-sheet-fill', '--dc-frost', '--dc-sheet']) {
    assert.ok(CSS.includes(`${token}:`), `${token} is defined`);
  }
  // ...and with no blur on any platform (app.css "No glass, on any
  // platform") the fill is ALL there is, so the pane is solid. 50% white with
  // rows sliding crisply under it is the rendering fault the frost used to
  // prevent, not a slightly flatter bar. Both go solid TOGETHER, and the
  // same on every platform: staying the same colour as each other matters
  // more here than either one's material.
  assert.match(CSS,
    /\n\.dev-ws-pane-head, \.dev-ws-pane-body \{ background-color: var\(--dc-sheet-solid\); \}/,
    'head and body are one solid fill on every platform');
  // On By stage the BAR spans the window — it is a pinned edge, and one that
  // stopped short of the board under it would look like a mistake — but what
  // sits IN it keeps the reading column. The exact bound is asserted below,
  // with the gutter correction that keeps it from growing on the switch.
  // Two things inside this subtree must escape the pane's box: the "+" menu is
  // absolutely positioned, and sticky does not work under a clipping ancestor.
  assert.match(CSS, /\.dev-ws-pane \{[^}]*overflow: visible/);
  assert.ok(!/overflow: hidden/.test(paneDecls), 'never clipped to hide the radius');
  // The controls must not GROW when you switch panes. On By stage they are
  // bounded to the reading column MINUS the head's own gutter — bounding to
  // the column's outer width made them 20px wider there (740 against 760),
  // a toolbar that changed size on a tab click. Every child of the head, the
  // grouping strip included (#852: it hung off the pane as an "ear" once, and
  // that surface was the one exemption).
  // #4486: except the one-row head and the pipeline, which span the board.
  assert.match(CSS,
    /#dev-workshop\.dev-ws-has-board \.dev-ws-pane-head > :not\(\.dev-ws-allbar, \.dev-kanban-stages\) \{[\s\S]*?max-width: calc\(760px - 20px\)/);
  assert.ok(!/dev-ws-ear/.test(CSS), 'no rule styles an ear any more');
});

test('the grouping strip is one node, the pane head\'s first row at every width (#852)', () => {
  // It was ONE NODE IN TWO PLACES: the head below 768px, and above it an
  // "ear" hanging off the pane's top-right corner beside the tab pill, which
  // took a measured left bound, a measured width, a clipped top line on the
  // pane and a z-index relation with the strip. The tabs moved into the
  // header, so there is no pill to sit beside and the strip leads the head
  // everywhere, as it always did on a phone.
  assert.match(WORKSHOP, /function GroupStrip\(\{ group \}: \{ group: string \}\)/);
  assert.equal((WORKSHOP.match(/data-ws-group="category"/g) || []).length, 1, 'written once');
  const headAt = WORKSHOP.indexOf('className="dev-ws-pane-head"');
  const stripAt = WORKSHOP.indexOf('<GroupStrip group={group} />');
  const actionsAt = WORKSHOP.indexOf('<DevActionsRow');
  assert.ok(headAt > 0 && stripAt > headAt && stripAt < actionsAt,
    'the strip is the head\'s first child, ahead of the tools');
  assert.equal((WORKSHOP.match(/<GroupStrip /g) || []).length, 1, 'and it is rendered in that one place');
  for (const gone of [/EAR_QUERY/, /useEarInset/, /EAR_PROPS/, /data-ws-ear/, /className="dev-ws-ear"/, /--dev-ws-ear-left/, /--dev-ws-group-w/]) {
    assert.doesNotMatch(WORKSHOP, gone, `${gone} is gone with the ear`);
  }
  assert.doesNotMatch(CSS, /dev-ws-ear|--dev-ws-ear-left|--dev-ws-group-w/, 'and app.css styles none of it');
  // The buttons are real buttons with a real handler.
  assert.match(WORKSHOP, /onClick=\{\(\) => callAppView\('_setWorkshopGroup', 'category'\)\}/);
  assert.match(WORKSHOP, /onClick=\{\(\) => callAppView\('_setWorkshopGroup', 'stage'\)\}/);
});

test('the declared stage check still describes the pane it has to walk', () => {
  // It broke once, and silently: the check merged with the grouping tabs, and
  // the working pane then moved `.dev-ws-board` inside `.dev-ws-pane-body`
  // while the selector still read `.dev-ws-group + .dev-ws-board` — an
  // adjacency that only held while both were direct children of `.dev-ws`.
  // Nothing locally noticed, because a declared selector is a STRING here and
  // only the staging gate resolves it.
  //
  // So this asserts the chain against the same source the checks walk: every
  // class in it must be one the component actually renders, in the nesting
  // order it renders them.
  const dapp = JSON.parse(read('dapp.json'));
  const check = dapp.tests.find((t) => /group=stage/.test(t.path || '')
    && /dev-ws-board/.test(t.expectSelector || ''));
  assert.ok(check, 'the stage check exists');
  assert.ok(!/\.dev-ws-group \+ \.dev-ws-board/.test(check.expectSelector),
    'the retired adjacency is gone');
  assert.match(check.expectSelector, /\[data-ws-pane\] > \.dev-ws-pane-body > \.dev-ws-board/,
    'it walks head-and-body pane, as the component renders it');
  // ...and the component really does nest them that way.
  assert.match(WORKSHOP, /className="dev-ws-pane-body"[\s\S]{0,400}className="dev-ws-board"/);
});

test('the ?ws= deep link survives arriving AFTER the first paint', () => {
  // THE BUG THIS PINS COST A WHOLE CHECK CYCLE. The tab was seeded from the
  // publish alone — `useState(() => v.tab || 'status')` — and that initialiser
  // runs against whatever the store holds AT MOUNT, which is
  // EMPTY_WORKSHOP_VIEW. The legacy module publishes `_workshopView()` after
  // its data load, so on a cold open `v.tab` is undefined in that first frame
  // and the deep link was dropped on the floor: every `?ws=all` route landed
  // on Current status, and 25 declared checks failed on routes that read
  // perfectly. `autoExpand` has carried a late-arrival effect since it
  // shipped, which is precisely why `?shot=themes` worked where `?ws=` did
  // not.
  //
  // Asserted as source text because nothing here runs effects: these tests
  // render statically, so the only local witness to an effect is the code.
  //
  // The seed asks AppView first now (`freshTab`): the store keeps the LAST
  // view published, so a page opened again — Back, or a hub door that has
  // just set the tab — opened on a tab the viewer had since left. The
  // publish stays the fallback, and the late-arrival effect stays for a
  // mount where AppView is not there to ask.
  assert.match(WORKSHOP, /const \[tab, setTab\] = useState<TabKey>\(\(\) => freshTab\(\) \|\| v\.tab \|\| 'status'\);/,
    'the seed still paints the right tab on the first frame when the view is already there');
  assert.match(
    WORKSHOP,
    /const deepTabApplied = useRef<boolean>\(!!v\.tab \|\| !!freshTab\(\)\);\s*useEffect\(\(\) => \{\s*if \(deepTabApplied\.current \|\| !v\.tab\) return;\s*deepTabApplied\.current = true;\s*setTab\(v\.tab\);\s*\}, \[v\.tab\]\);/,
    'and an effect applies it when the publish lands later',
  );
  // The ref is not decoration. `v.tab` reads the URL, so it never changes for
  // the life of the page, while `_rerenderWorkshop()` republishes on every
  // data change — an unguarded effect would yank a reader who had tapped
  // another tab back to the deep-linked one on the next refresh.
  assert.ok(/deepTabApplied\.current \|\| !v\.tab/.test(WORKSHOP),
    'applied once, so a later republish cannot override the reader');
});

test('#2767/#2769: the phone rail sits at the HEAD of the page, in flow, and leaves with the Workshop', () => {
  // THE OWNER REVERSED THE BOTTOM BAR. On a phone this was a pill fixed to
  // the foot of the window, portalled out of the Dev frame's frost into a
  // shell-level anchor so `position: fixed` could mean the screen. #2767
  // moved the tabs to the top of the page, under the header; and the portal
  // WAS #2769 — its anchor sat outside #app-view, so the pill stayed on
  // screen over Messages, Discover and Me after a visit to the Workshop.
  const rail = /\n\.dev-ws-tabs \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(rail, 'the rail rule exists');
  const railDecls = rail[1].replace(/\/\*[\s\S]*?\*\//g, '');
  // RELATIVE: the containing block the selection marker and `offsetLeft`
  // measure against, and nothing more. Not fixed, and not sticky — the pane
  // head below it is the band that pins.
  assert.match(railDecls, /position: relative;/, 'in flow, and the marker\'s containing block');
  assert.ok(!/position: (fixed|sticky)/.test(railDecls), 'neither fixed to the viewport nor pinned');
  assert.match(railDecls, /order: 0;/, 'painted where it is written: first');
  assert.ok(!/\bbottom:|\bleft:|\bright:/.test(railDecls), 'no viewport offsets left behind');

  // NO PORTAL. The node renders in place at every width, inside the
  // Workshop's own subtree, so hiding the app view hides it.
  assert.ok(!/createPortal/.test(WORKSHOP), 'nothing lifts the rail out of the tree');
  assert.ok(!/useRailHost|railHost/.test(WORKSHOP), 'and no hook looks for a host');
  assert.match(WORKSHOP, /\{band\}\n\s*\{\/\* Everything but the bar lives in here\./, 'the band renders where it is written');
  assert.ok(!/dev-ws-rail-host/.test(SHELL), 'the shell keeps no anchor for it');
  assert.ok(!/dev-ws-rail-host/.test(CSS), 'and no rule styles one');
  // ONE SPELLING OF THE BREAKPOINT survives for the ask composer and the feed.
  assert.match(WORKSHOP, /const WIDE_QUERY = '\(min-width: 700px\)';/);

  // NOTHING OVERLAYS THE LANDER, so nothing reserves room for a bar: the
  // tokens that held the pill's box and the air under it are gone, and the
  // tab body carries no clearance.
  const decls = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/--ws-bar|--ws-lift/.test(decls), 'no bar box, no lift');
  const body = /\n\.dev-ws-tabbody \{([\s\S]*?)\n\}/.exec(decls);
  assert.ok(body && !/padding-bottom/.test(body[1]), 'the tab body reserves nothing under itself');

  // THE FLOOR takes the header, the insets, the air and the platform's tab
  // bar — the larger of that bar and the home-indicator strip, which is what
  // `.platform-safe-scroll` reserves below the lander — and NOT a Workshop
  // bar, which is in flow inside `.dev-ws` now.
  const area = /\.dev-ws \{[\s\S]*?--ws-area: calc\(([\s\S]*?)\);\n/.exec(CSS);
  assert.ok(area, 'the floor exists');
  assert.match(area[1], /var\(--ws-gap\)/);
  assert.match(area[1], /max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom, 0px\)\)/);
  // QA 2026-09-24 Q8: and the fixed strips above the header ("Get the app",
  // offline), which body padding reserves at the head of the page. Without
  // this a phone browser with the install strip up pushed the foot of every
  // Needs you card under the tab bar.
  assert.match(area[1], /100dvh - var\(--browser-banner-h, 0px\)/);
  // The fitted box is the same length, since nothing floats over its foot.
  assert.match(CSS, /--ws-fit: var\(--ws-area\);/);
  // And the wide block no longer needs its own floor: the base one is the
  // in-flow arithmetic it always used.
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(wide, 'the wide block exists');
  assert.ok(!/--ws-area/.test(wide[1].replace(/\/\*[\s\S]*?\*\//g, '')),
    'one floor, every width');
});

test('the ask composer keeps a visible send, and opens with it in the bottom-right corner', () => {
  // The whole controls row used to sit behind focus, which took the send
  // circle with it and left a card that looked like a text box and nothing
  // else — no sign it would do anything. The card has no shut state any
  // more, so the circle has ONE home: the bottom-right corner, where
  // `.dc-card-row` puts the dev session's own.
  const send = /const sendBtn = \(([\s\S]*?)\n  \);/.exec(WORKSHOP);
  assert.ok(send, 'the circle is written ONCE, so its two homes cannot drift');
  assert.match(send[1], /className="dc-send-btn dc-circle-send dev-ws-ask-send"/);
  assert.match(send[1], /disabled=\{!draft\.trim\(\) \|\| !target \|\| inFlight\}/);
  const line = /<div className="dev-ws-ask-line">([\s\S]*?)<\/div>/.exec(WORKSHOP);
  assert.ok(line, 'the composer has a resting line');
  assert.match(line[1], /id="dev-ws-ask-input"/, 'the field is on it');
  assert.ok(!/\{expanded/.test(WORKSHOP),
    'nothing in the composer waits for a tap: the controls row is always there');
  const row = /<div className="dev-ws-ask-row">([\s\S]*?)\n          <\/div>/.exec(WORKSHOP);
  assert.ok(row, 'the controls row is written once, ungated');
  assert.match(row[1], /data-ws-ask-model/, 'the model picker is in it');
  assert.match(row[1], /\{sendBtn\}/, 'and the circle, as the row\'s last child');
  assert.ok(row[1].indexOf('data-ws-ask-model') < row[1].indexOf('{sendBtn}'),
    'model left, send right');
  // `margin-left: auto` rather than `justify-content`: the picker beside it
  // has to keep shrinking (a <select>'s intrinsic width is its longest
  // option), and with no picker at all the circle is the row's only child and
  // the auto margin still pins it right. Measured at 1280x900: the circle
  // rests 14px from the card's right edge and 12px from its bottom, which is
  // the card's own padding on both sides.
  assert.match(CSS, /\.dev-ws-ask-row > \.dev-ws-ask-send \{ margin-left: auto; \}/);
});

test('the filter host asks to be filled, because the repaint that fills it runs too early', () => {
  // THE ORDER IS THE BUG. `_repaintDevBody()`'s Workshop branch creates an
  // empty `#dev-workshop` and then calls `_renderKanbanFilterBar()` — but
  // `#dev-kanban-filterbar` is a node of the TOOLBAR, which the Workshop's
  // All-items pane renders, so on the first visit of a page session the
  // filler ran against a host that did not exist yet, returned at its own
  // guard, and the search field appeared only on whatever repaint happened to
  // come next: a WebSocket push, or a pull-to-refresh. "The search is missing
  // for a few seconds and then it is there."
  assert.match(APP_VIEW_SRC, /body\.innerHTML = '<div id="dev-workshop"><\/div>';[\s\S]*?AppView\._renderKanbanFilterBar\(\);/,
    'the module still fills the strip on the repaint — this is that ordering');
  assert.match(APP_VIEW_SRC, /_renderKanbanFilterBar\(\) \{\s*const el = document\.getElementById\('dev-kanban-filterbar'\);\s*if \(!el\) return;/,
    'and it is a no-op when the host is absent, which is why nothing was drawn');
  // So the host asks for itself, on the effect after it mounts.
  assert.match(ACTIONS_ROW, /<div id="dev-kanban-filterbar"/, 'the toolbar owns the host');
  assert.match(ACTIONS_ROW, /queueMicrotask\(\(\) => \{ if \(live\) callAppView\('_renderKanbanFilterBar'\); \}\);/);
  // IN A MICROTASK, and that is React's own instruction rather than a taste.
  // The mount publishes inside `flushSync`, and a `flushSync` raised while
  // React is still committing answers with "flushSync was called from inside
  // a lifecycle method… Consider moving this call to a scheduler task or
  // micro task" — an effect body is inside that commit, passive or not.
  // Checked both ways in a browser on a development React build: from the
  // effect body it fires, from the microtask it does not.
  assert.match(read('frontend/src/lib/legacy-portals.tsx'), /function commit\(\): void \{\s*flushSync\(publish\);/,
    'the synchronous publish the mount goes through');
  assert.ok(!/useLayoutEffect/.test(ACTIONS_ROW), 'and the effect is passive, not a layout one');
  // Cancelled on unmount, so a row torn down inside the same tick does not
  // mount a portal into a host that has already been discarded.
  assert.match(ACTIONS_ROW, /return \(\) => \{ live = false; \};/);
  // Nothing waits on it: the host holds the field's row open from the
  // frame's first paint, so arriving a beat later shifts nothing under it.
  assert.match(ACTIONS_ROW, /id="dev-kanban-filterbar" className="flex-1 min-w-0 min-h-8"/);
});

test('the ⋯ asks to be wired when it mounts, because the module wires it before it exists (#2141)', () => {
  // THE ORDER IS THE BUG, AGAIN, one line further down the same branch. The
  // module wires the button from `_repaintDevBody`, on the line after
  // `_rerenderWorkshop()` — by id, so it is a no-op while the button is not
  // in the DOM.
  assert.match(APP_VIEW_SRC, /AppView\._rerenderWorkshop\(\);\s*AppView\._rewirePlusMenu\(\);/,
    'the module wires on the repaint, after the Workshop publish');
  assert.match(APP_VIEW_SRC, /_wirePlusMenu\(content\) \{\s*const btn = document\.getElementById\('dev-plus-btn'\);\s*const menu = document\.getElementById\('dev-plus-menu'\);\s*if \(!btn \|\| !menu\) return;/,
    'and it returns at its own guard when the "+" is absent');
  // Ways it arrives AFTER that line. It is the hub hero's, and the hero
  // draws its actions only once the community read has answered; and a
  // door back to the hub mounts it from React state, while the module side
  // of the press only persists the choice — nothing re-runs the wiring.
  assert.match(WORKSHOP, /onMore=\{\(\) => openTab\('workshop'\)\}/);
  assert.match(WORKSHOP, /onBack=\{\(\) => openTab\(pageParent\(tab\)\)\}/);
  // Every tab turns the page, Homeroom's Discussion (#general) included (#3494).
  assert.match(WORKSHOP, /const openTab = \(next: TabKey\) => \{\s*setTab\(next\);\s*callAppView\('_setWorkshopTab', next\);/);
  const setTab = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _setWorkshopTab(key) {'));
  const setTabBody = setTab.slice(0, setTab.indexOf('\n  },'));
  assert.match(setTabBody, /localStorage\.setItem\(AppView\.WORKSHOP_TAB_KEY, next\)/);
  assert.ok(!/_rewirePlusMenu|_repaintDevBody|_rerenderWorkshop/.test(setTabBody),
    'the tab is persisted, not repainted');
  // And a deep-linked or remembered `ws=all` reaches a cold Workshop through
  // the late-arrival effect on `v.tab`: a state update raised inside a
  // passive effect is scheduled at default priority, so the pane lands a task
  // AFTER the synchronous publish the module's call follows.
  assert.match(WORKSHOP, /useState<TabKey>\(\(\) => freshTab\(\) \|\| v\.tab \|\| 'status'\)/);
  assert.match(WORKSHOP, /useEffect\(\(\) => \{\s*if \(deepTabApplied\.current \|\| !v\.tab\) return;\s*deepTabApplied\.current = true;\s*setTab\(v\.tab\);\s*\}, \[v\.tab\]\);/);
  // So the ⋯ asks for itself, from its OWN mount effect. It rode on the
  // filter row's effect while it lived at the end of that row; it is its own
  // component now (`DevPlusMenu`), in the hub's hero, and the row in the
  // pane head carries none to wire.
  const plusSrc = ACTIONS_ROW.slice(ACTIONS_ROW.indexOf('export function DevPlusMenu('));
  const plusEffect = plusSrc.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[\]\);/);
  assert.ok(plusEffect, 'the "+" has a mount effect');
  // In the effect BODY, not a microtask: the wiring binds listeners and
  // flushes nothing through React, so there is nothing for a microtask to
  // keep out of the commit, and the nodes it looks up are committed by the
  // time any effect runs.
  assert.match(plusEffect[0], /^useEffect\(\(\) => \{\s*callAppView\('_rewirePlusMenu'\);\s*\}, \[\]\);$/);
  // The strip keeps its microtask (see the test above), and no longer wires
  // a "+" the row may not hold.
  const rowSrc = ACTIONS_ROW.slice(ACTIONS_ROW.indexOf('export function DevActionsRow('));
  const rowEffect = rowSrc.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[\]\);/);
  assert.ok(rowEffect, 'the filter row has its mount effect');
  assert.match(rowEffect[0], /queueMicrotask\(\(\) => \{ if \(live\) callAppView\('_renderKanbanFilterBar'\); \}\);/);
  assert.ok(!/_rewirePlusMenu/.test(rowEffect[0]), 'the row does not wire the "+"');
  const wire = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _wirePlusMenu(content) {'));
  const wireBody = wire.slice(0, wire.indexOf('\n  },'));
  assert.ok(!/_reactDevBoard|publish|flushSync|innerHTML/.test(wireBody), 'listeners only');
  assert.match(wireBody, /AppView\._plusMenuAbort\?\.abort\(\);/,
    'and re-entrant: the previous handlers go before the next ones bind');
});

test('re-running the wiring from the row is safe: nothing bound while the "+" is absent, one live handler once it is', () => {
  // The module half of the fix above, executed: the sequence the row's mount
  // now produces is "the module called with no button, then the row called
  // with one, then the module again on the next repaint", and every step has
  // to leave at most one handler on the node. Real EventTargets, so the
  // `{ signal }` each listener carries is honoured by the dispatch.
  const target = () => {
    const node = new EventTarget();
    node.click = () => node.dispatchEvent(new Event('click'));
    node.attrs = {};
    node.setAttribute = (k, v) => { node.attrs[k] = v; };
    node.querySelector = () => null;
    node.querySelectorAll = () => [];
    return node;
  };
  const content = target();
  const btn = target();
  const menu = target();
  const cls = new Set(['hidden']);
  menu.classList = {
    add: (c) => { cls.add(c); },
    remove: (c) => { cls.delete(c); },
    contains: (c) => cls.has(c),
    toggle: (c) => (cls.has(c) ? (cls.delete(c), false) : (cls.add(c), true)),
  };
  const present = { 'app-content': content };
  const AppView = makeAppView({
    document: {
      getElementById: (id) => present[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    globals: { AbortController, PlatformUI: { isTouch: () => false } },
  });
  AppView.refreshDevChatSecretsState = () => {};
  // 1. The button is not in the DOM (the lander is on Current status, or a
  //    cold Workshop is on its first frame): the module's call binds nothing.
  AppView._rewirePlusMenu();
  assert.equal(AppView._plusMenuAbort, undefined, 'nothing bound, so nothing to abort');
  // 2. The row mounts and asks: the button opens the menu.
  present['dev-plus-btn'] = btn;
  present['dev-plus-menu'] = menu;
  AppView._rewirePlusMenu();
  btn.click();
  assert.equal(cls.has('hidden'), false, 'the menu opens');
  assert.equal(btn.attrs['aria-expanded'], 'true');
  // 3. The module's own repaint call lands on top: still one handler, so a
  //    click toggles once (shut) rather than twice (shut, then open again).
  AppView._rewirePlusMenu();
  btn.click();
  assert.equal(cls.has('hidden'), true, 'closes: one toggle, not two');
  assert.equal(btn.attrs['aria-expanded'], 'false');
  btn.click();
  assert.equal(cls.has('hidden'), false, 'and opens again');
});

test('Needs you is a fitted screen on a phone, in the page-scrolling layout too', () => {
  // MEASURED, in the harness that loads the real generated shell and the real
  // app.css at 402x874, with a nine-paragraph summary on the card, at a 34px
  // home-indicator inset and at none.
  //
  // NATIVE layout (bounded #dev-forum-scroll): the deck refused to shrink and
  // the lander grew instead — `.dev-ws` 1803px tall, the composer 910px below
  // the fold — because `.dev-ws` is a flex ITEM whose automatic minimum size
  // is its content, and it was the one link in the chain without
  // `min-height: 0`.
  // Discussion is the second fitted tab (#852 review): the channel's pane
  // rests its composer on the foot of the reading area the same way.
  assert.match(CSS, /#dev-workshop > \.dev-ws\[data-ws-tab="needs"\],\s*#dev-workshop > \.dev-ws\[data-ws-tab="discussion"\] \{ min-height: 0; \}/);
  // ONLY those tabs: the others are meant to grow and scroll inside
  // #dev-forum-scroll, and `.dev-ws-tabbody` is not a scroller itself, so
  // shrinking them would clip what they hold rather than make it reachable.
  assert.ok(!/#dev-workshop > \.dev-ws \{[^}]*min-height: 0/.test(CSS),
    'the rule is scoped to the fitted tab');
  // BROWSER layout (`html[data-browser-scroller]`, which is what a mobile
  // browser gets): every height below the scroller is `auto` there, so
  // `--ws-area` is only a floor and a long card pushed the composer under the
  // fold with nothing pinned — while a SHORT one stopped EARLY, because the
  // floor is not the same number as the clearance `.dev-ws-tabbody` reserves:
  // 79px of dead air under the composer at a zero inset and 51px at 34,
  // against the native layout's 8 at both. The tab takes `--ws-fit` as a
  // definite height instead — the box the native chain arrives at on its own
  // — and both layouts then land the composer 7-8px under the pill, tall card
  // or short, at either inset.
  const fitted = /@media \(max-width: 699\.98px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(fitted, 'the phone-only block exists');
  assert.match(fitted[1], /html\[data-browser-scroller\] \.dev-ws\[data-ws-tab="needs"\] \{[\s\S]*?height: var\(--ws-fit\);[\s\S]*?min-height: var\(--ws-fit\);/);
  // Scoped to the PHONE as well as to the layout, and that is load-bearing:
  // `data-browser-scroller` is set on any coarse pointer (MOBILE_PAGE_QUERY),
  // tablets included, and above 700px `--ws-area` no longer takes the bar off
  // — so `--ws-fit` would be a bar too tall up there.
  assert.match(read('frontend/src/lib/browser-scroll.ts'),
    /MOBILE_PAGE_QUERY = '\(max-width: 767px\), \(hover: none\) and \(pointer: coarse\)';/,
    'which is why the layout attribute alone is not a phone');
  // What scrolls when the card is long is the card's own pane; the answers,
  // the page arrows and the ask box are the fitted parts and stay put.
  assert.match(CSS, /\.dev-ws-needs-scroll \{[\s\S]*?overflow-y: auto;/);
});

test('the ask card is padded evenly, so its resting line sits on its own middle', () => {
  // `.dc-card` ships `0.875rem 1rem 0.625rem` — 14 over, 10 under — which is
  // right for the dev session's composer, a tall field with controls beneath
  // it. Here, at rest, the card holds ONE line, and 14 against 10 put that
  // line 2px below the middle of its own box. That is what "the ask box sits
  // slightly low" was. Measured at 402x874: a 58px card with a 34px line
  // starting at 14.
  assert.match(CSS, /\.dev-ws-ask-composer \{[^}]*padding: 12px 14px;/);
  assert.match(CSS, /\.dc-card \{[\s\S]*?padding: 0\.875rem 1rem 0\.625rem;/,
    'the session card keeps its own, which is why this is an override rather than a change');
});

test('#4457: since-your-last-visit shows its first few and the rest behind Show all N', () => {
  const store = {};
  store['workshopSeen:demo-app'] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  // Seven merges by somebody else, all since the last visit.
  AppView._merged = [40, 39, 38, 37, 36, 35, 34].map((n, i) => ({
    id: 78 - i, pr_number: n, pr_title: `Landed ${n}`, status: 'merged', username: 'alice',
    created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr',
  }));
  AppView._mergedTotal = 7;
  const html = workshopHtml(AppView, 'workshop');
  const since = html.slice(html.indexOf('data-ws-since=""'), html.indexOf('data-ws-weeks=""'));
  const { SINCE_FIRST } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.equal(SINCE_FIRST, 5);
  assert.equal((since.match(/data-ws-row="since:/g) || []).length, SINCE_FIRST, 'the first five are drawn');
  const total = Number((since.match(/<span class="dev-ws-head-n">(\d+)<\/span>/) || [0, 0])[1]);
  assert.ok(total > SINCE_FIRST, 'the head counts them all');
  assert.match(since, new RegExp(`<button type="button" class="dev-ws-reveal touch-target-32" data-ws-since-more=""><svg[\\s\\S]*?<\\/svg>Show all ${total}<\\/button>`),
    'and the rest are one press, in place');
  assert.match(since, /<span class="dev-ws-wrow-sub">PR #40 · alice · 2d ago<\/span><span class="dev-ws-wrow-status"><span class="dev-ws-row-state dev-ws-row-state-ok dev-ws-wrow-live"[^>]*>✓ Live<\/span>/,
    'a live change: what it is in the board\u2019s words, led by the bar\u2019s own ✓ Live (#4486)');
  // An empty list says so, in one line, and counts nothing.
  const fresh = makeAppView({ localStorage: { 'workshopSeen:demo-app': String(Date.now()) } });
  seed(fresh);
  const quiet = workshopHtml(fresh, 'workshop');
  assert.match(quiet, /<p class="dev-ws-none" data-ws-since-none="">Nothing new since you were last here\.<\/p>/);
  const quietSince = quiet.slice(quiet.indexOf('data-ws-since=""'), quiet.indexOf('data-ws-weeks=""'));
  assert.doesNotMatch(quietSince, /dev-ws-head-n/, 'no count pill when nothing moved');
  assert.doesNotMatch(quietSince, /data-ws-row=/, 'and no rows of what was seen: that is the weeks\'');
});

test('#4457: a governance vote counts in the sentence as a proposal, in the singular', () => {
  const AppView = makeAppView({ localStorage: { 'workshopSeen:demo-app': String(Date.now() - 12 * 3600000) } });
  seed(AppView);
  AppView._govProposals = [
    { id: 72, kind: 'close_issue', title: 'Theirs', status: 'open', created_by: 9,
      created_by_username: 'carol', payload: { issueNumber: 13, issueTitle: 'Keyboard voting' },
      created_at: at(0.1), last_message_at: at(0.1), up_count: 0, down_count: 0, my_vote: null },
  ];
  const v = AppView._workshopView();
  assert.equal(v.since.total, 1, 'only the governance proposal moved');
  const html = workshopHtml(AppView, 'workshop');
  assert.match(html, /data-ws-since-sum="">1 proposal to vote on\.</);
});

// ── #2183: Clear, and a Show an earlier week that is always there ─────

test('since-your-last-visit publishes the rest of the list as "seen", newest first', () => {
  const store = {};
  store['workshopSeen:demo-app'] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  const v = AppView._workshopView();
  // Issue 13 was filed twenty days ago and last touched nine days ago: on
  // the far side of the line, so it is the one row the reader has seen.
  assert.deepEqual(plain(v.since.rows.map((r) => r.key).sort()), ['since:issue:12', 'since:merged:78', 'since:proposal:34']);
  assert.deepEqual(plain(v.since.seen.rows.map((r) => r.key)), ['seen:issue:13']);
  assert.equal(v.since.seen.total, 1);
  assert.ok(!v.since.seen.rows[0].fresh, 'nothing on that side is new');
  // `through` is the newest stamp among the new rows — what Clear moves the
  // line up to, so a row a clock put a moment ahead goes with the rest.
  assert.equal(v.since.through, Date.parse(AppView._ghIssues[0].updatedAt), 'issue 12, touched a day ago, is the newest');
  assert.ok(v.since.through > v.since.baseline);
  assert.ok(v.since.through <= Date.now());

  // The seen list is the SAME activity list below the line, newest first,
  // capped like the new one: thirty-five merges from before the visit draw
  // as thirty, with the whole rest counted.
  const many = makeAppView({ localStorage: { 'workshopSeen:demo-app': String(Date.now() - 3.5 * 86400000) } });
  seed(many);
  many._merged = Array.from({ length: 35 }, (_, i) => ({
    id: 200 + i, pr_number: 300 + i, pr_title: `Old ${i}`, status: 'merged', username: 'alice',
    created_at: at(10 + i), merged_at: at(10 + i), last_message_at: at(10 + i), row_type: 'pr',
  }));
  many._mergedTotal = 35;
  const mv = many._workshopView();
  assert.equal(mv.since.seen.rows.length, many.WORKSHOP_SEEN_MAX);
  assert.equal(many.WORKSHOP_SEEN_MAX, 30);
  assert.equal(mv.since.seen.total, 36, 'the thirty-five merges and issue 13');
  assert.equal(mv.since.seen.rows[0].key, 'seen:issue:13', 'nine days ago comes before ten');
  assert.equal(mv.since.seen.rows[1].key, 'seen:merged:200');
});

test('Clear moves the baseline to now, persists it, and what was new is then in its week', () => {
  const store = {};
  store['workshopSeen:demo-app'] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  const before = AppView._workshopView();
  assert.equal(before.since.rows.length, 3);
  const html = workshopHtml(AppView, 'workshop');
  assert.match(html, /<button type="button" class="dev-ws-since-clear un-touch-target" data-ws-since-clear="">Clear<\/button>/,
    'live, because there is something to clear');

  AppView._workshopClearSince('demo-app', before.since.through);
  const after = AppView._workshopView();
  assert.equal(after.since.rows.length, 0, 'nothing is new any more');
  assert.ok(after.since.baseline >= before.since.through, 'the line moved up to now');
  assert.ok(after.since.baseline >= Date.now() - 1000);
  assert.deepEqual(plain(after.since.seen.rows.map((r) => r.key)),
    ['seen:issue:12', 'seen:merged:78', 'seen:proposal:34', 'seen:issue:13']);
  assert.equal(after.since.seen.total, 4);
  assert.equal(after.themes.length ? after.themes[0].counts.fresh : 0, 0, 'the "new" marks go with it');
  assert.equal(store['workshopSeen:demo-app'], String(after.since.baseline));
  assert.equal(AppView._workshopSince['demo-app'], after.since.baseline);
  const cleared = workshopHtml(AppView, 'workshop');
  assert.match(cleared, /data-ws-since-none=""/);
  assert.match(cleared, /<button type="button" class="dev-ws-since-clear un-touch-target" data-ws-since-clear="" disabled="">Clear<\/button>/,
    'disabled rather than absent, so the row does not reflow');
  // #4457: what was cleared is in its week, one row away.
  assert.match(cleared, /<button type="button" class="dev-ws-week" data-ws-week="/, 'and the way back to it is its week');

  // A row a server clock put a moment in the future is cleared with the
  // rest: the stamp is the newer of now and `through`.
  const ahead = makeAppView({ localStorage: { 'workshopSeen:demo-app': String(Date.now() - 3.5 * 86400000) } });
  seed(ahead);
  const soon = new Date(Date.now() + 60000).toISOString();
  ahead._ghIssues[0].updatedAt = soon;
  ahead._ghIssues[0].lastMessageAt = soon;
  const av = ahead._workshopView();
  assert.ok(av.since.through > Date.now(), 'the fixture is ahead of the clock');
  ahead._workshopClearSince('demo-app', av.since.through);
  assert.equal(ahead._workshopView().since.rows.length, 0);
  assert.equal(ahead._workshopSince['demo-app'], av.since.through);

  // The slug defaults to the current app.
  const idle = makeAppView();
  idle._workshopClearSince();
  assert.ok(idle._workshopSince['demo-app'] > 0);
});

test('#4457: Week by week opens on two weeks, and Show earlier weeks adds rows to the same list', () => {
  const { WEEKS_FIRST, WEEKS_STEP } = loadTsx('frontend/src/features/dev-board/workshop/week-pages.tsx');
  assert.equal(WEEKS_FIRST, 2);
  assert.equal(WEEKS_STEP, 4);
  assert.match(WORKSHOP, /const \[weeksShown, setWeeksShown\] = useState\(WEEKS_FIRST\);/);
  assert.match(WORKSHOP, /\{weeks\.slice\(0, weeksShown\)\.map\(\(w\) => \(/);
  assert.match(WORKSHOP, /onClick=\{\(\) => setWeeksShown\(weeksShown \+ WEEKS_STEP\)\}/);
  // A week's row opens its page in the tab, and the page's back closes it.
  assert.match(WORKSHOP, /\{tab === 'workshop' && weekUp \? \(\s*<WeekPage/);
  assert.match(WORKSHOP, /\{tab === 'workshop' && !weekUp \? \(/, 'and the tab itself is not drawn under it');
  assert.match(WORKSHOP, /const closeWeekPage = \(\) => \{\s*setOpenWeek\(null\);/);
  // Every class it emits has a rule (the #2097 lesson).
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const cls of ['dev-ws-wlist', 'dev-ws-wrow', 'dev-ws-wrow-tile', 'dev-ws-wrow-main', 'dev-ws-wrow-link', 'dev-ws-wrow-sub',
    'dev-ws-wrow-status', 'dev-ws-wrow-chev', 'dev-ws-tag', 'dev-ws-wvote', 'dev-ws-wvote-state', 'dev-ws-wvote-btn',
    'dev-ws-wrow-menu', 'dev-ws-wrow-live', 'dev-ws-brow',
    'dev-ws-week', 'dev-ws-week-main', 'dev-ws-week-head', 'dev-ws-week-fresh', 'dev-ws-week-line', 'dev-ws-week-n',
    'dev-ws-weekpage', 'dev-ws-week-meta', 'dev-ws-week-lead', 'dev-ws-none', 'dev-ws-since-clear', 'dev-ws-since-sum',
    'dev-ws-rules', 'dev-ws-rule-step', 'dev-ws-rule-join', 'dev-ws-rule-tile', 'dev-ws-rule-face', 'dev-ws-rule-text',
    'dev-ws-side', 'dev-ws-side-bar', 'dev-ws-side-btn', 'dev-ws-side-page']) {
    assert.match(stripped, new RegExp(`\\.${cls} \\{`), `.${cls} has a rule`);
  }
  assert.match(stripped, /\.dev-ws-since-clear \{[^}]*margin-left: auto;/, 'Clear at the far end of the heading row');
});

test('the since-list and week checks reach their states through URLs that give the page a last visit', () => {
  assert.match(APP_VIEW_SRC, /if \(shot === 'since-visit'\) \{\s*AppView\._workshopSince\[slug\] = Date\.now\(\) - 30 \* 86400000;\s*\}/);
  assert.match(APP_VIEW_SRC, /if \(shot === 'since-seen'\) \{\s*AppView\._workshopSince\[slug\] = Date\.now\(\) \+ 30 \* 86400000;\s*\}/,
    'the quiet visit: the line past every row');
  const block = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf("if (shot === 'week-page') {"));
  const body = block.slice(0, block.indexOf('\n      }\n') + 1);
  assert.match(body, /document\.querySelector\('button\[data-ws-week\]'\)/, 'it presses the real week row');
  assert.match(body, /if \(document\.querySelector\('\[data-ws-week-page\]'\)\) \{ done\(\); return; \}/, 'and stops once the page is up');
  assert.match(body, /e\.isTrusted/, 'and lets go on the first real gesture');
  assert.ok(!/localStorage/.test(body), 'nothing is written to storage');
  const visit = dapp.tests.find((t) => /shot=since-visit/.test(t.path || ''));
  assert.match(visit.expectSelector, /\[data-ws-since\]:has\(> \[data-ws-since-head\] > \.dev-ws-head-n \+ button\[data-ws-since-clear\]\)/);
  assert.match(visit.expectSelector, /\+ \[data-ws-weeks\] > \.dev-ws-wlist > button\.dev-ws-week\[data-ws-week\]/);
  const quiet = dapp.tests.find((t) => /shot=since-seen/.test(t.path || ''));
  assert.match(quiet.expectSelector, /p\[data-ws-since-none\]/);
  assert.equal(quiet.expectText, 'Nothing new since you were last here.');
  const week = dapp.tests.find((t) => /shot=week-page/.test(t.path || ''));
  assert.match(week.expectSelector, /\.dev-ws-weekpage\[data-ws-week-page\] > \[data-ws-pagehead\]/);
});

test('the composer shows its model picker and send circle at every width', () => {
  // It used to open expanded above the breakpoint and stay one line on a
  // phone until the field was tapped. The tap was the problem: a picker
  // behind it was a picker nobody knew was there. So there is no collapsed
  // state and no `focused` flag to seed, or to lose again on blur.
  assert.ok(!/const expanded = /.test(WORKSHOP), 'no expanded/collapsed state');
  assert.ok(!/setFocused\(/.test(WORKSHOP), 'and no focus flag driving one');
  assert.match(WORKSHOP, /const wide = useMediaFlag\(WIDE_QUERY\);/);
  // READ AT MOUNT, unlike `useRailHost` — nothing here is prerendered (the
  // Workshop mounts client-side into a host `_repaintDevBody()` creates), so
  // there is no first paint to disagree with, and a collapsed frame followed
  // a tick later by an expanded one is a flash on every visit.
  //
  // The hook takes the QUERY, so a second breakpoint (the grouping strip's
  // ear had one, 768px, until #852) needs no near-identical copy beside it.
  // The seed is lazy so the read happens on mount rather than on every
  // render.
  assert.match(WORKSHOP, /const \[on, setOn\] = useState\(\(\) => matchesQuery\(query\)\);/);
  // And guarded, because the render this suite does happens in node, where
  // there is no matchMedia at all.
  assert.match(WORKSHOP, /typeof window !== 'undefined' && typeof window\.matchMedia === 'function'/);
});

test('the sheets move, stop above the keyboard, and More opens the card page', () => {
  // OPEN AND CLOSE ANIMATE. A sheet unmounts when it closes, so the leave
  // needs the element kept for the animation's length: `leaving` holds the
  // kind, `[data-ws-leaving]` marks it, and a timer drops it — instantly
  // where motion is unwelcome, because app.css runs no animation there.
  assert.match(WORKSHOP, /const \[leaving, setLeaving\] = useState<SheetKind \| null>\(null\);/);
  // Never on the end card, which has no item for a sheet to be about (#2172).
  assert.match(WORKSHOP, /const shown = row \? \(sheet \|\| leaving\) : null;/);
  assert.match(WORKSHOP, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(CSS, /\.dev-ws-sheet-modal\[data-ws-leaving\] > \.dev-ws-sheet-card \{\s*animation-name: var\(--ws-sheet-out\)/);
  assert.match(CSS, /@keyframes dev-ws-sheet-up \{ from \{ transform: translateY\(100%\); \}/);
  // A leaving sheet lets taps and focus through: its scrim and buttons stay
  // mounted for the leave, and would swallow the next tap. Not motion-gated.
  assert.match(CSS, /\n\.dev-ws-sheet-modal\[data-ws-leaving\] \{ pointer-events: none; \}/);
  assert.match(WORKSHOP, /const leavingAttr = !sheet && leaving \? \{ 'data-ws-leaving': '', inert: true \} : \{\};/);
  // A panel slides in from the side it lives on; a popover pops. Same rule,
  // different names, set where the panel and the popover are declared.
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS)[1];
  assert.match(wide, /--ws-sheet-in: dev-ws-panel-in; --ws-sheet-out: dev-ws-panel-out;/);
  assert.match(wide, /--ws-sheet-in: dev-ws-pop-in; --ws-sheet-out: dev-ws-pop-out;/);
  // THE KEYBOARD. Fixed elements are laid out against the layout viewport,
  // which the on-screen keyboard does not shrink, so the card's floor — and
  // the field on it — sat under the keys. The floor lifts by the inset, only
  // while a sheet is up and only below the breakpoint.
  //
  // THE NUMBER IS THE KIT'S. This screen used to measure the visual viewport
  // itself, and this test pinned that expression —
  // `window.innerHeight - vv.height - vv.offsetTop` — which #1938 proved wrong
  // on iOS, where innerHeight collapses to the visual viewport and the result
  // goes negative. A private copy is the thing to prevent, not to pin, so the
  // assertion is now that the screen takes the kit's published inset and does
  // NOT do its own arithmetic.
  assert.doesNotMatch(WORKSHOP, /window\.innerHeight\s*-\s*vv\.height/,
    'the workshop sheet must not re-derive the keyboard: read --un-kb-inset');
  assert.match(WORKSHOP, /classList\.contains\('un-kb'\)/);
  assert.match(WORKSHOP, /\}, \[sheet, wide\]\);/);
  assert.match(CSS, /\.dev-ws-sheet-modal \{\s*position: fixed; inset: 0; z-index: 40;[\s\S]*?bottom: var\(--un-kb-inset, 0px\);/);
  // Keys up: the card takes the strip above them, short of the status bar,
  // and drops the home-indicator clearance the keys now cover
  // (tests/needs-sheet-above-bars.test.js has the why).
  assert.match(CSS, /\.dev-ws-needs\[data-ws-kb\] \.dev-ws-sheet-card \{ max-height: calc\(100% - var\(--platform-safe-top, 0px\)\); padding-bottom: 12px; \}/);
  assert.match(CSS, /padding: 8px 16px calc\(12px \+ var\(--platform-safe-bottom, 0px\)\);/,
    'and the floor clears the home indicator');
  // OPEN CARD. The item is the whole screen, so the card's own page is a row
  // under More; the href rides on the trigger and app-view.js reads it.
  assert.match(WORKSHOP, /data-card-menu-open=\{cardHref \|\| undefined\}/);
  // #3488: the row's own project, on the Communities screen's feed.
  assert.match(WORKSHOP, /const cardHref = row \? openHref\(rowSlug\(row, slug\), row\.card\) : null;/);
  const appView = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
  assert.match(appView, /trigger\.dataset\.cardMenuOpen/);
  // The row is part of the ONE descriptor list every reader of the menu
  // uses, so a row's index means the same thing in the menu that opened and
  // in the refreshed one under it — prepending it in only the opener once
  // sent the first row's click to the wrong descriptor on a desktop.
  assert.match(appView, /_cardMenuItems\(key, own\)/);
  assert.match(appView, /_cardMenuItems\(open\.key, open\.own\)/);
  assert.match(appView, /label: 'Open card',/);
});

test('the lander fills its scroller without a percentage in the floor', () => {
  // THE BUG THIS PINS SHIPPED TWICE AND WAS INVISIBLE TO EVERY LOCAL CHECK.
  // The floor was `min-height: max(100%, var(--ws-area))`. FIREFOX does not
  // apply it: measured on the running app (Gecko 155), `.dev-ws` computed
  // `min-height: max(100%, 806.5px)` and used a height of 649px, leaving
  // 121px of unused scroller beneath it. A sticky bar cannot sit below its
  // own parent's bottom edge, so the rail rested there — and three rounds of
  // tuning `--ws-gap` and `bottom` moved numbers that were never the problem.
  // Chromium applies the same declaration correctly, so a headless harness
  // reported 8px while the app floated. The percentage is indefinite here and
  // the two engines disagree about what that does to the whole `max()`.
  //
  // So the rule is: NO PERCENTAGE IN THIS FLOOR, in either layout.
  assert.ok(!/\.dev-ws \{ min-height: max\(100%/.test(CSS),
    'the percentage floor is gone — Firefox drops it');
  assert.match(CSS, /html\[data-browser-scroller\] \.dev-ws \{ min-height: var\(--ws-area\); \}/,
    'the browser layout gets the viewport floor as a plain length');
  // The native layout does not use a floor at all: the scroller has a definite
  // height there, so the chain flexes and the lander takes what is left. That
  // also drops the dependency on --platform-header-h being right, and on how
  // much chrome sits above #dev-body (measured: 47px, which no viewport
  // subtraction knew about).
  assert.match(CSS, /#dev-forum-scroll:has\(> #dev-body > #dev-workshop\) \{ display: flex; flex-direction: column; \}/);
  // Both selectors carry TWO rules each (the padding one above shares
  // `#dev-body:has(> #dev-workshop)`), so match the block that actually holds
  // the flex declarations rather than the first block that matches the name.
  for (const sel of ['#dev-body:has\\(> #dev-workshop\\)', '#dev-workshop:has\\(> \\.dev-ws\\)']) {
    const blocks = [...CSS.matchAll(new RegExp(sel + ' \\{([^}]*)\\}', 'g'))].map((m) => m[1]);
    assert.ok(blocks.length, `${sel} has a rule`);
    const flexed = blocks.find((b) => /flex: 1 1 auto/.test(b));
    assert.ok(flexed, `${sel} is part of the flex chain`);
    assert.match(flexed, /min-height: 0/);
  }
  // And the width is explicit, because `#dev-workshop` centres with
  // `margin: 0 auto` and auto margins on a flex column's cross axis ABSORB
  // the free space instead of stretching. Without it the pane collapsed to
  // content: measured 760 -> 640 on By category and 1432 -> 310 on By stage.
  assert.match(CSS, /#dev-workshop:has\(> \.dev-ws\) \{[^}]*width: 100%/);
  assert.match(CSS, /#dev-workshop > \.dev-ws \{ flex: 1 1 auto; width: 100%; \}/);
});

test('the growing tabs keep the tab-bar clearance at the foot of the scroller (#3053)', () => {
  // "Unable to scroll down to see last issue on mobile." In the NATIVE layout
  // the chain's `min-height: 0` let #dev-body and #dev-workshop shrink to the
  // scroller while `.dev-ws` (Current status, All items) overflowed them — and
  // a scroller's block-end padding follows its in-flow children, not an
  // overflowing descendant, so `.platform-safe-scroll` reserved nothing and
  // the last item's foot ended under the fixed tab bar. Measured with the real
  // app.css at 390x844: the last card 13px past the bar's top edge before,
  // 51px clear of it after.
  // Not the fitted tabs, Needs you and Discussion (#852 review).
  const rule = /#dev-body:has\(> #dev-workshop > \.dev-ws:not\(\[data-ws-tab="needs"\]\):not\(\[data-ws-tab="discussion"\]\)\),\s*#dev-workshop:has\(> \.dev-ws:not\(\[data-ws-tab="needs"\]\):not\(\[data-ws-tab="discussion"\]\)\) \{ flex-shrink: 0; \}/;
  assert.match(CSS, rule, 'the two links above a growing tab do not shrink');
  // It lands AFTER the chain it overrides, so equal-or-higher specificity and
  // source order both favour it.
  assert.ok(CSS.search(rule) > CSS.indexOf('#dev-body:has(> #dev-workshop) {\n  flex: 1 1 auto; min-height: 0;'),
    'declared after the flex chain');
  // Needs you is left bounded — it is the tab the chain exists for.
  assert.doesNotMatch(CSS, /#dev-body:has\(> #dev-workshop\) \{[^}]*flex-shrink: 0/);
  // And the scroller still carries the clearance this relies on.
  const frame = read('frontend/src/features/dev-board/board-frame.tsx');
  assert.match(frame, /id="dev-forum-scroll"\s+className="[^"]*\bplatform-safe-scroll\b/);
});

test('the ask box is a sheet on a phone and a panel on a wide window', () => {
  // It was floating well clear of the bar, for two different reasons.
  //
  // ON A PHONE the deck filled its box exactly and the box stopped 80px
  // short: `.dev-ws-tabbody` reserves the rail's height so the last card of a
  // SCROLLING tab can be read clear of a bar that overlays it. Needs you does
  // not scroll under the rail — it is one fitted decision per screen — so
  // that clearance was dead space pushing the composer up. Measured at
  // 402x874: 90px between the ask box and the bar. The clearance now lifts on
  // that tab alone.
  // THAT EXEMPTION IS GONE, and its reasoning with it. It read: the deck is
  // fitted, nothing ever passes beneath the rail, so the clearance is dead
  // space pushing the composer up — 90px of it at 402x874. True while the rail
  // sat IN FLOW and took its own space at the foot of the column. The bar is
  // fixed now and overlays every tab equally, fitted or not: with the
  // exemption still in, the deck filled to the foot of `.dev-ws` and the
  // composer ran 63px UNDER the bar. The deck instead ends above it because
  // `--ws-area` subtracts `--ws-bar`, which is what keeps the composer clear
  // without a per-tab special case — measured 9px above the bar at a 0px inset
  // and at a 34px one, which is the point: one number, both devices.
  assert.ok(!/\.dev-ws\[data-ws-tab="needs"\] > \.dev-ws-tabbody \{ padding-bottom: 0/.test(
    CSS.replace(/\/\*[\s\S]*?\*\//g, '')));
  // ON A WIDE WINDOW there is no ask box at the floor any more. The ask is a
  // PANEL beside the rail, the stage is a row — card, rail, panel — and the
  // item's card is what takes the height. Its rules ride the one wide block
  // the strip already has, because that block is the breakpoint.
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(wide, 'the wide block exists');
  assert.match(wide[1], /THE FEED ON A WIDE WINDOW: THE STAGE/, 'and the feed\'s rules are in it, not in a second one');
  assert.match(wide[1], /\.dev-ws-needs \{\s*flex-direction: row;/, 'the lander is a row: card, rail, panel');
  assert.match(wide[1], /\.dev-ws-sheet-ask, \.dev-ws-sheet-comments, \.dev-ws-sheet-description \{\s*position: relative; inset: auto; flex: 0 0 400px;/,
    'ask, comments and the description are panels');
  assert.match(wide[1], /\.dev-ws-sheet-vote \{ position: absolute;/, 'and the vote is a popover on its button');
  assert.ok(!/\.dev-ws-needs > \.dev-ws-ask/.test(CSS), 'nothing pins an ask box to the floor');
  // Both now measure 10px above the bar — `.dev-ws`'s own column gap, which is
  // the floor for anything sitting directly above the rail.
});

test('the feed answers on the Vote sheet and moves by swipe, arrows or keys', () => {
  // THE ANSWERS ARE ON THE SHEET. The rail's Vote control opens the question
  // and records nothing by itself — a thumbs-up on a rail reads as "like",
  // and a queue answered by reflex is answered carelessly. Yes and No sit
  // together on the sheet with the tally, and Cancel closes it. #3613: they
  // are the card's own VotePicker, inline — the switch, the line for the
  // group under it and the send — not two buttons followed by a prompt card.
  assert.ok(!/data-ws-answer-btn="skip"/.test(WORKSHOP), 'skip is gone from the answers');
  assert.ok(!/dev-ws-answer-skip/.test(WORKSHOP), 'and so is its button');
  assert.match(WORKSHOP, /data-ws-rail-btn="vote"[\s\S]{0,400}?onClick=\{\(\) => toggleSheet\('vote'\)\}/, 'Vote opens the sheet');
  assert.match(WORKSHOP, /<NeedsVoteForm[\s\S]{0,400}?onCancel=\{closeSheet\}\s*onSend=\{submitVote\}/, 'the sheet holds the vote form');
  assert.match(WORKSHOP, /data-ws-vote-form=""[\s\S]{0,120}?<VotePicker[\s\S]{0,900}?withLine/, 'which is the card\'s picker, with its line box');
  assert.ok(!/data-ws-answer-btn="(yes|no)"/.test(WORKSHOP), 'the bare Yes/No pair is gone');
  assert.match(WORKSHOP, /answer\(voteSide, undefined, voteTrimmed \|\| null\)/, 'the sheet sends its line, so castVote does not ask again');
  assert.match(WORKSHOP, /const opts = reason === undefined \? \{ onSend \} : \{ onSend, reason \};/, 'only the swipe leaves the line to castVote');
  // NOTHING ADVANCES ON ITS OWN. The deck used to jump half a second after a
  // vote, which in a feed reads as the card vanishing under the press: the
  // row is pinned in place with its confirmation until you move on.
  assert.ok(!/window\.setTimeout\(\(\) => setAt\(i \+ 1\)/.test(WORKSHOP), 'no auto-advance');
  // #3052: at the index of the item answered, which a swipe names (`at`
  // defaults to `i`, the item in view, for a press or a key).
  assert.match(WORKSHOP, /pinsRef\.current\.set\(row\.key, \{ row, index: at \}\);/, 'the answered row is pinned');
  // AND STAYS PINNED. The pins used to be dropped once the next card had
  // settled, which removed the voted row from ABOVE the one in view: every
  // index after it moved, the counter re-numbered, the index-keyed tint
  // flipped, and the scroll correction — a `scrollTop` assignment under the
  // scroller's `scroll-behavior: smooth` — animated the card back into place.
  // That was "the card I just arrived on resets a second later".
  assert.ok(!/dropPins|settleRef/.test(WORKSHOP), 'no pin is dropped on a move');
  assert.match(WORKSHOP, /const tintRef = useRef<Map<string, 'a' \| 'b'>>\(new Map\(\)\);/,
    'a row\'s tint is decided once, from where it first stood');
  assert.match(WORKSHOP, /tint=\{tints\[k\]\}/);
  assert.match(WORKSHOP, /tint = prev === 'a' \? 'b' : 'a'; seen\.set\(r\.key, tint\);/,
    'a row seen for the first time takes the opposite of the row above it');
  assert.ok(!/data-ws-tint=\{index % 2/.test(WORKSHOP), 'and never from the index of the moment');
  assert.match(WORKSHOP, /el\.style\.scrollBehavior = 'auto';\s*el\.scrollTop = idx \* el\.clientHeight;\s*el\.style\.scrollBehavior = '';/,
    'a position correction is instant, whatever the scroller\'s own behaviour');
  assert.match(WORKSHOP, /\$\{answeredWords\(row, voted\)\} · \$\{wide \? 'press ↓ or scroll' : 'swipe up'\} for the next/,
    'and the eyebrow becomes the confirmation');
  // "Voted yes", or on a Just-you change "Approved" / "Not approved" (#3977).
  assert.match(WORKSHOP, /if \(!approves\(row\)\) return `Voted \$\{voted\}`;\s*return voted === 'yes' \? 'Approved' : 'Not approved';/);
  // THE ARROWS: icon buttons with a NAME, since a chevron alone has none,
  // disabled at the ends rather than wrapping. Hidden on a phone, where the
  // swipe is the move; on a wide window they do what the wheel does.
  assert.match(WORKSHOP, /<div className="dev-ws-move" data-ws-move-row="">/);
  for (const [dir, guard, name] of [
    ['prev', /disabled=\{i <= 0\}/, /aria-label="Previous"/],
    // `n`, not `n - 1`: the end card is the last slot (#2172).
    ['next', /disabled=\{i >= n\}/, /aria-label="Next"/],
  ]) {
    const btn = new RegExp(`data-ws-move="${dir}"[\\s\\S]{0,240}?</button>`).exec(WORKSHOP);
    assert.ok(btn, `the ${dir} control exists`);
    assert.match(btn[0], guard, `${dir} is disabled at its end rather than wrapping`);
    assert.match(btn[0], name, `${dir} is named`);
  }
  assert.match(CSS, /\.dev-ws-move \{ display: none; \}/, 'no arrows on a phone');
  // The count rides each item's own top line beside its eyebrow: it answers
  // "where am I" for the thing in front of you.
  assert.match(WORKSHOP, /className="dev-ws-item-of">\{`\$\{index \+ 1\} \/ \$\{count\}`\}/);
  // #3517: AND ON A PHONE, THE WAY BACK beside it. The arrows above are a
  // wide window's, so a phone had only the swipe down, which nothing on the
  // card mentioned (and which the refresh gesture used to take: see
  // platform-ui.test.js). A named button, from the second item on, handed
  // down only below the breakpoint, stable so the memo()'d items skip a
  // render, and going back by the same `go` the keys and arrows use.
  const prev = /\{onPrev && index > 0 \? \(\s*<button[^>]*data-ws-item-prev=""[^>]*>/.exec(WORKSHOP);
  assert.ok(prev, 'the item draws its Previous from the second item on, when handed one');
  assert.match(prev[0], /aria-label="Previous item"/, 'a chevron alone has no name');
  assert.match(prev[0], /onClick=\{onPrev\}/);
  assert.match(WORKSHOP, /onPrev=\{wide \? undefined : prevItem\}/, 'a phone only: a wide window has the arrows');
  assert.match(WORKSHOP, /const prevItem = useCallback\(\(\) => goRef\.current\(-1\), \[\]\);/);
  // Held to the counter's line, so the title does not move between the
  // first item (no button) and the rest.
  assert.match(CSS, /\.dev-ws-item-prev \{[^}]*width: 26px; height: 26px; margin: -3px -4px -3px auto;/);
  // THE KEYS, every one also a button on the rail, ignored while a field has
  // focus, and listed only where a keyboard is likely (app.css hides the
  // legend on a phone).
  assert.match(WORKSHOP, /if \(t && \(t\.tagName === 'INPUT' \|\| t\.tagName === 'TEXTAREA'/, 'typing is typing');
  for (const key of ["'ArrowDown'", "'ArrowUp'", "'v' || k === 'V'", "'a' || k === 'A'", "'c' || k === 'C'", "'t' || k === 'T'", "'m' || k === 'M'", "'Escape'"]) {
    assert.ok(WORKSHOP.includes(`k === ${key}`), `${key} is bound`);
  }
  assert.match(CSS, /\.dev-ws-keys \{ display: none; \}/, 'the legend is off on a phone');
  // NO WRAP, and no reordering: the ends are the ends, the counter says
  // which one you are at, and you walk back yourself.
  // `n`, the end card's slot, is the last a press reaches (#2172).
  assert.match(WORKSHOP, /const idx = Math\.min\(Math\.max\(i \+ delta, 0\), n\);/);
  assert.ok(!/setSkipped/.test(WORKSHOP), 'the re-queue went with the button it belonged to');
  assert.match(WORKSHOP, /const live = rows\.filter\(\(r\): r is QueueRow => r\.t === 'card'\);/,
    'the feed keeps the order it was published in');
});

test('the project page opens on the page you last used', () => {
  // The hub and its pages are different jobs, and the one you want is usually
  // the one you wanted last time — somebody working the vote queue landed on
  // the digest every single visit. Stored per browser: it is a reading
  // position, not a setting, and it reuses the mechanism the grouping has.
  assert.match(APP_VIEW_SRC, /WORKSHOP_TAB_KEY: 'devWorkshopTab',/);
  const read = /_workshopTab\(\) \{([\s\S]*?)\n  \},/.exec(APP_VIEW_SRC);
  assert.ok(read, '_workshopTab resolves it');
  // ORDER MATTERS: the deep link wins, then what you chose, then the default.
  // A declared check runs against an empty localStorage, so `?ws=` losing to
  // a stored value would make every one of them assert the wrong tab.
  assert.match(read[1], /const url = AppView\._workshopTabParam\(\);\s*if \(url\) return url;/);
  assert.match(read[1], /localStorage\.getItem\(AppView\.WORKSHOP_TAB_KEY\)/);
  assert.match(read[1], /return 'status';/);
  // And an explicit tap retires the URL override, exactly as the grouping
  // does — otherwise `?ws=` would keep winning over every later press.
  const write = /_setWorkshopTab\(key\) \{([\s\S]*?)\n  \},/.exec(APP_VIEW_SRC);
  assert.ok(write, '_setWorkshopTab stores it');
  assert.match(write[1], /AppView\._workshopTabUrlOverride = null;/);
  assert.match(write[1], /localStorage\.setItem\(AppView\.WORKSHOP_TAB_KEY, next\)/);
  // The view model publishes the RESOLVED tab, not the raw parameter.
  assert.match(APP_VIEW_SRC, /tab: AppView\._workshopTab\(\),/);
  assert.match(WORKSHOP, /onOpen=\{\(\) => openTab\('needs'\)\}/);
  assert.match(WORKSHOP, /onBack=\{\(\) => openTab\(pageParent\(tab\)\)\}/);
  // Every tab turns the page, Homeroom's Discussion (#general) included (#3494).
  assert.match(WORKSHOP, /const openTab = \(next: TabKey\) => \{\s*setTab\(next\);\s*callAppView\('_setWorkshopTab', next\);/);
});

test('a category card is raised off the pane it sits on', () => {
  // It took `--dc-sheet-fill`, the SAME value as the pane beneath it, so in
  // dark mode the card was rgba(28,28,30,.72) on rgba(28,28,30,.72) with only
  // a 12%-white hairline between them. Light mode got away with it because
  // its hairline is 10% BLACK on near-white, which reads far harder.
  assert.match(CSS, /--dc-sheet-raise: #ffffff;/, 'light');
  assert.match(CSS, /--dc-sheet-raise: #2c2c2e;/, 'dark, one step up the same ramp as the sheet');
  const card = /\.dev-ws-theme \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(card, 'the card rule exists');
  assert.match(card[1], /background-color: var\(--dc-sheet-raise\);/);
  // Opaque, so no frost: it blurs what is BEHIND, and what is behind is a
  // pane of one flat colour — a compositing layer per card for nothing.
  assert.ok(!/backdrop-filter/.test(card[1]), 'the frost went with it');
});

test('a wide window reads the tabs at the top, as a segmented control', () => {
  // THE PILL IS A PHONE CONVENTION. Pinned to the floor of a 900px window it
  // puts the switch as far from the reading as the window allows, and the eye
  // crosses the whole height to use it. Above 700px — the breakpoint the deck
  // already uses, so the two stay in step — the bar comes off the floor.
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(wide, 'the wide-screen block exists');
  // ONE block at this breakpoint, not two: a second would sit below the deck
  // rules and the regex above would read only the first, so a rule could be
  // added here and silently go unchecked.
  assert.equal((CSS.match(/@media \(min-width: 700px\) \{/g) || []).length, 1,
    'the breakpoint is written once');

  // NOT AN UNDERLINED ROW. That shape separates by RULE where this product
  // separates by figure and ground — the distinction @/components/ui/tabs.tsx
  // spells out where it retired the same underline from the Leaderboard's
  // strip — and it reads as a code-hosting tool bolted to a consumer one.
  // Comments stripped first: the block above explains WHY the underline went,
  // and prose naming it is not the declaration this forbids.
  const decls = wide[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/border-bottom: 2px solid/.test(decls), 'no underline on the tab');
  assert.ok(!/border-bottom-color: var\(--brand-ink\)/.test(decls),
    'and none carrying the accent under the selected one');

  const rail = /\.dev-ws-tabs \{([\s\S]*?)\n  \}/.exec(wide[1]);
  assert.ok(rail, 'the rail is restyled for width');
  // `order: 0` is the whole move — the nav is already first in the DOM, so
  // dropping the phone's `order: 1` paints it where it is written.
  assert.match(rail[1], /order: 0;/, 'it paints where it is written');
  // STICKY, not static — and sticky is positioned, so it remains the
  // containing block for the selection marker and the element its tabs'
  // offsetLeft/offsetTop resolve against, which is all `relative` was ever
  // here for. The strip PINS now: it is one band with the ear and the head.
  assert.match(rail[1], /position: sticky;/, 'still the containing block for the marker');
  // The offset is set AFTER `inset: auto`, or the shorthand resets it and the
  // strip pins to nothing. Measured when it was written above: the strip's top
  // went to -890 on a 900px scroll while the head it travels with stayed.
  // #3583: the offset is `--ws-pin-top` now, the header's foot, rather than
  // 0: the order is the same rule.
  const insetAt = rail[1].indexOf('inset: auto;');
  const topAt = rail[1].indexOf('top: var(--ws-pin-top, 0px);');
  assert.ok(insetAt > 0 && topAt > insetAt, '`top` comes after `inset: auto`');
  // THE PHONE BAR'S BOX DOES NOT COME UP HERE, and all three of these are
  // regressions, not tidying. `left/right/bottom` place a FIXED pill against
  // the viewport; `position: relative` does not ignore them, it SHIFTS by
  // them — so the strip sat 10px right of the column it aligns to and 8px
  // (`--ws-lift`) above its own place in the flow. Measured in Chromium at
  // 1280px: 2px of air above the strip and 18px below, against the 10 and 10
  // the two rules here declare. `max-width`/`margin-inline` leak the same way
  // and cost the alignment below — 740px with auto side margins is a
  // shrink-to-fit box that has already centred itself, and nothing can be
  // left-aligned inside one.
  assert.match(rail[1], /inset: auto;/, 'the fixed offsets do not follow it into the flow');
  assert.match(rail[1], /max-width: none;/, "and neither does the pill's width bound");
  assert.match(rail[1], /\n    margin: 0;/, 'nor its auto side margins');
  // LEFT-ALIGNED, not centred. The pill inside is content-width, so whatever
  // positions the pill decides where the strip appears — and the nav spans the
  // same reading column the pane below it does, so `flex-start` puts the
  // strip's left edge on the pane's left edge. Centred, it sat on the WINDOW's
  // centre line, which belongs to no edge on the screen at any width.
  assert.match(rail[1], /display: flex;\n    justify-content: flex-start;/,
    "the strip is left-aligned, on the reading column's own edge");
  // AND IT IS WHAT SETTLES THE SELECTION MARKER. The marker is placed from
  // `offsetLeft` against this nav, and under `justify-content: center` that
  // number is `(nav - pill) / 2` plus the tab's own — so it MOVED whenever the
  // nav's width did, for a tab that had not moved on screen. Switching the All
  // items pane between By category and By stage gives the nav two widths, and
  // the marker's coordinate jumped 158px for an unmoved tab, which the
  // transition then animated. At `flex-start` the pill sits at offset 0 and
  // the number is the tab's own, whatever the nav is doing.
  assert.ok(!/justify-content: center/.test(decls),
    'a centred strip re-expresses an unmoved tab every time the nav resizes');
  // FLEX, NOT `text-align: center`. An inline-level box placed by an INHERITED
  // property is one stray `text-align` on any ancestor away from moving on its
  // own — which is the class of bug this is fixing, not a shape to re-enter.
  assert.ok(!/text-align/.test(decls), 'nothing here positions by inheritance');
  assert.match(rail[1], /background: none; backdrop-filter: none;/,
    'the frost belongs to the floating phone bar, not to a strip in the flow');

  const track = /\.dev-ws-tabtrack \{([\s\S]*?)\n  \}/.exec(wide[1]);
  assert.ok(track, 'the track holds the pill and the "+"');
  // `inline-flex` so it hugs its three labels: a segmented control spanning
  // the reading column reads as a header bar rather than as a control, which
  // is the same reason SECTION_TABS_LIST is inline-flex.
  assert.match(track[1], /display: inline-flex;/, 'it hugs its labels');
  // #2934: THE TRACK DRAWS NOTHING. It was the pill, with the "+" as its last
  // segment; the pill's material moved onto the tab list and the "+"'s
  // wrapper, so the "+" is its own circle a gap after the pill.
  assert.ok(!/background|padding|border-radius/.test(track[1]),
    'the surface is on its two items, not on the track');
  const pill = /\n  \.dev-ws-tablist, \.dev-ws-tabtrack > \.dev-ws-plus \{([\s\S]*?)\n  \}/.exec(wide[1]);
  assert.ok(pill, 'the tab list and the "+" draw the surface at this width');

  // THE AIR ABOVE AND BELOW IS ONE NUMBER. `.dev-ws` is a flex column with
  // `gap: 10px`, so a `margin-bottom` on the nav STACKS on it — 14px below
  // against the 8px of `#dev-body` padding above, which is the lopsided air
  // the strip sat in. The gap alone sets the bottom; the padding is raised to
  // match it, and neither side carries a number the other does not.
  assert.match(CSS, /\.dev-ws \{ display: flex; flex-direction: column; gap: 10px; \}/);
  assert.ok(!/margin-bottom: 4px;/.test(rail[1]), 'no margin stacked on the column gap');
  assert.match(wide[1], /#dev-body:has\(> #dev-workshop\) \{ padding-top: 10px; \}/,
    'and the space above equals it');
  assert.match(pill[1], /border-radius: 9999px;/);
  // A TOKEN, NOT A LITERAL WHITE. The mock that sold this option hardcoded
  // #ffffff and rendered a glaring slab in dark mode; --dc-sheet-raise is the
  // raised surface the category cards already use and carries both values.
  assert.match(pill[1], /background-color: var\(--dc-sheet-raise\);/);
  assert.ok(!/#fff/i.test(pill[1]), 'no literal white to strand dark mode');

  const tab = /\.dev-ws-tab \{([\s\S]*?)\n  \}/.exec(wide[1]);
  assert.ok(tab, 'the tab is restyled too');
  // SECTION_TAB_BASE's geometry, transcribed: h-8, px-4, rounded-full.
  assert.match(tab[1], /height: 32px; padding: 0 16px;/);
  assert.match(tab[1], /border-radius: 9999px;/);
  assert.match(tab[1], /flex: 0 0 auto; flex-direction: row;/,
    'sized to its text, not a stretched third of the column');

  // THE SELECTED STATE IS NOT RESTATED AT THIS WIDTH. The phone's periwinkle
  // carries through, so the two widths are one control at two sizes. A desktop
  // override here would be the bug, not the fix.
  assert.ok(!/\.dev-ws-tab\[aria-selected="true"\]/.test(wide[1]),
    'the phone rule carries through');
  // THE PERIWINKLE MOVED TO THE MARKER, which is what lets the selection slide
  // instead of snapping: a background drawn by the tab itself can only appear
  // on one and vanish from another. The tab keeps the ink, which has nothing
  // to animate between.
  assert.match(CSS, /\.dev-ws-tab\[aria-selected="true"\] \{\s*color: var\(--lit-ink\);\s*\}/,
    'the selected tab is ink only');
  assert.match(CSS, /\.dev-ws-tab-marker \{[\s\S]*?background: var\(--lit-tint\);/,
    'and the fill is the marker, at both widths — it carries no breakpoint');

  // Nothing overlays the content at ANY width now (#2767), so the tab body
  // carries no clearance in its base rule and the wide block has nothing to
  // take back off.
  assert.ok(!/\.dev-ws-tabbody \{[^}]*padding-bottom/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')),
    'no clearance for a bar that no longer floats');

  // The markup half: the track exists and is inert on a phone, so the bar
  // there is byte-identical to what it was.
  assert.match(read('frontend/src/features/dev-board/workshop/project-band.tsx'), /<div className="dev-ws-tabtrack" role="tablist"/);
  assert.match(CSS, /\.dev-ws-tabtrack \{ display: contents; \}/,
    'the wrapper introduces no box on a phone');
});

test('the read-only demo check names the pane its proposal is actually on', () => {
  // #621 asserts one string — the seeded proposal's title — is on the demo
  // app's Dev tab. The rework put it behind two choices and `&ws=all` alone
  // was not enough, so the check went red and stayed red through a merge.
  //
  // ALL ITEMS DEFAULTS TO "BY CATEGORY", AND A CATEGORY CARD IS COLLAPSED.
  // It renders the category's name, its saying and its count chips; the lanes
  // holding item titles are behind `open`. So the title is not merely below
  // the fold on that pane — it is not in the document. By stage renders the
  // board's own columns, where every row is a card with its title.
  //
  // `&col=inreview` because the seed (src/db/migrate.js) inserts the proposal
  // `promoted`, which `_kanbanView` buckets into `inreview` — and at phone
  // width the board shows ONE column, so without it the check passes at
  // 1280px and fails at 402px depending on the runner's viewport. Measured
  // against the real components at 402, 800 and 1280: absent on category at
  // every width, absent on stage/issues at 402, present and painted on
  // stage/inreview at all three.
  const dapp = JSON.parse(read('dapp.json'));
  const found = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    if (typeof o.expectText === 'string' && o.expectText === 'Staging demo read-only proposal') found.push(o);
    Object.values(o).forEach(walk);
  };
  walk(dapp);
  assert.equal(found.length, 1, 'exactly one check asserts the seeded proposal');
  const p = found[0].path;
  assert.match(p, /[?&]ws=all(&|$)/, 'the tab, since the lander opens on Current status');
  assert.match(p, /[?&]group=stage(&|$)/, 'the pane that lists item titles');
  assert.match(p, /[?&]col=inreview(&|$)/, 'the column a promoted proposal buckets into');
  // The bucketing this leans on, pinned here so moving `promoted` to another
  // column fails locally rather than as a red check on somebody's proposal.
  assert.match(APP_VIEW_SRC, /key: 'inreview', title: 'Waiting for approval'/);
  assert.match(APP_VIEW_SRC, /rows: cardRows\(\s*kInReview,\s*\(x\) => \(x\.kind === 'proposal'/);
});

// ── #2176: the tiles count calendar weeks ────────────────────────────

test('#2176: "shipped this week" is the calendar week from Monday 00:00 UTC, not a trailing seven days', () => {
  const AppView = makeAppView();
  seed(AppView);
  const monday = AppView._weekStart(Date.now());
  assert.equal(new Date(monday).getUTCDay(), 1, 'the week starts on a Monday');
  assert.equal(monday % 86400000, 0, 'at midnight UTC');
  const iso = (ms) => new Date(ms).toISOString();
  const row = (id, ms) => ({
    id, pr_number: id, pr_title: `Merge ${id}`, status: 'merged', username: 'alice',
    merged_at: iso(ms), created_at: iso(ms), row_type: 'pr',
  });
  AppView._merged = [
    row(1, monday + 3600000),              // this week
    row(2, monday - 1000),                 // one second before Monday: last week
    row(3, monday - 7 * 86400000 + 1000),  // the first second of last week
    row(4, monday - 7 * 86400000 - 1000),  // the week before that: neither
  ];
  const d = AppView._workshopView().dashboard;
  assert.equal(d.shippedWeek, 1, 'only what landed since Monday');
  assert.equal(d.shippedPrevWeek, 2, 'the whole seven days before that Monday');
  const html = workshopHtml(AppView, 'workshop');
  assert.match(html, /data-ws-dash-cell="shipped" title="This calendar week, counted from Monday 00:00 UTC\."/,
    'the tile says which week it means');
});

// ── #2182: the viewer's strip stays on screen when it is empty ───────

test('#2182: "What you are working on" stays on screen with nothing in it, and says so', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  // Nothing of the viewer's: no session, and the proposal is somebody else's.
  AppView._mySessions = [];
  for (const p of AppView._proposals) p.user_id = 999;
  const v = AppView._workshopView();
  assert.equal(v.mine.viewer, true);
  assert.equal(v.mine.rows.length, 0);
  const html = workshopHtml(AppView, 'workshop');
  assert.ok(html.includes('data-ws-mine=""'), 'the strip is drawn');
  // BUG g: the note sent the viewer to "start something from the + button",
  // and the "+" had no propose row then. It named the Homeroom menu's
  // Build it now (B8), and names the hub's ⋯ one now: the menu's shows
  // only for somebody who has had an agent session (first-session
  // run-through, 5 Oct 2026), and the ⋯'s is there for every writer.
  assert.equal(v.mine.bot, false, 'Homeroom bot does not build here');
  assert.match(html, /data-ws-lane="mine"><p class="[^"]*" data-ws-mine-empty="">You have no work going on\. Pick up an open item in All items, or press ⋯ on the hub and use Build it now\.<\/p>/,
    'with the note in the lane');
  assert.doesNotMatch(html, /Start a new change in the Homeroom menu/, 'not the row\'s old name');
  assert.doesNotMatch(html, /Build it now in the Homeroom menu/, 'nor a row a newcomer does not have');
  assert.doesNotMatch(html, /start something from the \+ button/, 'and not the door that cannot open');
  // A read-only viewer has neither door (no New change, no board writes), so
  // the note states the fact and offers nothing to press.
  withDevActions({ readOnly: true }, () => {
    const ro = workshopHtml(AppView, 'workshop');
    assert.match(ro, /data-ws-mine-empty="">You have no work going on\.<\/p>/,
      'a read-only viewer is told the fact alone');
  });
  assert.ok(!html.includes('data-ws-mine-more'), 'and no more-of-yours button');
  assert.ok(html.indexOf('data-ws-dashboard') < html.indexOf('data-ws-mine=""'), 'in its place, under All items');
  // First-session run-through, 5 Oct 2026: where Homeroom bot builds for
  // this viewer (the request pages' door, AppView._botDoor), the way in is
  // asking it, not the developer path.
  AppView._ghIssuesMeta = { ...(AppView._ghIssuesMeta || {}), homeroomBot: { typicalMinutes: 8 } };
  assert.equal(AppView._workshopView().mine.bot, true);
  const bot = workshopHtml(AppView, 'workshop');
  assert.match(bot, /data-ws-mine-empty="">You have no work going on\. To change something, tell Homeroom bot, or use Suggest an improvement in the Homeroom menu\.<\/p>/,
    'the bot\'s project points at asking for a change');
  assert.doesNotMatch(bot, /Pick up an open item|Build it now/, 'and not at building it');
  withDevActions({ readOnly: true }, () => {
    assert.match(workshopHtml(AppView, 'workshop'), /data-ws-mine-empty="">You have no work going on\.<\/p>/,
      'a read-only viewer is still told the fact alone');
  });
  // The declared check reaches this state through ?shot=mine-empty, whatever
  // the demo seeded for the viewer.
  const Seeded = makeAppView();
  seed(Seeded);
  Seeded._mySessions = [{ id: 51, session_title: 'Bottom tabs', pr_number: null, last_activity_at: at(0) }];
  assert.ok(Seeded._workshopView().mine.rows.length > 0, 'the viewer has work');
  Seeded._workshopShot = 'mine-empty';
  assert.equal(Seeded._workshopView().mine.rows.length, 0);
  assert.ok(workshopHtml(Seeded, 'workshop').includes('data-ws-mine-empty=""'));
});

test('#2182: a guest has no strip to keep', () => {
  const AppView = makeAppView({ App: { user: null, currentApp: 'demo-app', currentSubTab: 'forum' } });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const v = AppView._workshopView();
  assert.equal(v.mine.viewer, false);
  assert.ok(!workshopHtml(AppView).includes('data-ws-mine='), 'no empty strip for a reader with no work to have');
});

// ── #1933: the category chip on the Board's cards ───────────────────────
//
// The themes are the Workshop's grouping, and until now they were visible
// ONLY as that pane's headings: the Board's columns and the stage pane sort
// by state, and a card there said nothing about where the model had placed
// it. The chip is the theme's name on the card's meta line, looked up by the
// same key the server placed the card under.

test('#1933: a card names the category it was placed in, and tapping it votes', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._sharedSessions = [
    { id: 56, session_title: 'Shared thing', status: 'active', shared_at: at(1), linked_issues: [], created_at: at(1), last_activity_at: at(0) },
  ];
  // ONE chip. The bespoke `key: 'theme'` badge is gone: there is one grouping
  // now, so the card's own CATEGORY chip shows it — and unlike the badge it
  // replaced, a tap on it opens the attribute popover and lets you vote.
  const chipOf = (card) => (card.badges || []).find((b) => b && b.key === 'attr:category') || null;

  // No categories yet and no votes: nothing is drawn at all, so a slow fetch
  // never paints a name it has not confirmed. (A dense card omits an unset
  // chip; that is the behaviour this rides on, unchanged.)
  AppView._workshopThemes = null;
  assert.equal(chipOf(AppView._issueCardModel(AppView._ghIssues[0])), null);

  AppView._workshopThemes = themes([
    { id: 'theming', name: 'Theming', items: ['issue:12', 'session:34', 'session:56', 'session:78'] },
  ]);
  const issue = chipOf(AppView._issueCardModel(AppView._ghIssues[0]));
  assert.ok(issue, 'the issue the category names carries the chip');
  // The shape that makes it tappable: the same `t: 'attr'` the priority and
  // assignee chips use, addressed at the row this card votes under.
  assert.equal(issue.t, 'attr');
  assert.equal(issue.field, 'category');
  assert.equal(issue.targetType, 'issue');
  assert.equal(issue.targetRef, 12);
  assert.equal(issue.readonly, false);
  assert.equal(issue.label.text, 'Theming', 'and it names where the card actually sits');
  assert.equal(issue.cls, AppView._categoryTint('theming').cls,
    'one category is one colour on every card, through the same hash the custom category chips use');
  // The title says the placement is the MODEL'S and can be voted away — the
  // question the old flat badge left a reader with and could not answer.
  assert.match(issue.title, /Placed automatically/);
  assert.match(issue.title, /vote for a different category/);
});

test('#1933: under the "By category" pane the row leaves the chip out, because the heading already says it', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 'theming', name: 'Theming', items: ['issue:12', 'session:34'] }]);
  const chipOf = (row) => (row.card.badges || []).find((b) => b && b.key === 'attr:category') || null;
  const lane = (t, k) => t.lanes.find((l) => l.key === k);

  AppView._getWorkshopGroup = () => 'category';
  const grouped = AppView._workshopView();
  // #4486: the CARD keeps its chip whichever grouping is up: the same rows
  // are the Workshop tab's since list, which draws the chip. The lane's rows
  // leave it out themselves (`category={false}`).
  assert.equal(chipOf(lane(grouped.themes[0], 'open').rows[0]).label.text, 'Theming');
  AppView._workshopShot = 'themes';
  const html = workshopHtml(AppView, 'all');
  const body = html.slice(html.indexOf('dev-ws-theme-body'));
  assert.ok(body.includes('data-ws-row="issue:12"'), 'the row is drawn');
  assert.ok(!/data-attr-field="category"/.test(body), 'with no chip under its own heading');
  assert.match(WORKSHOP, /<WorkList rows=\{rows\} slug=\{slug\} openKey=\{openKey\} onOpen=\{onOpen\} variant="board" category=\{false\} \/>/);
  // The vote strip is not grouped by category, so its card keeps the name.
  assert.equal(grouped.votes.rows.length, 1);
  assert.equal(chipOf(grouped.votes.rows[0]).label.text, 'Theming');
});

test('#1933: the themes landing repaints whichever surface is up, not only the Workshop pane', async () => {
  const AppView = makeAppView({
    fetch: async () => ({ ok: true, json: async () => ({ themes: [{ id: 't', name: 'T', items: ['issue:12'] }], source: 'ai' }) }),
  });
  seed(AppView);
  let repaints = 0;
  AppView._repaintBoardSurface = () => { repaints += 1; };
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(AppView._workshopThemes.themes.length, 1);
  assert.equal(repaints, 1, 'the board repaints so its cards can pick up their chips');
});

test('#1933: the declared check reads the chip off a demo issue card on the board', () => {
  const check = dapp.tests.find((t) => /#1933/.test(t.name || ''));
  assert.ok(check, 'declared');
  assert.match(check.path, /demo=1.*#app\/usernode-2d5619\/board$/);
  // `data-issue-row`, not `data-ref-issue`: the Board draws FOLDED rows, and
  // a folded row carries only the item hooks (fold.tsx ITEM_HOOKS), which is
  // the one the first run of this check learned the hard way.
  // The chip is a real attribute chip now, not a flat badge, so the check
  // selects the hooks that make it votable rather than the retired
  // `data-theme-chip` marker — a stronger assertion than the one it replaces.
  assert.match(check.expectSelector,
    /#dev-kanban \[data-issue-row="900001"\] \[data-attr-chip\]\[data-attr-field="category"\]/);
  assert.equal(check.expectText, '[Mock] Appearance & theming');
  // The name and the placement it asserts are the staging demo theme's.
  const route = read('src/routes/workshop-themes.js');
  assert.ok(route.includes("id: 'demo-appearance'"));
  assert.ok(route.includes("name: '[Mock] Appearance & theming'"));
  assert.ok(/items: \['issue:900001'/.test(route));
});

// ─── #2227: your own governance proposal is your work too ─────────────

test('a propose-to-close you opened yourself joins "What you are working on"', () => {
  const AppView = makeAppView();
  seed(AppView);
  // Three rows in review: a code proposal of mine, a governance
  // propose-to-close of MINE, and a governance one of somebody else's.
  AppView._proposals = [
    { id: 61, pr_number: 61, pr_title: 'Mine', status: 'promoted', username: 'me', user_id: 1,
      created_at: at(3), promoted_at: at(3), last_message_at: at(3), linked_issues: [], my_vote: null },
  ];
  AppView._govProposals = [
    { id: 71, kind: 'close_issue', title: 'Close it', status: 'open', created_by: 1,
      created_by_username: 'me', payload: { issueNumber: 12, issueTitle: 'Dark mode resets' },
      created_at: at(1), last_message_at: at(1), up_count: 0, down_count: 0, my_vote: null },
    { id: 72, kind: 'close_issue', title: 'Theirs', status: 'open', created_by: 9,
      created_by_username: 'carol', payload: { issueNumber: 13, issueTitle: 'Keyboard voting' },
      created_at: at(2), last_message_at: at(2), up_count: 0, down_count: 0, my_vote: null },
  ];
  const v = AppView._workshopView();
  assert.deepEqual(plain(v.mine.rows).map((r) => r.key),
    ['mine:gov:71', 'mine:proposal:61'],
    'my governance proposal rides beside my code proposal, most recent first');
  assert.equal(v.mine.count, 2, 'mine, not carol’s');

  // And it is not ALSO owed a vote from me — same de-dup the code
  // proposal already gets, since "waiting on you" asks whether you have
  // voted, not whose it is.
  assert.ok(!plain(v.votes.rows).some((r) => r.key.includes('gov:71')),
    'your own governance proposal is not also owed a vote from you');
  assert.ok(plain(v.votes.rows).some((r) => r.key.includes('gov:72')),
    'but somebody else’s still is');
});

test('the tab strip and the head pin as one band (#2339 follow-up)', () => {
  // WHAT THIS EXISTS FOR. A first cut read "have the controls scroll with the
  // page" as "let them scroll away" and removed the stickiness the head
  // already had — the opposite of the ask, and it shipped. The controls belong
  // WITH the list you are narrowing: all three stay put while it scrolls.
  //
  // Three elements, three mechanisms, and the test is that all three are
  // present — no single declaration expresses "one band".
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(wide, 'the wide-screen block exists');
  const decls = wide[1].replace(/\/\*[\s\S]*?\*\//g, '');

  // 1. THE STRIP pins to the scroller's top. `top` after `inset: auto`, or the
  //    shorthand resets it — measured, the strip went to -890 on a 900px
  //    scroll while the head stayed.
  const rail = /\.dev-ws-tabs \{([\s\S]*?)\n  \}/.exec(decls);
  assert.ok(rail, 'the rail is restyled for width');
  assert.match(rail[1], /position: sticky;/);
  //    #3583: it pins at the header's foot (`--ws-pin-top`), not at 0.
  assert.ok(rail[1].indexOf('top: var(--ws-pin-top, 0px);') > rail[1].indexOf('inset: auto;'),
    '`top` is set after `inset: auto`');

  // 2. THE HEAD keeps the base rule's `position: sticky` and only moves where
  //    it rests: under the strip, by the strip's MEASURED height plus the
  //    column gap. `top: 0` would slide it under the strip. #3583: counted
  //    from where the strip pins, which is no longer the scroller's top.
  assert.match(decls, /#dev-workshop \.dev-ws-pane-head \{[^}]*top: calc\(var\(--ws-pin-top, 0px\) \+ var\(--dev-ws-head-top, 0px\)\)/);
  assert.match(WORKSHOP, /const WS_GAP_PX = 10;/);
  assert.match(WORKSHOP,
    /setProperty\('--dev-ws-head-top', `\$\{Math\.round\(n\.height\) \+ WS_GAP_PX\}px`\)/);
  assert.ok(WORKSHOP.includes("'--dev-ws-head-top'"), 'and it is cleared with the rest');

  // 3. ABOVE THE STRIP in paint order, the order the open "+" menu's rule is
  //    written against (the grouping tabs hung into the strip's band from the
  //    head once, as an "ear", which is where the order came from).
  const headBlock = /#dev-workshop \.dev-ws-pane-head \{([^}]*)\}/.exec(decls);
  const headZ = Number(/z-index: (\d+)/.exec(headBlock[1])[1]);
  const navZ = Number(/z-index: (\d+)/.exec(decls.slice(decls.indexOf('.dev-ws-tabs {')))[1]
    || /z-index: (\d+)/.exec(CSS.replace(/\/\*[\s\S]*?\*\//g, '')
      .slice(CSS.replace(/\/\*[\s\S]*?\*\//g, '').indexOf('.dev-ws-tabs {')))[1]);
  assert.ok(headZ > navZ, `the head (${headZ}) paints above the strip (${navZ})`);

  // The head must NOT be un-stuck: that was the inverted change, and this is
  // the assertion that would have caught it.
  assert.ok(!/#dev-workshop \.dev-ws-pane-head \{[^}]*position: relative/.test(decls),
    'the head is never un-stuck here');
});

test('the pinned strip stays above the list, on a solid band (QA 2026-09-24 Q7)', () => {
  // THE BUG. Scrolled on All items, the strip went UNDER the cards: it was
  // sticky with no z-index, so the pane and its cards, later in the tree,
  // painted over it and took its clicks.
  // And the air around the pill had nothing behind it, so the cards scrolled
  // past between the controls.
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(wide, 'the wide-screen block exists');
  const decls = wide[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const rail = /\n  \.dev-ws-tabs \{([\s\S]*?)\n  \}/.exec(decls);
  assert.ok(rail, 'the strip is restyled for width');
  assert.match(rail[1], /z-index: 30;/, 'the strip has a stacking level of its own');
  const headZ = Number(/#dev-workshop \.dev-ws-pane-head \{[^}]*z-index: (\d+)/.exec(decls)[1]);
  assert.ok(headZ > 30, 'and stays under the head');
  // The band: behind the strip's content, only while pinned, down to where
  // the head rests and across the pane (measured).
  const band = /\.dev-ws-tabs::before \{([^}]*)\}/.exec(decls);
  assert.ok(band, 'the strip carries a band');
  assert.match(band[1], /z-index: -1;/);
  assert.match(band[1], /height: var\(--dev-ws-head-top, calc\(100% \+ 10px\)\);/);
  assert.match(band[1], /left: var\(--dev-ws-band-left, 0px\);/);
  assert.match(band[1], /right: var\(--dev-ws-band-right, 0px\);/);
  // #3651: solid in the PANE's colour, which its head keeps while pinned.
  assert.match(band[1], /background-color: var\(--dc-sheet-solid\);/, 'solid: a nested frost cannot blur here');
  assert.match(band[1], /visibility: hidden;/, 'and not at rest, where it would be a slab for nothing');
  assert.match(decls, /\.dev-ws\[data-ws-pinned\] > \.dev-ws-tabs::before \{ visibility: visible; \}/);
  // The measurement and the flag.
  assert.match(WORKSHOP, /const STRIP_PROPS = \['--dev-ws-head-top', '--dev-ws-band-left', '--dev-ws-band-right'\];/);
  assert.match(WORKSHOP, /setProperty\('--dev-ws-band-left', `\$\{Math\.round\(p\.left - n\.left\)\}px`\)/);
  assert.match(WORKSHOP, /setProperty\('--dev-ws-band-right', `\$\{Math\.round\(n\.right - p\.right\)\}px`\)/);
  const hook = WORKSHOP.slice(WORKSHOP.indexOf('function usePinnedStrip('));
  const body = hook.slice(0, hook.indexOf('\n}\n'));
  assert.match(body, /document\.addEventListener\('scroll', schedule, \{ capture: true, passive: true \}\)/,
    'hears the dev frame\'s scroller and the document alike');
  assert.match(body, /host\.toggleAttribute\('data-ws-pinned', pinned\)/, 'written on the host, not as state');
  assert.match(body, /host\.removeAttribute\('data-ws-pinned'\)/, 'and taken off again on teardown');
  // #3651: asked at every width (a phone's band and head pin too, #3522);
  // only the insets the band is drawn to are the wide layout's.
  assert.match(WORKSHOP, /usePinnedStrip\(bar, hostRef, tab\);/);
  assert.match(WORKSHOP, /const stripSticks = useMediaFlag\(WIDE_QUERY\);\s*useStripInsets\(bar, hostRef, stripSticks\);/,
    'the insets only where the band behind the strip is drawn');
});

test('#3651: on All items one header pins, the tabs and the head, in the pane\'s colour and square on top', () => {
  // THE BUG. "Sometimes workshop all items header formatting goes weird after
  // you scroll down a little bit." From 700px every `.dev-ws-tabs` box was
  // sticky at the same offset, and All items has two: the project's tabs and
  // the back bar under them. A little way down the back bar's title rode up
  // across Hub and Discussion; further down its band covered the tabs. And
  // that band, with the head under it, turned white (`--dc-sheet`) over the
  // cream pane, its top-right corner still rounded: a slab with a notch,
  // whose edges read as a gap down both sides and along the foot.
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(wide, 'the wide-screen block exists');
  const decls = wide[1].replace(/\/\*[\s\S]*?\*\//g, '');

  // 1. THE TABS ARE THE BAR ON EVERY PAGE; the back bar is not measured.
  assert.match(WORKSHOP, /<ProjectBand[^>]*?\n\s*barRef=\{setBar\}\n\s*\/>/, 'the band is the bar, All items too');
  assert.equal((WORKSHOP.match(/\{setBar\}/g) || []).length, 1, 'and nothing else is the bar');

  // 2. NO BACK BAR OF ITS OWN (#4486). The way back and the page's name are
  //    the first things in the head's one row, which pins under the tabs, so
  //    there is no second `.dev-ws-tabs` box to scroll away under them, and
  //    no rule for one.
  assert.ok(!/data-ws-pagebar|dev-ws-pagebar/.test(WORKSHOP), 'no back bar');
  assert.ok(!/dev-ws-pagebar/.test(decls), 'and no rule styles one');

  // 3. UNDER 768px THE HEAD RESTS ON THE BAND'S FOOT. The coloured band is
  //    opaque and draws no sheet behind it, so the measured offset's column
  //    gap would show the cards; a phone's head rests the same way (58px).
  assert.match(decls, /@media \(max-width: 767\.98px\) \{\s*#dev-workshop \.dev-ws-pane-head \{ top: calc\(var\(--ws-pin-top, 0px\) - 15px \+ 58px\); \}\s*\}/);
  assert.ok(decls.indexOf('- 15px + 58px') > decls.indexOf('#dev-workshop .dev-ws-pane-head {'),
    'after the measured offset it overrides, which has the same specificity');

  // 4. ONE COLOUR. The head keeps the pane's while pinned, and the band
  //    behind the tabs matches it (asserted with the band's other rules).
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ''), /\[data-ws-pinned\] \.dev-ws-pane-head \{[^}]*background/,
    'the pinned head is not repainted');
  assert.match(CSS, /\n\.dev-ws-pane-head, \.dev-ws-pane-body \{ background-color: var\(--dc-sheet-solid\); \}/);

  // 5. SQUARE ON TOP, both corners, at every width (outside the wide block),
  //    once the head has left the top of its pane.
  assert.match(CSS, /\n\.dev-ws\[data-ws-head-pinned\] \.dev-ws-pane-head \{ border-top-left-radius: 0; border-top-right-radius: 0; \}/);
  assert.doesNotMatch(decls, /border-top-left-radius/, 'not the wide block\'s left corner alone');
  const hook = WORKSHOP.slice(WORKSHOP.indexOf('function usePinnedStrip('));
  const body = hook.slice(0, hook.indexOf('\n}\n'));
  assert.match(body, /const below = bar\.nextElementSibling;/, 'pinned once what follows the bar slides under it — the back bar on All items');
  assert.match(body, /host\.querySelector<HTMLElement>\(':scope > \.dev-ws-tabbody > \[data-ws-pane\]'\)/);
  assert.match(body, /host\.toggleAttribute\('data-ws-head-pinned', headPinned\)/);
  assert.equal((body.match(/host\.removeAttribute\('data-ws-head-pinned'\)/g) || []).length, 2,
    'cleared with no bar, and on teardown');
  assert.doesNotMatch(body, /enabled/, 'and not only from 700px');
});

test('the Needs-you card is marked voted only once the server has the vote (QA 2026-09-24 Q3)', () => {
  // THE BUG. `answer` set the confirmation before castVote ran, and castVote
  // asks a No for its line first: cancelling that prompt sent nothing and
  // still left "Voted no · press ↓ for the next" on the card.
  const fn = WORKSHOP.slice(WORKSHOP.indexOf('  const answer = (which'));
  const body = fn.slice(0, fn.indexOf('\n  };\n'));
  const then = body.indexOf('.then((ok) => {');
  assert.ok(then > 0, 'the answer waits on castVote\'s outcome');
  const marks = body.indexOf('setAnswered(');
  assert.ok(marks > then, 'and the card is marked only inside it');
  assert.match(body.slice(then), /if \(ok === true\) \{\s*setAnswered\(/, 'only on a vote that landed');
  assert.match(body, /pinsRef\.current\.delete\(key\)/, 'a cancelled or failed vote drops the pin this press added');
  assert.match(body, /\{ onSend \}/, 'the rail says "Sending…" from the moment the vote is committed');
  assert.match(body, /if \(sendingRef\.current\.has\(key\)\) return;/, 'one vote per card in flight');
  assert.match(WORKSHOP, /sending\[row\.key\] \? 'Sending…' : \(approves\(row\) \? 'Approve' : 'Vote'\)/);
  // castVote's side of the contract.
  const view = read('public/js/app-view.js');
  const cast = view.slice(view.indexOf('  async castVote(sessionId, vote'));
  const castBody = cast.slice(0, cast.indexOf('\n  },\n'));
  assert.match(castBody, /if \(reason === false\) \{\s*AppView\._voteInFlight\.delete\(key\);\s*return false;/);
  assert.match(castBody, /return true;/);
});

test('#3977: on a project that is just yours, the Needs-you item reads Approve and Don\'t approve', () => {
  // B7's approval (`_cardVoteButtonSpecs` marks the Yes `approve`) rides on
  // the queue row, and the item says it in the card's words: the rail
  // button, the swipe's two stamps and, once answered, the confirmation.
  const AppView = makeAppView();
  seed(AppView);
  AppView.appData = { ...AppView.appData, audience: 'solo' };
  const row = AppView._workshopView().queue.find((r) => r.kind === 'vote');
  assert.equal(row.yes.approve, true);
  assert.ok(!('approve' in row.no));
  const html = workshopHtml(AppView, 'needs');
  assert.match(html, /<span class="dev-ws-rail-lab">Approve<\/span>/);
  assert.match(html, /<span class="dev-ws-swipe-hint dev-ws-swipe-yes" aria-hidden="true">Approve<\/span>/);
  assert.match(html, /<span class="dev-ws-swipe-hint dev-ws-swipe-no" aria-hidden="true">Don’t approve<\/span>/);
  assert.match(WORKSHOP, /<p className="dev-ws-keys-hint" aria-hidden="true">\{approves\(row\) \? 'Y approve · N don’t approve · Enter send · Esc close' : 'Y yes · N no · Enter vote · Esc close'\}<\/p>/);
  assert.match(WORKSHOP, /approve=\{approves\(row\)\}/, 'and the sheet\'s form is the card\'s picker, as an approval');
  // A group's row is a vote, word for word.
  const group = makeAppView();
  seed(group);
  assert.ok(!('approve' in group._workshopView().queue.find((r) => r.kind === 'vote').yes));
  const groupHtml = workshopHtml(group, 'needs');
  assert.match(groupHtml, /<span class="dev-ws-rail-lab">Vote<\/span>/);
  assert.match(groupHtml, /dev-ws-swipe-yes" aria-hidden="true">Yes<\/span>/);
});

test('#3052: on a phone a card the viewer can vote on takes the swipe; an issue or a pairless row does not', () => {
  // The vm the feed renders in has no matchMedia, so this is the layout
  // below 700px: the one the gesture is for. (The wiring and the gesture's
  // arithmetic are tests/workshop-swipe-vote.test.js.)
  const AppView = makeAppView();
  seed(AppView);
  const opening = (html, kind) => (html.match(/<section class="dev-ws-item"[^>]*>/g) || [])
    .filter((s) => s.includes(`data-ws-kind="${kind}"`));
  const html = workshopHtml(AppView, 'needs');
  assert.equal(opening(html, 'vote').length, 1);
  assert.ok(opening(html, 'vote').every((s) => s.includes('data-ws-swipeable=""')),
    'the proposal owed a vote is swipeable');
  assert.equal(opening(html, 'claim').length, 2);
  assert.ok(opening(html, 'claim').every((s) => !s.includes('data-ws-swipeable')),
    'an issue\'s "Let\'s take it" is not a vote, so its card is not swiped');
  // Its two hints, once each, hidden from assistive tech: the Vote sheet's
  // buttons are the way to vote without a gesture.
  assert.equal((html.match(/<span class="dev-ws-swipe-hint dev-ws-swipe-yes" aria-hidden="true">Yes<\/span>/g) || []).length, 1);
  assert.equal((html.match(/<span class="dev-ws-swipe-hint dev-ws-swipe-no" aria-hidden="true">No<\/span>/g) || []).length, 1);

  // A vote row with no Yes/No pair (a governance item's shape here) is not
  // one the viewer can vote on from the card, so it takes no gesture either.
  AppView._cardVoteButtonSpecs = () => [];
  const bare = workshopHtml(AppView, 'needs');
  assert.equal(opening(bare, 'vote').length, 1);
  assert.ok(opening(bare, 'vote').every((s) => !s.includes('data-ws-swipeable')));
  assert.ok(!bare.includes('dev-ws-swipe-hint'));
});

test('the strip insets re-measure on every render, or a grouping switch leaves them stale', () => {
  // A REAL BUG, reported from the preview, when this hook still placed the
  // ear: it had a dependency array, none of whose entries change when the
  // grouping does, so an offset measured against the 760px column stayed in
  // force once By stage made the pane full-bleed and moved its edges. The
  // band behind the pinned strip reads the same edges, so the rule holds.
  //
  // The ResizeObserver does not save it on its own: it watches the boxes the
  // effect captured AT THE TIME and reports SIZE only, while a centred column
  // moves without resizing. So: no dependency array.
  const hook = WORKSHOP.slice(WORKSHOP.indexOf('function useStripInsets('));
  const body = hook.slice(0, hook.indexOf('\n}\n'));
  assert.ok(!/\}, \[[^\]]*\]\);/.test(body),
    'useStripInsets takes no dependency array — a narrow one shipped a stale offset');
  assert.match(body, /\n  \}\);/, 'the layout effect closes with no deps');
  assert.match(body, /for \(const k of STRIP_PROPS\) host\.style\.removeProperty\(k\);/,
    'and the properties are cleared where the strip does not stick, not left stale');
  assert.match(body, /ro\.observe\(bar\);/);
  assert.match(body, /ro\.observe\(pane\);/);
});

test('what the strip measures is published in one go: every read, then every write', () => {
  // A custom property INHERITS. One that changes on `.dev-ws` or on
  // #dev-workshop makes the browser re-apply the stylesheet to everything
  // under it at the next layout question: measured on the board with every
  // card open, any such change is about 77ms, used or not.
  //
  // The strip's three properties and the header's foot were published by two
  // hooks, each asking a question right after the other's write, so a page's
  // first frame paid for the board three times after the pass that drew it.
  // `useStripInsets` now reads the foot with its own two boxes and writes all
  // four together; `usePinnedStrip` still publishes the foot on every scroll
  // frame, and on the first one finds the value it was about to write.
  const hook = WORKSHOP.slice(WORKSHOP.indexOf('function useStripInsets('));
  const body = hook.slice(0, hook.indexOf('\n}\n'));
  assert.match(body,
    /const foot = headerFoot\(host\);\s*const n = bar\.getBoundingClientRect\(\);\s*const p = pane\.getBoundingClientRect\(\);\s*const cssHost = offsetHost\(host\);\s*if \(foot == null\) cssHost\.style\.removeProperty\(HEAD_FOOT_PROP\);\s*else cssHost\.style\.setProperty\(HEAD_FOOT_PROP, `\$\{Math\.round\(foot\)\}px`\);\s*if \(!n\.width \|\| !p\.width\) return;\s*host\.style\.setProperty\('--dev-ws-head-top'/,
    'the foot is read before anything is written, and written with the strip\'s own three');
  // Nothing is read back after the first write.
  const writes = body.slice(body.indexOf('cssHost.style.removeProperty(HEAD_FOOT_PROP)'), body.indexOf('measure();'));
  assert.doesNotMatch(writes, /getBoundingClientRect|getComputedStyle|offset(?:Top|Left|Width|Height)\b|client(?:Width|Height)\b/);
  // The foot's other publisher is unchanged (tests/project-page-opens-at-head.test.js).
  const pinned = WORKSHOP.slice(WORKSHOP.indexOf('function usePinnedStrip('));
  assert.match(pinned.slice(0, pinned.indexOf('\n}\n')), /const foot = headerFoot\(host\);/);
});

test('the board\'s in-flight marks hold still for a reader who asked for less motion', () => {
  // The arc beside "Checks running…", the ring on a vote that is open, and
  // the chip on an issue whose proposal is being drafted. They run for as
  // long as the state lasts, a vote for days, and a board carries dozens (71
  // on this repository's own with every card open, 68 of them scrolled out of
  // view). The header's cog already rests under this setting; these did not.
  //
  // It is also what lets a browser that draws without a GPU, like the one the
  // declared checks run in, ask for a still page: there, one running
  // animation of any size costs about a fifth of a core per open window.
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(rules, /\.dc-status-spinner-arc \{[^}]*animation: dc-spin 0\.8s linear infinite;[^}]*\}\s*@media \(prefers-reduced-motion: reduce\) \{\s*\.dc-status-spinner-arc \{ animation: none; \}\s*\}/);
  assert.match(rules, /\.gc-vote-count-dot-ping \{[^}]*animation: ping 1s[^}]*\}\s*@media \(prefers-reduced-motion: reduce\) \{\s*\.gc-vote-count-dot-ping \{ animation: none; \}\s*\}/);
  assert.match(read('frontend/src/features/dev-board/card/dev-card.tsx'), /spec\.pulse \? ' motion-safe:animate-pulse' : ''/);
});

test('the Workshop keeps no swatch of its own — it imports the one the threads use', () => {
  // A REAL BUG (#2475). This file carried a private `swatchFor` over seven
  // stock hues hashed with `h * 31`, under a comment claiming it followed
  // feed-thread's rule. It did not: feed-thread imports
  // features/messages/format.tsx, which is six PRODUCT swatches hashed with
  // FNV-1a. So the same person's initial was one colour on a Workshop row
  // and a different one in that row's own Comments sheet — which renders
  // <FeedThread /> a few lines below, from the same name.
  //
  // Three call sites read it (the faces strip, a theme's letter tile, an
  // item's byline avatar) and all three take a name and get a colour back,
  // so the shared function drops in unchanged.
  assert.match(WORKSHOP, /^import \{ swatchFor \} from '\.\.\/\.\.\/messages\/format';$/m,
    'the Workshop imports the shared swatch');
  assert.ok(!/(?:function|const)\s+swatchFor\b/.test(WORKSHOP),
    'and defines no local copy — a second palette is the bug this fixes');

  // The old palette, named so a re-introduction of any of it is loud. None of
  // these seven is in the product's vocabulary.
  for (const hex of ['#8e44ad', '#1f8a4c', '#b4620a', '#c0392b', '#0e7c86', '#6d4c41']) {
    assert.ok(!WORKSHOP.includes(hex), `${hex} is a stock hue the Workshop no longer paints with`);
  }

  // The row and the sheet under it now agree, which is the visible fix.
  const { swatchFor } = loadTsx('frontend/src/features/messages/format.tsx');
  assert.equal(swatchFor('ada'), swatchFor('ada'));
  assert.ok(['#5b7553', '#c0532f', '#6fb3a8', '#4a6fa5', '#8a5a83', '#b08344'].includes(swatchFor('ada')),
    'and the colour comes from the shared six');
  assert.match(read('frontend/src/features/dev-board/card/feed-thread.tsx'),
    /import \{ swatchFor \} from '\.\.\/\.\.\/messages\/format';/,
    'the sheet reads the same module — that is what makes the two match');
});

// ── The theme order holds between sorts ────────────────────────────────
//
// The list was re-sorted on every refetch, so a vote, a verdict or a new card
// anywhere on the board could move the theme a reader was looking at: the
// largest layout shift measured on the Workshop (0.16) was a card dropping
// 255 px when a draft became a proposal and its theme's counts moved.

test('a refetch keeps every theme where it was; only a chip press re-sorts', () => {
  const { orderThemesStable } = devCardApi();
  const theme = (id, people, extra = {}) => ({
    id, people: Array.from({ length: people }, (_, i) => `u${i}`), lastActive: 0,
    counts: { open: 0 }, ...extra,
  });
  const first = orderThemesStable(null, [theme('a', 1), theme('b', 3), theme('z', 0, { ungrouped: true })], 'people');
  assert.deepEqual(first.map((t) => t.id), ['b', 'a', 'z'], 'the first paint sorts');
  const held = { key: 'people', ids: first.map((t) => t.id) };
  // "a" gains people, "c" is new, "b" is still here: nothing already shown moves.
  const next = orderThemesStable(held,
    [theme('a', 9), theme('b', 3), theme('c', 5), theme('z', 0, { ungrouped: true })], 'people');
  assert.deepEqual(next.map((t) => t.id), ['b', 'a', 'c', 'z'],
    'a refetch keeps the order, adds new themes after it, and "Not yet grouped" stays last');
  assert.equal(next[1].people.length, 9, 'with each theme\'s fresh numbers');
  // A theme that is gone is dropped; a chip press sorts afresh.
  assert.deepEqual(orderThemesStable(held, [theme('a', 9)], 'people').map((t) => t.id), ['a']);
  assert.deepEqual(orderThemesStable({ key: 'activity', ids: ['b', 'a'] },
    [theme('a', 9), theme('b', 3)], 'people').map((t) => t.id), ['a', 'b']);
});

test('#4031: the end card keeps its ring when the last vote takes the open count to zero', () => {
  const { endRingTotal } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  // One open change, voted on here: the server's count is 0 by the time the
  // end card shows. The ring was dropped, the centred card jumped 65px under
  // the reader, and iOS left the old button painted below the new one.
  assert.equal(endRingTotal(0, 1, 0), 1, 'a full 1/1 ring, not none');
  // The live count still wins whenever it is larger: three open, none voted.
  assert.equal(endRingTotal(3, 0, 3), 3);
  // Two voted here, one still waiting, server already down to one.
  assert.equal(endRingTotal(1, 2, 1), 3);
  // Nothing to vote on and nothing voted: still no ring.
  assert.equal(endRingTotal(0, 0, 0), 0);
  assert.match(WORKSHOP, /<DoneItem\s+total=\{endRingTotal\(total, votedHere, leftVotes\)\}/, 'the feed draws the end card with it');
});

test('a run that does not know its total yet says "Checks…" on a row, its full words the tooltip and what a screen reader reads', () => {
  const AppView = makeAppView();
  seed(AppView);
  const item = { id: 77, pr_number: 4577, status: 'promoted', check_state: 'pending', created_at: at(1), linked_issues: [] };
  const running = AppView.statusTagSpecs(item).find((s) => s.data && s.data['data-status-tag'] === 'checks-running');
  assert.ok(running && /^Checks running…/.test(running.label), 'the card’s status tag keeps its words');
  const tag = AppView._workshopBrief('proposal', item, null).tags.find((t) => /^Checks running…/.test(t.label));
  assert.ok(tag, 'the row carries the tag');
  assert.equal(tag.short, 'Checks…');
});
