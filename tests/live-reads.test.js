'use strict';

// #4177: one place that re-reads what is on screen after a gap.
//
// The reported case: a proposal opened in a new tab showed an empty
// Discussion. The service worker answered the thread's first page from an
// older saved copy (public/sw.js, API_TIMEOUT_MS), its late correction reached
// a screen loader that deliberately left the thread alone, and the thread
// only loads once. The same shape (read once, then trust the socket) left
// vote rosters, a change page's row and the chat streams wrong after a socket
// drop, a relay gap or a hidden tab.
//
// These tests pin the pieces:
//   1. frontend/src/lib/live-reads.ts: the triggers and who hears them;
//   2. public/sw.js: a re-read waits for the network instead of the copy;
//   3. the relay: a fresh LISTEN tells this server's sockets to re-read;
//   4. public/js/group-chat.js: loaded streams catch up instead of paging back;
//   5. the proposal page: its row, its rosters and app.js's reconnect sweep.
//
// Run with: node --test tests/live-reads.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. The module ─────────────────────────────────────────────────────

const live = () => loadTsx('frontend/src/lib/live-reads.ts');

function install({ hidden = false } = {}) {
  const lr = live();
  lr._resetLiveReads();
  const listeners = { win: new Map(), doc: new Map() };
  const on = (side) => (type, fn) => {
    if (!listeners[side].has(type)) listeners[side].set(type, []);
    listeners[side].get(type).push(fn);
  };
  const win = { location: { origin: 'https://h.test' }, addEventListener: on('win'), UsernodeReact: {} };
  const doc = { visibilityState: hidden ? 'hidden' : 'visible', addEventListener: on('doc') };
  lr.installLiveReads(win, doc);
  const fire = (side, type, event) => {
    for (const fn of listeners[side].get(type) || []) fn(event || {});
  };
  return { lr, win, doc, fire };
}

function recorder() {
  const calls = [];
  const fn = (resync) => { calls.push(resync); };
  fn.calls = calls;
  return fn;
}

test('a reconnect re-reads every watcher, once per pass, with no urls', () => {
  const { lr } = install();
  const a = recorder();
  const b = recorder();
  lr.watch(a);
  lr.watch(b, { reads: () => false });
  lr.resync('reconnect');
  lr.resync('reconnect');
  lr.flush();
  assert.equal(a.calls.length, 1, 'two triggers in one pass are one re-read');
  assert.equal(b.calls.length, 1, 'a watcher with reads still hears an everything-re-read');
  assert.equal(a.calls[0].urls, null);
  assert.equal(a.calls[0].reason, 'reconnect');
});

test('a correction reaches only the watcher that owns the read', () => {
  const { lr, fire } = install();
  const owner = recorder();
  const other = recorder();
  const blind = recorder();
  lr.watch(owner, { reads: (u) => u.pathname === '/api/apps/demo/messages' });
  lr.watch(other, { reads: (u) => u.pathname === '/api/sessions/5/votes' });
  lr.watch(blind);
  fire('win', 'usernode:api-updated', { detail: { url: 'https://h.test/api/apps/demo/messages?limit=50' } });
  lr.flush();
  assert.deepEqual(owner.calls.map((c) => c.urls), [['https://h.test/api/apps/demo/messages?limit=50']]);
  assert.equal(owner.calls[0].reason, 'correction');
  assert.equal(other.calls.length, 0);
  assert.equal(blind.calls.length, 0, 'a watcher that names no reads hears no corrections');
});

test('nothing re-reads while the tab is hidden; it runs when the tab is seen', () => {
  const { lr, doc, fire } = install({ hidden: true });
  const w = recorder();
  lr.watch(w);
  lr.resync('reconnect');
  lr.flush();
  assert.equal(w.calls.length, 0, 'a hidden tab reads nothing');
  doc.visibilityState = 'visible';
  fire('doc', 'visibilitychange');
  lr.flush();
  assert.equal(w.calls.length, 1, 'what was asked for while hidden runs when seen');
});

test('coming back after being away re-reads everything; a glance away does not', () => {
  const { lr, doc, fire } = install();
  const w = recorder();
  lr.watch(w);
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    doc.visibilityState = 'hidden';
    fire('doc', 'visibilitychange');
    now += 5_000;
    doc.visibilityState = 'visible';
    fire('doc', 'visibilitychange');
    lr.flush();
    assert.equal(w.calls.length, 0, 'five seconds away: the sockets were still delivering');

    doc.visibilityState = 'hidden';
    fire('doc', 'visibilitychange');
    now += lr.AWAY_MS;
    doc.visibilityState = 'visible';
    fire('doc', 'visibilitychange');
    lr.flush();
    assert.equal(w.calls.length, 1);
    assert.equal(w.calls[0].reason, 'visible');
    assert.equal(w.calls[0].urls, null);
  } finally {
    Date.now = realNow;
  }
});

test('coming back online re-reads everything', () => {
  const { lr, fire } = install();
  const w = recorder();
  lr.watch(w);
  fire('win', 'online');
  lr.flush();
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].reason, 'online');
});

test('one watcher failing does not stop the others, and unwatch removes one', async () => {
  const { lr } = install();
  const after = recorder();
  lr.watch(() => { throw new Error('boom'); });
  lr.watch(() => Promise.reject(new Error('later boom')));
  const unwatch = lr.watch(recorder());
  lr.watch(after);
  unwatch();
  lr.resync('reconnect');
  lr.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(after.calls.length, 1);
});

test('the bridge is published for the classic scripts, with the fresh init', () => {
  const { win } = install();
  const bridge = win.UsernodeReact.liveReads;
  assert.equal(typeof bridge.watch, 'function');
  assert.equal(typeof bridge.resync, 'function');
  assert.equal(bridge.FRESH.cache, 'no-cache');
  assert.match(read('frontend/src/main.tsx'), /import '\.\/lib\/live-reads';/,
    'the browser entry installs it before DOMContentLoaded');
});

// ── 2. The service worker ─────────────────────────────────────────────

const sw = require('../public/sw.js');

test('a no-cache or reload read asks the worker for the current answer', () => {
  assert.equal(sw.wantsFreshAnswer('no-cache'), true);
  assert.equal(sw.wantsFreshAnswer('reload'), true);
  assert.equal(sw.wantsFreshAnswer('default'), false);
  assert.equal(sw.wantsFreshAnswer(undefined), false);
  const src = read('public/sw.js');
  // Such a read waits for the network far longer than the 1s deadline: the
  // saved copy answers it only on a link that has not answered at all
  // (FRESH_API_TIMEOUT_MS, offline findings 2 Nov 2026), and the late answer
  // still corrects the screen (tests/pwa-offline-cache.test.js).
  assert.match(src, /const fresh = wantsFreshAnswer\(event\.request\.cache\);[\s\S]{0,800}: fresh \? \(laned \? FRESH_BOOT_API_TIMEOUT_MS : FRESH_API_TIMEOUT_MS\)/,
    'networkFirstApi gives such a read the long fresh deadline');
  assert.ok(sw.FRESH_API_TIMEOUT_MS >= 3 * sw.API_TIMEOUT_MS,
    'far longer than the ordinary deadline a working link can lose');
  // A re-pull after a correction is a fresh read now, so it consumes the
  // correction marks they exist to guard (adversarial review).
  assert.match(src, /const settling = awaitingNetwork\.delete\(event\.request\.url\);/);
  assert.match(src, /const laned = !correcting\.delete\(event\.request\.url\)/);
});

test('with no deadline, a slow network answer wins over the saved copy', async () => {
  let scheduled = 0;
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const pending = sw.raceNetworkAndCache({
    startFetch: () => slow,
    matchCache: async () => 'saved copy',
    timeoutMs: null,
    schedule: () => { scheduled++; return () => {}; },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release('network answer');
  const { response, fromCache } = await pending;
  assert.equal(response, 'network answer');
  assert.equal(fromCache, false);
  assert.equal(scheduled, 0, 'no deadline is ever armed');
});

test('with no deadline, the saved copy still answers when the network fails', async () => {
  const { response, fromCache } = await sw.raceNetworkAndCache({
    startFetch: () => Promise.reject(new Error('offline')),
    matchCache: async () => 'saved copy',
    timeoutMs: null,
    schedule: () => () => {},
  });
  assert.equal(response, 'saved copy');
  assert.equal(fromCache, true);
});

// ── 3. The relay ──────────────────────────────────────────────────────

test('each fresh LISTEN nudges this server\'s sockets, rationed and jittered', (t) => {
  const bus = require('../src/services/ws-bus');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let heard = 0;
  bus.start({ pool: null, connectionString: null, onMessage: () => {}, onListening: () => { heard++; } });
  bus._listening();
  t.mock.timers.tick(2_000);
  assert.equal(heard, 1, 'the first re-subscription nudges, within the jitter');
  // A listener flapping once a second: one more nudge covers the next window,
  // at its end, not one per flap (adversarial review: one per ~1s before).
  for (let i = 0; i < 20; i++) { bus._listening(); t.mock.timers.tick(1_000); }
  assert.equal(heard, 1, 'nothing more inside the window');
  t.mock.timers.tick(bus.HINT_MIN_INTERVAL_MS);
  assert.equal(heard, 2, 'one nudge at the end of it covers every flap');
  assert.equal(bus._hintDelay(0, -Infinity, 0), 0);
  assert.equal(bus._hintDelay(10_000, 0, 0), bus.HINT_MIN_INTERVAL_MS - 10_000);
  bus.start({ pool: null, connectionString: null, onMessage: () => {}, onListening: () => { throw new Error('boom'); } });
  bus._listening();
  assert.doesNotThrow(() => t.mock.timers.tick(bus.HINT_MIN_INTERVAL_MS + 2_000));
  const src = read('src/services/ws-bus.js');
  assert.match(src, /await client\.query\(`LISTEN \$\{CHANNEL\}`\);[\s\S]{0,200}_listening\(\);/,
    'the handler runs after every successful LISTEN, reconnects included');
});

test('a fresh LISTEN nudges every events socket and every chat room on this server', () => {
  const src = read('src/services/ws.js');
  assert.match(src, /onListening: _onBusListening,/);
  const fn = src.slice(src.indexOf('function _onBusListening()'), src.indexOf('// The Homeroom bot follows issue activity.'));
  assert.match(fn, /const hint = \{ type: 'resync_hint' \};/);
  assert.match(fn, /deliverGlobal\(hint\);/);
  assert.match(fn, /for \(const appId of rooms\.keys\(\)\) deliverToRoom\(appId, hint\);/);
});

// ── 4. The chat streams ───────────────────────────────────────────────

const gcJs = read('public/js/group-chat.js');

// `onScreen`: the channel's transcript is on the page (markRead needs it).
function loadGroupChat({ fetch, liveReads, onScreen = false, extra = {} } = {}) {
  const el = { scrollHeight: 1000, scrollTop: 0, clientHeight: 500, dataset: {}, querySelector: () => null };
  const document = {
    visibilityState: 'visible',
    createElement: () => ({ style: {} }),
    getElementById: (id) => (onScreen && id === 'gc-messages' ? el : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const window = { matchMedia: () => ({ matches: false }), UsernodeReact: liveReads ? { liveReads } : {} };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost', origin: 'http://localhost' },
    URL, URLSearchParams,
    document,
    window,
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    console,
    fetch: fetch || (async () => ({ ok: true, json: async () => ({ messages: [] }) })),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
    ...extra,
  };
  sandbox.globalThis = sandbox;
  window.App = sandbox.App;
  vm.createContext(sandbox);
  vm.runInContext(`${gcJs}\nglobalThis.__M = { GroupChat };`, sandbox);
  return sandbox.__M.GroupChat;
}

const ids = (list) => Array.from(list, (m) => Number(m.id));
const msg = (id, extra) => ({ id, content: `m${id}`, ...(extra || {}) });

// A read's reconciled answer with the events that arrived meanwhile replayed.
function caughtUp(GroupChat, current, latest, full, { before, events = [], thread = null, root = null } = {}) {
  // `events`: what happened during the read. A new message ({ kind: 'chat', msg })
  // is held by then, as the socket handler holds it; the rest are field events.
  const arrivedIds = new Set(events.filter((e) => e.kind === 'chat').map((e) => String(e.msg.id)));
  const log = events.filter((e) => e.kind !== 'chat');
  log.held = new Set(current.filter((m) => !arrivedIds.has(String(m.id))).map((m) => String(m.id)));
  const held = [...current];
  for (const e of events) if (e.kind === 'chat' && !held.some((m) => String(m.id) === String(e.msg.id))) held.push(e.msg);
  const s = { messages: held, syncedMax: before ?? -Infinity, again: false, stale: true, hasMore: true, oldestId: null, root };
  const next = GroupChat._takeNewest(s, thread, latest, { has_more_before: full }, log);
  return { ...next, messages: s.messages };
}

test('the newest page is the truth from its first id on', () => {
  const GroupChat = loadGroupChat();
  // Held: 1..6, of which 5 was deleted on the server and 4 edited; 9 arrived
  // over the socket while the read was in flight. The page spans 3..8.
  const current = [1, 2, 3, 4, 5, 6, 9].map((id) => msg(id));
  const latest = [msg(3), msg(4, { content: 'edited' }), msg(6), msg(7), msg(8)];
  const { messages, reset, older } = caughtUp(GroupChat, current, latest, true,
    { before: 6, events: [{ kind: 'chat', msg: msg(9) }] });
  assert.equal(reset, false);
  assert.equal(older, 2);
  assert.deepEqual(ids(messages), [1, 2, 3, 4, 6, 7, 8, 9]);
  assert.equal(messages[3].content, 'edited');
});

test('a page that is the whole stream replaces everything held', () => {
  const GroupChat = loadGroupChat();
  const { messages } = caughtUp(GroupChat, [msg(1), msg(2), msg(3)], [msg(2), msg(4)], false, { before: 3 });
  assert.deepEqual(ids(messages), [2, 4], 'message 1 and 3 are gone from the server');
});

test('a gap wider than a page starts the stream over from the newest page', () => {
  const GroupChat = loadGroupChat();
  const { messages, reset } = caughtUp(GroupChat, [msg(1), msg(2)], [msg(60), msg(61)], true, { before: 2 });
  assert.equal(reset, true);
  assert.deepEqual(ids(messages), [60, 61]);
  const unknown = GroupChat._reconcileLatest([msg(1)], [msg(60)], true, {});
  assert.equal(unknown.reset, true, 'an unknown boundary counts as a gap: "Load earlier" recovers it');
});

// ── The review findings on 68127b4d ───────────────────────────────────

test('review 2: a socket edit, delete or reaction during the read outranks its older answer', () => {
  const GroupChat = loadGroupChat();
  const latest = [msg(1, { reactions: [] }), msg(2, { content: 'old' }), msg(3, { content: 'still here' })];
  const { messages } = caughtUp(GroupChat, [msg(1), msg(2), msg(3)], latest, false, { before: 3, events: [
    { kind: 'reaction', id: 1, reactions: [{ emoji: '👍', count: 1 }] },
    { kind: 'edit', id: 2, content: 'new', editedAt: 'now' },
    { kind: 'delete', id: 3 },
  ] });
  assert.equal(messages[0].reactions.length, 1);
  assert.equal(messages[1].content, 'new', 'old → new stays new, not back to old');
  assert.equal(messages[2].deleted, true);
  assert.equal(messages[2].content, '');
});

test('review 2, end to end: an edit that lands during the catch-up survives it', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const GroupChat = loadGroupChat({
    fetch: async () => { await gate; return { ok: true, json: async () => ({ messages: [msg(1), msg(2, { content: 'old' })] }) }; },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat._syncedMax = 2;
  GroupChat.messages = [msg(1), msg(2, { content: 'old' })];
  GroupChat.oldestMessageId = 1;
  const pending = GroupChat._refreshLatest(null);
  GroupChat.handleIncoming({ type: 'chat_edit', messageId: 2, content: 'new', editedAt: 'now' });
  release();
  await pending;
  assert.equal(GroupChat.messages.find((m) => Number(m.id) === 2).content, 'new');
  assert.equal(GroupChat._liveWindows.size, 0, 'the record closes with the read');
});

test('review 3: a message delivered after the gap does not hide it', () => {
  const GroupChat = loadGroupChat();
  // Held [1, 2] before the gap; 110 arrived over the socket during the read;
  // the newest page is 60..109, so 3..59 are missing.
  const page = Array.from({ length: 50 }, (_, i) => msg(60 + i));
  const { messages, reset } = caughtUp(GroupChat, [msg(1), msg(2), msg(110)], page, true,
    { before: 2, events: [{ kind: 'chat', msg: msg(110) }] });
  assert.equal(reset, true, 'the stream starts over, so "Load earlier" pages back from 60');
  assert.deepEqual(ids(messages), [...page.map((m) => m.id), 110]);
});

test('review 3, end to end: the gap is measured from where the stream was known whole', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const page = Array.from({ length: 50 }, (_, i) => msg(60 + i));
  const GroupChat = loadGroupChat({
    fetch: async () => { await gate; return { ok: true, json: async () => ({ messages: page, has_more_before: true }) }; },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat._syncedMax = 2;
  GroupChat.messages = [msg(1), msg(2)];
  GroupChat.oldestMessageId = 1;
  const pending = GroupChat._refreshLatest(null);
  GroupChat.handleIncoming({ type: 'chat', ...msg(110) });
  assert.equal(GroupChat._syncedMax, 2, 'a message past a pending gap proves nothing');
  release();
  await pending;
  assert.equal(GroupChat.oldestMessageId, 60);
  assert.equal(GroupChat.hasMore, true);
  assert.deepEqual(ids(GroupChat.messages).slice(-2), [109, 110]);
  assert.equal(ids(GroupChat.messages)[0], 60);
  assert.equal(GroupChat._syncedMax, 110);
});

test('review 4: a held message the answer lacks is gone, unless it arrived during the read', () => {
  const GroupChat = loadGroupChat();
  // 12 was the newest reply line, deleted on the server; 13 arrived live.
  const { messages } = caughtUp(GroupChat, [msg(10), msg(11), msg(12), msg(13)], [msg(10), msg(11)], false,
    { before: 12, events: [{ kind: 'chat', msg: msg(13) }] });
  assert.deepEqual(ids(messages), [10, 11, 13]);
  const empty = caughtUp(GroupChat, [msg(1), msg(2)], [], false, { before: 2 });
  assert.deepEqual(ids(empty.messages), [], 'an empty whole-stream answer keeps nothing');
});

// ── The review findings on dc7daaef ───────────────────────────────────

test('review 2.1: a reaction during the read keeps the answer\'s newer text', () => {
  const GroupChat = loadGroupChat();
  // The held copy missed an edit; the answer has it; a reaction lands live.
  const { messages } = caughtUp(GroupChat, [msg(4, { content: 'before the edit' })],
    [msg(4, { content: 'after the edit' })], false,
    { before: 4, events: [{ kind: 'reaction', id: 4, reactions: [{ emoji: '🎉', count: 2 }] }] });
  assert.equal(messages[0].content, 'after the edit', 'only the field the event changed is taken');
  assert.equal(messages[0].reactions[0].count, 2);
});

test('review 2.2: an edit or reaction reaches every held copy, so a reply\'s thread copy agrees', () => {
  const GroupChat = loadGroupChat();
  GroupChat.appSlug = 'demo';
  // A reply is held in the general stream and in its reply thread.
  GroupChat.messages = [msg(5, { content: 'old', thread: { type: 'message', ref: 1 } })];
  GroupChat._threadState('message', 1).messages = [msg(5, { content: 'old' })];
  GroupChat.handleIncoming({ type: 'chat_edit', messageId: 5, content: 'new', editedAt: 'now' });
  GroupChat.handleIncoming({ type: 'reaction', messageId: 5, reactions: [{ emoji: '👍', count: 1 }] });
  for (const copy of [GroupChat.messages[0], GroupChat._threadState('message', 1).messages[0]]) {
    assert.equal(copy.content, 'new');
    assert.equal(copy.reactions.length, 1);
  }
});

test('review 2.3: a thread root deleted during the read stays deleted', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const GroupChat = loadGroupChat({
    fetch: async () => {
      await gate;
      return { ok: true, json: async () => ({ messages: [msg(8)], root: msg(3, { content: 'the root' }) }) };
    },
  });
  GroupChat.appSlug = 'demo';
  const st = GroupChat._threadState('message', 3);
  Object.assign(st, { loaded: true, messages: [msg(8)], oldestId: 8, syncedMax: 8, root: msg(3, { content: 'the root' }) });
  GroupChat.activeThread = { type: 'message', ref: 3 };
  const pending = GroupChat._refreshLatest({ type: 'message', ref: 3 });
  GroupChat.handleIncoming({ type: 'chat_delete', id: 3 });
  release();
  await pending;
  assert.equal(st.root.deleted, true);
  assert.equal(st.root.content, '');
});

test('review 2.4: a catch-up queued behind "Load earlier" still sees the gap', async () => {
  const page = Array.from({ length: 50 }, (_, i) => msg(61 + i));
  const GroupChat = loadGroupChat({
    fetch: async () => ({ ok: true, json: async () => ({ messages: page, has_more_before: true }) }),
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat._syncedMax = 2;
  GroupChat.messages = [msg(1), msg(2)];
  GroupChat.oldestMessageId = 1;
  GroupChat._historyLoad = {}; // "Load earlier" on the wire
  GroupChat.resyncLoaded(); // a gap: queued behind it
  assert.equal(GroupChat._latestAgain, true);
  GroupChat.handleIncoming({ type: 'chat', ...msg(110) }); // arrives while queued
  GroupChat._historyLoad = null;
  await GroupChat._refreshLatest(null);
  assert.equal(GroupChat.oldestMessageId, 61, 'started over: the middle is "Load earlier" away');
  assert.equal(GroupChat.hasMore, true);
  assert.equal(ids(GroupChat.messages)[0], 61);
});

test('review 2.5: correcting an empty discussion brings "Load earlier" back', async () => {
  const page = Array.from({ length: 50 }, (_, i) => msg(100 + i));
  const GroupChat = loadGroupChat({
    fetch: async () => ({ ok: true, json: async () => ({ messages: page, has_more_before: true }) }),
  });
  GroupChat.appSlug = 'demo';
  const st = GroupChat._threadState('session', 6284);
  Object.assign(st, { loaded: true, messages: [], hasMore: false, oldestId: null }); // the empty saved copy
  GroupChat.activeThread = { type: 'session', ref: 6284 };
  await GroupChat._refreshLatest({ type: 'session', ref: 6284 });
  assert.equal(st.hasMore, true);
  assert.equal(st.oldestId, 100);
});

test('review 2.6: a failed catch-up stays owed, without retrying in a loop', async () => {
  let calls = 0;
  const GroupChat = loadGroupChat({ fetch: async () => { calls++; throw new Error('offline'); } });
  GroupChat.appSlug = 'demo';
  const st = GroupChat._threadState('session', 9);
  Object.assign(st, { loaded: true, messages: [msg(5)], oldestId: 5, syncedMax: 5 });
  GroupChat.activeThread = { type: 'session', ref: 9 };
  await GroupChat._refreshLatest({ type: 'session', ref: 9 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'no loop');
  assert.equal(st.stale, true, 'remounting the thread catches it up');
  assert.match(gcJs, /else if \(st\.stale && !st\.read\) void GroupChat\._refreshLatest\(\{ type, ref \}\);/);
});

// ── The review finding on f9e297e2 ────────────────────────────────────

const savedCopy = { get: (h) => (h === 'sw-cached-at' ? '1' : null) };
const fresh = { get: () => null };
const wideGapPage = Array.from({ length: 50 }, (_, i) => msg(61 + i));

test('review 3.1: a live message that beats a saved-copy first page does not set the watermark (channel)', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) {
        await gate;
        return { ok: true, headers: savedCopy, json: async () => ({ messages: [msg(1), msg(2)] }) };
      }
      return { ok: true, headers: fresh, json: async () => ({ messages: wideGapPage, has_more_before: true }) };
    },
  });
  GroupChat.appSlug = 'demo';
  const first = GroupChat.loadHistory();
  GroupChat.handleIncoming({ type: 'chat', ...msg(110) }); // live, before the page lands
  release();
  await first;
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  // (the channel also reads its bot cards on first open)
  assert.equal(requests.filter((r) => r.url.includes('/messages?')).length, 2);
  assert.equal(GroupChat.oldestMessageId, 61, 'started over: 3..60 are "Load earlier" away');
  assert.equal(GroupChat.hasMore, true);
  assert.equal(ids(GroupChat.messages)[0], 61);
});

test('review 3.1: a live message that beats a saved-copy first page does not set the watermark (thread)', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) {
        await gate;
        return { ok: true, headers: savedCopy, json: async () => ({ messages: [msg(1), msg(2)] }) };
      }
      return { ok: true, headers: fresh, json: async () => ({ messages: wideGapPage, has_more_before: true }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat.activeThread = { type: 'session', ref: 6284, language: 'chat' };
  const first = GroupChat.loadThreadHistory('session', 6284);
  GroupChat.handleIncoming({ type: 'chat', ...msg(110), thread: { type: 'session', ref: 6284 } });
  release();
  await first;
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  const st = GroupChat._threadState('session', 6284);
  assert.equal(requests.length, 2);
  assert.equal(st.oldestId, 61);
  assert.equal(st.hasMore, true);
  assert.equal(ids(st.messages)[0], 61);
});

test('review 3.2: a catch-up that lands with another gap queued keeps that gap\'s boundary', async () => {
  const releases = [];
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url) => {
      requests.push(url);
      if (requests.length === 1) {
        await new Promise((resolve) => releases.push(resolve));
        return { ok: true, headers: fresh, json: async () => ({ messages: [msg(1), msg(2), msg(3)] }) };
      }
      return { ok: true, headers: fresh, json: async () => ({ messages: wideGapPage, has_more_before: true }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat._syncedMax = 2;
  GroupChat.messages = [msg(1), msg(2)];
  GroupChat.oldestMessageId = 1;
  const read = GroupChat._refreshLatest(null);
  await new Promise((resolve) => setImmediate(resolve));
  GroupChat.resyncLoaded(); // a second gap opens during the read...
  GroupChat.handleIncoming({ type: 'chat', ...msg(110) }); // ...and 110 arrives past it
  releases[0]();
  await read;
  assert.equal(GroupChat._syncedMax, 3, 'the answer\'s own newest id, not the live 110');
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2, 'the queued catch-up ran');
  assert.equal(GroupChat.oldestMessageId, 61);
  assert.equal(GroupChat.hasMore, true);
});

test('a first page answered from the saved copy is caught up at once', async () => {
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) {
        return { ok: true, headers: { get: (h) => (h === 'sw-cached-at' ? '1' : null) }, json: async () => ({ messages: [] }) };
      }
      return { ok: true, headers: { get: () => null }, json: async () => ({ messages: [msg(1), msg(2)] }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat.activeThread = { type: 'session', ref: 6284, language: 'chat' };
  await GroupChat.loadThreadHistory('session', 6284);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2, 'no waiting for the worker\'s correction');
  assert.equal(requests[1].init.cache, 'no-cache');
  assert.deepEqual(ids(GroupChat._threadState('session', 6284).messages), [1, 2]);
});

test('a catch-up the worker could only answer from its saved copy changes nothing', async () => {
  const GroupChat = loadGroupChat({
    fetch: async () => ({ ok: true, headers: { get: (h) => (h === 'sw-cached-at' ? '1' : null) }, json: async () => ({ messages: [] }) }),
  });
  GroupChat.appSlug = 'demo';
  const st = GroupChat._threadState('session', 9);
  Object.assign(st, { loaded: true, messages: [msg(5)], oldestId: 5, syncedMax: 5 });
  GroupChat.activeThread = { type: 'session', ref: 9 };
  await GroupChat._refreshLatest({ type: 'session', ref: 9 });
  assert.deepEqual(ids(st.messages), [5]);
  assert.equal(st.stale, true);
});

test('review 1: a catch-up asked for during a read runs again when it lands', async () => {
  const releases = [];
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url) => {
      requests.push(url);
      await new Promise((resolve) => releases.push(resolve));
      return { ok: true, json: async () => ({ messages: requests.length === 1 ? [msg(1)] : [msg(1), msg(2)] }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat.messages = [msg(1)];
  GroupChat.oldestMessageId = 1;
  const first = GroupChat._refreshLatest(null);
  await new Promise((resolve) => setImmediate(resolve));
  GroupChat.resyncLoaded(); // a second gap while the first read is on the wire
  assert.equal(requests.length, 1, 'not two reads at once');
  releases[0]();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2, 'one more read after the first lands');
  releases[1]();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ids(GroupChat.messages), [1, 2]);

  // The same for a thread.
  const threadRequests = [];
  const threadReleases = [];
  const GC2 = loadGroupChat({
    fetch: async (url) => {
      // The general stream, never loaded here, takes its own first page.
      if (!url.includes('thread_type=')) return { ok: true, json: async () => ({ messages: [] }) };
      threadRequests.push(url);
      await new Promise((resolve) => threadReleases.push(resolve));
      return { ok: true, json: async () => ({ messages: [msg(5)] }) };
    },
  });
  GC2.appSlug = 'demo';
  Object.assign(GC2._threadState('session', 9), { loaded: true, messages: [msg(5)], oldestId: 5 });
  GC2.activeThread = { type: 'session', ref: 9 };
  const t1 = GC2._refreshLatest({ type: 'session', ref: 9 });
  await new Promise((resolve) => setImmediate(resolve));
  GC2.resyncLoaded();
  threadReleases[0]();
  await t1;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(threadRequests.length, 2);
  threadReleases[1]();
});

test('review 5: a channel whose first page came back empty still takes its correction', async () => {
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ messages: [msg(7), msg(8)] }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true; // its first page loaded, empty
  GroupChat.messages = [];
  GroupChat.oldestMessageId = null;
  GroupChat._onLiveResync({ reason: 'correction', urls: ['http://localhost/api/apps/demo/messages?limit=50'] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.cache, 'no-cache');
  assert.deepEqual(ids(GroupChat.messages), [7, 8]);
  assert.equal(GroupChat.oldestMessageId, 7);
});

test('a reconnect catches the general stream UP, freshly, instead of paging back', async () => {
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ messages: [msg(2), msg(3), msg(4)] }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat.messages = [msg(1), msg(2)];
  GroupChat.oldestMessageId = 1;
  GroupChat.resyncLoaded();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/apps/demo/messages?limit=50', 'the newest page, never ?before=');
  assert.equal(requests[0].init.cache, 'no-cache');
  // A short page is the whole stream: 1 is no longer on the server (hidden,
  // or from someone the reader blocked), so it goes; 3 and 4 were missed.
  assert.deepEqual(ids(GroupChat.messages), [2, 3, 4]);
  assert.equal(GroupChat.hasMore, false);

  const open = gcJs.slice(gcJs.indexOf('ws.onopen = () => {'), gcJs.indexOf('ws.onmessage'));
  assert.match(open, /GroupChat\.resyncLoaded\(\);/);
  assert.doesNotMatch(open, /GroupChat\.loadHistory\(\)/, 'onopen no longer pages backward on a loaded stream');
});

test('the open thread catches up; a thread cached off screen is marked stale', async () => {
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ messages: [msg(10), msg(11)] }) };
    },
  });
  GroupChat.appSlug = 'demo';
  const open = GroupChat._threadState('session', 6284);
  Object.assign(open, { loaded: true, messages: [msg(10)], oldestId: 10 });
  const away = GroupChat._threadState('issue', 12);
  Object.assign(away, { loaded: true, messages: [msg(5)], oldestId: 5 });
  const never = GroupChat._threadState('issue', 13);
  GroupChat.activeThread = { type: 'session', ref: 6284, language: 'chat' };
  GroupChat.oldestMessageId = null;
  GroupChat._historyLoad = {}; // the general stream's own first read is in flight
  GroupChat.resyncLoaded();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ['/api/apps/demo/messages?thread_type=session&thread_ref=6284&limit=50']);
  assert.deepEqual(ids(open.messages), [10, 11]);
  assert.equal(away.stale, true, 'caught up when it is mounted again');
  assert.notEqual(never.stale, true, 'a thread that never loaded is left to its own first read');
  assert.match(gcJs, /else if \(st\.stale && !st\.read\) void GroupChat\._refreshLatest\(\{ type, ref \}\);/,
    'mountThread catches a stale thread up');
});

test('a correction re-reads exactly the stream it names', () => {
  const GroupChat = loadGroupChat();
  GroupChat.appSlug = 'demo';
  const refreshed = [];
  GroupChat._refreshLatest = (thread) => { refreshed.push(thread ? `${thread.type}:${thread.ref}` : 'general'); };
  GroupChat.oldestMessageId = 1;
  Object.assign(GroupChat._threadState('session', 7), { loaded: true });
  Object.assign(GroupChat._threadState('issue', 3), { loaded: true });
  GroupChat.activeThread = { type: 'session', ref: 7 };
  GroupChat._onLiveResync({ reason: 'correction', urls: [
    'http://localhost/api/apps/demo/messages?thread_type=session&thread_ref=7&limit=50',
    'http://localhost/api/apps/demo/messages?thread_type=issue&thread_ref=3&limit=50',
    'http://localhost/api/apps/demo/messages?limit=50&before=40',
  ] });
  assert.deepEqual(refreshed, ['session:7'], 'an older page is not the newest one');
  assert.equal(GroupChat._threadState('issue', 3).stale, true);
});

test('a correction that lands during the first read is caught up once that read is done', async () => {
  // The reported case: the worker answers the thread's first page from an
  // older saved copy, and its correction can arrive before that page is in.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) { await gate; return { ok: true, json: async () => ({ messages: [] }) }; }
      return { ok: true, json: async () => ({ messages: [msg(1), msg(2)] }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat.activeThread = { type: 'session', ref: 6284, language: 'chat' };
  const first = GroupChat.loadThreadHistory('session', 6284);
  GroupChat._onLiveResync({ reason: 'correction', urls: [
    'http://localhost/api/apps/demo/messages?thread_type=session&thread_ref=6284&limit=50',
  ] });
  release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].init.cache, 'no-cache');
  assert.deepEqual(ids(GroupChat._threadState('session', 6284).messages), [1, 2],
    'the empty saved copy is replaced by the thread as it is');
});

test('the chat registers with live reads once, for its own messages reads', () => {
  const registered = [];
  const GroupChat = loadGroupChat({ liveReads: { watch: (fn, opts) => { registered.push(opts); return () => {}; } } });
  GroupChat._watchLiveReads();
  GroupChat._watchLiveReads();
  assert.equal(registered.length, 1);
  GroupChat.appSlug = 'demo';
  assert.equal(registered[0].reads(new URL('http://localhost/api/apps/demo/messages?limit=50')), true);
  assert.equal(registered[0].reads(new URL('http://localhost/api/apps/other/messages?limit=50')), false);
  assert.match(gcJs, /GroupChat\._openSocket\(\);\s*GroupChat\.attachScrollHandlers\(\);[\s\S]{0,200}GroupChat\._watchLiveReads\(\);/,
    'connect registers it');
});

test('the chat socket answers resync_hint and moderation_changed by catching up', () => {
  const GroupChat = loadGroupChat();
  let resyncs = 0;
  GroupChat.resyncLoaded = () => { resyncs++; };
  GroupChat.handleIncoming({ type: 'resync_hint' });
  GroupChat.handleIncoming({ type: 'moderation_changed' });
  assert.equal(resyncs, 2);
});

test('a broadcast already brought in by a catch-up is not drawn twice', () => {
  const GroupChat = loadGroupChat();
  GroupChat.appSlug = 'demo';
  GroupChat.messages = [msg(5)];
  GroupChat.handleIncoming({ type: 'chat', ...msg(5) });
  assert.deepEqual(ids(GroupChat.messages), [5]);
  const st = GroupChat._threadState('session', 9);
  st.messages = [msg(8)];
  GroupChat.handleIncoming({ type: 'chat', ...msg(8), thread: { type: 'session', ref: 9 } });
  assert.deepEqual(ids(st.messages), [8]);
});

// ── 5. The proposal page ──────────────────────────────────────────────

test('the reconnect sweep hands the moved screens to live reads', () => {
  const app = read('public/js/app.js');
  const sweep = app.slice(app.indexOf('  resyncCurrentView() {'), app.indexOf('  _listedNewApps:'));
  assert.match(sweep, /window\.UsernodeReact\?\.liveReads\?\.resync\?\.\('reconnect'\);/);
  assert.doesNotMatch(sweep, /change-detail-refresh/, 'the change page re-reads through live reads now');
});

test('a change page re-reads its own row and roster when live reads asks', () => {
  const src = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  const detail = src.slice(src.indexOf('export function ChangeDetail('));
  assert.match(detail, /const paths = new Set\(\[changeDetailPath\(item\), `\/api\/sessions\/\$\{id\}\/votes`\]\);/);
  assert.match(detail, /watch\(\(\) => \{\s*freshNext\.current = true;\s*setRevision\(\(n\) => n \+ 1\);\s*\}, \{ reads: \(url\) => paths\.has\(url\.pathname\) \}\);/);
  assert.match(detail, /unwatch\(\);/, 'and stops when it unmounts');
  assert.doesNotMatch(detail, /detail === 'all'/);
});

test('a fresh change-page read skips the saved copy and re-reads the roster for anyone', async () => {
  const { readChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const previousWindow = global.window;
  const previousFetch = global.fetch;
  const invalidated = [];
  const loads = [];
  global.window = { AppView: { appData: { slug: 'example' }, _demoQS: () => '',
    _invalidateVoteRoster(id) { invalidated.push(id); },
    _loadVoteRoster(id, opts) { loads.push(opts); } } };
  const inits = [];
  global.fetch = async (url, init) => {
    inits.push(init);
    return { ok: true, json: async () => ({ proposal: { id: 7, status: 'promoted' } }) };
  };
  const signal = new AbortController().signal;
  try {
    await readChangeDetail({ id: 7, status: 'promoted' }, false, signal);
    assert.equal(inits[0].cache, undefined, 'an ordinary read is unchanged');
    assert.deepEqual(invalidated, [], 'and leaves a reader\'s roster cached');
    await readChangeDetail({ id: 7, status: 'promoted' }, false, signal, { fresh: true });
    assert.equal(inits[1].cache, 'no-cache');
    assert.equal(inits[1].signal, signal);
    assert.deepEqual(invalidated, [7]);
    assert.equal(loads[1].fresh, true);
  } finally {
    global.fetch = previousFetch;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

function loadAppView({ fetch, liveReads, currentTab = 'dev' } = {}) {
  const sandbox = {
    console,
    relTime: () => ({ text: '', title: '' }),
    relStamp: () => ({ text: '', title: '' }),
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1, username: 'me' }, currentApp: 'demo', currentTab },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: () => {}, body: { appendChild: () => {} },
    },
    fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
    UsernodeReact: liveReads ? { liveReads } : {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo' };
  AppView._renderTopicHead = () => {};
  return AppView;
}

test('an open governance topic re-reads its roster, freshly, after a gap', async () => {
  const requests = [];
  let reads = null;
  const AppView = loadAppView({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ yes: ['bob'], no: [], reasons: [] }) };
    },
    liveReads: { watch: (fn, opts) => { reads = opts.reads; AppView.__reread = fn; return () => {}; } },
  });
  AppView._govVoteRoster[7] = { phase: 'ready', yes: { label: 'Yes (0)', names: '' } };
  AppView._devTopic = { kind: 'gov', id: 7 };
  AppView._watchTopicLiveReads();
  assert.equal(reads(new URL('http://localhost/api/apps/demo/governance/7/votes')), true);
  assert.equal(reads(new URL('http://localhost/api/apps/demo/governance/8/votes')), false);
  await AppView.__reread({ reason: 'reconnect', urls: null });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/apps/demo/governance/7/votes');
  assert.equal(requests[0].init.cache, 'no-cache');
  assert.match(AppView._govVoteRoster[7].yes.names, /@bob/, 'another person\'s vote now shows');

  AppView._devTopic = { kind: 'proposal', id: 7 };
  await AppView.__reread({ reason: 'reconnect', urls: null });
  assert.equal(requests.length, 1, 'only a governance topic has this roster to re-read');
});

// ── The review finding on 287ad91b ────────────────────────────────────

function gatedRosterFetch() {
  const requests = [];
  const releases = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    await new Promise((resolve) => releases.push(resolve));
    return { ok: true, json: async () => ({ yes: [`voter${requests.length}`], no: [], reasons: [] }) };
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { requests, releases, fetch, settle };
}

test('review 4: a fresh roster read asked for during the first load follows it (proposal)', async () => {
  const f = gatedRosterFetch();
  const AppView = loadAppView({ fetch: f.fetch });
  const first = AppView._loadVoteRoster(7);
  await AppView._loadVoteRoster(7, { fresh: true }); // a gap while the first is on the wire
  assert.equal(f.requests.length, 1, 'not two at once');
  f.releases[0]();
  await first;
  await f.settle();
  assert.equal(f.requests.length, 2, 'one fresh read after the first lands');
  assert.equal(f.requests[1].init.cache, 'no-cache');
  f.releases[1]();
  await f.settle();
  await f.settle();
  assert.match(AppView._voteRoster[7].yes.names, /@voter2/, 'the newer answer is what shows');
  assert.equal(AppView._voteRosterStale.has(7), false, 'the mark is spent by the read it asked for');
});

test('review 4: a vote that invalidates the roster during its first load is not lost (proposal)', async () => {
  const f = gatedRosterFetch();
  const AppView = loadAppView({ fetch: f.fetch });
  const first = AppView._loadVoteRoster(7);
  AppView._invalidateVoteRoster(7); // no cached entry yet: nothing to mark stale
  f.releases[0]();
  await first;
  await f.settle();
  assert.equal(f.requests.length, 2);
  f.releases[1]();
});

test('review 4: a fresh roster read asked for during the first load follows it (governance)', async () => {
  const f = gatedRosterFetch();
  const AppView = loadAppView({ fetch: f.fetch });
  AppView._devTopic = { kind: 'gov', id: 9 };
  const first = AppView._loadGovVoteRoster(9);
  await AppView._rereadOpenTopic(); // the live-reads watcher, mid-load
  assert.equal(f.requests.length, 1);
  f.releases[0]();
  await first;
  await f.settle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].init.cache, 'no-cache');
  f.releases[1]();
  await f.settle();
  await f.settle();
  assert.match(AppView._govVoteRoster[9].yes.names, /@voter2/);
});

test('opening a governance topic marks its cached roster for a re-read', () => {
  const src = read('public/js/app-view.js');
  const open = src.slice(src.indexOf('  async _renderTopicSubView(content, ref) {'));
  // Before the page paints (1 Nov 2026: past the look for a change's request).
  const head = open.slice(0, open.indexOf('// ── Fast open (#4524)'));
  assert.match(head, /if \(ref\.kind === 'gov'\) AppView\._invalidateGovVoteRoster\(ref\.id\);/);
  assert.match(head, /AppView\._watchTopicLiveReads\(\);/);
});

// ── The adversarial review of f7523842, and the one-rule rewrite ──────

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => msg(a + i));
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };
function gate() { let release; const p = new Promise((resolve) => { release = resolve; }); return { p, release }; }

test('adversarial 1: "Load earlier" waits for a catch-up that restarts the stream, so no hole opens', async () => {
  const latest = gate();
  const older = gate();
  const GroupChat = loadGroupChat({
    fetch: async (url) => {
      if (url.includes('before=')) {
        await older.p;
        const before = Number(new URL(url, 'http://x').searchParams.get('before'));
        return { ok: true, headers: fresh, json: async () => ({ messages: range(before - 50, before - 1), has_more_before: true }) };
      }
      await latest.p;
      return { ok: true, headers: fresh, json: async () => ({ messages: range(251, 300), has_more_before: true }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat.messages = range(51, 100);
  GroupChat.oldestMessageId = 51;
  GroupChat._syncedMax = 100;
  GroupChat.resyncLoaded(); // a long drop: catch-up on the wire
  const page = GroupChat.loadHistory(); // the reader reaches the top meanwhile
  latest.release();
  await tick();
  older.release();
  await page;
  const held = ids(GroupChat.messages);
  assert.deepEqual(held, range(201, 300).map((m) => m.id), 'the older page is read from the restarted cursor');
  assert.equal(GroupChat.oldestMessageId, 201);
});

test('adversarial 5: "Load earlier" in a thread during its catch-up runs once the catch-up lands', async () => {
  const g = gate();
  const urls = [];
  const GroupChat = loadGroupChat({
    fetch: async (url) => {
      urls.push(url);
      if (url.includes('before=')) return { ok: true, headers: fresh, json: async () => ({ messages: range(1, 50), has_more_before: false }) };
      await g.p;
      return { ok: true, headers: fresh, json: async () => ({ messages: range(51, 100), has_more_before: true }) };
    },
  });
  GroupChat.appSlug = 'demo';
  const st = GroupChat._threadState('session', 9);
  Object.assign(st, { loaded: true, messages: range(51, 100), oldestId: 51, hasMore: true, syncedMax: 100 });
  GroupChat.activeThread = { type: 'session', ref: 9 };
  GroupChat.resyncLoaded();
  const earlier = GroupChat.loadThreadHistory('session', 9);
  await tick();
  assert.equal(urls.filter((u) => u.includes('before=')).length, 0, 'not while the catch-up is on the wire');
  g.release();
  await earlier;
  assert.ok(urls.some((u) => u.includes('before=51')));
  assert.deepEqual(ids(st.messages), range(1, 100).map((m) => m.id));
});

test('adversarial 4: what a catch-up brings onto the open channel is marked read', async () => {
  const reads = [];
  let first = true;
  const GroupChat = loadGroupChat({
    onScreen: true,
    fetch: async (url, init) => {
      if (url.includes('/messages/read')) { reads.push(JSON.parse(init.body).message_id); return { ok: true, json: async () => ({}) }; }
      if (!url.includes('/messages?limit=50')) return { ok: true, headers: fresh, json: async () => ({}) };
      if (first) {
        first = false;
        return { ok: true, headers: savedCopy, json: async () => ({ messages: [msg(1), msg(2)], read: { last_read_message_id: 2, unread_count: 0 } }) };
      }
      return { ok: true, headers: fresh, json: async () => ({ messages: range(1, 5), has_more_before: false }) };
    },
  });
  GroupChat.appSlug = 'demo';
  await GroupChat.loadHistory();
  await tick(10);
  assert.deepEqual(ids(GroupChat.messages), [1, 2, 3, 4, 5]);
  assert.equal(GroupChat._readUpTo, 5);
});

test('adversarial 6: a live message during a catch-up keeps the server\'s order (no sort)', async () => {
  const g = gate();
  const answer = [msg(9902011), msg(9902012), msg(9902018), msg(640)];
  const GroupChat = loadGroupChat({
    fetch: async () => { await g.p; return { ok: true, headers: fresh, json: async () => ({ messages: answer, has_more_before: false }) }; },
  });
  GroupChat.appSlug = 'demo';
  const st = GroupChat._threadState('issue', 900008);
  Object.assign(st, { loaded: true, messages: answer.slice(), oldestId: 9902011, hasMore: false, syncedMax: 9902018 });
  GroupChat.activeThread = { type: 'issue', ref: 900008, language: 'chat' };
  const pending = GroupChat._refreshLatest({ type: 'issue', ref: 900008 });
  GroupChat.handleIncoming({ type: 'chat', ...msg(641), thread: { type: 'issue', ref: 900008 } });
  g.release();
  await pending;
  assert.deepEqual(ids(st.messages), [9902011, 9902012, 9902018, 640, 641]);
});

test('adversarial 3: one relay gap costs the open channel one read, not two', async () => {
  const lr = live();
  lr._resetLiveReads();
  const win = { location: { origin: 'http://localhost' }, addEventListener() {}, UsernodeReact: {} };
  lr.installLiveReads(win, { visibilityState: 'visible', addEventListener() {} });
  const reads = [];
  const GroupChat = loadGroupChat({
    liveReads: win.UsernodeReact.liveReads,
    fetch: async (url) => {
      reads.push(url);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true, headers: fresh, json: async () => ({ messages: range(51, 100), has_more_before: true }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat.messages = range(51, 100);
  GroupChat.oldestMessageId = 51;
  GroupChat._syncedMax = 100;
  GroupChat._watchLiveReads();
  GroupChat.handleIncoming({ type: 'resync_hint' }); // the chat room's copy of the hint
  win.UsernodeReact.liveReads.resync('reconnect'); // the events socket's copy
  lr.flush();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(reads.length, 1);
  win.UsernodeReact.liveReads.resync('visible'); // a different gap is still answered
  lr.flush();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(reads.length, 2);
});

test('one rule: an edit during a first page or an older page survives it too', async () => {
  const g = gate();
  const GroupChat = loadGroupChat({
    fetch: async (url) => {
      await g.p;
      return url.includes('before=')
        ? { ok: true, headers: fresh, json: async () => ({ messages: [msg(1, { content: 'old' }), msg(2)], has_more_before: false }) }
        : { ok: true, headers: fresh, json: async () => ({ messages: [msg(3, { content: 'old' }), msg(4)], has_more_before: true }) };
    },
  });
  GroupChat.appSlug = 'demo';
  const first = GroupChat.loadHistory();
  GroupChat.handleIncoming({ type: 'chat_edit', messageId: 3, content: 'new', editedAt: 'now' });
  GroupChat.handleIncoming({ type: 'chat', ...msg(5) }); // delivered before the page lands
  g.release();
  await first;
  assert.deepEqual(ids(GroupChat.messages), [3, 4, 5], 'the live message is kept');
  assert.equal(GroupChat.messages[0].content, 'new');
  const g2 = gate();
  const GC2 = loadGroupChat({
    fetch: async () => { await g2.p; return { ok: true, headers: fresh, json: async () => ({ messages: [msg(1, { content: 'old' }), msg(2)], has_more_before: false }) }; },
  });
  GC2.appSlug = 'demo';
  GC2._streamLoaded = true;
  GC2.messages = [msg(3), msg(4)];
  GC2.oldestMessageId = 3;
  const older = GC2.loadHistory();
  GC2.handleIncoming({ type: 'chat_edit', messageId: 1, content: 'new', editedAt: 'now' });
  g2.release();
  await older;
  assert.deepEqual(ids(GC2.messages), [1, 2, 3, 4]);
  assert.equal(GC2.messages[0].content, 'new');
  assert.equal(GC2._liveWindows.size, 0);
});

test('one rule: the old merge is gone, and the vote rosters have one stale mark each', () => {
  assert.doesNotMatch(gcJs, /_mergeHistory/);
  const view = read('public/js/app-view.js');
  assert.doesNotMatch(view, /RosterAgain/);
  const detail = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(detail, /if \(freshInFlight\) freshNext\.current = true;/,
    'a fresh read cut short by a revision bump hands `fresh` to the next one');
});

test('"Load earlier" also waits for the catch-up queued behind the one it waited for', async () => {
  const gates = [gate(), gate()];
  let latestCalls = 0;
  const order = [];
  const GroupChat = loadGroupChat({
    fetch: async (url) => {
      if (url.includes('before=')) {
        const before = Number(new URL(url, 'http://x').searchParams.get('before'));
        order.push(`older:${before}`);
        return { ok: true, headers: fresh, json: async () => ({ messages: range(before - 50, before - 1), has_more_before: true }) };
      }
      const n = latestCalls++;
      order.push(`latest:${n}`);
      await gates[n].p;
      return { ok: true, headers: fresh, json: async () => ({ messages: n === 0 ? range(201, 250) : range(301, 350), has_more_before: true }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat.messages = range(51, 100);
  GroupChat.oldestMessageId = 51;
  GroupChat._syncedMax = 100;
  GroupChat.resyncLoaded(); // catch-up 0
  await tick();
  GroupChat.resyncLoaded(); // queued behind it (`again`)
  const page = GroupChat.loadHistory();
  gates[0].release();
  await tick();
  gates[1].release();
  await page;
  assert.deepEqual(order, ['latest:0', 'latest:1', 'older:301'], 'the older page goes after both, from the final cursor');
  assert.deepEqual(ids(GroupChat.messages), range(251, 350).map((m) => m.id), 'no hole: paged back from 301');
});

// ── The second adversarial review (63c38fae) ──────────────────────────

test('adversarial 2.1: a thread opened after a gap has no hole "Load earlier" cannot reach', async () => {
  const T = { type: 'issue', ref: 7 };
  const server = range(1, 161).map((m) => ({ ...m, thread: { ...T } }));
  const page = (url) => {
    const before = new URL(url, 'http://localhost').searchParams.get('before');
    const rows = before ? server.filter((m) => m.id < Number(before)) : server;
    return { messages: rows.slice(-50), has_more_before: rows.length > 50 };
  };
  const GroupChat = loadGroupChat({ fetch: async (url) => ({ ok: true, headers: fresh, json: async () => page(url) }) });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat._syncedMax = 0;
  GroupChat.handleIncoming({ type: 'chat', id: 100, content: 't100', thread: { ...T } }); // thread not open
  GroupChat.resyncLoaded(); // the socket came back after 101..160 were posted
  await tick();
  GroupChat.handleIncoming({ type: 'chat', id: 161, content: 't161', thread: { ...T } }); // past the gap
  GroupChat.activeThread = { ...T };
  await GroupChat.loadThreadHistory(T.type, T.ref);
  const st = GroupChat._threadState(T.type, T.ref);
  for (let i = 0; i < 10 && st.hasMore; i++) await GroupChat.loadThreadHistory(T.type, T.ref);
  const held = new Set(ids(st.messages));
  const missing = range(1, 161).map((m) => m.id).filter((id) => !held.has(id));
  assert.deepEqual(missing, [], 'every message in the thread is reachable');
});

for (const path of ['catch-up', 'load-earlier', 'socket']) {
  test(`adversarial 2.2: a delete the server refuses during a ${path} read is not replayed`, async () => {
    const g = gate();
    const GroupChat = loadGroupChat({
      fetch: async (url, init) => {
        if (init && init.method === 'DELETE') return { ok: false, status: 403, headers: fresh, json: async () => ({}) };
        await g.p;
        return url.includes('before=')
          ? { ok: true, headers: fresh, json: async () => ({ messages: range(1, 50), has_more_before: false }) }
          : { ok: true, headers: fresh, json: async () => ({ messages: range(51, 100), has_more_before: true }) };
      },
    });
    GroupChat.appSlug = 'demo';
    GroupChat._streamLoaded = true;
    GroupChat.messages = range(51, 100);
    GroupChat.oldestMessageId = 51;
    GroupChat.hasMore = true;
    GroupChat._syncedMax = 100;
    GroupChat._didInitialScroll = true;
    if (path === 'socket') GroupChat.ws = { readyState: 1, send() {} };
    const read = path === 'load-earlier' ? GroupChat.loadHistory() : GroupChat._refreshLatest(null);
    await tick();
    const del = GroupChat.deleteMessage(99);
    if (path === 'socket') GroupChat.handleIncoming({ type: 'delete_error', id: 99, code: 'rate_limited' });
    await assert.rejects(del);
    g.release();
    await read;
    await tick();
    const m = GroupChat.messages.find((x) => Number(x.id) === 99);
    assert.ok(!m.deleted, 'the refused delete is not on the message');
    assert.equal(m.content, 'm99');
  });
}

test('adversarial 2.3: a pass that brings the tab back AND a reconnect still re-reads the chat', () => {
  const { lr, win, doc, fire } = install();
  const GroupChat = loadGroupChat({ liveReads: win.UsernodeReact.liveReads });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  let resyncs = 0;
  GroupChat.resyncLoaded = () => { resyncs += 1; };
  GroupChat._watchLiveReads();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    doc.visibilityState = 'hidden';
    fire('doc', 'visibilitychange');
    now += lr.AWAY_MS + 1000;
    doc.visibilityState = 'visible';
    fire('doc', 'visibilitychange'); // resync('visible')
    lr.resync('reconnect'); // the events socket reopens in the same pass
    lr.flush();
  } finally {
    Date.now = realNow;
  }
  assert.equal(resyncs, 1);
  lr.resync('reconnect'); // a reconnect alone is still the chat socket's own business
  lr.flush();
  assert.equal(resyncs, 1);
});

test('a pass hands its watchers every reason it gathered', () => {
  const { lr } = install();
  const w = recorder();
  lr.watch(w);
  lr.resync('visible');
  lr.resync('reconnect');
  lr.resync('visible');
  lr.flush();
  assert.deepEqual(Array.from(w.calls[0].reasons), ['reconnect', 'visible']);
  assert.equal(w.calls[0].reason, 'visible', 'the last trigger');
});

test('a catch-up times out even where AbortSignal.timeout does not exist', async () => {
  const signals = [];
  const GroupChat = loadGroupChat({
    extra: { AbortSignal: {}, AbortController },
    fetch: (url, init) => new Promise((resolve, reject) => {
      signals.push(init && init.signal);
      if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  GroupChat.CATCH_UP_TIMEOUT_MS = 30;
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat.messages = [msg(1)];
  await GroupChat._refreshLatest(null);
  assert.ok(signals[0], 'the read carries a signal');
  assert.equal(signals[0].aborted, true, 'and it fired');
  assert.equal(GroupChat._latestLoad, null, '"Load earlier" is not left waiting');
  assert.equal(GroupChat._streamStale, true, 'still owed');
});

test('remounting while a catch-up is on the wire does not queue a second one', () => {
  assert.match(gcJs, /if \(GroupChat\._streamStale && !GroupChat\._latestLoad\) void GroupChat\._refreshLatest\(null\);/);
  assert.match(gcJs, /else if \(st\.stale && !st\.read\) void GroupChat\._refreshLatest\(\{ type, ref \}\);/);
});
