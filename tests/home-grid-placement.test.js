// Home-screen FREE-FORM placement — the drag half of "put apps and widgets
// anywhere". Replaces tests/home-drag-add.test.js, which pinned the flow
// reorder model (canDropCard / classifyCardDrop / buildYoursOrder →
// PUT /api/favorites/order). That model is gone: it could only express an
// ordering, and an ordering cannot describe a grid with holes in it.
//
// What is pinned here:
//
//   1. The options Home hands the kit's attachGridPlacement — in particular
//      that the item selector matches EVERY widget host, including a create
//      widget rendered in its disabled state (lacking app quota must not
//      make the widget unmovable).
//   2. The lift/settle deferral contract: onLift holds _dragActive so a WS
//      app_status can't yank a tile from under the finger, and onSettle
//      flushes whatever was deferred — reload wins over re-render.
//   3. The drop → persist pipeline: a legal drop writes the whole width to
//      PUT /api/home-layout and NEVER to /api/favorites/order; an illegal
//      one writes nothing at all.
//   4. The failure revert: a rejected write refetches server truth rather
//      than leaving the grid showing an arrangement nobody saved.
//   5. Layout resolution: a stored arrangement wins and a DERIVATION is never
//      persisted, so a passive visit never becomes a claim.
//
// THE UI OVERHAUL narrowed the canvas to app tiles at ONE column count.
// Everything that used to be about widget footprints, per-breakpoint sizes or
// the 640px crossing went with it; the geometry that remains never cared what
// kind of item it was moving.
//
// home.js is a plain browser script (`const Home = {…}`); we load it into a
// vm context with stubbed globals — same harness as
// home-your-apps-partition.test.js — with home-layout.js loaded first,
// since Home lays out against it.
//
// Run with: node --test tests/home-grid-placement.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installAppCard } = require('./helpers/app-card');
const { installGridStore } = require('./helpers/home-grid-store');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { HOME_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { englishPlatformI18n } = require('./lib/platform-i18n');

// Returns { Home, HomeLayout, fetchCalls, toasts, setFetch, sandbox,
// attachCalls, setWidth, fireResize, fireMediaChange, mediaQueries }.
// attachCalls records every attachGridPlacement invocation; the viewport
// helpers drive the live-resize path (setWidth moves the reported
// innerWidth, then fireResize/fireMediaChange delivers the signal the
// browser would).
function makeHome({ width = 1280, canCreateApps = true } = {}) {
  const fetchCalls = [];
  const toasts = [];
  const attachCalls = [];
  const winListeners = Object.create(null);
  const mediaQueries = [];
  let fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  const sandbox = {
    console,
    App: { user: { id: 1, canCreateApps } },
    PlatformUI: { toast: (msg) => { toasts.push(String(msg)); } },
    innerWidth: width,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      elementFromPoint: () => null,
      createElement: () => {
        let t = '';
        return {
          style: {},
          classList: { add: () => {}, remove: () => {}, contains: () => false },
          set textContent(v) { t = String(v); },
          set innerHTML(v) { t = String(v); },
          get innerHTML() {
            return t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          },
          querySelector: () => null,
          querySelectorAll: () => [],
          appendChild: () => {},
        };
      },
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    unNative: {
      attachGridPlacement: (listEl, opts) => {
        attachCalls.push({ listEl, opts });
        return { detach: () => {} };
      },
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({
        url,
        method: opts.method || 'GET',
        body: opts.body ? JSON.parse(opts.body) : null,
      });
      return fetchImpl(url, opts);
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    location: { search: '', hash: '' },
    URLSearchParams,
    Date,
    addEventListener: (type, fn) => {
      (winListeners[type] || (winListeners[type] = [])).push(fn);
    },
    removeEventListener: () => {},
    // The breakpoint signal. Records every query the code subscribes to so
    // a test can assert it watched the right one, and lets a test deliver
    // a `change` the way a real browser would on a viewport crossing.
    matchMedia: (query) => {
      const entry = { query, handlers: [], get matches() { return false; } };
      entry.addEventListener = (type, fn) => {
        if (type === 'change') entry.handlers.push(fn);
      };
      entry.removeEventListener = () => {};
      mediaQueries.push(entry);
      return entry;
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  // home.js delegates iconTileFor / renderAppPillsHtml to window.AppCard
  // (frontend/src/features/apps/app-card.js) since #1083 chunk F.
  installAppCard(sandbox);
  // #1191: Home.render() publishes a view model instead of assigning
  // innerHTML. See ./helpers/home-grid-store.
  const gridStore = installGridStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  const Home = sandbox.__Home;
  const HomeLayout = sandbox.HomeLayout;
  // HomeLayout.setRegistry(REGISTRY) and a HomePanels stub carrying
  // gridSlotKeys()/hasLayoutRegistry() sat here: the widget footprints the
  // canvas placed against, and the "the authoritative registry has arrived"
  // gate that stopped a layout load beating /api/home-panels from persisting
  // a repair with every widget cell erased.
  //
  // THE UI OVERHAUL made Discover, Challenges and Create app fixed sections
  // below the grid, so the canvas holds nothing but 1x1 app tiles and nothing
  // on it waits for a second endpoint. HomePanels is stubbed only for the
  // render() call home.js makes to paint those sections.
  sandbox.HomePanels = {
    render: () => {},
    ensureLoaded: () => Promise.resolve(),
  };
  return {
    gridStore, Home, HomeLayout, fetchCalls, toasts, attachCalls, sandbox, mediaQueries,
    setFetch: (fn) => { fetchImpl = fn; },
    setWidth: (w) => { sandbox.innerWidth = w; },
    fireResize: () => { (winListeners.resize || []).forEach((fn) => fn()); },
    fireMediaChange: () => {
      mediaQueries.forEach((mq) => mq.handlers.forEach((fn) => fn(mq)));
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const app = (slug, over = {}) => ({
  slug, name: slug, status: 'running',
  is_collaborator: true, is_favorited: false, your_apps_hidden: false,
  favorite_order: null, featured: false, ...over,
});


// ── The attach contract ───────────────────────────────────────────────

test('Home wires the placement recognizer, not the flow reorder', () => {
  const { Home, attachCalls } = makeHome();
  Home._apps = [app('a')];
  Home._attachGridPlacement({ querySelectorAll: () => [] }, true);
  assert.equal(attachCalls.length, 1);
  const { opts } = attachCalls[0];
  assert.equal(typeof opts.cellFromPoint, 'function', 'the host owns the geometry');
  assert.equal(typeof opts.canPlace, 'function');
  assert.equal(typeof opts.onPlace, 'function');
  assert.equal(typeof opts.onHover, 'function', 'the host paints the target highlight');
});


// The search view is a flat, transient list with no layout to write.
test('the search view arms no placement recognizer', () => {
  const { Home, attachCalls } = makeHome();
  Home._apps = [app('a')];
  Home._attachGridPlacement({ querySelectorAll: () => [] }, false);
  assert.equal(attachCalls.length, 0);
});

// ── Lift / settle deferral ────────────────────────────────────────────

test('onLift holds _dragActive; onSettle clears it and flushes a reload', async () => {
  const { Home, attachCalls } = makeHome();
  Home._apps = [app('a')];
  Home._attachGridPlacement({ querySelectorAll: () => [], appendChild: () => {} }, true);
  const { opts } = attachCalls[0];

  let loaded = 0;
  Home.load = async () => { loaded += 1; };

  opts.onLift({ classList: { contains: () => false }, dataset: {} });
  assert.equal(Home._dragActive, true);

  // A WS event arriving mid-drag defers instead of replacing the grid.
  Home._reloadPending = true;
  opts.onSettle(true);
  assert.equal(Home._dragActive, false);
  await flush();
  assert.equal(loaded, 1, 'the deferred reload ran once the gesture ended');
  assert.equal(Home._reloadPending, false);
});

test('onSettle prefers a full reload over a cheap re-render', async () => {
  const { Home, attachCalls } = makeHome();
  Home._apps = [app('a')];
  Home._attachGridPlacement({ querySelectorAll: () => [] }, true);
  const { opts } = attachCalls[0];
  let loaded = 0;
  let rendered = 0;
  Home.load = async () => { loaded += 1; };
  Home.render = () => { rendered += 1; };

  Home._reloadPending = true;
  Home._rerenderPending = true;
  opts.onSettle(true);
  await flush();
  assert.equal(loaded, 1);
  assert.equal(rendered, 0, 'server truth supersedes the optimistic repaint');

  // Re-render alone when that is all that was deferred.
  Home._rerenderPending = true;
  opts.onSettle(true);
  await flush();
  assert.equal(rendered, 1);
});

// ── The drop → persist pipeline ───────────────────────────────────────

// A four-column arrangement with deliberate holes. It used to seed three
// WIDGETS alongside the tiles at five columns; THE UI OVERHAUL made those
// fixed sections below the grid, so the canvas is app tiles only and the
// column count is four everywhere.
function seedLayout(Home, cols = 4) {
  Home._apps = [app('a'), app('b'), app('c'), app('d')];
  Home._layouts = {
    4: [
      { type: 'app', slug: 'a', col: 0, row: 0 },
      { type: 'app', slug: 'b', col: 3, row: 0 },
      { type: 'app', slug: 'c', col: 0, row: 1 },
      { type: 'app', slug: 'd', col: 3, row: 2 },
    ],
  };
  Home._layoutFetchedAt = Date.now();
  Home._layoutCache = Home._layouts[String(cols)];
  return Home._layoutCache;
}

/** A dragged app tile, as the recognizer hands it to Home. */
const tileEl = (slug) => ({
  dataset: { slug },
  classList: { contains: () => false },
});

test('a legal drop writes the whole width to PUT /api/home-layout', async () => {
  const { Home, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};

  // Move app "a" from (0,0) to an empty cell at (2,0).
  Home._onGridPlace(tileEl('a'), { col: 2, row: 0 }, 4);
  await flush();

  const writes = fetchCalls.filter((c) => c.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/home-layout');
  assert.equal(writes[0].body.cols, 4);
  const moved = writes[0].body.items.find((i) => i.slug === 'a');
  assert.deepEqual([moved.col, moved.row], [2, 0]);
  // Everything else held still — holes are preserved, nothing re-packs.
  const other = writes[0].body.items.find((i) => i.slug === 'b');
  assert.deepEqual([other.col, other.row], [3, 0]);
  // The retired flow endpoint is never touched.
  assert.equal(fetchCalls.filter((c) => c.url === '/api/favorites/order').length, 0);
  assert.equal(Home._rerenderPending, true, 'the repaint is deferred to onSettle');
});

test('dropping a tile onto another swaps them', async () => {
  const { Home, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};

  Home._onGridPlace(tileEl('a'), { col: 3, row: 0 }, 4);
  await flush();

  const items = fetchCalls.find((c) => c.method === 'PUT').body.items;
  assert.deepEqual(
    [items.find((i) => i.slug === 'a').col, items.find((i) => i.slug === 'a').row], [3, 0]);
  assert.deepEqual(
    [items.find((i) => i.slug === 'b').col, items.find((i) => i.slug === 'b').row], [0, 0]);
});

// Dropping a widget onto cells another widget occupies DISPLACES it — the
// old rule refused this, which is what made a crowded grid unrearrangeable.
test('a drop onto an occupied cell displaces the occupant and persists', async () => {
  const { Home, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};

  // 'd' (3,2) onto the cell 'c' (0,1) holds.
  Home._onGridPlace(tileEl('d'), { col: 0, row: 1 }, 4);
  await flush();

  const writes = fetchCalls.filter((c) => c.method === 'PUT');
  assert.equal(writes.length, 1, 'the drop commits');
  const items = writes[0].body.items;
  const at = (slug) => {
    const it = items.find((i) => i.slug === slug);
    return [it.col, it.row];
  };
  assert.deepEqual(at('d'), [0, 1]);
  // Same footprint, so the occupant takes the vacated cell — a swap.
  assert.deepEqual(at('c'), [3, 2]);
  // The tiles nowhere near the target held still.
  assert.deepEqual(at('a'), [0, 0]);
  assert.deepEqual(at('b'), [3, 0]);
  assert.equal(items.length, 4, 'nothing is lost');
});

// The second reported bug: a 2x2 widget nudged one cell over overlaps its own
// footprint. The dragged item is excluded from the occupancy test, so this is
// an ordinary move rather than an impossible one.
test('a tile can be dropped back onto its own cell', async () => {
  // The dragged item's own footprint is excluded from the occupancy test, so
  // a release that has not moved is a legal drop rather than a refusal. It
  // mattered most for the multi-cell widgets this canvas used to carry (a 2x2
  // nudged one cell over overlaps itself), and the rule survives them.
  const { Home, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};

  Home._onGridPlace(tileEl('d'), { col: 3, row: 2 }, 4);
  await flush();

  const writes = fetchCalls.filter((c) => c.method === 'PUT');
  assert.equal(writes.length, 1, 'the self-overlapping drop commits');
  const d = writes[0].body.items.find((i) => i.slug === 'd');
  assert.deepEqual([d.col, d.row], [3, 2]);
});

// Only an item that isn't in the layout at all is refused now.
test('a drop of an unknown item persists nothing', async () => {
  const { Home, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};

  Home._onGridPlace({ dataset: { slug: 'not-in-the-layout' },
    classList: { contains: () => false } }, { col: 2, row: 2 }, 5);
  await flush();
  assert.equal(fetchCalls.filter((c) => c.method === 'PUT').length, 0);
});

// The overlay must tint an occupied target, or the grid lies about where a
// release will land. canPlace and place are the same decision.
test('canPlace accepts occupied targets and self-overlap', () => {
  const { Home, attachCalls } = makeHome();
  seedLayout(Home);
  Home._attachGridPlacement({ querySelectorAll: () => [], appendChild: () => {} }, true);
  const { opts } = attachCalls[0];
  const d = tileEl('d');

  assert.equal(opts.canPlace(d, { col: 0, row: 1 }), true, "occupied by 'c'");
  assert.equal(opts.canPlace(d, { col: 3, row: 2 }), true, 'its own cell');
  assert.equal(opts.canPlace(d, { col: 0, row: 0 }), true, "occupied by 'a'");
  assert.equal(opts.canPlace(d, { col: 2, row: 5 }), true, 'and an empty one');
});

// ── The live displacement preview ─────────────────────────────────────
//
// While an item hovers a target, the occupants that WOULD be pushed move to
// the cells they'd land in. The flow reorder this replaced gave that away for
// free; free placement has to show it deliberately, because only the items
// that actually collide move at all.

// A grid whose cells and items are real enough for the preview to measure.
// Each overlay cell reports a rect from its data-cell, so a translate delta
// is exactly (dcol * CELL_W, drow * CELL_H).
const CELL_W = 100;
const CELL_H = 120;

// THE ROW TABLE (#968). Rows are uniform CELL_H unless a test says otherwise:
// `setRowHeights([120, 60, 120, …])` installs a canvas with a short row in it,
// the way a phone with a fit row actually renders. Everything that resolves a
// row — the fake cell rects, the elementFromPoint stub, the assertions — reads
// this one table, so a test can't accidentally describe two different grids.
// No gap: tops are the running sum, which keeps the uniform case exactly the
// arithmetic every existing test in this file was written against.
let ROW_HEIGHTS = null;
function setRowHeights(heights) { ROW_HEIGHTS = heights ? heights.slice() : null; }
function rowHeight(row) {
  return ROW_HEIGHTS && ROW_HEIGHTS[row] != null ? ROW_HEIGHTS[row] : CELL_H;
}
function rowTop(row) {
  let top = 0;
  for (let r = 0; r < row; r++) top += rowHeight(r);
  return top;
}
// Which row contains this y, or -1 above/below the canvas.
function rowAt(y) {
  for (let r = 0; r < 8; r++) {
    const top = rowTop(r);
    if (y >= top && y < top + rowHeight(r)) return r;
  }
  return -1;
}
// Every test starts on the uniform canvas; a test that installs a table is
// responsible for nothing else.
test.beforeEach(() => { setRowHeights(null); });

function makeGridDom(items) {
  const cells = new Map();
  const nodes = new Map();
  const mk = (extra) => ({
    style: {},
    _cls: new Set(),
    classList: {
      add(...c) { c.forEach((x) => extra._cls.add(x)); },
      remove(...c) { c.forEach((x) => extra._cls.delete(x)); },
      contains: (c) => extra._cls.has(c),
    },
    ...extra,
  });
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row < 8; row++) {
      const cell = { dataset: { cell: `${col},${row}` }, _cls: new Set() };
      cell.classList = {
        add: (c) => cell._cls.add(c),
        remove: (c) => cell._cls.delete(c),
        contains: (c) => cell._cls.has(c),
      };
      // Rows read their geometry from the table so a NON-UNIFORM canvas can
      // be exercised (#968): a fit row is as tall as the widget in it, and
      // _targetCellFor now measures rows rather than assuming one pitch.
      // `height`/`bottom` are what it measures; the default table is the
      // uniform grid every other test in this file was written against.
      cell.getBoundingClientRect = () => {
        const top = rowTop(row);
        const height = rowHeight(row);
        return {
          left: col * CELL_W, top, height, bottom: top + height,
          width: CELL_W, right: col * CELL_W + CELL_W,
        };
      };
      cells.set(`${col},${row}`, cell);
    }
  }
  for (const it of items) {
    const node = { dataset: {}, style: {}, _cls: new Set() };
    node.classList = {
      add: (...c) => c.forEach((x) => node._cls.add(x)),
      remove: (...c) => c.forEach((x) => node._cls.delete(x)),
      contains: (c) => node._cls.has(c),
    };
    if (it.type === 'widget') {
      node.dataset.panelSlot = it.key;
      // _itemFor dispatches on this class, exactly as the real host carries it.
      node._cls.add('home-panel-slot');
    } else {
      node.dataset.slug = it.slug;
    }
    nodes.set(it.type === 'widget' ? `widget:${it.key}` : `app:${it.slug}`, node);
  }
  const overlay = {
    _cls: new Set(),
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    querySelector: (sel) => {
      const m = /\[data-cell="([^"]+)"\]/.exec(sel);
      return m ? (cells.get(m[1]) || null) : null;
    },
    querySelectorAll: (sel) => (sel === '.home-grid-cell--on'
      ? [...cells.values()].filter((c) => c._cls.has('home-grid-cell--on'))
      : []),
  };
  const listEl = {
    querySelector: (sel) => {
      let m = /\[data-panel-slot="([^"]+)"\]/.exec(sel);
      if (m) return nodes.get(`widget:${m[1]}`) || null;
      m = /\.app-card\[data-slug="([^"]+)"\]/.exec(sel);
      if (m) return nodes.get(`app:${m[1]}`) || null;
      return null;
    },
    querySelectorAll: () => [],
    appendChild: () => {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
  };
  overlay.parentNode = Object.assign(listEl, { removeChild: () => {} });
  return { overlay, listEl, nodes, cells, mk };
}

// Wire a Home with a known layout and a measurable overlay, then hover.
// `cols` picks the breakpoint the layout is stored at (5 = desktop, 4 = phone,
// where the big widgets go full-width).
function makePreview(layout, { cols = 5, width = cols === 4 ? 390 : 1280 } = {}) {
  const h = makeHome({ width });
  h.Home._layouts = cols === 4 ? { 4: layout, 5: [] } : { 5: layout, 4: [] };
  h.Home._layoutFetchedAt = Date.now();
  h.Home._layoutCache = layout;
  const dom = makeGridDom(layout);
  h.Home._overlayEl = dom.overlay;
  h.dom = dom;
  h.hover = (id, col, row) => {
    const el = dom.nodes.get(id);
    h.Home._previewDrop(el, { col, row }, true, 5);
  };
  h.transformOf = (id) => dom.nodes.get(id).style.transform || '';
  h.classesOf = (id) => [...dom.nodes.get(id)._cls].sort().join(' ');
  h.tinted = () => [...dom.cells.values()]
    .filter((c) => c._cls.has('home-grid-cell--on'))
    .map((c) => c.dataset.cell);
  return h;
}

test('hovering an occupied cell slides the occupant to where it would land', () => {
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 2, row: 0 },
    { type: 'app', slug: 'far', col: 4, row: 4 },
  ];
  const h = makePreview(layout);
  h.hover('app:a', 2, 0);

  // The target tints...
  assert.deepEqual(h.tinted(), ['2,0']);
  // ...and the occupant has actually MOVED to the cell it would land in —
  // a's vacated (0,0), two columns to the left of where b sits.
  assert.equal(h.transformOf('app:b'), `translate(${-2 * CELL_W}px, 0px)`);
  assert.match(h.classesOf('app:b'), /home-item-displaced/);
  // The dragged item is NOT transformed: the ghost under the finger and its
  // dashed origin slot already represent it.
  assert.equal(h.transformOf('app:a'), '');
  // An item the drop doesn't touch holds completely still.
  assert.equal(h.transformOf('app:far'), '');
  assert.equal(h.classesOf('app:far'), '');
});

test('the preview clears and restores when the hover moves', () => {
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 2, row: 0 },
    { type: 'app', slug: 'c', col: 3, row: 1 },
  ];
  const h = makePreview(layout);

  h.hover('app:a', 2, 0);
  assert.notEqual(h.transformOf('app:b'), '', 'b is previewed');

  // Hover a DIFFERENT occupied cell: b goes back, c takes over.
  h.hover('app:a', 3, 1);
  assert.equal(h.transformOf('app:b'), '', 'b is restored');
  assert.equal(h.classesOf('app:b'), '');
  assert.notEqual(h.transformOf('app:c'), '', 'c is now previewed');

  // Hover an EMPTY cell: nothing is displaced at all.
  h.hover('app:a', 4, 4);
  assert.equal(h.transformOf('app:c'), '');
  assert.deepEqual(h.tinted(), ['4,4']);

  // Leaving the grid clears the tint and every transform.
  h.Home._previewDrop(h.dom.nodes.get('app:a'), null, false, 5);
  assert.deepEqual(h.tinted(), []);
  assert.equal(h.transformOf('app:b'), '');
  assert.equal(h.transformOf('app:c'), '');
});


// A displaced item can be pushed clean off the 8-row canvas. There is no
// overlay cell to slide it to, so it says so where it stands rather than
// moving silently or sliding somewhere that doesn't exist yet.
test('an item pushed into the overflow rows is marked, not translated', () => {
  // A FULL canvas plus one extra tile already in the overflow region, so the
  // displaced occupant has nowhere on the canvas to go.
  //
  // The original of this test used a 2x2 widget as the thing pushed off:
  // dragging a tile onto its origin vacated one cell, and no free 2x2
  // remained. Every item is 1x1 now, so a full canvas is the way to reach the
  // same state — and the state is the point, not how it was provoked.
  const layout = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 4; col++) layout.push({ type: 'app', slug: `a${col}${row}`, col, row });
  }
  const h = makePreview(layout);
  // Drag the far-corner tile onto the origin. The occupant of (0,0) is
  // displaced, the vacated cell is the one the dragged tile came from, and
  // with the canvas otherwise full it is pushed clean off it.
  h.hover('app:a37', 0, 0);

  const pushed = h.dom.nodes.get('app:a00');
  assert.ok(pushed._cls.has('home-item-displaced')
    || pushed._cls.has('home-item-to-overflow'),
    'the occupant is either slid or marked, never left looking untouched');
  if (pushed._cls.has('home-item-to-overflow')) {
    assert.equal(pushed.style.transform || '', '',
      'and is NOT slid to a cell that does not exist yet');
    assert.ok(!pushed._cls.has('home-item-displaced'),
      'the two states are distinct — one slides, one says so in place');
  }
});

// The preview and the drop must be ONE computation. Two would eventually
// disagree, and the grid would lie about where a release lands.
test('the preview reuses the plan canPlace computed', () => {
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 2, row: 0 },
  ];
  const h = makePreview(layout);
  let calls = 0;
  const realPlace = h.HomeLayout.place;
  h.HomeLayout.place = (...args) => { calls += 1; return realPlace.apply(h.HomeLayout, args); };

  const el = h.dom.nodes.get('app:a');
  assert.equal(h.Home._planFor(el, { col: 2, row: 0 }, 5) !== null, true);
  assert.equal(calls, 1);
  // onHover right after must not recompute it.
  h.Home._previewDrop(el, { col: 2, row: 0 }, true, 5);
  assert.equal(calls, 1, 'the memo is what makes highlight and drop agree');
  // A different cell is a different plan.
  h.Home._previewDrop(el, { col: 3, row: 0 }, true, 5);
  assert.equal(calls, 2);
  h.HomeLayout.place = realPlace;
});

test('hiding the overlay clears every preview transform', () => {
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 2, row: 0 },
  ];
  const h = makePreview(layout);
  h.hover('app:a', 2, 0);
  assert.notEqual(h.transformOf('app:b'), '');
  // onSettle → _hideGridOverlay: a cancelled or refused drag must not leave a
  // tile parked at a position nothing saved.
  h.Home._hideGridOverlay();
  assert.equal(h.transformOf('app:b'), '');
  assert.equal(h.classesOf('app:b'), '');
});

test('the preview motion matches the kit’s FLIP family', () => {
  const CSS = read('public/css/app.css');
  // 200ms ease is attachReorder's gridFlip timing — the preview has to feel
  // like the same mechanism, not a second animation language.
  assert.match(CSS, /\.home-item-displaced \{[^}]*transition: transform 200ms ease/);
  assert.match(read('public/usernode-native/v1/native.js'), /transition = 'transform 200ms ease'/);
  // z-index so a sliding tile passes OVER its stationary neighbours.
  assert.match(CSS, /\.home-item-displaced \{[^}]*z-index: 2/);
  // Reduced motion drops the tween but keeps the move — the new POSITION is
  // the information.
  assert.match(CSS, /prefers-reduced-motion[^}]*\}[\s\S]*?\.home-item-displaced \{ transition: none/);
  // The overflow marker is a visible state, not a silent move.
  assert.match(CSS, /\.home-item-to-overflow \{[^}]*opacity/);
  assert.match(CSS, /\.home-item-to-overflow::after \{[^}]*content: '↓'/);
});

test('?shot=home-grid renders a real preview, not just the outlines', () => {
  // The preview is the part a reviewer needs to see and the part nothing can
  // navigate to, so the deep link has to enter it — otherwise the declared
  // check only proves the dashed cells still paint.
  const shot = HOME_SRC.slice(
    HOME_SRC.indexOf('_maybeShowShotGrid(listEl) {'),
    HOME_SRC.indexOf('\n  // Screenshot-state deep link (?shot=discover-drag'));
  assert.match(shot, /_previewDrop\(el, \{ col: 0, row: 0 \}, true, cols\)/);
  // THE LAST RENDERED ITEM, not `canvas[canvas.length - 1]`. The canvas is
  // eight rows deep and the grid shows two of them by default
  // (HomeLayout.DEFAULT_ROWS, THE UI OVERHAUL), so on any real account the
  // last canvas item is behind "Show all N apps" and has no element — which
  // sent the shot to its no-subject branch and left the check asserting
  // outlines with nothing being pushed.
  assert.match(shot, /for \(let i = canvas\.length - 1; i > 0 && !el; i--\)/,
    'walks back from the end to the last item that is actually on screen');
  assert.match(shot, /Home\._elFor\(candidate, listEl\)/,
    'and "on screen" means it resolves to an element');
  assert.match(shot, /i > 0/, 'a single-item grid has nothing to displace');
});

test('a rejected write reverts to server truth', async () => {
  const { Home, toasts, setFetch, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};
  setFetch(async (url, opts) => (
    (opts && opts.method === 'PUT')
      ? { ok: false, status: 500, json: async () => ({}) }
      : { ok: true, json: async () => ({ layouts: { 4: [], 5: [] }, widgets: REGISTRY }) }
  ));

  Home._onGridPlace({ dataset: { slug: 'a' }, classList: { contains: () => false } },
    { col: 2, row: 0 }, 5);
  await flush();
  await flush();

  assert.equal(toasts.length, 1, 'the failure is surfaced, not swallowed');
  assert.match(toasts[0], /layout/i);
  // ...and the client refetches rather than keeping an unsaved arrangement.
  assert.ok(fetchCalls.some((c) => c.method === 'GET' && c.url.startsWith('/api/home-layout')));
});



// Reading-order ids of a layout, for compact assertions.
function HomeLayoutIdsOf(layout) {
  return layout.slice()
    .sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col))
    .map((i) => (i.type === 'widget' ? `widget:${i.key}` : `app:${i.slug}`));
}

// ── Cell hit-testing ──────────────────────────────────────────────────

test('cellFromPoint reads the overlay’s own cells, never grid arithmetic', () => {
  const { Home, sandbox } = makeHome();
  sandbox.document.elementFromPoint = () => ({
    closest: (sel) => (sel === '[data-cell]' ? { dataset: { cell: '3,2' } } : null),
  });
  assert.deepEqual({ ...Home._cellFromPoint(10, 10) }, { col: 3, row: 2 });

  // Off the grid (deadspace, or the gap between cells) is null, not a guess.
  sandbox.document.elementFromPoint = () => ({ closest: () => null });
  assert.equal(Home._cellFromPoint(10, 10), null);
  sandbox.document.elementFromPoint = () => null;
  assert.equal(Home._cellFromPoint(10, 10), null);
});

// ── The target cell: the TILE's centroid, not the finger ──────────────
//
// The ghost tracks the finger from wherever the tile was grabbed, so the
// pointer sits a grab-offset away from the tile's own box. Resolving the
// target from the pointer put the tile's TOP-LEFT under the finger: grab a
// 2x2 widget by its bottom-right and the highlight appeared two cells right
// and two rows down from the block being held, and the drop landed there.
// These pin the centroid rule that replaced it.

// Point the sandbox's elementFromPoint at the fake overlay: a point resolves
// to the cell containing it, or to nothing outside the canvas — the same
// gate the real overlay provides through its own cell elements.
function hitTestCells(h, cols = 5) {
  h.sandbox.document.elementFromPoint = (x, y) => {
    const col = Math.floor(x / CELL_W);
    // Not `Math.floor(y / CELL_H)`: with a fit row on the canvas the rows are
    // not one pitch apart, so the boundary walk in rowAt IS the hit test.
    const row = rowAt(y);
    const cell = (col >= 0 && col < cols && row >= 0 && row < 8)
      ? h.dom.cells.get(`${col},${row}`) : null;
    return { closest: (sel) => (sel === '[data-cell]' && cell ? cell : null) };
  };
}

// The kit's third argument: the dragged tile's live viewport geometry. `grab`
// is where inside the tile the finger is holding it — the whole point being
// that it must not change the answer.
function ghostInfo(el, { left, top, w, h: rows, grabX = 0, grabY = 0 }) {
  const width = w * CELL_W;
  const height = rows * CELL_H;
  return {
    item: el,
    rect: { left, top, width, height },
    centerX: left + width / 2,
    centerY: top + height / 2,
    pointerX: left + grabX * width,
    pointerY: top + grabY * height,
  };
}

// The recognizer's own options, so these exercise the wired callback rather
// than the internals.
function wiredOpts(h) {
  h.Home._apps = [app('a')];
  h.Home._attachGridPlacement({ querySelectorAll: () => [] }, true);
  return h.attachCalls[h.attachCalls.length - 1].opts;
}

test('where the tile was grabbed does not move the target', () => {
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout);
  hitTestCells(h);
  const el = h.dom.nodes.get('app:a');
  // A ghost sitting exactly over cell (1,1).
  const place = { left: CELL_W, top: CELL_H, w: 1, h: 1 };

  for (const [grabX, grabY] of [[0, 0], [0.5, 0.5], [1, 1], [0.9, 0.1]]) {
    const info = ghostInfo(el, { ...place, grabX, grabY });
    assert.deepEqual({ ...h.Home._targetCellFor(info.pointerX, info.pointerY, info, 4) },
      { col: 1, row: 1 }, `grab at ${grabX},${grabY} must not move the tile`);
  }
});



// ── The row template (#968, #975) ─────────────────────────────────────
//
// The tracks Home.render writes onto #app-list. Everything about the model is
// unchanged — this is purely how many pixels one row is given.

// A stand-in for #app-list, which makeHome's document does not have (every
// other test here drives the geometry directly). Permissive on purpose: the
// subject is `style.gridTemplateRows`, not the rest of the render.
function installListEl(h) {
  const el = {
    dataset: {}, style: {}, innerHTML: '',
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    removeChild: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 800 }),
  };
  h.sandbox.document.getElementById = (id) => (id === 'app-list' ? el : null);
  return el;
}


test('the template stops at the last occupied row, not at the canvas', () => {
  // Eight entries would make the rows EXPLICIT, and an explicit grid exists
  // whether or not anything is in it: a three-app home screen would grow a
  // ~950px tail of empty rows.
  const { Home } = makeHome({ width: 390 });
  const layout = [
    { type: 'widget', key: 'challenges', col: 0, row: 0 },
    { type: 'app', slug: 'a', col: 0, row: 2 },
  ];
  assert.equal(Home.rowTemplate(layout, 4).split(' ').length, 3);
});

test('no template for a canvas with no blank row at all', () => {
  // The rule used to be gated on the phone column count, because at five
  // columns a row was shared between widgets and app icons and a short row
  // left a notch beside its neighbours. There is one column count now, so the
  // gate is gone and the only question is whether a row is empty.
  const { Home } = makeHome({ width: 390 });
  assert.equal(Home.rowTemplate([{ type: 'app', slug: 'a', col: 0, row: 0 }], 4), '',
    'one full row: nothing blank, so no template at all');
  assert.equal(Home.rowTemplate([], 4), '');
  assert.equal(Home.rowTemplate([
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 1, row: 1 },
  ], 4), '', 'consecutive occupied rows need no template either');
});

test('an empty row gets the half-cell track (#975)', () => {
  // The fit-row track that used to lead this template is gone with the widget
  // that earned it; an app tile has always kept its whole cell, and a row with
  // nothing in it has always been half of one.
  const { Home } = makeHome({ width: 390 });
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 0, row: 1 },
    { type: 'app', slug: 'c', col: 0, row: 3 },
  ];
  assert.deepEqual(Home.rowTemplate(layout, 4).split(' '), [
    'var(--home-cell-h)',
    'var(--home-cell-h)',
    'var(--home-blank-row-h)', // row 2 holds nothing
    'var(--home-cell-h)',
  ]);
});

test('a blank row alone produces a template where there used to be none', () => {
  // The one behaviour reversal: before #975 a phone layout with no Challenges
  // widget got no inline template at all, so its gaps were full cells.
  const { Home } = makeHome({ width: 390 });
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 0, row: 2 }];
  assert.equal(Home.rowTemplate(layout, 4),
    'var(--home-cell-h) var(--home-blank-row-h) var(--home-cell-h)');
});

test('trailing empty rows are not tracks, so they cannot be shrunk', () => {
  // The grid ends at the last placed item; declaring the whole eight-row canvas
  // would pad a small home screen out with a tail of empty tracks.
  const { Home } = makeHome({ width: 390 });
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 0, row: 1 }];
  assert.equal(Home.rowTemplate(layout, 4), '', 'nothing between them, nothing after');
  const gapped = [{ type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 0, row: 2 }];
  assert.equal(Home.rowTemplate(gapped, 4).split(' ').length, 3,
    'three entries — rows 3..7 stay implicit');
});

test('the default phone arrangement halves both of its gaps', () => {
  // The shape most accounts actually see (Challenges, one app row, two empty
  // rows, Discover, Create app) — the ~116px this issue is about.
  const { Home } = makeHome({ width: 390 });
  const layout = [
    { type: 'widget', key: 'challenges', col: 0, row: 0 },
    { type: 'app', slug: 'a', col: 0, row: 1 },
    { type: 'widget', key: 'discover', col: 0, row: 4 },
    { type: 'widget', key: 'create', col: 0, row: 5 },
  ];
  const tracks = Home.rowTemplate(layout, 4).split(' ');
  assert.equal(tracks.length, 6);
  assert.deepEqual(tracks.slice(2, 4),
    ['var(--home-blank-row-h)', 'var(--home-blank-row-h)']);
  assert.deepEqual(tracks.slice(4), ['var(--home-cell-h)', 'var(--home-cell-h)'],
    'Discover and Create app keep their cells');
});

test('every track stays a single space-free token', () => {
  // The overlay's mirror and these tests split the template on whitespace, so
  // a track containing a space (an inline `calc(a / 2)`, say) would be read as
  // two rows. That is why the half height is a CSS variable.
  const { Home } = makeHome({ width: 390 });
  const layout = [
    { type: 'widget', key: 'challenges', col: 0, row: 0 },
    { type: 'app', slug: 'a', col: 0, row: 2 },
  ];
  const template = Home.rowTemplate(layout, 4);
  assert.equal(template.split(' ').length, 3);
  for (const track of template.split(' ')) assert.doesNotMatch(track, /\s/);
});

test('the half-cell token is declared and derived from the cell', () => {
  // Derived, so 116px phone cell → 58px empty row with no second literal to
  // drift. rowTemplate emits the name; app.css has to define it.
  const CSS = read('public/css/app.css');
  assert.match(CSS, /--home-blank-row-h:\s*calc\(var\(--home-cell-h\)\s*\/\s*2\)/);
});

test('render publishes the template for the grid and clears it for a search', () => {
  // #1191: the tracks are PUBLISHED now, not written. Home.render() puts
  // `rowTemplate` in the view model and features/home/app-grid.tsx writes it
  // onto the element in a layout effect — so this asserts the model, which is
  // the half home.js still owns.
  const h = makeHome({ width: 390 });
  const { Home, gridStore } = h;
  installListEl(h);
  Home._apps = [app('a'), app('b')];
  Home._appsExpanded = true;
  Home._layouts = {
    4: [{ type: 'app', slug: 'a', col: 0, row: 0 },
      { type: 'app', slug: 'b', col: 0, row: 2 }],
  };
  Home._layoutFetchedAt = Date.now();
  Home.render();
  assert.match(gridStore.get().rowTemplate,
    /var\(--home-cell-h\) var\(--home-blank-row-h\) var\(--home-cell-h\)/);

  // The search view is a flat list with no placement: a stale template would
  // give its "N results" header a grid cell's height.
  Home._query = 'a';
  Home.render();
  assert.equal(gridStore.get().rowTemplate, '');
  assert.equal(gridStore.get().view, 'search', 'and the view switches with it');
});

// ── The overlay mirrors the tracks (#968, #975) ───────────────────────

test('the overlay copies the grid’s used row sizes and pads to the canvas', () => {
  const h = makeHome({ width: 390 });
  const { Home, sandbox } = h;
  const listEl = installListEl(h);
  sandbox.getComputedStyle = () => ({ gridTemplateRows: '116px 67.5px 116px' });
  assert.equal(Home._overlayRowTemplate(listEl),
    ['116px', '67.5px', '116px', ...Array(5).fill('var(--home-cell-h)')].join(' '),
    'the real rows, then the cell token for the rest of the eight-row canvas');
});

test('a half-height blank row is mirrored too, and the padding stays full', () => {
  // The used value of var(--home-blank-row-h) is plain pixels by the time
  // getComputedStyle reports it, so the mirror needs no knowledge of the token.
  // The rows PAST the template are empty as well but keep the full cell: they
  // are below the content, so they cost the page nothing and a big drop target
  // is worth more there.
  const h = makeHome({ width: 390 });
  const { Home, sandbox } = h;
  const listEl = installListEl(h);
  sandbox.getComputedStyle = () => ({ gridTemplateRows: '116px 58px 116px' });
  assert.equal(Home._overlayRowTemplate(listEl),
    ['116px', '58px', '116px', ...Array(5).fill('var(--home-cell-h)')].join(' '));
});

test('a grid with no template leaves the overlay’s own row sizing alone', () => {
  // Desktop and the search view: `none` is what getComputedStyle reports for a
  // grid whose rows are all implicit, and the overlay must fall back to its
  // stylesheet grid-auto-rows rather than writing "none" over it.
  const h = makeHome();
  const { Home, sandbox } = h;
  const listEl = installListEl(h);
  sandbox.getComputedStyle = () => ({ gridTemplateRows: 'none' });
  assert.equal(Home._overlayRowTemplate(listEl), '');
  sandbox.getComputedStyle = () => ({ gridTemplateRows: '' });
  assert.equal(Home._overlayRowTemplate(listEl), '');
});

// ── Non-uniform rows (#968) ───────────────────────────────────────────
//
// A phone row a fit widget owns is as tall as the widget draws, so the canvas
// no longer has one row pitch. _targetCellFor used to derive the row by
// dividing by the 0→1 pitch, which stops describing row 5 the moment row 1 is
// short; it measures the rows now. These pin that it lands on the right one —
// the uniform cases above go through the same code path, so they are the other
// half of this guard.
//
// The table: row 1 is a ~68px fit row (an empty Challenges widget), the rest
// are full 120px cells. Tops: 0, 120, 188, 308, 428…
const FIT_TABLE = [CELL_H, 68, CELL_H, CELL_H, CELL_H, CELL_H, CELL_H, CELL_H];

test('a tile centred over a SHORT row lands in it, not one derived from pitch', () => {
  setRowHeights(FIT_TABLE);
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 4 }];
  const h = makePreview(layout, { cols: 4, width: 390 });
  hitTestCells(h, 4);
  const el = h.dom.nodes.get('app:a');
  // The ghost sits squarely over row 1 — top 120, height 68, so centre 154.
  const info = ghostInfo(el, { left: 0, top: 120, w: 1, h: 1, grabX: 0.5, grabY: 0.5 });
  info.rect.height = 68;
  info.centerY = 154;

  assert.equal(rowAt(info.centerY), 1, 'the centre really is in the short row');
  assert.deepEqual({ ...h.Home._targetCellFor(info.pointerX, info.pointerY, info, 4) },
    { col: 0, row: 1 });
});

test('a short row shifts the rows under it, and the target follows', () => {
  // The regression the pitch arithmetic actually had. Row 1 is 52px short, so
  // every row below it sits 52px higher than a uniform canvas would put it.
  // Row 3's real band is 308–428 (centre 368); a ghost centred at 310 is
  // inside it and nearest its centre, but dividing by the 0→1 pitch gives
  // round(310/120 - 0.5) = 2 and drops the tile a row short.
  setRowHeights(FIT_TABLE);
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout, { cols: 4, width: 390 });
  hitTestCells(h, 4);
  const el = h.dom.nodes.get('app:a');
  const info = ghostInfo(el, { left: 0, top: 250, w: 1, h: 1, grabX: 0.5, grabY: 0.5 });

  assert.equal(info.centerY, 310);
  assert.equal(rowAt(info.centerY), 3, 'the centre really is in row 3');
  assert.equal(Math.round(info.centerY / CELL_H - 0.5), 2,
    'and a single pitch would have said row 2 — this is the bug');
  assert.deepEqual({ ...h.Home._targetCellFor(info.pointerX, info.pointerY, info, 4) },
    { col: 0, row: 3 });
});


// A blank row is the second source of short rows (#975): 58px against the
// 116px phone cell. Same measured code path as a fit row, so what this pins is
// that a HALF-height row is still hittable and still the nearest target when
// the ghost is over it — a tile can be dropped into a gap exactly as before.
const BLANK_TABLE = [CELL_H, 58, CELL_H, CELL_H, CELL_H, CELL_H, CELL_H, CELL_H];

test('a tile centred over a half-height blank row lands in that row', () => {
  setRowHeights(BLANK_TABLE);
  // Row 1 is the empty one: top 120, height 58, so its band is 120–178.
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 0, row: 2 }];
  const h = makePreview(layout, { cols: 4, width: 390 });
  hitTestCells(h, 4);
  const el = h.dom.nodes.get('app:a');
  const info = ghostInfo(el, { left: 0, top: 120, w: 1, h: 1, grabX: 0.5, grabY: 0.5 });
  info.rect.height = CELL_H;
  info.centerY = 149; // the blank row's own centre

  assert.equal(rowAt(info.centerY), 1, 'the centre really is in the blank row');
  assert.deepEqual({ ...h.Home._targetCellFor(info.pointerX, info.pointerY, info, 4) },
    { col: 0, row: 1 }, 'so the gap is a drop target, not a row to skip over');
});

test('a blank row shifts the rows under it, and the target follows', () => {
  // The same guard as the fit-row case: row 1 is 58px short, so row 3's real
  // band is 294–414 (centre 354) while a single 0→1 pitch would put the ghost
  // a row short.
  setRowHeights(BLANK_TABLE);
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout, { cols: 4, width: 390 });
  hitTestCells(h, 4);
  const el = h.dom.nodes.get('app:a');
  const info = ghostInfo(el, { left: 0, top: 240, w: 1, h: 1, grabX: 0.5, grabY: 0.5 });

  assert.equal(info.centerY, 300);
  assert.equal(rowAt(info.centerY), 3, 'the centre really is in row 3');
  assert.equal(Math.round(info.centerY / CELL_H - 0.5), 2,
    'and a single pitch would have said row 2');
  assert.deepEqual({ ...h.Home._targetCellFor(info.pointerX, info.pointerY, info, 4) },
    { col: 0, row: 3 });
});

test('_rowNearest falls back to the pitch when a rect reports no height', () => {
  // A host that mocks only { left, top } must degrade to the uniform
  // assumption rather than treating every row as zero-tall and collapsing
  // every answer to row 0.
  const h = makePreview([{ type: 'app', slug: 'a', col: 0, row: 0 }]);
  for (const cell of h.dom.cells.values()) {
    const { left, top } = cell.getBoundingClientRect();
    cell.getBoundingClientRect = () => ({ left, top });
  }
  assert.equal(h.Home._rowNearest(h.dom.overlay, 3 * CELL_H + CELL_H / 2, 1, CELL_H), 3);
  assert.equal(h.Home._rowNearest(h.dom.overlay, CELL_H / 2, 1, CELL_H), 0);
});

test('a tile snaps once it is more than halfway into the next column', () => {
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout);
  hitTestCells(h);
  const el = h.dom.nodes.get('app:a');
  const at = (left) => h.Home._targetCellFor(0, 0,
    ghostInfo(el, { left, top: 0, w: 1, h: 1 }), 5).col;

  assert.equal(at(CELL_W), 1, 'aligned with column 1');
  assert.equal(at(CELL_W + 40), 1, 'not yet halfway');
  assert.equal(at(CELL_W + 60), 2, 'past halfway — snaps on');
});

test('the target is clamped to the canvas, so the token IS the landing cell', () => {
  const layout = [{ type: 'app', slug: 'a', col: 2, row: 2 }];
  const h = makePreview(layout);
  hitTestCells(h);
  const el = h.dom.nodes.get('app:a');

  // A tile dragged off the top-left corner wants a negative cell.
  const corner = ghostInfo(el, { left: -CELL_W / 2, top: -CELL_H / 2, w: 1, h: 1 });
  assert.deepEqual({ ...h.Home._targetCellFor(0, 0, corner, 4) }, { col: 0, row: 0 });

  // ...and one pushed past the last column is nudged in to where it fits,
  // which is the same cell _rectForCell measures, so the glide can't disagree.
  const edge = ghostInfo(el, { left: 4.4 * CELL_W, top: CELL_H, w: 1, h: 1 });
  const cell = h.Home._targetCellFor(0, 0, edge, 4);
  assert.deepEqual({ ...cell }, { col: 3, row: 1 });
  assert.deepEqual({ ...h.Home._rectForCell(el, cell, 4) },
    { left: 3 * CELL_W, top: 1 * CELL_H });
});

test('a tile whose CENTRE leaves the canvas has no target, finger or not', () => {
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout);
  hitTestCells(h);
  const el = h.dom.nodes.get('app:a');
  // Dragged up off the grid: the finger is still over a cell (it is holding
  // the tile's bottom edge), the tile is not.
  const info = ghostInfo(el, { left: 0, top: -0.75 * CELL_H, w: 1, h: 1, grabY: 1 });
  assert.deepEqual({ ...h.Home._cellFromPoint(info.pointerX, info.pointerY) }, { col: 0, row: 0 });
  assert.equal(h.Home._targetCellFor(info.pointerX, info.pointerY, info, 5), null);
});

test('no tile geometry (an older kit) falls back to the pointer hit-test', () => {
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout);
  hitTestCells(h);
  const opts = wiredOpts(h);
  h.Home._overlayEl = h.dom.overlay; // _attachGridPlacement doesn't touch it; be explicit

  assert.deepEqual({ ...opts.cellFromPoint(250, 250) }, { col: 2, row: 2 },
    'degrades to today’s behaviour rather than breaking the drag');
  assert.deepEqual({ ...opts.cellFromPoint(250, 250, { item: null }) }, { col: 2, row: 2 });
});

test('the wired hover tints the cell the TILE covers, and the glide agrees', () => {
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 3, row: 0 },
  ];
  const h = makePreview(layout);
  hitTestCells(h);
  const opts = wiredOpts(h);
  h.Home._overlayEl = h.dom.overlay;
  const el = h.dom.nodes.get('app:a');

  // The tile is sitting over cell (2,1), held by its top-left corner.
  const info = ghostInfo(el, { left: 2 * CELL_W, top: CELL_H, w: 1, h: 1 });
  const cell = opts.cellFromPoint(info.pointerX, info.pointerY, info);
  assert.deepEqual({ ...cell }, { col: 2, row: 1 });

  assert.equal(opts.canPlace(el, cell), true);
  opts.onHover(el, cell, true);
  assert.deepEqual(h.tinted().sort(), ['2,1'], 'exactly the cell under the tile');
  assert.deepEqual({ ...opts.rectForCell(el, cell) }, { left: 2 * CELL_W, top: CELL_H });
});

// ── Where the release glide lands ──────────────────────────────────────
//
// The kit settles the ghost on the rect _rectForCell returns. Getting that
// wrong is the bug this suite exists to prevent regressing: a placement drag
// never moves the real item, so if the kit falls back to the item's own rect
// the tile flies from the finger BACK to the cell it was picked up from and
// only then pops into the drop cell — one release, two contradictory motions,
// too fast to read as anything but a glitch.

test('rectForCell settles the ghost on the LANDING cell, not the origin cell', () => {
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 2, row: 3 },
  ];
  const h = makePreview(layout);
  const el = h.dom.nodes.get('app:a');

  // Drop 'a' (origin 0,0 → rect 0,0) on cell 3,5.
  assert.deepEqual({ ...h.Home._rectForCell(el, { col: 3, row: 5 }, 5) },
    { left: 3 * CELL_W, top: 5 * CELL_H });
  // Emphatically NOT the origin, which is what item.getBoundingClientRect()
  // would still report mid-drag.
  assert.notDeepEqual({ ...h.Home._rectForCell(el, { col: 3, row: 5 }, 5) }, { left: 0, top: 0 });

  // Dropping where it already is settles in place — a no-op drop must not
  // glide anywhere.
  assert.deepEqual({ ...h.Home._rectForCell(el, { col: 0, row: 0 }, 5) }, { left: 0, top: 0 });
});

test('the settle target is the plan’s cell, so an edge nudge lands where the tint promised', () => {
  // A tile hovered PAST the last column cannot be placed there — the plan
  // clamps it in to fit. The tint shows the clamped cell, and the glide has to
  // agree with it: settling on the cell under the FINGER would drop the tile a
  // column short of where it visibly lands.
  //
  // The original of this case used a 2x2 widget at column 4 of 5, where the
  // nudge was a footprint that would not fit. Every item is 1x1 now, so the
  // clamp is the edge itself — the same rule, reached the only way left.
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout);
  const el = h.dom.nodes.get('app:a');

  const plan = h.Home._planFor(el, { col: 9, row: 1 }, 4);
  const placed = plan.next.find((i) => h.HomeLayout.idOf(i) === 'app:a');
  assert.equal(placed.col, 3, 'a tile past col 3 of 4 is clamped to the last column');

  assert.deepEqual({ ...h.Home._rectForCell(el, { col: 9, row: 1 }, 4) },
    { left: 3 * CELL_W, top: 1 * CELL_H }, 'the glide follows the plan, not the pointer');
  // And the tint agrees, which is the whole point of sharing the memo.
  h.Home._previewDrop(el, { col: 9, row: 1 }, true, 4);
  assert.deepEqual(h.tinted().sort(), ['3,1']);
});

test('rectForCell returns null when there is no cell to settle on', () => {
  // Null means "fall back to the item's own rect": a slightly wrong glide is
  // better than reading a rect off nothing, and better than a thrown error
  // mid-release, which would leave the ghost on screen forever.
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout);
  const el = h.dom.nodes.get('app:a');

  // No overlay at all (a drop resolved after teardown).
  const overlay = h.Home._overlayEl;
  h.Home._overlayEl = null;
  assert.equal(h.Home._rectForCell(el, { col: 1, row: 1 }, 5), null);
  h.Home._overlayEl = overlay;

  // An element that is in no layout has no plan and therefore no landing.
  assert.equal(h.Home._rectForCell({ dataset: {}, _cls: new Set(), classList: { contains: () => false } },
    { col: 1, row: 1 }, 5), null);

  // A landing off the bottom of the canvas has no overlay cell to measure.
  // canPlace refuses those, so this guard is belt-and-braces — stub the plan
  // to reach it.
  const realPlace = h.HomeLayout.place;
  h.HomeLayout.place = () => [{ type: 'app', slug: 'a', col: 0, row: h.HomeLayout.MAX_ROWS }];
  h.Home._planMemo = null;
  assert.equal(h.Home._rectForCell(el, { col: 0, row: 1 }, 5), null);
  h.HomeLayout.place = realPlace;
  h.Home._planMemo = null;
});

test('the host hands rectForCell to the kit, wired to the same memo as the tint', () => {
  const { Home, attachCalls } = makeHome();
  Home._apps = [app('a')];
  Home._attachGridPlacement({ querySelectorAll: () => [] }, true);
  const { opts } = attachCalls[0];
  assert.equal(typeof opts.rectForCell, 'function',
    'without this the kit settles on the item’s own rect — the origin cell');

  // It must route through _rectForCell (and so through _planFor's memo)
  // rather than measure something of its own.
  const calls = [];
  const real = Home._rectForCell;
  Home._rectForCell = (...args) => { calls.push(args); return { left: 7, top: 9 }; };
  const el = { dataset: {} };
  assert.deepEqual(opts.rectForCell(el, { col: 2, row: 2 }), { left: 7, top: 9 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], el);
  assert.deepEqual(calls[0][1], { col: 2, row: 2 });
  Home._rectForCell = real;
});

test('the overlay is inset by the grid’s ASYMMETRIC padding', () => {
  // _rectForCell measures overlay cells, so any offset between the overlay
  // and the real grid becomes a jump at the very end of the glide — the one
  // frame the motion is supposed to be seamless. #app-list is
  // `p-2 pt-1.5 sm:p-3 sm:pt-2`: the top is tighter than the sides, and a
  // uniform inset sits the whole overlay 2px (phone) / 4px (desktop) low.
  const CSS = read('public/css/app.css');
  assert.match(read('public/index.html'), /id="app-list"[^>]*class="[^"]*\bp-2 pt-1\.5 sm:p-3 sm:pt-2/,
    'the padding these insets mirror');
  assert.match(CSS, /\.home-grid-overlay \{[^}]*inset: 0\.375rem 0\.5rem 0\.5rem;/);
  assert.match(CSS, /min-width: 640px\)[\s\S]*?\.home-grid-overlay \{[^}]*inset: 0\.5rem 0\.75rem 0\.75rem;/);
});

// ── Live reflow across the 640px boundary ─────────────────────────────
//
// Every item's cell is an INLINE grid-column/grid-row written at render
// time. The CSS switches columns on its own (grid-cols-4 sm:grid-cols-5,
// plus the media-queried --home-cell-h) but those inline placements do
// not: without a resize handler, widening a narrowed desktop window keeps
// the 4-column arrangement inside a 5-column grid — a dead trailing
// column, widgets spanning 4 of 5 — until some unrelated event happens to
// re-render. These pin the handler AND the rule that it never writes.

// A helper: render() needs real DOM, so drive _applyColumnCount with
// render stubbed out and count the re-renders.
function watchRenders(Home) {
  const calls = [];
  Home.render = () => { calls.push(Home.currentCols()); };
  return calls;
}












function HomeLayoutBreakpoint() {
  const m = LAYOUT_SRC.match(/BREAKPOINT_PX:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

// ── The staging demo tiles are placed, not dropped ────────────────────
//
// GET /api/apps?demo=1 injects two read-only demo tiles, and the ?demo=1
// layout places them on the grid on purpose — that route exists so a
// reviewer signed in as ANY cloned identity sees the feature. But they are
// neither favourited nor collaborations, so partitionApps rightly leaves
// them out of "Your apps", and repair() drops whatever presentIds() does
// not list. The demo route's whole subject was being deleted from it before
// the first paint: a reviewer with no apps of their own got three widgets
// on an otherwise bare grid, and every dapp.json check that selects an app
// tile at ?demo=1 failed on a screen that looked deliberate.
//
// The spec's rule is that [data-demo] tiles are "excluded from the drag but
// placed by the layout like anything else" — the recognizer's own
// `:not([data-demo])` selector is what excludes them, not their absence.

test('demo tiles count as present, so repair() keeps them on the grid', () => {
  const { Home } = makeHome();
  Home._apps = [
    app('mine', { is_favorited: true }),
    { ...app('demo-emoji'), demo: true, is_collaborator: false },
    { ...app('demo-image'), demo: true, is_collaborator: false },
  ];
  const ids = Home.presentIds();
  assert.ok(ids.includes('app:mine'));
  assert.ok(ids.includes('app:demo-emoji'), 'a demo tile is present');
  assert.ok(ids.includes('app:demo-image'));
  // Listed exactly once — a demo tile that were ALSO yours must not appear
  // twice, or repair() would try to place the same item two ways.
  assert.equal(ids.filter((i) => i === 'app:demo-emoji').length, 1);
});

test('a demo tile that IS yours is listed once, not twice', () => {
  const { Home } = makeHome();
  Home._apps = [{ ...app('both', { is_favorited: true }), demo: true }];
  const ids = Home.presentIds().filter((i) => i === 'app:both');
  assert.deepEqual([...ids], ['app:both']);
});

test('the demo layout survives repair for a viewer with no apps of their own', () => {
  const { Home, HomeLayout } = makeHome();
  // Exactly the ?demo=1 shape: two demo tiles and the widgets, nothing the
  // viewer owns.
  Home._apps = [
    { ...app('staging-demo-emoji-icon'), demo: true, is_collaborator: false },
    { ...app('staging-demo-image-icon'), demo: true, is_collaborator: false },
  ];
  Home._layouts = {
    4: [
      { type: 'app', slug: 'staging-demo-emoji-icon', col: 0, row: 0 },
      { type: 'app', slug: 'staging-demo-image-icon', col: 3, row: 0 },
      { type: 'widget', key: 'discover', col: 0, row: 1 },
      { type: 'widget', key: 'challenges', col: 0, row: 4 },
      { type: 'widget', key: 'create', col: 0, row: 6 },
    ],
    5: [],
  };
  Home._layoutFetchedAt = Date.now();
  Home._layoutIsDemo = true;

  const layout = Home.currentLayout(4);
  const ids = layout.map((i) => HomeLayout.idOf(i));
  assert.ok(ids.includes('app:staging-demo-emoji-icon'),
    'the demo route still shows the tiles it exists to show');
  assert.ok(ids.includes('app:staging-demo-image-icon'));
  assert.equal(layout.filter((i) => i.type === 'app').length, 2);
});

// ── More apps than cells: a repair that only moves overflow is not a write ──
//
// With more apps than the 4 x MAX_ROWS canvas holds, repair() parks the rest
// on the overflow row and reports `changed` on every call. Writing that was a
// loop in production (93 apps): toWire() dropped the overflow, the server kept
// the same 32 cells, its answer reset _layouts, and every render — three per
// home refresh — wrote again.

/** A full stored canvas, plus `extra` apps that do not fit on it. */
function seedFullCanvas(Home, HomeLayout, extra) {
  const cells = 4 * HomeLayout.MAX_ROWS;
  const slugs = Array.from({ length: cells + extra }, (_, i) => `app-${i}`);
  Home._apps = slugs.map((s) => app(s));
  Home._layouts = {
    4: slugs.slice(0, cells).map((slug, i) => (
      { type: 'app', slug, col: i % 4, row: Math.floor(i / 4) }
    )),
    5: [],
  };
  Home._layoutFetchedAt = Date.now();
  return slugs;
}

/** The server's answer to a PUT: the cells it stored, as GET returns them. */
function echoStoredCells(setFetch) {
  setFetch(async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    return {
      ok: true,
      json: async () => (body ? { layouts: { 4: body.items, 5: [] } } : {}),
    };
  });
}

test('a full canvas with overflow apps renders without writing', async () => {
  const { Home, HomeLayout, fetchCalls, setFetch } = makeHome();
  seedFullCanvas(Home, HomeLayout, 61);
  echoStoredCells(setFetch);

  for (let i = 0; i < 3; i++) {
    const layout = Home.currentLayout(4);
    assert.equal(layout.length, 4 * HomeLayout.MAX_ROWS + 61, 'every app is still laid out');
    await flush();
  }
  assert.equal(fetchCalls.filter((c) => c.method === 'PUT').length, 0,
    'nothing the server would store changed, so nothing is written');
});

test('a real correction beside overflow apps is written once, then settles', async () => {
  const { Home, HomeLayout, fetchCalls, setFetch } = makeHome();
  const slugs = seedFullCanvas(Home, HomeLayout, 10);
  echoStoredCells(setFetch);
  // The app in the first cell was deleted: its cell is free for an overflow app.
  Home._apps = Home._apps.filter((a) => a.slug !== slugs[0]);

  for (let i = 0; i < 3; i++) {
    Home.currentLayout(4);
    await flush();
  }
  const writes = fetchCalls.filter((c) => c.method === 'PUT');
  assert.equal(writes.length, 1, 'the correction is written, and only once');
  const stored = writes[0].body.items;
  assert.equal(stored.length, 4 * HomeLayout.MAX_ROWS, 'the freed cell is filled');
  assert.ok(!stored.some((i) => i.slug === slugs[0]), 'the deleted app is gone');
});

test('a stored canvas with room still writes a newly added app', async () => {
  const { Home, fetchCalls, setFetch } = makeHome();
  seedLayout(Home);
  echoStoredCells(setFetch);
  Home._apps = [...Home._apps, app('e')];

  Home.currentLayout(4);
  await flush();
  Home.currentLayout(4);
  await flush();
  const writes = fetchCalls.filter((c) => c.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.ok(writes[0].body.items.some((i) => i.slug === 'e'));
});


// ── The drag-time overlay lives INSIDE a React-owned host ─────────────
//
// `_showGridOverlay` appends `#home-grid-overlay` into `#app-list`, and
// `#app-list` is `features/home/app-grid.tsx`'s subtree. That is a second
// writer under an owned host — the thing AGENTS.md's ownership rule exists to
// forbid — and it is deliberate, because the alternatives are worse: the
// overlay's inset mirrors #app-list's padding EXACTLY at both breakpoints
// (app.css says so, twice) and `_rectForCell` measures those cell elements to
// land a committed drop, so moving it out would re-derive geometry that is
// currently free.
//
// What makes it safe is a timing invariant rather than a boundary: the overlay
// exists ONLY between onLift and onSettle, and React cannot reconcile
// `#app-list` in that window because every path that publishes the grid model
// returns early while `_dragActive` holds. The audit
// (scripts/audit-react-ownership.mjs) cannot check this — it never drags — so
// it is checked here, on both halves:
//
//   1. Executed: with the guard held, neither entry point publishes.
//   2. Complete: there is no THIRD publisher for the guard to miss.
//
// Break either half and the failure is the one the rule describes — React
// reconciling over a subtree the drag is mutating, mid-gesture.

test('no grid model is published while a drag holds the guard', async () => {
  const { Home, gridStore } = makeHome();
  Home._apps = [app('alpha'), app('beta')];
  Home._layoutFetchedAt = Date.now();
  Home.render();
  const painted = gridStore.get();
  assert.equal(painted.ready, true, 'a normal render publishes');

  Home._dragActive = true;
  Home._query = 'alpha';           // a search keystroke mid-drag
  Home.render();
  assert.equal(gridStore.get(), painted, 'render() defers instead of republishing');
  assert.equal(Home._reloadPending, true, 'and records what it owes');

  Home._reloadPending = false;
  await Home.load();               // a WS app_status mid-drag
  assert.equal(gridStore.get(), painted, 'load() defers too');
  assert.equal(Home._reloadPending, true);
});

test('render() and load() are the only publishers of the grid model', () => {
  // Comments first — the note above names the store it is about.
  const code = HOME_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const sites = [...code.matchAll(/gridStore\.\w+\(/g)].map((m) => m.index);
  assert.equal(sites.length, 3,
    'a new gridStore write needs its own drag guard — see the note above');
  // Each one is inside load() (its two failure paths) or render() (the paint).
  // load() is the single-flight gate; the load itself is _loadOnce().
  const load = code.indexOf('async _loadOnce() {');
  const render = code.indexOf('  render() {');
  const afterRender = code.indexOf('  _renderAppsMore(count) {');
  assert.ok(load > 0 && render > load && afterRender > render);
  const inLoad = sites.filter((at) => at > load && at < render).length;
  const inRender = sites.filter((at) => at > render && at < afterRender).length;
  assert.equal(inLoad, 2, 'load()\'s offline and failure notices');
  assert.equal(inRender, 1, 'the paint');
  // And both entry points open with the guard.
  assert.match(code.slice(load, load + 400), /if \(Home\._dragActive\) \{\s*Home\._reloadPending = true;\s*return;/);
  assert.match(code.slice(render, render + 300), /if \(Home\._dragActive\) \{\s*Home\._reloadPending = true;\s*return;/);
});


// ── #1567: an add that lands below the fold opens the grid ────────────
//
// The default grid shows two rows. An app added from a Discover rail that
// gets placed past that bound would be added to a section that visibly does
// not change, which is the reload complaint again in a smaller form — so
// the paint that follows an add reveals it.

const revealHome = () => {
  const h = makeHome({ width: 390 });
  installListEl(h);
  h.Home._apps = ['a', 'b', 'far'].map(app);
  h.Home._layouts = {
    4: [
      { type: 'app', slug: 'a', col: 0, row: 0 },
      { type: 'app', slug: 'b', col: 0, row: 1 },
      { type: 'app', slug: 'far', col: 0, row: 5 },
    ],
  };
  h.Home._layoutFetchedAt = Date.now();
  return h;
};

test('a tile added past the visible rows expands the grid so it can be seen', () => {
  const { Home, gridStore } = revealHome();
  Home.render();
  assert.equal(Home._appsExpanded, false, 'collapsed to start with');
  assert.equal(
    gridStore.get().items.some((it) => it.app.slug === 'far'), false,
    'and row 5 is held back',
  );

  Home._revealSlug = 'far';
  Home.render();
  assert.equal(Home._appsExpanded, true, 'the add opened it');
  assert.equal(
    gridStore.get().items.some((it) => it.app.slug === 'far'), true,
    'so the app the viewer just added is actually on screen',
  );
});

test('a tile that lands inside the visible rows leaves the grid collapsed', () => {
  const { Home, gridStore } = revealHome();
  Home._revealSlug = 'a';
  Home.render();
  assert.equal(Home._appsExpanded, false,
    'nothing was hidden from this viewer, so nothing needs revealing');
  assert.equal(gridStore.get().items.some((it) => it.app.slug === 'far'), false);
});

test('the reveal is one-shot: the next paint does not re-open the grid', () => {
  const { Home } = revealHome();
  Home._revealSlug = 'far';
  Home.render();
  assert.equal(Home._revealSlug, null, 'cleared by the paint it described');
  Home._appsExpanded = false;
  Home.render();
  assert.equal(Home._appsExpanded, false);
});

test('a stationary touch lift opens context without placing; movement continues as a drag', () => {
  const { Home, attachCalls } = makeHome();
  const list = { querySelectorAll: () => [], appendChild: () => {} };
  const item = { dataset: { slug: 'a' } };
  Home._attachGridPlacement(list, true);
  const { opts } = attachCalls[0];
  const events = [];
  Home._cardPointerType = 'touch';
  Home.openCardMenu = (slug, anchor) => events.push(['open', slug, anchor]);
  Home.closeCardMenu = () => events.push(['close']);
  Home._showGridOverlay = () => events.push(['overlay']);
  Home._targetCellFor = () => ({ col: 1, row: 0 });
  opts.onLift(item);
  assert.deepEqual(events, [['open', 'a', item]]);
  assert.equal(opts.cellFromPoint(20, 20, {}), null);
  assert.equal(opts.cellFromPoint(23, 24, {}), null, 'finger jitter does not place');
  assert.equal(events.length, 1);
  assert.deepEqual(opts.cellFromPoint(40, 20, {}), { col: 1, row: 0 });
  assert.deepEqual(events.slice(1), [['close'], ['overlay']]);
  assert.equal(Home._contextLift, null);
  opts.onSettle(true);
  assert.equal(Home._dragActive, false);
});

// ── Dragging an app IN from Discover (#1763) ──────────────────────────
//
// The same recognizer, attached to a rail instead of to #app-list, carrying
// an item that is not on the canvas yet. What is pinned here is the whole of
// what makes that work: the item is modelled and parked off-canvas for the
// span of the gesture, the grid's own plan then treats the drop as ordinary,
// and a committed drop both PLACES and ADDS while a cancelled one does
// neither.

/** A Discover card, as the recognizer hands it to Home. */
const cardEl = (slug) => ({
  dataset: { slug },
  classList: { contains: () => false, add: () => {}, remove: () => {} },
});

/** Arm the rail recognizer and hand back its options. */
function armRail(Home, attachCalls, opts) {
  const detach = Home._attachDiscoverPlacement({ querySelectorAll: () => [] }, opts);
  return { opts: attachCalls[attachCalls.length - 1].opts, detach };
}

/** A sidebar community row, as the recognizer hands it to Home (#6025). */
const railRowEl = (slug) => ({
  dataset: { railCommunity: slug },
  classList: { contains: () => false, add: () => {}, remove: () => {} },
});

/** Arm the sidebar's own recognizer, the way RailCommunities does (#6025). */
function armSidebar(Home, attachCalls) {
  const listEl = { querySelectorAll: () => [] };
  const detach = Home._attachDiscoverPlacement(listEl, {
    itemSelector: '.platform-rail-community[data-rail-community]',
  });
  return { listEl, opts: attachCalls[attachCalls.length - 1].opts, detach };
}

test('the rail arms the SAME recognizer the grid does, and excludes demo tiles', () => {
  const { Home, attachCalls } = makeHome();
  seedLayout(Home);
  const { opts, detach } = armRail(Home, attachCalls);
  assert.equal(attachCalls.length, 1);
  assert.match(opts.itemSelector, /:not\(\[data-demo\]\)/,
    'staging demo tiles stay drag-inert (#746) — no row to favourite');
  assert.match(opts.itemSelector, /\[data-slug\]/, 'and the empty-lane note is not a card');
  for (const hook of ['cellFromPoint', 'canPlace', 'onHover', 'rectForCell', 'onPlace', 'onSettle']) {
    assert.equal(typeof opts[hook], 'function', `${hook} is the grid's own`);
  }
  assert.equal(typeof detach, 'function',
    'a handle per lane, because there are two rails and one slot would drop one');
});

test('a card that is not on the canvas is carried as an off-canvas item', () => {
  const { Home, attachCalls, HomeLayout } = makeHome();
  seedLayout(Home);
  const { opts } = armRail(Home, attachCalls);

  opts.onLift(cardEl('newcomer'));
  assert.equal(Home._dragActive, true);
  // Spread: the item is built inside the vm context, so deepStrictEqual would
  // fail on the prototype rather than on anything about the value.
  assert.deepEqual({ ...Home._incoming },
    { type: 'app', slug: 'newcomer', col: 0, row: HomeLayout.MAX_ROWS });

  // It is on the layout the DRAG works against, and only that one: the cache
  // the grid renders from is untouched, so nothing paints a tile for an app
  // the viewer has not dropped yet.
  const working = Home.currentLayoutCached(4);
  assert.equal(working.some((it) => it.slug === 'newcomer'), true);
  assert.equal(Home._layoutCache.some((it) => it.slug === 'newcomer'), false);
  assert.equal(Home._itemFor(cardEl('newcomer')), Home._incoming);

  opts.onSettle(false);
  assert.equal(Home._incoming, null, 'and it is gone the moment the gesture is');
  assert.equal(Home._dragActive, false);
});

test('a card whose app is already yours moves that tile instead of adding a second', () => {
  const { Home, attachCalls } = makeHome();
  seedLayout(Home);
  const { opts } = armRail(Home, attachCalls);

  // The lane keeps a card for the rest of the visit after an add (#1567), so
  // this is the ordinary case, not a corner one.
  opts.onLift(cardEl('a'));
  assert.equal(Home._incoming, null);
  assert.deepEqual({ ...Home._itemFor(cardEl('a')) }, { type: 'app', slug: 'a', col: 0, row: 0 });
});

test('the incoming drop displaces the occupant to a free cell, never off the canvas', () => {
  const { Home, attachCalls, HomeLayout } = makeHome();
  seedLayout(Home);
  const { opts } = armRail(Home, attachCalls);
  opts.onLift(cardEl('newcomer'));

  // (0,0) is app "a". HomeLayout.place re-homes a displaced occupant into the
  // dragged item's VACATED rectangle first — which for an incoming item is the
  // overflow row, and HomeLayout.fits refuses row >= MAX_ROWS. So "a" takes
  // the first free cell instead of being pushed off the grid.
  assert.equal(opts.canPlace(cardEl('newcomer'), { col: 0, row: 0 }), true);
  const { next } = Home._planFor(cardEl('newcomer'), { col: 0, row: 0 }, 4);
  const placed = next.find((it) => it.slug === 'newcomer');
  assert.deepEqual([placed.col, placed.row], [0, 0]);
  const bumped = next.find((it) => it.slug === 'a');
  assert.ok(bumped.row < HomeLayout.MAX_ROWS,
    `"a" was pushed to row ${bumped.row} — an occupant must never be sent to `
    + 'the overflow region by a tile arriving from off-canvas');
  assert.notDeepEqual([bumped.col, bumped.row], [0, 0]);
});

test('a committed incoming drop places the app AND adds it to Your apps', async () => {
  const { Home, attachCalls, fetchCalls } = makeHome();
  seedLayout(Home);
  Home._apps.push(app('newcomer'));
  Home.render = () => {};
  const { opts } = armRail(Home, attachCalls);

  opts.onLift(cardEl('newcomer'));
  opts.onPlace(cardEl('newcomer'), { col: 2, row: 1 });
  // The membership write waits for the gesture to be over, so the repaint it
  // ends in is not swallowed by the drag deferral.
  assert.equal(fetchCalls.filter((c) => c.method === 'POST').length, 0);
  opts.onSettle(true);
  await flush();

  const put = fetchCalls.find((c) => c.method === 'PUT' && c.url === '/api/home-layout');
  assert.ok(put, 'the cell is written');
  const landed = put.body.items.find((i) => i.slug === 'newcomer');
  assert.deepEqual([landed.col, landed.row], [2, 1], 'at the cell it was dropped in');

  const post = fetchCalls.find((c) => c.url === '/api/apps/newcomer/favorite');
  assert.ok(post, 'and the app joins Your apps');
  assert.deepEqual(post.body, { favorited: true });
  assert.equal(Home._apps.find((a) => a.slug === 'newcomer').is_favorited, true);
  assert.equal(Home._pendingAdd, null);
});

test('a cancelled incoming drag adds nothing and writes nothing', async () => {
  const { Home, attachCalls, fetchCalls } = makeHome();
  seedLayout(Home);
  Home._apps.push(app('newcomer'));
  Home.render = () => {};
  const { opts } = armRail(Home, attachCalls);

  // Released off the grid: the kit never calls onPlace, only onSettle.
  opts.onLift(cardEl('newcomer'));
  opts.onSettle(false);
  await flush();

  assert.equal(fetchCalls.filter((c) => c.method !== 'GET').length, 0,
    'the gesture is cancellable, which the ⊕ badge is not');
  assert.equal(Home._apps.find((a) => a.slug === 'newcomer').is_favorited, false);
});

test('an incoming add does not let a deferred reload race its own POST', async () => {
  const { Home, attachCalls } = makeHome();
  seedLayout(Home);
  Home._apps.push(app('newcomer'));
  Home.render = () => {};
  let loaded = 0;
  Home.load = async () => { loaded += 1; };
  const { opts } = armRail(Home, attachCalls);

  opts.onLift(cardEl('newcomer'));
  opts.onPlace(cardEl('newcomer'), { col: 2, row: 1 });
  // A WS app event mid-gesture asks for a full reload. On an ordinary drop
  // that wins; here it would re-read /api/apps while the favourite POST is
  // still in flight and paint the app straight back out of Your apps.
  Home._reloadPending = true;
  opts.onSettle(true);
  await flush();

  assert.equal(loaded, 0, 'toggleAdded owns the repaint on this path');
  assert.equal(Home._reloadPending, false);
  assert.equal(Home._rerenderPending, false);
});

// ── The SIDEBAR's community rows are the same recognizer's second source
//    (#6025) ────────────────────────────────────────────────────────────
//
// RailCommunities attaches this recognizer to #platform-rail-communities
// while Home is on show, naming its own rows with `itemSelector`. A row
// carries `data-rail-community` rather than `data-slug`, and both name the
// same app slug, so the drop is the Discover drop unchanged: place it in the
// cell where it was let go, then add it.

test('a sidebar row is carried as the same incoming app a Discover card is', () => {
  const { Home, attachCalls, HomeLayout } = makeHome();
  seedLayout(Home);
  const { listEl, opts } = armSidebar(Home, attachCalls);

  assert.equal(attachCalls[0].listEl, listEl, 'attached to the sidebar section itself');
  assert.equal(opts.itemSelector, '.platform-rail-community[data-rail-community]');
  opts.onLift(railRowEl('newcomer'));
  assert.equal(Home._dragActive, true);
  assert.deepEqual({ ...Home._incoming },
    { type: 'app', slug: 'newcomer', col: 0, row: HomeLayout.MAX_ROWS });
  assert.equal(Home._itemFor(railRowEl('newcomer')), Home._incoming,
    'the row resolves to the incoming item through its own data attribute');
});

test('a community dropped on My apps is placed AND added, as Add does', async () => {
  const { Home, attachCalls, fetchCalls } = makeHome();
  seedLayout(Home);
  Home._apps.push(app('newcomer'));
  Home.render = () => {};
  const { opts } = armSidebar(Home, attachCalls);

  opts.onLift(railRowEl('newcomer'));
  opts.onPlace(railRowEl('newcomer'), { col: 2, row: 1 });
  assert.equal(fetchCalls.filter((c) => c.method === 'POST').length, 0,
    'the membership write waits for the gesture to be over');
  opts.onSettle(true);
  await flush();

  const put = fetchCalls.find((c) => c.method === 'PUT' && c.url === '/api/home-layout');
  assert.ok(put, 'the cell is written');
  const landed = put.body.items.find((i) => i.slug === 'newcomer');
  assert.deepEqual([landed.col, landed.row], [2, 1], 'at the cell it was dropped in');

  const post = fetchCalls.find((c) => c.url === '/api/apps/newcomer/favorite');
  assert.ok(post, 'and the app is added to My apps');
  assert.deepEqual(post.body, { favorited: true });
  assert.equal(Home._apps.find((a) => a.slug === 'newcomer').is_favorited, true);
});

test('a community drag released off the grid writes nothing', async () => {
  const { Home, attachCalls, fetchCalls } = makeHome();
  seedLayout(Home);
  Home._apps.push(app('newcomer'));
  Home.render = () => {};
  const { opts } = armSidebar(Home, attachCalls);

  opts.onLift(railRowEl('newcomer'));
  opts.onSettle(false);
  await flush();

  assert.equal(fetchCalls.filter((c) => c.method !== 'GET').length, 0,
    'a drop outside the grid is a cancellation, not an add');
  assert.equal(Home._apps.find((a) => a.slug === 'newcomer').is_favorited, false);
});

test('a community whose app is already in My apps moves that tile, adding nothing', () => {
  const { Home, attachCalls } = makeHome();
  seedLayout(Home);
  const { opts } = armSidebar(Home, attachCalls);

  opts.onLift(railRowEl('a'));
  assert.equal(Home._incoming, null, 'it already has a tile, so nothing is arriving');
  assert.deepEqual({ ...Home._itemFor(railRowEl('a')) },
    { type: 'app', slug: 'a', col: 0, row: 0 });
});

test('with no itemSelector the Discover card selector is unchanged', () => {
  const { Home, attachCalls } = makeHome();
  seedLayout(Home);
  const { opts } = armRail(Home, attachCalls);
  assert.equal(opts.itemSelector, '.app-card[data-slug]:not([data-demo])',
    'the sidebar names its own rows; everything else keeps Discover\'s');
});

// ── #1838: the gesture-driven card-menu deep links ────────────────
//
// `?shot=card-menu` alone proves the menu BUILDER works: it calls
// openCardMenu directly, so it would have stayed green through the whole of
// #1838 — a desktop right-click was a no-op and a held mouse button was
// discarded before the timer was ever armed, and no declared check could
// tell. The two gesture variants exist to close that: they synthesise the
// mouse input and let the tile's own handlers and the hold recognizer do
// everything else.

// rAF is setTimeout(fn, 0) in this sandbox, and setImmediate (flush) can win
// the race against a pending timer — so wait on a timer registered AFTER it.
const frame = () => new Promise((r) => setTimeout(r, 0));

function shotMenuEnv(search) {
  const env = makeHome();
  const { Home, sandbox } = env;
  const dispatched = [];
  const opened = [];
  sandbox.location.search = search;
  sandbox.PointerEvent = class PointerEvent {
    constructor(type, init) { Object.assign(this, { type }, init); }
  };
  sandbox.MouseEvent = class MouseEvent {
    constructor(type, init) { Object.assign(this, { type }, init); }
  };
  Home.openCardMenu = (slug, anchor) => { opened.push([slug, anchor]); };

  const card = {
    nodeType: 1,
    dataset: { slug: 'demo-app' },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 60, height: 40 }),
    dispatchEvent: (e) => { dispatched.push(e); return true; },
  };
  const listEl = {
    offsetParent: {},
    querySelector: (sel) => (sel === '.app-card[data-slug]' ? card : null),
  };
  return { ...env, card, listEl, dispatched, opened };
}

test('shot=card-menu with no gesture still opens the menu directly (#1838)', async () => {
  const env = shotMenuEnv('?demo=1&shot=card-menu');
  env.Home._maybeOpenShotMenu(env.listEl);
  await frame();
  assert.deepEqual(env.opened, [['demo-app', env.card]],
    'the plain link is unchanged — it is what pins the menu builder');
  assert.deepEqual(env.dispatched, [], 'and it synthesises no input');
});

test('shot=card-menu&gesture=contextmenu right-clicks the real tile (#1838)', async () => {
  const env = shotMenuEnv('?demo=1&shot=card-menu&gesture=contextmenu');
  env.Home._maybeOpenShotMenu(env.listEl);
  await frame();

  assert.deepEqual(env.opened, [],
    'the point of this variant is that NOTHING calls openCardMenu — the'
    + ' tile’s own onContextMenu has to reach it');
  assert.deepEqual(env.dispatched.map((e) => e.type), ['pointerdown', 'contextmenu'],
    'pointerdown leads, the way a browser delivers them: it is what records'
    + ' the pointer type the handler branches on');
  assert.equal(env.dispatched[0].button, 2);
  assert.equal(env.dispatched[0].pointerType, 'mouse');
  assert.equal(env.dispatched[0].bubbles, true,
    'the handler is a React prop, so the event has to reach the root');
  // Centre of the tile, so the kit's flip/clamp placement has a sane anchor.
  assert.equal(env.dispatched[0].clientX, 40);
  assert.equal(env.dispatched[0].clientY, 40);
  assert.equal(env.Home._shotMenuDone, true, 'still a one-shot');
});

test('shot=card-menu&gesture=hold holds the left button down (#1838)', async () => {
  const env = shotMenuEnv('?demo=1&shot=card-menu&gesture=hold');
  env.Home._maybeOpenShotMenu(env.listEl);
  await frame();

  assert.deepEqual(env.opened, []);
  assert.deepEqual(env.dispatched.map((e) => e.type), ['pointerdown'],
    'no pointerup and no pointermove — a released or moved press is exactly'
    + ' what must NOT open the menu, so the hold has to run to its timer');
  assert.equal(env.dispatched[0].button, 0);
  assert.equal(env.dispatched[0].pointerType, 'mouse');
  assert.equal(env.dispatched[0].isPrimary, true);
  assert.equal(env.Home._shotMenuDone, true);

  // Spent: a later repaint must not fire a second press.
  env.Home._maybeOpenShotMenu(env.listEl);
  await frame();
  assert.equal(env.dispatched.length, 1);
});

test('a gesture link leaves the one-shot unspent when only a rect resolves (#1838)', async () => {
  const env = shotMenuEnv('?demo=1&shot=card-menu&gesture=contextmenu');
  const { Home, sandbox } = env;
  // #929's featured-row fallback hands back a RECT, and a rect cannot
  // receive an event. Rather than dispatch nowhere, wait for a repaint that
  // has a real launcher tile — which is what the seeded demo tile is for.
  const featuredCard = {
    dataset: { slug: 'featured-app' },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 60, height: 40 }),
  };
  sandbox.document.getElementById = (id) => (id === 'home-featured-list'
    ? { offsetParent: {}, querySelector: () => featuredCard }
    : null);
  const emptyList = { offsetParent: {}, querySelector: () => null };

  Home._maybeOpenShotMenu(emptyList);
  await frame();
  assert.deepEqual(env.dispatched, []);
  assert.deepEqual(env.opened, []);
  assert.equal(Home._shotMenuDone, false,
    'the link must still fire on a later paint that has a real tile');

  Home._maybeOpenShotMenu(env.listEl);
  await frame();
  assert.deepEqual(env.dispatched.map((e) => e.type), ['pointerdown', 'contextmenu']);
  assert.equal(Home._shotMenuDone, true);
});

test('an unknown gesture value falls back to the direct open (#1838)', async () => {
  const env = shotMenuEnv('?demo=1&shot=card-menu&gesture=wiggle');
  env.Home._maybeOpenShotMenu(env.listEl);
  await frame();
  assert.deepEqual(env.opened, [['demo-app', env.card]]);
  assert.deepEqual(env.dispatched, []);
});
