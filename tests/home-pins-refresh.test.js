'use strict';

// Request 6500: Home's community tiles kept a vote count they read at sign-in.
// A soft refresh (a pull, or coming back to Home) never re-read it, and a
// counts read that failed zeroed it, so the number sat at 0 until a hard
// reload. This suite runs the real store (`home-pins-store.ts`) against a
// stubbed `fetch` and pins the refresh paths:
//
//   1. the counts read asks the network for the current numbers (no-cache);
//   2. a refresh that lands while a read is running queues exactly ONE more,
//      shared by every caller, and the store ends on the newer number;
//   3. a failed counts read keeps the number already on the tiles;
//   4. signed out, a refresh reads nothing;
//   5. `force` reaches the community scope, which fills the Needs you total;
//   6. `wireHomePins` publishes the legacy bridge and removes it on cleanup.
//
// The community scope's own forced read is run against the real module at the
// bottom: an unforced read keeps its cache, a forced one asks the network.
//
// Run with: node --test tests/home-pins-refresh.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const STORE = 'frontend/src/features/home/home-pins-store.ts';
const SCOPE = 'frontend/src/features/workshop/community-scope.ts';
const CARDS = 'frontend/src/features/dev-board/card/cards-store.ts';
const SEEN = 'frontend/src/features/workshop/needs-seen.ts';

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A browser's worth of what these modules look for. */
function fakeWindow({ user = { id: 1 } } = {}) {
  globalThis.window = {
    App: user ? { user } : {},
    UsernodeReact: undefined,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '' },
    addEventListener() {},
    removeEventListener() {},
  };
}

/** Only the bridge test needs a document to wire the membership events. */
function fakeDocument() {
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
  };
}

test.afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.fetch;
});

/** The real store, with the scope it calls replaced (its own test is below). */
function loadStore(scope = { loadCommunities: async () => {} }) {
  return loadTsx(STORE, { stubs: { '../workshop/community-scope': scope } });
}

/** `fetch` answering every endpoint, recording the call and its init. */
function fakeServer(overrides = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init: init || {} });
    const handler = overrides[u];
    if (handler) return handler(u);
    const body = u === '/api/me/home-pins' ? { pins: [] }
      : u === '/api/apps?scope=joined' ? { apps: [] }
        : { counts: {} };
    return { ok: true, json: async () => body };
  };
  return calls;
}

test('the counts read asks the network, never a copy saved on the device', async () => {
  fakeWindow();
  const calls = fakeServer();
  const store = loadStore();
  await store.loadHomePins();
  const counts = calls.filter((c) => c.url === '/api/workshop/counts');
  assert.equal(counts.length, 1);
  assert.equal(counts[0].init.cache, 'no-cache');
  assert.equal(counts[0].init.credentials, 'same-origin');
});

test('a refresh during a read queues ONE more, and the tiles end on the newer number', async () => {
  fakeWindow();
  const calls = [];
  globalThis.fetch = (url) => new Promise((resolve) => { calls.push({ url: String(url), resolve }); });
  const store = loadStore();

  const first = store.refreshHomePins();
  await tick();
  assert.equal(calls.length, 3, 'the pins, the joined list and the counts');

  // Two callers in the running read's window share one queued read.
  const q1 = store.loadHomePins();
  const q2 = store.loadHomePins();
  assert.equal(q1, q2, 'the queued load is shared, as Home.load shares its own');

  const settle = (needs) => {
    for (const c of calls.splice(0)) {
      const body = c.url === '/api/me/home-pins' ? { pins: [] }
        : c.url === '/api/apps?scope=joined' ? { apps: [] }
          : { counts: { a: { needs } } };
      c.resolve({ ok: true, json: async () => body });
    }
  };

  settle(1);
  await first;
  await tick();
  assert.equal(calls.length, 3, 'exactly one more read, not one per caller');
  settle(2);
  await q1;
  assert.equal(store.homePinsStore.get().owed.a, 2, 'the refresh ends on the newer answer');
});

test('a failed counts read keeps the number already on the tiles', async () => {
  fakeWindow();
  let failing = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/workshop/counts' && failing) throw new Error('offline');
    const body = u === '/api/me/home-pins' ? { pins: [] }
      : u === '/api/apps?scope=joined' ? { apps: [] }
        : { counts: { a: { needs: 4 } } };
    return { ok: true, json: async () => body };
  };
  const store = loadStore();
  await store.loadHomePins();
  assert.equal(store.homePinsStore.get().owed.a, 4);

  failing = true;
  await store.loadHomePins();
  assert.equal(store.homePinsStore.get().owed.a, 4, 'the failed read does not drop the number to zero');
});

test('signed out, a refresh reads nothing', async () => {
  fakeWindow({ user: null });
  const calls = fakeServer();
  const store = loadStore();
  await store.refreshHomePins({ force: true });
  assert.equal(calls.length, 0);
});

test('a refresh reads the pins and passes force on to the community scope', async () => {
  fakeWindow();
  const seen = [];
  const scope = { loadCommunities: async (force) => { seen.push(force); } };
  const calls = fakeServer();
  const store = loadStore(scope);

  await store.refreshHomePins();
  assert.deepEqual(seen, [false], 'coming back to Home goes through the quiet read');
  assert.ok(calls.some((c) => c.url === '/api/me/home-pins'), 'and the pins store re-reads');

  await store.refreshHomePins({ force: true });
  assert.deepEqual(seen, [false, true], 'a pull skips the thirty-second wait');
});

test('wireHomePins publishes the refresh for the legacy screens and removes it', () => {
  fakeWindow();
  fakeDocument();
  const store = loadStore();
  const unwire = store.wireHomePins();
  assert.equal(typeof globalThis.window.UsernodeReact.homePins.refresh, 'function');
  unwire();
  assert.equal(globalThis.window.UsernodeReact.homePins, undefined);
});

test('Home re-reads on every load, and a pull forces the read', () => {
  const home = read('frontend/src/features/home/home.js');
  assert.match(home, /if \(App\.user\) window\.UsernodeReact\?\.homePins\?\.refresh\?\.\(\);/,
    'Home._loadOnce re-reads the tiles on every visit and correction');
  const app = read('public/js/app.js');
  assert.match(app, /window\.UsernodeReact\?\.homePins\?\.refresh\?\.\(\{ force: true \}\)/,
    'the Home pull passes force');
});

test('the community scope asks for a fresh counts answer when forced', async () => {
  fakeWindow();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const body = String(url).startsWith('/api/workshop/counts') ? { counts: {} } : { apps: [] };
    return { ok: true, json: async () => body };
  };
  const scope = loadTsx(SCOPE, {
    stubs: {
      '../dev-board/card/cards-store': loadTsx(CARDS),
      './needs-seen': loadTsx(SEEN),
    },
  });

  await scope.loadCommunities();
  const unforced = calls.find((c) => c.url.startsWith('/api/workshop/counts'));
  assert.equal(unforced.init.cache, undefined, 'the quiet read keeps its own cache');

  calls.length = 0;
  await scope.loadCommunities(true);
  const forced = calls.find((c) => c.url.startsWith('/api/workshop/counts'));
  assert.ok(forced, 'force skips the thirty-second wait');
  assert.equal(forced.init.cache, 'no-cache');
});
