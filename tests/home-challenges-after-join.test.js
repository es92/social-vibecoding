// Joining a community ticks "Join a community" on Home at once, not only on
// the Challenges tab (first-session run-through, 5 October 2026, item 16).
//
// The server counts the join before it answers (POST /api/apps/:slug/
// membership awaits challengeScorer.scoreOnJoin). The Challenges tab reads
// afresh each time it opens, so it showed the tick; Home's Challenges block
// kept its copy of GET /api/home-panels for a minute (HomePanels.TTL_MS) and
// still said Not started. Now:
//
//   * Home.setMembership, the one in-app join and leave, says so on
//     `document` once the write lands (`sv:membership-changed`, the
//     `sv:tour-done` pattern), and says nothing when it is refused;
//   * HomePanels listens (and to the join screen's `sv:communities-joined`)
//     and reads again, forced, past its minute;
//   * a forced read is a refresh, not a boot: it tells the service worker
//     first (App._announceRefreshIntent), so the worker's zero-deadline lane
//     does not hand back the cached copy, and it does not share a read that
//     left before the join; it reads again once that one settles.
//
// home.js and home-panels.js run together in one vm context, with a real
// EventTarget for `document`, so the event Home sends is the one the block
// hears.
//
// #4600: the same goes for a join from Home's featured list. Its ⊕ is
// Home.toggleAdded, a PIN (POST /api/apps/:slug/favorite), which joins
// through the app_favorites trigger; the route now counts that join on the
// spot and answers `joined: true`, and toggleAdded says so on `document` as
// setMembership does. A pin of something already joined says nothing.
//
// Run with: node --test tests/home-challenges-after-join.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { HOME_SRC, PANELS_SRC } = require('./helpers/home-modules');
const { installPanelsStore } = require('./helpers/home-grid-store');

const JOIN_ID = 41;

// GET /api/home-panels with the First challenges' "Join a community" in it,
// done or not.
function panelsPayload(joined) {
  return {
    registry: [{ key: 'challenges', title: 'Challenges', removable: false }],
    hidden: [],
    panels: [{
      key: 'challenges',
      title: 'Challenges',
      season: { id: 2, name: 'Season 2' },
      total: 1,
      done: joined ? 1 : 0,
      points_remaining: joined ? 0 : 500,
      challenges: [{
        id: JOIN_ID,
        label: 'First challenges',
        goal: 'Join a community',
        task: 'Find people to build with.',
        reward: '500 pts',
        cta: null,
        metric: null,
        progress: { done: joined, current: null, target: null },
        earned_points: joined ? 500 : 0,
      }],
    }],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// `holdPanels`: GET /api/home-panels waits until the test lets it answer.
function makeHome({ joinOk = true, holdPanels = false } = {}) {
  const bus = new EventTarget();
  // One ordered log of what reached the network and the service worker.
  const log = [];
  const server = { joined: false };
  const held = [];
  const events = [];
  const sandbox = {
    console,
    App: {
      user: { id: 7 },
      _announceRefreshIntent: () => log.push('refresh-intent'),
    },
    PlatformUI: { toast: () => {} },
    ConfirmModal: { show: async () => true },
    document: {
      addEventListener: bus.addEventListener.bind(bus),
      removeEventListener: bus.removeEventListener.bind(bus),
      dispatchEvent: bus.dispatchEvent.bind(bus),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    CustomEvent,
    fetch: async (url, init = {}) => {
      const method = init.method || 'GET';
      log.push(`${method} ${url}`);
      if (/\/membership$/.test(url)) {
        if (!joinOk) return { ok: false, status: 500, json: async () => ({ error: 'Internal server error' }) };
        // The route counts "Join a community" before it answers.
        const body = JSON.parse(init.body);
        if (body.joined) server.joined = true;
        return { ok: true, status: 200, json: async () => ({ ok: true, member_count: 3 }) };
      }
      if (/\/favorite$/.test(url)) {
        if (!joinOk) return { ok: false, status: 500, json: async () => ({ error: 'Internal server error' }) };
        // #4600: a pin joins (the app_favorites trigger), the route counts
        // it before it answers, and says whether this pin was the join.
        const body = JSON.parse(init.body);
        const joined = body.favorited && !server.joined;
        if (body.favorited) server.joined = true;
        return { ok: true, status: 200, json: async () => ({ ok: true, is_favorited: body.favorited, joined }) };
      }
      if (url.startsWith('/api/home-panels')) {
        const answer = panelsPayload(server.joined);
        if (holdPanels) {
          const gate = deferred();
          held.push(gate);
          await gate.promise;
        }
        return { ok: true, status: 200, json: async () => answer };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    setTimeout, clearTimeout,
    URLSearchParams,
    location: { search: '', hash: '' },
    Date,
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  installPanelsStore(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.__HP = HomePanels;`, sandbox);
  const Home = sandbox.__Home;
  const HP = sandbox.__HP;
  // The launcher's own paint and catalog load are not under test: count them.
  const counts = { render: 0, load: 0 };
  Home.render = () => { counts.render += 1; };
  Home.load = async () => { counts.load += 1; };
  bus.addEventListener('sv:membership-changed', (e) => events.push(e.detail));

  // Home has drawn the block once, a moment ago: inside its minute.
  HP._data = panelsPayload(false);
  HP._fetchedAt = Date.now();
  HP.render();

  const joinCard = () => {
    const view = sandbox.panelsStore.get().challenges;
    return view && view.rows.find((r) => r.id === String(JOIN_ID));
  };
  // Wait for every read the block has started or queued.
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
      const pending = HP._queued || HP._inflight;
      if (pending) await pending;
      await new Promise((r) => setImmediate(r));
    }
  };
  return { Home, HP, sandbox, bus, log, server, held, events, counts, joinCard, settle };
}

const panelReads = (log) => log.filter((l) => l.startsWith('GET /api/home-panels'));

test('a join ticks "Join a community" on Home at once, inside the block\'s minute', async () => {
  const h = makeHome();
  assert.equal(h.joinCard().done, false);
  assert.equal(h.joinCard().stateLabel, 'Not started');

  assert.equal(await h.Home.setMembership('garden', true, undefined, { name: 'City garden' }), true);
  await h.settle();

  assert.deepEqual(h.log, [
    'POST /api/apps/garden/membership',
    'refresh-intent',
    'GET /api/home-panels',
  ], 'the block reads again after the join answered, and tells the worker first');
  assert.equal(h.joinCard().done, true);
  assert.equal(h.joinCard().state, 'done');
  assert.equal(h.joinCard().earned, 'Earned 500 pts');
});

test('the join says so on document once it lands: sv:membership-changed, with the slug', async () => {
  const h = makeHome();
  await h.Home.setMembership('garden', true);
  assert.equal(h.Home.MEMBERSHIP_EVENT, 'sv:membership-changed');
  assert.deepEqual(h.events.map((d) => ({ ...d })), [{ slug: 'garden', joined: true }]);
});

test('a leave reads again the same way', async () => {
  const h = makeHome();
  h.Home._apps = [{ slug: 'garden', name: 'City garden', is_member: true, is_favorited: true }];
  assert.equal(await h.Home.setMembership('garden', false), true, 'confirmed in the dialog');
  await h.settle();
  assert.deepEqual(h.events.map((d) => ({ ...d })), [{ slug: 'garden', joined: false }]);
  assert.deepEqual(h.log, [
    'POST /api/apps/garden/membership',
    'refresh-intent',
    'GET /api/home-panels',
  ]);
});

test('a refused join says nothing and the block is not read again for it', async () => {
  const h = makeHome({ joinOk: false });
  assert.equal(await h.Home.setMembership('garden', true), false);
  await h.settle();
  assert.deepEqual(h.events, []);
  assert.deepEqual(panelReads(h.log), []);
  assert.equal(h.counts.load, 1, 'Home re-syncs the grid as before');
  assert.equal(h.joinCard().done, false);
});

test('the join screen\'s sv:communities-joined reads the block again too', async () => {
  const h = makeHome();
  h.server.joined = true;
  h.sandbox.document.dispatchEvent(new CustomEvent('sv:communities-joined', { detail: { joined: ['garden'] } }));
  await h.settle();
  assert.deepEqual(panelReads(h.log), ['GET /api/home-panels']);
  assert.equal(h.joinCard().done, true);
});

test('before the block\'s first read a join reads nothing extra: Home\'s first load brings it', async () => {
  const h = makeHome();
  h.HP._data = null;
  h.HP._fetchedAt = 0;
  await h.Home.setMembership('garden', true);
  await h.settle();
  assert.deepEqual(panelReads(h.log), []);
});

test('an ordinary read inside the minute still reads nothing: only a forced one goes', async () => {
  const h = makeHome();
  await h.HP.ensureLoaded();
  assert.deepEqual(h.log, [], 'the TTL holds for Home.load()\'s dozen callers');
  await h.HP.ensureLoaded({ force: true });
  assert.deepEqual(h.log, ['refresh-intent', 'GET /api/home-panels']);
});

test('a forced read does not share a read that left before the join: it reads again, once', async () => {
  const h = makeHome({ holdPanels: true });
  // A read left before the join (a Home.load() after the minute, say).
  h.HP._fetchedAt = 0;
  const early = h.HP.ensureLoaded();
  assert.equal(h.held.length, 1);
  assert.equal(h.HP.ensureLoaded(), h.HP._inflight, 'an ordinary caller shares it, as before');

  // The join lands while it is out, and so do two more forced callers.
  await h.Home.setMembership('garden', true);
  const queued = h.HP._queued;
  assert.ok(queued, 'the forced read waits behind the one in flight');
  assert.equal(h.HP.ensureLoaded({ force: true }), queued, 'and later forced callers share it');

  // The early read answers with what the server said before the join.
  h.held[0].resolve();
  await early;
  assert.equal(h.joinCard().done, false, 'the early answer predates the join');

  // Then the queued read goes, and answers with the join counted.
  for (let i = 0; i < 10 && h.held.length < 2; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(h.held.length, 2, 'exactly one more read');
  h.held[1].resolve();
  await h.settle();
  assert.deepEqual(panelReads(h.log), ['GET /api/home-panels', 'GET /api/home-panels']);
  assert.equal(h.joinCard().done, true);
  assert.equal(h.HP._queued, null);
});

test('#4600: a join from Home\'s featured list (a pin) ticks "Join a community" at once too', async () => {
  const h = makeHome();
  h.Home._apps = [{ slug: 'garden', name: 'City garden', is_member: false, is_favorited: false }];
  await h.Home.toggleAdded('garden', true);
  await h.settle();
  assert.deepEqual(h.events.map((d) => ({ ...d })), [{ slug: 'garden', joined: true }]);
  assert.deepEqual(h.log, [
    'POST /api/apps/garden/favorite',
    'refresh-intent',
    'GET /api/home-panels',
  ], 'the block reads again after the pin answered, and tells the worker first');
  assert.equal(h.joinCard().done, true);
});

test('#4600: a pin that joined nothing (already a member) says nothing', async () => {
  const h = makeHome();
  h.server.joined = true;
  h.Home._apps = [{ slug: 'garden', name: 'City garden', is_member: true, is_favorited: false }];
  await h.Home.toggleAdded('garden', true);
  await h.settle();
  assert.deepEqual(h.events, []);
  assert.deepEqual(panelReads(h.log), []);
});

test('#4600: a refused pin says nothing', async () => {
  const h = makeHome({ joinOk: false });
  h.Home._apps = [{ slug: 'garden', name: 'City garden', is_member: false, is_favorited: false }];
  await h.Home.toggleAdded('garden', true);
  await h.settle();
  assert.deepEqual(h.events, []);
  assert.deepEqual(panelReads(h.log), []);
});
