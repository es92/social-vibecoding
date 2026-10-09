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
