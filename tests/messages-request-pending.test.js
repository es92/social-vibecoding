'use strict';

// QA 2026-09-24 Q2 and Q33a: a direct message REQUEST, from both ends.
//
// Q2, the sender. A DM to someone who has not accepted yet carries one
// opening message. Every later one used to come back "Not sent · Retry ·
// Discard": the service answered null, the route turned that into a 404
// "Conversation not found", and the Retry could never succeed — and nothing
// said the other person had to accept first. Now:
//
//   * the service refuses with `awaiting_acceptance` and the route answers
//     409 with that code (tests/platform-messaging-postgres.test.js runs the
//     SQL; tests/platform-messaging-core.test.js pins the guard);
//   * the conversation says so — `awaitingAcceptance`, with `canSend` false
//     once the opening message is spent;
//   * the composer says who it is waiting for in place of a box whose sends
//     would all fail, and a stale client's refused send goes back to the
//     draft rather than into a doomed Retry row.
//
// Q33a, the recipient. The request's row and header read "Direct message"
// over an anonymous "DM" tile, and named the sender only inside the banner
// text. The requester is deliberately part of an invitation's payload (so the
// recipient can decide), so the row, the header and Recents name them.
//
// Run with: node --test tests/messages-request-pending.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ROUTE = read('src/routes/conversations.js');
const SERVICE = read('src/services/conversations.js');
const SCREEN = read('frontend/src/features/messages/index.tsx');

const ME = { id: 7, username: 'me', avatarUrl: null };
const THEM = { id: 8, username: 'usernode-capture', avatarUrl: null };

// ── The wire ────────────────────────────────────────────────────────────

test('a second pre-acceptance send is a 409 awaiting_acceptance, not a 404', () => {
  assert.match(ROUTE, /const AWAITING_ACCEPTANCE = Object\.freeze\(\{ error: 'awaiting_acceptance' \}\);/);
  assert.match(ROUTE, /if \(error === 'awaiting_acceptance'\) return res\.status\(409\)\.json\(AWAITING_ACCEPTANCE\);/);
  // The send route reads the service's error before its null → 404.
  assert.match(ROUTE, /conversations\.sendMessage\(pool, req\.user, id, input\);\s*if \(result\?\.error\) return sendMessageError\(res, result\.error\);\s*if \(!result\) return sendNotFound\(res\);/);
});

test('the conversation says it is waiting, and canSend turns false once the opening message is spent', () => {
  assert.match(SERVICE, /SELECT other\.user_id, other\.status FROM conversation_members other/);
  assert.match(SERVICE, /const awaitingAcceptance = row\.kind === 'direct' && accepted && row\.status === 'active'\s*&& row\.peer_status === 'invited';/);
  assert.match(SERVICE, /canSend: row\.membership_status === 'member' && row\.status === 'active'\s*&& !\(awaitingAcceptance && row\.has_messages\),/);
});

test('the client reads awaitingAcceptance, for a direct conversation only', () => {
  const api = loadTsx('frontend/src/features/messages/api.ts');
  const direct = api.normalizeConversation({ id: 3, kind: 'direct', membershipStatus: 'member', awaitingAcceptance: true, canSend: false });
  assert.equal(direct.awaitingAcceptance, true);
  assert.equal(direct.canSend, false);
  assert.equal(api.normalizeConversation({ id: 3, kind: 'direct', membershipStatus: 'member' }).awaitingAcceptance, false);
  assert.equal(api.normalizeConversation({ id: 4, kind: 'group', awaitingAcceptance: true }).awaitingAcceptance, false);
});

// ── The composer ────────────────────────────────────────────────────────

function composerHtml(snap) {
  const store = {
    channels: () => [], draftFor: () => '', notifyTyping() {}, replyFor: () => null,
    scopeKey: (c, t) => (t ? `${c}:t${t}` : c), send: async () => {}, setDraft() {}, setReply() {},
    takePendingShare: () => undefined, useMessagesSnapshot: () => snap,
  };
  const { MessageComposer } = loadTsx('frontend/src/features/messages/composer.tsx', {
    stubs: {
      './store': store,
      './api': {},
      '../friends/store': { orderFriendsFirst: (list) => list, useFriendIds: () => [] },
      '../../lib/use-auto-grow': { useAutoGrow() {} },
    },
  });
  return renderToHtml(createElement(MessageComposer, {}));
}

function pendingDirect(extra = {}) {
  return {
    id: 42, kind: 'direct', title: THEM.username, membershipStatus: 'member', myRole: 'member',
    peer: THEM, members: [{ ...ME, role: 'member', status: 'member' }, { ...THEM, role: 'member', status: 'invited' }],
    memberCount: 1, unreadCount: 0, canInvite: false, canManage: false,
    awaitingAcceptance: true, canSend: true, ...extra,
  };
}

function snapshot(active, messages = []) {
  return { route: { conversationId: 42 }, active, messages, conversations: [], discussions: [] };
}

test('before the opening message: the composer, and one line saying what it will be', () => {
  const html = composerHtml(snapshot(pendingDirect()));
  assert.match(html, /<textarea[^>]*aria-label="Message"/, 'the opening message can still be written');
  assert.match(html, /class="messages-composer-hint"[^>]*>@usernode-capture gets your first message as a message request\. You can send more once they accept\./);
  assert.doesNotMatch(html, /Waiting for/);
});

test('after the opening message: no composer, and the thread says who it is waiting for', () => {
  const sent = { id: 1, conversationId: 42, sender: ME, content: 'Hi there!', createdAt: '2026-09-24T12:00:00Z', reactions: [], attachments: [], objects: [] };
  for (const html of [
    // The optimistic row counts, so a quick second Enter cannot slip in.
    composerHtml(snapshot(pendingDirect(), [{ ...sent, id: -1, pending: true }])),
    // And a reload, where the server already says canSend is spent.
    composerHtml(snapshot(pendingDirect({ canSend: false }))),
  ]) {
    assert.doesNotMatch(html, /<textarea/, 'no box whose sends would all fail');
    assert.match(html, /data-awaiting-acceptance=""/);
    assert.match(html, /<strong>Message request sent<\/strong>/);
    assert.match(html, /Waiting for @usernode-capture to accept your message request\. You can send more once they do\./);
    assert.doesNotMatch(html, /You can’t send messages in this conversation/);
  }
});

test('once accepted, the composer is the plain one again', () => {
  const html = composerHtml(snapshot(pendingDirect({ awaitingAcceptance: false }), [
    { id: 1, conversationId: 42, sender: ME, content: 'Hi', createdAt: '2026-09-24T12:00:00Z', reactions: [], attachments: [], objects: [] },
  ]));
  assert.match(html, /<textarea/);
  assert.doesNotMatch(html, /data-awaiting-acceptance/);
});

// ── A stale client's refused send ───────────────────────────────────────

test('a send refused as awaiting_acceptance leaves no Retry row, and its words go back to the draft', async () => {
  class MessagesApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const conversation = pendingDirect({ awaitingAcceptance: false, canSend: true });
  let gets = 0;
  const api = {
    MessagesApiError,
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async () => [conversation],
    getConversation: async () => { gets += 1; return gets > 1 ? { ...conversation, awaitingAcceptance: true, canSend: false } : conversation; },
    listMessages: async () => ({ messages: [], nextBefore: null }),
    markRead: async () => {},
    listAppDiscussions: async () => ({ discussions: [] }),
    sendMessage: async () => { throw new MessagesApiError(409, 'awaiting_acceptance'); },
  };
  let read = null;
  const react = { useSyncExternalStore: (subscribe, snap) => { read = snap; return snap(); } };
  globalThis.window = {
    App: { user: ME },
    location: { search: '', hash: '#messages/42' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  const store = loadTsx('frontend/src/features/messages/store.ts', { stubs: { './api': api, react } });
  store.useMessagesSnapshot();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  store.messagesController.route(42);
  for (let i = 0; i < 5; i += 1) await flush();
  await store.send({ content: 'Are you around?' });
  for (let i = 0; i < 5; i += 1) await flush();
  const state = read();
  assert.equal(state.messages.filter((item) => item.failed).length, 0, 'no "Not sent · Retry" row');
  assert.equal(state.messages.length, 0, 'the refused row is gone');
  assert.equal(store.draftFor(42), 'Are you around?', 'nothing typed is lost');
  assert.equal(state.active.awaitingAcceptance, true, 'the conversation was re-read, so the thread says why');
});

// ── Q33a: the recipient's side names the sender ─────────────────────────

test('an unanswered direct request is named by its requester in the row and the header', () => {
  const helper = SCREEN.slice(SCREEN.indexOf('function directPerson('), SCREEN.indexOf('function ConversationRow('));
  assert.match(helper, /conversation\.membershipStatus === 'invited' \? conversation\.requester \|\| null : null/);
  const row = SCREEN.slice(SCREEN.indexOf('function ConversationRow('), SCREEN.indexOf('function KindPill('));
  assert.match(row, /const peer = directPerson\(conversation\);/);
  assert.match(row, /title=\{peer\?\.username \|\| conversation\.title\}/, 'the tile is theirs, not "DM"');
  const header = SCREEN.slice(SCREEN.indexOf('function ThreadHeader('), SCREEN.indexOf('/** The day a message was sent'));
  assert.match(header, /const person = directPerson\(active\);/);
  // B5: named as senderName names it, the @handle for a person.
  assert.match(header, /active\.kind === 'direct' && person \? senderName\(person\)/);
  // The sender's own side of a request says it is pending too.
  assert.match(header, /active\.awaitingAcceptance \? 'Request pending' : 'Direct message'/);
});

test('the phone bar over an unanswered request names its requester too', () => {
  const STORE = read('frontend/src/features/messages/store.ts');
  assert.match(STORE, /: state\.route\.agent \? 'Messages' : chromeTitle\(state\.active\)\)/);
  const helper = STORE.slice(STORE.indexOf('function chromeTitle('));
  assert.match(helper, /active\.kind === 'direct' && active\.membershipStatus === 'invited' && active\.requester\?\.username\)\s*\{\s*return active\.requester\.username;/);
});

test('Recents names a request by its sender too', () => {
  const { buildRecents } = loadTsx('frontend/src/features/nav/recents.ts');
  const items = buildRecents({
    apps: [], discussions: [], agents: [], agentSessions: [], viewerId: ME.id,
    conversations: [{
      id: 5, kind: 'direct', title: 'Direct message', lastActivityAt: '2026-09-24T12:00:00Z', unreadCount: 0,
      peer: null, members: [], membershipStatus: 'invited', requester: { id: 1, username: 'localadmin' },
    }, {
      id: 6, kind: 'direct', title: 'Direct message', lastActivityAt: '2026-09-24T11:00:00Z', unreadCount: 0,
      peer: null, members: [], membershipStatus: 'member', requester: { id: 1, username: 'localadmin' },
    }],
  });
  const label = (id) => items.find((item) => item.key === `conversation:${id}`)?.label;
  assert.equal(label(5), '@localadmin');
  assert.equal(label(6), 'Direct message', 'only an unanswered request borrows its requester');
});
