'use strict';

// #4666, WHO SAYS YES, against the real schema: a project's rules as the
// deploy reconcile stores them (app-manifest.js reconcileAppGovernance,
// apps.governance_rules), and the gate every merge decision reads
// (governance.js governedGate) over real votes, real members and a named
// group resolved from usernames. tests/governance-rules.test.js holds the
// rules themselves; this holds the reads.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/governance-rules-postgres.test.js

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

test('a project’s rules, stored by the reconcile and read by the gate', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `gov_rules_${crypto.randomBytes(6).toString('hex')}`;
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
  const evan = await user('evan_g4666');
  const maya = await user('maya_g4666');
  const snait = await user('snait_g4666');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
     VALUES ('Swim Spots', 'swim-spots-g4666', 'running', $1, 'private', 'private', 'https://github.com/example/swim-spots')
     RETURNING id`,
    [evan.id],
  );
  const app = (await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  for (const u of [evan, maya, snait]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, u.id]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`, [app.id, u.id]);
  }
  const proposal = async (author) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, promoted_at, branch_name, pr_number)
     VALUES ($1, $2, 'promoted', NOW(), $3, 1) RETURNING id`,
    [app.id, author.id, `test/${crypto.randomBytes(4).toString('hex')}`],
  )).rows[0].id;
  const vote = (sessionId, who, value) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, $3)
     ON CONFLICT (session_id, user_id) DO UPDATE SET vote = EXCLUDED.vote`,
    [sessionId, who.id, value],
  );
  const reconcile = async (block) => {
    const manifest = { governance: appManifest.readGovernance({ governance: block }) };
    const changed = await appManifest.reconcileAppGovernance(pool, { id: app.id, slug: app.slug }, manifest);
    governance.invalidateGovernance(app.id);
    return changed;
  };
  const gate = (sessionId, extra = {}) => governance.governedGate(pool, app.id, { kind: 'pr', id: sessionId, ...extra });

  await t.test('a project that never chose keeps the two columns and today’s gate', async () => {
    const gov = await governance.getGovernance(pool, app.id);
    assert.equal(gov.rules, null);
    const id = await proposal(maya);
    assert.equal((await gate(id)).mode, 'default');
  });

  await t.test('You or the group: the creator’s yes, or the group', async () => {
    assert.equal(await reconcile({ preset: 'you_or_the_group' }), true);
    assert.equal(await reconcile({ preset: 'you_or_the_group' }), false, 'the same block again changes nothing');
    const stored = (await pool.query('SELECT governance_rules, approver_policy FROM apps WHERE id = $1', [app.id])).rows[0];
    assert.equal(stored.governance_rules.preset, 'you_or_the_group');
    assert.equal(stored.approver_policy, 'anyone');

    const mine = await proposal(evan);
    const own = await gate(mine);
    assert.equal(own.mode, 'rules');
    assert.equal(own.mergeable, false, 'proposing is not the creator’s yes (11 Nov 2026)');
    await vote(mine, evan, 'yes');
    assert.equal((await gate(mine)).mergeable, true, 'their tap is');

    const hers = await proposal(maya);
    assert.equal((await gate(hers)).mergeable, false);
    await vote(hers, evan, 'yes');
    const approved = await gate(hers);
    assert.equal(approved.mergeable, true);
    assert.equal(approved.creatorYes, true);
    assert.equal(approved.passedBy.group, 'creator');
  });

  await t.test('a change to who decides: the creator’s yes, never a quiet wait', async () => {
    const hers = await proposal(maya);
    await vote(hers, snait, 'yes');
    const waiting = await gate(hers, { explicitApproval: true, explicitReason: 'visibility' });
    assert.equal(waiting.whoDecides, true);
    assert.equal(waiting.lazyArmed, false);
    await vote(hers, evan, 'yes');
    assert.equal((await gate(hers, { explicitApproval: true, explicitReason: 'visibility' })).mergeable, true);
  });

  await t.test('a named group from dapp.json, resolved to its people', async () => {
    assert.equal(await reconcile({
      groups: [{ name: 'Lifeguards', people: ['maya_g4666', 'SNAIT_G4666'] }],
      rules: [{ group: 'Lifeguards', atLeast: 2 }],
    }), true);
    const stored = (await pool.query('SELECT governance_rules FROM apps WHERE id = $1', [app.id])).rows[0].governance_rules;
    assert.deepEqual(stored.groups[0].ids, [maya.id, snait.id].sort((a, b) => a - b));

    const his = await proposal(evan);
    await vote(his, evan, 'yes');
    assert.equal((await gate(his)).mergeable, false, 'the creator is not a lifeguard');
    await vote(his, maya, 'yes');
    assert.equal((await gate(his)).mergeable, false);
    await vote(his, snait, 'yes');
    assert.equal((await gate(his)).mergeable, true);

    // A lifeguard who makes the change says yes with a tap, not by proposing.
    const hers = await proposal(maya);
    await vote(hers, snait, 'yes');
    assert.equal((await gate(hers)).mergeable, false);
    await vote(hers, maya, 'yes');
    assert.equal((await gate(hers)).mergeable, true);

    const described = await governance.describeApproval(pool, app.id, await governance.getGovernance(pool, app.id));
    assert.equal(described.mode, 'rules');
    assert.equal(described.preset, null);
    assert.deepEqual(described.rules.map((r) => [r.group, r.size, r.need]), [['lifeguards', 2, 2]]);
  });

  await t.test('a group the app keeps is read live, in both gates', async () => {
    assert.equal(await reconcile({
      groups: [{ name: 'App users', keptByApp: true }],
      rules: [{ group: 'App users', atLeast: 1 }],
    }), true);
    const stored = (await pool.query('SELECT governance_rules FROM apps WHERE id = $1', [app.id])).rows[0].governance_rules;
    assert.equal(stored.groups[0].keptByApp, true);
    assert.deepEqual(stored.groups[0].ids, [], 'the app resolves its own people');

    // The app reports maya.
    const report = (userIds) => pool.query(
      `INSERT INTO app_groups (app_id, key, name, reported_at) VALUES ($1, 'app users', 'App users', NOW())
       ON CONFLICT (app_id, key) DO UPDATE SET reported_at = NOW() RETURNING id`, [app.id]);
    const group = async () => (await pool.query(
      "SELECT id FROM app_groups WHERE app_id = $1 AND key = 'app users'", [app.id])).rows[0];
    const setMembers = async (ids) => {
      await report();
      const g = await group();
      await pool.query('DELETE FROM app_group_members WHERE group_id = $1', [g.id]);
      for (const id of ids) {
        await pool.query('INSERT INTO app_group_members (group_id, user_id) VALUES ($1, $2)', [g.id, id]);
      }
      governance.invalidateGovernance(app.id);
    };
    const machine = (id) => readPrGate(pool, {
      sessionId: id, appId: app.id, openedAt: null, explicitApproval: false, explicitReason: null, authorId: evan.id, now: new Date(),
    });

    await setMembers([maya.id]);
    const his = await proposal(evan);
    await vote(his, maya, 'yes');
    assert.equal((await gate(his)).mergeable, true);
    assert.equal((await machine(his)).mergeable, true, 'the workflow gate agrees');

    // Maya stops qualifying: her vote row stays, but it no longer counts.
    await setMembers([]);
    assert.equal((await gate(his)).mergeable, false);
    assert.equal((await machine(his)).mergeable, false);
    // She qualifies again: the same vote counts again.
    await setMembers([maya.id]);
    assert.equal((await gate(his)).mergeable, true);

    const described = await governance.describeApproval(pool, app.id, await governance.getGovernance(pool, app.id));
    assert.equal(described.groups[0].keptByApp, true);
    assert.equal(described.groups[0].size, 1);
    assert.ok(described.groups[0].reportedAt);

    // #6811: every group the app has sent rides along, declared or not, with
    // its size and when it sent its list, and counts only.
    await pool.query(
      "INSERT INTO app_groups (app_id, key, name) VALUES ($1, 'finishers', 'Finishers')", [app.id]
    );
    const all = (await governance.describeApproval(pool, app.id, await governance.getGovernance(pool, app.id))).appGroups;
    assert.deepEqual(all.map((g) => [g.name, g.key, g.size]), [['App users', 'app users', 1], ['Finishers', 'finishers', 0]]);
    assert.ok(all[0].reportedAt, 'the declared group says when the app last sent it');
    assert.equal(all[1].reportedAt, null, 'a group the app made but never sent has no time');
    for (const g of all) {
      assert.deepEqual(Object.keys(g).sort(), ['key', 'name', 'reportedAt', 'size'], 'counts only, never who is in it');
      assert.equal(g.people, undefined);
      assert.equal(g.ids, undefined);
    }
  });

  await t.test('an old-style block takes the project back to the two columns', async () => {
    assert.equal(await reconcile({ approvers: 'anyone', approvals: { atLeast: 1 } }), true);
    const gov = await governance.getGovernance(pool, app.id);
    assert.equal(gov.rules, null);
    assert.equal(gov.approvalsRequired, 1);
    // #6811: the app's groups are listed on a project on the two columns too.
    const cols = await governance.describeApproval(pool, app.id, gov);
    assert.equal(cols.mode, 'columns');
    assert.ok(cols.appGroups.some((g) => g.name === 'App users'), 'the sheet lists the app’s groups whatever the rules');
  });
});
