'use strict';

// A message notification is a NOTIFICATION, and the bell is where it is
// counted.
//
// #1431 gave unread Messages a number of their own on a header chat bubble;
// #1443 kept the number and moved it onto the Messages ROW of the app chip's
// menu, subtracting `conversation_message` from the bell so one event could
// not light two badges. This reverses which side of that split survives.
//
// The rule it was defending is unchanged and still holds — one event, one
// badge. What changed is the answer to WHICH badge. The menu behind the chip
// is where you say where you are going; an unread count is a report that
// something happened to you, and the surface for that is the bell, whose
// sheet has rendered `conversation_*` rows with their own per-kind copy since
// #488. So the row lost its tag, the bell got its count back, and the number
// that was genuinely better about the retired one — that it is
// per-conversation — still exists on the conversation rows inside Messages,
// where it reads as a count rather than as an alert.
//
// 19 OCT 2026 (#18 of the polish board): the bell keeps the alerts and
// leaves PLAIN MESSAGES to the Messages tab. With one meaning per badge (red
// the bell, grey new to read, the accent waiting on you) one unread direct
// message lit the bell's red 1, the tab's grey 1 and a count on its row. The
// rows are still written and still listed in the bell's sheet; the server
// says how many of `unread` are `conversation_message` / `channel_message`
// (`messageUnread`, countUnreadSplit) and the bell's figure leaves them out.
// A mention, a reply to you and a thread you are in still ring it.
//
// Frontend logic is extracted from the shipped source (so these can't drift
// from what runs) and exercised against stubs, in the style of
// tests/notifications-mark-all.test.js.
//
// Run with: node --test tests/message-notifications-in-the-bell.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const FE_SRC = read('frontend/src/features/notifications/notifications.js');
const STORE_SRC = read('frontend/src/features/messages/store.ts');
const SHEET_SRC = read('frontend/src/features/app-context/app-context-sheet.tsx');
const HTML = read('public/index.html');

// Pull a 2-space-indented object method's body out of the source so we can
// rebuild it as a standalone callable closing over injected stubs. Same
// helper, same reason, as tests/notifications-mark-all.test.js.
function methodBody(name) {
  const re = new RegExp(name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},');
  const m = FE_SRC.match(re);
  assert.ok(m, name + '() definition found in notifications.js');
  return m[1];
}

// ── 1. the count is back on the bell ────────────────────────────────────

test('the bell counts every unread kind but plain messages, plus pending invites', () => {
  // The body is a single `return`, so it is the function body as extracted.
  const badgeTotal = new Function('Notifications', methodBody('_badgeTotal'));
  // #18: nine unread, four of them plain messages: the bell says six.
  assert.equal(badgeTotal({ unread: 9, messageUnread: 4, invites: [{ appId: 1 }] }), 6);
  assert.equal(badgeTotal({ unread: 2, messageUnread: 5, invites: [] }), 0, 'never below zero');

  // Nine unread on the account: four of them messages, two of them the
  // session kinds #improve-btn used to carry. Nothing is subtracted now
  // (#1610) — the bell is the only badge, so a split would only lose a count
  // on a surface that could not clear it.
  const count = badgeTotal({ unread: 9, invites: [{ appId: 1 }] });
  assert.equal(count, 10, 'with no plain messages, every unread kind is counted, plus invites');

  assert.doesNotMatch(FE_SRC, /_bellUnread/,
    'the session subtraction is gone, not merely unused');
  assert.doesNotMatch(FE_SRC, /_sessionUnread\b/,
    'and so is the half of the split it read');
});

test('nothing in notifications.js counts or paints a messages badge', () => {
  assert.doesNotMatch(FE_SRC, /_messageUnread/,
    'the conversation_message subtraction is gone, not merely unused');
  assert.doesNotMatch(FE_SRC, /__usernodeMessagesUnread/,
    'the window seam the retired badge was published on is gone');
  assert.doesNotMatch(FE_SRC, /drawer-messages-badge/,
    '_renderBadge paints the bell only');
  assert.doesNotMatch(FE_SRC, /notifications-badge-ai/,
    'nor the retired green count on #improve-btn (#1610)');
});

// ── 2. …and off the row behind the app chip ─────────────────────────────

test('Messages is a TAB, and the tab is where its count lives', () => {
  // #2718 moved the destination out of the chip's menu onto the bar, and
  // moved the argument with it. #1443 retired a per-conversation badge from
  // the menu ROW on the reading that a menu is where you say where you are
  // going rather than where you learn something happened — true of a row you
  // have to open a sheet to see, and not of a tab that is on screen already.
  // So the tab carries a count and the retired row's badge stays retired.
  assert.match(HTML, /id="platform-tab-messages"[^>]*href="#messages"/,
    'the destination is a tab');
  assert.match(HTML, /id="platform-tabs-badge"/, 'which can say there is something there');
  assert.doesNotMatch(HTML, /id="switcher-row-messages"/,
    'and the menu row it replaces is gone, not merely unlabelled');
  assert.doesNotMatch(HTML, /drawer-messages-badge/,
    'the unread tag is gone from the shell, not shipped hidden');
  assert.doesNotMatch(SHEET_SRC, /id="drawer-messages-badge"/);

  // The per-conversation counts that made the retired badge defensible still
  // exist — inside Messages, on the conversation rows, where they read as
  // counts rather than as an alert.
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /conversation\.unreadCount > 0 \?/,
    'the Messages screen still shows a per-conversation unread count');
});

// ── 3. reading a conversation clears it from the bell, in this tab ──────

// The bell owning the count is what makes this load-bearing: the server
// clears a conversation's notification rows inside POST
// /api/conversations/:id/read, but nothing told THIS document, so the badge
// would have gone on counting messages the viewer had just sat and read.
function buildMarkConversationRead() {
  return new Function('Notifications', 'conversationId', methodBody('markConversationRead'));
}

function stubNotifications(items, unread) {
  const calls = { badge: 0, list: 0 };
  return {
    items,
    unread,
    calls,
    _renderBadge() { calls.badge += 1; },
    _renderList() { calls.list += 1; },
  };
}

test('markConversationRead clears that conversation and walks the total down', () => {
  const markConversationRead = buildMarkConversationRead();
  const items = [
    { id: 1, kind: 'conversation_message', conversationId: 5, readAt: null },
    { id: 2, kind: 'conversation_mention', conversationId: 5, readAt: null },
    // Already read: it must not be counted twice against `unread`.
    { id: 3, kind: 'conversation_message', conversationId: 5, readAt: '2026-08-01T00:00:00Z' },
    // Another conversation, and a notification with no conversation at all.
    { id: 4, kind: 'conversation_message', conversationId: 6, readAt: null },
    { id: 5, kind: 'kudos', appId: 3, conversationId: null, readAt: null },
  ];
  const N = stubNotifications(items, 4);
  N.messageUnread = 1;

  markConversationRead(N, 5);

  assert.equal(items[0].readAt !== null, true);
  assert.equal(items[1].readAt !== null, true);
  assert.equal(items[2].readAt, '2026-08-01T00:00:00Z', 'an already-read row is untouched');
  assert.equal(items[3].readAt, null, 'another conversation keeps its unread row');
  assert.equal(items[4].readAt, null, 'a non-conversation notification is untouched');
  assert.equal(N.unread, 2, 'the total falls by exactly what cleared');
  assert.equal(N.messageUnread, 0, '#18: and the plain messages among it, from what they were');
  assert.equal(N.calls.badge, 1);
  assert.equal(N.calls.list, 1);
});

test('markConversationRead is inert when there is nothing to clear', () => {
  const markConversationRead = buildMarkConversationRead();
  const items = [{ id: 1, kind: 'conversation_message', conversationId: 5, readAt: '2026-08-01T00:00:00Z' }];
  const N = stubNotifications(items, 3);

  markConversationRead(N, 5);
  assert.equal(N.unread, 3, 'a conversation with nothing unread does not move the total');
  assert.equal(N.calls.badge, 0, 'and does not repaint');

  // Never below zero: `unread` is the server's total and the items array is
  // one loaded page of it, so the two can disagree.
  const short = stubNotifications(
    [{ id: 2, kind: 'conversation_message', conversationId: 7, readAt: null },
      { id: 3, kind: 'conversation_message', conversationId: 7, readAt: null }],
    1,
  );
  markConversationRead(short, 7);
  assert.equal(short.unread, 0);

  // A junk id reaches the loop with nothing to match; guard before it does.
  const guarded = stubNotifications([{ id: 4, conversationId: 7, readAt: null }], 1);
  for (const bad of [0, -1, 1.5, NaN, null, undefined, 'seven']) {
    markConversationRead(guarded, bad);
  }
  assert.equal(guarded.unread, 1);
  assert.equal(guarded.calls.badge, 0);
});

// #2387: a message inside a reply thread is read by reading THAT thread. The
// server's main-stream read leaves those alerts unread, so clearing them here
// only bounced the badge back on the next refresh.
test('a conversation read leaves its reply threads\' alerts; a thread read clears only that thread', () => {
  const markConversationRead = buildMarkConversationRead();
  const markThreadRead = new Function('Notifications', 'conversationId', 'rootId',
    methodBody('markConversationThreadRead'));
  const items = [
    { id: 1, kind: 'conversation_message', conversationId: 5, readAt: null },
    { id: 2, kind: 'conversation_thread_reply', conversationId: 5, conversationThreadRootId: 40, readAt: null },
    { id: 3, kind: 'conversation_mention', conversationId: 5, conversationThreadRootId: 41, readAt: null },
    { id: 4, kind: 'conversation_thread_reply', conversationId: 6, conversationThreadRootId: 40, readAt: null },
  ];
  const N = stubNotifications(items, 4);
  markConversationRead(N, 5);
  assert.deepEqual(items.map((n) => !!n.readAt), [true, false, false, false]);
  assert.equal(N.unread, 3);

  markThreadRead(N, 5, 40);
  assert.deepEqual(items.map((n) => !!n.readAt), [true, true, false, false],
    'that thread only — not another thread, not the same root id in another conversation');
  assert.equal(N.unread, 2);
  markThreadRead(N, 5, 'x');
  assert.equal(N.unread, 2, 'a junk root clears nothing');
});

// ── 4. the Messages store is what calls it ──────────────────────────────

test('the Messages store tells the bell on a local read, and on its own cross-tab read', () => {
  assert.match(STORE_SRC, /window\.Notifications\?\.markConversationRead\?\.\(conversationId\)/,
    'the seam is window.Notifications: notifications.js must stay import-free');

  const markRead = STORE_SRC.slice(
    STORE_SRC.indexOf('export async function markRead('),
    STORE_SRC.indexOf('function eventConversationId('),
  );
  const publishAt = markRead.indexOf('publish({ conversations: items })');
  const notifyAt = markRead.indexOf('notifyConversationRead(conversationId)');
  assert.ok(publishAt > -1 && notifyAt > publishAt,
    'the bell is reconciled on the local read, without waiting for the round-trip');

  const readEvent = STORE_SRC.slice(
    STORE_SRC.indexOf("case 'conversation_read':"),
    STORE_SRC.indexOf("case 'conversation_membership_changed':"),
  );
  assert.match(readEvent, /=== currentUser\(\)\.id/,
    'the event fans out to every member, so only the reader\'s own tabs clear');
  assert.match(readEvent, /notifyConversationRead\(conversationId\)/);

  assert.doesNotMatch(STORE_SRC, /drawer-messages-badge/,
    'syncDrawerBadge and its listener are gone with the element they wrote to');
});

// ── 5. the server says how many are plain messages (#18) ────────────────

test('countUnreadSplit reads the total and the plain messages in one query', async () => {
  const notifications = require('../src/services/notifications');
  assert.deepEqual(notifications.MESSAGE_KINDS, ['conversation_message', 'channel_message']);
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rows: [{ c: 7, m: 3 }] }; } };
  assert.deepEqual(await notifications.countUnreadSplit(pool, 5), { unread: 7, messageUnread: 3 });
  assert.equal(calls.length, 1);
  // #5580: a plain message is one of the two message kinds, except the
  // Homeroom bot's news about a project, which carries that project and is
  // the bell's like any project's notification.
  assert.match(calls[0].sql, /COUNT\(\*\) FILTER \(WHERE \(n\.kind = 'channel_message' OR \(n\.kind = 'conversation_message' AND n\.app_id IS NULL\)\)\)/);
  assert.match(calls[0].sql, /COUNT\(\*\)::int AS c FROM notifications AS n/, 'the total keeps countUnread\'s shape');
  assert.equal(calls[0].params.length, 2, 'the message kinds are in the rule, not a parameter');
  // The same rows as countUnread, which the phone's icon keeps counting.
  const total = notifications.countUnread.toString();
  for (const piece of ['DECIDED_ASK_SETTLED_SQL', 'CONVERSATION_ACCESS_SQL', 'CHAT_SENDER_ACCESS_SQL', 'PARKED_KINDS_SQL']) {
    assert.ok(total.includes(piece) && notifications.countUnreadSplit.toString().includes(piece), piece);
  }
  // Every response that hands the bell its count hands it both.
  const route = read('src/routes/notifications.js');
  assert.match(route, /Object\.assign\(payload, await notifications\.countUnreadSplit\(pool, req\.user\.id\)\);/);
  assert.equal((route.match(/res\.json\(\{ unread, messageUnread, cleared \}\)/g) || []).length, 5);
  assert.doesNotMatch(route, /notifications\.countUnread\(/, 'no response carries the total alone');
  // …and the client keeps both, wherever it takes the server's word.
  const takes = FE_SRC.match(/Notifications\.unread = data\.unread \|\| 0;/g) || [];
  const both = FE_SRC.match(/Notifications\.unread = data\.unread \|\| 0;\n\s*Notifications\.messageUnread = Number\(data\.messageUnread\) \|\| 0;/g) || [];
  assert.ok(takes.length >= 5);
  assert.equal(both.length, takes.length);
});
