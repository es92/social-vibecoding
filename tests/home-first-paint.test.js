// Home's first paint is its final shape (#10, and the web half of #1, on the
// polish board of 19 Oct 2026).
//
// A cold load drew Home in skeletons and then rearranged it: the grid's real
// rows and "Show all 21 apps" pushed Discover and Challenges down, Discover
// grew from its heading into a card, the Challenges heading changed words,
// the desktop sidebar's community rows arrived 185px tall over "All 31
// communities", the tab bar renamed its fifth tab and found its community,
// and the challenge art arrived a frame after its card. Measured on a desktop
// at one layout shift of 0.0585 on every cold load. This file pins each part
// of the fix:
//
//   1. the heights this device last drew at, kept (lib/first-paint-reserve.ts)
//      and put on <html> before the first paint (the head's inline script),
//      held by app.css only while a box is still a skeleton;
//   2. HomePanels' first paint waits for both reads, and the sections hold a
//      skeleton and the heading's box (not its words) until then;
//   3. the tab bar's viewer and the sidebar's list of communities applied in
//      the same task as hydration (lib/shell-snapshot-apply.ts);
//   4. the challenge art: precached, decoded before the cards draw, sized.
//
// The layout-shift numbers themselves need a browser; the proposal's history
// records them (CLS 0.038 → 0 on a desktop, 0.084 → 0 on a phone, in Chrome).
//
// Run with: node --test tests/home-first-paint.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { PANELS_SRC, HOME_RAW, PANELS_RAW } = require('./helpers/home-modules');
const { installPanelsStore } = require('./helpers/home-grid-store');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const RESERVE = 'frontend/src/lib/first-paint-reserve.ts';
const SECTIONS = 'frontend/src/features/home/panels/sections.tsx';
const SCOPE = 'frontend/src/features/workshop/community-scope.ts';
const APPLY = 'frontend/src/lib/shell-snapshot-apply.ts';
const NAV_STORE = 'frontend/src/features/nav/nav-store.js';
const HEAD = read('frontend', 'src', 'head.html');
const CSS = read('public', 'css', 'app.css');

function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test.afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.fetch;
});

// ── 1. The heights, kept and held ──────────────────────────────────────

/** The head's inline script, as it ships. */
const headScript = (() => {
  const at = HEAD.indexOf("localStorage.getItem('usernode.first-paint.v1')");
  assert.ok(at !== -1, 'the head reads the kept heights');
  const start = HEAD.lastIndexOf('<script>', at) + '<script>'.length;
  return HEAD.slice(start, HEAD.indexOf('</script>', at));
})();

function runHead({ storage, width = 1440, height = 900, textSize = null }) {
  const props = {};
  const classes = new Set();
  const root = {
    getAttribute: (n) => (n === 'data-text-size' ? textSize : null),
    style: { setProperty: (k, v) => { props[k] = v; } },
    classList: { add: (c) => classes.add(c) },
  };
  const sandbox = { window: { innerWidth: width, innerHeight: height }, document: { documentElement: root }, localStorage: storage, JSON, Number, isFinite };
  vm.runInNewContext(headScript, sandbox);
  return { props, classes };
}

// The placeholder is the tile's own size (27 Nov 2026): its two rows lie on the grid's rows, and from 1280px its tile is
// today's 48px row. It drew the kit's 96px rows in a box held for two of 56px, and ran over what was under it.
test('Pinned projects\' placeholder lies on the grid\'s rows, at today\'s tile size', () => {
  const at = CSS.indexOf('html:root #app-list:not([data-view]) > .animate-pulse {');
  assert.ok(at !== -1, 'the placeholder\'s own rule');
  assert.match(CSS.slice(at, CSS.indexOf('}', at) + 1), /grid-row: span 2;\s*grid-auto-rows: var\(--home-cell-h\);/);
  const rest = CSS.slice(at);
  assert.match(rest, /@media \(min-width: 1280px\) \{\s*html:root #app-list:not\(\[data-view\]\) > \.animate-pulse > div \{ gap: 12px; height: 48px; padding: 0 4px; \}\s*html:root #app-list:not\(\[data-view\]\) > \.animate-pulse > div > :first-child \{ width: 48px; height: 48px;/);
  assert.match(rest, /@media \(max-width: 639\.98px\) \{[^@]*html:root #app-list:not\(\[data-view\]\) \{ min-height: calc\(2 \* var\(--home-cell-h\) \+ 1\.875rem\); \}/);
});

// Three more placeholders are the size of what lands (27 Nov 2026): Challenges' held label row is the linked label's
// 54px, the inbox placeholder leads with the heading's own box, and a Featured cover's words are a real cover's height.
// Each was shorter, so what was under it dropped when the real part arrived (16px, 40px, and 4px a row of covers).
test('Challenges\', the inbox\'s and Featured\'s placeholders hold what lands under them', () => {
  assert.match(CSS, /html:root #home-screen #home-challenges-section\.home-section-pending > \.home-area-label \{ min-height: 3\.375rem; \}/);
  assert.match(CSS, /html:root #home-screen #home-apps-section > \.home-area-label \{ min-height: 3\.375rem; \}/, 'the height a label row with its link has');
  // The placeholder's leading line is named in the heading's own rules, on a phone and from 768px.
  const lead = 'html:root #messages-screen .messages-list-pane .messages-list-scroll > .animate-pulse::before';
  const head = 'html:root #messages-screen .messages-list-pane .messages-section-head';
  assert.ok(CSS.includes(`${lead} { content: "\\00A0"; display: block; }`), 'an empty line, a block');
  assert.ok(CSS.includes(`${head},\n${lead} {\n  padding: 15px 6px 8px;`), 'the heading\'s box on a phone');
  assert.ok(CSS.includes(`  ${head},\n  ${lead} { padding: 16px 6px 8px; }`), 'and from 768px');
  const cover = 'html:root :is(#home-screen, #communities-screen) [data-home-join-featured] .cm-card-skel .cm-card-skel-body';
  assert.ok(CSS.includes(`${cover} { height: 63px; }`));
  assert.ok(CSS.includes(`@media (min-width: 768px) {\n  ${cover} { height: 62px; }\n}`));
});

test('the head and the module keep the same record: key, size and property names', () => {
  const reserve = loadTsx(RESERVE);
  assert.equal(reserve.RESERVE_KEY, 'usernode.first-paint.v1');
  assert.equal(reserve.reserveKey({ innerWidth: 1440, innerHeight: 900 }, null), '1440x900|normal');
  assert.equal(reserve.reserveKey({ innerWidth: 390, innerHeight: 844 }, 'large'), '390x844|large');
  assert.match(headScript, /window\.innerWidth \+ 'x' \+ window\.innerHeight \+ '\|'\s*\+ \(root\.getAttribute\('data-text-size'\) \|\| 'normal'\)/,
    'the head builds the same key');
  const at = HEAD.indexOf(headScript);
  assert.ok(HEAD.indexOf('window.Display = ') < at, 'after the Display module has put the text size on <html>');
  assert.ok(HEAD.indexOf('name="viewport"') < at, 'and after the viewport meta, so the width is the page\'s');
});

test('the head puts a kept size on <html>, and nothing without one', () => {
  const sizes = { '1440x900|normal': { homeApps: 354, homeDiscover: 120.5, homeChallenges: 377, railCommunities: 222, at: 1 } };
  const kept = JSON.stringify({ sizes });
  const signedIn = { 'usernode.session.v1': '{"user":{"id":1}}', 'usernode.first-paint.v1': kept };

  const hit = runHead({ storage: fakeStorage(signedIn) });
  assert.deepEqual(hit.props, {
    '--reserve-home-apps': '354px',
    '--reserve-home-discover': '120.5px',
    '--reserve-home-challenges': '377px',
    '--reserve-rail-communities': '222px',
  });
  assert.ok(hit.classes.has('first-paint-reserved'));

  const otherSize = runHead({ storage: fakeStorage(signedIn), width: 1280 });
  assert.deepEqual(otherSize.props, {}, 'a window of another size draws the skeletons at their own shape');
  assert.equal(otherSize.classes.size, 0);

  const signedOut = runHead({ storage: fakeStorage({ 'usernode.first-paint.v1': kept }) });
  assert.deepEqual(signedOut.props, {}, 'no session snapshot: the landing comes, not Home');

  const odd = runHead({ storage: fakeStorage({ ...signedIn, 'usernode.first-paint.v1': JSON.stringify({ sizes: { '1440x900|normal': { homeApps: 'tall', homeDiscover: -4, homeChallenges: 1e6 } } }) }) });
  assert.deepEqual(odd.props, {}, 'only a plausible height is applied');

  const corrupt = runHead({ storage: fakeStorage({ ...signedIn, 'usernode.first-paint.v1': '{' }) });
  assert.deepEqual(corrupt.props, {}, 'a corrupt record is nothing kept');
});

test('app.css holds each box at its kept height only while it is a skeleton', () => {
  const rules = [
    ['html.first-paint-reserved #home-apps-section:has(#app-list:not([data-view]))', /height: var\(--reserve-home-apps\);\s*overflow: hidden;/],
    ['html.first-paint-reserved #home-discover-section.home-section-pending', /height: var\(--reserve-home-discover\);\s*overflow: hidden;/],
    ['html.first-paint-reserved #home-challenges-section.home-section-pending', /height: var\(--reserve-home-challenges\);\s*overflow: hidden;/],
    ['html.first-paint-reserved .platform-rail-communities:has(> .platform-rail-head:last-child)', /min-height: var\(--reserve-rail-communities\);/],
  ];
  for (const [selector, body] of rules) {
    const at = CSS.indexOf(`${selector} {`);
    assert.ok(at !== -1, `missing: ${selector}`);
    assert.match(CSS.slice(at, CSS.indexOf('}', at) + 1), body, selector);
  }
  // `data-view` is the grid's first READY render (app-grid.tsx), the same
  // marker the two-row reserve above it keys on.
  assert.match(read('frontend', 'src', 'features', 'home', 'app-grid.tsx'), /data-view=\{state\.ready \? state\.view : undefined\}/);
});

/** A document with Home's three areas and the sidebar's rows at given heights. */
function fakePage({ homeShown = true, heights = {}, railRows = 6 } = {}) {
  const el = (id, h, extra = {}) => ({
    id,
    classList: { contains: (c) => c === 'hidden' && extra.hidden === true },
    getClientRects: () => (extra.hidden ? [] : [{}]),
    getBoundingClientRect: () => ({ height: h }),
    childElementCount: extra.children ?? 1,
  });
  const nodes = {
    'home-screen': el('home-screen', 800, { hidden: !homeShown }),
    'home-apps-section': el('home-apps-section', heights.apps ?? 354.004),
    'home-discover-section': el('home-discover-section', heights.discover ?? 121),
    'home-challenges-section': el('home-challenges-section', heights.challenges ?? 377),
    'platform-rail-communities': el('platform-rail-communities', heights.rail ?? 222, { children: railRows }),
  };
  return { getElementById: (id) => nodes[id] || null, documentElement: { getAttribute: () => null } };
}

test('what is kept: Home at rest with both sections painted, and the sidebar with its rows', () => {
  const grid = loadTsx('frontend/src/features/home/grid-store.ts');
  const panels = loadTsx('frontend/src/features/home/panels-store.ts');
  const reserve = loadTsx(RESERVE, { stubs: { '../features/home/grid-store': grid, '../features/home/panels-store': panels } });
  globalThis.window = { Home: { _appsExpanded: false, _query: '' }, localStorage: fakeStorage() };

  assert.deepEqual({ ...reserve.measure(fakePage({ railRows: 1 })) }, {},
    'skeletons: nothing is kept, and a sidebar with only its heading is not kept either');

  grid.gridStore.set({ ready: true, view: 'grid', notice: null, editing: false });
  assert.deepEqual({ ...reserve.measure(fakePage()) }, { railCommunities: 222 },
    'the grid is in but the sections are not painted yet: only the sidebar');

  panels.panelsStore.set({ painted: true });
  assert.deepEqual({ ...reserve.measure(fakePage()) },
    { homeApps: 354, homeDiscover: 121, homeChallenges: 377, railCommunities: 222 },
    'the resting shape, exact to the hundredth');

  window.Home._appsExpanded = true;
  assert.equal(reserve.measure(fakePage()).homeApps, undefined, '"Show all" pressed is not how a cold load draws');
  window.Home._appsExpanded = false;
  window.Home._query = 'todo';
  assert.equal(reserve.measure(fakePage()).homeApps, undefined, 'nor is a search');
  window.Home._query = '';
  grid.gridStore.set({ editing: true });
  assert.equal(reserve.measure(fakePage()).homeApps, undefined, 'nor edit mode');
  grid.gridStore.set({ editing: false, notice: { text: 'Offline', tone: 'muted' } });
  assert.equal(reserve.measure(fakePage()).homeApps, undefined, 'nor a load notice');
  grid.gridStore.set({ notice: null });
  assert.deepEqual({ ...reserve.measure(fakePage({ homeShown: false })) }, {}, 'nothing while Home is not the screen');
});

test('kept per size, merged, the newest four sizes only', () => {
  const reserve = loadTsx(RESERVE);
  const storage = fakeStorage();
  globalThis.window = { localStorage: storage };
  const kept = () => JSON.parse(storage.getItem('usernode.first-paint.v1')).sizes;
  reserve.saveReserve('390x844|normal', { railCommunities: 0, homeApps: 330 }, 1);
  reserve.saveReserve('390x844|normal', { homeDiscover: 121 }, 2);
  assert.deepEqual(kept()['390x844|normal'], { railCommunities: 0, homeApps: 330, homeDiscover: 121, at: 2 }, 'a patch merges');
  for (let i = 0; i < 5; i += 1) reserve.saveReserve(`${1000 + i}x900|normal`, { homeApps: i }, 10 + i);
  assert.deepEqual(Object.keys(kept()).sort(), ['1001x900|normal', '1002x900|normal', '1003x900|normal', '1004x900|normal']);
  const before = storage.getItem('usernode.first-paint.v1');
  reserve.saveReserve('1004x900|normal', { homeApps: 4 }, 99);
  assert.equal(storage.getItem('usernode.first-paint.v1'), before, 'an unchanged height is not written again');
});

test('the browser entry keeps them, after hydration', () => {
  const main = read('frontend', 'src', 'main.tsx');
  assert.match(main, /import \{ installFirstPaintReserve \} from '\.\/lib\/first-paint-reserve';/);
  assert.ok(main.indexOf("bootStep('installFirstPaintReserve'") > main.indexOf("bootStep('hydrate'"));
});

// ── 2. One paint, when both reads are in ───────────────────────────────

function panelsSandbox({ home } = {}) {
  const sandbox = {
    console,
    App: { user: { id: 1 } },
    ...(home ? { Home: home } : {}),
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    setTimeout, clearTimeout, URLSearchParams, location: { search: '', hash: '' }, Date,
    addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  installPanelsStore(sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.__HP = HomePanels;`, sandbox);
  return { HP: sandbox.__HP, sandbox, painted: () => sandbox.panelsStore.get().painted };
}

const DATA = { registry: [{ key: 'discover' }, { key: 'challenges' }], hidden: [], panels: [] };

test('HomePanels\' first paint waits for both the panels and the apps', () => {
  const home = { _appsLoaded: false, _apps: [] };
  const h = panelsSandbox({ home });
  h.HP.render();
  assert.equal(h.painted(), false, 'neither read in: the skeletons stay');
  h.HP._data = DATA;
  h.HP._answered = true;
  h.HP.render();
  assert.equal(h.painted(), false, 'the panels alone: Discover would draw from no apps and grow');
  home._appsLoaded = true;
  h.HP.render();
  assert.equal(h.painted(), true, 'both in: one paint');
  home._appsLoaded = false;
  h.HP.render();
  assert.equal(h.painted(), true, 'only the FIRST paint waits');

  const failedApps = panelsSandbox({ home: { _appsLoaded: false, _appsSettled: true, _apps: [] } });
  failedApps.HP._answered = true;
  failedApps.HP.render();
  assert.equal(failedApps.painted(), true, 'an apps read that failed does not hold the sections');

  const failedPanels = panelsSandbox({ home: { _appsLoaded: true, _apps: [] } });
  failedPanels.HP.render();
  assert.equal(failedPanels.painted(), false, 'the panels read has not answered');
  failedPanels.HP._answered = true;
  failedPanels.HP.render();
  assert.equal(failedPanels.painted(), true, 'it answered with nothing: the sections hide rather than wait');
  assert.equal(failedPanels.sandbox.panelsStore.get().challenges, null);

  const signedOut = panelsSandbox({ home: { _appsLoaded: false } });
  signedOut.sandbox.App.user = null;
  signedOut.HP.render();
  assert.equal(signedOut.painted(), true, 'signed out draws nothing, at once, as before');
});

test('the read marks itself answered after its art, and a failed apps read settles Home', () => {
  const ensure = /ensureLoaded\(opts\) \{([\s\S]*?)\n {2}\},/.exec(PANELS_RAW)[1];
  assert.match(ensure,
    /\.catch\(\(\) => \{\}\)\s*\.then\(\(\) => HomePanels\._warmArt\(\)\)\s*\.then\(\(\) => \{\s*HomePanels\._inflight = null;\s*HomePanels\._answered = true;\s*HomePanels\.render\(\);/);
  const load = /async _loadOnce\(\) \{([\s\S]*?)\n {2}\},/.exec(HOME_RAW)[1];
  assert.match(load, /catch \(err\) \{[\s\S]*?if \(!Home\._appsLoaded\) \{\s*Home\._appsSettled = true;\s*window\.HomePanels\?\.render\(\);\s*\}/);
});

// ── 2b. The sections while they wait ──────────────────────────────────

test('before the first paint each section holds a skeleton, and Challenges holds its heading\'s words', () => {
  const mod = loadTsx(SECTIONS);
  const challenges = renderToHtml(createElement(mod.ChallengesSectionView, { painted: false, discover: null, challenges: null }));
  assert.match(challenges, /^<section id="home-challenges-section" data-panel-slot="challenges" class="home-section-pending px-3 pb-3">/);
  assert.match(challenges, /<span class="invisible">Challenges<\/span>/,
    'the heading keeps its box, and no word that would change when the view lands');
  assert.equal((challenges.match(/h-\[104px\] rounded-3xl/g) || []).length, 3, 'three card skeletons');
  assert.match(challenges, /animate-pulse/, 'what the app\'s launch cover waits to see gone');

  // Discover's section went with Home's Discover lane (One Home, #6361).
  assert.equal(mod.DiscoverSectionView, undefined);

  const after = renderToHtml(createElement(mod.ChallengesSectionView, { painted: true, discover: null, challenges: null }));
  assert.match(after, /class="hidden px-3 pb-3"/, 'painted with nothing: hidden, as before');
  assert.doesNotMatch(after, /animate-pulse|home-section-pending/);
});

// ── 3. The tab bar's own last state ────────────────────────────────────

test('the viewer comes from the session snapshot, under App\'s own rules', () => {
  const hydrated = [];
  const apply = loadTsx(APPLY, { stubs: { '../features/workshop/community-scope': { hydrateCommunityScope: (v) => hydrated.push(v) } } });
  const named = [];
  const day = 24 * 60 * 60 * 1000;
  const page = (snapshot, classes = []) => {
    if (snapshot) snapshot.cacheScope ??= 'a'.repeat(64);
    globalThis.window = {
      localStorage: fakeStorage(snapshot === undefined ? {} : { 'usernode.session.v1': JSON.stringify(snapshot) }),
      UsernodeReact: { nav: { setViewer: (v) => named.push(v) } },
    };
    globalThis.document = { cookie: '__Host-usernode_api_scope=' + 'a'.repeat(64),
      documentElement: { classList: { contains: (c) => classes.includes(c) } } };
  };
  page({ user: { id: 7, username: ' evan ' }, savedAt: Date.now() - day });
  assert.equal(apply.snapshotViewer(), 'evan');
  apply.applyNavSnapshot();
  assert.deepEqual(named, ['evan'], 'through the same bridge call App._syncViewer makes');
  assert.deepEqual(hydrated, ['evan'], 'and the community list is read back for them');

  page({ user: { id: 7, username: 'evan' }, savedAt: Date.now(), cacheScope: 'b'.repeat(64) });
  assert.equal(apply.snapshotViewer(), null, 'a different browser session cannot restore their navigation');

  page({ user: { id: 7, username: 'evan' }, savedAt: Date.now() - 31 * day });
  assert.equal(apply.snapshotViewer(), null, 'past the 30 days App ages it out at');
  page({ user: { username: 'evan' }, savedAt: Date.now() });
  assert.equal(apply.snapshotViewer(), null, 'a user with no id is no session');
  page(undefined);
  assert.equal(apply.snapshotViewer(), null);
  named.length = 0; hydrated.length = 0;
  apply.applyNavSnapshot();
  assert.deepEqual(named, [], 'nobody to name');
  assert.deepEqual(hydrated, [null]);

  page({ user: { id: 7, username: 'evan' }, savedAt: Date.now() }, ['in-side-panel']);
  named.length = 0; hydrated.length = 0;
  apply.applyNavSnapshot();
  assert.deepEqual([named, hydrated], [[], []], 'the side panel\'s document has no tab bar');
});

test('the browser entry applies it in the same task as hydration, committed by flushSync', () => {
  const main = read('frontend', 'src', 'main.tsx');
  const hydrate = main.indexOf("bootStep('hydrate'");
  const nav = main.indexOf("bootStep('applyNavSnapshot', () => {\n  flushSync(applyNavSnapshot);\n});");
  assert.ok(hydrate !== -1 && nav > hydrate, 'after hydration matched the prerender, never before it');
});

test('the sidebar\'s communities come back from this device, for the same viewer only, without counts', async () => {
  const nav = loadTsx(NAV_STORE);
  const load = () => loadTsx(SCOPE, { stubs: { '../nav/nav-store.js': nav } });
  const storage = fakeStorage();
  globalThis.window = { localStorage: storage, location: { search: '' }, setTimeout, clearTimeout };
  const apps = [
    { slug: 'recipes', name: 'Recipe Box', icon_url: '/app-icons/aa', is_member: true, last_active_at: '2026-10-19T10:00:00Z' },
    { slug: 'chores', name: 'Chores', icon_emoji: '🧹', is_member: true, last_active_at: '2026-10-18T10:00:00Z' },
  ];
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).startsWith('/api/apps') ? { apps } : { counts: { recipes: { needs: 3, owed: ['proposal:1', 'proposal:2', 'proposal:3'] } } }),
  });
  nav.navStore.set({ viewer: 'evan' });
  const first = load();
  await first.loadCommunities(true);
  const kept = JSON.parse(storage.getItem('communityScopeList:v1'));
  assert.equal(kept.viewer, 'evan');
  assert.deepEqual(kept.list, ['recipes', 'chores']);
  assert.equal(kept.info.recipes.name, 'Recipe Box');
  assert.equal('owedCount' in kept.info.recipes || 'needs' in kept.info.recipes || 'owed' in kept.info.recipes, false,
    'the votes owed are not kept: a number is never shown before it is read');

  // A cold document: the tab bar's effect hydrates first, naming nobody;
  // the snapshot's viewer follows in the same task.
  const cold = load();
  cold.hydrateCommunityScope();
  assert.equal(cold.communityScopeStore.get().list, null, 'nobody named yet');
  cold.hydrateCommunityScope('evan');
  assert.deepEqual(cold.communityScopeStore.get().list, ['recipes', 'chores'], 'drawn from this device');
  assert.equal(cold.communityScopeStore.get().info.chores.iconEmoji, '🧹');
  assert.equal(cold.communityScopeStore.get().totalNeeds, null, 'and no count until one is read');

  const other = load();
  other.hydrateCommunityScope('someone-else');
  assert.equal(other.communityScopeStore.get().list, null, 'another account on this device sees none of it');
});

// ── 4. The challenge art ───────────────────────────────────────────────

test('the built-in art is precached, every file of it (tests/pwa-sw-classify.test.js classifies it)', () => {
  const sw = require(path.join(ROOT, 'public', 'sw.js'));
  const files = fs.readdirSync(path.join(ROOT, 'public', 'illustrations', 'challenges')).filter((f) => f.endsWith('.svg'));
  assert.ok(files.length > 0);
  for (const f of files) assert.ok(sw.SHELL_ASSETS.includes(`/illustrations/challenges/${f}`), `precached: ${f}`);
});

test('the tile is sized in its own attributes and decoded with the frame that draws it', () => {
  const card = read('frontend', 'src', 'features', 'leaderboard', 'challenge-card.tsx');
  const img = /<img\s+src=\{art\.src\}([\s\S]*?)\/>/.exec(card)[1];
  assert.match(img, /width=\{64\}/);
  assert.match(img, /height=\{64\}/);
  assert.match(img, /decoding="sync"/);
});

test('warmIllustrations decodes each resolved picture once, and never waits past its cap', async () => {
  const lib = loadTsx('frontend/src/lib/challenge-illustrations.ts');
  const made = [];
  let hang = false;
  globalThis.Image = class {
    constructor() { made.push(this); }
    decode() { return hang ? new Promise(() => {}) : Promise.resolve(); }
  };
  try {
    await lib.warmIllustrations([{ slug: 'try-three-apps' }, { slug: 'try-three-apps' }, { slug: 'no-such-art' }, { slug: `u-${'a'.repeat(32)}`, tone: 'pink' }]);
    assert.deepEqual(made.map((i) => i.src), ['/illustrations/challenges/try-three-apps.svg', `/challenge-illustrations/${'a'.repeat(32)}`],
      'one decode per picture that draws; a slug that draws nothing costs nothing');
    await lib.warmIllustrations([{ slug: 'try-three-apps' }]);
    assert.equal(made.length, 2, 'decoded once per document');
    hang = true;
    const t0 = Date.now();
    await lib.warmIllustrations([{ slug: 'useful-feedback' }], 30);
    assert.ok(Date.now() - t0 < 500, 'a picture that never decodes holds nothing past the cap');
  } finally {
    delete globalThis.Image;
  }
});

// ── Unfolding keeps Home's place (phone review, 23 Nov 2026, item 141) ──
// frontend/src/features/home/scroll-anchor.ts remembers the section at the
// top of the view and scrolls it back there after a width change, which
// WebKit (no overflow-anchor) did not do on the iPhone Duo.
const anchorMod = loadTsx('frontend/src/features/home/scroll-anchor.ts');
const part = (name, top, height) => ({ el: { name }, box: { top, bottom: top + height, height } });

test('the anchor is the first part still in view, with how far its top is from the view\'s', () => {
  const parts = [part('pinned', -900, 400), part('threads', -500, 450), part('challenges', -40, 160), part('featured', 140, 300)];
  const a = anchorMod.pickAnchor(parts, 0);
  assert.equal(a.el.name, 'challenges');
  assert.equal(a.offset, -40);
  // A part with no height (hidden) is passed over.
  assert.equal(anchorMod.pickAnchor([part('aside', 10, 0), part('featured', 20, 100)], 0).el.name, 'featured');
  assert.equal(anchorMod.pickAnchor([part('pinned', -500, 100)], 0), null, 'nothing below the top edge');
});

test('after a width change the anchor goes back where it stood, and an anchor already there moves nothing', () => {
  const anchor = { el: {}, offset: -40 };
  // Unfolded, the same scroll offset left the challenges 520px further up.
  assert.equal(anchorMod.anchorShift(anchor, -560, 0), -520);
  // The browser anchored it itself (Chromium): no second correction.
  assert.equal(anchorMod.anchorShift(anchor, -40, 0), 0);
  assert.equal(anchorMod.anchorShift(anchor, -40.4, 0), 0, 'less than a pixel is no move');
});

test('Home watches its scroller, and the sections it can anchor to are Home\'s own', () => {
  const index = fs.readFileSync(path.join(ROOT, 'frontend/src/features/home/index.tsx'), 'utf8');
  assert.match(index, /useEffect\(\(\) => keepHomeAnchor\(screenRef\.current,/);
  for (const sel of ['#home-apps-section', '#home-challenges-section', '[data-home-join-featured]']) {
    assert.ok(anchorMod.ANCHORS.includes(sel), sel);
  }
});
