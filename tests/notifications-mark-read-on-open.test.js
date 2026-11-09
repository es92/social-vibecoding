// #6498 wrote the server's narrow clear; #6527 stopped the bell from using it
// automatically.
//
// #6498 made opening the bell clear what it counted, through the server's
// `keep_plain_messages` option (markRead({ all, keepPlainMessages })). #6527
// reported the other side of that: a "live, ready to try" notice left Unread
// just because the drawer was opened, on every device. So opening the bell
// now only refreshes, and nothing sends the narrow clear any more. The
// server option stays, and these tests pin it:
//
//   1. services markRead({ all, keepPlainMessages }) clears exactly what the
//      bell counts — the server's PLAIN_MESSAGE_SQL is kept out — and refuses
//      to combine with older_than_days.
//   2. The route passes `keep_plain_messages` through the mark-all branch and
//      refuses it alongside older_than_days.
//   3. The sheet controller only refreshes on open: no markReadOnOpen, no
//      markAllRead, no read request.
//   4. The frontend no longer defines markReadOnOpen and sends no
//      keep_plain_messages request.
//
// Frontend logic is extracted from the shipped source (so tests cannot drift
// from what runs) and exercised against stubs, the notifications-mark-all
// pattern.
//
// Run with: node --test tests/notifications-mark-read-on-open.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notifications = require('../src/services/notifications');

const FE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8'
);
const CONTROLLER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications-sheet-controller.js'),
  'utf8'
);
const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'notifications.js'),
  'utf8'
);

// ── 1. the service clears what the bell counts, plain messages aside ────

function stubPool(rowCount) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      return Promise.resolve({ rowCount, rows: [] });
    },
  };
}

test('markRead({all, keepPlainMessages}) keeps channel and app-less conversation messages unread', async () => {
  const pool = stubPool(5);
  const cleared = await notifications.markRead(pool, 42, { all: true, keepPlainMessages: true });
  assert.equal(cleared, 5);
  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /UPDATE notifications AS n SET read_at = NOW\(\)/);
  assert.match(sql, /n\.user_id = \$1/);
  assert.match(sql, /n\.read_at IS NULL/);
  // The predicate countUnreadSplit counts with (#18): a channel message, or
  // a conversation message with no app. An app's own conversation still
  // counts on the bell, so it must still be cleared.
  assert.match(sql, /NOT \(n\.kind = 'channel_message' OR \(n\.kind = 'conversation_message' AND n\.app_id IS NULL\)\)/);
  assert.deepEqual(params, [42], 'user id is the only parameter');
});

test('markRead({all}) without the flag is still the unscoped clear-all', async () => {
  const pool = stubPool(9);
  await notifications.markRead(pool, 42, { all: true });
  const { sql } = pool.calls[0];
  assert.doesNotMatch(sql, /PLAIN_MESSAGE|channel_message/);
});

test('markRead({all, keepPlainMessages, olderThanDays}) throws like kind scoping does', async () => {
  const pool = stubPool(1);
  await assert.rejects(
    () => notifications.markRead(pool, 42, { all: true, keepPlainMessages: true, olderThanDays: 7 }),
    /olderThanDays does not combine with keepPlainMessages/
  );
  assert.equal(pool.calls.length, 0, 'refused before any query runs');
});

// ── 2. the route passes the flag through, and refuses the window ────────

test('route passes keep_plain_messages through the mark-all branch', () => {
  const m = ROUTE_SRC.match(/const cleared = await notifications\.markRead\([\s\S]*?\}\);/);
  assert.ok(m, 'markRead call found');
  assert.match(m[0], /keepPlainMessages: keepPlainMessages === true/,
    'only a literal true enables the narrow clear');
});

test('route refuses keep_plain_messages alongside older_than_days', () => {
  const m = ROUTE_SRC.match(/if \(olderThanDays != null\) \{[\s\S]*?return res\.status\(400\)\.json\(\{ error: 'Invalid older_than_days' \}\);/);
  assert.ok(m, 'older_than_days validation found');
  assert.match(m[0], /keepPlainMessages != null/,
    'the window and the narrow clear are different scopes and do not combine');
});

// ── 3. the controller only refreshes on open ────────────────────────────

// The shipped onOpen, extracted so the behaviour is exercised rather than
// only its text. `window` is the building function's parameter, so the arrow
// captures the stub it is built with.
function controllerOnOpen(windowStub) {
  const m = CONTROLLER_SRC.match(/onOpen: ([\s\S]*?),\n\}\);/);
  assert.ok(m, 'onOpen definition found');
  return new Function('window', `return (${m[1]});`)(windowStub);
}

function notificationsStub(refreshResult) {
  const calls = { refresh: 0, markReadOnOpen: 0, markAllRead: 0, clearNotification: 0 };
  return {
    calls,
    window: {
      Notifications: {
        refresh() { calls.refresh++; return Promise.resolve(refreshResult); },
        markReadOnOpen() { calls.markReadOnOpen++; },
        markAllRead() { calls.markAllRead++; },
        clearNotification() { calls.clearNotification++; },
      },
    },
  };
}

test('controller refreshes once on open and marks nothing read when the refresh landed', async () => {
  const { calls, window } = notificationsStub(true);
  await controllerOnOpen(window)();
  assert.equal(calls.refresh, 1, 'refreshes on open');
  assert.equal(calls.markReadOnOpen, 0, 'opening does not read');
  assert.equal(calls.markAllRead, 0, 'opening does not clear everything');
  assert.equal(calls.clearNotification, 0, 'opening does not clear rows');
});

test('controller refreshes once on open and marks nothing read when the refresh failed', async () => {
  const { calls, window } = notificationsStub(false);
  await controllerOnOpen(window)();
  assert.equal(calls.refresh, 1, 'refreshes on open');
  assert.equal(calls.markReadOnOpen, 0);
  assert.equal(calls.markAllRead, 0);
  assert.equal(calls.clearNotification, 0);
});

test('the controller source sends no read request and names no clearing method', () => {
  assert.doesNotMatch(CONTROLLER_SRC, /markReadOnOpen|markAllRead|\/api\/notifications\/read/,
    'opening the bell only refreshes it (#6527)');
});

// ── 4. the frontend's automatic clear is gone ───────────────────────────

test('the frontend no longer defines markReadOnOpen or sends keep_plain_messages', () => {
  assert.doesNotMatch(FE_SRC, /markReadOnOpen/, 'the automatic clear on open is gone (#6527)');
  assert.doesNotMatch(FE_SRC, /keep_plain_messages/,
    'nothing in the app sends the narrow clear; the server option remains');
});

// ── 5. the capture page draws the named unread row bold (#6526) ─────────
//
// #6526: the shot page (`/?shot=notifications&demo=1`) is a picture of an
// unread list, not somebody reading their notifications. It failed on changes
// that never touched notifications because opening the sheet used to mark
// every unread row read (#6498); #6506 then drew a read subject
// regular-weight, so dapp.json's bold-subject selector went missing. #6527
// removed the automatic clear, so opening the sheet only refreshes and a
// capture's rows stay unread. The check is tightened here to insist on the
// bold subject of the row it already names: "any row's bold subject" let a
// different unread row satisfy a row that had gone read.

const DAPP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));

test('the notification shot check needs the named unread row itself to be bold', () => {
  const check = DAPP.tests.find((t) => t.name === 'Unread notification rows read source, bold subject, muted preview');
  assert.ok(check, 'the declared check still exists');
  assert.equal(check.path, '/?shot=notifications&demo=1');
  assert.ok(check.expectSelector.includes(
    '.notifications-row-slot > [data-notif-id="990211"] + button[data-notification-clear="990211"]'
  ), 'the check still requires the unread row and its clear control');
  assert.ok(check.expectSelector.includes(
    '[data-notif-id="990211"] .text-xs + .text-sm.font-semibold'
  ), "and the bold subject has to be that row's, not any row's");
});

test('the demo fixture leaves the checked row unread', () => {
  // The unread rendering, and so the bold subject the check selects, depends
  // on this row having no readAt. A fixture that quietly stamped one would
  // turn the check red for every change again.
  const base = ROUTE_SRC.match(/const base = \{[\s\S]*?\n  \};/);
  assert.ok(base, 'the demo base row is defined');
  assert.match(base[0], /readAt: null/, 'every demo row starts unread');
  const at = ROUTE_SRC.indexOf('id: 990211,');
  assert.ok(at > 0, 'the checked row is in the demo fixture');
  const entry = ROUTE_SRC.slice(at, ROUTE_SRC.indexOf('\n    },', at));
  assert.doesNotMatch(entry, /readAt/, '990211 does not override its read state');
});

// ── 6. the query itself, against a real PostgreSQL ──────────────────────
//
// The stub tests pin the SQL text; this runs the same call through the real
// service against the full schema, so a predicate that reads right but
// clears the wrong rows fails here. Skipped (unless TEST_DATABASE_URL is
// set) where no PostgreSQL is available.

test('markRead({all, keepPlainMessages}) against a real database', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const crypto = require('node:crypto');
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `notif_open_read_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  const { rows: [viewer] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('bell_reader', 'x') RETURNING id`
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by) VALUES ('Plant Pal', 'plant-pal', $1) RETURNING id`,
    [viewer.id]
  );
  const insert = (kind, appId) => pool.query(
    `INSERT INTO notifications (user_id, kind, app_id) VALUES ($1, $2, $3) RETURNING id`,
    [viewer.id, kind, appId]
  );
  const channel = (await insert('channel_message', null)).rows[0].id;
  const plainConversation = (await insert('conversation_message', null)).rows[0].id;
  const appConversation = (await insert('conversation_message', app.id)).rows[0].id;
  const mention = (await insert('mention', null)).rows[0].id;

  const cleared = await notifications.markRead(pool, viewer.id, { all: true, keepPlainMessages: true });
  assert.equal(cleared, 2, 'only the two rows the bell counts were cleared');

  const { rows } = await pool.query(
    `SELECT id, read_at FROM notifications WHERE user_id = $1 ORDER BY id`, [viewer.id]
  );
  const read = new Map(rows.map((r) => [r.id, r.read_at]));
  assert.equal(read.get(channel), null, 'a channel message stays for the Messages tab');
  assert.equal(read.get(plainConversation), null, 'an app-less conversation message stays too');
  assert.ok(read.get(appConversation), 'an app conversation counts on the bell, so it clears');
  assert.ok(read.get(mention), 'a mention clears');
});
