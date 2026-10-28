'use strict';

// The Home and Browse headers, executed end to end.
//
// #1569 made these two IDENTICAL: Browse was read as a peer root of Home, so
// its bar carried no back slot, and this file existed to stop one appearing.
// #2639 reverses that half. Browse is not a root you arrive at — you go there
// from Home's "Find more apps" — and an empty bar left the chip menu's Home
// row as the only way out. So the list now draws the house, and what this
// file pins is the ONE way the two headers differ: that slot, and nothing
// else. Everything #1569 was protecting — the chip, the controls, the
// classes, the wrappers, the deferral of chrome writes until the level
// transition — is unchanged and still asserted below.
// Execute the actual router and Browse controller, then render the actual
// React header through their store bridges. Effects do not run under SSR;
// viewport geometry remains covered by header-height/title-centering tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const APP = read('public/js/app.js');
const BROWSE = read('frontend/src/features/apps/browse.js');
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
  vm.runInContext(BROWSE, sandbox);
  const { App, Browse } = sandbox;
  App.user = { id: 1 };
  App._setScreenVisible = (id, value) => visible.set(id, value);
  App._isScreenVisible = (id) => visible.get(id) === true;
  App.setChromeless = () => {};
  App.updateHash = () => { sandbox.location.hash = ''; };
  Browse._load = () => {}; // No network needed to exercise screen/level chrome.
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
  return { App, Browse, header, writes, transitions, visible, flush };
}

// The LABEL is the ONE thing that may legitimately differ between the two
// root headers: it says where you are, and Home and Browse are different
// places. Blanking exactly it keeps the comparison below an EQUALITY over
// everything else — controls, classes, wrappers, attribute order — which is
// the whole value of this test. It is then asserted on its own terms, rather
// than by substituting one string for the other, which is what stopped
// working when the visible half became a drawing and the spoken half stayed
// a word.
//
// #2718 took the second half away. The label used to be inside a button
// whose aria-label interpolated the same name, so there were two carriers to
// mask; the heading is not a control any more (the menu has its own button —
// features/header/platform-mark.tsx) and there is one.
const LABEL = /<span id="header-title-name" class="min-w-0 truncate">[\s\S]*?<\/span>/;
const label = (html) => {
  const found = html.match(LABEL);
  assert.ok(found, 'the header carries the title label slot');
  return found[0];
};
// #2639: the back slot is the one intended difference between the two
// headers, so the parity comparison masks it and asserts it on its own.
const maskBackSlot = (html) => html
  .replace(/<div class="h-7 shrink-0[^"]*"[\s\S]*?<\/a><\/div>/, '[back slot]')
  .replace(/<div class="h-7 shrink-0[^"]*">\s*<\/div>/, '[back slot]');
const maskChip = (html) => html.replace(label(html), '[title label]');

// THE PILL IS GONE (#2718), and its absence is the assertion now. The chip
// wore a tinted 28px surface because it was a control sitting on the page
// ground and had to read as one; the heading is not a control any more, so a
// surface around it would be a button that does nothing. What has to stay is
// the h1's own className, which ./use-header-layout.ts toggles `.is-centered`
// on — a re-rendered class attribute there drops the measurement's own flag.
const TITLE_CLASS = 'flex-1 min-w-0 text-base font-semibold pointer-events-none truncate';

for (const improveAvailable of [true, false]) {
  test(`Home and Browse differ only in the back slot, with Improve ${improveAvailable ? 'available' : 'unavailable'}`, () => {
    const h = harness({ improveAvailable });
    h.App._showOnlyScreen('home-screen');
    h.App.setHeaderTitle('Homeroom');
    const home = h.header();
    h.writes.length = 0;

    h.App.navigateToBrowse();
    assert.deepEqual(h.writes, [], 'no incoming chrome before the outgoing snapshot');
    assert.equal(h.header(), home);
    h.flush();
    const browse = h.header();
    // #1569 built this comparison to protect one thing: the two screens share
    // a bar, so the controls, the classes and the wrappers must be
    // byte-identical and only the title's words may differ.
    //
    // #2639 made the back slot a second difference and masked it out. #2718's
    // review takes that difference away again: Discover is a tab now, so
    // Browse is a ROOT like Home and both slots are hidden. The mask stays
    // anyway — it costs nothing and the next screen to differ here will want
    // it — but the slots are asserted EQUAL rather than opposite.
    assert.equal(maskChip(maskBackSlot(browse)), maskChip(maskBackSlot(home)),
      'apart from the back slot, only what the title says changes');
    // THE GROUP'S CLASS IS A CONSTANT (#2718 review). It holds the desktop
    // sidebar toggle now, and for one round it varied with the rail's
    // visibility so a tab root could show that toggle — which read a store
    // published by a classic script BEFORE this bundle hydrates, so the
    // prerender and the first client render disagreed and React threw #418
    // on every route. Whether the group SHOWS is app.css's question now: it
    // can see the back anchor's `hidden`, the bar's `hidden` and the
    // viewport, and it is not part of hydration. The back ANCHOR inside is
    // still `hidden`, which is the fact these two screens are compared on.
    const EMPTY_SLOT = /<div class="h-7 shrink-0 flex items-center gap-1\.5 min-w-0 platform-header-left">[\s\S]{0,1200}id="back-btn"[^>]*un-touch-target hidden"/;
    assert.match(home, EMPTY_SLOT, 'Home is a root: its slot is hidden');
    assert.match(browse, EMPTY_SLOT, 'and so is Discover');
    assert.match(label(home), /<svg[^>]*\bfill="currentColor"/,
      'Home names the platform with the logotype');
    assert.doesNotMatch(label(home), /Homeroom/,
      'and draws it INSTEAD of the word, not beside it');
    assert.equal(label(browse),
      '<span id="header-title-name" class="min-w-0 truncate">Discover</span>',
      'Browse names the destination in words, in the same slot');
    // Two writers own this transition — the screen reveal and Browse's own
    // chrome sync — and the LATER one wins, so they have to AGREE or one
    // silently undoes the other inside a single transition. That is exactly
    // how a first attempt at #2639 shipped as a no-op, which is why this is
    // asserted on every write rather than on the final state.
    //
    // They agree on 'none' since #2718 review: Discover is a tab, so its list
    // level is a root and shows no glyph at all.
    assert.ok(h.writes.some((entry) => entry.mode === 'none'));
    assert.ok(h.writes.every((entry) => !entry.mode || entry.mode === 'none'),
      'no intermediate publish puts a glyph in a root\'s corner');

    h.writes.length = 0;
    h.App.navigateHome();
    assert.deepEqual(h.writes, [], 'return navigation also defers its header writes');
    assert.equal(h.header(), browse);
    h.flush();
    assert.equal(h.header(), home);
    assert.ok(h.writes.every((entry) => !entry.mode || entry.mode === 'none'),
      'and going back to the root hides the slot again');
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

test('a cold Browse entry draws no glyph, and a repeated route changes nothing', () => {
  const h = harness();
  h.App.navigateToBrowse();
  assert.deepEqual(h.writes, []);
  h.flush();
  assert.ok(h.writes.every((entry) => !entry.mode || entry.mode === 'none'),
    'a cold entry lands on the empty root slot, with no house in between');
  const header = h.header();
  h.writes.length = 0;
  h.App.navigateToBrowse();
  assert.equal(h.transitions.length, 0, 'duplicate dispatch does not start another transition');
  assert.deepEqual(h.writes, []);
  assert.equal(h.header(), header);
});

test('Browse details retain the arrow to the list, and returning restores the house', () => {
  const h = harness();
  h.App.navigateToBrowse();
  h.flush();
  const listHeader = h.header();
  h.App.navigateToBrowse('notes');
  assert.equal(h.header(), listHeader, 'detail chrome is deferred until the level transition');
  h.flush();
  assert.equal(ui.backButtonStore.get().mode, 'arrow');
  assert.equal(ui.backButtonStore.get().href, '#apps');
  assert.match(h.header(), /id="back-btn"[^>]*aria-label="Back"[^>]*href="#apps"/);

  h.App.navigateToBrowse();
  h.flush();
  assert.equal(h.header(), listHeader);
});

test('a detail opened directly from a Home card has no list to go up to', () => {
  // It offered the house, which was the only way out of a detail reached
  // without a list behind it. The tab bar is that way out now (#2718 review),
  // and an arrow would promise a list level this detail never came through —
  // so the slot is empty, the same as on the list itself.
  const h = harness();
  h.Browse.noteDetailOrigin('home');
  h.App.navigateToBrowse('notes');
  h.flush();
  assert.equal(ui.backButtonStore.get().mode, 'none');
  // The anchor keeps its default aria-label while hidden — 'none' hides the
  // slot rather than renaming it — so the observable is the class on the
  // anchor. Its WRAPPER renders the same class on every route (see the note
  // beside EMPTY_SLOT above): app.css takes the group away when the anchor
  // is hidden and no toggle is showing beside it.
  assert.match(h.header(), /<div class="h-7 shrink-0 flex items-center gap-1\.5 min-w-0 platform-header-left">/);
  assert.match(h.header(), /id="back-btn"[^>]*un-touch-target hidden"/);
});

test('a tab root shows nothing; a sub-page shows an arrow to its tab', () => {
  // #2718 review. The bar answers "how do I get out of here" for all five
  // roots, so the corner is empty on them; the screens reached FROM one of
  // those roots have a genuine level above and say so with a chevron that
  // lands on it.
  const h = harness();
  for (const screen of ['profile-screen', 'messages-screen', 'workshop-screen', 'browse-screen']) {
    h.App._showOnlyScreen('home-screen');
    h.App._showOnlyScreen(screen);
    assert.equal(ui.backButtonStore.get().mode, 'none', `${screen} is a root`);
  }
  for (const [screen, href] of [['settings-screen', '#profile'], ['admin-screen', '#profile'],
    ['leaderboard-screen', '#profile'], ['agent-session-screen', '#messages']]) {
    h.App._showOnlyScreen('home-screen');
    h.App._showOnlyScreen(screen);
    assert.equal(ui.backButtonStore.get().mode, 'arrow', `${screen} has a level above`);
    assert.equal(ui.backButtonStore.get().href, href, `${screen} goes up to its tab`);
  }
  // …and on a phone the app view gets the ✕ instead (#2718), which is the
  // same guarantee in a different glyph: leaving somebody else's program is
  // not going up a level, so the slot says "step out" rather than "go up".
  const phone = harness({ phone: true });
  phone.App._showOnlyScreen('browse-screen');
  phone.App._showOnlyScreen('app-view');
  assert.equal(ui.backButtonStore.get().mode, 'close', 'an app view offers the way out');
  // On a desktop the rail stays beside the app and is the way out, as on a
  // root: the corner is empty for the sidebar toggle.
  const desktop = harness();
  desktop.App._showOnlyScreen('browse-screen');
  desktop.App._showOnlyScreen('app-view');
  assert.equal(ui.backButtonStore.get().mode, 'none', 'the rail beside the app is the way out');
});

test('Home and Discover are reachable from the bar, on every platform screen', () => {
  // They were rows of the app chip's menu, which is what this test named.
  // #2718 put them on #platform-tabs, and the guarantee it was written for is
  // the one that matters: both destinations exist, both are reachable without
  // opening anything, and Home's plain click is still routed in place while
  // its href stays a real path so a modified click opens a tab.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /key: 'home' as const[\s\S]{0,400}href: '\/'/);
  // A press on the tab says so, and swaps like any other tab's (#2881).
  assert.match(bar, /\.App\?\.navigateHome\?\.\(\{ viaTab: true \}\)/);
  assert.match(bar, /key: 'discover' as const, label: 'core:tabs\.discover', href: '#apps'/);
  assert.equal(message('core:tabs.discover'), 'Discover');
  // …and the menu they left carries no platform destination at all.
  const menu = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.doesNotMatch(menu, /id="switcher-row-/);
});
