'use strict';

// "Create an app" is the launcher grid's trailing TILE.
//
// The prototype's Home (nav-prototype.html, `scrHome`) ends Your apps with a
// dashed `.tile.create`, and the navigation spec retires the chip menu's
// Create entry into "Home's launcher grid and its Create tile". The product
// drew it as a fourth area instead: a full-width card in a section of its own,
// below Discover and Challenges. This moved it into the grid, and these are
// the properties the move has to keep:
//
//   1. It is the grid's LAST child and sits in the cell straight after the
//      last tile — collapsed, and after "Show all N apps". A collapsed grid it
//      would add a row to holds it behind "Show all N apps" instead (#3047).
//   2. It is not a layout item: nothing stores, drags or displaces it.
//   3. Hydration: it is absent from the initial store state and so from the
//      prerender, exactly like every other data-placed child of #app-list.
//   4. It is on every home screen: quota decides its treatment, never its
//      presence, and both states open the same create flow.
//   5. The section it replaced is gone, and the declared checks follow it.
//
// Run with: node --test tests/home-create-tile.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { HOME_SRC, PANELS_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { installGridStore, installPanelsStore, INITIAL_GRID } = require('./helpers/home-grid-store');
const { installAppCard } = require('./helpers/app-card');
const { tokenize } = require('./helpers/html-tokens');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const GRID = 'frontend/src/features/home/app-grid.tsx';
const TILE = 'frontend/src/features/home/create-tile.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const CARD = {
  slug: 'demo-app',
  name: 'Demo App',
  status: 'running',
  icon: { kind: 'letter', letter: 'D' },
  locked: false,
  demo: false,
  statusLabel: '',
  isAwaiting: false,
  isError: false,
  clickable: true,
  failureReason: null,
  showRetry: false,
  forkName: null,
};

// AppGrid at an arbitrary model — the same store stub tests/home-empty-apps
// .test.js hands `loadTsx`: `useStoreState` needs only `get` and `subscribe`.
function renderGrid(patch) {
  const state = { ...INITIAL_GRID, ...patch };
  const gridStore = { get: () => state, subscribe: () => () => {} };
  const { AppGrid } = loadTsx(GRID, { stubs: { './grid-store': { gridStore } } });
  return renderToHtml(createElement(AppGrid, {}));
}

// The element children of the first element carrying `id`, in order.
function childrenOf(html, id) {
  const tokens = tokenize(html);
  const out = [];
  let depth = -1;
  for (const t of tokens) {
    if (t.kind === 'open') {
      const attrs = Object.fromEntries(t.attrs.map((a) => [a.name, a.value]));
      if (depth === -1) {
        if (attrs.id === id) depth = 0;
        continue;
      }
      if (depth === 0) out.push({ tag: t.tag, attrs });
      if (!t.selfClosing && !['img', 'input', 'br'].includes(t.tag)) depth += 1;
    } else if (t.kind === 'close' && depth >= 0) {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  return out;
}

const CREATE = { enabled: true, hint: 'View your app allowance or request more slots.', placement: null };

// ── 1. the grid's last child ──────────────────────────────────────────

test('the tile is #app-list\'s LAST child, after every app tile', () => {
  const items = ['a', 'b', 'c'].map((slug, col) => ({
    kind: 'card', placement: { col, row: 0, w: 1, h: 1 }, app: { ...CARD, slug, name: slug },
  }));
  const html = renderGrid({
    ready: true, items, create: { ...CREATE, placement: { col: 3, row: 0, w: 1, h: 1 } },
  });
  const kids = childrenOf(html, 'app-list');
  assert.deepEqual(kids.map((k) => k.attrs['data-slug'] || k.attrs.id),
    ['a', 'b', 'c', 'home-create-tile']);
  const tile = kids[kids.length - 1];
  assert.equal(tile.tag, 'button');
  assert.equal(tile.attrs['data-panel-slot'], 'create');
  assert.equal(tile.attrs['data-create-enabled'], 'true');
  assert.match(tile.attrs.class, /\bhome-create-tile\b/);
  assert.match(tile.attrs.class, /\bhome-create-btn\b/, 'the focus-ring hook app.css keys');
});

test('with no apps it follows the "No apps added yet" note', () => {
  const html = renderGrid({ ready: true, create: CREATE });
  const kids = childrenOf(html, 'app-list');
  assert.equal(kids.length, 2);
  assert.equal(kids[0].attrs['data-home-apps-empty'], '');
  assert.equal(kids[1].attrs.id, 'home-create-tile');
});

// ── 3. hydration ──────────────────────────────────────────────────────

test('the initial state draws no tile, and neither does the prerender', () => {
  assert.equal(INITIAL_GRID.create, null);
  const html = renderGrid({});
  assert.doesNotMatch(html, /home-create-tile/,
    'a tile before the first Home.render() would be a child the prerendered #app-list lacks');
  assert.match(html, /Loading your apps/, 'it is still the skeleton at this point');
  const index = read('public/index.html');
  assert.doesNotMatch(index, /id="home-create-tile"/);
  assert.doesNotMatch(index, /data-panel-slot="create"/);
});

test('a load notice and the search view carry no tile', () => {
  assert.doesNotMatch(renderGrid({ ready: true, notice: { text: 'x', tone: 'error' } }), /home-create-tile/);
  assert.doesNotMatch(renderGrid({ ready: true, view: 'search', emptyQuery: 'zzz' }), /home-create-tile/);
  // Both load() failure publishes clear it — the store MERGES, so a notice
  // painted over a grid that had a tile would otherwise keep it.
  const load = HOME_SRC.slice(HOME_SRC.indexOf('  async load() {'), HOME_SRC.indexOf('  render() {'));
  assert.equal((load.match(/emptyQuery: null, create: null,/g) || []).length, 2);
});

// ── Home.render(): where the tile goes ────────────────────────────────

function makeHome({ search = '', canCreateApps = true } = {}) {
  const sandbox = {
    console,
    App: { user: { id: 1, canCreateApps }, _isScreenVisible: () => true },
    PlatformUI: { toast: () => {} },
    document: {
      createElement: () => ({ style: {}, textContent: '', innerHTML: '' }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    location: { search, origin: 'https://sv.test' },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  installAppCard(sandbox);
  const gridStore = installGridStore(sandbox);
  installPanelsStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n;globalThis.HomeLayout = HomeLayout;`, sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.HomePanels = HomePanels;`, sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  // Cross-realm: the store lives in the vm context, so round-trip through JSON.
  const model = () => JSON.parse(JSON.stringify(gridStore.get()));
  const moreCount = () => sandbox.chromeStore.get().moreCount;
  return { Home: sandbox.__Home, model, moreCount };
}

const mine = (n) => Array.from({ length: n }, (_, i) => ({
  slug: `app-${i}`, name: `App ${i}`, status: 'running',
  is_favorited: true, favorite_order: i, is_collaborator: false,
}));

test('Home.render() puts the tile in the cell straight after the last tile', () => {
  const { Home, model } = makeHome();
  Home._apps = mine(3);
  Home.render();
  assert.deepEqual(model().create.placement, { col: 3, row: 0, w: 1, h: 1 }, 'beside a short row');
  Home._apps = mine(4);
  Home.render();
  assert.deepEqual(model().create.placement, { col: 0, row: 1, w: 1, h: 1 }, 'a full row wraps it');
});

test('a hole the viewer left stays a hole: the tile follows the LAST tile', () => {
  const { Home, model } = makeHome();
  Home._apps = mine(2);
  Home._layouts = { 4: [
    { type: 'app', slug: 'app-0', col: 0, row: 0 },
    { type: 'app', slug: 'app-1', col: 1, row: 2 },
  ] };
  Home.render();
  const state = model();
  assert.deepEqual(state.create.placement, { col: 2, row: 2, w: 1, h: 1 });
  assert.ok(state.items.every((it) => it.placement.row !== 2 || it.placement.col !== 2),
    'and no app shares its cell');
});

test('it survives "Show all N apps": last in the collapsed grid and the expanded one', () => {
  const { Home, model } = makeHome();
  // Rows 0-1 full, two apps on row 2 and one on row 3.
  Home._apps = mine(11);
  Home._layouts = { 4: [
    ...Array.from({ length: 10 }, (_, i) => ({ type: 'app', slug: `app-${i}`, col: i % 4, row: Math.floor(i / 4) })),
    { type: 'app', slug: 'app-10', col: 0, row: 3 },
  ] };
  Home.visibleRowBudget = () => 3;
  Home.render();
  let state = model();
  // Budget 3 → rows 0-2 shown; row 2 has room, so the tile fits beside its
  // two apps while row 3 is behind the button.
  assert.equal(state.items.length, 10, 'three rows of apps shown, row 3 held back');
  assert.deepEqual(state.create.placement, { col: 2, row: 2, w: 1, h: 1 },
    'the tile ends the collapsed grid');
  // "Show all 11 apps" — the same flag the button sets.
  Home._appsExpanded = true;
  Home.render();
  state = model();
  assert.equal(state.items.length, 11);
  assert.deepEqual(state.create.placement, { col: 1, row: 3, w: 1, h: 1 },
    'and moves to the end of the expanded grid');
});

test('#3047: the tile goes behind "Show all" when it would add a row past 2 rows / 8 apps', () => {
  const { Home, model, moreCount } = makeHome();
  Home.visibleRowBudget = () => 2;

  // Seven apps: the tile fits in the eighth cell, no expander.
  Home._apps = mine(7);
  Home.render();
  let state = model();
  assert.deepEqual(state.create.placement, { col: 3, row: 1, w: 1, h: 1 });
  assert.equal(moreCount(), 0, 'nothing to show more of');

  // Eight apps fill both rows: the tile would start a third row, so it is
  // held back — and the grid still shows all eight apps.
  Home._apps = mine(8);
  Home.render();
  state = model();
  assert.equal(state.items.length, 8, 'every app still shown');
  assert.equal(state.create, null, 'the tile is behind "Show all"');
  assert.ok(state.items.every((it) => it.placement.row <= 1), 'two rows, nothing more');
  assert.equal(moreCount(), 8, 'the expander appears for the tile alone, naming every app');

  // Seventeen apps: two rows of apps, no third row for the tile.
  Home._apps = mine(17);
  Home.render();
  state = model();
  assert.equal(state.items.length, 8);
  assert.equal(state.create, null);

  // A taller budget holds it back the same way, trading no apps for it.
  Home._apps = mine(16);
  Home.visibleRowBudget = () => 4;
  Home.render();
  state = model();
  assert.equal(state.items.length, 16, 'four full rows of apps, not three');
  assert.equal(state.create, null);

  // "Show all" brings it back, ending the expanded grid.
  Home._appsExpanded = true;
  Home.render();
  state = model();
  assert.deepEqual(state.create.placement, { col: 0, row: 4, w: 1, h: 1 });
  assert.equal(moreCount(), 0, 'expanded: the expander goes away');
});

test('#3047: the expander appears for the tile alone, naming every app', () => {
  const HOME = HOME_SRC;
  assert.match(HOME, /const createHidden = !Home\._appsExpanded\s*&& HomeLayout\.createTileCollapsed\(shown, cols, rowBound\);/);
  assert.match(HOME, /const collapsed = hiddenRows \|\| createHidden;/);
  assert.match(HOME, /moreCount = collapsed \? \(canvas\.length \+ HomeLayout\.overflowItems\(layout\)\.length\) : 0;/);
  assert.match(HOME, /create = createHidden \? null : \{/);
  // The shot links that pin the tile's treatments open the grid, so the tile
  // they exist to show is on screen whatever the viewport's budget.
  assert.match(HOME, /shot === 'home-apps' \|\| shot === 'create-enabled' \|\| shot === 'create-disabled'/);
});

test('no apps, or tiles in the overflow, and the tile flows after them', () => {
  const { Home, model } = makeHome();
  Home._apps = [];
  Home.render();
  assert.equal(model().create.placement, null, 'after the empty note, in flow');

  // 33 apps: the canvas holds 32 cells, and the 33rd renders in the overflow
  // region with no cell of its own — so the tile flows after it.
  Home._apps = mine(33);
  Home._appsExpanded = true;
  Home.render();
  const state = model();
  assert.ok(state.items.some((it) => it.placement === null), 'one tile is in the overflow');
  assert.equal(state.create.placement, null);
});

test('a search turns the tile off; clearing it brings the tile back', () => {
  const { Home, model } = makeHome();
  Home._apps = mine(3);
  Home._query = 'App 1';
  Home.render();
  assert.equal(model().view, 'search');
  assert.equal(model().create, null);
  Home._query = '';
  Home.render();
  assert.ok(model().create);
});

// ── 4. every account ──────────────────────────────────────────────────

test('quota decides the treatment, never the presence', () => {
  for (const [search, enabled] of [['?shot=create-enabled', true], ['?shot=create-disabled', false]]) {
    const { Home, model } = makeHome({ search, canCreateApps: !enabled });
    Home._apps = mine(2);
    Home.render();
    const { create } = model();
    assert.ok(create, `${search}: the tile is there`);
    assert.equal(create.enabled, enabled, `${search}: the ?shot= link pins the treatment`);
    assert.equal(create.hint, 'View your app allowance or request more slots.');
  }
  // And off the account itself.
  const { Home, model } = makeHome({ canCreateApps: false });
  Home._apps = mine(1);
  Home.render();
  assert.equal(model().create.enabled, false);
});

test('the tile draws both states, and never the disabled attribute', () => {
  const { CreateTile } = loadTsx(TILE);
  const on = renderToHtml(createElement(CreateTile, { view: { ...CREATE, enabled: true } }));
  assert.match(on, /id="home-create-tile"/);
  assert.match(on, />Create an app</, 'the prototype\'s label');
  assert.match(on, /data-create-enabled="true"/);
  assert.match(on, /title="Create a new app"/);
  assert.doesNotMatch(on, /aria-label=/, 'its name is its visible label');

  const off = renderToHtml(createElement(CreateTile, { view: { ...CREATE, enabled: false } }));
  assert.match(off, /data-create-enabled="false"/);
  assert.match(off, /aria-label="Create an app\. View app quota\. View your app allowance or request more slots\."/,
    'the locked name starts with the visible label, then says what a tap does');
  // NOT the disabled ATTRIBUTE: that would swallow the tap that opens the
  // dialog with the quota in it.
  assert.doesNotMatch(off, /<button[^>]*\sdisabled/);
  assert.doesNotMatch(off, /aria-disabled/);
  // The accent arrives on hover only while creation is open.
  assert.match(on, /group-hover:border-violet-500/);
  assert.doesNotMatch(off, /violet/);
});

test('both states open the same create flow', () => {
  const src = read(TILE);
  // The handler's CODE, its comment lines dropped (they explain the toast it
  // deliberately does not show).
  const click = src.slice(src.indexOf('onClick={() =>'), src.indexOf('}}', src.indexOf('onClick={() =>')))
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(click, /win\(\)\.App\?\.showCreateModal\?\.\(\);/);
  assert.doesNotMatch(click, /PlatformUI|toast/,
    'a generic toast would hide the exact quota at the moment it matters');
});

// ── 2. not a layout item ──────────────────────────────────────────────

test('it cannot be dragged, rearranged or stored', () => {
  const { CreateTile } = loadTsx(TILE);
  const html = renderToHtml(createElement(CreateTile, { view: CREATE }));
  // The kit's placement recognizer and App._tileFor both select `.app-card`;
  // the tile answers neither.
  assert.doesNotMatch(html, /\bapp-card\b(?!-title)/);
  assert.doesNotMatch(html, /data-yours|data-slug|aria-haspopup/);
  assert.match(HOME_SRC, /itemSelector: '\.app-card\[data-yours\]:not\(\[data-demo\]\)'/);
  // Nothing about it reaches the layout model or its persistence.
  assert.doesNotMatch(LAYOUT_SRC.slice(LAYOUT_SRC.indexOf('  toWire(layout) {')), /create/i);
  // While something is lifted it stays out of the hit-test (the overlay cell
  // under it is a target) and steps back visually.
  const css = read('public/css/app.css');
  assert.match(css, /#app-list > \.home-create-tile \{\n  position: relative;\n  z-index: 1;\n  align-self: start;\n\}/);
  assert.match(css, /#app-list\.un-reordering > \.home-create-tile \{\n  pointer-events: none;\n  opacity: 0\.4;\n\}/);
});

test('its cell is written as an attribute, like the app tiles\'', () => {
  const src = read(TILE);
  assert.match(src, /el\.setAttribute\('style', style\)/);
  assert.doesNotMatch(src, /style=\{style\}/,
    'the style prop would fold grid-column + grid-row into a grid-area shorthand');
  // …from the same template the tiles use, handed down by AppGrid.
  const grid = read(GRID);
  assert.match(grid, /<CreateTile view=\{state\.create\} style=\{placementStyle\(state\.create\.placement\)\} \/>/);
  assert.ok(grid.indexOf('<CreateTile') > grid.indexOf('state.items.map('),
    'rendered after the app tiles, so it is the last child');
});

// ── 5. the section is gone, and the checks follow the tile ─────────────

test('the Create section is retired everywhere it was mounted', () => {
  assert.doesNotMatch(read('frontend/src/features/home/index.tsx'), /<CreateSection \/>/);
  assert.doesNotMatch(read('frontend/src/features/home/panels/sections.tsx'), /CreateSection|home-create-section"/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'frontend/src/features/home/panels/create.tsx')), false);
  assert.doesNotMatch(read('public/index.html'), /id="home-create-section"/);
  assert.doesNotMatch(read('scripts/audit-react-ownership.mjs'), /sel: '#home-create-section'/);
});

test('the declared Create checks select the grid\'s last child', () => {
  const declared = JSON.parse(read('dapp.json')).tests || [];
  const creates = declared.filter((t) => /data-panel-slot=\\?"create\\?"|data-panel-slot="create"/.test(t.expectSelector || ''));
  assert.equal(creates.length, 2, 'the enabled and the locked treatment');
  for (const t of creates) {
    assert.match(t.expectSelector, /#app-list > #home-create-tile\.home-create-btn\[data-panel-slot="create"\]\[data-create-enabled="(true|false)"\]:last-child/);
    assert.match(t.name, /re-pointed/i, 'a re-pointed check says so in its name');
    assert.equal(t.expectText, 'Create an app');
  }
  const paths = creates.map((t) => t.path).sort();
  assert.deepEqual(paths, ['/?demo=1&shot=create-disabled', '/?demo=1&shot=create-enabled']);
  // No check still anchors on the retired section (a :not(:has()) guard that
  // says it is gone is the one allowed mention).
  for (const t of declared) {
    const sel = (t.expectSelector || '').replace(/:not\(:has\(#home-create-section\)\)/g, '');
    assert.doesNotMatch(sel, /home-create-section/, t.name);
  }
});
