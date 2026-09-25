'use strict';

// #platform-tabs — the shell's five sections as a permanent bar.
//
// Three things are checked here, and each one is a way the bar can be wrong
// while every structural test in the suite still passes:
//
//   1. THE MAP IS COMPLETE. Five tabs cover ten screen roots, so a root added
//      later falls through to "no tab" and the bar simply goes blank on it —
//      no throw, no failing selector, just a bar that stops answering where
//      you are. This asserts the map against App.SCREEN_IDS itself.
//   2. THE RENDER MATCHES THE PRERENDER. The bar is an island in a document
//      React hydrates, so a first client render that disagrees with the
//      prerendered markup console.errors, and a console error on any route
//      fails proposal checks. The initial store state has to produce exactly
//      the shipped markup: no `aria-current`, a hidden empty badge.
//   3. ONE PLACE DECIDES WHETHER IT IS THERE. Three unrelated code paths hide
//      it (a running app, chromeless, the signed-out shell) and they all go
//      through App._syncPlatformTabs. This runs the real function.
//
// The CSS reservation is checked too, because the bar is out of flow: nothing
// holds its band open automatically, and the rules that do are in a different
// file from the one that sets the bar's height.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const appSource = read('public/js/app.js');
const css = read('public/css/app.css');

// ── 1. The map ────────────────────────────────────────────────────────

test('every screen root but the app view belongs to a tab', () => {
  const { TAB_FOR_SCREEN } = loadTsx('frontend/src/features/nav/nav-store.js');
  const match = appSource.match(/SCREEN_IDS:\s*(\[[^\]]*\])/);
  assert.ok(match, 'App.SCREEN_IDS is an array literal in app.js');
  const roots = JSON.parse(match[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));

  const unmapped = roots.filter((id) => id !== 'app-view' && !TAB_FOR_SCREEN[id]);
  assert.deepEqual(unmapped, [],
    'screen roots with no tab — add them to TAB_FOR_SCREEN in features/nav/nav-store.js, '
    + 'or the bar goes blank on those routes: ' + unmapped.join(', '));

  // The other direction, so a root that is retired cannot leave a dead entry
  // pointing at nothing.
  const stale = Object.keys(TAB_FOR_SCREEN).filter((id) => !roots.includes(id));
  assert.deepEqual(stale, [], 'TAB_FOR_SCREEN names roots App.SCREEN_IDS does not');

  // #app-view is absent ON PURPOSE — the bar is hidden inside a running app —
  // and the assertion above would also pass if someone added it, so say it.
  assert.equal(TAB_FOR_SCREEN['app-view'], undefined,
    'the app view is not one of the platform\'s sections; the bar is hidden there');
});

test('the five tabs are the five the bar renders', () => {
  const { TAB_FOR_SCREEN } = loadTsx('frontend/src/features/nav/nav-store.js');
  const sections = [...new Set(Object.values(TAB_FOR_SCREEN))].sort();
  assert.deepEqual(sections, ['discover', 'home', 'me', 'messages', 'workshop']);
});

// ── 2. The render ─────────────────────────────────────────────────────

test('the initial render is the markup the prerender ships', () => {
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});

  for (const key of ['home', 'discover', 'messages', 'workshop', 'me']) {
    assert.match(html, new RegExp(`id="platform-tab-${key}"`), `#platform-tab-${key} renders`);
  }
  assert.match(html, /id="platform-tabs"/);

  // NO tab is lit before the router has said anything. The store's INITIAL is
  // `tab: null` precisely so this render and the prerendered document agree.
  assert.doesNotMatch(html, /aria-current/,
    'a lit tab in the first render is a hydration mismatch against the prerender');

  // The badge is STRUCTURAL — always in the markup, hidden until it has a
  // count — so a declared check can select it on a cold document.
  assert.match(html, /id="platform-tabs-badge"/);
  assert.match(html, /class="platform-tab-badge hidden"/,
    'the badge ships hidden, with `hidden` constant in the class string');
  assert.doesNotMatch(html, /platform-tab-badge hidden"[^>]*>\s*\d/,
    'the badge ships empty');
});

test('Home is the one tab addressed as a path, so a modified click opens a tab', () => {
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});
  assert.match(html, /id="platform-tab-home"[^>]*href="\/"/);
  for (const [key, href] of [
    ['discover', '#apps'], ['messages', '#messages'],
    ['workshop', '#workshop'], ['me', '#profile'],
  ]) {
    assert.match(html, new RegExp(`id="platform-tab-${key}"[^>]*href="${href.replace('#', '\\#')}"`));
  }
});

// ── 3. One place decides ──────────────────────────────────────────────

function harness() {
  const context = vm.createContext({
    location: new URL('https://homeroom.test/'),
    history: { pushState() {}, replaceState() {} },
    URL, URLSearchParams, console,
    document: {
      title: '',
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
    },
    addEventListener() {},
    localStorage: { getItem: () => null },
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
  });
  context.window = context;
  vm.runInContext(appSource, context);
  const { App } = context;
  const lit = [];
  context.UsernodeReact = { nav: { setScreen: (id) => lit.push(id) } };
  return { App, context, lit, shown: () => App.Visibility.read('platform-tabs') };
}

test('loading app.js with no session hides the bar before React renders', () => {
  // `_applyBootScreen` runs at MODULE SCOPE — app.js is a classic script and
  // the React entry is a deferred module, so this is the last thing that
  // happens before hydration. The harness's document has no session, so the
  // resolver answers the landing screen and the bar is published away with
  // it. Nothing has to reset this for the tests below: they publish their own
  // answer by calling _syncPlatformTabs.
  const { shown } = harness();
  assert.equal(shown(), false);
});

test('the bar is up on a platform screen and down inside an app', () => {
  const { App, shown } = harness();
  App._syncPlatformTabs('messages-screen');
  assert.equal(shown(), true);
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), false);
});

test('chromeless takes the bar with the header', () => {
  const { App, shown } = harness();
  App._syncPlatformTabs('home-screen');
  assert.equal(shown(), true);
  App.setChromeless(true);
  assert.equal(shown(), false, 'setChromeless must re-decide, not only hide the header');
  App.setChromeless(false);
  assert.equal(shown(), true);
});

test('the signed-out shell has nothing to tab to', () => {
  const { App, context, shown } = harness();
  App._syncPlatformTabs('home-screen');
  assert.equal(shown(), true);
  context.AuthScreens = { _current: 'landing' };
  App._syncPlatformTabs();
  assert.equal(shown(), false);
  context.AuthScreens._current = null;
  App._syncPlatformTabs();
  assert.equal(shown(), true);
});

test('a plain "/" boot never swaps screens, and the bar is still up', () => {
  // `_revealedScreen` is null until the first swap, and restoreFromHash's
  // no-hash branch is already-on-home: it calls Home.load() without one. A
  // null read as "no section" would hide the bar on the most-visited route.
  const { App, shown, lit } = harness();
  assert.equal(App._revealedScreen, null);
  App._syncPlatformTabs();
  assert.equal(shown(), true);
  assert.equal(lit.at(-1), 'home-screen');
});

test('the section is published even when the bar is down', () => {
  // Otherwise the store keeps the last one and the bar returns lighting a tab
  // the viewer has since left.
  //
  // THE RAW SCREEN, not the tab, and not null for the app view: the bar has
  // no tab for #app-view and goes away there, but the HEADER reads the same
  // publication to know it is inside an app (its left slot becomes a close
  // button, the app's tile appears beside its name). features/nav/mount.ts
  // derives the tab from it; only the signed-out screens publish nothing.
  const { App, context, lit } = harness();
  App._syncPlatformTabs('workshop-screen');
  assert.equal(lit.at(-1), 'workshop-screen');
  App._syncPlatformTabs('app-view');
  assert.equal(lit.at(-1), 'app-view');
  assert.equal(App.Visibility.read('platform-tabs'), false, 'and the bar is still down');
  context.AuthScreens = { _current: 'landing' };
  App._syncPlatformTabs();
  assert.equal(lit.at(-1), null, 'the signed-out screens are the one nothing');
});

test('a cold boot into an app or the signed-out shell never paints the bar', () => {
  for (const [hash, pathname, signedIn] of [
    ['#app/some-app', '/', true],
    ['#login', '/', false],
    ['', '/app/some-app', true],
  ]) {
    const { App, shown } = harness();
    // The real resolver decides; only the DOM half of the reveal is stubbed,
    // because this harness has no elements for it to toggle.
    const target = App._bootScreenFor(hash, pathname, signedIn);
    assert.ok(target === 'app-view' || target.startsWith('auth-'),
      `${pathname}${hash} resolves to ${target}`);
    App._revealBootScreen = () => {};
    App._bootScreenFor = () => target;
    App._applyBootScreen();
    assert.equal(shown(), false, `${pathname}${hash} painted the bar before the router ran`);
  }

  // ...and a cold boot onto a platform screen leaves the store ALONE, so the
  // bar paints with the document rather than a frame later. Nothing published
  // means "whatever the markup shipped", which is visible.
  const { App, context, shown } = harness();
  delete context.__usernodeVisibility.visible['platform-tabs'];
  App._revealBootScreen = () => {};
  App._bootScreenFor = () => 'workshop-screen';
  App._applyBootScreen();
  assert.equal(shown(), undefined);
});

// ── The band the bar covers ───────────────────────────────────────────

test('the bar spends the home-indicator inset exactly once', () => {
  // The bar is fused to the bottom edge, so its own lower padding covers the
  // strip and `--platform-tabs-h` counts it. Every consumer then takes
  // `max()` of the two rather than adding them — adding is the #4149 bug
  // (`--ws-bar`'s comment above documents the same trap from the other side).
  // #2766: what the bar spends is `--platform-tabs-inset` — the inset itself
  // everywhere but iOS — and the band tokens count that same figure, so the
  // screens clear exactly the bar that is drawn.
  assert.match(css, /\.platform-tabs\s*\{[^}]*padding-bottom:\s*var\(--platform-tabs-inset\)/,
    '.platform-tabs spends the inset itself');
  assert.match(css, /--platform-tabs-inset: var\(--platform-safe-bottom\);/,
    'by default the bar spends the whole inset');
  assert.match(css, /--platform-tabs-h:\s*calc\(56px \+ var\(--platform-tabs-inset, 0px\)\)/,
    'the token is the bar\'s FULL outer height, inset included');

  for (const rule of ['.platform-safe-scroll', '.platform-safe-bar', '.home-body-fill']) {
    const block = css.slice(css.indexOf(`${rule} {`));
    const decl = block.slice(0, block.indexOf('}'));
    assert.match(decl, /max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom\)\)/,
      `${rule} must clear the bar and the inset with max(), never both stacked`);
  }
});

test('the bar sits lower on iOS, and only there (#2766)', () => {
  const rule = /html\.un-ios \{\s*--platform-tabs-inset: ([^;]+);\s*\}/.exec(css);
  assert.ok(rule, 'iOS gets its own, smaller share of the home-indicator strip');
  assert.equal(rule[1], 'max(0px, calc(var(--platform-safe-bottom, 0px) - 14px))',
    'all but 14px of the strip, never negative when the inset is thin');
  assert.doesNotMatch(css, /html\.un-android[^{]*\{[^}]*--platform-tabs-inset/,
    'Android\'s inset is the navigation bar: borrowing from it puts the tabs under it');
});

test('an installed Android app spends the navigation bar\'s full height (#2755)', () => {
  const block = /@media \(display-mode: standalone\), \(display-mode: fullscreen\) \{\s*html\.un-android,\s*html\.un-android #app-view\[data-app-surface="platform"\] \{\s*--platform-safe-bottom: ([^;]+);/.exec(css);
  assert.ok(block, 'standalone Android restates the inset on both the root and the platform surface');
  assert.equal(block[1],
    'max(var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)), env(safe-area-max-inset-bottom, 0px))',
    'the larger of the live inset and the navigation bar\'s full height, still in the kit form');
});

test('a drag that starts on the bar never pans the document (#2771)', () => {
  assert.match(css, /\.platform-tabs\s*\{[^}]*touch-action: none;/);
});

test('the same five tabs stand up at desktop, and the band goes away', () => {
  // A bottom bar is a PHONE shape: at 1280px its five tabs sit 250px apart
  // along the foot of the window, which is a row of unrelated buttons rather
  // than a set of places. Slack, Discord, Teams and Telegram Desktop all turn
  // the same bar into a left rail, and so does this.
  const at = css.indexOf('@media (min-width: 768px) {\n  /* THE BAND AT THE FOOT GOES AWAY');
  assert.ok(at > 0, 'the desktop block must exist, at the shell\'s own md breakpoint');
  const block = css.slice(at, css.indexOf('\n}\n', css.indexOf('.platform-parked-pill {', at)));

  // TWO TOKENS, NOT ONE (#2718 review). `--platform-rail-full` is how wide
  // the rail IS and never changes; `--platform-rail-w` is how much width it
  // RESERVES, and goes to 0 while it is folded or peeking. One number for
  // both drew a 17px sliver — padding and a border around a zero-width
  // column — the first time the rail was peeked over a folded desktop.
  assert.match(css, /--platform-rail-full: 224px;/, 'the rail has a width');
  assert.match(block, /--platform-rail-w: var\(--platform-rail-full\);/,
    'and reserves it while it is up');
  assert.match(block, /--platform-tabs-h: var\(--platform-safe-bottom\);/,
    'and the band at the foot is the home-indicator inset and nothing else');
  assert.match(block, /width: var\(--platform-rail-full\);/,
    'the bar is DRAWN at the full width, never at the reserved one');
  // A FLEX COLUMN, not the phone's grid (#2718 review). Same arrangement —
  // rows at their natural height, packed from the top — said the way that
  // lets Me claim the leftover space at the foot with `margin-top: auto`. In
  // a grid with `align-content: start` an auto margin moves an item only
  // inside its own `max-content` row, which is no movement at all.
  assert.match(block, /display: flex;\s*\n\s*flex-direction: column;/,
    'and stops being five equal columns');
  // The auto margin is on the rule drawn above Me (#2800), which Me follows.
  assert.match(block, /\.platform-tabs::after \{[^}]*order: 1;[^}]*margin: auto 4px 6px;/,
    'Me is the rail\'s foot: the four above are places, this is the reader');
  assert.match(block, /#platform-tab-me \{\s*\n\s*order: 2;/, 'and Me comes after the rule');
  // A GUTTER AFTER THE RAIL, MIRRORED ON THE FAR EDGE (#2718 review). The
  // rail's hairline was the content's left margin, so a card began where the
  // rail ended while the page had air on the right and none on the left — a
  // centred column inside then centred a gutter's width left of the window's
  // middle. Spending the same figure on both sides is what fixes that, and
  // 1.5rem is the shell's own outer gutter rather than a number for this edge.
  assert.match(block, /padding-left: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter\)\);/,
    'the screens move over by PADDING, so nothing about the flex chain moves');
  assert.match(block, /padding-right: var\(--platform-gutter\);/,
    'and the same figure is spent on the far edge');
  assert.match(block, /--platform-gutter: 1\.5rem;/);
  // …and the app view is NOT one of the roots in that list: an app covers the
  // rail, which is what "the app is the whole window" means. The prose above
  // the rule says so, so the check is on the selector itself.
  const roots = block.slice(block.indexOf('  :is(#home-screen'), block.indexOf('padding-left: calc('));
  assert.doesNotMatch(roots, /#app-view/, 'an app covers the rail');
  assert.match(roots, /#messages-screen/, 'every platform root does move over');
  // QA 2026-09-24 Q23: the agent session's own screen drew from the window's
  // edge, under the rail, with its chips and the start of its composer
  // unreachable there.
  assert.match(roots, /#agent-session-screen/, 'the agent session screen moves over too');
  // IT MOVES OVER ANYWAY WHILE ITS RAIL IS UP (#2718 review), through a rule
  // of its own keyed off the bar rather than off the screen id — because
  // `#app-view` is two screens behind one id, and only one of them covers the
  // rail. Keyed off the bar and not off the tab, because the bar is already
  // the answer to that question.
  assert.match(block,
    /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\):not\(\.platform-tabs-folded\)\) #app-view \{\s*padding-left: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter\)\);/);
  // The parked strip is the rail's footer, and its pill becomes a caption
  // because four things do not fit across 224px.
  assert.match(block, /\.platform-parked \{[\s\S]{0,300}width: var\(--platform-rail-full\);/);
  assert.match(block, /\.platform-parked-pill \{[\s\S]{0,200}order: -1;/);
});

test('the rail peeks back over an open app, and reserves nothing while it does', () => {
  // An app covers the rail, which is what makes it feel like a program
  // rather than a page, and on a laptop the pointer is already at the left
  // edge half the time. The navigation comes back on hover and stops
  // spending width while you work.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /id="platform-rail-peek"/, 'a hot zone starts it');
  // TWO WAYS TO HAVE NO RAIL, and the zone answers both (#2718 review): the
  // ROUTE can say there is none (an app) and the VIEWER can fold the one
  // there is (#sidebar-toggle). `!railOpen` rather than the `collapsed` the
  // class toggle below uses, deliberately — `collapsed` is also true on the
  // chromeless and signed-out shells, where a strip that peeked a rail in
  // would be conjuring navigation out of nothing.
  assert.match(bar, /\(screen === 'app-view' && !visible\) \|\| !railOpen \? \(/,
    'and it exists where the rail is out of the way, by either route');
  // NOT a bare `screen === 'app-view'`: the app view is two screens, and on
  // its Workshop the rail is UP. This strip is `z-index: 39` against the
  // rail's 30, so rendering it there lays an invisible 18px column down the
  // left edge of the tabs and swallows the press meant for the one under the
  // pointer.
  assert.ok(!bar.includes("{screen === 'app-view' ? ("),
    'the app view alone is not the question — whether its rail is down is');
  // THE PEEK IS NOT THE BAR'S VISIBILITY. The router still says hidden, the
  // screens reserve no band, and the app is full width; this is an overlay
  // on top of that answer.
  assert.match(bar, /useHiddenClass\(barRef, !visible && !peek\);/);
  assert.match(bar, /const collapsed = !visible \|\| !railOpen;/);
  assert.match(bar, /useClassToggle\(barRef, 'platform-tabs-peek', collapsed && peek\);/);
  assert.match(css, /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\)/,
    'a peeking bar reserves nothing — reflowing the app under the pointer '
    + 'that revealed it is the bug this excludes');
  // A phone has no pointer to hover with, and an invisible strip down the
  // left edge of a touch screen eats the swipe that goes back.
  assert.match(css, /@media \(max-width: 767px\) \{\s*\.platform-rail-peek \{ display: none; \}/);
  // A fade, not a slide: a rail that slides in races the pointer that
  // summoned it and arrives under it.
  assert.match(css, /animation: platform-rail-peek-in 140ms ease-out;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}animation: none;/);
});

test('every screen change clears the peek, and nothing else does', () => {
  // That is what a peek is FOR: you reveal the rail over an app to leave it,
  // and the thing you tapped has now happened. Leaving it set would hand the
  // next screen an overlay rail on top of its own.
  const mount = read('frontend/src/features/nav/mount.ts');
  assert.match(mount,
    /setScreen\(screenId: string \| null, tabOverride\?: string \| null\) \{[\s\S]{0,1400}peek: false/);
  // THE OVERRIDE IS FOR ONE SCREEN (#2718 review): `#app-view` is the running
  // app, which lights nothing, AND the platform's Workshop for that app,
  // which lights Workshop. TAB_FOR_SCREEN cannot say so — a screen in that
  // map is a tab ROOT, and tests/header-back-home.test.js derives "shows no
  // back control" from being in it, which the app view's ✕ contradicts.
  assert.match(mount, /tab: tabOverride \|\| \(screen \? tabForScreen\(screen\) : null\),/);
  assert.match(read('public/js/app.js'),
    /screen === 'app-view' && !inApp\s*\n\s*\? \(App\._isMessagesThread\(\) \? 'messages' : 'workshop'\)/,
    'and app.js is the one place that decides which of the two it is');
  // ON A CHANGE, not on every call. Re-asserting the screen you are already
  // on is not navigation, and clearing there yanks the rail out from under
  // the pointer that summoned it — measured with a harness that re-asserted
  // the current screen on a 100ms timer, which made the rail strobe at
  // exactly that rate. Nothing in the shipped router does that today; the
  // guard is here so that nothing ever can.
  assert.match(mount, /const changed = navStore\.get\(\)\.screen !== screen;/);
  assert.match(mount, /\.\.\.\(changed \? \{ peek: false, peekOut: false \} : null\),/);
});

test('the desktop rail folds by hand, and a phone can never lose its bar', () => {
  // #2718 review: "the sidebar toggle button is missing on desktop". Every
  // host in the study that draws a persistent rail also draws a way to fold
  // it, in the window's top-left corner.
  const toggle = read('frontend/src/features/nav/sidebar-toggle.tsx');
  const navStoreSrc = read('frontend/src/features/nav/nav-store.js');
  const header = read('frontend/src/features/header/platform-header.tsx');

  // THE STATE SHIPS OPEN, which is what makes it safe to hold in the nav
  // store at all: the prerendered document carries a visible bar, so the
  // first client render agrees with it and hydration is silent.
  assert.match(navStoreSrc, /railOpen: true,/);
  assert.match(toggle, /aria-pressed=\{railOpen \? 'true' : 'false'\}/,
    'the state is on the control, so the label can stay the ACTION');
  assert.match(toggle, /aria-label=\{railOpen \? 'Hide sidebar' : 'Show sidebar'\}/);
  assert.match(toggle, /aria-controls="platform-tabs"/);

  // IT IS UNSEEN WHERE THE ROUTE HAS NO RAIL — inside an app, chromeless,
  // signed out — because a toggle for a thing that is not there is a dead
  // control, and an app's rail comes back by pointing at the window's edge.
  // BUT THAT IS CSS'S ANSWER, not a `return null`: see the hydration note
  // further down, and the selector asserted with it.
  assert.ok(!/^import .*visibility-store/m.test(toggle),
    'the route may not reach this component through anything render-time');
  assert.ok(!/^\s*(if \(.*\) )?return null;/m.test(toggle), 'it always renders');

  // IT LIVES IN THE MEASURED LEFT GROUP, so use-header-layout.ts counts it
  // without being told: that hook decides whether the title can centre from
  // the group's inner edge, and a control outside the group is 28px of room
  // it would hand to the title.
  assert.match(header, /<SidebarToggle \/>/);

  // NOTHING ABOUT THE MARKUP VARIES WITH THE RAIL (#2718 review). Both this
  // group's class and the toggle's existence were computed from
  // `useVisibility('platform-tabs')` during render — a store public/js/app.js
  // publishes before this deferred bundle hydrates — so the prerender and the
  // first client render disagreed, and React threw #418 on every route. A
  // console error on any route fails every declared check.
  assert.match(header, /className=\{LEFT_GROUP_CLASS\}/, 'a constant, rendered once');
  assert.match(header, /const LEFT_GROUP_CLASS = '[^']*platform-header-left';/);
  // The header still READS a visibility flag — its own — and that is fine
  // because it spends it through `useHiddenClass`, a ref effect that runs
  // after hydration has already agreed with the prerender. The rule is not
  // "never read the store", it is "never let a read reach the markup".
  const reads = header.match(/^\s*const \w+ = useVisibility\(/gm) || [];
  assert.equal(reads.length, 1, 'one read, and it is not the rail\u2019s');
  assert.match(header, /const visible = useVisibility\('platform-header', true\);\n\s*useHiddenClass\(headerRef, !visible\);/);

  // A PHONE'S BAR IS AT THE FOOT OF THE SCREEN and is the only navigation
  // there is. Folding must never reach it — so the fold is a CLASS that
  // app.css acts on inside the desktop media query and nowhere else, rather
  // than the `hidden` the router uses. A desktop window narrowed to a phone
  // gets its bar back with no store watching the viewport.
  assert.match(read('frontend/src/features/nav/tab-bar.tsx'),
    /useClassToggle\(barRef, 'platform-tabs-folded', !railOpen\);/);
  const folded = css.indexOf('.platform-tabs.platform-tabs-folded:not(.platform-tabs-peek)');
  assert.ok(folded > 0, 'a folded rail is not drawn');
  assert.ok(css.lastIndexOf('@media (min-width: 768px) {', folded) > 0);
  // …and it is not drawn only while it is not peeking, which is what makes
  // the hot zone at the window's edge the way back from folded.
  assert.match(css.slice(folded, folded + 120), /:not\(\.platform-tabs-peek\) \{\s*display: none;/);
  // The toggle itself is desktop-only by the same mechanism, and the group
  // that holds it goes with it when the back slot is empty — an
  // empty-but-present flex item still reserves the header's own `gap-4`,
  // which put the wordmark 16px in from the edge of every root screen the
  // first time this was tried. The id beats Tailwind's own `.flex`, which
  // wins equal-specificity conflicts because app.css loads first.
  assert.match(css, /\.platform-sidebar-toggle \{\n  display: none;\n\}/);
  // All three questions are CSS's, and none is part of hydration: does the
  // rail exist (`#platform-tabs.hidden`), is there room for it (the media
  // query), and has the group anything in it (`:has(> #back-btn.hidden)`).
  assert.match(css,
    /#platform-header \.platform-header-left:has\(> #back-btn\.hidden\) \{\s*\n\s*display: none;/);
  assert.match(css,
    /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-route-hidden\)\) #platform-header\s*\n\s*\.platform-header-left:has\(> #back-btn\.hidden\) \{\s*\n\s*display: flex;/,
    '…unless the toggle is in it, which needs both a rail and the width');
  assert.match(css,
    /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-route-hidden\)\) \.platform-sidebar-toggle \{\s*\n\s*display: inline-flex;/,
    'which is what replaces the `return null` the component used to do');
  // FOLDED RESERVES NOTHING, and only on the desktop layout.
  const zero = css.indexOf('body:has(#platform-tabs.platform-tabs-folded)');
  assert.ok(zero > 0);
  assert.ok(css.lastIndexOf('@media (min-width: 768px) {', zero) > 0,
    'the zeroing rule is inside the desktop block, so a phone never sees it');
  assert.match(css.slice(zero, zero + 120), /\{\s*--platform-rail-w: 0px;/);
});

test('a peek over a running app never brings the sidebar toggle into the app\'s strip', () => {
  // THE BUG: the peek takes `hidden` off #platform-tabs over a running app,
  // and the toggle's rule asked `#platform-tabs:not(.hidden)` alone — so
  // pointing at the window's left edge inside an app drew the toggle into the
  // app's own strip, pushed ✕, the tile and the name 34px right, and a press
  // on it folded the docked rail behind the app.
  //
  // The ROUTE'S answer rides beside the peek's as its own class, applied
  // through a ref like the others (never a rendered className, so nothing
  // about it can reach hydration)…
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /useClassToggle\(barRef, 'platform-tabs-route-hidden', !visible\);/);
  assert.match(bar, /useHiddenClass\(barRef, !visible && !peek\);/,
    'while `hidden` is still the OR of the route and the peek, so the peek works');
  // …and every rule that decides whether the toggle EXISTS reads it. A rail
  // the viewer folded is still the route's rail, so its toggle stays: that is
  // how the fold comes undone.
  const decides = css.match(/body:has\(#platform-tabs:not\(\.hidden\)[^)]*\)[^{]*(?:platform-sidebar-toggle|platform-header-left)[^{]*\{/g) || [];
  assert.equal(decides.length, 2, 'the toggle\'s own rule and its group\'s');
  for (const rule of decides) {
    assert.match(rule, /:not\(\.platform-tabs-route-hidden\)/, rule);
    assert.doesNotMatch(rule, /platform-tabs-folded|platform-tabs-peek/,
      'folding and peeking are not what decides it: the route is');
  }
});

test('the reservation is keyed off the bar\'s own hidden class', () => {
  // No second flag to keep in step: the island publishes `hidden` and the
  // screens read it, the same shape the wallpaper's route test uses.
  assert.match(css, /html:not\(\.un-kb\) body:has\(#platform-tabs:not\(\.hidden\)\)/);
  // Declared on `body` in BOTH branches. A custom property's var()s are
  // substituted on the element it is declared on, so a `:root` declaration
  // would bake in `:root`'s value and never see the override — which is also
  // why the parked strip's rule spells both terms out rather than adding 52px
  // to `--platform-bar-h`.
  assert.match(css, /\nbody \{\n(?:  \/\*[^]*?\*\/\n)?  --platform-bar-h: 0px;/);
  assert.match(css, /--platform-tabs-h: 0px;/);
  assert.match(css, /--platform-rail-w: 0px;\n  --platform-gutter: 0px;\n\}/,
    'and the rail costs a phone no width at all, nor the gutter beside it');
  assert.match(css,
    /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\):has\(#platform-parked:not\(\.hidden\)\) \{\s*--platform-tabs-h: calc\(52px \+ 56px \+ var\(--platform-tabs-inset, 0px\)\);/,
    'the strip adds its own band, and only while the bar is there to sit on '
    + 'for real rather than peeking over an app');
  assert.match(css, /\.platform-parked \{[^}]*bottom: var\(--platform-bar-h, 0px\);/,
    'and it rests ON the bar, so neither reserves the home-indicator twice');
  assert.match(css, /html\.un-kb #platform-tabs \{\s*display: none;/,
    'the keyboard takes the bar with it');
});

// ── The seam, and the foot (#2718 review) ──────────────────────────────

test('the bar and the rail meet as one surface, squared and ruled', () => {
  // The header is `rounded-b-2xl`, which is right while it floats over the
  // page with nothing under its corners. The rail arrives directly beneath
  // its LEFT one, so that 1rem curve cut a bite out of the top of a surface
  // made of the same material — one pane with a chip out of it.
  const at = css.indexOf('WHERE THE BAR MEETS THE RAIL');
  assert.ok(at > 0, 'the rule states its reason');
  const block = css.slice(at, css.indexOf('\n  }\n', css.indexOf('.platform-tabs:not(.platform-tabs-folded)', at)));
  assert.match(block, /#platform-header \{\s*\n\s*border-bottom-left-radius: 0;/,
    'square on the left');
  assert.doesNotMatch(block, /border-bottom-right-radius/,
    'and only on the left: the right corner still has page under it');
  assert.match(block, /\.platform-tabs:not\(\.platform-tabs-folded\) \{\s*\n\s*border-top: 1px solid var\(--app-sheet-line\);/,
    'a hairline across the seam, on the RAIL — a border under the header '
    + 'would run the window\'s whole width and divide the bar from the page too');
  // Keyed off the rail OCCUPYING its column. A folded rail is not there, so
  // the corner keeps its curve; a folded rail peeking is an overlay with the
  // page still underneath, where the curve is right for the same reason it
  // is right over an app.
  assert.match(block, /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-folded\)\)/);
});

test('the desktop band tokens are not outranked by the phone\'s', () => {
  // `:has()` takes the specificity of its most specific ARGUMENT, so the
  // phone rule — whose argument carries one class more — outranked the
  // desktop block and `--platform-bar-h` / `--platform-tabs-h` never once
  // applied. Measured at 1280: `calc(56px + 0px)` and `calc(52px + 56px +
  // 0px)`. The parked strip is placed at `bottom: var(--platform-bar-h)`, so
  // the app you left floated 56px above the bottom-left corner instead of
  // resting in it, and every desktop screen reserved 108px of band at its
  // foot for a bar that is a rail down the side.
  const at = css.indexOf('THE BAND TOKENS NEED THE OTHER RULE\'S SELECTOR, EXACTLY');
  assert.ok(at > 0, 'the rule states its reason');
  const block = css.slice(at, css.indexOf('\n  }\n', css.indexOf(':has(#platform-parked', at)));
  // Character for character with the rule it has to beat, which is also the
  // right selector on its own terms: a PEEKING rail reserves nothing.
  assert.match(block, /html:not\(\.un-kb\) body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\) \{\s*\n\s*--platform-bar-h: 0px;\s*\n\s*--platform-tabs-h: var\(--platform-safe-bottom\);/);
  assert.match(block, /:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\):has\(#platform-parked:not\(\.hidden\)\)/);
  // And the parked strip rests ON the Me row rather than over it, through
  // one token so the two cannot drift.
  assert.match(css, /--platform-rail-foot-h: 52px;/);
  assert.match(css, /\.platform-parked \{\s*\n\s*bottom: calc\(var\(--platform-rail-foot-h\) \+ var\(--platform-safe-bottom, 0px\)\);/);
});

test('a tab label has room for its descenders', () => {
  // `.platform-tab` sets `line-height: 13px` as an absolute — right for the
  // 11px caption under a phone glyph, two pixels short for the rail's 15px
  // row. With `overflow: hidden` on the label the tail of a `g` or a `p` was
  // sliced off flat. Measured at 1280: an 18px ink box in a 13px line box.
  const label = css.slice(css.indexOf('\n.platform-tab-label {'));
  assert.match(label.slice(0, label.indexOf('\n}')), /line-height: 1\.35;/,
    'a unitless multiplier is the one value correct at both sizes');
});

test('the Messages count is the quiet one: grey on the phone, at the row\'s end on the rail (#2912)', () => {
  // Unread messages are counted in the bell as well, so a second RED count on
  // the Messages tab said the same thing twice in the loudest colour on the
  // screen. The bell keeps the red (#notifications-badge is not touched);
  // this badge used to match it on purpose and now deliberately does not.
  const phone = css.match(/\n\.platform-tab-badge \{[^}]*\}/);
  assert.ok(phone, 'the badge has its base (phone) rule');
  assert.match(phone[0], /background: var\(--text-faint, #8e8e93\);/,
    'a grey disc on the phone, one value in both themes');
  assert.doesNotMatch(phone[0], /--danger|#ef4444/, 'the red is the bell\'s alone');
  assert.match(phone[0], /position: absolute;\s*top: -3px;\s*left: calc\(100% - 7px\);/,
    'and it keeps its place on the glyph\'s corner');

  // On the rail the count moves to the row's far end, where Recents draws its
  // unread dots, as a pill in the rail's own muted ink. The glyph's wrapper
  // dissolves so the badge is an item of the row, back in the flow, so the
  // label can shrink before it but never run under it.
  const at = css.indexOf('@media (min-width: 768px) {\n  /* THE BAND AT THE FOOT GOES AWAY');
  const block = css.slice(at, css.indexOf('\n}\n', css.indexOf('.platform-parked-pill {', at)));
  assert.match(block, /\n {2}\.platform-tab-mark \{\s*display: contents;\s*\}/,
    'the wrapper dissolves on the rail and only there');
  const rail = block.match(/\n {2}\.platform-tab-badge \{[^}]*\}/);
  assert.ok(rail, 'the rail restyles the badge inside the desktop block');
  for (const decl of [
    /position: static;/, /order: 1;/, /flex: none;/, /margin-left: auto;/,
    /background: color-mix\(in srgb, var\(--text-muted\) 16%, transparent\);/,
    /color: var\(--text-muted\);/,
  ]) assert.match(rail[0], decl);

  // THE MARKUP DOES NOT MOVE, which is what lets the phone keep its anchor
  // and the declared checks keep finding the badge inside the Messages tab.
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});
  assert.match(html,
    /id="platform-tab-messages"[^>]*><span class="platform-tab-mark"><svg[^>]*class="platform-tab-glyph"[\s\S]*?<\/svg><span id="platform-tabs-badge"/,
    'the badge is still the glyph wrapper\'s child, inside #platform-tab-messages');
});

test('the Messages tab cannot be dead, whatever the flag says', () => {
  // navigateToMessages returns EARLY when `_inMessages` is set — routing the
  // island and revealing nothing, because the screen is supposed to be up
  // already. Only navigateToWorkshop and the global-chat route cleared that
  // flag, so Messages → Home → Messages found it still true, took the early
  // return and did nothing at all.
  const appJs = read('public/js/app.js');
  const reveal = appJs.slice(appJs.indexOf('  _showOnlyScreen(revealId, keepAlso) {'));
  assert.match(reveal.slice(0, reveal.indexOf('\n  },\n')),
    /if \(revealId !== 'messages-screen' && App\._inMessages\) App\._exitMessages\(\);/,
    'one clearer, at the choke point every reveal passes through — the same '
    + 'place and the same reasoning as `_appBackHref` beside it');
  // And the early return asks the SCREEN, not just the flag.
  assert.match(appJs,
    /if \(App\._inMessages && App\._isScreenVisible\('messages-screen'\) && messages\?\.isOpen\?\.\(\)\)/);
});

test('an app\'s discussion belongs to Messages, and says so', () => {
  // `dev/chat` is the app's general chat, and it is a row in the Messages
  // inbox — which is why the Workshop's Current status stopped offering it.
  // Lighting Workshop there put the reader in a section they had not been
  // in, and the way out it offered led to the Workshop rather than to the
  // list they opened the thread from.
  assert.match(read('public/js/app.js'),
    /screen === 'app-view' && !inApp\s*\n\s*\? \(App\._isMessagesThread\(\) \? 'messages' : 'workshop'\)/);
  const appJs = read('public/js/app.js');
  const pred = appJs.slice(appJs.indexOf('  _isMessagesThread() {'));
  assert.match(pred.slice(0, pred.indexOf('\n  },')),
    /App\.currentTab === 'dev'\s*&& \(App\.currentSubTab === 'chat' \|\| App\.currentSubTab === 'sessions'\)/,
    'the discussion and a dev session (#2770) are both threads of Messages');
  assert.match(appJs, /if \(App\._isMessagesThread\(\)\) return \['arrow', '#messages'\];/,
    'and the back slot agrees with the tab that lights');
  const appView = read('public/js/app-view.js');
  const branch = appView.slice(appView.indexOf("if (subTab === 'chat') {"));
  assert.match(branch.slice(0, branch.indexOf('\n    }')),
    /App\.setBackIcon\?\.\('arrow', '#messages'\);/,
    'a level inside Messages shows the way up to it');
  // A CHANGE IS AN AGENT CONVERSATION (#2770): its screen hangs off Messages
  // the same way, rather than off the board it used to point at.
  const session = appView.slice(appView.indexOf("if (subTab === 'sessions' && ref) {"));
  assert.match(session.slice(0, session.indexOf('\n    }')),
    /App\.setBackIcon\?\.\('arrow', '#messages'\);/,
    'a dev session shows the way up to Messages');
});

// ── #2824: the lit tab's sliding marker ───────────────────────────────

test('the marker ships bare, so the first render matches the prerender', () => {
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});
  const marker = html.match(/<span[^>]*class="platform-tabs-marker"[^>]*>/);
  assert.ok(marker, 'the marker is part of the bar\'s markup');
  assert.match(marker[0], /aria-hidden="true"/, 'aria-current already announces the lit tab');
  assert.doesNotMatch(marker[0], /style=|data-marker-at|data-marker-slide/,
    'unmeasured: no geometry and not visible, or hydration disagrees and it slides in from the edge');
  // Rendered BEFORE the tabs so it paints behind them.
  assert.ok(html.indexOf('platform-tabs-marker') < html.indexOf('id="platform-tab-home"'));
});

test('the marker is an inset of the lit tab, and an unlaid-out bar keeps the last box', () => {
  const { markerBoxFor } = loadTsx('frontend/src/features/nav/tab-bar.tsx');
  assert.deepEqual(
    { ...markerBoxFor({ offsetLeft: 150, offsetTop: 0, offsetWidth: 72, offsetHeight: 56 }) },
    { x: 154, y: 4, w: 64, h: 48 },
  );
  assert.equal(markerBoxFor({ offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0 }), null,
    'a hidden bar (an app, the keyboard) has no geometry to report');
});

test('only a selection change slides, the Workshop\'s way (#2824)', () => {
  const src = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(src, /slide: !!prev && selectionChanged/,
    'the first placement and a re-measure land; only a new tab slides');
  assert.match(src, /new ResizeObserver\(\(\) => \{ if \(!cancelSlide\) measure\(false\); \}\)/);
  assert.match(src, /querySelector<HTMLElement>\('\.platform-tab\[aria-current="page"\]'\)/,
    'the marker follows the same attribute the declared checks and screen readers read');
});

// #3046: on the phone a tab press swaps the whole screen synchronously, so
// the first frame after it is the expensive one. A transition written in that
// frame had spent its duration before anything painted and showed only the
// tail of the slide. The slide therefore starts two frames out.
test('a slide waits out the screen swap\'s frame before it starts (#3046)', () => {
  const { afterNextFrame } = loadTsx('frontend/src/features/nav/tab-bar.tsx');
  const queue = [];
  let nextId = 0;
  const raf = (cb) => { queue.push(cb); nextId += 1; return nextId; };
  const cancelled = [];
  const caf = (id) => cancelled.push(id);
  let ran = 0;
  afterNextFrame(() => { ran += 1; }, raf, caf);
  assert.equal(ran, 0, 'not in the press\'s own task');
  queue.shift()();
  assert.equal(ran, 0, 'not at the start of the swap\'s frame either — that write lands in it');
  queue.shift()();
  assert.equal(ran, 1, 'once the swap\'s frame has been produced');

  // A second press before it starts cancels the first slide.
  let ran2 = 0;
  const cancel = afterNextFrame(() => { ran2 += 1; }, raf, caf);
  queue.shift()();
  cancel();
  assert.deepEqual(cancelled, [4], 'the pending second frame is cancelled');
  assert.equal(ran2, 0);

  // No rAF (a test environment, a worker): it runs at once.
  let ran3 = 0;
  afterNextFrame(() => { ran3 += 1; }, undefined, undefined);
  assert.equal(ran3, 1);

  const src = read('frontend/src/features/nav/tab-bar.tsx');
  const hook = src.slice(src.indexOf('function useTabMarker('), src.indexOf('export function PlatformTabs()'));
  assert.match(hook, /cancelSlide = afterNextFrame\(\(\) => \{\s*cancelSlide = null;\s*measure\(true\);/,
    'a move from a marked tab re-measures and slides after the frame');
  assert.match(hook, /new ResizeObserver\(\(\) => \{ if \(!cancelSlide\) measure\(false\); \}\)/,
    'the observer\'s delivery on observe() cannot land the marker ahead of its pending slide');
  assert.match(hook, /cancelSlide\?\.\(\);/, 'a tab change or unmount cancels a pending slide');
});

test('the marker is the Workshop\'s blue, on the Workshop\'s curve, phone only', () => {
  const rule = css.match(/\.platform-tabs-marker \{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /position: absolute;/);
  assert.match(rule[0], /background: var\(--brand-tint\);/);
  assert.match(rule[0], /box-shadow: inset 0 0 0 1px var\(--brand-line\);/);
  assert.match(rule[0], /opacity: 0;/, 'hidden until measured');
  assert.match(css, /\.platform-tabs-marker\[data-marker-at\] \{ opacity: 1; \}/);
  assert.match(css,
    /@media \(prefers-reduced-motion: no-preference\) \{\s*\.platform-tabs-marker\[data-marker-slide\] \{\s*transition:\s*transform \.26s cubic-bezier\(\.32, \.72, 0, 1\)/,
    'the slide is the Workshop marker\'s, and reduced motion does without it');
  assert.match(css, /\.platform-tab \{\s*position: relative;\s*z-index: 1;\s*\}/,
    'the tabs sit over the marker');
  // The rail keeps its row fill; the marker is not drawn there.
  const desktop = css.slice(css.indexOf('.platform-tab[aria-current="page"] {\n    background: var(--brand-tint);'));
  assert.match(desktop.slice(0, 400), /\.platform-tabs-marker \{\s*display: none;\s*\}/);
});
