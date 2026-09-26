'use strict';

// enqueue_mobile_push_deliveries, executed by a REAL postgres.
//
// tests/mobile-push-schema.test.js asserts the trigger's SQL *text*; nothing
// anywhere inserted a notifications row and watched delivery rows appear. The
// whole outbox capture — per-device fan-out, the preference gate, permission
// and session eligibility, the deployment kill switch and activation cutoff —
// lived only as regex assertions. This file runs the real function against
// the real DDL, extracted from src/db/schema.sql at test time so it cannot
// drift from what production executes.
//
// ── When it runs ────────────────────────────────────────────────────────
// Same contract as tests/check-history-postgres.test.js: when a postgres
// server is reachable (a dev checkout with `make up`, or any environment
// exporting TEST_DATABASE_URL) — otherwise it SKIPS, because a test that
// cannot reach its dependency is not evidence of a defect. Everything is
// created in a throwaway schema, so a developer's live platform database is
// never touched.
//
// Run with: node --test tests/mobile-push-trigger-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');

function extract(re, label) {
  const match = schemaSql.match(re);
  if (!match) throw new Error(`schema.sql no longer contains ${label}`);
  return match[0];
}

// The real push DDL, verbatim from schema.sql.
const PUSH_DDL = [
  extract(/CREATE TABLE IF NOT EXISTS mobile_push_deployment_state \([\s\S]*?\n\);/,
    'the deployment state table'),
  extract(/CREATE TABLE IF NOT EXISTS mobile_push_registrations \([\s\S]*?\n\);/,
    'the registrations table'),
  extract(/CREATE TABLE IF NOT EXISTS mobile_push_kind_categories \([\s\S]*?\n\);/,
    'the kind/category policy table'),
  extract(/INSERT INTO mobile_push_kind_categories \(kind, category, default_enabled\) VALUES[\s\S]*?EXCLUDED\.default_enabled;/,
    'the closed kind/category seed'),
  extract(/CREATE TABLE IF NOT EXISTS mobile_push_preferences \([\s\S]*?\n\);/,
    'the account preferences table'),
  extract(/CREATE TABLE IF NOT EXISTS mobile_push_deliveries \([\s\S]*?\n\);/,
    'the delivery outbox table'),
];
const TRIGGER_FN = extract(
  /CREATE OR REPLACE FUNCTION enqueue_mobile_push_deliveries\(\)[\s\S]*?END;\n\$\$;/,
  'the enqueue trigger function');

// The trigger only reads notifications.{id,user_id,kind,read_at,created_at}
// and registrations FK users(id); these stand-ins carry exactly the column
// types the real tables declare for them, nothing more.
const STUB_DDL = `
  CREATE TABLE users (id SERIAL PRIMARY KEY);
  CREATE TABLE notifications (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    kind       VARCHAR(32) NOT NULL,
    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

// Connect, or report why not. Never throws — an unreachable server is a
// skip. (Same shape as check-history-postgres.test.js, including the
// empty-message AggregateError caveat documented there.)
async function connect() {
  let Client;
  try { ({ Client } = require('pg')); } catch { return null; }
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    return { error: err.message || err.code || String(err) };
  }
  return { client };
}

// A private schema per test process so a run against a developer's live
// platform database cannot touch the real tables. Dropped in `finally`,
// which also removes the function and trigger created inside it.
async function withSchema(client, fn) {
  const name = `mobile_push_trigger_test_${process.pid}`;
  await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await client.query(`CREATE SCHEMA ${name}`);
  try {
    await client.query(`SET search_path TO ${name}`);
    await client.query(STUB_DDL);
    for (const statement of PUSH_DDL) await client.query(statement);
    await client.query(TRIGGER_FN);
    await client.query(
      `CREATE TRIGGER notifications_enqueue_mobile_push_deliveries
         AFTER INSERT ON notifications
         FOR EACH ROW EXECUTE FUNCTION enqueue_mobile_push_deliveries()`);
    return await fn();
  } finally {
    await client.query('SET search_path TO public').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
  }
}

// ── Fixture helpers ─────────────────────────────────────────────────────

let hashCounter = 0;
const uniqueHash = () => (++hashCounter).toString(16).padStart(64, '0');

async function addUser(client) {
  const { rows } = await client.query('INSERT INTO users DEFAULT VALUES RETURNING id');
  return rows[0].id;
}

async function addRegistration(client, {
  userId, installationId, environment = 'production', platform = 'android',
  permission = 'authorized', expiresInMs = 60 * 60 * 1000,
}) {
  const credentialReference = `nsc_${String(userId).padStart(43, '0')}`;
  const { rows } = await client.query(
    `INSERT INTO mobile_push_registrations
       (user_id, native_session_credential_reference, environment, installation_id,
        registration_hash, registration_enc, platform, permission_status, session_expires_at)
     VALUES ($1, $2, $3, $4, $5, 'enc:opaque', $6, $7,
             NOW() + ($8 || ' milliseconds')::interval)
     RETURNING id`,
    [userId, credentialReference, environment, installationId, uniqueHash(),
      platform, permission, expiresInMs]
  );
  // BIGSERIAL comes back as a string; normalize for comparisons.
  return Number(rows[0].id);
}

async function notify(client, { userId, kind, readAt = null, createdAt = null }) {
  const { rows } = await client.query(
    `INSERT INTO notifications (user_id, kind, read_at, created_at)
     VALUES ($1, $2, $3, COALESCE($4, NOW()))
     RETURNING id, created_at`,
    [userId, kind, readAt, createdAt]
  );
  return rows[0];
}

async function deliveriesFor(client, notificationId) {
  const { rows } = await client.query(
    `SELECT registration_id, environment, installation_id, platform, status, expires_at
       FROM mobile_push_deliveries WHERE notification_id = $1 ORDER BY registration_id`,
    [notificationId]
  );
  return rows;
}

async function enableSending(client, { notBeforeMs = -60 * 60 * 1000 } = {}) {
  await client.query(
    `INSERT INTO mobile_push_deployment_state
       (environment, firebase_project_id, send_enabled, send_not_before)
     VALUES ('production', 'social-prod', TRUE, NOW() + ($1 || ' milliseconds')::interval)
     ON CONFLICT (environment) DO UPDATE
       SET send_enabled = EXCLUDED.send_enabled,
           send_not_before = EXCLUDED.send_not_before`,
    [notBeforeMs]
  );
}

const DEVICE_A = '123e4567-e89b-12d3-a456-426614174000';
const DEVICE_B = '223e4567-e89b-12d3-a456-426614174001';
const DEVICE_C = '323e4567-e89b-12d3-a456-426614174002';

// ── Tests ───────────────────────────────────────────────────────────────

function pgTest(name, run) {
  test(name, async (t) => {
    const conn = await connect();
    if (!conn) return t.skip('the pg driver is not installed in this environment');
    if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
    const { client } = conn;
    try {
      await withSchema(client, () => run(client));
    } finally {
      await client.end().catch(() => {});
    }
  });
}

pgTest('an unread notification fans out one delivery per eligible device of its recipient', async (client) => {
  await enableSending(client);
  const alice = await addUser(client);
  const bob = await addUser(client);
  const aliceAndroid = await addRegistration(client, {
    userId: alice, installationId: DEVICE_A, platform: 'android', permission: 'authorized',
  });
  const aliceIos = await addRegistration(client, {
    userId: alice, installationId: DEVICE_B, platform: 'ios', permission: 'provisional',
  });
  const bobAndroid = await addRegistration(client, { userId: bob, installationId: DEVICE_C });

  const inserted = await notify(client, { userId: alice, kind: 'session_done' });
  const rows = await deliveriesFor(client, inserted.id);
  assert.equal(rows.length, 2, 'both of alice\'s devices, provisional included');
  assert.deepEqual(
    rows.map((r) => [Number(r.registration_id), r.installation_id, r.platform, r.status]),
    [
      [aliceAndroid, DEVICE_A, 'android', 'pending'],
      [aliceIos, DEVICE_B, 'ios', 'pending'],
    ],
    'delivery rows snapshot registration, installation and platform');
  assert.ok(!rows.some((r) => Number(r.registration_id) === bobAndroid),
    'another user\'s device is never targeted');
  for (const row of rows) {
    assert.equal(new Date(row.expires_at).getTime(),
      new Date(inserted.created_at).getTime() + 24 * 60 * 60 * 1000,
      'the outbox row expires 24h after the notification');
  }

  const bobRow = await notify(client, { userId: bob, kind: 'session_done' });
  assert.deepEqual((await deliveriesFor(client, bobRow.id)).map((r) => Number(r.registration_id)),
    [bobAndroid]);
});

pgTest('the closed kind policy and account preferences gate enqueue at insert time', async (client) => {
  await enableSending(client);
  const alice = await addUser(client);
  await addRegistration(client, { userId: alice, installationId: DEVICE_A });

  const { rows: policy } = await client.query(
    'SELECT kind, default_enabled FROM mobile_push_kind_categories ORDER BY kind');
  // 22 includes #1795's explicit test alert, under developer_sessions.
  // 19 -> 21: #1405's two connector kinds. This number is a TRIPWIRE, not
  // bookkeeping — a new push-eligible kind has to be looked at rather than
  // merely added, which is what it just forced. Both land in
  // `developer_sessions` beside session_done and auto_solve_done, both
  // default_enabled, and that is the whole point of the feature: "your agent
  // submitted work" and "your agent is waiting on you" are exactly the
  // moments somebody is away from the screen.
  //
  // Bumping it weakens nothing. The loop below fires a notification for
  // EVERY row this query returns and asserts the delivery count matches
  // default_enabled, so the two new kinds gain real coverage from the same
  // assertion the existing nineteen have.
  // 22 → 27 with #1374's five (proposal_vote, pr_merged, vote_digest,
  // issue_opened, app_health). Two of that five are only PART of the delta:
  // the same change restored connector_submitted and agent_awaiting_input,
  // which the seed INSERTed and the DELETE reaper below it then removed on
  // every boot, so they were push-disabled in the database while the service
  // policy said otherwise. This count running against a real server is what
  // proves they survive now. 27 → 29 with #1688's two (revision_recheck,
  // weekly_digest), seeded and reaped in the same two lists. 29 → 31 with
  // #2386's two (friend_request, friend_accept), the same way; 31 → 33 with
  // #2387's two: conversation_thread_reply (under messages) and thread_reply
  // (an app-chat reply-thread reply, direct_interactions). 33 → 35 with
  // #3181's session_stalled, beside session_done in developer_sessions, and
  // platform_limit (server-wide cap alerts for full admins, app_alerts).
  assert.equal(policy.length, 35, 'the seed carries the reviewed closed set');
  for (const { kind, default_enabled: enabled } of policy) {
    const row = await notify(client, { userId: alice, kind });
    assert.equal((await deliveriesFor(client, row.id)).length, enabled ? 1 : 0,
      `${kind} default_enabled=${enabled}`);
  }

  // A future inbox kind is push-ineligible by construction, and a row born
  // read never reaches a lock screen.
  const unknown = await notify(client, { userId: alice, kind: 'future_kind' });
  assert.equal((await deliveriesFor(client, unknown.id)).length, 0);
  const read = await notify(client, { userId: alice, kind: 'session_done', readAt: new Date() });
  assert.equal((await deliveriesFor(client, read.id)).length, 0);

  // An explicit preference overrides the default in both directions —
  // opting into the quiet-by-default kudos, opting out of mentions.
  await client.query(
    `INSERT INTO mobile_push_preferences (user_id, category, enabled)
     VALUES ($1, 'lightweight_activity', TRUE), ($1, 'direct_interactions', FALSE)`,
    [alice]);
  const kudos = await notify(client, { userId: alice, kind: 'kudos' });
  assert.equal((await deliveriesFor(client, kudos.id)).length, 1);
  const mention = await notify(client, { userId: alice, kind: 'mention' });
  assert.equal((await deliveriesFor(client, mention.id)).length, 0);

  // The preference is account-scoped: another account keeps the defaults.
  const bob = await addUser(client);
  await addRegistration(client, { userId: bob, installationId: DEVICE_B });
  const bobKudos = await notify(client, { userId: bob, kind: 'kudos' });
  assert.equal((await deliveriesFor(client, bobKudos.id)).length, 0);
});

pgTest('device eligibility filters registrations without touching the notification', async (client) => {
  await enableSending(client);
  const alice = await addUser(client);
  await addRegistration(client, {
    userId: alice, installationId: DEVICE_A, permission: 'denied',
  });
  await addRegistration(client, {
    userId: alice, installationId: DEVICE_B, permission: 'not_determined',
  });
  await addRegistration(client, {
    userId: alice, installationId: DEVICE_C, expiresInMs: -1000,
  });
  // An environment with no deployment-state row cannot receive anything.
  await addRegistration(client, {
    userId: alice, installationId: '423e4567-e89b-12d3-a456-426614174003',
    environment: 'staging',
  });

  const row = await notify(client, { userId: alice, kind: 'session_done' });
  assert.equal((await deliveriesFor(client, row.id)).length, 0,
    'denied, undecided, expired-session and unknown-environment devices are all skipped');
  const { rows } = await client.query('SELECT read_at FROM notifications WHERE id = $1', [row.id]);
  assert.equal(rows.length, 1, 'the inbox row itself is untouched by push ineligibility');
});

pgTest('the deployment kill switch and activation cutoff suppress the outbox', async (client) => {
  const alice = await addUser(client);
  await addRegistration(client, { userId: alice, installationId: DEVICE_A });

  // send_enabled = FALSE (send_not_before must stay set per the CHECK).
  await client.query(
    `INSERT INTO mobile_push_deployment_state
       (environment, firebase_project_id, send_enabled, send_not_before)
     VALUES ('production', 'social-prod', FALSE, NOW())`);
  const disabled = await notify(client, { userId: alice, kind: 'session_done' });
  assert.equal((await deliveriesFor(client, disabled.id)).length, 0, 'kill switch');

  // Enabled, but the notification predates the activation cutoff — work
  // from before (re-)activation is not delivered.
  await enableSending(client, { notBeforeMs: -60 * 60 * 1000 });
  const stale = await notify(client, {
    userId: alice, kind: 'session_done',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });
  assert.equal((await deliveriesFor(client, stale.id)).length, 0, 'activation cutoff');

  // A notification at/after the cutoff flows again.
  const fresh = await notify(client, { userId: alice, kind: 'session_done' });
  assert.equal((await deliveriesFor(client, fresh.id)).length, 1);
});

pgTest('test alerts use the durable ten-second delay and respect developer-session preferences', async (client) => {
  const { queueTestAlert, TEST_DELAY_MS } = require('../src/services/test-alert');
  await enableSending(client);
  const alice = await addUser(client);
  await addRegistration(client, { userId: alice, installationId: DEVICE_A });
  const pool = { connect: async () => ({
    query: (...args) => client.query(...args), release() {},
  }) };
  const result = await queueTestAlert(pool, alice);
  assert.equal(result.queued, true);
  assert.equal(result.delayMs, TEST_DELAY_MS);
  const { rows: [delivery] } = await client.query(
    `SELECT d.status, d.available_at - n.created_at AS delay,
            EXTRACT(EPOCH FROM (d.available_at - n.created_at)) * 1000 AS delay_ms,
            d.available_at > NOW() AS waits
       FROM mobile_push_deliveries d JOIN notifications n ON n.id = d.notification_id
      WHERE n.id = $1`, [result.notificationId]);
  assert.equal(delivery.status, 'pending');
  assert.equal(Number(delivery.delay_ms), TEST_DELAY_MS);
  assert.equal(delivery.waits, true, 'a worker cannot claim it immediately');
  await client.query(`INSERT INTO mobile_push_preferences (user_id, category, enabled)
    VALUES ($1, 'developer_sessions', FALSE)`, [alice]);
  assert.equal((await queueTestAlert(pool, alice)).reason, 'preference_disabled');
  const bob = await addUser(client);
  assert.equal((await queueTestAlert(pool, bob)).reason, 'no_eligible_device');
  assert.equal((await client.query('SELECT id FROM notifications')).rowCount, 1,
    'unqueueable tests do not leave misleading inbox entries');
});
