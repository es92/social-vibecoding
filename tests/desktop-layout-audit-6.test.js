'use strict';

// The overnight UI audit's desktop and tablet findings (1 Nov 2026, batch 6):
// the rules each fix rests on, where a screenshot is the only other witness.
// The layout itself is checked at 800, 1024, 1440 and 1920 by
// `npm run audit:layout -- --profiles desktop-800,desktop-1024,...`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CSS = read('public/css/app.css');

test('W06, reversed by #6154: My apps keeps four columns across the whole column; Home\'s search clears the bar', () => {
  // The audit capped the grid at 40rem. That left a block empty on its right on
  // a large screen, so the rendered grid names no width of its own: it is as
  // wide as the search box and the sections under it.
  const html = renderComponent('frontend/src/features/home/app-grid.tsx', 'AppGrid');
  const grid = html.match(/<div[^>]*\bid="app-list"[^>]*>/);
  assert.ok(grid, 'the grid renders');
  const className = grid[0].match(/class="([^"]*)"/)[1].split(/\s+/);
  assert.ok(className.includes('grid-cols-4'), 'four columns, the count a stored layout is keyed by');
  assert.deepEqual(className.filter((c) => /(^|:)max-w-/.test(c)), [], 'and no cap at any width');
  assert.match(read('frontend/src/features/home/index.tsx'), /<div className="home-column px-3 pt-3 md:pt-5 pb-2">/);
});

test('W07: an empty Challenges tab is the card Home draws, on the tabs\' edge', () => {
  const src = read('frontend/src/features/leaderboard/challenges-pane.tsx');
  assert.match(src, /<GroupedList className="mx-0 mt-4" data-challenges-empty="">\s*<ListRow\s*chevron=\{false\}\s*title=\{t\('leaderboard:challenges\.empty'\)\}\s*subtitle=\{t\('leaderboard:challenges\.emptyHint'\)\}/);
  assert.equal(message('leaderboard:challenges.empty'), 'No challenges right now');
  assert.equal(message('leaderboard:challenges.emptyHint'), 'New ones will show up here.');
  assert.equal(message('leaderboard:challenges.empty'), message('home:challenges.none.title'), 'the same words as Home');
  assert.equal(message('leaderboard:challenges.emptyHint'), message('home:challenges.none.text'));
});

test('D12: on By stage the place title widens with the board', () => {
  assert.match(CSS, /@media \(min-width: 768px\) \{\s*#dev-workshop\.dev-ws-has-board > \.dev-ws > \.dev-ws-placebar \{ max-width: none; \}/);
});

test('W05: "Find a setting" is the shell\'s search pill, with its glyph', () => {
  const html = renderComponent('frontend/src/features/settings/settings-nav.tsx', 'SettingsNavDesktop', {});
  assert.ok(typeof html === 'string');
  const src = read('frontend/src/features/settings/settings-nav.tsx');
  assert.match(src, /<div className="messages-search settings-filter">\s*<SearchIcon className="messages-search-glyph w-5 h-5" aria-hidden="true" \/>\s*<input/);
  assert.doesNotMatch(src, /from '@\/components\/ui\/input'/);
});
