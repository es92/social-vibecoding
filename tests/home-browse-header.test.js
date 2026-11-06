'use strict';

// The Home header, executed end to end.
//
// #1569 made Home's and Browse's headers IDENTICAL, and #2639 then let them
// differ in the back slot alone. One Home (#6361) retired Browse (Discover's
// screen), so what this file pins now is Home's own bar: a root with an
// empty corner and the logotype, the chrome writes deferred until the
// transition, and the slot's answers on the other screens. Execute the
// actual router, then render the actual React header through its store
// bridges. Effects do not run under SSR;
// viewport geometry remains covered by header-height/title-centering tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const APP = read('public/js/app.js');
const ui = loadTsx('tests/fixtures/platform-header-api.ts');
const initialBack = { ...ui.backButtonStore.get() };
const initialTitle = { ...ui.headerTitleStore.get() };
const initialImprove = { ...ui.improveStore.get() };

function harness({ improveAvailable = true, phone = false } = {}) {
  ui.backButtonStore.set(initialBack);
  ui.headerTitleStore.set(initialTitle);
  // Target availability is held steady, as it is on these two platform
  // screens. The authority/data-loading gates have their own coverage in
  // improve-target-leaving-app.test.js.
  ui.improveStore.set({
    ...initialImprove,
    target: improveAvailable ? 'platform' : null,
    slug: improveAvailable ? 'platform-app' : null,
    selfHosted: improveAvailable,
  });
  const writes = [];
  const transitions = [];
  const visible = new Map([['home-screen', true]]);
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, innerHTML: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {},
    });
    return nodes.get(id);
  }
  const sandbox = {
    console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { hash: '', search: '', pathname: '/', origin: 'https://example.test' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: node, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    addEventListener() {},
    // A desktop unless `phone` (no matchMedia reads as the desktop).
    ...(phone ? { matchMedia: () => ({ matches: false, addEventListener() {} }) } : {}),
    PlatformUI: { transition: (fn, options) => transitions.push({ fn, options }) },
    Home: { _apps: [{ slug: 'notes', name: 'Notes' }], load() {}, publishImproveTarget() {} },
    AppView: { close() {}, _teardownDevRoots() {}, _unmountAppFrame() {}, _retireAppFrame() {} },
    UsernodeReact: {
      backButton: { set(mode, href) {
        writes.push({ mode, href });
        ui.backButtonStore.set({ mode, href });
      } },
      headerTitle: { set(text, subtitle) {
        writes.push({ text });
        ui.headerTitleStore.set({ text, subtitle: subtitle || '' });
      } },
    },
  };
  sandbox.window = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(APP, sandbox);
  const { App } = sandbox;
  App.user = { id: 1 };
  App._setScreenVisible = (id, value) => visible.set(id, value);
  App._isScreenVisible = (id) => visible.get(id) === true;
  App.setChromeless = () => {};
  App.updateHash = () => { sandbox.location.hash = ''; };
  const header = () => {
    // homeHref reads the browser bridge on a visible Home button. Supply the
    // same window to the renderer for this synchronous pass, then restore it.
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const previousWindow = globalThis.window;
    globalThis.window = sandbox;
    try {
      const html = renderToHtml(createElement(ui.PlatformHeader));
      const result = html.match(/<header\b[\s\S]*?<\/header>/);
      assert.ok(result, 'the real platform header renders');
      return result[0];
    } finally {
      if (hadWindow) globalThis.window = previousWindow;
      else delete globalThis.window;
    }
  };
  const flush = () => {
    const transition = transitions.shift();
    assert.ok(transition, 'one screen transition is pending');
    transition.fn();
    transition.options?.after?.();
  };
  return { App, header, writes, transitions, visible, flush };
}

// The title label slot: a drawing on the platform's own screens, a word
// everywhere else (#2718 made the heading a plain h1, so there is one
// carrier of the name).
const LABEL = /<span id="header-title-name" class="min-w-0 truncate">[\s\S]*?<\/span>/;
const label = (html) => {
  const found = html.match(LABEL);
  assert.ok(found, 'the header carries the title label slot');
  return found[0];
};
// THE PILL IS GONE (#2718), and its absence is the assertion now. The chip
// wore a tinted 28px surface because it was a control sitting on the page
// ground and had to read as one; the heading is not a control any more, so a
// surface around it would be a button that does nothing. What has to stay is
// the h1's own className, which ./use-header-layout.ts toggles `.is-centered`
// on — a re-rendered class attribute there drops the measurement's own flag.
const TITLE_CLASS = 'flex-1 min-w-0 text-base font-semibold pointer-events-none truncate';

for (const improveAvailable of [true, false]) {
  test(`Home is a root: an empty corner and the logotype, with Improve ${improveAvailable ? 'available' : 'unavailable'}`, () => {
    const h = harness({ improveAvailable });
    h.App._showOnlyScreen('profile-screen');
    h.App.setHeaderTitle('Me');
    const away = h.header();
    h.writes.length = 0;

    h.App.navigateHome();
    assert.deepEqual(h.writes, [], 'no incoming chrome before the outgoing snapshot');
    assert.equal(h.header(), away);
    h.flush();
    const home = h.header();
    // THE GROUP'S CLASS IS A CONSTANT (#2718 review). It holds the desktop
    // sidebar toggle now, and for one round it varied with the rail's
    // visibility so a tab root could show that toggle — which read a store
    // published by a classic script BEFORE this bundle hydrates, so the
    // prerender and the first client render disagreed and React threw #418
    // on every route. Whether the group SHOWS is app.css's question now: it
    // can see the back anchor's `hidden`, the bar's `hidden` and the
    // viewport, and it is not part of hydration. The back ANCHOR inside is
    // still `hidden`, which is the fact a root is held to.
    const EMPTY_SLOT = /<div class="h-7 shrink-0 flex items-center gap-1\.5 min-w-0 platform-header-left">[\s\S]{0,1200}id="back-btn"[^>]*un-touch-target hidden"/;
    assert.match(home, EMPTY_SLOT, 'Home is a root: its slot is hidden');
    assert.match(label(home), /<svg[^>]*\bfill="currentColor"/,
      'Home names the platform with the logotype');
    assert.doesNotMatch(label(home), /Homeroom/,
      'and draws it INSTEAD of the word, not beside it');
    assert.ok(h.writes.every((entry) => !entry.mode || entry.mode === 'none'),
      'no intermediate publish puts a glyph in a root\'s corner');
    assert.ok(home.includes(TITLE_CLASS), 'the h1 keeps its className');
  });
}

// Nothing asserted what the label IS until now — only that the slot existed.
// It is a drawing on the platform's own screens and a word everywhere else,
// so both halves of that switch get a pin here.
test('the header draws the logotype when it names the platform', () => {
  const h = harness();
  h.App._showOnlyScreen('home-screen');
  h.App.setHeaderTitle('Homeroom');
  const header = h.header();
  const mark = label(header);

  assert.match(mark, /<svg\b/, 'the platform is named by the drawing, not the word');
  assert.doesNotMatch(mark, /Homeroom/, 'and the word is not set beside it');
  assert.match(mark, /<svg[^>]*\bfill="currentColor"/,
    'the mark takes the chip ink, so --brand-ink re-inks it across theme and app tone');
  assert.doesNotMatch(mark, /\bdark:/,
    'no hand-written dark variant — currentColor already covers all four combinations');
  // #2718: the h1 takes its accessible name from its CONTENTS now, there
  // being no button with an aria-label to override them. The drawing IS the
  // word, so a role="img", a <title> or an sr-only twin would have it read
  // twice — aria-hidden is still the right call, for a new reason.
  assert.match(mark, /<svg[^>]*\baria-hidden="true"/,
    'the mark is decorative: the screens publish the name in words');
  assert.doesNotMatch(mark, /role="img"|<title>/,
    'so it must not announce the word a second time');

  // h-5 is one of the three heights that belong in a header bar; `text-xl` is
  // the same 20px expressed as type and is banned BY NAME in
  // tests/header-height-parity.test.js, which is why the mark is sized as a box.
  assert.match(mark, /<svg[^>]*\bclass="h-5 w-\[77\.5px\]"/,
    'the mark is 20px tall, with the logotype aspect written out as a literal');
  for (const banned of ['h-8', 'h-9', 'h-10', 'h-12', 'py-2', 'py-3', 'py-4',
    'text-xl', 'text-2xl', 'text-3xl']) {
    assert.ok(!new RegExp(`\\b(?:sm:|md:|lg:)?${banned}\\b`).test(mark),
      `the title label carries no ${banned} — the content row is still 28px`);
  }

  // Everything AROUND the label is untouched.
  assert.ok(header.includes(TITLE_CLASS),
    "the h1 keeps its className, which use-header-layout.ts writes .is-centered onto");
  assert.doesNotMatch(header, /id="header-title"[^>]*<button/,
    'and it is not a control: the menu has its own button (#2718)');
  assert.match(header, /id="header-title-name" class="min-w-0 truncate"/,
    'the named slot and its truncation stay, whatever is inside them');
  assert.doesNotMatch(header, /id="header-subtitle"/, 'Home publishes no subtitle');
});

test('the header writes a name in words for an app, and whenever there is a subtitle', () => {
  const h = harness();
  h.App.setHeaderTitle('Notes', 'Board');
  const header = h.header();
  assert.equal(label(header),
    '<span id="header-title-name" class="min-w-0 truncate">Notes</span>',
    'an app is named in words, in the same slot');
  assert.doesNotMatch(label(header), /<svg/, 'and nothing is drawn in its place');
  assert.match(header, /id="header-subtitle" class="shrink-0/,
    'the subtitle still does not shrink — the name is what truncates');
  assert.match(header, /id="header-subtitle"[\s\S]*?>Board</,
    'and it still says which part of the app you are in');

  // The self-hosted platform app is ITSELF named "Homeroom", so the title
  // string alone is true inside it too. The mark is suppressed there: it has
  // no text baseline for the `items-baseline` line it would share with the
  // subtitle, and no design board covers those screens.
  h.App.setHeaderTitle('Homeroom', 'Workshop');
  const subtitled = h.header();
  assert.equal(label(subtitled),
    '<span id="header-title-name" class="min-w-0 truncate">Homeroom</span>',
    'a subtitled screen keeps the word, even when the word is the platform name');
  assert.match(subtitled, />Workshop</, 'beside the subtitle it shares the line with');
});

test('a tab root shows nothing; a sub-page shows an arrow to its tab', () => {
  // #2718 review. The bar answers "how do I get out of here" for all five
  // roots, so the corner is empty on them; the screens reached FROM one of
  // those roots have a genuine level above and say so with a chevron that
  // lands on it.
  const h = harness();
  for (const screen of ['profile-screen', 'messages-screen']) {
    h.App._showOnlyScreen('home-screen');
    h.App._showOnlyScreen(screen);
    assert.equal(ui.backButtonStore.get().mode, 'none', `${screen} is a root`);
  }
  // One Home (#6361): Needs you, the page left of the Communities screen,
  // is a level under Home.
  for (const [screen, href] of [['settings-screen', '#profile'], ['admin-screen', '#profile'],
    ['leaderboard-screen', '#profile'], ['agent-session-screen', '#messages'], ['workshop-screen', '/']]) {
    h.App._showOnlyScreen('home-screen');
    h.App._showOnlyScreen(screen);
    assert.equal(ui.backButtonStore.get().mode, 'arrow', `${screen} has a level above`);
    assert.equal(ui.backButtonStore.get().href, href, `${screen} goes up to its tab`);
  }
  // On a phone the app view gets the ✕ instead (#2718), which is the
  // same guarantee in a different glyph: leaving somebody else's program is
  // not going up a level, so the slot says "step out" rather than "go up".
  const phone = harness({ phone: true });
  phone.App._showOnlyScreen('home-screen');
  phone.App._showOnlyScreen('app-view');
  assert.equal(ui.backButtonStore.get().mode, 'close', 'an app view offers the way out');
  // On a desktop the rail stays beside the app and is the way out, as on a
  // root: the corner is empty for the sidebar toggle.
  const desktop = harness();
  desktop.App._showOnlyScreen('home-screen');
  desktop.App._showOnlyScreen('app-view');
  assert.equal(ui.backButtonStore.get().mode, 'none', 'the rail beside the app is the way out');
});

test('Home is reachable from the bar, on every platform screen', () => {
  // They were rows of the app chip's menu, which is what this test named.
  // #2718 put them on #platform-tabs, and the guarantee it was written for is
  // the one that matters: both destinations exist, both are reachable without
  // opening anything, and Home's plain click is still routed in place while
  // its href stays a real path so a modified click opens a tab.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /key: 'home' as const[\s\S]{0,400}href: '\/'/);
  // A press on the tab says so, and swaps like any other tab's (#2881).
  assert.match(bar, /\.App\?\.navigateHome\?\.\(\{ viaTab: true \}\)/);
  // Discover was the rail's tab (29 Oct 2026) until One Home (#6361) made
  // its directory Home's Communities to join.
  assert.doesNotMatch(bar, /key: 'discover'/);
  // …and the menu they left carries no platform destination at all.
  const menu = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.doesNotMatch(menu, /id="switcher-row-/);
});
