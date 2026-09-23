'use strict';
// #2765: in the installed phone app, Give feedback with the on-screen
// keyboard up was pressed against the top of the screen and only partly
// visible. The kit centres its modal in the strip above the keyboard but not
// in the part of the layout viewport that is ON SCREEN: iOS pans the visual
// viewport down to reveal the focused field, and a fixed box does not follow.
// frontend/src/lib/visual-viewport.ts publishes the pan as --platform-vv-top
// and app.css adds it to the modal's `top`.
//
// The geometry below is not a copy of the CSS: it EVALUATES the shipped
// declarations — app.css's `top`, native.css's `max-height` — with the
// keyboard inset computed by the kit's own `keyboardInset`, and checks the
// resulting card against the band the viewer can actually see.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP_CSS = read('public/css/app.css');
const NATIVE_CSS = read('public/usernode-native/v1/native.css');
const { physics } = require('../public/usernode-native/v1/native.js');
const { VV_TOP_PROP, visualViewportTop, initVisualViewportTop } =
  loadTsx('frontend/src/lib/visual-viewport.ts');

// ── A CSS length, evaluated ──────────────────────────────────────────────
//
// Just the grammar these declarations use: calc() and parentheses, + - * /,
// var() and env() with fallbacks, and px / % / vh / dvh. `%` is of the fixed
// containing block — the layout viewport — and so are vh and dvh: on iOS the
// on-screen keyboard changes neither, which is exactly why the kit subtracts
// its inset from 100dvh itself.
function evalCss(src, { vars = {}, env = {}, percent = 0, vh = 0 } = {}) {
  const s = src.trim();
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const peek = (t) => s.startsWith(t, i);
  const expect = (t) => {
    ws();
    if (!peek(t)) throw new Error(`expected "${t}" at ${i} in: ${s}`);
    i += t.length;
  };
  const ident = () => {
    ws();
    const m = /^[-\w]+/.exec(s.slice(i));
    if (!m) throw new Error(`expected a name at ${i} in: ${s}`);
    i += m[0].length;
    return m[0];
  };
  function factor() {
    ws();
    if (peek('calc(')) { i += 5; const v = sum(); expect(')'); return v; }
    if (peek('(')) { i += 1; const v = sum(); expect(')'); return v; }
    if (peek('var(') || peek('env(')) {
      const table = peek('var(') ? vars : env;
      i += 4;
      const name = ident();
      ws();
      let fallback;
      if (peek(',')) { i += 1; fallback = sum(); }
      expect(')');
      if (Object.prototype.hasOwnProperty.call(table, name)) return table[name];
      if (fallback === undefined) throw new Error(`${name} has no value and no fallback`);
      return fallback;
    }
    const m = /^(\d*\.?\d+)(px|%|dvh|vh)?/.exec(s.slice(i));
    if (!m) throw new Error(`unexpected "${s.slice(i, i + 16)}" in: ${s}`);
    i += m[0].length;
    const n = Number(m[1]);
    if (m[2] === '%') return (n / 100) * percent;
    if (m[2] === 'vh' || m[2] === 'dvh') return (n / 100) * vh;
    return n;
  }
  function product() {
    let v = factor();
    for (;;) {
      ws();
      if (peek('*')) { i += 1; v *= factor(); } else if (peek('/')) { i += 1; v /= factor(); } else return v;
    }
  }
  function sum() {
    let v = product();
    for (;;) {
      ws();
      if (peek('+')) { i += 1; v += product(); } else if (peek('-')) { i += 1; v -= product(); } else return v;
    }
  }
  const value = sum();
  ws();
  if (i !== s.length) throw new Error(`trailing "${s.slice(i)}" in: ${s}`);
  return value;
}

test('the evaluator reads the grammar the modal rules are written in', () => {
  assert.equal(evalCss('calc(var(--a, 0px) + 50% - var(--b, 0px) / 2)',
    { vars: { '--a': 10, '--b': 40 }, percent: 800 }), 390);
  assert.equal(evalCss('var(--missing, env(safe-area-inset-top, 7px))'), 7);
  assert.equal(evalCss('var(--x, calc(100dvh - 32px))', { vh: 812 }), 780);
  assert.throws(() => evalCss('var(--x)'), /no value and no fallback/);
});

// ── The declarations ─────────────────────────────────────────────────────

/** Every `\n<selector> {` rule body in a stylesheet. */
function rules(css, selector) {
  const out = [];
  const head = `\n${selector} {`;
  for (let at = css.indexOf(head); at >= 0; at = css.indexOf(head, at + 1)) {
    out.push(css.slice(at + head.length, css.indexOf('\n}', at + 1)));
  }
  return out;
}
/** The value a rule body gives a property — the LAST declaration wins. */
function declared(body, prop) {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`, 'g'))];
  assert.ok(all.length, `${prop} is declared`);
  return all[all.length - 1][1].trim();
}

const KIT_MODAL = rules(NATIVE_CSS, '.un-modal');
assert.equal(KIT_MODAL.length, 1, 'native.css has one .un-modal rule');
const KIT_TOP = declared(KIT_MODAL[0], 'top');
const KIT_MAX_HEIGHT = declared(KIT_MODAL[0], 'max-height');
const SHELL_TOPS = rules(APP_CSS, '.un-modal').filter((body) => /(^|\s)top:/.test(body));
const SHELL_TOP = SHELL_TOPS.length === 1 ? declared(SHELL_TOPS[0], 'top') : null;

test('the shell repositions the kit modal in exactly one rule, with the pan added', () => {
  assert.equal(SHELL_TOPS.length, 1, 'one app.css .un-modal rule sets top');
  assert.equal(SHELL_TOP, 'calc(var(--platform-vv-top, 0px) + 50% - var(--un-kb-inset, 0px) / 2)');
  // It restates the kit's centre with one term added, so where the pan is 0
  // it is the kit's own formula — asserted numerically below as well.
  assert.equal(KIT_TOP, 'calc(50% - var(--un-kb-inset, 0px) / 2)');
});

test('the kit rule the geometry relies on: centred on `top`, capped by the strip, scrolling', () => {
  // `top` is the CENTRE only because the card is translated back by half.
  assert.match(KIT_MODAL[0], /transform: translate\(-50%, -50%\) scale\(1\.04\);/);
  // The cap is the visual viewport's height less margins: 100dvh with the
  // inset taken off, which is what makes the band the only term missing.
  assert.match(KIT_MAX_HEIGHT, /100dvh/);
  assert.match(KIT_MAX_HEIGHT, /var\(--un-kb-inset, 0px\)/);
  // …and what does not fit scrolls, which is what keeps Submit reachable.
  assert.match(KIT_MODAL[0], /overflow-y: auto;/);
});

// ── The card against the screen ──────────────────────────────────────────

/** Where the shipped CSS puts a modal whose content is `content` px tall. */
function place({ layout, vvHeight, offsetTop, scale = 1, safeTop = 0, safeBottom = 0, content }, topRule = SHELL_TOP) {
  const kb = physics.keyboardInset({ layoutHeight: layout, vvHeight, vvScale: scale });
  const vars = {
    '--un-kb-inset': kb,
    '--platform-vv-top': visualViewportTop({ offsetTop, scale }),
    '--un-safe-inset-top': safeTop,
    '--un-safe-inset-bottom': safeBottom,
  };
  const centre = evalCss(topRule, { vars, percent: layout, vh: layout });
  const cap = evalCss(KIT_MAX_HEIGHT, { vars, percent: layout, vh: layout });
  const height = Math.min(content, cap);
  return { top: centre - height / 2, bottom: centre + height / 2, height, cap, kb };
}
/** What is on screen, in the layout viewport's coordinates. */
const bandOf = ({ vvHeight, offsetTop }) => ({ top: offsetTop, bottom: offsetTop + vvHeight });
const inside = (card, band) => card.top >= band.top && card.bottom <= band.bottom;

// The kit's own measurements with the keyboard up (native.js keyboardInset,
// #1938) — the numbers every keyboard decision in this repo is argued from.
const IOS_STANDALONE = { layout: 812, vvHeight: 409, offsetTop: 403 };
const IOS_SAFARI = { layout: 714, vvHeight: 377, offsetTop: 337 };
const ANDROID = { layout: 810, vvHeight: 498, offsetTop: 0 };
// Give feedback's card as drawn at 390px, measured in Chromium: 477px tall.
const FEEDBACK = 477;

test('iOS, installed: the feedback dialog is inside the visible band and clear of the status bar', () => {
  const frame = { ...IOS_STANDALONE, safeTop: 59, safeBottom: 34, content: FEEDBACK };
  const card = place(frame);
  const band = bandOf(frame);
  assert.ok(inside(card, band), `card ${card.top}–${card.bottom} within ${band.top}–${band.bottom}`);
  // The status bar is drawn over the top of the visible band.
  assert.ok(card.top >= band.top + frame.safeTop, 'the heading is not under the status bar');
  // It had to shrink to fit, so its own content scrolls.
  assert.ok(card.height < FEEDBACK && card.height === card.cap);
});

test('the kit on its own puts that same dialog above the screen — the report', () => {
  const frame = { ...IOS_STANDALONE, safeTop: 59, safeBottom: 34, content: FEEDBACK };
  const card = place(frame, KIT_TOP);
  const band = bandOf(frame);
  assert.ok(card.bottom <= band.top, `kit card ${card.top}–${card.bottom}, band from ${band.top}`);
});

test('iOS Safari, measured: inside the band', () => {
  const frame = { ...IOS_SAFARI, content: FEEDBACK };
  assert.ok(inside(place(frame), bandOf(frame)));
});

test('every pan iOS can make keeps the card on screen, short card or tall', () => {
  // The same 403px keyboard on a 390x844 phone, a 304px one on a 667px
  // iPhone SE, and a 200px one on a phone held sideways. The pan is anywhere
  // from none to all of the keyboard, depending on where the focused field was.
  for (const [layout, keyboard] of [[844, 403], [667, 304], [390, 200]]) {
    const vvHeight = layout - keyboard;
    for (const content of [180, FEEDBACK, 1200]) {
      for (let offsetTop = 0; offsetTop <= keyboard; offsetTop += 1) {
        const frame = { layout, vvHeight, offsetTop, content };
        const card = place(frame);
        assert.ok(inside(card, bandOf(frame)),
          `${layout}px layout, content ${content} at pan ${offsetTop}: ${card.top}–${card.bottom}`);
      }
    }
  }
});

test('where nothing pans the kit\'s placement is unchanged: Android, no keyboard', () => {
  for (const frame of [
    { ...ANDROID, content: FEEDBACK },
    { layout: 844, vvHeight: 844, offsetTop: 0, content: FEEDBACK },
  ]) {
    assert.deepEqual(place(frame), place(frame, KIT_TOP));
    assert.ok(inside(place(frame), bandOf(frame)));
  }
});

test('pinch zoom is not a keyboard: the offset is ignored and the kit decides', () => {
  const frame = { layout: 844, vvHeight: 422, offsetTop: 300, scale: 2, content: FEEDBACK };
  assert.equal(visualViewportTop(frame), 0);
  assert.deepEqual(place(frame), place(frame, KIT_TOP));
});

// ── The offset ───────────────────────────────────────────────────────────

test('visualViewportTop: the pan in whole px, 0 for anything that is not one', () => {
  assert.equal(visualViewportTop({ offsetTop: 403, scale: 1 }), 403);
  assert.equal(visualViewportTop({ offsetTop: 69.4, scale: 1 }), 69);
  assert.equal(visualViewportTop({ offsetTop: 0, scale: 1 }), 0);
  assert.equal(visualViewportTop({ offsetTop: -12, scale: 1 }), 0, 'an overscroll bounce is not a pan');
  assert.equal(visualViewportTop({ offsetTop: 200, scale: 1.5 }), 0, 'zoomed');
  assert.equal(visualViewportTop({ offsetTop: 200, scale: 1.005 }), 200, 'rounding noise is still scale 1');
  assert.equal(visualViewportTop({ offsetTop: Number.NaN, scale: 1 }), 0);
  assert.equal(visualViewportTop(null), 0);
  assert.equal(visualViewportTop(undefined), 0);
});

// ── The tracker ──────────────────────────────────────────────────────────

function fakes(vv) {
  const props = {};
  const writes = [];
  const frames = [];
  const listeners = {};
  const doc = { documentElement: { style: { setProperty: (k, v) => { props[k] = v; writes.push([k, v]); } } } };
  const viewport = vv && Object.assign(vv, {
    addEventListener: (type, fn, opts) => { listeners[type] = { fn, opts }; },
  });
  const win = {
    visualViewport: viewport,
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
  };
  const flush = () => { while (frames.length) frames.shift()(); };
  const fire = (type) => listeners[type].fn();
  return { doc, win, props, writes, frames, listeners, flush, fire };
}

test('the tracker follows resize and scroll, passively, like the kit\'s', () => {
  const vv = { offsetTop: 0, scale: 1 };
  const t = fakes(vv);
  initVisualViewportTop(t.doc, t.win);
  assert.deepEqual(Object.keys(t.listeners).sort(), ['resize', 'scroll']);
  assert.equal(t.listeners.resize.opts.passive, true);
  assert.equal(t.listeners.scroll.opts.passive, true);
  assert.deepEqual(t.writes, [], 'nothing panned, nothing written: the stylesheet falls back to 0px');
});

test('a burst of viewport events is one frame and one write', () => {
  const vv = { offsetTop: 0, scale: 1 };
  const t = fakes(vv);
  initVisualViewportTop(t.doc, t.win);
  vv.offsetTop = 403;
  t.fire('resize'); t.fire('scroll'); t.fire('scroll');
  assert.equal(t.frames.length, 1, 'coalesced into one animation frame');
  t.flush();
  assert.deepEqual(t.writes, [[VV_TOP_PROP, '403px']]);
  t.fire('scroll'); t.flush();
  assert.equal(t.writes.length, 1, 'an unchanged pan is not rewritten on every scroll');
});

test('the pan going away is written back, so the dialog does not stay shifted', () => {
  const vv = { offsetTop: 120, scale: 1 };
  const t = fakes(vv);
  initVisualViewportTop(t.doc, t.win);
  assert.equal(t.props[VV_TOP_PROP], '120px', 'a load that starts panned is published at once');
  vv.offsetTop = 0;
  t.fire('resize'); t.flush();
  assert.equal(t.props[VV_TOP_PROP], '0px');
  vv.offsetTop = 250; vv.scale = 2;
  t.fire('resize'); t.flush();
  assert.equal(t.props[VV_TOP_PROP], '0px', 'zooming in is still no pan');
});

test('no visual viewport, no listeners and no writes', () => {
  const t = fakes(null);
  const apply = initVisualViewportTop(t.doc, t.win);
  apply();
  assert.deepEqual(t.writes, []);
  assert.deepEqual(t.frames, []);
});

// ── Wiring ───────────────────────────────────────────────────────────────

test('the shell entry loads the tracker, and the stylesheet only reads its property', () => {
  assert.match(read('frontend/src/main.tsx'), /^import '\.\/lib\/visual-viewport';$/m);
  assert.equal(VV_TOP_PROP, '--platform-vv-top');
  // The value lives on <html> as an inline style, beside the kit's
  // --un-kb-inset. A stylesheet declaration would sit between them and win.
  assert.doesNotMatch(APP_CSS, /--platform-vv-top\s*:/, 'no stylesheet rule may set --platform-vv-top');
  assert.doesNotMatch(NATIVE_CSS, /--platform-vv-top/, 'the centrally hosted kit is not changed');
});
