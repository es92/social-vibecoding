// Unit tests for the usernode-native v1 kit's physics
// (public/usernode-native/v1/native.js). The file is dual-target: in Node
// it exports { physics } and touches no DOM, so the gesture math — the
// part the "feels native" fidelity requirements hang on — is testable
// headlessly. The DOM half (springs on elements, swipe/PTR wiring) is
// exercised via the demo page in a browser.
//
// Run with: node --test tests/native-kit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { physics } = require('../public/usernode-native/v1/native.js');

const {
  PRESETS,
  DECEL_RATE,
  springStep,
  simulateSpring,
  projectMomentum,
  projectDisplacement,
  estimateVelocity,
  rubberband,
  rubberbandInvert,
  lockIntent,
  decideSwipeRelease,
  decidePtrRelease,
  ptrPuckOffset,
  PTR_PUCK,
  PTR_HOLD,
  PTR_THRESHOLD,
  PTR_LIMIT,
  PTR_LAYER_H,
  decideSheetRelease,
  remeasuredSheetY,
  keyboardInset,
  isTextEntryField,
  revealScrollDelta,
  reorderDropIndex,
  gridDropSide,
  autoScrollVelocity,
  createArbiter,
  createToastSlot,
  zoomPose,
  zoomRectUsable,
} = physics;

// ── Spring integrator ──────────────────────────────────────────────────

test('spring converges to the target and terminates at the rest threshold', () => {
  for (const name of Object.keys(PRESETS)) {
    const r = simulateSpring(0, 100, 0, PRESETS[name]);
    assert.ok(
      Math.abs(r.x - 100) < physics.REST_DELTA,
      `${name}: settled at ${r.x}, expected ~100`
    );
    assert.ok(Math.abs(r.v) < physics.REST_VELOCITY, `${name}: still moving at rest`);
    assert.ok(r.durationMs < 5000, `${name}: never terminated (${r.durationMs}ms)`);
    assert.ok(r.durationMs > 50, `${name}: implausibly instant (${r.durationMs}ms)`);
  }
});

test('spring gains no energy (overshoot stays bounded for the shipped presets)', () => {
  for (const name of Object.keys(PRESETS)) {
    const r = simulateSpring(0, 100, 0, PRESETS[name]);
    const maxX = Math.max(...r.samples.map((s) => s.x));
    // The shipped presets are near-critically damped: tiny overshoot is
    // fine, oscillation growth is not.
    assert.ok(maxX < 110, `${name}: overshoot ${maxX} exceeds 10%`);
    // And the tail must decay: the last quarter of samples all near target.
    const tail = r.samples.slice(Math.floor(r.samples.length * 0.75));
    for (const s of tail) {
      assert.ok(Math.abs(s.x - 100) < 5, `${name}: tail sample ${s.x} not settled`);
    }
  }
});

test('sheet preset is snappy: 90% of travel in ≤200ms and rests sooner than default (issue #769)', () => {
  // A 500px slide-up is a typical tray height. The `sheet` preset exists
  // so trays feel "there" noticeably faster than the soft `default` —
  // pin that so a future retune can't quietly regress it.
  const fast = simulateSpring(500, 0, 0, PRESETS.sheet);
  const soft = simulateSpring(500, 0, 0, PRESETS.default);
  const t90 = fast.samples.find((s) => Math.abs(s.x) <= 500 * 0.10).t;
  assert.ok(t90 <= 200, `sheet preset reached 90% travel at ${t90}ms, expected ≤200ms`);
  assert.ok(
    fast.durationMs < soft.durationMs * 0.8,
    `sheet preset rests at ${fast.durationMs}ms — not meaningfully sooner than default's ${soft.durationMs}ms`
  );
});

test('velocity seeding shifts the trajectory (a flicked release moves faster early)', () => {
  const still = simulateSpring(0, 100, 0, PRESETS.default);
  const flicked = simulateSpring(0, 100, 1.5, PRESETS.default); // 1.5 px/ms toward target
  const at = (r, t) => r.samples[Math.min(t, r.samples.length - 1)].x;
  assert.ok(
    at(flicked, 60) > at(still, 60),
    `flicked spring should lead at 60ms (${at(flicked, 60)} vs ${at(still, 60)})`
  );
  // Both still settle on the same target.
  assert.ok(Math.abs(flicked.x - 100) < physics.REST_DELTA);
});

test('springStep integrates with fixed-timestep semantics (many small steps ≈ simulate)', () => {
  const state = { x: 0, v: 0 };
  for (let t = 0; t < 500; t++) springStep(state, 100, PRESETS.default, 1);
  const ref = simulateSpring(0, 100, 0, PRESETS.default);
  const refAt500 = ref.samples[Math.min(500, ref.samples.length - 1)].x;
  assert.ok(Math.abs(state.x - refAt500) < 0.001, `${state.x} vs ${refAt500}`);
});

// ── Momentum projection ────────────────────────────────────────────────

test('projectMomentum matches the closed form and degenerates to position at v=0', () => {
  // v * decel / (1 - decel): 1 px/ms at 0.998 → +499 px
  assert.ok(Math.abs(projectMomentum(0, 1) - 499) < 1e-9);
  assert.equal(projectMomentum(-40, 0), -40);
  // Direction-preserving
  assert.ok(projectMomentum(0, -1) < 0);
  // Custom decel rate
  assert.equal(projectMomentum(0, 1, 0.5), 1);
  assert.equal(DECEL_RATE, 0.998);
});

test('projectDisplacement is the bounded closed form and defaults to the 120ms commit horizon', () => {
  assert.equal(physics.COMMIT_HORIZON_MS, 120);
  // Explicit horizon: position + v * horizon
  assert.equal(projectDisplacement(0, 1, 100), 100);
  assert.equal(projectDisplacement(50, -0.5, 40), 30);
  // Default horizon: the 120ms commit window (x + v·0.12s, issue #690)
  assert.equal(projectDisplacement(-40, -1), -160);
  // Degenerates to position at v=0
  assert.equal(projectDisplacement(-40, 0, 500), -40);
});

// ── Release decisions (the fidelity requirements, as math) ─────────────

test('swipe release: a short fast flick commits even far from the commit distance', () => {
  // Finger travelled only 40px of a 360px row, but the flick projects
  // well past 60% of the row width.
  const d = decideSwipeRelease({ x: -40, v: -1.5, trayWidth: 160, rowWidth: 360, canCommit: true });
  assert.equal(d, 'commit');
});

test('swipe release: dragging past the line then back before release does NOT commit', () => {
  // Position is past 60% of the row (-230 < -216) but the finger was
  // moving back toward closed at release: the commit is cancelled. With
  // the bounded 120ms horizon the projected landing (-170) is still past
  // the tray, so the row settles OPEN — matching iOS, where drifting back
  // off the delete cue keeps the actions revealed. (The old full-coast
  // projection overshot all the way to 'close'.)
  const d = decideSwipeRelease({ x: -230, v: 0.5, trayWidth: 160, rowWidth: 360, canCommit: true });
  assert.equal(d, 'open');
  // Drifting back harder projects past the tray line and closes.
  const d2 = decideSwipeRelease({ x: -230, v: 1.5, trayWidth: 160, rowWidth: 360, canCommit: true });
  assert.equal(d2, 'close');
});

test('swipe release: issue #690 benchmark — a fast 70px flick opens a 204px tray', () => {
  // 70px travelled at 1.2 px/ms projects to -214, past half the tray.
  assert.equal(
    decideSwipeRelease({ x: -70, v: -1.2, trayWidth: 204, rowWidth: 375, canCommit: false }),
    'open'
  );
  // Drifting back from just past the tray cancels (projected -50 > -102).
  assert.equal(
    decideSwipeRelease({ x: -110, v: 0.5, trayWidth: 204, rowWidth: 375, canCommit: false }),
    'close'
  );
});

test('release decisions honor an explicit horizon override', () => {
  // 30px pulled at 0.5 px/ms: 120ms horizon projects to 90 (commit)…
  assert.equal(decidePtrRelease({ pull: 30, v: 0.5, threshold: 70 }), true);
  // …a 40ms horizon only reaches 50 (no commit).
  assert.equal(decidePtrRelease({ pull: 30, v: 0.5, threshold: 70, horizonMs: 40 }), false);
  assert.equal(
    decideSwipeRelease({ x: -70, v: -1.2, trayWidth: 204, rowWidth: 375, canCommit: false, horizonMs: 10 }),
    'close'
  );
});

test('swipe release: a slow reveal past half the tray opens; a shallow one closes', () => {
  assert.equal(
    decideSwipeRelease({ x: -90, v: 0, trayWidth: 160, rowWidth: 360, canCommit: true }),
    'open'
  );
  assert.equal(
    decideSwipeRelease({ x: -30, v: 0, trayWidth: 160, rowWidth: 360, canCommit: true }),
    'close'
  );
});

test('swipe release: without a destructive full-swipe action, commit never fires', () => {
  const d = decideSwipeRelease({ x: -300, v: -3, trayWidth: 160, rowWidth: 360, canCommit: false });
  assert.equal(d, 'open');
});

test('PTR release: commits on distance, commits on velocity, cancels on neither', () => {
  assert.equal(decidePtrRelease({ pull: 80, v: 0, threshold: 70 }), true);
  // Only 30px pulled but yanked at 0.5 px/ms → projected past threshold.
  assert.equal(decidePtrRelease({ pull: 30, v: 0.5, threshold: 70 }), true);
  assert.equal(decidePtrRelease({ pull: 30, v: 0, threshold: 70 }), false);
  // Moving back up at release: projection reduces, still under.
  assert.equal(decidePtrRelease({ pull: 60, v: -0.5, threshold: 70 }), false);
});

test('sheet release: flick dismisses, deep drag dismisses, shallow drag cancels', () => {
  // Fast flick from a shallow position projects past half the sheet.
  assert.equal(decideSheetRelease({ y: 60, v: 1.4, sheetHeight: 400 }), true);
  // Deep slow drag past half the sheet dismisses on distance alone.
  assert.equal(decideSheetRelease({ y: 260, v: 0, sheetHeight: 400 }), true);
  // Shallow drag with no momentum cancels.
  assert.equal(decideSheetRelease({ y: 80, v: 0, sheetHeight: 400 }), false);
  // Past the line but drifting back UP at release: cancels.
  assert.equal(decideSheetRelease({ y: 230, v: -1, sheetHeight: 400 }), false);
});

// ── Sheet re-measure (issue #742) ──────────────────────────────────────

test('remeasuredSheetY: growth mid-entrance shifts the offset by the delta', () => {
  // Sheet grew from grabber-only (21px) to full content (313px) while the
  // entrance spring was at y=15: the top edge stays continuous and the
  // spring animates the added 292px.
  assert.equal(remeasuredSheetY({ y: 15, oldHeight: 21, newHeight: 313 }), 307);
});

test('remeasuredSheetY: growth at rest springs the new content up', () => {
  // Presented at rest (y=0), content grows by 200px: retarget from 200.
  assert.equal(remeasuredSheetY({ y: 0, oldHeight: 313, newHeight: 513 }), 200);
});

test('remeasuredSheetY: shrink at rest lands in the rubber-band zone above rest', () => {
  // Content shrank by 100px: the offset goes negative (sheet momentarily
  // above rest) and the spring settles it back down to 0.
  assert.equal(remeasuredSheetY({ y: 0, oldHeight: 400, newHeight: 300 }), -100);
});

test('remeasuredSheetY: equal heights is a no-op', () => {
  assert.equal(remeasuredSheetY({ y: 42, oldHeight: 313, newHeight: 313 }), 42);
});

// ── Overscroll surface extension (issue #789) ──────────────────────────
// The sheet paints only inside its own border box, so ANY negative y lifts
// its bottom edge off the screen edge and (before #789) exposed the dimmed
// backdrop over the page. The fix is the `.un-sheet::after` filler in
// native.css; these tests pin the three code paths that produce a negative
// y, so a future preset/limit change can't quietly start assuming y >= 0
// and leave the CSS looking like dead weight.

test('sheet overscroll: an upward drag lifts the sheet above rest, bounded by the 32px limit', () => {
  // The drag path renders rubberband(raw, 32) for raw < 0 — a hard pull
  // lifts the sheet ~29px off the screen edge and holds there.
  const hard = rubberband(-500, 32);
  assert.ok(hard < 0, `hard upward pull must lift the sheet (got ${hard})`);
  assert.ok(hard > -32, `elastic give must stay inside the 32px limit (got ${hard})`);
  // Monotonic in between, so every pull depth exposes some strip.
  assert.ok(rubberband(-60, 32) < 0 && rubberband(-60, 32) > rubberband(-200, 32));
});

test('sheet overscroll: the entrance spring overshoots above rest on every open', () => {
  // The `sheet` preset is underdamped, so the slide-up crosses y=0 before
  // settling — a hairline lift on EVERY open, not just on a drag.
  const r = simulateSpring(400, 0, 0, PRESETS.sheet);
  const min = Math.min(...r.samples.map((s) => s.x));
  assert.ok(min < 0, `entrance spring must overshoot past rest (min y ${min})`);
});

test('sheet overscroll: a post-present shrink lifts the sheet off the screen edge', () => {
  // Same math as the #742 shrink test, asserted here for its #789
  // consequence: the lift is the full shrink delta (hundreds of px, far
  // past the 32px drag limit), which is why the CSS filler is viewport-tall
  // rather than sized for the drag case.
  assert.equal(remeasuredSheetY({ y: 0, oldHeight: 500, newHeight: 200 }), -300);
});

// ── Shipped stylesheet contract (issue #789) ───────────────────────────
// The overscroll fix lives in CSS, so the regression guard has to read the
// shipped stylesheet. (Same stance as tests/platform-ui.test.js pinning
// index.html's kit includes.)

const NATIVE_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'usernode-native', 'v1', 'native.css'),
  'utf8'
);

// The declaration block for one selector, verbatim.
function cssBlock(selector) {
  const at = NATIVE_CSS.indexOf(selector + ' {');
  assert.ok(at !== -1, `native.css lost the ${selector} rule`);
  const open = NATIVE_CSS.indexOf('{', at);
  const close = NATIVE_CSS.indexOf('}', open);
  return NATIVE_CSS.slice(open + 1, close);
}

test('native.css: .un-sheet::after extends the sheet surface below its bottom edge', () => {
  const block = cssBlock('.un-sheet::after');
  assert.match(block, /content:/, 'a pseudo-element without content never renders');
  assert.match(block, /position:\s*absolute/,
    'must be out of flow — in-flow would change sheet.offsetHeight, which seeds the spring, the backdrop denominator and the dismissal travel');
  assert.match(block, /top:\s*100%/, 'the filler starts at the sheet bottom edge');
  assert.match(block, /background:\s*var\(--un-sheet-bg\)/,
    'the filler must be theme-aware — a literal color breaks dark mode');
  assert.match(block, /height:\s*\d+(vh|dvh|lvh)/,
    'the filler must be viewport-tall: a shrink re-measure can lift the sheet hundreds of px, far past the 32px drag limit');
  assert.match(block, /pointer-events:\s*none/,
    'taps in the strip below the sheet must keep reaching the backdrop (which dismisses)');
});

test('native.css: .un-sheet does not clip its overscroll filler', () => {
  const block = cssBlock('.un-sheet');
  assert.ok(!/overflow:\s*hidden/.test(block),
    'overflow:hidden on .un-sheet would clip the overscroll filler away (issue #789)');
});

// ── Side panel contract ────────────────────────────────────────────────
// The drawer's overshoot fix and its inset handling live in CSS, so the
// guards read the shipped stylesheet — same stance as the sheet's ::after
// above. Its NON-draggability is a deliberate design decision (a nav
// drawer is not a bottom sheet), so that is pinned too: an earlier
// revision shipped drag-to-dismiss plus a grabber pill and both were
// removed as un-native.

test('native.css: .un-panel::after extends the panel surface past its edge', () => {
  const block = cssBlock('.un-panel::after');
  assert.match(block, /content:/, 'a pseudo-element without content never renders');
  assert.match(block, /position:\s*absolute/,
    'must be out of flow — in-flow would change panel.offsetWidth, which seeds the spring, the backdrop denominator and the dismissal travel');
  assert.match(block, /width:\s*\d+vw/,
    'the filler must be viewport-wide so no bounce depth uncovers the dimmed page');
  assert.match(block, /background:\s*var\(--un-panel-bg\)/,
    'the filler must be theme-aware — a literal color breaks dark mode');
  assert.match(block, /pointer-events:\s*none/,
    'taps outside the panel must keep reaching the backdrop (which dismisses)');
  // Anchored outward from the panel's own edge, per side.
  assert.match(cssBlock('.un-panel[data-un-side="right"]::after'), /left:\s*100%/,
    'a right drawer continues its surface to the RIGHT of the screen edge');
  assert.match(cssBlock('.un-panel[data-un-side="left"]::after'), /right:\s*100%/,
    'a left drawer continues its surface to the LEFT of the screen edge');
});

test('native.css: .un-panel does not clip its filler or restrict input', () => {
  const block = cssBlock('.un-panel');
  assert.ok(!/overflow:\s*hidden/.test(block),
    'overflow:hidden on .un-panel would clip the overshoot filler away (cf. .un-sheet)');
  // #970: the forwarded custom property first, env() as the standalone
  // fallback — bare env() is 0px inside a Homeroom app frame.
  assert.match(
    block,
    /padding-top:\s*var\(--un-safe-inset-top,\s*env\(safe-area-inset-top/,
    'rows must clear the status bar / notch, embedded as well as standalone'
  );
  assert.ok(!/transition:\s*[^;]*transform/.test(block),
    'translateX is JS-owned (entrance/exit springs) — a CSS transition on transform would fight it');
  // With no drag gesture there is nothing to take capability away for:
  // both of these only ever existed to serve the removed pointer handling.
  assert.ok(!/touch-action/.test(block),
    'a non-draggable drawer must not narrow touch-action — scrolling inside it is plain native scrolling');
  assert.ok(!/user-select/.test(block),
    'user-select:none existed only to keep a drag from selecting text; without the drag it just breaks selection');
});

test('native.css: the drawer ships no grabber affordance', () => {
  assert.ok(!/un-panel-grabber/.test(NATIVE_CSS),
    'the grabber pill promises a drag gesture the panel does not have — it belongs to .un-sheet only');
  // The sheet's own grabber must survive: it DOES drag.
  assert.ok(/\.un-sheet-grabber\s*\{/.test(NATIVE_CSS),
    'removing the panel grabber must not take the bottom sheet\'s with it');
});

test('native.css: the panel body absorbs the keyboard without stacking the safe area', () => {
  const body = cssBlock('.un-panel-body');
  assert.match(body, /overflow-y:\s*auto/, 'the body is the drawer scroller');
  assert.match(
    body,
    /var\(--un-safe-inset-bottom,\s*env\(safe-area-inset-bottom/,
    'the last row must clear the home indicator (#970: forwarded property first)'
  );
  assert.match(body, /var\(--un-kb-inset/,
    'a full-height panel cannot ride above the keyboard — it pads for it instead');
  const kb = cssBlock('html.un-kb .un-panel-body');
  assert.match(kb, /padding-bottom:\s*var\(--un-kb-inset, 0px\)/,
    'keyboard up: the safe area sits BEHIND the keyboard, so the two insets must not stack');
});

test('native.css: the drawer ships both theming tokens with a sheet-derived surface', () => {
  const root = cssBlock(':root');
  assert.match(root, /--un-panel-bg:\s*var\(--un-sheet-bg\)/,
    'deriving from --un-sheet-bg is what gives the panel dark mode for free');
  assert.match(root, /--un-panel-width:\s*min\(/,
    'the default width must be viewport-bounded so a narrow phone never gets a full-bleed drawer');
});

test('native.js: presentPanel reaches the public surface', () => {
  assert.match(NATIVE_JS, /function presentPanel\(/, 'the component exists');
  assert.match(NATIVE_JS, /presentPanel:\s*presentPanel/,
    'a component that never lands on global.unNative is unreachable by apps');
});

test('native.js: the drawer carries no drag machinery at all', () => {
  const at = NATIVE_JS.indexOf('function presentPanel(');
  // The function body, up to the next top-level component.
  const fn = NATIVE_JS.slice(at, NATIVE_JS.indexOf('\n  function ', at + 30));
  for (const [pattern, why] of [
    [/pointerdown|pointermove|pointerup|pointercancel/, 'pointer handling'],
    [/lockIntent/, 'an axis intent lock'],
    [/rubberband/, 'elastic over-drag'],
    [/gestures\.claim/, 'a gesture-arbiter claim'],
    [/estimateVelocity|projectDisplacement/, 'release-velocity projection'],
    [/setPointerCapture/, 'pointer capture'],
    [/stopPropagation/, 'a click swallow'],
    [/grabber/, 'a grabber affordance'],
  ]) {
    assert.ok(!pattern.test(fn),
      `presentPanel must not reintroduce ${why} — a nav drawer is closed by the backdrop / Escape / a row, not by swiping`);
  }
  // What it DOES keep: springs both ways, and the backdrop riding along.
  assert.match(fn, /springTo\(0\)/, 'the entrance spring');
  assert.match(fn, /springTo\(width, teardown\)/, 'the exit spring, then teardown');
  assert.match(fn, /backdrop\.style\.opacity/, 'the dim rides the slide as one motion');
  assert.match(fn, /modalStack\.push/, 'Escape dismissal via the shared modal stack');
});

// ── Pull-to-refresh puck sits BELOW the app header ─────────────────────
// The puck used to be anchored to the top of the scroller's PARENT — i.e.
// the top of the whole shell, header included — at z-index 2, so it was
// painted on top of the fixed header on the way down. It now lives in
// .un-ptr-layer, an overflow-clipped box anchored at the header's bottom
// edge and stacked underneath it. Both halves are load-bearing (the clip
// covers a translucent header, the stacking covers an opaque one), so
// guard both in the shipped stylesheet.

test('native.css: .un-ptr-layer clips the puck to below its anchor line', () => {
  const block = cssBlock('.un-ptr-layer');
  assert.match(block, /overflow:\s*hidden/,
    'without the clip the retracted puck (parked at -40px) rides up over the header');
  assert.match(block, /pointer-events:\s*none/,
    'the layer spans content — it must never swallow taps');
  assert.match(block, /z-index:\s*0/,
    'stack level 0 + first-in-tree-order keeps the layer under the header and the scroller');
  assert.match(block, /position:\s*absolute/);
});

test('native.css: window-mode puck layer stacks under .un-navbar', () => {
  const layer = cssBlock('.un-ptr-layer.un-ptr-layer-fixed');
  assert.match(layer, /position:\s*fixed/);
  assert.match(
    layer,
    /top:\s*var\(--un-safe-inset-top,\s*env\(safe-area-inset-top/,
    'with no anchor element the puck emerges from under the status bar, not the viewport top'
  );
  const layerZ = Number(/z-index:\s*(\d+)/.exec(layer)[1]);
  const navZ = Number(/z-index:\s*(\d+)/.exec(cssBlock('.un-navbar'))[1]);
  assert.ok(layerZ < navZ,
    `puck layer z-index ${layerZ} must stay under .un-navbar's ${navZ} — a fixed nav bar is never overlapped`);
});

test('native.css: the puck itself carries no stacking of its own', () => {
  const block = cssBlock('.un-ptr-puck');
  assert.ok(!/z-index/.test(block),
    'the old z-index:2 on the puck is what lifted it over the header — layering belongs to .un-ptr-layer now');
  assert.match(block, /position:\s*absolute/,
    'the puck positions inside the layer, even in window mode (the LAYER is the fixed one)');
});

// ── Where the puck comes to REST (issue #1526) ─────────────────────────
// #885 fixed the anchoring; the per-frame pose it left behind dated from
// the kit's first commit, when the puck was free-standing and unclipped.
// At the hold it parked at -9.2px — a quarter of the circle sliced off by
// the header's edge, with 31.8px of dead space underneath. The pose is
// derived from the puck's own box now (PTR_PUCK + PTR_PUCK_GAP), and it
// lives above the Node cut so these numbers are actually checkable.

test('ptrPuckOffset: the puck rests FULLY below the anchor line', () => {
  assert.ok(ptrPuckOffset(PTR_HOLD) >= 0,
    `#1526 regression guard: at the ${PTR_HOLD}px hold the puck's top sits at ` +
    `${ptrPuckOffset(PTR_HOLD)}px — anything negative is clipped by the header's edge`);
});

test('ptrPuckOffset: equal space above and below the resting puck', () => {
  const above = ptrPuckOffset(PTR_HOLD);
  const below = PTR_HOLD - ptrPuckOffset(PTR_HOLD) - PTR_PUCK;
  assert.ok(Math.abs(above - below) <= 1,
    `resting spacing is lopsided: ${above}px above vs ${below}px below (was 1:3.7)`);
});

test('ptrPuckOffset: parked entirely above the anchor when idle', () => {
  assert.ok(ptrPuckOffset(0) + PTR_PUCK <= 0,
    `at rest the whole puck must sit above the anchor line (bottom at ` +
    `${ptrPuckOffset(0) + PTR_PUCK}px) so nothing peeks over the header`);
});

test('the puck rests at full scale and full opacity while spinning', () => {
  // render() drives both from progress = min(1, y / PTR_THRESHOLD), so a
  // hold shorter than the arm threshold spins at 0.97 scale / 0.93 opacity
  // AND springs the content backwards on commit. One inequality pins both.
  assert.ok(PTR_HOLD >= PTR_THRESHOLD,
    `hold ${PTR_HOLD} < arm threshold ${PTR_THRESHOLD}: the puck would rest dimmed ` +
    'and undersized, and the content would spring backwards on release');
});

test('ptrPuckOffset: travel is strictly monotonic across the pull range', () => {
  let prev = -Infinity;
  for (let pull = 0; pull <= PTR_LIMIT; pull += 1) {
    const offset = ptrPuckOffset(pull);
    assert.ok(offset > prev,
      `the puck must never move backwards as the pull grows (${pull}px)`);
    prev = offset;
  }
});

test('ptrPuckOffset: a max-depth pull never escapes the clip window', () => {
  assert.ok(ptrPuckOffset(PTR_LIMIT) + PTR_PUCK <= PTR_LAYER_H,
    `at the ${PTR_LIMIT}px rubber-band asymptote the puck's bottom reaches ` +
    `${ptrPuckOffset(PTR_LIMIT) + PTR_PUCK}px, outside the ${PTR_LAYER_H}px layer`);
});

test('native.css: the painted puck box matches PTR_PUCK in native.js', () => {
  const block = cssBlock('.un-ptr-puck');
  const width = Number(/width:\s*(\d+)px/.exec(block)[1]);
  const height = Number(/height:\s*(\d+)px/.exec(block)[1]);
  assert.equal(width, PTR_PUCK,
    'the pose math is derived from PTR_PUCK — a painted box that drifts from it makes the balance meaningless');
  assert.equal(height, PTR_PUCK, 'the puck is a circle: width and height both mirror PTR_PUCK');
});

const NATIVE_JS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'usernode-native', 'v1', 'native.js'),
  'utf8'
);

test('native.js: the spinner lingers after onRefresh settles before retracting', () => {
  const hold = Number(/PTR_SETTLE_HOLD_MS\s*=\s*(\d+)/.exec(NATIVE_JS)[1]);
  assert.ok(hold >= 400 && hold <= 600,
    `post-refresh linger ${hold}ms is outside the 400-600ms band — the spinner must not vanish the instant the fetch resolves`);
  // The linger runs AFTER the work/min-hold race, not alongside it.
  assert.match(
    NATIVE_JS,
    /Promise\.all\(\[work, minHold\]\)\.then\([\s\S]{0,600}?setTimeout\([\s\S]{0,400}?PTR_SETTLE_HOLD_MS\)/,
    'the linger must be chained off the settled refresh, not raced against it'
  );
  assert.match(NATIVE_JS, /clearTimeout\(settleTimer\)/,
    'detach() during the linger must not retract a removed puck');
});

// ── Keyboard occlusion (issue #719) ────────────────────────────────────

test('keyboardInset: iOS overlay keyboard returns the occluded height', () => {
  // iPhone-ish: layout viewport 844px, keyboard shrinks the visual
  // viewport to 508px while overlaying the layout viewport.
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 508, vvOffsetTop: 0, vvScale: 1 }),
    336
  );
  // A scrolled visual viewport (offsetTop) reduces the occluded strip.
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 508, vvOffsetTop: 100, vvScale: 1 }),
    236
  );
  // Fractional viewport metrics round to integer px.
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 507.7, vvOffsetTop: 0, vvScale: 1 }),
    336
  );
});

test('keyboardInset: Android resize mode (innerHeight tracks the vv) returns 0', () => {
  // The layout viewport shrank with the keyboard — fixed bottom:0
  // already sits above it, so no extra inset (no double compensation).
  assert.equal(
    keyboardInset({ innerHeight: 508, vvHeight: 508, vvOffsetTop: 0, vvScale: 1 }),
    0
  );
});

test('keyboardInset: sub-threshold noise (URL-bar transients) returns 0', () => {
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 804, vvOffsetTop: 0, vvScale: 1 }),
    0
  );
  // Exactly at the threshold counts as a keyboard.
  assert.equal(
    keyboardInset({
      innerHeight: 844,
      vvHeight: 844 - physics.KB_MIN_INSET,
      vvOffsetTop: 0,
      vvScale: 1,
    }),
    physics.KB_MIN_INSET
  );
});

test('keyboardInset: pinch zoom forces 0 (a zoomed viewport is not a keyboard)', () => {
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 422, vvOffsetTop: 0, vvScale: 2 }),
    0
  );
  // Missing scale is treated as unzoomed.
  assert.equal(keyboardInset({ innerHeight: 844, vvHeight: 508, vvOffsetTop: 0 }), 336);
});

test('keyboardInset: negative occlusion clamps to 0', () => {
  assert.equal(
    keyboardInset({ innerHeight: 508, vvHeight: 844, vvOffsetTop: 0, vvScale: 1 }),
    0
  );
});

test('keyboardInset: explicit minInset override is honored, degenerate input is 0', () => {
  assert.equal(
    keyboardInset({ innerHeight: 844, vvHeight: 804, vvOffsetTop: 0, vvScale: 1, minInset: 20 }),
    40
  );
  assert.equal(keyboardInset(null), 0);
  assert.equal(keyboardInset(undefined), 0);
});

// ── Keyboard-avoidance reveal math ─────────────────────────────────────
// bottomLimit = innerHeight - inset - margin; topLimit is passed final
// (the caller adds its own margin, e.g. navbar bottom + margin).

test('revealScrollDelta: field under the keyboard scrolls down by the overlap', () => {
  // iPhone-ish: 844 viewport, 336 keyboard, 8 margin → bottomLimit 500.
  assert.equal(
    revealScrollDelta({
      fieldTop: 600, fieldBottom: 640, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    140
  );
});

test('revealScrollDelta: field above the top limit scrolls up (negative delta)', () => {
  assert.equal(
    revealScrollDelta({
      fieldTop: 20, fieldBottom: 60, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    -32
  );
});

test('revealScrollDelta: an already-visible field does not move (minimal motion)', () => {
  // scrollIntoView would count a field under the padding as visible; this
  // is the corrected math — inside [topLimit, bottomLimit] means delta 0.
  assert.equal(
    revealScrollDelta({
      fieldTop: 100, fieldBottom: 140, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    0
  );
  // Exactly at the limits is visible too.
  assert.equal(
    revealScrollDelta({
      fieldTop: 52, fieldBottom: 500, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    0
  );
});

test('revealScrollDelta: a field taller than the visible strip keeps its top visible', () => {
  // Strip is [52, 500]; a 600px-tall field can't fit — the clamp caps the
  // downward scroll so fieldTop lands at topLimit, never past it.
  assert.equal(
    revealScrollDelta({
      fieldTop: 300, fieldBottom: 900, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    248 // fieldTop 300 - topLimit 52, NOT fieldBottom 900 - bottomLimit 500
  );
  // Tall field whose top is already at the limit: no motion at all.
  assert.equal(
    revealScrollDelta({
      fieldTop: 52, fieldBottom: 900, innerHeight: 844, inset: 336, margin: 8, topLimit: 52,
    }),
    0
  );
});

test('revealScrollDelta: inset 0 degenerates to plain viewport math', () => {
  // Resize-mode Android / hardware keyboard: innerHeight already shrank,
  // so bottomLimit = innerHeight - margin is correct as-is.
  assert.equal(
    revealScrollDelta({
      fieldTop: 460, fieldBottom: 520, innerHeight: 508, inset: 0, margin: 8, topLimit: 8,
    }),
    20
  );
  assert.equal(revealScrollDelta(null), 0);
  assert.equal(revealScrollDelta(undefined), 0);
});

// ── Keyboard-avoidance text-entry allowlist ────────────────────────────

test('isTextEntryField: text-keyboard input types are intercepted', () => {
  for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number']) {
    assert.equal(isTextEntryField({ tag: 'input', type }), true, type);
  }
  assert.equal(isTextEntryField({ tag: 'textarea' }), true);
  assert.equal(isTextEntryField({ tag: 'div', contentEditable: true }), true);
  // Missing/unknown types default to text (the HTML default).
  assert.equal(isTextEntryField({ tag: 'input' }), true);
  assert.equal(isTextEntryField({ tag: 'input', type: 'made-up-type' }), true);
  // Case-insensitive, like the DOM.
  assert.equal(isTextEntryField({ tag: 'INPUT', type: 'Text' }), true);
});

test('isTextEntryField: non-text controls keep native taps', () => {
  for (const type of [
    'checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit',
    'reset', 'image', 'hidden', 'date', 'time', 'month', 'week', 'datetime-local',
  ]) {
    assert.equal(isTextEntryField({ tag: 'input', type }), false, type);
  }
  assert.equal(isTextEntryField({ tag: 'select' }), false);
  assert.equal(isTextEntryField({ tag: 'button' }), false);
  assert.equal(isTextEntryField({ tag: 'div' }), false);
});

test('isTextEntryField: disabled / readonly fields are never intercepted', () => {
  assert.equal(isTextEntryField({ tag: 'input', type: 'text', disabled: true }), false);
  assert.equal(isTextEntryField({ tag: 'input', type: 'text', readOnly: true }), false);
  assert.equal(isTextEntryField({ tag: 'textarea', readOnly: true }), false);
  assert.equal(isTextEntryField({ tag: 'div', contentEditable: true, disabled: true }), false);
  assert.equal(isTextEntryField(null), false);
  assert.equal(isTextEntryField(undefined), false);
});

// ── Gesture arbiter ────────────────────────────────────────────────────

test('gesture arbiter: first claim wins, owner re-claim is idempotent, release frees', () => {
  const a = createArbiter();
  const swipe = {};
  const ptr = {};
  assert.equal(a.claim('touch', swipe), true);
  assert.equal(a.claim('touch', ptr), false, 'second claimant must lose');
  assert.equal(a.claim('touch', swipe), true, 'owner re-claim is idempotent');
  assert.equal(a.owner('touch'), swipe);
  a.release('touch');
  assert.equal(a.owner('touch'), null);
  assert.equal(a.claim('touch', ptr), true, 'released sequence is claimable again');
  // Sequences are independent.
  assert.equal(a.claim(7, swipe), true);
  assert.equal(a.owner(7), swipe);
  assert.equal(a.owner('touch'), ptr);
  // Degenerate input never claims.
  assert.equal(a.claim(null, swipe), false);
  assert.equal(a.claim('touch', null), false);
});

// ── Velocity estimator ─────────────────────────────────────────────────

test('estimateVelocity computes px/ms over the sample window', () => {
  const samples = [];
  for (let i = 0; i <= 5; i++) samples.push({ t: i * 16, x: i * 10 }); // 10px / 16ms
  const v = estimateVelocity(samples);
  assert.ok(Math.abs(v - 10 / 16) < 1e-9, `got ${v}`);
});

test('estimateVelocity ignores samples older than the window', () => {
  // Ancient fast movement, then holding still for the last 100ms.
  const samples = [
    { t: 0, x: 0 },
    { t: 10, x: 200 },
    { t: 500, x: 200 },
    { t: 590, x: 200 },
  ];
  assert.equal(estimateVelocity(samples, 100), 0);
});

test('estimateVelocity decays to zero across a held-still dwell before release', () => {
  // A fast drag, then the finger holds still for 250ms; the gesture
  // handlers push a final sample stamped at the release moment, which
  // pushes all the movement samples out of the window.
  const samples = [
    { t: 0, x: 0 },
    { t: 16, x: -20 },
    { t: 32, x: -40 },
    { t: 48, x: -60 },
    { t: 48 + 250, x: -60 }, // release-time sample after the dwell
  ];
  assert.equal(estimateVelocity(samples, 100), 0);
});

test('estimateVelocity handles degenerate input', () => {
  assert.equal(estimateVelocity([], 100), 0);
  assert.equal(estimateVelocity([{ t: 0, x: 5 }], 100), 0);
  assert.equal(estimateVelocity(null, 100), 0);
});

// ── Intent lock ────────────────────────────────────────────────────────

test('lockIntent stays null under the threshold, then picks the dominant axis', () => {
  assert.equal(lockIntent(4, 4), null);
  assert.equal(lockIntent(-9, 3), null);
  assert.equal(lockIntent(-14, 3), 'x');
  assert.equal(lockIntent(3, 18), 'y');
  // Custom threshold
  assert.equal(lockIntent(6, 1, 5), 'x');
});

// ── Rubber band ────────────────────────────────────────────────────────

test('rubberband is monotonic, sign-preserving and bounded by the limit', () => {
  let prev = 0;
  for (let d = 10; d <= 2000; d += 10) {
    const out = rubberband(d, 150, 0.4);
    assert.ok(out > prev, 'must be monotonic');
    assert.ok(out < 150, `must stay under the limit (got ${out})`);
    prev = out;
  }
  assert.ok(rubberband(-100, 150, 0.4) < 0, 'sign-preserving');
  assert.equal(rubberband(0, 150, 0.4), 0);
});

test('rubberband initial slope approximates the coefficient', () => {
  const out = rubberband(1, 150, 0.4);
  assert.ok(Math.abs(out - 0.4) < 0.01, `slope near 0.4 at origin, got ${out}`);
});

test('rubberbandInvert round-trips (mid-settle grab re-enters the drag without a jump)', () => {
  for (const d of [5, 40, 90, 300, 1200]) {
    const display = rubberband(d, 150, 0.4);
    const back = rubberbandInvert(display, 150, 0.4);
    assert.ok(Math.abs(back - d) < 0.01, `roundtrip ${d} → ${display} → ${back}`);
  }
});

// ── Reorder hit-testing ────────────────────────────────────────────────

// Three 40px rows starting at y=100, packed tight.
const packed = [
  { top: 100, bottom: 140 },
  { top: 140, bottom: 180 },
  { top: 180, bottom: 220 },
];

test('reorderDropIndex: inside an item, the midpoint splits before/after', () => {
  assert.equal(reorderDropIndex(110, packed), 0, 'above first midpoint → gap 0');
  assert.equal(reorderDropIndex(130, packed), 1, 'below first midpoint → gap 1');
  assert.equal(reorderDropIndex(159, packed), 1);
  assert.equal(reorderDropIndex(161, packed), 2);
  assert.equal(reorderDropIndex(215, packed), 3, 'bottom half of the last row → append');
});

test('reorderDropIndex: outside the list snaps to the first/last gap', () => {
  assert.equal(reorderDropIndex(20, packed), 0, 'far above → insert at top');
  assert.equal(reorderDropIndex(900, packed), 3, 'far below → append');
});

test('reorderDropIndex: a section header / deadspace snaps to the NEAREST gap', () => {
  // Two sections with a 60px header band between them (rows 0-1, rows 2-3).
  const sectioned = [
    { top: 100, bottom: 140 },
    { top: 140, bottom: 180 },
    { top: 240, bottom: 280 }, // section 2, after a 60px header/deadspace
    { top: 280, bottom: 320 },
  ];
  // Hovering the header band (y 180..240): the nearest gap is 2 in the
  // lower half — "insert at the top of that section", never "append".
  assert.equal(reorderDropIndex(235, sectioned), 2);
  assert.equal(reorderDropIndex(212, sectioned), 2, 'past the band midpoint → section top');
  // The very start of the band is closer to gap 2's boundary too (the gap
  // midpoint is 210, so everything above it maps to the same gap index),
  // but a y right at the last row of section 1 stays with it.
  assert.equal(reorderDropIndex(175, sectioned), 2, 'bottom half of row 1 → after it');
});

test('reorderDropIndex: degenerate input', () => {
  assert.equal(reorderDropIndex(50, []), 0);
  assert.equal(reorderDropIndex(50, null), 0);
});

// ── Grid reorder drop side (attachReorder grid mode) ───────────────────

test('gridDropSide: a tile sharing its row splits at the horizontal midpoint', () => {
  // 100px-wide tile at x 200..300 in a 1000px list (multi-column).
  const tile = { left: 200, top: 100, width: 100, height: 120 };
  assert.equal(gridDropSide(tile, 1000, 240, 160), 'before', 'left half → before');
  assert.equal(gridDropSide(tile, 1000, 260, 160), 'after', 'right half → after');
  // The y coordinate is irrelevant for multi-column tiles — top-right
  // still reads as "after", bottom-left as "before".
  assert.equal(gridDropSide(tile, 1000, 290, 101), 'after');
  assert.equal(gridDropSide(tile, 1000, 210, 219), 'before');
});

test('gridDropSide: a full-width tile splits at the vertical midpoint', () => {
  // Tile spanning (almost) the whole list — single-column layout.
  const row = { left: 0, top: 100, width: 960, height: 80 };
  assert.equal(gridDropSide(row, 1000, 480, 120), 'before', 'top half → before');
  assert.equal(gridDropSide(row, 1000, 480, 170), 'after', 'bottom half → after');
  // x is irrelevant for full-width rows.
  assert.equal(gridDropSide(row, 1000, 950, 110), 'before');
  assert.equal(gridDropSide(row, 1000, 10, 175), 'after');
});

test('gridDropSide: the ~90% width threshold separates the two regimes', () => {
  // 89% of the list width → still a row-sharing tile (x decides)…
  const narrow = { left: 0, top: 0, width: 890, height: 100 };
  assert.equal(gridDropSide(narrow, 1000, 300, 90), 'before', 'x-left wins despite bottom y');
  // …while 90%+ is treated as full-width (y decides).
  const wide = { left: 0, top: 0, width: 900, height: 100 };
  assert.equal(gridDropSide(wide, 1000, 300, 90), 'after', 'bottom y wins despite left x');
});

// ── attachGridPlacement (free-form placement) ──────────────────────────
//
// A SIBLING of attachReorder's grid mode, not a flag on it. attachReorder
// speaks in a dense index space (onReorder(from, to, item) over a list where
// every position is occupied) and enforces that by moving the real item
// through the DOM live while siblings FLIP aside. Free placement has no such
// index — a layout with holes is not an ordering — and must leave every
// other item exactly where it is.

test('attachGridPlacement is exported and documented beside attachReorder', () => {
  assert.match(NATIVE_JS, /attachGridPlacement: attachGridPlacement,/);
  assert.match(NATIVE_JS, /\*\s+unNative\.attachGridPlacement\(listEl, opts\)/,
    'the header surface list names it');
  // Nothing about the drop is decided by the kit: the host answers "which
  // cell is this point in", which keeps the kit free of any assumption about
  // row heights, gaps or grid-template-columns.
  const fn = NATIVE_JS.slice(
    NATIVE_JS.indexOf('function attachGridPlacement(listEl, options) {'),
    NATIVE_JS.indexOf('/* ────────────────────────────────────────────────────────────────────\n   * Page transitions'));
  assert.ok(fn.length > 1000, 'located attachGridPlacement');
  assert.match(fn, /opts\.cellFromPoint\(drag\.lastX, drag\.lastY, ghostInfo\(\)\)/,
    'the pointer stays the first two arguments; the tile’s geometry rides along');
  assert.match(fn, /opts\.canPlace\(drag\.item, cell\)/);
  assert.match(fn, /opts\.onPlace\(item, cell\)/);
  // The real item never moves during the drag — that is the whole
  // difference from displacement mode.
  assert.doesNotMatch(fn, /insertBefore|gridFlip/);
  // The ghost must not occlude the host's own elementFromPoint hit-test.
  assert.match(fn, /ghost\.style\.pointerEvents = 'none'/);
});

// The finger is not the tile. The ghost tracks the pointer from wherever the
// item was grabbed, so a host that resolves its target from x/y puts the
// tile's TOP-LEFT under the finger — for a multi-cell item the highlight then
// sits a whole tile away from the block the user is holding. The kit can't fix
// that itself (it computes no cells) but it is the only party that knows where
// the ghost actually is, so it reports that geometry and the doc tells hosts
// to use the centroid.
test('cellFromPoint is handed the dragged TILE’s live geometry, not just the finger', () => {
  const fn = NATIVE_JS.slice(
    NATIVE_JS.indexOf('function attachGridPlacement(listEl, options) {'),
    NATIVE_JS.indexOf('/* ────────────────────────────────────────────────────────────────────\n   * Page transitions'));

  const info = fn.slice(fn.indexOf('function ghostInfo() {'), fn.indexOf('function update() {'));
  assert.ok(info.length > 100, 'located ghostInfo()');

  // The ghost is position:fixed, so its viewport rect is the lift rect plus
  // the live translate — pure arithmetic. A getBoundingClientRect() here would
  // put a forced layout on the pointermove path.
  assert.match(info, /var left = drag\.ghostLeft \+ drag\.gx;/);
  assert.match(info, /var top = drag\.ghostTop \+ drag\.gy;/);
  assert.doesNotMatch(info, /getBoundingClientRect/);
  const update = fn.slice(fn.indexOf('function update() {'), fn.indexOf('function autoScrollFrame() {'));
  assert.doesNotMatch(update, /getBoundingClientRect/);

  // Size comes from the lift measurement, so the rect is complete.
  assert.match(fn, /drag\.ghostW = rect\.width;/);
  assert.match(fn, /drag\.ghostH = rect\.height;/);
  assert.match(info, /width: drag\.ghostW, height: drag\.ghostH/);

  // The dragged item rides along (mirroring canPlace/onHover), and so does the
  // CENTRE — the thing a host needs to place a footprint under the tile.
  assert.match(info, /item: drag\.item,/);
  assert.match(info, /centerX: left \+ drag\.ghostW \/ 2,/);
  assert.match(info, /centerY: top \+ drag\.ghostH \/ 2,/);
  // x/y keep their meaning, so a host that ignores info is unaffected.
  assert.match(info, /pointerX: drag\.lastX,/);
  assert.match(info, /pointerY: drag\.lastY,/);

  // And the contract says which one to answer from.
  const doc = NATIVE_JS.slice(
    NATIVE_JS.indexOf('// attachGridPlacement(listEl, {'),
    NATIVE_JS.indexOf('function attachGridPlacement(listEl, options) {'));
  assert.match(doc, /cellFromPoint\(x, y, info\)/);
  assert.match(doc, /CENTROID/, 'the doc block names the rule hosts should follow');
});

test('attachGridPlacement never throws on bad input', () => {
  // Same contract attachReorder carries: a bad call logs a warning and
  // returns a no-op handle, so a host that wires it defensively is never the
  // reason a page dies.
  const fn = NATIVE_JS.slice(
    NATIVE_JS.indexOf('function attachGridPlacement(listEl, options) {'),
    NATIVE_JS.indexOf('/* ────────────────────────────────────────────────────────────────────\n   * Page transitions'));
  assert.match(fn, /var noop = \{ detach: function \(\) \{\} \};/);
  assert.match(fn, /if \(!listEl \|\| listEl\.nodeType !== 1\) \{[\s\S]*?console\.warn[\s\S]*?return noop;/);
  // cellFromPoint is the one REQUIRED option — without it the kit has no way
  // to resolve a drop at all, so it disables itself rather than guessing.
  assert.match(fn, /typeof opts\.cellFromPoint !== 'function'[\s\S]*?console\.warn[\s\S]*?return noop;/);
});

test('attachGridPlacement fires onSettle on every teardown path', () => {
  // A mid-lift detach never reaches release(), so onSettle has to fire from
  // detach() too — otherwise a host deferral flag set in onLift (the guard
  // that stops a WS event replacing the grid) gets stuck on forever.
  const fn = NATIVE_JS.slice(
    NATIVE_JS.indexOf('function attachGridPlacement(listEl, options) {'),
    NATIVE_JS.indexOf('/* ────────────────────────────────────────────────────────────────────\n   * Page transitions'));
  const detach = fn.slice(fn.indexOf('detach: function () {'));
  assert.match(detach, /if \(wasLifted && opts\.onSettle\)/);
  assert.match(detach, /pendingFinish/, 'a ghost settle stopped mid-spring still owes its callbacks');
});

// ── The release glide ──────────────────────────────────────────────────
//
// One release must read as ONE motion: from wherever the ghost is under the
// finger, to the cell the tile lands in. Three separate things broke that,
// and each is pinned below.

test('the ghost glide runs in the PIXEL domain, not on 0→1 progress', () => {
  // isAtRest's thresholds are absolute — REST_DELTA px, REST_VELOCITY px/ms.
  // Drive a spring over a normalized 0→1 progress value through them and
  // "rest" fires while the progress is still REST_DELTA short of 1, i.e. at
  // ~66% of the travel: the ghost teleports the last third of the way. That
  // is not a tuning nit, it is the difference between landing and snapping.
  const norm = simulateSpring(0, 1, 0, PRESETS.stiff);
  assert.ok(norm.x < 0.7,
    `a normalized stiff spring quits at ${norm.x.toFixed(3)} of the travel`);

  // The same preset over the same journey expressed in pixels arrives.
  const dist = 300;
  const px = simulateSpring(dist, 0, 0, PRESETS.stiff);
  assert.ok(Math.abs(px.x) < physics.REST_DELTA, `pixel-domain spring arrives: ${px.x}`);
  assert.ok(px.durationMs > norm.durationMs,
    'and it takes longer, because it actually finishes the trip');

  // glideGhost is that spring, shared by both ghost drops.
  assert.match(NATIVE_JS, /function glideGhost\(ghost, gx, gy, tx, ty, onRest\) \{/);
  const glide = NATIVE_JS.slice(
    NATIVE_JS.indexOf('function glideGhost(ghost, gx, gy, tx, ty, onRest) {'),
    NATIVE_JS.indexOf('Swipe-to-act rows'));
  assert.match(glide, /from: dist, to: 0/, 'counts remaining DISTANCE down to zero');
  assert.doesNotMatch(glide, /from: 0, to: 1/);
  // Interpolates both axes off that one scalar, so the flight is a straight
  // line rather than two springs racing.
  assert.match(glide, /1 - remaining \/ dist/);
  assert.match(glide, /translate\('\s*\+\s*\n?\s*\(gx \+ dx \* p\) \+ 'px, ' \+ \(gy \+ dy \* p\) \+ 'px\)'/);

  // Neither drop site may hand-roll it again.
  assert.equal(NATIVE_JS.match(/activeSpring = glideGhost\(ghost, gx, gy, tx, ty,/g).length, 2,
    'both the reorder drop and the placement drop use it');
  assert.doesNotMatch(NATIVE_JS, /from: 0, to: 1, velocity: 0, preset: 'stiff'/,
    'no normalized ghost settle survives anywhere in the kit');
});

test('the placement glide STARTS at the ghost’s live offset and ENDS on the landing cell', () => {
  const fn = NATIVE_JS.slice(
    NATIVE_JS.indexOf('function attachGridPlacement(listEl, options) {'),
    NATIVE_JS.indexOf('/* ────────────────────────────────────────────────────────────────────\n   * Page transitions'));
  const release = fn.slice(fn.indexOf('function release(cancelled) {'),
    fn.indexOf('function onPointerDown(e) {'));
  assert.ok(release.length > 500, 'located release()');

  // ORIGIN: the ghost's own live translate under the finger. Re-deriving it
  // from the pointer would drop the lift offset and jump on the first frame.
  assert.match(release, /var gx = drag\.gx;\n\s*var gy = drag\.gy;/);

  // TARGET: the host's landing rect for a COMMITTED drop. The real item never
  // moves during a placement drag, so its own rect is still the ORIGIN cell —
  // settling there flies the tile back to where it was picked up and only
  // then lets the re-render pop it into the drop cell.
  assert.match(release, /if \(placed && typeof opts\.rectForCell === 'function'\)/);
  assert.match(release, /target = opts\.rectForCell\(item, cell\)/);
  assert.match(release, /var tx = target\.left - drag\.ghostLeft;/);
  assert.match(release, /var ty = target\.top - drag\.ghostTop;/);
  // A host that omits it, or returns something unmeasurable, still gets a
  // glide rather than NaN.
  assert.match(release, /if \(!target \|\| typeof target\.left !== 'number'[\s\S]*?target = item\.getBoundingClientRect\(\);/);
  assert.match(release, /catch \(err\) \{ target = null; \}/);
  // A refused or cancelled drop lands nowhere, so it never asks the host and
  // springs back to the item instead — `placed` is what gates it, and it is
  // false for both.
  assert.match(release, /var placed = !cancelled && !!cell && drag\.ok;/);
  assert.equal(release.match(/opts\.rectForCell\(/g).length, 1,
    'one call, behind the placed gate');
});

test('nothing swaps into place until the glide finishes', () => {
  const fn = NATIVE_JS.slice(
    NATIVE_JS.indexOf('function attachGridPlacement(listEl, options) {'),
    NATIVE_JS.indexOf('/* ────────────────────────────────────────────────────────────────────\n   * Page transitions'));
  const release = fn.slice(fn.indexOf('function release(cancelled) {'),
    fn.indexOf('function onPointerDown(e) {'));
  const finish = release.slice(release.indexOf('function finish() {'),
    release.indexOf('listEl.classList.remove(\'un-reordering\')'));

  // The host's re-render is driven from onPlace, and the origin slot and
  // ghost come off, all inside finish() — which the spring's onRest calls.
  for (const owed of [/opts\.onPlace\(item, cell\)/, /removeChild\(ghost\)/,
    /item\.classList\.remove\('un-reorder-slot'\)/, /opts\.onSettle\(placed\)/]) {
    assert.match(finish, owed);
  }
  assert.match(release, /activeSpring = glideGhost\(ghost, gx, gy, tx, ty, function \(\) \{\n\s*activeSpring = null;\n\s*finish\(\);/,
    'finish() is the glide’s onRest, not something release() runs itself');
  // …and nothing above finish() may do any of it early.
  const beforeFinish = release.slice(0, release.indexOf('function finish() {'));
  assert.doesNotMatch(beforeFinish, /onPlace|removeChild|un-reorder-slot/);

  // The displacement preview is part of the same motion: clearing hover at
  // release would snap the displaced occupants back to their old cells while
  // the tile is still in the air, then move them a second time on the
  // re-render. A committed drop tears it down in finish(); a REFUSED one
  // clears at once, because nothing is landing.
  assert.match(release, /if \(!placed\) hover\(null, false\);/);
  assert.match(finish, /if \(placed && opts\.onHover\)[\s\S]*?opts\.onHover\(item, null, false\)/);
  // Ordering inside finish(): the preview comes off in the same task as the
  // re-render onPlace triggers, so both land in one paint.
  assert.ok(finish.indexOf('onHover') < finish.indexOf('onPlace'));
});

// ── Reorder edge auto-scroll ───────────────────────────────────────────

test('autoScrollVelocity: zero outside the edge band, ramps to ±max at the edge', () => {
  // Viewport 0..800, 48px band, 14px/frame max.
  assert.equal(autoScrollVelocity(400, 0, 800, 48, 14), 0, 'mid-viewport → no scroll');
  assert.equal(autoScrollVelocity(48, 0, 800, 48, 14), 0, 'band boundary → still zero');
  // Inside the top band: negative (scroll up), growing toward the edge.
  const shallow = autoScrollVelocity(40, 0, 800, 48, 14);
  const deep = autoScrollVelocity(8, 0, 800, 48, 14);
  assert.ok(shallow < 0 && deep < shallow, `ramps up: ${shallow} vs ${deep}`);
  assert.equal(autoScrollVelocity(0, 0, 800, 48, 14), -14, 'top edge → -max');
  assert.equal(autoScrollVelocity(-50, 0, 800, 48, 14), -14, 'past the edge → clamped');
  // Bottom band mirrors with positive velocity.
  assert.ok(autoScrollVelocity(770, 0, 800, 48, 14) > 0);
  assert.equal(autoScrollVelocity(800, 0, 800, 48, 14), 14);
  assert.equal(autoScrollVelocity(900, 0, 800, 48, 14), 14, 'past the bottom → clamped');
});

test('autoScrollVelocity: defaults and degenerate band', () => {
  // Defaults: 48px band, 14px/frame.
  assert.equal(autoScrollVelocity(0, 0, 800), -14);
  assert.equal(autoScrollVelocity(400, 0, 800), 0);
  assert.equal(autoScrollVelocity(0, 0, 800, 0, 14), 0, 'zero-width band never scrolls');
});

// ── Reorder vs swipe arbitration ───────────────────────────────────────

test('gesture arbiter: a reorder claim loses to an earlier swipe claim and vice versa', () => {
  const a = createArbiter();
  const swipe = { swipe: true };
  const reorder = { reorder: true };
  // Swipe locks the x axis first: the long-press lift must back off.
  assert.equal(a.claim('touch', swipe), true);
  assert.equal(a.claim('touch', reorder), false, 'reorder lift must abort');
  a.release('touch');
  // Reorder lifts first: a later swipe x-lock on the same finger loses.
  assert.equal(a.claim('touch', reorder), true);
  assert.equal(a.claim('touch', swipe), false, 'swipe must back off mid-reorder');
});

// ── Toast slot state machine (priority / pending displacement) ─────────

test('toast slot: ordinary replaces visible ordinary (last-writer-wins)', () => {
  const slot = createToastSlot();
  const a = { priority: false };
  const b = { priority: false };
  assert.deepEqual(slot.show(a), { display: 'replace', closed: [] });
  const r = slot.show(b);
  assert.equal(r.display, 'replace');
  assert.deepEqual(r.closed, [a]);
  assert.equal(slot.current(), b);
  assert.equal(slot.pending(), null);
});

test('toast slot: ordinary queues behind a visible priority toast', () => {
  const slot = createToastSlot();
  const undo = { priority: true };
  const saved = { priority: false };
  slot.show(undo);
  const r = slot.show(saved);
  assert.equal(r.display, 'queue');
  assert.deepEqual(r.closed, []);
  assert.equal(slot.current(), undo, 'the priority toast keeps the visible slot');
  assert.equal(slot.pending(), saved);
});

test('toast slot: a second queued ordinary replaces the first pending (depth stays 1)', () => {
  const slot = createToastSlot();
  const undo = { priority: true };
  const first = { priority: false };
  const second = { priority: false };
  slot.show(undo);
  slot.show(first);
  const r = slot.show(second);
  assert.equal(r.display, 'queue');
  assert.deepEqual(r.closed, [first], 'the dropped pending toast is reported closed');
  assert.equal(slot.pending(), second);
});

test('toast slot: priority replaces priority; the pending ordinary survives', () => {
  const slot = createToastSlot();
  const undo1 = { priority: true };
  const saved = { priority: false };
  const undo2 = { priority: true };
  slot.show(undo1);
  slot.show(saved);
  const r = slot.show(undo2);
  assert.equal(r.display, 'replace');
  assert.deepEqual(r.closed, [undo1]);
  assert.equal(slot.current(), undo2);
  assert.equal(slot.pending(), saved);
});

test('toast slot: priority replaces a visible ordinary toast', () => {
  const slot = createToastSlot();
  const saved = { priority: false };
  const undo = { priority: true };
  slot.show(saved);
  const r = slot.show(undo);
  assert.equal(r.display, 'replace');
  assert.deepEqual(r.closed, [saved]);
  assert.equal(slot.current(), undo);
});

test('toast slot: resolution promotes the pending toast exactly once', () => {
  const slot = createToastSlot();
  const undo = { priority: true };
  const saved = { priority: false };
  slot.show(undo);
  slot.show(saved);
  assert.equal(slot.resolve(undo), saved);
  assert.equal(slot.current(), saved);
  assert.equal(slot.pending(), null);
  assert.equal(slot.resolve(undo), null, 'a stale resolve is a no-op');
  assert.equal(slot.current(), saved, 'a stale resolve must not clear the slot');
  assert.equal(slot.resolve(saved), null, 'nothing left to promote');
  assert.equal(slot.current(), null);
});

test('toast slot: cancelPending removes only the queued record', () => {
  const slot = createToastSlot();
  const undo = { priority: true };
  const saved = { priority: false };
  slot.show(undo);
  slot.show(saved);
  assert.equal(slot.cancelPending(undo), false, 'the visible record is not pending');
  assert.equal(slot.cancelPending(saved), true);
  assert.equal(slot.pending(), null);
  assert.equal(slot.resolve(undo), null, 'a cancelled pending toast never promotes');
});

test('toast slot: every record ends exactly once across a mixed sequence', () => {
  // Drive the machine with a mixed priority/ordinary sequence and count
  // lifecycle ends per record: displaced (via show().closed) or resolved
  // (the visible slot ending). Exactly-once here is what guarantees the
  // DOM layer's exactly-once onClose.
  const slot = createToastSlot();
  const records = [];
  const ended = new Map();
  function mk(priority) {
    const r = { priority, id: records.length };
    records.push(r);
    ended.set(r, 0);
    return r;
  }
  function end(r) { ended.set(r, ended.get(r) + 1); }
  for (const p of [false, true, false, false, true, true, false]) {
    for (const c of slot.show(mk(p)).closed) end(c);
  }
  // Drain: resolve whatever is visible until the slot empties.
  let cur = slot.current();
  while (cur) { end(cur); cur = slot.resolve(cur); }
  for (const r of records) {
    assert.equal(ended.get(r), 1, `record ${r.id} ended ${ended.get(r)} times`);
  }
});

// ── Anchored popover placement (issue #741) ────────────────────────────
//
// placePopover is the pure half of unNative.popover(): given the anchor
// rect, the measured panel size and the viewport, it returns where the
// panel goes — flipped to the opposite vertical side when the preferred
// side overflows, clamped horizontally, and reporting the side actually
// used. All placement decisions live here precisely so they're testable
// without a DOM.

const { placePopover } = physics;

test('popover placement: fits below → bottom-start at the anchor left edge with the default gutter', () => {
  const p = placePopover({
    anchor: { left: 100, top: 50, right: 130, bottom: 80 },
    size: { w: 200, h: 240 },
    viewport: { w: 1200, h: 800 },
  });
  assert.deepEqual(p, { left: 100, top: 84, placement: 'bottom-start' });
});

test('popover placement: flips above when the panel would poke past the bottom edge, and reports it', () => {
  const p = placePopover({
    anchor: { left: 100, top: 600, right: 130, bottom: 630 },
    size: { w: 200, h: 240 },
    viewport: { w: 1200, h: 800 },
  });
  // 630 + 4 + 240 = 874 > 800 - 8 → flip: top = 600 - 240 - 4
  assert.equal(p.top, 356);
  assert.equal(p.placement, 'top-start');
});

test('popover placement: clamps at the right viewport edge (never past w - margin)', () => {
  const p = placePopover({
    anchor: { left: 1150, top: 50, right: 1180, bottom: 80 },
    size: { w: 200, h: 100 },
    viewport: { w: 1200, h: 800 },
  });
  assert.equal(p.left, 1200 - 200 - 8);
  assert.equal(p.placement, 'bottom-start');
});

test('popover placement: clamps at the left viewport edge (bottom-end hanging leftward)', () => {
  const p = placePopover({
    anchor: { left: 10, top: 50, right: 40, bottom: 80 },
    size: { w: 200, h: 100 },
    viewport: { w: 1200, h: 800 },
    placement: 'bottom-end',
  });
  // end-align wants left = 40 - 200 = -160 → clamped to the 8px margin
  assert.equal(p.left, 8);
  assert.equal(p.placement, 'bottom-end');
});

test('popover placement: bottom-end aligns the panel right edge to the anchor right edge', () => {
  const p = placePopover({
    anchor: { left: 500, top: 50, right: 530, bottom: 80 },
    size: { w: 200, h: 100 },
    viewport: { w: 1200, h: 800 },
    placement: 'bottom-end',
  });
  assert.equal(p.left, 330);
  assert.equal(p.top, 84);
});

test('popover placement: top-start flips back below when there is no room above', () => {
  const p = placePopover({
    anchor: { left: 100, top: 40, right: 130, bottom: 70 },
    size: { w: 200, h: 240 },
    viewport: { w: 1200, h: 800 },
    placement: 'top-start',
  });
  assert.equal(p.top, 74);
  assert.equal(p.placement, 'bottom-start');
});

test('popover placement: a zero-size anchor rect works as point anchoring', () => {
  const p = placePopover({
    anchor: { left: 300, top: 200, right: 300, bottom: 200 },
    size: { w: 200, h: 100 },
    viewport: { w: 1200, h: 800 },
  });
  assert.deepEqual(p, { left: 300, top: 204, placement: 'bottom-start' });
});

test('popover placement: a flipped panel taller than the space above still clamps inside the viewport', () => {
  // No room below AND not enough above: flip is chosen, then the top
  // clamps to the margin so the panel (max-height'd by the CSS) never
  // leaves the viewport.
  const p = placePopover({
    anchor: { left: 100, top: 100, right: 130, bottom: 780 },
    size: { w: 200, h: 400 },
    viewport: { w: 1200, h: 800 },
  });
  assert.equal(p.placement, 'top-start');
  assert.equal(p.top, 8);
});

test('popover placement: gutter and margin are tunable', () => {
  const p = placePopover({
    anchor: { left: 0, top: 50, right: 30, bottom: 80 },
    size: { w: 200, h: 100 },
    viewport: { w: 1200, h: 800 },
    gutter: 10,
    margin: 16,
  });
  assert.equal(p.top, 90);
  assert.equal(p.left, 16);
});

// ── Zoom-from-element math (transition 'zoom-in'/'zoom-out') ───────────

test('zoomPose maps the screen rect onto the tile rect (translate + scale)', () => {
  // A 100×80 tile at (40, 300) inside a 390×700 screen region at (0, 60):
  // the pose that shrinks the screen onto the tile (transform-origin 0 0).
  const tile = { left: 40, top: 300, width: 100, height: 80 };
  const screen = { left: 0, top: 60, width: 390, height: 700 };
  const pose = zoomPose(tile, screen);
  assert.equal(pose.tx, 40);
  assert.equal(pose.ty, 240);
  assert.ok(Math.abs(pose.sx - 100 / 390) < 1e-12);
  assert.ok(Math.abs(pose.sy - 80 / 700) < 1e-12);
  // Identity: a rect mapped onto itself is no transform at all.
  assert.deepEqual(zoomPose(screen, screen), { tx: 0, ty: 0, sx: 1, sy: 1 });
});

test('zoomPose rejects degenerate rects', () => {
  const ok = { left: 0, top: 0, width: 100, height: 100 };
  assert.equal(zoomPose(null, ok), null);
  assert.equal(zoomPose(ok, null), null);
  assert.equal(zoomPose({ left: 0, top: 0, width: 0, height: 50 }, ok), null);
  assert.equal(zoomPose(ok, { left: 0, top: 0, width: 390, height: 0 }), null);
});

test('zoomRectUsable accepts partially visible rects and rejects off-screen ones', () => {
  const vh = 800;
  // Fully on screen.
  assert.equal(zoomRectUsable({ left: 0, top: 100, width: 100, height: 100, bottom: 200 }, vh), true);
  // Partially visible at either edge still counts (the platform rule:
  // reject only when the rect is entirely outside the vertical band).
  assert.equal(zoomRectUsable({ left: 0, top: -50, width: 100, height: 100, bottom: 50 }, vh), true);
  assert.equal(zoomRectUsable({ left: 0, top: 790, width: 100, height: 100, bottom: 890 }, vh), true);
  // Entirely above / below the viewport → unusable.
  assert.equal(zoomRectUsable({ left: 0, top: -200, width: 100, height: 100, bottom: -100 }, vh), false);
  assert.equal(zoomRectUsable({ left: 0, top: 900, width: 100, height: 100, bottom: 1000 }, vh), false);
  // Degenerate: zero-size (a display:none source screen) or missing.
  assert.equal(zoomRectUsable({ left: 0, top: 0, width: 0, height: 0, bottom: 0 }, vh), false);
  assert.equal(zoomRectUsable(null, vh), false);
  // bottom is derived from top+height when absent (plain-object rects).
  assert.equal(zoomRectUsable({ left: 0, top: -50, width: 10, height: 100 }, vh), true);
  assert.equal(zoomRectUsable({ left: 0, top: -200, width: 10, height: 100 }, vh), false);
});

// ── Undefined-helper scope check (issue #929) ──────────────────────────
//
// The kit's DOM half is not unit-testable in Node (it needs a real
// document), so a *stale internal call* in it is invisible to this file
// and, because a browser only evaluates it when the surface is actually
// presented, invisible to `node --check` and to any page load that
// doesn't open that surface. That is exactly how #929 shipped: #915
// renamed `watchHeight(el, cb)` to `watchSize(el, prop, cb)` and updated
// the bottom sheet but not the action sheet, so EVERY touch action sheet
// (the home app-card menu, the dev screen's "+" menu) threw
// "watchHeight is not defined" on present — mounting an invisible
// full-screen backdrop and never showing a menu.
//
// So check it statically instead: every identifier the file CALLS must be
// declared somewhere in the file, or be one of the browser/JS globals
// listed below. Cheap, no parser dependency, and it fails on the next
// rename miss anywhere in the kit — including in the presenters this test
// file can't otherwise reach.
test('every helper native.js calls is declared in it (no stale renames)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'usernode-native', 'v1', 'native.js'),
    'utf8'
  );
  // Blank out comments and string/template literals so their contents
  // can't look like code. Order matters: comments first.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');

  const declared = new Set();
  const addName = (raw) => {
    const n = String(raw).trim().replace(/[=:].*$/, '').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
  };
  // Function declarations/expressions + their parameter lists.
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    if (m[1]) declared.add(m[1]);
    m[2].split(',').forEach(addName);
  }
  // var/let/const declarators, catch bindings, arrow parameters.
  for (const m of code.matchAll(/\b(?:var|let|const)\s+([^;\n=]+)/g)) m[1].split(',').forEach(addName);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) m[1].split(',').forEach(addName);
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);

  // Statement keywords that are followed by "(" and so read as calls.
  const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
    'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'case',
    'instanceof', 'throw', 'await', 'yield', 'super', 'this',
  ]);
  // Globals the kit is allowed to call. Deliberately a short, explicit
  // list: a NEW name showing up here should be a conscious decision, and
  // anything else is a typo or a stale internal helper.
  const GLOBALS = new Set([
    'String', 'Number', 'Boolean', 'Object', 'Array', 'Promise', 'Error',
    'Math', 'JSON', 'Date', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout',
    'clearTimeout', 'setInterval', 'clearInterval', 'getComputedStyle',
    'ResizeObserver', 'MutationObserver', 'IntersectionObserver',
    'CustomEvent', 'URLSearchParams', 'matchMedia', 'require',
  ]);

  const unknown = [];
  code.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (KEYWORDS.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
      unknown.push(`${name}() at native.js:${i + 1}`);
    }
  });
  assert.deepEqual(
    unknown,
    [],
    'native.js calls something it never declares (stale rename, or a new global '
      + 'that belongs in this test\'s GLOBALS list):\n  ' + unknown.join('\n  ')
  );
});

// ── Backdrop dismissal vs. the opening gesture's ghost click ───────────
// A tap that presents an overlay leaves a synthesized `click` behind
// ~300ms later, hit-tested against whatever is under the finger by then —
// the full-screen backdrop the present() just appended. Every backdrop
// dismissed on the first click it saw, so one tap opened AND closed the
// surface: the "Allow notifications" sheet rose from the bottom for a
// fraction of a second with nothing left to tap. The decision is a pure
// function so it can be pinned here; the wiring is pinned below it.

test('backdrop dismiss: the opening gesture\'s ghost click does not dismiss', () => {
  // No press of its own, inside the window: the ghost, and only the ghost.
  assert.equal(physics.decideBackdropDismiss({ pressed: false, elapsedMs: 0 }), false);
  assert.equal(physics.decideBackdropDismiss({ pressed: false, elapsedMs: 300 }), false);
  assert.equal(
    physics.decideBackdropDismiss({
      pressed: false,
      elapsedMs: physics.GHOST_CLICK_MS - 1,
    }),
    false,
    'the window is closed at its own boundary, not before it'
  );
});

test('backdrop dismiss: a deliberate backdrop tap dismisses immediately', () => {
  // A press ON the backdrop cannot be the press that opened the surface,
  // so it dismisses however early it arrives — no 450ms of dead overlay.
  assert.equal(physics.decideBackdropDismiss({ pressed: true, elapsedMs: 0 }), true);
  assert.equal(physics.decideBackdropDismiss({ pressed: true, elapsedMs: 10 }), true);
});

test('backdrop dismiss: an un-pressed click past the window still dismisses', () => {
  // Keeps a programmatic backdrop.click() (and any click the platform
  // synthesizes for assistive tech) working once the ghost cannot be one.
  assert.equal(
    physics.decideBackdropDismiss({ pressed: false, elapsedMs: physics.GHOST_CLICK_MS }),
    true
  );
  assert.equal(physics.decideBackdropDismiss({ pressed: false, elapsedMs: 5000 }), true);
});

test('backdrop dismiss: the kit\'s window matches the React dialog layer\'s', () => {
  // frontend/src/lib/static-modal.ts guards the same failure for the nine
  // static dialogs with MODAL_GESTURE_GUARD_MS. Two different numbers
  // would mean a ghost that is late enough to close a kit sheet but not a
  // React dialog (or the reverse) — keep them in step.
  const staticModal = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'static-modal.ts'), 'utf8');
  const react = Number(/MODAL_GESTURE_GUARD_MS\s*=\s*(\d+)/.exec(staticModal)[1]);
  assert.equal(physics.GHOST_CLICK_MS, react,
    `kit guard ${physics.GHOST_CLICK_MS}ms vs React guard ${react}ms`);
});

test('native.js: every dismissible backdrop goes through the guard', () => {
  // The bug was one raw listener per presenter. Binding 'click' straight
  // onto a backdrop is the shape that reintroduces it, so allow it in
  // exactly one place: inside onBackdropDismiss itself.
  const raw = [];
  NATIVE_JS.split('\n').forEach((line, i) => {
    if (/backdrop\.addEventListener\(\s*'click'/.test(line)) raw.push(i + 1);
  });
  const helperAt = NATIVE_JS.slice(0, NATIVE_JS.indexOf('function onBackdropDismiss('))
    .split('\n').length;
  const helperEnd = helperAt + 40;
  const strays = raw.filter((n) => n < helperAt || n > helperEnd);
  assert.deepEqual(strays, [],
    'a backdrop binds click directly instead of via onBackdropDismiss — '
      + `native.js:${strays.join(', ')}`);

  // And each presenter that HAS a dismissible backdrop is wired.
  const wired = (NATIVE_JS.match(/[^\w]onBackdropDismiss\(backdrop, function/g) || []).length;
  assert.equal(wired, 4,
    'the bottom sheet, modal, side panel and action sheet all dismiss on '
      + 'their backdrop and all four must be guarded');
});

test('native.js: only pointerdown/touchstart count as a real backdrop press', () => {
  // The ghost is a compatibility MOUSE sequence (mousedown → mouseup →
  // click) synthesized from a touch that landed on the opener. Treating
  // its mousedown as a press would hand the guard straight back the
  // answer it exists to reject — so mousedown is only a press signal on a
  // browser with neither pointer events nor touch, where it cannot be one.
  const at = NATIVE_JS.indexOf('function onBackdropDismiss(');
  const fn = NATIVE_JS.slice(at, NATIVE_JS.indexOf('\n  // presentSheet(', at));
  assert.match(fn, /addEventListener\('pointerdown', press\)/);
  assert.match(fn, /addEventListener\('touchstart', press/);
  const mouse = fn.indexOf("addEventListener('mousedown', press)");
  assert.ok(mouse > 0, 'the no-pointer-no-touch fallback still exists');
  assert.match(fn.slice(0, mouse), /PointerEvent === 'undefined'[\s\S]*ontouchstart/,
    'the mousedown press signal must stay behind the no-pointer/no-touch guard');
  // A swallowed ghost must not bubble on to re-fire whatever opened us.
  assert.match(fn, /stopPropagation\(\)/);
  assert.match(fn, /preventDefault\(\)/);
});

// ── Menu-row icons (additive /v1) ───────────────────────────────────
//
// The kit's menus grew an optional icon. Two things have to stay true or
// the addition is not additive: a row that asks for no icon must render
// the DOM it rendered before this existed, and a menu where only SOME
// rows carry one must still line its labels up.

test('the icon registry answers only its own names', () => {
  assert.ok(physics.ICON_NAMES.length > 0, 'the set is not empty');
  for (const name of physics.ICON_NAMES) {
    const paths = physics.iconPaths(name);
    assert.ok(Array.isArray(paths) && paths.length > 0, `${name} has no geometry`);
    for (const d of paths) {
      assert.equal(typeof d, 'string');
      // A path that does not start with a move-to is a path the browser
      // silently drops — the icon would be an invisible hole in the row.
      assert.match(d, /^M/, `${name}: path does not open with a move-to`);
    }
  }
});

test('an unknown icon name is nothing, including a prototype member', () => {
  // `icon` is caller data. A bare property lookup would answer `toString`
  // with a function, and `constructor` with a constructor — neither is an
  // icon, and both would throw inside the renderer.
  for (const bogus of ['', null, undefined, 'nope', 'toString', 'constructor', '__proto__']) {
    assert.equal(physics.iconPaths(bogus), null, `iconPaths(${JSON.stringify(bogus)})`);
  }
});

test('rowHasIcon is the single answer both idioms ask', () => {
  // The action sheet and the popover must never disagree about whether a
  // menu is an icon menu — one of them aligning and the other not is the
  // failure this shared predicate exists to prevent.
  assert.equal(physics.rowHasIcon({ label: 'x' }), false);
  assert.equal(physics.rowHasIcon({ label: 'x', icon: 'nope' }), false);
  assert.equal(physics.rowHasIcon({ label: 'x', icon: 'home' }), true);
  // A caller-supplied node counts, but only a real element.
  assert.equal(physics.rowHasIcon({ label: 'x', iconEl: { nodeType: 1 } }), true);
  assert.equal(physics.rowHasIcon({ label: 'x', iconEl: 'not a node' }), false);
  assert.equal(physics.rowHasIcon({ label: 'x', iconEl: null }), false);
  assert.equal(physics.rowHasIcon(null), false);
  assert.equal(physics.rowHasIcon(undefined), false);
});

test('native.js: a row with no icon renders exactly what it always did', () => {
  // The whole additive claim rests on this line. Every app on the platform
  // has menus built before icons existed, and some of their checks select
  // on a row's text — so the no-icon path stays a bare textContent
  // assignment producing a single text node, not a wrapped span.
  const at = NATIVE_JS.indexOf('function fillRowButton(');
  assert.ok(at !== -1, 'fillRowButton must exist');
  const fn = NATIVE_JS.slice(at, NATIVE_JS.indexOf('\n  // Does this menu', at));
  assert.match(fn, /if \(!icon && !aligned\) \{\s*\n\s*btn\.textContent = item\.label;/,
    'the no-icon, no-alignment path must assign textContent directly');
  // …and with an icon, the label still has to be readable as the button's
  // own text, which is only true while the icon contributes none.
  assert.match(fn, /createElement\('span'\)/, 'the label is wrapped for truncation');
  assert.match(NATIVE_JS.slice(NATIVE_JS.indexOf('function buildRowIcon(')),
    /createElementNS\(SVG_NS, 'svg'\)/,
    'the kit icon is an SVG, which contributes no text to textContent');
});

test('native.js: both menu idioms fill their rows through the shared builder', () => {
  // Two call sites, one builder. A copy in either would be a second place
  // for the icon contract to be forgotten.
  const calls = (NATIVE_JS.match(/(?<!function )fillRowButton\(btn, (?:action|item), \w+\)/g) || []);
  assert.equal(calls.length, 2,
    `the action sheet and the popover both fill through it (got ${calls.length})`);
  assert.match(NATIVE_JS, /var sheetAligned = menuHasIcons\(actions\)/);
  assert.match(NATIVE_JS, /var popoverAligned = menuHasIcons\(opts\.items\)/);
});

test('the conventions document names exactly the icons the kit ships', () => {
  // Apps pick an icon by reading the handbook, and an unknown name draws
  // nothing rather than throwing — so a doc that lags the registry costs
  // an app a silent blank row, and a doc that runs ahead of it costs the
  // same. This is the only place the two lists meet.
  const doc = fs.readFileSync(
    path.join(__dirname, '..', 'src/prompts/app-conventions.md'), 'utf8'
  );
  const at = doc.indexOf('- **Menu-row icons.**');
  assert.ok(at !== -1, 'the conventions must document menu-row icons');
  const entry = doc.slice(at, doc.indexOf('\n- **', at + 4));
  const documented = (entry.match(/`([a-z]+)`/g) || [])
    .map((m) => m.slice(1, -1))
    .filter((name) => physics.ICON_NAMES.includes(name));
  assert.deepEqual(
    [...new Set(documented)].sort(),
    [...physics.ICON_NAMES].sort(),
    'the documented icon names and the kit registry have drifted',
  );
});

test('an icon row lets its label wrap, exactly as a bare label always did', () => {
  // A menu row before icons existed was a text node in a block button, so a
  // long label ran to a second line. Wrapping the label in a span to sit
  // beside an icon is the moment that could silently become an ellipsis —
  // and it would hide the end of every long row on the platform, on the
  // rows that need reading most. `min-width: 0` is what lets a flex child
  // wrap rather than push the icon out.
  const at = NATIVE_CSS.indexOf('.un-item-label {');
  assert.ok(at !== -1, '.un-item-label must be styled');
  const rule = NATIVE_CSS.slice(at, NATIVE_CSS.indexOf('}', at));
  assert.match(rule, /min-width:\s*0/);
  assert.doesNotMatch(rule, /white-space:\s*nowrap/,
    'a menu label must keep wrapping');
  assert.doesNotMatch(rule, /text-overflow:\s*ellipsis/,
    'a menu label must not be truncated');
});
