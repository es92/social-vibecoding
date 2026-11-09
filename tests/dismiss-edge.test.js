// The near-edge rule shared by every popup (#6475).
//
// A tap on a popup, or within a finger's width of its edge, kept closing it
// because touch hit-testing can retarget the tap to the backdrop behind it.
// `frontend/src/lib/dismiss-edge.ts` is the one arithmetic that says whether
// a point counts as ON the surface; the React dialog root, the anchored
// popovers and (through its own copy of the constant) the native kit all use
// it.
//
// Run with: node --test tests/dismiss-edge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  DISMISS_EDGE_TOLERANCE_PX,
  nearRect,
  nearAny,
} = require(path.join(__dirname, '..', 'frontend', 'src', 'lib', 'dismiss-edge.ts'));

// A 100x50 box away from the origin, so a synthetic (0, 0) can be told apart
// from a real point just outside its left or top edge.
const RECT = { left: 100, right: 200, top: 100, bottom: 150 };
const midX = (RECT.left + RECT.right) / 2;
const midY = (RECT.top + RECT.bottom) / 2;

test('the tolerance is a finger width', () => {
  assert.equal(DISMISS_EDGE_TOLERANCE_PX, 8);
});

test('a point on or up to 8px outside each edge counts as inside', () => {
  const sides = {
    left: (d) => [RECT.left - d, midY],
    right: (d) => [RECT.right + d, midY],
    top: (d) => [midX, RECT.top - d],
    bottom: (d) => [midX, RECT.bottom + d],
  };
  for (const [side, point] of Object.entries(sides)) {
    for (const d of [0, 7, 8]) {
      assert.equal(nearRect(...point(d), RECT), true,
        `${side}, ${d}px out`);
    }
    assert.equal(nearRect(...point(9), RECT), false,
      `${side}, 9px out: past the tolerance`);
  }
});

test('a point inside the box, and one well outside it', () => {
  assert.equal(nearRect(midX, midY, RECT), true);
  assert.equal(nearRect(RECT.left + 1, RECT.top + 1, RECT), true);
  assert.equal(nearRect(0, 0, RECT), false, 'far away');
  assert.equal(nearRect(-40, midY, RECT), false);
});

test('a synthetic click at (0, 0) has no point and skips the geometry test', () => {
  // `element.click()` and an assistive-technology activation both report
  // (0, 0), which is not a position any finger could mean.
  const atOrigin = { left: -20, right: 20, top: -20, bottom: 20 };
  assert.equal(nearRect(0, 0, atOrigin), false,
    '(0, 0) must not count as inside a box covering the origin');
  assert.equal(nearRect(1, 1, atOrigin), true,
    'a real point there still counts');
});

test('nearAny asks every element, skipping ones that are not there', () => {
  const el = (rect) => ({ getBoundingClientRect: () => rect });
  const far = el({ left: 500, right: 600, top: 500, bottom: 600 });
  const near = el({ left: 100, right: 200, top: 100, bottom: 150 });
  assert.equal(nearAny(205, midY, [null, undefined, far, near]), true,
    '5px past the near element\'s right edge');
  assert.equal(nearAny(300, midY, [far, near]), false);
  assert.equal(nearAny(0, 0, [el({ left: -20, right: 20, top: -20, bottom: 20 })]), false,
    'a synthetic point never counts, even against an element at the origin');
});
