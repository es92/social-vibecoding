// Every vote is born at an epoch — the write-side half of "which approvals
// describe the code under review".
//
// #2038 made a vote count while pv.approval_epoch = cs.approval_epoch. That
// is an equality against a NULLABLE column, so a vote whose epoch was never
// set can never count, however the group votes. Only recordVote named the
// column; thirteen other INSERT INTO pr_votes statements did not, and every
// row they wrote was dead on arrival (#2050) — including the one in
// services/rename-pr.js that carries real people's issue votes onto a rename
// PR.
//
// Two separate defects, and this file pins both:
//
//   1. INSERT paths. schema.sql's pr_votes_stamp_approval_epoch trigger fills
//      the column from the session, so a caller that has never heard of
//      epochs writes a vote that counts.
//   2. The backfill. It kept only half of the rule it was replacing. The old
//      predicate was `(<reviewed head> IS NULL OR pv.head_sha = <reviewed
//      head>)`, and a session with NO reviewed head counted every vote on it
//      — every rename PR, every staging fixture. Dropping that half zeroed
//      their tallies the moment the migration ran, which is precisely the
//      thing #2038 promised not to do.
//
// It runs the REAL statements out of schema.sql against a real PostgreSQL,
// because a mock cannot have a trigger and NULL semantics are the whole
// subject. Set TEST_DATABASE_URL to point it somewhere; without one it skips.
//
// Run with: node --test tests/pr-vote-epoch-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const { currentVotePredicateSql } = require('../src/services/pr-vote-revision');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

// The migration as shipped, lifted verbatim — the ALTERs, the backfill and
// the trigger. Extracting it rather than retyping it is the point: a test
// holding its own copy of the SQL stops being evidence about the SQL that
// ships the first time the two drift.
function epochMigration() {
  const start = SCHEMA.indexOf('ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS approval_epoch');
  assert.ok(start > 0, 'the approval-epoch migration must be findable in schema.sql');
  // Ends at the trigger when there is one, and at the backfill when there is
  // not. The fallback is what makes this a test OF the fix rather than a test
  // that the fix is present: run against the schema as #2038 shipped it, the
  // assertions below fail on the behaviour — a carried vote that does not
  // count — instead of failing to find a string.
  const marker = 'EXECUTE FUNCTION stamp_pr_vote_approval_epoch();\n  END IF;\nEND $$;';
  const withTrigger = SCHEMA.indexOf(marker, start);
  if (withTrigger > start) return SCHEMA.slice(start, withTrigger + marker.length);
  const backfillEnd = SCHEMA.indexOf('reviewed_head_sha END));', start);
  const legacyEnd = SCHEMA.indexOf('ELSE cs.reviewed_head_sha END);', start);
  const end = backfillEnd > start ? backfillEnd + 'reviewed_head_sha END));'.length
    : legacyEnd + 'ELSE cs.reviewed_head_sha END);'.length;
  assert.ok(end > start, 'the approval-epoch backfill must be findable in schema.sql');
  return SCHEMA.slice(start, end);
}

// A vote counts when the platform's own predicate says so. Asking it, rather
// than re-writing the comparison here, is what keeps this test honest if the
// definition ever moves again.
const COUNTED = `(SELECT COUNT(*) FROM pr_votes pv
   WHERE pv.session_id = cs.id AND ${currentVotePredicateSql('pv', 'cs')})`;

test('a vote is born at its session’s epoch, whoever inserts it', async (t) => {
  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL
      || 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    connectionTimeoutMillis: 1500,
  });
  try { await client.connect(); } catch {
    await client.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not reachable');
    return t.skip('No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.');
  }

  // Per-process, like every other *-postgres test here. The runner gives each
  // test FILE its own process and runs files concurrently, so a fixed name is
  // a shared resource: `DROP SCHEMA ... CASCADE` takes an ACCESS EXCLUSIVE
  // lock, Postgres's default lock_timeout is 0 (wait forever), and two
  // overlapping runs would park a connection indefinitely rather than fail.
  const schema = `pr_vote_epoch_test_${process.pid}`;

  try {
    // Belt and braces for the same hazard: never let this file block the
    // suite, whatever else is holding a lock on the database it shares.
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '30s'");
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path = ${schema}`);

    // Only the columns the migration touches. chat_sessions has ~200 of them
    // and none of the rest participate.
    await client.query(`
      CREATE TABLE chat_sessions (
        id INTEGER PRIMARY KEY,
        source TEXT,
        imported_pr_head_sha VARCHAR(40),
        reviewed_head_sha VARCHAR(40))`);
    await client.query(`
      CREATE TABLE pr_votes (
        session_id INTEGER NOT NULL REFERENCES chat_sessions(id),
        user_id INTEGER NOT NULL,
        vote TEXT NOT NULL,
        head_sha VARCHAR(40),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, user_id))`);

    const SHA = 'a'.repeat(40);
    const OTHER = 'b'.repeat(40);

    // ── Rows that exist BEFORE the migration, so the backfill sees them ──
    // (1) a rename PR / staging fixture: no reviewed head at all
    // (2) a proposal whose vote is on its current head
    // (3) a proposal whose vote is on an OLD head
    await client.query(`INSERT INTO chat_sessions (id, reviewed_head_sha) VALUES
      (1, NULL), (2, '${SHA}'), (3, '${SHA}')`);
    await client.query(`INSERT INTO pr_votes (session_id, user_id, vote, head_sha) VALUES
      (1, 10, 'yes', NULL),
      (2, 10, 'yes', '${SHA}'),
      (3, 10, 'yes', '${OTHER}')`);

    await client.query(epochMigration());

    const counted = async (id) => {
      const { rows } = await client.query(
        `SELECT ${COUNTED} AS n FROM chat_sessions cs WHERE cs.id = $1`, [id]);
      return Number(rows[0].n);
    };

    // ── 1. The backfill preserves the OLD rule, both halves ─────────────
    assert.equal(await counted(1), 1,
      'a session with no reviewed head counted every vote on it, and must still — #2050');
    assert.equal(await counted(2), 1,
      'a vote on the reviewed head kept counting');
    assert.equal(await counted(3), 0,
      'a vote genuinely stale under the old rule must NOT be resurrected');

    // ── 2. The trigger: an insert that never heard of epochs ────────────
    // The shape every seed and services/rename-pr.js use.
    await client.query(
      `INSERT INTO pr_votes (session_id, user_id, vote) VALUES (1, 11, 'yes')`);
    assert.equal(await counted(1), 2,
      'a vote inserted without naming approval_epoch must count');

    // ── 3. It stamps the SESSION’s epoch, not a blanket zero ────────────
    await client.query(`INSERT INTO chat_sessions (id) VALUES (4)`);
    await client.query(`UPDATE chat_sessions SET approval_epoch = 3 WHERE id = 4`);
    await client.query(
      `INSERT INTO pr_votes (session_id, user_id, vote) VALUES (4, 10, 'yes')`);
    const { rows: stamped } = await client.query(
      'SELECT approval_epoch FROM pr_votes WHERE session_id = 4 AND user_id = 10');
    assert.equal(stamped[0].approval_epoch, 3,
      'stamping 0 would make every vote on a session that has cleared approvals dead');
    assert.equal(await counted(4), 1);

    // ── 4. An epoch the caller supplied is left alone ───────────────────
    // recordVote decides what a real vote is cast under; the trigger's WHEN
    // clause means those inserts never reach it.
    await client.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch)
       VALUES (4, 11, 'yes', 99)`);
    const { rows: kept } = await client.query(
      'SELECT approval_epoch FROM pr_votes WHERE session_id = 4 AND user_id = 11');
    assert.equal(kept[0].approval_epoch, 99, 'the caller’s epoch must survive');
    assert.equal(await counted(4), 1, 'and an epoch that does not match still does not count');

    // ── 5. An explicit NULL is stamped too ──────────────────────────────
    // WHEN tests the value, not whether the statement named the column, so
    // there is no way left to write a vote that cannot count.
    await client.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch)
       VALUES (4, 12, 'yes', NULL)`);
    const { rows: explicitNull } = await client.query(
      'SELECT approval_epoch FROM pr_votes WHERE session_id = 4 AND user_id = 12');
    assert.equal(explicitNull[0].approval_epoch, 3,
      'an explicit NULL must be stamped, or the hole is still open');

    // ── 6. Clearing approvals still works ───────────────────────────────
    // The trigger must not weaken the one thing the epoch exists to do.
    await client.query('UPDATE chat_sessions SET approval_epoch = approval_epoch + 1 WHERE id = 1');
    assert.equal(await counted(1), 0,
      'bumping the session epoch must still retire every vote under it');
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  }
});

// Runs without a database, so the trigger cannot be quietly deleted in a
// checkout where the DB tests skip.
test('schema.sql declares the stamping trigger on pr_votes', () => {
  assert.match(SCHEMA, /CREATE TRIGGER pr_votes_stamp_approval_epoch\s+BEFORE INSERT ON pr_votes/,
    'the invariant is the trigger; fifteen call sites will not remember the rule');
  assert.match(SCHEMA, /FOR EACH ROW WHEN \(NEW\.approval_epoch IS NULL\)/,
    'the WHEN clause is what keeps recordVote authoritative and the common path free');
});
