'use strict';

// 29 Oct 2026, against the real schema: a change a coding agent submitted
// for its author (chat_sessions.external_agent) waits for its author to tap
// Yes, and that tap counts. tests/agent-submission-yes.test.js holds the
// rule; this holds the reads it rests on: the gate every merge decision
// takes (governance.js governedGate), the serializers' batch read
// (rulesContext), the workflow machine's own read (rules/pr-gate.ts
// readPrGate), and the lists that ask people to vote: the Workshop's owed
// votes and the daily digest, which now ask the author too.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/agent-submission-yes-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}
// The reconcile announces what it applied; nothing here listens.
stub(require.resolve('../src/services/ws'), {
  pushAppUpdate() {}, pushNotificationToUser() {}, sendSystemMessage: async () => ({ id: 1 }),
});

const governance = require('../src/services/governance');
const appManifest = require('../src/services/app-manifest');
const { readPrGate } = require('../src/workflow/rules/pr-gate.ts');
const { COUNTS_SQL } = require('../src/routes/workshop-overview');
const { PENDING_SQL } = require('../src/services/vote-digest');

test('an agent\'s submission waits for its author\'s own yes, which counts', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `agent_submission_yes_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4, connectionTimeoutMillis: 10000 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username],
  )).rows[0];
  const ada = await user('ada_ag');
  const sam = await user('sam_ag');
  const kim = await user('kim_ag');

  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
     VALUES ('agent-yes', 'agent-yes', 'running', $1, 'private', 'private', 'https://github.com/example/agent-yes') RETURNING id`,
    [ada.id],
  );
  const club = (await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  for (const m of [ada, sam, kim]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [club.community_id, m.id]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`, [club.id, m.id]);
    await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [club.id, m.id]);
  }
  const reconcile = async (block) => {
    const manifest = { governance: appManifest.readGovernance({ governance: block }) };
    await appManifest.reconcileAppGovernance(pool, { id: club.id, slug: club.slug }, manifest);
    governance.invalidateGovernance(club.id);
  };
  let pr = 0;
  const proposal = async (author, agent = null) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, promoted_at, branch_name, pr_number, check_state, external_agent)
     VALUES ($1, $2, 'promoted', NOW(), $3, $4, 'passing', $5) RETURNING id`,
    [club.id, author.id, `test/${crypto.randomBytes(4).toString('hex')}`, ++pr, agent],
  )).rows[0].id;
  const vote = (sessionId, who) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')
     ON CONFLICT (session_id, user_id) DO UPDATE SET vote = EXCLUDED.vote`,
    [sessionId, who.id],
  );
  // Every read a merge decision or a list takes, so they can be held to one answer.
  const gates = async (id, author) => {
    const gov = await governance.getGovernance(pool, club.id);
    const ctx = await governance.rulesContext(pool, club.id, gov, 'pr', [id]);
    const listed = governance.computeGate(gov, ctx.facts.membersActive, 0, 0, null, null,
      governance.rulesGateOpts(ctx, id, author.id, null));
    const machine = await readPrGate(pool, {
      sessionId: id, appId: club.id, openedAt: null, explicitApproval: false, explicitReason: null, authorId: author.id, now: new Date(),
    });
    const direct = await governance.governedGate(pool, club.id, { kind: 'pr', id });
    return [direct.mergeable, listed.mergeable, machine.mergeable];
  };

  await t.test('Open floor: proposing through the connector is not a yes; the author\'s tap is', async () => {
    await reconcile({ preset: 'open_floor' });
    const byHand = await proposal(sam);
    assert.deepEqual(await gates(byHand, sam), [true, true, true], 'proposing on Homeroom is still their yes');
    const byAgent = await proposal(sam, 'claude-code');
    assert.deepEqual(await gates(byAgent, sam), [false, false, false], 'every read waits for a tap');
    await vote(byAgent, sam);
    assert.deepEqual(await gates(byAgent, sam), [true, true, true], 'and the author\'s own tap counts');
  });

  await t.test('Two yeses: the author and one more, both tapped', async () => {
    await reconcile({ preset: 'two_yeses' });
    const byAgent = await proposal(sam, 'codex');
    await vote(byAgent, kim);
    assert.deepEqual(await gates(byAgent, sam), [false, false, false]);
    await vote(byAgent, sam);
    assert.deepEqual(await gates(byAgent, sam), [true, true, true]);
  });

  await t.test('#6477: an author who takes their vote back has no yes for proposing, until a new version', async () => {
    await reconcile({ preset: 'two_yeses' });
    const hers = await proposal(sam);
    const before = await governance.governedGate(pool, club.id, { kind: 'pr', id: hers });
    assert.equal(before.qualifiedYes, 1, 'proposing counts as her yes');
    // The retraction's own write (routes/votes.js retractVote stamps the epoch).
    await pool.query(
      'UPDATE chat_sessions SET author_yes_withdrawn_epoch = approval_epoch WHERE id = $1', [hers]
    );
    const after = await governance.governedGate(pool, club.id, { kind: 'pr', id: hers });
    assert.equal(after.qualifiedYes, 0, 'taking the vote back takes the proposing yes with it');
    // Every read agrees: the serializers' batch read and the machine's own.
    const gov = await governance.getGovernance(pool, club.id);
    const ctx = await governance.rulesContext(pool, club.id, gov, 'pr', [hers]);
    const listed = governance.computeGate(gov, ctx.facts.membersActive, 0, 0, null, null,
      governance.rulesGateOpts(ctx, hers, sam.id, null));
    const machine = await readPrGate(pool, {
      sessionId: hers, appId: club.id, openedAt: null, explicitApproval: false, explicitReason: null, authorId: sam.id, now: new Date(),
    });
    assert.equal(listed.qualifiedYes, 0);
    assert.equal(machine.qualifiedYes, 0);
    assert.deepEqual(await gates(hers, sam), [false, false, false]);
    // A new version is proposing it again.
    await pool.query('UPDATE chat_sessions SET approval_epoch = approval_epoch + 1 WHERE id = $1', [hers]);
    assert.equal((await governance.governedGate(pool, club.id, { kind: 'pr', id: hers })).qualifiedYes, 1);
    await pool.query(`UPDATE chat_sessions SET status = 'closed' WHERE id = $1`, [hers]);
  });

  await t.test('Needs you and the digest ask the author of an agent\'s submission for their yes', async () => {
    await pool.query(`UPDATE chat_sessions SET status = 'closed' WHERE app_id = $1`, [club.id]);
    const owed = async (who) => {
      const { rows } = await pool.query(COUNTS_SQL, [who.id, false, false]);
      const row = rows.find((r) => r.slug === club.slug);
      return row ? Number(row.needs) : 0;
    };
    const digest = async (who) => (await pool.query(PENDING_SQL, ['24'])).rows.find((r) => r.user_id === who.id);
    const byHand = await proposal(sam);
    assert.equal(await owed(sam), 0, 'their own change made on Homeroom is not owed by them');
    assert.equal(await digest(sam), undefined);
    assert.equal(await owed(kim), 1);
    await pool.query(`UPDATE chat_sessions SET status = 'closed' WHERE id = $1`, [byHand]);

    const byAgent = await proposal(sam, 'claude-code');
    assert.equal(await owed(sam), 1, 'one an agent submitted for them is');
    assert.equal(Number((await digest(sam)).pending), 1, 'and their digest counts it');
    await vote(byAgent, sam);
    assert.equal(await owed(sam), 0, 'until they vote on it');
    assert.equal(await digest(sam), undefined);
    assert.equal(await owed(kim), 1, 'everyone else still owes theirs');
  });
});
