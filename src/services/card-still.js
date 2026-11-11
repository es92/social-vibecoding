'use strict';

// A project's card still: the picture on its card in Discover, Home's
// Communities and the signed-out landing that shows the project BEING USED
// (what goes in, what comes out), rather than an object that only names its
// topic.
//
// A still is the app's own screen, never a drawing of it. This module takes
// a real screenshot, crops it to the part that matters (`focus`), scales it
// onto a 16:10 canvas the card's own shape, and lays it over the card's
// colour as a rounded panel with a soft shadow: a light still and its dark
// twin. Every pixel of the panel is the screenshot's, resampled; nothing in
// it passes through an image model, so the app's words are its real words.
//
// The image model's part is optional and kept apart (bot-pictures.js
// makeCardStill): it may draw a scene AROUND the panel ("the moment of
// use": hands, a desk, a soft room) from words alone, and that scene is the
// background here. The model is never sent the screenshot.
//
// The card draws a still whole (frontend/src/features/guest/guest-discover
// .tsx CardCover): the canvas is the card's own 16:10, so `object-cover`
// crops nothing, and the panel keeps a margin on every side so the card's
// corner pills sit on the colour rather than on the screen.
//
// Pure: PNG in, PNG out (pngjs). JPEG and WebP screenshots are refused with
// a reason; a browser re-encodes one to PNG for free.

const { PNG } = require('pngjs');
const { sniffImageType } = require('./attachments');

/** The still's size: the card's 16:10 at 2× a wide card, under the card picture limit. */
const WIDTH = 1280;
const HEIGHT = 800;
const ASPECT = WIDTH / HEIGHT;
/** Smaller sizes tried, in order, when a still does not fit under maxBytes. */
const FALLBACK_WIDTHS = Object.freeze([960, 800, 640]);
/**
 * How far from 16:10 an image may be and still be a still (0.5%): close
 * enough that a card drawing it whole leaves no gap a person could see.
 */
const ASPECT_TOLERANCE = 0.005;
/** The smallest still a card takes: anything less is blurry at 2×. */
const MIN_STILL_WIDTH = 640;
/** A card picture's byte limit (routes/app-illustrations.js validateImage). */
const MAX_BYTES = 1024 * 1024;
/** The largest screenshot read: a 4K screen, and no more pixels than that. */
const MAX_SCREENSHOT_SIDE = 4096;
const MAX_SCREENSHOT_PIXELS = 4096 * 2560;
/** The smallest focus region, as a fraction of the screenshot's side. */
const MIN_FOCUS = 0.08;

// The card colours, as the editor offers them (routes/app-illustrations.js
// TONES; their `--tone-50` in public/css/app.css `.home-tone-*`).
const TONE_HEX = Object.freeze({
  cream: '#fefdf5',
  yellow: '#fff9de',
  orange: '#fff0e0',
  coral: '#fde8e4',
  pink: '#f8e4ee',
  purple: '#ede4f4',
  indigo: '#e4e8f6',
  blue: '#deedf8',
  teal: '#deeeed',
  mint: '#e2f2e8',
  sage: '#eaf2e4',
  gray: '#f4f3f1',
});
// The dark card's ground, the same one `--tone-dark-art` mixes into.
const DARK_GROUND = Object.freeze([11, 11, 12]);
const WHITE = Object.freeze([255, 255, 255]);

// The panel: how much of the canvas it may take, its corners and its edge.
const LAYOUT = Object.freeze({
  plain: Object.freeze({ width: 0.86, height: 0.82 }),
  // With a scene around it the panel leaves the scene room to show.
  scene: Object.freeze({ width: 0.7, height: 0.72 }),
  radius: 0.025,
  shadow: Object.freeze({ dy: 0.011, blur: 0.03, light: 0.16, dark: 0.5 }),
  ring: Object.freeze({ width: 0.0016, light: [0, 0, 0, 0.1], dark: [255, 255, 255, 0.14] }),
});

class CardStillError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CardStillError';
    this.code = code;
  }
}

// ── Colour ───────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

/**
 * Pure: the colour a still is laid on, light and dark: the card colour its
 * author picked (`tone`, one of TONE_HEX), else a pale wash of the project's
 * own colour (`color`, dapp.json's icon colour), else the grey tone.
 */
function backdrop({ tone = null, color = null } = {}) {
  if (tone && TONE_HEX[tone]) {
    const base = hexToRgb(TONE_HEX[tone]);
    return { light: base, dark: mix(DARK_GROUND, base, 0.14) };
  }
  const own = hexToRgb(color);
  if (own) return { light: mix(WHITE, own, 0.22), dark: mix(DARK_GROUND, own, 0.22) };
  const gray = hexToRgb(TONE_HEX.gray);
  return { light: gray, dark: mix(DARK_GROUND, gray, 0.14) };
}

// ── Shape ────────────────────────────────────────────────────────────────

/** Pure: whether a picture this size is a still (16:10, big enough for 2×). */
function isStillSize(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < MIN_STILL_WIDTH || h <= 0) return false;
  return Math.abs((w / h) / ASPECT - 1) <= ASPECT_TOLERANCE;
}

// ── Reading a screenshot ─────────────────────────────────────────────────

/** A PNG's pixels: { width, height, data } (RGBA). Throws CardStillError. */
function decodePng(data, what = 'screenshot') {
  if (!Buffer.isBuffer(data) || !data.length) throw new CardStillError('empty', `The ${what} is empty.`);
  const type = sniffImageType(data);
  if (type !== 'image/png') {
    throw new CardStillError('png_only', `The ${what} must be a PNG${type ? ` (this one is ${type.replace('image/', '').toUpperCase()})` : ''}.`);
  }
  // The header's size first, so a huge image is refused before it is inflated.
  if (data.length >= 24) {
    const w = data.readUInt32BE(16);
    const h = data.readUInt32BE(20);
    if (w > MAX_SCREENSHOT_SIDE || h > MAX_SCREENSHOT_SIDE || w * h > MAX_SCREENSHOT_PIXELS) {
      throw new CardStillError('too_big', `The ${what} is ${w}×${h}; send one no bigger than a 4K screen.`);
    }
  }
  try {
    const png = PNG.sync.read(data);
    return { width: png.width, height: png.height, data: png.data };
  } catch {
    throw new CardStillError('unreadable', `The ${what} could not be read as a PNG.`);
  }
}

/**
 * Pure: the part of a `width` × `height` screenshot to show, in whole pixels,
 * from `focus` ({ x, y, width, height }, each 0..1 of the screenshot). The
 * whole screenshot when `focus` is absent; never smaller than MIN_FOCUS of a
 * side, never outside the screenshot.
 */
function focusBox(focus, width, height) {
  const whole = { x: 0, y: 0, width, height };
  if (!focus || typeof focus !== 'object') return whole;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  let fw = Math.min(1, Math.max(MIN_FOCUS, num(focus.width, 1)));
  let fh = Math.min(1, Math.max(MIN_FOCUS, num(focus.height, 1)));
  const fx = Math.min(1 - fw, Math.max(0, num(focus.x, 0)));
  const fy = Math.min(1 - fh, Math.max(0, num(focus.y, 0)));
  const x = Math.round(fx * width);
  const y = Math.round(fy * height);
  fw = Math.max(1, Math.min(width - x, Math.round(fw * width)));
  fh = Math.max(1, Math.min(height - y, Math.round(fh * height)));
  return { x, y, width: fw, height: fh };
}

// ── Resampling ───────────────────────────────────────────────────────────

/**
 * One axis's taps for a resample from `src` pixels to `dst`: for each output
 * pixel, the source indices and their weights (a tent as wide as the scale,
 * so a downscale averages what it drops and an upscale interpolates).
 */
function taps(src, dst, offset = 0) {
  const scale = src / dst;
  const support = Math.max(1, scale);
  const out = new Array(dst);
  for (let i = 0; i < dst; i += 1) {
    const centre = (i + 0.5) * scale - 0.5;
    const lo = Math.max(0, Math.floor(centre - support));
    const hi = Math.min(src - 1, Math.ceil(centre + support));
    const idx = [];
    const w = [];
    let sum = 0;
    for (let s = lo; s <= hi; s += 1) {
      const weight = Math.max(0, 1 - Math.abs(s - centre) / support);
      if (weight > 0) { idx.push(s + offset); w.push(weight); sum += weight; }
    }
    if (!sum) { idx.push(Math.min(src - 1, Math.max(0, Math.round(centre))) + offset); w.push(1); sum = 1; }
    out[i] = { idx, w: w.map((x) => x / sum) };
  }
  return out;
}

/**
 * Pure: the `box` of an RGBA `image` resampled to `dw` × `dh`, premultiplied
 * so a transparent edge does not darken. Resolves a Float32Array of RGBA,
 * alpha 0..1, colour premultiplied.
 */
function resample(image, box, dw, dh) {
  const { width: sw, data } = image;
  const xt = taps(box.width, dw, box.x);
  const yt = taps(box.height, dh, box.y);
  // Horizontal pass over just the rows the vertical pass reads.
  const rows = new Map();
  const row = (sy) => {
    let r = rows.get(sy);
    if (r) return r;
    r = new Float32Array(dw * 4);
    for (let x = 0; x < dw; x += 1) {
      const { idx, w } = xt[x];
      let pr = 0; let pg = 0; let pb = 0; let pa = 0;
      for (let k = 0; k < idx.length; k += 1) {
        const o = (sy * sw + idx[k]) * 4;
        const a = (data[o + 3] / 255) * w[k];
        pr += data[o] * a; pg += data[o + 1] * a; pb += data[o + 2] * a; pa += a;
      }
      r[x * 4] = pr; r[x * 4 + 1] = pg; r[x * 4 + 2] = pb; r[x * 4 + 3] = pa;
    }
    rows.set(sy, r);
    return r;
  };
  const out = new Float32Array(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const { idx, w } = yt[y];
    const o = y * dw * 4;
    for (let k = 0; k < idx.length; k += 1) {
      const r = row(idx[k]);
      const wk = w[k];
      for (let i = 0; i < dw * 4; i += 1) out[o + i] += r[i] * wk;
    }
    // Rows above the next output row's taps are never read again.
    for (const key of rows.keys()) if (key < (yt[y + 1]?.idx[0] ?? Infinity)) rows.delete(key);
  }
  return out;
}

// ── Drawing ──────────────────────────────────────────────────────────────

/** Signed distance from a point to a rounded rectangle centred on 0 (negative inside). */
function roundRectDistance(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, v) => { const t = clamp01((v - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/**
 * Pure: the panel's rectangle on a `width` × `height` canvas for a crop of
 * `cropW` × `cropH`: as large as the layout allows, centred, the crop's own
 * aspect kept, so nothing of the screenshot is cut or stretched.
 */
function panelRect(width, height, cropW, cropH, withScene = false) {
  const room = withScene ? LAYOUT.scene : LAYOUT.plain;
  const maxW = width * room.width;
  const maxH = height * room.height;
  const scale = Math.min(maxW / cropW, maxH / cropH);
  const w = Math.max(1, Math.round(cropW * scale));
  const h = Math.max(1, Math.round(cropH * scale));
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h };
}

/**
 * Pure: draw one still: the ground (a scene, or the colour lit from the top
 * left), the panel's shadow, the screenshot's `box` in the panel, and a
 * hairline round it. Resolves the RGB bytes of a `width` × `height` image.
 */
function drawStill({ shot, box, theme, ground, scene = null, width = WIDTH, height = HEIGHT }) {
  const dark = theme === 'dark';
  const rgb = Buffer.alloc(width * height * 3);
  // 1. The ground.
  if (scene) {
    // Cover-fit: the scene fills the canvas, centred, its overflow cut.
    const s = Math.max(width / scene.width, height / scene.height);
    const cw = Math.min(scene.width, Math.round(width / s));
    const ch = Math.min(scene.height, Math.round(height / s));
    const px = resample(scene, { x: Math.floor((scene.width - cw) / 2), y: Math.floor((scene.height - ch) / 2), width: cw, height: ch }, width, height);
    for (let i = 0, j = 0; i < width * height; i += 1, j += 4) {
      const a = px[j + 3];
      // A transparent scene shows the colour through it.
      rgb[i * 3] = Math.round(px[j] + ground[0] * (1 - a));
      rgb[i * 3 + 1] = Math.round(px[j + 1] + ground[1] * (1 - a));
      rgb[i * 3 + 2] = Math.round(px[j + 2] + ground[2] * (1 - a));
    }
  } else {
    const lit = dark ? 0.05 : 0.32;
    const reach = width * 1.1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const d = Math.hypot(x - width * 0.18, y - height * 0.08) / reach;
        const t = lit * (1 - smooth(0, 1, d));
        const o = (y * width + x) * 3;
        rgb[o] = Math.round(ground[0] + (255 - ground[0]) * t);
        rgb[o + 1] = Math.round(ground[1] + (255 - ground[1]) * t);
        rgb[o + 2] = Math.round(ground[2] + (255 - ground[2]) * t);
      }
    }
  }
  // 2. The panel, its shadow and its edge.
  const panel = panelRect(width, height, box.width, box.height, !!scene);
  const pixels = resample(shot, box, panel.width, panel.height);
  const radius = Math.min(width * LAYOUT.radius, panel.width / 2, panel.height / 2);
  const hw = panel.width / 2;
  const hh = panel.height / 2;
  const cx = panel.x + hw;
  const cy = panel.y + hh;
  const dy = width * LAYOUT.shadow.dy;
  const blur = width * LAYOUT.shadow.blur;
  const shadowA = dark ? LAYOUT.shadow.dark : LAYOUT.shadow.light;
  const ring = dark ? LAYOUT.ring.dark : LAYOUT.ring.light;
  const ringW = Math.max(1, width * LAYOUT.ring.width);
  const pad = Math.ceil(blur * 1.5 + dy);
  const x0 = Math.max(0, panel.x - pad);
  const x1 = Math.min(width, panel.x + panel.width + pad);
  const y0 = Math.max(0, panel.y - pad);
  const y1 = Math.min(height, panel.y + panel.height + pad);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * width + x) * 3;
      let r = rgb[o]; let g = rgb[o + 1]; let b = rgb[o + 2];
      // The shadow, a little below the panel, falling off over `blur`.
      const sd = roundRectDistance(x + 0.5 - cx, y + 0.5 - (cy + dy), hw, hh, radius);
      const sa = shadowA * (1 - smooth(-blur * 0.35, blur, sd));
      if (sa > 0) { r *= 1 - sa; g *= 1 - sa; b *= 1 - sa; }
      // The panel: the screenshot's own pixels, antialiased at the corners.
      const d = roundRectDistance(x + 0.5 - cx, y + 0.5 - cy, hw, hh, radius);
      const cover = clamp01(0.5 - d);
      if (cover > 0) {
        const px = x - panel.x;
        const py = y - panel.y;
        if (px >= 0 && py >= 0 && px < panel.width && py < panel.height) {
          const j = (py * panel.width + px) * 4;
          const a = pixels[j + 3];
          // A transparent screenshot pixel shows white (light) or the dark
          // card (dark) through it, as the app's own page would.
          const under = dark ? 18 : 255;
          const sr = pixels[j] + under * (1 - a);
          const sg = pixels[j + 1] + under * (1 - a);
          const sb = pixels[j + 2] + under * (1 - a);
          r = r * (1 - cover) + sr * cover;
          g = g * (1 - cover) + sg * cover;
          b = b * (1 - cover) + sb * cover;
        }
        // The hairline, inside the panel's edge.
        const edge = (cover - clamp01(0.5 - (d + ringW))) * ring[3];
        if (edge > 0) {
          r = r * (1 - edge) + ring[0] * edge;
          g = g * (1 - edge) + ring[1] * edge;
          b = b * (1 - edge) + ring[2] * edge;
        }
      }
      rgb[o] = Math.round(r); rgb[o + 1] = Math.round(g); rgb[o + 2] = Math.round(b);
    }
  }
  return { rgb, panel };
}

/** An RGB image as a PNG (no alpha: a still is opaque). */
function encodeRgb(rgb, width, height) {
  return PNG.sync.write({ width, height, data: rgb, gamma: 0 },
    { colorType: 2, inputColorType: 2, inputHasAlpha: false, deflateLevel: 9 });
}

/**
 * One still of a screenshot, in one theme: { contentType, data, width,
 * height, panel } where `panel` is where the screenshot sits on it. Tried at
 * WIDTH, then smaller until it is under `maxBytes`. Throws CardStillError.
 */
function composeStill({ screenshot, focus = null, theme = 'light', ground, scene = null, maxBytes = MAX_BYTES }) {
  const shot = screenshot && screenshot.data && Number.isInteger(screenshot.width) ? screenshot : decodePng(screenshot);
  const box = focusBox(focus, shot.width, shot.height);
  for (const width of [WIDTH, ...FALLBACK_WIDTHS]) {
    const height = Math.round(width / ASPECT);
    const { rgb, panel } = drawStill({ shot, box, theme, ground, scene, width, height });
    const data = encodeRgb(rgb, width, height);
    if (data.length <= maxBytes) return { contentType: 'image/png', data, width, height, panel };
  }
  throw new CardStillError('too_large', 'The still could not be made small enough for a card picture (under 1 MB).');
}

/**
 * A still and its dark twin from one screenshot (and, when there is one, a
 * dark-theme screenshot of the same screen for the twin): { light, dark },
 * each composeStill's. `scenes` ({ light, dark }, decoded or PNG bytes) is
 * the model's ground when there is one. Throws CardStillError.
 */
function composePair({ screenshot, darkScreenshot = null, focus = null, tone = null, color = null, scenes = null, maxBytes = MAX_BYTES }) {
  const ground = backdrop({ tone, color });
  const shot = decodePng(screenshot);
  const darkShot = darkScreenshot ? decodePng(darkScreenshot, 'dark screenshot') : shot;
  const scene = (value, what) => {
    if (!value) return null;
    if (value.data && Number.isInteger(value.width)) return value;
    try { return decodePng(value, what); } catch { return null; }
  };
  const lightScene = scene(scenes?.light, 'scene');
  const darkScene = scene(scenes?.dark, 'dark scene');
  return {
    light: composeStill({ screenshot: shot, focus, theme: 'light', ground: ground.light, scene: lightScene, maxBytes }),
    dark: composeStill({ screenshot: darkShot, focus, theme: 'dark', ground: ground.dark, scene: darkScene, maxBytes }),
  };
}

// ── Off the request thread ───────────────────────────────────────────────

/** How long a pair may take in its worker before it is given up on. */
const WORKER_TIMEOUT_MS = 30_000;

/**
 * composePair, in a worker thread: a pair is about a second of pixel work,
 * which on the platform's own thread would stall every other request for
 * that long. Resolves what composePair returns; rejects with its
 * CardStillError (code kept) or a `failed` one.
 */
function composePairAsync(args, { timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  const { Worker } = require('node:worker_threads');
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(__filename, { workerData: { cardStillPair: args } });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new CardStillError('timeout', 'The still took too long to make.')), timeoutMs);
    worker.once('message', (msg) => {
      if (msg && msg.error) return finish(reject, new CardStillError(msg.error.code || 'failed', msg.error.message || 'The still could not be made.'));
      const back = (side) => ({ ...side, data: Buffer.from(side.data) });
      return finish(resolve, { light: back(msg.light), dark: back(msg.dark) });
    });
    worker.once('error', (err) => finish(reject, new CardStillError('failed', err.message || 'The still could not be made.')));
    worker.once('exit', (code) => finish(reject, new CardStillError('failed', `The still's worker stopped (${code}).`)));
  });
}

// This file is also composePairAsync's worker.
{
  const threads = require('node:worker_threads');
  if (!threads.isMainThread && threads.workerData && threads.workerData.cardStillPair) {
    const args = threads.workerData.cardStillPair;
    const buf = (v) => (v && !Buffer.isBuffer(v) && v.buffer ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
    try {
      const scenes = args.scenes ? { light: buf(args.scenes.light), dark: buf(args.scenes.dark) } : null;
      const pair = composePair({ ...args, screenshot: buf(args.screenshot), darkScreenshot: buf(args.darkScreenshot), scenes });
      threads.parentPort.postMessage(pair);
    } catch (err) {
      threads.parentPort.postMessage({ error: { code: err.code || 'failed', message: err.message } });
    }
  }
}

module.exports = {
  WIDTH,
  HEIGHT,
  ASPECT,
  MAX_BYTES,
  MIN_STILL_WIDTH,
  TONE_HEX,
  LAYOUT,
  CardStillError,
  backdrop,
  isStillSize,
  decodePng,
  focusBox,
  resample,
  panelRect,
  drawStill,
  composeStill,
  composePair,
  composePairAsync,
};
