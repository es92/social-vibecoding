'use strict';

// Offline test, 2 Nov 2026, finding 1: a message sent on a quiet network
// (connections open, nothing passes, the phone still says it is online)
// looked sent, then vanished, and the server never had it.
//
//   - The send had no time limit, so it never failed and never became the
//     "Not sent" row. Now it is given up after SEND_TIMEOUT_MS, and the
//     shell's connectivity probe is asked: with the connection gone the
//     message waits for it, with the connection up it is Not sent, Retry.
//   - Messages waited for a connection only when navigator.onLine said
//     false. Now also when the shell's probe says so, and they go when it
//     says the connection is back (`usernode:offline-change`), on the
//     browser's `online`, and on the events socket reopening (resync).
//   - A re-read of the conversation that started empty (opening it again)
//     dropped every row not yet sent. Now those rows outlive the screen.
//   - The rows lived in memory only. Now each is kept on the device
//     (frontend/src/features/messages/outbox.ts, IndexedDB) for the account
//     that wrote it, comes back on a reload, and goes on sign-out.
//   - A send slower than SLOW_SEND_MS says "Sending…" (a fast one still
//     shows only the fade, #2907).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const STORE = read('frontend/src/features/messages/store.ts');
const APP_JS = read('public/js/app.js');
const CSS = read('public/css/app.css');

const ME = { id: 7, username: 'me', avatarUrl: null };
const THEM = { id: 8, username: 'them', avatarUrl: null };
const CONVERSATION = {
  id: 42, kind: 'group', title: 'Launch crew', membershipStatus: 'member', canSend: true,
  members: [ME, THEM], unreadCount: 0,
};

function serverMessage(id, sender, content) {
  return {
    id, conversationId: 42, sender, content, createdAt: new Date(Date.UTC(2026, 10, 2, 12, 0, id)).toISOString(),
    reply: null, reactions: [], attachments: [], objects: [],
  };
}

class MessagesApiError extends Error {
  constructor(status, text) { super(text); this.status = status; }
}

/** What api.sendMessage throws when its deadline passes: not an answer. */
class TimeoutError extends Error {
  constructor() { super('The message got no answer in time.'); this.name = 'TimeoutError'; }
}

/** The device's outbox, in memory, filtering by account as ./outbox.ts does. */
function memoryOutbox(stored = []) {
  const records = new Map(stored.map((record) => [record.key, record]));
  const box = {
    records,
    loads: [],
    cleared: 0,
    load: async (viewer) => { box.loads.push(viewer); return [...records.values()].filter((item) => item.viewer === viewer); },
    save: (record) => { records.set(record.key, JSON.parse(JSON.stringify(record))); },
    drop: (key) => { records.delete(key); },
    clear: () => { box.cleared += 1; records.clear(); },
  };
  return box;
}

function harness({ offline = false, stored = [], viewer = ME } = {}) {
  const server = { messages: [serverMessage(1, THEM, 'hello')], nextId: 2, posts: [], quiet: false, refuse: 0 };
  const deferred = [];
  const api = {
    MessagesApiError,
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async () => [CONVERSATION],
    getConversation: async () => CONVERSATION,
    listMessages: async () => ({ messages: server.messages.map((item) => ({ ...item })), nextBefore: null }),
    markRead: async () => {},
    sendMessage: (id, payload, options) => new Promise((resolve, reject) => {
      server.posts.push({ payload, options });
      deferred.push(() => {
        // A quiet network: nothing comes back, and the deadline gives up.
        if (server.quiet) { reject(new TimeoutError()); return; }
        // The server itself says no.
        if (server.refuse) { server.refuse -= 1; reject(new MessagesApiError(500, 'Server hiccup')); return; }
        // Idempotent, as services/conversations.js is: the same key is one row.
        const existing = server.messages.find((item) => item.key === payload.idempotencyKey);
        if (existing) { resolve({ ...existing }); return; }
        const row = { ...serverMessage(server.nextId++, ME, payload.content), key: payload.idempotencyKey };
        server.messages.push(row);
        resolve({ ...row });
      });
    }),
  };
  // The shell's connectivity state (../../lib/offline.ts): what isOffline()
  // says, and what the next probe will find.
  const net = { offline, probes: 0, probeSays: null };
  const connectivity = {
    isOffline: () => net.offline,
    probe: async () => { net.probes += 1; if (net.probeSays !== null) net.offline = net.probeSays; },
  };
  const outbox = memoryOutbox(stored);
  const listeners = {};
  let read = null;
  const react = { useSyncExternalStore: (subscribe, snapshot) => { read = snapshot; return snapshot(); } };
  globalThis.window = {
    App: { user: viewer },
    location: { search: '', hash: '#messages/42' },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((each) => each !== fn); },
    dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  // The app-discussions read is a plain fetch beside the stubbed API.
  globalThis.fetch = async () => ({ ok: false, json: async () => null });
  const store = loadTsx('frontend/src/features/messages/store.ts', {
    stubs: { './api': api, react, '../../lib/offline': connectivity, './outbox': { MAX_UNSENT: 50, messagesOutbox: () => outbox } },
  });
  store.useMessagesSnapshot();
  const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const settle = async () => { while (deferred.length) { deferred.shift()(); await flush(); } await flush(); };
  const fire = async (type, detail) => { for (const fn of listeners[type] || []) fn({ type, detail }); await flush(); };
  const state = () => read();
  const rows = () => state().messages.map((item) => [item.content, item.id > 0 ? 'sent' : item.queued ? 'queued' : item.failed ? 'failed' : 'sending']);
  return { store, server, net, outbox, state, rows, flush, settle, fire };
}

async function openThread(h) {
  h.store.messagesController.route(42);
  await h.flush();
  assert.equal(h.state().loadingThread, false, 'the thread loaded');
}

function record(key, content, state, savedAt, over = {}) {
  return {
    key, viewer: ME.id, conversationId: 42, after: 1, state, savedAt,
    payload: { content, idempotencyKey: key },
    row: {
      id: -savedAt, conversationId: 42, sender: ME, content, createdAt: new Date(savedAt).toISOString(),
      reply: null, reactions: [], attachments: [], objects: [], clientKey: key, threadRootId: null,
    },
    ...over,
  };
}

// ── Sending with no connection ───────────────────────────────────────────

test('offline by the shell\'s probe, a message waits instead of going, and goes when the probe says the connection is back', async () => {
  const h = harness({ offline: true });
  const stop = h.store.initializeMessagesStore();
  await openThread(h);
  await h.store.send({ content: 'written offline' });
  assert.equal(h.server.posts.length, 0, 'nothing is sent while the app says it is offline, whatever the browser says');
  assert.deepEqual(h.rows(), [['hello', 'sent'], ['written offline', 'queued']]);
  const row = h.state().messages[1];
  assert.equal(row.pending, false, 'not faded as if on its way');
  assert.equal(h.outbox.records.get(row.clientKey).state, 'queued', 'kept on the device');

  h.net.offline = false;
  await h.fire('usernode:offline-change', { offline: false });
  assert.equal(h.server.posts.length, 1, 'the probe saying the connection is back sends it');
  assert.equal(h.server.posts[0].payload.idempotencyKey, row.clientKey, 'under the key it was written with');
  await h.settle();
  assert.deepEqual(h.rows(), [['hello', 'sent'], ['written offline', 'sent']]);
  assert.equal(h.state().messages[1].clientKey, row.clientKey, 'the same row, updated in place');
  assert.equal(h.outbox.records.size, 0, 'and no longer kept on the device');
  stop();
});

test('the browser\'s online event and the events socket reopening send what waited too', async () => {
  const h = harness({ offline: true });
  const stop = h.store.initializeMessagesStore();
  await openThread(h);
  await h.store.send({ content: 'one' });
  h.net.offline = false;
  await h.fire('online');
  assert.equal(h.server.posts.length, 1, 'online');
  await h.settle();

  h.net.offline = true;
  await h.store.send({ content: 'two' });
  assert.equal(h.server.posts.length, 1);
  h.net.offline = false;
  void h.store.messagesController.resync();
  await h.flush();
  assert.equal(h.server.posts.length, 2, 'a reconnect of the events socket (App.resyncCurrentView)');
  await h.settle();
  assert.deepEqual(h.rows(), [['hello', 'sent'], ['one', 'sent'], ['two', 'sent']]);
  stop();
});

test('a message written while others wait goes behind them, in the order they were written', async () => {
  const h = harness({ offline: true });
  await openThread(h);
  await h.store.send({ content: 'first' });
  await h.store.send({ content: 'second' });
  // Back online by the probe, before its event has been heard here.
  h.net.offline = false;
  const third = h.store.send({ content: 'third' });
  await h.flush();
  assert.equal(h.server.posts.length, 1, 'one at a time');
  await h.settle();
  await third;
  assert.deepEqual(h.server.posts.map((post) => post.payload.content), ['first', 'second', 'third']);
  assert.deepEqual(h.rows().map(([content, how]) => `${content}:${how}`), ['hello:sent', 'first:sent', 'second:sent', 'third:sent']);
});

// ── A send nobody answers ────────────────────────────────────────────────

test('a send is given up after 15 s; with the connection gone it waits for it, and goes when it is back', async () => {
  const h = harness();
  const stop = h.store.initializeMessagesStore();
  await openThread(h);
  h.server.quiet = true;
  h.net.probeSays = true;
  const sending = h.store.send({ content: 'Sent while blackhole' });
  assert.equal(h.server.posts[0].options.timeoutMs, 15_000, 'the POST has a deadline (api.sendMessage)');
  assert.equal(h.store.SEND_TIMEOUT_MS, 15_000);
  assert.deepEqual(h.rows()[1], ['Sent while blackhole', 'sending'], 'on its way, faded');
  await h.settle();
  await sending;
  assert.equal(h.net.probes, 1, 'an unanswered send asks the connectivity probe, so the app notices the quiet network');
  assert.deepEqual(h.rows()[1], ['Sent while blackhole', 'queued'], 'the probe found no connection: it waits for one');
  const key = h.state().messages[1].clientKey;
  assert.equal(h.outbox.records.get(key).state, 'queued');

  h.server.quiet = false;
  h.net.offline = false;
  await h.fire('usernode:offline-change', { offline: false });
  await h.settle();
  assert.deepEqual(h.rows(), [['hello', 'sent'], ['Sent while blackhole', 'sent']]);
  assert.equal(h.server.posts.length, 2);
  assert.equal(h.server.posts[1].payload.idempotencyKey, key, 'the same key: never stored twice');
  assert.equal(h.server.messages.filter((item) => item.content === 'Sent while blackhole').length, 1);
  stop();
});

test('with the connection up, an unanswered send is Not sent, and Retry sends it under the same key', async () => {
  const h = harness();
  await openThread(h);
  h.server.quiet = true;
  h.net.probeSays = false;
  const sending = h.store.send({ content: 'nobody answered' });
  await h.settle();
  await sending;
  let row = h.state().messages[1];
  assert.equal(row.failed, true, 'Not sent');
  assert.equal(row.pending, false);
  assert.equal(h.outbox.records.get(row.clientKey).state, 'failed', 'kept on the device as not sent');

  h.server.quiet = false;
  const retry = h.store.retrySend(row.clientKey);
  await h.settle();
  await retry;
  row = h.state().messages[1];
  assert.ok(row.id > 0, 'sent');
  assert.equal(h.server.posts[0].payload.idempotencyKey, h.server.posts[1].payload.idempotencyKey);
});

test('a refused send is Not sent without asking the probe, and Retry while offline waits for the connection', async () => {
  const h = harness();
  await openThread(h);
  h.server.refuse = 1;
  const sending = h.store.send({ content: 'refused' });
  await h.settle();
  await sending;
  assert.equal(h.net.probes, 0, 'an answer from the server is not a question about the network');
  assert.deepEqual(h.rows()[1], ['refused', 'failed']);

  h.net.offline = true;
  await h.store.retrySend(h.state().messages[1].clientKey);
  assert.equal(h.server.posts.length, 1, 'not sent into no connection');
  assert.deepEqual(h.rows()[1], ['refused', 'queued'], 'it waits, and goes by itself');
  assert.equal(h.net.probes, 1, 'a Retry has the probe look again');
});

// ── Re-reads never drop a row not yet sent ───────────────────────────────

test('opening the conversation again, or re-reading it, keeps every row not yet sent, after the server\'s, in order', async () => {
  const h = harness();
  await openThread(h);
  const first = h.store.send({ content: 'on its way' });
  h.net.offline = true;
  await h.store.send({ content: 'waiting' });
  assert.deepEqual(h.rows(), [['hello', 'sent'], ['on its way', 'sending'], ['waiting', 'queued']]);

  // Away and back: the run's own path (A-06 to A-10), where it vanished.
  h.store.messagesController.close();
  assert.deepEqual(h.state().messages, []);
  await openThread(h);
  assert.deepEqual(h.rows(), [['hello', 'sent'], ['on its way', 'sending'], ['waiting', 'queued']],
    'an open starts from an empty transcript and still draws them');

  // A live re-read, and a reconnect's.
  h.server.messages.push(serverMessage(h.server.nextId++, THEM, 'are you there?'));
  h.store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42 });
  await h.flush();
  assert.deepEqual(h.rows(), [['hello', 'sent'], ['are you there?', 'sent'], ['on its way', 'sending'], ['waiting', 'queued']]);

  h.net.offline = false;
  await h.settle();
  await first;
  const flushing = h.store.flushQueued();
  await h.settle();
  await flushing;
  assert.deepEqual(h.rows(), [['hello', 'sent'], ['are you there?', 'sent'], ['on its way', 'sent'], ['waiting', 'sent']]);
  assert.equal(new Set(h.state().messages.map((item) => item.clientKey || item.id)).size, 4, 'each drawn once');
});

// ── Kept on the device ───────────────────────────────────────────────────

test('a reload brings back this account\'s unsent messages: waiting ones go once online, a not-sent one keeps its Retry', async () => {
  const stored = [
    record('waiting-key-0001', 'written on the train', 'queued', Date.now() - 3000),
    record('failed-key-00001', 'refused earlier', 'failed', Date.now() - 2000),
    record('flight-key-00001', 'on its way when the app closed', 'sending', Date.now() - 1000),
  ];
  const h = harness({ offline: true, stored });
  const stop = h.store.initializeMessagesStore();
  await h.flush();
  assert.deepEqual(h.outbox.loads, [ME.id], 'read for the signed-in account only');
  await openThread(h);
  assert.deepEqual(h.rows(), [
    ['hello', 'sent'],
    ['written on the train', 'queued'],
    ['refused earlier', 'failed'],
    ['on its way when the app closed', 'queued'],
  ], 'back in their conversation, in the order written; one on its way waits, its key makes sending it again safe');
  assert.equal(h.server.posts.length, 0);

  h.net.offline = false;
  await h.fire('usernode:offline-change', { offline: false });
  await h.settle();
  assert.deepEqual(h.server.posts.map((post) => post.payload.idempotencyKey), ['waiting-key-0001', 'flight-key-00001'],
    'the waiting ones, under their own keys; the not-sent one waits for its Retry');
  assert.deepEqual(h.rows(), [
    ['hello', 'sent'],
    ['written on the train', 'sent'],
    ['on its way when the app closed', 'sent'],
    ['refused earlier', 'failed'],
  ], 'what the server has, then what it does not');
  assert.deepEqual([...h.outbox.records.keys()], ['failed-key-00001']);
  stop();
});

test('restored rows that arrive after the conversation is drawn join it', async () => {
  const stored = [record('late-key-000001', 'from before the reload', 'failed', Date.now() - 1000)];
  const h = harness({ stored });
  await openThread(h);
  assert.deepEqual(h.rows(), [['hello', 'sent']]);
  await h.store.restoreUnsent();
  assert.deepEqual(h.rows(), [['hello', 'sent'], ['from before the reload', 'failed']]);
  await h.store.restoreUnsent();
  assert.equal(h.state().messages.length, 2, 'once per account');
});

test('sign-out forgets them, on screen and on the device; Discard forgets one', async () => {
  const h = harness({ offline: true });
  await openThread(h);
  await h.store.send({ content: 'keep me' });
  await h.store.send({ content: 'drop me' });
  h.store.discardFailed(h.state().messages[2].clientKey);
  assert.deepEqual(h.rows(), [['hello', 'sent'], ['keep me', 'queued']], 'Discard takes a waiting row too');
  assert.equal(h.outbox.records.size, 1);

  h.store.messagesController.clearUnsent();
  assert.deepEqual(h.rows(), [['hello', 'sent']]);
  assert.equal(h.outbox.cleared, 1);
  h.net.offline = false;
  await h.store.flushQueued();
  assert.equal(h.server.posts.length, 0, 'nothing of theirs is sent after they have gone');
});

test('the session sweep clears them, except for a snapshot whose session token merely changed', () => {
  const start = APP_JS.indexOf('\n  _dropCachedSession(');
  const sweep = APP_JS.slice(start, APP_JS.indexOf('\n  },', start));
  assert.match(sweep, /_dropCachedSession\(\{ apiCache = true, keepUnsent = false \} = \{\}\)/);
  assert.match(sweep, /if \(!keepUnsent\) window\.UsernodeReact\?\.messages\?\.clearUnsent\?\.\(\);/);
  const snapshot = APP_JS.slice(APP_JS.indexOf('\n  readSessionSnapshot('), APP_JS.indexOf('\n  clearSessionSnapshot('));
  assert.match(snapshot, /snap\.cacheScope !== App\._sessionCacheScope\(\)\) \{[\s\S]{0,400}?App\._dropCachedSession\(\{ keepUnsent: true \}\);/);
  assert.match(STORE, /\/\/ Offline test, finding 1: App\._dropCachedSession's sweep, when a session ends\.\s*clearUnsent,\s*\};/,
    'published on window.UsernodeReact.messages (features/messages/index.tsx)');
});

// ── The device store ─────────────────────────────────────────────────────

test('the outbox keeps the newest 50 of one account\'s, none older than a week, and deletes the rest', () => {
  const { restorable, MAX_UNSENT, MAX_UNSENT_AGE_MS } = loadTsx('frontend/src/features/messages/outbox.ts');
  assert.equal(MAX_UNSENT, 50);
  assert.equal(MAX_UNSENT_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  const now = Date.UTC(2026, 10, 2);
  const mine = Array.from({ length: 52 }, (_, i) => record(`mine-key-${String(i).padStart(4, '0')}`, `m${i}`, 'queued', now - 1000 * (60 - i)));
  const other = { ...record('other-key-00001', 'theirs', 'queued', now - 10), viewer: 99 };
  const stale = record('stale-key-00001', 'old', 'failed', now - MAX_UNSENT_AGE_MS - 1);
  const broken = { key: 'broken-key-0001', viewer: ME.id };
  const { keep, drop } = restorable([other, ...mine.slice().reverse(), stale, broken], ME.id, now);
  assert.equal(keep.length, 50);
  assert.deepEqual(keep.map((item) => item.payload.content), mine.slice(2).map((item) => item.payload.content), 'oldest first');
  assert.deepEqual(drop.sort(), ['broken-key-0001', 'mine-key-0000', 'mine-key-0001', 'other-key-00001', 'stale-key-00001']);
});

/** Just enough IndexedDB for ./outbox.ts: one database, one store keyed by `key`. */
function fakeIndexedDb() {
  const rows = new Map();
  const later = (fn) => setImmediate(fn);
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {};
      const store = {
        put(value) { rows.set(value.key, structuredClone(value)); later(() => tx.oncomplete?.()); },
        delete(key) { rows.delete(key); later(() => tx.oncomplete?.()); },
        clear() { rows.clear(); later(() => tx.oncomplete?.()); },
        getAll() {
          const request = {};
          later(() => { request.result = [...rows.values()].map((value) => structuredClone(value)); request.onsuccess?.(); });
          return request;
        },
      };
      tx.objectStore = () => store;
      return tx;
    },
  };
  return {
    rows,
    open() {
      const request = { result: db };
      later(() => request.onsuccess?.());
      return request;
    },
  };
}

test('the outbox over IndexedDB: saved, read back for its account only, dropped and cleared', async () => {
  const { createOutbox } = loadTsx('frontend/src/features/messages/outbox.ts');
  const idb = fakeIndexedDb();
  const outbox = createOutbox(idb);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
  outbox.save(record('aaaa-key-00001', 'one', 'queued', Date.now() - 2));
  outbox.save(record('bbbb-key-00001', 'two', 'failed', Date.now() - 1));
  outbox.save({ ...record('cccc-key-00001', 'theirs', 'queued', Date.now()), viewer: 99 });
  await wait();
  const mine = await outbox.load(ME.id);
  assert.deepEqual(mine.map((item) => item.payload.content), ['one', 'two']);
  await wait();
  assert.deepEqual([...idb.rows.keys()].sort(), ['aaaa-key-00001', 'bbbb-key-00001'], 'another account\'s is deleted once anyone\'s are read');
  outbox.drop('aaaa-key-00001');
  await wait();
  assert.deepEqual([...idb.rows.keys()], ['bbbb-key-00001']);
  outbox.clear();
  await wait();
  assert.equal(idb.rows.size, 0);

  const none = createOutbox(null);
  assert.deepEqual(await none.load(ME.id), [], 'no IndexedDB: nothing kept, nothing thrown');
  none.save(record('dddd-key-00001', 'x', 'queued', Date.now()));
});

// ── The deadline itself ──────────────────────────────────────────────────

test('api.sendMessage gives up after its deadline, body included, as a timeout rather than an answer', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.window = { location: { search: '' } };
  const api = loadTsx('frontend/src/features/messages/api.ts');
  const seen = [];
  // A network that connects and passes nothing: the request never settles until aborted.
  globalThis.fetch = (url, init) => {
    seen.push(init);
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
  };
  await assert.rejects(
    api.sendMessage(42, { content: 'hi', idempotencyKey: 'abcd-key-00001' }, { timeoutMs: 20 }),
    (error) => error instanceof api.MessagesTimeoutError && error.name === 'TimeoutError' && !(error instanceof api.MessagesApiError)
      // The share dialog shows a send's error as it is: plain words, from the catalog.
      && error.message === message('messages:api.sendTimedOut'),
  );
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].signal.aborted, true, 'the request itself is cancelled');

  // Headers in time, the body cut off: still not a message.
  globalThis.fetch = (url, init) => Promise.resolve({
    ok: true, status: 201,
    json: () => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    }),
  });
  await assert.rejects(api.sendMessage(42, { content: 'hi', idempotencyKey: 'abcd-key-00002' }, { timeoutMs: 20 }), api.MessagesTimeoutError);

  // An answer in time is the message, and the server's no is still its own.
  globalThis.fetch = async () => ({ ok: true, status: 201, json: async () => ({ message: serverMessage(9, ME, 'hi') }) });
  assert.equal((await api.sendMessage(42, { content: 'hi', idempotencyKey: 'abcd-key-00003' }, { timeoutMs: 20 })).id, 9);
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: 'slow down' }) });
  await assert.rejects(api.sendMessage(42, { content: 'hi', idempotencyKey: 'abcd-key-00004' }, { timeoutMs: 20 }), api.MessagesApiError);
});

// ── The row ──────────────────────────────────────────────────────────────

function row(props) {
  // Rendered as the server renders: no document (the store harness set one).
  delete globalThis.document;
  globalThis.window = {
    App: { user: ME },
    location: { search: '', hash: '#messages/42' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => fn(),
    setTimeout, clearTimeout,
  };
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  return renderToHtml(createElement(MessageRow, { conversationId: 42, kind: 'group', ...props }));
}

function local(over) {
  return {
    id: -1, conversationId: 42, sender: ME, content: 'Sent while blackhole', createdAt: new Date().toISOString(),
    reply: null, reactions: [], attachments: [], objects: [], clientKey: 'row-key-000001', ...over,
  };
}

test('the row says where a message not yet sent stands, on the line "Not sent" uses', () => {
  const quick = row({ message: local({ pending: true }) });
  assert.doesNotMatch(quick, /messages-message-send-note/, '#2907: a send that answers in a couple of seconds shows only the fade');
  assert.doesNotMatch(quick, new RegExp(message('messages:row.sending')));

  const slow = row({ message: local({ pending: true, createdAt: new Date(Date.now() - 5000).toISOString() }) });
  assert.match(slow, /<div class="messages-message-meta messages-message-send-note" role="status"><span>Sending…<\/span><\/div>/);
  assert.equal(message('messages:row.sending'), 'Sending…');

  const queued = row({ message: local({ queued: true }) });
  assert.match(queued, /messages-message-send-note" role="status"><span>Will send when you’re back online<\/span><button type="button" class="messages-discard">Discard<\/button>/);
  assert.doesNotMatch(queued, /messages-message-actions/, 'no reactions or replies on a message the server does not have');
  assert.doesNotMatch(queued, /messages-message-pending|messages-retry/);
  assert.equal(message('messages:row.queued'), 'Will send when you’re back online');

  const failed = row({ message: local({ failed: true }) });
  assert.match(failed, /messages-message-failed-note/);
  assert.match(failed, /class="messages-retry"/);
  assert.doesNotMatch(failed, /messages-message-send-note/);

  const { SLOW_SEND_MS } = loadTsx('frontend/src/features/messages/message-row.tsx');
  assert.equal(SLOW_SEND_MS, 2000);
  assert.match(CSS, /\.messages-message-meta\.messages-message-failed-note,\n\.messages-message-meta\.messages-message-send-note \{ display: flex;/,
    'the send note is laid out as the Not sent line is, so one replacing the other moves nothing');
  assert.match(CSS, /\.messages-message-pending \{ opacity: \.55; \}/);
});
