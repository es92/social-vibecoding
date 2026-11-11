'use strict';

// 13 Oct 2026, run four (Club Votes), against the real schema: a project's
// first version goes live without a vote (D1), and every later change
// Homeroom bot makes needs a person's yes (D2). tests/first-version-gate.test.js
// holds the rules; this holds the reads they rest on: which change is the
// first version (services/first-version-rule.js, from the bot's runs and
// homeroom_bot_first_versions), whether a change's author is a person
// (users.is_synthetic), the gate every merge decision takes
// (governance.js governedGate) and the serializers' batch read
// (rulesContext), and the lists that ask people to vote: the Workshop's
// owed votes, the daily digest and the "new proposal" notification.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/first-version-gate-postgres.test.js

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
const firstVersionRule = require('../src/services/first-version-rule');
const notifications = require('../src/services/notifications');
const { COUNTS_SQL } = require('../src/routes/workshop-overview');
const { PENDING_SQL } = require('../src/services/vote-digest');

test('the first version skips the vote; the bot\'s later changes wait for a person', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `first_version_gate_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4, connectionTimeoutMillis: 10000 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  const ada = await user('ada_fv');
  const sam = await user('sam_fv');
  const kim = await user('kim_fv');

  const project = async (slug, members) => {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
       VALUES ($1, $1, 'running', $2, 'private', 'private', $3) RETURNING id`,
      [slug, members[0].id, `https://github.com/example/${slug}`],
    );
    const app = (await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
    for (const m of members) {
      await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, m.id]);
      await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`, [app.id, m.id]);
      await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.id, m.id]);
    }
    return app;
  };
  const reconcile = async (app, block) => {
    const manifest = { governance: appManifest.readGovernance({ governance: block }) };
    await appManifest.reconcileAppGovernance(pool, { id: app.id, slug: app.slug }, manifest);
    governance.invalidateGovernance(app.id);
  };
  const proposal = async (app, author, extra = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, promoted_at, branch_name, pr_number, check_state, requires_explicit_approval)
     VALUES ($1, $2, 'promoted', NOW(), $3, 1, 'passing', $4) RETURNING id`,
    [app.id, author.id, `test/${crypto.randomBytes(4).toString('hex')}`, !!extra.explicit],
  )).rows[0].id;
  // The bot's run for request `issue`, its proposal recorded (or, at the
  // moment of the promote, only its build session).
  const run = (app, issue, sessionId, { recorded = true } = {}) => pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, build_session_id, proposal_session_id)
     VALUES ($1, $2, 'live', 'ready', TRUE, $3, $4)`,
    [app.id, issue, sessionId, recorded ? sessionId : null],
  );
  const describedAs = (app, issue) => pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number)
     SELECT $1, created_by, 'what it should do', 'filed', $2 FROM apps WHERE id = $1`,
    [app.id, issue],
  );
  const vote = (sessionId, who) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')
     ON CONFLICT (session_id, user_id) DO UPDATE SET vote = EXCLUDED.vote`,
    [sessionId, who.id],
  );
  const gate = (app, id, extra = {}) => governance.governedGate(pool, app.id, { kind: 'pr', id, ...extra });
  // The serializers' path: one batch read, then computeGate per row.
  const listed = async (app, id, author) => {
    const gov = await governance.getGovernance(pool, app.id);
    const ctx = await governance.rulesContext(pool, app.id, gov, 'pr', [id]);
    return governance.computeGate(gov, ctx.facts.membersActive, 0, 0, null, null, {
      ...governance.rulesGateOpts(ctx, id, author.id, null),
      firstVersion: await firstVersionRule.isFirstVersion(pool, id),
    });
  };

  const club = await project('club-votes-fv', [ada, sam, kim]);

  await t.test('D2: on Open floor the bot\'s change needs a member\'s yes, as a person\'s own does', async () => {
    await reconcile(club, { preset: 'open_floor' });
    const bots = await proposal(club, bot);
    await run(club, 7, bots);
    const waiting = await gate(club, bots);
    assert.equal(waiting.mode, 'rules');
    assert.equal(waiting.mergeable, false, 'the bot proposing it is nobody\'s yes');
    assert.equal((await listed(club, bots, bot)).mergeable, false, 'and the lists say the same');
    await vote(bots, kim);
    assert.equal((await gate(club, bots)).mergeable, true, 'any member\'s yes lets it in');

    const hers = await proposal(club, sam);
    assert.equal((await gate(club, hers)).mergeable, false, 'a person proposing is not their yes (11 Nov 2026)');
    assert.equal((await listed(club, hers, sam)).mergeable, false);
    await vote(hers, sam);
    assert.equal((await gate(club, hers)).mergeable, true, 'their tap is');
    assert.equal((await listed(club, hers, sam)).mergeable, true);
  });

  await t.test('D2: Two yeses from the bot is two people\'s', async () => {
    await reconcile(club, { preset: 'two_yeses' });
    const bots = await proposal(club, bot);
    await run(club, 8, bots);
    await vote(bots, sam);
    assert.equal((await gate(club, bots)).mergeable, false);
    await vote(bots, kim);
    assert.equal((await gate(club, bots)).mergeable, true);
  });

  await t.test('D1: the first version goes live with no votes, on a project of any rule', async () => {
    await reconcile(club, { preset: 'you_or_the_group' });
    await describedAs(club, 1);
    const first = await proposal(club, bot);
    // At the promote the run names only its build session; that is enough.
    await run(club, 1, first, { recorded: false });
    assert.equal(await firstVersionRule.isFirstVersion(pool, first), true);
    const g = await gate(club, first);
    assert.equal(g.mergeable, true);
    assert.equal(g.firstVersion, true);
    assert.equal(g.required, 0);
    assert.equal((await listed(club, first, bot)).mergeable, true);
    await pool.query('UPDATE homeroom_bot_runs SET proposal_session_id = build_session_id WHERE build_session_id = $1', [first]);
    assert.equal((await gate(club, first)).mergeable, true, 'and once its proposal is recorded');

    // The two columns' gate as well (a project that never chose a rule).
    await pool.query('UPDATE apps SET governance_rules = NULL WHERE id = $1', [club.id]);
    governance.invalidateGovernance(club.id);
    const columns = await gate(club, first);
    assert.equal(columns.mode, 'default');
    assert.equal(columns.mergeable, true);
    await reconcile(club, { preset: 'you_or_the_group' });

    // Changing protected settings, it still goes by that rule.
    const flagged = await proposal(club, bot, { explicit: true });
    await run(club, 1, flagged);
    const held = await gate(club, flagged, { explicitApproval: true, explicitReason: 'visibility' });
    assert.equal(held.mergeable, false);
    assert.equal(held.firstVersion, undefined);
    await pool.query(`UPDATE chat_sessions SET status = 'closed' WHERE id = $1`, [flagged]);
  });

  await t.test('owed votes, the digest and the "new proposal" ping leave the first version out', async () => {
    const first = (await pool.query(
      'SELECT proposal_session_id AS id FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = 1 AND proposal_session_id IS NOT NULL', [club.id],
    )).rows[0].id;
    // Only the first version is up now.
    await pool.query(`UPDATE chat_sessions SET status = 'closed' WHERE app_id = $1 AND id <> $2`, [club.id, first]);
    const owed = async (who) => {
      const { rows } = await pool.query(COUNTS_SQL, [who.id, false, false]);
      const row = rows.find((r) => r.slug === club.slug);
      return row ? Number(row.needs) : 0;
    };
    const digest = async () => (await pool.query(PENDING_SQL, ['24'])).rows.filter((r) => [ada.id, sam.id, kim.id].includes(r.user_id));
    assert.equal(await owed(ada), 0, 'its maker owes no vote on it');
    assert.equal(await owed(sam), 0);
    assert.deepEqual(await digest(), [], 'nobody\'s digest counts it');
    await pool.query(
      `INSERT INTO notification_preferences (user_id, app_id, category, enabled) VALUES ($1, NULL, 'new_proposals', TRUE)`,
      [sam.id],
    );
    assert.deepEqual(await notifications.createPrProposedNotifications(pool, { appId: club.id, sessionId: first, proposerId: bot.id }), [],
      'nobody is asked to come and vote on it');

    // A later change of the bot's is owed, counted and pinged as before.
    const later = await proposal(club, bot);
    await run(club, 2, later);
    assert.equal(await owed(ada), 1);
    assert.equal(await owed(sam), 1);
    assert.ok((await digest()).some((r) => r.user_id === sam.id));
    const pinged = await notifications.createPrProposedNotifications(pool, { appId: club.id, sessionId: later, proposerId: bot.id });
    assert.deepEqual(pinged.map((r) => r.user_id), [sam.id]);
  });

  await t.test('D1 ends once a change for the request is live: the next one goes to the vote', async () => {
    const first = (await pool.query(
      'SELECT proposal_session_id AS id FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = 1 AND proposal_session_id IS NOT NULL ORDER BY id LIMIT 1', [club.id],
    )).rows[0].id;
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [first]);
    assert.equal(await firstVersionRule.isFirstVersion(pool, first), true, 'the one that went live still was the first version');
    // Another build for the same request after it went live is a later change.
    const again = await proposal(club, bot);
    await run(club, 1, again);
    assert.equal(await firstVersionRule.isFirstVersion(pool, again), false);
    const g = await gate(club, again);
    assert.equal(g.mergeable, false);
    assert.equal(g.firstVersion, undefined);
    // And a change for any other request never was one.
    const other = await proposal(club, bot);
    await run(club, 9, other);
    assert.equal(await firstVersionRule.isFirstVersion(pool, other), false);
    // A person's change is never the first version, whatever it closes.
    assert.equal(await firstVersionRule.isFirstVersion(pool, await proposal(club, ada)), false);
  });
});
