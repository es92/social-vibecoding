'use strict';

// Home on a quiet network (offline test, 2 Nov 2026). Its /api/apps read
// now gives up instead of waiting a minute (frontend/src/lib/read-timeout.ts),
// and while the probe still says online that failure used to draw the error
// card over a grid already on screen. Now:
//
//   1. a read the network never answered keeps the grid that was drawn;
//   2. with nothing drawn yet it is the error card and its Retry, as before;
//   3. an answer that failed (a 500) is still the error card;
//   4. coming back online reads Home again when its last read failed, not
//      only when it never loaded, and once: the resync the same return starts
//      may already be loading it.
//
// Run with: node --test tests/home-load-recovery.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { HOME_SRC, PANELS_SRC } = require('./helpers/home-modules');
const { installGridStore, installPanelsStore } = require('./helpers/home-grid-store');
const { installAppCard } = require('./helpers/app-card');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const APP = {
  id: 1, slug: 'demo-app', name: 'Demo App', status: 'running', created_by: 2,
  created_at: '2026-06-01T00:00:00Z', is_collaborator: true, active_users: '0',
};

function makeHome({ apps = 'unreached' } = {}) {
  const listeners = new Map();
  const later = [];
  const nudges = [];
  let answer = apps;
  const sandbox = {
    console,
    App: { user: { id: 1 }, _isScreenVisible: () => true },
    PlatformUI: { toast: () => {} },
    Offline: { isOffline: () => false, nudge: () => nudges.push(1) },
    HomeLayout: null,
    document: {
      createElement: () => ({ style: {}, textContent: '', innerHTML: '' }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async (url) => {
      if (!String(url).startsWith('/api/apps')) return { ok: true, json: async () => ({}) };
      if (answer === 'unreached') throw new TypeError('Network request timed out');
      if (answer === 'refused') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ apps: answer }) };
    },
    location: { search: '', origin: 'https://sv.test' },
    URL,
    URLSearchParams,
    setTimeout: (fn, ms) => { later.push({ fn, ms }); return later.length; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  installAppCard(sandbox);
  const gridStore = installGridStore(sandbox);
  installPanelsStore(sandbox);
  vm.runInContext(
    `${read('frontend/src/features/home/home-layout.js')}\n;globalThis.HomeLayout = HomeLayout;`,
    sandbox,
  );
  vm.runInContext(`${PANELS_SRC}\n;globalThis.HomePanels = HomePanels;`, sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  const backOnline = () => {
    for (const fn of listeners.get('usernode:offline-change') || []) fn({ detail: { offline: false } });
  };
  return {
    Home: sandbox.__Home,
    grid: () => JSON.parse(JSON.stringify(gridStore.get())),
    answer(next) { answer = next; },
    backOnline,
    later,
    nudges,
  };
}

test('a read the network never answered keeps the grid already drawn', async () => {
  const h = makeHome({ apps: [APP] });
  await h.Home.load();
  assert.equal(h.grid().items.length, 1, 'the first read drew the app');
  h.answer('unreached');
  await h.Home.load();
  const state = h.grid();
  assert.equal(state.notice, null, 'no error card over it');
  assert.equal(state.items.length, 1, 'the app is still there');
  assert.equal(h.Home._lastLoadFailed, true);
});

test('with nothing drawn yet, it is the error card and its Retry, as before', async () => {
  const h = makeHome();
  await h.Home.load();
  assert.deepEqual(h.grid().notice, { text: "Couldn't load your apps", tone: 'error' });
});

test('an answer that failed is still the error card', async () => {
  const h = makeHome({ apps: [APP] });
  await h.Home.load();
  h.answer('refused');
  await h.Home.load();
  assert.deepEqual(h.grid().notice, { text: "Couldn't load your apps", tone: 'error' });
});

test('back online, Home is read again when its last read failed, and once', async () => {
  const h = makeHome({ apps: [APP] });
  await h.Home.load();
  h.answer('unreached');
  await h.Home.load();
  let loads = 0;
  const realLoad = h.Home.load;
  h.Home.load = () => { loads += 1; return realLoad.call(h.Home); };
  h.later.length = 0;

  h.backOnline();
  assert.equal(loads, 0, 'not at once: the reconnect\'s own resync may be loading it');
  const wait = h.later.find((entry) => entry.ms === 1500);
  assert.ok(wait, 'it waits a moment');
  h.answer([APP]);
  wait.fn();
  assert.equal(loads, 1, 'and then reads it');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.Home._lastLoadFailed, false);

  // Heard again with a current grid: nothing to do.
  h.later.length = 0;
  h.backOnline();
  assert.equal(h.later.length, 0);

  // A resync already loading Home by then: it stands down.
  h.answer('unreached');
  await realLoad.call(h.Home);
  h.later.length = 0;
  h.backOnline();
  h.Home._loadInFlight = Promise.resolve();
  h.later.find((entry) => entry.ms === 1500).fn();
  assert.equal(loads, 1, 'no second read of the same return');
});
