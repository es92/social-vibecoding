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
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { workshopHtml, kanbanHtml, api: devCardApi } = require('./lib/dev-card-html');
// 24 Nov 2026: the Workshop tab is its front page (tests/workshop-front-page.test.js).
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
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  // The ⋯ rows and meta links to GitHub decide by the address
  // (frontend/src/lib/repo-link.js, published as window.RepoLink).
  require('./lib/repo-link').installRepoLink(sandbox);
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

// THE CATEGORY PANE IS NOT REACHED IN THE PRODUCT (request 6708: All items is
// the board by stage, with no switch), but its cards and lanes are still in
// workshop.tsx. The cases that pin them draw the pane by answering for it
// here, which nothing in the product does.
function categoryPaneHtml(AppView, tab) {
  const prev = AppView._getWorkshopGroup;
  AppView._getWorkshopGroup = () => 'category';
  try { return workshopHtml(AppView, tab); } finally { AppView._getWorkshopGroup = prev; }
}

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
  // #4745: the figure routes its tap through these refs — the same bucket
  // the count reads, each carrying the address its page opens on, in the
  // bucket's order.
  assert.deepEqual(plain(first.dashboard.votesWaitingRefs), [{ kind: 'proposal', id: 34 }]);
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

test('#5369: a stage filter narrows the theme lists, and the dashboard figures stay whole', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13'] }]);
  const whole = AppView._workshopView();
  assert.equal(whole.dashboard.open, 3, 'two requests and the waiting proposal');
  assert.equal(whole.dashboard.unclaimed, 2, 'both requests untouched');
  assert.equal(whole.dashboard.shippedWeek, 1, 'the merge, live this week');
  // (A theme with nothing matched in it is not drawn at all, so the lookup
  // can come back empty — that reads as zero rows.)
  const themeRows = (v) => {
    const t = v.themes.find((x) => x.id === 't');
    return t ? t.lanes.reduce((n, l) => n + l.rows.length, 0) : 0;
  };
  assert.equal(themeRows(whole), 2, 'the theme holds both requests');

  // stage 'open': the shipped merge leaves the lists; the figures do not
  // move — they count the whole board, whatever All items is narrowed to
  // (#2915's rule, one filter further).
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), stage: 'open' };
  let v = AppView._workshopView();
  assert.equal(v.meta.filtered, true, 'the tab strip is told a filter is waiting');
  assert.equal(v.dashboard.open, 3);
  assert.equal(v.dashboard.unclaimed, 2);
  assert.equal(v.dashboard.shippedWeek, 1);
  assert.equal(themeRows(v), 2, 'requests and the proposal are open; the theme holds the requests');

  // stage 'unclaimed': still the two untouched requests — a claimed or
  // assigned one would drop out here, and on this board none is taken.
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), stage: 'unclaimed' };
  v = AppView._workshopView();
  assert.equal(v.dashboard.open, 3, 'the figures stay whole under any stage');
  assert.equal(themeRows(v), 2);

  // stage 'shipped': the theme (open work) empties; the week figure is the
  // same one the tile showed.
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), stage: 'shipped' };
  v = AppView._workshopView();
  assert.equal(v.dashboard.shippedWeek, 1);
  assert.equal(themeRows(v), 0, 'nothing in the theme went live');

  // An unknown stored value reads as no filter at all — an older tab's
  // storage must not half-narrow the board.
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), stage: 'bogus' };
  v = AppView._workshopView();
  assert.equal(v.meta.filtered, false, 'an unknown stage is not a filter');
  assert.equal(themeRows(v), 2, 'and it narrows nothing');
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

test('the Overview says where the open work is, not the model\'s paragraph nor one derived from the counts', () => {
  const AppView = makeAppView();
  seed(AppView);
  // After-Workshop-B: the paragraph about the open work, the sentence the
  // counts derived when there was none, and the caption that said which of
  // the two was on screen all gave way to one line of chips, and #5391 took
  // the chips out. Whatever the model has or has not written, the Overview
  // says nothing about the open work beyond its figures.
  const states = [
    { digest: 'In the last week, alice finished the sign-in work. Bob is on the mail templates now.' },
    {},
    { digestError: 'Workshop digest response hit the output limit before it finished' },
  ];
  for (const extra of states) {
    AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }], extra);
    const html = workshopHtml(AppView, 'workshop');
    assert.ok(!html.includes('data-ws-open-topics'), JSON.stringify(extra));
    assert.ok(!html.includes('alice finished the sign-in work'), 'no paragraph');
    assert.ok(!html.includes('open items across'), 'no derived sentence');
    assert.ok(!html.includes('data-ws-digest-note'), 'and no caption about either');
    assert.ok(!html.includes('could not be written') && !html.includes('the model writes one on the next pass'));
  }
  // The functions that wrote them went with them.
  assert.ok(!/function (digestNote|describe|summarise)\(/.test(WORKSHOP));
  assert.doesNotMatch(CSS, /\.dev-ws-digest-note|\.dev-ws-open-line/);
});

test('the digest survives the fetch that loads it', async () => {
  // The seam the tests step over when they seed `_workshopThemes` with the
  // CACHE shape directly: `_loadWorkshopThemes` is the only thing that
  // writes that cache in a browser. #1803 shipped the consumer
  // (`tData.digest`) without the producer, so this asserts ACROSS the
  // normaliser: the response body goes in, the view model comes out.
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
  // what it CACHED and what the view makes of it, not about the DOM.
  AppView._repaintBoardSurface = () => {};
  await AppView._loadWorkshopThemes('demo-app');

  assert.equal(AppView._workshopThemes.digest, digest, 'the normaliser keeps it');
  assert.equal(AppView._workshopView().dashboard.summary, digest, 'and the view model carries it');
  // The Workshop's Overview draws neither it nor the chips that once took
  // its place (After-Workshop-B, #5391).
  const html = workshopHtml(AppView, 'workshop');
  assert.ok(!html.includes('alice finished the sign-in work'));
  assert.ok(!html.includes('data-ws-topic-chip'));

  // A response with no paragraph still reads as one: null, not undefined.
  const empty = makeAppView({ fetch: async () => ({ ok: true, json: async () => ({ ...body, digest: null }) }) });
  seed(empty);
  empty._repaintBoardSurface = () => {};
  await empty._loadWorkshopThemes('demo-app');
  assert.equal(empty._workshopThemes.digest, null);
  assert.equal(empty._workshopView().dashboard.summary, null);
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

test('the lead block went with its sentence, and the walk’s way back went with the walk', async () => {
  const AppView = await loadWith(responseBody({
    digestCards: {
      lastWeek: 'The vote counter was rebuilt and two preview races were closed.',
      thisWeek: 'Kubernetes deploys stopped racing the health check.',
      open: 'The domain migration and a long tail of preview reliability.',
    },
  }));
  const html = workshopHtml(AppView, 'workshop');
  // "Open items" titled the open line while the Overview had one. Neither
  // the heading nor its rule is left, nor the chips that followed (#5391).
  assert.ok(!html.includes('dev-ws-lead-title') && !html.includes('dev-ws-lead-head'));
  assert.doesNotMatch(CSS, /\.dev-ws-lead-(title|head) \{/);
  assert.ok(!html.includes('data-ws-open-topics'), 'nor the chips');
  // "Hide past weeks" folded the walk that was under this block. The weeks
  // are What happened's now, each a row or this week's head.
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

// ── #3293: the list reaches back to the project's start ──────────────

test('#3293: a week from another year says which year', () => {
  const WEEK = 7 * 86400000;
  const jan = weekRow({ key: 'week:a', title: '', startMs: Date.UTC(2026, 0, 12), endMs: Date.UTC(2026, 0, 12) + WEEK, counts: null, line: 'January.' });
  const dec = weekRow({ key: 'week:b', title: '', startMs: Date.UTC(2025, 11, 29), endMs: Date.UTC(2025, 11, 29) + WEEK, counts: null, line: 'Across the new year.' });
  assert.match(jan, /<b>Jan 12 – Jan 18<\/b>/, 'this year: no year');
  assert.match(dec, /<b>Dec 29, 2025 – Jan 4<\/b>/, 'last year: named');
});

// ── #4818: a week's dates are in the interface's language ─────────────

test('#4818: weekDate formats in the interface language, never a fixed en-US', () => {
  const { weekDate } = loadTsx('frontend/src/features/dev-board/workshop/week-pages.tsx');
  const ms = Date.UTC(new Date().getUTCFullYear(), 7, 25);
  assert.equal(weekDate(ms), 'Aug 25', 'English while the interface is English, whatever the device says');
  const seen = [];
  const original = Date.prototype.toLocaleDateString;
  Date.prototype.toLocaleDateString = function (locales, options) {
    seen.push({ locales, options });
    return original.call(this, locales, options);
  };
  try {
    weekDate(ms);
  } finally {
    Date.prototype.toLocaleDateString = original;
  }
  assert.equal(seen.length, 1);
  // #6103: the locale is the date rule — the interface language with the
  // device's region. node's own navigator supplies one where it has it.
  const { dateLocale } = loadTsx('frontend/src/lib/i18n/locale.ts');
  const device = typeof navigator === 'undefined' ? []
    : (navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean));
  assert.equal(seen[0].locales, dateLocale('en', device),
    'the date locale (getDateLocale), not the bare device default');
  assert.equal(seen[0].options.timeZone, 'UTC', 'a week is still named by its UTC days');
  const options = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  assert.equal(original.call(new Date(ms), 'en-GB', options), '25 Aug',
    'an English interface on a UK device reads the day first');
  assert.equal(original.call(new Date(ms), 'en', options), 'Aug 25',
    'with no device region the English default keeps the month first');
  assert.equal(original.call(new Date(ms), 'fr', options), '25 août',
    'and a French interface reads "25 août"');
  assert.match(read('frontend/src/features/dev-board/workshop/week-pages.tsx'), /toLocaleDateString\(getDateLocale\(\), \{/);
});

// ── #4717: the page fetches its week, and says so while it does ───────

test('#4717: a week page draws its fetched rows, and says loading, failed or empty', async () => {
  const { WeekPage } = loadTsx('frontend/src/features/dev-board/workshop/week-pages.tsx');
  const WEEK = 7 * 86400000;
  const startMs = Date.UTC(2026, 8, 7); // last week's Monday
  const week = {
    key: 'lastWeek', title: '', startMs, endMs: startMs + WEEK, live: false,
    line: 'The week\'s line.', counts: { closed: 2, partial: false }, fresh: [], seen: [],
  };
  const render = (fetched) => renderToHtml(createElement(WeekPage, {
    week, fetched, slug: 'demo-app', openKey: null, onOpen: () => {}, onBack: () => {},
  }));
  // Real card models: a group's row is drawn by WorkRow, which reads the
  // card, so a bare object will not do.
  const AppView = await loadWith(responseBody({}));
  const brief = (over) => ({ kind: 'request', noun: 'Request', n: 1, by: 'maya', mine: false, requested: false, category: '', replies: 0, linked: [], closed: [], stage: 'request', at: startMs + 86400000, tags: [], vote: null, ...over });
  const row = (key, at, over) => ({ t: 'card', key, card: AppView._issueCardModel(AppView._ghIssues[0]), at, brief: brief({ at, ...over }) });

  // WHILE IT LOADS: the loading line, and neither the empty line nor groups.
  const loading = render({ loading: true, failed: false, fresh: [], seen: [] });
  assert.match(loading, /<p class="dev-ws-none" data-ws-week-loading="">Loading this week…<\/p>/);
  assert.ok(!loading.includes('data-ws-week-group'), 'no groups before rows arrive');
  assert.ok(!loading.includes('data-ws-week-failed'));
  assert.ok(!loading.includes(message('project:weekPage.none')), 'the empty line waits for the fetch to finish');

  // ROWS AS THEY ARRIVE: the unchanged groups file them, and the week's own
  // (capped) rows stand down in favour of the fetched ones.
  const fetched = {
    loading: false, failed: false, fresh: [],
    seen: [
      row('week:l', startMs + 2 * 86400000, { kind: 'live', noun: 'Change', stage: 'live' }),
      row('week:r', startMs + 86400000),
    ],
  };
  const withRows = render(fetched);
  const groups = [...withRows.matchAll(/data-ws-week-group="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ['live', 'requests'], 'went live, then the week\'s new requests');
  assert.ok(!withRows.includes('data-ws-week-loading') && !withRows.includes('data-ws-week-failed'));
  assert.ok(!withRows.includes('data-ws-week-none'), 'and the week loaded, so no empty line');

  // A FINISHED, EMPTY FETCH: only then does the empty line show — and it
  // says nothing happened, not that the board dropped it.
  const empty = render({ loading: false, failed: false, fresh: [], seen: [] });
  assert.match(empty, /<p class="dev-ws-none">Nothing happened in this week\.<\/p>/);
  assert.ok(!empty.includes('data-ws-week-loading') && !empty.includes('data-ws-week-failed'));

  // A FETCH THAT FAILED PART WAY: what it got stays, and the line says to
  // open the week again.
  const failed = render({ ...fetched, failed: true });
  assert.match(failed, /<p class="dev-ws-none" data-ws-week-failed="">Some of this week could not be loaded\. Open it again to try once more\.<\/p>/);
  assert.deepEqual([...failed.matchAll(/data-ws-week-group="([a-z]+)"/g)].map((m) => m[1]), ['live', 'requests'],
    'the rows that did land stay listed');
  assert.ok(!failed.includes(message('project:weekPage.none')));

  // WITHOUT AppView's fetch the page is what it was: the week's own rows.
  const plain2 = render(null);
  assert.ok(!plain2.includes('data-ws-week-loading') && !plain2.includes('data-ws-week-failed'));
  assert.match(plain2, /<p class="dev-ws-none">Nothing happened in this week\.<\/p>/, 'an empty week with no fetch is the empty line');
});

test('#4717: opening a week asks AppView for the week, closing tells it the page shut', () => {
  assert.match(WORKSHOP, /const week = weeks\.find\(\(w\) => sinceWeekStateKey\(w\) === key\);\s*if \(week\) callAppView\('openWorkshopWeek', week\.startMs, week\.endMs\);/,
    'openWeekPage hands AppView the week\'s range');
  // 24 Nov 2026: a week opened from Earlier weeks goes back there (the front page's other page).
  assert.match(WORKSHOP, /const closeWeekPage = \(\) => \{\s*const back = weekFromEarlier\.current;\s*weekFromEarlier\.current = false;\s*setOpenWeek\(back \? EARLIER_WEEKS : null\);\s*callAppView\('closeWorkshopWeek'\);/,
    'and closeWeekPage retires the fetch state with the page');
  assert.match(WORKSHOP, /fetched=\{v\.week && v\.week\.startMs === weekUp\.startMs/,
    'the page draws only the fetch for the week that is open');
});

test('a row written before the cards keeps its paragraph in the view, and its weeks their lines', async () => {
  // The rolling-deploy state: `digest` alone has to keep working, as the
  // view model's `summary`. The Workshop tab draws neither it nor the
  // derived sentence (After-Workshop-B); the weeks keep their lines on
  // their own pages.
  const AppView = await loadWith(responseBody({
    digest: 'In the last week, alice finished the sign-in work. Bob is on the mail templates now.',
  }));
  assert.match(AppView._workshopView().dashboard.summary, /alice finished the sign-in work/);
  const html = workshopHtml(AppView, 'workshop');
  assert.ok(!html.includes('data-ws-week='), 'no weeks');
  assert.ok(!html.includes('alice finished the sign-in work') && !html.includes('data-ws-digest-note'));

  // And when a row has both, the cards win.
  const both = await loadWith(responseBody({
    digest: 'The flattened paragraph.',
    digestCards: { lastWeek: 'The last-week line.', thisWeek: '', open: '' },
  }));
  const bothHtml = workshopHtml(both, 'workshop');
  assert.ok(!bothHtml.includes('The flattened paragraph.'), 'the prose form is not drawn beside them');
  assert.ok(!bothHtml.includes('data-ws-digest-note'), 'and no provenance caption');
  const [lastWeek] = plain(both._workshopView().dashboard.weeks);
  assert.match(weekPage(lastWeek), /data-ws-week-line="">The last-week line\./, 'the week carries it, on its page');
});

test('themes all start collapsed, and a deep link is what opens one', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13'] }]);
  // The first theme used to open itself. A lander whose every theme is shut
  // IS a list of headings, and a list of headings is what this screen is for.
  const shut = categoryPaneHtml(AppView, 'all');
  assert.match(shut, /data-ws-theme="t"/);
  assert.ok(!shut.includes('dev-ws-theme-body'), 'nothing is opened for you');
  assert.ok(!shut.includes('dev-ws-theme-open'));

  // Which means the lanes are only reachable by tapping — so there is a URL
  // that reaches them, and the declared check for them rides it.
  AppView._workshopShot = 'themes';
  const open = categoryPaneHtml(AppView, 'all');
  assert.match(open, /dev-ws-theme dev-ws-theme-open/);
  assert.match(open, /data-ws-lane="open"[\s\S]{0,400}?class="dev-ws-wrow dev-ws-brow"/);
  assert.ok(!open.includes('dev-feed-entry'), 'the theme only, its items the board\u2019s rows: nothing unfolds in place (#4486)');
  // No declared check rides it any more: the pane is not on a page (request 6708).
  assert.ok(!dapp.tests.some((t) => /dev-ws-theme-body|shot=themes/.test(`${t.expectSelector || ''} ${t.path || ''}`)));
});

// #5365: a change whose outcome the viewer's vote does not decide (its
// /promoted row carries my_vote_advisory) keeps the flag on the queue row's
// Yes — the item labels it and its vote sheet's picker shows the line — and
// the deck puts the marked rows last, so the rows whose vote decides come
// first and a viewer can stop when the marked cards begin.
test('the queue keeps the advisory flag on its Yes and puts the marked rows last', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._proposals = [...AppView._proposals, {
    id: 35, pr_number: 42, pr_title: 'Advisory change', status: 'promoted', username: 'dan',
    created_at: at(1), promoted_at: at(1), last_message_at: at(1), linked_issues: [], my_vote: null,
    votes_for: 0, votes_against: 0, yes_count: 0, no_count: 0, my_vote_advisory: true,
  }];
  const q = plain(AppView._workshopView().queue);
  assert.deepEqual(q.map((r) => r.card.key), ['proposal:34', 'proposal:35'],
    'the advisory change is last, after the change the viewer decides');
  assert.equal(q[1].yes.advisory, true, 'the queue keeps the flag the card’s Yes spec carries');
  assert.ok(!q[0].yes.advisory, 'the deciding row’s Yes is bare');
});

test('a quiet theme is not told it has never been built in', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12', 'issue:13', 'session:78'] }]);
  const html = categoryPaneHtml(AppView, 'all');
  // "nobody building yet" said something the data cannot know: the condition
  // is only that nothing is in flight RIGHT NOW, so a theme that shipped a
  // dozen changes read identically to one nobody has ever touched.
  assert.ok(!html.includes('nobody building yet'));
  assert.match(html, /1 went live this week, nothing in progress now/);

  // …and with nothing shipped either, it says only what it knows.
  AppView._merged = [];
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  assert.match(categoryPaneHtml(AppView, 'all'), /1 involved · nothing in flight right now/);
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
    { id: 80, pr_number: 38, pr_title: 'Last week', status: 'merged', username: 'bob', merged_at: iso(monday - 6 * 86400000), created_at: iso(monday - 6 * 86400000), row_type: 'pr' },
  ];
  const d = AppView._workshopView().dashboard;
  assert.equal(d.shippedWeek, 2);
  assert.equal(d.shippedPrevWeek, 1, 'the week before, from the same source, so the two compare');
  assert.equal(d.shippedPrevWeekToDate, 1, '#6547: last week up to this same point');

  // #6547: a row from later in last week is part of last week's total but
  // was not yet there "by this time last week", so it belongs to one count
  // and not the other.
  AppView._merged.push({ id: 81, pr_number: 37, pr_title: 'Late last week', status: 'merged', username: 'bob', merged_at: iso(monday - 2 * 86400000), created_at: iso(monday - 2 * 86400000), row_type: 'pr' });
  const later = AppView._workshopView().dashboard;
  assert.equal(later.shippedPrevWeek, 2, 'the whole of last week');
  assert.equal(later.shippedPrevWeekToDate, 1, 'but not up to this point');
  AppView._merged.pop();
  assert.equal(d.partial, false);

  // The merged history is paged. With more behind it the counts are floors,
  // and the view has to say so rather than reporting a page as the record.
  AppView._mergedHasMore = true;
  assert.equal(AppView._workshopView().dashboard.partial, true);
});

test('#1922: the loader keeps the server\'s week counts, and only well-formed ones', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public/js/app-view.js'), 'utf8');
  assert.match(src, /const shipped = mergedData\.shipped;\s*AppView\._mergedShipped = shipped\s*&& Number\.isFinite\(shipped\.week\) && Number\.isFinite\(shipped\.prevWeek\)/);
  assert.match(src, /prevWeekToDate: Number\.isFinite\(shipped\.prevWeekToDate\) \? shipped\.prevWeekToDate : null/);
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

  // NEAR THE TOP OF THE HUB, under the band, and with no no-items note after
  // it (15 Oct 2026): the note said what the banner says, and offered to
  // import a PR. A ✕ closes the banner on this project (hub-dismissed.ts).
  const order = ['data-ws-band', 'data-ws-start-here'].map((k) => html.indexOf(k));
  assert.ok(order.every((i) => i >= 0), `each is drawn: ${JSON.stringify(order)}`);
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'and the prompt comes under the band');
  assert.ok(!html.includes('data-ws-empty'), 'no empty note under it');
  assert.match(html, /data-ws-start-here=""><div class="dev-ws-head"><span class="dev-ws-head-title">Start working on this app<\/span><button type="button" class="dev-ws-card-close un-touch-target" data-ws-card-close="start" aria-label="Close this card" title="Close this card">/,
    'its ✕ ends the head');
  // The hub's own last line is the same action (#852), and stands down under
  // the banner that already leads with it.
  assert.ok(!html.includes('data-ws-start-change'), 'one Start a new change, not two');
});

test('15 Oct 2026: the start-here banner\'s ✕ closes it on this project for good, and the note does not come back', () => {
  const { hubDismissedStore } = devCardApi();
  const AppView = makeAppView();
  seedUntouched(AppView);
  const slug = AppView._workshopView().slug;
  assert.ok(slug, 'the page names its project');
  assert.match(workshopHtml(AppView), /data-ws-start-here=""[\s\S]*data-ws-card-close="start"/);
  const before = hubDismissedStore.get();
  try {
    hubDismissedStore.set({ read: true, closed: { [slug]: { start: Date.now() } } });
    const closed = workshopHtml(AppView);
    assert.ok(!closed.includes('data-ws-start-here'), 'closed on this project');
    assert.ok(!closed.includes('data-ws-empty'), 'and the note it stood for stays away');
    hubDismissedStore.set({ closed: { 'another-project': { start: Date.now() } } });
    assert.match(workshopHtml(AppView), /data-ws-start-here=""/, 'closing it on another project leaves this one');
  } finally {
    hubDismissedStore.set(before);
  }
  // The ✕ is the card's; what it offered stays on the page: the hero's ⋯
  // has Suggest an improvement and Build it now (actions-row.tsx).
  assert.match(WORKSHOP, /const \[closed, close\] = useHubDismissed\(slug, 'start'\);\s*if \(closed\) return null;/);
  assert.equal((WORKSHOP.match(/<HubCardClose card="start" onClose=\{close\} \/>/g) || []).length, 2, 'on both of its faces');
  assert.match(read('frontend/src/features/dev-board/actions-row.tsx'), /data-plus="issue"/);
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
test('#2573: the banner presses the same Start a new change the hub\'s ⋯ does', () => {
  assert.match(WORKSHOP, /import \{ Improve \} from '\.\.\/\.\.\/improve\/improve-controller\.js'/);
  assert.match(WORKSHOP, /onClick=\{\(\) => Improve\.startSession\(\)\}/);
  // The other one was the Improve panel's row, then the mark menu's button;
  // the menu's left with its Agent chats section (#4729), and the hub's ⋯
  // keeps the method. Same method, which is the whole point of asserting
  // both: two controls saying "start a new change" have to mean it.
  assert.match(read('frontend/src/features/dev-board/actions-row.tsx'),
    /data-plus="new-change"[\s\S]{0,300}Improve\.startSession\(\)/,
    'which is the method the hub\'s row calls');
  assert.doesNotMatch(SHEET_TSX, /improve-row-new-session/, 'the menu no longer carries one');
});

// ── #4896: where Homeroom bot builds for the viewer, the card sends them to it ──
//
// Onboarding run, 12 Oct 2026: a newcomer reached their new project's page
// at the end of the tour and met "Start working on this app. Nothing is open
// and nothing has shipped yet. The first change is yours to start." over
// Start a new change, which read like a developer tool.

test('#4896: an unstarted project the bot builds for asks what to change, and its one button is Homeroom bot', () => {
  const AppView = makeAppView();
  seedUntouched(AppView);
  AppView._ghIssuesMeta = { homeroomBot: { typicalMinutes: 8 } };
  assert.equal(AppView._workshopView().mine.bot, true, 'the bot builds here for this viewer (AppView._botDoor)');
  const html = workshopHtml(AppView);
  assert.match(html, /<section class="dev-ws-strip" data-ws-start-here="bot"><div class="dev-ws-head"><span class="dev-ws-head-title">What do you want to change\?<\/span><button type="button" class="dev-ws-card-close un-touch-target" data-ws-card-close="start" aria-label="Close this card" title="Close this card"><svg[^>]*>[\s\S]*?<\/svg><\/button><\/div><p class="dev-ws-strip-text">Describe what you want\. Homeroom bot makes the change for you\.<\/p><button[^>]*data-ws-start-here-bot=""[^>]*>Tell Homeroom bot what to change<\/button><\/section>/,
    'its ✕ ends the head (15 Oct 2026)');
  assert.match(html, /<button(?=[^>]*data-ws-start-here-bot="")[^>]*class="[^"]*bg-violet-600/, 'the accent: it is the one thing to do here');
  assert.doesNotMatch(html, /Start working on this app|The first change is yours|data-ws-start-here-btn|>Start a new change</,
    'not the developer\'s card, and no second button: building it yourself is the ⋯\'s Build it now');
  // Same place on the hub, and no note under it: it said the same thing
  // again, and offered to import a PR (15 Oct 2026).
  assert.ok(html.indexOf('data-ws-band') >= 0 && html.indexOf('data-ws-band') < html.indexOf('data-ws-start-here="bot"'));
  assert.ok(!html.includes('data-ws-empty'), 'no empty note under it');
  // Where the bot does not build (no door: it is off, paused here, or not
  // this viewer's), the card is as it was, Start a new change and all.
  AppView._ghIssuesMeta = {};
  const without = workshopHtml(AppView);
  assert.match(without, /data-ws-start-here=""[\s\S]*Start working on this app[\s\S]*data-ws-start-here-btn=""[^>]*>Start a new change</);
  assert.doesNotMatch(without, /data-ws-start-here-bot|Tell Homeroom bot/);
});

test('#4896: the button opens a new chat with Homeroom bot already set to this project', async () => {
  assert.match(WORKSHOP, /import \{ openBot \} from '\.\.\/\.\.\/messages\/store';/);
  assert.match(WORKSHOP, /onClick=\{\(\) => \{ void openBot\(startHereBotReference\(slug, name\)\); \}\}/);
  assert.match(WORKSHOP, /if \(bot && !readOnly && slug\) \{/, 'never for a viewer who may not start a change');
  const { startHereBotReference } = devCardApi();
  const ref = plain(startHereBotReference('demo-app', 'Geneva hikes'));
  assert.deepEqual(ref, { type: 'app', appSlug: 'demo-app', title: 'Geneva hikes' });
  assert.equal(plain(startHereBotReference('demo-app', '')).title, null);
  // 14 Nov 2026: it attached the project in Main Chat's box. There is no
  // Main Chat: a reference that is a project opens a new chat set to it
  // (#homeroom-bot/new?project=<slug>), with nothing attached.
  const fakeApi = new Proxy({},
    { get: (t, k) => (k in t ? t[k] : () => { throw new Error(`api.${String(k)} not stubbed`); }) });
  const went = [];
  const carry = loadTsx('frontend/src/features/messages/new-chat-carry.ts');
  const store = loadTsx('frontend/src/features/messages/store.ts', {
    stubs: {
      './api': fakeApi,
      './new-chat-carry': carry,
      '../ai/door': { ...loadTsx('frontend/src/features/ai/door.ts'), goBotAddress: (href) => went.push(href) },
    },
  });
  assert.equal(store.stagedComplete(ref), true);
  await store.openBot(ref);
  assert.deepEqual(went, ['#homeroom-bot/new?project=demo-app']);
  assert.equal(carry.takeCarried(), null, 'a project is the chat\'s chip, not an item in its box');
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


test('#1934: All items\' search leaves the "more" alone, and the unclaimed count with it (#2915)', () => {
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
  assert.equal(v.dashboard.unclaimed, 2, 'and both are still counted, for the Hub\'s line');
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
  assert.ok(!html.includes('data-ws-happened') && !html.includes('data-ws-mine=""') && !html.includes('data-ws-dashboard'),
    'what happened, your work in full and the board are the Workshop page\'s');
  assert.ok(!html.includes('data-ws-discussion'), 'and the old discussion section is gone');
  assert.ok(!html.includes('data-discussion-row'), 'nor its row');
  assert.equal(AppView._workshopView().since.total, 3, 'the view model still counts the whole population');
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
  // The state is the one tag (dev-card.tsx ChangeTag): a vote that waits on
  // the viewer is its needs-you state, in the server's words.
  assert.match(html, /data-state-tag="needs" class="one-tag one-tag-strong" data-pill-key="needs_vote"[^>]*><span class="one-tag-words">Vote · \d+\/\d+</,
    'the state line carries the vote, as the tag that asks for you');
  // The blocker is a tag on the row's tags line (#4486: the brief's words for
  // the card's status tags) — not on the band. The band is the vote and the
  // Vote button.
  // #2222: amber. A predicted conflict the platform resolves by itself is not
  // the reader's move, so it reads as worth knowing, not as a failure.
  assert.match(html, /<span data-state-tag="plain" class="one-tag one-tag-plain dev-ws-tag"[^>]*>Conflicts with main · 2 files<\/span>/);
  assert.ok(html.indexOf('Conflicts with main') < html.indexOf('dev-ws-row-band'),
    'the tag is above the band, on the meta line');
  assert.ok(!html.includes('dev-ws-row-pill'),
    'it is no longer flattened to plain text in the grey the author\'s name wears');

  // The line is clipped to one for the same reason the dense card's rows are:
  // a row that grew with its state would break the column's rhythm. The vote
  // button sits at its right end, where the card's bar puts it.
  assert.match(CSS, /\.dev-ws-row-band \{[^}]*flex-wrap: nowrap;[^}]*overflow: hidden;/);
  assert.match(CSS, /\.dev-ws-row-band > \.dev-ws-row-trailing \{ margin-inline-start: auto; \}/);
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
  const html = categoryPaneHtml(AppView, 'all');
  // Two issues open + one proposal in review = 3. The merge is NOT counted:
  // the number answers "how much is left in here", and shipped work is not.
  assert.match(
    html,
    /<span class="dev-ws-stat"><b>\d+<\/b>(?:person|people)<\/span><span class="dev-ws-stat"><b>3<\/b>items<\/span>/,
    'people and items, side by side',
  );
  assert.match(CSS, /\.dev-ws-stat \+ \.dev-ws-stat \{[^}]*border-inline-start:/, 'divided by a hairline');
});

test('a theme wears the glyph the model chose, or its initial when there is none', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Game Corner', icon: '🎮', items: ['issue:12'] }]);
  assert.match(categoryPaneHtml(AppView, 'all'), /<span class="dev-ws-theme-icon" aria-hidden="true">🎮<\/span>Game Corner/);

  // A row written before icons existed, or an answer the sanitiser rejected:
  // the initial on the name's own swatch, which reads as chosen where a
  // hashed-from-the-name emoji would be stable and meaningless.
  AppView._workshopThemes = themes([{ id: 't', name: 'Game Corner', items: ['issue:12'] }]);
  assert.match(
    categoryPaneHtml(AppView, 'all'),
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
  const html = categoryPaneHtml(AppView, 'all');
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
  // #6509: the theme is saved with the project's filters, so the board that
  // opens reads it back from localStorage; another project's is untouched.
  assert.equal(AppView._loadKanbanFilters('demo-app').theme, 't',
    'the theme is remembered with the project’s filters');
  assert.equal(AppView._loadKanbanFilters('another-app').theme, null,
    'and a project keeps its own filters');
});

// ── the component ────────────────────────────────────────────────────

test('the Workshop renders its strips, its themes and their rows', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'Looks.', saying: 'Dark mode should stick.', items: ['issue:12', 'session:34', 'session:78'] }]);
  // Themes start shut; `?shot=themes` is the URL that opens one with every
  // row in it still folded, which is what the lanes below are asserted on.
  AppView._workshopShot = 'themes';
  const html = categoryPaneHtml(AppView, 'all');
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
  // A pull request on GitHub, so its number is a link out (a change kept in
  // Homeroom draws it as text: the row already opens its page).
  AppView._proposals[0].pr_url = 'https://github.com/x/y/pull/41';
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'session:34'] }]);
  AppView._workshopShot = 'themes';
  const page = categoryPaneHtml(AppView, 'all');
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
  assert.match(CSS, /\.dev-card-head:has\(> \.dev-card-icon\) ~ \.dev-card-facts \{ padding-inline-start: 30px; \}/);
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
  assert.match(unfolded, /const openBtn = placement && href\s*\? <a className="gc-vote-btn dev-ws-open-btn" href=\{href\} data-ws-open-card=\{row\.key\}>\{t\('project:card\.fold\.openCard'\)\}<\/a>/,
    'one anchor, one label');
  assert.equal(message('project:card.fold.openCard'), 'Open card');
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




test('#4457: a row\'s line is the board\'s words: its number, who made it, what it is for, and when', () => {
  // 5 Nov 2026: Your work, which first drew these words for your own rows,
  // went (your work is the Homeroom bot tab's); the board and a week's page
  // still say them, from the card's own brief.
  const AppView = makeAppView();
  seed(AppView);
  AppView._ghIssues[0].in_progress = {
    count: 0, users: [], peopleTotal: 1, mine: true, sessions: [],
    claims: [{ username: 'me', userId: 1, mine: true, claimedAt: at(1), expiresAt: at(1 + 7 * 24) }],
    target: null,
  };
  const issue = AppView._ghIssues[0];
  const claimed = AppView._workshopBrief('issue', issue, AppView._issueCardModel(issue));
  assert.deepEqual(plain(claimed.tags), [{ label: 'Picked up · you', tone: 'plain' }], 'its tag says who is on it (#4486)');
  assert.equal(claimed.kind, 'request');
  assert.equal(claimed.n, 12);
  const session = { id: 51, session_title: 'Bottom tabs', status: 'paused', pr_number: null, linked_issues: [12],
    created_at: at(1), last_activity_at: at(0) };
  const change = AppView._workshopBrief('my-session', session, AppView._mySessionCardModel(session));
  assert.deepEqual(plain(change.linked), [12]);
  assert.equal(change.mine, true);
  // #4486: the line is the board's words — the number, who made it, what a
  // change is for or a live one closed, and when, as the card's meta line
  // dates it. The category and the replies are the coloured chip and the 💬
  // count on the tags line, so they are not said here too.
  const { rowWords } = loadTsx('frontend/src/features/dev-board/workshop/work-row.tsx');
  assert.equal(typeof change.ago, 'string', 'the brief carries the card\u2019s own age');
  const b = { ...plain(change), by: 'evan', ago: '' };
  assert.equal(rowWords(b), 'Change · evan · for #12', 'a change with no number yet');
  assert.equal(rowWords({ ...b, n: 4456, linked: [4455, 4452], ago: '4m ago' }), 'PR 4456 · evan · for #4455 and #4452 · 4m ago');
  assert.equal(rowWords({ ...plain(claimed), by: 'evan', category: 'Bug', replies: 3, ago: '8h ago' }), '#12 · evan · 8h ago');
  assert.equal(rowWords({ ...b, kind: 'live', linked: [], closed: [4453], n: 4454, ago: '1h ago' }), 'PR 4454 · evan · closed #4453 · 1h ago');
  assert.equal(rowWords({ ...b, kind: 'vote', noun: 'vote', linked: [], n: 7 }), 'Vote #7 · evan');
  // `noun` is a key; the words are the row's messages.
  assert.equal(b.noun, 'change');
  assert.equal(message('project:workRow.name.changeNumbered', { number: 4456 }), 'PR 4456');
  assert.equal(message('project:workRow.name.requestNumbered', { number: 12 }), '#12');
  // The board's words never say "yours": a row of yours names you as its
  // maker, as every other row names its own.
  assert.doesNotMatch(rowWords(b), /yours/);
  assert.doesNotMatch(rowWords({ ...plain(claimed), mine: true, by: 'evan' }), /yours/);
});

test('#4457, #4486, #4718: a change up for a vote keeps its vote on its own line under the tags: the card\'s bar with its own words, and its Vote', () => {
  const { WorkRow } = loadTsx('frontend/src/features/dev-board/workshop/work-row.tsx');
  const AppView = makeAppView();
  seed(AppView);
  const v = AppView._workshopView();
  const row = [...v.votes.rows, ...(v.since ? v.since.rows : [])].find((r) => r.t === 'card' && r.card.attrs['data-proposal-row']);
  assert.ok(row, 'a proposal row');
  const brief = { kind: 'change', noun: 'Change', n: 34, by: 'bob', mine: false, category: '', replies: 0, linked: [], closed: [], stage: 'vote', at: 0,
    tags: [{ label: 'Checks running…', tone: 'run' }, { label: 'Preview ready', tone: 'plain', glyph: 'eye' }], vote: { yes: 1, need: 3, ask: true } };
  const html = renderToHtml(createElement(WorkRow, { row: { ...row, brief }, slug: 'demo-app' }));
  assert.match(html, /<span data-state-tag="working" class="one-tag one-tag-plain one-tag-working dev-ws-tag"><span class="dc-status-spinner-arc" aria-hidden="true"><\/span>Checks running…<\/span>/);
  // #7182: Homeroom bot's own tone spins too, and paints in the bot's colour.
  const botBrief = { ...brief, tags: [{ label: 'Homeroom bot is building this', tone: 'bot' }] };
  const botHtml = renderToHtml(createElement(WorkRow, { row: { ...row, brief: botBrief }, slug: 'demo-app' }));
  assert.match(botHtml, /<span data-state-tag="working" class="one-tag one-tag-plain one-tag-working dev-ws-tag"><span class="dc-status-spinner-arc" aria-hidden="true"><\/span>Homeroom bot is building this<\/span>/);
  // Homeroom bot's own work turns like any other: the one tag's working state.
  // #4499: once the run knows its total, the tag carries a bar instead of
  // "619/732", with the count as its tooltip and the bar's name.
  const runningBrief = { ...brief, tags: [{ label: 'Checks', tone: 'run', title: '619 of 732 checks done. Automated tests are still running.', progress: { done: 619, total: 732, text: '619 of 732 checks done' } }] };
  const running = renderToHtml(createElement(WorkRow, { row: { ...row, brief: runningBrief }, slug: 'demo-app' }));
  assert.match(running, /<span data-state-tag="working" class="one-tag one-tag-plain one-tag-working dev-ws-tag" title="619 of 732 checks done\. Automated tests are still running\."><span class="dc-status-spinner-arc" aria-hidden="true"><\/span>Checks<span class="checks-chip-bar" role="progressbar" aria-valuemin="0" aria-valuemax="732" aria-valuenow="619" aria-label="619 of 732 checks done"><span class="checks-chip-bar-fill" style="width:85%"><\/span><\/span><\/span>/);
  // #4486: the thin bar and its "1 of 3 yes" went; the card's own status
  // pill says it in its own words, as the one tag (dev-card.tsx ChangeTag)
  // at its words' width.
  const pill = row.card.pill.state;
  assert.match(html, new RegExp(`<span class="dev-ws-wvote" data-ws-vote=""><span data-state-tag="[a-z]+" class="one-tag [a-z -]+ dev-ws-wvote-state"[^>]*>(?:<span class="dc-status-spinner-arc" aria-hidden="true"></span>)?<span class="one-tag-words">${pill.label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}</span></span><span class="dev-ws-wvote-btn">`),
    'the tag, then Vote');
  assert.ok(!/dev-ws-wvote-bar|dev-ws-wvote-n|dev-ws-wvote-cell/.test(html), 'no thin bar, no count beside it');
  // #4718: the vote takes a line of its own under the tags, at the row's
  // far end, on every width — it never rides the tags' line, so rows beside
  // each other keep their pills lined up whatever the tags' length.
  assert.match(html, /<\/span><span class="dev-ws-wrow-votes"><span class="dev-ws-wvote" data-ws-vote="">/, 'the tags line closes, then the votes line opens with the vote');
  const statusLine = html.slice(html.indexOf('<span class="dev-ws-wrow-status">'), html.indexOf('<span class="dev-ws-wrow-votes">'));
  assert.ok(!statusLine.includes('dev-ws-wvote'), 'the tags line holds no vote');
  assert.match(html, /<span data-state-tag="plain" class="one-tag one-tag-plain dev-ws-tag"><svg[^>]*>.*?<\/svg>Preview ready<\/span><\/span><span class="dev-ws-wrow-votes">/, 'a tag without short words draws its label, and the tags line ends before the vote');
  assert.match(CSS, /\.dev-ws-wrow-votes \{ margin-top: 6px; display: flex; align-items: center; \}/);
  assert.match(CSS, /\.dev-ws-wvote \{\s*position: relative; z-index: 1; margin-inline-start: auto;/);
  const short = { ...brief, tags: [{ label: 'Taking before & after screenshots', short: 'Taking screenshots', tone: 'run' }, { label: 'Preview ready', short: 'Preview', tone: 'plain', glyph: 'eye' }] };
  const shortHtml = renderToHtml(createElement(WorkRow, { row: { ...row, brief: short }, slug: 'demo-app' }));
  assert.match(shortHtml, /<span data-state-tag="working" class="one-tag one-tag-plain one-tag-working dev-ws-tag" title="Taking before &amp; after screenshots"><span class="dc-status-spinner-arc" aria-hidden="true"><\/span><span aria-hidden="true">Taking screenshots<\/span><span class="sr-only">Taking before &amp; after screenshots<\/span><\/span>/);
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
  // #4629: the open waits for a microtask — a flushSync inside the effect
  // body is dropped, and mountThread then wired nothing to the composer.
  assert.match(PANEL, /let live = true;\s*queueMicrotask\(\(\) => \{ if \(live\) void callAppView\('openTopicInPanel', item\.kind, item\.id\); \}\);\s*return \(\) => \{ live = false; callAppView\('closeTopicPanel', item\.kind, item\.id\); \};/);
  assert.match(PANEL, /callAppView\('openTopic', item\.kind, item\.id\)/, 'Open as a page is the page\'s own route');
  const open = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('async openTopicInPanel(kind, id) {'), APP_VIEW_SRC.indexOf('closeTopicPanel(kind, id) {'));
  assert.match(open, /AppView\._devTopic = \{ kind, id \};/);
  // #4640: a request's or governance discussion mounts on the ref alone,
  // before the item fetch (as the full page's _renderTopicSubView mounts
  // them); the after-fetch mount is guarded by "not mounted yet", still
  // followed by _renderTopicHead.
  assert.match(open, /let threadMounted = false;\s*if \(\(kind === 'issue' \|\| kind === 'gov'\) && current\(\)\) \{\s*threadMounted = true;\s*AppView\._mountTopicThread\(\);\s*\}/,
    'the discussion mounts on the ref alone, before the item fetch');
  assert.match(open, /if \(!threadMounted\) AppView\._mountTopicThread\(\);\s*AppView\._renderTopicHead\(\);/, 'the full page\'s own mount and paint');
  assert.match(APP_VIEW_SRC, /if \(subTab !== 'topic'\) \{ AppView\._devTopic = null; AppView\._devTopicInPanel = false; \}/,
    'a move to another sub-view lets it go');
  // A plain click on a wide window; anything else is the row's own link.
  // #4417: still 1180px, so a 1280px window keeps it. The places are nested
  // in the sidebar, so nothing beside the page steps aside for it now.
  // #6380: the breakpoint is still 1180px, in one place now — the module the
  // column beside the Homeroom bot's list asks too (./panel-target.ts).
  const PANEL_TARGET = read('frontend/src/features/dev-board/workshop/panel-target.ts');
  assert.match(PANEL_TARGET, /export const WORKSHOP_SIDE_QUERY = '\(min-width: 1180px\)';/);
  assert.match(WORKSHOP, /const sideWide = useMediaFlag\(WORKSHOP_SIDE_QUERY\);/);
  assert.match(WORKSHOP, /const sideOpen = !!sideItem && \(tab === 'workshop' \|\| tab === 'all' \|\| tab === 'bot'\);/);
  assert.doesNotMatch(WORKSHOP, /publishSide/);
  assert.match(WORKSHOP, /if \(!sideWide\) return;\s*event\.preventDefault\(\);/);
  assert.match(WORKSHOP, /\{sideOpen && sideItem \? <TopicSidePanel item=\{sideItem\} onClose=\{closeSide\} \/> : null\}/,
    'from the Workshop tab\u2019s lists, from All items (#4486) and from the bot\u2019s slots page (16 Oct 2026)');
  // The list makes room and keeps its place; the open row is lit.
  assert.match(CSS, /#dev-workshop:has\(> \.dev-ws\[data-ws-side-open\]\) \{/);
  assert.match(CSS, /\.dev-ws-wrow\[data-on\] \{ background: var\(--lit-tint\); \}/);
});

test('#6208: the open panel takes the room the list leaves, and the list sits at the inset', () => {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // One width on body, read by both: the list (a descendant) and the panel
  // (portalled into body). It is the container box — the usable width less
  // the two gutters — less the 616px the panel, inset and gap need, capped
  // at the list's reading width.
  assert.match(stripped, /--dev-ws-side-list-w: min\(760px, calc\(var\(--platform-usable-w\) - 2 \* var\(--platform-gutter, 0px\) - 616px\)\);/);
  // The usable box's edge on the rail's side, mirrored in Arabic.
  assert.match(stripped, /--dev-ws-side-start: calc\(var\(--platform-usable-left\) \* \(1 \+ var\(--rtl-sign\)\) \/ 2 \+ var\(--platform-usable-right\) \* \(1 - var\(--rtl-sign\)\) \/ 2\);/);
  // The panel starts a 32px gap past the list's end and runs to the 24px
  // inset: both insets, no width of its own.
  const panel = stripped.slice(stripped.indexOf('.dev-ws-side {'));
  const panelRule = panel.slice(0, panel.indexOf('}'));
  assert.match(panelRule, /inset-inline-start: calc\(var\(--dev-ws-side-start\) \+ var\(--platform-gutter, 0px\) \+ 24px \+ var\(--dev-ws-side-list-w\) \+ 32px\);/);
  assert.match(panelRule, /inset-inline-end: 24px;/);
  assert.doesNotMatch(panelRule, /(^|\s)width: 560px;/);
  // The figures the rule gives (sidebar 212px, gutter 24px): at 1280px the
  // list keeps today's 404px and the panel today's 560px; at 1720px the
  // list is at its 760px and the panel takes the rest.
  const layout = (win) => {
    const usable = win - 212;
    const list = Math.min(760, usable - 2 * 24 - 616);
    const start = 212 + 24 + 24 + list + 32;
    return { list, start, panel: win - 24 - start };
  };
  assert.deepEqual(layout(1720), { list: 760, start: 1052, panel: 644 });
  assert.deepEqual(layout(1280), { list: 404, start: 696, panel: 560 });
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

test('#1887: a card about your own session opens the CARD, and nothing on it leads to a dev chat', () => {
  // Opening a card about your own session used to navigate to the session
  // — the row's page link and the delegated #dev-body handler both went to
  // /dev/sessions/<id>. It is a card like every other now: the row unfolds
  // it in place and the change's page is the open card's pill (#1886).
  // #1887 put the session's dev chat INSIDE the open card as a line under
  // the sheet; that chat is retired, and its line with it.
  const mine = { id: 51, session_title: 'Bottom tabs', status: 'active', pr_number: null, linked_issues: [],
    created_at: at(1), last_activity_at: at(0) };
  const AppView = makeAppView();
  seed(AppView);
  AppView._mySessions = [{ ...mine }];
  // 5 Nov 2026: the Workshop and the Hub no longer list your own work (the
  // Homeroom bot tab does, ../frontend/src/features/ai/), so the card is the
  // board's own, by the same model the Board draws it with.
  const row = { t: 'card', key: 'my-session:51', card: AppView._mySessionCardModel({ ...mine }) };
  assert.equal(row.card.attrs['data-session-chip'], '51', 'the card carries the hook the checks name it by');

  // THE OPEN CARD, where a fold still draws one (the fold's own rule, which
  // a list that unfolds rows in place gets): its pill in the action band,
  // and nothing under the sheet.
  const { ListRowView } = loadTsx('tests/fixtures/dev-card-api.ts');
  const open = renderToHtml(createElement(ListRowView, {
    row: plain(row), fold: { slug: 'demo-app', canPost: true, open: true, onToggle: () => {} },
  }));
  assert.match(open, /^<div class="dev-ws-rowwrap dev-ws-rowwrap-open"><div class="dev-feed-entry dev-ws-sheet" data-ws-sheet="my-session:51"><div class="[^"]*dev-card-dense"[^>]*data-session-chip="51"/,
    'the open card, hook intact');
  // The change's page is the pill's, not a line under the sheet (#1886) —
  // and since #1884 round two the pill IS that link on its first tap, here
  // as on the Board, rather than opening the sections in place and becoming
  // the link on a second.
  assert.match(open, /<a class="gc-vote-btn dev-ws-open-btn" href="#app\/demo-app\/dev\/proposals\/51" data-ws-open-card="my-session:51">Open card<\/a>/,
    'the open card carries the pill, and it is the page link');
  assert.ok(!open.includes('Open on its own page'), 'no page link under the sheet');
  assert.ok(!open.includes('Open page ›'), 'and no second step to reach one');
  assert.ok(!open.includes('dev-ws-sheet-actions'), 'no line under the sheet');
  assert.ok(!open.includes('data-ws-open-session'), 'no session link');
  assert.ok(!open.includes('/dev/sessions/51'), 'and nothing on the card leads to the retired dev chat');
  assert.ok(!/\.dev-ws-sheet-(actions|sep)\b/.test(CSS), 'nor does the stylesheet keep a rule for that line');

  // The helpers, from the bundle: the card's page is the change's, and the
  // session helper is gone with the link it built.
  const fold = loadTsx('frontend/src/features/dev-board/card/fold.tsx');
  assert.equal(fold.openHref('demo-app', row.card), '#app/demo-app/dev/proposals/51');
  assert.equal(fold.sessionHref, undefined);

  // A tap outside a fold — the delegated #dev-body handler — opens the
  // change's page too, never the session (#2020). An old /dev/sessions/<id>
  // bookmark is rewritten to that page by the router (App._oldChatAddress).
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

  // 5 Nov 2026: the declared check that read the hub's Your work leading
  // with this session went with that row's list; the Hub's Your work is a
  // door to the Homeroom bot tab now, and its own check pins that.
  assert.ok(!dapp.tests.some((t) => /#1887/.test(t.name)), 'retired with the list it read');
  assert.ok(!/'mine-session'/.test(APP_VIEW_SRC), 'and so is its shot');
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




// #5466: a vote cast OFF the project page used to leave the kept queue
// holding the row — `AppView._publishWorkshop` publishes only while
// #dev-workshop is up and `refreshDevData` no-ops outside the dev tab — so
// the hub's "For you" card, the places list's Needs you count and the deck
// itself kept asking for a vote the server had saved. Two pins: the kept
// queue hears a saved vote cast anywhere (every vote funnels through
// AppView.castVote, whose ok path publishes into voteSavedStore, so the
// store listener covers the deck's own vote too — the project page passes
// no `onAnswered` hook, as #4794 pins), and the publish strips saved votes
// at the door through the same pure rule the listener runs, so a later
// publish built from a pre-vote list cannot bring the row back.
test('#5466: the project deck and its publish drop a saved vote\'s row', () => {
  // The strip is one shared rule, used by the listener over the kept queue
  // (which fires whichever tab the viewer is on) and by the publish.
  assert.match(WORKSHOP, /export function withoutSavedVotes\(/);
  // #6990: the same listener also hears a group decision's saved vote
  // (govVoteSavedStore), so both stores go through the one strip.
  assert.match(WORKSHOP,
    /voteSavedStore\.subscribe\(stripSavedQueue\);[\s\S]*?govVoteSavedStore\.subscribe\(stripSavedQueue\);/,
    'the kept queue hears a vote cast anywhere, through the same rule');
  assert.match(WORKSHOP,
    /withoutSavedVotes\(cur\.queue, voteSavedStore\.get\(\), govVoteSavedStore\.get\(\)\)/,
    'the strip takes both saved-vote maps');
  const MOUNT = read('frontend/src/features/dev-board/mount.ts');
  assert.match(MOUNT, /import \{ DevWorkshop, withoutSavedVotes \} from '\.\/workshop\/workshop';/);
  assert.match(MOUNT, /withoutSavedVotes\(view\.queue, voteSavedStore\.get\(\), govVoteSavedStore\.get\(\)\)/,
    'a publish runs the queue through the strip at the door');
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
  let html = categoryPaneHtml(AppView, 'all');
  assert.match(html, /drafting categories…/, 'pending on the grouping says so in the eyebrow');
  assert.match(html, /Categories are being drafted from the board now\./);
  assert.ok(!html.includes('regrouping…'), 'and does not claim a regroup of categories that do not exist yet');

  AppView._workshopThemes = cat({ lastError: 'boom' });
  html = categoryPaneHtml(AppView, 'all');
  assert.match(html, /The last attempt to draft categories failed \(boom\)\./);

  AppView._workshopThemes = cat({});
  html = categoryPaneHtml(AppView, 'all');
  assert.match(html, /No AI model is configured, so items are grouped by the categories the group has voted for\./);
  assert.ok(!html.includes('drafted once an AI model is available'), 'the misleading copy is gone');

  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'd', saying: 's', items: ['issue:12'] }],
    { pending: true, pendingStage: 'placement', coverage: { total: 4, placed: 1, unplaced: 0, pending: 3 } });
  html = categoryPaneHtml(AppView, 'all');
  assert.match(html, /placing new cards…/, 'pending placement on real categories says so');
  // The stamp has to sit inside `relStamp`'s relative window for that copy to
  // be the copy under test at all. Pinned here so a fixture that drifts out of
  // it fails as "the fixture went stale" rather than as a grouping bug — which
  // is how it read the first time, a week after the date was hardcoded.
  const REL_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;
  const stamp = Date.parse(themes([], {}).discoveredAt);
  assert.ok(Date.now() - stamp < REL_FLOOR_MS,
    'the fixture stamp is relative to now, not a wall-clock date that ages out');
  assert.match(read('frontend/src/lib/timestamp.ts'), /const RELATIVE_FLOOR_MS = 7 \* 24 \* 60 \* 60 \* 1000;/,
    'and that window is still seven days where lib/timestamp.ts (relStamp\'s agoStamp) defines it');
  assert.match(html, /Categories were drafted \d+[hd] ago and are re-drafted daily, or sooner when a tenth of the board changes\./);
  assert.match(html, /3 new cards are being placed\./);
  // The name is preceded by the theme's glyph now (#1787); the pin is still
  // on the COPY, which is what these four states are about.
  assert.match(html, /<div class="dev-ws-theme-name">(?:<span class="dev-ws-theme-icon[^>]*>[^<]*<\/span>)?Being placed<\/div>/);
  // The row's marker: the pseudo-theme is folded on a plain paint, so the
  // marker is pinned at the source, on the folded row.
  assert.match(FOLD, /\{row\.placing \? <span className="dev-ws-placing"[^>]*>\{t\('project:card\.fold\.placing'\)\}<\/span> : null\}/);
  assert.equal(message('project:card.fold.placing'), 'placing…');
  assert.match(CSS, /\.dev-ws-placing \{/);

  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'd', saying: 's', items: ['issue:12'] }],
    { pending: true, pendingStage: 'discovery', unplaced: ['issue:13', 'session:34', 'session:78'], coverage: { total: 4, placed: 1, unplaced: 3, pending: 0 }, lastError: 'placement: boom' });
  html = categoryPaneHtml(AppView, 'all');
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

test('#6791: a pending regrouping with no poll running is checked at most once a minute', async () => {
  // A regrouping whose chain has run out of steps leaves `pending` set and no
  // timer. WS-driven reloads used to skip the minute's throttle in that state
  // and re-read the endpoint (which rebuilds the server's input) on every one.
  let calls = 0;
  const AppView = makeAppView({
    fetch: async () => { calls++; return { ok: true, json: async () => ({ themes: [], source: 'category', pending: false }) }; },
  });
  AppView._getViewMode = () => 'kanban';
  AppView._repaintBoardSurface = () => {};
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }],
    { pending: true, at: Date.now() - 59000 });
  AppView._workshopPollTimer = null;
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 0, 'inside the minute: no fetch, pending or not');
  // The broadcast that says it finished, and the board's own recovery, still
  // read past it.
  await AppView._loadWorkshopThemes('demo-app', 0, { force: true });
  assert.equal(calls, 1, 'force still fetches');
  // A minute after the last read the check runs again.
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }],
    { pending: true, at: Date.now() - 61000 });
  AppView._workshopPollTimer = null;
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 2, 'a stale pending cache is read again');
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
  assert.match(CSS, /#dev-body:has\(> #dev-workshop\) \{ padding-block: 8px var\(--ws-gap, 8px\); padding-inline: 4px; \}/);
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
  assert.match(SHEET_TSX, /communityRowHref\(slug: string \| null \| undefined, owed: number \| null\): string \{[\s\S]*?return `#app\/\$\{encodeURIComponent\(slug\)\}\/dev\/hub`;[\s\S]*?href=\{communityRowHref\(slug, owed\)\}/);
  assert.ok(!SHEET_TSX.includes('data-context-row="activity"'), 'the Activity segment retired');
  assert.ok(!/data-context-row="board"|dataContextRow="board"/.test(SHEET_TSX),
    'and the Board segment after it — the Workshop and the kanban are one '
    + 'screen in two layouts, so the layout is not a destination in the menu');
  assert.match(SHEET_TSX, /label=\{t\('agent:appContext\.row\.community'\)\}/);
  assert.equal(message('agent:appContext.row.community'), 'Go to community');
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

test('All items is the board by stage, with no grouping switch, whatever was chosen before (request 6708)', () => {
  // The page had a second view, by category, behind a "By category" / "By
  // stage" switch. One view is left. A choice stored while the switch existed
  // (every spelling of it) and a link that asks for a pane change nothing.
  const cases = [
    {}, { localStorage: { devWorkshopGroup: 'category' } }, { localStorage: { devWorkshopGroup: 'theme' } },
    { localStorage: { devWorkshopGroup: 'stage' } }, { localStorage: { devWorkshopGroup: 'nonsense' } },
    { location: { search: '?group=category', hash: '', href: 'http://localhost/?group=category' } },
    { location: { search: '?group=theme', hash: '', href: 'http://localhost/?group=theme' } },
  ];
  let html = '';
  for (const o of cases) {
    const store = { ...(o.localStorage || {}) };
    const AppView = makeAppView({ ...o, localStorage: store });
    seed(AppView);
    AppView._workshopThemes = themes([
      { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
    ]);
    const label = JSON.stringify(o);
    assert.equal(AppView._getWorkshopGroup(), 'stage', label);
    html = workshopHtml(AppView, 'all');
    assert.ok(!html.includes('data-ws-group') && !html.includes('dev-ws-group'), `no switch: ${label}`);
    assert.ok(!html.includes('By category') && !html.includes('By stage'), `nor its words: ${label}`);
    assert.ok(html.includes('id="dev-kanban-tabs"'), `the pipeline's steps: ${label}`);
    assert.match(html, /class="dev-ws-board" data-ws-stage=""><[^>]*id="dev-kanban"/, `over the board's own columns: ${label}`);
    assert.ok(!html.includes('dev-ws-themes') && !html.includes('dev-ws-sort-opts') && !html.includes('dev-ws-foot-note'),
      `no category cards, order chips or grouping footnote: ${label}`);
    assert.equal(store.devWorkshopGroup, (o.localStorage || {}).devWorkshopGroup, `and no choice is written: ${label}`);
  }

  // NO TITLE LINE IN THE HEAD. It used to open with an "All items" eyebrow;
  // the page's own name says it.
  assert.ok(!html.includes('dev-ws-pane-eyebrow'), 'the eyebrow is gone');
  assert.ok(!/\.dev-ws-pane-eyebrow/.test(CSS), 'and so is the rule that styled it');
  // #4486: ONE ROW, the page's way back and its name, then the tools.
  assert.match(html, /class="dev-ws-pane-head"><div class="dev-ws-allbar" data-ws-allbar=""><div class="dev-ws-pagehead" data-ws-pagehead="">[\s\S]*?<h2 class="dev-ws-pagehead-title">All items<\/h2><\/div><\/div><div id="dev-actions"/);
  assert.ok(!html.includes('dev-ws-pagehead-over'), 'and no "Workshop" eyebrow over the name');
  assert.ok(
    !dapp.tests.some((t) => /data-ws-ear/.test(t.expectSelector || '')),
    'no declared check names the ear',
  );
  const head = dapp.tests.find((t) => t.id === 'workshop.grouping-ear');
  assert.ok(head, 'the head\'s declared check keeps its id');
  assert.ok(!/[?&]group=/.test(head.path), 'and asks for no pane');
  assert.equal(head.expectText, 'Waiting for approval');
  assert.ok(html.includes('Waiting for approval'), 'a step of the pipeline, which only the board draws');
  assert.ok(head.expectSelector.includes('[data-ws-pane]:not(:has([data-ws-group], .dev-ws-themes))'), 'it holds that no switch and no category list is drawn');
  assert.ok(head.expectSelector.includes('.dev-ws-board[data-ws-stage] > #dev-kanban'), 'that the page is the board');
  assert.ok(head.expectSelector.endsWith('> .dev-ws-allbar:not(:has(.dev-ws-pagehead-over, .dev-ws-eyebrow)) > [data-ws-pagehead]:first-child + #dev-actions'),
    'and that the tools come straight after the page\'s way back, with no title line');
  for (const t of dapp.tests) {
    assert.ok(!/data-ws-group|\.dev-ws-group|\.dev-ws-themes \[|data-ws-theme=|shot=themes/.test(`${t.path || ''} ${t.expectSelector || ''}`.replace(head.expectSelector, '')),
      `no other declared check walks the switch or the category cards: ${t.name}`);
    assert.ok(!/^By (category|stage)$/.test(t.expectText || ''), `or reads its words: ${t.name}`);
  }
  const old = dapp.tests.find((t) => /[?&]group=category/.test(t.path || ''));
  assert.ok(old && /\[data-ws-stage\] > #dev-kanban/.test(old.expectSelector), 'an old ?group=category link is checked to land on the board');

  // The switch is not in the sources, in any look.
  assert.ok(!/GroupStrip|data-ws-group|_setWorkshopGroup/.test(WORKSHOP), 'the page draws none and sets none');
  assert.ok(!/_setWorkshopGroup|_overrideWorkshopGroup|WORKSHOP_GROUP_KEY|devWorkshopGroup'/.test(APP_VIEW_SRC), 'app-view.js stores and reads no choice');
  assert.match(APP_VIEW_SRC, /\n  _getWorkshopGroup\(\) \{ return 'stage'; \},\n/);
  assert.ok(!/\.dev-ws-group/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/:is\(\.dev-ws-pagehead, \.dev-ws-group\)/g, '')),
    'and app.css styles none');
  const frame = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/dev-board/workshop/group-mode-store.ts'), 'utf8');
  assert.match(frame, /export const DEFAULT_WORKSHOP_GROUP: WorkshopGroup = 'stage';/, 'the pane\'s store rests on the board');
});

test('the sort row reports the state of the grouping after the count', () => {
  // The second half of that eyebrow: the part the list under it cannot say
  // for itself. Appended to the count, one clause per thing to report.
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = { ...themes([{ id: 't', name: 'T', items: ['issue:12'] }]), source: 'category' };
  assert.match(categoryPaneHtml(AppView, 'all'), /class="dev-ws-eyebrow">1 category · grouped by category for now</);
  AppView._workshopThemes = { ...themes([{ id: 't', name: 'T', items: ['issue:12'] }]), pending: true };
  assert.match(categoryPaneHtml(AppView, 'all'), /class="dev-ws-eyebrow">1 category · re-drafting categories…</);
  AppView._workshopThemes = {
    ...themes([{ id: 't', name: 'T', items: ['issue:12'] }]), pending: true, pendingStage: 'placement',
  };
  assert.match(categoryPaneHtml(AppView, 'all'), /class="dev-ws-eyebrow">1 category · placing new cards…</);
});

test('All items draws the board\'s own columns, and keeps everything above it', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
  ]);
  const html = workshopHtml(AppView, 'all');
  // The board, rendered INSIDE the Workshop: the same node ids the standalone
  // Board mode drew, because it is the same component.
  assert.ok(html.includes('id="dev-kanban"'), 'the board renders in the pane');
  assert.ok(html.includes('data-ws-stage'), 'inside the stage wrapper');
  assert.ok(!html.includes('dev-ws-themes'), 'no category list');
  assert.ok(!html.includes('dev-ws-sort-opts'), 'and no category sort chips');
  assert.ok(!html.includes('data-ws-dashboard'), 'the status strip is the Workshop page\'s');
  // #4417: the place bar names the Workshop over All items, its page;
  // #4486: the page's way back is in its pinned head under it.
  assert.match(html, /data-ws-band="" data-place-bar="all"[\s\S]*?data-place-title="">Workshop<\/h2>[\s\S]*?data-ws-allbar=""/,
    'and you are still on All items: the bar names the Workshop, the page\'s way back in the head under it (#852, #4486)');
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

test('the board view model is published on every Workshop repaint, before the mount', () => {
  // All items is the board (request 6708), so there is no pane to guard the
  // build behind any more.
  const src = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _rerenderWorkshop()'));
  const body = src.slice(0, src.indexOf('\n  _fmtCountdown('));
  const call = body.indexOf('AppView._kanbanView()');
  assert.ok(call > 0, '_rerenderWorkshop publishes the board');
  assert.ok(!/if \(group === 'stage'\)|publishWorkshopGroup/.test(body), 'with no pane to ask about');
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
  assert.match(APP_VIEW_SRC, /_overrideWorkshopTab\(tab\) \{/,
    'the retired board ROUTE has a landing');
  const board = dapp.tests.find((t) => /board resolves onto the stage pane/.test(t.name || ''));
  assert.ok(board && /\[data-ws-stage\]/.test(board.expectSelector),
    'and a declared check proves that landing draws the columns');
});

test('a retired Board preference opens on the columns', () => {
  // The other half of retiring the Board VIEW MODE. RETIRED_VIEW_MODES stops a
  // stored 'kanban' naming a mode that no longer exists, but on its own it
  // forgets what the viewer actually chose, which was the COLUMNS. The three
  // board-shaped values therefore open on All items, which is the board.
  for (const mode of ['kanban', 'pm', 'report']) {
    const AppView = makeAppView({ localStorage: { devViewMode: mode } });
    assert.equal(AppView._getViewMode(), 'workshop', `${mode} migrates to the one mode left`);
    assert.equal(AppView._workshopTab(), 'all', `${mode} still opens on the columns`);
  }
  // The Workshop's own predecessors get its own default tab: those viewers
  // never chose columns.
  for (const mode of ['feed', 'list', 'workshop']) {
    const AppView = makeAppView({ localStorage: { devViewMode: mode } });
    assert.equal(AppView._workshopTab(), 'status', `${mode} lands on the lander`);
  }
  // READ-TIME, like every other migration here: nothing is written back.
  const store = { devViewMode: 'kanban' };
  const fresh = makeAppView({ localStorage: store });
  assert.equal(fresh._workshopTab(), 'all');
  assert.deepEqual(Object.keys(store), ['devViewMode'], 'the migration stores nothing');
});

test('reaching the retired Board takes one answer: the All items tab, which is the board', () => {
  // It took two while All items had a second pane, by category (and setting
  // the pane alone once failed 69 declared checks at a go). Request 6708
  // removed that pane, so the tab is the whole answer.
  const at = (o) => makeAppView(o)._workshopTab();
  const loc = (search) => ({
    location: { search, hash: '', href: `http://localhost/${search}` },
  });

  // 1. The route alias, driven exactly as app.js's restoreFromHash drives it.
  const route = makeAppView({ localStorage: {} });
  route._overrideWorkshopTab('all');
  assert.equal(route._workshopTab(), 'all', '#app/<slug>/board');

  // 2. The retired deep link.
  assert.equal(at(loc('?view=kanban')), 'all', '?view=kanban');

  // 3. The stored preference of somebody who last left the Dev screen on it.
  for (const mode of ['kanban', 'pm', 'report']) {
    assert.equal(at({ localStorage: { devViewMode: mode } }), 'all', mode);
  }

  // ...and none of those three may drag anybody else onto the board.
  assert.equal(at({ localStorage: {} }), 'status', 'the lander default');
  assert.equal(at({ localStorage: { devViewMode: 'feed' } }), 'status',
    'the Workshop replaced feed: that viewer never chose columns');

  // The parameter still being offered, and the viewer's own taps, outrank
  // every hop above.
  assert.equal(at(loc('?view=kanban&ws=needs')), 'needs', 'an explicit tab wins');
  assert.equal(at({
    localStorage: { devViewMode: 'kanban', 'devWorkshopTab:demo-app': 'needs' },
  }), 'needs', 'and a choice they have actually made wins over the migration');
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
  assert.match(WORKSHOP, /\{group === 'stage' \? \(\s*<>\s*\{v\.emptyNote \? \([\s\S]*?\) : null\}\s*<div className="dev-ws-board"/, 'the pane the class stands for');

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
  const block = stageRules
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
  assert.match(CSS, /#dev-body:has\(> #dev-workshop\) \{ padding-block: 8px var\(--ws-gap, 8px\); padding-inline: 4px; \}/);
  assert.match(CSS, /\.dev-ws-board \{ padding: 2px 8px 0; \}/);
});

// ── The working pane: the controls, the switch, and what they act on ─────

test('the toolbar renders inside the Workshop pane, above the board', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
  ]);
  const html = workshopHtml(AppView, 'all');
  const pane = html.indexOf('data-ws-pane');
  const head = html.indexOf('dev-ws-pane-head');
  const actions = html.indexOf('id="dev-actions"');
  const board = html.indexOf('data-ws-stage');
  assert.ok(pane > 0, 'the pane renders');
  assert.ok(pane < head && head < actions, 'the sticky head is the pane’s first child, the toolbar in it');
  assert.ok(actions < board, 'above what it acts on');
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
  assert.equal(v.meta.filtered, true);
  const html = workshopHtml(AppView, 'all');
  // THE PANE STAYS. It was once gated on having something to draw, so a
  // search that matched nothing unmounted the whole pane, the toolbar whose
  // host the search field lives in with it. The one control that could undo
  // the search left the screen with the rows.
  assert.ok(html.includes('data-ws-pane'), 'the pane renders');
  assert.ok(html.includes('id="dev-actions"'), 'with its toolbar');
  assert.ok(html.includes('id="dev-kanban-filterbar"'), 'and the host the search box fills');
  assert.ok(html.includes('data-place-bar="all"'), 'and the project\'s place bar above it');
  // The board's columns say why they are empty, UNDER the controls it is
  // about. (The category view had a note of its own for this; the board
  // needs none, and a board with entries is not an empty board.)
  assert.ok(html.indexOf('id="dev-actions"') < html.indexOf('data-ws-stage'), 'the columns are beneath the toolbar');
  assert.match(html.slice(html.indexOf('data-ws-stage')), /No matching cards/);
  assert.ok(!html.includes('data-ws-empty'), 'no empty-board note');
  // Widen the search back out and the rows are back.
  AppView._kanbanFilters = AppView._defaultKanbanFilters();
  const back = workshopHtml(AppView, 'all');
  assert.ok(!back.includes('No matching cards'), 'the columns have their cards again');
  // The declared check runs this state in a browser: the pane opened already
  // narrowed to a search nothing matches, through `?q=` (app-view.js, where
  // the seed is consumed on the first load so it can never hold a cleared
  // search). The columns' words are what prove the search applied: without
  // them the box alone would pass on a pane the URL never narrowed.
  const check = dapp.tests.find((t) => /[?&]q=/.test(t.path || ''));
  assert.ok(check, 'a declared check opens the pane narrowed by ?q=');
  assert.match(check.path, /[?&]ws=all\b/, 'on All items');
  assert.match(check.expectSelector, /\[data-ws-pane\] > \.dev-ws-pane-head #dev-actions #dev-kanban-filterbar #dev-kanban-search$/,
    'and expects the search box, in the pane head');
  assert.equal(check.expectText, 'No matching cards');
  assert.equal(message('changes:board.column.emptyFiltered'), 'No matching cards');
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

  // NEEDS YOU: the whole queue, the votes alone; the unclaimed issues are
  // the count and the offer above, untouched too.
  assert.deepEqual(plain(v.queue.map((r) => r.key)), plain(whole.queue.map((r) => r.key)));
  assert.ok(v.queue.length && v.queue.every((r) => r.kind === 'vote'), 'every vote is still asked about, and nothing else');
  assert.equal(v.dashboard.unclaimed, whole.dashboard.unclaimed);

  // Drawn: the hub and the Workshop tab blame no search; All items'
  // columns say why they are empty.
  const status = workshopHtml(AppView, 'status');
  const workshop = workshopHtml(AppView, 'workshop');
  assert.doesNotMatch(status + workshop, /data-ws-empty/, 'no empty note over either');
  assert.match(workshopHtml(AppView, 'all'), /data-ws-stage=""[\s\S]*?No matching cards/);
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
  // #4417: the Workshop is a row of the places list (the section column, or
  // the tray), drawn apart from the page: the page hands it the dot.
  const { ProjectPlaces } = loadTsx('frontend/src/features/dev-board/workshop/project-places.tsx');
  const list = (filtered) => renderToHtml(createElement(ProjectPlaces, {
    slug: 'x', name: 'X', place: 'status', owed: 0, places: null, filtered, onPlace: () => {},
  }));
  assert.match(list(true), /data-place="workshop"[^>]*>[\s\S]*?<span class="dev-ws-place-label">Workshop<\/span><span class="dev-ws-filter-dot" data-ws-filtered="" aria-hidden="true"><\/span><span class="sr-only"> \(filtered\)<\/span><\/a>/,
    'the dot on the Workshop\'s row, and its words');
  assert.doesNotMatch(list(false), /data-ws-filtered/);
  assert.match(WORKSHOP, /filtered=\{!!v\.meta\.filtered && tab !== 'all'\}/, 'from everywhere but All items');
  for (const over of [{ q: 'dark' }, { assignedToMe: true }, { priority: 'high' }]) {
    AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), ...over };
    assert.doesNotMatch(workshopHtml(AppView, 'all'), /data-ws-filtered/, 'not while All items is up');
  }
  // Cleared, it goes.
  AppView._kanbanFilters = AppView._defaultKanbanFilters();
  assert.doesNotMatch(workshopHtml(AppView, 'status'), /data-ws-filtered/);
  // The accent, a 6px round.
  assert.match(CSS, /\.dev-ws-filter-dot \{ flex: none; width: 6px; height: 6px; border-radius: 999px; background: var\(--accent\); \}/);
});

test('the band in the community\'s colour is the place bar, not the old pill: nothing slides', () => {
  // The hub and the Workshop were two tabs under a segmented control with a
  // sliding marker, then four tabs as a band under the coloured header
  // (#852). #4417 makes the places one list, and the band holds the bar that
  // opens it and names the place you are on; All items is the Workshop's page.
  assert.doesNotMatch(WORKSHOP, /useTabMarker|data-ws-tab-marker|role="tablist" aria-label="Workshop sections"|ProjectBand/);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'frontend/src/features/dev-board/workshop/project-band.tsx')),
    'the four tabs are retired');
  assert.match(WORKSHOP, /<PlaceBar\s+place=\{tab\}/);
  assert.ok(!/dev-ws-pagebar/.test(WORKSHOP),
    'All items has no back bar of its own: its way back is in its pinned head (#4486)');
  const bar = read('frontend/src/features/dev-board/workshop/place-bar.tsx');
  assert.match(bar, /className="dev-ws-tabs dev-ws-band dev-ws-placebar" data-ws-band=""/, 'and so does the bar');
  assert.match(bar, /<div className="dev-ws-tabtrack">/);
});

test('#2915: declared checks open the Workshop page and the hub with a search on', () => {
  const searched = (tab) => dapp.tests.filter((t) => new RegExp(`[?&]ws=${tab}\\b`).test(t.path || '') && /[?&]q=/.test(t.path || ''));
  // 24 Nov 2026: the Workshop's front page; its path stands whole (each stop still counts) under a search.
  const whole = searched('workshop').find((t) => /\[data-ws-front="path"\]/.test(t.expectSelector || ''));
  assert.ok(whole, 'a check opens the Workshop tab narrowed by ?q=');
  assert.match(whole.expectSelector, /\.dev-ws\[data-ws-tab="workshop"\]:not\(:has\(\[data-ws-empty\]\)\)/,
    'and expects no "nothing here" note on it');
  // #4417: and the dot on the Workshop's row in the places list says the
  // search is still on (folded into the same check: the row is lit there).
  assert.match(whole.expectSelector, /\[data-places\] \[data-place="workshop"\]\[aria-current="page"\] \[data-ws-filtered\]/);
  assert.match(whole.expectSelector, /:has\(> \[data-place-bar="workshop"\]\) \[data-ws-front="path"\]:has\(> \.dev-ws-front-head > button\[data-ws-all-open\] \[data-ws-filtered\]\) \[data-ws-front-stop="asked"\]\[data-n\]$/,
    'and its path stands whole, the dot on Open the board saying the search is on');
});

test('#5391: the Overview names no categories; the "Most open work is in" chips and what fed them are gone', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 'look', name: 'Look', items: ['issue:12'] },
    { id: 'auth', name: 'Sign-in', items: ['issue:13'], topic: { key: 'auth', handle: 'sign-in' } },
  ]);
  assert.ok(!('openThemes' in AppView._workshopView().dashboard), 'the view model no longer ranks categories');
  assert.equal(AppView._workshopOpenThemes, undefined);
  assert.equal(AppView.WORKSHOP_OPEN_THEMES_MAX, undefined);
  const html = workshopHtml(AppView, 'workshop');
  assert.ok(!html.includes('data-ws-open-topics') && !html.includes('data-ws-topic-chip'));
  assert.doesNotMatch(WORKSHOP, /OpenTopics|const openTheme = |focusTheme/, 'nor does the Workshop keep a way in for one');
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
  // The hub of an app nobody has started has the start-here banner in its
  // place (15 Oct 2026); one that has shipped keeps its own copy of the note.
  const unstarted = workshopHtml(AppView, 'status');
  assert.match(unstarted, /data-ws-start-here=""/);
  assert.ok(!unstarted.includes('data-ws-empty'), 'the banner says it, so no note');
  AppView._mergedTotal = 2;
  const status = workshopHtml(AppView, 'status');
  assert.match(status, /data-ws-empty=""[^>]*>Nothing on the board yet\. Press /);
  assert.ok(!status.includes('data-ws-pane'), 'and no pane: that is the All items tab');
  // BUG g, the first half: the note told the viewer to press a "+" that was
  // not on screen. On the hub the ⋯ it names is in the hero above it (drawn
  // once the community record has answered, which this render has not).
  assert.match(WORKSHOP, /menu=\{\(place\) => \(\s*<DevPlusMenu[\s\S]*?inHero\b[\s\S]*?\/>\s*\)\}/, 'the ⋯ the note names is the hub hero\'s');
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
  assert.match(ROW, /\{readOnly \? null : \([\s\S]*?data-plus="new-change"[\s\S]*?title=\{t\('project:menu\.build\.title'\)\}/,
    'the ⋯ carries Build it now for every writer');
  assert.equal(require('./lib/platform-i18n').message('project:menu.build.title'), 'Build it now');
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

  // THE HUB of an app nobody has started: #2573's banner leads it with its
  // own New change, and no note follows it (15 Oct 2026): it said the same
  // thing again, and offered to import a PR.
  const status = workshopHtml(fresh, 'status');
  assert.match(status, /data-ws-start-here-btn=""[^>]*>Start a new change</, 'the banner offers Start a new change');
  assert.ok(!status.includes('data-ws-empty'), 'and no note under it');
  assert.doesNotMatch(status, /propose a change/);
  // ...and the Workshop tab beside it has no note of its own about your
  // work: its Your work row opens the Homeroom bot tab, which says it.
  assert.match(workshopHtml(fresh, 'workshop'), /data-ws-desk=""/);
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
    for (const html of [workshopHtml(fresh, 'all'), workshopHtml(finished, 'status')]) {
      assert.match(html, /data-ws-empty=""[^>]*>Nothing on the board yet\.<\/div>/, 'the read-only note');
      assert.doesNotMatch(html, /Homeroom menu/, 'and no door the reader cannot open');
    }
  });
  // Both notes are one component, so the two tabs cannot drift apart, and the
  // banner's condition is written once, for the banner and the note alike.
  // One component, whose sentence is one whole message picked from one table.
  assert.equal((WORKSHOP.match(/<RichMessage id=\{press\} /g) || []).length, 1);
  assert.equal((WORKSHOP.match(/'project:boardEmpty\.press\./g) || []).length, 4, 'where the ⋯ is, and what it holds');
  assert.equal(message('project:boardEmpty.press.hub.plain.full'),
    'Nothing on the board yet. Press <0>⋯</0> to suggest an improvement; to make one yourself, use Build it now there.');
  assert.match(WORKSHOP, /\{startHere \? <StartHereBanner slug=\{slug\} name=\{projectName\} bot=\{!!\(v\.mine && v\.mine\.bot\)\} \/> : null\}/);
  assert.match(WORKSHOP, /\{v\.emptyNote && !building && !startHere \? \(\s*<EmptyNote\s+filtered=\{!!v\.emptyNote\.filtered\}\s+loadFailed=\{v\.emptyNote\.loadFailed\}\s+start=\{emptyStart\}\s+onHub\s*\/>/);
});

test('#6111: an empty board offers the one action that starts the first change', async () => {
  const empty = (over, appOver) => {
    const AppView = makeAppView(appOver);
    seed(AppView);
    AppView._ghIssues = [];
    AppView._proposals = [];
    AppView._merged = [];
    AppView._mergedTotal = 0;
    Object.assign(AppView, over || {});
    return AppView;
  };
  const START = / data-ws-empty-start=""[^>]*>Start a change<\/button>/;
  const START_BOT = / data-ws-empty-start-bot=""[^>]*>Tell Homeroom bot what to change<\/button>/;

  // All items: the note, then one primary action.
  const category = workshopHtml(empty(), 'all');
  assert.match(category, /data-ws-empty=""[^>]*>Nothing on the board yet\. Press /, 'the note is unchanged');
  assert.match(category, START, 'with Start a change under it');
  assert.doesNotMatch(category, / data-ws-empty-start-bot=""/);
  assert.equal(message('project:boardEmpty.start'), 'Start a change');
  assert.equal(message('project:boardEmpty.startBot'), 'Tell Homeroom bot what to change');

  // Where Homeroom bot builds for this viewer, the one action is its chat.
  const botty = empty();
  botty._ghIssuesMeta = { ...botty._ghIssuesMeta, homeroomBot: { typicalMinutes: 8 } };
  const bot = workshopHtml(botty, 'all');
  assert.match(bot, START_BOT, 'the bot door replaces the session');
  assert.doesNotMatch(bot, / data-ws-empty-start=""/, 'never both');

  // The board used to show only a column of "Nothing here yet"s: the note
  // and its action lead the columns.
  const stage = category;
  assert.ok(stage.includes('data-ws-stage'), 'the columns render');
  assert.match(stage, START);
  assert.ok(stage.indexOf('data-ws-empty') < stage.indexOf('data-ws-stage'), 'the note comes before the columns');

  // A board with entries is not empty, and the page says nothing.
  const full = makeAppView();
  seed(full);
  assert.ok(!workshopHtml(full, 'all').includes('data-ws-empty'), 'no note on a board with cards');

  // A search that hides everything is not an empty board.
  const searched = makeAppView();
  seed(searched);
  searched._workshopThemes = themes([{ id: 't1', name: 'Voting', items: ['issue:12'] }]);
  searched._kanbanFilters = { ...searched._defaultKanbanFilters(), q: 'nothing matches this' };
  const filtered = workshopHtml(searched, 'all');
  assert.ok(!filtered.includes('data-ws-empty'), 'the columns say "No matching cards" for themselves');
  assert.match(filtered, /No matching cards/);
  assert.doesNotMatch(filtered, START, 'no start action for a search');

  // Nor is a list that could not load.
  const failed = empty();
  failed._ghIssuesMeta = { ...failed._ghIssuesMeta, note: 'could not load' };
  const unloaded = workshopHtml(failed, 'all');
  assert.match(unloaded, /Couldn&#x27;t load open requests right now\./);
  assert.doesNotMatch(unloaded, START, 'no start action when we cannot tell');

  // A viewer who can only look has nowhere to start.
  withDevActions({ readOnly: true }, () => {
    const html = workshopHtml(empty(), 'all');
    assert.match(html, /data-ws-empty=""[^>]*>Nothing on the board yet\.<\/div>/);
    assert.doesNotMatch(html, START, 'no button for a reader');
  });

  // While Homeroom bot builds the first version the board is empty too, but
  // "start the first change" would be the change already being made. The
  // community read runs in an effect, which static rendering does not run,
  // so this half is pinned at the gate that reads it.
  assert.match(WORKSHOP, /const emptyStart = v\.emptyNote && !v\.emptyNote\.loadFailed && !building/,
    'no start while the bot builds the first version');

  // The hub carries the same note and button once it has shipped, and none
  // while the start-here banner holds its place.
  const finished = empty({ _mergedTotal: 3 });
  const hub = workshopHtml(finished, 'status');
  assert.match(hub, /data-ws-empty=""[^>]*>Nothing on the board yet\. Press /);
  assert.match(hub, START);
  const unstarted = empty();
  const banner = workshopHtml(unstarted, 'status');
  assert.match(banner, /data-ws-start-here=""/);
  assert.ok(!banner.includes('data-ws-empty'), 'the banner says it');
  assert.doesNotMatch(banner, START);
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
    /<div class="dev-ws-hero-row"><div class="dev-ws-hero-actions">[\s\S]*?data-ws-community-invite=""[^>]*>(?:<svg[\s\S]*?<\/svg>)?Invite<\/button><div class="dev-ws-plus ?"><button id="dev-plus-btn"/,
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
  // A function of where it is drawn: the hero, or the project card for
  // somebody who has not joined (the hand-off of 11 Nov 2026), one node either way.
  assert.match(WORKSHOP,
    /menu=\{\(place\) => \(\s*<DevPlusMenu\s+illustrationApp=\{actions\.illustrationApp\}\s+canManageIllustration=\{actions\.canManageIllustration\}\s+selfHosted=\{actions\.selfHosted\}\s+readOnly=\{actions\.readOnly\}\s+canCollaborate=\{actions\.canCollaborate\}\s+showsMembers=\{actions\.showsMembers\}\s+inHero\b[\s\S]*?onWhoDecides=\{community\?\.can_manage[\s\S]*?onLeave=\{canLeave\(community\)[\s\S]*?\/>\s*\)\}/);
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
  // Invite's fill (`pillNeutral`), on the button itself, as a circle.
  assert.match(ACTIONS_ROW, /const HERO_BTN_CLS = 'dev-ws-plus-btn dev-ws-plus-btn-hero un-touch-target '\s*\+ 'bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100';/);
  assert.match(ACTIONS_ROW, /className=\{onCard \? CARD_BTN_CLS : inHero \? HERO_BTN_CLS : 'dev-ws-plus-btn un-touch-target'\}/, 'still a 44px hit box');
  // On the project card it is the card's round glass button, 50px (52px from 768px).
  assert.match(ACTIONS_ROW, /const CARD_BTN_CLS = 'dev-ws-plus-btn dev-ws-plus-btn-card un-touch-target bg-white\/15 hover:bg-white\/25 text-white';/);
  assert.match(decls, /\.dev-ws-plus-btn\.dev-ws-plus-btn-card \{ width: 50px; height: 50px; \}/);
  // Bigger on the hub: 48px with a hairline ring, a control of its own.
  assert.match(decls, /\.dev-ws-hero \.dev-ws-plus-btn \{ width: 48px; height: 48px; box-shadow: inset 0 0 0 1px var\(--app-sheet-line\); \}/);
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
  assert.match(ACTIONS_ROW, /id="dev-plus-menu"\s+className="hidden absolute end-0 top-full mt-2 z-30 w-64 /);
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

test('the pane head leads with the page\'s bar, and the ear and the grouping strip are gone (#852, request 6708)', () => {
  // The strip was one node in two places (the head, and an "ear" off the
  // pane's corner), then the head's first row, and is now not drawn: All
  // items has one view.
  assert.doesNotMatch(WORKSHOP, /GroupStrip|data-ws-group|dev-ws-group/);
  const headAt = WORKSHOP.indexOf('className="dev-ws-pane-head"');
  const barAt = WORKSHOP.indexOf('className="dev-ws-allbar"');
  const actionsAt = WORKSHOP.indexOf('<DevActionsRow', barAt);
  assert.ok(headAt > 0 && barAt > headAt && actionsAt > barAt, 'the bar is the head\'s first child, the tools in it');
  for (const gone of [/EAR_QUERY/, /useEarInset/, /EAR_PROPS/, /data-ws-ear/, /className="dev-ws-ear"/, /--dev-ws-ear-left/, /--dev-ws-group-w/]) {
    assert.doesNotMatch(WORKSHOP, gone, `${gone} is gone with the ear`);
  }
  assert.doesNotMatch(CSS, /dev-ws-ear|--dev-ws-ear-left|--dev-ws-group-w/, 'and app.css styles none of it');
  // #5820: in the wide layout a filter chip's word is real text again, and
  // the count moves into it. Two classes on the override, because Tailwind's
  // `.sr-only` loads after app.css and one class would lose.
  assert.match(CSS, /@media \(min-width: 700px\) \{[\s\S]*?\.sr-only\.dev-chip-word \{\s*position: static; width: auto; height: auto; margin: 0; padding: 0;\s*overflow: visible; clip: auto; white-space: nowrap;\s*\}[\s\S]*?\.dev-chip-count \{ display: none; \}/);
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
  const check = dapp.tests.find((t) => /[?&]ws=all&group=category/.test(t.path || '')
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
  assert.match(WORKSHOP, /const \[tab, setTab\] = useState<TabKey>\(\(\) => freshTab\(v\.slug\) \|\| v\.tab \|\| 'status'\);/,
    'the seed still paints the right tab on the first frame when the view is already there');
  assert.match(
    WORKSHOP,
    /const deepTabApplied = useRef<boolean>\(!!v\.tab \|\| !!freshTab\(v\.slug\)\);\s*useEffect\(\(\) => \{\s*if \(deepTabApplied\.current \|\| !v\.tab\) return;\s*deepTabApplied\.current = true;\s*setTab\(v\.tab\);\s*\}, \[v\.tab\]\);/,
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
  // #4417: the places tray follows it, which renders nothing in place: it is
  // portalled to the body while it is open (./places-tray.tsx).
  assert.match(WORKSHOP, /\{band\}\n\s*\{tray\}\n\s*\{\/\* Everything but the bar lives in here\./, 'the band renders where it is written');
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
  assert.match(WORKSHOP, /onAll=\{\(\) => openTab\('workshop'\)\}/);
  assert.match(WORKSHOP, /onBack=\{\(\) => openTab\(pageParent\(tab\)\)\}/);
  // Every tab turns the page, Homeroom's Discussion (#general) included (#3494).
  assert.match(WORKSHOP, /const openTab = \(next: TabKey\) => \{\s*setTab\(next\);\s*callAppView\('_setWorkshopTab', next, v\.slug\);/);
  const setTab = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _setWorkshopTab(key, slug) {'));
  const setTabBody = setTab.slice(0, setTab.indexOf('\n  },'));
  assert.match(setTabBody, /localStorage\.setItem\(store, next\)/);
  assert.ok(!/_rewirePlusMenu|_repaintDevBody|_rerenderWorkshop/.test(setTabBody),
    'the tab is persisted, not repainted');
  // And a deep-linked or remembered `ws=all` reaches a cold Workshop through
  // the late-arrival effect on `v.tab`: a state update raised inside a
  // passive effect is scheduled at default priority, so the pane lands a task
  // AFTER the synchronous publish the module's call follows.
  assert.match(WORKSHOP, /useState<TabKey>\(\(\) => freshTab\(v\.slug\) \|\| v\.tab \|\| 'status'\)/);
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
  // A topic's channel is the other fitted tab (#852 review): its pane rests
  // its composer on the foot of the reading area the same way. The
  // Discussion is posts now (26 Nov 2026), a page that grows like the Hub.
  assert.match(CSS, /#dev-workshop > \.dev-ws\[data-ws-tab="needs"\],\s*#dev-workshop > \.dev-ws\[data-ws-tab\^="c:"\] \{ min-height: 0; \}/);
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
  // `.dc-card`, the dev session composer's card (retired with the dev chat),
  // shipped `0.875rem 1rem 0.625rem` — 14 over, 10 under — which was right
  // for a tall field with controls beneath it. Here, at rest, the card holds
  // ONE line, and 14 against 10 put that line 2px below the middle of its
  // own box. That is what "the ask box sits slightly low" was. Measured at
  // 402x874: a 58px card with a 34px line starting at 14.
  assert.match(CSS, /\.dev-ws-ask-composer \{[^}]*padding: 12px 14px;/);
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
  // 24 Nov 2026: the standard look's front page says what is new beside Lately's All of this week.
  const visit = dapp.tests.find((t) => /shot=since-visit/.test(t.path || ''));
  assert.match(visit.expectSelector, /\[data-ws-front="lately"\]:has\(> \.dev-ws-front-head > \[data-ws-front-fresh\] \+ button\[data-ws-week="thisWeek"\]\[data-ws-week-all\]\)/);
  assert.match(visit.expectSelector, /> \.dev-ws-front-list > \.dev-ws-front-row > a\.dev-ws-front-row-link\[href\*="\/dev\/"\]$/);
  assert.ok(!/:has\([^)]*:has\(/.test(visit.expectSelector), 'no :has() nested in a :has()');
  assert.equal(visit.expectText, 'new since you were last here');
  const week = dapp.tests.find((t) => /shot=week-page/.test(t.path || ''));
  assert.match(week.expectSelector, /\.dev-ws-weekpage\[data-ws-week-page="thisWeek"\] > \[data-ws-pagehead\]/);
  // On the front page it is Lately's All of this week, ahead of the bars, and nothing before Lately is a week button.
  const front = read('frontend/src/features/dev-board/workshop/front-page.tsx');
  const lately = front.slice(front.indexOf('function Lately('));
  assert.ok(lately.indexOf('data-ws-week-all=""') > 0 && lately.indexOf('data-ws-week-all=""') < lately.indexOf('className="dev-ws-front-bar"'));
  assert.ok(!front.slice(0, front.indexOf('function Lately(')).includes('data-ws-week='));
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
  // Not the fitted tabs, Needs you and a topic's channel (#852 review); the
  // Discussion grows now, as posts (26 Nov 2026).
  const rule = /#dev-body:has\(> #dev-workshop > \.dev-ws:not\(\[data-ws-tab="needs"\]\):not\(\[data-ws-tab\^="c:"\]\)\),\s*#dev-workshop:has\(> \.dev-ws:not\(\[data-ws-tab="needs"\]\):not\(\[data-ws-tab\^="c:"\]\)\) \{ flex-shrink: 0; \}/;
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
  assert.match(wide[1], /\.dev-ws-sheet-talk \{\s*position: relative; inset: auto; flex: 0 1 380px;/,
    'Comments and Ask are one panel');
  assert.match(wide[1], /\.dev-ws-talk-head \{\s*display: flex;/, 'with the card\'s caption at its top');
  assert.match(CSS, /\n\.dev-ws-talk-head \{ display: none; \}/, 'which a phone\'s sheet leaves out');
  assert.match(wide[1], /\.dev-ws-sheet-vote \{ position: absolute;/, 'and the vote is a popover on its button');
  assert.ok(!/\.dev-ws-needs > \.dev-ws-ask/.test(CSS), 'nothing pins an ask box to the floor');
  // Both now measure 10px above the bar — `.dev-ws`'s own column gap, which is
  // the floor for anything sitting directly above the rail.
});



test('the project page opens on the page you last used', () => {
  // The hub and its pages are different jobs, and the one you want is usually
  // the one you wanted last time — somebody working the vote queue landed on
  // the digest every single visit. Stored per browser: it is a reading
  // position, not a setting, and it reuses the mechanism the grouping has.
  assert.match(APP_VIEW_SRC, /WORKSHOP_TAB_KEY: 'devWorkshopTab',/);
  // Per project (phone review #43): `devWorkshopTab:<slug>`, so one project's
  // last place never opens another's page.
  assert.match(APP_VIEW_SRC, /_workshopTabStoreKey\(slug\) \{\s*const at = slug \|\| \(typeof App !== 'undefined' && App && App\.currentApp\) \|\| '';\s*return at \? `\$\{AppView\.WORKSHOP_TAB_KEY\}:\$\{at\}` : null;/);
  const read = /_workshopTab\(slug\) \{([\s\S]*?)\n  \},/.exec(APP_VIEW_SRC);
  assert.ok(read, '_workshopTab resolves it');
  // ORDER MATTERS: the deep link wins, then what you chose, then the default.
  // A declared check runs against an empty localStorage, so `?ws=` losing to
  // a stored value would make every one of them assert the wrong tab.
  assert.match(read[1], /const url = AppView\._workshopTabParam\(\);\s*if \(url\) return url;/);
  assert.match(read[1], /const key = AppView\._workshopTabStoreKey\(slug\);\s*const stored = key \? window\.localStorage\.getItem\(key\) : null;/);
  assert.match(read[1], /return 'status';/);
  // And an explicit tap retires the URL override, exactly as the grouping
  // does — otherwise `?ws=` would keep winning over every later press.
  const write = /_setWorkshopTab\(key, slug\) \{([\s\S]*?)\n  \},/.exec(APP_VIEW_SRC);
  assert.ok(write, '_setWorkshopTab stores it');
  assert.match(write[1], /AppView\._workshopTabUrlOverride = null;/);
  assert.match(write[1], /const store = AppView\._workshopTabStoreKey\(slug\);\s*if \(!store\) return;\s*try \{ window\.localStorage\.setItem\(store, next\); \} catch \{\}/);
  // The view model publishes the RESOLVED tab, not the raw parameter.
  assert.match(APP_VIEW_SRC, /tab: AppView\._workshopTab\(\),/);
  assert.match(WORKSHOP, /onNeeds=\{\(\) => openTab\('needs'\)\}/);
  assert.match(WORKSHOP, /onBack=\{\(\) => openTab\(pageParent\(tab\)\)\}/);
  // Every tab turns the page, Homeroom's Discussion (#general) included (#3494).
  assert.match(WORKSHOP, /const openTab = \(next: TabKey\) => \{\s*setTab\(next\);\s*callAppView\('_setWorkshopTab', next, v\.slug\);/);
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

  // The markup half: the track exists and is inert on a phone. #4417: it is
  // the place bar's now (the four tabs are retired), and its row is the bar's.
  assert.match(read('frontend/src/features/dev-board/workshop/place-bar.tsx'), /<div className="dev-ws-tabtrack">/);
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
  assert.match(APP_VIEW_SRC, /key: 'inreview', title: PlatformI18n\.t\('changes:board\.column\.review'\)/);
  assert.equal(message('changes:board.column.review'), 'Waiting for approval');
  assert.match(APP_VIEW_SRC, /rows: cardRows\(\s*kInReview,\s*\(x\) => \(x\.kind === 'proposal'/);
});

// ── #2176: the tiles count calendar weeks ────────────────────────────

// ── #2182: the viewer's strip stays on screen when it is empty ───────

test('10 Nov 2026: somebody who has made nothing here is asked who should build, in Your work\'s place', () => {
  const FIRST = 'frontend/src/features/dev-board/workshop/first-change.tsx';
  const first = loadTsx(FIRST, { stubs: { '../../messages/api': { listConnectors: () => new Promise(() => {}) } } });
  const desk = (over = {}) => ({ ready: true, needs: 0, progress: 0, waiting: 0, first: null, ...over });
  const none = { rows: [], next: null };
  assert.equal(first.firstChangeFor(desk(), none), true, 'nothing of theirs now, and nothing before');
  assert.equal(first.firstChangeFor(desk(), { rows: [{ kind: 'vote' }, { kind: 'vote' }], next: null }), true, 'a vote is taking part, not making');
  assert.equal(first.firstChangeFor(desk(), { rows: [{ kind: 'request' }], next: null }), false, 'a request of theirs, once');
  assert.equal(first.firstChangeFor(desk(), { rows: [{ kind: 'change' }], next: null }), false);
  assert.equal(first.firstChangeFor(desk(), { rows: [{ kind: 'solo' }], next: null }), false, 'a private thread about the project counts');
  assert.equal(first.firstChangeFor(desk(), { rows: [{ kind: 'vote' }], next: '2026-10-01T00:00:00.000Z' }), false, 'more History than was read: not called empty');
  assert.equal(first.firstChangeFor(desk({ progress: 1 }), none), false, 'something of theirs is being built');
  assert.equal(first.firstChangeFor(desk({ waiting: 1 }), none), false);
  assert.equal(first.firstChangeFor(desk({ needs: 1 }), none), false, 'something asks for them: Your work says what');
  assert.equal(first.firstChangeFor(desk({ ready: false }), none), false, 'the desk unread');
  assert.equal(first.firstChangeFor(desk(), null), false, 'History unread, or its read failed: Your work is the safe answer');

  const html = renderToHtml(createElement(first.FirstChangeCard, { slug: 'demo-app', onClose() {} }));
  assert.match(html, /<section class="dev-ws-strip dev-ws-first" data-ws-first-change="">/, 'a card of the Workshop\'s own');
  assert.match(html, new RegExp(`<span class="dev-ws-head-title">${message('project:workshop.first.title')}</span>`));
  assert.match(html, /data-ws-card-close="first"/, 'closed for good, like the hub\'s cards');
  const rows = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*data-ws-first-builder="([^"]+)"/g)].map((m) => [m[2], m[1].replace(/&amp;/g, '&')]);
  assert.deepEqual(rows, [
    ['homeroom', '#homeroom-bot/new?project=demo-app'],
    ['claude-code', '#homeroom-bot/new?project=demo-app&with=claude-code'],
    ['chatgpt', '#homeroom-bot/new?project=demo-app&with=chatgpt'],
  ], 'three links, each to a new thread set to this project and that builder');
  assert.doesNotMatch(html, /data-ws-first-setup/, 'no Set up until the connections are read');
  for (const id of ['project:workshop.first.text', 'project:workshop.first.homeroom.sub']) {
    assert.ok(html.includes(message(id)), id);
  }
  assert.ok(html.includes(message('project:workshop.first.own', { product: 'Claude' })));
  assert.ok(html.includes(message('project:workshop.first.own', { product: 'ChatGPT' })));

  const src = read(FIRST);
  assert.match(src, /const empty = desk\.ready && desk\.needs \+ desk\.progress \+ desk\.waiting === 0;/);
  assert.match(src, /if \(!slug \|\| !empty \|\| closed \|\| readOnly\) return undefined;/, 'History is asked only when the desk is empty, the card open, and a change theirs to start');
  assert.match(src, /fetch\(`\/api\/ai\/history\?project=\$\{encodeURIComponent\(slug\)\}`, \{ credentials: 'same-origin' \}\)/);
  // A staging preview's ?demo=1 lists sample projects, never the one on
  // screen, so they cannot say somebody made nothing here: Your work stays,
  // as two declared checks of the demo's Workshop expect (dapp.json).
  assert.match(src, /new URLSearchParams\(window\.location\.search\)\.get\('demo'\) === '1'\) return Promise\.resolve\(null\);\n\s+const read = fetch\(/, 'asked before anything is read');
  const DAPP_CHECKS = JSON.parse(read('dapp.json')).tests;
  // 24 Nov 2026: on the standard look's front page, which draws no first-change card (its hero does that card's job).
  assert.ok(DAPP_CHECKS.some((check) => /\?demo=1&ws=workshop#app\//.test(check.path) && /\[data-ws-front="hero"\] > \[data-ws-desk\]/.test(check.expectSelector || '')),
    'the demo Workshop\'s Your work has a declared check');
  assert.doesNotMatch(read('frontend/src/features/dev-board/workshop/front-page.tsx'), /FirstChangeCard|useFirstChange/, 'the front page draws no first-change card');
  assert.match(src, /return \{ show: !closed && !readOnly && !settledLate && firstChangeFor\(desk, read\), close, decided, likely: empty \};/);
  assert.match(read('frontend/src/features/dev-board/workshop/your-work.tsx'),
    /const first = useFirstChange\(slug, desk\);\n\s+if \(first\.show\) return <FirstChangeCard slug=\{slug\} onClose=\{first\.close\} solo=\{solo\} live=\{live\} \/>;/);

  // Phone review #123: which card it is, is decided before either is drawn.
  // Until then its place is held, empty and inert, at the likelier card's
  // height, so nothing is swapped under a finger.
  const decided = (d, read, closed = false, readOnly = false) => first.firstChangeDecided(d, read, closed, readOnly);
  assert.equal(decided(desk({ ready: false }), false), false, 'the desk unread: not yet');
  assert.equal(decided({ ...desk({ ready: false }), settled: true }, false), true, 'a desk read that failed is an answer: Your work');
  assert.equal(decided(desk({ needs: 2 }), false), true, 'work of theirs here: Your work, without asking History');
  assert.equal(decided(desk(), false), false, 'nothing here now: History is still to answer');
  assert.equal(decided(desk(), true), true);
  assert.equal(decided(desk({ ready: false }), false, true), true, 'closed for good: Your work');
  const card = read('frontend/src/features/dev-board/workshop/your-work.tsx');
  assert.match(card, /if \(!first\.decided\) \{\n\s+return \(\n\s+<div className="invisible" data-ws-desk-held="" aria-hidden="true" inert>\n\s+\{first\.likely \? <FirstChangeCard [^\n]+ : <DeskRows slug=\{slug\} name=\{name\} \/>\}/);
  assert.match(src, /const HOLD_MS = 4000;/, 'and never held for ever');
  // Phone review #130: its words fit the project.
  const solo = renderToHtml(createElement(first.FirstChangeCard, { slug: 'demo-app', onClose() {}, solo: true, live: true }));
  assert.ok(solo.includes(message('project:workshop.first.textSolo')), 'a Just you project: you approve what it makes');
  assert.ok(!solo.includes(message('project:workshop.first.text')), 'not "to the group for a vote"');
  assert.match(solo, new RegExp(`<span class="dev-ws-head-title">${message('project:workshop.first.titleLive')}</span>`), 'and not "first" once changes are live');
  assert.equal(message('project:workshop.first.titleLive'), 'Make a change here');
  assert.equal(message('project:workshop.first.textSolo'), 'Pick who does the building. You approve what it makes.');
  assert.match(read('frontend/src/features/dev-board/workshop/hub-dismissed.ts'), /export type HubCard = 'start' \| 'first' \| `update:\$\{string\}`;/);
  assert.match(read('src/routes/ai-work.js'), /router\.get\('\/api\/ai\/history', async \(req, res\) => \{/);
});

test('#2182: a guest has no Your work to be told about', () => {
  const AppView = makeAppView({ App: { user: null, currentApp: 'demo-app', currentSubTab: 'forum' } });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const v = AppView._workshopView();
  assert.equal(v.mine.viewer, false);
  assert.ok(!workshopHtml(AppView).includes('data-ws-desk='), 'no row for a reader with no work to have');
});

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

test('a propose-to-close you opened yourself is owed a vote from you too', () => {
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
  // 11 Nov 2026: opening a decision is not your yes (governance-rules.ts),
  // so a propose-to-close you opened is owed your vote like anyone's, as is
  // your own code proposal: "waiting on you" asks whether you have voted,
  // not whose it is.
  assert.ok(plain(v.votes.rows).some((r) => r.key.includes('gov:71')),
    'your own governance proposal is owed a vote from you');
  assert.ok(plain(v.votes.rows).some((r) => r.key.includes('gov:72')),
    'and somebody else’s still is');
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
  assert.match(WORKSHOP, /<PlaceBar\s[\s\S]{0,400}?\n\s*barRef=\{setBar\}\n/, 'the place bar is the bar, All items too');
  assert.equal((WORKSHOP.match(/\{setBar\}/g) || []).length, 1, 'and nothing else is the bar');

  // 2. NO BACK BAR OF ITS OWN (#4486). The way back and the page's name are
  //    the first things in the head's one row, which pins under the tabs, so
  //    there is no second `.dev-ws-tabs` box to scroll away under them, and
  //    no rule for one.
  assert.ok(!/data-ws-pagebar|dev-ws-pagebar/.test(WORKSHOP), 'no back bar');
  assert.ok(!/dev-ws-pagebar/.test(decls), 'and no rule styles one');

  // 3. UNDER 768px THE HEAD RESTS ON THE BAND'S FOOT. The band is its 18px
  //    tuck now (#4703: the row it held lives in the header), so the measured
  //    offset's column gap would show the cards; a phone's head rests the
  //    same way (18px).
  assert.match(decls, /@media \(max-width: 767\.98px\) \{\s*#dev-workshop \.dev-ws-pane-head \{ top: calc\(var\(--ws-pin-top, 0px\) - 15px \+ 18px\); \}\s*\}/);
  assert.ok(decls.indexOf('- 15px + 18px') > decls.indexOf('#dev-workshop .dev-ws-pane-head {'),
    'after the measured offset it overrides, which has the same specificity');

  // 4. ONE COLOUR. The head keeps the pane's while pinned, and the band
  //    behind the tabs matches it (asserted with the band's other rules).
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ''), /\[data-ws-pinned\] \.dev-ws-pane-head \{[^}]*background/,
    'the pinned head is not repainted');
  assert.match(CSS, /\n\.dev-ws-pane-head, \.dev-ws-pane-body \{ background-color: var\(--dc-sheet-solid\); \}/);

  // 5. SQUARE ON TOP, both corners, at every width (outside the wide block),
  //    once the head has left the top of its pane.
  assert.match(CSS, /\n\.dev-ws\[data-ws-head-pinned\] \.dev-ws-pane-head \{ border-start-start-radius: 0; border-start-end-radius: 0; \}/);
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
  // The arc beside "Checks running…" and the ring on a vote that is open (a
  // third, the pulse on an issue whose proposal the headless run was
  // drafting, went with that run). They run for as long as the state lasts,
  // a vote for days, and a board carries dozens (71
  // on this repository's own with every card open, 68 of them scrolled out of
  // view). The header's cog already rests under this setting; these did not.
  //
  // It is also what lets a browser that draws without a GPU, like the one the
  // declared checks run in, ask for a still page: there, one running
  // animation of any size costs about a fifth of a core per open window.
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(rules, /\.dc-status-spinner-arc \{[^}]*animation: dc-spin 0\.8s linear infinite;[^}]*\}\s*@media \(prefers-reduced-motion: reduce\) \{\s*\.dc-status-spinner-arc \{ animation: none; \}\s*\}/);
  assert.match(rules, /\.gc-vote-count-dot-ping \{[^}]*animation: ping 1s[^}]*\}\s*@media \(prefers-reduced-motion: reduce\) \{\s*\.gc-vote-count-dot-ping \{ animation: none; \}\s*\}/);
  assert.doesNotMatch(read('frontend/src/features/dev-board/card/dev-card.tsx'), /animate-pulse/,
    'and no card icon pulses any more');
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


// #4568: a no vote ("Voted no", "Not approved") reads in the blocked red,
// not the ok green. The answer itself picks the tone, on the card's facts
// line and the comments panel's head (factsFor, whose fact the existing
// factTone map takes to the red class), on the
// confirmation line the eyebrow becomes, and on the rail's vote button —
// each marked with data-ws-voted so app.css can paint the no case without
// a second class. A yes keeps every class and colour it had.

test('a run that does not know its total yet still shows its bar: "Checks" on the row and the card, pulsing until the count arrives (#4628)', () => {
  const AppView = makeAppView();
  seed(AppView);
  const item = { id: 77, pr_number: 4577, status: 'promoted', check_state: 'pending', created_at: at(1), linked_issues: [] };
  const running = AppView.statusTagSpecs(item).find((s) => s.data && s.data['data-status-tag'] === 'checks-running');
  assert.ok(running, 'the card’s status tag exists');
  assert.equal(running.label, 'Checks', 'one word for the whole run');
  assert.ok(running.progress && running.progress.indeterminate, 'the bar pulses before the total is known');
  const tag = AppView._workshopBrief('proposal', item, null).tags.find((t) => t.label === 'Checks');
  assert.ok(tag, 'the row carries the tag');
  assert.ok(tag.progress && tag.progress.indeterminate, 'the same indeterminate progress');
  assert.match(tag.title, /^Checks starting/, 'the full words are the tooltip and what a screen reader reads');
  // The row draws the busy bar itself, not just the model.
  const { WorkRow } = loadTsx('frontend/src/features/dev-board/workshop/work-row.tsx');
  const v = AppView._workshopView();
  const row = [...v.votes.rows, ...(v.since ? v.since.rows : [])].find((r) => r.t === 'card' && r.card.attrs['data-proposal-row']);
  assert.ok(row, 'a proposal row');
  const brief = { kind: 'change', noun: 'Change', n: 4577, by: 'bob', mine: false, category: '', replies: 0, linked: [], closed: [], stage: 'run', at: 0,
    tags: [{ label: 'Checks', tone: 'run', title: tag.title, progress: tag.progress }] };
  const html = renderToHtml(createElement(WorkRow, { row: { ...row, brief }, slug: 'demo-app' }));
  assert.match(html, /<span data-state-tag="working" class="one-tag one-tag-plain one-tag-working dev-ws-tag" title="Checks starting\.[^"]*"><span class="dc-status-spinner-arc" aria-hidden="true"><\/span>Checks<span class="checks-chip-bar checks-chip-bar-busy" role="progressbar" aria-valuemin="0" aria-label="Checks starting"><\/span><\/span>/);
});

// #6145 (2 Nov 2026): a row's side panel is portalled to <body>, so it stayed
// over the Homeroom bot tab after the project page was left. app.js now
// publishes the project page's visibility to the store, and the Workshop
// clears its panel's item when that goes false.
test('#6145: the side panel\'s item is cleared when the project page is hidden', () => {
  const classes = new Map();
  const sandbox = {
    console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { hash: '', search: '', pathname: '/', origin: 'https://example.test' },
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      getElementById: (id) => ({ classList: { toggle(name, on) { classes.set(id, on ? name : ''); } } }),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/app.js'), sandbox);
  const { App } = sandbox;
  assert.ok(!App.REACT_SCREEN_IDS.includes('app-view'), 'no island owns the project page\'s class');
  App._setScreenVisible('app-view', true);
  assert.equal(sandbox.__usernodeVisibility.visible['app-view'], true);
  assert.equal(classes.get('app-view'), '', 'app.js still writes its class');
  App._setScreenVisible('app-view', false);
  assert.equal(sandbox.__usernodeVisibility.visible['app-view'], false, 'published when the page is left');
  assert.equal(classes.get('app-view'), 'hidden');
  App._setScreenVisible('settings-screen', true);
  assert.equal(sandbox.__usernodeVisibility.visible['settings-screen'], undefined, 'another unconverted screen keeps the class alone');

  // React reads the same store: the value the Workshop's useVisibility sees.
  const store = loadTsx('frontend/src/lib/visibility-store.ts');
  const before = store.readVisibility('app-view');
  try {
    store.publishVisibility('app-view', false);
    assert.equal(store.readVisibility('app-view'), false);
  } finally {
    store.getVisibilityStore().visible['app-view'] = before;
  }

  // The Workshop clears the panel's item when the page is hidden; with no
  // item, no panel is drawn, so back to the Workshop shows none open.
  const workshop = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(workshop, /import \{ useVisibility \} from '\.\.\/\.\.\/\.\.\/lib\/visibility-store';/);
  assert.match(workshop, /const pageShown = useVisibility\('app-view', true\);\n\s+useEffect\(\(\) => \{\n\s+if \(!pageShown\) setSideItem\(null\);\n\s+\}, \[pageShown\]\);/);
  assert.match(workshop, /\{sideOpen && sideItem \? <TopicSidePanel item=\{sideItem\} onClose=\{closeSide\} \/> : null\}/);
  assert.match(workshop, /const sideOpen = !!sideItem && /);
});

test('#6075: a live row keeps its final counted vote beside ✓ Live', () => {
  const AppView = makeAppView();
  seed(AppView);
  const { WorkRow } = loadTsx('frontend/src/features/dev-board/workshop/work-row.tsx');
  const render = (over) => {
    const item = {
      id: 78, pr_number: 40, pr_title: 'Landed thing', status: 'merged', username: 'alice',
      created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr', ...over,
    };
    const card = AppView._mergedRowModel(item);
    return renderToHtml(createElement(WorkRow, {
      row: { t: 'card', key: card.key, card, brief: AppView._workshopBrief('merged', item, card) },
      slug: 'demo-app', variant: 'board',
    }));
  };

  // The yes votes counted against the threshold snapshotted at merge time,
  // then the no votes.
  const withNo = render({ yes_count: 3, no_count: 1, votes_required: 3 });
  assert.match(withNo, /<span class="dev-ws-wrow-tally" title="3 yes and 1 no\. It needed 3 yes to pass\.">3 yes · 1 no<\/span>/);

  // A change nobody voted against names no votes.
  const yesOnly = render({ yes_count: 2, no_count: 0, votes_required: 2 });
  assert.match(yesOnly, /<span class="dev-ws-wrow-tally"[^>]*>2 yes<\/span>/,
    'no votes are named only when there were some');
  // V05: more yes than it needed is the count alone, never "2/1 yes"; one
  // that went live short of its threshold keeps the pair.
  const over = render({ yes_count: 2, no_count: 0, votes_required: 1 });
  assert.match(over, /<span class="dev-ws-wrow-tally" title="2 yes and 0 no\. It needed 1 yes to pass\.">2 yes<\/span>/);
  const short = render({ yes_count: 1, no_count: 0, votes_required: 2 });
  assert.match(short, /<span class="dev-ws-wrow-tally"[^>]*>1\/2 yes<\/span>/);

  // An imported PR has no counted votes: no tally, never "0/1".
  const imported = render({ yes_count: 0, no_count: 0, votes_required: 3 });
  assert.ok(!imported.includes('dev-ws-wrow-tally'));

  // Only once the pill says Live: still going live draws no tally.
  const deploying = render({ yes_count: 3, no_count: 1, votes_required: 3, deployment_state: 'deploying' });
  assert.match(deploying, />Going live…<\/span>/);
  assert.ok(!deploying.includes('dev-ws-wrow-tally'));
});

test('a link to the list of requests or changes opens All items by stage, not the Hub (audit N03)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public/js/app.js'), 'utf8');
  const at = src.indexOf("// dev, dev/issues, dev/proposals — all land on the plain");
  assert.ok(at > 0);
  const block = src.slice(at, at + 1200);
  assert.match(block, /subTab = 'forum';/);
  assert.match(block, /sec === 'proposals' \|\| sec === 'issues' \|\| sec === 'changes'/);
  assert.match(block, /AppView\._overrideWorkshopTab\('all'\);\n/, 'as the retired Board route does');
  assert.doesNotMatch(src, /_overrideWorkshopGroup/, 'the tab is the whole answer: All items is the board');
  const view = makeAppView({ localStorage: { devWorkshopTab: 'status' } });
  view._overrideWorkshopTab('all');
  assert.equal(view._workshopTab(), 'all', 'over a remembered Hub');
});

test('a bare link to a project\'s /workshop opens the Workshop; a door, a switch, history and ?ws= keep theirs (audit N03 follow-up)', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
  const at = appSrc.indexOf('  _linkOpensWorkshop(slug) {');
  assert.ok(at > 0);
  const body = appSrc.slice(at + '  _linkOpensWorkshop(slug) {'.length, appSrc.indexOf('\n  },', at));
  // The router calls it on the /workshop alias, before turning it into the page.
  assert.match(appSrc, /if \(tab === 'workshop'\) App\._linkOpensWorkshop\(slug\);/);
  const arrive = (AppView, location, slug = 'garden') => {
    // eslint-disable-next-line no-new-func
    const fn = new Function('AppView', 'location', 'URLSearchParams', 'App', `return (function (slug) {${body}\n})`);
    return fn(AppView, location, URLSearchParams, {})(slug);
  };
  const loc = (search = '', hash = '#app/garden/workshop') => ({ search, hash, href: `http://localhost/${search}${hash}` });
  // 1. A link, with the Hub remembered: the Workshop, remembered from now on.
  const linked = makeAppView({ localStorage: { 'devWorkshopTab:garden': 'status' } });
  assert.equal(arrive(linked, loc()), true);
  assert.equal(linked._workshopTab('garden'), 'workshop');
  // 2. A door: _landOnHub decides first, and the router takes it.
  const door = makeAppView({ localStorage: { 'devWorkshopTab:garden': 'workshop' } });
  door._landOnHub('garden');
  assert.equal(arrive(door, loc()), false);
  assert.equal(door._workshopTab('garden'), 'status');
  assert.equal(door._takePlaceDecision('garden'), false, 'spent on the arrival it was made for');
  // …for its own project only.
  const other = makeAppView({ localStorage: {} });
  other._landOnTab('elsewhere', 'needs');
  assert.equal(arrive(other, loc()), true);
  assert.equal(other._workshopTab('garden'), 'workshop');
  // …and not long after: a decision a page turned in place is not a later link's.
  const stale = makeAppView({ localStorage: {} });
  stale._landOnTab('garden', 'needs');
  stale._placeDecided.at -= stale.PLACE_DECISION_TTL_MS + 1;
  assert.equal(arrive(stale, loc()), true);
  // 3. ?ws= names its place outright.
  const named = makeAppView({ localStorage: {} });
  assert.equal(arrive(named, loc('?ws=needs')), false);
  // 4. Back, Forward or a reload: the entry names its place.
  const traversed = makeAppView({ localStorage: { 'devWorkshopTab:garden': 'status' } });
  traversed._historyWorkshopTab = () => ({ slug: 'garden', tab: 'status' });
  assert.equal(arrive(traversed, loc()), false);
  assert.equal(traversed._workshopTab('garden'), 'status');
  // 5. The Communities tab reopening the page you left keeps its place.
  assert.match(appSrc, /AppView\?\._notePlaceDecided\?\.\(view\.slug\);\s*\} catch[^\n]*\n\s*try \{\s*history\.pushState\(null, '', `\$\{view\.path\}/);
});

test('the Hub has its own address, #app/<slug>/dev/hub, for links that mean the front door (N03 follow-up)', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
  const at = appSrc.indexOf('  _placeAddress(parts) {');
  const body = appSrc.slice(at + '  _placeAddress(parts) {'.length, appSrc.indexOf('\n  },', at));
  const view = makeAppView({ localStorage: { 'devWorkshopTab:garden': 'workshop' } });
  // eslint-disable-next-line no-new-func
  const placeAddress = new Function('AppView', `return (function (parts) {${body}\n})`)(view);
  const parts = ['app', 'garden', 'dev', 'hub'];
  assert.equal(placeAddress(parts), true);
  assert.deepEqual(parts, ['app', 'garden', 'workshop'], 'rewritten to the page\'s own address');
  assert.equal(view._workshopTab('garden'), 'status', 'on its Hub');
  assert.equal(view._takePlaceDecision('garden'), true, 'a decision the /workshop link rule then honours');
  // With no project, Home: the communities are Home's (One Home, #6361).
  assert.match(appSrc, /_hubHref\(slug\) \{\s*(?:\/\/[^\n]*\n\s*)*return slug \? `#app\/\$\{encodeURIComponent\(slug\)\}\/dev\/hub` : '\/';/);
  assert.match(read('src/services/homeroom-bot-dm.js'), /id: 'open_community'[^\n]*target: `#app\/\$\{encodeURIComponent\(slug\)\}\/dev\/hub`/);
  assert.match(read('src/services/shared-objects.js'), /href: link\.type === 'hub' \? `#app\/\$\{slug\}\/dev\/hub`/);
});

// ── #6098: a keyboard vote keeps the reader's place ──────────────────
//
// A vote button used to be `disabled` while its vote was on its way, which
// dropped keyboard focus to the page: the next Tab started again at the top.
// It is shown busy (`aria-disabled`) instead, so it keeps focus, and each
// handler refuses a second press itself.

test('#6098: the card\'s Vote button keeps focus while its vote is sent, and takes focus back after the picker sends', () => {
  // Only the spec's own `disabled` and an approval switch the face off.
  assert.match(CARD_TSX, /disabled=\{disabled \|\| approved\}/);
  assert.doesNotMatch(CARD_TSX, /disabled=\{[^}]*!!sending[^}]*\}/, 'never by its own send');
  assert.match(CARD_TSX, /aria-disabled=\{sending \? 'true' : undefined\}/, 'shown busy instead, which keeps keyboard focus');
  assert.match(CARD_TSX, /if \(sending\) return;\n    if \(open \|\| sheetRef\.current\)/, 'and the second press is refused');
  // A send from the desktop popover returns focus to the face with no scroll:
  // the popover is a portal and would take focus down with it.
  assert.match(CARD_TSX, /const btn = open \? btnRef\.current : null;\s*shut\(\);\s*if \(btn\?\.isConnected\) btn\.focus\(\{ preventScroll: true \}\);/);
  assert.match(CSS, /\.dev-vote-btn\[aria-disabled="true"\] \{ cursor: progress; opacity: 0\.75; \}/);
});

test('#6098: the request\'s ballot keeps the button that was pressed focused, and its vote to close is the one Vote', () => {
  const src = read('frontend/src/features/dev-board/topic/thread-changes.tsx');
  assert.doesNotMatch(src, /disabled=\{busy\}/, 'the ballot is not switched off mid-vote');
  assert.match(src, /data-ballot-option=\{c\.key\}\s*aria-disabled=\{busy \|\| undefined\}/);
  assert.match(src, /onClick=\{\(e\) => \{ if \(!on\) void choose\(c\.pick, e\.currentTarget\); \}\}/, 'the pressed button is what comes back');
  assert.match(src, /if \(active && active !== document\.body\) return;/, 'only where focus was actually lost');
  assert.match(src, /focus\(\{ preventScroll: true \}\)/, 'and the page does not scroll under it');
  assert.match(src, /refocusAfterVote\(box\.current, 'ballot-option', from, wasFocused\)/);
  // The vote to close and a decision's vote are the change page's Vote
  // (VoteButton), which takes focus back itself after the picker sends.
  assert.doesNotMatch(src, /data-close-vote/, 'no Yes and No of their own');
  assert.equal((src.match(/<VoteButton yes=\{specs\.yes\} no=\{specs\.no\} \/>/g) || []).length, 2);
});

// ── #6987: a vote that never got sent says so ─────────────────────────
//
// The "Add a line for the group?" box is asked for before anything is
// painted. When it never came up, the vote stayed in flight forever: both
// buttons went dim, and every later tap returned at the guard without a
// word. The prompt is raced against a watchdog now, and castIssueVote
// answers true only when the server took the vote (as castVote does).

test('#6987: a vote to close and a decision\'s vote say "Sending…" through the one Vote', () => {
  // They are the change page's Vote (VoteButton), which reads the sending
  // store by its call and the decision's id (`castIssueVote:<id>`), as the
  // change page's own does for `castVote:<id>`.
  const src = read('frontend/src/features/dev-board/topic/thread-changes.tsx');
  assert.match(src, /act: \{ fn: 'castIssueVote', args: \[id, 'up'\] \}/);
  assert.match(CARD_TSX, /const sendKey = `\$\{yes\.act\?\.fn\}:\$\{String\(yes\.act\?\.args\?\.\[0\] \?\? ''\)\}`;/);
  assert.match(CARD_TSX, /\{sending \? t\('project:card\.vote\.sending'\) : \(/, 'the face says it is on its way');
  assert.doesNotMatch(src, /disabled=\{busy\}/, 'never switched off mid-vote, so focus stays');
});

test('#6987: castIssueVote answers only when the server took the vote', async () => {
  const ok = makeAppView({ globals: { PlatformUI: { toast: () => {} } } });
  // #6990: an ok answer now carries the side it saved, so the Votes card can
  // show it before its re-read; it is still truthy for #6987's callers.
  assert.deepEqual(plain(await ok.castIssueVote(5, 'up', { reason: null })), { ok: true, vote: 'yes' });

  const refused = makeAppView({
    fetch: async () => ({ ok: false, status: 409, json: async () => ({ code: 'issue_not_open' }) }),
    globals: { PlatformUI: { toast: () => {} } },
  });
  assert.equal(await refused.castIssueVote(5, 'up', { reason: null }), false, 'a refusal is not a recorded vote');

  const failed = makeAppView({
    fetch: async () => { throw new Error('offline'); },
    globals: { PlatformUI: { toast: () => {} } },
  });
  assert.equal(await failed.castIssueVote(5, 'up', { reason: null }), false, 'nor is a lost connection');

  const toasts = [];
  const cancelled = makeAppView({ globals: { PlatformUI: { prompt: async () => null, toast: (m) => toasts.push(m) } } });
  assert.equal(await cancelled.castIssueVote(5, 'down'), false, 'a cancelled No sends nothing');
  assert.equal(toasts.length, 0, 'and stays silent: it was the person\'s choice');

  // A second press while the first is still out is refused.
  let release = null;
  const slow = makeAppView({
    fetch: () => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({}) }); }),
    globals: { PlatformUI: { toast: () => {} } },
  });
  const first = slow.castIssueVote(5, 'up', { reason: null });
  assert.equal(await slow.castIssueVote(5, 'up', { reason: null }), false, 'the in-flight guard answers false');
  for (let i = 0; i < 20 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(plain(await first), { ok: true, vote: 'yes' }, 'and the vote that was out still resolves its side');
});

// #6990: the vote the server saved is published before the page's reads, so
// the Votes card shows it at once and Needs you lets go of the decision with
// the sidebar badge. A same-side vote is the server's toggle-off: no side.
test('#6990: castIssueVote publishes the side it saved, and none for a toggle-off', async () => {
  const calls = [];
  const bridge = { publishGovVoteSaved: (id, vote) => calls.push([id, vote]) };
  const answered = (data) => makeAppView({
    fetch: async () => ({ ok: true, json: async () => data }),
    globals: { PlatformUI: { toast: () => {} }, UsernodeReact: { devBoard: bridge } },
  });
  assert.deepEqual(plain(await answered({}).castIssueVote(5, 'up', { reason: null })), { ok: true, vote: 'yes' });
  assert.deepEqual(plain(await answered({ toggled: true }).castIssueVote(5, 'down', { reason: null })), { ok: true, vote: null });
  const refused = makeAppView({
    fetch: async () => ({ ok: false, status: 409, json: async () => ({ code: 'issue_not_open' }) }),
    globals: { PlatformUI: { toast: () => {} }, UsernodeReact: { devBoard: bridge } },
  });
  assert.equal(await refused.castIssueVote(5, 'up', { reason: null }), false, 'a refusal publishes nothing');
  assert.deepEqual(calls, [[5, 'yes'], [5, null]], 'only the answers the server took, with the side it saved');
});

test('#6987: a line box that never opens toasts "Vote not sent. Try again." and frees the next tap', async () => {
  const toasts = [];
  const never = new Promise(() => {});
  const AppView = makeAppView({ globals: { PlatformUI: { prompt: () => never, toast: (m) => toasts.push(m) } } });
  // The real wait is a second; shortened here so the suite stays quick.
  AppView.VOTE_PROMPT_OPEN_MS = 5;
  assert.equal(await AppView.castIssueVote(9, 'up'), false, 'nothing was sent');
  assert.deepEqual(toasts, [message('changes:vote.toast.notSentRetry')]);
  assert.equal(AppView._voteInFlight.has('issue:9'), false, 'the vote is not left in flight');
  // The next tap is accepted, and its box's answer is what sends it.
  const answered = makeAppView({ globals: { PlatformUI: { prompt: async () => 'because', toast: () => {} } }, fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.deepEqual(plain(await answered.castIssueVote(9, 'up')), { ok: true, vote: 'yes' });
});

test('#6987: a line box that is open at the check is left alone to be answered', async () => {
  const toasts = [];
  const AppView = makeAppView({
    document: {
      querySelectorAll: (sel) => (sel === '.un-alert' ? [{ getClientRects: () => [{ width: 10 }] }] : []),
      getElementById: () => null,
      addEventListener: () => {},
    },
    globals: {
      PlatformUI: {
        prompt: () => new Promise((resolve) => setTimeout(() => resolve('because'), 30)),
        toast: (m) => toasts.push(m),
      },
    },
  });
  AppView.VOTE_PROMPT_OPEN_MS = 5;
  assert.deepEqual(plain(await AppView.castIssueVote(5, 'up')), { ok: true, vote: 'yes' }, 'the box\'s own answer sends the vote');
  assert.equal(toasts.length, 0, 'and no "not sent" notice: reading it longer is not a failure');
});

// T2.5 (19 Nov 2026): a change row on the Workshop's list wears its stored
// row's words while that row is not up for a vote (AppView._workPill, the
// change page's header pill), and asks for no vote meanwhile; its Yes/No
// stay where they are (the card's own).
test('T2.5: a change row whose stored row is not up for a vote draws that row\'s pill', () => {
  const AppView = makeAppView();
  seed(AppView);
  const shots = {
    stage: 'checking', line: { code: 'shots' },
    words: { stage: { id: 'core:work.stage.shots' }, stageOthers: { id: 'core:work.stage.shots' }, line: { id: 'core:work.line.shots' } },
  };
  const item = (work) => ({ id: 77, pr_number: 4577, status: 'promoted', check_state: 'passing', created_at: at(1), linked_issues: [], work });
  const held = AppView._workshopBrief('proposal', item(shots), null);
  assert.equal(held.pill.label, 'Taking screenshots');
  assert.equal(held.vote.ask, false, 'nothing asks for a vote it cannot take yet');
  const open = AppView._workshopBrief('proposal', item({ stage: 'up_for_vote', words: { stage: { id: 'core:work.stage.upForVote' }, line: null } }), null);
  assert.equal(open.pill, undefined, 'up for a vote: the card\'s own pill');
  assert.equal(open.vote.ask, true);
  assert.equal(AppView._workshopBrief('proposal', item(null), null).pill, undefined);
  // The row draws it in place of the card's pill.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'frontend/src/features/dev-board/workshop/work-row.tsx'), 'utf8');
  assert.match(src, /<Votes card=\{card\} pill=\{b\.pill \|\| null\} \/>/);
});

test('24 Nov 2026: the path\'s Asked counts the open lane, the list its stop opens holds the same, and the viewer\'s own are marked', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const d = AppView._workshopView().dashboard;
  const buckets = AppView._bucketDevItems({
    issues: AppView._visibleGhIssues(), proposals: AppView._proposals || [], gov: AppView._govProposals || [],
    merged: AppView._merged || [], mySessions: AppView._mySessions || [], sharedSessions: AppView._sharedSessions || [],
  });
  assert.equal(d.asked, buckets.issues.length, 'every request nobody is building and not up for a vote');
  assert.ok(d.asked <= d.open - d.votesWaiting);
  // The board narrowed to the stop lists exactly that many (#5369's rule).
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), stage: 'asked' };
  const cols = AppView._kanbanView().cols;
  assert.equal(cols.find((c) => c.key === 'issues').count + cols.find((c) => c.key === 'inprogress').count
    + cols.find((c) => c.key === 'inreview').count + cols.find((c) => c.key === 'done').count, d.asked);
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), stage: 'votes' };
  assert.equal(AppView._kanbanView().cols.find((c) => c.key === 'inreview').count, d.votesWaiting);
  // The viewer's threads at each stop are a part of what it counts; a guest has none.
  assert.ok(d.mine && d.mine.asked <= d.asked && d.mine.votes <= d.votesWaiting && d.mine.live <= d.shippedWeek);
  assert.equal(typeof d.weeksPending, 'boolean');
  const guest = makeAppView({ App: { user: null, currentApp: 'demo-app', currentSubTab: 'forum' } });
  seed(guest);
  assert.equal(guest._workshopView().dashboard.mine, null);
});
