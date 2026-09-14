// The #apps browse-all-apps screen (frontend/src/features/apps/browse.js) —
// the directory half of the home-screen split.
//
// Home is "Your apps" only now, so this screen is the ONLY place the rest
// of the platform's apps are reachable from. It deliberately borrows the
// shared app-card markup builders (features/apps/app-card.js), Home's
// added-state predicate (isYours), search matcher and add/remove write, so
// the two launcher grids can't drift; what it owns is the screen — its
// fetch, its always-visible search field, its ordering (featured first) and
// its empty states.
//
// Also pins the routing this screen needs from app.js: the #apps hash
// branch, the sibling hide-lists in every navigateTo*, and the zoom
// generalization (a tap here must not leave the browse grid painted behind
// the opened app).
//
// Run with: node --test tests/browse-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { installAppCard } = require('./helpers/app-card');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { HOME_SRC } = require('./helpers/home-modules');
// browse.js is a bundle module since #1083 chunk F, but it is deliberately
// still a valid CLASSIC script: this test compiles the real source in a vm
// context, which is why the store arrives by the `_store` plant ./mount.ts
// does rather than by an `import`. The strip below is kept as a guard — if a
// future edit does add an import, it drops out here instead of turning every
// test in this file into one SyntaxError. installAppCard is still run because
// these tests read app-card.js's shared chip decision directly.
const BROWSE_SRC = read('frontend/src/features/apps/browse.js')
  .replace(/^import .*;$/gm, '');
const APP_SRC = read('public/js/app.js');
const INDEX = read('public/index.html');

// Load home.js + browse.js into one context (Browse leans on Home) with a
// minimal DOM plus a store stub: since #1191 slice 6 conversion 3 the screen
// renders in React, so render() ends in `Browse._store.set(descriptor)` rather
// than an `innerHTML =`. The stub below is what ./mount.ts plants in the
// browser, and `state` is exactly what browse-list.tsx / browse-detail.tsx
// receive — so these tests still pin every decision this file makes, one step
// earlier than the markup.
function makeBrowse(opts = {}) {
  const nodes = {};
  const mkEl = (id) => {
    const el = {
      id,
      innerHTML: '',
      textContent: '',
      dataset: {},
      _classes: new Set(id === 'browse-empty' ? ['hidden'] : []),
      classList: {
        add: (c) => el._classes.add(c),
        remove: (c) => el._classes.delete(c),
        toggle: (c, on) => (on ? el._classes.add(c) : el._classes.delete(c)),
        contains: (c) => el._classes.has(c),
      },
      addEventListener: () => {},
      // A null stub, and it can stay one: nothing in browse.js queries the
      // painted DOM any more. The last holdout was the shot deep link's
      // first-real-row lookup, and _maybeShotDetail reads the row
      // descriptors it just published instead — the same list, one tick
      // before React would have rendered it.
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      offsetHeight: 52,
      scrollTop: 0,
      value: '',
      focus: () => {},
    };
    nodes[id] = el;
    return el;
  };
  ['browse-list', 'browse-empty', 'browse-list-level', 'browse-detail',
    'browse-search-bar', 'browse-search-input', 'browse-search-clear',
    'home-screen', 'home-search-bar', 'app-list', 'home-featured-list',
    'home-create-body'].forEach(mkEl);
  // The chrome _syncLevel drives, recorded so the level tests can assert it.
  const chrome = { backIcon: null, backHref: null, title: null, transitions: [] };
  // The shot deep link aligns the URL with replaceState — record the URLs.
  const history = { calls: [], replaceState: (_a, _b, url) => history.calls.push(url) };

  const fetchCalls = [];
  const storage = opts.storage || {};
  const sandbox = {
    console,
    App: {
      user: opts.user || { id: 1 },
      navigateToApp: () => {},
      setBackIcon: (m, href) => { chrome.backIcon = m; chrome.backHref = href; },
      setHeaderTitle: (t) => { chrome.title = t; },
      navigateHome: () => { chrome.wentHome = (chrome.wentHome || 0) + 1; },
    },
    PlatformUI: {
      toast: () => {},
      // The kit wrapper runs fn directly when the kit is absent; do the
      // same and record the animation type the level change asked for.
      transition: (fn, o) => { chrome.transitions.push(o?.type); fn(); },
    },
    document: {
      getElementById: (id) => nodes[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      createElement: () => {
        let t = '';
        return {
          classList: { add() {} },
          dataset: {},
          set textContent(v) { t = String(v); },
          get innerHTML() {
            return t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          },
        };
      },
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    // Dispatches on the URL so each endpoint answers its REAL envelope —
    // notably GET /api/apps/:slug, which responds `{ app: … }` (a bare app
    // object here is what let the _fetchDetail envelope bug hide), and the
    // contributors read, which the detail page now also fires.
    fetch: async (url, init) => {
      fetchCalls.push({ url, method: init?.method || 'GET', body: init?.body && JSON.parse(init.body) });
      const ok = opts.fetchOk !== false;
      const json = async () => {
        if (/\/contributors/.test(url)) {
          const items = opts.contributors || [];
          return { slug: 'x', total: opts.contribTotal ?? items.length, contributors: items };
        }
        if (/^\/api\/apps\/[^/?]+$/.test(url)) return { app: opts.coldApp || null };
        return { apps: opts.apps || [] };
      };
      return { ok, status: ok ? 200 : 500, json };
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams,
    // The Sort control remembers the reader's choice (#1383). Backed by a
    // plain object the caller seeds through `opts.storage` and reads back
    // off the returned `storage` — so both halves of the round trip are
    // assertable, and a browser that refuses storage is still exercised by
    // passing `storage: null`.
    localStorage: opts.storage === null ? null : {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    history,
    requestAnimationFrame: (fn) => fn(),
    location: { search: opts.search || '', hash: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // The shared card builders first: home.js delegates to window.AppCard and
  // browse.js calls them as bare identifiers (its import is stripped above).
  installAppCard(sandbox);
  // home.js declares `const Home = {…}` at script top level, which lands
  // in the context's global LEXICAL scope (visible to browse.js, which is
  // the point) but never as a sandbox property — hence the explicit hoist.
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  vm.runInContext(BROWSE_SRC, sandbox);
  // The store ./mount.ts plants, with the same initial value browse-store.js
  // ships (which is also the shell's prerendered empty state).
  const state = { level: 'list', rows: null, empty: null, error: false, detail: null, sort: 'recommended' };
  sandbox.Browse._store = {
    get: () => state,
    set: (patch) => Object.assign(state, patch),
    subscribe: () => () => {},
    setFlush: () => {},
  };
  // Home.render() is the LAUNCHER's paint, and this harness has neither
  // HomeLayout nor the grid store loaded — so count the calls instead of
  // running them. Worth counting rather than merely silencing: #1567 made
  // Home.toggleAdded repaint, and that call is the whole fix.
  const renders = { count: 0 };
  sandbox.__Home.render = () => { renders.count += 1; };
  return {
    Browse: sandbox.Browse, Home: sandbox.__Home, AppCard: sandbox.AppCard,
    state, nodes, fetchCalls, chrome, history, location: sandbox.location,
    storage, renders,
  };
}

// The descriptor helpers the assertions below read through. `rows` is null
// until the first render, so every one of these is null-safe.
const slugs = (state) => (state.rows || []).map((r) => r.slug);
const rowFor = (state, slug) => (state.rows || []).find((r) => r.slug === slug) || null;

const app = (over) => ({
  slug: 'some-app',
  name: 'Some App',
  status: 'running',
  is_collaborator: false,
  is_favorited: false,
  favorite_order: null,
  featured: false,
  featured_order: null,
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

test('#1523: quality outranks featuring/popularity, while explicit sorts and search retain all apps', () => {
  const { Browse, state } = makeBrowse();
  Browse._open = true;
  Browse._apps = [
    app({ slug: 'demo', name: 'Demo app', active_users: 999, featured: true,
      directory: { tier: 'more', state: 'demo' } }),
    app({ slug: 'unreviewed', active_users: 10, directory: { tier: 'unreviewed' } }),
    app({ slug: 'working', icon_emoji: '🎮', active_users: 1, directory: { tier: 'ready', state: 'working' } }),
  ];
  Browse.render();
  assert.deepEqual(slugs(state), ['working', 'unreviewed', 'demo']);
  assert.equal(state.curated, true);
  assert.equal(state.moreExpanded, false);
  Browse.toggleMore();
  assert.equal(state.moreExpanded, true);
  Browse.toggleMore();
  Browse.setQuery('Demo app', { immediate: true });
  assert.equal(state.curated, false, 'matching demos are visible without expanding');
  assert.deepEqual(slugs(state), ['demo']);
  assert.equal(rowFor(state, 'demo').openable, true, 'real demo apps are still usable');
  assert.equal(rowFor(state, 'demo').demo, false, 'not a staging-only inert fixture');
  Browse.setQuery('', { immediate: true });
  assert.equal(state.curated, true);
  assert.equal(state.moreExpanded, false);
  Browse.setSort('users');
  // #1912: a metric sort still tucks the `more` tier behind Show more — it
  // is just not GROUPED under tier headings, so its own order holds.
  assert.equal(state.curated, true, 'every sort gets Show more');
  assert.equal(state.grouped, false, 'explicit metric sorts are one list, not grouped');
  assert.deepEqual(slugs(state), ['demo', 'unreviewed', 'working']);
  Browse.setSort('recommended');
  assert.equal(state.grouped, true, 'Recommended keeps its tier headings');
  Browse.setQuery('Demo app', { immediate: true });
  assert.equal(state.curated, false);
  assert.equal(state.grouped, false);
  Browse.setQuery('', { immediate: true });
});

test('#1523: disclosure survives a detail round trip and resets on a new directory visit', () => {
  const { Browse, state } = makeBrowse();
  Browse._load = () => {};
  Browse._apps = [app({ slug: 'demo', directory: { tier: 'more', state: 'demo' } })];
  Browse.open();
  Browse.toggleMore();
  Browse.showDetail('demo');
  Browse.showList();
  assert.equal(state.moreExpanded, true);
  Browse.close(); Browse.open();
  assert.equal(state.moreExpanded, false);
});

test('#1523: preview URLs seed only disclosure state and forward the staging fixture opt-in', async () => {
  const { Browse, state, fetchCalls, storage } = makeBrowse({ search: '?demo=1&curation=1&sort=recommended&shot=browse-more' });
  Browse.open();
  await flush();
  assert.equal(state.moreExpanded, true);
  assert.ok(fetchCalls.some((c) => c.url === '/api/apps?demo=1&curation=1'));
  assert.ok(fetchCalls.every((c) => c.method === 'GET'));
  assert.deepEqual(storage, {}, 'a review URL does not overwrite user preferences');
});

// ── sortApps: featured first, then the server's activity order ────

test('sortApps: featured rows lead, ordered by featured_order', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'plain-1' }),
    app({ slug: 'feat-b', featured: true, featured_order: 1 }),
    app({ slug: 'plain-2' }),
    app({ slug: 'feat-a', featured: true, featured_order: 0 }),
  ];
  assert.deepEqual(
    Browse.sortApps(apps).map((a) => a.slug),
    ['feat-a', 'feat-b', 'plain-1', 'plain-2']
  );
});

test('sortApps: the non-featured tail is ordered by users, most first', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'few', active_users: 2 }),
    app({ slug: 'many', active_users: 40 }),
    app({ slug: 'none' }),
    app({ slug: 'some', active_users: 9 }),
  ];
  assert.deepEqual(Browse.sortApps(apps).map((a) => a.slug),
    ['many', 'some', 'few', 'none']);
});

test('sortApps: equal user counts fall back to the server order', () => {
  const { Browse } = makeBrowse();
  // /api/apps already ranks by activity; a stable sort must not disturb
  // that among apps the user count can't separate.
  const apps = ['c', 'a', 'b'].map((slug) => app({ slug, active_users: 5 }));
  assert.deepEqual(Browse.sortApps(apps).map((a) => a.slug), ['c', 'a', 'b']);
});

test('sortApps: user count never reorders the admin-curated featured list', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'feat-second', featured: true, featured_order: 1, active_users: 99 }),
    app({ slug: 'feat-first', featured: true, featured_order: 0, active_users: 0 }),
    app({ slug: 'popular', active_users: 50 }),
  ];
  assert.deepEqual(Browse.sortApps(apps).map((a) => a.slug),
    ['feat-first', 'feat-second', 'popular'],
    'curation is a choice — users must not silently override it');
});

test('sortApps: a non-numeric user count is treated as zero', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'junk', active_users: null }),
    app({ slug: 'real', active_users: 1 }),
  ];
  assert.deepEqual(Browse.sortApps(apps).map((a) => a.slug), ['real', 'junk']);
});

test('sortApps: a featured row with a NULL order still leads', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'plain' }),
    app({ slug: 'feat-null', featured: true, featured_order: null }),
  ];
  assert.deepEqual(Browse.sortApps(apps).map((a) => a.slug), ['feat-null', 'plain']);
});

test('sortApps: does not mutate the input array', () => {
  const { Browse } = makeBrowse();
  const apps = [app({ slug: 'x' }), app({ slug: 'f', featured: true, featured_order: 0 })];
  Browse.sortApps(apps);
  assert.deepEqual(apps.map((a) => a.slug), ['x', 'f']);
});

// ── sortApps: the five orders of the Sort control (#1383) ─────────
//
// Every comparator returns 0 on a tie, so Array.prototype.sort's stability
// falls back to the order /api/apps already shipped (activity, then age).
// That is why "equal user counts fall back to the server order" above still
// holds under the default, and why each of these fixtures separates the rows
// on exactly the signal it is naming.

test('sortApps: users ranks purely by user count, curation included', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'feat', featured: true, featured_order: 0, active_users: 1 }),
    app({ slug: 'popular', active_users: 50 }),
    app({ slug: 'mid', active_users: 10 }),
  ];
  assert.deepEqual(Browse.sortApps(apps, 'users').map((a) => a.slug),
    ['popular', 'mid', 'feat'],
    'an EXPLICIT choice outranks the featured pin — otherwise the control looks broken');
});

test('sortApps: featured pinning applies under recommended ONLY', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'plain', active_users: 9, merged_prs: 4, created_at: '2026-08-01' }),
    app({ slug: 'feat', featured: true, featured_order: 0, created_at: '2020-01-01' }),
  ];
  assert.equal(Browse.sortApps(apps, 'recommended')[0].slug, 'feat');
  for (const key of ['users', 'active', 'merged', 'new']) {
    assert.equal(Browse.sortApps(apps, key)[0].slug, 'plain', `${key} must not pin`);
  }
});

test('sortApps: active leads on 30-day merges, then the last thing that happened', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'quiet', merged_prs_recent: 0, last_merged_at: '2026-08-25' }),
    app({ slug: 'steady-old', merged_prs_recent: 3, last_merged_at: '2026-08-10', last_deploy_at: '2026-02-01' }),
    app({ slug: 'busy', merged_prs_recent: 9, last_merged_at: '2026-01-01' }),
    app({ slug: 'steady-deploy', merged_prs_recent: 3, last_merged_at: '2026-08-01', last_deploy_at: '2026-08-24' }),
  ];
  assert.deepEqual(Browse.sortApps(apps, 'active').map((a) => a.slug),
    ['busy', 'steady-deploy', 'steady-old', 'quiet'],
    'a deploy counts as activity too, not just a merge');
});

test('sortApps: active breaks a total tie on users', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'few', merged_prs_recent: 2, last_merged_at: '2026-08-01', active_users: 1 }),
    app({ slug: 'many', merged_prs_recent: 2, last_merged_at: '2026-08-01', active_users: 30 }),
  ];
  assert.deepEqual(Browse.sortApps(apps, 'active').map((a) => a.slug), ['many', 'few']);
});

test('sortApps: merged ranks lifetime accepted changes, recency breaking ties', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'tie-old', merged_prs: 5, last_merged_at: '2026-02-20' }),
    app({ slug: 'shallow', merged_prs: 2, last_merged_at: '2026-08-24' }),
    app({ slug: 'deep', merged_prs: 40, last_merged_at: '2026-01-01' }),
    app({ slug: 'tie-recent', merged_prs: 5, last_merged_at: '2026-08-20' }),
  ];
  assert.deepEqual(Browse.sortApps(apps, 'merged').map((a) => a.slug),
    ['deep', 'tie-recent', 'tie-old', 'shallow']);
});

test('sortApps: a row that has never merged anything sinks, it does not lead', () => {
  const { Browse } = makeBrowse();
  // last_merged_at is NULL for an app with no merged history at all, and
  // NULL must never read as "merged at the epoch" or as "merged just now".
  const apps = [
    app({ slug: 'never', merged_prs: 5, last_merged_at: null }),
    app({ slug: 'once', merged_prs: 5, last_merged_at: '2020-01-01' }),
  ];
  assert.deepEqual(Browse.sortApps(apps, 'merged').map((a) => a.slug), ['once', 'never']);
});

test('sortApps: new ranks by creation date, undated rows last', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'older', created_at: '2025-01-01', active_users: 99 }),
    app({ slug: 'undated' }),
    app({ slug: 'newest', created_at: '2026-08-20' }),
  ];
  assert.deepEqual(Browse.sortApps(apps, 'new').map((a) => a.slug),
    ['newest', 'older', 'undated']);
});

test('sortApps: missing and non-numeric aggregates are read as zero', () => {
  const { Browse } = makeBrowse();
  // /api/apps coerces these server-side, but Home's cache seeds the first
  // paint and an older cached payload has none of the three new fields.
  const apps = [
    app({ slug: 'unknown' }),
    app({ slug: 'junk', merged_prs: null, merged_prs_recent: 'lots', last_merged_at: 'not-a-date' }),
    app({ slug: 'real', merged_prs: 1, merged_prs_recent: 1, last_merged_at: '2026-08-01' }),
  ];
  assert.equal(Browse.sortApps(apps, 'merged')[0].slug, 'real');
  assert.equal(Browse.sortApps(apps, 'active')[0].slug, 'real');
  assert.equal(Browse.sortApps(apps, 'merged').length, 3, 'and nothing is dropped');
});

test('sortApps: an unknown, absent or oddly-cased key resolves sanely', () => {
  const { Browse } = makeBrowse();
  assert.equal(Browse.resolveSort('nope'), 'recommended');
  assert.equal(Browse.resolveSort(undefined), 'recommended');
  assert.equal(Browse.resolveSort(''), 'recommended');
  assert.equal(Browse.resolveSort('  Users '), 'users', 'trimmed and lowercased');
  const apps = [app({ slug: 'a', active_users: 1 }), app({ slug: 'b', featured: true, featured_order: 0 })];
  assert.deepEqual(Browse.sortApps(apps, 'nope').map((a) => a.slug),
    Browse.sortApps(apps, 'recommended').map((a) => a.slug));
});

test('sortApps: every order REORDERS the directory, none of them filters it', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'a', active_users: 3, merged_prs: 2, merged_prs_recent: 1, created_at: '2026-01-01' }),
    app({ slug: 'b', featured: true, featured_order: 0 }),
    app({ slug: 'c', merged_prs: 9, last_merged_at: '2026-08-01' }),
    app({ slug: 'd', created_at: '2026-08-20' }),
    app({ slug: 'e' }),
  ];
  const expected = ['a', 'b', 'c', 'd', 'e'];
  for (const { key } of Browse.SORTS) {
    assert.deepEqual(Browse.sortApps(apps, key).map((a) => a.slug).sort(), expected,
      `${key} kept every app`);
  }
  assert.deepEqual(apps.map((a) => a.slug), expected, 'and never mutated the input');
});

// ── Remembering the choice, and the read-only ?sort= override ─────

test('setSort: applies, persists and republishes the order', () => {
  const { Browse, state, storage } = makeBrowse();
  Browse._apps = [
    app({ slug: 'few', active_users: 1 }),
    app({ slug: 'many', active_users: 40 }),
  ];
  Browse.setSort('users');
  assert.equal(Browse._sort, 'users');
  assert.equal(storage[Browse.SORT_STORAGE_KEY], 'users', 'remembered for the next visit');
  assert.equal(state.sort, 'users', 'the <select> is controlled off the store');
  assert.deepEqual(slugs(state), ['many', 'few'], 'and the rows repainted with it');
});

test('setSort: an unknown key lands on recommended rather than breaking the list', () => {
  const { Browse, state, storage } = makeBrowse();
  Browse.setSort('drop-tables');
  assert.equal(Browse._sort, 'recommended');
  assert.equal(storage[Browse.SORT_STORAGE_KEY], 'recommended');
  assert.equal(state.sort, 'recommended');
});

test('setSort: a browser that refuses storage still sorts', () => {
  const { Browse, state } = makeBrowse({ storage: null });
  Browse.setSort('new');
  assert.equal(Browse._sort, 'new');
  assert.equal(state.sort, 'new');
});

test('_applyInitialSort: the remembered choice is restored on entry', () => {
  const { Browse, state } = makeBrowse({ storage: { 'usernode:browse-sort': 'merged' } });
  Browse._applyInitialSort();
  assert.equal(Browse._sort, 'merged');
  assert.equal(state.sort, 'merged');
});

test('_applyInitialSort: a stale or absent stored value falls back to recommended', () => {
  assert.equal(makeBrowse({ storage: { 'usernode:browse-sort': 'trending' } })
    .Browse._storedSort(), null, 'a key we no longer ship is not a choice');
  const { Browse } = makeBrowse({ storage: { 'usernode:browse-sort': 'trending' } });
  Browse._applyInitialSort();
  assert.equal(Browse._sort, 'recommended');
  const fresh = makeBrowse();
  fresh.Browse._applyInitialSort();
  assert.equal(fresh.Browse._sort, 'recommended');
});

test('?sort= wins over the remembered choice and is never written back', () => {
  const { Browse, state, storage } = makeBrowse({
    search: '?sort=new',
    storage: { 'usernode:browse-sort': 'merged' },
  });
  Browse.open(null);
  assert.equal(Browse._sort, 'new', 'the deep link decides what this visit shows');
  assert.equal(state.sort, 'new');
  assert.equal(storage['usernode:browse-sort'], 'merged',
    'a link somebody sent must not rewrite what YOU chose');
});

test('?sort= with an unknown value defers to the remembered choice', () => {
  const { Browse } = makeBrowse({
    search: '?sort=bananas',
    storage: { 'usernode:browse-sort': 'merged' },
  });
  Browse._applyInitialSort();
  assert.equal(Browse._sort, 'merged');
  assert.equal(Browse._urlSort(), null, 'garbage is not a silent "recommended"');
});

test('?sort=recommended is honoured as an explicit choice', () => {
  const { Browse } = makeBrowse({
    search: '?sort=recommended',
    storage: { 'usernode:browse-sort': 'merged' },
  });
  Browse._applyInitialSort();
  assert.equal(Browse._sort, 'recommended', 'the default is still a value you can link to');
});

test("the screen's <option> list is a faithful copy of Browse.SORTS", () => {
  const { Browse } = makeBrowse();
  // browse-screen.tsx cannot read the controller: window.Browse does not
  // exist in the SSG prerender pass, so it carries its own copy of the five
  // labels. This is the guard that keeps the copy honest.
  const src = read('frontend/src/features/apps/browse-screen.tsx');
  const block = src.match(/const SORT_OPTIONS[\s\S]*?\n\];/);
  assert.ok(block, 'SORT_OPTIONS is still declared in browse-screen.tsx');
  const copied = [...block[0].matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)]
    .map((m) => ({ key: m[1], label: m[2] }));
  // Array.from, not .map: SORTS is the vm realm's array, and its .map would
  // hand back an array whose prototype deepStrictEqual refuses to match.
  assert.deepEqual(copied, Array.from(Browse.SORTS, (s) => ({ key: s.key, label: s.label })),
    'the <option> list and the comparators must name the same five orders');
});

// ── Search covers EVERY visible app (home's is scoped to yours) ────

test('visibleApps: filters on Home.matchesQuery over the whole list', () => {
  const { Browse } = makeBrowse();
  Browse._apps = [
    app({ slug: 'chess-1a2b', name: 'Chess Arena' }),
    app({ slug: 'puzzle-3c4d', name: 'Puzzle Chain' }),
    app({ slug: 'word-5e6f', name: 'Word Garden', is_collaborator: true }),
  ];
  Browse._query = 'chain';
  assert.deepEqual(Browse.visibleApps().map((a) => a.slug), ['puzzle-3c4d']);
  Browse._query = '5e6f';
  assert.deepEqual(Browse.visibleApps().map((a) => a.slug), ['word-5e6f'], 'slug matches');
  Browse._query = '';
  assert.equal(Browse.visibleApps().length, 3, 'no query = everything, yours included');
});

test('visibleApps: the search narrows, the sort orders, and they compose', () => {
  const { Browse } = makeBrowse();
  Browse._apps = [
    app({ slug: 'chess-old', name: 'Chess Classic', created_at: '2024-01-01', active_users: 40 }),
    app({ slug: 'chess-new', name: 'Chess Arena', created_at: '2026-08-20', active_users: 1 }),
    app({ slug: 'word', name: 'Word Garden', created_at: '2026-08-24', active_users: 99 }),
  ];
  Browse._query = 'chess';
  Browse.setSort('new');
  assert.deepEqual(Browse.visibleApps().map((a) => a.slug), ['chess-new', 'chess-old'],
    'newest first, within the filter');
  Browse.setSort('users');
  assert.deepEqual(Browse.visibleApps().map((a) => a.slug), ['chess-old', 'chess-new'],
    'the order changed, the filtered SET did not');
});

// ── render ───────────────────────────────────────────────────────

test('rowView: an app-store row — icon, name, meta, Add state', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [
    app({ slug: 'fresh', name: 'Fresh App', active_users: 3 }),
    app({ slug: 'mine', name: 'My App', is_favorited: true }),
  ];
  Browse.render();
  assert.deepEqual(slugs(state), ['fresh', 'mine'], 'rows, not launcher tiles');
  const fresh = rowFor(state, 'fresh');
  assert.equal(fresh.name, 'Fresh App');
  assert.match(fresh.meta, /3 users/, 'the derived meta line');
  // The whole app record rides the descriptor, because the icon tile and the
  // chip strip are shared decisions (app-card.js) the row does not re-make.
  assert.equal(fresh.app.slug, 'fresh');
  // Added rows read "Added", fresh ones "Add to Your apps" (#1553) — the flag
  // is the descriptor's, the two labels are browse-list.tsx's.
  assert.equal(fresh.added, false);
  assert.equal(rowFor(state, 'mine').added, true);
  assert.match(rowFor(state, 'mine').addTitle, /Tap to remove/);
  // The "…" menu is gone from this screen — the detail page absorbed it.
  assert.doesNotMatch(BROWSE_SRC, /card-menu-btn/);
  assert.doesNotMatch(BROWSE_SRC, /card-add-btn/, 'the corner badge is a real button now');
});

test('browse rows: the layout switch is pure CSS on the container', () => {
  // Narrow: a hairline-divided vertical list. md+: a 2/3-column grid whose
  // rows pick up a box treatment from .browse-row in app.css. No
  // matchMedia, so nothing re-renders on resize.
  const listTag = INDEX.match(/<div id="browse-list"[^>]*>/)[0];
  assert.match(listTag, /md:grid/);
  assert.match(listTag, /md:grid-cols-2/);
  assert.match(listTag, /lg:grid-cols-3/);
  assert.doesNotMatch(BROWSE_SRC, /matchMedia\(/, 'the breakpoint is CSS, not JS');

  // NO divide-* utility on the container. Tailwind's divide-y sets
  // border-bottom-width: 0 (and md:divide-y-0 zeroes the top too) via
  // `.divide-y-0 > :not([hidden]) ~ :not([hidden])`, which is (0,3,0) and
  // beat the (0,1,0) .browse-row box rule — every desktop box but the
  // FIRST lost its top and bottom edge. Both borders live in one cascade
  // now; putting a divide utility back here reopens that bug.
  assert.doesNotMatch(listTag, /divide-/,
    'the phone hairline is .browse-row + .browse-row in app.css');

  // Phone: the rows sit in ONE white card (the max-md classes on the container
  // above) and the hairline between them is INSET to the text column, so it
  // stops short of the card's corner radius. It is a pseudo-element rather
  // than `border-top` — a border cannot be inset — which is also what frees
  // the md+ block below to own the `border` shorthand outright.
  assert.match(listTag, /max-md:rounded-2xl/, 'phone: the rows sit in one card');
  assert.match(listTag, /max-md:bg-white/, 'phone: that card is a white surface');
  const css = read('public/css/app.css');
  assert.match(css, /\.browse-row \+ \.browse-row::before \{/,
    'phone: a hairline between consecutive rows');
  assert.match(css, /\.browse-row \+ \.browse-row::before \{[\s\S]*?left: 4\.75rem/,
    'and it is inset to the text column, not the card edge');
  // The md block re-states the sibling selector so the full box wins at
  // equal specificity instead of relying on source order alone.
  const browseStart = css.indexOf('/* ── Browse screen rows / boxes');
  const browseEnd = css.indexOf('/* ── App-card "…" actions menu', browseStart);
  assert.ok(browseStart > -1 && browseEnd > browseStart,
    'the Browse-owned CSS section must remain identifiable');
  const browseCss = css.slice(browseStart, browseEnd);
  const mdBlock = browseCss.slice(browseCss.indexOf('@media (min-width: 768px)'));
  const box = mdBlock.slice(0, mdBlock.indexOf('}\n}') + 3);
  assert.match(box, /\.browse-row,\s*\n\s*\.browse-row \+ \.browse-row \{/);
  // At md+ every row is its OWN box, so the between-rows hairline has nothing
  // left to separate — it would draw across the top of every box but the
  // first. The md block cancels it explicitly rather than relying on the
  // border shorthand to paint over it, which is what the shorthand used to do
  // back when the hairline was a `border-top`.
  assert.match(mdBlock, /\.browse-row \+ \.browse-row::before \{ content: none/,
    'md+: the between-rows hairline is cancelled, not painted over');
  // What changed with the widget language is what the box is made of — a white
  // surface on the grey page ground instead of a hairline outline — so the
  // shorthand is transparent and the separation comes from the fill. It stays
  // declared so the hover rule has a width to colour in without the box
  // changing size under the cursor.
  assert.match(box, /border: 1px solid transparent/);
  assert.match(box, /background-color: var\(--bg-primary\)/);
  assert.match(box, /border-radius/);
  // One theme token instead of `.dark` variants, which would out-specify
  // the sibling and hover rules.
  assert.match(css, /\.dark \.browse-row \{ --browse-border/);
});

test('rowView: status pills and the status word ride the row', () => {
  const { Browse, AppCard, state } = makeBrowse();
  Browse._apps = [app({
    slug: 'busy', status: 'awaiting_secrets', open_prs: 2, open_issues: 1,
    missingSecrets: ['API_KEY'], view_visibility: 'private',
  })];
  Browse.render();
  const row = rowFor(state, 'busy');
  assert.match(row.meta, /Awaiting secrets/, 'non-running status in the meta line');
  assert.equal(row.statusDot, 'creating', 'awaiting_secrets is still spinning up');
  // The chips are not the row's decision — the descriptor carries the record
  // and app-card.js's appPillsFor answers for every app surface at once.
  const pills = AppCard.appPillsFor(row.app);
  assert.deepEqual(Array.from(pills.chips, (c) => c.label),
    ['Missing secrets', '2 to vote', '1 issue']);
  assert.equal(pills.vis.label, 'Private');
});

test('metaLine: users · updated · status, pluralised, missing bits skipped', () => {
  const { Browse } = makeBrowse();
  assert.match(Browse.metaLine(app({ active_users: 1 })), /^1 user\b/);
  assert.match(Browse.metaLine(app({ active_users: 0 })), /^0 users\b/);
  const running = Browse.metaLine(app({ active_users: 4, status: 'running' }));
  assert.doesNotMatch(running, /running/, 'a healthy app needs no status word');
  assert.match(Browse.metaLine(app({ status: 'error' })), /Error/);
  assert.match(Browse.metaLine(app({ status: 'creating' })), /Spinning up/);
  // No timestamps at all still yields a usable line, and null is safe.
  assert.equal(Browse.metaLine(null), '');
  assert.match(Browse.metaLine({ status: 'running' }), /^0 users$/);
});

test('metaLine: the line answers the question the active sort asked (#1383)', () => {
  const { Browse } = makeBrowse();
  const ago = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const a = app({
    active_users: 4, merged_prs: 12, merged_prs_recent: 3,
    last_deploy_at: ago(1), created_at: ago(3),
  });

  const recommended = Browse.metaLine(a, 'recommended');
  assert.equal(recommended, '4 users · Updated 1h ago', 'the default line is unchanged');
  assert.equal(Browse.metaLine(a, 'users'), recommended, 'so is the users line');

  assert.equal(Browse.metaLine(a, 'active'), '4 users · 3 merged in 30d · Updated 1h ago');
  assert.equal(Browse.metaLine(a, 'merged'), '4 users · 12 changes merged · Updated 1h ago');
  assert.equal(Browse.metaLine(a, 'new'), '4 users · Created 3h ago',
    'sorting by age shows the age it sorted on, not the deploy');
});

test('metaLine: a zero aggregate is dropped, not rendered as "0"', () => {
  const { Browse } = makeBrowse();
  const quiet = app({ active_users: 2, merged_prs: 0, merged_prs_recent: 0 });
  assert.equal(Browse.metaLine(quiet, 'active'), '2 users');
  assert.equal(Browse.metaLine(quiet, 'merged'), '2 users');
  assert.match(Browse.metaLine(app({ merged_prs: 1 }), 'merged'), /1 change merged/,
    'and the one that is there is pluralised');
});

test('metaLine: the rows carry the line the store says they were sorted with', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [app({ slug: 'one', active_users: 2, merged_prs: 7 })];
  Browse.setSort('merged');
  assert.equal(state.sort, 'merged');
  assert.match(rowFor(state, 'one').meta, /7 changes merged/,
    'the meta line and the data-sort anchor can never disagree');
});

test('rowView: staging demo rows are inert (no detail page to open)', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [app({ slug: 'staging-demo-featured', demo: true })];
  Browse.render();
  const row = rowFor(state, 'staging-demo-featured');
  assert.equal(row.demo, true);
  assert.equal(row.openable, false, 'not presented as tappable');
  // Both the row tap and the cmd-click href re-check it, so a demo row is
  // inert under every activation path.
  assert.equal(Browse.rowHref(row), null);
  Browse.openRow(row);
  assert.equal(Browse._slug, null, 'the tap went nowhere');
});

test('syncFrom adopts an externally-fetched payload and repaints', () => {
  // Home.load() is where every detail-page action settles (add/remove,
  // retry, lock, delete), so this is how those land on this screen.
  const { Browse, state } = makeBrowse();
  Browse._apps = [app({ slug: 'before' })];
  Browse.render();
  assert.deepEqual(slugs(state), ['before']);
  Browse.syncFrom([app({ slug: 'after' })]);
  assert.deepEqual(slugs(state), ['after']);
  Browse.syncFrom(undefined);
  assert.deepEqual(slugs(state), ['after'], 'garbage is ignored');
});

test('Home.load hands its fresh payload to an open browse screen', () => {
  const load = HOME_SRC.slice(
    HOME_SRC.indexOf('async load() {'),
    HOME_SRC.indexOf('// ===== Rendering')
  );
  assert.ok(load.length > 200, 'located Home.load');
  assert.match(load, /window\.Browse\?\.isOpen\?\.\(\) \) *\?|window\.Browse\?\.isOpen\?\.\(\)/);
  assert.match(load, /Browse\.syncFrom\(apps\)/);
});

test('the browse rows no longer touch the home card menu at all', () => {
  assert.doesNotMatch(BROWSE_SRC, /openCardMenu/);
  assert.doesNotMatch(BROWSE_SRC, /closeCardMenu/);
  assert.doesNotMatch(BROWSE_SRC, /_maybeOpenShotMenu/);
  // ?shot=card-menu stays a HOME-only deep link.
  assert.match(HOME_SRC, /_maybeOpenShotMenu\(listEl\)/);
});

// ── Level 2: the app detail page ──────────────────────────────────

test('detailActionsFor: filters favorite + add-to-homescreen + app-details', () => {
  const { Browse, Home } = makeBrowse();
  // Stub the menu so this test pins the FILTER, not the (separately
  // tested) permission gates inside menuItemsFor.
  Home.menuItemsFor = () => ([
    { key: 'app-details', label: 'App details', run: () => {} },
    { key: 'favorite', label: 'Add to Your apps', run: () => {} },
    { key: 'add-to-homescreen', label: 'Add to Homeroom widget', run: () => {} },
    { key: 'retry', label: 'Retry', run: () => {} },
    { key: 'build-log', label: 'View build log', run: () => {} },
    { key: 'check-updates', label: 'Check for updates', keepOpen: true, run: () => {} },
    { key: 'fork', label: 'Fork this app', run: () => {} },
    { key: 'lock', label: 'Lock app', run: () => {} },
    { key: 'delete', label: 'Delete app', danger: true, run: () => {} },
  ]);
  const keys = Browse.detailActionsFor(app({ slug: 'x' })).map((i) => i.key);
  // Favorite is the dedicated Add/Remove button; the widget item is
  // "Your apps" only and belongs on home; app-details IS this page, so a
  // row for it would set the hash it's already on and appear dead.
  assert.deepEqual(keys, ['retry', 'build-log', 'check-updates', 'fork', 'lock', 'delete'],
    'order preserved, only the three excluded keys dropped');
  const actions = Browse.detailActionsFor(app({ slug: 'x' }));
  assert.equal(actions.find((a) => a.key === 'delete').danger, true, 'flags survive');
  assert.equal(actions.find((a) => a.key === 'check-updates').keepOpen, true);
  assert.deepEqual([...Browse.DETAIL_EXCLUDED_KEYS],
    ['favorite', 'add-to-homescreen', 'app-details']);
  assert.equal(Browse.detailActionsFor(null).length, 0, 'null-safe');
});

test('detailActionsFor: derives from Home.menuItemsFor, never re-derived', () => {
  // The whole point: one place owns the permission gates, so a new menu
  // item appears here for free unless it is explicitly excluded.
  const src = BROWSE_SRC.slice(BROWSE_SRC.indexOf('detailActionsFor(app) {'));
  assert.match(src.slice(0, 400), /Home\.menuItemsFor\(app\)/);
  // No re-implemented gating in this file.
  assert.doesNotMatch(BROWSE_SRC, /canAdminWrite/);
  assert.doesNotMatch(BROWSE_SRC, /is_collaborator/);
});

test('the detail page describes Open, Add/Remove and the action rows', () => {
  const { Browse, Home, state } = makeBrowse();
  Home.menuItemsFor = () => ([
    { key: 'favorite', label: 'Add to Your apps', run: () => {} },
    { key: 'fork', label: 'Fork this app', run: () => {} },
    { key: 'delete', label: 'Delete app', danger: true, run: () => {} },
  ]);
  Browse._apps = [app({ slug: 'detail-me', name: 'Detail Me', status: 'running' })];
  Browse.showDetail('detail-me');
  const d = state.detail;
  assert.equal(d.state, 'ready');
  assert.equal(d.name, 'Detail Me', 'full untruncated name');
  assert.equal(d.slug, 'detail-me');
  assert.equal(d.canOpen, true, 'Open is the primary action');
  assert.equal(d.openLabel, 'Open');
  assert.equal(d.favLabel, 'Add to Your apps');
  assert.deepEqual(d.actions.map((a) => a.label), ['Fork this app', 'Delete app'],
    'favorite is NOT duplicated as an action row');
  assert.equal(d.actions[1].danger, true, 'the danger row is flagged');
  assert.deepEqual(d.actions.map((a) => a.index), [0, 1],
    'the index is the handle back to the run closure');
});

test('the detail page disables Open when the app cannot be opened', () => {
  const { Browse, Home, state } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'broken', status: 'error' })];
  Browse.showDetail('broken');
  assert.equal(state.detail.canOpen, false);
  assert.equal(state.detail.openLabel, 'Not running');
  // awaiting_secrets IS openable (the user goes there to fill them in).
  Browse._apps = [app({ slug: 'secrets', status: 'awaiting_secrets' })];
  Browse.showDetail('secrets');
  assert.equal(state.detail.canOpen, true);
});

test('the detail page keeps its action closures off the store, reachable by index', () => {
  // The store carries plain data (it crosses into React); the `run` closures
  // stay on the controller. The click hands the clicked BUTTON back, so a
  // keepOpen item can still flip its own label in place.
  const { Browse, Home, state } = makeBrowse();
  const ran = [];
  Home.menuItemsFor = () => ([
    { key: 'retry', label: 'Retry', run: (btn) => ran.push(['retry', btn]) },
    { key: 'check-updates', label: 'Check for updates', keepOpen: true, run: () => ran.push(['check']) },
  ]);
  Browse._apps = [app({ slug: 'act' })];
  Browse.showDetail('act');
  assert.equal(JSON.stringify(state.detail.actions).includes('run'), false,
    'no function leaked into the descriptor');
  const btn = { id: 'stub' };
  Browse._runDetailAction(1, btn);
  Browse._runDetailAction(0, btn);
  assert.deepEqual(ran.map((r) => r[0]), ['check', 'retry']);
  assert.equal(ran[1][1], btn, 'the clicked element reaches the item');
  Browse._runDetailAction(99, btn);
  assert.equal(ran.length, 2, 'a stale index is inert, never a crash');
});

test('showDetail / showList publish the level, which drives both containers', () => {
  // The three nodes _syncLevel used to classList.toggle from outside React
  // (#browse-list-level, #browse-detail, #browse-search-bar) all read one
  // store field now — see browse-screen.tsx.
  const { Browse, Home, state, chrome } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a', name: 'App A' })];

  Browse.showDetail('a');
  assert.equal(state.level, 'detail',
    'searching a list nobody can see is meaningless');
  assert.equal(chrome.backIcon, 'arrow', 'a drill-in borrows the back chevron');
  assert.equal(chrome.title, 'App A');

  Browse.showList();
  assert.equal(state.level, 'list');
  // #1569: the list shares Home's root header; only detail pages need the
  // extra back slot. Home remains a destination in the shared menu.
  assert.equal(chrome.backIcon, 'none');
  assert.equal(chrome.backHref, undefined);
  assert.equal(chrome.title, 'All apps');
});

test('handleBack claims the header button only on the detail level', () => {
  const { Browse, Home, location } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a' })];
  assert.equal(Browse.handleBack(), false, 'on the list, back means Home');
  Browse.noteDetailOrigin('list');
  Browse.showDetail('a');
  assert.equal(Browse.handleBack(), true);
  assert.equal(location.hash, '#apps',
    'routed through the hash so the OS back gesture agrees');
});

// Back has to land where the user came IN from. A detail page opened from a
// home card's "App details" menu never showed the list, so backing out to
// it strands the user on a screen they never visited (the reported bug).
test('handleBack goes HOME when the detail page was entered from home', () => {
  const { Browse, Home, location, chrome } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a' })];
  Browse.noteDetailOrigin('home');
  Browse.showDetail('a');
  assert.equal(Browse._detailOrigin, 'home');
  assert.equal(chrome.backIcon, 'home', 'a detail opened from Home keeps its Home button');
  assert.equal(Browse.handleBack(), true, 'still claims the button');
  assert.equal(chrome.wentHome, 1, 'leaves the screen instead of showing the list');
  assert.equal(location.hash, '',
    'no #apps write — navigateHome owns the URL from here');
});

test('the origin defaults to the list for a deep link, and never leaks', () => {
  const { Browse, Home, location } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a' }), app({ slug: 'b' })];
  // No note at all (a cold #apps/<slug> deep link or ?shot=browse-detail):
  // the enclosing screen is the list, which is the only answer available.
  Browse.showDetail('a');
  assert.equal(Browse._detailOrigin, 'list');
  // A home-entered page followed by a list-entered one must not stay 'home'.
  Browse.noteDetailOrigin('home');
  Browse.showDetail('a');
  assert.equal(Browse._detailOrigin, 'home');
  Browse.showList();
  Browse.showDetail('b');
  assert.equal(Browse._detailOrigin, 'list', 'the note is consumed, not sticky');
  Browse.handleBack();
  assert.equal(location.hash, '#apps');
  // Leaving the screen retires it too.
  Browse.noteDetailOrigin('home');
  Browse.close();
  assert.equal(Browse._detailOrigin, 'list');
  assert.equal(Browse._pendingOrigin, null);
});

test('a browse row tap declares the list as its origin; the home menu declares home', () => {
  // Both call sites note the origin BEFORE writing the hash — the
  // hashchange lands in a later task, so the note is always in place.
  const tap = BROWSE_SRC.slice(BROWSE_SRC.indexOf('openRow(view) {'),
    BROWSE_SRC.indexOf('warmRow(view) {'));
  assert.match(tap, /noteDetailOrigin\('list'\)/);
  assert.ok(tap.indexOf("noteDetailOrigin('list')") < tap.indexOf('location.hash'));
  // And the #1036 modified-click href repeats openRow's guard, so a demo row
  // stays inert under cmd/middle-click too.
  assert.match(BROWSE_SRC, /rowHref\(view\) \{[\s\S]*?view\.demo/);

  const item = HOME_SRC.slice(HOME_SRC.indexOf("key: 'app-details'"));
  const run = item.slice(0, 400);
  assert.match(run, /Browse\?\.noteDetailOrigin\?\.\('home'\)/);
  assert.ok(run.indexOf("noteDetailOrigin?.('home')") < run.indexOf('location.hash'));
});

test('route animates a drill-in as a push and the way back as a pop', () => {
  const { Browse, Home, chrome } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a' })];
  Browse.route('a');
  assert.deepEqual(chrome.transitions, ['push']);
  Browse.route(null);
  assert.deepEqual(chrome.transitions, ['push', 'pop']);
  // A repeat hash write for the level already showing must not re-animate.
  Browse.route(null);
  assert.deepEqual(chrome.transitions, ['push', 'pop']);
});

test('a cold deep link falls back to GET /api/apps/:slug', async () => {
  const { Browse, Home, state, fetchCalls } = makeBrowse({ apps: [] });
  Home.menuItemsFor = () => [];
  // Nothing cached — the detail level has to read the one app itself.
  Browse._slug = 'cold-app';
  Browse.render();
  assert.equal(state.detail.state, 'loading');
  await flush();
  await flush();
  assert.ok(fetchCalls.some((c) => c.url === '/api/apps/cold-app'),
    'fetched the single app');
});

test('a deep link to a missing app renders the not-available state', async () => {
  const { Browse, Home, state } = makeBrowse({ fetchOk: false });
  Home.menuItemsFor = () => [];
  Browse._slug = 'ghost';
  Browse.render();
  await flush();
  await flush();
  assert.equal(state.detail.state, 'missing');
  // The copy and its escape-hatch anchor are browse-detail.tsx's.
  const tsx = read('frontend/src/features/apps/browse-detail.tsx');
  assert.match(tsx, /isn&rsquo;t available/);
  assert.match(tsx, /id="browse-detail-back"/);
  assert.match(tsx, /Back to all apps/);
});

test('syncFrom drops to the list when the open app is deleted away', () => {
  const { Browse, Home, location } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'doomed' })];
  Browse.showDetail('doomed');
  location.hash = '#apps/doomed';
  Browse.syncFrom([app({ slug: 'survivor' })]);
  assert.equal(location.hash, '#apps', 'no page left to show');
});

test('?shot=browse-detail drills into the first real row, once', () => {
  // The captures can never click, so the detail page needs a URL that
  // doesn't hard-code a slug (seed data moves).
  const { Browse, Home, state, history } = makeBrowse({ search: '?shot=browse-detail' });
  Home.menuItemsFor = () => [];
  Browse._apps = [
    app({ slug: 'demo-row', demo: true }),
    app({ slug: 'real-row', name: 'Real Row' }),
  ];
  Browse.render();
  assert.equal(Browse._slug, 'real-row', 'skips the inert demo row');
  assert.equal(state.detail.name, 'Real Row');
  // The URL is aligned with replaceState — NOT by assigning location.hash,
  // which would fire a hashchange that races the rest of boot and loses.
  assert.deepEqual(history.calls, ['?shot=browse-detail#apps/real-row']);
  assert.doesNotMatch(BROWSE_SRC, /location\.hash = `#apps\/\$\{encodeURIComponent\(row/);
  // Latched: a later re-render must not yank the user back to a detail.
  Browse.showList();
  Browse.render();
  assert.equal(Browse._slug, null);
});

test('no ?shot=browse-detail means no drill-in', () => {
  const { Browse, history } = makeBrowse();
  Browse._apps = [app({ slug: 'real-row' })];
  Browse.render();
  assert.equal(Browse._slug, null);
  assert.equal(history.calls.length, 0);
});

test('render: empty result explains itself, with the query when there is one', () => {
  // `empty` is a string-or-null now: the copy AND the note's visibility are
  // one field, because #browse-empty is React-rendered.
  const { Browse, state } = makeBrowse();
  Browse._apps = [app({ slug: 'chess', name: 'Chess' })];
  Browse._query = 'nothing-matches';
  Browse.render();
  assert.match(state.empty, /No apps match/);
  assert.match(state.empty, /nothing-matches/, 'quotes what was typed');
  Browse._query = '';
  Browse.render();
  assert.equal(state.empty, null, 'a populated grid hides the empty note');
  Browse._apps = [];
  Browse.render();
  assert.match(state.empty, /No apps to show yet/, 'and a truly empty directory says so');
});

// ── Data flow ────────────────────────────────────────────────────

test('_load fetches /api/apps and shares the payload with Home', async () => {
  const rows = [app({ slug: 'a' }), app({ slug: 'b' })];
  const { Browse, Home, fetchCalls } = makeBrowse({ apps: rows });
  await Browse._load();
  assert.deepEqual(fetchCalls.map((c) => c.url), ['/api/apps']);
  assert.deepEqual(Browse._apps.map((a) => a.slug), ['a', 'b']);
  assert.deepEqual(Home._apps.map((a) => a.slug), ['a', 'b'],
    'returning home shows adds made here');
});

test('_load forwards ?demo=1 so staging demo tiles show up here too', async () => {
  const { Browse, fetchCalls } = makeBrowse({ search: '?demo=1' });
  await Browse._load();
  assert.deepEqual(fetchCalls.map((c) => c.url), ['/api/apps?demo=1']);
});

test('_load failure renders an inline error, never throws', async () => {
  const { Browse, state } = makeBrowse({ fetchOk: false });
  await Browse._load();
  assert.equal(state.error, true);
  assert.equal(state.rows.length, 0, 'and the stale list is cleared');
  // #1899: drawn as the shared error card with a Retry, not a red line.
  assert.match(read('frontend/src/features/apps/browse-screen.tsx'), /<AppsLoadError[\s\S]*?title="Couldn't load the app directory"[\s\S]*?onRetry=\{\(\) => browse\(\)\?\._load\?\.\(\)\}/);
});

test('open seeds first paint from Home._apps, then refetches', async () => {
  const { Browse, Home, state, fetchCalls } = makeBrowse({ apps: [] });
  Home._apps = [app({ slug: 'cached', name: 'Cached App' })];
  Browse.open();
  assert.deepEqual(slugs(state), ['cached'], 'instant paint from the home cache');
  await flush();
  assert.equal(fetchCalls.length, 1, 'still reconciles with the server');
  assert.equal(Browse.isOpen(), true);
  Browse.close();
  assert.equal(Browse.isOpen(), false);
});

// ── Add / remove writes (Home.toggleAdded, shared with the featured row) ──

test('toggleAdded posts { favorited } and flips the cached flags', async () => {
  const { Browse, Home, fetchCalls } = makeBrowse();
  const fresh = app({ slug: 'fresh' });
  Home._apps = [fresh];
  Browse._apps = [fresh];
  await Home.toggleAdded('fresh', true, () => {});
  assert.equal(fresh.is_favorited, true);
  assert.deepEqual(fetchCalls[0], {
    url: '/api/apps/fresh/favorite', method: 'POST', body: { favorited: true },
  });
});

// ── #1567: the write REPAINTS, it does not wait for a reload ─────────

test('toggleAdded repaints Your apps before the write lands, and tells the caller too', async () => {
  const { Home, renders, fetchCalls } = makeBrowse();
  const fresh = app({ slug: 'fresh' });
  Home._apps = [fresh];
  let notified = 0;
  const p = Home.toggleAdded('fresh', true, () => { notified += 1; });
  // Both before the POST has resolved: the section is the optimistic flip's
  // to show, and this is what made an add from the home screen look like it
  // had done nothing until a reload.
  assert.equal(renders.count, 1, 'the launcher grid and the panels repaint');
  assert.equal(notified, 1, "and the caller's own list is told as well");
  assert.equal(fetchCalls.length, 1, 'one write');
  await p;
  assert.equal(renders.count, 1, 'a successful write adds no second paint');
});

test('toggleAdded repaints again on the failure path, through the reload', async () => {
  const { Home, renders } = makeBrowse({ fetchOk: false });
  const fresh = app({ slug: 'fresh' });
  Home._apps = [fresh];
  let notified = 0;
  // load() is the launcher's own re-sync; the paint it would do is counted
  // here so the revert is as visible as the optimistic flip was.
  Home.load = async () => { Home.render(); };
  await Home.toggleAdded('fresh', true, () => { notified += 1; });
  assert.equal(fresh.is_favorited, false, 'reverted');
  assert.equal(renders.count, 2, 'painted the add, then painted it back out');
  assert.equal(notified, 2);
});

test('a failed add clears the reveal, so nothing expands for an app that never arrived', async () => {
  const { Home } = makeBrowse({ fetchOk: false });
  const fresh = app({ slug: 'fresh' });
  Home._apps = [fresh];
  Home.load = async () => {};
  await Home.toggleAdded('fresh', true, () => {});
  assert.equal(Home._revealSlug, null);
});

test('a removal never sets the reveal — an expanded grid showing an absence is nonsense', async () => {
  const { Home } = makeBrowse();
  const mine = app({ slug: 'mine', is_favorited: true });
  Home._apps = [mine];
  await Home.toggleAdded('mine', false, () => {});
  assert.equal(Home._revealSlug, null);
});

test('toggleAdded on a member app writes the hidden opt-out, not a delete (#618)', async () => {
  const { Home } = makeBrowse();
  const member = app({ slug: 'mine', is_collaborator: true });
  Home._apps = [member];
  await Home.toggleAdded('mine', false, () => {});
  assert.equal(member.is_favorited, false);
  assert.equal(member.your_apps_hidden, true,
    'membership and access are untouched — display only');
});

test('toggleAdded reverts the optimistic flip when the write fails', async () => {
  const { Home, nodes } = makeBrowse({ fetchOk: false });
  const fresh = app({ slug: 'fresh' });
  Home._apps = [fresh];
  let reloaded = 0;
  Home.load = async () => { reloaded += 1; };
  await Home.toggleAdded('fresh', true, () => {});
  assert.equal(fresh.is_favorited, false, 'reverted');
  assert.equal(reloaded, 1, 'and re-synced with server truth');
  assert.ok(nodes);
});

test('toggleAdded ignores staging demo tiles (their slugs have no DB row)', async () => {
  const { Home, fetchCalls } = makeBrowse();
  Home._apps = [app({ slug: 'staging-demo-featured', demo: true })];
  await Home.toggleAdded('staging-demo-featured', true, () => {});
  assert.equal(fetchCalls.length, 0, 'a POST would 404');
});

// ── index.html shell ─────────────────────────────────────────────

test('index.html hosts #browse-screen with its own search field and grid', () => {
  // Ships hidden, and is the flex-child scroller its siblings are. Matched
  // per-class rather than as one closed string so an added utility (e.g.
  // `platform-safe-scroll`, which reserves the home-indicator strip for
  // the last row) doesn't fail this on a substring.
  const openTag = /<main id="browse-screen"[^>]*>/.exec(INDEX);
  assert.ok(openTag, '#browse-screen is missing from index.html');
  for (const cls of ['hidden', 'flex-1', 'overflow-y-auto']) {
    assert.match(openTag[0], new RegExp(`(?:class="|\\s)${cls}(?:\\s|")`),
      `#browse-screen must keep the ${cls} utility`);
  }
  const main = INDEX.slice(
    INDEX.indexOf('<main id="browse-screen"'),
    INDEX.indexOf('</main>', INDEX.indexOf('<main id="browse-screen"'))
  );
  assert.ok(main.includes('id="browse-search-input"'));
  assert.ok(main.includes('id="browse-list"'));
  assert.ok(main.includes('id="browse-empty"'));
  // Always visible here — the hidden-until-pulled treatment is home's.
  assert.match(main, /id="browse-search-bar"[^>]*sticky/);
  // Two levels in ONE <main>: the list wrapper and the detail page. Keeping
  // the detail inside this screen is what leaves _exitBrowse, the PTR
  // wiring and every sibling hide-list untouched.
  assert.ok(main.includes('id="browse-list-level"'));
  assert.match(main, /id="browse-detail" class="hidden/);
});

// browse.js used to be a classic <script> loaded after home.js, and this test
// pinned that order plus its own precache entry. #1083 chunk F moved it into
// the React bundle, so both registers change at once: the island imports it,
// and /shell/assets/shell.js — already in SHELL_ASSETS — is what precaches it.
test('browse.js is a bundle module the #browse-screen island imports', () => {
  // Since conversion 3 the island reaches it through ./mount.ts, which is
  // also what plants the store and publishes the controller for the legacy
  // callers — the same seam profile and notifications landed on.
  assert.match(
    read('frontend/src/features/apps/browse-screen.tsx'),
    /from '\.\/mount'/,
    'the island must import the mount — nothing else pulls the module in'
  );
  assert.match(
    read('frontend/src/features/apps/mount.ts'),
    /import '\.\/browse\.js';/,
    'and the mount is what actually loads the controller'
  );
  assert.ok(!INDEX.includes('/js/browse.js'), 'the retired script tag must be gone from the shell');
  assert.ok(!read('public/sw.js').includes('/js/browse.js'), 'and its precache entry with it');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'js', 'browse.js')),
    'and the file itself must be gone from public/js/');
  // The load-order dependency it had on home.js is gone too, and so is the
  // markup: the icon tile and the chip strip are app-card.js's decisions,
  // rendered by app-card-view.tsx off the row's `app` record.
  assert.doesNotMatch(BROWSE_SRC, /Home\.iconTileFor|Home\.renderAppPillsHtml/);
  assert.doesNotMatch(BROWSE_SRC, /iconTileFor|renderAppPillsHtml/,
    'the string builders belong to the surfaces that are still legacy');
  assert.match(read('frontend/src/features/apps/browse-list.tsx'),
    /from '\.\/app-card-view'/);
});

test('#1553: the row button names the destination, like every other surface', () => {
  // "Add" alone did not say add to WHAT, and this row was the only place the
  // platform left that a guess — the detail page's button, the app-chip menu
  // and this button's own title attribute all spell out "Your apps".
  const listSrc = read('frontend/src/features/apps/browse-list.tsx');
  assert.match(listSrc, /'Added' : 'Add to Your apps'/);
  assert.doesNotMatch(listSrc, /'Added' : 'Add'/);
  // The state label stays short: the row it sits on already says which app.
  assert.match(listSrc, /view\.added \? 'Added'/);
});

// ── app.js routing ───────────────────────────────────────────────

test('#apps and #apps/<slug> both route to navigateToBrowse', () => {
  assert.match(APP_SRC, /parts\[0\] === 'apps'/);
  const branch = APP_SRC.slice(APP_SRC.indexOf("parts[0] === 'apps'"));
  // The optional second segment is the detail page's deep link, decoded on
  // the way in (the hash round-trip isn't guaranteed to be byte-identical).
  assert.match(branch.slice(0, 700),
    /App\.navigateToBrowse\(parts\[1\] \? decodeURIComponent\(parts\[1\]\) : null\)/);
});

test('navigateToBrowse / _exitBrowse follow the screen pattern', () => {
  assert.match(APP_SRC, /navigateToBrowse\(slug\) \{/);
  assert.match(APP_SRC, /_exitBrowse\(\) \{/);
  const nav = APP_SRC.slice(
    APP_SRC.indexOf('navigateToBrowse(slug) {'),
    APP_SRC.indexOf('_exitBrowse() {')
  );
  assert.match(nav, /setHeaderTitle\('All apps'\)/);
  assert.match(nav, /App\._inBrowse = true/);
  assert.match(nav, /Browse\.open\(slug \|\| null, \{ chrome: false \}\)/);
  assert.match(nav, /App\._showOnlyScreen\('browse-screen'\)/);
  // Already mounted -> an in-screen LEVEL change, not a screen entry:
  // re-running the swap would replay the entry animation on a drill-in.
  assert.match(nav, /App\._inBrowse && window\.Browse\?\.isOpen\?\.\(\)/);
  assert.match(nav, /Browse\.route\(slug \|\| null\)/);
  // #979: the entry's visible mutations live inside the transition
  // callback, so the outgoing page is snapshotted as it looked. Browse's
  // own level chrome is deferred with it.
  const preTransition = nav.slice(0, nav.indexOf('PlatformUI.transition('));
  for (const forbidden of ['setHeaderTitle', 'setBackIcon', 'classList']) {
    assert.ok(!preTransition.includes(forbidden),
      `no ${forbidden} before the transition (it would land in the outgoing snapshot)`);
  }
  assert.match(nav, /Browse\.syncChrome\(\)/,
    'the deferred level chrome is applied inside the callback');
  // Leaving the screen is state-only now — the back chevron is handed back
  // by the next screen's _showOnlyScreen.
  const exit = APP_SRC.slice(APP_SRC.indexOf('_exitBrowse() {'));
  const exitBody = exit.slice(0, exit.indexOf('\n  },'));
  assert.ok(!exitBody.includes('setBackIcon'),
    '_exitBrowse no longer touches the back icon (#979)');
  assert.ok(!exitBody.includes('classList'),
    '_exitBrowse no longer hides the screen (#979)');
  assert.match(exitBody, /Browse\.close\(\)/);
});

test('the header back button consults Browse.handleBack', () => {
  const handler = APP_SRC.slice(APP_SRC.indexOf("getElementById('back-btn').addEventListener"));
  const body = handler.slice(0, 1800);
  assert.match(body, /App\._inBrowse && window\.Browse\?\.handleBack\?\.\(\)/);
  // Ordered after the admin/settings hooks and before the href fallback and
  // the navigateHome below it.
  assert.ok(body.indexOf('Browse?.handleBack') < body.indexOf('App.navigateHome()'));
});

test('every sibling screen hides #browse-screen and exits the flag', () => {
  // One list of screen roots, hidden through one primitive (#979) — the
  // per-navigation hand-rolled hide lists are gone, so what this test
  // pins is (a) browse is in that list, (b) every sibling entry calls the
  // primitive, and (c) the flag is still exited.
  assert.match(APP_SRC, /SCREEN_IDS: \[[^\]]*'browse-screen'/,
    '#browse-screen is one of the mutually exclusive screen roots');
  for (const fn of ['navigateToProfile', 'navigateToAdminConsole', 'navigateToSettings',
    'navigateToLeaderboard']) {
    // Anchor on the DEFINITION (two-space indent), not the many comment
    // references to these names earlier in the file.
    const start = APP_SRC.indexOf(`\n  ${fn}(`);
    assert.ok(start > 0, `${fn} exists`);
    const body = APP_SRC.slice(start, start + 2600);
    assert.match(body, /App\._inBrowse\) App\._exitBrowse\(\)/, `${fn} exits browse`);
    assert.match(body, /App\._showOnlyScreen\('[a-z-]+'\)/,
      `${fn} hides every other root through _showOnlyScreen`);
  }
  // navigateHome must exit it too, or the grid stays mounted.
  const home = APP_SRC.slice(APP_SRC.indexOf('navigateHome() {'));
  assert.match(home.slice(0, 1200), /App\._inBrowse\) App\._exitBrowse\(\)/);
  assert.match(home.slice(0, 2600), /App\._showOnlyScreen\('home-screen', \['app-view'\]\)/,
    'going home reveals home and hides every root but the shrinking app card');
  // Bare "/" with the browse screen up resolves back home.
  assert.match(APP_SRC, /else if \(App\._inBrowse\) App\.navigateHome\(\);/);
});

test('the app-view zoom departs from whichever screen was on top', () => {
  // Hard-coding #home-screen here left the browse grid painted behind the
  // opened app. Since the _exitX helpers became state-only (#979) the
  // settings / admin / profile / leaderboard roots are live at this point
  // too, so the answer is read off the DOM rather than off _inBrowse.
  assert.match(APP_SRC, /_departingScreen\(\) \{/);
  const dep = APP_SRC.slice(APP_SRC.indexOf('_departingScreen() {'));
  const depBody = dep.slice(0, dep.indexOf('\n  },'));
  assert.match(depBody, /for \(const id of App\.SCREEN_IDS\)/,
    'it scans every screen root');
  // Through the visibility seam (#1078), not a raw classList read: a root
  // React owns publishes its state into the store instead of carrying
  // `.hidden`, so reading the class directly would answer "visible" for a
  // React screen that is actually down.
  assert.match(depBody, /App\._isScreenVisible\(id\)/,
    'and returns the one that is actually visible');
  assert.match(depBody, /return document\.getElementById\('home-screen'\)/,
    'home is the fallback');
  const nav = APP_SRC.slice(APP_SRC.indexOf('async navigateToApp('));
  const zoom = nav.slice(0, nav.indexOf('await AppView.open('));
  assert.match(zoom, /const departing = App\._departingScreen\(\)/);
  assert.ok(zoom.indexOf('const departing') < zoom.indexOf('App._exitLeaderboard()'),
    'resolved before the _exitX flags are cleared');
  assert.match(zoom, /outEl: departing/);
  assert.match(zoom, /after: \(\) => \{ App\._showOnlyScreen\('app-view'\); \}/,
    'the conceal hook hides EVERY other root, not just `departing`');
});

test('_tileFor resolves tiles in the two grids that still HAVE tiles', () => {
  const fn = APP_SRC.slice(APP_SRC.indexOf('_tileFor(slug) {'));
  const body = fn.slice(0, fn.indexOf('_departingScreen'));
  assert.match(body, /#app-list \.app-card/);
  assert.match(body, /#home-featured-list \.app-card/);
  // Browse renders app-store ROWS now, not icon tiles, so there is no tile
  // rect to zoom out of there — the kit falls back to a push.
  assert.doesNotMatch(body, /#browse-list/);
  // The anonymous landing directory must stay excluded.
  assert.doesNotMatch(body, /#landing-apps/);
});

test('the browse scroller gets its own pull-to-refresh', () => {
  const fn = APP_SRC.slice(
    APP_SRC.indexOf('_wirePullToRefresh() {'),
    APP_SRC.indexOf('bindEvents() {')
  );
  assert.match(fn, /getElementById\('browse-screen'\)/);
  assert.match(fn, /pullToRefresh\(browse,/);
  // Routed through _refreshOrReload like every other screen, so a pull
  // also recovers from a platform redeploy.
  assert.match(fn, /App\._refreshOrReload\(\(\) => \(window\.Browse \? Browse\._load\(\)/);
});

// ── Contributors section (#919) ────────────────────────────────────────
//
// The card is DESCRIBED by a PURE function of (cache entry, expanded flag),
// so every state is pinned here without a DOM or a fetch — the same
// discipline sortApps / metaLine / rowView already follow. Since #1191 slice
// 6 that function returns a view object rather than an HTML string;
// browse-detail.tsx renders it, and the escaping that used to be this file's
// job is React's.

const contrib = (over) => ({
  user_id: 10,
  username: 'alice',
  merged_count: 7,
  votes_count: 12,
  is_creator: false,
  is_member: false,
  ...over,
});

const ready = (items, total) => ({
  state: 'ready',
  items,
  total: total == null ? items.length : total,
});

test('contributors: the heading paints while loading so the page cannot jump', () => {
  const { Browse } = makeBrowse();
  const view = Browse.contributorsView({ state: 'loading', items: [], total: 0 }, {});
  assert.equal(view.state, 'loading');
  assert.match(view.note, /Loading contributors/);
  // No count chip until there is a real number to show.
  assert.equal(view.count, null);
  assert.equal(view.rows.length, 0);
});

test('contributors: a ready row carries rank, avatar, @username, meta and the merged pill', () => {
  const { Browse } = makeBrowse();
  const view = Browse.contributorsView(
    ready([contrib({ username: 'alice', merged_count: 12, votes_count: 30, is_creator: true })]),
    {}
  );
  assert.equal(view.count, 1, 'the total rides the heading');
  const row = view.rows[0];
  assert.equal(row.who, 'alice');
  assert.equal(row.rank, 1, 'rank number');
  assert.equal(row.initial, 'A', 'initial-avatar circle');
  assert.equal(row.meta, 'Creator · 30 votes', 'role then vote count');
  assert.equal(row.merged, 12);
  assert.match(row.pillTint, /violet/, 'a non-zero count gets the violet pill');
});

test('contributors: creator wins over member on the role label', () => {
  const { Browse } = makeBrowse();
  const view = Browse.contributorsView(
    ready([contrib({ is_creator: true, is_member: true, votes_count: 0 })]), {}
  );
  assert.equal(view.rows[0].meta, 'Creator',
    'the creator is always a member too — saying both is noise');
});

test('contributors: a zero-merge row keeps a muted pill, and zero votes drop the meta line', () => {
  const { Browse } = makeBrowse();
  const view = Browse.contributorsView(
    ready([contrib({ username: 'lurker', merged_count: 0, votes_count: 0 })]), {}
  );
  assert.equal(view.rows[0].merged, 0,
    'the row still shows a count so the column stays aligned');
  assert.match(view.rows[0].pillTint, /bg-zinc-100/, 'muted rather than violet at zero');
  assert.equal(view.rows[0].meta, null, 'no vote fragment at zero');
  // A votes-only contributor DOES get the fragment.
  const votesOnly = Browse.contributorsView(
    ready([contrib({ merged_count: 0, votes_count: 19 })]), {}
  );
  assert.equal(votesOnly.rows[0].meta, '19 votes');
  assert.equal(votesOnly.rows[0].merged, 0);
});

test('contributors: one vote is singular', () => {
  const { Browse } = makeBrowse();
  const view = Browse.contributorsView(ready([contrib({ votes_count: 1 })]), {});
  assert.match(view.rows[0].meta, /1 vote(?!s)/);
});

test('contributors: the list folds at 5 with a Show-all toggle, and expands in place', () => {
  const { Browse } = makeBrowse();
  const seven = Array.from({ length: 7 }, (_, i) =>
    contrib({ user_id: i, username: `u${i}`, merged_count: 7 - i }));

  const folded = Browse.contributorsView(ready(seven), {});
  assert.equal(folded.rows.length, 5, 'top 5 only');
  assert.equal(folded.toggle, 'Show all 7 contributors');
  assert.equal(folded.rows.some((r) => r.who === 'u5'), false);

  const open = Browse.contributorsView(ready(seven), { expanded: true });
  assert.equal(open.rows.length, 7);
  assert.equal(open.toggle, 'Show fewer');
  assert.equal(open.rows.some((r) => r.who === 'u6'), true);
});

test('contributors: exactly 5 rows need no toggle', () => {
  const { Browse } = makeBrowse();
  const five = Array.from({ length: 5 }, (_, i) => contrib({ user_id: i, username: `u${i}` }));
  const view = Browse.contributorsView(ready(five), {});
  assert.equal(view.rows.length, 5);
  assert.equal(view.toggle, null);
});

test('contributors: a server-capped list quotes the true total but cannot reveal more locally', () => {
  const { Browse } = makeBrowse();
  // 6 rows arrived, the app really has 40 — the label says 40, and the
  // toggle can still only unfold what is in hand.
  const six = Array.from({ length: 6 }, (_, i) => contrib({ user_id: i, username: `u${i}` }));
  const view = Browse.contributorsView(ready(six, 40), { expanded: true });
  assert.equal(view.count, 40);
  assert.equal(view.rows.length, 6);
});

test('contributors: empty and error states each carry their own copy', () => {
  const { Browse } = makeBrowse();
  const empty = Browse.contributorsView(ready([]), {});
  assert.match(empty.note, /No contributors yet/);
  assert.equal(empty.rows.length, 0);
  // The card itself is unconditional in browse-detail.tsx — kept, not hidden.
  assert.match(read('frontend/src/features/apps/browse-detail.tsx'),
    /id="browse-detail-contributors"/);

  const errored = Browse.contributorsView({ state: 'error', items: [], total: 0 }, {});
  assert.match(errored.note, /load contributors/);
  assert.equal(errored.rows.length, 0);
});

test('contributors: a hostile username stays DATA all the way to the renderer', () => {
  // The escaping this file used to do by hand is React's now, so what has to
  // hold here is that nothing concatenates the name into markup on the way.
  const { Browse } = makeBrowse();
  const view = Browse.contributorsView(
    ready([contrib({ username: '"><img src=x>&' })]), {}
  );
  assert.equal(view.rows[0].who, '"><img src=x>&', 'passed through verbatim');
  assert.equal(view.rows[0].initial, '"');
  assert.doesNotMatch(BROWSE_SRC, /\.innerHTML\s*=/, 'this module writes no markup at all');
  const tsx = read('frontend/src/features/apps/browse-detail.tsx');
  const contribRow = tsx.slice(tsx.indexOf('function ContributorRow'));
  assert.doesNotMatch(contribRow.slice(0, 1200), /dangerouslySetInnerHTML/);
});

test('contributors: a missing entry describes the loading card, never a crash', () => {
  const { Browse } = makeBrowse();
  assert.match(Browse.contributorsView(undefined, {}).note, /Loading contributors/);
  assert.match(Browse.contributorsView({ state: 'ready' }, {}).note, /No contributors yet/);
});

test('the detail page mounts the contributors card BELOW the action rows', async () => {
  const { Browse, Home, state } = makeBrowse({
    contributors: [contrib({ username: 'alice' })],
  });
  Home.menuItemsFor = () => ([{ key: 'fork', label: 'Fork this app', run: () => {} }]);
  Browse._apps = [app({ slug: 'detail-me', name: 'Detail Me' })];
  Browse.showDetail('detail-me');
  assert.match(state.detail.contributors.note, /Loading contributors/,
    'first paint is the loading card');
  assert.deepEqual(state.detail.actions.map((a) => a.label), ['Fork this app'],
    'the rest of the page is untouched');
  await flush(); await flush();
  assert.equal(state.detail.contributors.rows[0].who, 'alice');
  // The ORDER is browse-detail.tsx's: the action rows stay above, so the
  // page's primary navigation is not pushed down.
  const tsx = read('frontend/src/features/apps/browse-detail.tsx');
  const ready2 = tsx.slice(tsx.indexOf('function Ready('));
  assert.ok(ready2.indexOf('browse-detail-open') < ready2.indexOf('view.actions.map'));
  assert.ok(ready2.indexOf('view.actions.map') < ready2.indexOf('<Contributors'));
});

test('the detail page reads contributors once, and a repaint does NOT refetch', async () => {
  const { Browse, Home, fetchCalls } = makeBrowse({ contributors: [contrib()] });
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'once' })];
  Browse.showDetail('once');
  await flush(); await flush();
  const url = '/api/apps/once/contributors';
  assert.equal(fetchCalls.filter((c) => c.url === url).length, 1);
  // syncFrom repaints on every /api/apps refresh, and the fold toggle
  // repaints too — neither may re-read.
  Browse.syncFrom([app({ slug: 'once' })]);
  Browse.render();
  await flush();
  assert.equal(fetchCalls.filter((c) => c.url === url).length, 1, 'served from the cache');
});

test('the contributors read carries the ?demo=1 passthrough', async () => {
  const { Browse, Home, fetchCalls } = makeBrowse({ search: '?demo=1' });
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'demoed' })];
  Browse.showDetail('demoed');
  await flush(); await flush();
  assert.ok(fetchCalls.some((c) => c.url === '/api/apps/demoed/contributors?demo=1'),
    'staging demo rows have to reach the detail page too');
});

test('a failed contributors read degrades to the error card, not a broken page', async () => {
  const { Browse, Home, state } = makeBrowse({ fetchOk: false });
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'sad' })];
  Browse.showDetail('sad');
  await flush(); await flush();
  assert.match(state.detail.contributors.note, /load contributors/);
  assert.equal(state.detail.state, 'ready', 'the rest of the detail page still renders');
  assert.equal(state.detail.slug, 'sad');
});

test('every level change resets the expanded fold', () => {
  const { Browse, Home } = makeBrowse();
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'a' }), app({ slug: 'b' })];
  for (const enter of [
    () => Browse.showDetail('b'),
    () => { Browse._slug = null; Browse.route('b'); },
    () => Browse.showList(),
    () => Browse.open('b'),
  ]) {
    Browse._contribExpanded = true;
    enter();
    assert.equal(Browse._contribExpanded, false,
      'a new page must never inherit the previous one’s fold state');
  }
});

test('leaving the screen drops the contributor cache so counts are re-read', async () => {
  const { Browse, Home, fetchCalls } = makeBrowse({ contributors: [contrib()] });
  Home.menuItemsFor = () => [];
  Browse._apps = [app({ slug: 'again' })];
  Browse.showDetail('again');
  await flush(); await flush();
  Browse.close();
  assert.equal(Browse._contrib.size, 0);
  Browse._open = true;
  Browse._apps = [app({ slug: 'again' })];
  Browse.showDetail('again');
  await flush(); await flush();
  assert.equal(fetchCalls.filter((c) => c.url === '/api/apps/again/contributors').length, 2,
    'merges land while the user is away — a fresh visit re-reads');
});

test('a contributor row routes to the existing leaderboard profile hash', () => {
  // The row is a hash link, so this screen owns no profile rendering; the
  // route is the one app.js already handles (#leaderboard/users/<name>).
  const { Browse, location } = makeBrowse();
  Browse.openContributor('alice');
  assert.equal(location.hash, '#leaderboard/users/alice');
  Browse.openContributor('');
  assert.equal(location.hash, '#leaderboard/users/alice', 'a nameless row is inert');
  assert.match(APP_SRC, /parts\[1\] === 'users' && parts\[2\]/,
    'app.js still routes the third segment as a profile username');
});

test('the cold deep-link fetch unwraps the { app } envelope the route sends', async () => {
  // Regression: reading the response as a BARE app row made every cold
  // deep link fall through to the "isn't available" state whenever the
  // concurrent /api/apps list didn't happen to carry the slug.
  const { Browse, Home, state } = makeBrowse({
    apps: [],
    coldApp: { slug: 'cold-app', name: 'Cold App', status: 'running' },
  });
  Home.menuItemsFor = () => [];
  Browse._slug = 'cold-app';
  Browse.render();
  await flush(); await flush(); await flush();
  assert.equal(state.detail.state, 'ready', 'the app painted');
  assert.equal(state.detail.name, 'Cold App');
  assert.equal(Browse._detailMissing, false);
});
