'use strict';

// The new Needs you review flow (frontend/src/features/review-flow/), an
// experiment behind Settings › Experimental ("New Needs you"), off by
// default and kept on the device.
//
// What is pinned, and each is a way it can be quietly wrong:
//
//   1. THE SWITCH. Off until a person turns it on, kept where the screen
//      reads it, painted and saved by Settings through its bridge, and the
//      Communities tab draws the new flow only while it is on.
//   2. THE PICTURES' MATHS. The title shot crops the after side to what
//      changed; the slider places BOTH sides with one placement, so a seam
//      never moves what it compares; the seam resists past an edge and
//      settles softly on the edges of what changed.
//   3. THE RUN AND THE VOTE. No feed: the page opens on the first change,
//      under its own light bar (Back, the title, ⌄), whose ⌄, title or line
//      opens the change in full; Back always leaves the run. Votes go
//      through the platform's castVote with the epoch; a No counts in one
//      tap and may carry a line after; your own answer again goes through
//      retractVote; Next moves to the next change without a vote and
//      carries how many still wait; Done on the last one shows the run's
//      end.
//   4. THE COPY. Every message the flow asks for exists in English.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const settings = loadTsx('frontend/src/features/review-flow/settings.ts');
const model = loadTsx('frontend/src/features/review-flow/model.ts');
const compare = loadTsx('frontend/src/features/review-flow/compare.tsx');
const sheet = loadTsx('frontend/src/features/review-flow/vote-sheet.tsx');

function memoryStorage(on) {
  const map = new Map(on ? [[settings.REVIEW_FLOW_STORAGE_KEY, '1']] : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    map,
  };
}

const SCREEN = {
  viewport: 'mobile',
  width: 390,
  before: { url: '/api/apps/a/proposals/1/shots/' + 'a'.repeat(32), height: 844 },
  after: { url: '/api/apps/a/proposals/1/shots/' + 'b'.repeat(32), height: 900 },
  regions: [{ n: 1, b: [20, 300, 200, 40], a: [20, 300, 240, 60] }],
};

function feedItem(over = {}) {
  return {
    kind: 'proposal', id: 41, title: 'Unused invite links say so plainly',
    summary: '**A link** nobody used reads "No one joined yet".', author: 'ines',
    number: 4827, epoch: 3, at: '2026-10-19T10:00:00Z', yes: 1, no: 0,
    shots: { state: 'verified' }, visuals: null,
    app: { slug: 'homeroom', name: 'Homeroom', icon_url: null, icon_emoji: null },
    ...over,
  };
}

// ── 1. The switch ────────────────────────────────────────────────────────

test('the switch is off by default and kept on the account; a failed save changes nothing', async () => {
  assert.equal(settings.reviewFlowEnabled({ user: {} }), false);
  assert.equal(settings.reviewFlowEnabled(null), false, 'signed out reads as off');
  const app = { user: { reviewFlowEnabled: false } };
  const sent = [];
  const ok = (v) => { sent.push(v); return Promise.resolve(true); };
  assert.equal(await settings.setReviewFlowEnabled(true, app, ok), true);
  assert.deepEqual(sent, [true]);
  assert.equal(settings.reviewFlowEnabled(app), true);
  assert.equal(await settings.setReviewFlowEnabled(false, app, () => Promise.resolve(false)), false);
  assert.equal(settings.reviewFlowEnabled(app), true, 'the account keeps what the server has');
});

test('a device that had it on carries it over to the account once, then forgets it', async () => {
  const app = { user: { reviewFlowEnabled: false } };
  const store = memoryStorage(true);
  const sent = [];
  await settings.carryOverDeviceSwitch(app, store, (v) => { sent.push(v); return Promise.resolve(true); });
  assert.deepEqual(sent, [true]);
  assert.equal(app.user.reviewFlowEnabled, true);
  assert.equal(store.map.has(settings.REVIEW_FLOW_STORAGE_KEY), false);
  await settings.carryOverDeviceSwitch(app, store, (v) => { sent.push(v); return Promise.resolve(true); });
  assert.deepEqual(sent, [true], 'nothing left to carry');
  const failing = memoryStorage(true);
  await settings.carryOverDeviceSwitch({ user: { reviewFlowEnabled: false } }, failing, () => Promise.resolve(false));
  assert.equal(failing.map.get(settings.REVIEW_FLOW_STORAGE_KEY), '1', 'kept to try again when the save failed');
});

test('the server keeps the switch on the account and serves it with the user', () => {
  assert.match(read('src/db/schema.sql'), /ALTER TABLE users ADD COLUMN IF NOT EXISTS review_flow_enabled BOOLEAN NOT NULL DEFAULT FALSE;/);
  const routes = read('src/routes/auth.js');
  assert.match(routes, /router\.post\('\/api\/me\/review-flow'[\s\S]{0,400}UPDATE users SET review_flow_enabled = \$1 WHERE id = \$2/);
  assert.match(routes, /reviewFlowEnabled: !!req\.user\.reviewFlowEnabled/);
  const mw = read('src/middleware/auth.js');
  assert.equal((mw.match(/review_flow_enabled/g) || []).length, 4, 'both reads select it and both shapes carry it');
});

test('the bridge settings.js reads and saves the switch through', () => {
  const win = {};
  settings.installReviewFlowBridge(win);
  assert.equal(typeof win.UsernodeReact.reviewFlow.enabled, 'function');
  assert.equal(typeof win.UsernodeReact.reviewFlow.setEnabled, 'function');
});

test('Settings, Experimental carries the switch, and settings.js paints and saves it', () => {
  const section = read('frontend/src/features/settings/sections/experimental.tsx');
  assert.match(section, /<SwitchRow id="review-flow-enabled">/);
  assert.match(section, /settings:experimental\.reviewFlow\.label/);
  const js = read('frontend/src/features/settings/settings.js');
  assert.match(js, /getElementById\('review-flow-enabled'\)[\s\S]{0,400}UsernodeReact\?\.reviewFlow[\s\S]{0,80}setEnabled\(e\.target\.checked\)[\s\S]{0,80}if \(!ok\) reviewToggle\.checked = !!pref\?\.enabled\(\)/);
  assert.match(js, /review\.checked = !!reviewPref\?\.enabled\(\)/);
  assert.match(read('frontend/src/main.tsx'), /import '\.\/features\/review-flow\/settings';/);
  assert.equal(message('settings:experimental.reviewFlow.label'), 'New Needs you');
});

test('the Communities tab draws the new flow only while the switch is on', () => {
  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /const reviewFlow = useReviewFlowEnabled\(\);/);
  assert.match(src, /reviewFlow \? \(\s*\/\/[\s\S]*?<ReviewFlow[\s\S]*?\) : \(\s*<NeedsReel/);
  assert.match(src, /onRetracted=\{\(id\) => workshopController\.retracted\(id\)\}/);
  assert.match(src, /retracted\(id: number\) \{[\s\S]*?answeredVotes\.delete\(key\)[\s\S]*?this\.refreshNeeds\(\)/);
});

// ── 2. The pictures' maths ──────────────────────────────────────────────

test('feed items become review items: plain summary, shaped screens, phone first, ground by size', () => {
  const desktop = { ...SCREEN, viewport: 'desktop', width: 1280 };
  const shape = () => ({ screens: [desktop, SCREEN], protected: true });
  const [item] = model.toReviewItems([feedItem({ staging_url: 'https://preview.example/x' })], shape);
  assert.equal(item.key, 'proposal:41');
  assert.equal(item.summary, 'A link nobody used reads "No one joined yet".');
  assert.deepEqual(item.screens.map((s) => s.viewport), ['mobile'], 'a phone screen wins when there is one');
  assert.equal(item.ground, model.GROUNDS.quiet, 'one changed spot is quiet');
  assert.equal(item.stagingUrl, 'https://preview.example/x');
  assert.equal(item.epoch, 3);

  const many = { ...SCREEN, regions: [SCREEN.regions[0], SCREEN.regions[0]] };
  assert.equal(model.groundFor([many]), model.GROUNDS.notable);
  assert.equal(model.groundFor([SCREEN, SCREEN]), model.GROUNDS.loud, 'several screens are loud');

  const [gov] = model.toReviewItems([feedItem({ kind: 'governance', shots: null })], () => { throw new Error('not shaped'); });
  assert.equal(gov.kind, 'governance');
  assert.deepEqual(gov.screens, []);
  assert.equal(gov.stagingUrl, null);

  const [legacy] = model.toReviewItems([feedItem({ shots: null, visuals: {} })], () => ({ before: 'c'.repeat(32), after: 'd'.repeat(32) }));
  assert.deepEqual(legacy.pair, { before: '/visuals/' + 'c'.repeat(32), after: '/visuals/' + 'd'.repeat(32) });
});

test('the title shot crops the after side to what changed, at its own proportions', () => {
  const crop = model.titleCrop(SCREEN, { w: 300, h: 200 });
  // The after box (20,300,240,60) with 24px of room, clamped at the left
  // edge: 284 x 108.
  assert.ok(crop.w <= 300 && crop.h <= 200);
  assert.ok(Math.abs(crop.w / crop.h - 284 / 108) < 0.05, 'the plate keeps the crop\'s proportions');
  assert.ok(crop.place.scale >= 1 && crop.place.scale <= 2, 'a small spot is shown at least at its size, at most twice');
  assert.ok(crop.place.ty < 0, 'the screen is moved up so the spot shows');
});

test('one placement for both sides: the seam never moves what it compares', () => {
  const box = model.focusBox(SCREEN, ['before', 'after'], 16);
  assert.deepEqual(box, { x: 4, y: 284, w: 272, h: 92 });
  const place = model.placeBox(SCREEN, box, { w: 390, h: 292 }, 1.6);
  assert.ok(place.scale <= 1.6);
  // The box's middle lands in the view's middle (or as near as the screen's edges allow).
  const mid = (box.y + box.h / 2) * place.scale + place.ty;
  assert.ok(Math.abs(mid - 146) < 1, `middle at ${mid}`);
});

test('the seam resists past an edge and settles softly near what changed', () => {
  assert.equal(model.rubberBand(0, 390), 0);
  const far = model.rubberBand(400, 390);
  assert.ok(far > 0 && far < 400 && far < 390, 'it follows, less and less');
  assert.equal(model.rubberBand(-50, 390), -model.rubberBand(50, 390));
  assert.equal(model.magnet(100, [100]), 100);
  const pulled = model.magnet(108, [100]);
  assert.ok(pulled < 108 && pulled > 100, 'pulled toward the stop');
  assert.equal(model.magnet(140, [100]), 140, 'out of reach, untouched');
  const stops = model.seamStops(SCREEN, { scale: 1, tx: 0, ty: 0 }, 390);
  assert.ok(stops.length >= 3);
  assert.ok(stops.every((x, i) => i === 0 || stops[i - 1] <= x), 'in order');
});

test('the switch names the side most of the window shows, with hysteresis, and colour follows share', () => {
  assert.equal(compare.viewFor(0.55, 'after'), 'after');
  assert.equal(compare.viewFor(0.6, 'after'), 'before');
  assert.equal(compare.viewFor(0.45, 'before'), 'before');
  assert.equal(compare.viewFor(0.4, 'before'), 'after');
  assert.equal(compare.saturationFor(0.5), 1);
  assert.equal(compare.saturationFor(0.25), 0.5);
  assert.equal(compare.saturationFor(0), 0);
});

test('the magnifier shows what is under the finger at the zoom, and stays inside the window', () => {
  const place = { scale: 1.2, tx: -10, ty: -40 };
  const lens = compare.lensPlace(place, { x: 100, y: 80 }, 2.5, 132);
  assert.equal(lens.scale, 3, 'the drawn scale times the zoom');
  const layerX = (100 - place.tx) / place.scale;
  const layerY = (80 - place.ty) / place.scale;
  assert.ok(Math.abs(lens.tx + layerX * lens.scale - 66) < 1e-9, 'the point lands at the circle\'s centre');
  assert.ok(Math.abs(lens.ty + layerY * lens.scale - 66) < 1e-9);
  const identity = compare.lensPlace(null, { x: 50, y: 20 }, 2.5, 132);
  assert.equal(identity.scale, 2.5, 'a whole pair magnifies by the zoom alone');

  const size = { w: 366, h: 275 };
  assert.deepEqual(compare.lensBox({ x: 183, y: 200 }, size, 132, 0), { x: 117, y: 134 }, 'a mouse: centred under the pointer');
  assert.deepEqual(compare.lensBox({ x: 183, y: 200 }, size, 132, 24), { x: 117, y: 44 }, 'a finger: raised clear of the fingertip');
  assert.deepEqual(compare.lensBox({ x: 0, y: 0 }, size, 132, 0), { x: 0, y: 0 });
  assert.deepEqual(compare.lensBox({ x: 366, y: 275 }, size, 132, 0), { x: 234, y: 143 });
  assert.deepEqual(compare.lensBox({ x: 366, y: 275 }, size, 132, 24), { x: 234, y: 119 }, 'inside at every edge');
});

test('a still press of a third of a second opens the magnifier; moving early does not', () => {
  const src = read('frontend/src/features/review-flow/compare.tsx');
  assert.match(src, /const HOLD_TO_ZOOM = 300;/);
  assert.match(src, /const LENS_ZOOM = 2\.5;/);
  assert.match(src, /Math\.hypot\(dx, dy\) > HOLD_SLOP\) clearTimeout\(zoomTimer\.current\)/, 'moving off the spot cancels the hold');
  assert.match(src, /Math\.abs\(dy\) > 8 && Math\.abs\(dy\) > Math\.abs\(dx\)/, 'the vertical threshold is unchanged');
  assert.match(src, /Math\.abs\(dx\) < 6/, 'the drag threshold is unchanged');
  assert.match(src, /addEventListener\('touchmove', hold, \{ passive: false \}\)/, 'the page does not scroll while the magnifier is open');
  assert.match(src, /if \(lensRef\.current\) \{\n\s+const p = pointAt\(e\)/, 'once open it follows the finger, not the seam');
  assert.match(src, /className="rf-lens"\s+aria-hidden="true"/, 'the magnifier is visual only');
  assert.match(src, /onContextMenu=\{\(e\) => e\.preventDefault\(\)\}/, 'the phone\'s long-press menu stays shut');

  const css = read('public/css/app.css');
  assert.match(css, /\n\.rf-lens \{ position: absolute; left: 0; top: 0; z-index: 6; width: 132px; height: 132px; border-radius: 999px;/);
  assert.match(css, /\.rf-compare \{[^}]*\-webkit-touch-callout: none;/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\n  \.rf-sheet, \.rf-scrim, \.rf-seam, \.rf-cap, \.rf-switch, [^}]*\{ transition: none; \}\n  \.rf-lens \{ animation: none; \}/,
    'the magnifier opens at once when motion is reduced',
  );
});

test('each side carries its own caption, and the seam wipes it with its picture', () => {
  const src = read('frontend/src/features/review-flow/compare.tsx');
  // The After caption lies over the after picture; the Before caption is
  // inside the clip with the before picture, so the seam cuts both alike.
  assert.match(src, /<div className="rf-cap rf-cap-after"[\s\S]*?<div className="rf-layer-clip"/);
  assert.match(src, /<div className="rf-layer-clip"[^>]*>\s*<div className="rf-layer"[^>]*>\{img\(before, 'before'\)\}\{veilAt\}<\/div>\s*<div className="rf-cap rf-cap-before"/);
  // The landing dim rides each side's own picture, so the seam wipes it too.
  assert.match(src, /data-rf-cam="">\{img\(after \|\| before, after \? 'after' : 'before'\)\}\{closeups\(after \? 'after' : 'before'\)\}\{veilAt\}<\/div>/);
  assert.match(src, /RichMessage id="communities:review\.compare\.captionAfter"/);
  assert.match(src, /RichMessage id="communities:review\.compare\.captionBefore"/);
  assert.equal(message('communities:review.compare.captionBefore'), 'Before <0>· Today</0>');
  assert.equal(message('communities:review.compare.captionAfter'), '<0>If it passes ·</0> After');
  assert.doesNotMatch(src, /rf-pill|rf-tab/, 'the pill and the ›› tab are gone');
});

test('the switch flips the view and its knob says which side, a press leans the seam in', () => {
  const src = read('frontend/src/features/review-flow/compare.tsx');
  assert.match(src, /role="switch"\s+aria-checked=\{word === 'before'\}/);
  assert.match(src, /const LEAN = 0\.08;/);
  assert.match(src, /onPointerDown=\{switchDown\}/);
  assert.match(src, /onClick=\{flip\}/);
  // A flip pins the knob to where it was sent while the seam glides there.
  assert.match(src, /pinned\.current = true;\s*setView\(to > 0 \? 'before' : 'after'\);\s*glide\(to, 320/);
  assert.match(src, /closest\('\[data-rf-switch\]'\)\) return;/, 'a press on the switch never starts a drag');
  const css = read('public/css/app.css');
  assert.match(css, /\.rf-switch \{ position: absolute; left: 50%; bottom: 12px;[^}]*width: 72px; height: 40px;/);
  assert.match(css, /\.rf-switch\[data-view="before"\] \.rf-knob \{ left: 2\.5px;/, 'Before on the left');
  assert.match(css, /\.rf-knob \{ position: absolute; top: 2\.5px; left: 34\.5px;/, 'After on the right');
});

test('the picture takes the page\'s free height, up to 3:2, and gives way to 2:1 before the line does', () => {
  const flow = loadTsx('frontend/src/features/review-flow/review-flow.tsx');
  // The page holds the line it leads with (6 + 42 + 14, .rf-claim) and the vote at rest (120).
  assert.equal(flow.heroHeight(351, 704, false), 704 - 182, 'a phone: what the page leaves');
  assert.equal(flow.heroHeight(351, 300, false), Math.round(351 * 0.5), 'a short window: 2:1 at least');
  assert.equal(flow.heroHeight(351, 2000, false), Math.round(351 * 1.5), 'a tall one stops at 3:2');
  assert.equal(flow.heroHeight(351, 704, true), 704 - 182 - 56, 'the strip takes its row: 12 above, 44 tall');
  assert.match(read('frontend/src/features/review-flow/review-flow.tsx'), /const PAGE_CHROME = 6 \+ 42 \+ 14 \+ 120;/);
  assert.match(read('public/css/app.css'), /\.rf-claim \{ flex: none; margin: 0 0 14px; padding: 6px 16px 0; min-height: 42px;/, 'the budget is the line\'s own box');
});
// ── 2b. The preview card ────────────────────────────────────────────────

test('the page leads with what the change does, then its picture, then the strip', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(src, /const INSET = 12;/);
  assert.match(src, /const inner = Math\.max\(0, width - INSET \* 2\);/);
  const body = src.slice(src.indexOf('<div className="rf-page-body"'), src.indexOf('/* ── The run'));
  const claim = body.indexOf('className="rf-claim-row"');
  const picture = body.indexOf('className="rf-picture"');
  const strip = body.indexOf('<Strip');
  assert.ok(claim > 0 && claim < picture && picture < strip, 'the line, the picture, the strip');
  // The title is the bar's, one line; the line under it is body text.
  assert.match(src, /className="rf-page" role="dialog" aria-modal="false" aria-label=\{item\.title\}/);
  assert.doesNotMatch(src, /rf-head|rf-preview|rf-thumbs|planTitleFlight|coverGhost/, 'no old head, no feed card, no flight');
  const css = read('public/css/app.css');
  assert.match(css, /\.rf-claim \{ flex: none; margin: 0 0 14px; padding: 6px 16px 0; min-height: 42px; font-size: 15px; font-weight: 400; line-height: 21px; color: var\(--rf-muted\);/, 'body text under the title, not a second title');
  assert.match(css, /\.rf-bar-title \{ [^}]*font-size: 17px; font-weight: 650;/, 'the title is the one strong line');
  assert.match(css, /\.rf-claim \{ display: -webkit-box; -webkit-line-clamp: 2;/);
  assert.match(css, /\.rf-picture \{ position: relative; margin: 0 12px; border-radius: 32px; overflow: hidden; isolation: isolate; \}/);
  assert.match(css, /\.rf-strip \{ position: relative; flex: none; height: 44px; margin: 12px 12px 0; \}/);
});

test('the strip is pictograms: an outline per screen, a bar on every place it changed, on grey tiles', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  const strip = src.slice(src.indexOf('function Strip('), src.indexOf('/* ── One change\'s page body'));
  assert.doesNotMatch(strip, /<img/, 'no screenshots under the picture');
  assert.match(strip, /const marks = pictoMarks\(s, inW, inH\);/);
  assert.match(strip, /<span key=\{b\.screen\} className="rf-gbar" aria-hidden="true" style=\{\{ left: b\.x, top: b\.y, width: b\.w, height: b\.h \}\} \/>/, 'the overview glyph stays as it is whichever screen is open');
  assert.match(src, /const TILE = 44;/);
  const css = read('public/css/app.css');
  assert.match(css, /\.rf-strip-all, \.rf-tile \{ position: absolute; padding: 0; border: 0; background: var\(--rf-fill\); color: var\(--rf-muted\);/, 'a grey ground says it can be pressed');
  assert.match(css, /\.rf-strip-all\[aria-current\], \.rf-tile\[aria-current\] \{ background: var\(--lit-tint\); color: var\(--lit-ink\); \}/, 'where you are: the lit tint and ink');
  assert.doesNotMatch(css, /\.rf-lit \{|\.rf-tile-in \{/);

  // Where the marks go: the screen's first phone-height, stretched to its lowest change.
  const screen = (regions, height = 844) => ({ viewport: 'phone', width: 390, after: { url: 'a.png', height }, before: null, regions });
  const r = (x, y, w, h) => ({ n: 1, b: null, a: [x, y, w, h] });
  assert.deepEqual(model.pictoMarks(screen([r(0, 422, 390, 84)]), 14, 24), [{ x: 0, y: 12, w: 14, h: 2.5 }], 'halfway down, the width of the screen');
  const two = model.pictoMarks(screen([r(20, 40, 100, 60), r(200, 700, 150, 80)]), 14, 24);
  assert.equal(two.length, 2, 'two places far apart, two marks');
  assert.ok(two[0].y < two[1].y, 'top to bottom');
  assert.equal(model.pictoMarks(screen([r(20, 100, 350, 40), r(20, 145, 350, 40)]), 14, 24).length, 1, 'touching at this size: one mark');
  assert.equal(model.pictoMarks(screen([r(0, 10, 50, 20), r(0, 200, 50, 20), r(0, 400, 50, 20), r(0, 600, 50, 20)]), 14, 24).length, 3, 'at most three');
  assert.deepEqual(model.pictoMarks(screen([]), 14, 24), [], 'nothing recorded: the outline alone, not a mark somewhere');
  const low = model.pictoMarks(screen([r(0, 1800, 390, 60)], 2400), 14, 24);
  assert.ok(low[0].y + low[0].h <= 24 && low[0].y > 20, 'a change below the first screenful still lands inside, at the foot');
});
// ── 3. The vote ──────────────────────────────────────────────────────────

test('votes go through castVote with the epoch, a No may carry a line, a vote taken back goes through retractVote', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(src, /callAppView\('castVote', item\.id, v, item\.epoch, opts\)/);
  assert.match(src, /v === 'no' \? \{ reason: reason \|\| '' \} : \{ reason: null \}/);
  assert.match(src, /callAppView\('retractVote', item\.id, item\.epoch\)/);
  assert.match(src, /onAnswered\?\.\(item\.id, item\.epoch\)/);
  assert.match(src, /onRetracted\?\.\(item\.id\)/);
  assert.equal(sheet.NO_LINE_MAX, 280, 'the server\'s VOTE_REASON_MAX');
});

test('going anywhere else takes the page down at once, and it comes back with the pane', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(src, /window\.addEventListener\('hashchange', route\)/);
  assert.match(src, /window\.addEventListener\('popstate', route\)/);
  assert.match(src, /setShown\(!!anchorRef\.current && anchorRef\.current\.getClientRects\(\)\.length > 0\)/);
});

test('the run\'s bar: back, the title and ⌄; the title, ⌄ or the line opens the change in full', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  // Back is the arrow alone, named for where it goes, and it leaves the run.
  assert.match(src, /const toProject = header === 'project' && item && item\.app \? item\.app\.name : '';/);
  assert.match(src, /t\('communities:review\.back\.label', \{ place: toProject \|\| t\('communities:switcher\.all\.name'\) \}\)/);
  assert.match(src, /<button type="button" className="rf-back" onClick=\{onDone\} aria-label=\{backName\} data-rf-back="">/);
  assert.match(src, /header="project"/);
  assert.match(read('frontend/src/features/workshop/index.tsx'), /onDone=\{\(\) => workshopController\.setTab\('status'\)\}/, 'from Communities, back to Communities');
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'), /<ProjectReviewFlow slug=\{slug\} onDone=\{\(\) => openTab\('status'\)\} \/>/, 'from a project, back to its hub');
  // Three ways in, one state.
  assert.match(src, /<button type="button" className="rf-bar-title-btn" onClick=\{\(\) => setDesc\(\(d\) => !d\)\} aria-expanded=\{desc\} aria-controls="rf-desc">\{item\.title\}<\/button>/);
  assert.match(src, /className="rf-bar-toggle"\s+aria-expanded=\{desc\}/);
  assert.match(src, /<button type="button" className="rf-claim-row" onClick=\{onMore\} aria-controls="rf-desc" data-rf-more="">/);
  assert.match(src, /onMore=\{\(\) => setDesc\(true\)\}/);
  // The card: what the change does in full, and the way on to its page.
  assert.match(src, /<p className="rf-desc-text">\{item\.summary \|\| item\.line\}<\/p>/);
  assert.match(src, /<a className="rf-desc-go" href=\{changeHref\(item\.app\.slug, item\.id, item\.number\)\}>\{t\('communities:review\.more\.open'\)\}<\/a>/);
  assert.match(src, /if \(desc\) setDesc\(false\);\s*else if \(sheetOpen\(sheet\)\)/, 'Escape folds the card first');
  assert.match(src, /useEffect\(\(\) => \{ setDesc\(false\); \}, \[itemKey\]\);/, 'folded on every new change');
  // The shell's header is main's: the run covers it on a phone.
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/header/review-run-store.js')));
  assert.doesNotMatch(read('frontend/src/features/header/header-title.tsx'), /reviewRun/);
  assert.doesNotMatch(read('frontend/src/features/header/platform-header.tsx'), /reviewRun/);
  const css = read('public/css/app.css');
  // A detail view: on a phone the page covers the header and the tab bar
  // (z 30) top to bottom; the vote bar clears the home indicator itself, and
  // the page's height budget counts that inset.
  assert.match(css, /\n\.rf-page-wrap \{ position: fixed; left: var\(--platform-rail-w, 0px\); right: 0; top: 0; bottom: 0; z-index: 35;/);
  assert.match(css, /\.rf-sheet-inner \{ display: flex; flex-direction: column; max-height: inherit; padding: 0 16px calc\(10px \+ var\(--platform-safe-bottom, 0px\)\); \}/);
  assert.match(css, /\.rf-safe-probe \{ [^}]*height: var\(--platform-safe-bottom, 0px\);/);
  assert.match(src, /const h = \(Number\.isFinite\(max\) && max > 0 \? max : pr\.height\) - bar - safe;/);
  assert.match(css, /\.rf-bar\[data-open\] \.rf-bar-title \{ white-space: normal;/, 'open, the whole title');
  assert.match(css, /\.rf-bar-toggle\[aria-expanded="true"\] svg \{ transform: rotate\(180deg\); \}/);
  assert.match(css, /\.rf-desc-wrap\[data-open\] \.rf-desc \{ transform: none;/);
});

test('Next change goes to the next change with no vote, wraps to an earlier one, and skips what you voted on', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  assert.equal(model.nextIndex(items, 0, {}), 1, 'nothing voted: the next one');
  assert.equal(model.nextIndex(items, 2, {}), 0, 'the last wraps to the first');
  assert.equal(model.nextIndex(items, 0, { b: 'yes' }), 2, 'a voted change is skipped');
  assert.equal(model.nextIndex(items, 1, { c: 'yes' }), 0, 'the one behind you, unvoted');
  assert.equal(model.nextIndex(items, 0, { b: 'yes', c: 'yes' }), -1, 'every other change has a vote');
  assert.equal(model.nextIndex([{ key: 'a' }], 0, {}), -1, 'a single change has none');
  const withDecision = [{ key: 'a' }, { key: 'g', kind: 'governance' }, { key: 'b' }];
  assert.equal(model.nextIndex(withDecision, 0, {}), 2, 'a group decision opens its own page and is skipped');
  assert.equal(model.nextIndex(withDecision, 2, { a: 'yes' }), -1, 'and it does not keep all-done from showing');
});

test('the sheet covers the page while its help, menu or reason list is open', () => {
  for (const s of ['ask', 'voted']) assert.equal(sheet.sheetOpen(s), false, s);
  for (const s of ['reason', 'askq', 'talk', 'try']) assert.equal(sheet.sheetOpen(s), true, s);
});

function sheetHtml(props) {
  const [item] = model.toReviewItems([feedItem()], () => ({ screens: [SCREEN] }));
  return renderToHtml(createElement(sheet.VoteSheet, {
    item, vote: null, state: 'ask', setState() {}, onVote: async () => true, onUndo: async () => true,
    onNext() {}, onSkip() {}, hasNext: true, maxHeight: 600, ...props,
  }));
}

test('Next passes the votes and the skips, and Done on the last one shows the run\'s end', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(src, /const next = item \? nextIndex\(run, index, passed\) : -1;/);
  assert.match(src, /if \(n < 0\) \{ finishAll\(\); return; \}/);
  assert.match(src, /const finishAll = \(\) => \{ stop\(\); setDone\(true\); \};/);
  // Skip moves on without a vote; nothing is recorded.
  assert.match(src, /goTo\(nextIndex\(run, index, now\)\);/);
  assert.match(src, /if \(done \|\| \(list && !item && Object\.keys\(votes\)\.length\)\) \{[\s\S]*?rf-end rf-end-alone/);
  assert.match(read('public/css/app.css'), /\.rf-end-alone \{ min-height: 56vh; justify-content: center;/);
});

test('the end is done only when everything had your vote; skipped changes wait as a stack, with a way to look again', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(src, /const waiting = run\.filter\(\(it\) => skipped\[it\.key\] && !votes\[it\.key\]\);/);
  const from = src.indexOf('{waiting.length ? (');
  const end = src.slice(from, src.indexOf(') : (', from));
  assert.doesNotMatch(end, /CheckIcon/, 'not done, so no check');
  assert.match(end, /waiting\.slice\(0, 3\)\.map/, 'at most three tiles, each on its own ground');
  assert.match(end, /t\('communities:review\.end\.throughAll'\)/);
  assert.match(end, /t\('communities:review\.end\.waiting', \{ count: waiting\.length \}\)/);
  assert.match(end, /onClick=\{again\} data-rf-again="">\{t\('communities:review\.end\.again', \{ count: waiting\.length \}\)\}/);
  assert.match(end, /className="rf-end-back" onClick=\{onDone\}/, 'and a quiet way back');
  // Looking again clears the skips and starts from the first change waiting.
  assert.match(src, /const again = \(\) => \{\s*const first = run\.findIndex\(\(it\) => it\.kind !== 'governance' && !votes\[it\.key\]\);[\s\S]*?setSkipped\(\{\}\);\s*setIndex\(first\);\s*setDone\(false\);/);
  assert.equal(message('communities:review.end.throughAll'), "You've been through them all");
  assert.equal(message('communities:review.end.again_other'), 'Look at the {{count}} again');
});
test('at rest the vote is part of the page: Yes | No and Skip, no sheet', () => {
  const html = sheetHtml({});
  assert.match(html, /class="rf-sheet rf-sheet-rest"/);
  assert.doesNotMatch(html, /rf-grab/, 'no handle while it rests');
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /data-rf-vote="yes"[\s\S]*rf-pair-div[\s\S]*data-rf-vote="no"/);
  assert.match(html, /data-rf-morph="skip"[^>]*data-rf-skip=""/);
  assert.ok(html.includes(`aria-label="${message('communities:review.vote.skipLabel')}"`));
  assert.ok(html.includes(`>${message('communities:review.vote.skip')}</span>`), 'Skip, in the same type as Yes and No');
  // Skip turns the page: it is the run's skip, not a vote.
  assert.match(read('frontend/src/features/review-flow/vote-sheet.tsx'), /onClick=\{vote \? onNext : onSkip\}/);
  const css = read('public/css/app.css');
  assert.match(css, /\.rf-morph \{ position: relative; flex: none; width: 128px;/, 'Skip holds Next\'s place, at Next\'s width');
  assert.match(html, /class="rf-why rf-why-off"/, 'the room for a reason is kept, empty');
});

test('help is in the bar\'s card: Ask privately, Discussion and Try it, each opened over the page', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  for (const to of ['askq', 'talk', 'try']) assert.match(src, new RegExp(`data-rf-help="${to}" onClick=\\{\\(\\) => help\\('${to}'\\)\\}`));
  assert.match(src, /const help = \(to: SheetState\) => \{ setDesc\(false\); setSheet\(to\); \};/, 'the card folds, the sheet opens');
  assert.match(src, /t\('communities:review\.desc\.by', \{ name: item\.author \}\)/, 'who made it, from the old About');
  const vs = read('frontend/src/features/review-flow/vote-sheet.tsx');
  assert.doesNotMatch(vs, /'unsure'|'about'/, 'no help sheet and no About of its own');
  assert.match(vs, /aria-label=\{t\('communities:review\.sheet\.close'\)\} onClick=\{\(\) => setState\(rest\)\}/, 'a help sheet\'s back closes it');
  const html = sheetHtml({ state: 'talk' });
  assert.match(html, /class="rf-sheet"/);
  assert.ok(html.includes(message('communities:review.help.talk')));
});

test('after a vote the row stays: the pair shows the choice, Skip becomes Next with how many still wait', () => {
  const html = sheetHtml({ vote: 'yes', state: 'voted', left: 2 });
  assert.match(html, /data-rf-voted="yes"/);
  assert.match(html, /aria-checked="true"[^>]*data-rf-vote="yes"/);
  assert.match(html, /data-rf-morph="next"[^>]*data-rf-next=""/);
  assert.ok(html.includes(`>${message('communities:review.said.nextShort')}</span>`), 'the word, with no glyph and no chevron');
  assert.ok(html.includes(`aria-label="${message('communities:review.said.nextLeft_other').replace('{{count}}', '2')}"`));
  assert.match(html, /<span class="rf-count" data-rf-count="" aria-hidden="true">2<\/span>/, 'the number alone, no ring');
  assert.ok(html.includes(message('communities:review.said.yes')), 'said for a screen reader');
  assert.doesNotMatch(html, /data-rf-undo/, 'your own answer again takes it back');
  assert.match(sheetHtml({ vote: 'yes', state: 'voted', left: 29 }), /data-rf-count="" aria-hidden="true">29<\/span>/);
  assert.match(sheetHtml({ vote: 'yes', state: 'voted', left: 140 }), /data-rf-count="" aria-hidden="true">99\+<\/span>/, 'past 99 it says 99+');
  const css = read('public/css/app.css');
  assert.match(css, /\.rf-morph\[data-rf-morph="next"\] \{ width: 128px;/);
  // The word's size and baseline, a lighter weight, full white (contrast),
  // figures of one width so the pair holds still as it counts down.
  assert.match(css, /\.rf-count \{ font-weight: 400; font-variant-numeric: tabular-nums;/);
  assert.doesNotMatch(css, /\.rf-count \{[^}]*opacity/, 'never dimmed on the blue');
  assert.doesNotMatch(css, /\.rf-ring\b/);
  const last = sheetHtml({ vote: 'yes', state: 'voted', hasNext: false });
  assert.ok(last.includes(message('communities:review.said.done')));
  assert.doesNotMatch(last, /rf-count/, 'Done is the word alone');
  const src = read('frontend/src/features/review-flow/vote-sheet.tsx');
  assert.match(src, /if \(vote === v\) \{ void undo\(\); return; \}/);
});

test('a No asks why first: four answers and the optional line, and nothing is cast until Send', () => {
  const src = read('frontend/src/features/review-flow/vote-sheet.tsx');
  assert.match(src, /if \(v === 'yes'\) \{ setShared\(null\); void cast\(v\); return; \}\s*setChoice\(null\);\s*setLine\(''\);\s*setState\('reason'\);/,
    'a No opens the reason list instead of casting');
  const asked = sheetHtml({ state: 'reason' });
  assert.match(asked, /class="rf-sheet"[^>]*data-rf-sheet="reason"/, 'it covers the page like the help sheet');
  assert.match(asked, /class="rf-grab"/, 'with the handle that closes it, counting nothing');
  assert.ok(asked.includes(`<h2 class="rf-why-head">${message('communities:review.why.title')}</h2>`));
  assert.match(asked, /class="rf-chips" role="radiogroup"/);
  for (const key of ['notWorking', 'approach', 'notNeeded', 'other']) {
    assert.match(asked, new RegExp(`role="radio" aria-checked="false" class="rf-chip" data-rf-why-choice="${key}"`));
    assert.ok(asked.includes(message(`communities:review.why.${key}`)), key);
  }
  assert.ok(asked.includes(`<p class="rf-line">${message('communities:review.why.detailLabel')}</p>`), 'the line stays optional');
  assert.match(asked, /<input aria-label="Add more, if you like\."[^>]*maxLength="280"/);
  assert.ok(asked.includes(`<button type="submit" class="rf-go" disabled="">${message('communities:review.no.send')}</button>`),
    'Send is off until an answer is picked');
  assert.match(src, /onClick=\{\(\) => setChoice\(c\.key\)\}/, 'a chip picks the answer');
  assert.match(src, /if \(!choice\) return;/, 'nothing is sent without one');
  // The composed reason is the answer, then the line when one is written,
  // within the server's limit.
  assert.match(src, /const text = \(detail\s*\? t\('communities:review\.why\.withDetail', \{ choice: choiceText, detail \}\)\s*: choiceText\)\.slice\(0, NO_LINE_MAX\);/);
  assert.match(src, /if \(await cast\('no', text\)\) setShared\(text\);/);
  // A No this page did not cast has no known line: the link opens the sheet.
  const offered = sheetHtml({ vote: 'no', state: 'voted' });
  assert.match(offered, /data-rf-voted="no"/);
  assert.match(offered, /data-rf-why=""/);
  assert.ok(offered.includes(message('communities:review.reason.add')));
  assert.doesNotMatch(sheetHtml({ vote: 'yes', state: 'voted' }), /data-rf-why=""/, 'a Yes is not asked why');
});

// ── 4. The copy ──────────────────────────────────────────────────────────

test('every message the flow asks for exists in English', () => {
  const dir = 'frontend/src/features/review-flow/';
  const ids = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    const src = read(dir + f);
    for (const m of src.matchAll(/'((?:communities|settings):[a-zA-Z0-9_.]+)'/g)) ids.add(m[1]);
  }
  assert.ok(ids.size > 40, `found ${ids.size} ids`);
  const has = (id) => { try { return !!message(id); } catch { return false; } };
  for (const id of ids) {
    // A message read with a count is written as its _one/_other pair.
    assert.ok(has(id) || (has(`${id}_one`) && has(`${id}_other`)), `missing ${id}`);
  }
});

test('a vote taken back leaves the saved-vote store, so no screen keeps it answered', () => {
  const cards = loadTsx('frontend/src/features/dev-board/card/cards-store.ts');
  cards.publishVoteSaved(9001, 'yes', 4);
  assert.equal(cards.voteSavedStore.get()['9001'].vote, 'yes');
  cards.publishVoteSaved(9001, null, 4);
  assert.equal('9001' in cards.voteSavedStore.get(), false);
  const before = cards.voteSavedStore.get();
  cards.publishVoteSaved(9002, null, null);
  assert.equal(cards.voteSavedStore.get(), before, 'nothing to forget: the store is untouched');
});

// ── 5. A picture for every card, a short line, changes first ──────────

test('every item gets a picture: shots, a pair, a drawn benefit or a drawn decision', () => {
  const shape = (v, shots) => (shots && shots.screens ? { screens: shots.screens } : null);
  const items = model.toReviewItems([
    feedItem({ id: 1, shots: { screens: [SCREEN] } }),
    feedItem({ id: 2, title: 'Fix the invite link that never opened', shots: null }),
    feedItem({ id: 3, kind: 'governance', shots: null, decision: { kind: 'close_issue', issueNumber: 5 } }),
    feedItem({ id: 4, kind: 'governance', shots: null, decision: { kind: 'something_new' } }),
    feedItem({ id: 5, shots: { claims: [], benefit: { kind: 'speed', area: 'messages', before: '85 KB', after: '46 KB' } } }),
    feedItem({ id: 6, shots: null, benefit: { kind: 'security', area: 'accounts' } }),
  ], shape);
  assert.deepEqual(items.pop().picture, { kind: 'benefit', benefit: 'security', area: 'accounts', token: null }, 'the feed row\'s own benefit counts too');
  assert.deepEqual(items.map((i) => i.picture.kind), ['shots', 'benefit', 'decision', 'decision', 'benefit']);
  assert.equal(items[1].picture.benefit, 'fixed');
  assert.equal(items[2].picture.decision, 'close_issue');
  assert.equal(items[3].picture.decision, 'decision', 'an unknown decision kind is drawn as a group decision');
  assert.deepEqual(items[4].picture, { kind: 'benefit', benefit: 'speed', area: 'messages', token: { before: '85 KB', after: '46 KB' } }, 'a declared benefit wins over the guess');
  for (const i of items) assert.match(i.ground, /^#[0-9A-F]{6}$/i);
});

test('the benefit is read from the title first, the summary only for work nobody sees', () => {
  const g = model.guessBenefit;
  assert.equal(g('Make the deferred tap-save tests run on mock timers'), 'behind');
  assert.equal(g('Add a one-tap light/dark switch to the top bar'), 'effort');
  assert.equal(g('Usage analytics are off by default, with a Share usage analytics switch'), 'security');
  assert.equal(g('Add rest timer to Gym Tracker'), 'more', '"Tracker" in a name is not privacy');
  assert.equal(g('Stop the rest timer when you go back from a workout'), 'fixed');
  assert.equal(g('Explain retry limit with last deploy error in Build log panel'), 'clarity');
  assert.equal(g('Polish the home lobby'), 'results');
  assert.equal(g('Category', 'Nothing in the game changes.'), 'behind');
  assert.equal(g('Category'), 'more');
});

test('the area is the project for an app, and named for Homeroom itself', () => {
  assert.equal(model.guessArea('Add a timer', 'gym-tracker-1'), 'app');
  assert.equal(model.guessArea('The Mayor answers in threads', model.PLATFORM_SLUG), 'agents');
  assert.equal(model.guessArea('Votes show at once', model.PLATFORM_SLUG), 'proposals');
  assert.equal(model.guessArea('Something else', model.PLATFORM_SLUG), 'platform');
});

test('the change line is the first declared change, else the first sentence, never a wall', () => {
  assert.equal(model.changeLine('A link nobody used says so.', 'Long summary. More.'), 'A link nobody used says so.');
  assert.equal(model.changeLine('', 'What changes for people Nothing in the game changes. The tests do.'), 'Nothing in the game changes.');
  const long = model.changeLine('', 'word '.repeat(80));
  assert.ok(long.length <= 141 && long.endsWith('…'), long);
  assert.equal(model.cleanTitle('implement this change in the app: TITLE: Add comments'), 'Add comments');
});

test('changes come first, group decisions after', () => {
  const order = model.orderForReview([{ key: 'g1', kind: 'governance' }, { key: 'p1', kind: 'proposal' }, { key: 'g2', kind: 'governance' }, { key: 'p2', kind: 'proposal' }]);
  assert.deepEqual(order.map((i) => i.key), ['p1', 'p2', 'g1', 'g2']);
});

test('the title shot zooms in on the biggest change, not every change at once', () => {
  const busy = { ...SCREEN, regions: [{ n: 1, a: [10, 10, 40, 20], b: null }, { n: 2, a: [20, 600, 300, 120], b: null }] };
  assert.deepEqual(model.largestRegion(busy), { x: 20, y: 600, w: 300, h: 120 });
  const crop = model.titleCrop(busy, { w: 300, h: 200 });
  assert.ok(crop.place.ty < -400, 'it moves to the big change far down the screen');
});

test('a project\'s Needs you draws the same flow when the switch is on', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(src, /const reviewFlow = useReviewFlowEnabled\(\);/);
  assert.match(src, /tab === 'needs' && reviewFlow && slug \? \([\s\S]*?<ProjectReviewFlow slug=\{slug\}/);
  const flow = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(flow, /export function ProjectReviewFlow\(/);
  assert.match(flow, /all\.filter\(\(it\) => it\.app && it\.app\.slug === slug\)/);
});


// ── 6. The title shot's composition (the prototype's rules) ─────────────

const CARD = { w: 358, h: 268 };
function screenWith(regions, over = {}) {
  return { viewport: 'phone', width: 390, before: { url: 'b.png', height: 844 }, after: { url: 'a.png', height: 844 }, regions, ...over };
}

test('one change: 62% of the binding side, or real size when it fits, centred at 48%, never past the captured pixels', () => {
  // A small control (60x30): real size fits, so it is not blown up past 1x.
  const small = model.composeTitle(model.piecesOf([screenWith([{ n: 1, a: [100, 200, 60, 30], b: null }])]), CARD, '#ECE6CE');
  assert.equal(small.rule, 'single');
  const p = small.plates[0];
  assert.ok(Math.abs(p.img.width - 390) < 0.5, 'shown at 1x: the still has one pixel per point');
  assert.ok(Math.abs((p.y + p.h / 2) - CARD.h * 0.48) < 0.5, 'centred 48% down');
  // A wide section (370x300): framed at 62% of the binding side.
  const big = model.composeTitle(model.piecesOf([screenWith([{ n: 1, a: [10, 100, 370, 300], b: null }])]), CARD, '#ECE6CE');
  const q = big.plates[0];
  assert.ok(q.w <= CARD.w * 0.92 + 0.5 && q.h <= CARD.h * 0.92 + 0.5, 'inside the wide allowance');
  assert.ok(Math.max(q.w / CARD.w, q.h / CARD.h) >= 0.62 - 0.01, 'binding side at least 62%');
});

test('a thin strip gets real context, never a sliver', () => {
  const [piece] = model.piecesOf([screenWith([{ n: 1, a: [0, 400, 390, 20], b: null }])]);
  assert.ok(piece.box.w / piece.box.h <= 3.3, `strip widened to ${piece.box.w}x${piece.box.h}`);
});

test('noise is dropped and near areas are one piece', () => {
  const pieces = model.piecesOf([screenWith([
    { n: 1, a: [20, 100, 200, 60], b: null },
    { n: 1, a: [20, 170, 200, 40], b: null },
    { n: 0, a: [300, 700, 10, 10], b: null },
  ])]);
  assert.equal(pieces.length, 1, 'the two named areas 10px apart merge; the unnamed speck goes');
});

test('two to four changes: a grid at one common scale; too small becomes a deck', () => {
  const two = model.composeTitle(model.piecesOf([screenWith([{ n: 1, a: [20, 100, 160, 60], b: null }, { n: 2, a: [20, 500, 160, 60], b: null }])]), CARD, '#F7E07A');
  assert.equal(two.rule, 'grid');
  assert.equal(two.plates.length, 2);
  assert.ok(Math.abs(two.plates[0].img.width - two.plates[1].img.width) < 0.01, 'one common scale');
  const many = model.composeTitle(model.piecesOf([1, 2, 3, 4, 5].map(() => null).map((_, i) => screenWith([{ n: 1, a: [10, 50, 370, 300], b: null }], { after: { url: `s${i}.png`, height: 844 } }))), CARD, '#F2958A');
  assert.equal(many.rule, 'deck');
  assert.equal(many.plates.length, 4, 'a lead and three back plates at most');
  assert.ok(many.plates.slice(1).every((p) => p.img === null && /^#[0-9a-f]{6}$/.test(p.fill)), 'back plates are plain tones');
  assert.ok(many.plates[1].w < many.plates[0].w && many.plates[2].w < many.plates[1].w, 'each back plate narrower');
});

test('a still is never shown larger than its saved pixels allow on the display', () => {
  const at = (density, display) => model.densityOf({ ...SCREEN, density }, display);
  assert.equal(at(undefined, 3), 1, 'a 1x still keeps today\'s size');
  assert.equal(at(3, 3), 1);
  assert.equal(at(3, 2), 1.5);
  assert.equal(at(8.2, 2), 4.1);
  const view = read('public/js/app-view.js');
  assert.match(view, /const density = Number\(screen\.density\) >= 1 \? Number\(screen\.density\) : 1;/);
});

test('transitions end on their last frame, with a timer only as rescue', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(src, /whenDone\(opening, \(\) => settle\(k\), OPEN_MS\)/, 'a screen opening from its plate');
  assert.match(src, /whenDone\(closing, done, CLOSE_MS\)/, 'and back onto it');
  assert.match(src, /whenDone\(sliding, end, OPEN_MS\)/, 'from tile to tile');
  assert.match(src, /whenDone\(sliding, settle, PUSH_MS\)/, 'Next\'s push');
  assert.match(src, /later\(once, ms \+ 1500\)/);
});
// ── 6b. The sheet, the strip and an opened screen ───────────────────────

const sheetScreen = (regions, extra = {}) => ({
  viewport: 'phone', width: 390, density: 1,
  before: { url: 'b.png', height: 844 }, after: { url: 'a.png', height: 844 },
  regions, ...extra,
});

test('a row the change only pushed along is not what it changed; a removed part keeps its place', () => {
  const moved = { n: 1, b: [16, 212, 357, 17], a: [16, 239, 357, 18] };
  const line = { n: 1, b: null, a: [111, 180, 170, 18], bMark: [111, 180, 170] };
  assert.equal(model.onlyMoved(moved), true, 'the same size, somewhere else');
  assert.equal(model.onlyMoved(line), false, 'new on the after side');
  assert.equal(model.onlyMoved({ n: 1, b: [10, 10, 50, 20], a: [10, 10, 50, 20] }), false, 'changed in place');
  assert.deepEqual(model.changedRegions(sheetScreen([moved, line])), [line]);
  // A part the change took away keeps only a mark line after; its box is where it was.
  const removed = { n: 1, b: [29, 378, 332, 212], a: null, aMark: [37, 521, 65] };
  assert.deepEqual(model.afterBox(removed), { x: 29, y: 378, w: 332, h: 212 });
  // The title piece is built from the same rule, so it never frames a row that only moved.
  const [piece] = model.piecesOf([sheetScreen([moved, line])]);
  assert.equal(piece.box.x, 111);
});

test('the sheet has one plate per screen at one scale, stacked or two to a row, never a deck', () => {
  const wide = sheetScreen([{ n: 1, a: [16, 300, 358, 60], b: [16, 300, 358, 60] }]);
  const three = model.composeSheet([wide, wide, wide], { w: 351, h: 368 });
  assert.equal(three.length, 3, 'every screen can be tapped');
  assert.deepEqual(three.map((p) => p.screen), [0, 1, 2]);
  assert.ok(three.every((p) => Math.abs(p.s - three[0].s) < 1e-9), 'one scale');
  assert.ok(three[1].y > three[0].y + three[0].h - 1, 'stacked, in order');
  assert.ok(three.every((p) => p.x >= 0 && p.x + p.w <= 351 + 1e-6 && p.y >= 0 && p.y + p.h <= 368 + 1e-6), 'inside the picture');
  assert.ok(three.every((p) => p.s <= 1 + 1e-9), 'a 1x still is never drawn larger than itself');
  // Tall, narrow changes would be cut to slivers in a stack: they sit two to a row, whole.
  const narrow = sheetScreen([{ n: 1, a: [20, 300, 120, 200], b: [20, 300, 120, 200] }], { density: 3 });
  const pairs = model.composeSheet([narrow, narrow, narrow], { w: 351, h: 368 }, 3);
  assert.ok(pairs[1].x > pairs[0].x, 'two to a row');
  assert.ok(pairs.every((p) => p.box.y <= 300 && p.box.y + p.box.h >= 500), 'each change whole in its plate');
});

test('crops end on blank rows, and never cut into the change', () => {
  // A still read at one sample per point: a flat ground with text rows at 100-110 and 140-150.
  const w = 390; const h = 844;
  const lum = new Uint8Array(w * h).fill(240);
  const text = (y0, y1) => { for (let y = y0; y < y1; y++) for (let x = 20; x < 300; x += 3) lum[y * w + x] = 20; };
  text(100, 110); text(140, 150);
  const ink = { w, h, lum };
  const snapped = model.snapRows({ x: 0, y: 105, w: 390, h: 60 }, ink, { x: 20, y: 140, w: 280, h: 10 }, 120);
  assert.ok(snapped.y <= 100 || (snapped.y >= 110 && snapped.y <= 140), 'the top is on a blank row');
  assert.ok(snapped.y <= 140 && snapped.y + snapped.h >= 150, 'the change stays whole');
  assert.deepEqual(model.snapRows({ x: 0, y: 105, w: 390, h: 60 }, null, null, 120), { x: 0, y: 105, w: 390, h: 60 }, 'without the still, as computed');
});

test('an opened screen is framed on its declared change, at real size at most', () => {
  const s = sheetScreen([
    { n: 1, b: null, a: [111, 180, 170, 18], bMark: [111, 180, 170] },
    { n: 0, b: [16, 212, 357, 17], a: [16, 239, 357, 18] },
    { n: 0, b: [35, 700, 321, 47], a: [35, 727, 321, 47] },
  ], { density: 3 });
  const { place, cut } = model.openPlace(s, { w: 351, h: 360 }, 3);
  assert.equal(place.scale, 1, 'a 3x still on a 3x screen: real size, not the whole screen shrunk');
  assert.ok(cut && cut.y >= 175 && cut.y <= 185, 'the dim\'s hole is the declared change');
  // A tile is a square round where that change starts.
  const tile = model.tileCrop(s, 64, 3);
  assert.ok(tile.scale > 0 && tile.scale <= 1);
  assert.ok(-tile.ty / tile.scale <= 180 && -tile.ty / tile.scale + 64 / tile.scale >= 198, 'the change is inside the tile');
});

// ── 7. A wide window ─────────────────────────────────────────────────────

test('on a wide window the run is one column as wide as the page', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  const css = read('public/css/app.css');
  const cap = Number((src.match(/^const COLUMN = (\d+);$/m) || [])[1]);
  assert.equal(cap, 520, 'the change page\'s own width');
  assert.match(src, /setSize\(\{ w: Math\.min\(COLUMN, pr\.width\), h \}\)/);
  assert.doesNotMatch(src, /Math\.min\(520\b/, 'one number, not two copies of it');
  const col = css.match(/\.rf-run, \.rf-feed-note \{([^}]*)\}/);
  assert.ok(col, 'the run\'s pane and its notes share one column rule');
  assert.match(col[1], new RegExp(`max-width: ${cap}px;`));
  assert.match(col[1], /margin-left: auto; margin-right: auto;/);
  assert.match(css, new RegExp(`\\.rf-page \\{[^}]*left: max\\(0px, calc\\(50% - ${cap / 2}px\\)\\); width: min\\(100%, ${cap}px\\);`));
  assert.match(src, /<p className="rf-feed-note [^"]*" data-needs-error="">/);
  assert.match(src, /data-needs-empty="" data-review-flow="">/);
  assert.match(src, /<div ref=\{anchorRef\} className="rf-run rf-loading" data-review-flow=""/);
});
test('a small change inside a close-up is drawn from it, big and sharp; without one it keeps the still\'s size', () => {
  const small = { ...SCREEN, regions: [{ n: 1, b: [100, 300, 50, 20], a: [100, 300, 50, 20] }] };
  const card = { w: 358, h: 358 };
  const plain = model.composeTitle(model.piecesOf([small]), card, '#ffffff').plates[0];
  assert.equal(plain.img.url, small.after.url);
  assert.ok(Math.abs(plain.w / 82 - 1) < 1e-6, 'a 1x still is never shown larger than itself');
  const closeup = { url: `/api/apps/a/proposals/1/shots/${'c'.repeat(32)}?density=device`, rect: { x: 80, y: 260, w: 100, h: 100 }, density: 8.2 };
  const sharp = model.composeTitle(model.piecesOf([{ ...small, closeups: [closeup] }]), card, '#ffffff').plates[0];
  assert.equal(sharp.img.url, closeup.url);
  const s = sharp.w / 82;
  assert.ok(s > 2.4 && s < 2.6, `the piece takes its 62% of the card (${s})`);
  assert.equal(Math.round(sharp.img.width), Math.round(100 * s), 'the close-up is laid out at the plate\'s scale');
  assert.equal(Math.round(sharp.img.left), Math.round((80 - 84) * s));
  // On a 3x display the same close-up allows 8.2 / 3 = 2.7x.
  assert.ok(model.pieceDensity({ screen: { ...small, closeups: [closeup] }, box: { x: 100, y: 282, w: 50, h: 56 } }, { x: 84, y: 266, w: 82, h: 88 }, 3) > 2.7);
  // A close-up that does not hold the whole plate is not used.
  const elsewhere = { ...closeup, rect: { x: 200, y: 260, w: 100, h: 100 } };
  assert.equal(model.composeTitle(model.piecesOf([{ ...small, closeups: [elsewhere] }]), card, '#ffffff').plates[0].img.url, small.after.url);
});

test('_workshopVisuals passes a screen\'s close-ups through, and only valid ones', () => {
  const src = read('public/js/app-view.js');
  assert.match(src, /a\.variant === 'closeup' && a\.side === 'head' && a\.media === 'png'\s*&& a\.storyId === screen\.shot && a\.viewport === screen\.viewport && urlOk\(a\.url\)/);
  assert.match(src, /Number\(a\.density\) > 1/);
});

test('from 768px the change page is a panel under the header, its vote sheet at its foot, the pane dimmed behind it', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  const css = read('public/css/app.css');
  const at = css.indexOf('.rf-page-dim { display: none; }');
  assert.ok(at > 0, 'the dim is drawn on a wide window only');
  // After the sheet's own rules, so the panel's foot overrides them at equal specificity.
  assert.ok(at > css.indexOf('\n.rf-sheet {'), 'the panel block follows the sheet\'s rules');
  const block = css.slice(at, css.indexOf('\n}\n', at) + 3);
  assert.match(block, /@media \(min-width: 768px\) \{/, 'a phone keeps the full page');
  // Under the app's header, measured by the shell's own tokens, never over it.
  assert.match(block, /\.rf-page-wrap \{\s*top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top, 0px\)\);/);
  assert.match(block, /--rf-room: calc\(100dvh - var\(--browser-banner-h, 0px\) - var\(--platform-header-h\) - var\(--platform-safe-top, 0px\) - var\(--platform-tabs-h, 0px\) - 32px\);/, '16px clear above and below');
  // A rounded panel as tall as what it holds, up to the room; the stage scrolls past it.
  assert.match(block, /\.rf-page \{ top: 16px; bottom: auto; max-height: var\(--rf-room\); border-radius: 20px; box-shadow: 0 0 0 1px var\(--rf-line\), [^;]+; \}/);
  assert.match(block, /\.rf-stage \{ flex: 0 1 auto; \}/);
  // The vote sheet is the panel's foot, not a sheet pinned to the window.
  assert.match(block, /\.rf-sheet \{ max-height: calc\(var\(--rf-room\) - 52px\); border-radius: 0; box-shadow: inset 0 1px 0 var\(--rf-line\); \}/);
  // The pane behind is dimmed, and a click on it is Back.
  assert.match(block, /\.rf-page-dim \{ display: block; position: absolute; inset: 0; [^}]*pointer-events: auto; \}/);
  assert.match(src, /<div ref=\{dimRef\} className="rf-page-dim" onClick=\{onDone\} aria-hidden="true" \/>\s*<div ref=\{pageRef\} className="rf-page"/);
  assert.match(src, /dimRef\.current\?\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1 \}\], \{ duration: OPEN_MS, easing: EASE \}\)/, 'the dim fades in as the run comes up');
});
