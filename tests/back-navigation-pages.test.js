'use strict';

// #3620: "fix back button navigation -- eg if i click community, then change
// the tab to workshop, back should go back to hub, not home."
//
// The rule this pins: a move YOU make to something you would call a page
// pushes an entry, so Back returns to where you were; Back and Forward
// themselves never push.
//
//   1. A project page's tabs (Hub, Discussion, Needs you, Workshop and All
//      items) share one address, so a press used to leave history alone and
//      Back skipped the hub. A press now pushes an entry at the same address
//      naming its tab (AppView._pushWorkshopTab), and the router shows the tab
//      an entry names when Back or Forward lands on it.
//   2. An up arrow (the header's, a topic's "‹ Workshop", Discover's detail,
//      a dev session's) is a STEP BACK when the entry below is where it
//      points (App._stepBackTo). Following its href pushed the parent on top
//      of the page, so the next Back reopened the page just left.
//   3. The Leaderboard's tabs push when pressed; a router pass still replaces.
//   4. A Discover row bound one more click listener on every list render, so
//      one tap opened the project two or three times over — three entries at
//      one address, and Back stayed on the hub.
//
// The declared check "Back from a project's Workshop tab returns to its Hub"
// walks flow 1 in a browser through ?shot=tab-back.
//
// Run with: node --test tests/back-navigation-pages.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const { message } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const AppView = require('../public/js/app-view.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP_JS = read('public/js/app.js');
const APP_VIEW = read('public/js/app-view.js');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const BROWSE_JS = read('frontend/src/features/apps/browse.js');
const BROWSE_LIST = read('frontend/src/features/apps/browse-list.tsx');
const DEV_CHAT = read('frontend/src/features/dev-chat/dev-chat.js');
const TOPIC_BACK = read('frontend/src/features/dev-board/topic/topic-back.tsx');
const LEADERBOARD = read('frontend/src/features/leaderboard/leaderboard.js');
const DAPP = JSON.parse(read('dapp.json'));

const ORIGIN = 'https://homeroom.test';
const KEY = AppView.WORKSHOP_TAB_STATE_KEY;

// A window with one document's session history: each entry has its own URL
// and state, as the History API keeps them.
function fakeWindow(start) {
  const entries = [{ url: new URL(start, ORIGIN), state: null }];
  let at = 0;
  const events = [];
  const store = new Map();
  const here = () => entries[at].url;
  const win = {
    events,
    entries,
    get at() { return at; },
    location: {
      get pathname() { return here().pathname; },
      get search() { return here().search; },
      get hash() { return here().hash; },
      get href() { return here().href; },
    },
    history: {
      get state() { return entries[at].state; },
      get length() { return entries.length; },
      pushState(state, _t, url) {
        entries.splice(at + 1);
        entries.push({ url: url == null ? new URL(here().href) : new URL(url, here()), state: structuredClone(state) });
        at = entries.length - 1;
      },
      replaceState(state, _t, url) {
        entries[at] = { url: url == null ? entries[at].url : new URL(url, here()), state: structuredClone(state) };
      },
      back() { if (at > 0) at -= 1; },
      forward() { if (at < entries.length - 1) at += 1; },
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    dispatchEvent: (e) => { events.push(e); return true; },
  };
  return win;
}

function withWindow(win, fn, app) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  const hadApp = Object.prototype.hasOwnProperty.call(globalThis, 'App');
  const wasApp = globalThis.App;
  globalThis.window = win;
  if (app) globalThis.App = app;
  AppView._workshopTabUrlOverride = undefined;
  try { return fn(); } finally {
    if (hadWindow) globalThis.window = was; else delete globalThis.window;
    if (app) { if (hadApp) globalThis.App = wasApp; else delete globalThis.App; }
    AppView._workshopTabUrlOverride = undefined;
  }
}

// One method of the App object literal in app.js, lifted out by its name.
function liftAppMethod(signature) {
  const start = APP_JS.indexOf(`\n  ${signature} {`);
  assert.ok(start !== -1, `${signature} located in app.js`);
  const end = APP_JS.indexOf('\n  },\n', start);
  return APP_JS.slice(start + 1, end + 4);
}

// ── 1. The project page's tabs ─────────────────────────────────────────

test('a tab press pushes an entry at the same address naming its tab, and stamps the one it leaves', () => {
  const win = fakeWindow('/app/garden/workshop?demo=1');
  withWindow(win, () => {
    assert.equal(AppView._pushWorkshopTab('garden', 'status', 'workshop'), true);
    assert.equal(win.entries.length, 2, 'one new entry');
    assert.equal(win.entries[1].url.href, `${ORIGIN}/app/garden/workshop?demo=1`, 'at the same address');
    assert.deepEqual(win.entries[0].state[KEY], { slug: 'garden', tab: 'status', from: null },
      'the entry left behind now says it was the hub');
    assert.deepEqual(win.entries[1].state[KEY], { slug: 'garden', tab: 'workshop', from: 'status' });

    // Back lands on the hub's entry, and that is what the router reads.
    win.history.back();
    assert.deepEqual(AppView._historyWorkshopTab(), { slug: 'garden', tab: 'status' });
    win.history.forward();
    assert.deepEqual(AppView._historyWorkshopTab(), { slug: 'garden', tab: 'workshop' });
  });
});

test('a press pushes nothing off the page, onto the same tab, or to a tab that does not exist', () => {
  for (const start of ['/?demo=1#communities', '/app/garden/dev/issues/12', '/app/garden', '/app/other/workshop']) {
    const win = fakeWindow(start);
    withWindow(win, () => {
      assert.equal(AppView._pushWorkshopTab('garden', 'status', 'workshop'), false, start);
      assert.equal(win.entries.length, 1, `${start}: history untouched`);
      assert.equal(win.entries[0].state, null);
    });
  }
  const win = fakeWindow('/app/garden/workshop');
  withWindow(win, () => {
    assert.equal(AppView._pushWorkshopTab('garden', 'workshop', 'workshop'), false, 'the tab already up');
    assert.equal(AppView._pushWorkshopTab('garden', 'status', 'nowhere'), false, 'an unknown tab');
    assert.equal(win.entries.length, 1);
  });
});

test('the project page answers to every spelling the router canonicalises', () => {
  const on = (start, slug = 'garden') => withWindow(fakeWindow(start), () => AppView._onProjectPage(slug));
  assert.equal(on('/app/garden/workshop'), true);
  assert.equal(on('/app/garden/board?ws=all'), true);
  assert.equal(on('/#app/garden/dev'), true);
  assert.equal(on('/#app/garden/workshop'), true);
  assert.equal(on('/app/garden/dev/issues/4'), false, 'an item is a page of its own');
  assert.equal(on('/app/garden'), false, 'the running app is not the project page');
  assert.equal(on('/app/garden/workshop#settings'), false, 'a fragment outranks the path');
  assert.equal(on('/app/garden/workshop', 'other'), false);
});

test('a stamp keeps whatever else the entry carries (a dismissible surface\'s marker)', () => {
  const win = fakeWindow('/app/garden/workshop');
  win.entries[0].state = { __unDismissId: 'abc:1', __unDismissDepth: 0 };
  withWindow(win, () => {
    AppView._pushWorkshopTab('garden', 'needs', 'all');
    assert.equal(win.entries[0].state.__unDismissId, 'abc:1');
    assert.equal(win.entries[0].state[KEY].tab, 'needs');
    assert.equal(win.entries[1].state.__unDismissId, undefined,
      'the new entry is ours alone: a copied marker would make the back stack skip it');
  });
});

test('a stamp only counts on its own project\'s page', () => {
  const win = fakeWindow('/app/garden/dev/issues/7');
  win.entries[0].state = { [KEY]: { slug: 'garden', tab: 'workshop', from: 'status' } };
  withWindow(win, () => assert.equal(AppView._historyWorkshopTab(), null, 'an item page carrying a copied stamp'));
  const other = fakeWindow('/app/other/workshop');
  other.entries[0].state = { [KEY]: { slug: 'garden', tab: 'workshop' } };
  withWindow(other, () => assert.equal(AppView._historyWorkshopTab(), null, 'another project\'s page'));
  const junk = fakeWindow('/app/garden/workshop');
  junk.entries[0].state = { [KEY]: { slug: 'garden', tab: 'nowhere' } };
  withWindow(junk, () => assert.equal(AppView._historyWorkshopTab(), null, 'an unknown tab'));
});

test('All items\' way back is a step Back when the Workshop is the entry below, and a press otherwise', () => {
  const win = fakeWindow('/app/garden/workshop');
  withWindow(win, () => {
    AppView._pushWorkshopTab('garden', 'status', 'workshop');
    AppView._pushWorkshopTab('garden', 'workshop', 'all');
    assert.equal(AppView._upWorkshopTab('garden', 'workshop'), true);
    assert.equal(win.at, 1, 'went back one entry rather than pushing a third');
    assert.equal(win.entries.length, 3);
    // A cold ?ws=all link has nothing of ours below it: the caller pushes.
    const cold = fakeWindow('/app/garden/workshop?ws=all');
    withWindow(cold, () => assert.equal(AppView._upWorkshopTab('garden', 'workshop'), false));
  });
});

test('Back or Forward shows the entry\'s tab as a traversal, remembered for the page to mount on', () => {
  const win = fakeWindow('/app/garden/workshop');
  withWindow(win, () => {
    AppView._showHistoryWorkshopTab('garden', 'discussion');
    assert.equal(win.localStorage.getItem(AppView.WORKSHOP_TAB_KEY), 'discussion');
    const ev = win.events.at(-1);
    assert.equal(ev.type, 'usernode:workshop-tab');
    assert.deepEqual(ev.detail, { slug: 'garden', tab: 'discussion', traversal: true });
    assert.equal(win.entries.length, 1, 'nothing pushed');
  });
});

test('an entry a door\'s navigation made is given the tab it opens on, so Forward can show it again', () => {
  const win = fakeWindow('/app/garden/workshop');
  const App = { currentApp: 'garden' };
  withWindow(win, () => {
    win.localStorage.setItem(AppView.WORKSHOP_TAB_KEY, 'status');
    assert.equal(AppView._stampArrivedWorkshopTab(), true);
    assert.deepEqual(win.entries[0].state[KEY], { slug: 'garden', tab: 'status', from: null });
    win.localStorage.setItem(AppView.WORKSHOP_TAB_KEY, 'needs');
    assert.equal(AppView._stampArrivedWorkshopTab(), false, 'an entry that already names its tab keeps it');
    assert.equal(win.entries[0].state[KEY].tab, 'status');
  }, App);
  const elsewhere = fakeWindow('/?demo=1#messages');
  withWindow(elsewhere, () => {
    assert.equal(AppView._stampArrivedWorkshopTab(), false);
    assert.equal(elsewhere.entries[0].state, null);
  }, App);
});

test('the router reads the entry\'s tab BEFORE it routes and shows it after, and never pushes', () => {
  const calls = [];
  const fakeView = {
    // #6110: an entry the side panel's address was written on is read as
    // the page's first, before anything reads the address.
    _leavePanelAddress: () => calls.push('leave'),
    _historyWorkshopTab: () => ({ slug: 'garden', tab: 'status' }),
    _setWorkshopTab: (t) => calls.push(`remember:${t}`),
    _showHistoryWorkshopTab: (s, t) => calls.push(`show:${s}:${t}`),
    _stampArrivedWorkshopTab: () => calls.push('stamp'),
  };
  const ctx = vm.createContext({ location: { hash: '' }, AppView: fakeView });
  ctx.calls = calls;
  const App = vm.runInContext(`const App = { _currentRoute: '', _previousRoute: null,
    restoreFromHash() { calls.push('route'); }, _applyRouteShots() { calls.push('shots'); },
    ${liftAppMethod('_routeFromHash()')} }; App`, ctx);
  App._routeFromHash();
  assert.deepEqual(calls, ['leave', 'remember:status', 'route', 'show:garden:status', 'shots']);

  calls.length = 0;
  fakeView._historyWorkshopTab = () => null;
  App._routeFromHash();
  assert.deepEqual(calls, ['leave', 'route', 'stamp', 'shots'], 'an entry naming no tab is given one, after the route');
});

test('the page pushes on a press, shows a traversal without pushing, and its doors push nothing', () => {
  const openTab = /const openTab = \(next: TabKey\) => \{([\s\S]*?)\n  \};/.exec(WORKSHOP);
  assert.ok(openTab, 'openTab located');
  assert.match(openTab[1], /const was = tabRef\.current;/, 'from the tab actually up, read before this press re-renders');
  assert.match(openTab[1],
    /const up = \(was === 'all' \|\| was === 'bot'\) && next === pageParent\(was\) && !!callAppView\('_upWorkshopTab', v\.slug, next\);\s*\n\s*if \(!up\) callAppView\('_pushWorkshopTab', v\.slug, was, next\);/,
    'a press pushes; up from All items or the bot\'s slots steps Back when the Workshop is below');
  const door = WORKSHOP.slice(WORKSHOP.indexOf('const onDoor = (event: Event) => {'));
  const doorBody = door.slice(0, door.indexOf('\n    };'));
  assert.doesNotMatch(doorBody, /_pushWorkshopTab/,
    'a door goes on to navigate to the page, and that navigation is its entry');
  assert.match(doorBody, /if \(door && door\.traversal && door\.tab === tabRef\.current\) return;/,
    'Back onto the tab already up leaves the page and its scroll alone');
  assert.match(WORKSHOP, /onBack=\{\(\) => openTab\(pageParent\(tab\)\)\}/,
    'All items\' "Workshop" goes through the same press');
});

test('the declared check walks the reported flow and asserts the hub came back', () => {
  const check = DAPP.tests.find((t) => /\(#3620\)/.test(t.name));
  assert.ok(check, 'the #3620 check is declared');
  assert.match(check.path, /[?&]shot=tab-back\b/);
  assert.match(check.path, /#app\/usernode-2d5619\/workshop$/);
  assert.match(check.expectSelector, /^html\[data-shot-tab-back=\\?"status\\?"\] /,
    'it asserts on what Back showed, not on the hub the page started on');
  const shot = APP_VIEW.slice(APP_VIEW.indexOf("if (shot === 'tab-back'"));
  const body = shot.slice(0, shot.indexOf("if (shot === 'preview-loading'"));
  assert.match(body, /press\('workshop'\)/, 'through the tab\'s own button');
  assert.match(body, /window\.history\.back\(\)/, 'then Back, as the browser\'s does');
  assert.match(body, /'data-shot-tab-back', onPage \? \(shown\(\) \|\| 'none'\) : 'left'/);
});

// ── 2. Up arrows ───────────────────────────────────────────────────────

function stepBackHarness({ current, below, sameDocument = true, navigationApi = true }) {
  const backs = [];
  const entries = [];
  if (below) entries.push({ url: new URL(below, ORIGIN).href, index: 0, sameDocument, key: 'a' });
  entries.push({ url: new URL(current, ORIGIN).href, index: entries.length, sameDocument: true, key: 'b' });
  const cur = new URL(current, ORIGIN);
  const ctx = vm.createContext({
    URL,
    location: { origin: ORIGIN, search: cur.search, pathname: cur.pathname, hash: cur.hash },
    history: { back: () => backs.push('back') },
    window: {},
  });
  if (navigationApi) {
    ctx.window.navigation = {
      entries: () => entries,
      currentEntry: entries[entries.length - 1],
      traverseTo() {},
    };
  }
  const App = vm.runInContext(`const App = {
    ${liftAppMethod('_routeSearch(innerPath)')},
    ${liftAppMethod('_rootUrl(hash)')},
    ${liftAppMethod('_navigationApi()')},
    ${liftAppMethod('_stepBackTo(href)')},
    ${liftAppMethod('_canStepBackTo(href)')} }; App`, ctx);
  return { App, backs };
}

test('an up arrow steps back when the entry below is where it points', () => {
  const thread = stepBackHarness({ current: '/?demo=1#messages/3', below: '/?demo=1#messages' });
  assert.equal(thread.App._stepBackTo('#messages'), true);
  assert.deepEqual(thread.backs, ['back']);

  // The board a topic or a session was opened from: the router canonicalised
  // its hash to the clean path, and the project page answers to its aliases.
  for (const href of ['#app/garden/workshop', '#app/garden/board', '#app/garden/dev']) {
    const topic = stepBackHarness({ current: '/app/garden/dev/issues/4', below: '/app/garden/workshop' });
    assert.equal(topic.App._stepBackTo(href), true, href);
  }
  const conversation = stepBackHarness({ current: '/app/garden/dev/issues/4', below: '/#messages/9' });
  assert.equal(conversation.App._stepBackTo('#messages/9'), true);
});

test('…and pushes, as it always did, everywhere else', () => {
  const elsewhere = stepBackHarness({ current: '/#messages/3', below: '/#communities' });
  assert.equal(elsewhere.App._stepBackTo('#messages'), false, 'the parent is not the entry below');
  const cold = stepBackHarness({ current: '/#messages/3' });
  assert.equal(cold.App._stepBackTo('#messages'), false, 'a cold deep link has nothing below');
  const oldDoc = stepBackHarness({ current: '/#messages/3', below: '/#messages', sameDocument: false });
  assert.equal(oldDoc.App._stepBackTo('#messages'), false, 'another document\'s entry is a reload away');
  const noApi = stepBackHarness({ current: '/#messages/3', below: '/#messages', navigationApi: false });
  assert.equal(noApi.App._stepBackTo('#messages'), false, 'without the Navigation API nothing can say');
  for (const h of [elsewhere, cold, oldDoc, noApi]) assert.deepEqual(h.backs, []);
});

test('every up arrow that followed its href asks to step back first', () => {
  const backBtn = APP_JS.slice(APP_JS.indexOf("document.getElementById('back-btn').addEventListener('click'"));
  const chain = backBtn.slice(0, backBtn.indexOf('App.navigateHome();'));
  assert.match(chain, /if \(App\._stepBackTo\(href\)\) return;[^\n]*\n\s*window\.location\.hash = href;/,
    'the header\'s arrow');
  const handleBack = BROWSE_JS.slice(BROWSE_JS.indexOf('  handleBack() {'), BROWSE_JS.indexOf('  _syncLevel() {'));
  assert.match(handleBack, /App\._stepBackTo\('#apps'\)\) return true;\s*\n\s*location\.hash = '#apps';/,
    'Discover\'s detail page');
  const leave = DEV_CHAT.slice(DEV_CHAT.indexOf('  leaveSession() {'));
  const leaveBody = leave.slice(0, leave.indexOf('\n  },'));
  assert.match(leaveBody, /if \(!stepBack\(origin\)\) location\.hash = origin;/, 'a dev session\'s arrow');
  assert.match(leaveBody, /if \(!stepBack\('#messages'\)\) location\.hash = '#messages';/);
  assert.match(TOPIC_BACK, /if \(app\?\._stepBackTo\?\.\(href\)\) return;\s*\n\s*window\.location\.hash = href;/,
    'a topic\'s "‹ Workshop"');
});

// ── 3. The Leaderboard's tabs ──────────────────────────────────────────

function loadLeaderboard({ isRestoring = false, open = true, hash = '#leaderboard/challenges' } = {}) {
  const writes = [];
  const location = { hash };
  const write = (kind) => (_s, _t, url) => { writes.push([kind, url]); location.hash = url; };
  const ctx = {
    App: { _isRestoring: isRestoring, setHeaderTitle() {}, _leaderboardTitle: () => '' },
    TopochainChallenges: { open() {}, close() {} },
    TopochainLeaderboard: { open() {}, close() {} },
    TopochainEventContext: { open() {}, close() {} },
    location,
    history: { replaceState: write('replace'), pushState: write('push') },
    document: { getElementById: () => ({ classList: { toggle() {}, contains: () => false } }) },
    console,
    fetch: async () => ({ ok: true, json: async () => ({ items: [] }) }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  ctx.PlatformI18n = englishPlatformI18n();
  vm.runInContext(`${LEADERBOARD.replace(/^export .*$/gm, '')}\n;globalThis.__lb = Leaderboard;`, ctx);
  const Leaderboard = ctx.__lb;
  Leaderboard._open = open;
  Leaderboard.section = 'challenges';
  return { Leaderboard, writes, ctx };
}

test('a Leaderboard tab pressed on the open screen pushes; the router\'s own passes replace', () => {
  const pressed = loadLeaderboard();
  pressed.Leaderboard.section = 'kudos';
  pressed.Leaderboard.sub = 'prs';
  pressed.Leaderboard._syncHash();
  assert.deepEqual(pressed.writes, [['push', '#leaderboard/prs']], 'Back from Kudos is Challenges again');

  const routed = loadLeaderboard({ isRestoring: true, hash: '#leaderboard' });
  routed.Leaderboard._syncHash();
  assert.deepEqual(routed.writes, [['replace', '#leaderboard/challenges']],
    'a bare #leaderboard healing to its tab is not somewhere to go back to');

  const before = loadLeaderboard({ open: false, hash: '#leaderboard/kudos' });
  before.Leaderboard.section = 'kudos';
  before.Leaderboard.sub = 'prs';
  before.Leaderboard._syncHash();
  assert.deepEqual(before.writes, [['replace', '#leaderboard/prs']], 'a deep link restored before open()');

  const same = loadLeaderboard();
  same.Leaderboard._syncHash();
  assert.deepEqual(same.writes, [], 'the address already says it');
});

// ── 4. Discover's rows ─────────────────────────────────────────────────

test('a Discover row binds its click once, however often the list renders', () => {
  const at = BROWSE_LIST.indexOf('const nav = (window as any).NavLink;');
  const effect = BROWSE_LIST.slice(BROWSE_LIST.lastIndexOf('useEffect(() => {', at), BROWSE_LIST.indexOf('const warm = ', at));
  assert.match(effect, /\n {2}\}, \[\]\);\s*$/, 'the wiring effect runs once per mounted row');
  assert.match(effect, /const view = latest\.current;[\s\S]*rowHref\(view\)/, 'hrefFor reads the current row');
  assert.match(effect, /const view = latest\.current;[\s\S]*openRow\(view\)/, 'and so does the plain click');
  assert.match(BROWSE_LIST, /const latest = useRef<RowView>\(view\);\s*\n\s*latest\.current = view;/);
});

test('a topic\'s chip names where its press goes: a step Back to the place left, else the Workshop its link opens (audit N05, N03 follow-up)', () => {
  const { chipFor, placeChip } = loadTsx('frontend/src/features/dev-board/topic/topic-back.tsx');
  const board = '#app/garden/workshop';
  // A step Back shows the place the page was left on.
  assert.deepEqual({ ...chipFor(board, 'status', true) }, { to: 'hub' });
  assert.deepEqual({ ...chipFor(board, 'workshop', true) }, { to: 'workshop' });
  assert.deepEqual({ ...chipFor(board, 'all', true) }, { to: 'allItems' });
  assert.deepEqual({ ...chipFor(board, 'needs', true) }, { to: 'needs' });
  assert.deepEqual({ ...chipFor(board, 'discussion', true) }, { to: 'channel', handle: 'general' });
  assert.deepEqual({ ...chipFor(board, 'c:onboarding', true) }, { to: 'channel', handle: 'onboarding' });
  assert.deepEqual({ ...placeChip('bot') }, { to: 'workshop' }, 'the bot\'s slots are under the Workshop');
  // Otherwise the press follows the link, and a link to /workshop opens the Workshop.
  assert.deepEqual({ ...chipFor(board, 'status') }, { to: 'workshop' }, 'a cold load: "‹ Workshop"');
  assert.deepEqual({ ...chipFor(board, 'needs', false) }, { to: 'workshop' });
  assert.deepEqual({ ...chipFor('#messages/12', 'status', true) }, { to: 'messages' });
  assert.equal(message('project:topic.back.hub'), 'Hub');
  assert.equal(message('project:topic.back.toWorkshop'), 'Back to Workshop');
  // The press and the words read the same test.
  assert.match(TOPIC_BACK, /chipFor\(href, workshopTab, stepsBackTo\(href\)\)/);
  assert.match(read('public/js/app.js'), /_stepBackTo\(href\) \{\s*if \(!App\._canStepBackTo\(href\)\) return false;/);
  // The sidebar and the phone header read the same answer on a request's page.
  const rail = read('frontend/src/features/nav/rail-communities.tsx');
  assert.match(rail, /place=\{here \? place\.place : \(onItem \? itemReturnPlace\(slug\) as PlaceKey : null\)\}/);
  assert.match(read('frontend/src/features/nav-drawer/nav-drawer.tsx'), /improve\.subTab === 'topic'\s*\? itemReturnPlace\(slug\)/);
});

// ── 6. The address follows the Workshop's side panel (#6110) ─────────────
//
// "tapped copy on a proposal to share it and what pasted was the app home
// url, not the proposal." On a wide window a row opens its item beside the
// list (AppView.openTopicInPanel) and the address stayed the Workshop's, so
// the browser's own Copy or Share handed out the Workshop. While the panel
// holds an item the address is the item's own, written in place; the page's
// comes back when the panel closes; a reload of it opens the item's page;
// Back or Forward onto the entry shows the page it was.

const PANEL_KEY = AppView.PANEL_ADDRESS_STATE_KEY;

// The real address writer, with the router's own helpers.
function panelApp(win, slug = 'garden') {
  const ctx = vm.createContext({ location: win.location, AppView, encodeURIComponent, decodeURIComponent, URLSearchParams });
  return vm.runInContext(`const App = { currentApp: ${JSON.stringify(slug)}, currentTab: 'dev', currentSubTab: 'forum',
    ${liftAppMethod('_routeSearch(innerPath)')},
    ${liftAppMethod('_changeNumber(value)')},
    ${liftAppMethod('_normalizeTab(tab, ref, subTab)')},
    ${liftAppMethod('_appUrl(slug, tab, ref, subTab, options)')} }; App`, ctx);
}

function withPanel(win, fn, slug) {
  const app = panelApp(win, slug);
  const wasPanel = AppView._devTopicInPanel;
  const wasAddress = AppView._panelAddress;
  const wasProposal = AppView._topicProposal;
  AppView._devTopicInPanel = true;
  AppView._panelAddress = null;
  try {
    return withWindow(win, () => fn(app), app);
  } finally {
    AppView._devTopicInPanel = wasPanel;
    AppView._panelAddress = wasAddress;
    AppView._topicProposal = wasProposal;
  }
}

test('#6110: the panel writes its item\'s own address in place, and the page\'s comes back when it closes', () => {
  const win = fakeWindow('/app/garden/workshop?ws=needs');
  win.entries[0].state = { [KEY]: { slug: 'garden', tab: 'needs', from: 'status' }, __unDismissId: 'x:1' };
  withPanel(win, () => {
    assert.equal(AppView._followPanelAddress('issue', 12), true);
    assert.equal(win.entries.length, 1, 'no step for Back');
    assert.equal(win.entries[0].url.href, `${ORIGIN}/app/garden/dev/issues/12?ws=needs`, 'the request\'s own address, as openTopic writes it');
    assert.deepEqual(win.entries[0].state[KEY], { slug: 'garden', tab: 'needs', from: 'status' }, 'the entry still names its place');
    assert.equal(win.entries[0].state.__unDismissId, 'x:1', 'and keeps whatever else it carried');
    assert.deepEqual(win.entries[0].state[PANEL_KEY], { slug: 'garden', from: '/app/garden/workshop?ws=needs' });
    assert.deepEqual(AppView._panelAddress, { slug: 'garden', from: '/app/garden/workshop?ws=needs', to: '/app/garden/dev/issues/12?ws=needs' });

    // The page is still the page: a place press pushes its entry.
    assert.equal(AppView._onProjectPage('garden'), true, 'the panel\'s address is the page\'s');
    assert.equal(AppView._onProjectPage('other'), false);
    assert.equal(AppView._historyWorkshopTab()?.tab, 'needs');

    // Another item in the same panel: the page's address is the one kept.
    AppView._topicProposal = { id: 51, pr_number: 77 };
    assert.equal(AppView._followPanelAddress('proposal', 51), true);
    assert.equal(win.entries[0].url.href, `${ORIGIN}/app/garden/dev/changes/77?ws=needs`, '#4367: a change with a pull request by its number');
    assert.equal(AppView._panelAddress.from, '/app/garden/workshop?ws=needs');
    assert.equal(win.entries[0].state[PANEL_KEY].from, '/app/garden/workshop?ws=needs');

    // ✕: the page's address, with its ?ws=, and the stamp gone.
    assert.equal(AppView._restorePanelAddress(), true);
    assert.equal(win.entries.length, 1);
    assert.equal(win.entries[0].url.href, `${ORIGIN}/app/garden/workshop?ws=needs`);
    assert.equal(PANEL_KEY in win.entries[0].state, false);
    assert.deepEqual(win.entries[0].state[KEY], { slug: 'garden', tab: 'needs', from: 'status' });
    assert.equal(AppView._panelAddress, null);
    assert.equal(AppView._restorePanelAddress(), false, 'nothing to put back twice');
  });

  // Not from anywhere but the page: an item's page, the running app.
  for (const start of ['/app/garden/dev/issues/4', '/app/garden', '/?demo=1#messages']) {
    const elsewhere = fakeWindow(start);
    withPanel(elsewhere, () => {
      assert.equal(AppView._followPanelAddress('issue', 12), false, start);
      assert.equal(elsewhere.entries[0].url.href, new URL(start, ORIGIN).href, `${start}: untouched`);
      assert.equal(AppView._panelAddress, null);
    });
  }
});

test('#6110: an address that moved on is not put back, and a place press while the panel is open still pushes', () => {
  const win = fakeWindow('/app/garden/workshop');
  withPanel(win, () => {
    AppView._followPanelAddress('proposal', 51);
    assert.equal(win.entries[0].url.pathname, '/app/garden/dev/proposals/51');
    // A press on Needs you: its entry, on top, at the address on screen;
    // the entry left behind keeps the panel's stamp with its place.
    assert.equal(AppView._pushWorkshopTab('garden', 'workshop', 'needs'), true);
    assert.equal(win.entries.length, 2);
    assert.deepEqual(win.entries[0].state[KEY], { slug: 'garden', tab: 'workshop', from: null });
    assert.deepEqual(win.entries[0].state[PANEL_KEY], { slug: 'garden', from: '/app/garden/workshop' });
    // The panel goes with the tab, and the new entry gets the page's address.
    assert.equal(AppView._restorePanelAddress(), true);
    assert.equal(win.entries[1].url.pathname, '/app/garden/workshop');
    assert.deepEqual(win.entries[1].state[KEY], { slug: 'garden', tab: 'needs', from: 'workshop' });
  });

  // Leaving for Messages pushed over it: the entry keeps the item's address
  // for the traversal to read, and nothing is written onto Messages.
  const left = fakeWindow('/app/garden/workshop');
  withPanel(left, () => {
    AppView._followPanelAddress('issue', 12);
    left.history.pushState(null, '', '/#messages');
    assert.equal(AppView._restorePanelAddress(), false);
    assert.equal(left.entries[1].url.href, `${ORIGIN}/#messages`);
    assert.equal(left.entries[0].url.pathname, '/app/garden/dev/issues/12');
    assert.equal(AppView._panelAddress, null);
  });
});

test('#6110: Back onto the entry shows the page it was; a reload is the item\'s page', () => {
  const win = fakeWindow('/app/garden/workshop?ws=needs');
  win.entries[0].state = { [KEY]: { slug: 'garden', tab: 'needs', from: 'status' } };
  withPanel(win, () => {
    AppView._followPanelAddress('issue', 12);
    // A sheet pushed over the open panel, closed with Back: the panel is up
    // for this very entry, so the address stays the item's.
    win.history.pushState({ __unDismissId: 'sheet:1' }, '');
    win.history.back();
    assert.equal(AppView._leavePanelAddress(), false, 'the panel is still up here');
    assert.equal(win.entries[0].url.pathname, '/app/garden/dev/issues/12');
    assert.deepEqual(AppView._panelAddress, { slug: 'garden', from: '/app/garden/workshop?ws=needs', to: '/app/garden/dev/issues/12?ws=needs' });
    // Leaving for Messages closes the panel (#6145) and pushes over it.
    win.history.pushState(null, '', '/#messages');
    AppView._restorePanelAddress();
    win.history.back();
    // What App._routeFromHash does first on a traversal.
    assert.equal(AppView._leavePanelAddress(), true);
    assert.equal(win.entries[0].url.href, `${ORIGIN}/app/garden/workshop?ws=needs`, 'the page\'s address, in place');
    assert.equal(win.entries.length, 2, 'nothing pushed');
    assert.equal(PANEL_KEY in win.entries[0].state, false);
    assert.deepEqual(AppView._historyWorkshopTab(), { slug: 'garden', tab: 'needs' }, 'at the place the entry names');
    assert.equal(AppView._leavePanelAddress(), false, 'the second of the popstate + hashchange pair finds nothing');
  });
  // An entry with no stamp is left alone: a pasted or followed link.
  const plain = fakeWindow('/app/garden/dev/issues/12');
  withPanel(plain, () => {
    assert.equal(AppView._leavePanelAddress(), false);
    assert.equal(plain.entries[0].url.pathname, '/app/garden/dev/issues/12');
  });
  // A stamp that does not fit its entry (another project's page, an address
  // that is not an item's) is dropped, and the address kept.
  for (const [start, from] of [['/app/garden/dev/issues/12', '/app/other/workshop'], ['/app/garden/workshop', '/app/garden/workshop'], ['/app/garden/dev/issues/12', 'https://evil.test/app/garden/workshop']]) {
    const odd = fakeWindow(start);
    odd.entries[0].state = { [PANEL_KEY]: { slug: from.includes('other') ? 'other' : 'garden', from } };
    withPanel(odd, () => {
      assert.equal(AppView._leavePanelAddress(), false, `${start} ← ${from}`);
      assert.equal(odd.entries[0].url.href, new URL(start, ORIGIN).href);
      assert.equal(PANEL_KEY in odd.entries[0].state, false, 'the stamp is dropped');
    });
  }
  // A reload never comes through the traversal: the router opens the item's
  // page from its address, and the page takes the stamp off its entry.
  const reload = fakeWindow('/app/garden/dev/issues/12?ws=needs');
  reload.entries[0].state = { [PANEL_KEY]: { slug: 'garden', from: '/app/garden/workshop?ws=needs' }, [KEY]: { slug: 'garden', tab: 'needs', from: null } };
  withPanel(reload, () => {
    assert.equal(AppView._dropPanelAddressStamp(), true);
    assert.equal(reload.entries[0].url.pathname, '/app/garden/dev/issues/12');
    assert.deepEqual(reload.entries[0].state, { [KEY]: { slug: 'garden', tab: 'needs', from: null } });
    assert.equal(AppView._dropPanelAddressStamp(), false);
  });
  const route = read('public/js/app.js');
  assert.match(route, /_routeFromHash\(\) \{\n\s*if \(typeof AppView !== 'undefined'\) AppView\._leavePanelAddress\?\.\(\);/,
    'before the router reads the address');
  assert.match(APP_VIEW, /else AppView\._devTopicInPanel = false;\n\s*if \(subTab === 'topic'\) AppView\._dropPanelAddressStamp\(\);/,
    'a topic page on the panel\'s address (a reload of it) takes the stamp off');
  assert.match(route, /\} else if \(sec === 'issues' && parts\[4\]\) \{\s*subTab = 'topic';/, 'a reload of dev/issues/<n> is the request\'s page');
  assert.match(route, /\} else if \(sec === 'changes' && App\._changeNumber\(parts\[4\]\)\) \{\s*subTab = 'topic';/, 'and dev/changes/<N> the change\'s');
});

test('#6110: the panel\'s address is where the side panel opens and closes, and a page opened from it steps on top of the Workshop', () => {
  const open = APP_VIEW.slice(APP_VIEW.indexOf('  async openTopicInPanel(kind, id) {'), APP_VIEW.indexOf('  closeTopicPanel(kind, id) {'));
  assert.match(open, /AppView\._devTopicInPanel = true;\s*AppView\._followPanelAddress\(kind, id\);/, 'once the panel holds the item');
  assert.match(APP_VIEW, /closeTopicPanel\(kind, id\) \{\s*AppView\._restorePanelAddress\(\);/, 'the page\'s address comes back whatever else the close does');
  const full = APP_VIEW.slice(APP_VIEW.indexOf('  openTopic(kind, id, options) {'), APP_VIEW.indexOf('  _devTopicInPanel: false,'));
  assert.match(full, /AppView\._restorePanelAddress\(\);\s*if \(typeof App !== 'undefined' && App\.switchTab\) \{/,
    '"Open as a page" (and a link inside the panel) writes the page\'s route over the Workshop\'s address, so Back returns to the Workshop');
  // The same address openTopic writes: App._appUrl with the topic ref.
  assert.match(APP_VIEW, /_panelItemAddress\(kind, id\) \{[\s\S]*?return App\._appUrl\(App\.currentApp, 'dev', ref, 'topic'\);/);
  assert.match(APP_VIEW, /const pr = kind === 'proposal' \? Number\(AppView\._findItem\('proposal', id\)\?\.pr_number\) : 0;\s*const ref = Number\.isInteger\(pr\) && pr > 0 \? \{ kind, id, pr \} : \{ kind, id \};\s*return App\._appUrl\(App\.currentApp, 'dev', ref, 'topic'\);/);
});

test('#6110: a write of the page\'s own address waits while the panel holds an item', () => {
  // A sheet opening over the Workshop (App._restoreAddressUnderSheet) or a
  // same-screen dispatch asks updateHash for the page's address, which
  // would take the item's off the bar while the panel is still open.
  const win = fakeWindow('/app/garden/workshop?ws=needs');
  const writes = [];
  const ctx = vm.createContext({
    location: win.location, history: win.history, URL, AppView,
    DevChat: undefined,
  });
  const App = vm.runInContext(`const App = { _isRestoring: false, currentApp: 'garden', currentTab: 'dev', currentSubTab: 'forum',
    chromeless: false, _historyPushes: 0,
    _appUrl: () => '/app/garden/workshop?ws=needs', _rootUrl: () => '/', _noteWorkshopView() {},
    ${liftAppMethod('updateHash(options)')} }; App`, ctx);
  withPanel(win, () => {
    AppView._followPanelAddress('issue', 12);
    App.updateHash({ replace: true });
    assert.equal(win.entries[0].url.pathname, '/app/garden/dev/issues/12', 'the item\'s address stays');
    App.updateHash();
    assert.equal(win.entries.length, 1, 'and nothing is pushed over it');
    assert.equal(win.entries[0].url.pathname, '/app/garden/dev/issues/12');
    // Closed: the next write is the page's own, as before.
    AppView._restorePanelAddress();
    App.updateHash({ replace: true });
    assert.equal(win.entries[0].url.href, `${ORIGIN}/app/garden/workshop?ws=needs`);
    assert.equal(writes.length, 0);
  });
});
