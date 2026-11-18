'use strict';

// Home's search offers to make what nothing matches (#5928, item 10).
//
// Discover's search made the offer (#6035); One Home (#6361) folded Discover
// into Home and left it behind, while the make screen kept its "Filled in
// from your search" line with no caller. What is pinned:
//
//   1. The words are an idea only when every list has answered and none
//      matches: the viewer's apps, their communities and the directory.
//   2. A list still loading, or a directory that could not be read, offers
//      nothing; neither does a web address or a single letter.
//   3. The button hands the whole search to the make screen as a search's.
//   4. Home mounts it, and nothing is drawn before somebody types.
//
// Run with: node --test tests/home-search-make.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const FILE = 'frontend/src/features/home/search-make.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const DIRECTORY = [
  { slug: 'pourover', name: 'Pourover Coffee', description: 'Rate the beans you brew' },
  { slug: 'trail-log', name: 'Trail Log', description: null },
];
const MINE = [{ slug: 'book-club', name: 'Book Club' }, { slug: 'quiet', name: null }];
const lists = (over = {}) => ({ noApps: true, communities: MINE, directory: DIRECTORY, ...over });

test('a search nothing matches is an idea, kept whole and trimmed', () => {
  const { searchIdea } = loadTsx(FILE);
  assert.equal(searchIdea('  chore wheel for our flat  ', lists()), 'chore wheel for our flat');
});

test('a match in any list means there is nothing to make', () => {
  const { searchIdea } = loadTsx(FILE);
  assert.equal(searchIdea('chore', lists({ noApps: false })), null, 'one of your apps matches');
  assert.equal(searchIdea('book', lists()), null, 'a community you are in, by name');
  assert.equal(searchIdea('QUIET', lists()), null, 'a community with no name, by its slug');
  assert.equal(searchIdea('trail', lists()), null, 'a community to join, by name');
  assert.equal(searchIdea('beans', lists()), null, 'a community to join, by what it says it is');
});

test('a list that has not answered is not "nothing matches"', () => {
  const { searchIdea } = loadTsx(FILE);
  assert.equal(searchIdea('chore wheel', lists({ directory: null })), null, 'the directory is loading or could not be read');
  assert.equal(searchIdea('chore wheel', lists({ communities: null })), null, 'the communities are not in yet');
});

test('an address, a single letter and an empty search offer nothing', () => {
  const { searchIdea } = loadTsx(FILE);
  for (const q of ['', '   ', 'z', 'https://example.com/a', 'example.com', 'www.example.com/page?x=1']) {
    assert.equal(searchIdea(q, lists()), null, JSON.stringify(q));
  }
  assert.equal(searchIdea('zz', lists()), 'zz');
  assert.equal(searchIdea('a to-do list. For two', lists()), 'a to-do list. For two', 'a sentence with a full stop is not an address');
});

test('the offer says no community matches either, and its button names the idea', () => {
  const { SearchMakeOffer } = loadTsx(FILE);
  const html = renderToHtml(createElement(SearchMakeOffer, { idea: 'chore wheel' }));
  assert.match(html, /^<div data-home-search-make=""/);
  assert.ok(html.includes(`<p>${message('home:search.none', { query: 'chore wheel' })}</p>`));
  assert.equal(message('home:search.none', { query: 'zz' }), 'No community matches “zz” either.');
  assert.equal(message('home:search.make', { idea: 'zz' }), 'Make “zz”');
  assert.match(html, /<button type="button"[^>]*title="Make “chore wheel”"[^>]*><span class="min-w-0 truncate">Make “chore wheel”<\/span><\/button>/);
  assert.doesNotMatch(html, /gray-|indigo-/);
});

test('the button opens the make screen with the whole search, as a search\'s idea', () => {
  const { makeFromSearch } = loadTsx(FILE);
  const calls = [];
  const before = globalThis.window;
  globalThis.window = { App: { showCreateModal: (o) => { calls.push(o); return true; } } };
  try {
    makeFromSearch('a chore wheel for a flat of four, with a weekly reset');
  } finally {
    if (before === undefined) delete globalThis.window; else globalThis.window = before;
  }
  assert.deepEqual(calls, [{ idea: 'a chore wheel for a flat of four, with a weekly reset', ideaSource: 'search' }]);
  // The make screen still credits it (make.tsx), and the shell still passes
  // the source through (first-session/index.tsx).
  assert.match(read('frontend/src/features/first-session/make.tsx'), /ideaSource === 'search' \? \{ attr: 'data-make-search-idea'/);
  assert.match(read('frontend/src/features/first-session/index.tsx'), /opts\?\.ideaSource === 'search' \? 'search'/);
});

test('the offer follows the grid\'s judged words, so it stays up while someone types', () => {
  const { offerWords, searchIdea } = loadTsx(FILE);
  // A keystroke inside the grid's 100 ms debounce: the field says "Vvvv",
  // the grid has judged "Vvv". The offer stays, for the grid's words.
  assert.equal(offerWords('Vvvv', { view: 'search', emptyQuery: 'Vvv' }), 'Vvv');
  assert.equal(searchIdea('Vvv', lists()), 'Vvv', 'and it is an idea for those words');
  // Clearing the box hides it at once, without waiting for the debounce.
  assert.equal(offerWords('', { view: 'search', emptyQuery: 'Vvv' }), null);
  // An app matched, or the grid is not searching: nothing to offer.
  assert.equal(offerWords('Vvvv', { view: 'search', emptyQuery: null }), null);
  assert.equal(offerWords('Vvvv', { view: 'grid', emptyQuery: 'Vvv' }), null);
});

test('settledQuery reads the grid\'s words, and the live text only where the grid has judged nothing', () => {
  const { settledQuery } = loadTsx('frontend/src/features/home/use-home-query.ts', {
    cache: false,
    stubs: {
      './grid-store': { gridStore: { get: () => ({}), subscribe: () => () => {} } },
      '../../lib/use-store-state': { useStoreState: () => ({}) },
    },
  });
  const grid = (over = {}) => ({ ready: true, notice: null, query: 'Vvv', ...over });
  assert.equal(settledQuery('', grid()), '', 'an empty box settles at once');
  assert.equal(settledQuery('Vvvv', grid()), 'Vvv', 'the lists trail the box by the grid\'s debounce');
  assert.equal(settledQuery('Vvvv', grid({ notice: { text: 'offline', tone: 'muted' } })), 'Vvvv', 'the grid has judged nothing');
  assert.equal(settledQuery('Vvvv', grid({ ready: false })), 'Vvvv', 'the grid has not rendered yet');
});

test('Home draws nothing before a search, or while the lists are still out', () => {
  const store = (state) => ({ get: () => state, subscribe: () => () => {} });
  const render = (query, grid, pins) => {
    const { HomeSearchMake } = loadTsx(FILE, {
      cache: false,
      stubs: {
        './grid-store': { gridStore: store({ view: 'grid', emptyQuery: null, ...grid }) },
        './home-pins-store': { homePinsStore: store({ ready: true, pins: [], joined: [], owed: {}, ...pins }) },
        './use-home-query': { useHomeQuery: () => query, matchesQuery: () => false },
        './communities-to-join': { readDirectory: () => Promise.resolve(DIRECTORY) },
      },
    });
    return renderToHtml(createElement(HomeSearchMake, {}));
  };
  assert.equal(render('', {}, {}), '', 'the prerender: no search yet');
  assert.equal(render('zz', { view: 'search', emptyQuery: null }, {}), '', 'an app matches');
  assert.equal(render('zz', { view: 'search', emptyQuery: 'zz' }, {}), '', 'the directory has not been read on this render');
  assert.equal(render('', { view: 'search', emptyQuery: 'Vvv' }, {}), '', 'an empty box draws nothing, even with a stale verdict');
  assert.equal(render('zz', { view: 'search', emptyQuery: 'z' }, {}), '', 'the grid judged a single letter');
});

test('Home mounts it under the apps section, outside a look\'s own page', () => {
  const src = read('frontend/src/features/home/index.tsx');
  assert.match(src, /import \{ HomeSearchMake \} from '\.\/search-make';/);
  assert.match(src, /\{wip \? null : <AppsMore \/>\}\s*<\/WipCard>\s*<\/section>\s*\{\/\*[\s\S]*?\*\/\}\s*\{frame \? null : <HomeSearchMake \/>\}/);
});
