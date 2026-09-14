// Tests for the pure geometry / detection / solve functions behind the
// feedback modal's drag-to-select screenshot capture (#683) —
// frontend/src/features/dialogs/screenshot-select.js exports them via its
// module.exports branch (same convention as public/sw.js's classifyRequest).
//
// The module moved out of public/js/ in #1078 chunk I, when the feedback
// dialog became stateful and its capture flow became an import of the shell
// bundle rather than a <script> tag. It is still the same plain IIFE, and its
// tail still ends with a `module.exports = pure` branch guarded by
// `typeof window === 'undefined'` so nothing browser-side is touched here.
// What changed is only WHERE it lives: frontend/package.json declares
// "type": "module", so Node resolves any .js under frontend/ as ESM and a
// bare require() of it throws ERR_REQUIRE_ESM. Evaluating the source in a
// CommonJS wrapper is the equivalent load — same file, same branch, no build
// step and no frontend/node_modules dependency (the root suite never has one).
//
// Covered:
//   - directMapping / applyMapping: identity, 2x DPR, non-integer scale
//     (browser zoom), edge clamping, degenerate rects.
//   - detectMarkers: four synthetic finder patterns found within
//     tolerance at 1x and 2x scale, with noise, on light and dark
//     backgrounds; 3 markers / occluded corner / all-black (minimized
//     window) frames yield failure, never a partial solve.
//   - solveRegistration: recovers scale+offset from four
//     correspondences; skewed axis scales and outlier points fail
//     validation. With MORE than four candidates (#2096: a share that
//     includes a tab strip, a toolbar, the dock) the four that agree with
//     the viewport's geometry and the markers' known size are used;
//     an ambiguous frame and a flood of candidates still fail closed.
//   - rescaleMapping: a registration mapping carries over a uniform
//     frame re-size and refuses a changed aspect ratio.
//
// Run with: node --test tests/screenshot-select.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(
  __dirname, '..', 'frontend', 'src', 'features', 'dialogs', 'screenshot-select.js',
);

function loadScreenshotSelect() {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', fs.readFileSync(SRC, 'utf8'))(mod, mod.exports);
  return mod.exports;
}

const {
  MARKER,
  markerCssCenters,
  directMapping,
  rescaleMapping,
  applyMapping,
  detectMarkers,
  classifyCorners,
  solveRegistration,
  MAX_UPLOAD_BYTES,
  validateNativeCapturePayload,
} = loadScreenshotSelect();

test('native capture payload validation accepts one bounded JPEG', () => {
  assert.equal(validateNativeCapturePayload({
    contentType: 'image/jpeg',
    base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
  }), null);
});

test('native capture payload validation rejects bad types, base64 and size', () => {
  assert.equal(validateNativeCapturePayload({
    contentType: 'image/gif', base64: 'AAAA',
  }), 'invalid-type');
  assert.equal(validateNativeCapturePayload({
    contentType: 'image/jpeg', base64: 'not base64',
  }), 'invalid');
  const encodedLength = Math.ceil((MAX_UPLOAD_BYTES + 1) / 3) * 4;
  assert.equal(validateNativeCapturePayload({
    contentType: 'image/png', base64: 'A'.repeat(encodedLength),
  }), 'too-large');
});

// ── Mapping ──────────────────────────────────────────────────────────

test('directMapping + applyMapping: identity at 1:1', () => {
  const m = directMapping(800, 600, 800, 600);
  const crop = applyMapping({ x: 10, y: 20, w: 100, h: 50 }, m, 800, 600);
  assert.deepEqual(crop, { sx: 10, sy: 20, sw: 100, sh: 50 });
});

test('directMapping + applyMapping: 2x DPR scaling', () => {
  const m = directMapping(800, 600, 1600, 1200);
  const crop = applyMapping({ x: 10, y: 20, w: 100, h: 50 }, m, 1600, 1200);
  assert.deepEqual(crop, { sx: 20, sy: 40, sw: 200, sh: 100 });
});

test('applyMapping: non-integer scale (browser zoom) rounds sanely', () => {
  // 1.25x zoom on a 2x display → frame/viewport ratio of 1.6.
  const m = directMapping(1000, 500, 1600, 800);
  const crop = applyMapping({ x: 33, y: 41, w: 101, h: 57 }, m, 1600, 800);
  assert.equal(crop.sx, Math.round(33 * 1.6));
  assert.equal(crop.sy, Math.round(41 * 1.6));
  // Width derives from the rounded edges, so it's within 1px of w*scale.
  assert.ok(Math.abs(crop.sw - 101 * 1.6) <= 1);
  assert.ok(Math.abs(crop.sh - 57 * 1.6) <= 1);
});

test('applyMapping: rect touching the viewport edge clamps to the frame', () => {
  const m = directMapping(800, 600, 800, 600);
  const crop = applyMapping({ x: 750, y: 580, w: 100, h: 100 }, m, 800, 600);
  assert.deepEqual(crop, { sx: 750, sy: 580, sw: 50, sh: 20 });
});

test('applyMapping: fully out-of-frame or degenerate rect is null', () => {
  const m = { scaleX: 1, scaleY: 1, offsetX: -500, offsetY: -500 };
  assert.equal(applyMapping({ x: 0, y: 0, w: 100, h: 100 }, m, 800, 600), null);
  const id = directMapping(800, 600, 800, 600);
  assert.equal(applyMapping({ x: 10, y: 10, w: 0.2, h: 0.2 }, id, 800, 600), null);
});

// ── Synthetic frames for detection ──────────────────────────────────

// Deterministic LCG so noise is reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function makeFrame(width, height, gray) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = gray; data[i + 1] = gray; data[i + 2] = gray; data[i + 3] = 255;
  }
  return { data, width, height };
}

function fillRect(frame, x, y, w, h, gray) {
  const x1 = Math.max(0, Math.round(x));
  const y1 = Math.max(0, Math.round(y));
  const x2 = Math.min(frame.width, Math.round(x + w));
  const y2 = Math.min(frame.height, Math.round(y + h));
  for (let yy = y1; yy < y2; yy++) {
    for (let xx = x1; xx < x2; xx++) {
      const i = (yy * frame.width + xx) * 4;
      frame.data[i] = gray; frame.data[i + 1] = gray; frame.data[i + 2] = gray;
    }
  }
}

// Draw a finder pattern (with its 2-module white quiet zone) centered at
// (cx, cy) with the given module size in frame pixels.
function drawFinder(frame, cx, cy, m) {
  fillRect(frame, cx - 5.5 * m, cy - 5.5 * m, 11 * m, 11 * m, 245); // quiet zone
  fillRect(frame, cx - 3.5 * m, cy - 3.5 * m, 7 * m, 7 * m, 10);    // dark border
  fillRect(frame, cx - 2.5 * m, cy - 2.5 * m, 5 * m, 5 * m, 245);   // light ring
  fillRect(frame, cx - 1.5 * m, cy - 1.5 * m, 3 * m, 3 * m, 10);    // dark center
}

function addNoise(frame, amplitude, seed) {
  const rng = makeRng(seed);
  for (let i = 0; i < frame.data.length; i += 4) {
    const n = Math.round((rng() - 0.5) * 2 * amplitude);
    for (let c = 0; c < 3; c++) {
      frame.data[i + c] = Math.max(0, Math.min(255, frame.data[i + c] + n));
    }
  }
}

// Build a simulated window/monitor capture of a viewport: markers drawn
// at cssCenters mapped through (scale, offset).
function buildRegistrationFrame({ viewportW, viewportH, scale, offsetX, offsetY, frameW, frameH, bg, noise, seed, skipCorner }) {
  const frame = makeFrame(frameW, frameH, bg);
  const centers = markerCssCenters(viewportW, viewportH);
  for (const key of ['tl', 'tr', 'bl', 'br']) {
    if (key === skipCorner) continue;
    const c = centers[key];
    drawFinder(frame, c.x * scale + offsetX, c.y * scale + offsetY, MARKER.MODULE * scale);
  }
  if (noise) addNoise(frame, noise, seed || 42);
  return { frame, centers };
}

function assertMarkersMatch(detected, centers, scale, offsetX, offsetY, tolPx) {
  assert.equal(detected.length, 4, `expected 4 markers, got ${detected.length}`);
  const corners = classifyCorners(detected);
  assert.ok(corners, 'corner classification failed');
  for (const key of ['tl', 'tr', 'bl', 'br']) {
    const expX = centers[key].x * scale + offsetX;
    const expY = centers[key].y * scale + offsetY;
    const err = Math.hypot(corners[key].x - expX, corners[key].y - expY);
    assert.ok(err <= tolPx, `${key} off by ${err.toFixed(1)}px (tol ${tolPx})`);
  }
}

// ── Detection ────────────────────────────────────────────────────────

test('detectMarkers: four markers at 1x on a light background', () => {
  const { frame, centers } = buildRegistrationFrame({
    viewportW: 400, viewportH: 300, scale: 1, offsetX: 30, offsetY: 25,
    frameW: 480, frameH: 380, bg: 220, noise: 8, seed: 7,
  });
  const detected = detectMarkers(frame);
  assertMarkersMatch(detected, centers, 1, 30, 25, 4);
});

test('detectMarkers: four markers at 2x on a dark background with noise', () => {
  const { frame, centers } = buildRegistrationFrame({
    viewportW: 400, viewportH: 300, scale: 2, offsetX: 90, offsetY: 60,
    frameW: 1000, frameH: 760, bg: 35, noise: 10, seed: 13,
  });
  const detected = detectMarkers(frame);
  assertMarkersMatch(detected, centers, 2, 90, 60, 6);
});

test('detectMarkers + solveRegistration: end-to-end recovers the mapping', () => {
  const scale = 1.5;
  const offsetX = 64;
  const offsetY = 48;
  const { frame, centers } = buildRegistrationFrame({
    viewportW: 500, viewportH: 360, scale, offsetX, offsetY,
    frameW: 900, frameH: 640, bg: 200, noise: 6, seed: 3,
  });
  const detected = detectMarkers(frame);
  const solved = solveRegistration(detected, centers, frame.width, frame.height);
  assert.ok(solved.ok, `solve failed: ${solved.reason}`);
  assert.ok(Math.abs(solved.mapping.scaleX - scale) < 0.05);
  assert.ok(Math.abs(solved.mapping.scaleY - scale) < 0.05);
  assert.ok(Math.abs(solved.mapping.offsetX - offsetX) < 6);
  assert.ok(Math.abs(solved.mapping.offsetY - offsetY) < 6);
  // And a crop through the solved mapping lands where it should.
  const crop = applyMapping({ x: 100, y: 80, w: 200, h: 120 }, solved.mapping, frame.width, frame.height);
  assert.ok(Math.abs(crop.sx - (100 * scale + offsetX)) <= 6);
  assert.ok(Math.abs(crop.sy - (80 * scale + offsetY)) <= 6);
});

test('detectMarkers: only 3 markers → solve fails, never a partial solve', () => {
  const { frame, centers } = buildRegistrationFrame({
    viewportW: 400, viewportH: 300, scale: 1, offsetX: 40, offsetY: 40,
    frameW: 500, frameH: 400, bg: 220, skipCorner: 'br',
  });
  const detected = detectMarkers(frame);
  assert.equal(detected.length, 3);
  const solved = solveRegistration(detected, centers, frame.width, frame.height);
  assert.equal(solved.ok, false);
});

test('detectMarkers: an occluded corner (marker covered) fails closed', () => {
  const { frame, centers } = buildRegistrationFrame({
    viewportW: 400, viewportH: 300, scale: 1, offsetX: 40, offsetY: 40,
    frameW: 500, frameH: 400, bg: 220,
  });
  // Another window covers the bottom-right marker entirely.
  const br = centers.br;
  fillRect(frame, br.x + 40 - 60, br.y + 40 - 60, 140, 120, 128);
  const detected = detectMarkers(frame);
  assert.ok(detected.length < 4, `expected <4 markers, got ${detected.length}`);
  const solved = solveRegistration(detected, centers, frame.width, frame.height);
  assert.equal(solved.ok, false);
});

test('detectMarkers: all-black frame (minimized window) finds nothing', () => {
  const frame = makeFrame(640, 480, 0);
  assert.deepEqual(detectMarkers(frame), []);
  const solved = solveRegistration([], markerCssCenters(400, 300), 640, 480);
  assert.equal(solved.ok, false);
});

function idealDetections(centers, scale, offsetX, offsetY) {
  return ['tl', 'tr', 'bl', 'br'].map((k) => ({
    x: centers[k].x * scale + offsetX,
    y: centers[k].y * scale + offsetY,
  }));
}

// ── #2096: candidates the share includes AROUND the page ─────────────
//
// A window or monitor share frames more than the viewport: the browser's
// tab strip and toolbar, the dock, whatever window sits beside it. Any of
// those can carry a shape with a finder pattern's 1:1:3:1:1 cross-section
// (a ring icon, a checked radio, a QR code in a neighbouring tab). The
// solve used to demand EXACTLY four detections, so one such shape was
// enough to refuse the whole capture as "couldn't locate this page".

test('solveRegistration: a fifth pattern beside the page is ignored when four markers solve', () => {
  const { frame, centers } = buildRegistrationFrame({
    viewportW: 400, viewportH: 300, scale: 1, offsetX: 40, offsetY: 40,
    frameW: 520, frameH: 420, bg: 220,
  });
  // A same-sized finder pattern in the page's centre.
  drawFinder(frame, 260, 210, MARKER.MODULE);
  const detected = detectMarkers(frame);
  assert.equal(detected.length, 5);
  const solved = solveRegistration(detected, centers, frame.width, frame.height);
  assert.ok(solved.ok, `solve failed: ${solved.reason}`);
  assert.ok(Math.abs(solved.mapping.scaleX - 1) < 0.05);
  assert.ok(Math.abs(solved.mapping.offsetX - 40) < 4);
  assert.ok(Math.abs(solved.mapping.offsetY - 40) < 4);
});

test('solveRegistration: favicon-sized patterns in the tab strip are ignored', () => {
  const { frame, centers } = buildRegistrationFrame({
    viewportW: 400, viewportH: 300, scale: 2, offsetX: 60, offsetY: 120,
    frameW: 920, frameH: 740, bg: 230,
  });
  // Three small finder-like glyphs in the "toolbar" above the page, with a
  // module size a real marker at this scale cannot have.
  drawFinder(frame, 120, 40, 3);
  drawFinder(frame, 300, 40, 3);
  drawFinder(frame, 700, 40, 4);
  const detected = detectMarkers(frame);
  assert.equal(detected.length, 7, `expected 7 candidates, got ${detected.length}`);
  const solved = solveRegistration(detected, centers, frame.width, frame.height);
  assert.ok(solved.ok, `solve failed: ${solved.reason}`);
  assert.ok(Math.abs(solved.mapping.scaleX - 2) < 0.05);
  assert.ok(Math.abs(solved.mapping.scaleY - 2) < 0.05);
  assert.ok(Math.abs(solved.mapping.offsetX - 60) < 6);
  assert.ok(Math.abs(solved.mapping.offsetY - 120) < 6);
});

test('solveRegistration: a marker of the wrong size does not complete a set', () => {
  const centers = markerCssCenters(800, 600);
  const detected = idealDetections(centers, 2, 120, 80).map((p) => ({ ...p, unit: MARKER.MODULE * 2 }));
  // The bottom-right "marker" is a toolbar glyph that happens to sit where
  // the corner would be — a quarter of the size a real marker has here.
  detected[3].unit = MARKER.MODULE * 0.5;
  const solved = solveRegistration(detected, centers, 2000, 1400);
  assert.equal(solved.ok, false);
  assert.match(solved.reason, /marker size/);
});

test('solveRegistration: two page-shaped sets of markers are ambiguous and fail closed', () => {
  const centers = markerCssCenters(400, 300);
  // Two placements of the same viewport at the same scale, side by side —
  // there is no telling which one is the page.
  const detected = [
    ...idealDetections(centers, 1, 20, 20).map((p) => ({ ...p, unit: MARKER.MODULE })),
    ...idealDetections(centers, 1, 480, 20).map((p) => ({ ...p, unit: MARKER.MODULE })),
  ];
  const solved = solveRegistration(detected, centers, 1000, 400);
  assert.equal(solved.ok, false);
  assert.match(solved.reason, /ambiguous/);
});

test('solveRegistration: a flood of candidates fails closed rather than searching', () => {
  const centers = markerCssCenters(400, 300);
  const detected = idealDetections(centers, 1, 20, 20);
  for (let i = 0; i < 20; i++) detected.push({ x: 100 + i * 30, y: 500, unit: 3 });
  const solved = solveRegistration(detected, centers, 1000, 600);
  assert.equal(solved.ok, false);
  assert.match(solved.reason, /too many/);
});

test('solveRegistration: fewer than four candidates still fails, however many strays', () => {
  const centers = markerCssCenters(400, 300);
  const detected = idealDetections(centers, 1, 20, 20).slice(0, 3);
  assert.equal(solveRegistration(detected, centers, 1000, 600).ok, false);
});

// ── #2096: the stream re-sizes its frames between the two grabs ──────

test('rescaleMapping: a uniform frame re-size carries the mapping over', () => {
  const mapping = { scaleX: 2, scaleY: 2, offsetX: 100, offsetY: 60 };
  const scaled = rescaleMapping(mapping, 2000, 1000, 1000, 500);
  assert.ok(scaled);
  assert.ok(Math.abs(scaled.scaleX - 1) < 1e-9);
  assert.ok(Math.abs(scaled.scaleY - 1) < 1e-9);
  assert.ok(Math.abs(scaled.offsetX - 50) < 1e-9);
  assert.ok(Math.abs(scaled.offsetY - 30) < 1e-9);
  // Odd rounding on one axis (1000x563 for a 16:9 source) is still a resample.
  assert.ok(rescaleMapping(mapping, 1920, 1080, 1000, 563));
  // Same size: unchanged.
  assert.equal(rescaleMapping(mapping, 2000, 1000, 2000, 1000), mapping);
});

test('rescaleMapping: a changed aspect ratio is a resized window and returns null', () => {
  const mapping = { scaleX: 2, scaleY: 2, offsetX: 100, offsetY: 60 };
  assert.equal(rescaleMapping(mapping, 2000, 1000, 2000, 900), null);
  assert.equal(rescaleMapping(mapping, 2000, 1000, 0, 500), null);
  assert.equal(rescaleMapping(null, 2000, 1000, 1000, 500), null);
});

// ── Solve validation ─────────────────────────────────────────────────

test('solveRegistration: exact recovery from clean correspondences', () => {
  const centers = markerCssCenters(800, 600);
  const solved = solveRegistration(idealDetections(centers, 2, 120, 80), centers, 2000, 1400);
  assert.ok(solved.ok);
  assert.ok(Math.abs(solved.mapping.scaleX - 2) < 1e-9);
  assert.ok(Math.abs(solved.mapping.scaleY - 2) < 1e-9);
  assert.ok(Math.abs(solved.mapping.offsetX - 120) < 1e-9);
  assert.ok(Math.abs(solved.mapping.offsetY - 80) < 1e-9);
});

test('solveRegistration: unequal axis scales fail validation', () => {
  const centers = markerCssCenters(800, 600);
  const detected = ['tl', 'tr', 'bl', 'br'].map((k) => ({
    x: centers[k].x * 2, // scaleX 2
    y: centers[k].y * 1, // scaleY 1 → skew way past 10%
  }));
  const solved = solveRegistration(detected, centers, 2000, 1400);
  assert.equal(solved.ok, false);
});

test('solveRegistration: one outlier point fails the residual check', () => {
  const centers = markerCssCenters(800, 600);
  const detected = idealDetections(centers, 2, 120, 80);
  detected[3] = { x: detected[3].x + 80, y: detected[3].y }; // dragged marker
  const solved = solveRegistration(detected, centers, 2000, 1400);
  assert.equal(solved.ok, false);
});

test('solveRegistration: wrong marker count is rejected', () => {
  const centers = markerCssCenters(800, 600);
  assert.equal(solveRegistration(idealDetections(centers, 1, 0, 0).slice(0, 3), centers, 800, 600).ok, false);
  assert.equal(solveRegistration([], centers, 800, 600).ok, false);
});
