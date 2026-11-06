// Back/home buttons on secondary screens; Home's root header (#1569).
//
// ── What the bar looked like before ────────────────────────────────────
//
// `mode` was a boolean wearing three names. Only 'arrow' drew anything;
// 'home' meant HIDDEN — a leftover from #1443, which retired the house glyph
// because the chip's menu carries a Home row an inch to its right. True, and
// the cost was five screens with nothing in the bar at all: the app itself,
// Profile, Settings, Admin and Messages. Two more drew a CHEVRON with no
// href, which resolved to home — the right destination behind the wrong
// glyph, promising a level above a root screen that has none.
//
// ── The three modes, and why 'home' was redefined rather than added to ──
//
//   'none'   hidden. Home alone. The Browse list was here too until #2639:
//            you navigate INTO it from Home, so it takes the house like
//            every other such screen.
//   'home'   the house, to home. THE DEFAULT — `_showOnlyScreen` publishes it
//            on other screen swaps, so secondary screens keep a way out.
//   'arrow'  the chevron, one level UP to its own href.
//
// ~40 call sites already spelled the default 'home', and every one of them
// meant "no level above this" — which is exactly the screen that should offer
// home. So the meaning moved and the call sites did not, and the ones that
// had to change are the ones that must NOT offer it: Home itself.
//
// ── The bug this file exists to stop coming back ───────────────────────
//
// The bridge in features/header/mount.ts narrowed `mode` with
// `mode === 'arrow' ? 'arrow' : 'home'`. Correct while 'home' meant hidden,
// and a silent bug the moment it draws: setBackIcon('none') from Home arrived
// as 'home' and put a house on the one screen that must not have one. Every
// layer above was right — app.js computed 'none' and published 'none' — and
// one ternary turned it into its opposite. It took a browser to find; it
// takes one assertion to keep found.
//
// Run with: node --test tests/header-back-home.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { runModules, makeStoreStub } = require('./helpers/bundle-module');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_JS = read('public/js/app.js');
const HEADER = read('frontend/src/features/header/platform-header.tsx');
const STORE = read('frontend/src/features/header/back-button-store.js');
const MOUNT = read('frontend/src/features/header/mount.ts');
const DEV_CHAT = read('frontend/src/features/dev-chat/dev-chat.js');
const IMPROVE_CONTROLLER = read('frontend/src/features/improve/improve-controller.js');
const IMPROVE_STORE = read('frontend/src/features/improve/improve-store.js');

// ── 1. The three modes exist end to end ────────────────────────────────

test('the store declares three modes and prerenders the hidden one', () => {
  assert.match(STORE, /'none'\|'home'\|'arrow'/,
    'the typedef names all three, so an editor and a reader agree');
  const initial = STORE.slice(STORE.indexOf('const INITIAL = {'));
  assert.match(initial.slice(0, initial.indexOf('};')), /mode: 'none'/,
    "INITIAL is 'none': the prerendered anchor ships hidden, and a first "
    + 'client render that disagrees with the document is a hydration '
    + 'mismatch — a console error, which fails proposal checks');
});

test('the bridge narrows to all THREE, not to two', () => {
  // THE REGRESSION. `mode === 'arrow' ? 'arrow' : 'home'` silently turned
  // Home's own 'none' into a house.
  const at = MOUNT.indexOf('bridge.backButton = {');
  assert.ok(at > 0, 'the backButton bridge must exist');
  const body = MOUNT.slice(at, MOUNT.indexOf('\n  };', at));
  assert.match(body, /mode === 'none' \? 'none' : 'home'/,
    "'none' must survive the narrowing — it is the one mode that HIDES the "
    + 'slot, and collapsing it into the default puts a house on Home');
  assert.match(body, /mode === 'arrow' \? 'arrow'/, "…and 'arrow' still wins first");
});

test('setBackIcon maps the four modes and toggles all three glyphs', () => {
  const at = APP_JS.indexOf('  setBackIcon(mode, href) {');
  assert.ok(at > 0, 'setBackIcon must exist');
  const body = APP_JS.slice(at, APP_JS.indexOf('\n  },', at));
  // #2718 added 'close' — the ✕ inside a running app. One expression still
  // owns the mapping and the fallback is unchanged: anything unrecognised
  // falls to 'home' rather than 'none', because an unknown mode should leave
  // a way OFF the screen, not remove one.
  assert.match(body, /const slot = arrow \? 'arrow'\n\s+: mode === 'close' \? 'close'\n\s+: \(mode === 'none' \? 'none' : 'home'\);/,
    'one expression owns the mapping, and anything unrecognised falls to '
    + "'home' rather than 'none' — an unknown mode should leave a way OFF "
    + 'the screen, not remove one');
  assert.match(body, /backButton\?\.set\?\.\(slot, target\)/,
    'and the SAME value is what gets published');
  // The pre-hydration fallback has three nodes to keep in step again.
  assert.match(body, /toggle\('hidden', slot === 'none'\)/, 'the anchor hides on none');
  // EACH GLYPH NAMES ITS OWN MODE. It was `!arrow` / `arrow` — correct while
  // there were two of them and exactly the bug a third introduces, because
  // "not the arrow" silently drew the house for 'close' too.
  assert.match(body, /back-icon-arrow'\)\?\.classList\.toggle\('hidden', slot !== 'arrow'\)/);
  assert.match(body, /back-icon-home'\)\?\.classList\.toggle\('hidden', slot !== 'home'\)/);
  assert.match(body, /back-icon-close'\)\?\.classList\.toggle\('hidden', slot !== 'close'\)/);
});

// ── 2. Home's root-header rule ─────────────────────────────────────────

test('Home is the only root, and it gets that from the shared screen reveal', () => {
  // navigateHome is the obvious one. The other is the unrecognised-hash
  // branch of restoreFromHash, and it is not an edge case: an EMPTY hash is
  // an unrecognised one, so `/` takes it on every cold boot. Miss it and the
  // most-visited screen in the product is the one with the bug.
  const at = APP_JS.indexOf('  _showOnlyScreen(revealId, keepAlso) {');
  const body = APP_JS.slice(at, APP_JS.indexOf('\n  },', at));
  // #2639: Browse used to be grouped with Home here. It is not a root you
  // arrive at, it is one you go to from Home's "Find more apps", and landing
  // there with an empty bar left the chip menu's Home row as the only way
  // back. One rule still owns the answer, and now only Home is exempt.
  // #2718: the answer stopped being a two-way question when the tab bar
  // landed, so it is a TABLE (App._BACK_SLOT) that this one rule reads. A tab
  // ROOT shows nothing — its tab is on screen beside it, so a corner control
  // that goes home is a second way to press a button already in view — a
  // SUB-PAGE shows an arrow to its tab's root, and an APP shows the ✕ that
  // steps out of it.
  assert.match(body, /App\.setBackIcon\(\.\.\.App\._backSlotFor\(revealId\)\);/,
    'one rule, including cold boots and history navigation');
  assert.doesNotMatch(body, /'home-screen' \? 'none'/,
    'the answers live in the table, not in a chain of ternaries here');
  assert.doesNotMatch(APP_JS, /App\.setBackIcon\('none'\)/,
    'no per-entry override briefly shows the house before hiding it');

  for (const [label, anchor] of [
    ['navigateHome', "App._showOnlyScreen('home-screen', ['app-view']);"],
    ['the cold-boot branch', "App._showOnlyScreen('home-screen');"],
  ]) {
    const at = APP_JS.indexOf(anchor);
    assert.ok(at > 0, `${label} must reveal its root through the shared helper`);
  }

  // And neither writes the class by hand any more: #back-btn's className is
  // React's, so a classList write there is undone on the island's next
  // render — and it cannot express three states regardless.
  assert.ok(!/back-btn'\)\.classList\.add\('hidden'\)/.test(APP_JS),
    'no raw classList write into the React-owned anchor');
});

// ── 3. The glyphs ──────────────────────────────────────────────────────

test('the anchor renders both glyphs and hides exactly one', () => {
  assert.match(HEADER, /id="back-icon-arrow"\n\s+className=\{backArrow \? 'w-5 h-5' : 'hidden w-5 h-5'\}/,
    'the chevron shows on arrow');
  // NOT `!backArrow`. With three glyphs, "not the arrow" is two of them, so
  // each names its own mode — the same change public/js/app.js's
  // pre-hydration fallback made for the same reason.
  assert.match(HEADER, /id="back-icon-home"\n\s+className=\{mode === 'home' \? 'w-5 h-5' : 'hidden w-5 h-5'\}/,
    'the house shows on home, and on nothing else');
  assert.match(HEADER, /id="back-icon-close"\n\s+className=\{backClose \? 'w-5 h-5' : 'hidden w-5 h-5'\}/,
    'and the ✕ inside a running app');
  // Both in the COLD DOCUMENT. Rendering only the active one would take an
  // id out of the shipped inventory whenever the initial mode is the other,
  // and that inventory is a contract (tests/shell-id-inventory.test.js).
  assert.match(HEADER, /className=\{BACK_BTN_CLASS \+ \(mode === 'none' \? ' hidden' : ''\)\}/,
    "the anchor itself hides only on 'none'");
  assert.match(HEADER, /aria-label=\{backArrow \? t\('core:header\.back'\) : backClose \? t\('core:header\.closeApp'\) : t\('core:header\.home'\)\}/,
    'and the accessible name follows the glyph — three meanings, three names');
  assert.deepEqual(['back', 'closeApp', 'home'].map((name) => message(`core:header.${name}`)), ['Back', 'Close app', 'Home']);
});

// ── 4. The ladder inside an app ────────────────────────────────────────

test('the route decides where UP is, inside an app', () => {
  const at = HEADER.indexOf('function appRouteUpHref(');
  assert.ok(at > 0, 'the derivation must exist');
  const body = HEADER.slice(at, HEADER.indexOf('\n}', at));
  assert.match(body, /if \(!slug \|\| tab !== 'dev'\) return null;/,
    'the app tab itself has no level above it inside the app — it gets the '
    + '✕, which leaves to the page the app was opened from');
  // #2770 REVERSED THE FALLBACK: a change is an agent conversation, a thread
  // of Messages, so a session with no captured origin goes up to that inbox
  // rather than to the board it used to fall back to.
  assert.match(body, /subTab === 'sessions'\) return sessionOrigin \|\| '#messages';/,
    'a session goes where it was opened from, falling back to Messages');
  // THE DISCUSSION IS A THREAD OF MESSAGES (#2718 review, #2763). The old
  // full-screen route still resolves for a legacy link, and its ‹ climbed to
  // the board — so a bell mention's Back landed on a Workshop the reader had
  // never been on. It agrees with App._backSlotFor now.
  assert.match(body, /subTab === 'chat'\) return '#messages';/,
    'the general chat goes up to the inbox it is a thread of');
  // #2916: A TOPIC IS NOT THIS BAR'S ANY MORE. Its level up is still the
  // board it was opened from, but the control is the "‹ Workshop" chip at the
  // top of the pane, and the bar draws nothing there. So the ladder must not
  // answer for a topic (it would put a chevron back beside the chip); the
  // board it goes to is pinned on `topicBackHref` in section 5b below.
  assert.doesNotMatch(body, /return boardHref\(/,
    'the ladder no longer climbs from a topic: the in-pane chip does');
  assert.match(body, /subTab 'topic'\) falls through on purpose \(#2916\)/,
    'and says so where the row used to be, so it is not "fixed" back in');
  // THE REGRESSION. `#app/${slug}/board` sent a viewer who had opened an
  // issue from the Workshop to the Kanban board — and that route APPLIES its
  // layout (AppView._setViewMode in restoreFromHash's alias block), so the
  // back arrow also rewrote their stored preference on the way.
  assert.ok(!/`#app\/\$\{slug\}\/board`/.test(body),
    'and no literal /board survives in the derivation');
  // AN APP'S WORKSHOP HAS NO BACK CONTROL (#2740 review), any app's — the
  // platform's own (#2843) was the exception this used to carry. It went up
  // to `#app/<slug>/app`: a ‹ from the mark's "Go to workshop" or Expand,
  // and both it and the ✕ the Workshop tab's arrival wore OPENED the app.
  assert.ok(!/`#app\/\$\{slug\}\/app`/.test(body),
    'nothing in the ladder climbs from the Workshop into the running app');
  assert.doesNotMatch(body, /subTab === 'forum'/,
    'the Workshop itself falls through to null: nowhere up to go');
  assert.match(body, /\n  return null;\s*$/, 'and null is the last answer');
});

test('the derived answer outranks the imperative one, and only inside an app', () => {
  // #2718 put ONE thing above the route: the app view's own 'close'. Inside
  // an app the ✕ is the whole way out — the Workshop and the app's other
  // views are rows of the mark's menu now, not a chevron's destination — so
  // a sub-route that used to earn an arrow gets the ✕ instead. The
  // DESTINATION is untouched: resolvedBackHref still prefers the route's
  // up-level href, so ✕ from a session lands on that app's Workshop as ← did.
  // #2916 put one answer between the two: a Workshop topic draws its back
  // in the pane, so the bar's slot is 'none' there whatever setBackIcon last
  // published. It is derived from the same function the chip renders from,
  // which is what keeps the page at exactly one back control.
  assert.match(HEADER, /const mode = backMode === 'close' \? 'close'\n\s+: paneBack \? 'none'\n\s+: \(routeUp \? 'arrow' : backMode\);/,
    'an app view wins outright; a Workshop topic hides the bar\'s slot for the '
    + 'in-pane chip; an app route with a level above it wins over the '
    + 'imperative call; everything else keeps what setBackIcon published');
  assert.match(HEADER, /const paneBack = topicBackHref\(\{\n\s+slug: backSlug, tab: backTab, subTab: backSubTab, boardView, topicOrigin,\n\s+\}\);/,
    'and that topic answer is topicBackHref\'s, the chip\'s own');
  // useBackSlot (24 Oct 2026) is where it is derived now, so the Duo's side
  // strip draws the same back as #back-btn; the header reads it back.
  assert.match(HEADER, /const href = routeUp\n\s+\|\| \(mode === 'home' \? homeHref\(\) : backHref\);/,
    "and 'home' resolves its own href rather than relying on a caller to "
    + 'pass one');
  assert.match(HEADER, /const \{ mode, href: resolvedBackHref, paneBack \} = useBackSlot\(\);/);
});

// ── 5. The session origin, actually executed ───────────────────────────

function loadImprove(initial) {
  const store = makeStoreStub({
    slug: null, tab: 'app', subTab: null, selfHosted: false,
    sessionOrigin: null, topicOrigin: null, boardView: 'workshop', ...initial,
  });
  const sandbox = {
    console, Promise, setTimeout, clearTimeout,
    location: { search: '', hash: '' },
    URLSearchParams,
    document: { getElementById: () => null, addEventListener: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // The REAL store module, in its own scope, so `boardHref` below is the
  // function the header imports rather than a copy of it that can drift.
  // Its `createStore` is the stub above, which is also what the controller
  // then writes into — one store, reached two ways, as in the bundle.
  runModules(sandbox, [['improve-store.js', IMPROVE_STORE]], {
    imports: {
      '../../lib/plain-store.js': { createStore: () => store },
      '../../lib/i18n/runtime': englishPlatformI18n(),
    },
    tail: 'window.__improveStore = { improveStore, boardHref, topicBackHref, topicBackLabel, topicWorkshopHref };',
  });
  // The one surface still listing these sessions. Flip `sheet.open` in a
  // test that needs the reload gate open; it is the notifications sheet's
  // flag, not the Improve panel's — that panel retired (#2718 review).
  const sheet = { open: false };
  runModules(sandbox, [['improve-controller.js', IMPROVE_CONTROLLER]], {
    imports: {
      // The module reads its words through the language runtime: the real one, in English.
      '../../lib/i18n/runtime': englishPlatformI18n(),
      '../apps/app-card.js': { iconViewFor: () => ({}) },
      // THE CONTROLLER PRESENTS NOTHING NOW (#2718 review). It adopted the
      // Improve panel's root through lib/kit-surface and swept the other
      // sheets through lib/sheet-controller; the panel retired, `open()`
      // forwards to the app-context sheet, and both stubs went with it. What
      // it does import is the notifications sheet's own open flag — the one
      // surface still listing these sessions, and the gate on reloading them.
      '../notifications/notifications-sheet-store.js': {
        notificationsSheetStore: { get: () => sheet, subscribe: () => () => {} },
      },
      './improve-store.js': sandbox.__improveStore,
      '../../lib/shell-snapshot': { saveShellSnapshot() {} },
    },
    tail: 'window.__improve = Improve;',
  });
  return {
    Improve: sandbox.__improve, store, sandbox,
    boardHref: sandbox.__improveStore.boardHref,
    topicBackHref: sandbox.__improveStore.topicBackHref,
    topicBackLabel: sandbox.__improveStore.topicBackLabel,
    topicWorkshopHref: sandbox.__improveStore.topicWorkshopHref,
  };
}

test('the first routing pass of a page load captures no origin', () => {
  // A COLD DEEP LINK has no previous screen, and the store cannot say so by
  // itself: its INITIAL is `tab: 'app'`, indistinguishable from having been
  // on the app tab. Reading it as one sent a shared session link's back arrow
  // to a screen the tab had never shown — and on the platform's own app, to
  // one that does not exist.
  const { Improve, store } = loadImprove({ slug: 'demo-app' });
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, null,
    'nothing to go back to, so the header falls back to Messages');
});

test('a door that names its origin wins, once (#2770)', () => {
  // New change and the Messages inbox's session rows record where the
  // session hangs off BEFORE they navigate: the Improve store's `prev` is the
  // last APP route, and Messages is not one.
  const { Improve, store } = loadImprove({ slug: 'demo-app' });
  Improve.setTab('dev', 'forum');
  Improve.enterSessionFrom('#messages');
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, '#messages', 'the named origin is recorded');
  Improve.setTab('dev', 'forum');
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, '#app/demo-app/workshop',
    'and it is taken once, so it cannot outlive the entry it was set for');
  Improve.enterSessionFrom('https://elsewhere.example/');
  assert.equal(Improve._nextSessionOrigin, null, 'only a hash is accepted');
});

test('entering a session serialises the route being left', () => {
  for (const [label, from, expected] of [
    ['the app tab', { tab: 'app', subTab: null }, '#app/demo-app/app'],
    ['the Workshop', { tab: 'dev', subTab: 'forum' }, '#app/demo-app/workshop'],
    ['the general chat', { tab: 'dev', subTab: 'chat' }, '#app/demo-app/dev/chat'],
  ]) {
    const { Improve, store } = loadImprove({ slug: 'demo-app' });
    // The first call is the page's own first routing pass; the second is the
    // navigation being measured.
    Improve.setTab(from.tab, from.subTab);
    Improve.setTab('dev', 'sessions');
    assert.equal(store.state.sessionOrigin, expected,
      `a session opened from ${label} goes back to it`);
  }
});

test('Workshop and Board are one screen in two layouts, and back knows which', () => {
  // The layout IS the route (see the alias block in app.js's
  // restoreFromHash), so an origin that always said "board" would drop the
  // viewer into the other layout of the screen they had just been reading.
  const { Improve, store, sandbox } = loadImprove({ slug: 'demo-app' });
  sandbox.AppView = { _getViewMode: () => 'workshop' };
  Improve.setTab('dev', 'forum');
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, '#app/demo-app/workshop');
});

test('the origin survives hops inside the session and dies on the way out', () => {
  const { Improve, store } = loadImprove({ slug: 'demo-app' });
  Improve.setTab('app');
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, '#app/demo-app/app');
  // A re-publish while still on the session (a preview opening, a lifecycle
  // change) must not overwrite the origin with the session itself.
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, '#app/demo-app/app', 'kept');
  // …and leaving clears it, so it cannot outlive the session it belonged to.
  Improve.setTab('dev', 'forum');
  assert.equal(store.state.sessionOrigin, null, 'cleared on the way out');
});

test("the platform's own app can never be an origin's app tab", () => {
  const { Improve, store } = loadImprove({ slug: 'usernode-x', selfHosted: true });
  Improve.setTab('app');
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, null,
    'it has no app tab to go back to, so the Messages fallback is the answer');
});

// ── 6. The click path agrees with the href ─────────────────────────────

test('leaving a session follows the same origin the arrow shows', () => {
  // A control whose href says one thing and whose handler does another is
  // exactly the bug that made this bar's href "decorative" once before.
  // leaveSession() unconditionally ran App.switchTab('dev') — the Board.
  const at = DEV_CHAT.indexOf('  leaveSession() {');
  assert.ok(at > 0, 'leaveSession must exist');
  const body = DEV_CHAT.slice(at, DEV_CHAT.indexOf('\n  },', at));
  assert.match(body, /const origin = window\.Improve\?\.sessionOrigin\?\.\(\);/,
    'it reads the captured origin through the window bridge — dev-chat.js is '
    + 'loaded as a SCRIPT by a dozen vm harnesses, where a top-level import '
    + 'is a syntax error');
  assert.match(body, /if \(origin[\s\S]{0,80}?location\.hash = origin;/,
    'and goes there');
  // #2770: the fallback is Messages now — a change is an agent conversation
  // and that is its inbox — matching the header's own fallback.
  assert.match(body, /location\.hash = '#messages';/,
    'with Messages the fallback when there is no origin');
  const code = body.replace(/\/\/.*$/gm, '');
  assert.ok(code.indexOf('location.hash = origin') < code.indexOf("location.hash = '#messages'"),
    'the origin is preferred over the fallback, not the other way round');
  assert.doesNotMatch(code, /App\.switchTab\('dev'\)/,
    'and the Board is no longer where a session with no origin goes back to');
});

// ── 5b. Which board "back to the board" means ──────────────────────────

test('boardHref names the layout, and only kanban is the Kanban board', () => {
  const { boardHref } = loadImprove({ slug: 'demo-app' });
  assert.equal(boardHref('demo-app', 'kanban'), '#app/demo-app/board');
  assert.equal(boardHref('demo-app', 'workshop'), '#app/demo-app/workshop');
  // `_getViewMode`'s own terminal fallback is the Workshop, so an unset or
  // unrecognised layout has to land there too rather than on the Board.
  assert.equal(boardHref('demo-app', undefined), '#app/demo-app/workshop',
    'anything that is not kanban is the Workshop');
});

test('the route publishes the layout it was entered from', () => {
  // THE BUG. Opening an issue from the Workshop and pressing back landed on
  // the Kanban board — a screen the viewer had not been on — and because
  // `#app/<slug>/board` APPLIES its layout, it rewrote their stored
  // preference to kanban as it went.
  for (const [mode, expected] of [['workshop', 'workshop'], ['kanban', 'kanban']]) {
    const { Improve, store, sandbox } = loadImprove({ slug: 'demo-app' });
    sandbox.AppView = { _getViewMode: () => mode };
    Improve.setTab('dev', 'forum');
    Improve.setTab('dev', 'topic');
    assert.equal(store.state.boardView, expected,
      `a topic opened from the ${mode} layout goes back to it`);
  }
});

test('the layout is read from AppView, not from the board frame', () => {
  // A COLD DEEP LINK to an issue never mounts a board, so the view-mode store
  // in features/dev-board/view-mode-store.ts — which is seeded at mount —
  // would answer with its own default instead of this viewer's preference.
  // `_getViewMode()` resolves the ?view= override and then localStorage, and
  // needs no board.
  const { Improve, store, sandbox } = loadImprove({ slug: 'demo-app' });
  sandbox.AppView = { _getViewMode: () => 'kanban' };
  Improve.setTab('dev', 'topic');
  assert.equal(store.state.boardView, 'kanban');
  assert.match(IMPROVE_CONTROLLER, /window\.AppView\?\._getViewMode\?\.\(\) === 'kanban'/,
    'and it is that function it asks, through the window bridge');
});

test('with no AppView at all the layout is the Workshop', () => {
  // The prerender and the pre-hydration window both reach this with no
  // AppView on the page yet; falling back to kanban there would put the
  // arrow on a screen chosen by boot order.
  const { Improve, store } = loadImprove({ slug: 'demo-app' });
  Improve.setTab('dev', 'topic');
  assert.equal(store.state.boardView, 'workshop');
});

test('a topic route, and only a topic route, has an in-pane back to its board (#2916)', () => {
  // `topicBackHref` is what the chip renders from AND what the header hides
  // its own slot on, so this table is the whole of "which pages carry the
  // chip instead of the arrow".
  const { topicBackHref } = loadImprove({ slug: 'demo-app' });
  const at = (subTab, extra = {}) => topicBackHref({
    slug: 'demo-app', tab: 'dev', subTab, boardView: 'workshop', ...extra,
  });
  assert.equal(at('topic'), '#app/demo-app/workshop',
    'an issue / proposal / governance vote / shared session goes to its board');
  assert.equal(at('topic', { boardView: 'kanban' }), '#app/demo-app/board',
    '…in the layout it was opened from, never a literal');
  for (const subTab of ['sessions', 'chat', 'forum', null]) {
    assert.equal(at(subTab), null,
      `subTab ${subTab}: no chip (a dev session and the discussion are Messages `
      + 'threads and keep the header arrow; the Workshop has nowhere up to go)');
  }
  assert.equal(at('topic', { tab: 'app' }), null, 'never on the running app');
  assert.equal(at('topic', { slug: null }), null, 'and never without an app');
});

test('a card opened from a Messages conversation goes back to it (#3103)', () => {
  // The shared proposal / issue card in a conversation opens the same topic
  // route the Workshop does. Its back chip went to the Workshop — a screen the
  // reader had not been on — because the only origin a topic knew was its
  // board. The card now names the conversation before it navigates.
  const { Improve, store, topicBackHref, topicBackLabel } = loadImprove({ slug: 'demo-app' });
  const chip = () => topicBackHref(store.state);
  Improve.setTab('dev', 'forum');
  Improve.enterTopicFrom('#messages/42');
  Improve.setTab('dev', 'topic');
  assert.equal(store.state.topicOrigin, '#messages/42', 'the conversation is recorded');
  assert.equal(chip(), '#messages/42', 'and the chip goes back to it');
  assert.equal(topicBackLabel(chip()), 'Messages', 'and says where it goes');
  Improve.setTab('dev', 'topic');
  assert.equal(chip(), '#messages/42',
    'kept when the topic route re-publishes (navigateToApp, once the record loads)');
  Improve.setTab('dev', 'forum');
  assert.equal(store.state.topicOrigin, null, 'dropped by any other route');
  Improve.setTab('dev', 'topic');
  assert.equal(chip(), '#app/demo-app/workshop',
    'so a topic opened from the Workshop still goes back to the Workshop');
  assert.equal(topicBackLabel(chip()), 'Workshop');

  Improve.enterTopicFrom('#messages/app/demo-app');
  Improve.setTab('dev', 'forum');
  Improve.setTab('dev', 'topic');
  assert.equal(chip(), '#messages/app/demo-app',
    'a named origin waits for the topic entry it was set for');
  Improve.clearTopicOrigin();
  assert.equal(store.state.topicOrigin, null,
    'and leaving the app view ends it (App._showOnlyScreen)');
  Improve.enterTopicFrom('https://elsewhere.example/');
  assert.equal(Improve._nextTopicOrigin, null, 'only a hash is accepted');
});

test('a card opened from Messages also offers its Workshop (#3691)', () => {
  // #3103 sent the card's one chip back to the conversation, and left the
  // project the card belongs to with no way in from its page. The second
  // chip is the board the first would have named from the Workshop.
  const { Improve, store, topicBackHref, topicWorkshopHref } = loadImprove({ slug: 'demo-app' });
  const workshop = () => topicWorkshopHref(store.state);
  Improve.setTab('dev', 'forum');
  Improve.enterTopicFrom('#messages/42');
  Improve.setTab('dev', 'topic');
  assert.equal(topicBackHref(store.state), '#messages/42', 'back is still the conversation');
  assert.equal(workshop(), '#app/demo-app/workshop', 'and the Workshop is offered beside it');
  store.set({ boardView: 'kanban' });
  assert.equal(workshop(), '#app/demo-app/board', 'in the layout the board was last in');
  store.set({ boardView: 'workshop' });

  Improve.setTab('dev', 'forum');
  Improve.setTab('dev', 'topic');
  assert.equal(workshop(), null,
    'opened from the Workshop, the one chip already goes there: no second one');
  Improve.enterTopicFrom('#messages/app/demo-app');
  Improve.setTab('dev', 'topic');
  assert.equal(workshop(), '#app/demo-app/workshop', "from the app's own channel too");
  Improve.setTab('dev', 'sessions');
  assert.equal(workshop(), null, 'never off a topic');
  Improve.setTab('app');
  assert.equal(workshop(), null, 'nor on the running app');
});

test('a thread opened from the Homeroom bot tab\'s page goes back there, with its Workshop beside it (29 Oct 2026)', () => {
  const { Improve, store, topicBackHref, topicBackLabel, topicWorkshopHref } = loadImprove({ slug: 'demo-app' });
  Improve.setTab('dev', 'forum');
  Improve.enterTopicFrom('#homeroom-bot');
  Improve.setTab('dev', 'topic');
  assert.equal(topicBackHref(store.state), '#homeroom-bot', 'back is the bot\'s page');
  assert.equal(Improve.topicOrigin(), '#homeroom-bot', 'and the router can read it (App._isBotTopic)');
  assert.equal(topicBackLabel('#homeroom-bot'), 'Homeroom bot');
  assert.equal(topicWorkshopHref(store.state), '#app/demo-app/workshop', 'and the project is offered beside it');
  Improve.setTab('dev', 'forum');
  assert.equal(Improve.topicOrigin(), null, 'gone with the topic');
  assert.equal(topicBackLabel('#homeroom-botanics'), 'Workshop', 'only the bot\'s own address');
});

test('the topic page draws both chips, Messages first, styled alike (#3691)', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const { renderToStaticMarkup } = require(require.resolve('react-dom/server',
    { paths: [path.join(__dirname, '..', 'frontend')] }));
  const React = require(require.resolve('react', { paths: [path.join(__dirname, '..', 'frontend')] }));
  let route;
  const { TopicBack } = loadTsx('frontend/src/features/dev-board/topic/topic-back.tsx', {
    stubs: { '../../../lib/use-store-state': { useStoreState: () => route } },
  });
  const draw = (state) => {
    route = { slug: 'demo-app', tab: 'dev', subTab: 'topic', boardView: 'workshop', topicOrigin: null, ...state };
    return renderToStaticMarkup(React.createElement(TopicBack));
  };
  const chip = (href, label) => `<a class="dev-topic-back un-touch-target" href="${href}" aria-label="Back to ${label}">`;

  const fromMessages = draw({ topicOrigin: '#messages/42' });
  assert.ok(fromMessages.startsWith(`<div class="dev-topic-backs">${chip('#messages/42', 'Messages')}`),
    'the way back comes first, as the one chip did');
  assert.ok(fromMessages.includes(`</a>${chip('#app/demo-app/workshop', 'Workshop')}`),
    "and the Workshop follows it in the same pill, the chip a Workshop-opened card wears");
  assert.equal(fromMessages.match(/class="dev-topic-back /g).length, 2);

  // 29 Oct 2026: from the Homeroom bot tab's page, the same pair, named for it.
  const fromBot = draw({ topicOrigin: '#homeroom-bot' });
  assert.ok(fromBot.startsWith(`<div class="dev-topic-backs">${chip('#homeroom-bot', 'Homeroom bot')}`),
    'the way back to the bot\'s page first');
  assert.ok(fromBot.includes(`</a>${chip('#app/demo-app/workshop', 'Workshop')}`), 'then the project');

  const fromWorkshop = draw({});
  assert.ok(fromWorkshop.startsWith(chip('#app/demo-app/workshop', 'Workshop')),
    'opened from the Workshop, the page is unchanged: one chip, first in .dev-topic');
  assert.ok(!fromWorkshop.includes('dev-topic-backs'), 'with no row around it');
  assert.equal(draw({ subTab: 'sessions' }), '', 'and off a topic, nothing');
});

test('the shared card and the router wire the Messages origin (#3103)', () => {
  const FORMAT = read('frontend/src/features/messages/format.tsx');
  assert.match(FORMAT, /className="messages-object-card"[^>]*onClick=\{\(event\) => recordObjectOrigin\(event, object\.href as string(?:, inboxOnly)?\)\}/,
    'the card anchor records its origin on click, keeping its class and href');
  const fn = FORMAT.slice(FORMAT.indexOf('export function recordObjectOrigin('),
    FORMAT.indexOf('export function ObjectCard('));
  assert.ok(fn.indexOf('isNativeClick?.(event)') !== -1, 'a modified click records nothing');
  assert.match(fn, /here\.startsWith\('#messages'\) \? here : '#messages'/,
    'the origin is the conversation address on screen, or the inbox');
  assert.match(fn, /\/dev\\\/sessions\\\/\/\.test\(href\)\) w\.Improve\?\.enterSessionFrom\?\.\(origin\)/,
    'a shared spec opens a session, whose arrow reads sessionOrigin');
  assert.match(fn, /\(\?:issues\|proposals\|changes\|governance\)\\\/\/\.test\(href\)\) w\.Improve\?\.enterTopicFrom\?\.\(origin\)/,
    'an issue, proposal or governance card opens a topic, whose chip reads topicOrigin');
  assert.match(APP_JS, /if \(revealId !== 'app-view'\) window\.Improve\?\.clearTopicOrigin\?\.\(\);/,
    'App._showOnlyScreen ends the origin with the app-view visit');
});

test('a session origin and the topic chip answer with the same board', () => {
  // One expression, used by both (features/improve/improve-store.js), so the
  // captured origin and the in-pane chip (#2916; the header's arrow before
  // it) cannot name different screens.
  const { Improve, store, sandbox, boardHref } = loadImprove({ slug: 'demo-app' });
  sandbox.AppView = { _getViewMode: () => 'workshop' };
  Improve.setTab('dev', 'forum');
  Improve.setTab('dev', 'sessions');
  assert.equal(store.state.sessionOrigin, boardHref('demo-app', store.state.boardView));
});

test('the accessor the click path reads is published on the controller', () => {
  const { Improve, store } = loadImprove({ slug: 'demo-app' });
  Improve.setTab('app');
  Improve.setTab('dev', 'sessions');
  assert.equal(typeof Improve.sessionOrigin, 'function');
  assert.equal(Improve.sessionOrigin(), store.state.sessionOrigin,
    'one source of truth for the href and the click');
});

// ── 7. The order of the right group ────────────────────────────────────

test('the bell renders BEFORE the mark, to its left', () => {
  // The bell was moved to the far right for a round, on the argument that a
  // standing alert wants a fixed address and Improve's width (which cleared
  // entirely on a screen with no target) moved it. The arrangement was
  // preferred as it had always been: the alert reads inward from the edge and
  // the corner goes to the control that never moves. Both are defensible,
  // which is exactly why the one we ship is pinned — an order nobody asserts
  // is an order that drifts.
  //
  // #2718 retired #improve-btn, so the group is two controls: the bell, then
  // the Homeroom mark. The argument only got stronger — the mark is a fixed
  // 26px tile, so the bell's address is fixed too.
  const group = HEADER.slice(HEADER.indexOf('<div ref={rightGroupRef}'));
  const body = group.slice(0, group.indexOf('</div>\n      </header>'));
  const bell = body.indexOf('id="notifications-btn"');
  const mark = body.indexOf('<PlatformMark />');
  assert.ok(bell > 0 && mark > 0, 'both controls are in the right group');
  assert.ok(bell < mark,
    'the bell first, then the mark — DOM order is visual order in this flex row');
  assert.equal(body.indexOf('<ImproveButton />'), -1,
    'and the Improve pill is not back between them');

  // The bell must stay INSIDE this group. rightGroupRef is what
  // use-header-layout.ts measures as the title's right-hand clearance, so a
  // control moved out of it stops counting toward the centring decision and
  // the title can overlap it.
  assert.ok(HEADER.indexOf('id="notifications-btn"') > HEADER.indexOf('<div ref={rightGroupRef}'),
    'the bell is inside the measured right group');
});

test('the back-slot table and the tab map agree about what is a root', () => {
  // TWO TABLES SAYING ONE THING, which is the shape that rots. App._BACK_SLOT
  // decides what the header's left slot shows for a screen; TAB_FOR_SCREEN
  // decides which tab lights up for the same screen. The rule that binds them
  // is short: a screen that IS its tab's root shows nothing, and a screen that
  // belongs to a tab it is not the root of shows an arrow to that tab's
  // address. So the two are derived from each other here rather than trusted
  // to stay in step by hand.
  const nav = fs.readFileSync(
    path.join(__dirname, '..', 'frontend/src/features/nav/nav-store.js'), 'utf8'
  );
  const tabFor = {};
  const mapBody = nav.match(/TAB_FOR_SCREEN = Object\.freeze\(\{([\s\S]*?)\}\)/)[1];
  for (const line of mapBody.split('\n')) {
    const m = line.match(/'([a-z-]+)': '([a-z]+)'/);
    if (m) tabFor[m[1]] = m[2];
  }
  assert.ok(Object.keys(tabFor).length >= 9, 'the tab map was read');

  const slots = {};
  const slotBody = APP_JS.match(/_BACK_SLOT: \{([\s\S]*?)\n  \},/)[1];
  for (const line of slotBody.split('\n')) {
    const m = line.match(/'([a-z-]+)': \[([^\]]*)\]/);
    if (m) slots[m[1]] = m[2].split(',').map((p) => p.trim().replace(/'/g, ''));
  }

  // The tab bar's own hrefs, so the arrow lands where the tab does rather than
  // at an address this test made up.
  const HREF = { home: '/', messages: '#messages', workshop: '#workshop', me: '#profile', ai: '#homeroom-bot' };
  // The root of each tab: the screen its tab navigates to. #6019: AI is its
  // own page (features/ai/), and Main, the bot's chat, a level under it on
  // the Messages screen; Discover is a page of Home's.
  const ROOT = {
    home: 'home-screen', messages: 'messages-screen',
    workshop: 'workshop-screen', me: 'profile-screen', ai: 'ai-screen',
  };

  for (const [screen, tab] of Object.entries(tabFor)) {
    assert.ok(slots[screen], `${screen} is in the tab map, so it needs a slot`);
    if (ROOT[tab] === screen) {
      assert.deepEqual(slots[screen], ['none'],
        `${screen} is ${tab}'s root, so its corner is empty`);
    } else {
      assert.deepEqual(slots[screen], ['arrow', HREF[tab]],
        `${screen} belongs to ${tab}, so it goes up to ${HREF[tab]}`);
    }
  }
  // An app is neither: leaving somebody else's program is stepping out, not
  // going up, and #app-view is deliberately absent from the tab map.
  assert.deepEqual(slots['app-view'], ['close']);
  assert.ok(!tabFor['app-view'], 'and no tab claims it');

  // THE RAIL'S OWN ANSWERS (29 Oct 2026): a screen the desktop rail lights
  // a tab of its own for is that tab's root there, so _backSlotFor empties
  // its corner at the rail's width. That was Discover alone, retired with
  // One Home (#6361), so the rail and the phone agree on every screen now.
  const railBody = nav.match(/RAIL_TAB_FOR_SCREEN = Object\.freeze\(\{([\s\S]*?)\}\)/)[1];
  const railFor = Object.fromEntries([...railBody.matchAll(/'([a-z-]+)': '([a-z]+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(railFor, {});
  for (const screen of Object.keys(railFor)) {
    assert.match(APP_JS, new RegExp(`if \\(revealId === '${screen}' && App\\._discoverIsTab\\(\\)\\) return \\['none'\\];`),
      `${screen} is a root on the rail`);
  }
});
