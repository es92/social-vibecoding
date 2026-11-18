'use strict';

// #3663 — "All communities" in "Your communities" wears the Communities tab's
// own glyph, not a dark tile.
//
// The switcher behind the header's community name leads with All
// communities. Its tile was filled near-black with a white people glyph, and
// the same list holds Homeroom's own community, whose icon is a cream H on
// near-black: two dark squares in one list, the first reading as a second
// Homeroom. The owner asked for the tab's people glyph in a square ring
// there instead. The tab itself wore that ring too until it became a plain
// door to its page (18 Nov 2026): it draws the glyph alone now, as every tab
// draws its own, and the ring is the switcher's.
//
// Pinned, each a way the two can drift apart again:
//
//   1. THE SAME GLYPH. The switcher's All tile draws the very icon the
//      Communities tab draws, path for path.
//   2. A RING, NOT A FILL. The tile is transparent with a 2px inset ring in
//      the ink it sits in; no colour of its own, so it follows the theme,
//      and no dark fill in either theme.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CSS = read('public/css/app.css');

const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });

function switcherAllTile() {
  const real = loadTsx('frontend/src/features/workshop/community-scope.ts');
  const mod = loadTsx('frontend/src/features/workshop/community-switcher.tsx', {
    stubs: {
      './community-scope': {
        ...real,
        communityScopeStore: fixedStore({ slug: null, info: {}, list: [], totalNeeds: 0, switcher: 'header', anchor: null }),
      },
    },
  });
  const html = renderToHtml(createElement(mod.SwitcherBody, {}));
  const row = html.match(/<button[^>]*data-switcher-community="all"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(row, 'the All communities row renders');
  const tile = row[0].match(/<span class="community-switcher-tile community-switcher-tile-all" aria-hidden="true">([\s\S]*?)<\/span>/);
  assert.ok(tile, 'with its tile first');
  return tile[1];
}

function tabGlyph() {
  const ui = loadTsx('tests/fixtures/tab-bar-api.ts');
  const html = renderToHtml(createElement(ui.PlatformTabs, {}));
  const at = html.indexOf('id="platform-tab-workshop"');
  assert.ok(at > 0, 'the Communities tab renders (the prerender)');
  const tab = html.slice(at, html.indexOf('</a>', at));
  const glyph = tab.match(/<span class="platform-tab-mark">(<svg[\s\S]*?<\/svg>)/);
  assert.ok(glyph, 'with its glyph first in its mark');
  return glyph[1];
}

const pathsOf = (svg) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
const ruleFor = (selector) => {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `${selector} has a rule`);
  return CSS.slice(at, CSS.indexOf('}', at));
};

// ── 1. The same glyph ─────────────────────────────────────────────────

test('the switcher\'s All communities tile draws the Communities tab\'s glyph', () => {
  const tile = switcherAllTile();
  const glyph = tabGlyph();
  assert.ok(pathsOf(tile).length > 0, 'the tile holds a drawn glyph');
  assert.deepEqual(pathsOf(tile), pathsOf(glyph), 'path for path the people glyph the tab draws');
  assert.doesNotMatch(tile, /class="/, 'sized by app.css with the tile, not by a utility');
});

// ── 2. A ring, not a fill ─────────────────────────────────────────────

test('the tile is a ring in the row\'s own ink, with no dark fill in either theme', () => {
  const tile = ruleFor('.community-switcher-tile-all');
  assert.match(tile, /background: transparent;/, 'no fill of its own');
  assert.match(tile, /color: inherit;/, 'the row\'s ink, which follows the theme');
  assert.match(tile, /box-shadow: inset 0 0 0 2px currentColor;/, 'a 2px ring in that ink');
  assert.doesNotMatch(CSS, /\.platform-tab-ring\b/, 'the tab\'s own ring is gone: it draws the glyph alone');
  assert.doesNotMatch(tile, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'no fixed colour, so no near-black tile');
  assert.doesNotMatch(CSS, /\.dark \.community-switcher-tile-all/, 'and no dark-theme twin to keep in step');
  // The glyph keeps the proportion the tab's ring had (18px in 28px) at both sizes.
  assert.match(CSS, /\n\.community-switcher-tile-all > svg \{ width: 26px; height: 26px; stroke-width: 1\.8; \}/,
    '26px in the sheet\'s 40px tile, with the tab glyph\'s stroke');
  assert.match(CSS, /\n\.community-switcher-menu \.community-switcher-tile-all > svg \{ width: 22px; height: 22px; \}/,
    '22px in the wide menu\'s 34px tile');
});
