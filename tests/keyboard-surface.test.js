'use strict';
// iPhone 17 simulator, iOS 26 Safari and the Homeroom app, 5 October 2026:
//
//   1. The sign-in sheet's password step: with the keyboard up the Sign in
//      button sat behind the keys and the password field half under the
//      keyboard's floating bar.
//   2. "What do you want to make?": "Make it" sat under that bar once a press
//      had scrolled the form, and iOS had panned the wordmark off the top.
//   3. In the app, opening the sheet focused Email while it slid up, so the
//      keys rose under a moving sheet and iOS scrolled the story behind it;
//      the sheet was a flat system grey.
//   4. The story landing's "Already have an account? Sign in" sat behind
//      Safari's bottom toolbar.
//
// Six parts:
//   1. lib/keyboard-open.ts publishes the foot of the visible band
//      (`--platform-kb-cover`) with its class, in Safari, Android and the app;
//   2. lib/keyboard-surface.ts's arithmetic: reveal the field with its form's
//      button when they fit, and ride a keyboard-sized step;
//   3. lib/keyboard-surface.ts executed against fakes: a tap focuses without
//      the pan (the first tap on a field focused from code too), the field is
//      revealed in the scroller once the keys settle, and the sheet rides;
//   4. app.css: the surfaces pad into the band, and the story's foot clears
//      Safari's toolbar;
//   5. the make screen and the sign-in sheet use it;
//   6. the sheet opens without a caret on a touch screen, keeps the page
//      behind it still, and is drawn as the platform's sheet.
//
// What this cannot do is raise a real keyboard; the numbers are the iPhone 17
// Pro's measured in Safari (#1938): a 714px layout viewport, a 377px visual
// viewport above the keys, the pill and the form bar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP_CSS = read('public/css/app.css');
const MAKE = read('frontend/src/features/first-session/make.tsx');
const SHEET = read('frontend/src/features/auth/sign-in-sheet.tsx');
const { physics } = require('../public/usernode-native/v1/native.js');
const open = loadTsx('frontend/src/lib/keyboard-open.ts');
const surface = loadTsx('frontend/src/lib/keyboard-surface.ts');

// ── 1. The band's foot ──────────────────────────────────────────────────

test('visibleBand: what is out of sight under the visual viewport, panned or not, in every host', () => {
  const { visibleBand } = open;
  // Safari: the layout viewport stays 714, the keys (and the pill and the
  // form bar over them) take 337.
  assert.deepEqual(visibleBand({ layout: 714, vv: { height: 377, offsetTop: 0, scale: 1 } }), { pan: 0, cover: 337 });
  // Panned by iOS to a field: the band starts 200 down and ends 137 above the foot.
  assert.deepEqual(visibleBand({ layout: 714, vv: { height: 377, offsetTop: 200, scale: 1 } }), { pan: 200, cover: 137 });
  // The app: its web view ends at the keys, so the visual viewport is the page.
  assert.deepEqual(visibleBand({ layout: 494, vv: { height: 494, offsetTop: 0, scale: 1 } }), { pan: 0, cover: 0 });
  // Android Chrome: covered, never panned.
  assert.deepEqual(visibleBand({ layout: 810, vv: { height: 498, offsetTop: 0, scale: 1 } }), { pan: 0, cover: 312 });
  // A pinch zoom is not the keys; nothing readable is nothing.
  assert.deepEqual(visibleBand({ layout: 714, vv: { height: 300, offsetTop: 50, scale: 2 } }), { pan: 0, cover: 0 });
  assert.deepEqual(visibleBand({ layout: 714, vv: null }), { pan: 0, cover: 0 });
  assert.deepEqual(visibleBand({ layout: 0, vv: { height: 377 } }), { pan: 0, cover: 0 });
});

test('the cover is published with the class, follows the viewport while open, and is 0 the moment the field lets go', () => {
  const { initKeyboardOpen, KB_COVER_VAR, KB_OPEN_CLASS, PHONE_QUERY } = open;
  assert.equal(KB_COVER_VAR, '--platform-kb-cover');
  const listeners = { win: {}, vv: {}, doc: {} };
  const on = (bucket) => (type, fn) => { (listeners[bucket][type] ||= []).push(fn); };
  const fire = (bucket, type, event = {}) => (listeners[bucket][type] || []).forEach((fn) => fn(event));
  const props = {};
  const classes = new Set();
  const root = {
    clientHeight: 714,
    classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); } },
    style: { setProperty(name, value) { props[name] = value; } },
  };
  const body = { tagName: 'BODY' };
  const doc = { activeElement: body, body, documentElement: root, addEventListener: on('doc') };
  const vv = { height: 714, offsetTop: 0, scale: 1, addEventListener: on('vv') };
  const win = {
    innerHeight: 714, innerWidth: 402, visualViewport: vv,
    matchMedia: (q) => ({ matches: q === PHONE_QUERY }),
    addEventListener: on('win'), unNative: { physics },
    performance: { now: () => 0 }, setTimeout: () => 0, clearTimeout() {},
  };
  initKeyboardOpen(doc, win);
  assert.equal(props[KB_COVER_VAR], undefined, 'nothing written at rest');
  const field = { tagName: 'INPUT', type: 'password' };
  doc.activeElement = field;
  fire('doc', 'focusin');
  // The keys: iOS collapses innerHeight with the visual viewport (#1938).
  vv.height = 377; win.innerHeight = 377;
  fire('vv', 'resize');
  assert.ok(classes.has(KB_OPEN_CLASS));
  assert.equal(props[KB_COVER_VAR], '337px');
  // The pan arrives in its own event; the cover follows it.
  vv.offsetTop = 120;
  fire('vv', 'scroll');
  assert.equal(props[KB_COVER_VAR], '217px', 'the visual viewport\'s scroll is listened to');
  // The QuickType row arriving late shrinks the band again.
  vv.height = 333;
  fire('vv', 'resize');
  assert.equal(props[KB_COVER_VAR], '261px');
  // A blur to nowhere: 0 in the event, before iOS reports the keys down.
  doc.activeElement = body;
  fire('doc', 'focusout', { relatedTarget: null });
  assert.ok(!classes.has(KB_OPEN_CLASS));
  assert.equal(props[KB_COVER_VAR], '0px');
});

// ── 2. The arithmetic ───────────────────────────────────────────────────

test('revealScrollTop: the field, and its button under it when the two fit, between the scroller\'s edges', () => {
  const { revealScrollTop, REVEAL_MARGIN } = surface;
  assert.equal(REVEAL_MARGIN, 12);
  const view = { scrollTop: 100, scrollMax: 900, viewTop: 52, viewBottom: 377 };
  // The password field half under the band's foot, Sign in 70px below it:
  // both fit, so the button's foot lands 12px above the band's.
  assert.equal(revealScrollTop({ ...view, fieldTop: 300, fieldBottom: 370, actionTop: 382, actionBottom: 432 }), 100 + (432 - 365));
  // A button that would not fit with the field: the field alone.
  assert.equal(revealScrollTop({ ...view, fieldTop: 300, fieldBottom: 370, actionTop: 382, actionBottom: 700 }), 100 + (370 - 365));
  // Already in view with its button: nothing moves.
  assert.equal(revealScrollTop({ ...view, fieldTop: 100, fieldBottom: 160, actionTop: 170, actionBottom: 220 }), 100);
  // Above the view (under the bar): scrolled down to it.
  assert.equal(revealScrollTop({ ...view, fieldTop: 20, fieldBottom: 80 }), 100 - (64 - 20));
  // A field taller than the view keeps its own top in view.
  assert.equal(revealScrollTop({ ...view, fieldTop: 200, fieldBottom: 800 }), 100 + (200 - 64));
  // Never past the scroller's range.
  assert.equal(revealScrollTop({ ...view, scrollMax: 120, fieldTop: 600, fieldBottom: 650 }), 120);
  assert.equal(revealScrollTop({ ...view, scrollTop: 10, fieldTop: -400, fieldBottom: -350 }), 0);
  // A button ABOVE the field (not this form's order) is not chased.
  assert.equal(revealScrollTop({ ...view, fieldTop: 300, fieldBottom: 370, actionTop: 100, actionBottom: 150 }), 105);
});

test('rideOffset: only a keyboard-sized step is ridden, and never with reduced motion', () => {
  const { rideOffset, RIDE_MIN, RIDE_MS } = surface;
  assert.equal(RIDE_MIN, 100);
  assert.equal(RIDE_MS, 250);
  assert.equal(rideOffset(500, 163), 337, 'up onto the keys: starts where it was, 337px lower');
  assert.equal(rideOffset(163, 500), -337, 'and down with them');
  assert.equal(rideOffset(500, 470), null, 'a host resizing frame by frame moves a little each time');
  assert.equal(rideOffset(null, 163), null, 'nothing to ride from');
  assert.equal(rideOffset(500, 163, true), null, 'reduced motion: it simply lands');
});

// ── 3. Executed ─────────────────────────────────────────────────────────

function fakeEl(props = {}) {
  const listeners = {};
  return {
    nodeType: 1,
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    fire(type, event) { (listeners[type] || []).slice().forEach((fn) => fn(event)); },
    count(type) { return (listeners[type] || []).length; },
    ...props,
  };
}

function rig({ platform = 'ios', keysUp = false, reduced = false } = {}) {
  let clock = 0;
  let seq = 0;
  const timers = [];
  const frames = [];
  const rootClasses = new Set(keysUp ? ['platform-kb-open'] : []);
  const submit = fakeEl({ tagName: 'BUTTON', rect: { top: 470, bottom: 520 } });
  submit.getBoundingClientRect = () => submit.rect;
  const form = { querySelector: (sel) => (/submit/.test(sel) ? submit : null) };
  const field = fakeEl({ tagName: 'INPUT', type: 'password', rect: { top: 400, bottom: 460 }, focused: [], blurred: 0, form });
  field.closest = (sel) => (/input/.test(sel) ? field : null);
  field.getBoundingClientRect = () => field.rect;
  field.focus = (opts) => { field.focused.push(opts || null); doc.activeElement = field; };
  field.blur = () => { field.blurred += 1; doc.activeElement = null; };
  const scrolls = [];
  const animations = [];
  const scroller = fakeEl({
    scrollTop: 0, scrollHeight: 900, clientHeight: 325, offsetTop: 500,
    getBoundingClientRect: () => ({ top: 52, bottom: 377 }),
    contains: (node) => node === field || node === submit,
    scrollTo({ top }) { scrolls.push(top); scroller.scrollTop = top; },
    animate(keyframes, options) { animations.push({ keyframes, options }); },
  });
  const vv = fakeEl();
  const win = fakeEl({
    unNative: { platform, physics, gestures: { owner: () => null } },
    visualViewport: vv,
    matchMedia: (q) => ({ matches: reduced && /reduce/.test(q) }),
    requestAnimationFrame: (fn) => { frames.push(fn); },
    setTimeout(fn, ms) { seq += 1; timers.push({ id: seq, fn, due: clock + ms }); return seq; },
    clearTimeout(id) { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1); },
  });
  const doc = { activeElement: null, documentElement: { classList: { contains: (c) => rootClasses.has(c) } } };
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      clock = due.due;
      due.fn();
    }
    clock = end;
  };
  const flush = () => frames.splice(0).forEach((fn) => fn());
  const tap = (target = field, { moved = false } = {}) => {
    const event = { target, touches: [], cancelable: true, prevented: false, preventDefault() { this.prevented = true; } };
    scroller.fire('touchstart', { touches: [{ clientX: 10, clientY: 10 }] });
    if (moved) scroller.fire('touchmove', { touches: [{ clientX: 10, clientY: 40 }] });
    scroller.fire('touchend', event);
    return event;
  };
  return { scroller, field, submit, win, doc, vv, rootClasses, scrolls, animations, advance, flush, tap };
}

test('a tap on a field is taken: focused with preventScroll, so iOS does not pan the page', () => {
  const r = rig();
  surface.attachKeyboardSurface(r.scroller, r.win, r.doc);
  const event = r.tap();
  assert.equal(event.prevented, true, 'the native focus, and with it the native reveal, is cancelled');
  assert.deepEqual(r.field.focused, [{ preventScroll: true }]);
  assert.equal(r.field.blurred, 0, 'a field without focus is just focused');
  // A drag that ends on a field is a scroll, natively.
  const drag = r.tap(r.field, { moved: true });
  assert.equal(drag.prevented, false);
});

test('the first tap on a field focused from code is taken too, once; with the keys up taps are native', () => {
  const r = rig();
  surface.attachKeyboardSurface(r.scroller, r.win, r.doc);
  r.doc.activeElement = r.field; // the screen put the caret there; iOS raised no keys
  const first = r.tap();
  assert.equal(first.prevented, true);
  assert.equal(r.field.blurred, 1, 'blurred, then refocused inside the tap: the keys come up without the pan');
  assert.deepEqual(r.field.focused, [{ preventScroll: true }]);
  const second = r.tap();
  assert.equal(second.prevented, false, 'every later tap there places the caret natively');

  const up = rig({ keysUp: true });
  surface.attachKeyboardSurface(up.scroller, up.win, up.doc);
  up.doc.activeElement = up.field;
  assert.equal(up.tap().prevented, false, 'its keys are up: the tap moves the caret');
});

test('once the keys settle the field is revealed in the scroller, with its form\'s button', () => {
  const r = rig();
  surface.attachKeyboardSurface(r.scroller, r.win, r.doc);
  r.tap();
  // The keys come up: a burst of viewport events, then quiet.
  r.vv.fire('resize');
  r.advance(60);
  r.vv.fire('resize');
  r.advance(surface.SETTLE_MS - 1);
  assert.deepEqual(r.scrolls, [], 'not per event');
  r.advance(1);
  // The password field ends at 460 and Sign in at 520; the view ends at 377.
  assert.deepEqual(r.scrolls, [520 - (377 - 12)], 'the button\'s foot 12px above the band\'s');
  // A host that reports nothing still gets its reveal.
  const quiet = rig();
  surface.attachKeyboardSurface(quiet.scroller, quiet.win, quiet.doc);
  quiet.tap();
  quiet.advance(surface.FALLBACK_MS);
  assert.equal(quiet.scrolls.length, 1);
});

test('a focus moved by code with the keys up is revealed at once; a desktop attaches nothing', () => {
  const r = rig({ keysUp: true });
  surface.attachKeyboardSurface(r.scroller, r.win, r.doc);
  r.doc.activeElement = r.field;
  r.scroller.fire('focusin', { target: r.field });
  r.flush();
  assert.equal(r.scrolls.length, 1);

  const desk = rig({ platform: 'desktop' });
  const detach = surface.attachKeyboardSurface(desk.scroller, desk.win, desk.doc);
  assert.equal(desk.scroller.count('touchend'), 0);
  assert.equal(desk.vv.count('resize'), 0);
  assert.doesNotThrow(detach);
});

test('a form that grows under the focused field with the keys up (a hint line) is revealed again', () => {
  const r = rig({ keysUp: true });
  let observe = null;
  const observed = [];
  r.win.ResizeObserver = class { constructor(cb) { observe = cb; } observe(el) { observed.push(el); } disconnect() { observed.length = 0; } };
  const content = { nodeType: 1 };
  r.scroller.children = [content];
  const detach = surface.attachKeyboardSurface(r.scroller, r.win, r.doc);
  assert.deepEqual(observed, [content], 'the scroller\'s content is watched for size');
  r.doc.activeElement = r.field;
  observe(); // "Say what it should do first." pushed Make it down
  r.flush();
  assert.equal(r.scrolls.length, 1);
  r.rootClasses.clear(); // keys down: a size change moves nothing
  observe();
  r.flush();
  assert.equal(r.scrolls.length, 1);
  detach();
  assert.equal(observed.length, 0);
});

test('a sheet rides the keys: one transform from where it was, the keys\' quarter second, none with reduced motion', () => {
  const r = rig();
  const detach = surface.attachKeyboardSurface(r.scroller, r.win, r.doc, { ride: true });
  r.tap();
  // The band moves the sheet's foot onto the keys in the viewport's event.
  r.scroller.offsetTop = 163;
  r.vv.fire('resize');
  assert.equal(r.animations.length, 1);
  assert.deepEqual(r.animations[0].keyframes, [{ translate: '0 337px' }, { translate: '0 0' }]);
  assert.deepEqual(r.animations[0].options, { duration: 250, easing: 'ease-out' });
  // The app resizes its web view: the window's resize, the same ride.
  assert.equal(r.win.count('resize'), 1);
  // The keys going down: where it was is read in the window's capture, before
  // the band drops in the document's.
  r.win.fire('focusout');
  r.scroller.offsetTop = 500;
  r.flush();
  assert.deepEqual(r.animations[1].keyframes, [{ translate: '0 -337px' }, { translate: '0 0' }]);
  detach();
  assert.equal(r.win.count('resize'), 0);
  assert.equal(r.win.count('focusout'), 0);

  const still = rig({ reduced: true });
  surface.attachKeyboardSurface(still.scroller, still.win, still.doc, { ride: true });
  still.tap();
  still.scroller.offsetTop = 163;
  still.vv.fire('resize');
  assert.equal(still.animations.length, 0);
});

// ── 4. app.css ──────────────────────────────────────────────────────────

test('app.css pads a surface into the band, puts a sheet\'s foot on it, and clears Safari\'s toolbar under the story', () => {
  const block = APP_CSS.slice(APP_CSS.indexOf('/* A FULL-SCREEN SURFACE KEEPS ITS FIELD AND ITS BUTTON ABOVE THE KEYS'));
  const rules = block.slice(block.indexOf('@media (max-width: 767px) {'), block.indexOf('\n}\n') + 2);
  assert.match(rules, /html\.platform-kb-open \.platform-kb-surface \{\s*padding-top: var\(--platform-vv-top, 0px\);\s*padding-bottom: var\(--platform-kb-cover, 0px\);\s*\}/);
  assert.match(rules, /html\.platform-kb-open \.platform-kb-sheet \{\s*bottom: var\(--platform-kb-cover, 0px\);\s*max-height: calc\(100% - var\(--platform-vv-top, 0px\) - var\(--platform-kb-cover, 0px\) - 12px\);/);
  // Nothing assumes a height for what iOS draws above the keys.
  assert.doesNotMatch(rules, /\b(44|48|50)px/);
  // The story's foot: Safari's toolbar is the large viewport less the small.
  assert.match(APP_CSS, /html\.un-ios\[data-browser-scroller="auth-landing-scroll"\] \[data-landing-story\] \{\s*padding-bottom: max\(0px, calc\(100lvh - 100svh\)\);\s*\}/);
  assert.match(read('frontend/src/features/auth/story.tsx'), /<div data-landing-story="" className=/);
  // #4593: with the keys down, the sheet's foot stands on the small viewport's
  // foot, clear of Safari's toolbar, and its height is capped to that
  // viewport; the keyboard rule above is more specific, so it still wins.
  const svh = APP_CSS.slice(APP_CSS.indexOf('/* THE SHEET\'S BUTTON CLEARS SAFARI\'S TOOLBAR WITH THE KEYS DOWN (#4593).'));
  assert.match(svh, /@media \(max-width: 767px\) \{\s*@supports \(height: 100svh\) \{\s*html \.platform-kb-sheet \{\s*bottom: max\(0px, calc\(100% - 100svh\)\);\s*max-height: 92svh;\s*\}/);
  // And the sign-in screen's foot, with the story switched off.
  assert.match(APP_CSS, /html\.un-ios\[data-browser-scroller="auth-login-screen"\] #auth-login-screen > \.min-h-full \{\s*padding-bottom: max\(0px, calc\(100lvh - 100svh\)\);\s*\}/);
});

// ── 5. The two screens ──────────────────────────────────────────────────

test('the make screen is a surface whose fields are the keyboard surface\'s, every focus without a scroll', () => {
  assert.match(MAKE, /export const MAKE_ROOT = 'platform-kb-surface fixed inset-0 z-\[9000\] flex flex-col /);
  // From Create, under the platform header (#4195), still a surface.
  assert.match(MAKE, /export const MAKE_ROOT_UNDER_HEADER = 'platform-kb-surface platform-under-header fixed inset-x-0 bottom-0 z-\[9000\] flex flex-col /);
  assert.match(MAKE, /className=\{underHeader \? MAKE_ROOT_UNDER_HEADER : MAKE_ROOT\}/);
  assert.match(MAKE, /useKeyboardSurface\(scrollerRef\);/);
  assert.doesNotMatch(MAKE, /\.focus\(\)/, 'no focus that lets iOS reveal on its own');
  // Make it is the form's submit button, so the reveal finds it.
  assert.match(MAKE, /<Button\s+type="submit"/);
});

test('the sign-in sheet\'s panel rides the keys as a sheet in the band, and every step focuses without a scroll', () => {
  assert.match(SHEET, /useKeyboardSurface\(panelRef, \{ ride: true \}\);/);
  assert.match(SHEET, /ref=\{panelRef\}\s+role="dialog"/);
  assert.match(SHEET, /className=\{`platform-kb-sheet absolute inset-x-0 bottom-0 /);
  assert.doesNotMatch(SHEET, /\.focus\(\)/);
  for (const step of ['sign-in-sheet-email', 'sign-in-sheet-code', 'sign-in-sheet-identifier', 'sign-in-sheet-password']) {
    const form = SHEET.slice(SHEET.lastIndexOf('<form', SHEET.indexOf(`id="${step}"`)), SHEET.indexOf('</form>', SHEET.indexOf(`id="${step}"`)));
    assert.match(form, /<button type="submit"/, `${step}'s form has the button the reveal brings with it`);
  }
});

// ── 6. Opening the sheet ────────────────────────────────────────────────

test('on a touch screen the sheet opens without a caret; it moves one only while the keys are already up', () => {
  const { mayFocusByCode } = loadTsx('frontend/src/features/auth/sign-in-sheet.tsx');
  assert.equal(mayFocusByCode({ touch: true, keysUp: false }), false, 'the tap raises the keys, after the sheet has arrived');
  assert.equal(mayFocusByCode({ touch: true, keysUp: true }), true, 'a hop with the keys up keeps them up');
  assert.equal(mayFocusByCode({ touch: false, keysUp: false }), true, 'a desktop gets its caret');
  assert.match(SHEET, /export function mayFocusByCodeNow\(\): boolean \{\s*return mayFocusByCode\(\{ touch: touchScreen\(\), keysUp: keyboardUp\(\) \}\);\s*\}/);
  assert.match(SHEET, /const focus = mayFocusByCodeNow\(\);/);
  assert.match(SHEET, /if \(focus\) field\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(SHEET, /if \(focus\) currentPasswordField\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(SHEET, /root\.contains\(KB_OPEN_CLASS\) \|\| root\.contains\('un-kb'\)/);
});

test('the page behind the sheet stays still, and the sheet is the platform\'s: plane colour, 20px, hairline, handle', () => {
  const html = renderComponent('frontend/src/features/auth/sign-in-sheet.tsx', 'SignInSheet', {
    open: true, title: 'Sign in', intro: 'Welcome back.', onClose() {}, primaryClass: 'pill',
  });
  const dim = /<div aria-hidden="true" class="([^"]*bg-black\/40[^"]*)"/.exec(html)[1];
  assert.match(dim, /\btouch-none\b/, 'a drag on the dim does not scroll the story (the kit backdrop\'s rule)');
  const panel = /<div role="dialog"[^>]*class="([^"]*)"/.exec(html)[1];
  assert.match(panel, /\boverscroll-contain\b/, 'the panel does not hand its scroll on to the page');
  assert.match(panel, /bg-\[color:var\(--dc-sheet-solid\)\]/, 'the plane colour, as the platform\'s sheets');
  assert.match(panel, /shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\]/, 'the sheets\' hairline');
  assert.match(panel, /rounded-t-\[20px\]/);
  assert.doesNotMatch(panel, /bg-zinc-100/, 'not the flat system grey');
  assert.match(html, /<div class="mx-auto h-1 w-9 rounded-full bg-\[color:var\(--border\)\] md:hidden" aria-hidden="true"><\/div>/,
    'the 36px handle in --border, as the workshop\'s sheets');
  // The fields are white cards with the same hairline, as on the make screen.
  assert.match(html, /class="overflow-hidden rounded-2xl bg-white shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\] dark:bg-zinc-900"/);
  // The PLANE_FILL literal lives once, in the primitive.
  assert.match(SHEET, /import \{ PLANE_FILL \} from '@\/components\/ui\/grouped-list';/);
});

// ── 7. Return walks the sheet's fields ─────────────────────────────────
// The Homeroom app is losing the keyboard's ‹ › bar (flutter-mobile-app
// #603): Return is the way from one field to the next. The account step
// used to submit from its username and fail on the empty password.

test('returnTarget: the next empty field, else the last; the last field submits', () => {
  const { returnTarget } = loadTsx('frontend/src/features/auth/sign-in-sheet.tsx');
  assert.equal(returnTarget(['', ''], 0), 1, 'username to password');
  assert.equal(returnTarget(['ada', ''], 1), null, 'the last field submits');
  assert.equal(returnTarget(['ada', '', ''], 0), 1);
  assert.equal(returnTarget(['ada', 'pw', ''], 0), 2, 'past a filled field to the empty one');
  assert.equal(returnTarget(['ada', 'pw', 'pw'], 0), 2, 'none empty: the last field, which submits on its own Return');
  assert.equal(returnTarget(['only'], 0), null, 'a one-field step submits');
});

test('the password and account steps walk on Return, and each field says what its Return does', () => {
  const { returnWalks } = loadTsx('frontend/src/features/auth/sign-in-sheet.tsx');
  const field = (value) => ({ value, focused: null, focus(opts) { this.focused = opts; } });
  const user = field('');
  const pass = field('');
  const confirm = field('');
  const refs = [{ current: user }, { current: pass }, { current: confirm }];
  const press = (target, extra = {}) => {
    const e = { key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, currentTarget: target, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    returnWalks(refs, refs.findIndex((r) => r.current === target))(e);
    return e;
  };
  const first = press(user);
  assert.equal(first.prevented, true, 'no submit from the username');
  assert.deepEqual(pass.focused, { preventScroll: true }, 'on to the password, without a scroll');
  pass.value = 'secret-1';
  press(pass);
  assert.deepEqual(confirm.focused, { preventScroll: true });
  assert.equal(press(confirm).prevented, false, 'the last field\'s Return submits the form');
  assert.equal(press(user, { shiftKey: true }).prevented, false, 'Shift+Return is left alone');
  assert.equal(press(user, { nativeEvent: { isComposing: true } }).prevented, false, 'so is an IME\'s Return');
  // No username asked for: the step's fields are the two passwords.
  const two = [{ current: null }, { current: pass }, { current: confirm }];
  pass.value = '';
  confirm.focused = null;
  const e = { key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, currentTarget: pass, preventDefault() { this.prevented = true; } };
  returnWalks(two, 1)(e);
  assert.deepEqual(confirm.focused, { preventScroll: true });

  // Wired: "next" on every field but each step's last, which says "go".
  assert.match(SHEET, /id="sign-in-sheet-identifier"[^>]*enterKeyHint="next" onKeyDown=\{returnWalks\(passwordStepFields, 0\)\}/);
  assert.match(SHEET, /id="sign-in-sheet-current-password"[^>]*enterKeyHint="go"/);
  assert.match(SHEET, /id="sign-in-sheet-username"[^>]*enterKeyHint="next" onKeyDown=\{returnWalks\(accountStepFields, 0\)\}/);
  assert.match(SHEET, /id="sign-in-sheet-password"[^>]*enterKeyHint="next" onKeyDown=\{returnWalks\(accountStepFields, 1\)\}/);
  assert.match(SHEET, /id="sign-in-sheet-confirm"[^>]*enterKeyHint="go"/);
  for (const id of ['sign-in-sheet-email', 'sign-in-sheet-code', 'sign-in-sheet-provider-username']) {
    assert.match(SHEET, new RegExp(`id="${id}"[^>]*enterKeyHint="go"`), `${id}: a one-field step's Return goes`);
  }
  assert.match(SHEET, /const passwordStepFields = \[identifierField, currentPasswordField\];/);
  assert.match(SHEET, /const accountStepFields = \[usernameField, passwordField, confirmField\];/);
});
