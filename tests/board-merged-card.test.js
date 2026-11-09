'use strict';

// #5233: a proposal that has merged must leave the board's Waiting for
// approval column as soon as the merge lands, without a manual reload. The
// server's open-proposals list already excludes merged rows, so the
// lingering card is stale cache: App.handleVoteUpdate hands the WS event to
// AppView.noteSessionMerged, which patches the cached row's status and —
// while the board is not the surface showing — re-reads the board's
// proposals + merged parts in the background, so the row is under Done when
// the board next paints.
//
// The wiring test slices handleVoteUpdate out of app.js the way
// live-refresh-burst does; the helper's own behaviour runs the real
// app-view.js in a vm sandbox the way dev-kanban-buckets does.
//
// Run with: node --test tests/board-merged-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const APP_VIEW_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function sliceMember(src, signature) {
  const start = src.indexOf(`\n  ${signature}`);
  assert.ok(start >= 0, `${signature} is defined`);
  const close = '\n  },';
  const end = src.indexOf(close, start);
  return src.slice(start + 1, end + close.length);
}

// deepStrictEqual compares realm prototypes; the burst's args are built in
// the vm, so copy the values into host-realm arrays and objects first.
const normCall = (c) => [c[0], c[1], { ...c[2] }];

// ── handleVoteUpdate routes the merge to noteSessionMerged ─────────────────

function makeAppCtx({ currentTab = 'dev', currentSubTab = 'topic' } = {}) {
  const sandbox = {
    console,
    Promise,
    JSON,
    AppView: {
      noteSessionMerged: (id, slug, opts) => { sandbox.nsmCalls.push([id, slug, { ...opts }]); return true; },
      recheckFirstVersionNow: () => null,
      renderAppTab: () => {},
    },
    nsmCalls: [],
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `var calls = []; var App = { currentApp: 'demo', currentTab: ${JSON.stringify(currentTab)},`
    + ` currentSubTab: ${JSON.stringify(currentSubTab)}, _liveRefresh: (kind, ids, opts) => { calls.push([kind, ids, JSON.parse(JSON.stringify(opts))]); },\n`
    + `${sliceMember(APP_JS, 'handleVoteUpdate(data) {')}\n};`
    + 'globalThis.__App = App; globalThis.__calls = calls;',
    sandbox
  );
  return { App: sandbox.__App, calls: sandbox.__calls, nsmCalls: sandbox.nsmCalls };
}

test('handleVoteUpdate with merged: true hands the row to noteSessionMerged', () => {
  const h = makeAppCtx();
  h.App.handleVoteUpdate({ sessionId: 7, appSlug: 'demo', merged: true });
  assert.deepEqual(h.nsmCalls, [[7, 'demo', { live: false }]],
    'the merge is patched before the burst refresh reads');
  assert.deepEqual(Array.from(h.calls, normCall), [['vote', 7, { appSlug: 'demo', merged: true, home: true }]],
    'the burst still runs as before');
});

test('#6490: a live merge tells the helper production now runs it', () => {
  const h = makeAppCtx();
  h.App.handleVoteUpdate({ sessionId: 7, appSlug: 'demo', merged: true, live: true });
  assert.deepEqual(h.nsmCalls, [[7, 'demo', { live: true }]]);
});

test('the hand-off runs whatever tab is showing, and even when the app is not the current one', () => {
  for (const [currentTab, currentSubTab] of [['app', null], ['home', null], ['dev', 'forum']]) {
    const h = makeAppCtx({ currentTab, currentSubTab });
    h.App.handleVoteUpdate({ sessionId: 7, appSlug: 'other', merged: true });
    assert.deepEqual(h.nsmCalls, [[7, 'other', { live: false }]], `${currentTab}/${currentSubTab}: helper still called`);
    assert.deepEqual(Array.from(h.calls, normCall), [['vote', 7, { appSlug: 'other', merged: true, home: true }]]);
  }
});

test('a vote without merged does not reach noteSessionMerged', () => {
  const h = makeAppCtx();
  h.App.handleVoteUpdate({ sessionId: 7, appSlug: 'demo', merged: false });
  assert.deepEqual(h.nsmCalls, [], 'only merges patch the lists');
  h.App.handleVoteUpdate({ sessionId: 7, appSlug: 'demo' });
  assert.deepEqual(h.nsmCalls, [], 'an event without the flag at all either');
});

// ── noteSessionMerged, against the real app-view.js ────────────────────────

function makeViewCtx({ currentTab = 'dev', currentSubTab = 'topic' } = {}) {
  const events = [];
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentTab, currentSubTab },
    Kudos: { renderButton: () => '', attach: () => {} },
    CustomEvent: class {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    dispatchEvent: (event) => { events.push(event.detail); return true; },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  const loads = [];
  // The opts object is built inside the vm realm; normalise it so
  // deepStrictEqual compares values, not realm prototypes.
  AppView._loadDevData = (opts) => {
    loads.push(opts && JSON.parse(JSON.stringify(opts)));
    return Promise.resolve(true);
  };
  return { AppView, loads, events };
}

function stage(over) {
  const o = over || {};
  const ctx = makeViewCtx({ currentTab: o.currentTab, currentSubTab: o.currentSubTab });
  ctx.AppView.appData = { slug: 'demo' };
  ctx.AppView._devDataSlug = o.listsFor || 'demo';
  ctx.AppView._devDataReady = o.ready !== false;
  ctx.AppView._proposals = o.held === false
    ? []
    : [{ id: 7, pr_number: 70, pr_title: 'PR 7', status: o.status || 'promoted', linked_issues: [] }];
  ctx.AppView._mySessions = o.my || [];
  ctx.AppView._sharedSessions = o.shared || [];
  ctx.AppView._merged = o.mergedRows || [];
  ctx.AppView._topicProposal = o.topic || null;
  return ctx;
}

test('a proposal page up: the held row stops counting as open and the parts re-read in the background', () => {
  const { AppView, loads } = stage({ currentTab: 'dev', currentSubTab: 'topic' });
  assert.equal(AppView.noteSessionMerged(7, 'demo'), true);
  assert.equal(AppView._proposals[0].status, 'merged', 'the cached row is patched');
  assert.deepEqual(loads, [{ fresh: true, parts: ['promoted', 'merged'] }],
    'one background partial load, proposals + merged together');
});

test('a merging row is patched too (the merge has landed, not merely started)', () => {
  const { AppView } = stage({ status: 'merging' });
  AppView.noteSessionMerged(7, 'demo');
  assert.equal(AppView._proposals[0].status, 'merged');
});

test('on the board itself the helper patches but starts no load of its own', () => {
  const { AppView, loads } = stage({ currentTab: 'dev', currentSubTab: 'forum' });
  AppView.noteSessionMerged(7, 'demo');
  assert.equal(AppView._proposals[0].status, 'merged', 'the patch still lands');
  assert.deepEqual(loads, [], 'the burst’s own refresh covers the board showing live');
});

test('lists for another app: nothing patched, nothing fetched', () => {
  const { AppView, loads } = stage({ listsFor: 'demo' });
  assert.equal(AppView.noteSessionMerged(7, 'other'), false);
  assert.equal(AppView._proposals[0].status, 'promoted', 'the cached row is untouched');
  assert.deepEqual(loads, []);
});

test('no whole load yet (_devDataReady false): patched only, no partial load', () => {
  const { AppView, loads } = stage({ ready: false });
  assert.equal(AppView.noteSessionMerged(7, 'demo'), false);
  assert.equal(AppView._proposals[0].status, 'merged');
  assert.deepEqual(loads, []);
});

test('off the dev tab the background load still runs (caches only, no repaint)', () => {
  const { AppView, loads } = stage({ currentTab: 'app', currentSubTab: null });
  assert.equal(AppView.noteSessionMerged(7, 'demo'), true);
  assert.equal(AppView._proposals[0].status, 'merged');
  assert.deepEqual(loads, [{ fresh: true, parts: ['promoted', 'merged'] }]);
});

test('a row the lists do not hold leaves nothing to patch', () => {
  const { AppView, loads } = stage({ held: false });
  assert.equal(AppView.noteSessionMerged(7, 'demo'), true);
  assert.deepEqual(loads, [{ fresh: true, parts: ['promoted', 'merged'] }],
    'the board’s own reload keeps Done current');
});

// ── #6490: every cached copy leaves "Up for a vote" ────────────────────────

test('#6490: the viewer’s own row, a shared row and the open topic row are patched too', () => {
  const my = { id: 7, status: 'promoted', live_at: '2026-11-09T00:00:00Z' };
  const shared = { id: 7, status: 'merging' };
  const topic = { id: 7, status: 'promoted' };
  const { AppView, events } = stage({ held: false, my: [my], shared: [shared], topic });
  assert.equal(AppView.noteSessionMerged(7, 'demo'), true);
  for (const row of [my, shared, topic]) {
    assert.equal(row.status, 'merged', 'the row stops counting as open');
    assert.equal(row.live_at, null, 'not live yet: a missing field would read ✓ Live');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{ id: 7, patch: { status: 'merged', live_at: null } }],
    'the change page and the request page’s section hear the same patch');
});

test('#6490: a live merge fills an empty live_at and keeps one it already had', () => {
  const my = { id: 7, status: 'merged', live_at: null };
  const shared = { id: 7, status: 'merged', live_at: '2026-11-01T00:00:00Z' };
  const { AppView, events } = stage({ held: false, my: [my], shared: [shared] });
  assert.equal(AppView.noteSessionMerged(7, 'demo', { live: true }), true);
  assert.ok(my.live_at, 'the empty live_at is filled');
  assert.equal(shared.live_at, '2026-11-01T00:00:00Z', 'a known live_at is kept');
  assert.equal(events.length, 1, 'the open page is told once');
  assert.equal(events[0].patch.status, 'merged');
  assert.ok(events[0].patch.live_at, 'and that it is live');
});

test('#6490: a closed row is left alone, and nothing is told', () => {
  const closed = { id: 7, status: 'closed' };
  const { AppView, events, loads } = stage({ held: false, my: [closed] });
  assert.equal(AppView.noteSessionMerged(7, 'demo'), true);
  assert.equal(closed.status, 'closed', 'a settled change does not flip');
  assert.deepEqual(events, []);
  assert.deepEqual(loads, [{ fresh: true, parts: ['promoted', 'merged'] }],
    'the board reload still lands');
});

test('#6490: a second merged event for a row already merged tells nothing', () => {
  const row = { id: 7, status: 'merged', live_at: '2026-11-01T00:00:00Z' };
  const { AppView, events } = stage({ held: false, my: [row] });
  AppView.noteSessionMerged(7, 'demo');
  assert.equal(row.live_at, '2026-11-01T00:00:00Z', 'production’s own live_at stands');
  assert.deepEqual(events, [], 'no second patch');
});

// ── #6490: a merge heard as a plain session update ─────────────────────────

function makeSessionCtx() {
  const sandbox = {
    console,
    Promise,
    JSON,
    AppView: {
      noteSessionMerged: (id, slug, opts) => { sandbox.nsmCalls.push([id, slug, { ...opts }]); return true; },
    },
    nsmCalls: [],
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `var calls = []; var App = { currentApp: 'demo', currentTab: 'dev', currentSubTab: 'topic',`
    + ` _liveRefresh: (kind, ids, opts) => { calls.push([kind, ids, JSON.parse(JSON.stringify(opts))]); },\n`
    + `${sliceMember(APP_JS, 'handleSessionUpdate(data) {')}\n};`
    + 'globalThis.__App = App; globalThis.__calls = calls;',
    sandbox
  );
  return { App: sandbox.__App, calls: sandbox.__calls, nsmCalls: sandbox.nsmCalls };
}

test('#6490: a session update saying the change merged patches the same caches', () => {
  for (const payload of [{ merged: true }, { status: 'merged' }]) {
    const h = makeSessionCtx();
    h.App.handleSessionUpdate({ sessionId: 7, appSlug: 'demo', ...payload });
    assert.deepEqual(h.nsmCalls, [[7, 'demo', { live: false }]], `${JSON.stringify(payload)} patches`);
    assert.deepEqual(Array.from(h.calls, normCall), [['session', 7, { appSlug: 'demo', home: true }]],
      'the burst still runs as before');
  }
});

test('#6490: an ordinary session update does not reach the merge helper', () => {
  const h = makeSessionCtx();
  h.App.handleSessionUpdate({ sessionId: 7, appSlug: 'demo' });
  assert.deepEqual(h.nsmCalls, [], 'only a merge patches the lists');
  assert.deepEqual(Array.from(h.calls, normCall), [['session', 7, { appSlug: 'demo', home: true }]]);
});

// ── #6490: the change page re-derives its pill ─────────────────────────────

test('#6490: a change page whose card was drawn before the merge steps past the open-vote pill', () => {
  const { AppView } = stage({ status: 'merged' });
  // Only the drawing helpers around the pill are faked; the real
  // statusPillState and _changeThreadView/_changeVotesView run.
  AppView._placedCategoryFor = () => null;
  AppView._categoryMeta = () => null;
  AppView.externalAgentProduct = () => null;
  AppView._changeTestingView = () => ({});
  AppView._changeShotsView = () => null;
  AppView._kudosOffered = () => false;
  AppView._codeMissing = () => false;
  AppView._stackedView = () => ({});
  AppView._voteRoster = {};
  const card = { pill: { state: { key: 'needs_vote', label: 'Up for a vote', tone: 'violet', yes: 1, majority: 2 } } };
  const item = {
    id: 7, status: 'merged', live_at: null, deployment_state: null, check_state: 'passing',
    category: { top: 'ui' }, yes_count: 1, votes_required: 2,
  };
  const goingLive = AppView._changeThreadView('proposal', item, card, { hero: {} });
  assert.equal(goingLive.status.key, 'deploying', 'the row’s status, not the card’s stale pill');
  assert.match(goingLive.status.label, /Going live/);

  item.live_at = '2026-11-09T00:00:00Z';
  const live = AppView._changeThreadView('proposal', item, card, { hero: {} });
  assert.notEqual(live.status.key, 'needs_vote', 'the open-vote pill is gone once production runs it');
  assert.match(live.status.label, /Live/);
});

