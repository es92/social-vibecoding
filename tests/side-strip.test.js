'use strict';
// iPhone Duo (24 Oct 2026): folded, the Duo's cover moves the clock, the
// camera and every app's bars into an 84pt column down its right edge, and
// the Homeroom app's web view is handed that column as
// `env(safe-area-inset-right)` (measured on the iOS 27.1 simulator: right
// 84px, top 0). frontend/src/lib/side-strip.ts turns a one-sided inset into
// `data-side-strip` on <html>; app.css keeps the content out of the column
// and stands the tab bar and the back button in it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP_CSS = read('public/css/app.css');
const {
  STRIP_ATTR, STRIP_W_PROP, STRIP_MIN_PX, STRIP_SHOT_PX,
  BAND_ATTR, BAND_H_PROP, BAND_MIN_WIDTH_PX,
  CORNER_ATTR, CORNER_W_PROP, CORNER_SHOT_PX, RESUME_SETTLE_MS,
  stripSide, stripShotSide, applyStrip, watchSideStrip,
  topBand, topBandShot, applyTopBand,
  sideCorner, cornerShot, applyCorner,
} = loadTsx('frontend/src/lib/side-strip.ts');

test('stripSide: only a wide inset on one side is a strip', () => {
  assert.equal(stripSide({ left: 0, right: 84 }), 'right', 'the Duo\'s cover, folded');
  assert.equal(stripSide({ left: 84, right: 0 }), 'left', 'Split View with the app against the left edge');
  assert.equal(stripSide({ left: 0, right: 0 }), null, 'a phone in portrait');
  assert.equal(stripSide({ left: 59, right: 59 }), null, 'a phone in landscape: the notch is inset on both sides');
  assert.equal(stripSide({ left: 84, right: 84 }), null, 'both sides is never a column');
  assert.equal(stripSide({ left: 0, right: STRIP_MIN_PX - 1 }), null, 'an Android cutout in landscape');
  assert.equal(stripSide({ left: 0, right: STRIP_MIN_PX }), 'right');
  assert.equal(stripSide(null), null);
  assert.equal(stripSide({ left: Number.NaN, right: 84 }), 'right');
});

test('?side-strip= paints the Duo\'s column for a browser that has none', () => {
  assert.equal(stripShotSide('?side-strip=right'), 'right');
  assert.equal(stripShotSide('?side-strip=1'), 'right', 'the Duo\'s own side');
  assert.equal(stripShotSide('?side-strip=left'), 'left');
  assert.equal(stripShotSide('?side-strip=up'), null);
  assert.equal(stripShotSide(''), null);
  assert.equal(STRIP_SHOT_PX, 84, 'the column as measured on the simulator');
});

test('applyStrip: publishes the side and width, and takes them away again', () => {
  const attrs = new Map();
  const props = new Map();
  let writes = 0;
  const root = {
    getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
    setAttribute: (n, v) => { writes += 1; attrs.set(n, v); },
    removeAttribute: (n) => { writes += 1; attrs.delete(n); },
    style: {
      setProperty: (n, v) => props.set(n, v),
      removeProperty: (n) => props.delete(n),
    },
  };
  applyStrip(root, 'right', 84);
  assert.equal(attrs.get(STRIP_ATTR), 'right');
  assert.equal(props.get(STRIP_W_PROP), '84px');
  applyStrip(root, 'right', 84);
  assert.equal(writes, 1, 'an unchanged side is not written again');
  applyStrip(root, null, 0);
  assert.equal(attrs.has(STRIP_ATTR), false, 'unfolded: gone');
  assert.equal(props.has(STRIP_W_PROP), false);
  applyStrip(root, null, 0);
  assert.equal(writes, 2, 'nothing to take away twice');
});

test('the probe reads the kit override before env(), as app.css does', () => {
  const src = read('frontend/src/lib/side-strip.ts');
  // The right inset rides as TOP padding and the top inset as BOTTOM
  // padding, so the probe's box is (left x (right + top)) and a change to
  // any of them resizes it.
  assert.match(src, /padding-top:var\(--un-safe-inset-right,env\(safe-area-inset-right,0px\)\)/);
  assert.match(src, /padding-left:var\(--un-safe-inset-left,env\(safe-area-inset-left,0px\)\)/);
  assert.match(src, /padding-bottom:var\(--un-safe-inset-top,env\(safe-area-inset-top,0px\)\)/);
  assert.match(src, /right: parseFloat\(cs\.paddingTop\)/);
  assert.match(src, /top: parseFloat\(cs\.paddingBottom\)/);
  assert.match(read('frontend/src/main.tsx'), /import '\.\/lib\/side-strip';/);
});

// ── The top band: the unfolded Duo, held upright (6070) ────────────────

// The unfolded Duo held upright is 669px wide; the band's width (6161).
const DUO_UP = { width: 669 };

test('topBand: a tall top inset with no side column, on the unfolded Duo\'s width, is its band', () => {
  assert.equal(topBand({ top: 80, left: 0, right: 0 }, DUO_UP), 80, 'the unfolded Duo held upright');
  assert.equal(topBand({ top: 59, left: 0, right: 0 }, DUO_UP), 0, 'an ordinary iPhone status bar');
  assert.equal(topBand({ top: STRIP_MIN_PX - 1, left: 0, right: 0 }, DUO_UP), 0, 'below the floor');
  assert.equal(topBand({ top: STRIP_MIN_PX, left: 0, right: 0 }, DUO_UP), STRIP_MIN_PX, 'the floor itself');
  assert.equal(topBand({ top: 80, left: 0, right: 84 }, DUO_UP), 0, 'a column reported too: the strip wins');
  assert.equal(topBand({ top: 80, left: 84, right: 0 }, DUO_UP), 0);
  assert.equal(topBand({ top: Number.NaN, left: 0, right: 0 }, DUO_UP), 0);
  assert.equal(topBand({ top: undefined, left: 0, right: 0 }, DUO_UP), 0);
  assert.equal(topBand(null, DUO_UP), 0);
});

// 6161: in the app an iPhone 17 Pro reports a top inset just over the floor,
// and its clock runs across the top-left, not a corner pill: the band's
// layout put the back disc and the page's title under the clock on every
// screen. The width tells the two apart.
test('topBand: an ordinary phone\'s tall inset is not a band, whatever its height (6161)', () => {
  assert.equal(topBand({ top: 66, left: 0, right: 0 }, { width: 402 }), 0, 'an iPhone 17 Pro in the app');
  assert.equal(topBand({ top: 80, left: 0, right: 0 }, { width: 440 }), 0, 'the widest phone upright');
  assert.equal(topBand({ top: 80, left: 0, right: 0 }, { width: BAND_MIN_WIDTH_PX - 1 }), 0, 'under the width');
  assert.equal(topBand({ top: 80, left: 0, right: 0 }, { width: BAND_MIN_WIDTH_PX }), 80, 'the width itself');
  assert.equal(topBand({ top: 80, left: 0, right: 0 }, { width: Number.NaN }), 0, 'no width is no band');
  assert.ok(BAND_MIN_WIDTH_PX > 440 && BAND_MIN_WIDTH_PX < 669, 'between the widest phone and the unfolded Duo');
});

test('?side-strip=up paints the Duo\'s top band, not a column', () => {
  assert.equal(topBandShot('?side-strip=up'), true);
  assert.equal(topBandShot('?side-strip=right'), false);
  assert.equal(topBandShot('?side-strip=1'), false);
  assert.equal(topBandShot(''), false);
  assert.equal(stripShotSide('?side-strip=up'), null, 'no column from the band flag');
  assert.equal(topBandShot('?side-strip=up&demo=1'), true, 'the flag composes with the state');
});

test('applyTopBand: publishes the band and its height, and takes them away again', () => {
  const attrs = new Map();
  const props = new Map();
  let writes = 0;
  const root = {
    getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
    setAttribute: (n, v) => { writes += 1; attrs.set(n, v); },
    removeAttribute: (n) => { writes += 1; attrs.delete(n); },
    style: {
      setProperty: (n, v) => props.set(n, v),
      removeProperty: (n) => props.delete(n),
    },
  };
  applyTopBand(root, 80);
  assert.equal(attrs.has(BAND_ATTR), true);
  assert.equal(props.get(BAND_H_PROP), '80px');
  applyTopBand(root, 80);
  assert.equal(writes, 1, 'an unchanged band is not written again');
  applyTopBand(root, 0);
  assert.equal(attrs.has(BAND_ATTR), false, 'back to a plain phone: gone');
  assert.equal(props.has(BAND_H_PROP), false);
  applyTopBand(root, 0);
  assert.equal(writes, 2, 'nothing to take away twice');
});

// ── The side corner: the folded Duo's pill (6072) ──────────────────────

test('sideCorner: a narrow one-sided inset on an upright phone is the corner', () => {
  const portrait = { portrait: true };
  assert.equal(sideCorner({ left: 0, right: 52 }, portrait), 'right', 'the folded Duo in the report');
  assert.equal(sideCorner({ left: 52, right: 0 }, portrait), 'left', 'Split View against the left edge');
  assert.equal(sideCorner({ left: 59, right: 59 }, portrait), null, 'both sides: a landscape notch');
  assert.equal(sideCorner({ left: 0, right: 84 }, portrait), null, 'a column wins');
  assert.equal(sideCorner({ left: 0, right: STRIP_MIN_PX }, portrait), null, 'the floor itself is a strip');
  assert.equal(sideCorner({ top: 80, left: 0, right: 0 }, portrait), null, 'a top band wins');
  assert.equal(sideCorner({ left: 0, right: 52 }, { portrait: false }), null, 'a sideways phone is not this pose');
  assert.equal(sideCorner({ left: 0, right: 0 }, portrait), null, 'a plain portrait phone');
  assert.equal(sideCorner(null, portrait), null);
  assert.equal(CORNER_SHOT_PX, 52, 'the corner as the report measures it');
});

test('?side-strip=corner paints the folded Duo\'s corner for a browser', () => {
  assert.equal(cornerShot('?side-strip=corner'), true);
  assert.equal(cornerShot('?side-strip=right'), false);
  assert.equal(cornerShot('?side-strip=up'), false);
  assert.equal(cornerShot(''), false);
  assert.equal(stripShotSide('?side-strip=corner'), null, 'no column from the corner flag');
  assert.equal(topBandShot('?side-strip=corner'), false, 'no band from it either');
  assert.equal(cornerShot('?side-strip=corner&demo=1'), true, 'the flag composes with the state');
});

test('applyCorner: publishes the side and width, and takes them away again', () => {
  const attrs = new Map();
  const props = new Map();
  let writes = 0;
  const root = {
    getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
    setAttribute: (n, v) => { writes += 1; attrs.set(n, v); },
    removeAttribute: (n) => { writes += 1; attrs.delete(n); },
    style: {
      setProperty: (n, v) => props.set(n, v),
      removeProperty: (n) => props.delete(n),
    },
  };
  applyCorner(root, 'right', 52);
  assert.equal(attrs.get(CORNER_ATTR), 'right');
  assert.equal(props.get(CORNER_W_PROP), '52px');
  applyCorner(root, 'right', 52);
  assert.equal(writes, 1, 'an unchanged side is not written again');
  applyCorner(root, null, 0);
  assert.equal(attrs.has(CORNER_ATTR), false, 'a plain phone: gone');
  assert.equal(props.has(CORNER_W_PROP), false);
  applyCorner(root, null, 0);
  assert.equal(writes, 2, 'nothing to take away twice');
});

// A document and window just big enough for watchSideStrip: the probe's
// computed padding is whatever `insets` says now.
function fakePage({ withObserver = true } = {}) {
  const insets = { top: 0, left: 0, right: 0 };
  const attrs = new Map();
  const props = new Map();
  const listeners = new Map();
  const docListeners = new Map();
  const observers = [];
  const root = {
    getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
    setAttribute: (n, v) => attrs.set(n, v),
    removeAttribute: (n) => attrs.delete(n),
    style: { setProperty: (n, v) => props.set(n, v), removeProperty: (n) => props.delete(n) },
    appendChild: (el) => { el.isConnected = true; },
  };
  const doc = {
    documentElement: root,
    createElement: () => ({ isConnected: false, style: {}, setAttribute() {} }),
    // A page is visible unless a test says otherwise.
    visibilityState: 'visible',
    addEventListener: (type, fn) => docListeners.set(type, fn),
    removeEventListener: (type) => docListeners.delete(type),
  };
  // The frame and timer queues, flushed by hand (a resume's follow-up
  // reads): a cancelled entry is nulled, so a flush skips it.
  const frames = [];
  const timers = [];
  const win = {
    location: { search: '' },
    // Upright by default: the corner's pose. A landscape case sets its own.
    innerWidth: 390,
    innerHeight: 844,
    getComputedStyle: () => ({
      paddingLeft: `${insets.left}px`,
      paddingTop: `${insets.right}px`,
      paddingBottom: `${insets.top}px`,
    }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    requestAnimationFrame: (fn) => frames.push(fn),
    cancelAnimationFrame: (id) => { frames[id - 1] = null; },
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: (id) => { timers[id - 1] = null; },
  };
  if (withObserver) {
    win.ResizeObserver = class {
      constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
      observe(target, options) { this.targets.push({ target, options }); }
      unobserve() {}
      disconnect() { this.disconnected = true; }
    };
  }
  const flushFrames = () => { for (const fn of frames.splice(0)) if (fn) fn(); };
  const flushTimers = () => { for (const fn of timers.splice(0)) if (fn) fn(); };
  return {
    insets, attrs, props, listeners, docListeners, observers, doc, win, root, frames, timers, flushFrames, flushTimers,
  };
}

test('the strip follows the inset itself, not only a resize (the tabs left at the foot on a real Duo)', () => {
  const page = fakePage();
  const stop = watchSideStrip(page.doc, page.win);
  assert.equal(page.attrs.get(STRIP_ATTR), undefined, 'unfolded: no column yet');
  const [observer] = page.observers;
  assert.ok(observer, 'the probe is watched');
  assert.equal(observer.targets.length, 1);
  assert.deepEqual(observer.targets[0].options, { box: 'border-box' }, 'its padding is its border box');
  // Folded: the viewport's resize came and went with the old inset, and
  // the new one lands in a later layout pass.
  page.listeners.get('resize')();
  assert.equal(page.attrs.get(STRIP_ATTR), undefined);
  page.insets.right = 84;
  observer.callback([]);
  assert.equal(page.attrs.get(STRIP_ATTR), 'right', 'the inset moving is enough');
  page.insets.right = 0;
  page.insets.left = 84;
  observer.callback([]);
  assert.equal(page.attrs.get(STRIP_ATTR), 'left', 'a column that moves sides is a change too');
  stop();
  assert.equal(observer.disconnected, true);
  assert.equal(page.listeners.size, 0);
});

// 1 Nov 2026: WebKit hands the side panel's frame the screen's insets, and
// beside the Homeroom bot tab on the Duo held sideways its page padded itself
// an 84px column it does not touch. The panel is a column inside the page.
test('the side panel\'s own document takes no strip, band or corner, whatever the frame is handed', () => {
  const page = fakePage();
  page.root.classList = { contains: (c) => c === 'in-side-panel' };
  page.win.innerWidth = 669;
  page.insets.right = 84;
  page.insets.top = 84;
  watchSideStrip(page.doc, page.win);
  assert.equal(page.attrs.get(STRIP_ATTR), undefined, 'no column');
  assert.equal(page.attrs.get(BAND_ATTR), undefined, 'no band');
  page.listeners.get('resize')();
  assert.equal(page.attrs.get(STRIP_ATTR), undefined, 'and none on the next read either');
});

test('with no ResizeObserver, the window\'s resize still reads the inset', () => {
  const page = fakePage({ withObserver: false });
  watchSideStrip(page.doc, page.win);
  page.insets.right = 84;
  page.listeners.get('resize')();
  assert.equal(page.attrs.get(STRIP_ATTR), 'right');
});

// ── A resume reads the inset again (6450) ──────────────────────────────
// Leaving the Duo for another app and coming back dropped the tabs to the
// foot of the folded cover: the resume's own read found no inset, and with
// the probe's box unchanged nothing read it again. Coming back now reads
// now, on the next frame and once more after the phone's late report.

test('a resume puts the strip back (6450)', () => {
  const page = fakePage();
  page.insets.right = 84;
  const stop = watchSideStrip(page.doc, page.win);
  assert.equal(page.attrs.get(STRIP_ATTR), 'right', 'the Duo\'s column, as before leaving');
  // The resume's own pass reads no inset at all, and removes the column.
  page.insets.right = 0;
  page.listeners.get('resize')();
  assert.equal(page.attrs.has(STRIP_ATTR), false);
  // Back in the app, the phone reports the column again.
  page.insets.right = 84;
  page.listeners.get('pageshow')();
  assert.equal(page.attrs.get(STRIP_ATTR), 'right');
  assert.equal(page.props.get(STRIP_W_PROP), '84px');
  stop();
});

test('coming back reads the inset as a visibility change too (6450)', () => {
  const page = fakePage();
  page.insets.right = 84;
  const stop = watchSideStrip(page.doc, page.win);
  page.insets.right = 0;
  page.listeners.get('resize')();
  assert.equal(page.attrs.has(STRIP_ATTR), false);
  page.doc.visibilityState = 'hidden';
  page.insets.right = 84;
  page.docListeners.get('visibilitychange')();
  assert.equal(page.attrs.has(STRIP_ATTR), false, 'a hidden page reads nothing');
  page.doc.visibilityState = 'visible';
  page.docListeners.get('visibilitychange')();
  assert.equal(page.attrs.get(STRIP_ATTR), 'right', 'visible again: the column is read back');
  assert.equal(page.props.get(STRIP_W_PROP), '84px');
  stop();
});

test('a resume catches the inset WebKit hands over a moment later (6450)', () => {
  assert.equal(RESUME_SETTLE_MS, 250, 'a quarter of a second after the resume');
  const page = fakePage();
  const stop = watchSideStrip(page.doc, page.win);
  page.listeners.get('pageshow')();
  assert.equal(page.attrs.has(STRIP_ATTR), false, 'the resume pass still says there is no column');
  page.insets.right = 84;
  page.flushFrames();
  assert.equal(page.attrs.get(STRIP_ATTR), 'right', 'the next frame sees it');
  page.flushTimers();
  assert.equal(page.attrs.get(STRIP_ATTR), 'right', 'the settle read keeps it');
  stop();

  // Even later than the frame: the settle read is what catches it.
  const late = fakePage();
  const stopLate = watchSideStrip(late.doc, late.win);
  late.listeners.get('pageshow')();
  late.flushFrames();
  assert.equal(late.attrs.has(STRIP_ATTR), false, 'nothing yet');
  late.insets.right = 84;
  late.flushTimers();
  assert.equal(late.attrs.get(STRIP_ATTR), 'right');
  assert.equal(late.props.get(STRIP_W_PROP), '84px');
  stopLate();
});

test('a resume that really finds no inset still removes the strip (6450)', () => {
  const page = fakePage();
  page.insets.right = 84;
  const stop = watchSideStrip(page.doc, page.win);
  page.insets.right = 0;
  page.listeners.get('pageshow')();
  page.flushFrames();
  page.flushTimers();
  assert.equal(page.attrs.has(STRIP_ATTR), false, 'a real read of no column takes it away');
  assert.equal(page.props.has(STRIP_W_PROP), false);
  stop();
});

test('stop() removes the resume listeners and cancels its pending reads (6450)', () => {
  const page = fakePage();
  const stop = watchSideStrip(page.doc, page.win);
  page.listeners.get('pageshow')();
  assert.equal(page.frames.length, 1, 'a frame is queued');
  assert.equal(page.timers.length, 1, 'and the settle timer');
  stop();
  assert.equal(page.listeners.size, 0);
  assert.equal(page.docListeners.size, 0);
  assert.ok(page.frames.every((fn) => fn === null), 'the frame is cancelled');
  assert.ok(page.timers.every((fn) => fn === null), 'the timer is cancelled');
  page.flushFrames();
  page.flushTimers();
});

test('the top band follows the top inset, on the unfolded Duo that reports no column', () => {
  const page = fakePage();
  page.win.innerWidth = 669;
  const stop = watchSideStrip(page.doc, page.win);
  assert.equal(page.attrs.has(BAND_ATTR), false, 'a phone: no band');
  const [observer] = page.observers;
  // Unfolded, held upright: the band lands in a layout pass of its own.
  page.insets.top = 80;
  observer.callback([]);
  assert.equal(page.attrs.has(BAND_ATTR), true, 'the band is on');
  assert.equal(page.props.get(BAND_H_PROP), '80px');
  assert.equal(page.attrs.has(STRIP_ATTR), false, 'no column beside it');
  // Folded: the column arrives and the band leaves, in whichever order the
  // insets are read.
  page.insets.top = 0;
  page.insets.right = 84;
  observer.callback([]);
  assert.equal(page.attrs.has(BAND_ATTR), false, 'a column is not a band');
  assert.equal(page.attrs.get(STRIP_ATTR), 'right');
  stop();
});

// 6161: the app on an iPhone 17 Pro reports a top inset just over the floor
// (66px here), and the band's layout drew the back disc and the title under
// the clock. A phone's width says it is the status bar, not the Duo's band:
// the header keeps the inset as its padding.
test('a phone\'s tall top inset is not the band: the status bar keeps its reservation (6161)', () => {
  const page = fakePage();
  page.root.classList = { contains: (name) => name === 'in-native-webview' };
  const stop = watchSideStrip(page.doc, page.win);
  const [observer] = page.observers;
  page.insets.top = 66;
  observer.callback([]);
  assert.equal(page.attrs.has(BAND_ATTR), false, 'an ordinary phone, upright: no band');
  assert.equal(page.props.has(BAND_H_PROP), false);
  assert.equal(page.attrs.has(CORNER_ATTR), false, 'and a two-sided nothing is no corner');
  // Unfolded: the same inset on the Duo's width is the band again.
  page.win.innerWidth = 669;
  observer.callback([]);
  assert.equal(page.attrs.has(BAND_ATTR), true, 'the width is what tells them apart');
  stop();
});

test('a browser tab never has a band, whatever the engine reports (#2509)', () => {
  const page = fakePage();
  page.win.innerWidth = 669;
  page.root.classList = { contains: (name) => name === 'web-browser-chrome' };
  watchSideStrip(page.doc, page.win);
  const [observer] = page.observers;
  page.insets.top = 80;
  observer.callback([]);
  assert.equal(page.attrs.has(BAND_ATTR), false, 'the browser owns the top of the screen');
});

test('?side-strip=up still paints the band in a browser tab, at a phone\'s width: it is a review state', () => {
  const page = fakePage();
  page.root.classList = { contains: (name) => name === 'web-browser-chrome' };
  page.win.location.search = '?side-strip=up';
  page.insets.top = STRIP_SHOT_PX;
  watchSideStrip(page.doc, page.win);
  assert.equal(page.attrs.has(BAND_ATTR), true, 'the flag paints the device it names');
});

test('?side-strip=up paints the 84px top inset the probe reads as a band', () => {
  const page = fakePage();
  page.win.location.search = '?side-strip=up';
  page.insets.top = STRIP_SHOT_PX;
  const stop = watchSideStrip(page.doc, page.win);
  assert.equal(page.props.get('--un-safe-inset-top'), '84px');
  assert.equal(page.attrs.has(BAND_ATTR), true);
  assert.equal(page.props.get(BAND_H_PROP), '84px');
  assert.equal(page.attrs.has(STRIP_ATTR), false, 'the flag paints no column');
  stop();
});

test('the corner follows a narrow one-sided inset in the app, upright', () => {
  const page = fakePage();
  page.root.classList = { contains: (name) => name === 'in-native-webview' };
  const stop = watchSideStrip(page.doc, page.win);
  assert.equal(page.attrs.has(CORNER_ATTR), false, 'a plain phone: no corner');
  const [observer] = page.observers;
  page.insets.right = CORNER_SHOT_PX;
  observer.callback([]);
  assert.equal(page.attrs.get(CORNER_ATTR), 'right', 'the inset moving is enough');
  assert.equal(page.props.get(CORNER_W_PROP), '52px');
  assert.equal(page.attrs.has(STRIP_ATTR), false, 'the corner is not a column');
  // Sideways, the same inset is a cutout: the corner goes.
  page.win.innerWidth = 844;
  page.win.innerHeight = 390;
  observer.callback([]);
  assert.equal(page.attrs.has(CORNER_ATTR), false, 'a sideways phone keeps its own layout');
  // Upright again, and with a real column it is the strip that wins.
  page.win.innerWidth = 466;
  page.win.innerHeight = 678;
  page.insets.right = 84;
  observer.callback([]);
  assert.equal(page.attrs.has(CORNER_ATTR), false, 'a column is not the corner');
  assert.equal(page.attrs.get(STRIP_ATTR), 'right');
  stop();
});

test('a browser tab never has the corner, whatever the engine reports', () => {
  const page = fakePage();
  page.root.classList = { contains: (name) => name === 'web-browser-chrome' };
  watchSideStrip(page.doc, page.win);
  const [observer] = page.observers;
  page.insets.right = CORNER_SHOT_PX;
  observer.callback([]);
  assert.equal(page.attrs.has(CORNER_ATTR), false, 'the browser chrome is its own');
});

test('?side-strip=corner paints 52px and sets the corner in a tab', () => {
  const page = fakePage();
  page.root.classList = { contains: (name) => name === 'web-browser-chrome' };
  page.win.location.search = '?side-strip=corner';
  page.insets.right = CORNER_SHOT_PX;
  watchSideStrip(page.doc, page.win);
  assert.equal(page.props.get('--un-safe-inset-right'), '52px');
  assert.equal(page.attrs.get(CORNER_ATTR), 'right', 'the flag paints the device it names');
  assert.equal(page.props.get(CORNER_W_PROP), '52px');
  assert.equal(page.attrs.has(STRIP_ATTR), false, 'the flag paints no column');
  assert.equal(page.attrs.has(BAND_ATTR), false, 'and no band');
});

// ── app.css ─────────────────────────────────────────────────────────────

const block = (() => {
  const start = APP_CSS.indexOf('THE SIDE STRIP — iPhone Duo');
  // The top band's block follows this one now (6070), so the slice ends at
  // its heading rather than at the next section after both.
  const end = APP_CSS.indexOf('THE TOP BAND — iPhone Duo', start);
  assert.ok(start > 0 && end > start, 'the side strip block is in app.css');
  return APP_CSS.slice(start, end);
})();

test('every rule in the block is keyed on the strip, but the off switch', () => {
  const selectors = [...block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map((m) => m[1].trim())
    .filter((sel) => sel && !sel.startsWith('@media'));
  assert.ok(selectors.length > 10);
  for (const sel of selectors) {
    if (/^\.platform-side-strip-top,\s*\.platform-side-strip-ground,\s*\.platform-side-strip-frost,\s*\.platform-side-apps$/.test(sel)) continue;
    assert.match(sel, /html\[data-side-strip/, `${sel} applies only with the strip`);
  }
  assert.match(block, /\.platform-side-strip-top,\n\.platform-side-strip-ground,\n\.platform-side-strip-frost,\n\.platform-side-apps \{\s*display: none;/, 'no strip, no strip pieces');
});

test('the content stops at the strip; the tabs and the back stand in it', () => {
  assert.match(block, /html\[data-side-strip="right"\] body \{\s*padding-right: var\(--platform-strip-w, 0px\);/);
  assert.match(block, /html\[data-side-strip="left"\] body \{\s*padding-left: var\(--platform-strip-w, 0px\);/);
  assert.match(block, /html\[data-side-strip\] #platform-tabs \{[^}]*flex-direction: column;[^}]*\}/);
  // The column is drawn only where the bar is: never over a running app or
  // the signed-out shell (`hidden`), never with the keyboard up.
  assert.doesNotMatch(block, /html\[data-side-strip\] #platform-tabs \{[^}]*display:/);
  assert.match(block, /html\[data-side-strip\]:not\(\.un-kb\):not\(\.platform-kb-open\) #platform-tabs:not\(\.hidden\) \{\s*display: flex;/);
  assert.match(block, /html\[data-side-strip\] #platform-tabs \{[^}]*bottom: var\(--platform-strip-foot\);/);
  assert.match(block, /html\[data-side-strip\] #platform-header :is\(#back-btn, \.nav-drawer-back\) \{\s*display: none;/);
  assert.match(block, /--platform-strip-top: 174px;/, 'where Settings hangs its own back, measured');
  assert.match(block, /--platform-strip-axis: 48px;/, 'the system column\'s centre line, measured');
  assert.match(block, /\.platform-side-strip-top \{[^}]*right: calc\(var\(--platform-strip-axis\) - var\(--platform-strip-back\) \/ 2\);/,
    'the back disc stands on the axis, under the clock');
  assert.match(block, /html\[data-side-strip="left"\] body:not\(:has\(#platform-header\.hidden\)\) \.platform-side-strip-top \{\s*left: calc\(var\(--platform-strip-axis\) - var\(--platform-strip-back\) \/ 2\);\s*right: auto;/,
    'mirrored for a left strip');
  assert.match(block, /\.platform-side-strip-top \{[^}]*position: fixed;[^}]*top: var\(--platform-strip-top\);[^}]*pointer-events: none;/,
    'the box is no target: only a live control takes the press');
  // The foot band goes: the screens clear the home indicator only.
  // …with the app you left up too: it stands in the strip as well.
  assert.match(block, /html\[data-side-strip\]:not\(\.un-kb\) body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\),\n\s*html\[data-side-strip\]:not\(\.un-kb\) body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\):has\(#platform-parked:not\(\.hidden\)\) \{\s*--platform-bar-h: 0px;\s*--platform-tabs-h: var\(--platform-safe-bottom\);/);
});

test('the header runs across the strip; its controls stay beside it', () => {
  assert.match(block, /html\[data-side-strip="right"\] #platform-header \{\s*margin-right: calc\(-1 \* var\(--platform-strip-w, 0px\)\);\s*padding-right: calc\(1rem \+ var\(--platform-strip-w, 0px\)\);/);
});

// 6666: the bell's sheet is fixed like the header, so its ground spans the
// screen while its content — the close disc, Mark all read, the search, the
// tabs and every row — stops beside the column.
test('the bell\'s sheet keeps its ground and moves its content beside the strip', () => {
  assert.match(block, /html\[data-side-strip="right"\] #notifications-sheet \{\s*padding-right: var\(--platform-strip-w, 0px\);/,
    'the sheet\'s content stops left of the column');
  assert.match(block, /html\[data-side-strip="left"\] #notifications-sheet \{\s*padding-left: var\(--platform-strip-w, 0px\);/,
    'mirrored when the column is on the left');
});

test('a sheet screen\'s strip wears the sheet, opaque, under the header', () => {
  const ground = block.match(/html\[data-side-strip\] body:has\(([^{]+)\) \.platform-side-strip-ground \{([^}]*)\}/);
  assert.ok(ground, 'the ground has a rule');
  assert.match(ground[1], /#messages-screen/);
  assert.match(ground[2], /z-index: 9;/, 'under the header (10), over the screens a drawer pans');
  assert.match(ground[2], /top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top, 0px\) - 0\.5rem\);/, 'from the sheet\'s own top');
  assert.match(block, /\.platform-side-strip-ground::before \{[^}]*position: fixed;[^}]*linear-gradient\(var\(--dc-strip-fill\), var\(--dc-strip-fill\)\),\s*var\(--home-wallpaper/);
  assert.match(block, /html\[data-side-strip="right"\] \.dc-lift-strip:not\(#app-content > \.dc-lift-strip\):not\(\.messages-drawer\) \{\s*border-top-right-radius: 0;/);
  // A project's pages run their own sheet under the strip (below), so the
  // ground is for the screens that do not.
  assert.doesNotMatch(ground[1], /#app-view/);
});

test('the drawer under the strip is veiled while it is out, coming in at the strip\'s edge', () => {
  const frost = block.match(/html\[data-side-strip\] \.platform-side-strip-frost \{([^}]*)\}/);
  assert.ok(frost, 'the frost has a rule');
  assert.match(frost[1], /z-index: 25;/, 'over the drawer (20), under the pill and the back button (30)');
  // Whole from the strip's own edge (the pill's gap to the screen's edge,
  // mirrored), coming in over the 16px before it, a screen's own margin, so
  // no card is ever under it; eased, so the edge is not a line.
  assert.match(frost[1], /width: calc\(var\(--platform-strip-w, 0px\) \+ 16px\);/);
  assert.match(frost[1], /mask-image: linear-gradient\(to right, transparent, rgba\(0, 0, 0, \.2\) 5px, rgba\(0, 0, 0, \.55\) 10px, rgba\(0, 0, 0, \.85\) 14px, #000 16px\);/);
  // A fill of the wallpaper's ground, not a blur: the blur stuttered the
  // slides, re-run on every frame of the page moving under it.
  // What is behind the strip at rest: a sheet's tint over the wallpaper, as
  // a viewport-fixed layer clipped to the veil, at 86%.
  assert.match(frost[1], /background: transparent;\s*clip-path: inset\(0\);/);
  assert.doesNotMatch(frost[1], /backdrop-filter/);
  assert.match(block, /\.platform-side-strip-frost::before \{[^}]*position: fixed;\s*inset: 0;[^}]*opacity: \.86;[^}]*linear-gradient\(var\(--dc-strip-fill\), var\(--dc-strip-fill\)\),\s*var\(--home-wallpaper, var\(--dc-strip-solid\)\);/);
  assert.match(frost[1], /pointer-events: none;/);
  assert.match(frost[1], /visibility: hidden;[^}]*opacity: 0;/, 'out of the paint at rest');
  // It fades over the slide's own length and curve, on the compositor: a
  // transition, never a script writing opacity on every frame (which held
  // the glass while the page slid on under it).
  const math = loadTsx('frontend/src/features/nav-drawer/drawer-math.ts');
  assert.equal(math.SLIDE_MS, 300);
  assert.equal(math.SLIDE_EASE, 'cubic-bezier(0.33, 1, 0.68, 1)');
  // Out on the mirror of the slide's ease-out, so it lifts off rather
  // than vanishing under the arriving page.
  assert.match(frost[1], /transition: opacity 300ms cubic-bezier\(0\.32, 0, 0\.67, 0\), visibility 0s linear 300ms;/);
  assert.match(block, /\.platform-side-strip-frost\[data-out\] \{\s*visibility: visible;\s*opacity: 1;\s*transition: opacity 300ms cubic-bezier\(0\.33, 1, 0\.68, 1\), visibility 0s;/);
  assert.match(block, /html\[data-side-strip\] body:has\(#platform-header\.hidden\) \.platform-side-strip-frost \{\s*display: none;/);
  assert.match(block, /body:has\(#messages-screen:not\(\.hidden\) \.messages-drawer-alone\) \.platform-side-strip-frost \{\s*visibility: hidden;/);
  // Out from the drawer's LEVEL: Messages on its list. A community's page has
  // no levels off it since 3 Nov 2026 (its places are the Hub's rows).
  const strip = read('frontend/src/features/nav/strip-back.tsx');
  assert.match(strip, /const out = messages\.on && messages\.level === 0;/);
  assert.match(strip, /<div className="platform-side-strip-frost" aria-hidden="true" \{\.\.\.\(out \? \{ 'data-out': '' \} : \{\}\)\} \/>/);
  assert.doesNotMatch(strip, /style\.opacity/, 'no script writes the glass\'s opacity');
});

test('a project\'s pages run under the strip', () => {
  assert.match(block, /html\[data-side-strip="right"\] :is\(#app-view\[data-app-surface="platform"\], #app-view\[data-app-surface="platform"\] > #app-content, #app-view\[data-app-surface="platform"\] > #app-content > \.dc-lift-strip\) \{\s*margin-right: calc\(-1 \* var\(--platform-strip-w, 0px\)\);\s*padding-right: var\(--platform-strip-w, 0px\);/,
    'the page, its host and its sheet reach under the strip; their content stays beside it');
  // 3 Nov 2026: no drawer over them any more, so no levels to fit beside it.
  assert.doesNotMatch(block, /\.nav-drawer-outer|\.nav-drawer-places/);
});

test('Messages\' drawer runs under the strip the same way', () => {
  assert.match(block, /html\[data-side-strip="right"\] #messages-screen:has\(> \.messages-layout\.messages-drawer\) \{\s*margin-right: calc\(-1 \* var\(--platform-strip-w, 0px\)\);/);
  assert.match(block, /html\[data-side-strip="right"\] #messages-screen > \.messages-layout\.messages-drawer \{\s*padding-right: var\(--platform-strip-w, 0px\);/);
  assert.match(block, /html\[data-side-strip="right"\] \.messages-layout\.messages-drawer > \.messages-list-pane \{\s*width: calc\(\(100% - var\(--platform-strip-w, 0px\)\) \* 0\.85\);/);
  assert.match(block, /html\[data-side-strip="right"\] \.messages-layout\.messages-drawer > \.messages-thread-pane \{\s*padding-right: var\(--platform-strip-w, 0px\);/);
  // Its floating discs are positioned off the sheet's edge, which padding
  // does not move: they come in by the strip too, from their own 12px.
  assert.match(APP_CSS, /\.messages-layout\.messages-drawer > \.messages-thread-pane > \.messages-thread-header \{\s*position: absolute; top: 4px; inset-inline-end: 12px;/);
  // Audit C01: they float only over the bot's strip; over a transcript they
  // take a slim row of their own, so no bubble sits under them.
  assert.match(APP_CSS, /\.messages-layout\.messages-drawer > \.messages-thread-pane > \.messages-thread-header:not\(:has\(\+ \[data-bot-strip\]\)\) \{\s*position: static; padding: 4px 12px; justify-content: flex-end;/);
  assert.match(block, /html\[data-side-strip="right"\] \.messages-layout\.messages-drawer > \.messages-thread-pane > \.messages-thread-header \{\s*right: calc\(12px \+ var\(--platform-strip-w, 0px\)\);/);
  // Its own sheet runs under the strip, so the strip's ground is not drawn.
  assert.match(block, /\.dc-lift-strip:not\(\.messages-drawer\)\) \.platform-side-strip-ground \{/);
  // It pans by the width beside the strip.
  const drawer = read('frontend/src/features/messages/phone-drawer.tsx');
  assert.match(drawer, /Math\.max\(1, \(layout\?\.clientWidth \|\| 1\) - stripWidth\(\)\)/);
  assert.equal((drawer.match(/- stripWidth\(\)/g) || []).length, 2, 'placement and the touch pan back (no peek to pan toward since 3 Nov 2026)');
  const { stripWidth } = loadTsx('frontend/src/lib/side-strip.ts');
  const root = (attr, w) => ({ documentElement: { hasAttribute: () => attr, style: { getPropertyValue: () => w } } });
  assert.equal(stripWidth(root(true, '84px')), 84);
  assert.equal(stripWidth(root(false, '84px')), 0, 'no strip, nothing taken off');
});

test('the strip\'s tabs: one capsule at the foot, the apps above it', () => {
  // THE CAPSULE (Evan, 18 Nov 2026): the system draws a tab bar in the
  // Duo's column as one 48px capsule at the column's foot, icons only, on
  // the same centre line as the clock; ours stands the same way.
  assert.match(block, /html\[data-side-strip\] #platform-tabs \{[^}]*right: calc\(var\(--platform-strip-axis\) - 24px\);[^}]*top: auto;[^}]*bottom: var\(--platform-strip-foot\);[^}]*width: 48px;/);
  assert.match(block, /html\[data-side-strip="left"\] #platform-tabs \{\s*left: calc\(var\(--platform-strip-axis\) - 24px\);\s*right: auto;/);
  assert.match(block, /--platform-strip-foot: 24px;/, 'in the home-indicator strip, as the system\'s own capsule');
  assert.match(block, /html\[data-side-strip\] #platform-tabs \{[^}]*border-radius: 999px;[^}]*background: var\(--dc-sheet-solid\);[^}]*box-shadow: inset 0 0 0 1px var\(--app-sheet-line\)/,
    'the page\'s own plane with its hairline, in every look');
  assert.doesNotMatch(block, /--platform-strip-pill-top/, 'the capsule hangs from the foot, not from the back slot');
  assert.doesNotMatch(block, /transition: top/, 'nothing to slide');
  assert.doesNotMatch(block, /html\[data-side-strip\] #platform-tab-me \{\s*(margin-top|order):/, 'you are last in the capsule already');
  // The apps stand above the capsule, lifted out of its flow (the section is
  // the bar's first child: the declared checks pin the tabs' sibling chain).
  assert.match(block, /html\[data-side-strip\] \.platform-side-apps:not\(\.hidden\) \{\s*position: absolute;\s*left: 0;\s*bottom: calc\(100% \+ 12px\);/);
  assert.doesNotMatch(block, /\.platform-side-apps:not\(\.hidden\) \{\s*order:/);
  assert.match(block, /html\[data-side-strip\] \.platform-side-apps-head \{\s*display: none;/);
  assert.match(block, /html\[data-side-strip\] \.platform-side-app \{[^}]*width: 48px;\s*height: 48px;\s*border-radius: 999px;\s*background: var\(--dc-sheet-solid\);/,
    'each app a disc of the capsule\'s own plane');
  // The lit state is drawn once, as a pill inside the capsule from the bar's
  // own tokens, so the sliding marker is not drawn here (the desktop rail
  // does the same), and the phone bar's fake glass stays away.
  assert.match(block, /html\[data-side-strip\] \.platform-tabs-marker \{\s*display: none;/,
    'the lit state is drawn once, by the pill');
  assert.match(block, /html\[data-side-strip\] #platform-tabs::before \{\s*content: none;/,
    'no fake glass behind the capsule');
  assert.match(block, /html\[data-side-strip\] \.platform-tab\[aria-current="page"\] \{\s*background: var\(--lit-tint\);\s*box-shadow: inset 0 0 0 1px var\(--lit-line\);/,
    'the place you are on is filled from the bar\'s lit tokens');
  assert.match(block, /html\[data-side-strip\] \.platform-tab\[aria-current="page"\] \.platform-tab-mark \{\s*color: var\(--lit-ink\);/);
  // Icons only, as the system's side tabs: the words stay for a screen
  // reader and the declared checks, clipped rather than removed.
  assert.match(block, /html\[data-side-strip\] :is\(\.platform-tab, \.platform-side-app\) \.platform-tab-label \{\s*position: absolute;\s*width: 1px;\s*height: 1px;\s*overflow: hidden;\s*clip-path: inset\(50%\);/);
  assert.doesNotMatch(block, /\.platform-tab-label \{[^}]*display: none/, 'never removed');
  // A community's page lights Communities, which is drawn on the strip
  // again (18 Nov 2026), so Home no longer stands in for it.
  assert.doesNotMatch(APP_CSS, /:has\(#platform-tab-workshop\[aria-current="page"\]\) #platform-tab-home/);
  assert.doesNotMatch(APP_CSS, /#platform-tab-workshop \{ display: none/, 'nothing hides the tab');
  // The strip still measures the marker (tab-bar.tsx), and the phone's bar
  // still draws it with its own 16px radius.
  assert.match(APP_CSS, /\.platform-tabs-marker \{[^}]*border-radius: 16px;/);
  assert.match(read('frontend/src/features/nav/tab-bar.tsx'), /markerBoxFor\(el, tabContentRect\(el\), inStrip\)/);
  // The phone's Resume strip stands aside: the section offers the app you left.
  assert.match(block, /html\[data-side-strip\] #platform-parked \{\s*display: none;/);
  assert.match(read('frontend/src/features/nav/strip-back.tsx'), /<div className="platform-side-strip-ground" aria-hidden="true" \/>/);
});

test('the apps section: the app on screen lit, the app you left with its ✕', () => {
  const tsx = read('frontend/src/features/nav/side-apps.tsx');
  assert.match(tsx, /aria-current="page"/, 'the app on screen is where you are');
  assert.match(tsx, /forgetParked\(left\)/);
  assert.match(tsx, /window\.App\?\.openAppTab\?\.\(left\.slug, 'app'\)/, 'resume is the router\'s own entry');
  assert.match(tsx, /\(running \|\| left \? '' : ' hidden'\)/, 'nothing drawn, heading included, with neither');
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.ok(bar.indexOf('<SideApps />') > bar.indexOf('id="platform-tabs"')
    && bar.indexOf('<SideApps />') < bar.indexOf('className="platform-tabs-marker"'),
    'first in the bar, before the marker: the marker + Home chain #2824 pins stays whole');
  assert.match(bar, /useTabMarker\(barRef, tab, runningApp && !!onScreenApp\)/, 'the marker lights the app while no tab is');
  assert.match(bar, /'\.platform-side-app\[aria-current="page"\]'/);
  // app.js says which app is on screen, beside what it parks.
  const app = read('public/js/app.js');
  assert.match(app, /if \(typeof bridge\.running === 'function'\) bridge\.running\(running\);/);
  assert.match(app, /if \(typeof bridge\.running === 'function'\) bridge\.running\(null\);/);
  // The resume motion lands on the section's tile, and the reopen grows out
  // of that same tile, not the whole 64x54 row around it.
  assert.match(read('frontend/src/features/nav/resume-motion.ts'), /#platform-tabs \.platform-side-app\[data-side-app\]/);
  assert.match(tsx, /noteResumeOrigin\(left\.slug, event\.currentTarget\.querySelector\('\.platform-side-app-tile'\) \|\| event\.currentTarget\);\s*window\.App\?\.openAppTab\?\.\(left\.slug, 'app'\);/);
  // The strip is always on screen, so its icon is never left to lazy loading.
  assert.match(tsx, /<AppIconContent app=\{record\(app\)\} eager \/>/);
  const core = JSON.parse(read('frontend/locales/en/core.json'));
  assert.equal(core['tabs.stripApps'].text, 'Apps');
  assert.equal(core['tabs.stripResume'].text, 'Resume {{app}}');
});

test('in a running app the tabs stay in the strip and the ✕ goes', () => {
  assert.match(block, /html\[data-side-strip\]:not\(\.un-kb\):not\(\.platform-kb-open\) body:has\(#app-view:not\(\.hidden\)\[data-app-surface="app"\]\):not\(:has\(#platform-header\.hidden\)\) #platform-tabs\.platform-tabs-route-hidden \{\s*display: flex;/,
    'over a running app only, with the platform header up');
  assert.match(block, /\.platform-side-strip-back:is\(\.hidden, \[data-back="close"\]\) \{\s*display: none;/);
  assert.match(read('frontend/src/features/nav/strip-back.tsx'), /data-back=\{mode\}/);
});

test('the drawer\'s titles have no slot to step out of when the arrow is in the strip', () => {
  const { titleSlot } = loadTsx('frontend/src/features/nav-drawer/drawer-math.ts');
  // On a phone: the arrow and its gap.
  assert.equal(titleSlot({ laidOut: true, left: 60 }, { laidOut: true, left: 16 }), 44);
  // On the Duo the empty group is not drawn: 0, not the titles' own 16px
  // (which put "Messages" against the screen's edge).
  assert.equal(titleSlot({ laidOut: true, left: 16 }, { laidOut: false, left: 0 }), 0);
  // A hidden header reads zero for both and says nothing.
  assert.equal(titleSlot({ laidOut: false, left: 0 }, { laidOut: false, left: 0 }), null);
  assert.equal(titleSlot({ laidOut: true, left: 16 }, { laidOut: true, left: 16 }), null);
  assert.match(read('frontend/src/features/nav-drawer/header-drawer.tsx'), /const at = titleSlot\(/);
});

test('the strip controls are rendered from the header\'s own back slot', () => {
  const strip = read('frontend/src/features/nav/strip-back.tsx');
  assert.match(strip, /useBackSlot\(\)/);
  assert.match(strip, /document\.getElementById\('back-btn'\)\?\.click\(\)/, 'a press is #back-btn\'s');
  assert.match(strip, /<DrawerBack \/>/);
  const header = read('frontend/src/features/header/platform-header.tsx');
  assert.match(header, /export function useBackSlot\(\)/);
  assert.match(header, /const \{ mode, href: resolvedBackHref, paneBack \} = useBackSlot\(\);/);
  assert.match(read('frontend/src/Shell.tsx'), /<Island name="StripBack"><StripBack \/><\/Island>/);
});

// ── app.css: THE TOP BAND (6070) ───────────────────────────────────────

const bandBlock = (() => {
  const start = APP_CSS.indexOf('THE TOP BAND — iPhone Duo');
  // THE SIDE CORNER block follows the band (6072), so the slice ends at its
  // heading rather than at the next section after both.
  const end = APP_CSS.indexOf('THE SIDE CORNER — iPhone Duo', start);
  assert.ok(start > 0 && end > start, 'the top band block is in app.css');
  return APP_CSS.slice(start, end);
})();

test('the top band block is keyed on the band, and only on a phone with an inset', () => {
  const selectors = [...bandBlock.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map((m) => m[1].trim())
    .filter((sel) => sel && !sel.startsWith('@media') && !sel.startsWith('@supports'));
  assert.ok(selectors.length >= 2, 'the height and the bars');
  for (const sel of selectors) {
    assert.match(sel, /html\[data-top-band/, `${sel} applies only with the band`);
  }
  assert.match(bandBlock, /@media \(max-width: 767px\) \{\s*@supports \(padding: env\(safe-area-inset-top\)\) \{/,
    'phones only, and only where a top inset exists');
});

test('the top band gives the header the band and its foot to the screens below', () => {
  assert.match(bandBlock, /html\[data-top-band\] \{\s*--platform-header-h: max\(0px, calc\(3\.25rem - var\(--platform-band-h\)\)\);/,
    'the height below loses what the band now covers');
  const bars = bandBlock.match(/html\[data-top-band\] :is\(#platform-header, #landing-header\)\.un-safe-top-extend,[^{]*\{([^}]*)\}/);
  assert.ok(bars, 'one rule lays both bars into the band');
  assert.match(bars[0], /html\[data-top-band\]\[data-community-tint\] body:has\(#app-view:not\(\.hidden\)\) #platform-header\.un-safe-top-extend/,
    'and repeats the community tint\'s app-view rule so it outranks it');
  // The row sits on the clock's line, the digits' middle 34px above the
  // band's foot: pinned to the top it sat about 25px above that line, and
  // centred in the band about 7px above it.
  assert.match(bars[1], /padding-top: max\(0\.5rem, calc\(var\(--platform-band-h\) - 3rem\)\) !important;/,
    'the inset leaves the padding; the band less row and foot over the row, the 8px pad the floor');
  assert.match(bars[1], /padding-bottom: 1\.25rem;/,
    'a 20px foot under the row, and the bar\'s foot meets the band\'s foot');
  assert.doesNotMatch(bars[1], /align-items: flex-start;/, 'the row is on the clock\'s line, not pinned to the band\'s top');
  // The unfolded Duo's clock and Wi-Fi ring sit in a pill about 130px wide
  // (x 540 to 669 on the simulator); at 84px the account chevron sat under it.
  assert.match(bars[1], /padding-right: calc\(0\.5rem \+ 130px\);/, 'the right group clears the clock and Wi-Fi pill');
});

// ── app.css: THE SIDE CORNER (6072) ─────────────────────────────────────

const cornerBlock = (() => {
  const start = APP_CSS.indexOf('THE SIDE CORNER — iPhone Duo');
  const end = APP_CSS.indexOf('/* ── #platform-parked — the app you left', start);
  assert.ok(start > 0 && end > start, 'the side corner block is in app.css');
  return APP_CSS.slice(start, end);
})();

test('the corner block is keyed on the corner, and only on a phone', () => {
  const selectors = [...cornerBlock.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map((m) => m[1].trim())
    .filter((sel) => sel && !sel.startsWith('@media'));
  assert.ok(selectors.length >= 6, 'the content, the header and the bar, both sides');
  for (const sel of selectors) {
    assert.match(sel, /html\[data-side-corner/, `${sel} applies only with the corner`);
  }
  assert.match(cornerBlock, /@media \(max-width: 767px\) \{/, 'phones only');
  assert.doesNotMatch(cornerBlock, /data-side-strip/, 'the column layout is never keyed on the corner');
});

test('the corner keeps the content, the header\'s controls and the five cells out of it', () => {
  assert.match(cornerBlock, /html\[data-side-corner="right"\] body,\s*html\[data-side-corner="right"\] #auth-landing-screen \{\s*padding-right: var\(--platform-corner-w, 0px\);/);
  assert.match(cornerBlock, /html\[data-side-corner="left"\] body,\s*html\[data-side-corner="left"\] #auth-landing-screen \{\s*padding-left: var\(--platform-corner-w, 0px\);/);
  assert.match(cornerBlock, /html\[data-side-corner="right"\] #platform-header \{\s*margin-right: calc\(-1 \* var\(--platform-corner-w, 0px\)\);\s*padding-right: calc\(1rem \+ 84px\);/,
    'the header spans the screen; its controls clear the 84px corner (6070)');
  assert.match(cornerBlock, /html\[data-side-corner="left"\] #platform-header \{\s*margin-left: calc\(-1 \* var\(--platform-corner-w, 0px\)\);\s*padding-left: calc\(1rem \+ 84px\);/,
    'mirrored for Split View against the left edge');
  assert.match(cornerBlock, /html\[data-side-corner="right"\] #notifications-sheet \{\s*padding-right: var\(--platform-corner-w, 0px\);/,
    'the bell\'s sheet moves its content by the corner\'s own width (6666)');
  assert.match(cornerBlock, /html\[data-side-corner="left"\] #notifications-sheet \{\s*padding-left: var\(--platform-corner-w, 0px\);/);
  assert.match(cornerBlock, /html\[data-side-corner="right"\] #platform-tabs \{\s*padding-right: var\(--platform-corner-w, 0px\);/,
    'the bar keeps its ground; its cells stay left of the corner');
  assert.match(cornerBlock, /html\[data-side-corner="left"\] #platform-tabs \{\s*padding-left: var\(--platform-corner-w, 0px\);/);
});
