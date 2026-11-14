'use strict';

// #4703: THE MERGED HEADER, ON A PHONE.
//
// A project page under 768px had two coloured rows at the top: the platform
// header (community switcher, bell, menu), then the place bar — the tray's
// button and the place's name. This change folds the second row into the
// first: the header carries the places button (opening the same tray the
// page owns), then the place's name beside the switcher, and the band draws
// nothing. On a wide window nothing changes: the places list is the section
// column and the bar is the page's title row.
//
// These pin the store hand-off (the page publishes what the header's button
// draws and how its tray opens), the header-side components, the hydration
// safety of both, and the CSS that collapses the band and sizes the header's
// controls.
//
// Run with: node --test tests/header-place.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const DIR = 'frontend/src/features/dev-board/workshop';
const CSS = read('public/css/app.css');

// One bundle for the bar and its store, so the state a test publishes is the
// state the component reads (tests/fixtures/platform-header-api.ts for why).
const ui = loadTsx('tests/fixtures/header-place-api.ts');

test('the page publishes unread and tray with the place, and the store resets both', () => {
  ui.publishPlace('notes-ab12', 'workshop', 4, 3, true);
  assert.deepEqual(ui.placeStore.get(), {
    slug: 'notes-ab12', place: 'workshop', owed: 4, unread: 3, tray: true,
  });
  ui.publishPlace('notes-ab12', 'c:onboarding', 0, 0, false);
  assert.equal(ui.placeStore.get().place, 'c:onboarding');
  assert.equal(ui.placeStore.get().unread, 0);
  // The item panel's flag went with the section column it told (18 Oct 2026).
  assert.doesNotMatch(read(`${DIR}/place-store.ts`), /publishSide|side: boolean/);
  ui.clearPlace('notes-ab12');
  assert.deepEqual(ui.placeStore.get(), {
    slug: null, place: 'status', owed: 0, unread: 0, tray: false,
  });
});

test('toggleTray calls the mounted page\'s toggle and remembers the button for focus', () => {
  ui.publishPlace('notes-ab12', 'workshop', 0, 0, false);
  let toggles = 0;
  const undo = ui.registerTrayToggle('notes-ab12', () => { toggles += 1; });
  const button = { __el: true };
  ui.toggleTray(button);
  assert.equal(toggles, 1, 'the page is mounted for this project, so its toggle runs');
  assert.equal(ui.trayButton(), button, 'the pressed button is where focus returns');
  // Another project's page is mounted: the toggle is not theirs to press.
  ui.publishPlace('other-slug', 'workshop', 0, 0, false);
  ui.toggleTray(null);
  assert.equal(toggles, 1, 'a toggle registered for another slug does not run');
  undo();
  ui.publishPlace('notes-ab12', 'workshop', 0, 0, false);
  ui.toggleTray(null);
  assert.equal(toggles, 1, 'and neither does one that has been unregistered');
  ui.clearPlace('notes-ab12');
});

test('the header\'s place name is the place the page published, a channel by its #handle', () => {
  ui.publishPlace('notes-ab12', 'c:homeroom-bot', 0, 0, false);
  const html = renderToHtml(createElement(ui.HeaderPlaceName, { slug: 'notes-ab12' }));
  assert.match(html,
    /^<span class="header-place-name" data-header-place="" aria-hidden="true"><span class="dev-ws-place-title-hash">#<\/span>homeroom-bot<\/span>$/,
    'a channel by its handle, with a #');
  ui.publishPlace('notes-ab12', 'workshop', 0, 0, false);
  assert.match(renderToHtml(createElement(ui.HeaderPlaceName, { slug: 'notes-ab12' })), />Workshop</);
  ui.publishPlace('notes-ab12', 'needs', 0, 0, false);
  assert.match(renderToHtml(createElement(ui.HeaderPlaceName, { slug: 'notes-ab12' })), />Needs you</);
  // Another project's page is mounted: this route draws nothing.
  assert.equal(renderToHtml(createElement(ui.HeaderPlaceName, { slug: 'other-slug' })), '');
  ui.clearPlace('notes-ab12');
  assert.equal(renderToHtml(createElement(ui.HeaderPlaceName, { slug: 'notes-ab12' })), '',
    'no page mounted, no name');
});

test('the merged header\'s button carries the bar\'s own markup, one class more', () => {
  const html = renderToHtml(createElement(ui.PlacesButton, {
    name: 'Notes', open: false, waiting: '29 to vote', onToggle: () => {}, className: 'header-places-btn',
  }));
  assert.match(html,
    /<button type="button" class="dev-ws-places-btn header-places-btn" data-places-btn="" aria-label="Notes&#x27;s places" aria-expanded="false">/);
  assert.match(html, /<span class="dev-ws-places-dot" data-places-waiting="" aria-hidden="true"><\/span><span class="sr-only"> \(29 to vote\)<\/span><\/button>/);
  assert.doesNotMatch(html, /aria-controls/, 'the header names no tray of its own');
});

test('the page publishes what the header\'s button draws and how its tray opens', () => {
  const WS = read(`${DIR}/workshop.tsx`);
  assert.match(WS, /publishPlace\(v\.slug, tab, owed, unreadElsewhere, trayOpen\)/,
    'unread and tray ride with the place');
  assert.match(WS, /\[v\.slug, v\.loading, tab, owed, unreadElsewhere, trayOpen\]/,
    'and every one of them is a dependency');
  assert.match(WS, /registerTrayToggle\(mine/, 'the header presses the page\'s own tray toggle');
  assert.match(WS, /const header = trayButton\(\);/, 'focus returns to the header\'s button first');
});

test('the header\'s places button asks #5168: the app view must be the screen on show', () => {
  // A project page stays mounted behind the other tabs, and improveStore
  // still names the app, so `mounted !== slug` alone passed on Discover,
  // Home, Messages and Profile and the button drew there. The gate is the
  // same one header-title.tsx's `inApp` reads.
  const src = read(`${DIR}/place-bar.tsx`);
  assert.match(src, /const \{ screen \} = useStoreState\(navStore\);/,
    'the route\'s screen comes from navStore');
  assert.match(src, /if \(!phone \|\| !slug \|\| mounted !== slug \|\| screen !== 'app-view'\) return null;/,
    'and a non-app screen draws nothing');
  // The fixtures bundle the same navStore the component reads, so the
  // render below runs the new hook against the store the router publishes.
  // The phone flag is effect-settled, so a static render cannot show the
  // drawn button on either screen; what the render buys is that the gate
  // does not throw on it, and that the initial store agrees on nothing
  // drawn. The source assertions above are the guard.
  ui.publishPlace('notes-ab12', 'workshop', 4, 3, true);
  try {
    assert.equal(ui.navStore.get().screen, null, 'INITIAL has no screen, like placeStore');
    ui.navStore.set({ ...ui.navStore.get(), screen: 'browse-screen' });
    assert.equal(renderToHtml(createElement(ui.HeaderPlace, { slug: 'notes-ab12', name: 'Notes' })), '',
      'the place is mounted, the screen is not the app view: nothing draws');
    ui.navStore.set({ ...ui.navStore.get(), screen: 'app-view' });
    assert.equal(renderToHtml(createElement(ui.HeaderPlace, { slug: 'notes-ab12', name: 'Notes' })), '',
      'the screen is the app view, but no width is settled yet: nothing draws');
  } finally {
    ui.clearPlace('notes-ab12');
  }
});

test('the prerendered header emits none of the merged row, so hydration is safe', () => {
  // The phone flag and the mounted place are both settled after hydration,
  // so the server render — and the first client render — draw neither the
  // button nor the name, whatever the stores hold (the name's phone-ness
  // itself is app.css's, so the header's code carries no width query).
  const ph = loadTsx('tests/fixtures/platform-header-api.ts');
  const initial = { ...ph.improveStore.get() };
  ph.improveStore.set({
    ...initial,
    slug: 'notes-ab12', tab: 'dev', subTab: 'forum', name: 'Notes',
  });
  ui.publishPlace('notes-ab12', 'workshop', 4, 3, true);
  try {
    const html = renderToHtml(createElement(ph.PlatformHeader));
    assert.match(html, /<header\b/, 'the real platform header renders');
    assert.doesNotMatch(html, /data-places-btn/, 'no places button in the cold document');
    assert.doesNotMatch(html, /data-header-place/, 'and no place name either');
  } finally {
    ph.improveStore.set(initial);
    ui.clearPlace('notes-ab12');
  }
});

test('the band draws nothing on a phone, and keeps the box it is measured by', () => {
  const phone = /@media \(max-width: 767\.98px\) \{\n  \.dev-ws-tabs\.dev-ws-band \{ background: none; pointer-events: none; \}/;
  assert.match(CSS, phone, 'the band paints nothing and takes no taps');
  assert.match(CSS, /\.dev-ws-placebar \.dev-ws-tabtrack \{ height: 0; overflow: hidden; \}/,
    'the row it held is collapsed, the h2 with it, in the DOM still');
  assert.doesNotMatch(CSS, /\.dev-ws-placebar \.dev-ws-places-btn/,
    'the bar draws no button to hide (#6671)');
  // The box survives: the margin and the padding the pinned head and the
  // pull to refresh are measured against are untouched.
  assert.match(CSS, /^\.dev-ws-tabs\.dev-ws-band \{\s*margin: -18px -4px 0;/m);
  assert.match(CSS, /^\.dev-ws-tabs\.dev-ws-band \{\s*margin: -18px -4px 0;[\s\S]*?padding: 18px 8px 0;/m);
});

test('the header\'s merged controls are the bar\'s, sized to the header\'s row', () => {
  assert.match(CSS, /#platform-header \.header-places-btn \{ width: 28px; height: 28px; margin-inline-start: 0; \}/,
    'a 28px control, like the header\'s others');
  assert.match(CSS, /#platform-header \.header-places-btn \.dev-ws-places-dot \{ top: 1px; inset-inline-end: 0; \}/,
    'the dot rides the smaller box');
  assert.match(CSS, /#platform-header \.header-place-name \{[^}]*flex-shrink: 0; min-width: 0; max-width: 45%;/,
    'the place name holds its ground');
  // The name is phone-only by CSS, not a width query in the header's code
  // (#3271): hidden at every width, shown inside the phone block alone.
  assert.match(CSS, /#platform-header \.header-place-name \{ display: none; \}/,
    'the name paints nowhere by default');
  assert.match(CSS, /@media \(max-width: 767\.98px\) \{[^@]*?#platform-header \.header-place-name \{\n    display: inline-block;/,
    'and only a phone shows it');
  // Run six (14 Oct 2026): "Club Votes ⌄ Hub" read as a word slipped under
  // the name's baseline. It is a small quiet tag now, centred on the row.
  assert.match(CSS, /#platform-header \.header-place-name \{[^}]*align-self: center;/,
    'centred on the title\'s line, beside the switcher');
  assert.doesNotMatch(CSS, /#platform-header \.header-place-name \{[^}]*align-self: flex-end;/,
    'no longer dropped to the chip\'s foot');
  assert.match(CSS, /#platform-header \.header-place-name \{[^}]*padding: 2px 8px; border-radius: 999px;\s+background: var\(--brand-tint\); color: var\(--brand-ink\);\s+font-size: 12px; font-weight: 600; line-height: 16px;/,
    'a pill in the header\'s own ink, small');
  // On a project's page that ink is white on the community's tint, as the
  // bell's and the back disc's are.
  assert.match(CSS, /html\[data-community-tint\] body:has\(#app-view:not\(\.hidden\)\) #platform-header \{\n  --fake-glass-tint: var\(--community-tint\);\n  --brand-ink: #fff;\n  --brand-tint: rgba\(255, 255, 255, \.16\);/);
  // The dot's ring is the community tint it sits on, as the band's was.
  assert.match(CSS, /\.dev-ws-places-dot \{[^}]*box-shadow: 0 0 0 2px var\(--community-tint, #2a2e34\);/);
});

test('the left group is not empty while it holds the places button', () => {
  // The group goes when the back slot is empty — which on a project page it
  // is — so the merged button needs its own exception, or it would inherit
  // the group's display: none.
  assert.match(CSS,
    /#platform-header \.platform-header-left:has\(> #back-btn\.hidden\):not\(:has\(> \.header-places-btn\)\):not\(:has\(> \.nav-drawer-back\)\) \{/,
    'the group stays while the button is in it');
});

test('the header\'s own 52px row is the split of 12 and 12 at every width now', () => {
  // #4237's padding rule came out of its 768px wrapper: below 768px the band
  // no longer continues the colour, so the tinted bar ends at its own foot
  // everywhere.
  assert.doesNotMatch(CSS,
    /@media \(min-width: 768px\) \{\s*html\[data-community-tint\][^)]*\) #platform-header \{\s*padding-bottom: 0\.75rem;/,
    'the 12/12 split is no phone rule short');
  assert.match(CSS,
    /^html\[data-community-tint\] body:has\(#app-view:not\(\.hidden\)\) #platform-header \{\n  padding-bottom: 0\.75rem;\n\}/m,
    'and stands at the top level instead');
});

// ── #5683: the header keeps to the community you are in ─────────────────

test('a place is trusted while its community\'s record is unread, and never a channel of another one', () => {
  assert.equal(ui.cachedTopics('nothing-read'), null, 'no record: nothing is known');
  assert.equal(ui.livePlace('nothing-read', 'c:onboarding'), 'c:onboarding',
    'unread record: the page\'s own place stands');
  assert.equal(ui.livePlace('nothing-read', 'status'), 'status');
  assert.equal(ui.livePlace('nothing-read', 'workshop'), 'workshop');
  // The header follows the same rule as the drawer's own switch, so a
  // channel left behind by another community gives way to the Hub.
  assert.match(read(`${DIR}/place-bar.tsx`), /const shown = livePlace\(slug, place\);[\s\S]*\{handle \|\| placeName\(shown\)\}/);
  assert.match(read('frontend/src/features/nav-drawer/nav-drawer.tsx'),
    /pageUp && slug\s*\? livePlace\(slug, placed\.place\)[\s\S]{0,240}: keepPlace\(rememberedPlace\(\), slug \? cachedTopics\(slug\) : null\)/,
    'the drawer checks the page\'s own place too, and its fallback keeps only what the community has');
});
