'use strict';

// The Workshop's scope chip and its totals (#2718).
//
// The screen answers "which of my apps wants something from me": a chip that
// says what you are looking at and narrows it, a legend that totals what is
// owed, and one row per app carrying both of its numbers.
//
// ── What this suite used to pin, and why it does not ──────────────────
//
// A TAB STRIP (Current status / Needs you / All items) and a PLUS. Both are
// retired from this screen on the owner's review, and the reason is worth
// keeping because it is the argument that would bring them back: those three
// words are the APP Workshop's, about one app's items. Up here the list is of
// APPS, each row already showing both figures, so the tabs hid whole apps to
// say what their rows were saying anyway — and the plus asked "which app?"
// before two questions ("propose a change", "report a problem") that can only
// be asked inside an app.
//
// AND THE SCOPE CHIP (#2759). It read "All apps" here and its panel listed
// your apps — but this screen IS that list, every row the way into its app's
// Workshop, so the chip was the page repeating itself. It lives on ONE app's
// Workshop now, where naming the app and offering the others says something.
//
// Three things are still pinned, and each is a way the screens can be quietly
// wrong:
//
//   1. PICKING AN APP NAVIGATES, to that app's own Workshop.
//   2. THE NAVIGATION IS AWAITED, so a refused one cannot read as a
//      completed one.
//   3. THE TOTALS DO NOT REWORD THE LEGEND. A declared check pins the phrase
//      "Votes waiting on you" on this screen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const CHROME = read('frontend/src/features/workshop/workshop-chrome.tsx');
const SCREEN = read('frontend/src/features/workshop/index.tsx');

const screen = loadTsx('frontend/src/features/workshop/index.tsx');
const chrome = loadTsx('frontend/src/features/workshop/workshop-chrome.tsx');

const app = (slug, working, needs) => ({ slug, name: slug, working, needs });

test('picking an app navigates: the chip is the link out', () => {
  assert.match(CHROME, /await win\(\)\.App\?\.navigateToApp\?\.\(slug, 'dev'\);/,
    'picking an app goes to that app’s own Workshop');
  // NEVER DISABLED. The chip is only ever scoped to an app now, and scoped
  // there is always somewhere to go — back up to all of them.
  assert.ok(!/disabled=\{/.test(CHROME), 'the chip is never a dead control');
});

test('the action waits for the navigation', () => {
  // It MATTERED more when the plus's two action rows landed here:
  // navigateToApp resolves once the app view has opened and the Improve
  // controller knows what it is about, and calling startSession() before that
  // started a change on whatever app the panel last pointed at. The scope
  // chip is the only caller left, so nothing runs after the await — the await
  // stays so a refused navigation cannot read as a completed one, and the
  // panel closes either way.
  const at = CHROME.indexOf('async function goToApp(');
  const fn = CHROME.slice(at, CHROME.indexOf('\n}\n', at));
  assert.match(fn, /await win\(\)\.App\?\.navigateToApp\?\.\(slug, 'dev'\);/);
  assert.match(fn, /\} catch \{/, 'and a refusal is caught rather than thrown at the screen');
  assert.ok(!fn.includes('startSession'), 'nothing is started from this screen any more');
  assert.ok(!fn.includes('giveFeedback'), 'nor reported from it');
});

test('the tabs and the plus are gone, and took their panel modes with them', () => {
  for (const id of ['workshop-tabs', 'workshop-tab-status', 'workshop-tab-needs',
    'workshop-tab-all', 'workshop-tab-empty', 'workshop-plus',
    'workshop-plus-change', 'workshop-plus-issue', 'workshop-plus-create']) {
    assert.ok(!CHROME.includes(`id="${id}"`), `#${id} is not rendered`);
    assert.ok(!SCREEN.includes(`id="${id}"`), `#${id} is not on the screen either`);
    assert.ok(!HTML.includes(`id="${id}"`), `#${id} is not in the shipped shell`);
  }
  // The store's `tab` went with the strip: nothing filters this list now, so
  // a field naming which filter is on would be a fact with no reader.
  const store = read('frontend/src/features/workshop/workshop-store.js');
  assert.ok(!/^\s*tab:/m.test(store), 'the store holds no tab');
  assert.ok(!SCREEN.includes('filterRows'), 'and the screen does not filter');
  // #2759: the scope chip went too, and `picker` — its open flag — with it.
  assert.ok(!/picker/.test(store), 'the store holds no panel flag');
  assert.ok(!/WorkshopScope|WorkshopPicker/.test(SCREEN), 'the all-apps screen renders no chip');
  // ONE PANEL COMPONENT, and the ids are the caller's: there is one caller
  // left (an app's own Workshop), and no default spelling to fall back on.
  assert.ok(!/'workshop-(scope|picker)'/.test(CHROME), 'no all-apps ids survive as defaults');
});

test('the legend carries the totals, and says nothing when there is nothing', () => {
  // The design study put three count cards at the top of this screen. The
  // question they answer is real — the rows say which APPS need you, and
  // nothing said how much there is altogether — but a deck above a list whose
  // every row carries the same two figures is the third telling of one fact,
  // so the numbers went into the legend that already names the two glyphs.
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.match(screen, /id="workshop-total-working"/);
  assert.match(screen, /id="workshop-total-needs"/);
  // ACROSS EVERY APP, not the filtered tab: "how much is there" is not a
  // question whose answer should move when you change tabs.
  const at = screen.indexOf('const totals = all');
  const decl = screen.slice(at, screen.indexOf('const empty', at));
  assert.match(decl, /all\.length > 0/,
    'no totals with no apps — the empty card already says why the screen is bare');
  assert.match(decl, /acc\.working \+ \(row\.working \|\| 0\)/);
  assert.match(decl, /acc\.needs \+ \(row\.needs \|\| 0\)/);
  assert.ok(!decl.includes('rows'), 'it sums `all`, not the tab-filtered rows');
  // THE WORDS ARE NOT THE NUMBER'S TO CHANGE, which is the whole reason this
  // assertion exists in this shape. The totals first shipped as "2 working
  // on" / "3 waiting on your vote" — a rewording on the way past — and a
  // declared check pins the phrase "Votes waiting on you" on this screen, so
  // it went red on the platform's own run. The number is additive now: the
  // legend says what it always said and gains a figure at the end.
  assert.match(screen, /You are working on\n\s+\{totals \? <b id="workshop-total-working"/);
  assert.match(screen, /Votes waiting on you\n\s+\{totals \? <b id="workshop-total-needs"/);
  const dapp = JSON.parse(read('dapp.json'));
  const pinned = dapp.tests.find((t) => t.expectText === 'Votes waiting on you');
  assert.ok(pinned, 'the phrase is still a declared check\'s expectText');
  assert.ok(read('public/index.html').includes('Votes waiting on you'),
    'and the cold document still carries it, with no figure to wait for');
  assert.ok(!HTML.includes('id="workshop-total-working"'),
    'a figure read from data is not in a cold document');
});

test('#2759: the all-apps screen ships no scope chip', () => {
  // The screen is a flat list of your apps; a chip whose panel listed them
  // again was redundant. Gone from the source and from the cold document.
  for (const id of ['workshop-scope', 'workshop-picker']) {
    assert.ok(!SCREEN.includes(id), `#${id} is not on the screen`);
    assert.ok(!HTML.includes(`id="${id}"`), `#${id} is not in the shipped shell`);
  }
  // What leads the screen now is the legend, and it carries the header's
  // notch clearance the chip's row used to.
  assert.match(SCREEN, /<p className="px-4 pt-5 pb-2 flex flex-wrap/);
});

// ── The same chip, scoped to one app (#2718 review) ────────────────────

test('scoped, the chip names the app and never reads as a dead control', () => {
  // The app's own Workshop wears this, and the first render has no list: the
  // fetch runs in an effect, so what it draws until then is what the caller
  // already knows — which is why the name and the artwork are props rather
  // than something to wait for. A chip that started as a bare slug and
  // changed under the reader would be worse than one that arrived late.
  const html = renderToHtml(createElement(chrome.AppWorkshopScope, {
    slug: 'notes-ab12', name: 'Recipe Box', iconEmoji: '🍲',
  }));
  assert.match(html, /id="dev-ws-scope-chip"/);
  assert.match(html, /Recipe Box/, 'it names the app, not the slug');
  assert.doesNotMatch(html, /All apps/,
    'the panel is behind a press, so the first render is the chip alone');
  // The ATTRIBUTE, not the word: `disabled:opacity-60` is in every one of
  // these chips' class strings and matching on it would pass either way.
  assert.doesNotMatch(html, /disabled=""/,
    'scoped there is always somewhere to go — up to all of them');
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="dev-ws-scope-chip-picker"/,
    'the panel it names is this surface\'s, not the all-apps screen\'s');
});

test('#2768: the panel\'s id is one spelling, shared with the header\'s control', () => {
  // Below 700px the chip is hidden and the HEADER's tile and name open the
  // same panel; its `aria-controls` must name the element the chip's does.
  const store = read('frontend/src/features/workshop/app-scope-store.js');
  assert.match(store, /export const APP_SCOPE_PANEL_ID = 'dev-ws-scope-chip-picker';/);
  assert.match(CHROME, /id=\{APP_SCOPE_PANEL_ID\}/, 'the panel wears it');
  assert.match(CHROME, /aria-controls=\{`\$\{id\}-picker`\}/, 'and the chip derives the same string');
  const header = read('frontend/src/features/header/header-title.tsx');
  assert.match(header, /aria-controls=\{APP_SCOPE_PANEL_ID\}/, 'and so does the header');
  assert.match(header, /onClick=\{\(\) => appScopeStore\.set\(\{ open: !scopeOpen \}\)\}/);
});

test('#2768: on the app\'s Workshop the header drops its tile on desktop and IS the switcher on a phone', () => {
  const header = read('frontend/src/features/header/header-title.tsx');
  // Which screen: the Dev half's board route in its Workshop layout.
  assert.match(header,
    /const onWorkshop = inApp && tab === 'dev' && subTab === 'forum' && viewMode === 'workshop';/);
  // DESKTOP: the chip under the bar is the one picture of the app, so the
  // bar keeps the name and loses the tile.
  assert.match(header, /const showTile = inApp && !\(onWorkshop && !phone\);/);
  // PHONE: the tile and the app's name become a button that opens the panel.
  assert.match(header, /const switcher = onWorkshop && phone;/);
  assert.match(header, /id="header-app-switch"/);
  assert.match(header, /aria-haspopup="menu"/);
  // `pointer-events-auto`, or the h1's `pointer-events-none` swallows the tap.
  assert.match(header, /className="pointer-events-auto /);
  // The width is settled in an EFFECT, false first, so the hydrating render is
  // the prerender's whatever the window is — a mismatch is a console error on
  // every route.
  assert.match(header, /const \[phone, setPhone\] = useState\(false\);/);
  assert.match(header, /const PHONE_QUERY = '\(max-width: 699\.98px\)';/);

  // And below the same breakpoint the Workshop's own chip steps aside, the
  // wrapper with it while the panel is shut.
  const css = read('public/css/app.css');
  assert.match(css, /@media \(max-width: 699\.98px\) \{\n  \.dev-ws-scope > button \{ display: none; \}\n  \.dev-ws-scope:not\(:has\(> \[role='menu'\]\)\) \{ display: none; \}\n\}/);
});
