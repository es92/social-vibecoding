'use strict';

// Two Messages fixes filed together by the platform admin:
//
//   #2907 — sending a message drew a loading indicator that pushed the
//           messages down. Decision: no sending indicator at all. The
//           sender's message is in the list at once, faded until the server
//           confirms it; a failed send offers Retry on that message. The
//           realtime echo of the send re-reads the thread silently.
//   #2905 — since #2895 a follow-up message from the same person was drawn
//           in a sliver of the row on a phone: three always-visible report /
//           block links took a column beside its text. They are one small ⋯
//           menu now, on both the app chat and the Messages transcript.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const ROW = read('frontend/src/features/messages/message-row.tsx');
const BAR = read('frontend/src/features/message-actions/action-bar.tsx');
const TRANSCRIPT = read('frontend/src/features/group-chat/transcript.tsx');
const CSS = read('public/css/app.css');
const DAPP = JSON.parse(read('dapp.json'));

// ── The store, run against a stubbed API ─────────────────────────────────

const ME = { id: 7, username: 'me', avatarUrl: null };
const THEM = { id: 8, username: 'them', avatarUrl: null };
const CONVERSATION = {
  id: 42, kind: 'group', title: 'Launch crew', membershipStatus: 'member', canSend: true,
  members: [ME, THEM], unreadCount: 0,
};

function serverMessage(id, sender, content) {
  return {
    id, conversationId: 42, sender, content, createdAt: new Date(Date.UTC(2026, 8, 23, 12, 0, id)).toISOString(),
    reply: null, reactions: [], attachments: [], objects: [],
  };
}

function harness() {
  const server = { messages: [serverMessage(1, THEM, 'hello')], nextId: 2, posts: [], failNext: 0 };
  const deferred = [];
  const api = {
    // The server's own answer, as api.ts throws it: a refused send is not
    // a network that went quiet (messages-send-offline.test.js has those).
    MessagesApiError: class extends Error { constructor(status, text) { super(text); this.status = status; } },
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async () => ({ conversations: [CONVERSATION] }),
    getConversation: async () => CONVERSATION,
    listMessages: async () => ({ messages: server.messages.map((item) => ({ ...item })), nextBefore: null }),
    markRead: async () => {},
    listAppDiscussions: async () => ({ discussions: [] }),
    sendMessage: (id, payload) => new Promise((resolve, reject) => {
      server.posts.push(payload);
      deferred.push(() => {
        if (server.failNext) { server.failNext -= 1; reject(new api.MessagesApiError(500, 'Server hiccup')); return; }
        // Idempotent, as services/conversations.js is: the same key is one row.
        const existing = server.messages.find((item) => item.key === payload.idempotencyKey);
        if (existing) { resolve({ ...existing }); return; }
        const message = { ...serverMessage(server.nextId++, ME, payload.content), key: payload.idempotencyKey };
        server.messages.push(message);
        resolve({ ...message });
      });
    }),
  };
  let read = null;
  const react = { useSyncExternalStore: (subscribe, snapshot) => { read = snapshot; return snapshot(); } };
  globalThis.window = {
    App: { user: ME },
    location: { search: '', hash: '#messages/42' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  // Online by the shell's probe too, and nothing kept on a device.
  const offline = { isOffline: () => false, probe: async () => {} };
  const outbox = { load: async () => [], save() {}, drop() {}, clear() {} };
  const store = loadTsx('frontend/src/features/messages/store.ts', {
    stubs: { './api': api, react, '../../lib/offline': offline, './outbox': { MAX_UNSENT: 50, messagesOutbox: () => outbox } },
  });
  store.useMessagesSnapshot();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const settle = async () => { while (deferred.length) deferred.shift()(); await flush(); await flush(); };
  return { store, server, state: () => read(), flush, settle };
}

async function openThread(h) {
  h.store.messagesController.route(42);
  for (let i = 0; i < 5; i += 1) await h.flush();
  assert.equal(h.state().messages.length, 1, 'the thread loaded');
}

test('a sent message is in the list at once, faded, and a refresh neither drops nor doubles it', async () => {
  const h = harness();
  await openThread(h);
  const sending = h.store.send({ content: 'on my way' });
  let rows = h.state().messages;
  assert.equal(rows.length, 2);
  const local = rows[1];
  assert.equal(local.content, 'on my way');
  assert.equal(local.pending, true, 'drawn as in flight');
  assert.ok(local.clientKey, 'drawn under its client key');

  // The realtime echo re-reads the thread while the POST is still out: the
  // server does not have the row yet, and the local one must stay.
  h.store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42 });
  for (let i = 0; i < 5; i += 1) await h.flush();
  assert.equal(h.state().loadingThread, false);
  rows = h.state().messages;
  assert.deepEqual(rows.map((item) => item.content), ['hello', 'on my way'], 'the local row survives the refresh');

  await h.settle();
  await sending;
  rows = h.state().messages;
  assert.deepEqual(rows.map((item) => item.content), ['hello', 'on my way'], 'confirmed once, not twice');
  assert.equal(rows[1].pending, undefined, 'the fade lifts');
  assert.equal(rows[1].clientKey, local.clientKey, 'same key, so the row is updated in place, not remounted');

  // A later refresh keeps that key on the server's copy.
  h.store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42 });
  for (let i = 0; i < 5; i += 1) await h.flush();
  assert.equal(h.state().messages[1].clientKey, local.clientKey);
  assert.equal(h.state().messages.length, 2);
});

test('an echo that lands after the server stored the row, before the POST returns, draws it once', async () => {
  const h = harness();
  await openThread(h);
  const sending = h.store.send({ content: 'raced' });
  const key = h.state().messages[1].clientKey;
  // The server has stored it (the echo went out) but the POST has not come back.
  h.server.messages.push({ ...serverMessage(h.server.nextId++, ME, 'raced'), key });
  h.store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42 });
  for (let i = 0; i < 5; i += 1) await h.flush();
  const rows = h.state().messages;
  assert.deepEqual(rows.map((item) => item.content), ['hello', 'raced']);
  assert.equal(rows[1].clientKey, key, 'the server copy takes the local row\'s key');
  await h.settle();
  await sending;
  assert.deepEqual(h.state().messages.map((item) => item.content), ['hello', 'raced']);
});

test('a failed send stays on its row with Retry, which sends it again under the same key', async () => {
  const h = harness();
  await openThread(h);
  h.server.failNext = 1;
  const sending = h.store.send({ content: 'try me' });
  await h.settle();
  await sending;
  let row = h.state().messages[1];
  assert.equal(row.failed, true);
  assert.equal(row.pending, false);

  const retry = h.store.retrySend(row.clientKey);
  row = h.state().messages[1];
  assert.equal(row.pending, true, 'Retry fades it again, in place');
  assert.equal(row.failed, false);
  await h.settle();
  await retry;
  row = h.state().messages[1];
  assert.equal(row.content, 'try me');
  assert.ok(row.id > 0, 'the server row replaced it');
  assert.equal(h.state().messages.length, 2);
  assert.equal(h.server.posts.length, 2);
  assert.equal(h.server.posts[0].idempotencyKey, h.server.posts[1].idempotencyKey, 'never stored twice');
});

test('a failed send can be discarded', async () => {
  const h = harness();
  await openThread(h);
  h.server.failNext = 1;
  const sending = h.store.send({ content: 'never mind' });
  await h.settle();
  await sending;
  h.store.discardFailed(h.state().messages[1].clientKey);
  assert.deepEqual(h.state().messages.map((item) => item.content), ['hello']);
});

// ── The screen and the row ───────────────────────────────────────────────

test('#2907: no loading row over a visible thread, no "sending…", no busy send button', () => {
  assert.match(SCREEN, /\{snap\.loadingThread && !snap\.messages\.length \? <div className="messages-state">/,
    'the spinner row is only for a thread with nothing to show yet');
  assert.doesNotMatch(ROW, /<span>sending…<\/span>/);
  assert.doesNotMatch(COMPOSER, /setSending|sending \? '…'/);
  // #2387: the send names the thread it goes into, when the composer is a thread's.
  assert.match(COMPOSER, /setValue\(''\); setAttachments\(\[\]\); setObject\(null\);\s*requestAnimationFrame[^\n]*\n\s*send\(\{ \.\.\.input, threadRootId \}\)/,
    'the box empties at once, before the round trip');
  assert.match(ROW, /className="messages-retry" onClick=\{\(\) => void retrySend\(/);
  assert.match(ROW, /messages-message-actions-reserved/, 'an in-flight row keeps its tray\'s place');
  assert.match(CSS, /\.messages-message-actions\.messages-message-actions-reserved \{ visibility: hidden; \}/);
  assert.match(CSS, /\.messages-message-pending \{ opacity: \.55; \}/);
});

test('#2905: report and block are one ⋯ menu on both transcripts', () => {
  assert.doesNotMatch(TRANSCRIPT, />Report message<\/button> : null\}\s*\{onReportUser/,
    'no longer three text links in the row\'s action slot');
  // #2387: the app chat's rows carry the shared hover bar too, and its ⋯
  // menu holds report and block after the everyday acts.
  assert.match(TRANSCRIPT, /<MessageActionBar[\s\S]*?moreClassName="gc-msg-more-action"/);
  assert.match(TRANSCRIPT, /label: translate\('chat:group\.menu\.report'\)[\s\S]*?label: msg\.usernameMissing \? translate\('chat:group\.menu\.blockUnknown'\) : translate\('chat:group\.menu\.block', \{ username: msg\.username \}\)/);
  assert.equal(message('chat:group.menu.report'), 'Report message');
  assert.equal(message('chat:group.menu.block', { username: 'ada' }), 'Block @ada');
  assert.doesNotMatch(TRANSCRIPT, /report-user|onReportUser|targetType: 'user'/,
    'message menus offer one report action, targeting the message');

  // #2387: the ⋯ is the shared hover bar's (../message-actions/action-bar.tsx),
  // and it keeps the class and the popup role the declared checks select on.
  assert.match(BAR, /moreClassName = 'messages-action-more'/);
  assert.match(BAR, /className=\{`msgx-bar-icon \$\{moreClassName\}[^`]*`\}[\s\S]{0,160}aria-haspopup="menu"/);
  assert.match(ROW, /<MessageActionBar[\s\S]*?onToggleMore=/);
  assert.doesNotMatch(ROW, />⚑<\/button>|>⊘<\/button>|>!<\/button>/, 'the three discs are gone');
  assert.match(ROW, /openReport\(\{ targetType: 'conversation_message'/);
  assert.doesNotMatch(ROW, /report-user|targetType: 'user'/,
    'private message menus also report only the message');
});

test('dapp.json declares the ⋯ menus', () => {
  const selectors = DAPP.tests.map((item) => item.expectSelector || '').join('\n');
  assert.match(selectors, /\.messages-message-actions > button\.messages-action-more\[aria-haspopup="menu"\]/);
});
