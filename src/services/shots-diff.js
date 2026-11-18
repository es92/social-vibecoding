'use strict';

// Where a change's before and after screens differ, worked out once when a
// run saves its shots so the card can outline it on both sides.
//
// The screens are compared row by row first, the way a text diff compares
// lines, so content that only moved (a sheet that grew upward and pushed
// everything in it up) lines up instead of counting as changed. Runs of rows
// that do not line up are then compared pixel by pixel to find how wide each
// change is. Each area is tied to the declared change whose element shot sits
// inside it; anything else that differs is kept as an undeclared area.
//
// Pure apart from PNG decoding. Everything it returns is integers and story
// ids from the run's own declaration, in the screen's CSS pixels: a still
// saved at its device's density (3 on a phone, 2 on a desktop) is averaged
// down to one pixel per CSS pixel first, so the areas, widths and heights
// mean the same whatever the density, and each screen says its `density`
// for the cards that zoom into it.

const { PNG } = require('pngjs');
const { densityFor } = require('./shots-files');

// Compared pixels, after averaging down to CSS pixels.
const MAX_PIXELS = 1920 * 1440;
const MAX_REGIONS = 12;
// A crop with too many plausible placements is ambiguous. Bound both the
// pixel work and retained placements instead of spending minutes scoring
// every patch of a repetitive screen (and searching an ever-growing list).
const MAX_LOCATE_CHECKS = 8_000_000;
const MAX_LOCATE_MATCHES = 128;
// Two channels closer than this are the same colour: antialiasing and image
// compression move a pixel a little, a change moves it a lot.
const TOLERANCE = 28;
// Equal rows this close together inside a change do not split it (the
// identical middle row of a button, say).
const JOIN_ROWS = 6;
// An element shot covering at most this share of its screen still widens the
// box it overlaps; a bigger one is the agent photographing a whole dialog or
// sheet, and taking it in would outline the panel instead of the change.
const FOCUS_MAX_SHARE = 0.5;

// Width and height off the PNG's header, read before anything is inflated
// (shots-files.inspectImage checked the header when the shot was saved).
function pngSize(buffer) {
  return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
}

// One pixel per `density` x `density` block: their average.
function averageDown(png, density) {
  const w = Math.floor(png.width / density);
  const h = Math.floor(png.height / density);
  const d = Buffer.alloc(w * h * 4);
  const n = density * density;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let dy = 0; dy < density; dy += 1) {
        let i = ((y * density + dy) * png.width + x * density) * 4;
        for (let dx = 0; dx < density; dx += 1, i += 4) {
          r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; a += png.data[i + 3];
        }
      }
      const o = (y * w + x) * 4;
      d[o] = Math.round(r / n); d[o + 1] = Math.round(g / n); d[o + 2] = Math.round(b / n); d[o + 3] = Math.round(a / n);
    }
  }
  return { w, h, d };
}

// A still's pixels at one per CSS pixel. `density` is how many device
// pixels it holds per CSS pixel (shots-files.densityFor).
function decode(buffer, density = 1) {
  const k = Number.isInteger(density) && density > 1 ? density : 1;
  const size = pngSize(buffer);
  if (Math.floor(size.w / k) * Math.floor(size.h / k) > MAX_PIXELS) throw new Error('screen too large to compare');
  const png = PNG.sync.read(buffer);
  return k === 1 ? { w: png.width, h: png.height, d: png.data } : averageDown(png, k);
}

// A still saved at `density` device pixels per CSS pixel, as the 1x PNG
// everyone outside the density experiment is shown (services/shots-density.js):
// each block averaged, as `decode` does, then written back as a PNG.
function flatten(buffer, density) {
  const px = decode(buffer, density);
  const png = new PNG({ width: px.w, height: px.h });
  png.data = Buffer.from(px.d.buffer, px.d.byteOffset, px.d.length);
  return PNG.sync.write(png);
}

// One hash per row, with the low bits of each channel dropped so that noise
// does not split rows that look the same.
function rowHashes(px) {
  const out = new Uint32Array(px.h);
  for (let y = 0; y < px.h; y += 1) {
    let h = 2166136261;
    const base = y * px.w * 4;
    for (let x = 0; x < px.w; x += 1) {
      const i = base + x * 4;
      h ^= (px.d[i] >> 3) | ((px.d[i + 1] >> 3) << 5) | ((px.d[i + 2] >> 3) << 10);
      h = Math.imul(h, 16777619);
    }
    out[y] = h >>> 0;
  }
  return out;
}

// Longest common subsequence of rows, as an edit script: 'eq', 'del' (a
// before row with no partner) and 'ins' (an after row with none).
function align(A, B) {
  const n = A.length;
  const m = B.length;
  const W = m + 1;
  const L = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1
        : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push(['eq', i, j]); i += 1; j += 1; }
    else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { ops.push(['del', i, j]); i += 1; }
    else { ops.push(['ins', i, j]); j += 1; }
  }
  while (i < n) { ops.push(['del', i, j]); i += 1; }
  while (j < m) { ops.push(['ins', i, j]); j += 1; }
  return ops;
}

function differs(a, ia, b, ib) {
  return Math.max(Math.abs(a[ia] - b[ib]), Math.abs(a[ia + 1] - b[ib + 1]),
    Math.abs(a[ia + 2] - b[ib + 2])) > TOLERANCE;
}

function rowExtent(pa, ya, pb, yb, span) {
  const w = Math.min(pa.w, pb.w);
  for (let x = 0; x < w; x += 1) {
    if (differs(pa.d, (ya * pa.w + x) * 4, pb.d, (yb * pb.w + x) * 4)) {
      if (x < span.min) span.min = x;
      if (x > span.max) span.max = x;
    }
  }
}

// Areas that differ, each with its box on the side it is on and, when it is
// only on one side, the line on the other side where it appears or went.
// Boxes are [x, y, width, height]; lines are [x, y, width].
function regions(before, after) {
  if (before.w !== after.w) return [];
  const ops = align(rowHashes(before), rowHashes(after));
  const hunks = [];
  let cur = null;
  let gap = 0;
  for (const [op, i, j] of ops) {
    if (op === 'eq') {
      if (cur) {
        gap += 1;
        if (gap > JOIN_ROWS) { hunks.push(cur); cur = null; }
      }
      continue;
    }
    if (!cur) cur = { b0: Infinity, b1: -1, a0: Infinity, a1: -1, bAt: i, aAt: j };
    gap = 0;
    if (op === 'del') { cur.b0 = Math.min(cur.b0, i); cur.b1 = Math.max(cur.b1, i + 1); }
    else { cur.a0 = Math.min(cur.a0, j); cur.a1 = Math.max(cur.a1, j + 1); }
  }
  if (cur) hunks.push(cur);
  const out = [];
  for (const h of hunks) {
    const hasB = h.b1 > h.b0;
    const hasA = h.a1 > h.a0;
    const span = { min: Infinity, max: -1 };
    if (hasB && hasA) {
      const len = Math.min(h.b1 - h.b0, h.a1 - h.a0);
      for (let k = 0; k < len; k += 1) rowExtent(before, h.b0 + k, after, h.a0 + k, span);
      const refB = Math.max(0, h.b0 - 1);
      const refA = Math.max(0, h.a0 - 1);
      for (let y = h.b0 + len; y < h.b1; y += 1) rowExtent(before, y, before, refB, span);
      for (let y = h.a0 + len; y < h.a1; y += 1) rowExtent(after, y, after, refA, span);
    } else if (hasA) {
      const ref = h.a0 > 0 ? h.a0 - 1 : Math.min(after.h - 1, h.a1);
      for (let y = h.a0; y < h.a1; y += 1) rowExtent(after, y, after, ref, span);
    } else if (hasB) {
      const ref = h.b0 > 0 ? h.b0 - 1 : Math.min(before.h - 1, h.b1);
      for (let y = h.b0; y < h.b1; y += 1) rowExtent(before, y, before, ref, span);
    }
    if (span.max < 0) continue;
    const x = Math.max(0, span.min - 4);
    const w = Math.min(before.w, span.max + 5) - x;
    const rows = Math.max(h.b1 - h.b0, h.a1 - h.a0);
    if (rows < 3 && w < 24) continue;
    out.push({
      b: hasB ? [x, h.b0, w, h.b1 - h.b0] : null,
      a: hasA ? [x, h.a0, w, h.a1 - h.a0] : null,
      bMark: hasB ? null : [x, h.bAt, w],
      aMark: hasA ? null : [x, h.aAt, w],
    });
  }
  return out;
}

// Where an element shot sits inside its screen. The points compared are the
// crop's detail (text and edges: pixels unlike its most common colour),
// because a crop that is mostly plain background matches plain background
// anywhere; a candidate is then confirmed on a dense grid. A few points may
// differ: the agent hovers an element before shooting it.
function locate(screen, crop) {
  return locateAll(screen, crop, 1)[0] || null;
}

// Every place the crop matches, best first. A screen can repeat an element
// (identical rows in a list), so the caller picks the one where the screens
// differ.
function locateAll(screen, crop, limit = 8) {
  return searchCrop(screen, crop, limit).boxes;
}

// locateAll's search, saying also whether it could decide: a crop that does
// not fit, a search past its budget, or one with too many placements finds
// nothing, but has not shown the crop is not there.
function searchCrop(screen, crop, limit = 8) {
  const undecided = { boxes: [], decided: false };
  if (!crop || crop.w > screen.w || crop.h > screen.h || crop.w < 3 || crop.h < 3) return undecided;
  const q = (d, i) => ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
  const counts = new Map();
  for (let i = 0; i < crop.d.length; i += 12) counts.set(q(crop.d, i), (counts.get(q(crop.d, i)) || 0) + 1);
  const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const detail = [];
  for (let y = 1; y < crop.h - 1; y += 2) {
    for (let x = 1; x < crop.w - 1; x += 2) {
      const i = (y * crop.w + x) * 4;
      if (q(crop.d, i) !== bg) detail.push([x, y, i]);
    }
  }
  const pts = [];
  if (detail.length >= 12) {
    const step = Math.max(1, Math.floor(detail.length / 64));
    for (let k = 0; k < detail.length && pts.length < 64; k += step) pts.push(detail[k]);
  } else {
    // A solid colour can still identify a button on a contrasting page.
    // Sample the crop's extent; the same check and placement budgets below
    // stop searches whose colour matches too much of the screen.
    for (let gy = 0; gy < 6; gy += 1) {
      for (let gx = 0; gx < 8; gx += 1) {
        const x = Math.round(1 + (gx / 7) * (crop.w - 3));
        const y = Math.round(1 + (gy / 5) * (crop.h - 3));
        pts.push([x, y, (y * crop.w + x) * 4]);
      }
    }
  }
  const allowed = Math.max(2, Math.floor(pts.length / 10));
  let remaining = MAX_LOCATE_CHECKS;
  const gridSize = Math.ceil(crop.w / 3) * Math.ceil(crop.h / 3);
  const rejectAt = Math.ceil(gridSize * 0.15);
  const offShare = (x, y) => {
    let off = 0;
    for (let cy = 0; cy < crop.h; cy += 3) {
      for (let cx = 0; cx < crop.w; cx += 3) {
        if (--remaining < 0) return null;
        if (differs(screen.d, ((y + cy) * screen.w + x + cx) * 4, crop.d, (cy * crop.w + cx) * 4)) off += 1;
        if (off >= rejectAt) return 1;
      }
    }
    return off / gridSize;
  };
  const found = [];
  for (let y = 0; y <= screen.h - crop.h; y += 1) {
    for (let x = 0; x <= screen.w - crop.w; x += 1) {
      let miss = 0;
      for (const [px, py, ci] of pts) {
        if (--remaining < 0) return undecided;
        if (differs(screen.d, ((y + py) * screen.w + x + px) * 4, crop.d, ci) && ++miss > allowed) break;
      }
      if (miss > allowed) continue;
      const off = offShare(x, y);
      // Discard partial search results: a later match could be better.
      if (off === null) return undecided;
      if (off >= 0.15) continue;
      // A match a pixel or two over from one already kept is the same place:
      // keep whichever of the two matches better.
      const near = found.find((hit) => Math.abs(hit.box[0] - x) <= 2 && Math.abs(hit.box[1] - y) <= 2);
      if (!near) {
        if (found.length >= MAX_LOCATE_MATCHES) return undecided;
        found.push({ box: [x, y, crop.w, crop.h], off });
      }
      else if (off < near.off) { near.box = [x, y, crop.w, crop.h]; near.off = off; }
    }
  }
  return { boxes: found.sort((a, b) => a.off - b.off).slice(0, limit).map((hit) => hit.box), decided: true };
}

// Whether a dark screen shot is framed as its light one: the same page at
// the same scroll, only its colours changed. Colours say nothing here (the
// whole page changed colour), but where text and edges sit does not change
// with the mode, so each row's count of sharp changes in brightness is
// compared, at the same place and shifted up or down. A dark shot scrolled
// to another part of the page (#6787: the light at the top, the dark at the
// rows under it) lines up better shifted than in place. `light` and `dark`
// are decoded at one pixel per CSS pixel. Resolves `{ same, reason, shift }`:
// `same` false only when the framing plainly differs, null when a screen
// has too little detail to tell.
const FRAMING_EDGE = 36;
const FRAMING_MIN_SHIFT = 8;
function edgeRows(px) {
  const out = new Float64Array(px.h);
  const lum = (i) => (px.d[i] * 299 + px.d[i + 1] * 587 + px.d[i + 2] * 114) / 1000;
  for (let y = 0; y < px.h; y += 1) {
    let n = 0;
    const base = y * px.w * 4;
    for (let x = 0; x + 2 < px.w; x += 2) {
      if (Math.abs(lum(base + x * 4) - lum(base + (x + 2) * 4)) > FRAMING_EDGE) n += 1;
    }
    out[y] = n;
  }
  return out;
}

function shiftedCorrelation(a, b, shift) {
  // Row y of `a` against row y + shift of `b`.
  const from = Math.max(0, -shift);
  const to = Math.min(a.length, b.length - shift);
  const n = to - from;
  if (n < 2) return { r: 0, n: 0 };
  let sa = 0; let sb = 0;
  for (let y = from; y < to; y += 1) { sa += a[y]; sb += b[y + shift]; }
  const ma = sa / n; const mb = sb / n;
  let num = 0; let da = 0; let db = 0;
  for (let y = from; y < to; y += 1) {
    const x = a[y] - ma; const z = b[y + shift] - mb;
    num += x * z; da += x * x; db += z * z;
  }
  return { r: da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0, n };
}

function framing(light, dark) {
  if (!light || !dark) return { same: null, reason: 'missing', shift: 0 };
  if (light.w !== dark.w || light.h !== dark.h) return { same: false, reason: 'size', shift: 0 };
  const a = edgeRows(light);
  const b = edgeRows(dark);
  const total = (rows) => rows.reduce((sum, v) => sum + v, 0);
  // Too little on the page to tell one place from another.
  const rowsWithDetail = (rows) => rows.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
  if (total(a) < light.h || total(b) < dark.h || rowsWithDetail(a) < 24 || rowsWithDetail(b) < 24) {
    return { same: null, reason: 'plain', shift: 0 };
  }
  const inPlace = shiftedCorrelation(a, b, 0).r;
  let best = { r: -1, shift: 0 };
  const most = Math.floor(light.h * 0.75);
  for (let shift = -most; shift <= most; shift += 2) {
    if (Math.abs(shift) < FRAMING_MIN_SHIFT) continue;
    const c = shiftedCorrelation(a, b, shift);
    // A shift that leaves less than a third of the screen to compare
    // matches by chance.
    if (c.n < light.h / 3) continue;
    if (c.r > best.r) best = { r: c.r, shift };
  }
  const round = (value) => Math.round(value * 100) / 100;
  if (best.r > 0.6 && best.r > inPlace + 0.2) {
    return { same: false, reason: 'scrolled', shift: best.shift, inPlace: round(inPlace), shifted: round(best.r) };
  }
  if (inPlace < 0.35) return { same: false, reason: 'different', shift: 0, inPlace: round(inPlace) };
  return { same: true, reason: 'aligned', shift: 0, inPlace: round(inPlace) };
}

// What a still is checked for as it is saved (shots-control.saveShot): a
// dark screen against its light one (framed the same, and whether it looks
// any different at all), or a change's element shot against its screen shot
// (whether the element is in it). Each PNG comes with its density, so both
// are compared at one pixel per CSS pixel.
function checkSave(job) {
  if (job?.kind === 'dark') {
    const light = decode(job.light, job.lightDensity);
    const dark = decode(job.dark, job.darkDensity);
    const placed = framing(light, dark);
    const unchanged = light.w === dark.w && light.h === dark.h && regions(light, dark).length === 0;
    return { kind: 'dark', ...placed, unchanged };
  }
  if (job?.kind === 'element') {
    const screen = decode(job.screen, job.screenDensity);
    const element = decode(job.element, job.elementDensity);
    const search = searchCrop(screen, element, 1);
    return { kind: 'element', found: search.boxes.length > 0, decided: search.decided };
  }
  return null;
}

function overlaps(box, rect) {
  if (!box || !rect) return false;
  return box[0] < rect[0] + rect[2] + 4 && rect[0] < box[0] + box[2] + 4
    && box[1] < rect[1] + rect[3] + 4 && rect[1] < box[1] + box[3] + 4;
}

function union(box, rect) {
  const x = Math.min(box[0], rect[0]);
  const y = Math.min(box[1], rect[1]);
  return [x, y, Math.max(box[0] + box[2], rect[0] + rect[2]) - x, Math.max(box[1] + box[3], rect[1] + rect[3]) - y];
}

// Two boxes overlap "a lot" when at least half of the smaller one lies inside
// the other: whole-panel outlines stacked on the same panel read as one.
function overlapsALot(p, q) {
  const x0 = Math.max(p[0], q[0]);
  const y0 = Math.max(p[1], q[1]);
  const x1 = Math.min(p[0] + p[2], q[0] + q[2]);
  const y1 = Math.min(p[1] + p[3], q[1] + q[3]);
  const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return area * 2 >= Math.min(p[2] * p[3], q[2] * q[3]);
}

// One region from two whose boxes sit almost on top of each other on a side,
// or null when they do not. The merged box is the union per side; a side with
// no box keeps the first mark found there; the story is the earliest of the
// two on the screen.
function mergedPair(a, b, order) {
  const sides = ['a', 'b'].filter((side) => a[side] && b[side] && overlapsALot(a[side], b[side]));
  if (!sides.length) return null;
  const merged = { ...a };
  for (const side of ['a', 'b']) {
    merged[side] = a[side] && b[side] ? union(a[side], b[side]) : (a[side] || b[side]);
    const mark = side === 'a' ? 'aMark' : 'bMark';
    merged[mark] = merged[side] ? null : (a[mark] || b[mark] || null);
  }
  const rank = (id) => {
    const at = order.indexOf(id);
    return at === -1 ? order.length : at;
  };
  const stories = [a.story, b.story].filter((id) => id !== null);
  merged.story = stories.length
    ? stories.reduce((best, id) => (rank(id) < rank(best) ? id : best))
    : null;
  return merged;
}

// Regions whose boxes would sit almost on top of each other are one outline
// on the card: several whole-panel boxes over one panel hide everything under
// them. Runs until nothing merges; the lists are small.
function mergeOverlapping(found, storyOrder) {
  const regions = found.slice();
  for (;;) {
    let mergedAny = false;
    for (let i = 0; i < regions.length - 1 && !mergedAny; i += 1) {
      for (let j = i + 1; j < regions.length; j += 1) {
        const merged = mergedPair(regions[i], regions[j], storyOrder || []);
        if (merged) {
          regions.splice(j, 1);
          regions[i] = merged;
          mergedAny = true;
          break;
        }
      }
    }
    if (!mergedAny) return regions;
  }
}

const areaOf = (region) => Math.max(
  region.b ? region.b[2] * region.b[3] : 0,
  region.a ? region.a[2] * region.a[3] : 0,
);

// The screens a run's card shows. Changes on one screen size whose before
// AND after screens look the same share one screen, with an area for each;
// the first change's after screen is the one shown, since the agent may have
// hovered something different for each. Comparing the after screens too is
// what keeps a new page: an address that used to fall through to another
// declared page has that page's before screen, but its own after screen, so
// it gets a screen of its own instead of the other change's after. A change
// declared as not there before (`baseState: 'not_present'`) never folds and
// never takes another change in, whatever the images look like. A screen
// lists in `foldedAfter` the changes on it whose own after screen is not the
// one shown. `stories` are the ready ones, in the declaration's order.
// Production callers use shots-diff-worker so decoding and matching cannot
// block health responses or workflow lease renewals.
async function screensFor(stories, files) {
  const find = (storyId, viewport, side, variant) => files.find((file) => file.storyId === storyId
    && file.viewport === viewport && file.side === side && file.variant === variant && file.media === 'png');
  const cache = new Map();
  // An element shot is averaged down by its screen shot's density: its own
  // width says nothing about the screen's.
  const pixelsOf = (file, density) => {
    if (!file) return null;
    const key = `${file.sha256}\u0000${density}`;
    if (!cache.has(key)) cache.set(key, decode(file.data, density));
    return cache.get(key);
  };
  const densityOf = (file, story, viewport) => {
    const declared = (story.viewports || []).find((candidate) => candidate.name === viewport);
    return file && declared ? densityFor(pngSize(file.data).w, declared.width) : 1;
  };
  const viewports = [];
  for (const story of stories) {
    for (const viewport of story.viewports || []) {
      if (!viewports.includes(viewport.name)) viewports.push(viewport.name);
    }
  }
  // A change declared as not on the before build is a page that did not
  // exist: its before screen is whatever that address fell through to, so it
  // says nothing about the other changes and they say nothing about it.
  const notPresent = (story) => story.intent?.baseState === 'not_present';
  // Whether a story's after screen already looks like the one its group
  // shows. Same image settles it; otherwise both are decoded at their own
  // densities and the comparison must find nothing to outline.
  const sameAfter = (group, head, story, viewportName) => {
    if (group.head.sha256 === head.sha256) return true;
    const shown = pixelsOf(group.head, densityOf(group.head, group.stories[0], viewportName));
    const own = pixelsOf(head, densityOf(head, story, viewportName));
    return !!shown && !!own && shown.w === own.w && regions(shown, own).length === 0;
  };
  const screens = [];
  for (const viewport of viewports) {
    const groups = [];
    for (const story of stories) {
      const base = find(story.id, viewport, 'base', 'context');
      const head = find(story.id, viewport, 'head', 'context');
      if (!base || !head) continue;
      const own = notPresent(story);
      const group = own ? null : groups.find((entry) => !entry.notPresent
        && entry.baseSha === base.sha256 && sameAfter(entry, head, story, viewport));
      if (group) {
        group.stories.push(story);
        group.heads.set(story.id, head);
      } else {
        groups.push({
          baseSha: base.sha256, stories: [story], base, head, notPresent: own, heads: new Map([[story.id, head]]),
        });
      }
    }
    for (const group of groups) {
      await new Promise((resolve) => setImmediate(resolve));
      const density = densityOf(group.base, group.stories[0], viewport);
      const before = pixelsOf(group.base, density);
      const after = pixelsOf(group.head, densityOf(group.head, group.stories[0], viewport));
      const found = regions(before, after).map((region) => ({ ...region, story: null }));
      for (const story of group.stories) {
        // Each element shot is found in its change's own screen shot, which
        // may differ from the one shown only by what the agent hovered.
        const rects = {};
        for (const side of ['base', 'head']) {
          const crop = find(story.id, viewport, side, 'focus');
          const own = find(story.id, viewport, side, 'context');
          if (crop && own) await new Promise((resolve) => setImmediate(resolve));
          const ownDensity = densityOf(own, story, viewport);
          const places = crop && own
            ? locateAll(pixelsOf(own, ownDensity), pixelsOf(crop, ownDensity)) : [];
          const boxOf = (region) => (side === 'head' ? region.a : region.b);
          rects[side] = places.find((place) => found.some((region) => overlaps(boxOf(region), place)))
            || places[0] || null;
        }
        for (const region of found) {
          if (region.story === null && (overlaps(region.a, rects.head) || overlaps(region.b, rects.base))) {
            region.story = story.id;
            // Only the pixels that differ are in the box, which can leave
            // out most of a button whose colour did not change. Take in the
            // element the agent shot, on the side it overlaps — unless that
            // element covers most of the screen (the agent photographed a
            // whole dialog or sheet), where taking it in would outline the
            // panel instead of the change inside it.
            if (overlaps(region.a, rects.head)
              && rects.head[2] * rects.head[3] <= FOCUS_MAX_SHARE * after.w * after.h) {
              region.a = union(region.a, rects.head);
            }
            if (overlaps(region.b, rects.base)
              && rects.base[2] * rects.base[3] <= FOCUS_MAX_SHARE * before.w * before.h) {
              region.b = union(region.b, rects.base);
            }
          }
        }
      }
      // Several whole-panel outlines over the same panel are unreadable on
      // the card: boxes that would sit almost on top of each other become
      // one, numbered for the earliest change on the screen.
      const merged = mergeOverlapping(found, group.stories.map((story) => story.id));
      const kept = merged
        .map((region, index) => ({ region, index }))
        .sort((x, y) => (x.region.story === null) - (y.region.story === null) || areaOf(y.region) - areaOf(x.region))
        .slice(0, MAX_REGIONS)
        .sort((x, y) => x.index - y.index)
        .map(({ region }) => region);
      screens.push({
        viewport,
        stories: group.stories.map((story) => story.id),
        shot: group.stories[0].id,
        // Changes on this screen whose own after screen is not the one shown:
        // their own shot is kept but the card draws the first change's.
        foldedAfter: group.stories.slice(1)
          .filter((story) => group.heads.get(story.id).sha256 !== group.head.sha256)
          .map((story) => story.id),
        width: before.w,
        heightBefore: before.h,
        heightAfter: after.h,
        // Device pixels per CSS pixel in the stills shown: how far a card
        // may zoom before it draws them soft.
        density,
        regions: kept,
      });
    }
  }
  return screens;
}

// The changes whose every screen showed no difference at all between before
// and after, within the comparison's tolerance: a byte-identical pair is the
// obvious case, and a pair that differs only by antialiasing is the same to
// a person looking at it. A change with any screen that differs is not here.
// A screen's areas compare its before with the after of `shot`, the first
// change on it, so they say nothing about the other changes folded onto that
// screen: those are left out (counted as differing), even when their after
// screens matched within the comparison's tolerance.
function unchangedStories(screens) {
  const changed = new Set();
  const seen = new Set();
  for (const screen of screens || []) {
    for (const id of screen.stories || []) {
      seen.add(id);
      if (id !== screen.shot || (screen.regions || []).length) changed.add(id);
    }
  }
  return new Set([...seen].filter((id) => !changed.has(id)));
}

module.exports = {
  MAX_REGIONS,
  decode,
  averageDown,
  flatten,
  rowHashes,
  align,
  regions,
  framing,
  checkSave,
  locate,
  locateAll,
  screensFor,
  unchangedStories,
};
