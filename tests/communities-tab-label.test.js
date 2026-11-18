'use strict';

// #3709 — the Communities tab says "Communities" wherever you are.
//
// #852 (#3455) made the fourth tab a community: its tile in a ring, and, as
// its label, the community's own name cut short ("Recipe Box"). The owner
// asked for the word back (#3709), and the ring kept saying which community
// the tab was on. One Home (#6361) then drew the tab on neither bar. It is
// back (18 Nov 2026) as a plain door to its page, `#communities`: the people
// glyph and the word, on the phone's bar and the desktop sidebar (one
// anchor, which app.css lays out for both), whatever community you were on.
//
// Pinned, each a way the tab can be quietly wrong again:
//
//   1. WITH A COMMUNITY CHOSEN, THE TAB IS STILL THE GLYPH AND THE WORD: no
//      tile, no ring, no name.
//   2. THE SPOKEN NAME IS THE WORD ON SCREEN, and only the votes waiting add
//      to it, after the word.
//   3. WITH NONE CHOSEN it is the same tab, exactly as the prerender ships it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const TAB_BAR = read('frontend/src/features/nav/tab-bar.tsx');
const DAPP = JSON.parse(read('dapp.json'));

const ui = loadTsx('tests/fixtures/tab-bar-api.ts');

const RECIPES = {
  slug: 'recipes', name: 'Recipe Box of the Week', iconUrl: null, iconEmoji: '🍲', iconColor: '#2e6660', needs: 0,
};

const render = (slug) => {
  const before = ui.communityScopeStore.get();
  ui.communityScopeStore.set({ slug, info: slug ? { [slug]: RECIPES } : {} });
  try {
    return renderToHtml(createElement(ui.PlatformTabs, {}));
  } finally {
    ui.communityScopeStore.set(before);
  }
};
const workshopTab = (html) => {
  const at = html.indexOf('id="platform-tab-workshop"');
  assert.ok(at > 0, '#platform-tab-workshop renders');
  return html.slice(html.lastIndexOf('<a', at), html.indexOf('</a>', at) + 4);
};
const labelOf = (tab) => (tab.match(/<span class="platform-tab-label">([^<]*)<\/span>/) || [])[1];
const openTag = (tab) => tab.slice(0, tab.indexOf('>') + 1);

// ── 1. With a community chosen ───────────────────────────────────────

test('with a community chosen the tab is still the people glyph and the word', () => {
  const tab = workshopTab(render('recipes'));
  assert.equal(labelOf(tab), 'Communities', 'the word, not the community\'s name');
  assert.doesNotMatch(tab, /Recipe/, 'no part of the name is on the tab');
  assert.match(tab, /<span class="platform-tab-mark"><svg[^>]* class="platform-tab-glyph"/, 'its own glyph, as every tab\'s is');
  assert.doesNotMatch(tab, /platform-tab-ring|platform-tab-tile|app-icon-tile/, 'no ring and no community\'s tile');
  assert.doesNotMatch(TAB_BAR, /CommunityTabFace/, 'the face that named a community is gone');
});

// ── 2. The spoken name ────────────────────────────────────────────────

test('its accessible name is its text, and names no community', () => {
  const tab = workshopTab(render('recipes'));
  assert.doesNotMatch(openTag(tab), /aria-label=/, 'its text is its name');
  assert.equal(ui.communitiesAriaLabel(), undefined);
  assert.equal(ui.communitiesAriaLabel(0), undefined, 'at zero, as the prerender ships it');
});

test('#5040: with votes waiting, the spoken name says what the blue number counts', () => {
  assert.equal(ui.communitiesAriaLabel(1), 'Communities, 1 vote waiting on you');
  assert.equal(ui.communitiesAriaLabel(7), 'Communities, 7 votes waiting on you');
  const before = ui.communityScopeStore.get();
  ui.communityScopeStore.set({ slug: 'recipes', info: { recipes: { ...RECIPES, needs: 3 } }, badgeNeeds: 5 });
  let tab;
  try {
    tab = workshopTab(renderToHtml(createElement(ui.PlatformTabs, {})));
  } finally {
    ui.communityScopeStore.set(before);
  }
  // Every vote waiting on you, not the chosen community's alone: the tab is
  // the door to all of them.
  assert.match(openTag(tab), /aria-label="Communities, 5 votes waiting on you"/);
  assert.match(openTag(tab), /title="5 votes waiting on you"/, 'pointed at, it says the same');
  assert.match(tab, /<span class="platform-tab-votes" aria-label="5 votes waiting on you">5<\/span>/, 'the one number, at both widths');
  assert.doesNotMatch(tab, /platform-tab-all-votes|platform-tab-all-label/, 'the sidebar\'s All row is gone with its own count');
  assert.doesNotMatch(openTag(workshopTab(render('recipes'))), /title=/, 'no votes, no tooltip');
});

// ── 3. With none chosen ───────────────────────────────────────────────

test('with no community chosen the tab is the same: the glyph, the word, and the shipped markup', () => {
  const tab = workshopTab(render(null));
  assert.equal(labelOf(tab), 'Communities');
  assert.doesNotMatch(openTag(tab), /aria-label=/, 'its text is its name');
  assert.equal(tab, workshopTab(render('recipes')), 'the community chosen changes nothing on it');
  // The first client render is the shipped document's, or hydration fails.
  assert.equal(tab, workshopTab(HTML).replace(/ aria-current="page"/, ''),
    'the store\'s INITIAL renders exactly the shipped tab');
});

test('nothing in the tab bar puts a community\'s name in a label any more', () => {
  assert.doesNotMatch(TAB_BAR, /shortName\(/, 'the cut-down name is gone from the bar');
  // The declared check on a community's page: the checks run at 1280px,
  // where the sidebar lights the community's own row in Recents rather than
  // the Communities row, so it pins that row.
  const check = DAPP.tests.find((t) => /^On a wide window the sidebar's Recents lists your communities/.test(t.name));
  assert.ok(check, 'the declared check for a community\'s row is still there');
  assert.match(check.expectSelector, /\.platform-rail-row\[data-rail-row="usernode-2d5619"\] > a\.platform-rail-community\[aria-current="page"\]/);
});
