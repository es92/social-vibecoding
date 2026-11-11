// The featured illustration editor frames by DIRECT MANIPULATION — drag to
// pan, wheel/trackpad or pinch to zoom — and carries no sliders.
//
// Two halves, because the gestures and the render are testable at different
// depths:
//
//   1. frontend/src/lib/illustration-framing.ts is pure math and is executed
//      here. Its contract is the one the product promises: whatever the
//      gesture, the art still COVERS the card. The transform the card writes
//      is `translate(x%, y%) scale(zoom)` with the translate outside the
//      scale, so cover holds exactly while zoom >= 1 and |offset| <=
//      50 * (zoom - 1) — asserted below over a sweep rather than at a point.
//   2. The editor's render pass is checked for the absence of the three
//      retired `input[type=range]` controls, for the framing surface the
//      gestures bind to, and for the staged actions (Reset / Use app icon /
//      Save / Cancel) the conversion had to leave alone.
//
// Effects do not run under renderToStaticMarkup, so the pointer/wheel/key
// handlers themselves are verified in the browser on the build turn; what is
// pinned here is the math they call and the markup they hang off.
//
// Run with: node --test tests/featured-illustration-framing.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const framing = loadTsx('frontend/src/lib/illustration-framing.ts');
const {
  MIN_ZOOM, MAX_ZOOM, DEFAULT_FRAME, clampFrame, panFrame, zoomFrame, wheelZoomFactor,
  spreadOf, centreOf,
} = framing;

/** The cover invariant, stated the way the CSS renders it. */
function covers(frame) {
  const limit = (frame.zoom - 1) * 50 + 1e-9;
  return frame.zoom >= MIN_ZOOM && frame.zoom <= MAX_ZOOM
    && Math.abs(frame.x) <= limit && Math.abs(frame.y) <= limit;
}

test('the default frame is the exact cover fit, where no pan is legal', () => {
  assert.deepEqual(DEFAULT_FRAME, { zoom: 1, x: 0, y: 0 });
  assert.ok(covers(DEFAULT_FRAME));
  assert.deepEqual(panFrame(DEFAULT_FRAME, 0.5, -0.5), { zoom: 1, x: 0, y: 0 });
});

test('clamping rejects every framing that would open a gutter', () => {
  assert.deepEqual(clampFrame({ zoom: 0.5, x: 0, y: 0 }), { zoom: 1, x: 0, y: 0 });
  assert.deepEqual(clampFrame({ zoom: 9, x: 999, y: -999 }), { zoom: 3, x: 100, y: -100 });
  // The API's own range is wider (zoom from 0.5); a stored value is clamped,
  // not trusted, which is what keeps the Discover card gutter-free.
  assert.deepEqual(clampFrame({ zoom: 1.5, x: 40, y: -40 }), { zoom: 1.5, x: 25, y: -25 });
  for (const bad of [{ zoom: NaN, x: 0, y: 0 }, { zoom: 2, x: Infinity, y: NaN }]) {
    assert.ok(covers(clampFrame(bad)), `clamped ${JSON.stringify(bad)}`);
  }
});

test('panning and zooming can never leave the cover envelope', () => {
  let frame = DEFAULT_FRAME;
  for (let step = 0; step < 400; step++) {
    const factor = step % 7 === 0 ? 1.4 : step % 11 === 0 ? 0.6 : 1;
    frame = zoomFrame(frame, factor, (step % 5) / 4, (step % 3) / 2);
    frame = panFrame(frame, ((step % 9) - 4) / 5, ((step % 6) - 3) / 4);
    assert.ok(covers(frame), `step ${step}: ${JSON.stringify(frame)}`);
  }
});

test('a zoom holds the point under the cursor, once there is room to pan', () => {
  // Anchored at the frame's left edge: zooming in there must push the offset
  // right, keeping the same pixel of art under the cursor.
  const zoomed = zoomFrame({ zoom: 1.5, x: 0, y: 0 }, 4 / 3, 0, 0.5);
  assert.equal(zoomed.zoom, 2);
  // -50 (the left edge, in percent from the centre) held under a 1.5 -> 2
  // zoom lands the offset at -50 - (2/1.5)(-50) = +16.67, inside the +/-50
  // the new zoom allows.
  assert.equal(zoomed.x, 16.67);
  assert.equal(zoomed.y, 0);
  assert.ok(covers(zoomed));
  // Centre-anchored zoom leaves a centred frame centred.
  assert.deepEqual(zoomFrame({ zoom: 1, x: 0, y: 0 }, 2), { zoom: 2, x: 0, y: 0 });
  // Zooming back out drags the offset home rather than stranding it.
  assert.deepEqual(zoomFrame({ zoom: 2, x: 50, y: -50 }, 0.25), { zoom: 1, x: 0, y: 0 });
});

test('wheel notches read as multiplicative zoom, capped per event', () => {
  assert.ok(wheelZoomFactor(-100) > 1, 'scrolling up zooms in');
  assert.ok(wheelZoomFactor(100) < 1, 'scrolling down zooms out');
  assert.equal(wheelZoomFactor(0), 1);
  // A line-mode or page-mode wheel is scaled to pixels, and one flung event
  // cannot cross the whole 1..3 range.
  assert.ok(wheelZoomFactor(-3, 1) < wheelZoomFactor(-300, 0));
  for (const delta of [-10000, 10000]) {
    const factor = wheelZoomFactor(delta, 2);
    assert.ok(factor > 0.4 && factor < 2.5, `capped factor ${factor}`);
  }
});

test('pinch geometry uses the first two pointers and their midpoint', () => {
  assert.equal(spreadOf([{ x: 0, y: 0 }]), 0, 'one finger is a drag, not a pinch');
  assert.equal(spreadOf([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 5);
  assert.deepEqual(centreOf([{ x: 0, y: 10 }, { x: 10, y: 20 }]), { x: 5, y: 15 });
  assert.deepEqual(centreOf([{ x: 4, y: 6 }]), { x: 4, y: 6 });
});

test('the editor renders a gesture surface and no sliders', () => {
  const previous = global.window;
  global.window = { Home: null, HomePanels: null };
  let html;
  try {
    const { FeaturedIllustrationEditor } = loadTsx('frontend/src/features/apps/featured-illustration-editor.tsx');
    html = renderToHtml(createElement(FeaturedIllustrationEditor, {
      app: { slug: 'gym', name: 'Gym', status: 'ready', icon_emoji: '🏋️' },
      onClose: () => {},
    }));
  } finally {
    if (previous === undefined) delete global.window; else global.window = previous;
  }
  assert.ok(!/type="range"/.test(html), 'the Size / position sliders are gone');
  for (const label of ['Horizontal position', 'Vertical position']) {
    assert.ok(!html.includes(label), `retired control still rendered: ${label}`);
  }
  // The surface the pointer and wheel handlers bind to, with the card inside
  // it, plus the aria the gestures are announced through.
  assert.match(html, /data-framing-surface="false"/);
  assert.match(html, /aria-label="Illustration framing: drag to move, scroll or pinch to zoom, arrow keys to nudge"/);
  assert.match(html, /class="app-card home-discover-card/);
  // Staged actions are untouched by the conversion. Reset / Use app icon only
  // exist once an image is staged, so the fresh editor shows the propose
  // button (#2086: a save opens a governance card, so it says so) and Cancel.
  for (const label of ['Upload light image', 'Light', 'Dark', 'Propose change', 'Cancel']) assert.ok(html.includes(label), label);
});

test('the editor keeps the framing helpers as its only clamp, and the card covers', () => {
  const editor = read('frontend/src/features/apps/featured-illustration-editor.tsx');
  assert.match(editor, /from '\.\.\/\.\.\/lib\/illustration-framing'/);
  assert.ok(!/input type="range"|type="range"/.test(editor), 'no slider markup left in the source');
  // touch-action must be denied on the surface or a phone drag scrolls the
  // dialog instead of panning the art.
  assert.match(editor, /touchAction: interactive \? 'none'/);
  // And selection suppressed, or a drag across the card leaves the app name
  // and blurb under it highlighted — very visible on touch.
  assert.match(editor, /userSelect: 'none'/);
  assert.match(editor, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
  const discover = read('frontend/src/features/home/panels/discover.tsx');
  assert.match(discover, /clampFrame\(art\)/);
  assert.match(read('public/css/app.css'), /\.home-discover-illustration \{[^}]*object-fit: cover/);
});
