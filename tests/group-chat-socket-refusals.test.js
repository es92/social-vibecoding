// Refusals the chat socket answers to the sender, as public/js/group-chat.js
// shows them.
//
//   - `rate_limited` (admitSocketFrame in src/services/ws.js): a message,
//     edit or reaction sent faster than the person's budget. The composer has
//     already cleared, so a toast says it was not sent and when to try again.
//   - `error`: a refusal the server words itself, such as Homeroom's old
//     channel being read-only (`channel_moved`). handleIncoming had no case
//     for it, so it vanished with the message it answered. Every chat
//     message the server will not post is answered this way now
//     (`refuseChat`), and reads as not sent.
//
// Run with: node --test tests/group-chat-socket-refusals.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// group-chat.js is a classic script with no exports; load it into a vm with
// enough of a window to answer, and record the shell's toasts.
function loadGroupChat({ withToast = true } = {}) {
  const document = {
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, addEventListener() {}, appendChild() {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const toasts = [];
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document,
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    fetch: () => Promise.reject(new Error('no fetch expected')),
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.Notifications = { items: [], refresh() {} };
  sandbox.UsernodeReact = { groupChat: { patchTranscriptMessage() {} } };
  if (withToast) sandbox.PlatformUI = { toast: (text) => toasts.push(text) };
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/group-chat.js')}\nglobalThis.__M = { GroupChat };`, sandbox);
  const { GroupChat } = sandbox.__M;
  GroupChat.appSlug = 'demo';
  GroupChat.messages = [];
  GroupChat.render = () => {};
  return { GroupChat, toasts };
}

test('a message sent too fast says it was not sent and when to try again', () => {
  const { GroupChat, toasts } = loadGroupChat();
  GroupChat.handleIncoming({
    type: 'rate_limited',
    retryAfterSeconds: 12,
    error: "You're sending messages too fast. Try again in 12 seconds.",
    retry: { type: 'chat', content: 'hello' },
  });
  assert.deepEqual(toasts, ["Not sent. You're sending messages too fast. Try again in 12 seconds."]);
  assert.deepEqual(GroupChat.messages, [], 'nothing is drawn for the refused message');
});

test('one second is singular, and no number reads as "in a moment"', () => {
  const { GroupChat, toasts } = loadGroupChat();
  GroupChat.handleIncoming({ type: 'rate_limited', retryAfterSeconds: 1 });
  GroupChat.handleIncoming({ type: 'rate_limited' });
  GroupChat.handleIncoming({ type: 'rate_limited', retryAfterSeconds: 'soon' });
  GroupChat.handleIncoming({ type: 'rate_limited', retryAfterSeconds: 2.2 });
  assert.deepEqual(toasts, [
    "Not sent. You're sending messages too fast. Try again in 1 second.",
    "Not sent. You're sending messages too fast. Try again in a moment.",
    "Not sent. You're sending messages too fast. Try again in a moment.",
    "Not sent. You're sending messages too fast. Try again in 3 seconds.",
  ]);
});

test('the toast matches the words the server puts in the frame', () => {
  // The server's `error` (socketRetryPhrase) and the client's toast are
  // worded apart; they must say the same thing.
  const ws = read('src/services/ws.js');
  assert.match(ws, /error: `You're sending messages too fast\. Try again \$\{socketRetryPhrase\(retryAfterSeconds\)\}\.`/);
  assert.match(ws, /if \(!Number\.isFinite\(n\) \|\| n <= 0\) return 'in a moment';/);
  assert.match(ws, /return `in \$\{whole\} \$\{whole === 1 \? 'second' : 'seconds'\}`;/);
});

test('the read-only channel refusal is shown, not swallowed', () => {
  const { GroupChat, toasts } = loadGroupChat();
  GroupChat.handleIncoming({
    type: 'error',
    code: 'channel_moved',
    message: "This discussion is read-only now: Homeroom's channel is #general.",
  });
  assert.deepEqual(toasts, ["Not sent. This discussion is read-only now: Homeroom's channel is #general."]);
});

test('every chat message the server refuses says it was not sent (refuseChat)', () => {
  // Feedback, 21 Oct 2026: a reply on a change's page was refused as a
  // thread of another app, in silence, so it simply vanished from the box.
  const { GroupChat, toasts } = loadGroupChat();
  for (const code of ['invalid_thread', 'write_access_failed', 'invalid_attachment_ids', 'attachment_not_owned', 'send_failed']) {
    GroupChat.handleIncoming({ type: 'error', code });
  }
  GroupChat.handleIncoming({ type: 'error', code: 'not_collaborator', message: 'Only collaborators can post here.' });
  assert.deepEqual(toasts, [
    ...Array(5).fill('Not sent. Something went wrong. Try again.'),
    'Not sent. Only collaborators can post here.',
  ]);
  // Each code the server answers a chat message with is one the client
  // reads as not sent.
  const ws = read('src/services/ws.js');
  const answered = new Set([...ws.matchAll(/refuseChat\(client, msg, '([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(answered.size >= 6, 'the refusals are found');
  for (const code of answered) assert.ok(GroupChat.NOT_SENT_CODES.has(code), `${code} reads as not sent`);
});

test('any other error frame shows its own words', () => {
  const { GroupChat, toasts } = loadGroupChat();
  GroupChat.handleIncoming({ type: 'error', code: 'something_else', message: 'That did not work.' });
  GroupChat.handleIncoming({ type: 'error', error: 'Also not that.' });
  GroupChat.handleIncoming({ type: 'error' });
  assert.deepEqual(toasts, ['That did not work.', 'Also not that.', 'Something went wrong. Try again.']);
});

test('a page without the toast primitive does not throw', () => {
  const { GroupChat } = loadGroupChat({ withToast: false });
  assert.doesNotThrow(() => GroupChat.handleIncoming({ type: 'rate_limited', retryAfterSeconds: 3 }));
  assert.doesNotThrow(() => GroupChat.handleIncoming({ type: 'error', code: 'channel_moved', message: 'Read-only.' }));
});
