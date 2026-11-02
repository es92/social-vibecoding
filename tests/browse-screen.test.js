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
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
// browse.js is a bundle module since #1083 chunk F, but it is deliberately
// still a valid CLASSIC script: this test compiles the real source in a vm
// context, which is why the store arrives by the `_store` plant ./mount.ts
// does rather than by an `import`. The strip below is kept as a guard — if a
// future edit does add an import, it drops out here instead of turning every
// test in this file into one SyntaxError. installAppCard is still run because
// these tests read app-card.js's shared chip decision directly.
const BROWSE_SRC = read('frontend/src/features/apps/browse.js')
  .replace(/^import .*;$/gm, '');
const BROWSE_LIST_SRC = read('frontend/src/features/apps/browse-list.tsx');
const APP_SRC = read('public/js/app.js');
const APP_CSS = read('public/css/app.css');
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
  // What the Share row said, for the tests that assert on it.
  const toasts = [];
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
      toast: (message) => { toasts.push(message); },
      // The shell's clipboard helper; resolves true unless a test says not.
      copyText: opts.copyText || (async () => true),
      // The kit wrapper runs fn directly when the kit is absent; do the
      // same and record the animation type the level change asked for.
      transition: (fn, o) => { chrome.transitions.push(o?.type); fn(); },
      // The kit's action sheet, only when a test hands one in: without it
      // there is no sheet to ask with, as in a shell whose kit failed.
      ...(opts.actionSheet ? { actionSheet: opts.actionSheet, hasKit: () => true } : {}),
    },
    // Only when a test hands one in: the default is a browser with no Web
    // Share API, which is what most desktops are.
    ...(opts.navigator ? { navigator: opts.navigator } : {}),
    // public/js/dev-host.js's global, when a test wants the rewrite.
    ...(opts.resolveDevHost ? { resolveDevHost: opts.resolveDevHost } : {}),
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
        if (/^\/api\/apps\/[^/?]+(?:\?manifest=summary)?$/.test(url)) return { app: opts.coldApp || null };
        return { apps: opts.apps || [] };
      };
      return { ok, status: ok ? 200 : 500, json };
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    // Browse.siteFor parses candidates with `new URL` (#5364); URL, unlike
    // URLSearchParams, is not a vm-context built-in.
    URL,
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
  sandbox.PlatformI18n = englishPlatformI18n();
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
  const state = {
    level: 'list', rows: null, empty: null, error: false, detail: null,
    sort: 'recommended', view: 'foryou', only: [], activeCount: 0, filter: 'all',
    categories: [], category: 'all',
  };
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
    storage, renders, toasts, win: sandbox,
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

test('#1523: an app that cannot run goes after the rest, a flagged one is in no list, and explicit sorts and search keep the others', () => {
  const { Browse, state } = makeBrowse();
  Browse._open = true;
  Browse._apps = [
    app({ slug: 'demo', name: 'Demo app', active_users: 999, featured: true, status: 'error',
      directory: { tier: 'more', state: 'unavailable' } }),
    app({ slug: 'unreviewed', active_users: 10, directory: { tier: 'listed', state: 'listed' } }),
    app({ slug: 'working', icon_emoji: '🎮', active_users: 1, directory: { tier: 'listed', state: 'listed' } }),
    app({ slug: 'flagged', name: 'Demo flagged', active_users: 5000, featured: true,
      directory: { tier: 'hidden', state: 'flagged', flagged: true } }),
  ];
  Browse.render();
  assert.deepEqual(slugs(state), ['unreviewed', 'working', 'demo']);
  assert.equal(state.curated, true);
  assert.equal(state.moreExpanded, false);
  Browse.toggleMore();
  assert.equal(state.moreExpanded, true);
  Browse.toggleMore();
  Browse.setQuery('Demo app', { immediate: true });
  assert.equal(state.curated, false, 'matching apps are visible without expanding');
  assert.deepEqual(slugs(state), ['demo'], 'a search never finds a flagged app');
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

test("the sheet's radio list is a faithful copy of Browse.SORTS", () => {
  const { Browse } = makeBrowse();
  // browse-filter-sheet.tsx cannot read the controller: window.Browse does not
  // exist in the SSG prerender pass, so it carries its own copy of the five
  // labels. This is the guard that keeps the copy honest.
  const src = read('frontend/src/features/apps/browse-filter-sheet.tsx');
  const block = src.match(/const SORT_OPTIONS[\s\S]*?\n\];/);
  assert.ok(block, 'SORT_OPTIONS is still declared in browse-filter-sheet.tsx');
  const copied = [...block[0].matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)]
    .map((m) => ({ key: m[1], label: m[2] }));
  // Array.from, not .map: SORTS is the vm realm's array, and its .map would
  // hand back an array whose prototype deepStrictEqual refuses to match.
  assert.deepEqual(copied, Array.from(Browse.SORTS, (s) => ({ key: s.key, label: s.label })),
    'the radio list and the comparators must name the same five orders');
});

// ── The view switch and the Filters sheet's switches ─────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-23T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

test("the switch is a faithful copy of Browse.VIEWS, in its order", () => {
  const { Browse } = makeBrowse();
  assert.deepEqual(Array.from(Browse.VIEWS, (v) => v.key), ['foryou', 'browse', 'joined']);
  assert.deepEqual(Array.from(Browse.VIEWS, (v) => message(v.label)), ['For you', 'Browse', 'Joined']);
  // A copy for the same reason SORT_OPTIONS is one: window.Browse does not
  // exist in the SSG pass.
  const src = read('frontend/src/features/apps/browse-screen.tsx');
  const block = src.match(/const VIEW_TABS[\s\S]*?\n\];/);
  assert.ok(block, 'VIEW_TABS is still declared in browse-screen.tsx');
  const copied = [...block[0].matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)]
    .map((m) => ({ key: m[1], label: m[2] }));
  assert.deepEqual(copied, Array.from(Browse.VIEWS, (v) => ({ key: v.key, label: v.label })));
});

test("the sheet's Show only switches are a faithful copy of Browse.SHOW_ONLY", () => {
  const { Browse } = makeBrowse();
  assert.deepEqual(Array.from(Browse.SHOW_ONLY, (o) => o.key), ['featured', 'new', 'notjoined']);
  assert.deepEqual(Array.from(Browse.SHOW_ONLY, (o) => message(o.label)),
    ['Featured', 'New', 'Hide apps I’ve joined']);
  const src = read('frontend/src/features/apps/browse-filter-sheet.tsx');
  const block = src.match(/const SHOW_ONLY[\s\S]*?\n\];/);
  assert.ok(block, 'SHOW_ONLY is declared in browse-filter-sheet.tsx');
  const copied = [...block[0].matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)]
    .map((m) => ({ key: m[1], label: m[2] }));
  assert.deepEqual(copied, Array.from(Browse.SHOW_ONLY, (o) => ({ key: o.key, label: o.label })));
  // No switch of an admin's own any more: the review it filtered on is gone.
  assert.equal(Browse.ADMIN_SHOW_ONLY, undefined);
  assert.doesNotMatch(src, /ADMIN_SHOW_ONLY|adminFilters|unreviewed/);
  assert.doesNotMatch(read('frontend/src/features/apps/browse-store.js'), /adminFilters/);
});

test('resolveFilter: anything unrecognised is All, never an empty screen', () => {
  const { Browse } = makeBrowse();
  for (const key of ['all', 'featured', 'notjoined', 'yours', 'new']) assert.equal(Browse.resolveFilter(key), key);
  // The old admin chip's link lands on All, for an admin too.
  assert.equal(Browse.resolveFilter('unreviewed'), 'all');
  assert.equal(makeBrowse({ user: { id: 1, isAdmin: true } }).Browse.resolveFilter('unreviewed'), 'all');
  assert.equal(Browse.resolveFilter(' Featured '), 'featured');
  for (const bad of ['mine', '', null, undefined, 42, 'drop-tables']) {
    assert.equal(Browse.resolveFilter(bad), 'all', String(bad));
  }
});

test('filterApps: each chip admits the set its name promises', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'plain', created_at: ago(90) }),
    app({ slug: 'curated', featured: true, featured_order: 0, created_at: ago(60) }),
    app({ slug: 'curated-mine', featured: true, is_favorited: true, is_member: true, created_at: ago(40) }),
    app({ slug: 'member', is_collaborator: true, is_member: true, created_at: ago(30) }),
    app({ slug: 'member-hidden', is_collaborator: true, your_apps_hidden: true, is_member: true, created_at: ago(20) }),
    // Pinned to Home by an older client but not in the community: the pin
    // is a shortcut, and the chip is membership.
    app({ slug: 'pinned-only', is_favorited: true, created_at: ago(50) }),
    app({ slug: 'fresh', created_at: ago(3) }),
  ];
  const keys = (list) => Array.from(list, (a) => a.slug);
  assert.deepEqual(keys(Browse.filterApps(apps, 'all', NOW)), keys(apps), 'All is everything');
  // Featured is the admin's `featured` flag — the one Home's featured lane
  // reads — and the directory shows the WHOLE set, apps you have included.
  assert.deepEqual(keys(Browse.filterApps(apps, 'featured', NOW)), ['curated', 'curated-mine']);
  // Joined is Home.isJoined: the communities you are in, the same predicate
  // as the rows' Join / Joined pill. Taking an app off Home is not leaving,
  // so the hidden member is still here, and a pin alone is not membership.
  assert.deepEqual(keys(Browse.filterApps(apps, 'yours', NOW)), ['curated-mine', 'member', 'member-hidden']);
  // Not joined is the rest of it (#5267): exactly what Joined leaves out.
  assert.deepEqual(keys(Browse.filterApps(apps, 'notjoined', NOW)), ['plain', 'curated', 'pinned-only', 'fresh']);
  assert.deepEqual(keys(Browse.filterApps(apps, 'new', NOW)), ['fresh'], 'created in the last 14 days');
  // Pure: the input is untouched and no key means the current switches.
  assert.equal(apps.length, 7);
  Browse._only = ['featured'];
  assert.deepEqual(keys(Browse.filterApps(apps)), ['curated', 'curated-mine']);
});

test('New is the last 14 days, or the newest six when nothing is that young', () => {
  const { Browse } = makeBrowse();
  assert.equal(Browse.NEW_WINDOW_DAYS, 14);
  assert.equal(Browse.NEW_FALLBACK_COUNT, 6);
  const keys = (list) => Array.from(list, (a) => a.slug);
  // The window is inclusive at 14 days and excludes the day after.
  const edge = [app({ slug: 'd14', created_at: ago(14) }), app({ slug: 'd15', created_at: ago(15) })];
  assert.deepEqual(keys(Browse.newApps(edge, NOW)), ['d14']);
  // A quiet fortnight: the chip still answers, with what arrived last, newest
  // first and capped. Undated rows carry no information and never lead.
  const old = Array.from({ length: 9 }, (_, i) => app({ slug: `old-${i}`, created_at: ago(30 + i * 10) }))
    .concat([app({ slug: 'undated', created_at: null })]);
  assert.deepEqual(keys(Browse.newApps(old, NOW)),
    ['old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'old-5']);
  assert.deepEqual(keys(Browse.newApps([], NOW)), [], 'an empty directory is still empty');
});

test('the view and switches pick the set, Sort orders it, and the search narrows it', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [
    app({ slug: 'f-few', name: 'Chess Few', featured: true, featured_order: 0, active_users: 1 }),
    app({ slug: 'f-many', name: 'Chess Many', featured: true, featured_order: 1, active_users: 50 }),
    app({ slug: 'loud', name: 'Chess Loud', active_users: 999 }),
  ];
  Browse.applyFilters({ only: ['featured'], category: 'all', sort: 'recommended' });
  assert.equal(state.filter, 'featured', 'the switches and #browse-list[data-filter] read the store');
  assert.deepEqual(slugs(state), ['f-few', 'f-many'], 'Recommended keeps the curated order');
  Browse.setSort('users');
  assert.deepEqual(slugs(state), ['f-many', 'f-few'], 'Sort works WITHIN the switches');
  Browse.setQuery('many', { immediate: true });
  assert.deepEqual(slugs(state), ['f-many'], 'and the search narrows it further');
  Browse.setQuery('', { immediate: true });
  Browse.applyFilters({ only: [], category: 'all', sort: 'users' });
  assert.deepEqual(slugs(state), ['loud', 'f-many', 'f-few'], 'no switch brings the rest back, still sorted');
  assert.equal(state.sort, 'users', 'and switching filters never lost the order');
  assert.equal(state.filter, 'all');
});

test('an empty set says which filter is empty', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [app({ slug: 'plain', name: 'Plain' })];
  Browse.applyFilters({ only: ['featured'] });
  assert.equal(state.empty, 'No featured apps yet.');
  Browse.setView('joined');
  assert.equal(state.empty, 'You haven’t joined anything yet. Join apps from Browse.');
  Browse.setQuery('zzz', { immediate: true });
  assert.equal(state.empty, 'Nothing you’ve joined matches “zzz”.');
  Browse.setView('foryou');
  Browse.applyFilters({ only: ['featured'] });
  assert.equal(state.empty, 'No featured apps match “zzz”.');
  Browse.applyFilters({ only: ['new'] });
  assert.equal(state.empty, 'No new apps match “zzz”.');
  // More than one switch: the generic sentence, not one switch's name.
  Browse.applyFilters({ only: ['featured', 'new'] });
  assert.equal(state.empty, 'No apps match “zzz” with these filters.');
  Browse.applyFilters({ only: [] });
  assert.equal(state.empty, 'No apps match “zzz”.', 'no switch keeps the sentence it always had');
  assert.equal(Browse.emptyText('', 'featured new', 'all'), 'No apps match these filters.');
});

// ── The view, the switches and the sheet's count ─────────────────────

test('narrowApps: the Joined view, each switch, and their composition', () => {
  const { Browse } = makeBrowse();
  const apps = [
    app({ slug: 'plain', created_at: ago(90) }),
    app({ slug: 'curated', featured: true, featured_order: 0, created_at: ago(60) }),
    app({ slug: 'curated-mine', featured: true, is_favorited: true, is_member: true, created_at: ago(40) }),
    app({ slug: 'member', is_collaborator: true, is_member: true, created_at: ago(30) }),
    app({ slug: 'fresh', created_at: ago(3) }),
  ];
  const keys = (list) => Array.from(list, (a) => a.slug);
  assert.deepEqual(keys(Browse.narrowApps(apps, { view: 'browse', only: [] }, NOW)), keys(apps),
    'Browse is every app');
  assert.deepEqual(keys(Browse.narrowApps(apps, { view: 'foryou', only: [] }, NOW)), keys(apps),
    'For you is every app too; its order and grouping are the difference');
  assert.deepEqual(keys(Browse.narrowApps(apps, { view: 'joined', only: [] }, NOW)),
    ['curated-mine', 'member'], 'Joined keeps the communities you are in');
  assert.deepEqual(keys(Browse.narrowApps(apps, { view: 'browse', only: ['featured'] }, NOW)),
    ['curated', 'curated-mine']);
  assert.deepEqual(keys(Browse.narrowApps(apps, { view: 'browse', only: ['new'] }, NOW)), ['fresh']);
  assert.deepEqual(keys(Browse.narrowApps(apps, { view: 'browse', only: ['notjoined'] }, NOW)),
    ['plain', 'curated', 'fresh']);
  // Featured AND New is their intersection, in the switches' order. (New
  // keeps its "newest six when nothing is that young" behaviour, so an old
  // featured set still answers.)
  assert.deepEqual(keys(Browse.narrowApps(apps, { view: 'browse', only: ['featured', 'new'] }, NOW)),
    ['curated-mine', 'curated'], 'New keeps its newest-first fallback inside Featured');
  const freshFeatured = app({ slug: 'fresh-featured', featured: true, created_at: ago(2) });
  assert.deepEqual(
    keys(Browse.narrowApps(apps.concat([freshFeatured]), { view: 'browse', only: ['featured', 'new'] }, NOW)),
    ['fresh-featured'],
  );
  assert.equal(apps.length, 5, 'pure: the input is untouched');
});

test('showOnlyKeys drops unknown keys and keeps the fixed order', () => {
  const { Browse } = makeBrowse();
  assert.deepEqual(Array.from(Browse.showOnlyKeys(['new', 'featured', 'bogus', 'new'])), ['featured', 'new']);
  assert.deepEqual(Array.from(Browse.showOnlyKeys(['unreviewed'])), []);
  const admin = makeBrowse({ user: { id: 2, isAdmin: true } }).Browse;
  assert.deepEqual(Array.from(admin.showOnlyKeys(['unreviewed', 'featured'])), ['featured'], 'for an admin too');
  assert.deepEqual(Array.from(Browse.showOnlyKeys(null)), []);
});

test('visibleApps and countFor take a draft; the live search still applies', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [
    typed('chess', 'games', { active_users: 5, featured: true }),
    typed('quiz', 'games', { active_users: 50 }),
    typed('notes', 'tools', { active_users: 99 }),
  ];
  // A draft does not change the live state behind the sheet.
  assert.equal(Browse.countFor({ view: 'browse', only: [], category: 'games', sort: 'recommended' }), 2);
  assert.equal(Browse.countFor({ view: 'browse', only: [], category: 'tools', sort: 'recommended' }), 1);
  assert.equal(Browse.countFor({ view: 'browse', only: [], category: 'all', sort: 'recommended' }), 3);
  assert.equal(state.category, 'all', 'the draft stayed a draft');
  // The live query counts too: the button counts the search.
  Browse.setQuery('quiz', { immediate: true });
  assert.equal(Browse.countFor({ view: 'browse', only: [], category: 'all', sort: 'recommended' }), 1);
  Browse.setQuery('', { immediate: true });
  assert.deepEqual(
    Array.from(Browse.visibleApps({ view: 'joined', only: [], category: 'all', sort: 'recommended' }), (a) => a.slug),
    [],
    'the Joined view shows nothing you are not in',
  );
});

test('activeFilterCount counts the switches, a type and a non-default order', () => {
  const { Browse } = makeBrowse();
  assert.equal(Browse.activeFilterCount(), 0);
  Browse._only = ['featured', 'new'];
  assert.equal(Browse.activeFilterCount(), 2);
  Browse._category = 'games';
  assert.equal(Browse.activeFilterCount(), 3);
  Browse._sort = 'users';
  assert.equal(Browse.activeFilterCount(), 4);
  Browse._view = 'joined';
  assert.equal(Browse.activeFilterCount(), 4, 'the view tab is never counted');
});

test('only For you with the defaults is grouped; Browse and Joined are one flat list', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [
    app({ slug: 'f', featured: true, featured_order: 0 }),
    app({ slug: 'other' }),
  ];
  Browse.render();
  assert.equal(state.grouped, true);
  assert.equal(state.rows.filter((r) => r.recommended).length, 1);
  Browse.setView('browse');
  assert.equal(state.grouped, false);
  assert.equal(state.rows.some((r) => r.recommended), false);
  Browse.setView('joined');
  assert.equal(state.grouped, false);
  assert.equal(state.rows.some((r) => r.recommended), false);
});

// ── Type chips (#3962) ────────────────────────────────────────────

const typed = (slug, category, over) => app({ slug, name: slug, manifest_snapshot: { secrets: [], category }, ...over });

test('the type chips are a labelled copy of dapp.json\'s category list, in its order', () => {
  const { Browse } = makeBrowse();
  const { APP_CATEGORIES } = require('../src/services/app-manifest');
  assert.deepEqual(Array.from(Browse.CATEGORIES, (c) => c.key), Array.from(APP_CATEGORIES));
  assert.deepEqual(Array.from(Browse.CATEGORIES, (c) => message(c.label)),
    ['Games', 'Social', 'Tools', 'Learning', 'Creative', 'Other']);
  assert.equal(message('discover:category.groupLabel'), 'Filter by type');
});

test('appCategory reads the manifest snapshot and nothing else', () => {
  const { Browse } = makeBrowse();
  assert.equal(Browse.appCategory(typed('a', 'games')), 'games');
  assert.equal(Browse.appCategory(typed('a', ' Social ')), 'social');
  // No guessing from words: a chess app that says nothing has no type.
  assert.equal(Browse.appCategory(app({ name: 'Chess Arena' })), null);
  assert.equal(Browse.appCategory(typed('a', 'casino')), null);
  assert.equal(Browse.appCategory(app({ manifest_snapshot: null })), null);
  assert.equal(Browse.appCategory(null), null);
});

test('presentCategories: only types some app has, and no row for Other alone', () => {
  const { Browse } = makeBrowse();
  const keys = (list) => Array.from(list, (c) => c.key);
  assert.deepEqual(keys(Browse.presentCategories([app({}), app({ slug: 'b' })])), [], 'nobody tagged: no row');
  assert.deepEqual(keys(Browse.presentCategories([typed('a', 'other'), typed('b', 'other')])), [],
    'All types and Other alone would sort nothing');
  assert.deepEqual(keys(Browse.presentCategories([typed('a', 'tools'), typed('b', 'other'), typed('c', 'games'), app({})])),
    ['games', 'tools', 'other'], 'in the list\'s order');
  // The Filters sheet lists every type present, with Other always included
  // once anything is tagged, and no Type section at all when nothing is.
  // Audit D11: nor when Other is all there is, which filters nothing.
  assert.deepEqual(keys(Browse.categoryOptions([typed('a', 'tools')])), ['tools', 'other']);
  assert.deepEqual(keys(Browse.categoryOptions([typed('a', 'other')])), []);
  assert.deepEqual(keys(Browse.categoryOptions([app({})])), []);
  // resolveCategory can pick Other (the sheet offers it) but never a type the
  // directory does not have.
  assert.equal(Browse.resolveCategory('other', [typed('a', 'other')]), 'other');
  assert.equal(Browse.resolveCategory('learning', [typed('a', 'tools')]), 'all');
});

test('a type narrows the view\'s set, before Sort and the search', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [
    typed('chess', 'games', { active_users: 5, is_member: true }),
    typed('quiz', 'games', { active_users: 50 }),
    typed('notes', 'tools', { active_users: 99 }),
    app({ slug: 'untagged', name: 'untagged', active_users: 7 }),
  ];
  Browse.setSort('users');
  assert.deepEqual(Array.from(state.categories, (c) => c.key), ['games', 'tools']);
  assert.equal(state.category, 'all');
  assert.deepEqual(slugs(state), ['notes', 'quiz', 'untagged', 'chess'], 'All types is everything');
  Browse.setCategory('games');
  assert.equal(state.category, 'games');
  assert.deepEqual(slugs(state), ['quiz', 'chess'], 'only games, still in Sort\'s order');
  Browse.setView('joined');
  assert.deepEqual(slugs(state), ['chess'], 'composes with the Joined view');
  Browse.setView('foryou');
  Browse.setQuery('qu', { immediate: true });
  assert.deepEqual(slugs(state), ['quiz'], 'and with the search');
  Browse.setQuery('', { immediate: true });
  // A type no app has is not a chip, and asking for one lands on All types.
  Browse.setCategory('learning');
  assert.equal(state.category, 'all');
  assert.equal(slugs(state).length, 4);
});

test('an emptied type says so, and a search keeps its own sentence', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [typed('quiz', 'games'), typed('notes', 'tools')];
  Browse.setCategory('games');
  Browse.applyFilters({ only: ['featured'], category: 'games' });
  assert.equal(state.empty, 'No apps of this type here.');
  Browse.setQuery('zzz', { immediate: true });
  assert.equal(state.empty, 'No featured apps match “zzz”.');
});

test('the type row is always drawn, but its rail waits for the store', () => {
  const store = read('frontend/src/features/apps/browse-store.js');
  assert.match(store, /categories: \[\],/);
  assert.match(store, /category: 'all',/);
  assert.doesNotMatch(INDEX, /browse-category-chips/, 'which types exist is known only after /api/apps');
  // The row and the Filters button ARE prerendered; only the rail is not.
  assert.match(INDEX, /id="browse-type-row"/);
  assert.match(INDEX, /id="browse-filters-btn"/);
  const src = read('frontend/src/features/apps/browse-screen.tsx');
  assert.match(src, /\{typeChips\.length \? \(\s*<ChipRail\s+id="browse-category-chips"/);
  // The page row drops Other unless it is picked; the sheet keeps it.
  assert.match(src, /c\.key !== 'other' \|\| category === 'other'/);
});

// ── Open site (#5364) ─────────────────────────────────────────────

// siteFor decides when the "Open site" row shows. Its rules ARE the feature:
// an address opens, plain words and phrases never trigger, and only http/https
// web pages (a dotted host) are offered.
test('siteFor accepts web addresses and rejects everything else', () => {
  const { Browse } = makeBrowse();
  const ok = (query, href, label) => {
    const site = Browse.siteFor(query);
    assert.ok(site, `accepts ${JSON.stringify(query)}`);
    assert.equal(site.href, href);
    assert.equal(site.label, label);
  };
  ok('example.com', 'https://example.com/', 'example.com');
  ok('www.example.org/page', 'https://www.example.org/page', 'www.example.org/page');
  ok('https://Example.com/', 'https://example.com/', 'Example.com');
  ok('http://x.io:8080/a', 'http://x.io:8080/a', 'x.io:8080/a');
  const no = (query) => {
    assert.equal(Browse.siteFor(query), null, `rejects ${JSON.stringify(query)}`);
  };
  no('');
  no('   ');
  no('notes');
  no('my app');
  no('1.5');
  no('javascript:alert(1)');
  no('https://localhost');
  no('ftp://x.com');
});

// The store wiring: a site-shaped query publishes the row descriptor and the
// site row counts as a result, so the "No apps match" line never sits under
// it; any other query publishes null and search behaves as it always did.
test('a web-address query publishes the site row and hides the empty line', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [app({ slug: 'notes', name: 'Notes' })];
  Browse.setQuery('example.com', { immediate: true });
  // Field-by-field: the descriptor is built in the vm context, so its
  // prototype is not this realm's Object.prototype and deepEqual would
  // reject the very same shape.
  assert.equal(state.site && state.site.href, 'https://example.com/');
  assert.equal(state.site && state.site.label, 'example.com');
  assert.equal(state.empty, null, 'the site row is a result, not a miss');
  assert.deepEqual(slugs(state), [], 'app matching itself is unchanged');
  Browse.setQuery('Notes', { immediate: true });
  assert.equal(state.site, null);
  assert.deepEqual(slugs(state), ['notes']);
  assert.equal(state.empty, null);
  Browse.setQuery('zzz', { immediate: true });
  assert.equal(state.site, null);
  assert.equal(state.empty, 'No apps match “zzz”.');
  Browse.setQuery('', { immediate: true });
  assert.equal(state.site, null);
});

// The row is drawn by BrowseRows, ahead of every app row, in both the grouped
// and ungrouped layouts, and the field's Enter opens the site.
test('the site row renders first and Enter opens it', () => {
  const listSrc = read('frontend/src/features/apps/browse-list.tsx');
  assert.match(listSrc, /function SiteRow\(/);
  assert.match(listSrc, /as="a"\n\s+href=\{site\.href\}\n\s+target="_blank"\n\s+rel="noopener noreferrer"/);
  // The site row is not an app row: it has no data-slug and no Join button,
  // so the selectors and checks that read rows by slug never see it.
  const siteRowSrc = listSrc.slice(listSrc.indexOf('function SiteRow('), listSrc.indexOf('export function BrowseRows'));
  assert.ok(siteRowSrc.includes('as="a"') && !siteRowSrc.includes('data-slug'),
    'the site row carries no data-slug');
  assert.match(listSrc, /const siteRow = site \? <SiteRow site=\{site\} \/> : null;/);
  assert.match(listSrc, /<>\{siteRow\}\{renderRows\(rows\)\}<\/>/);
  assert.match(listSrc, /\{siteRow\}\n\s+\{grouped \?/);
  assert.match(listSrc, /t\('discover:site\.subtitle'\)/);
  const screenSrc = read('frontend/src/features/apps/browse-screen.tsx');
  assert.match(screenSrc, /site=\{state\.site\}/);
  assert.match(screenSrc, /e\.key === 'Enter'[\s\S]*?siteFor\?\.\(e\.currentTarget\.value\)[\s\S]*?window\.open\(site\.href, '_blank', 'noopener'\)/);
  // The store ships the prerender value: no query, no site row.
  assert.match(read('frontend/src/features/apps/browse-store.js'), /site: null,/);
});

test('the view and switches are remembered for the session, and ?filter= seeds the first entry', () => {
  const { Browse, state, storage } = makeBrowse({ search: '?filter=new' });
  Browse._load = () => {};
  Browse.open(null);
  assert.equal(state.filter, 'new', 'a link turns on its switch');
  assert.deepEqual(Array.from(state.only), ['new']);
  assert.equal(state.view, 'foryou');
  Browse.applyFilters({ only: ['featured'], category: 'all', sort: 'recommended' });
  Browse.close();
  Browse.open(null);
  assert.equal(state.filter, 'featured',
    'the choice survives leaving Discover, and the spent link does not override it');
  assert.equal(Object.keys(storage).some((k) => /filter/i.test(k)), false,
    'nothing is stored: a reload starts on For you with no switches');
  const fresh = makeBrowse();
  fresh.Browse._load = () => {};
  fresh.Browse.open(null);
  assert.equal(fresh.state.filter, 'all');
  assert.equal(fresh.state.view, 'foryou');
  const junk = makeBrowse({ search: '?filter=bananas' });
  junk.Browse._load = () => {};
  junk.Browse.open(null);
  assert.equal(junk.state.filter, 'all');
});

test('?filter= maps onto the switch and the sheet: yours is Joined, the rest are switches', () => {
  const cases = [
    ['?filter=yours', { view: 'joined', only: [] }],
    ['?filter=featured', { view: 'foryou', only: ['featured'] }],
    ['?filter=new', { view: 'foryou', only: ['new'] }],
    ['?filter=notjoined', { view: 'foryou', only: ['notjoined'] }],
    ['?filter=all', { view: 'foryou', only: [] }],
    // The old admin switch is gone, so its link lands on defaults.
    ['?filter=unreviewed', { view: 'foryou', only: [] }],
  ];
  for (const [search, want] of cases) {
    const { Browse, state } = makeBrowse({ search });
    Browse._load = () => {};
    Browse.open(null);
    assert.equal(state.view, want.view, search);
    assert.deepEqual(Array.from(state.only), want.only, search);
  }
  const admin = makeBrowse({ search: '?filter=unreviewed', user: { id: 2, isAdmin: true } });
  admin.Browse._load = () => {};
  admin.Browse.open(null);
  assert.deepEqual(Array.from(admin.state.only), [], 'for an admin too');
  assert.equal(admin.state.activeCount, 0);
});

test('the controls prerender from the store\'s initial values', () => {
  const src = read('frontend/src/features/apps/browse-store.js');
  assert.match(src, /view: 'foryou',/);
  assert.match(src, /only: \[\],/);
  assert.match(src, /activeCount: 0,/);
  assert.match(src, /filter: 'all',/);
  // Applied on ENTRY, never during render: location.search does not exist in
  // the SSG pass.
  assert.match(BROWSE_SRC, /Browse\._applyInitialSort\(\);\n\s+Browse\._applyInitialFilter\(\);/);
  const start = INDEX.indexOf('id="browse-search-bar"');
  const bar = INDEX.slice(start, INDEX.indexOf('id="browse-list-level"', start));
  // For you is the pressed part; the other two are not.
  assert.match(bar, /data-view="foryou" aria-current="page"/);
  assert.match(bar, /data-view="browse" aria-current="false"/);
  assert.match(bar, /data-view="joined" aria-current="false"/);
  // The Filters button is there, with no count: nothing is on by default.
  assert.match(bar, /id="browse-filters-btn"/);
  assert.doesNotMatch(bar, /data-active-count/);
  assert.doesNotMatch(bar, /browse-filter-chips|browse-sort-bar|browse-sort-select|browse-category-chips/);
  assert.match(INDEX, /id="browse-list"[^>]*data-sort="recommended"/);
  assert.match(INDEX, /id="browse-list"[^>]*data-view="foryou"[^>]*data-filter="all"/);
  // The language's own chip, not a hand-rolled one.
  assert.match(read('frontend/src/features/apps/browse-screen.tsx'), /from '@\/components\/ui\/chip'/);
});

// ── Search covers EVERY visible app (home's is scoped to yours) ────

test('visibleApps: filters through Home.filterApps over the whole list', () => {
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

test('visibleApps: an exact name or slug match tops the sorted list (#4793)', () => {
  const { Browse } = makeBrowse();
  Browse._apps = [
    app({ slug: 'chess-arena', name: 'Chess Arena', active_users: 90 }),
    app({ slug: 'chess-club', name: 'Chess Club', active_users: 80 }),
    app({ slug: 'speed-chess', name: 'Speed Chess', active_users: 70 }),
    app({ slug: 'chess-daily', name: 'Chess', active_users: 2 }),
    app({ slug: 'chess', name: 'Board Games', active_users: 1 }),
  ];
  Browse.setSort('users');
  const slugs = () => Browse.visibleApps().map((a) => a.slug);
  Browse._query = 'Chess';
  assert.deepEqual(slugs(), ['chess-daily', 'chess', 'chess-arena', 'chess-club', 'speed-chess'],
    'the exact name and the exact slug lead, in sort order; the rest keep the sort');
  Browse._query = '  cHeSs  ';
  assert.equal(slugs()[0], 'chess-daily', 'case and whitespace do not matter');
  Browse._query = 'speed-chess';
  assert.deepEqual(slugs(), ['speed-chess'], 'an exact slug');
  Browse._query = 'chess club';
  assert.deepEqual(slugs(), ['chess-club'], 'an exact name');
  Browse._query = 'ches';
  assert.deepEqual(slugs(), ['chess-arena', 'chess-club', 'speed-chess', 'chess-daily', 'chess'],
    'no exact match: the sort order stands');
  Browse._query = '';
  assert.deepEqual(slugs(), ['chess-arena', 'chess-club', 'speed-chess', 'chess-daily', 'chess'],
    'no query: the sort order stands');
});

// ── render ───────────────────────────────────────────────────────

test('rowView: an app-store row — icon, name, meta, Join state', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [
    app({ slug: 'fresh', name: 'Fresh App', active_users: 3 }),
    app({ slug: 'mine', name: 'My App', is_favorited: true, is_member: true }),
  ];
  Browse.render();
  assert.deepEqual(slugs(state), ['fresh', 'mine'], 'rows, not launcher tiles');
  const fresh = rowFor(state, 'fresh');
  assert.equal(fresh.name, 'Fresh App');
  assert.match(fresh.meta, /3 users/, 'the derived meta line');
  // The whole app record rides the descriptor, because the icon tile and the
  // chip strip are shared decisions (app-card.js) the row does not re-make.
  assert.equal(fresh.app.slug, 'fresh');
  // Fresh rows offer "Join", joined ones "Open" (#5267: not "✓ Joined").
  // The flag is the descriptor's (`added`, the name the declared checks'
  // data-added attribute keeps), the two labels are browse-list.tsx's.
  assert.equal(fresh.added, false);
  assert.equal(fresh.addTitle, 'Join Fresh App');
  assert.equal(rowFor(state, 'mine').added, true);
  assert.equal(rowFor(state, 'mine').addTitle, 'Open My App');
  assert.equal(rowFor(state, 'mine').canOpen, true, 'a running joined app can be opened');
  // The "…" menu is gone from this screen — the detail page absorbed it.
  assert.doesNotMatch(BROWSE_SRC, /card-menu-btn/);
  assert.doesNotMatch(BROWSE_SRC, /card-add-btn/, 'the corner badge is a real button now');
});

test('#5928: rowView carries the app\'s own one-line description, or nothing', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [
    app({ slug: 'said', name: 'Said', manifest_snapshot: { description: '  Count   sheep\nbefore bed.  ' } }),
    app({ slug: 'blank', name: 'Blank', manifest_snapshot: { description: '   ' } }),
    app({ slug: 'none', name: 'None', manifest_snapshot: null }),
    app({ slug: 'long', name: 'Long', manifest_snapshot: { description: 'x'.repeat(400) } }),
  ];
  Browse.render();
  assert.equal(rowFor(state, 'said').about, 'Count sheep before bed.', 'whitespace folded');
  assert.equal(rowFor(state, 'blank').about, null, 'no filler for a blank description');
  assert.equal(rowFor(state, 'none').about, null);
  assert.equal(rowFor(state, 'long').about.length, 160, 'capped as Home\'s cards cap it');
});

test('browse rows: the layout switch is pure CSS on the container', () => {
  // Narrow: a hairline-divided vertical list. md+: a 2/3-column grid whose
  // rows pick up a box treatment from .browse-row in app.css. No
  // matchMedia, so nothing re-renders on resize.
  const listTag = INDEX.match(/<div id="browse-list"[^>]*>/)[0];
  assert.match(listTag, /md:grid/);
  // Overnight audit W03: the columns are counted from the list's own width
  // (as many 20rem boxes as fit), not picked by the window's: md:grid-cols-2
  // gave two ~250px boxes beside the rail at 800px. That is one column at
  // 800, two at 1024 (QA 2026-09-24 Q10: a third left the name 0px wide
  // there) and three in the 1024px page column.
  assert.match(listTag, /md:grid-cols-\[repeat\(auto-fill,minmax\(20rem,1fr\)\)\]/);
  assert.doesNotMatch(listTag, /(md|lg|xl):grid-cols-\d/, 'no count tied to the window');
  assert.doesNotMatch(BROWSE_SRC, /matchMedia\(/, 'the breakpoint is CSS, not JS');

  // NO divide-* utility on the container. Tailwind's divide-y sets
  // border-bottom-width: 0 (and md:divide-y-0 zeroes the top too) via
  // `.divide-y-0 > :not([hidden]) ~ :not([hidden])`, which is (0,3,0) and
  // beat the (0,1,0) .browse-row box rule — every desktop box but the
  // FIRST lost its top and bottom edge. Both borders live in one cascade
  // now; putting a divide utility back here reopens that bug.
  assert.doesNotMatch(listTag, /divide-/,
    'the phone hairline is .browse-row + .browse-row in app.css');

  // Phone: the rows sit in a CARD, with the search, the chips and Sort on
  // the ground above it (the communities prototype; #1919 made the bar the
  // card's head). The surface — the sheet fill, the hairline ring, the 22px
  // radius — is `browse-pane-*` in app.css beside the row rules, NOT
  // utilities on the tag (it used to be `max-md:rounded-2xl max-md:bg-white`).
  // The hairline between rows is INSET to the text column, so it stops short
  // of the card's corner radius. It is a pseudo-element rather than
  // `border-top` — a border cannot be inset — which is also what frees the
  // md+ block below to own the `border` shorthand outright.
  assert.match(listTag, /browse-pane-body/, 'phone: the rows sit in the card');
  assert.doesNotMatch(listTag, /max-md:/, 'phone: the surface is app.css, not utilities');
  const barTag = INDEX.match(/<div id="browse-search-bar"[^>]*>/)[0];
  assert.match(barTag, /browse-pane-head/, 'phone: the search bar keeps its part name');
  // #5267: no band. The bar used to wear the wallpaper's base colour at md+,
  // a flat fill that read as a separate panel over the wallpaper's washes.
  assert.doesNotMatch(barTag, /home-ground|md:bg-/, 'md+: the controls sit on the page background too');
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
  // Below md only. The head is ON THE GROUND: no fill, no ring, and not
  // pinned (a pinned head needs a fill, which would band the wallpaper). The
  // body (or the empty note in its place) is a whole card: sheet fill over
  // --dc-frost, an --app-sheet-line ring, 22px corners all round.
  const paneBlock = browseCss.slice(browseCss.indexOf('@media (max-width: 767px)'));
  assert.ok(paneBlock.length > 0, 'phone: the card block sits in the Browse-owned section');
  const head = paneBlock.match(/#browse-screen \.browse-pane-head \{[^}]*\}/);
  assert.ok(head, 'phone: the head has its own rule');
  assert.match(head[0], /position: static;/, 'phone: the controls scroll with the list');
  assert.match(head[0], /background: transparent;/, 'phone: the controls sit on the ground');
  assert.doesNotMatch(head[0], /border|radius|frost/, 'phone: the controls are not in the card');
  assert.match(paneBlock,
    /#browse-screen \.browse-pane-body,\s*\n\s*#browse-screen \.browse-pane-note \{[\s\S]*?background-color: var\(--dc-sheet-fill\);[\s\S]*?backdrop-filter: var\(--dc-frost\);[\s\S]*?border: 1px solid var\(--app-sheet-line\);[\s\S]*?border-radius: 22px;/,
    'phone: the list (or the empty note) is one whole card');
  assert.match(paneBlock, /\.browse-pane-body:empty \{ display: none; \}/,
    'phone: an empty list collapses so the note can be the card');
  // No blur on any platform (app.css "No glass, on any platform"): the card
  // and the note go solid together, the same on every platform.
  assert.match(paneBlock,
    /@media \(max-width: 767px\) \{\s*#browse-screen \.browse-pane-body,\s*#browse-screen \.browse-pane-note \{ background-color: var\(--dc-sheet-solid\); \}\s*\}/,
    'phone: the card and the note go solid together, the same on every platform');
  assert.doesNotMatch(browseCss, /@supports not \(\(backdrop-filter/,
    'no per-platform glass fallback is left in the Browse section');
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
  // Polish N12: a vote is a member's, so a community you have not joined
  // asks you for none.
  assert.deepEqual(Array.from(AppCard.appPillsFor({ ...row.app, is_member: false }).chips, (c) => c.label),
    ['Missing secrets', '1 issue']);
  assert.deepEqual(Array.from(AppCard.appPillsFor({ ...row.app, is_member: true }).chips, (c) => c.label),
    ['Missing secrets', '2 to vote', '1 issue']);
});

test('metaLine: users · updated · status, pluralised, missing bits skipped', () => {
  const { Browse } = makeBrowse();
  assert.match(Browse.metaLine(app({ active_users: 1 })), /^1 user\b/);
  assert.doesNotMatch(Browse.metaLine(app({ active_users: 0 })), /0 users/, 'a zero says nothing (polish N12)');
  const running = Browse.metaLine(app({ active_users: 4, status: 'running' }));
  assert.doesNotMatch(running, /running/, 'a healthy app needs no status word');
  assert.match(Browse.metaLine(app({ status: 'error' })), /Error/);
  assert.match(Browse.metaLine(app({ status: 'creating' })), /Spinning up/);
  // No timestamps and nobody using it: no line at all, and null is safe.
  assert.equal(Browse.metaLine(null), '');
  assert.equal(Browse.metaLine({ status: 'running' }), '', 'nothing to say: no line');
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

  assert.equal(Browse.metaLine(a, 'active'), '4 users · 3 live in 30d · Updated 1h ago');
  assert.equal(Browse.metaLine(a, 'merged'), '4 users · 12 changes live · Updated 1h ago');
  assert.equal(Browse.metaLine(a, 'new'), '4 users · Created 3h ago',
    'sorting by age shows the age it sorted on, not the deploy');
});

test('metaLine: a zero aggregate is dropped, not rendered as "0"', () => {
  const { Browse } = makeBrowse();
  const quiet = app({ active_users: 2, merged_prs: 0, merged_prs_recent: 0 });
  assert.equal(Browse.metaLine(quiet, 'active'), '2 users');
  assert.equal(Browse.metaLine(quiet, 'merged'), '2 users');
  assert.match(Browse.metaLine(app({ merged_prs: 1 }), 'merged'), /1 change live/,
    'and the one that is there is pluralised');
});

test('metaLine: the rows carry the line the store says they were sorted with', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [app({ slug: 'one', active_users: 2, merged_prs: 7 })];
  Browse.setSort('merged');
  assert.equal(state.sort, 'merged');
  assert.match(rowFor(state, 'one').meta, /7 changes live/,
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
  // load() is the single-flight gate; the load itself is _loadOnce().
  const load = HOME_SRC.slice(
    HOME_SRC.indexOf('async _loadOnce() {'),
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
    { key: 'favorite', label: 'Add to My apps', run: () => {} },
    { key: 'add-to-homescreen', label: 'Add to Homeroom widget', run: () => {} },
    { key: 'retry', label: 'Retry', run: () => {} },
    { key: 'build-log', label: 'View build log', run: () => {} },
    { key: 'check-updates', label: 'Check for updates', keepOpen: true, run: () => {} },
    { key: 'fork', label: 'Remix', run: () => {} },
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
    { key: 'favorite', label: 'Add to My apps', run: () => {} },
    { key: 'fork', label: 'Remix', run: () => {} },
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
  assert.equal(d.favLabel, 'Add to My apps');
  assert.deepEqual(d.actions.map((a) => a.label), ['Remix', 'Delete app'],
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

// ── Versions on the app's page (docs/plans/versions.md) ──────────────────

test('versionsLineFor: an original says how many versions it has and how many get its updates; a zero says nothing', () => {
  const { Browse } = makeBrowse();
  assert.equal(Browse.versionsLineFor(app({ versions: { count: 214, following: 160 } })), '214 versions · 160 get its updates');
  assert.equal(Browse.versionsLineFor(app({ versions: { count: 214, following: 1 } })), '214 versions · 1 gets its updates');
  assert.equal(Browse.versionsLineFor(app({ versions: { count: 1, following: 1 } })), '1 version · it gets its updates');
  assert.equal(Browse.versionsLineFor(app({ versions: { count: 5, following: 0 } })), '5 versions');
  assert.equal(Browse.versionsLineFor(app({ versions: { count: 0, following: 0 } })), null, 'no line before the first version');
  assert.equal(Browse.versionsLineFor(app({ versions: null })), null, 'not an original');
  assert.equal(Browse.versionsLineFor(app({})), null, 'a server that predates versions');
  assert.equal(Browse.versionsLineFor(null), null);
});

// ── Share on the app's page (the prototype's About sheet: More, then Share) ──

test("shareUrlFor: the app's public link, behind the same gate as the menu's Share app", () => {
  const { Browse } = makeBrowse();
  const url = 'https://chess-1a2b.apps.example';
  // The link the mark menu's About > "Share app" hands out is the running
  // app's own `url` (features/dialogs/share.tsx reads AppView.appData.url),
  // and it is drawn only on `canShare`: running, with a URL, never the
  // platform itself. The directory reads the same field off the row.
  assert.equal(Browse.shareUrlFor(app({ url })), url);
  assert.equal(Browse.shareUrlFor(app({ url, status: 'error' })), null, 'not running');
  assert.equal(Browse.shareUrlFor(app({ url, status: 'creating' })), null);
  assert.equal(Browse.shareUrlFor(app({ url: null })), null, 'no public link to give');
  assert.equal(Browse.shareUrlFor(app({ url, self_hosted: true })), null,
    'the platform row has no per-slug app URL');
  assert.equal(Browse.shareUrlFor(null), null);
  // Through the same dev-host rewrite the share dialog applies, so a phone on
  // the LAN is handed a link it can open.
  const lan = makeBrowse({ resolveDevHost: (u) => u.replace('localhost', '192.168.1.7') });
  assert.equal(lan.Browse.shareUrlFor(app({ url: 'http://localhost:4100' })), 'http://192.168.1.7:4100');
});

test('the page describes a Share row only when there is a link to share', () => {
  const { Browse, Home, state } = makeBrowse();
  Home.menuItemsFor = () => [{ key: 'fork', label: 'Remix', run: () => {} }];
  Browse._apps = [app({ slug: 'live', url: 'https://live.apps.example' }), app({ slug: 'down', status: 'error', url: null })];
  Browse.showDetail('live');
  assert.equal(state.detail.canShare, true);
  assert.deepEqual(state.detail.actions.map((a) => a.label), ['Remix'],
    'Share is its own row, not one of the home card menu\'s items');
  assert.equal(JSON.stringify(state.detail).includes('live.apps.example'), true, 'the app record rides along');
  Browse.showDetail('down');
  assert.equal(state.detail.canShare, false);
  // …and the component leads the action card with it, as its own button.
  const detailSrc = read('frontend/src/features/apps/browse-detail.tsx');
  assert.match(detailSrc, /\{view\.actions\.length \|\| view\.canShare \? \(/);
  assert.match(detailSrc, /id="browse-detail-share"[\s\S]{0,600}title=\{t\('discover:detail\.share\.label'\)\}[\s\S]{0,120}onClick=\{\(\) => controller\(\)\?\.shareDetailApp\(view\.app\)\}/);
  assert.equal(message('discover:detail.share.label'), 'Share');
  assert.ok(detailSrc.indexOf('id="browse-detail-share"') < detailSrc.indexOf('view.actions.map('),
    'Share comes first, as in the prototype\'s More list');
});

test('Share uses the Web Share API where there is one', async () => {
  const shared = [];
  const copied = [];
  const { Browse, toasts } = makeBrowse({
    navigator: { share: async (data) => { shared.push(data); }, canShare: () => true },
    copyText: async (text) => { copied.push(text); return true; },
  });
  await Browse.shareDetailApp(app({ slug: 'chess', name: 'Chess Arena', url: 'https://chess.apps.example' }));
  assert.deepEqual(JSON.parse(JSON.stringify(shared)),
    [{ title: 'Chess Arena', url: 'https://chess.apps.example' }]);
  assert.deepEqual(copied, [], 'the share sheet is the whole answer');
  assert.deepEqual(toasts, []);
});

test('a dismissed share sheet is an answer, not a failure: no copy, no toast', async () => {
  const copied = [];
  const { Browse, toasts } = makeBrowse({
    navigator: { share: async () => { const e = new Error('dismissed'); e.name = 'AbortError'; throw e; } },
    copyText: async (text) => { copied.push(text); return true; },
  });
  await Browse.shareDetailApp(app({ url: 'https://x.apps.example' }));
  assert.deepEqual(copied, []);
  assert.deepEqual(toasts, []);
});

test('without the Web Share API it copies the link and says so', async () => {
  const copied = [];
  const { Browse, toasts } = makeBrowse({
    copyText: async (text) => { copied.push(text); return true; },
  });
  await Browse.shareDetailApp(app({ url: 'https://x.apps.example' }));
  assert.deepEqual(copied, ['https://x.apps.example']);
  assert.deepEqual(toasts, ['Link copied']);

  // A share target that refuses (not a dismissal) falls through to the copy.
  const refused = makeBrowse({
    navigator: { share: async () => { throw new Error('NotAllowedError'); } },
    copyText: async () => true,
  });
  await refused.Browse.shareDetailApp(app({ url: 'https://x.apps.example' }));
  assert.deepEqual(refused.toasts, ['Link copied']);

  // …and a clipboard that refuses says THAT, rather than claiming a copy.
  const noClip = makeBrowse({ copyText: async () => false });
  await noClip.Browse.shareDetailApp(app({ url: 'https://x.apps.example' }));
  assert.deepEqual(noClip.toasts, ['Couldn’t copy the link']);

  // Nothing to share, nothing happens.
  const none = makeBrowse({ copyText: async () => { throw new Error('should not copy'); } });
  await none.Browse.shareDetailApp(app({ url: null }));
  assert.deepEqual(none.toasts, []);
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
  // #6019: Discover is a page of Home's now, not a tab (#2718 had made it
  // one, with an empty corner), so the list's way out is an arrow back to
  // Home, where its Discover section opened it.
  assert.equal(chrome.backIcon, 'arrow');
  assert.equal(chrome.backHref, '/', 'back to Home');
  assert.equal(chrome.title, 'Discover');
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
  // #6019: an arrow back to Home, where it came from, rather than up to a
  // list level this detail never came through. The BEHAVIOUR below is the
  // same: Back leaves the screen rather than showing a list nobody visited.
  assert.equal(chrome.backIcon, 'arrow', 'a detail with no list above it goes back to Home');
  assert.equal(chrome.backHref, '/');
  assert.equal(Browse.handleBack(), true, 'still claims the gesture');
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

test('a browse row tap opens the project hub; the home menu opens About and declares home', () => {
  // The row goes to the project's hub (the communities prototype), not to
  // the About page, so it notes no About origin: the hub is not a level of
  // Discover.
  const tap = BROWSE_SRC.slice(BROWSE_SRC.indexOf('openRow(view) {'),
    BROWSE_SRC.indexOf('warmRow(view) {'));
  assert.doesNotMatch(tap, /noteDetailOrigin/);
  assert.match(BROWSE_SRC, /rowHref\(view\) \{[\s\S]*?return `#app\/\$\{encodeURIComponent\(view\.slug\)\}\/workshop`;/);
  // Home's menu still drills into About and notes the origin BEFORE writing
  // the hash — the hashchange lands in a later task.
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
  assert.ok(fetchCalls.some((c) => c.url === '/api/apps/cold-app?manifest=summary'),
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
  assert.match(tsx, /\{t\('discover:detail\.unavailable'\)\}/);
  assert.equal(message('discover:detail.unavailable'), 'That app isn’t available.');
  assert.match(tsx, /id="browse-detail-back"/);
  assert.match(tsx, /\{t\('discover:detail\.backToAll'\)\}/);
  assert.match(message('discover:detail.backToAll'), /Back to all apps/);
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
  Browse._loaded = true;
  Browse.render();
  assert.match(state.empty, /No apps to show yet/, 'and a truly empty directory says so');
  assert.equal(state.loading, false);
});

test('L06: before the directory answers, the list is loading, not empty', async () => {
  // Overnight audit, 2 Nov 2026: a slow load on an iPhone Pro Max showed
  // "No apps to show yet." while every other device listed eleven apps.
  const { Browse, state } = makeBrowse({ apps: [app({ slug: 'chess', name: 'Chess' })] });
  Browse.render();
  assert.equal(state.loading, true, 'its rows\' place shows their skeleton');
  assert.equal(state.empty, null, 'and nothing claims the directory is empty');
  assert.equal(state.make, null);
  Browse._query = 'plant swap';
  Browse.render();
  assert.equal(state.empty, null, 'a search waits for the directory too');
  Browse._query = '';
  await Browse._load();
  assert.equal(state.loading, false);
  assert.deepEqual(slugs(state), ['chess']);
  // A directory that answers with nothing is empty, and says so.
  const none = makeBrowse({ apps: [] });
  await none.Browse._load();
  assert.equal(none.state.loading, false);
  assert.match(none.state.empty, /No apps to show yet/);
  // A failed read is the error card, never the skeleton.
  const failed = makeBrowse({ fetchOk: false });
  await failed.Browse._load();
  assert.equal(failed.state.loading, false);
  assert.equal(failed.state.error, true);
});

test('#5928: a search no app answers offers to make it; a filtered-away match does not', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [app({ slug: 'chess', name: 'Chess' })];
  Browse._query = '  plant swap ';
  Browse.render();
  assert.match(state.empty, /No apps match/);
  assert.equal(state.make, 'plant swap', 'the words typed, trimmed, are the idea');

  // Chess exists, but the Joined view hides it: relaxing the view finds it,
  // so there is nothing to make.
  Browse._view = 'joined';
  Browse._query = 'chess';
  Browse.render();
  assert.ok(state.empty, 'the joined view has nothing to show');
  assert.equal(state.make, null, 'an app elsewhere in the directory matches');

  // A web address offers its site row instead, and no empty line at all.
  Browse._view = 'foryou';
  Browse._query = 'example.com';
  Browse.render();
  assert.equal(state.empty, null);
  assert.equal(state.make, null);

  // No search, no offer, even when the list is empty.
  Browse._apps = [];
  Browse._loaded = true;
  Browse._query = '';
  Browse.render();
  assert.match(state.empty, /No apps to show yet/);
  assert.equal(state.make, null);
});

test('#5928: makeIdeaFor keeps the whole idea and ignores blank text', () => {
  const { Browse } = makeBrowse();
  assert.equal(Browse.makeIdeaFor('   ', []), null);
  assert.equal(Browse.makeIdeaFor(null, []), null);
  const long = 'a garden '.repeat(60).trim();
  assert.equal(Browse.makeIdeaFor(long, []), long, 'never cut: the make screen takes 4000');
});

test('#5928: a flagged app nobody can reach does not hide Make; a joined one does', () => {
  const { Browse } = makeBrowse();
  const flagged = app({ slug: 'plant-swap', name: 'Plant Swap', directory: { flagged: true } });
  assert.equal(Browse.makeIdeaFor('plant', [flagged]), 'plant',
    'Discover never lists a flagged app, so no filter can show it');
  const joined = app({ slug: 'plant-swap', name: 'Plant Swap', directory: { flagged: true }, is_member: true });
  assert.equal(Browse.makeIdeaFor('plant', [joined]), null,
    'the Joined view keeps a flagged app you are in, so it is found there');
});

test('#5928: Make and the results search match the same way', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [app({ slug: 'plant-swap', name: 'Plant Swap' })];
  for (const q of ['plant  swap', 'Plant Swap', 'plant']) {
    Browse._query = q;
    Browse.render();
    assert.equal(!!state.make, state.rows.length === 0,
      `"${q}": Make shows exactly when the results are empty`);
  }
  Browse._query = 'plant  swap';
  Browse.render();
  assert.equal(state.make, 'plant  swap', 'two spaces find nothing, so Make offers them');
});

function renderBrowseScreen(patch) {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const initial = {
    level: 'list', rows: [], site: null, curated: true, grouped: true, moreExpanded: false,
    empty: null, make: null, error: false, detail: null, sort: 'recommended', view: 'foryou',
    only: [], activeCount: 0, filter: 'all', categories: [], category: 'all',
  };
  const value = { ...initial, ...patch };
  const browseStore = { get: () => value, subscribe: () => () => {} };
  const mod = loadTsx('frontend/src/features/apps/browse-screen.tsx', {
    stubs: { './mount': { browseStore } },
  });
  return renderToHtml(createElement(mod.BrowseScreen, {}));
}

test('#5928: the empty line draws Make with the idea only when there is one', () => {
  const plain = renderBrowseScreen({ empty: 'No apps match “zz”.' });
  assert.match(plain, /id="browse-empty"[^>]*>No apps match “zz”\.<\/div>/,
    'without an idea, #browse-empty is the sentence alone');
  assert.doesNotMatch(plain, /browse-empty-make/);

  const html = renderBrowseScreen({ empty: 'No apps match “plant swap”.', make: 'plant swap' });
  const btn = html.match(/<button[^>]*id="browse-empty-make"[^>]*><span class="min-w-0 truncate">([^<]*)<\/span><\/button>/);
  assert.ok(btn, 'the Make button is drawn under the sentence');
  assert.equal(btn[1], message('discover:empty.search.make').replace('{{idea}}', 'plant swap'));
  assert.match(btn[0], /bg-violet-600/, 'the accent pill: it is the action the line offers');

  const prerender = renderBrowseScreen({});
  assert.match(prerender, /id="browse-empty" class="hidden [^"]*"><\/div>/,
    'the prerender ships #browse-empty empty and hidden, as before');
});

test('#5928: pressing Make opens "What do you want to make?" with the whole search', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const mod = loadTsx('frontend/src/features/apps/browse-screen.tsx', {
    stubs: { './mount': { browseStore: { get: () => ({}), subscribe: () => () => {} } } },
  });
  const calls = [];
  const prevWindow = globalThis.window;
  globalThis.window = { App: { showCreateModal: (opts) => { calls.push(opts); return true; } } };
  try {
    const idea = 'a garden '.repeat(30).trim();
    const button = mod.MakeFromSearch({ idea, label: `Make “${idea}”` });
    assert.equal(button.props.id, 'browse-empty-make');
    button.props.onClick();
    assert.deepEqual(calls, [{ idea, ideaSource: 'search' }], 'showCreateModal gets the idea, uncut, and says it came from a search');
  } finally {
    globalThis.window = prevWindow;
  }
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
  assert.match(read('frontend/src/features/apps/browse-screen.tsx'), /<AppsLoadError[\s\S]*?title=\{t\('discover:loadError\.directoryTitle'\)\}[\s\S]*?onRetry=\{\(\) => browse\(\)\?\._load\?\.\(\)\}/);
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

// ── Join / Leave (Home.setMembership — Discover's pill, communities) ──

test('the Discover pill joins: POST { joined: true }, and the row, the chip and Home agree at once', async () => {
  const { Browse, Home, fetchCalls, toasts } = makeBrowse();
  const fresh = app({ slug: 'fresh', name: 'Fresh App', member_count: 2 });
  Home._apps = [fresh];
  Browse._apps = [fresh];
  Browse.toggleRowAdded(Browse.rowView(fresh));
  assert.equal(fresh.is_member, true, 'optimistic: the pill reads Joined before the write lands');
  assert.equal(fresh.is_favorited, true, 'and it is pinned, as Add pinned it');
  assert.equal(fresh.member_count, 3);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(fetchCalls[0], {
    url: '/api/apps/fresh/membership', method: 'POST', body: { joined: true },
  });
  assert.equal(Browse.filterApps([fresh], 'yours').length, 1, 'and the Joined chip holds it');
  assert.deepEqual(toasts, ['Joined Fresh App']);
});

test('leaving asks first, and a No leaves everything as it was', async () => {
  const { Home, fetchCalls, win } = makeBrowse();
  const mine = app({ slug: 'mine', name: 'Mine', is_member: true, is_favorited: true });
  Home._apps = [mine];
  const asked = [];
  win.ConfirmModal = { show: async (o) => { asked.push(o); return false; } };
  assert.equal(await Home.setMembership('mine', false), false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, 'Leave Mine?');
  assert.equal(asked[0].danger, true);
  assert.match(asked[0].message, /propose or vote/);
  assert.equal(mine.is_member, true);
  assert.equal(fetchCalls.length, 0, 'nothing is sent');

  win.ConfirmModal = { show: async () => true };
  assert.equal(await Home.setMembership('mine', false), true);
  assert.equal(mine.is_member, false);
  assert.equal(mine.is_favorited, false, 'leaving takes it off Home too');
  assert.deepEqual(fetchCalls[0].body, { joined: false });
});

test('the Joined view offers Leave beside Open, never to the creator or outside Joined (#5953)', async () => {
  const { Browse, Home, fetchCalls, win, state } = makeBrowse({ user: { id: 7 } });
  const theirs = app({ slug: 'theirs', name: 'Theirs', is_member: true, is_favorited: true, created_by: 3 });
  const made = app({ slug: 'made', name: 'Made', is_member: true, is_favorited: true, created_by: 7 });
  const fresh = app({ slug: 'fresh', name: 'Fresh' });
  Home._apps = [theirs, made, fresh];
  Browse._apps = [theirs, made, fresh];

  Browse.setView('browse');
  assert.equal(rowFor(state, 'theirs').canLeave, false, 'Browse keeps its one button: Open');
  Browse.setView('joined');
  assert.equal(rowFor(state, 'theirs').canLeave, true, 'a member who did not make it can leave');
  assert.equal(rowFor(state, 'theirs').canOpen, true, 'and Open stays beside it');
  assert.equal(rowFor(state, 'made').canLeave, false, 'the creator cannot leave what they started');

  // Leave goes through setMembership, so it asks first and a No sends nothing.
  const asked = [];
  win.ConfirmModal = { show: async (o) => { asked.push(o); return false; } };
  Browse.leaveRow(rowFor(state, 'theirs'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, 'Leave Theirs?');
  assert.equal(fetchCalls.length, 0);

  win.ConfirmModal = { show: async () => true };
  Browse.leaveRow(rowFor(state, 'theirs'));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(fetchCalls[0], { url: '/api/apps/theirs/membership', method: 'POST', body: { joined: false } });
  assert.equal(theirs.is_member, false);
  assert.deepEqual(slugs(state), ['made'], 'the left app drops out of Joined');

  // A row that cannot leave never sends anything.
  Browse.leaveRow(rowFor(state, 'made'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fetchCalls.length, 1);
  assert.match(BROWSE_LIST_SRC, /data-action="leave"/);
  assert.match(BROWSE_LIST_SRC, /\.browse-leave-btn/, 'the row click skips the button');
  // Open and Leave go in one box, the row's one trailing control.
  assert.match(BROWSE_LIST_SRC, /<span className="browse-row-actions [^"]*">\s*\{primary\}\s*\{leave\}/);
  // Overnight audit W08: one row shape at every width (no phone grid), so
  // the pair sits in the row's trailing slot like Open alone does.
  assert.doesNotMatch(APP_CSS, /\.browse-row\.browse-row \{\s*display: grid;/);
});

test('leaving a private app says it costs access', async () => {
  const { Home, win } = makeBrowse();
  Home._apps = [app({ slug: 'priv', name: 'Priv', is_member: true, view_visibility: 'private' })];
  let message = '';
  win.ConfirmModal = { show: async (o) => { message = o.message; return false; } };
  await Home.setMembership('priv', false);
  assert.match(message, /lose access/);
});

test('with no confirm dialog there is no leaving', async () => {
  const { Home, fetchCalls } = makeBrowse();
  const mine = app({ slug: 'mine', is_member: true });
  Home._apps = [mine];
  assert.equal(await Home.setMembership('mine', false), false);
  assert.equal(mine.is_member, true);
  assert.equal(fetchCalls.length, 0);
});

// #5962: the question comes BEFORE anything moves, in one sheet, so Cancel
// leaves Home exactly as it was. It used to be asked after the unpin had
// landed, and the tile was gone whichever button was pressed.
function sheetAnswering(choice, asked) {
  return async (o) => {
    asked.push(o);
    return choice ? o.actions.find((a) => a.choice === choice) : null;
  };
}

test('removing a member app asks first, and Cancel changes nothing (#5962)', async () => {
  const asked = [];
  const { Home, fetchCalls } = makeBrowse({ actionSheet: sheetAnswering(null, asked) });
  const mine = app({ slug: 'mine', name: 'Mine', is_member: true, is_favorited: true, created_by: 77 });
  Home._apps = [mine];
  await Home.toggleAdded('mine', false, () => {});
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, 'Remove Mine from your Home screen? You can stay a member, or leave it too and stop proposing and voting on its changes.');
  assert.deepEqual(JSON.parse(JSON.stringify(asked[0].actions.map((a) => [a.label, !!a.destructive]))), [
    ['Remove from Home', false],
    ['Remove and leave Mine', true],
  ]);
  assert.equal(mine.is_favorited, true, 'the tile is still on Home');
  assert.equal(mine.is_member, true);
  assert.equal(fetchCalls.length, 0, 'nothing is sent');
});

test('"Remove from Home" unpins and keeps the membership; "Remove and leave" does both (#5962)', async () => {
  const asked = [];
  let answer = 'remove';
  const { Home, fetchCalls } = makeBrowse({
    actionSheet: async (o) => { asked.push(o); return o.actions.find((a) => a.choice === answer); },
  });
  const keep = app({ slug: 'keep', name: 'Keep', is_member: true, is_favorited: true, created_by: 77 });
  const gone = app({ slug: 'gone', name: 'Gone', is_member: true, is_favorited: true, created_by: 77, view_visibility: 'private' });
  Home._apps = [keep, gone];
  await Home.toggleAdded('keep', false, () => {});
  assert.equal(keep.is_favorited, false);
  assert.equal(keep.is_member, true, 'still a member');
  answer = 'leave';
  await Home.toggleAdded('gone', false, () => {});
  assert.match(asked[1].title, /ends your access until someone invites you back/, 'a private app says what leaving costs');
  assert.deepEqual(fetchCalls.map((c) => [c.url, c.body]), [
    ['/api/apps/keep/favorite', { favorited: false }],
    ['/api/apps/gone/favorite', { favorited: false }],
    ['/api/apps/gone/membership', { joined: false }],
  ], 'one question each, and no second confirm before the leave');
  assert.equal(gone.is_member, false);
});

test('nobody is asked who is not in it, who started it, or when there is no kit', async () => {
  const asked = [];
  const { Home, fetchCalls } = makeBrowse({ user: { id: 5 }, actionSheet: sheetAnswering('leave', asked) });
  const outsider = app({ slug: 'pinned', is_favorited: true });
  const mine = app({ slug: 'mine', is_member: true, is_favorited: true, created_by: 5 });
  Home._apps = [outsider, mine];
  await Home.toggleAdded('pinned', false, () => {});
  await Home.toggleAdded('mine', false, () => {});
  assert.equal(asked.length, 0);
  assert.equal(outsider.is_favorited, false);
  assert.equal(mine.is_favorited, false, 'the creator\'s tile goes, unasked');
  assert.ok(fetchCalls.every((c) => !/membership/.test(c.url)));

  const bare = makeBrowse();
  const member = app({ slug: 'm', is_member: true, is_favorited: true, created_by: 77 });
  bare.Home._apps = [member];
  await bare.Home.toggleAdded('m', false, () => {});
  assert.equal(member.is_favorited, false, 'no kit, no sheet: the unpin goes ahead');
  assert.equal(member.is_member, true);
});

test('pinning marks the app joined at once, because the pin joins it', async () => {
  const { Home } = makeBrowse();
  const fresh = app({ slug: 'fresh' });
  Home._apps = [fresh];
  await Home.toggleAdded('fresh', true, () => {});
  assert.equal(fresh.is_member, true);
});

test('a refused join puts the flags back and re-syncs', async () => {
  const { Home, toasts } = makeBrowse({ fetchOk: false });
  const fresh = app({ slug: 'fresh', name: 'Fresh' });
  Home._apps = [fresh];
  let reloaded = 0;
  Home.load = async () => { reloaded += 1; };
  assert.equal(await Home.setMembership('fresh', true), false);
  assert.ok(!fresh.is_member, 'back to what the server last said');
  assert.ok(!fresh.is_favorited);
  assert.equal(reloaded, 1);
  assert.match(toasts[0], /^Couldn’t join/);
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
  // Always visible here (the hidden-until-pulled treatment is home's), and
  // not pinned (#5267): a pinned bar needs a fill, and the fill was the band.
  assert.doesNotMatch(main.match(/<div id="browse-search-bar"[^>]*>/)[0], /sticky/);
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

test('#1553: the row button names what it acts on, like every other surface', () => {
  // "Add" alone did not say add to WHAT (#1553); the pill is Join now
  // (communities), and "Join" alone would not say join WHAT for someone not
  // reading the row. The accessible name and the title spell out the app.
  const listSrc = read('frontend/src/features/apps/browse-list.tsx');
  // QA 2026-09-24 Q10: a long pill squeezed the app's name to ten characters
  // on desktop and to nothing at 1024, so the visible label stays one short
  // word and the rest rides the accessible name and the title.
  assert.match(listSrc, /\{t\('discover:list\.join\.action'\)\}/);
  assert.equal(message('discover:list.join.action'), 'Join');
  assert.match(listSrc, /aria-label=\{t\('discover:list\.join\.named', \{ app: view\.name \}\)\}/);
  assert.equal(message('discover:list.join.named', { app: 'Recipe Box' }), 'Join Recipe Box');
  assert.match(listSrc, /title=\{view\.addTitle\}/);
  assert.match(listSrc, /<PlusIcon /);
  // #5267: a joined row offers Open, the next thing to do with the app, in
  // place of the "✓ Joined" state that filled the directory. Same rule: one
  // short word, the app's name in the accessible name.
  assert.match(listSrc, /\{t\('discover:list\.open\.action'\)\}/);
  assert.equal(message('discover:list.open.action'), 'Open');
  assert.match(listSrc, /aria-label=\{t\('discover:list\.open\.named', \{ app: view\.name \}\)\}/);
  assert.doesNotMatch(listSrc, /CheckIcon|list\.join\.joined/, 'no "✓ Joined" left on a row');
});

// ── #5267: Recommended for you, Not joined, Open, the admin's chip ────

test('#5267: the default list leads with Recommended for you, the featured apps you are not in', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [
    app({ slug: 'loud', active_users: 99, directory: { tier: 'ready', state: 'working' } }),
    app({ slug: 'f-second', featured: true, featured_order: 2, directory: { tier: 'ready', state: 'working' } }),
    app({ slug: 'f-first', featured: true, featured_order: 1, directory: { tier: 'unreviewed', state: 'unreviewed' } }),
    app({ slug: 'f-mine', featured: true, featured_order: 0, is_member: true, directory: { tier: 'ready', state: 'working' } }),
    app({ slug: 'f-demo', featured: true, featured_order: 0, directory: { tier: 'more', state: 'demo' } }),
  ];
  Browse.render();
  assert.equal(state.grouped, true);
  const picked = Array.from(state.rows.filter((r) => r.recommended), (r) => r.slug);
  // The admin's featured order, not the tier order, and never a joined app
  // or one under Show more.
  assert.deepEqual(picked, ['f-first', 'f-second']);
  assert.deepEqual(slugs(state).slice(0, 2), ['f-first', 'f-second'], 'and they come first');
  assert.equal(slugs(state).filter((s) => s === 'f-first').length, 1, 'each app is listed once');
  assert.ok(slugs(state).includes('f-mine'), 'a joined featured app is still in the list below');
  // Only the default list: another chip, a metric sort or a search is one
  // list in its own order, with no section.
  for (const go of [() => Browse.applyFilters({ only: ['featured'] }), () => Browse.setSort('users'),
    () => Browse.setQuery('f', { immediate: true })]) {
    go();
    assert.equal(state.grouped, false);
    assert.equal(state.rows.some((r) => r.recommended), false);
  }
});

test('#5267: Join keeps the row where it was, now offering Open', () => {
  const { Browse, Home, state } = makeBrowse();
  const pick = app({ slug: 'pick', name: 'Pick', featured: true, featured_order: 0, directory: { tier: 'ready', state: 'working' } });
  const other = app({ slug: 'other', name: 'Other' });
  Home._apps = [pick, other];
  Browse._apps = [pick, other];
  Browse.render();
  Browse.toggleRowAdded(rowFor(state, 'pick'));
  assert.equal(pick.is_member, true);
  const row = rowFor(state, 'pick');
  assert.equal(row.recommended, true, 'still in Recommended for you for this visit');
  assert.equal(row.added, true);
  assert.equal(row.addTitle, 'Open Pick');
  Browse.applyFilters({ only: ['notjoined'] });
  assert.deepEqual(slugs(state), ['other'], 'a new list is built without it');
  Browse.toggleRowAdded(rowFor(state, 'other'));
  assert.deepEqual(slugs(state), ['other'], 'Not joined keeps a row joined from it');
});

test('#5267: Open opens the app itself, and only an app that can run', () => {
  const opened = [];
  const { Browse, win } = makeBrowse();
  win.App.navigateToApp = (slug) => opened.push(slug);
  const running = Browse.rowView(app({ slug: 'up', is_member: true }));
  const broken = Browse.rowView(app({ slug: 'down', is_member: true, status: 'error' }));
  const fixture = Browse.rowView(app({ slug: 'demo', is_member: true, demo: true }));
  assert.equal(broken.canOpen, false);
  assert.equal(fixture.canOpen, false, 'a staging fixture has no app to open');
  Browse.openRowApp(running);
  Browse.openRowApp(broken);
  Browse.openRowApp(fixture);
  assert.deepEqual(opened, ['up']);
});

test('a flagged app is out of For you and Browse for everyone, and stays in Joined for its members', () => {
  const flagged = { tier: 'hidden', state: 'flagged', label: 'Hidden from Discover', flagged: true };
  const apps = () => [
    app({ slug: 'ok', icon_emoji: '🎮', directory: { tier: 'listed', state: 'listed' } }),
    app({ slug: 'hidden', icon_emoji: '🚩', active_users: 9999, directory: flagged }),
    app({ slug: 'hidden-mine', icon_emoji: '🚩', is_member: true, directory: flagged }),
  ];
  for (const user of [undefined, { id: 2, isAdmin: true }]) {
    const { Browse, state } = makeBrowse({ user });
    Browse._apps = apps();
    Browse._load = () => {};
    Browse.open(null);
    assert.deepEqual(slugs(state), ['ok'], 'For you');
    Browse.setView('browse');
    assert.deepEqual(slugs(state), ['ok'], 'Browse');
    Browse.setView('joined');
    assert.deepEqual(slugs(state), ['hidden-mine'], 'Joined is what you are in');
    assert.equal(rowFor(state, 'hidden-mine').directoryTier, 'more');
    assert.equal(state.adminFilters, undefined, 'no admin switch for anyone');
  }
  const { Browse } = makeBrowse();
  assert.deepEqual(Array.from(Browse.listedApps(apps()), (a) => a.slug), ['ok']);
});

test('#5267: an empty Hide apps I’ve joined says so', () => {
  const { Browse, state } = makeBrowse();
  Browse._apps = [app({ slug: 'mine', name: 'Mine', is_member: true })];
  Browse.applyFilters({ only: ['notjoined'] });
  assert.equal(state.empty, 'You’ve joined every app here.');
  Browse.setQuery('zzz', { immediate: true });
  assert.equal(state.empty, 'Nothing you haven’t joined matches “zzz”.');
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

test('#discover is an alias of #apps, landing on Discover itself', () => {
  // UX audit, 20 Oct 2026: Discover's own address is #apps, and a typed or
  // shared #discover matched no branch and fell through to Home. The alias
  // rewrites the address in place (no Back step, no re-route) and then hands
  // off to the same navigation, as #workshop does for #communities.
  const start = APP_SRC.indexOf("parts[0] === 'discover'");
  assert.ok(start > -1, 'a #discover branch exists');
  const branch = APP_SRC.slice(start, APP_SRC.indexOf("parts[0] === 'apps'", start));
  const rewrite = branch.indexOf("history.replaceState(null, '', '#apps'");
  assert.ok(rewrite > -1, 'the address settles on Discover\'s own');
  assert.ok(rewrite < branch.indexOf('App.navigateToBrowse'),
    'the rewrite runs first, so the router lands on the canonical address');
  assert.match(branch,
    /App\.navigateToBrowse\(parts\[1\] \? decodeURIComponent\(parts\[1\]\) : null\)/,
    'and an optional app segment deep-links as #apps/<slug> does');
  // Its FIRST PAINT is Discover too, not Home for a beat before the router.
  assert.match(APP_SRC, /case 'discover': return 'browse-screen'/);
});

test('navigateToBrowse / _exitBrowse follow the screen pattern', () => {
  assert.match(APP_SRC, /navigateToBrowse\(slug\) \{/);
  assert.match(APP_SRC, /_exitBrowse\(\) \{/);
  const nav = APP_SRC.slice(
    APP_SRC.indexOf('navigateToBrowse(slug) {'),
    APP_SRC.indexOf('_exitBrowse() {')
  );
  assert.match(nav, /setHeaderTitle\(PlatformI18n\.t\('shell:title\.allApps'\)\)/);
  assert.equal(message('shell:title.allApps'), 'Discover');
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
  const home = APP_SRC.slice(APP_SRC.indexOf('navigateHome(opts) {'));
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
  // The fold state rides the descriptor so the toggle can expose it as
  // aria-expanded rather than only through its label (#2991).
  assert.equal(folded.expanded, false);
  assert.equal(open.expanded, true);
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
  Home.menuItemsFor = () => ([{ key: 'fork', label: 'Remix', run: () => {} }]);
  Browse._apps = [app({ slug: 'detail-me', name: 'Detail Me' })];
  Browse.showDetail('detail-me');
  assert.match(state.detail.contributors.note, /Loading contributors/,
    'first paint is the loading card');
  assert.deepEqual(state.detail.actions.map((a) => a.label), ['Remix'],
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

test('Filters is a centred dialog from 768px and a bottom sheet on a phone', () => {
  const src = read('frontend/src/features/apps/browse-filter-sheet.tsx');
  assert.match(src, /window\.matchMedia\('\(min-width: 768px\)'\)\.matches/);
  assert.match(src, /const dialog = wide\(\) && typeof kit\.modal === 'function';/);
  assert.match(src, /\? kit\.modal!\(\{ contentEl: panel, onDismiss: finish \}\)\s+: kit\.sheet\(\{ contentEl: panel, onDismiss: finish \}\)/);
  // The dialog's card brings its own padding; the sheet's panel pads itself.
  assert.match(src, /className=\{dialog \? undefined : 'px-4 pb-5'\}/);
  assert.match(src, /setAttribute\('aria-labelledby', 'browse-filters-title'\)/);
  assert.match(src, /<h2 id="browse-filters-title"/);
});
