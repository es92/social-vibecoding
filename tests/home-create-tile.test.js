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
//      would add a row to holds it behind "Show all N apps" instead (#3047),
//      where a compact New project entry on the My apps heading stands in for
//      it (#4757, moved there by #5825): same label, same tooltip, same
//      dialog, never two at once.
//   2. It is not a layout item: nothing stores, drags or displaces it.
//   3. Hydration: it is absent from the initial store state and so from the
//      prerender, exactly like every other data-placed child of #app-list.
//   4. It is on every home screen: quota decides its treatment, never its
//      presence, and both states open the same create flow.
//   5. The section it replaced is gone, and the declared checks follow it.
//
// ONE HOME (#6361) took this tile off the grid and left making a project to
// Pinned communities' New community tile; #6522 brought it back, so the
// properties above hold again. The New community tile left Home with Pinned
// communities: it is the last tile of Joined on the Communities tab's page
// (frontend/src/features/communities/index.tsx).
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
const { englishPlatformI18n } = require('./lib/platform-i18n');

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

test('with no apps it is all the grid shows (no "No apps added yet" line)', () => {
  const html = renderGrid({ ready: true, create: CREATE });
  const kids = childrenOf(html, 'app-list');
  assert.equal(kids.length, 1);
  assert.equal(kids[0].attrs.id, 'home-create-tile');
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
  // load() is the single-flight gate; the load itself is _loadOnce().
  const load = HOME_SRC.slice(HOME_SRC.indexOf('  async _loadOnce() {'), HOME_SRC.indexOf('  render() {'));
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
  sandbox.PlatformI18n = englishPlatformI18n();
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
  return { Home: sandbox.__Home, model, moreCount, sandbox };
}

const mine = (n) => Array.from({ length: n }, (_, i) => ({
  slug: `app-${i}`, name: `App ${i}`, status: 'running',
  is_favorited: true, favorite_order: i, is_collaborator: false,
}));

test('#3047: the expander appears for the tile alone, naming every app', () => {
  const HOME = HOME_SRC;
  // #4669 added the `!editing` half: edit mode shows every tile and its
  // trailing tile, so the collapsed-grid gates step aside while it holds.
  // 17 Nov 2026: a collapsed grid whose last shown row is full no longer
  // holds the tile back. The tile takes that row's last cell and the app in
  // it goes behind the expander (the render tests below).
  assert.match(HOME, /const createTakesLast = !inCard && !editing && !Home\._appsExpanded\s*&& HomeLayout\.createTileCollapsed\(shown, cols, rowBound\);/);
  assert.match(HOME, /const collapsed = hiddenRows \|\| createTakesLast;/);
  assert.match(HOME, /moreCount = collapsed \? \(canvas\.length \+ HomeLayout\.overflowItems\(layout\)\.length\) : 0;/);
  // #4757: a held-back tile is no longer dropped — the view is pushed with
  // heldBack and no placement, and index.tsx's My apps heading draws the
  // compact entry (#5825; apps-more.tsx drew it before).
  assert.match(HOME, /create = \{/);
  assert.match(HOME, /heldBack: createHidden,/);
  assert.match(HOME, /placement: createCell\s*\? \{ \.\.\.createCell, w: 1, h: 1 \}\s*: createHidden \|\| flows/);
  // The shot links that pin the tile's treatments open the grid, so the tile
  // they exist to show is on screen whatever the viewport's budget.
  assert.match(HOME, /shot === 'home-apps' \|\| shot === 'create-enabled' \|\| shot === 'create-disabled'/);
});

// ── #4757/#5825: the compact entry rides the My apps heading ──────────

const MORE = 'frontend/src/features/home/apps-more.tsx';
const HOME_INDEX = 'frontend/src/features/home/index.tsx';

test('a held-back view draws no tile in the grid', () => {
  const items = ['a', 'b', 'c', 'd'].map((slug, col) => ({
    kind: 'card', placement: { col, row: 0, w: 1, h: 1 }, app: { ...CARD, slug, name: slug },
  }));
  const held = renderGrid({
    ready: true, items, create: { ...CREATE, heldBack: true },
  });
  assert.doesNotMatch(held, /home-create-tile/,
    'the compact entry on the My apps heading is the only New project control');
  const shown = renderGrid({
    ready: true, items,
    create: { ...CREATE, heldBack: false, placement: { col: 0, row: 1, w: 1, h: 1 } },
  });
  assert.match(shown, /id="home-create-tile"/, 'the tile still ends the grid when it fits');
});

// CreateCompact is a function component with hooks, so calling it for its
// tree needs a render — the same probe home-chrome-hosts.test.js uses. The
// walk descends THROUGH function components by calling them, and must run
// inside that render because the entry reads the i18n context.
function compactButton(view) {
  const { CreateCompact } = loadTsx(TILE);
  let hit = null;
  const walk = (node) => {
    if (hit || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props && node.props.id === 'home-create-tile') { hit = node; return; }
    walk(node.props && node.props.children);
    if (!hit && typeof node.type === 'function') walk(node.type(node.props));
  };
  const Probe = () => { walk(createElement(CreateCompact, { view })); return null; };
  renderToHtml(createElement(Probe));
  return hit;
}

function compactHtml(view) {
  const { CreateCompact } = loadTsx(TILE);
  return renderToHtml(createElement(CreateCompact, { view }));
}

test('the compact entry keeps its light-button treatment, label and ids', () => {
  const html = compactHtml({ ...CREATE, heldBack: true });
  const entry = html.match(/<button type="button" id="home-create-tile" class="([^"]*)"/);
  assert.ok(entry, 'the compact entry is a button carrying the Create id');
  assert.match(entry[1], /\bhome-create-btn\b/, 'the focus-ring hook app.css keys');
  assert.doesNotMatch(entry[1], /\bhome-create-tile\b/,
    'not a tile of the grid canvas: the drag-time #app-list rules do not apply');
  // #5654: a light button — white surface inside a hairline border, dark zinc
  // ink at rest, the blue accent on hover — with no dashed face.
  assert.doesNotMatch(entry[1], /\bbg-violet-600\b/, 'not a filled blue button');
  assert.doesNotMatch(entry[1], /\btext-white\b/, 'no white ink: dark zinc text on white');
  assert.match(entry[1], /\bbg-white\b/, 'the app\'s white surface');
  assert.match(entry[1], /\brounded-full\b/, 'fully rounded ends, as the screenshot draws it');
  assert.match(entry[1], /\bborder-zinc-200\b/, 'the hairline border');
  assert.match(entry[1], /\btext-zinc-800\b/, 'dark zinc ink at rest');
  assert.match(entry[1], /\bhover:text-violet-700\b/, 'the violet hover accent');
  assert.doesNotMatch(html, /border-dashed/, 'the compact entry drops the dashed face');
  assert.match(html, /data-panel-slot="create"/);
  assert.match(html, /data-create-enabled="true"/);
  assert.match(html, /title="Start a project: an app for you or for a community"/);
  assert.match(html, />New project</, 'the tile\'s own label');
  assert.doesNotMatch(html, /<button[^>]*\sdisabled/, 'never the disabled attribute');
});

test('the compact entry draws the locked treatment, and opens the same dialog', () => {
  const off = compactHtml({ ...CREATE, enabled: false, heldBack: true });
  const entry = off.match(/<button type="button" id="home-create-tile" class="([^"]*)"/);
  assert.ok(entry, 'the locked entry is still there');
  assert.doesNotMatch(entry[1], /violet/, 'locked ink, no accent — as the locked tile');
  assert.match(off, /data-create-enabled="false"/);
  assert.match(off, /aria-label="New project\. View app quota\. View your app allowance or request more slots\."/,
    'the locked name starts with the visible label, then says what a tap does');
  assert.doesNotMatch(off, /<button[^>]*\sdisabled/);

  // Executed coverage, the half a source grep cannot give: the tap opens the
  // dialog the tile opens, in both states.
  const calls = [];
  const prev = global.window;
  global.window = { App: { showCreateModal: () => { calls.push(1); } } };
  try {
    const btn = compactButton({ ...CREATE, heldBack: true });
    btn.props.onClick();
    assert.equal(calls.length, 1, 'the compact entry opens the same create dialog');
  } finally {
    if (prev === undefined) delete global.window; else global.window = prev;
  }
});

test('#5825: the My apps heading carries the compact entry exactly when the tile is held back', () => {
  const source = read(HOME_INDEX);
  // The non-editing branch of the heading's action: `heldBack` decides it,
  // and the button is the same component the grid draws as a tile.
  // #5871: it shares the seat with "Edit", which starts edit mode, so the
  // seat is drawn when either is due and each decides for itself.
  assert.match(source,
    /\) : \(canEdit \|\| grid\.create\?\.heldBack\) \? \(/,
    'the heading has an action when Edit or the held-back tile needs one');
  assert.match(source,
    /\{grid\.create\?\.heldBack \? <CreateCompact view=\{grid\.create\} \/> : null\}/,
    'the heading draws the compact entry when the grid holds its tile back');
  assert.match(source, /import \{ CreateCompact \} from '\.\/create-tile';/);
  // Edit mode keeps its own action, checked first — Add apps and Done, never
  // New project beside them.
  assert.match(source, /action=\{grid\.editing \? \(/);
});

test('#5825: the Show-all line is the expander alone, at the right end', () => {
  const { AppsMoreBody } = loadTsx(MORE);
  const html = renderToHtml(createElement(AppsMoreBody, { moreCount: 93 }));
  assert.match(html, /Show all 93 apps/, 'the expander keeps its words');
  assert.match(html, /class="flex items-center justify-end"/,
    'the line ends at the grid\'s right edge, where New project was');
  assert.doesNotMatch(html, /home-create-tile/, 'and carries no compact entry any more');
  const showAll = html.match(/<button type="button" id="home-apps-more-btn" class="([^"]*)"/);
  assert.ok(showAll, 'Show all is still a button');
  assert.match(showAll[1], /\btext-end\b/, 'aligned to the end in its line');
  assert.doesNotMatch(showAll[1], /\btext-left\b/);
  assert.doesNotMatch(showAll[1], /\bflex-1\b/, 'no longer centred in the space left over');
});

test('without a held-back tile, or with a count, the line is the expander alone', () => {
  const { AppsMoreBody } = loadTsx(MORE);
  const html = renderToHtml(createElement(AppsMoreBody, { moreCount: 9 }));
  assert.match(html, /id="home-apps-more-btn"[^>]*class="text-end /,
    'alone on its line, Show all reads to the right');
  assert.doesNotMatch(html, /w-full/, 'no longer stretched across the line');
  assert.doesNotMatch(html, /home-create-tile/, 'and no compact entry beside it');
  assert.doesNotMatch(html, /flex-1/);
  // The zero count is still the hidden, empty host.
  assert.equal(
    renderToHtml(createElement(AppsMoreBody, { moreCount: 0 })),
    '<div id="home-apps-more" class="hidden px-2 pb-1 sm:px-3"></div>',
  );
});

// 17 Nov 2026: where Home is one column the collapsed grid ENDS with the
// tile; beside the New project card (from 1280px) the grid draws none.
test('a full last row gives its last cell to the tile, and that app waits behind Show all', () => {
  const { Home, model, moreCount } = makeHome();
  Home._apps = mine(12); // three full rows: the least Home shows
  Home.render();
  const state = model();
  assert.equal(Home.MIN_ROWS, 3);
  assert.equal(state.items.length, 11, 'three rows of four cells: eleven apps and the tile');
  assert.equal(state.items.some((it) => it.app.slug === 'app-11'), false, 'the last cell\'s app is held back');
  assert.deepEqual(state.create.placement, { col: 3, row: 2, w: 1, h: 1 });
  assert.equal(state.create.heldBack, false, 'no compact entry stands in for it');
  assert.equal(moreCount(), 12, 'the expander names every app');

  Home._appsExpanded = true;
  Home.render();
  const open = model();
  assert.equal(open.items.length, 12, 'expanded, every app is back in its own cell');
  assert.deepEqual(open.create.placement, { col: 0, row: 3, w: 1, h: 1 }, 'and the tile follows the last one');
});

test('beside the New project card the grid draws no tile and gives up no cell', () => {
  const { Home, model, moreCount, sandbox } = makeHome();
  sandbox.matchMedia = (q) => ({ matches: q === '(min-width: 1280px)' });
  Home._apps = mine(12);
  // The column is Standard (WIP)'s: Standard keeps the tile at every width.
  Home.render();
  assert.equal(model().create.inCard, false, 'no card under Standard');
  sandbox.Skin = { get: () => 'wip' };
  Home.render();
  const state = model();
  assert.equal(state.create.inCard, true);
  assert.equal(state.items.length, 12, 'four apps to the last row');
  assert.equal(moreCount(), 0, 'nothing is held back');
  assert.doesNotMatch(
    renderGrid({ ready: true, items: [], create: { ...CREATE, heldBack: false, inCard: true, placement: null } }),
    /home-create-tile/,
  );

  // The shot links the declared Create checks open keep the tile.
  const shot = makeHome({ search: '?demo=1&shot=create-enabled' });
  shot.sandbox.matchMedia = () => ({ matches: true });
  shot.Home._apps = mine(2);
  shot.Home.render();
  assert.equal(shot.model().create.inCard, false);

  // A frame look draws its own Home, with the tile, at every width.
  const framed = makeHome();
  framed.sandbox.matchMedia = () => ({ matches: true });
  framed.sandbox.Skin = { get: () => 'glass' };
  framed.Home._apps = mine(12);
  framed.Home.render();
  assert.equal(framed.model().create.inCard, false);
  assert.deepEqual(framed.model().create.placement, { col: 3, row: 2, w: 1, h: 1 });
});

// #6522: Home.render() hands the grid its Create view again, and the three
// cases that decide whether it is there at all.
test('#6522: a normal account\'s render yields the Create view, search and private members none', () => {
  const { Home, model } = makeHome();
  Home._apps = mine(2);
  Home.render();
  const create = model().create;
  assert.ok(create && typeof create === 'object', 'a normal account gets the trailing New project tile');
  assert.equal(typeof create.enabled, 'boolean');
  assert.equal(create.heldBack, false, 'with two apps the tile fits its own cell');

  Home._query = 'App 1';
  Home.render();
  assert.equal(model().create, null, 'the search view is a flat list of matches: no create control');

  // A private member makes no apps until they are let in off the waitlist.
  const { Home: privateHome, model: privateModel, sandbox } = makeHome();
  sandbox.App.user.privateMember = true;
  privateHome._apps = mine(2);
  privateHome.render();
  assert.equal(privateModel().create, null, 'a private member gets no trailing tile');
});

test('the tile draws both states, and never the disabled attribute', () => {
  const { CreateTile } = loadTsx(TILE);
  const on = renderToHtml(createElement(CreateTile, { view: { ...CREATE, enabled: true } }));
  assert.match(on, /id="home-create-tile"/);
  assert.match(on, />New project</, 'the create dialog\'s own title (communities, stage 4)');
  assert.match(on, /data-create-enabled="true"/);
  assert.match(on, /title="Start a project: an app for you or for a community"/);
  assert.doesNotMatch(on, /aria-label=/, 'its name is its visible label');

  const off = renderToHtml(createElement(CreateTile, { view: { ...CREATE, enabled: false } }));
  assert.match(off, /data-create-enabled="false"/);
  assert.match(off, /aria-label="New project\. View app quota\. View your app allowance or request more slots\."/,
    'the locked name starts with the visible label, then says what a tap does');
  // NOT the disabled ATTRIBUTE: that would swallow the tap that opens the
  // dialog with the quota in it.
  assert.doesNotMatch(off, /<button[^>]*\sdisabled/);
  assert.doesNotMatch(off, /aria-disabled/);
  // The accent face (17 Nov 2026: a gradient app icon, no longer a dashed
  // slot) is drawn only while creation is open; the locked tile is the quiet
  // dashed outline.
  assert.match(on, /bg-gradient-to-br from-violet-400 to-violet-700 text-white/);
  assert.doesNotMatch(on, /border-dashed/);
  assert.match(off, /border-dashed/);
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
  // …from the same template the tiles use, handed down by AppGrid. #4669:
  // edit mode leaves the trailing tile alone — one CreateTile, in edit
  // mode as at rest; the mode's own entry is the heading's Add apps button.
  const grid = read(GRID);
  assert.match(grid, /<CreateTile view=\{state\.create\} style=\{placementStyle\(state\.create\.placement\)\} \/>/);
  assert.doesNotMatch(grid, /AddAppsTile/);
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

test('the declared Create checks select New project on Home and New community on the Communities page (#6522)', () => {
  const declared = JSON.parse(read('dapp.json')).tests || [];
  const creates = declared.filter((t) => /data-panel-slot=\\?"create\\?"|data-panel-slot="create"/.test(t.expectSelector || ''));
  assert.equal(creates.length, 3, 'New project enabled, New community locked, and the page\'s own check, which names the tile');
  // New project is the grid's own trailing tile, back on Pinned apps (#6522),
  // with no :not(:has()) guard asserting it gone. Home lists none of the
  // viewer's communities beside it: the section is hidden until a search.
  const project = creates.find((t) => t.path === '/?demo=1&shot=create-enabled');
  assert.ok(project, 'the enabled treatment is checked on Home');
  assert.match(project.expectSelector,
    /#home-apps-section:not\(\[hidden\]\) #home-create-tile\[data-panel-slot="create"\]\[data-create-enabled="true"\]/);
  assert.match(project.expectSelector, /#home-body:has\(#home-communities-section\[hidden\]\)/);
  assert.doesNotMatch(project.expectSelector, /:not\(:has\(#home-create-tile\)\)/);
  assert.equal(project.expectText, 'New project');
  // New community left Home with Pinned communities: it is the last tile of
  // Joined on the Communities tab's page (`#communities`), and the locked
  // treatment is checked there.
  const community = creates.find((t) => t.path === '/?demo=1&shot=create-disabled#communities');
  assert.ok(community, 'the locked treatment is checked on the Communities page');
  assert.match(community.expectSelector,
    /#communities-screen:not\(\.hidden\) #communities-joined-section:not\(\[hidden\]\) #communities-new-community\[data-panel-slot="create"\]\[data-create-enabled="false"\]/);
  assert.match(community.expectSelector, /:last-child/);
  assert.equal(community.expectText, 'New community');
  // The page's own check holds the tile in Joined too.
  const page = creates.find((t) => t.path === '/?demo=1#communities');
  assert.ok(page, 'the Communities page\'s check');
  assert.match(page.expectSelector, /:has\(#communities-joined-section #communities-new-community\[data-panel-slot="create"\]\)/);
  // No check selects the tile where it was, in Home's section.
  for (const t of declared) assert.doesNotMatch(t.expectSelector || '', /#home-new-community|#home-all-communities|#home-needs-tile/, t.name);
  // And the page draws it with the hook the checks select on.
  const src = read('frontend/src/features/communities/index.tsx');
  assert.match(src, /id="communities-new-community"[\s\S]{0,400}'data-panel-slot': 'create',\s*'data-create-enabled': String\(createOn\),/);
  // No check still anchors on the retired section (a :not(:has()) guard that
  // says it is gone is the one allowed mention).
  for (const t of declared) {
    const sel = (t.expectSelector || '').replace(/:not\(:has\(#home-create-section\)\)/g, '');
    assert.doesNotMatch(sel, /home-create-section/, t.name);
  }
});

// ── EDIT MODE (#4669): the trailing tile keeps its place ──────────────

test('while editing, the trailing tile is still the Create tile, as at rest', () => {
  const items = ['a', 'b'].map((slug, col) => ({
    kind: 'card', placement: { col, row: 0, w: 1, h: 1 }, app: { ...CARD, slug, name: slug },
  }));
  const html = renderGrid({
    ready: true, editing: true, items,
    create: { ...CREATE, placement: { col: 2, row: 0, w: 1, h: 1 } },
  });
  const kids = childrenOf(html, 'app-list');
  assert.deepEqual(kids.map((k) => k.attrs['data-slug'] || k.attrs.id),
    ['a', 'b', 'home-create-tile'],
    'the same last child as the resting grid, same id, no Add-apps tile');
  const tile = kids[kids.length - 1];
  assert.equal(tile.tag, 'button');
  assert.match(tile.attrs.class, /\bhome-create-tile\b/);
  assert.doesNotMatch(html, /home-add-apps-tile/,
    'the Add-apps entry is the heading button now, not a tile');
  assert.equal(tile.attrs['data-panel-slot'], 'create',
    'the declared checks still select the Create entry by this hook');
  assert.equal(tile.attrs['data-create-enabled'], 'true');
  assert.match(html, />New project</);
  // The grid itself is marked for the wiggle's CSS.
  assert.match(html, /data-editing="true"/);
});

test('not editing, the trailing tile is the Create tile as before', () => {
  const html = renderGrid({
    ready: true, items: [],
    create: { ...CREATE, placement: null },
  });
  assert.match(html, /id="home-create-tile"/);
  assert.doesNotMatch(html, /home-add-apps-tile/);
  assert.doesNotMatch(html, /data-editing=/, 'the attribute is absent, not "false"');
  // The initial store renders neither the tile nor an editing mark.
  assert.doesNotMatch(renderGrid({}), /home-create-tile|data-editing/);
});

test('#6372: the − and + corner discs sit above the tile\'s own hit area', () => {
  // TILE carries un-touch-target, whose ::after (native.css) covers the tile
  // and paints after its children. The discs live in the face's wrapper,
  // which the edit-mode wiggle (a transform) makes a stacking context, so the
  // lift must be on that wrapper: a z-index on a disc cannot leave it
  // (checked by hit-testing in Chromium when this was fixed).
  const src = read('frontend/src/features/home/pinned-communities.tsx');
  assert.match(src, /const TILE = '[^']*\bun-touch-target\b/);
  assert.match(read('public/usernode-native/v1/native.css'), /\.un-touch-target::after \{[^}]*position: absolute;/);
  const wrap = src.match(/const FACE_WRAP = '([^']*)'/);
  assert.ok(wrap, 'FACE_WRAP is one literal');
  assert.match(wrap[1], /\brelative\b/);
  assert.match(wrap[1], /\bz-\[1\]/, 'the wrapper is lifted above the ::after');
  assert.match(src, /<span className=\{editing \? `\$\{FACE_WRAP\} \$\{WIGGLE\}` : FACE_WRAP\}>/, 'both branches use it');
  assert.match(src, /className=\{`\$\{CORNER\} -start-1\.5 \$\{CORNER_UNPIN\}`\}/);
  assert.match(src, /className=\{`\$\{CORNER\} -end-1\.5 \$\{CORNER_PIN\}`\}/);
});
