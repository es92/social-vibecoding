'use strict';

// services/shots-diff.js: where a change's before and after screens differ,
// worked out when a run saves its shots so the card can outline it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const diff = require('../src/services/shots-diff');

// A screen of `w`×`h` in a background colour, with rectangles painted on it.
function screen(w, h, rects = [], bg = [245, 245, 247]) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) d.set([...bg, 255], i * 4);
  for (const [x, y, rw, rh, color] of rects) {
    for (let yy = y; yy < y + rh; yy += 1) {
      for (let xx = x; xx < x + rw; xx += 1) d.set([...color, 255], (yy * w + xx) * 4);
    }
  }
  return { w, h, d };
}
// Text-like detail: a row of dark marks, so a crop is not plain background.
const glyphs = (x, y, n, color = [30, 30, 40]) => Array.from({ length: n }, (_, i) => [x + i * 7, y, 4, 9, color]);
const crop = (px, x, y, w, h) => {
  const d = new Uint8Array(w * h * 4);
  for (let yy = 0; yy < h; yy += 1) d.set(px.d.subarray(((y + yy) * px.w + x) * 4, ((y + yy) * px.w + x + w) * 4), yy * w * 4);
  return { w, h, d };
};
const png = (px) => {
  const image = new PNG({ width: px.w, height: px.h });
  image.data = Buffer.from(px.d);
  return PNG.sync.write(image);
};
const file = (storyId, viewport, side, variant, px) => {
  const data = png(px);
  return { storyId, viewport, side, variant, media: 'png', data,
    sha256: crypto.createHash('sha256').update(data).digest('hex') };
};

test('identical screens have nothing to outline', () => {
  const a = screen(120, 80, glyphs(10, 10, 8));
  assert.deepEqual(diff.regions(a, screen(120, 80, glyphs(10, 10, 8))), []);
});

test('a change in place is outlined at the same spot on both sides', () => {
  const before = screen(200, 120, [[40, 50, 60, 20, [37, 99, 235]], ...glyphs(10, 10, 10)]);
  const after = screen(200, 120, [[40, 50, 120, 20, [37, 99, 235]], ...glyphs(10, 10, 10)]);
  const found = diff.regions(before, after);
  assert.equal(found.length, 1);
  const [region] = found;
  assert.equal(region.b[1], 50);
  assert.equal(region.a[1], 50);
  assert.equal(region.b[3], 20);
  assert.ok(region.b[0] <= 100 && region.b[0] + region.b[2] >= 160, 'as wide as the pixels that differ');
  assert.equal(region.bMark, null);
});

test('rows added in the middle are outlined on the after side only, and what moved down is not', () => {
  const rows = (offset) => [
    ...glyphs(10, 10, 12), [10, 30, 150, 10, [200, 60, 60]],
    ...glyphs(10, 60 + offset, 12, [60, 60, 90]), [10, 90 + offset, 150, 10, [60, 160, 90]],
  ];
  const before = screen(180, 140, rows(0));
  const after = screen(180, 170, [...rows(30), [10, 50, 150, 16, [120, 60, 200]]]);
  const found = diff.regions(before, after);
  assert.equal(found.length, 1, 'the content that shifted lines up again');
  const [region] = found;
  assert.equal(region.b, null);
  assert.ok(region.a[1] >= 44 && region.a[1] <= 50 && region.a[3] >= 16 && region.a[3] <= 30);
  assert.ok(Array.isArray(region.bMark), 'the before side marks where it appears');
});

test('an element shot is found by its detail, not by the plain background around it', () => {
  const page = screen(300, 200, [...glyphs(20, 20, 20), ...glyphs(40, 150, 12, [90, 30, 30]), [36, 146, 100, 1, [210, 210, 214]]]);
  const element = crop(page, 30, 140, 110, 30);
  assert.deepEqual(diff.locate(page, element), [30, 140, 110, 30]);
  // A crop that exists nowhere in the screen is not found.
  const stranger = screen(60, 20, glyphs(5, 5, 6, [10, 200, 10]));
  assert.equal(diff.locate(page, stranger), null);
});

test('solid-color and sparsely detailed focus crops locate unique elements on a contrasting page', () => {
  for (const marks of [[], [[60, 55, 2, 2, [30, 30, 40]]]]) {
    const page = screen(200, 160, [[30, 50, 80, 20, [30, 80, 220]], ...marks], [255, 255, 255]);
    assert.deepEqual(diff.locate(page, crop(page, 30, 50, 80, 20)), [30, 50, 80, 20]);
  }
});

test('solid-color focus crops keep the changed region associated with its declaration', async () => {
  const before = screen(200, 160, [[30, 50, 80, 20, [220, 40, 40]]], [255, 255, 255]);
  const after = screen(200, 160, [[30, 50, 80, 20, [30, 80, 220]]], [255, 255, 255]);
  const stories = [{ id: 'button-color', viewports: [{ name: 'desktop', width: 200 }] }];
  const files = [
    file('button-color', 'desktop', 'base', 'context', before),
    file('button-color', 'desktop', 'head', 'context', after),
    file('button-color', 'desktop', 'base', 'focus', crop(before, 30, 50, 80, 20)),
    file('button-color', 'desktop', 'head', 'focus', crop(after, 30, 50, 80, 20)),
  ];
  for (const comparer of [diff, require('../src/services/shots-diff-worker')]) {
    const [shown] = await comparer.screensFor(stories, files);
    assert.equal(shown.regions.length, 1);
    assert.equal(shown.regions[0].story, 'button-color');
  }
});

test('blank and repetitive crops are ambiguous instead of scoring every placement', () => {
  const blank = screen(1280, 800);
  assert.deepEqual(diff.locateAll(blank, crop(blank, 0, 0, 188, 90)), []);
  const stripes = screen(600, 400, Array.from({ length: 60 }, (_, i) => [i * 10, 0, 5, 400, [30, 30, 40]]));
  assert.deepEqual(diff.locateAll(stripes, crop(stripes, 0, 0, 188, 90)), []);
});

test('a few repeated elements are still located so the changed one can be selected', () => {
  const page = screen(200, 180, [...glyphs(40, 30, 10), ...glyphs(40, 130, 10)]);
  const matches = diff.locateAll(page, crop(page, 30, 20, 100, 30));
  assert.ok(matches.some(([x, y]) => x === 30 && Math.abs(y - 20) <= 2));
  assert.ok(matches.some(([x, y]) => x === 30 && Math.abs(y - 120) <= 2));
});

test('changes on one screen share it, each area tied to the change whose element shot it holds', async () => {
  const base = [...glyphs(10, 10, 20), [20, 40, 80, 20, [37, 99, 235]], [120, 40, 80, 20, [37, 99, 235]], ...glyphs(20, 120, 10)];
  const before = screen(240, 200, base);
  const after = screen(240, 200, [...glyphs(10, 10, 20), [20, 40, 180, 20, [37, 99, 235]], ...glyphs(24, 44, 8, [255, 255, 255]),
    ...glyphs(20, 120, 10), [20, 150, 180, 20, [240, 240, 250]], ...glyphs(26, 155, 10)]);
  const stories = [
    { id: 'well', viewports: [{ name: 'desktop' }] },
    { id: 'list', viewports: [{ name: 'desktop' }] },
  ];
  const files = [
    file('well', 'desktop', 'base', 'context', before), file('well', 'desktop', 'head', 'context', after),
    file('well', 'desktop', 'head', 'focus', crop(after, 18, 38, 184, 24)),
    file('list', 'desktop', 'base', 'context', before), file('list', 'desktop', 'head', 'context', after),
    file('list', 'desktop', 'head', 'focus', crop(after, 18, 148, 184, 24)),
  ];
  const screens = await diff.screensFor(stories, files);
  assert.equal(screens.length, 1);
  const [shown] = screens;
  assert.deepEqual(shown.stories, ['well', 'list']);
  assert.equal(shown.shot, 'well');
  assert.deepEqual([shown.width, shown.heightBefore, shown.heightAfter], [240, 200, 200]);
  const byStory = Object.fromEntries(shown.regions.map((region) => [region.story, region]));
  assert.ok(byStory.well && byStory.list, 'both changes are outlined');
  assert.deepEqual(byStory.well.a, [18, 38, 184, 24], 'widened to the whole element the agent shot');
  assert.ok(byStory.list.a[1] <= 150 && byStory.list.a[1] + byStory.list.a[3] >= 170);
  for (const region of shown.regions) {
    for (const box of [region.b, region.a]) {
      if (box) assert.ok(box.every((value) => Number.isSafeInteger(value) && value >= 0));
    }
  }
});

test('a focus shot covering most of the screen does not stretch the outline', async () => {
  // A panel that covers more than half of the 300×200 screen: the agent
  // photographed a whole dialog, so taking it into the box would outline
  // the panel instead of the two rows added inside it.
  const panel = [30, 30, 240, 140, [200, 200, 210]];
  const before = screen(300, 200, [...glyphs(10, 10, 20), panel]);
  const after = screen(300, 200, [...glyphs(10, 10, 20), panel, ...glyphs(50, 60, 10), ...glyphs(50, 120, 10)]);
  const stories = [{ id: 'panel', viewports: [{ name: 'desktop' }] }];
  const files = [
    file('panel', 'desktop', 'base', 'context', before), file('panel', 'desktop', 'head', 'context', after),
    file('panel', 'desktop', 'head', 'focus', crop(after, 30, 30, 240, 140)),
  ];
  const [shown] = await diff.screensFor(stories, files);
  assert.equal(shown.regions.length, 2, 'the two added rows stay separate');
  for (const region of shown.regions) {
    assert.equal(region.story, 'panel', 'each row is tied to the change whose element shot holds it');
    assert.ok(region.a[3] < 140, 'the box is much smaller than the crop, not stretched to it');
    assert.notDeepEqual(region.a, [30, 30, 240, 140]);
  }
});

test('overlapping whole-panel regions are merged into one, keeping the first change number', async () => {
  // A panel under half the screen, so the box is still widened to it — but
  // two changes whose element shot is the same panel then each yield the
  // whole-panel box, and the card gets one outline, not a stack.
  const panel = [30, 40, 160, 100, [200, 200, 210]];
  const before = screen(240, 200, [...glyphs(10, 10, 20), panel]);
  const after = screen(240, 200, [...glyphs(10, 10, 20), panel, ...glyphs(50, 60, 10), ...glyphs(50, 120, 10)]);
  const focus = crop(after, 30, 40, 160, 100);
  const stories = [
    { id: 'first', viewports: [{ name: 'desktop' }] },
    { id: 'second', viewports: [{ name: 'desktop' }] },
  ];
  const files = [
    file('first', 'desktop', 'base', 'context', before), file('first', 'desktop', 'head', 'context', after),
    file('first', 'desktop', 'head', 'focus', focus),
    file('second', 'desktop', 'base', 'context', before), file('second', 'desktop', 'head', 'context', after),
    file('second', 'desktop', 'head', 'focus', focus),
  ];
  const [shown] = await diff.screensFor(stories, files);
  assert.equal(shown.regions.length, 1, 'one outline over the panel, not a stack');
  const [region] = shown.regions;
  assert.equal(region.story, 'first', "it carries the first change's number");
  assert.ok(region.a[0] <= 30 && region.a[1] <= 40 && region.a[0] + region.a[2] >= 190
    && region.a[1] + region.a[3] >= 140, 'the box covers the panel');
});

test('screens of different widths are shown without outlines rather than guessed', async () => {
  const stories = [{ id: 'x', viewports: [{ name: 'desktop' }] }];
  const files = [
    file('x', 'desktop', 'base', 'context', screen(100, 60, glyphs(5, 5, 5))),
    file('x', 'desktop', 'head', 'context', screen(120, 60, glyphs(5, 5, 5))),
  ];
  const [shown] = await diff.screensFor(stories, files);
  assert.deepEqual(shown.regions, []);
});

test('changes whose after screens differ keep their own screen, so a new page keeps its after shot', async () => {
  // A new page's address showed the landing before: the same before screen as
  // the landing change, but its own after screen.
  const before = screen(240, 200, [...glyphs(10, 10, 18), [20, 40, 80, 20, [37, 99, 235]], ...glyphs(20, 120, 10)]);
  const landing = screen(240, 200, [...glyphs(10, 10, 18), [20, 40, 180, 20, [37, 99, 235]], ...glyphs(20, 120, 10)]);
  const communities = screen(240, 200, [...glyphs(10, 10, 18), [20, 40, 80, 20, [160, 160, 180]], ...glyphs(60, 150, 6)]);
  const stories = [
    { id: 'landing', intent: { baseState: 'present' }, viewports: [{ name: 'desktop', width: 240 }] },
    { id: 'communities', intent: { baseState: 'present' }, viewports: [{ name: 'desktop', width: 240 }] },
  ];
  const files = [
    file('landing', 'desktop', 'base', 'context', before), file('landing', 'desktop', 'head', 'context', landing),
    file('communities', 'desktop', 'base', 'context', before), file('communities', 'desktop', 'head', 'context', communities),
  ];
  const screens = await diff.screensFor(stories, files);
  assert.equal(screens.length, 2, 'the new page gets its own screen');
  assert.deepEqual(screens.map((shown) => shown.shot), ['landing', 'communities']);
  assert.deepEqual(screens.map((shown) => shown.stories), [['landing'], ['communities']]);
});

test('a change declared not present before never folds, in either declaration order', async () => {
  const before = screen(240, 200, glyphs(10, 10, 18));
  const after = screen(240, 200, [...glyphs(10, 10, 18), [20, 150, 180, 20, [240, 240, 250]]]);
  const present = { id: 'landing', intent: { baseState: 'present' }, viewports: [{ name: 'desktop', width: 240 }] };
  const fresh = { id: 'communities', intent: { baseState: 'not_present' }, viewports: [{ name: 'desktop', width: 240 }] };
  const files = [
    file('landing', 'desktop', 'base', 'context', before), file('landing', 'desktop', 'head', 'context', after),
    file('communities', 'desktop', 'base', 'context', before), file('communities', 'desktop', 'head', 'context', after),
  ];
  for (const stories of [[present, fresh], [fresh, present]]) {
    const screens = await diff.screensFor(stories, files);
    assert.equal(screens.length, 2, `not folded with ${stories[0].id} first`);
    assert.deepEqual(screens.map((shown) => shown.stories.length), [1, 1]);
    assert.deepEqual(screens.flatMap((shown) => shown.foldedAfter), []);
  }
});

test('afters that match within the comparison tolerance fold, and only a differing own after is named', async () => {
  const before = screen(240, 200, [...glyphs(10, 10, 18), [20, 40, 80, 20, [37, 99, 235]]]);
  const shownAfter = screen(240, 200, [...glyphs(10, 10, 18), [20, 40, 120, 20, [37, 99, 235]]]);
  // Same picture, one channel nudged by less than the tolerance: nothing to
  // outline, so the two changes still share the screen.
  const nudged = screen(240, 200, [...glyphs(10, 10, 18, [34, 34, 44]), [20, 40, 120, 20, [37, 99, 235]]]);
  const stories = [
    { id: 'first', intent: { baseState: 'present' }, viewports: [{ name: 'desktop', width: 240 }] },
    { id: 'second', intent: { baseState: 'present' }, viewports: [{ name: 'desktop', width: 240 }] },
  ];
  const files = (secondAfter) => [
    file('first', 'desktop', 'base', 'context', before), file('first', 'desktop', 'head', 'context', shownAfter),
    file('second', 'desktop', 'base', 'context', before), file('second', 'desktop', 'head', 'context', secondAfter),
  ];
  const [folded] = await diff.screensFor(stories, files(nudged));
  assert.deepEqual(folded.stories, ['first', 'second']);
  assert.deepEqual(folded.foldedAfter, ['second'], 'its own after is not the one shown');

  const [same] = await diff.screensFor(stories, files(shownAfter));
  assert.deepEqual(same.stories, ['first', 'second'], 'byte-identical afters still fold');
  assert.deepEqual(same.foldedAfter, [], 'nothing is withheld when the shown after is its own');
});

test('unchangedStories names the changes whose every screen shows no difference', () => {
  const screens = [
    { viewport: 'desktop', shot: 'a', stories: ['a'], regions: [] },
    { viewport: 'mobile', shot: 'a', stories: ['a'], regions: [] },
    { viewport: 'mobile', shot: 'b', stories: ['b'], regions: [{ story: 'b' }] },
    { viewport: 'desktop', shot: 'c', stories: ['c'], regions: [] },
    // 'e' shares 'd's before screen; the areas compare it with 'd's after,
    // so they say nothing about 'e'.
    { viewport: 'desktop', shot: 'd', stories: ['d', 'e'], regions: [] },
  ];
  assert.deepEqual([...diff.unchangedStories(screens)].sort(), ['a', 'c', 'd']);
  assert.deepEqual([...diff.unchangedStories([])], []);
  assert.deepEqual([...diff.unchangedStories(undefined)], []);
});

// A screen as a browser at `k` device pixels per CSS pixel saves it: each
// CSS pixel drawn as a k×k block.
const atDensity = (px, k) => {
  const w = px.w * k;
  const d = new Uint8Array(w * px.h * k * 4);
  for (let y = 0; y < px.h * k; y += 1) {
    for (let x = 0; x < w; x += 1) {
      d.set(px.d.subarray((Math.floor(y / k) * px.w + Math.floor(x / k)) * 4, (Math.floor(y / k) * px.w + Math.floor(x / k)) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { w, h: px.h * k, d };
};

test('stills saved at device scale are compared in CSS pixels, and the screen says its density', async () => {
  const before = screen(240, 200, [...glyphs(10, 10, 20), [20, 40, 80, 20, [37, 99, 235]], ...glyphs(20, 120, 10)]);
  const after = screen(240, 200, [...glyphs(10, 10, 20), [20, 40, 180, 20, [37, 99, 235]], ...glyphs(20, 120, 10)]);
  const shown = async (k) => {
    const stories = [{ id: 'well', viewports: [{ name: 'phone', width: 240, height: 200 }] }];
    const files = [
      file('well', 'phone', 'base', 'context', atDensity(before, k)),
      file('well', 'phone', 'head', 'context', atDensity(after, k)),
      file('well', 'phone', 'head', 'focus', atDensity(crop(after, 18, 38, 184, 24), k)),
    ];
    return (await diff.screensFor(stories, files))[0];
  };
  const flat = await shown(1);
  for (const k of [2, 3]) {
    const dense = await shown(k);
    assert.deepEqual([dense.width, dense.heightBefore, dense.heightAfter], [240, 200, 200], `${k}x geometry stays in CSS pixels`);
    assert.equal(dense.density, k);
    assert.deepEqual(dense.regions, flat.regions, `${k}x outlines the same areas as 1x`);
  }
  assert.equal(flat.density, 1);
});

test('a 3x phone screen is within what the diff compares; the size is read before anything is inflated', () => {
  const phone = png(screen(1170, 2532));
  assert.deepEqual([diff.decode(phone, 3).w, diff.decode(phone, 3).h], [390, 844]);
  assert.throws(() => diff.decode(phone, 1), /too large/, 'at 1x the same image is too many pixels');
  // A header claiming a huge image is refused without decoding its body.
  const claim = Buffer.from(phone);
  claim.writeUInt32BE(8000, 16);
  claim.writeUInt32BE(8000, 20);
  assert.throws(() => diff.decode(claim, 2), /too large/);
});

test('averaging down keeps a block\'s mean colour', () => {
  const two = { width: 2, height: 2, data: Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]) };
  assert.deepEqual([...diff.averageDown(two, 2).d], [128, 128, 128, 255]);
});

// #6787: a dark shot scrolled to another part of the page than its light one
// showed the wrong place in the card's crop. Colours change everywhere with
// the mode, but where text and edges sit does not.
test('a dark screen is framed like its light one only when its detail sits in the same rows', () => {
  // A page of lines of text at uneven places (a real page is not a grid),
  // light: dark marks on a pale ground.
  const at = [8, 31, 52, 90, 104, 139, 171, 186, 230, 247, 281, 322, 337, 371, 409, 431, 466];
  const lines = (shift, color, bg) => screen(320, 400, at
    .flatMap((y, k) => glyphs(12 + (k % 3) * 9, y - shift, 14 + ((k * 7) % 5) * 5, color))
    .filter(([, y]) => y >= 0 && y + 9 <= 400), bg);
  const light = lines(0, [30, 30, 40], [245, 245, 247]);
  // The same page in dark: pale marks on a dark ground, at the same place.
  const dark = lines(0, [225, 225, 232], [18, 18, 24]);
  assert.deepEqual(diff.framing(light, dark), { same: true, reason: 'aligned', shift: 0, inPlace: 1 });
  // Scrolled down by three lines: it lines up shifted, not in place.
  const scrolled = diff.framing(light, lines(81, [225, 225, 232], [18, 18, 24]));
  assert.equal(scrolled.same, false);
  assert.equal(scrolled.reason, 'scrolled');
  assert.ok(Math.abs(scrolled.shift + 81) <= 2, `lines up ${scrolled.shift} rows over`);
  // Another size is another screen.
  assert.deepEqual(diff.framing(light, screen(320, 380)), { same: false, reason: 'size', shift: 0 });
  // Too little on a page to tell is never a refusal.
  assert.equal(diff.framing(screen(320, 400), screen(320, 400, [], [10, 10, 10])).same, null);
});

test('checkSave compares a dark screen with its light one and finds an element shot in its screen', () => {
  const page = screen(200, 120, [...glyphs(10, 20, 12), ...glyphs(10, 60, 8), [140, 50, 40, 24, [40, 90, 210]]]);
  const darkPage = screen(200, 120, [...glyphs(10, 20, 12, [220, 220, 230]), ...glyphs(10, 60, 8, [220, 220, 230]),
    [140, 50, 40, 24, [90, 140, 250]]], [16, 16, 22]);
  const dark = diff.checkSave({ kind: 'dark', light: png(page), lightDensity: 1, dark: png(darkPage), darkDensity: 1 });
  assert.equal(dark.kind, 'dark');
  assert.equal(dark.same, true, 'the same layout, its colours changed');
  assert.equal(dark.unchanged, false);
  assert.equal(diff.checkSave({ kind: 'dark', light: png(page), dark: png(page) }).unchanged, true,
    'the same picture has nothing to switch to');
  const button = crop(page, 136, 46, 48, 32);
  assert.deepEqual(diff.checkSave({ kind: 'element', screen: png(page), element: png(button) }),
    { kind: 'element', found: true, decided: true });
  // An element shot from another state of the page is not in this screen.
  const other = crop(screen(200, 120, [[140, 50, 40, 24, [200, 40, 40]], ...glyphs(150, 56, 3)]), 136, 46, 48, 32);
  assert.deepEqual(diff.checkSave({ kind: 'element', screen: png(page), element: png(other) }),
    { kind: 'element', found: false, decided: true });
  // One larger than the screen cannot be looked for: undecided, never a warning.
  assert.deepEqual(diff.checkSave({ kind: 'element', screen: png(button), element: png(page) }),
    { kind: 'element', found: false, decided: false });
});
