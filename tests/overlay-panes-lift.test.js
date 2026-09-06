'use strict';

// THE SHELL'S THREE FLOATING PANES ARE ONE SURFACE, AND IT CASTS ITS OWN DIM.
//
// The bell's rail, the Improve rail and the app chip's menu are the three
// things in the shell that present over a scrim. They had drifted into three
// different surfaces: the bell wore `.dc-lift dc-lift-session` (the dev
// screen's glass), the other two wore `bg-white dark:bg-zinc-900` with a zinc
// hairline and `shadow-2xl` — the pre-lift panel look.
//
// The bell's glass looked DULL, and the cause was where the dim came from.
// Each pane raised a sibling backdrop at z-40 carrying `bg-black/40` and sat
// above it at z-50. `backdrop-filter` samples everything painted behind the
// element, so the thing the glass was frosting was a page already dimmed 40%.
// On the home ground: #f4f2e4 → #929189 under the backdrop → #cac7c3 under the
// pane. Grey, on the surface meant to be the brightest thing on screen.
//
// Making the pane opaque fixed that and cost the glass — three flat white
// slabs. Both halves are wanted, so the dim moved ONTO the pane as an outer
// box-shadow. An outer shadow is clipped to outside the border box, so it is
// never part of the element's own backdrop: the pane frosts the UNDIMMED page
// while the same declaration darkens everything around it. Measured at
// (200,700) and (1100,650), 1280x860, light:
//
//   opaque + backdrop dim   page #948a84   pane #ffffff   (flat)
//   glass  + no dim         page #f7e7dc   pane #fcf6ee   (not modal)
//   glass  + backdrop dim   page #948a84   pane #cac7c3   (the dull one)
//   glass  + cast dim       page #948a84   pane #fcf6ee   (both)
//
// What this file pins is that arrangement: the shared surface, the glass, the
// scrim living on the pane rather than behind it, the backdrops staying as
// transparent click targets, and the dev screen's own planes untouched.
//
// Run with: node --test tests/overlay-panes-lift.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_CSS = read('public/css/app.css');

const NOTIFICATIONS = read('frontend/src/features/notifications/notifications-sheet.tsx');
const IMPROVE = read('frontend/src/features/improve/improve-panel.tsx');
const SWITCHER = read('frontend/src/features/app-context/app-context-sheet.tsx');

/** The three panes, by the id each one's root carries. */
const PANES = [
  { id: 'notifications-sheet', src: NOTIFICATIONS, overlay: 'notifications-sheet-overlay' },
  { id: 'improve-panel', src: IMPROVE, overlay: 'improve-overlay' },
  { id: 'apps-switcher-sheet', src: SWITCHER, overlay: 'apps-switcher-overlay' },
];

const rule = (sel) => {
  const at = APP_CSS.indexOf(`\n${sel} {`);
  assert.ok(at > 0, `${sel} must exist`);
  return APP_CSS.slice(at, APP_CSS.indexOf('\n}', at + 1));
};

/**
 * The `max-width: 639px` rule for a pane — the one nested block declaring
 * `#<id>` whose body slides the panel up from the floor. Selected by content
 * rather than by counting occurrences: every one of these ids is declared in
 * three or four places (a base rule, a dropdown or rail rule, a kit-adopted
 * rule), and an index-based pick silently follows the wrong one the next time
 * a block is added above it.
 */
const bottomSheetRule = (id) => {
  // The selector may be grouped — the bell's block still carries the retired
  // #messages-sheet alongside it — so the head runs to the brace.
  const re = new RegExp(`\\n  #${id}[,\\s][^{]*\\{`, 'g');
  const hits = [];
  for (let m = re.exec(APP_CSS); m; m = re.exec(APP_CSS)) {
    const body = APP_CSS.slice(m.index, APP_CSS.indexOf('\n  }', m.index));
    if (body.includes('translateY(100%)')) hits.push(body);
  }
  assert.equal(hits.length, 1, `#${id} must have exactly one bottom-sheet rule`);
  return hits[0];
};

/** The class string on the root element carrying `id`. */
const rootClass = (src, id) => {
  const m = new RegExp(`id="${id}"[\\s\\S]{0,800}?className=\\{?'?"?([^"']*)`).exec(src);
  assert.ok(m, `located the class string on #${id}`);
  return m[1];
};

// ── The surface ────────────────────────────────────────────────────────

test('all three panes wear the lift and the one shared pane surface', () => {
  for (const { id, src } of PANES) {
    const cls = rootClass(src, id);
    assert.match(cls, /\bdc-lift\b/, `#${id} takes the lift's geometry`);
    assert.match(cls, /\bdc-lift-panel\b/, `#${id} takes the shared pane surface`);
    assert.doesNotMatch(cls, /\bdc-lift-session\b/,
      `#${id} reads .dc-lift-panel, which is that glass PLUS the cast dim`);
  }
});

test('the pane surface is GLASS, the same the dev screen wears', () => {
  const panel = rule('.dc-lift-panel');
  assert.match(panel, /background-color: var\(--dc-sheet-fill\)/,
    'the translucent fill, not the opaque --dc-sheet');
  assert.match(panel, /backdrop-filter: var\(--dc-frost\)/, 'and it frosts');
  // Safari has shipped this prefixed for years; dropping it turns the glass
  // into an unblurred wash there, which is worse than either end state.
  assert.match(panel, /-webkit-backdrop-filter: var\(--dc-frost\)/);
});

test('the dim is cast BY the pane, so it is not in the pane\'s own backdrop', () => {
  // The whole fix in one declaration. An outer box-shadow paints only outside
  // the border box, so it darkens the page without ever reaching the area the
  // backdrop-filter samples. 100vmax covers the viewport from wherever the
  // pane is docked — which is why this works for a right rail, a bottom sheet
  // and a centred dropdown without any of them knowing its own geometry.
  const open = rule('.dc-lift-panel[data-open]');
  assert.match(open, /box-shadow: var\(--dc-lift-shadow\), 0 0 0 100vmax var\(--pane-scrim\)/);
  for (const tok of ['--pane-scrim:', '--dc-lift-shadow:']) {
    const decls = APP_CSS.match(new RegExp(`${tok}[^;]+;`, 'g')) || [];
    assert.ok(decls.length >= 2, `${tok} must be declared in both themes`);
  }
  // The lift reads the same token the panes append to, so the two copies of
  // its two layers cannot drift apart.
  assert.match(rule('.dc-lift'), /box-shadow: var\(--dc-lift-shadow\)/);
});

test('the closed state keeps the same shadow COUNT, so the dim fades', () => {
  // box-shadow interpolates componentwise; a list that changes length snaps.
  // Closed carries the scrim as `transparent` rather than dropping the layer.
  const shut = rule('.dc-lift-panel');
  assert.match(shut, /box-shadow: var\(--dc-lift-shadow\), 0 0 0 100vmax transparent/);
  const count = (s) => (s.match(/box-shadow:[^;]+;/)[0].match(/0 0 0 100vmax/g) || []).length;
  assert.equal(count(shut), count(rule('.dc-lift-panel[data-open]')));
  // And each pane's transition has to carry box-shadow, or the dim snaps on at
  // the start of the open and off at the start of the close.
  for (const cls of ['.nav-sheet-transition', '.improve-panel-transition',
    '.app-context-transition']) {
    assert.match(rule(cls), /transition:[^;]*box-shadow/, `${cls} fades its dim`);
  }
});

test('a CLOSED pane is not painted, because the scrim layer is 100vmax', () => {
  // A performance rule. All three panes are always mounted — a closed rail is
  // translated off-screen, not unmounted — and a 100vmax shadow is rasterised
  // even when its colour is `transparent`. Measured in Chromium at 1280x860
  // over 60 forced style-recalc + paint cycles:
  //
  //   painted while closed          frame median 51.9ms   p95 72.7ms
  //   opacity: 0 while closed                 16.7ms          35.2ms
  //   visibility: hidden while closed         16.7ms          17.1ms
  //
  // 3x the frame cost on EVERY screen, which is enough to make
  // timing-dependent checks fail on a slow container.
  const shut = rule('.dc-lift-panel:not([data-open])');
  assert.match(shut, /opacity: 0/, 'a closed pane suppresses its paint');
  // The delay is what keeps the slide-out visible: opacity drops AFTER the
  // 200ms transition, and opening carries no delay so it paints all the way in.
  assert.match(shut, /transition:[^;]*opacity 0s linear 200ms/,
    'and only once the pane has finished sliding out');
  assert.match(shut, /transition:[^;]*transform 200ms/,
    'restating the transition here must not drop the slide');
  assert.match(shut, /transition:[^;]*box-shadow 200ms/, 'nor the dim fade');
});

test('...and it does NOT use visibility, which would hide the panes\' TEXT', () => {
  // The regression this replaced. `visibility: hidden` is marginally faster and
  // removes the subtree from `innerText` — and dapp.json reads text out of
  // these panes on routes where they are CLOSED. "Improve panel leads with
  // Give feedback" asserts that string on `/`, where #improve-panel is shut.
  // Any future check of the same shape would have gone the same way.
  const shut = rule('.dc-lift-panel:not([data-open])');
  assert.doesNotMatch(shut, /visibility:\s*hidden/,
    'a closed pane must stay in innerText — see the declared checks that read it');

  // The contract, stated against the real thing: the built shell ships that
  // string inside the closed panel, so nothing may make it unreadable.
  const shell = read('public/index.html');
  const at = shell.indexOf('id="improve-panel"');
  assert.ok(at > 0, 'the built shell carries the always-mounted Improve panel');
  assert.ok(shell.indexOf('Give feedback', at) > at,
    'and "Give feedback" inside it, which a declared check reads on `/`');
});

test('the backdrops stay, transparent — they are the click target', () => {
  // They own pointer-events and dismiss-on-click, which the shadow does not
  // take over. What they no longer do is paint, because painting is what put
  // the dim inside the pane's backdrop.
  for (const { id, src: file, overlay } of PANES) {
    const m = new RegExp(`id="${overlay}"[\\s\\S]{0,400}?className="([^"]*)"`).exec(file);
    assert.ok(m, `#${overlay} must still be rendered`);
    assert.match(m[1], /fixed inset-0 z-40/, `#${overlay} still covers the page`);
    assert.doesNotMatch(m[1], /bg-black/,
      `#${overlay} must not paint the dim — #${id} casts it instead`);
    assert.match(file, new RegExp(`id="${overlay}"[\\s\\S]{0,400}?onClick=\\{close\\}|`
      + `id="${overlay}"[\\s\\S]{0,400}?onClick=`), 'and still dismisses on click');
  }
});

test('without backdrop-filter the pane goes opaque and the dim survives', () => {
  // The scrim is a shadow, not a filter, so only the fill falls back — the
  // same admission `.dc-lift-session` already makes: the effect is the blur.
  const at = APP_CSS.indexOf('@supports not ((backdrop-filter', APP_CSS.indexOf('.dc-lift-panel {'));
  assert.ok(at > 0, 'the panel needs its own no-filter fallback');
  const block = APP_CSS.slice(at, APP_CSS.indexOf('\n}\n', at));
  assert.match(block, /\.dc-lift-panel \{ background-color: var\(--dc-sheet\); \}/);
  assert.doesNotMatch(block, /box-shadow/, 'the dim is not part of the fallback');
});

test('the dev screen keeps its glass — this change does not reach it', () => {
  // .dc-lift-session and .dc-lift-strip sit over the page wallpaper, which is
  // something worth seeing through. Flattening them was never the ask.
  for (const sel of ['.dc-lift-strip', '.dc-lift-session']) {
    const r = rule(sel);
    assert.match(r, /background-color: var\(--dc-(strip|sheet)-fill\)/,
      `${sel} keeps its translucent fill`);
    assert.match(r, /backdrop-filter: var\(--dc-frost\)/, `${sel} keeps its blur`);
  }
});

test('no pane keeps the pre-lift panel look', () => {
  for (const { id, src } of PANES) {
    const cls = rootClass(src, id);
    for (const dead of [/\bbg-white\b/, /\bdark:bg-zinc-900\b/, /\bshadow-2xl\b/,
      /\bborder-zinc-200\b/, /\bdark:border-zinc-700\b/]) {
      assert.doesNotMatch(cls, dead,
        `#${id} still carries ${dead} — the lift supplies fill, hairline and shadow`);
    }
  }
});

// ── The shape, which differs by how each pane docks ────────────────────

test('the two rails round the one corner that is a corner of anything', () => {
  // A right-edge rail runs floor to ceiling against the right of the display,
  // so three of its four corners sit on an edge. `.dc-lift` ships the
  // floor-docked shape (1.75rem 1.75rem 0 0) and each rail restates its own.
  for (const id of ['notifications-sheet', 'improve-panel']) {
    const r = rule(`#${id}`);
    assert.match(r, /border-radius: 1\.75rem 0 0 0/,
      `#${id}'s desktop shape is the top-LEFT corner only`);
    assert.match(r, /border-(left|color)/, `#${id} draws its left hairline`);
  }
});

test('the app menu keeps the menu shape it earned, and only takes the surface', () => {
  // It hangs off the chip that opens it rather than docking to an edge, so
  // all four of its corners are real and none of them is the lift's 28px.
  // --un-radius-card and --brand-line tie it to the chip's own ring; the
  // pane style is the fill and the shadow here, not the outline.
  const at = APP_CSS.indexOf('#apps-switcher-sheet {', APP_CSS.indexOf('@media (min-width: 640px)'));
  assert.ok(at > 0, 'located the dropdown rule');
  const dropdown = APP_CSS.slice(at, APP_CSS.indexOf('\n  }', at));
  assert.match(dropdown, /border-radius: 0\.75rem/, 'the kit menu radius stays');
  assert.match(dropdown, /border-color: var\(--brand-line\)/, 'the brand hairline stays');
  assert.doesNotMatch(dropdown, /1\.75rem/, 'it must not adopt the docked radius');
});

test('all three bottom sheets round to the same 1.75rem, by reading it', () => {
  // Below sm every one of these is a bottom sheet docked to the floor, which
  // is the shape `.dc-lift` itself ships — so the three agree on the number.
  // The bell used to restate it with `!important` to beat a stale `1rem` in
  // its own geometry block; that block says 1.75rem now, so the override is
  // gone and there is one declaration per pane rather than two.
  for (const id of ['improve-panel', 'apps-switcher-sheet', 'notifications-sheet']) {
    const sheet = bottomSheetRule(id);
    assert.match(sheet, /border-top-left-radius: 1\.75rem/, `#${id}'s left corner`);
    assert.match(sheet, /border-top-right-radius: 1\.75rem/, `#${id}'s right corner`);
    assert.match(sheet, /transform: translateY\(100%\)/,
      `#${id} is the bottom-sheet rule, not some other block that mentions it`);
  }
  assert.doesNotMatch(APP_CSS, /border-top-left-radius: [^;]*!important/,
    'no pane needs an !important to win its own top corner any more');
});

// ── The kit path ───────────────────────────────────────────────────────

test('an adopted pane lets the kit own the surface', () => {
  // On touch the native kit presents these elements inside its own sheet and
  // `.platform-sheet-adopted` flattens the fixed chrome. That rule carries
  // `!important`, so nothing here may out-rank it with an `!important` of its
  // own — which the bell's desktop radius used to do.
  const adopted = rule('.platform-sheet-adopted');
  for (const prop of ['border', 'border-radius', 'box-shadow', 'background']) {
    assert.match(adopted, new RegExp(`${prop}: [^;]*!important`),
      `the kit sheet owns ${prop}`);
  }
  const desktop = APP_CSS.slice(APP_CSS.indexOf('#notifications-sheet { border-color'));
  const block = desktop.slice(0, desktop.indexOf('.notifications-row'));
  assert.doesNotMatch(block, /!important/,
    'the bell no longer overrides the kit with !important');
});
