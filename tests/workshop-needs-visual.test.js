'use strict';

// The Needs-you card as a reel: the picture fills it (the run's own outlined
// screen first), and over its foot the caption — who, the title, the summary
// in two lines with a "more", the facts as one line. "more" (and D) grows the
// caption over the picture with what the card leaves out; Comments and Ask
// share one sheet, a panel beside the card on a wide window.
//
// Run with: node --test tests/workshop-needs-visual.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AppView = require('../public/js/app-view.js');
const { message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const APP_VIEW = read('public/js/app-view.js');
const CSS = read('public/css/app.css');

/** The text between two markers, the first occurrence. */
function body(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `missing ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b >= 0, `missing end of ${start}`);
  return src.slice(a, b);
}

const id = (char) => char.repeat(32);
const url = (char) => `/api/apps/demo/proposals/42/shots/${id(char)}`;
const context = (storyId, viewport, side, char, width, height) => ({
  id: id(char), storyId, viewport, side, variant: 'context', media: 'png', url: url(char), width, height,
});

function shots(overrides = {}) {
  return {
    state: 'verified',
    claims: [
      { id: 'well', claim: 'The menu has one full-width button.', viewports: ['desktop', 'phone'] },
      { id: 'list', claim: 'The session list is headed "Agent sessions".', viewports: ['desktop', 'phone'] },
    ],
    artifacts: [
      context('well', 'desktop', 'base', '1', 1280, 800), context('well', 'desktop', 'head', '2', 1280, 800),
      context('well', 'phone', 'base', '3', 390, 844), context('well', 'phone', 'head', '4', 390, 844),
    ],
    screens: [
      {
        viewport: 'desktop', shot: 'well', stories: ['well', 'list'], width: 1280, heightBefore: 800, heightAfter: 800,
        regions: [
          { story: 'well', b: [880, 83, 382, 48], a: [896, 87, 350, 36], bMark: null, aMark: null },
          { story: 'list', b: null, a: [875, 351, 392, 126], bMark: [875, 353, 392], aMark: null },
        ],
      },
      {
        viewport: 'phone', shot: 'well', stories: ['well'], width: 390, heightBefore: 844, heightAfter: 844,
        regions: [
          { story: 'well', b: [0, 556, 390, 48], a: [16, 479, 358, 37], bMark: null, aMark: null },
          { story: null, b: [0, 426, 390, 117], a: [0, 426, 390, 36], bMark: null, aMark: null },
        ],
      },
      // A screen whose shots this card does not have is never offered.
      { viewport: 'tablet', shot: 'list', stories: ['list'], width: 800, heightBefore: 600, heightAfter: 600, regions: [] },
    ],
    ...overrides,
  };
}

test('the feed picture carries the run\'s own screens, numbered as the changes are', () => {
  const v = AppView._workshopVisuals(null, shots());
  assert.equal(v.protected, true);
  assert.deepEqual(v.changes, [
    { n: 1, text: 'The menu has one full-width button.' },
    { n: 2, text: 'The session list is headed "Agent sessions".' },
  ]);
  assert.deepEqual(v.screens.map((s) => s.viewport), ['desktop', 'phone']);
  const [desktop, phone] = v.screens;
  assert.deepEqual(desktop.before, { url: url('1'), height: 800 });
  assert.deepEqual(desktop.after, { url: url('2'), height: 800 });
  assert.equal(desktop.width, 1280);
  assert.deepEqual(desktop.changes, [1, 2]);
  assert.deepEqual(desktop.regions, [
    { n: 1, b: [880, 83, 382, 48], a: [896, 87, 350, 36], bMark: null, aMark: null },
    { n: 2, b: null, a: [875, 351, 392, 126], bMark: [875, 353, 392], aMark: null },
  ]);
  assert.deepEqual(phone.changes, [1]);
  assert.equal(phone.regions[1].n, 0, 'a difference no change accounts for keeps no number');
  // The old fields are still there for the legacy picture and the full view.
  assert.equal(v.after, url('2'));
  // A run from before its screens were worked out has none, and the feed
  // falls back to the picture it always drew.
  assert.deepEqual(AppView._workshopVisuals(null, shots({ screens: undefined })).screens, []);
  assert.equal(AppView._workshopVisuals(null, shots({ state: 'failed' })), null);
});

test('each owed row carries its description, rendered where the page renders it', () => {
  assert.match(APP_VIEW, /descriptionHtml: x\.kind === 'proposal' \? AppView\._proposalSummaryHtml\(x\.item\) : '',/);
  // Requests are not in the feed, so neither is an issue's body.
  assert.doesNotMatch(APP_VIEW, /descriptionHtml: e\.item && e\.item\.body/);
});

test('the picture leads and the caption over it reads who, the title, the summary and one line of facts', () => {
  const item = body(WORKSHOP, 'const FeedItem = memo(function FeedItem(', '\n});\n');
  // The picture first, then the scrim, then the caption laid over its foot.
  const order = ['<ShotsPicture', 'className="dev-ws-item-scrim"', 'className="dev-ws-item-caption"'];
  const at = order.map((s) => item.indexOf(s));
  assert.ok(at.every((x) => x >= 0) && at[0] < at[1] && at[1] < at[2], 'picture, scrim, caption');
  const caption = item.slice(item.indexOf('className="dev-ws-item-caption"'));
  const parts = ['<ItemBy row={row} />', 'className="dev-ws-item-title"', "'dev-ws-item-summary-text'", '<FactsLine facts={facts} />'];
  const pos = parts.map((s) => caption.indexOf(s));
  assert.ok(pos.every((x) => x >= 0) && pos.every((x, k) => k === 0 || x > pos[k - 1]), 'who, the title, the summary, the facts');
  // The summary is there whatever the picture is, two lines with its "more".
  assert.match(item, /const shots = !!\(row\.visuals && row\.visuals\.screens && row\.visuals\.screens\.length\);/);
  assert.match(item, /\{shots && row\.visuals \? <ShotsPicture v=\{row\.visuals\} near=\{near\} wide=\{wide\} \/>/);
  assert.match(CSS, /\.dev-ws-item-summary-text \{[^}]*-webkit-line-clamp: 2;/);
  assert.match(item, /data-ws-more="" aria-expanded=\{false\} onClick=\{onMore\}/);
  assert.equal(message('project:needsYou.caption.more'), 'more');
  // The facts are one line, set apart from the vote's words on a wide window.
  assert.match(WORKSHOP, /<p className="dev-ws-item-facts" data-ws-facts="">/);
  assert.doesNotMatch(item, /dev-ws-item-chips|onDescribe/, 'no row of chips, and no Description sheet to open');
  const facts = body(WORKSHOP, 'function factsFor(', '\n}\n');
  const tally = facts.indexOf("key: 'tally'");
  assert.ok(tally >= 0 && tally < facts.indexOf("key: 'last'") && facts.indexOf("key: 'last'") < facts.indexOf("key: 'state'"),
    'where the vote stands comes first, then "your yes puts it live", then the status');
  // "your yes puts it live" only when exactly one more Yes meets the rule,
  // and only once the viewer has not answered.
  assert.match(facts, /if \(!voted && lastYes\(row\)\) out\.push\(\{ key: 'last'/);
  assert.equal(message('project:needsYou.fact.yourYesPutsItLive'), 'your yes puts it live');
  assert.match(APP_VIEW, /_yesPutsItLive\(pr\) \{[\s\S]*?if \(pr\.approval_policy === 'invited'\) return false;[\s\S]*?return !!st && st\.majority - st\.yes === 1;/);
  assert.match(APP_VIEW, /\.\.\.\(x\.kind === 'proposal' && AppView\._yesPutsItLive\(x\.item\) \? \{ lastYes: true \} : \{\}\),/);
});


test('the switch sits above the picture, never on it', () => {
  const legacy = body(WORKSHOP, 'function BeforeAfter(', '\n}\n');
  assert.ok(legacy.indexOf('dev-ws-media-bar') < legacy.indexOf('dev-ws-media-view'), 'the bar leads the legacy picture');
  const shotsPic = body(WORKSHOP, 'function ShotsPicture(', '\n}\n');
  assert.ok(shotsPic.indexOf('dev-ws-media-bar') < shotsPic.indexOf('className="dev-ws-media-view"'));
  assert.match(shotsPic, /<span className="dev-ws-media-size">\{size\}<\/span>/);
  const rule = (sel) => {
    const m = new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS);
    assert.ok(m, `rule ${sel}`);
    return m[1];
  };
  assert.doesNotMatch(rule('.dev-ws-seg'), /position: absolute/);
  assert.doesNotMatch(rule('.dev-ws-media-full'), /position: absolute/);
  assert.match(rule('.dev-ws-media-bar'), /margin: 0 14px 8px;/, 'the picture runs edge to edge under it');
  // The facts wrap to a second line rather than losing their end (the topic
  // is last), at every width.
  assert.match(rule('.dev-ws-item-facts'), /white-space: normal; overflow-wrap: anywhere;/);
  assert.doesNotMatch(rule('.dev-ws-item-facts'), /nowrap|text-overflow|overflow: hidden/);
  const wideBlock = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS)[1];
  assert.doesNotMatch(wideBlock, /\.dev-ws-item-facts[^{]*\{[^}]*(nowrap|text-overflow)/, 'nor on a wide window');
});

test('the picture is the reader\'s own screen size, cropped to the run\'s outlines', () => {
  const pick = body(WORKSHOP, 'function pickScreen(', '\n}\n');
  assert.match(pick, /screens\.find\(\(s\) => \(wide \? !isPhoneScreen\(s\) : isPhoneScreen\(s\)\)\) \|\| screens\[0\] \|\| null/);
  const shotsPic = body(WORKSHOP, 'function ShotsPicture(', '\n}\n');
  // The crop covers both sides' outlines, so a flip never moves it.
  assert.match(shotsPic, /screen\.regions\.flatMap\(\(r\) => \[regionRect\(r, 'before'\), regionRect\(r, 'after'\)\]\)/);
  // Nothing loads for an item far from view.
  assert.match(shotsPic, /\{near && place \? <img src=\{shot\.url\}/);
  // Tapping the picture flips it, from the keyboard too.
  assert.match(shotsPic, /onClick=\{flip\}/);
  assert.match(shotsPic, /if \(e\.key === ' ' \|\| e\.key === 'Enter'\) \{ e\.preventDefault\(\); flip\(\); \}/);
  // The changes its numbers stand for are the caption's "more", not a list
  // under the picture, which the caption lies over now.
  assert.doesNotMatch(shotsPic, /dev-ws-shot-changes/);
  assert.match(WORKSHOP, /const changes = row\.visuals && row\.visuals\.changes \? row\.visuals\.changes : \[\];/);
});


test('#5394: the card is in the page\'s scheme, and the by-line reads in its ink', () => {
  // The avatar ring is the card's own plane colour, so it reads over the
  // picture in either theme.
  assert.match(CSS, /\n\.dev-ws-item-caption \.dev-ws-item-avatar \{ box-shadow: 0 0 0 2px var\(--dc-sheet-solid\); \}/);
  // The card redefines no token: everything inside reads the theme's own
  // values, drawn as GroupedList draws its cards -- the plane fill and the
  // one hairline.
  const itemRule = /\n\.dev-ws-item:not\(\.dev-ws-needs-done\) \{([^}]*)\}/.exec(CSS);
  assert.ok(itemRule, 'the needs item rule');
  assert.doesNotMatch(itemRule[1], /--[\w-]+:/, 'no custom property is redefined');
  assert.match(itemRule[1], /background-color: var\(--dc-sheet-solid\);/);
  assert.match(itemRule[1], /box-shadow: inset 0 0 0 1px var\(--app-sheet-line\);/);
  // The tint pair stays on the cards in markup (it feeds .dev-topic-hero
  // elsewhere) but draws no gradient of its own here.
  assert.doesNotMatch(CSS, /\.dev-ws-item\[data-ws-tint=/);
  const itemRules = CSS.slice(CSS.indexOf('.dev-ws-item:not(.dev-ws-needs-done)'), CSS.indexOf('.dev-ws-needs-stage'));
  assert.ok(!itemRules.includes('#14171f'), 'no forced dark ground in the item rules');
  // The eyebrow is the section label: small caps at 12px, tracked .06em,
  // in the muted ink.
  assert.match(CSS, /\.dev-ws-item-top > \.dev-ws-eyebrow \{ font-size: 12px; font-weight: 700; letter-spacing: \.06em; color: var\(--text-muted\);/);
  // The rail's discs are solid in the card's colour with the hairline and a
  // small drop, so they read over any screenshot (#5298).
  assert.match(CSS, /\n\.dev-ws-rail-ic \{\n  width: 44px; height: 44px; border-radius: 9999px;\n  display: grid; place-items: center;\n  background-color: var\(--dc-sheet-solid\);\n  color: var\(--text-primary\);\n  box-shadow: inset 0 0 0 1px var\(--app-sheet-line\), 0 1px 3px rgba\(0, 0, 0, \.12\);\n\}/);
});

test('#5039: the caption\'s words sit on a solid panel of the card\'s own colour', () => {
  // Every pictured card gets it; a pictureless card, where the words fill
  // the card and nothing sits behind them, does not.
  assert.match(CSS, /\n\.dev-ws-item:not\(\[data-ws-picture="none"\]\) > \.dev-ws-item-caption \{\n  padding: 10px 12px; border-radius: 16px;\n  background: var\(--dc-sheet-solid\);\n  box-shadow: inset 0 0 0 1px var\(--app-sheet-line\);\n\}/);
  assert.ok(!CSS.slice(CSS.indexOf('.dev-ws-item:not([data-ws-picture="none"]) > .dev-ws-item-caption'), CSS.indexOf('.dev-ws-item[data-ws-picture="none"] > .dev-ws-item-caption > :first-child')).includes('rgba(20, 23, 31'), 'no dark glass panel');
});

test('a long URL or word in a card\'s title or its changes wraps instead of widening the caption', () => {
  const rule = (sel) => {
    const m = new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS);
    assert.ok(m, `rule ${sel}`);
    return m[1];
  };
  assert.match(rule('.dev-ws-item-title'), /overflow-wrap: anywhere;/, 'an opened title wraps rather than running over the rail');
  // The change rows sit in a grid column and are flex rows: both the row and
  // its words may shrink, and the words wrap at any point.
  assert.match(rule('.dev-ws-shot-change'), /min-width: 0;/);
  assert.match(rule('.dev-ws-shot-change > :not(.dev-ws-shot-n)'), /^ min-width: 0; overflow-wrap: anywhere; $/);
  assert.match(WORKSHOP, /<li key=\{c\.n\} className="dev-ws-shot-change">\s*<span className="dev-ws-shot-n">\{c\.n\}<\/span>\s*<span>\{c\.text\}<\/span>/, 'the words are the row\'s only other child');
});
