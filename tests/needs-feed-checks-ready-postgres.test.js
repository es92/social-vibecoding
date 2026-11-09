'use strict';

// #6402 (6 Nov 2026): a vote is asked only once a change is ready to be
// reviewed: its checks passed (or it had nothing to test) and it merges
// cleanly with main. Against the REAL schema in a throwaway PostgreSQL
// database.
//
// What this pins:
//   1. A promoted change whose checks are pending, deferred, failing, or
//      which was measured to conflict with main is not in the Needs you feed,
//      not in COUNTS_SQL's `needs`/`owed`, not in OWED_BY_COMMUNITY_SQL's
//      waiting count, and not in the vote digest.
//   2. With passing (or skipped) checks and no recorded conflict, it is in
//      all four.
//   3. A ballot (two changes closing the same request) is not owed while one
//      of its changes is still being checked.
//   4. `integration_merges_clean IS NULL` (never measured) counts as clean.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/needs-feed-checks-ready-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a vote is asked only once the checks pass and it merges cleanly', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `needs_ready_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const overview = require('../src/routes/workshop-overview');
  const digest = require('../src/services/vote-digest');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username) => one(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username]);
  const ada = await user('nr_ada');
  const bob = await user('nr_bob');
  const cat = await user('nr_cat');
  const app = await one(
    `INSERT INTO apps (name, slug, view_visibility, collab_visibility, created_by)
     VALUES ('Checks first', 'nr-checks', 'public', 'public', $1) RETURNING id, slug`, [ada.id]);
  for (const u of [ada, bob, cat]) {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [app.id, u.id]);
  }
  await pool.query(`INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 7, 'Night mode', $2)`, [app.id, ada.id]);
  const change = async (by, pr, linked, extra = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, check_state,
                                check_phase, merge_conflict_state, integration_merges_clean, integration_block_reasons,
                                promoted_at)
     VALUES ($1, $2, 'promoted', $3::int[], $4, $5, $6, $7, $8, $9, $10::jsonb, NOW()) RETURNING id`,
    [app.id, by.id, linked, pr, `Change ${pr}`, extra.checkState ?? 'passing', extra.checkPhase ?? null,
      extra.conflict ?? null, extra.clean ?? null, JSON.stringify(extra.reasons ?? [])])).rows[0];

  // What the four readers say about the change for ada, who would owe it.
  const feed = async () => (await pool.query(
    overview.NEEDS_FEED_SQL, [ada.id, false, false, overview.NEEDS_FEED_MAX])).rows
    .filter((r) => Number(r.app_id) === Number(app.id) && r.kind === 'proposal')
    .map((r) => Number(r.id));
  const counts = async () => {
    const row = (await pool.query(overview.COUNTS_SQL, [ada.id, false, false])).rows
      .find((r) => r.slug === app.slug);
    return row ? { needs: Number(row.needs), owed: row.owed } : { needs: 0, owed: [] };
  };
  const waiting = async () => {
    const row = (await overview.owedByCommunity(pool, ada.id)).find((r) => r.slug === app.slug);
    return row ? Number(row.waiting) : 0;
  };
  const digestFor = async () => {
    const row = (await pool.query(digest.PENDING_SQL, [String(digest.MIN_GAP_HOURS)])).rows
      .find((r) => Number(r.user_id) === Number(ada.id));
    return row ? Number(row.pending) : 0;
  };
  const everywhere = async () => {
    const [f, c, w, d] = await Promise.all([feed(), counts(), waiting(), digestFor()]);
    return { feed: f, needs: c.needs, owed: c.owed, waiting: w, digest: d };
  };

  await t.test('passing checks and a clean merge: owed everywhere', async () => {
    const ready = await change(bob, 20, [7], { clean: true });
    assert.deepEqual(await everywhere(), {
      feed: [ready.id], needs: 1, owed: [`proposal:${ready.id}@0`], waiting: 1, digest: 1,
    });
    await pool.query('UPDATE chat_sessions SET status = \'closed\' WHERE id = $1', [ready.id]);
  });

  await t.test('checks still running, deferred or failing: owed nowhere', async () => {
    for (const extra of [
      { checkState: 'pending', checkPhase: 'testing' },
      { checkState: 'pending', checkPhase: 'queued' },
      { checkState: 'pending', checkPhase: 'deferred' },
      { checkState: 'failing' },
      { checkState: 'error' },
    ]) {
      const c = await change(bob, 30, [7], extra);
      assert.deepEqual(await everywhere(), { feed: [], needs: 0, owed: [], waiting: 0, digest: 0 },
        JSON.stringify(extra));
      await pool.query('DELETE FROM chat_sessions WHERE id = $1', [c.id]);
    }
  });

  await t.test('a passing change that conflicts with main waits to sync: not owed', async () => {
    for (const extra of [
      { conflict: 'conflict' },
      { conflict: 'failed' },
      { clean: false },
    ]) {
      const c = await change(bob, 31, [7], extra);
      assert.deepEqual(await everywhere(), { feed: [], needs: 0, owed: [], waiting: 0, digest: 0 },
        JSON.stringify(extra));
      await pool.query('DELETE FROM chat_sessions WHERE id = $1', [c.id]);
    }
  });

  await t.test('#6531: a conflict only a yes can move is owed, and says so on its row', async () => {
    const c = await change(bob, 33, [7], { clean: false, reasons: ['awaiting_approval'] });
    assert.deepEqual(await everywhere(), {
      feed: [c.id], needs: 1, owed: [`proposal:${c.id}@0`], waiting: 1, digest: 1,
    });
    const row = (await pool.query(overview.NEEDS_FEED_SQL, [ada.id, false, false, overview.NEEDS_FEED_MAX]))
      .rows.find((r) => Number(r.id) === Number(c.id));
    assert.equal(row.conflict_on_yes, true, 'its Vote row names the conflict');
    assert.equal(overview.shapeNeedsFeed([row])[0].conflictOnYes, true);
    // A conflict the lane is still resolving is not owed.
    await pool.query(`UPDATE chat_sessions SET integration_block_reasons = '["integrating"]'::jsonb WHERE id = $1`, [c.id]);
    assert.deepEqual(await everywhere(), { feed: [], needs: 0, owed: [], waiting: 0, digest: 0 });
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [c.id]);
  });

  await t.test('skipped checks and a never-measured merge count as clean', async () => {
    const c = await change(bob, 32, [7], { checkState: 'skipped', clean: null });
    assert.deepEqual(await everywhere(), {
      feed: [c.id], needs: 1, owed: [`proposal:${c.id}@0`], waiting: 1, digest: 1,
    });
    await pool.query('UPDATE chat_sessions SET status = \'closed\' WHERE id = $1', [c.id]);
  });

  await t.test('a ballot waits while any of its changes is still checking', async () => {
    const a = await change(bob, 40, [7], { clean: true });
    const b = await change(cat, 41, [7], { checkState: 'pending', checkPhase: 'testing' });
    assert.deepEqual(await feed(), [], 'nobody picks between unfinished changes');
    await pool.query('UPDATE chat_sessions SET check_state = \'passing\' WHERE id = $1', [b.id]);
    assert.deepEqual(await feed(), [a.id], 'the older change carries the ready ballot');
    await pool.query('UPDATE chat_sessions SET status = \'closed\' WHERE id = ANY($1::int[])', [[a.id, b.id]]);
  });

  await t.test('the new-proposal ping waits for the checks to pass', async () => {
    const notifications = require('../src/services/notifications');
    await pool.query(
      `INSERT INTO notification_preferences (user_id, app_id, category, enabled)
       VALUES ($1, $2, 'new_proposals', TRUE)
       ON CONFLICT DO NOTHING`, [ada.id, app.id]);
    const c = await change(bob, 50, [7], { checkState: 'pending', checkPhase: 'testing' });
    assert.deepEqual(await notifications.createPrProposedNotifications(pool, {
      appId: app.id, sessionId: c.id, proposerId: bob.id,
    }), [], 'nothing is asked while its tests run');
    await pool.query("UPDATE chat_sessions SET check_state = 'passing', check_phase = NULL WHERE id = $1", [c.id]);
    const rows = await notifications.createPrProposedNotifications(pool, {
      appId: app.id, sessionId: c.id, proposerId: bob.id,
    });
    assert.ok(rows.some((r) => Number(r.user_id) === Number(ada.id)), 'the opt-in stakeholder is asked once it is ready');
    assert.deepEqual(await notifications.createPrProposedNotifications(pool, {
      appId: app.id, sessionId: c.id, proposerId: bob.id,
    }), [], 'and never a second time for the same change');
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [c.id]);
  });
});
