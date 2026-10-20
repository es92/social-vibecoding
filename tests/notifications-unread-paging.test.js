'use strict';

// #5527: the Unread tab fills itself up to the badge.
//
// The bell's badge counts every unread row on the account (countUnread);
// the sheet's Unread tab showed only the unread among the newest 100 rows
// the ordinary feed returns. A backlog of unread behind a long run of read
// rows read as "bell says 46, list shows 1" — the admin who reported it had
// exactly that, four days of it. The fix has three halves, all pinned here:
//
//   * the ROUTE serves `?unread=1` as a page of unread rows only, under
//     the same filters the badge counts with, and as a follow-up page: no
//     unread aggregate, no invites, no saved lists — the client already
//     holds those;
//   * the CONTROLLER walks its own cursor (loadMoreUnread) to fetch those
//     pages until its list is as long as the badge, without disturbing the
//     All tab's cursor, deduping and re-sorting the merged feed;
//   * the SHEET auto-fills on opening and offers the foot button once
//     the auto-fill's five batches are spent.
//
// Harness shape mirrors tests/notifications-messages-tab.test.js: the REAL
// shipped sources, extracted by regex and rebuilt as callables over stubs.
//
// Run with: node --test tests/notifications-unread-paging.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const FE_SRC = read('frontend/src/features/notifications/notifications.js');
const SHEET_SRC = read('frontend/src/features/notifications/notifications-sheet.tsx');
const LOCALE = JSON.parse(read('frontend/locales/en/notifications.json'));
const { message } = require('./lib/platform-i18n');

// Pull a 2-space-indented object method's body out of the source so it can
// be rebuilt as a standalone callable closing over injected stubs.
function methodBody(name) {
  const re = new RegExp(name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},');
  const m = FE_SRC.match(re);
  assert.ok(m, name + '() definition found in notifications.js');
  return m[1];
}

// ── the route ───────────────────────────────────────────────────────────

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [], rowCount: 0 });
let queries = [];
const pool = { query: (...args) => poolQueryHandler(...args) };

function reset() {
  queries = [];
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
}

const routePath = require.resolve('../src/routes/notifications');
const prevGetPool = poolMod.getPool;
poolMod.getPool = () => pool;
const { notificationsRoutes } = require(routePath);
poolMod.getPool = prevGetPool;

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 5, username: 'alice' };
    next();
  });
  app.use(notificationsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlFor(server, pathPart) {
  return `http://127.0.0.1:${server.address().port}${pathPart}`;
}

// A feed row the big listForUser SELECT can come back with. Serialized
// below, so every column the client's rows read must be present.
const FEED_ROW = {
  id: 900, kind: 'mention', read_at: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  app_id: null, app_slug: null, app_name: null,
  chat_message_id: null, message_content: null,
  thread_type: null, thread_ref: null, root_thread_type: null, root_thread_ref: null,
  session_id: null, session_title: null, pr_title: null, pr_number: null,
  headless_issue_number: null, branch_name: null, agent_session_id: null,
  conversation_id: null, conversation_kind: null, conversation_title: null,
  conversation_invite_note: null, conversation_message_id: null,
  conversation_message_content: null, conversation_thread_root_id: null,
  source_username: null, source_user_id: null, detail: null,
  vote_reason: null, session_status: null, digest_waiting: null,
  bot_request_number: null, saved: false, saved_at: null,
};

const isFeedSelect = (sql) => /SELECT n\.id, n\.kind,/.test(sql);

test('?unread=1 serves a page of unread rows and no first-page aggregates', async () => {
  reset();
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (isFeedSelect(sql)) return { rows: [FEED_ROW], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/notifications?unread=1&limit=100'));
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.notifications.length, 1, 'the page comes back');
    assert.equal(payload.notifications[0].id, 900);
    assert.equal(payload.hasMore, false, 'one row under a 100 limit has no next page');
    assert.equal(payload.nextBefore, null);
    // The follow-up contract: the client already holds the aggregates from
    // the first page, so none of them are re-sent here.
    assert.equal(payload.unread, undefined, 'no badge count on an unread page');
    assert.equal(payload.pendingInvites, undefined, 'no invites on an unread page');
    assert.equal(payload.savedMessages, undefined, 'no saved messages on an unread page');
    assert.equal(payload.savedNotifications, undefined, 'no saved notifications on an unread page');
    // The unread clause went into the SQL — the same read state and
    // settled-ask filters countUnread applies — and `kind` did not.
    const feed = queries.find((q) => isFeedSelect(q.sql));
    assert.ok(feed);
    assert.match(feed.sql, /AND n\.read_at IS NULL AND NOT \(n\.kind IN \(/,
      'the page filters to unread rows, under the badge\'s settled-ask rule');
    assert.equal(
      (feed.sql.match(/n\.kind = ANY\(/g) || []).length, 1,
      'exactly one kind-membership clause remains (the merged-hidden rule) — '
      + 'a second would mean the `kind` filter leaked in',
    );
    assert.deepEqual(feed.params.slice(0, 1), [5], 'owned by the caller');
    // No badge aggregate was computed for an unread page.
    assert.ok(!queries.some((q) => /SELECT COUNT\(\*\)::int AS c/.test(q.sql)),
      'countUnread never runs for an unread page');
  } finally {
    server.close();
  }
});

test('?unread=1 ignores ?kind — the Unread list spans every kind', async () => {
  reset();
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (isFeedSelect(sql)) return { rows: [FEED_ROW], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server,
      '/api/notifications?unread=1&kind=conversation&limit=100'));
    assert.equal(res.status, 200);
    const feed = queries.find((q) => isFeedSelect(q.sql));
    assert.equal(
      (feed.sql.match(/n\.kind = ANY\(/g) || []).length, 1,
      'no conversation-kind clause despite ?kind=conversation',
    );
  } finally {
    server.close();
  }
});

test('the ordinary first page still carries the aggregates it always did', async () => {
  reset();
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (isFeedSelect(sql)) return { rows: [FEED_ROW], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/notifications?limit=100'));
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.unread, 0, 'the badge count is on the first page');
    assert.ok('pendingInvites' in payload, 'invites are too');
    assert.ok('savedMessages' in payload, 'and the saved lists');
    // And that page carries NO unread-only clause — read rows are listed.
    const feed = queries.find((q) => isFeedSelect(q.sql));
    assert.doesNotMatch(feed.sql, /AND n\.read_at IS NULL AND NOT \(n\.kind IN \(/,
      'the ordinary feed lists read rows, as it always has');
  } finally {
    server.close();
  }
});

// ── the controller: loadMoreUnread ─────────────────────────────────────

// Rebuild _unreadShort and loadMoreUnread over one stub object that also
// carries the state they read and write.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function buildController(state) {
  const N = {
    unread: state.unread,
    items: state.items.slice(),
    unreadHasMore: state.unreadHasMore,
    unreadNextBefore: state.unreadNextBefore,
    unreadLoading: false,
    // The All tab's cursor, deliberately marked with sentinels so a test
    // can see it is never touched.
    hasMore: 'ALL_HASMORE',
    nextBefore: 'ALL_CURSOR',
    _refreshGeneration: 1,
    _shown: (n) => !!n,
    _renderList() { N.rendered = (N.rendered || 0) + 1; },
  };
  const unreadShortFn = new Function('Notifications', methodBody('_unreadShort'));
  N._unreadShort = () => unreadShortFn(N);
  const loadMoreUnreadFn = new AsyncFunction('Notifications', 'options', methodBody('loadMoreUnread'));
  N.loadMoreUnread = (options) => loadMoreUnreadFn(N, options);
  return N;
}

// A fetched unread page: `count` rows continuing downward from `fromId`.
function unreadPage(count, fromId, createdAt) {
  return Array.from({ length: count }, (_, i) => ({
    id: fromId + i,
    kind: 'mention',
    readAt: null,
    createdAt,
  }));
}

test('loadMoreUnread walks its own cursor and never touches the All tab\'s', async () => {
  // The sheet's opening state, as the reported issue had it: a bell of 46,
  // a first page holding ONE unread row, and the unread cursor seeded
  // (unreadNextBefore null — the first unread batch starts where the
  // shared first page stopped).
  const pages = [
    unreadPage(20, 200, '2026-01-01T00:05:00Z'),
    unreadPage(20, 220, '2026-01-01T00:04:00Z'),
    unreadPage(6, 240, '2026-01-01T00:03:00Z'), // 1 + 20 + 20 + 6 = 47 > 46
  ];
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    const page = pages[urls.length - 1];
    return {
      ok: true,
      json: async () => ({
        notifications: page,
        hasMore: urls.length < pages.length,
        nextBefore: { createdAt: '2026-01-01T00:00:00Z', id: 999 + urls.length },
      }),
    };
  };
  const N = buildController({
    unread: 46,
    items: [unreadPage(1, 100, '2026-01-01T00:10:00Z')[0]],
    unreadHasMore: true,
    unreadNextBefore: null,
  });
  await N.loadMoreUnread();
  // Three batches: the run stops as soon as the list is as long as the
  // badge — the third page overshoots on purpose (a page can straddle the
  // badge boundary), and dedupe on id keeps the merged feed honest.
  assert.equal(urls.length, 3, `three batches fetch ${urls.length}`);
  assert.match(urls[0], /\/api\/notifications\?limit=100&unread=1$/,
    'the first batch starts from the shared first page, with no cursor of its own yet');
  assert.match(urls[1], /before=/, 'and every later batch carries the cursor');
  assert.match(urls[1], /before_id=/);
  assert.equal(N.items.length, 47, 'one first-page unread plus every fetched one');
  assert.equal(new Set(N.items.map((n) => n.id)).size, 47, 'no duplicates');
  assert.equal(N._unreadShort(), false, 'the list has caught up with the badge');
  assert.equal(N.unreadLoading, false, 'and the run is over');
  // The All tab's cursor is untouched: paging Unread may not strand the
  // rows between the two cursors' positions.
  assert.equal(N.hasMore, 'ALL_HASMORE', 'the All tab\'s hasMore is untouched');
  assert.equal(N.nextBefore, 'ALL_CURSOR', 'the All tab\'s cursor is untouched');
  delete global.fetch;
});

test('loadMoreUnread merges and re-sorts, newest first, across pages', async () => {
  const pages = [
    unreadPage(2, 300, '2026-01-01T00:01:00Z'),   // older
    unreadPage(2, 200, '2026-01-01T00:02:00Z'),   // newer than page 1
  ];
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    const page = pages[urls.length - 1];
    return {
      ok: true,
      json: async () => ({
        notifications: page,
        hasMore: urls.length < pages.length,
        // The real route only hands a cursor back when there is a next page.
        nextBefore: urls.length < pages.length
          ? { createdAt: '2026-01-01T00:00:30Z', id: 310 }
          : null,
      }),
    };
  };
  const N = buildController({
    unread: 5,
    items: [unreadPage(1, 100, '2026-01-01T00:10:00Z')[0]],
    unreadHasMore: true,
    unreadNextBefore: null,
  });
  await N.loadMoreUnread({ pages: 2 });
  assert.deepEqual(N.items.map((n) => n.id), [100, 201, 200, 301, 300],
    'the second page\'s newer rows sit above the first page\'s older ones, '
    + 'and a tie keeps the higher id first');
  assert.equal(N.unreadNextBefore, null, 'the exhausted cursor reads as nothing more');
  delete global.fetch;
});

test('loadMoreUnread stops at its page budget even while still short', async () => {
  // A backlog the five-batch auto-fill cannot finish: eight pages of five
  // rows, badge of 46. The run must stop after five, leave the cursor and
  // the hasMore standing, and leave the pager offered.
  const pages = Array.from({ length: 8 }, (_, p) => unreadPage(5, 1000 + p * 5, '2026-01-01T00:00:00Z'));
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const page = pages[calls - 1];
    return {
      ok: true,
      json: async () => ({
        notifications: page,
        hasMore: calls < pages.length,
        nextBefore: { createdAt: '2026-01-01T00:00:00Z', id: 2000 + calls },
      }),
    };
  };
  const N = buildController({
    unread: 46,
    items: [],
    unreadHasMore: true,
    unreadNextBefore: null,
  });
  await N.loadMoreUnread();
  assert.equal(calls, 5, 'five batches, then it stops');
  assert.equal(N.items.length, 25);
  assert.equal(N._unreadShort(), true, 'still short — the foot button takes over');
  assert.equal(N.unreadHasMore, true, 'the cursor says there is more');
  assert.equal(N.unreadLoading, false);
  delete global.fetch;
});

test('loadMoreUnread drops a page that lands after a newer refresh', async () => {
  // A refresh() runs while the batch is in flight: it re-seeds the feed and
  // the unread cursor, so mixing this page in would merge two cursors'
  // worth of rows. The page is dropped whole.
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) N._refreshGeneration = 2; // the refresh lands first
    return {
      ok: true,
      json: async () => ({
        notifications: unreadPage(5, 100, '2026-01-01T00:00:00Z'),
        hasMore: false,
        nextBefore: null,
      }),
    };
  };
  const N = buildController({
    unread: 46,
    items: [unreadPage(1, 50, '2026-01-01T00:10:00Z')[0]],
    unreadHasMore: true,
    unreadNextBefore: null,
  });
  await N.loadMoreUnread();
  assert.equal(N.items.length, 1, 'the stale page was dropped whole');
  assert.equal(N.unreadLoading, false, 'and the run unwound cleanly');
  delete global.fetch;
});

test('a failed page stops the run without losing the list', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const N = buildController({
    unread: 46,
    items: [unreadPage(1, 50, '2026-01-01T00:10:00Z')[0]],
    unreadHasMore: true,
    unreadNextBefore: null,
  });
  await N.loadMoreUnread();
  assert.equal(calls, 1, 'one attempt, then it stops');
  assert.equal(N.items.length, 1, 'the list is untouched');
  assert.equal(N.unreadLoading, false);
  delete global.fetch;
});

// ── published state ─────────────────────────────────────────────────────

test('both _renderList branches publish the Unread tab\'s pager state', () => {
  const branch = (marker) => {
    const at = FE_SRC.indexOf(marker);
    assert.ok(at > -1, `${marker} branch found`);
    return FE_SRC.slice(at, at + 2000);
  };
  for (const at of ['store.set({\n        list: [],', 'store.set({\n      list:']) {
    const body = branch(at);
    assert.match(body, /unreadCanLoadMore: Notifications\.unreadHasMore && Notifications\._unreadShort\(\)/,
      'the pager is offered only while the list is still shorter than the badge');
    assert.match(body, /loadingUnread: Notifications\.unreadLoading/,
      'and the in-flight flag rides along');
  }
});

test('the badge counts what the Unread tab pages: unread less plain messages, plus invites', () => {
  // #18 (19 Oct 2026 polish board): the bell leaves plain messages to the
  // Messages tab, so `?unread=1` leaves them out and _unreadShort compares
  // against the same figure.
  assert.match(FE_SRC, /_badgeTotal\(\) \{\s*\n\s*return Math\.max\(0, Notifications\.unread - \(Notifications\.messageUnread \|\| 0\)\) \+ Notifications\.invites\.length;\s*\n\s*\},/);
  assert.match(FE_SRC, /return loaded < Notifications\.unread - \(Notifications\.messageUnread \|\| 0\);/);
  // #5580: the Homeroom bot's reply about a project is the exception: it
  // carries that project, so it is not a plain message, and both the list
  // and the count read it by the same one rule.
  const svc = read('src/services/notifications.js');
  assert.match(svc, /const PLAIN_MESSAGE_SQL = `\(n\.kind = 'channel_message' OR \(n\.kind = 'conversation_message' AND n\.app_id IS NULL\)\)`;/);
  assert.match(svc, /AND NOT \$\{PLAIN_MESSAGE_SQL\}`;/);
  assert.match(svc, /COUNT\(\*\) FILTER \(WHERE \$\{PLAIN_MESSAGE_SQL\}\)/);
});

// ── the sheet ───────────────────────────────────────────────────────────

test('the Unread tab grows the foot button, above "See older notifications"', () => {
  const block = SHEET_SRC;
  const btn = block.indexOf('id="notifications-load-unread"');
  // The Messages tab shares "See older notifications" as its jump label, so
  // measure against the Unread branch's own occurrence — the one inside the
  // `tab === 'unread' && !olderShown` fragment.
  const older = block.indexOf('id="notifications-see-older"', btn);
  assert.ok(btn > -1, 'the unread pager button exists');
  assert.ok(older > -1, 'the older-reveal button still exists');
  assert.ok(btn < older, 'the unread pager renders ABOVE the older reveal');
  // It pages the unread cursor, disables while loading, and reads the
  // catalog entry.
  assert.match(block, /onClick=\{\(\) => controller\(\)\?\.loadMoreUnread\(\)\}/);
  assert.match(block, /disabled=\{snap\.loadingUnread\}/);
  assert.match(block, /snap\.loadingUnread \? t\('notifications:sheet\.older\.loading'\) : t\('notifications:sheet\.older\.unread'\)/);
  // Offered only while the controller says there are unread rows still to
  // bring up — the same condition both _renderList branches publish.
  assert.match(block, /\{snap\.unreadCanLoadMore \? \(/);
});

test('the Unread tab fills itself on the refresh landing, not on the open', () => {
  // The auto-fill effect: armed when the sheet opens, fired when a refresh
  // lands while it is open. Opening always refreshes (the sheet
  // controller's onOpen), and a fill that starts before that refresh lands
  // is thrown away by it — refresh replaces the whole feed. Filling after
  // the refresh lands is the one order that cannot race.
  const effectAt = SHEET_SRC.indexOf('unreadFillTickRef');
  assert.ok(effectAt > -1, 'the auto-fill ref exists');
  const effect = SHEET_SRC.slice(effectAt, SHEET_SRC.indexOf('const all = snap.screenList'));
  assert.match(effect, /if \(!open\) \{ unreadFillTickRef\.current = null; return; \}/,
    'a closed sheet disarms the gate');
  assert.match(effect, /unreadFillTickRef\.current = snap\.refreshTick;\s*\n\s*return;/,
    'opening arms the gate on the tick it starts from, fetching nothing yet');
  assert.match(effect, /if \(unreadFillTickRef\.current === snap\.refreshTick\) return;/,
    'a refresh that has not landed yet never triggers a fill');
  assert.match(effect, /if \(tab !== 'unread'\) return;/,
    'only the Unread tab fills itself');
  assert.match(effect, /if \(!snap\.unreadCanLoadMore\) return;/,
    'only while the badge is ahead of the list');
  assert.match(effect, /controller\(\)\?\.loadMoreUnread\(\)/,
    'and it walks the same loader the foot button drives');
  // The tick the effect waits for is published by the controller: every
  // refresh whose first page landed bumps it, and both _renderList branches
  // publish it.
  assert.match(FE_SRC, /refreshTick: 0,/);
  assert.match(FE_SRC, /Notifications\.refreshTick \+= 1;/);
  assert.equal((FE_SRC.match(/refreshTick: Notifications\.refreshTick,/g) || []).length, 2,
    'published from both _renderList branches');
});

test('the foot button\'s words are in the catalog', () => {
  assert.equal(LOCALE['sheet.older.unread'].text, 'See more unread notifications');
  assert.ok(LOCALE['sheet.older.unread'].description.length > 10,
    'carries a description for the translators');
  assert.equal(message('notifications:sheet.older.unread'), 'See more unread notifications');
});

test('a 3-message unread run counts as 3 in the tab, agreeing with the badge', () => {
  // The count rule the tab already keeps (summing collapsed runs), now
  // under load: three consecutive conversation rows collapse to ONE row
  // carrying count 3, and the tab's sum says 3 — the number on the bell.
  const re = /function collapseConversationRuns\(([^)]*)\)\s*\{([\s\S]*?)\n\}/;
  const m = FE_SRC.match(re);
  assert.ok(m, 'collapseConversationRuns() found');
  const collapse = new Function(...m[1].split(','), m[2]);
  const msg = (id) => ({
    id, kind: 'conversation_message', conversationId: 7, readAt: null,
  });
  const runs = collapse([msg(3), msg(2), msg(1)]);
  assert.equal(runs.length, 1, 'three messages, one row');
  const unreadCount = runs.reduce((sum, view) => sum + (view.count || 1), 0);
  assert.equal(unreadCount, 3, 'the tab counts 3, as the badge does');
});
