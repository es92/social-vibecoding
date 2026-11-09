// Challenge numbers catch up without a reload (#3985).
//
// "Finished the tasks yesterday but the challenge card still showed the old
// numbers for a while; refreshed twice." Three things kept an old count up:
//
//   * neither challenge surface was registered with live reads
//     (frontend/src/lib/live-reads.ts), so coming back to the tab, a socket
//     reconnect or coming back online read nothing again;
//   * Home's pull went through Home.load(), whose Challenges block keeps its
//     read for a minute (HomePanels.TTL_MS), so a pull inside that minute
//     re-read nothing;
//   * a pull on the Challenges tab read without `cache: 'no-cache'`, so a
//     slow network got the service worker's saved copy back first.
//
// Both the Challenges tab (topochain-challenges.js) and Home's block
// (home-panels.js) now watch live reads while they show challenges and
// re-read fresh, and the tab re-reads in place: the cards stay up and a
// failed re-read keeps them.
//
// Run with: node --test tests/challenges-live-reads.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { PANELS_SRC } = require('./helpers/home-modules');
const { installPanelsStore } = require('./helpers/home-grid-store');

const root = path.join(__dirname, '..');
const CHALLENGES_SRC = fs.readFileSync(
  path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');

// A stand-in for window.UsernodeReact.liveReads: what registered, and a way
// to fire every watcher as a pass would.
function fakeLiveReads() {
  const watchers = new Set();
  const owns = new Map();
  return {
    watchers,
    watch(fn, opts = {}) {
      watchers.add(fn);
      owns.set(fn, opts.reads || null);
      return () => watchers.delete(fn);
    },
    fire() {
      return Promise.all([...watchers].map((fn) => fn({ reason: 'visible', reasons: ['visible'], urls: null })));
    },
    // A service-worker correction: only the watchers that own the read.
    correct(href) {
      const url = new URL(href);
      return Promise.all([...watchers].filter((fn) => owns.get(fn) && owns.get(fn)(url))
        .map((fn) => fn({ reason: 'correction', reasons: ['correction'], urls: [href] })));
    },
  };
}

const json = (body, ok = true) => ({
  ok, status: ok ? 200 : 500,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

function loadPane({ context = { eventId: 10, onChange: () => () => {} } } = {}) {
  const live = fakeLiveReads();
  const server = { credits: 1, fail: false, holdMine: null };
  const reads = [];
  const sandbox = {
    console, setTimeout, clearTimeout,
    location: { hash: '', search: '' },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: { TopochainEventContext: context, UsernodeReact: { liveReads: live } },
    fetch: async (url, init) => {
      reads.push({ url: String(url), cache: init && init.cache });
      if (server.fail) return json({ success: false, error: 'boom' }, false);
      if (String(url).startsWith('/challenges-api/')) {
        const answer = json({ success: true, data: [{ id: 1, points: server.credits * 100 }] });
        if (server.holdMine) await server.holdMine;
        return answer;
      }
      return json({
        success: true,
        data: [{
          id: 1,
          card_preview: { goal: 'Try three apps' },
          metric: { kind: 'apps_tried', target: 3, label: 'Apps tried' },
          progress: { done: server.credits >= 3, current: server.credits, target: 3 },
        }],
      });
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.addEventListener = () => {};
  sandbox.window.removeEventListener = () => {};
  sandbox.TopochainEventContext = context;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(CHALLENGES_SRC, sandbox, { filename: 'topochain-challenges.js' });
  const pane = sandbox.window.TopochainChallenges;
  const state = { mounted: false, grid: null, detail: null, profile: null };
  const grids = [];
  pane._store = {
    get: () => state,
    set: (patch) => { Object.assign(state, patch); if ('grid' in patch) grids.push(patch.grid); },
  };
  const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };
  return { pane, live, server, reads, state, grids, settle };
}

// Polish N11: on a cold visit the event list has not answered, so there is
// no event id yet. That is a wait: "No challenges right now." flashed for a
// frame before the skeleton. Once the list answers with no event at all,
// the same null is the real empty state.
test('before the event list answers the grid waits; a list with no event is the empty state', async () => {
  let notify = () => {};
  const context = { eventId: null, _resolved: false, onChange: (fn) => { notify = fn; return () => {}; } };
  const { pane, state, grids, settle } = loadPane({ context });
  pane.open();
  await settle();
  assert.ok(grids.length > 0, 'the grid was drawn');
  assert.ok(grids.every((g) => g.kind === 'loading'), 'no "No challenges right now." while the list is out');
  // The list answers, with no public event: its notification ends the wait.
  context._resolved = true;
  notify();
  await settle();
  assert.equal(state.grid.kind, 'empty');
  pane.close();
});

test('the Challenges tab watches live reads while open, and stops when it closes', async () => {
  const { pane, live, settle } = loadPane();
  pane.open();
  await settle();
  assert.equal(live.watchers.size, 1, 'open() registers one watcher');
  pane.open();
  assert.equal(live.watchers.size, 1, 'a second open does not register twice');
  pane.close();
  assert.equal(live.watchers.size, 0, 'close() unregisters it');
});

test('a live re-read brings the new count in place, fresh, without a skeleton', async () => {
  const { pane, live, server, reads, state, grids, settle } = loadPane();
  pane.open();
  await settle();
  assert.equal(state.grid.kind, 'cards');
  reads.length = 0;
  grids.length = 0;

  server.credits = 3;
  await live.fire();
  await settle();

  assert.deepEqual(reads.map((r) => r.cache), ['no-cache', 'no-cache'],
    'both the list and the viewer\'s own rows ask the worker for the current answer');
  assert.ok(grids.every((g) => g.kind === 'cards'), 'the cards never give way to a loading state');
  assert.equal(pane._challenges[0].progress.current, 3, 'the new count is what the grid now reads');
});

test('a failed re-read keeps the cards on screen', async () => {
  const { pane, live, server, state, settle } = loadPane();
  pane.open();
  await settle();
  server.fail = true;
  await live.fire();
  await settle();
  assert.equal(state.grid.kind, 'cards');
  assert.equal(pane._challengesError, null);
  assert.equal(pane._challenges.length, 1);
});

test('an open detail page takes the fresh row onto the object it was opened with', async () => {
  const { pane, live, server, settle } = loadPane();
  pane.open();
  await settle();
  const opened = pane._challenges[0];
  pane._detailChallenge = opened;
  server.credits = 2;
  await live.fire();
  await settle();
  assert.equal(pane._detailChallenge, opened, 'same object: the breakdown read stays fenced on it');
  assert.equal(opened.progress.current, 2);
  assert.equal(pane._challenges[0], opened, 'and the grid holds that same object');
});

test('an older read of your own rows that lands late does not undo a newer one', async () => {
  const { pane, live, server, settle } = loadPane();
  let release;
  server.holdMine = new Promise((r) => { release = r; });
  pane.open();
  await settle();
  // The first read of your own rows is still out, holding the old answer.
  server.holdMine = null;
  server.credits = 3;
  await live.fire();
  await settle();
  assert.equal(pane._mine.get(1).points, 300);
  release();
  await settle();
  assert.equal(pane._mine.get(1).points, 300, 'the late, older answer is dropped');
});

test('the Leaderboard\'s pull and the worker\'s correction read the tab fresh', () => {
  assert.match(APP_JS, /TopochainChallenges\.loadChallenges\(\{ fresh: true \}\)/);
});

// ── Home's Challenges block ───────────────────────────────────────────────

function loadPanels({ homeVisible = true } = {}) {
  const live = fakeLiveReads();
  const reads = [];
  const sandbox = {
    console, setTimeout, clearTimeout, URLSearchParams,
    location: { search: '', hash: '' },
    App: { user: { id: 7 }, _announceRefreshIntent() {}, _isScreenVisible: (id) => id === 'home-screen' && homeVisible },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    UsernodeReact: { liveReads: live },
    fetch: async (url, init) => {
      reads.push({ url: String(url), cache: init && init.cache });
      return { ok: true, json: async () => ({ registry: [], hidden: [], panels: [] }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.PlatformI18n = englishPlatformI18n();
  installPanelsStore(sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.__HP = HomePanels;`, sandbox);
  const HP = sandbox.__HP;
  HP.render = () => {};
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
      const pending = HP._queued || HP._inflight;
      if (pending) await pending;
      await new Promise((r) => setImmediate(r));
    }
  };
  return { HP, live, reads, settle };
}

test('Home\'s block re-reads fresh on a live re-read, inside its minute', async () => {
  const { HP, live, reads, settle } = loadPanels();
  await HP.ensureLoaded();
  await settle();
  assert.equal(live.watchers.size, 1, 'the first read registers the watcher');
  assert.deepEqual(reads.map((r) => r.cache), [undefined], 'an ordinary first read');
  await HP.ensureLoaded();
  assert.equal(reads.length, 1, 'inside the minute an ordinary call reads nothing');

  await live.fire();
  await settle();
  assert.deepEqual(reads.map((r) => r.cache), [undefined, 'no-cache']);
});

test('the worker\'s correction of /api/home-panels reaches the block inside its minute', async () => {
  const { HP, live, reads, settle } = loadPanels();
  await HP.ensureLoaded();
  await settle();
  await live.correct('http://localhost/api/apps');
  await settle();
  assert.equal(reads.length, 1, 'a correction of another read is not the block\'s');
  await live.correct('http://localhost/api/home-panels');
  await settle();
  assert.deepEqual(reads.map((r) => r.cache), [undefined, 'no-cache']);
});

test('coming back to Home from another screen reads the block again', () => {
  const fn = APP_JS.slice(APP_JS.indexOf('  navigateHome(opts) {'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.match(body, /const returning = !App\._isScreenVisible\('home-screen'\);/);
  assert.match(body, /if \(returning && window\.HomePanels\?\._data\) HomePanels\.ensureLoaded\(\{ force: true \}\);\s*Home\.load\(\);/);
});

test('Home\'s block reads nothing on a live re-read while Home is not on screen', async () => {
  const { HP, live, reads, settle } = loadPanels({ homeVisible: false });
  await HP.ensureLoaded();
  await settle();
  await live.fire();
  await settle();
  assert.equal(reads.length, 1);
});

test('a fresh forced read queued behind one in flight stays fresh', async () => {
  const { HP, reads, settle } = loadPanels();
  HP.ensureLoaded();
  HP.ensureLoaded({ force: true, fresh: true });
  await settle();
  assert.deepEqual(reads.map((r) => r.cache), [undefined, 'no-cache']);
});

test('Home\'s pull reads the block again, fresh, past its minute', () => {
  const pull = APP_JS.slice(APP_JS.indexOf('_wirePullToRefresh() {'), APP_JS.indexOf('const browse = document.getElementById(\'browse-screen\')'));
  // Request 6500 adds the tiles' vote-count read to the same Promise.all; the
  // block's forced read and Home.load() still compose it, and the spinner
  // still waits for them.
  assert.match(pull, /Promise\.all\(\[\s*window\.HomePanels\?\.ensureLoaded\?\.\(\{ force: true, fresh: true \}\),\s*(?:window\.UsernodeReact\?\.homePins\?\.refresh\?\.\(\{ force: true \}\),\s*)?Home\.load\(\),/,
    'and the pull waits for that read, so the spinner stops on the new numbers');
});
