'use strict';

// #4787: a change a person voted on goes live, and they hear about it. Until
// this only its author was told; smartfren666 voted on three proposals in a
// week and found one had gone live by accident, days later.
//
//   1. the producer (src/workflow/rules/change-notifications.ts
//      createVotedChangeMergedNotifications): one row per voter, yes or no,
//      the author never double-told, a muted voter left alone, a second call
//      writes nothing — and, against the full PostgreSQL schema, the
//      producer's INSERT actually runs (its VALUES row is cast: the columns
//      are otherwise typed text and `n.user_id = v.user_id` is an integer =
//      text comparison Postgres refuses); and the door the merge workflow
//      uses, createPrMergedNotification's alsoVoters, which tells the author
//      and the voters in one call, and throws on a voters-side failure so the
//      machine's transaction is retried whole;
//   2. the phone's banner, on a child app (live when it arrives) and on the
//     platform's own (approved now, live in a few minutes);
//   3. the bell's row: the same drawing as the author's "Live" row, no
//     button of its own, and the kind opens the proposal;
//   4. the merge path: the machine's write, for a merge and for a change
//     included in another alike (exercised for real against PostgreSQL in
//     tests/workflow-merge-followups-postgres.test.js).
//
// Run with: node --test tests/voted-change-merged-notifications.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

// The producer reads the voters' preference through the `filter` it is
// handed; this one records the ask and mutes user 10.
const filtered = [];
const filter = async (_pool, args) => {
  filtered.push(args);
  return args.userIds.filter((id) => id !== 10); // 10 muted the category
};

const changeNotifications = require('../src/workflow/rules/change-notifications.ts');
const voted = (pool, args) => changeNotifications.createVotedChangeMergedNotifications(pool, args, filter);

function makePool(voters = [{ user_id: 8 }, { user_id: 7 }, { user_id: 10 }, { user_id: 12 }]) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      const s = String(sql);
      queries.push({ sql: s, params });
      if (/FROM pr_votes/.test(s)) {
        return { rows: voters };
      }
      if (/INSERT INTO notifications/.test(s)) {
        return {
          rows: params.slice(2).map((userId, i) => ({
            id: 900 + i, user_id: userId, app_id: params[0], session_id: params[1],
            source_user_id: null, kind: 'voted_change_merged', detail: null,
          })),
        };
      }
      return { rows: [] };
    },
  };
}

// ── 1. The producer ───────────────────────────────────────────────────

test('one row per voter, yes or no; the author never double-told, a muted voter left alone', async () => {
  filtered.length = 0;
  const pool = makePool();
  const rows = await voted(pool, {
    appId: 5, sessionId: 41, authorId: 7,
  });
  assert.deepEqual(filtered, [{ userIds: [8, 10, 12], appId: 5, categoryKey: 'voted_changes_live' }],
    'every vote row (both directions), the author dropped, then the category filter');
  assert.equal(pool.queries.length, 2);
  const [voters, insert] = pool.queries;
  assert.match(voters.sql, /SELECT v\.user_id, v\.vote FROM pr_votes v\s+WHERE v\.session_id = \$1/);
  // "One story": never the requester of a change Homeroom bot built.
  assert.match(voters.sql, /v\.user_id NOT IN \(SELECT q\.user_id\s+FROM homeroom_bot_runs r\s+JOIN homeroom_bot_requesters q/);
  assert.deepEqual(insert.params, [5, 41, 8, 12], 'a muted voter is filtered out before the insert');
  assert.match(insert.sql, /\(\$3::int, \$1::int, \$2::int/);
  assert.match(insert.sql, /'voted_change_merged'::text/);
  assert.match(insert.sql, /WHERE NOT EXISTS \([\s\S]*n\.user_id = v\.user_id AND n\.session_id = v\.session_id\s+AND n\.kind = 'voted_change_merged'/,
    'a retried or repeated merge writes nothing (#4787: one per voter per change)');
  assert.deepEqual(rows.map((r) => r.user_id), [8, 12]);
  assert.deepEqual(rows.map((r) => r.kind), ['voted_change_merged', 'voted_change_merged']);
  assert.deepEqual(rows.map((r) => r.source_user_id), [null, null],
    'system-generated: the group\'s decision arriving, not a person acting');
});

test('nobody to tell: no filter, no insert', async () => {
  filtered.length = 0;
  const pool = makePool();
  assert.deepEqual(await voted(pool, { appId: 5, sessionId: null, authorId: 7 }), []);
  assert.equal(pool.queries.length, 0);
  // A change only its author voted on (or a Just you project whose only
  // voter is its author): read, then nothing.
  const solo = makePool([{ user_id: 7 }]);
  assert.deepEqual(await voted(solo, { appId: 5, sessionId: 41, authorId: 7 }), []);
  assert.equal(solo.queries.length, 1, 'the votes were read');
  assert.deepEqual(filtered, [], 'nobody left, nobody asked the filter');
  // Everybody muted: filtered, then nothing written.
  const muted = makePool([{ user_id: 10 }]);
  assert.deepEqual(await voted(muted, { appId: 5, sessionId: 41, authorId: 7 }), []);
  assert.equal(filtered.length, 1);
  assert.equal(muted.queries.filter((q) => /INSERT INTO notifications/.test(q.sql)).length, 0);
});

test('against PostgreSQL: the insert runs, dedupes, and never tells the author', async () => {
  const { Pool } = require('pg');
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    console.log('# PostgreSQL unavailable; the producer runs against a fake pool only');
    return;
  }
  const name = `voted_merged_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  try {
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    await pool.query(schema);
    const { rows: [ada] } = await pool.query(`INSERT INTO users (username, password) VALUES ('ada', 'x') RETURNING id`);
    const { rows: [mo] } = await pool.query(`INSERT INTO users (username, password) VALUES ('mo', 'x') RETURNING id`);
    const { rows: [priya] } = await pool.query(`INSERT INTO users (username, password) VALUES ('priya', 'x') RETURNING id`);
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       VALUES ('Page Turners', 'page-turners', 'running', $1, 'private', 'private') RETURNING id`, [ada.id]);
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, pr_title)
       VALUES ($1, $2, 'bot-1', 'merged', 'Dark mode', 'Dark mode') RETURNING id`, [app.id, mo.id]);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes'), ($1, $3, 'no')`, [s.id, ada.id, priya.id]);

    const first = await voted(pool, {
      appId: app.id, sessionId: s.id, authorId: mo.id,
    });
    assert.deepEqual(first.map((r) => Number(r.user_id)).sort(), [Number(ada.id), Number(priya.id)],
      'the yes voter and the no voter, never the author');
    const again = await voted(pool, {
      appId: app.id, sessionId: s.id, authorId: mo.id,
    });
    assert.deepEqual(again, [], 'a retried merge writes nothing');
    const { rows: all } = await pool.query(
      `SELECT kind, user_id, source_user_id, detail FROM notifications WHERE session_id = $1`, [s.id]);
    assert.deepEqual(all.map((r) => r.kind).sort(), ['voted_change_merged', 'voted_change_merged']);
    for (const r of all) {
      assert.equal(r.source_user_id, null, 'system-generated');
      // "One story": how they voted ("It's live. You voted yes.").
      assert.equal(r.detail, Number(r.user_id) === Number(ada.id) ? 'yes' : null);
    }
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});

// ── 2. The phone ──────────────────────────────────────────────────────

test('the banner: live on a child app, approved now on the platform\'s own', () => {
  const { buildMessage } = require('../src/services/mobile-push-policy');
  const INPUT = {
    token: 'opaque-fcm-token', notificationId: 42, kind: 'voted_change_merged', environment: 'production',
    installationId: '123e4567-e89b-12d3-a456-426614174000', userId: 7, expiresAt: new Date(Date.now() + 60_000),
  };
  const CONTEXT = {
    appName: 'Page Turners', conversationTitle: null, sourceUsername: null, messageContent: null,
    sessionTitle: 'Dark mode for the reading list', prTitle: null, branchName: null, detail: null,
  };
  const banner = (over = {}) => buildMessage({ ...INPUT, context: { ...CONTEXT, ...over } }).notification;
  // "One story": the change and its project, over what happened and how
  // they voted.
  let n = banner();
  assert.equal(n.title, 'Dark mode for the reading list · Page Turners');
  assert.equal(n.body, 'It\'s live. You voted on it.');
  assert.equal(banner({ detail: 'yes' }).body, 'It\'s live. You voted yes.');
  n = banner({ appSelfHosted: true, detail: 'yes' });
  assert.equal(n.title, 'Dark mode for the reading list · Page Turners');
  assert.equal(n.body, 'Approved. It will be live in a few minutes. You voted yes.');
  // A change with no title: the words name the kind, not a machine label.
  const untitled = banner({ sessionTitle: null });
  assert.equal(untitled.title, 'A change you voted on is live');
  assert.equal(untitled.body, 'It\'s live. You voted on it.');
  // Muted push category: the row is written, the phone is not rung.
  const prefs = require('../src/services/mobile-push-preferences');
  assert.equal(prefs.ALLOWED_KINDS.has('voted_change_merged'), true, 'push-eligible: muting proposal_alerts stops the phone, not the bell');
});

// ── 3. The bell's row ─────────────────────────────────────────────────

let N = null;
function controller() {
  if (N) return N;
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.PlatformI18n = englishPlatformI18n();
  loadTsx('frontend/src/features/notifications/notifications.js');
  N = globalThis.window.Notifications;
  assert.equal(typeof N._rowView, 'function');
  return N;
}
const AT = new Date(Date.now() - 2 * 60 * 1000).toISOString();
const ROW = { id: 1, createdAt: AT, readAt: null, appName: 'Page Turners', appSlug: 'page-turners', sourceUsername: null, sessionId: 41, prTitle: 'Dark mode for the reading list', prNumber: 42 };
const subjectOf = (view) => view.segments.map((s) => (s.t === 'who' ? `@${s.v}` : s.v)).join(' ');

test('the row is drawn like the author\'s "Live" row, with no button of its own', () => {
  const view = controller()._rowView({ ...ROW, kind: 'voted_change_merged' });
  assert.equal(view.label, 'A change you voted on is live');
  assert.equal(subjectOf(view), 'Dark mode for the reading list');
  assert.equal(view.icon, '\u{1F389}', 'the same tile as the author\'s "Live" row');
  assert.deepEqual(view.actions || [], [], 'no button: the row itself opens the change');
  assert.equal(view.unread, true);
  const unnamed = controller()._rowView({ ...ROW, kind: 'voted_change_merged', prTitle: null, prNumber: null, sessionTitle: null });
  assert.equal(subjectOf(unnamed), 'a change');
  const read = controller()._rowView({ ...ROW, kind: 'voted_change_merged', readAt: AT });
  assert.equal(read.unread, false);

  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/features/notifications/notifications.js'), 'utf8');
  assert.match(src, /'voted_change_merged',\s*\n\s*\]\);/, 'a proposal kind: opens the proposal');
});

// #5064: "A change you voted on is live" while it was still merging. The
// row reads where the change stands (`sessionStatus`, the server's
// session_status), as a "ready to try" row does, and says going live until
// production runs it. The author's "Live" row says the same.
test('#5064: going live until production runs it, then live', () => {
  const going = controller()._rowView({ ...ROW, kind: 'voted_change_merged', sessionStatus: 'merging' });
  assert.equal(going.label, 'A change you voted on is going live');
  assert.equal(subjectOf(going), 'Dark mode for the reading list');
  assert.equal(going.icon, '\u{1F680}', 'the "Going live" tile a "ready to try" row uses');
  const live = controller()._rowView({ ...ROW, kind: 'voted_change_merged', sessionStatus: 'merged' });
  assert.equal(live.label, 'A change you voted on is live');
  assert.equal(live.icon, '\u{1F389}');

  const author = (extra) => controller()._rowView({ ...ROW, kind: 'pr_merged', ...extra });
  assert.equal(author({ sessionStatus: 'merging' }).label, 'Going live');
  assert.equal(author({ sessionStatus: 'merging' }).icon, '\u{1F680}');
  assert.equal(author({ sessionStatus: 'merged' }).label, 'Live');
  assert.equal(author({}).label, 'Live', 'a row without the field reads as it always did');
  assert.equal(author({ sessionStatus: 'merging', detail: 'forced' }).label, 'Made live by an admin');
  const credited = author({ sessionStatus: 'merging', detail: 'Backed by alice.' });
  assert.equal(credited.label, 'Going live');
  assert.match(subjectOf(credited), /Backed by alice\.$/, 'the credits still ride along');

  // The server hands the status to both rows, read with them.
  const service = fs.readFileSync(path.join(__dirname, '../src/services/notifications.js'), 'utf8');
  assert.match(service, /SESSION_STATUS_KINDS = new Set\(\['change_ready', 'pr_merged', 'voted_change_merged', 'change_closed'\]\)/);
  assert.match(service, /cs\.status = 'merged' AND \(cs\.live_at IS NULL OR \$\{RELEASE_PENDING_SQL\}\)/);
});

// ── 4. The merge paths ────────────────────────────────────────────────

// The merge workflow asks for the voters' rows through
// createPrMergedNotification's own `alsoVoters` rather than through a second
// door. Its preference reads are the rules' own (rules/notification-
// preferences.ts), which read notification_preferences: here user 10 has
// muted the category.
function mergedPool({ voters = [], failVotes = false } = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      const s = String(sql);
      queries.push({ sql: s, params });
      if (/FROM pr_votes/.test(s)) {
        if (failVotes) throw new Error('db hiccup');
        return { rows: voters };
      }
      if (/FROM notification_preferences/.test(s) && /category = \$1/.test(s)) {
        return { rows: [{ user_id: 10, app_id: null, enabled: false }] };
      }
      if (/INSERT INTO notifications/.test(s)) {
        if (/'pr_merged'/.test(s)) {
          return { rows: [{ id: 800, user_id: params[0], app_id: params[1], session_id: params[2], source_user_id: null, kind: 'pr_merged', detail: params[3] }] };
        }
        return {
          rows: params.slice(2).map((userId, i) => ({
            id: 900 + i, user_id: userId, app_id: params[0], session_id: params[1],
            source_user_id: null, kind: 'voted_change_merged', detail: null,
          })),
        };
      }
      return { rows: [] };
    },
  };
}

const allows = async () => true;

test('alsoVoters: the author and the voters in one call, the author never double-told', async () => {
  const pool = mergedPool({ voters: [{ user_id: 8 }, { user_id: 7 }, { user_id: 10 }, { user_id: 12 }] });
  const rows = await changeNotifications.createPrMergedNotification(pool, {
    userId: 7, appId: 5, sessionId: 41, credits: 'Backed by ada.', alsoVoters: true,
  }, allows);
  assert.deepEqual(rows.map((r) => [r.kind, r.user_id]),
    [['pr_merged', 7], ['voted_change_merged', 8], ['voted_change_merged', 12]],
    'the author\'s row first, then the voters\' — the author (7) and the muted voter (10) left out');
  const prefs = pool.queries.find((q) => /FROM notification_preferences/.test(q.sql));
  assert.deepEqual(prefs.params, ['voted_changes_live', [8, 10, 12], 5]);
});

test('alsoVoters with no author (a bot build): only the voters have someone to tell', async () => {
  const pool = mergedPool({ voters: [{ user_id: 8 }, { user_id: 12 }] });
  const rows = await changeNotifications.createPrMergedNotification(pool, {
    userId: null, appId: 5, sessionId: 41, credits: null, alsoVoters: true,
  }, allows);
  assert.deepEqual(rows.map((r) => r.kind), ['voted_change_merged', 'voted_change_merged']);
  assert.equal(pool.queries.some((q) => /'pr_merged'/.test(q.sql)), false,
    'no author row where there is no author');
});

test('alsoVoters: a voters-side failure throws, so the machine\'s transaction is retried whole', async () => {
  const pool = mergedPool({ voters: [{ user_id: 8 }], failVotes: true });
  await assert.rejects(changeNotifications.createPrMergedNotification(pool, {
    userId: 7, appId: 5, sessionId: 41, credits: null, alsoVoters: true,
  }, allows), /db hiccup/);
});

// The machine's write (writeMergedNotification, for a merge and an included
// change alike) runs against PostgreSQL, producer and all, in
// tests/workflow-merge-followups-postgres.test.js (F5).
