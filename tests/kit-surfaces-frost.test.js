'use strict';

// Shell-only kit material; browser/overlay-scrim.mjs exercises the
// replacement paint layer against the actual animation and dismissal lifecycle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_CSS = read('public/css/app.css');
const NATIVE_CSS = read('public/usernode-native/v1/native.css');
const NATIVE_JS = read('public/usernode-native/v1/native.js');

const rule = (sel, css = APP_CSS) => {
  const at = css.indexOf(`\n${sel} {`);
  assert.ok(at > 0, `${sel} must exist`);
  return css.slice(at, css.indexOf('\n}', at + 1));
};

const SURFACES = ['.un-modal', '.un-sheet', '.un-panel'];
// ── The surface ────────────────────────────────────────────────────────

test('the kit modal, sheet and panel wear the pane glass in the shell', () => {
  for (const sel of SURFACES) {
    const body = rule(sel);
    assert.match(body, /background-color: var\(--dc-sheet-fill\)/, `${sel} takes the translucent fill`);
    assert.match(body, /backdrop-filter: var\(--dc-frost\)/, `${sel} frosts`);
    assert.match(body, /-webkit-backdrop-filter: var\(--dc-frost\)/, `${sel} frosts in Safari`);
  }
});

test('the overscroll extensions are more surface, so they are the same glass', () => {
  // `.un-sheet::after` / `.un-panel::after` continue the surface past the
  // screen edge (native.css, issue #789); an opaque strip there would show
  // through on every bounce.
  for (const sel of ['.un-sheet::after', '.un-panel::after']) {
    const body = rule(sel);
    assert.match(body, /background-color: var\(--dc-sheet-fill\)/, `${sel}`);
    assert.match(body, /backdrop-filter: var\(--dc-frost\)/, `${sel}`);
  }
});

test('native.css is NOT restyled — the frost is the shell\'s alone', () => {
  // The kit is centrally hosted to every app. Its own modal, sheet and
  // panel keep their opaque surface; only the shell document, which loads
  // app.css after native.css, sees the glass.
  for (const sel of SURFACES) {
    const body = rule(sel, NATIVE_CSS);
    assert.match(body, /background: var\(--un-(sheet|panel)-bg\)/, `${sel} keeps its opaque ground in the kit`);
    assert.doesNotMatch(body, /backdrop-filter/, `${sel} does not frost in the kit`);
  }
  assert.doesNotMatch(NATIVE_CSS, /--pane-scrim|--dc-sheet-fill|--un-presence/,
    'the kit stylesheet reads none of the shell\'s tokens');
});

test('without backdrop-filter the surfaces go opaque and keep the dim', () => {
  const fallback = APP_CSS.slice(
    APP_CSS.indexOf('.un-modal, .un-sheet, .un-sheet::after, .un-panel, .un-panel::after {'),
  ).slice(0, 200);
  assert.match(fallback, /background-color: var\(--dc-sheet\)/, 'the opaque sheet colour');
  const before = APP_CSS.slice(0, APP_CSS.indexOf('.un-modal, .un-sheet, .un-sheet::after, .un-panel, .un-panel::after {'));
  assert.match(before.slice(-200), /@supports not \(\(backdrop-filter: blur\(1px\)\)/,
    'inside the no-backdrop-filter block');
});

// ── The dim ────────────────────────────────────────────────────────────

test('the kit backdrop goes transparent only where a frosted surface follows it', () => {
  const body = rule('.un-backdrop:has(+ .un-modal),\n.un-backdrop:has(+ .un-sheet),\n.un-backdrop:has(+ .un-panel)');
  assert.match(body, /background: transparent/);
  // presentModal / presentSheet / presentPanel each append the backdrop and
  // then the surface, so the surface is the backdrop's next sibling. The
  // alert and the action sheet are not in the list and keep the kit's dim.
  for (const fn of ['presentModal', 'presentSheet', 'presentPanel']) {
    const at = NATIVE_JS.indexOf(`function ${fn}(`);
    assert.ok(at > 0, fn);
    const src = NATIVE_JS.slice(at, at + 2500);
    assert.match(src, /document\.body\.appendChild\(backdrop\);\s*document\.body\.appendChild\((card|sheet|panel)\);/,
      `${fn} appends the surface right after its backdrop`);
  }
  // It is the backdrop's ELEMENT that stays: dapp.json reads its inline
  // opacity to know a modal has entered.
  const DAPP = read('dapp.json');
  assert.match(DAPP, /\.un-backdrop\[style\*=\\"opacity: 1\\"\]/);
});

test('kit surfaces retain their bounded shadows without viewport-sized spread', () => {
  assert.match(rule('.un-modal'), /box-shadow: var\(--dc-lift-shadow\);/);
  assert.match(rule('.un-sheet'), /box-shadow: 0 -8px 32px rgba\(0, 0, 0, 0\.22\);/);
  assert.match(rule('.un-panel[data-un-side="right"]'), /box-shadow: -8px 0 32px rgba\(0, 0, 0, 0\.22\);/);
  assert.match(rule('.un-panel[data-un-side="left"]'), /box-shadow: 8px 0 32px rgba\(0, 0, 0, 0\.22\);/);
  assert.doesNotMatch(APP_CSS, /100vmax/);
});

test('native.js publishes --un-presence from the render that drives the backdrop', () => {
  for (const [fn, el, extent] of [['presentSheet', 'sheet', 'height'], ['presentPanel', 'panel', 'width']]) {
    const at = NATIVE_JS.indexOf(`function ${fn}(`);
    const src = NATIVE_JS.slice(at, NATIVE_JS.indexOf('\n  }\n', at));
    const render = src.slice(src.indexOf('function render(val)'), src.indexOf('function springTo'));
    // One number, computed once, written to both: the backdrop's opacity
    // and the surface's custom property can never disagree.
    assert.match(render, new RegExp(`var presence = String\\(Math\\.max\\(0, Math\\.min\\(1, 1 - val / ${extent}\\)\\)\\);`), fn);
    assert.match(render, /backdrop\.style\.opacity = presence;/, fn);
    assert.match(render, new RegExp(`${el}\\.style\\.setProperty\\('--un-presence', presence\\);`), fn);
  }
  assert.doesNotMatch(NATIVE_CSS, /--un-presence/, 'the kit\'s own styles ignore it; apps render as before');
});

test('the scrim tokens are split into ink and alpha in both themes', () => {
  for (const tok of ['--pane-scrim-ink: 0 0 0;', '--pane-scrim-alpha: 0.4;',
    '--pane-scrim: rgb(var(--pane-scrim-ink) / var(--pane-scrim-alpha));']) {
    assert.equal((APP_CSS.match(new RegExp(tok.replace(/[()*.+/]/g, '\\$&'), 'g')) || []).length, 2,
      `${tok} declared once per theme`);
  }
});

// ── The create dialog ──────────────────────────────────────────────────

test('the create dialog sits on the strip\'s frosted tint, opaque strip as fallback', () => {
  const body = rule('.un-modal:has(> #create-card)');
  assert.match(body, /--un-sheet-bg: var\(--dc-strip\)/, 'the kit variable stays for whatever still reads it');
  assert.match(body, /background-color: var\(--dc-strip-fill\)/);
  assert.match(APP_CSS, /\.un-modal:has\(> #create-card\) \{ background-color: var\(--dc-strip\); \}/);
});

// ── The adopted panes hand the surface to the kit ──────────────────────

test('an adopted pane still lets the kit own the surface, so the frost is not doubled', () => {
  // `.platform-sheet-adopted` (tests/overlay-panes-lift.test.js pins the
  // !important) flattens the pane's own background and shadow while it rides
  // the kit sheet: the sheet's glass and the sheet's scrim are the only ones.
  const adopted = rule('.platform-sheet-adopted');
  assert.match(adopted, /background: transparent !important/);
  assert.match(adopted, /box-shadow: none !important/);
});

// ── The two bars are one material (#2718 review) ───────────────────────

test('the platform header wears the same glass as the tab bar', () => {
  // The bar at the foot (or, on a desktop, the rail at the side) has always
  // been `--dc-sheet-fill` under `--dc-frost`. The header was CLEARED on
  // every wallpapered screen, which was right while it floated alone on a
  // page and wrong the moment a second bar shared the screen with it: two
  // pieces of the same chrome, drawn as two different materials.
  const at = APP_CSS.indexOf('THE BAR IS THE SAME MATERIAL AS THE BAR AT THE FOOT');
  assert.ok(at > 0, 'the rule states its reason');
  const block = APP_CSS.slice(at, APP_CSS.indexOf('\n}', APP_CSS.indexOf('#platform-header {', at)));
  assert.match(block, /background-color: var\(--dc-sheet-fill\);/);
  assert.match(block, /backdrop-filter: var\(--dc-frost\);/);
  assert.match(block, /-webkit-backdrop-filter: var\(--dc-frost\);/);
  // AND IT KEEPS THAT GLASS THROUGH A TRANSITION (#2718 review). Forcing the
  // opaque fallback under `html[data-un-vt]` was tried, on the reading that a
  // named view-transition group composites above the root group and so has to
  // be opaque. It made both bars `#ffffff` for the length of every navigation
  // — over a cream wallpaper they read as a pale wash of it — so the cure was
  // a white flash on every tab press. Pinning the two IMAGES is what does the
  // work: a snapshot is a picture, not a live surface sampling a moving
  // backdrop.
  assert.ok(!APP_CSS.includes('--platform-bar-fill'),
    'no token indirection survives, because nothing overrides these any more');
  const selector = block.slice(block.indexOf('body:has('), block.indexOf('{', block.indexOf('body:has(')));
  // NOT INSIDE AN APP. The strip takes the APP's tone there (#1945) and a
  // frost over somebody else's page colour is a smear, not a surface — and
  // there is no tab bar on that route to match in the first place.
  assert.doesNotMatch(selector, /#app-view/, 'an app keeps its own tone');
  for (const screen of ['#home-screen', '#workshop-screen', '#messages-screen', '#profile-screen']) {
    assert.ok(selector.includes(screen), `${screen} is a platform screen and takes the glass`);
  }
  // It must come AFTER the rule that clears the bar, or it never applies:
  // both are `body:has(…) #platform-header` and carry the same specificity.
  assert.ok(APP_CSS.indexOf('background-color: transparent;', APP_CSS.indexOf(':not(.hidden)) #platform-header'))
    < at, 'the glass is declared after the rule it overrides');
});

test('an app\'s own Workshop wears the glass; the running app keeps its clear bar (#2806)', () => {
  // The Workshop tab of an app — its board, its sessions, its discussion — is
  // the platform's page ABOUT the app, not the app: AppView._setSurface marks
  // it `data-app-surface="platform"` and the frame is parked (no app tone).
  // It was the one place the bar went bare. A SEPARATE rule keeps the one
  // above free of #app-view, so the running app (`data-app-surface="app"`)
  // stays clear and takes the app's tone.
  const at = APP_CSS.indexOf('AND OVER AN APP\'S OWN WORKSHOP (#2806)');
  assert.ok(at > 0, 'the rule states its reason');
  const sel = 'body:has(#app-view:not(.hidden)[data-app-surface="platform"]) #platform-header {';
  const start = APP_CSS.indexOf(sel, at);
  assert.ok(start > at, 'keyed on the platform surface of a visible app view');
  const block = APP_CSS.slice(start, APP_CSS.indexOf('\n}', start));
  assert.match(block, /background-color: var\(--dc-sheet-fill\);/);
  assert.match(block, /backdrop-filter: var\(--dc-frost\);/);
  assert.match(block, /-webkit-backdrop-filter: var\(--dc-frost\);/);
  assert.ok(!APP_CSS.includes('[data-app-surface="app"]) #platform-header'),
    'nothing frosts the bar over a running app');
  // After the clearing rule, which has the same specificity class and would
  // otherwise win.
  assert.ok(APP_CSS.indexOf('background-color: transparent;', APP_CSS.indexOf(':not(.hidden)) #platform-header'))
    < start, 'declared after the rule that clears the bar');
});

test('a sticky header over a scrolling document keeps that glass too', () => {
  // `html[data-browser-scroller]` is the routes where the DOCUMENT scrolls so
  // the browser's own toolbars can follow it (#1518). The header is sticky
  // there, and it used to force a near-opaque wash of the page ground with
  // `!important` — which beat the glass above and left the two bars looking
  // different again on exactly the routes a phone browser uses.
  //
  // The wash stays where it belongs: #landing-header, which has no tab bar to
  // match and nothing frosted near it. A frost over moving content is not a
  // new risk here — the tab bar is `position: fixed` over the same scrolling
  // document and has always been frosted.
  const sticky = rule('html[data-browser-scroller] :is(#platform-header, #landing-header)');
  assert.match(sticky, /position: sticky;/);
  assert.ok(!sticky.includes('background'), 'the shared rule sets position only');
  const landing = rule('html[data-browser-scroller] #landing-header');
  assert.match(landing, /background: color-mix\(in srgb, var\(--home-ground\) 92%, transparent\);/);
  assert.ok(!/color-mix\(in srgb, var\(--home-ground\) 92%, transparent\) !important/.test(APP_CSS),
    'and nothing forces that wash onto the platform header any more');
});

test('persistent chrome does not cross-fade through a screen swap', () => {
  // `animation: none` on a named GROUP stops it sliding. It does not stop the
  // two IMAGES inside it cross-fading, which is the default — so the bar
  // stayed put and spent 130ms showing "Homeroom" and "Workshop"
  // superimposed, both at half opacity, over a rail whose five labels were
  // ghosting through the root snapshot at the same time. Caught by
  // screenshotting 40ms into a Home → Workshop push.
  assert.match(APP_CSS, /#platform-tabs \{\s*\n\s*view-transition-name: platform-tabs;/,
    'the rail gets its own group: unnamed it is part of the root snapshot '
    + 'and slides with the page it is navigation for');
  assert.match(APP_CSS,
    /html\[data-un-vt\]::view-transition-old\(platform-header\),\s*\n\s*html\[data-un-vt\]::view-transition-old\(platform-tabs\) \{\s*\n\s*animation: none;\s*\n\s*opacity: 0;/,
    'the old image goes');
  assert.match(APP_CSS,
    /html\[data-un-vt\]::view-transition-new\(platform-header\),\s*\n\s*html\[data-un-vt\]::view-transition-new\(platform-tabs\) \{\s*\n\s*animation: none;\s*\n\s*opacity: 1;/,
    'and the new one is simply there — a cross-fade animates a thing '
    + 'CHANGING, and these relabel rather than change');
  for (const name of ['platform-header', 'platform-tabs']) {
    assert.match(APP_CSS, new RegExp(`::view-transition-group\\(${name}\\) \\{\\s*\\n\\s*animation: none;`),
      `${name}'s group is pinned too, so it does not slide`);
  }
});
