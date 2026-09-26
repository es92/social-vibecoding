'use strict';

// #3177: the dev chat treats a stream that breaks after `accepted` as a
// delivered message on a lost connection, not a failed send
// (DevChat.sendMessage in frontend/src/features/dev-chat/dev-chat.js).
//
// POST /api/sessions/:id/chat now opens its stream with `accepted` once the
// message is stored. Past that event, a broken stream (a slow or mobile
// network dropping it a few hundred bytes in) leaves the turn's live cue up
// and resumes the turn from the event's _seq through GET /events?since=.
// A stream that breaks before it keeps the old handling.
//
// Drives the REAL sendMessage in a vm with a fake DOM, the
// tests/devchat-composer-restore.test.js harness, with a response body that
// carries some frames and then fails the way a dropped connection does.
//
// Run with: node --test tests/dev-chat-accepted-delivery.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

const encoder = new TextEncoder();
const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

// A body that carries `frames`, then breaks like a dropped connection.
function brokenStream(frames) {
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
    },
    pull(controller) {
      controller.error(new TypeError('network error'));
    },
  });
}

function makeElement(id) {
  return {
    id,
    style: {},
    dataset: {},
    disabled: false,
    value: '',
    innerHTML: '',
    textContent: '',
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { return c; },
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function makeHarness(frames) {
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };
  const storage = new Map();
  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    TextDecoder,
    AbortController,
    document: {
      title: 'MyApp',
      getElementById: getEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => makeElement(`__created_${tag}`),
      addEventListener() {},
      removeEventListener() {},
      visibilityState: 'visible',
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    fetch: async () => ({ ok: true, status: 200, body: brokenStream(frames) }),
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    Notifications: {},
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  const calls = { removeSpinner: 0, resumed: [] };
  DevChat.renderMessages = () => {};
  DevChat.scrollToBottom = () => {};
  DevChat.refreshBudget = () => {};
  DevChat._showSpinner = () => {};
  DevChat._removeSpinner = () => { calls.removeSpinner += 1; };
  DevChat._flushStreamingFinal = () => {};
  DevChat._stopProgressPolling = () => {};
  DevChat._closeResumableStream = () => {};
  DevChat._openResumableStream = (sessionId) => { calls.resumed.push({ sessionId, since: DevChat._lastSeenSeq }); };
  DevChat._startProgressPolling = () => {};
  DevChat._setStreamingUI = () => {};
  return { DevChat, calls, getEl };
}

const SESSION_ID = 42;
const MSG = 'add a dark mode toggle';

async function send(DevChat) {
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.messages = [];
  DevChat.isStreaming = false;
  await DevChat.sendMessage(MSG);
}

test('a stream that breaks after `accepted` keeps the turn live and resumes it from there', async () => {
  const accepted = { type: 'accepted', _seq: 'lx9-1', messageId: 1001, clientMessageId: null };
  const { DevChat, calls, getEl } = makeHarness([frame(accepted)]);
  await send(DevChat);

  assert.equal(calls.removeSpinner, 0, 'the live cue stays up: the message was delivered');
  assert.equal(DevChat.isStreaming, true, 'the turn is still being followed');
  assert.deepEqual(calls.resumed, [{ sessionId: SESSION_ID, since: 'lx9-1' }],
    'the resumable stream picks the turn up from the accepted event');
  assert.ok(DevChat.messages.some((m) => m.role === 'user' && m.content === MSG),
    'the sent message stays in the transcript');
  assert.equal(getEl('dc-input').value, '', 'nothing is handed back to the composer');
});

test('a stream that breaks before `accepted` keeps the old handling', async () => {
  const { DevChat, calls } = makeHarness([]);
  await send(DevChat);

  assert.equal(calls.removeSpinner, 1, 'no proof of delivery: the live cue drops as before');
  assert.deepEqual(calls.resumed, [{ sessionId: SESSION_ID, since: null }],
    'and the same fallback still looks for the turn');
});
