// Issue #770: the "Homeroom widget" tile strip's kit drag uses the
// grid (displacement) mode, matching the app-card grid from #753.
// These tests pin the attachReorder options _wireWidgetStrip passes —
// grid: true + itemSelector — and the callback contracts: onLift /
// onSettle hold Home._dragActive (and onSettle flushes a deferred
// reload/re-render), and onReorder persists the strip's DOM order via
// the bridge's reorderHomeScreenShortcuts.
//
// home.js declares `const Home = {…}` at top level; we load it into a vm
// context with stubbed globals and call _wireWidgetStrip directly with fake
// DOM nodes — same harness as home-drag-add.test.js. Its source comes from
// ./helpers/home-modules, which resolves the module's post-#1083 location and
// strips the one `import` line a vm context cannot parse.
//
// Run with: node --test tests/widget-grid-reorder.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { HOME_SRC } = require('./helpers/home-modules');

// Returns { Home, attachCalls, reorderCalls, toasts }. attachCalls
// records every unNative.attachReorder invocation ({ listEl, opts });
// reorderCalls the id arrays sent to the bridge's
// reorderHomeScreenShortcuts stub.
function makeHome() {
  const attachCalls = [];
  const reorderCalls = [];
  const toasts = [];
  const sandbox = {
    console,
    App: { user: { id: 1 } },
    PlatformUI: { toast: (msg) => { toasts.push(String(msg)); } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
    unNative: {
      attachReorder: (listEl, opts) => {
        attachCalls.push({ listEl, opts });
        return { detach: () => {} };
      },
    },
    usernode: {
      reorderHomeScreenShortcuts: async (ids) => { reorderCalls.push(ids); },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, attachCalls, reorderCalls, toasts };
}

const flush = () => new Promise((r) => setImmediate(r));

// Minimal fake DOM for _wireWidgetStrip: a listEl whose only queryable
// child is the strip, and a strip holding widget tiles (dataset.wid).
function makeStrip(ids) {
  const tiles = ids.map((id) => ({ dataset: { wid: id } }));
  const strip = {
    tiles,
    querySelectorAll: (sel) => (sel === '.widget-tile' ? strip.tiles : []),
  };
  const listEl = {
    querySelector: (sel) => (sel === '#widget-strip' ? strip : null),
  };
  return { listEl, strip };
}

function wire(ids = ['a', 'b', 'c']) {
  const env = makeHome();
  const { listEl, strip } = makeStrip(ids);
  env.Home._wireWidgetStrip(listEl);
  assert.equal(env.attachCalls.length, 1, 'attachReorder wired once');
  return { ...env, strip, opts: env.attachCalls[0].opts, attachedTo: env.attachCalls[0].listEl };
}

// ── attachReorder options ─────────────────────────────────────────

test('widget strip attaches kit reorder in grid mode on the strip', () => {
  const { opts, attachedTo, strip } = wire();
  assert.equal(attachedTo, strip, 'attached to the strip element');
  assert.equal(opts.grid, true, 'grid (displacement) mode is on');
  assert.equal(opts.itemSelector, '.widget-tile');
  assert.equal(typeof opts.onLift, 'function');
  assert.equal(typeof opts.onSettle, 'function');
  assert.equal(typeof opts.onReorder, 'function');
});

// ── onLift / onSettle hold _dragActive ────────────────────────────

test('onLift sets _dragActive; onSettle clears it', () => {
  const { Home, opts } = wire();
  assert.equal(Home._dragActive, false);
  opts.onLift();
  assert.equal(Home._dragActive, true, 'lift holds the drag guard');
  opts.onSettle(false);
  assert.equal(Home._dragActive, false, 'settle releases it');
});

test('onSettle flushes a deferred reload into Home.load()', () => {
  const { Home, opts } = wire();
  let loads = 0;
  Home.load = () => { loads += 1; };
  opts.onLift();
  Home._reloadPending = true; // a WS update arrived mid-drag
  opts.onSettle(true);
  assert.equal(loads, 1, 'deferred reload runs at settle');
  assert.equal(Home._reloadPending, false);
  assert.equal(Home._dragActive, false);
});

test('onSettle flushes a deferred re-render when no reload is pending', () => {
  const { Home, opts } = wire();
  let renders = 0;
  Home.render = () => { renders += 1; };
  opts.onLift();
  Home._rerenderPending = true;
  opts.onSettle(false);
  assert.equal(renders, 1, 'deferred re-render runs at settle');
  assert.equal(Home._rerenderPending, false);
});

// ── onReorder persists the strip's DOM order ──────────────────────

test('onReorder saves the tile order the strip currently shows', async () => {
  const { Home, opts, strip, reorderCalls } = wire(['a', 'b', 'c']);
  Home._widgetItems = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ];
  // Simulate the kit's live DOM move (b dragged to the front) — the
  // kit fires onReorder AFTER the element has moved.
  strip.tiles = [
    { dataset: { wid: 'b' } },
    { dataset: { wid: 'a' } },
    { dataset: { wid: 'c' } },
  ];
  opts.onReorder(1, 0, strip.tiles[0]);
  await flush();
  // Spread into host-realm arrays: the ids array is built inside the vm
  // context, whose Array.prototype fails deepStrictEqual across realms.
  assert.equal(reorderCalls.length, 1, 'one bridge reorder call');
  assert.deepEqual([...reorderCalls[0]], ['b', 'a', 'c'], 'bridge got the DOM order');
  assert.deepEqual(
    [...Home._widgetItems].map((it) => it.id),
    ['b', 'a', 'c'],
    'optimistic mirror matches'
  );
});
