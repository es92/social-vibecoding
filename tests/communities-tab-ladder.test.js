'use strict';

// #3701 — pressing the lit Communities tab goes up a level, at every width.
// Holding it on a phone's bar opened "Your communities" until the drawer's
// list replaced that switcher there (18 Oct 2026); a held tab is a press.
//
// The same press did two things by width (#852): on a phone the lit tab
// opened the switcher, on the desktop rail the lit row went to All
// communities. It is one ladder now (frontend/src/features/workshop/
// tab-ladder.ts):
//
//   1. below a community's tabs (All items, a card, a reply thread) → back to
//      the community, on the tab you were on, at its top;
//   2. on one of its tabs, scrolled down → to the top;
//   3. on one of its tabs, at the top → All communities;
//   4. on All communities → to the top, and nothing else.
//
// A step that changes page pushes an entry (#3620). The switcher is the
// header's name on a wide window; nothing on the phone's bar opens it.
//
// What is pinned, each a way it could quietly go back to what it was:
//
//   1. THE LADDER'S TABLE, and where each press lands from each place.
//   2. NO HOLD: the tab carries no long-press handlers and the ladder makes
//      none, so a held tab cannot bring the old switcher back over the drawer.
//   3. THE WIRING: the tab bar's lit press is the ladder at every width and
//      never the switcher; the pages say what is below their tabs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const LADDER_PATH = 'frontend/src/features/workshop/tab-ladder.ts';

/** The ladder with community-scope's call recorded rather than made. */
function loadLadder() {
  const calls = [];
  const mod = loadTsx(LADDER_PATH, {
    stubs: {
      './community-scope': {
        goToCommunity: (slug) => calls.push(['goToCommunity', slug]),
      },
    },
  });
  return { mod, calls };
}

/** A scroller that records where it was asked to go. */
function scroller(id, scrollTop) {
  const el = {
    id,
    scrollTop,
    went: [],
    scrollTo(opts) { this.went.push(opts); this.scrollTop = opts.top; },
    closest(sel) { return sel === '#dev-forum-scroll' ? feed : null; },
  };
  let feed = null;
  el.setFeed = (f) => { feed = f; };
  return el;
}

/** Run `fn` with a stand-in window and document, then put the globals back. */
function withPage({ app = {}, view = {}, screens = {}, reduced = false } = {}, fn) {
  const had = { window: global.window, document: global.document };
  const location = { hash: '' };
  global.window = {
    App: app,
    AppView: view,
    location,
    PlatformUI: { scrollElement: (el) => el },
    matchMedia: (q) => ({ matches: q.includes('reduced-motion') ? reduced : false }),
  };
  global.document = { getElementById: (id) => screens[id] || null };
  try {
    return fn(location);
  } finally {
    global.window = had.window;
    global.document = had.document;
  }
}

test('the ladder: below → up, a tab → its top then the root, the root → its top and nothing more', () => {
  const { mod } = loadLadder();
  const { rungFor } = mod;
  assert.equal(rungFor('below', false), 'up');
  assert.equal(rungFor('below', true), 'up', 'a page below goes up whatever its offset');
  assert.equal(rungFor('tab', true), 'top');
  assert.equal(rungFor('tab', false), 'root');
  assert.equal(rungFor('root', true), 'top');
  assert.equal(rungFor('root', false), 'none', 'All communities at its top: nothing else');
  assert.equal(rungFor(null, true), 'none');
  // The tab a page below goes back to: the one last up, All items' is the
  // Workshop lit over it, and anything unreadable is the hub.
  assert.equal(mod.tabToReturnTo('all'), 'workshop');
  assert.equal(mod.tabToReturnTo('needs'), 'needs');
  assert.equal(mod.tabToReturnTo('discussion'), 'discussion');
  assert.equal(mod.tabToReturnTo('nowhere'), 'status');
  assert.equal(mod.tabToReturnTo(null), 'status');
});

test('step 4: on All communities a press only scrolls, and at the top does nothing', () => {
  const { mod, calls } = loadLadder();
  const list = scroller('workshop-screen', 480);
  withPage({ screens: { 'workshop-screen': list } }, (location) => {
    assert.equal(mod.pressLitTab('workshop-screen'), 'top');
    assert.deepEqual(list.went, [{ top: 0, behavior: 'smooth' }], 'glides to the top');
    assert.equal(mod.pressLitTab('workshop-screen'), 'none');
    assert.equal(list.went.length, 1, 'already at the top: nothing');
    assert.equal(location.hash, '', 'no navigation');
  });
  assert.deepEqual(calls, [], 'never the switcher, never a page');
  // Reduced motion lands rather than glides.
  const again = scroller('workshop-screen', 300);
  withPage({ screens: { 'workshop-screen': again }, reduced: true }, () => {
    mod.pressLitTab('workshop-screen');
    assert.deepEqual(again.went, [{ top: 0, behavior: 'auto' }]);
  });
});

test('step 1 from a card: back to the community on the tab last up, at its top, as a pushed address', () => {
  const { mod, calls } = loadLadder();
  const landed = [];
  const view = {
    _onProjectPage: () => false,
    _workshopTab: () => 'all',
    _landOnTab: (slug, tab) => landed.push([slug, tab]),
  };
  const app = { currentApp: 'garden', _hubHref: (s) => `#app/${s}/workshop` };
  withPage({ app, view }, (location) => {
    assert.equal(mod.pressLitTab('app-view'), 'up');
    assert.deepEqual(landed, [['garden', 'workshop']], 'All items was last up: its Workshop, by the door that forgets the offset');
    assert.equal(location.hash, '#app/garden/workshop', 'a hash assignment: a new entry, as the card chip makes');
  });
  assert.deepEqual(calls, []);
  // The tab last up is the one it opens on.
  const back = [];
  withPage({
    app: { currentApp: 'garden' },
    view: { _onProjectPage: () => false, _workshopTab: () => 'needs', _landOnTab: (s, t) => back.push(t) },
  }, (location) => {
    mod.pressLitTab('app-view');
    assert.deepEqual(back, ['needs']);
    assert.equal(location.hash, '#app/garden/workshop', 'the hub\'s address without App._hubHref too');
  });
});

test('on the project page: All items or a thread goes up first, then the top, then All communities', () => {
  const { mod, calls } = loadLadder();
  const feed = scroller('dev-forum-scroll', 0);
  const host = scroller('host', 0);
  host.setFeed(feed);
  let tab = 'all';
  const ups = [];
  const page = mod.registerLevel({
    slug: 'garden',
    below: () => tab === 'all',
    up: () => { ups.push('workshop'); tab = 'workshop'; },
    host: () => host,
  });
  // Another community's page says nothing about this one.
  const other = mod.registerLevel({ slug: 'club', below: () => true, up: () => ups.push('club') });
  const app = { currentApp: 'garden' };
  const view = { _onProjectPage: (s) => s === 'garden', _landOnTab: () => assert.fail('no door on the page itself') };
  withPage({ app, view }, (location) => {
    feed.scrollTop = 900;
    assert.equal(mod.pressLitTab('app-view'), 'up', 'All items, however far down');
    assert.deepEqual(ups, ['workshop'], 'the page\'s own climb, not another community\'s');
    assert.equal(location.hash, '', 'the page pushes its own tab entry; no address here');
    assert.equal(mod.pressLitTab('app-view'), 'top', 'on the Workshop, scrolled: to the top');
    assert.equal(feed.scrollTop, 0);
    assert.equal(mod.pressLitTab('app-view'), 'root', 'at the top: All communities');
  });
  assert.deepEqual(calls, [['goToCommunity', null]], 'by the switcher\'s own All communities door, which pushes #communities');
  // A reply thread beside the Discussion is a level below it too.
  let thread = true;
  const discussion = mod.registerLevel({ slug: 'garden', below: () => thread, up: () => { thread = false; } });
  withPage({ app, view }, () => {
    assert.equal(mod.pressLitTab('app-view'), 'up');
    assert.equal(thread, false, 'the thread closes');
    assert.equal(mod.pressLitTab('app-view'), 'root');
  });
  page();
  other();
  discussion();
  // Nothing registered (the page still loading): a tab at its top.
  withPage({ app, view }, () => assert.equal(mod.pressLitTab('app-view'), 'root'));
  // A screen the tab is not lit on, or no app: nothing.
  withPage({ app: {}, view }, () => assert.equal(mod.pressLitTab('app-view'), 'none'));
  withPage({ app, view }, () => assert.equal(mod.pressLitTab('home-screen'), 'none'));
});

test('the tab bar: the lit Communities tab is the ladder at every width, and holding it opens nothing', () => {
  const src = read('frontend/src/features/nav/tab-bar.tsx');
  const click = src.slice(src.indexOf('const onTabClick = '), src.indexOf('return (', src.indexOf('const onTabClick = ')));
  assert.match(click, /if \(key === 'workshop' && lit === 'workshop' && tab === 'workshop'\) \{\s*event\.preventDefault\(\);\s*pressLitTab\(screen\);\s*return;\s*\}/);
  // v3: in the sidebar of rows the tab is "All 13 communities" and goes
  // there (a community's own row is the way up its page); on the list it
  // only scrolls. The strip and the phone's bar keep the ladder.
  assert.match(click, /if \(key === 'workshop' && sidebarRows\) \{\s*event\.preventDefault\(\);\s*if \(screen === 'workshop-screen'\) pressLitTab\(screen\);\s*else goToCommunity\(null\);\s*return;\s*\}/);
  assert.doesNotMatch(click, /toggleSwitcher|openSwitcher|matchMedia/,
    'no media query decides it, and a press never opens the switcher');
  assert.doesNotMatch(src, /toggleSwitcher/);
  // No hold: the old switcher would open over the phone's drawer (18 Oct 2026).
  assert.doesNotMatch(src, /createSwitcherHold|holdProps|onContextMenu/);
  const ladder = read(LADDER_PATH);
  assert.doesNotMatch(ladder, /createHold|createSwitcherHold|HOLD_MS|openSwitcher/);
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /#platform-tab-workshop \{\s*-webkit-touch-callout: none;/);
  // The header's name still opens it, unchanged; the Communities screen's
  // title, its second door, left with its list (One Home, #6361).
  const header = read('frontend/src/features/header/header-title.tsx');
  assert.equal((header.match(/onClick=\{\(e\) => toggleSwitcher\('header', e\.currentTarget\)\}/g) || []).length, 1);
});

test('the pages say what is below their tabs: All items on the project page, a reply thread beside its Discussion', () => {
  const workshop = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const climb = /const climb = \(\) => \{([\s\S]*?)\n  \};/.exec(workshop);
  assert.ok(climb, 'the page\'s climb');
  assert.match(climb[1], /const next = pageParent\(was\);/);
  assert.match(climb[1], /callAppView\('_pushWorkshopTab', v\.slug, was, next\);/, 'a new entry, as a tab press pushes');
  assert.doesNotMatch(climb[1], /_upWorkshopTab/);
  assert.match(climb[1], /callAppView\('_saveFeedScroll', v\.slug, 0\);\s*scrollToHead\(hostRef\.current\);/, 'at its top');
  // #4074: the plan is a page under the Hub, as All items is under the
  // Workshop. #4417: and every place but the Hub is a step below it, at
  // depth 1, so a reply thread beside a channel (depth 2) goes first.
  assert.match(workshop, /registerLevel\(\{\s*slug: v\.slug,(?:\s*\/\/[^\n]*)*\s*below: \(\) => tabRef\.current !== 'status',\s*up: \(\) => climbRef\.current\(\),\s*host: \(\) => hostRef\.current,\s*depth: 1,\s*\}\)/);
  const discussion = read('frontend/src/features/dev-board/workshop/project-discussion.tsx');
  assert.match(discussion, /below: \(\) => \(room \? embeddedThreadOpen\(room\) : !!threadRef\.current\),\s*up: \(\) => \{ if \(room\) closeThread\(\); else setThread\(null\); \},\s*\/\/[^\n]*\s*depth: 2,/);
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /export function embeddedThreadOpen\(conversationId: number\): boolean \{\s*return !!state\.route\.embedded && state\.route\.conversationId === conversationId && !!state\.route\.threadRootId;/);
  // The switcher's notes say where it opens from now.
  const switcher = read('frontend/src/features/workshop/community-switcher.tsx');
  // #5290: and from ⌘K, the third place.
  assert.match(switcher, /opens from three places, all through the same store/);
  assert.match(switcher, /The phone's tab held\s*\* opened it too \(#3701\) until the drawer's list replaced it there/);
  assert.doesNotMatch(switcher, /lit sidebar row goes back/);
  assert.match(switcher, /t\.closest\('\[data-community-switch\]'\)/, 'a press on the rail row closes the menu like any other');
});

// ── #5708: a return to the Communities tab keeps the place you left ───
//
// #5040 sent a press from another tab to Needs you while the blue number
// showed, and openPlace wrote `needs` over the place `freshTab()` reads on
// the next mount, so an account with votes waiting always came back to Needs
// you. The number is a count again: every press from another tab resumes the
// remembered view, which pushes the project page and opens the place stored.

test('#5708: the bar has no votes detour, and a return resumes the remembered view', () => {
  const src = read('frontend/src/features/nav/tab-bar.tsx');
  const click = src.slice(src.indexOf('const onTabClick = '), src.indexOf('return (', src.indexOf('const onTabClick = ')));
  assert.doesNotMatch(click, /votes/, 'no press branch keys off the blue number');
  assert.doesNotMatch(src, /goToVotes|openPlace/, 'the bar never routes to Needs you itself');
  assert.doesNotMatch(src, /onVotes|pageOnScreen/);
  // The number itself is unchanged: the badge, its count and its tooltip.
  assert.match(src, /const votes = tabVotes\(scope\);/);
  assert.match(src, /<VotesBadge count=\{votes\} \/>/);
  assert.match(src, /title=\{key === 'workshop' && titleVotes > 0 \? t\('core:tabs\.votesWaiting', \{ count: titleVotes \}\) : undefined\}/,
    'pointed at, the tab says what the number counts, and nothing at zero');
  // The sidebar row is still decided first, and the lit tab is still the ladder.
  const sidebarAt = src.indexOf("if (key === 'workshop' && sidebarRows)");
  const ladderAt = src.indexOf("if (key === 'workshop' && lit === 'workshop' && tab === 'workshop')");
  assert.ok(sidebarAt > 0 && ladderAt > sidebarAt, 'the sidebar row\'s press comes before the lit tab\'s ladder');
  assert.match(src.slice(ladderAt, ladderAt + 200), /pressLitTab\(screen\)/, 'the lit tab is the ladder');
  // Every press from another tab is the tab's own navigation, and that tries
  // the remembered view before the phone's list (#5581).
  assert.match(src, /if \(key !== lit && press\(event\.currentTarget, key, \(\) => goToTab\(key, href\), fallback\)\)/,
    'a press from another tab goes through goToTab');
  const goToTab = src.slice(src.indexOf('function goToTab('), src.indexOf('export function PlatformTabs'));
  const resumeAt = goToTab.indexOf('app?.resumeWorkshopView?.()');
  const listAt = goToTab.indexOf('goToCommunity(null)');
  assert.ok(resumeAt > 0 && listAt > resumeAt, 'goToTab resumes the remembered view before the phone\'s list');
  // And the ladder carries no detour at all.
  const { mod } = loadLadder();
  assert.equal(mod.goToVotes, undefined, 'tab-ladder.ts no longer exports goToVotes');
  assert.equal(mod.onVotes, undefined, 'nor onVotes');
});
