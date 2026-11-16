'use strict';

// Making a message findable in the bell, once the bell is where messages live.
//
// The move landed (#1446) and the notification was there — at the bottom of a
// flat chronological feed that also carries every session completion,
// proposal nudge and kudos row, four rows deep because a message notification
// is created per member PER MESSAGE. Two things follow from that, and this
// file pins both:
//
//   1. A run of consecutive same-conversation rows collapses into ONE row
//      carrying a count. This is the per-conversation quality the retired
//      Messages tag had and the bell gave up; it comes back here rather than
//      as a second badge somewhere else.
//   2. The sheet grew a Messages tab for a while, with a way out to the
//      #messages screen. #5289 took it out again: it repeated the Messages
//      tab in the bar, which lists the same conversations and the agents
//      beside them. The pins in part 2 hold that it stays gone.
//
// Frontend logic is extracted from the shipped source (so these cannot drift
// from what runs) and exercised against stubs, in the style of
// tests/notifications-mark-all.test.js.
//
// Run with: node --test tests/notifications-messages-tab.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const FE_SRC = read('frontend/src/features/notifications/notifications.js');
const SHEET_SRC = read('frontend/src/features/notifications/notifications-sheet.tsx');
const HTML = read('public/index.html');
const dapp = JSON.parse(read('dapp.json'));

// Rebuild a top-level function from the shipped source, so the collapsing
// rule under test is the one that ships.
function topLevelFn(name, args) {
  const re = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = FE_SRC.match(re);
  assert.ok(m, `${name}() found in notifications.js`);
  return new Function(...args, m[2]);
}

const collapse = topLevelFn('collapseConversationRuns', ['items']);

const msg = (id, conversationId, readAt = null) => ({
  id, kind: 'conversation_message', conversationId, readAt,
});

// ── 1. the collapsing rule ──────────────────────────────────────────────

test('a run of consecutive same-conversation rows becomes one counted run', () => {
  const runs = collapse([
    msg(4, 7), msg(3, 7), msg(2, 7), msg(1, 7),
  ]);
  assert.equal(runs.length, 1, 'four messages, one row');
  assert.equal(runs[0].count, 4);
  assert.equal(runs[0].item.id, 4, 'the run is represented by its NEWEST member');
});

test('a lone notification is a run of one, and app rows never merge', () => {
  const runs = collapse([
    msg(9, 7),
    { id: 8, kind: 'session_done', appId: 3, conversationId: null, readAt: null },
    { id: 7, kind: 'kudos', appId: 3, conversationId: null, readAt: null },
  ]);
  assert.equal(runs.length, 3, 'nothing collapses');
  assert.deepEqual(runs.map((r) => r.count), [1, 1, 1]);
  // Two app notifications for the SAME app sit next to each other above and
  // stay separate: a null conversation id must never match another null one,
  // or every app row in the feed would fold into its neighbour.
  assert.equal(runs[1].item.id, 8);
  assert.equal(runs[2].item.id, 7);
});

test('only CONSECUTIVE rows merge, so nothing is re-dated or reordered', () => {
  const runs = collapse([
    msg(5, 7),
    { id: 4, kind: 'session_done', appId: 3, conversationId: null, readAt: null },
    msg(3, 7),
    msg(2, 7),
  ]);
  assert.equal(runs.length, 3, 'the interrupted burst stays two separate rows');
  assert.deepEqual(runs.map((r) => r.count), [1, 1, 2]);
  // The feed is newest-first and each run sits where its newest member sat,
  // so the session row keeps its chronological place between the two bursts.
  assert.deepEqual(runs.map((r) => r.item.id), [5, 4, 3]);
});

test('two conversations back to back stay two rows', () => {
  const runs = collapse([msg(4, 7), msg(3, 7), msg(2, 8), msg(1, 8)]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.count), [2, 2]);
  assert.deepEqual(runs.map((r) => r.conversationId), [7, 8]);
});

test('read and unread never share a run', () => {
  const runs = collapse([msg(4, 7), msg(3, 7), msg(2, 7, '2026-08-01T00:00:00Z')]);
  assert.equal(runs.length, 2, 'the read one is its own row');
  assert.deepEqual(runs.map((r) => r.count), [2, 1]);
  assert.equal(runs[0].read, false);
  assert.equal(runs[1].read, true);
  // This is what lets the Unread tab filter whole ROWS: a run is entirely
  // unread or entirely read, so filtering can never hide an unread message
  // inside a row it counted as read.
  const merged = collapse([msg(9, 7), msg(8, 7, '2026-08-01T00:00:00Z')]);
  assert.ok(merged.every((r) => typeof r.read === 'boolean'));
  assert.equal(merged.length, 2);
});

test('the count rides only on a genuine collapse', () => {
  const views = FE_SRC.slice(FE_SRC.indexOf('function screenViews('),
    FE_SRC.indexOf('// One notification row, as data.'));
  assert.match(views, /run\.count > 1\s*\?/,
    'a single notification keeps the view it always had, with no count field');
});

// ── 2. #5289: no Messages filter in the bell ────────────────────────────

test('the strip is Unread and All, and nothing filters on a Messages tab', () => {
  assert.match(SHEET_SRC, /type Tab = 'all' \| 'unread';/);
  assert.doesNotMatch(SHEET_SRC, /notifications-tab-messages|notifications-all-messages|'messages'/);
  assert.doesNotMatch(SHEET_SRC, /notifications-see-older-messages|loadOlderMessages/);
  assert.doesNotMatch(HTML, /id="notifications-tab-messages"/);
  assert.match(HTML, /id="notifications-tab-unread"[\s\S]*?id="notifications-tab-all"/);
  // The pager it had, and the cursor behind it, went with it.
  assert.doesNotMatch(FE_SRC, /loadOlderMessages|msgNextBefore|msgHasMore/);
  // A conversation row still says it is one: the sheet draws a person for it
  // and never folds it into a kind group.
  assert.match(FE_SRC, /conversation: true,/);
  assert.doesNotMatch(FE_SRC, /AGENT_NOTIF_KINDS|agent: true/);
});

test('there is no Agents tab either, and the old deep link opens the sheet on Unread', () => {
  assert.doesNotMatch(SHEET_SRC, /notifications-tab-agents/);
  assert.doesNotMatch(SHEET_SRC, /'agents'/);
  assert.doesNotMatch(FE_SRC, /notifications-agents/);
  assert.match(FE_SRC, /shot !== 'notifications' && shot !== 'notifications-messages'/,
    'a link that still carries the old shot opens the sheet');
  assert.doesNotMatch(SHEET_SRC, /setTab\('messages'\)/);
  const effect = SHEET_SRC.slice(SHEET_SRC.indexOf('const [tab, setTab]'),
    SHEET_SRC.indexOf('const all = snap.screenList'));
  assert.match(effect, /useState<Tab>\('unread'\)/, 'the prerendered tab is Unread');
});

test('declared checks follow the agent rows to Messages and keep a collapsed row', () => {
  const has = (fragment) => dapp.tests.some((t) => (t.expectSelector || '').includes(fragment));
  assert.ok(!has('#notifications-tab-messages'));
  assert.ok(!has('#notifications-all-messages'));
  assert.ok(!dapp.tests.some((t) => /shot=notifications-messages/.test(t.path)));
  assert.ok(has('[data-notif-id="990207"] [aria-label="2 notifications"]'), 'a collapsed count is checked');
  // #18: a plain message is not on Unread, so its rows are checked on All,
  // which `?shot=notifications-all` opens the sheet on.
  const messageChecks = dapp.tests.filter((t) => (t.expectSelector || '').includes('[data-notif-id="990207"]'));
  assert.ok(messageChecks.length >= 2);
  for (const check of messageChecks) assert.equal(check.path, '/?shot=notifications-all&demo=1', check.name);
  assert.match(FE_SRC, /shot !== 'notifications-all'\) return;/, 'the All link opens the sheet');
  assert.match(SHEET_SRC, /if \(shot === 'notifications-all'\) setTab\('all'\);/, 'and the sheet lands on All');
  // The work-order row was checked on Messages' Agents list until that list
  // left Messages (16 Nov 2026); no check selects it on the bell either.
  assert.ok(!has('[data-improve-row'), 'no check selects a change or work-order row');
});
