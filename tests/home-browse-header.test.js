'use strict';

// #1569: the Home/Browse root header must not grow a back slot on navigation.
// Execute the actual router and Browse controller, then render the actual
// React header through their store bridges. Effects do not run under SSR;
// viewport geometry remains covered by header-height/title-centering tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const APP = read('public/js/app.js');
const BROWSE = read('frontend/src/features/apps/browse.js');
const ui = loadTsx('tests/fixtures/platform-header-api.ts');
const initialBack = { ...ui.backButtonStore.get() };
const initialTitle = { ...ui.headerTitleStore.get() };
const initialImprove = { ...ui.improveStore.get() };

function harness({ improveAvailable = true } = {}) {
  ui.backButtonStore.set(initialBack);
  ui.headerTitleStore.set(initialTitle);
  // Target availability is held steady, as it is on these two platform
  // screens. The authority/data-loading gates have their own coverage in
  // improve-target-leaving-app.test.js.
  ui.improveStore.set({
    ...initialImprove,
    target: improveAvailable ? 'platform' : null,
    slug: improveAvailable ? 'platform-app' : null,
    selfHosted: improveAvailable,
  });
  const writes = [];
  const transitions = [];
  const visible = new Map([['home-screen', true]]);
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, innerHTML: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {},
    });
    return nodes.get(id);
  }
  const sandbox = {
    console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { hash: '', search: '', pathname: '/', origin: 'https://example.test' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: node, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    addEventListener() {},
    PlatformUI: { transition: (fn, options) => transitions.push({ fn, options }) },
    Home: { _apps: [{ slug: 'notes', name: 'Notes' }], load() {}, publishImproveTarget() {} },
    AppView: { close() {}, _teardownDevRoots() {}, _unmountAppFrame() {} },
    UsernodeReact: {
      backButton: { set(mode, href) {
        writes.push({ mode, href });
        ui.backButtonStore.set({ mode, href });
      } },
      headerTitle: { set(text, subtitle) {
        writes.push({ text });
        ui.headerTitleStore.set({ text, subtitle: subtitle || '' });
      } },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP, sandbox);
  vm.runInContext(BROWSE, sandbox);
  const { App, Browse } = sandbox;
  App.user = { id: 1 };
  App._setScreenVisible = (id, value) => visible.set(id, value);
  App._isScreenVisible = (id) => visible.get(id) === true;
  App.setChromeless = () => {};
  App.updateHash = () => { sandbox.location.hash = ''; };
  Browse._load = () => {}; // No network needed to exercise screen/level chrome.
  const header = () => {
    // homeHref reads the browser bridge on a visible Home button. Supply the
    // same window to the renderer for this synchronous pass, then restore it.
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const previousWindow = globalThis.window;
    globalThis.window = sandbox;
    try {
      const html = renderToHtml(createElement(ui.PlatformHeader));
      const result = html.match(/<header\b[\s\S]*?<\/header>/);
      assert.ok(result, 'the real platform header renders');
      return result[0];
    } finally {
      if (hadWindow) globalThis.window = previousWindow;
      else delete globalThis.window;
    }
  };
  const flush = () => {
    const transition = transitions.shift();
    assert.ok(transition, 'one screen transition is pending');
    transition.fn();
    transition.options?.after?.();
  };
  return { App, Browse, header, writes, transitions, visible, flush };
}

for (const improveAvailable of [true, false]) {
  test(`Home and Browse render identical header controls with Improve ${improveAvailable ? 'available' : 'unavailable'}`, () => {
    const h = harness({ improveAvailable });
    h.App._showOnlyScreen('home-screen');
    h.App.setHeaderTitle('Homeroom');
    const home = h.header();
    h.writes.length = 0;

    h.App.navigateToBrowse();
    assert.deepEqual(h.writes, [], 'no incoming chrome before the outgoing snapshot');
    assert.equal(h.header(), home);
    h.flush();
    assert.equal(h.header(), home.replaceAll('Homeroom', 'All apps'),
      'only the destination name changes, not controls, classes, or wrappers');
    assert.ok(h.writes.some((entry) => entry.mode === 'none'));
    assert.ok(h.writes.every((entry) => !entry.mode || entry.mode === 'none'),
      'not even an intermediate publish inserts a Home icon');

    const browse = h.header();
    h.writes.length = 0;
    h.App.navigateHome();
    assert.deepEqual(h.writes, [], 'return navigation also defers its header writes');
    assert.equal(h.header(), browse);
    h.flush();
    assert.equal(h.header(), home);
    assert.ok(h.writes.every((entry) => !entry.mode || entry.mode === 'none'));
  });
}

test('a cold Browse entry and a repeated route never insert the Home icon', () => {
  const h = harness();
  h.App.navigateToBrowse();
  assert.deepEqual(h.writes, []);
  h.flush();
  assert.ok(h.writes.every((entry) => !entry.mode || entry.mode === 'none'));
  const header = h.header();
  h.writes.length = 0;
  h.App.navigateToBrowse();
  assert.equal(h.transitions.length, 0, 'duplicate dispatch does not start another transition');
  assert.deepEqual(h.writes, []);
  assert.equal(h.header(), header);
});

test('Browse details retain the arrow to the list, which restores the root header', () => {
  const h = harness();
  h.App.navigateToBrowse();
  h.flush();
  const listHeader = h.header();
  h.App.navigateToBrowse('notes');
  assert.equal(h.header(), listHeader, 'detail chrome is deferred until the level transition');
  h.flush();
  assert.equal(ui.backButtonStore.get().mode, 'arrow');
  assert.equal(ui.backButtonStore.get().href, '#apps');
  assert.match(h.header(), /id="back-btn"[^>]*aria-label="Back"[^>]*href="#apps"/);

  h.App.navigateToBrowse();
  h.flush();
  assert.equal(h.header(), listHeader);
});

test('a detail opened directly from a Home card still offers Home', () => {
  const h = harness();
  h.Browse.noteDetailOrigin('home');
  h.App.navigateToBrowse('notes');
  h.flush();
  assert.equal(ui.backButtonStore.get().mode, 'home');
  assert.equal(ui.backButtonStore.get().href, '/');
  assert.match(h.header(), /id="back-btn"[^>]*aria-label="Home"/);
});

test('secondary screens keep their Home button instead of inheriting the root state', () => {
  const h = harness();
  for (const screen of ['app-view', 'settings-screen', 'profile-screen', 'messages-screen', 'admin-screen', 'leaderboard-screen']) {
    h.App._showOnlyScreen('browse-screen');
    h.App._showOnlyScreen(screen);
    assert.equal(ui.backButtonStore.get().mode, 'home', `${screen} keeps its way out`);
  }
});

test('the shared navigation menu still has reachable Home and Discover destinations', () => {
  const menu = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(menu, /label="Home"[\s\S]{0,500}App\?\.navigateHome\?\.\(\)/);
  assert.match(menu, /href="#apps"\s+icon=\{<SearchIcon \/>\}\s+label="Discover"/);
});
