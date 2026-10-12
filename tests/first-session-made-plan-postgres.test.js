'use strict';

// The made screen (frontend/src/features/first-session/made.tsx) shows
// Homeroom bot's plan where the maker is, from GET /api/apps/:slug.
//
// First-session run-through, 5 October 2026: alex_t1005 made Page Turners and
// stayed on the made screen. The bot sent its plan at 11:09 and waited for
// Build it; the screen, looked at three times over the next 18 minutes, never
// drew it. The server had it all along: GET /api/apps/:slug answered the plan
// to its creator. The answer is `{ app }`, and the made screen read
// `first_version` off the answer itself, so it never found a first version at
// all: no plan, and no "Step 3 of 7" either. It reads `app.first_version` now
// (madeAppOf), past the service worker's boot cache (madeAppUrl, no-store).
//
// What only the real records can show: the plan the bot's own path sends
// (homeroom-bot.js awaitGo) reaches the made screen's read of the real route
// as a plan it draws, for its creator only, and goes once Build it is tapped.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/first-session-made-plan-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const { loadTsx } = require('./lib/render-tsx');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const MADE = 'frontend/src/features/first-session/made.tsx';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Realtime and push are process-wide singletons (the bot's DM sends through
// them), and the apps router's infrastructure is not what this is about.
stub(require.resolve('../src/services/ws'), {
  pushConversationEvent: () => 1, pushToUser: () => 1, pushNotificationToUser: () => 1,
  sendSystemMessage: async () => ({ id: 1 }), pushIssueUpdate() {},
});
stub(require.resolve('../src/services/mobile-push'), { scheduleBadgeSync() { return false; } });
stub(require.resolve('../src/services/app-creator'), { createApp: async () => {} });
stub(require.resolve('../src/services/app-forker'), { forkApp: async () => {} });
stub(require.resolve('../src/services/caddy'), { productionHostname: (slug) => `${slug}.example.test`, USERNODE_DOMAIN: 'example.test' });
stub(require.resolve('../src/services/docker'), { getHostPort: async () => null });
stub(require.resolve('../src/services/github'), { parseGithubUrl: () => null, isEnabled: () => false });
stub(require.resolve('../src/services/main-drift-poller'), { checkAndRedeployOne: async () => ({}) });
stub(require.resolve('../src/services/app-secrets'), {});
stub(require.resolve('../src/services/rename-pr'), {});
stub(require.resolve('../src/services/staging'), { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });

let pool = null;
require('../src/db/pool').getPool = () => pool;

const bot = require('../src/services/homeroom-bot');
const progress = require('../src/services/homeroom-bot-progress');
const { appRoutes } = require('../src/routes/apps');

test('the made screen reads the waiting plan off the real GET /api/apps/:slug, for its creator', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `made_plan_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess"`,
    [username, synthetic],
  )).rows[0];
  const homeroomBot = await user('homeroom_bot', true);
  const alex = await user('alex_t1005');
  const priya = await user('priya_t1006');
  // A group project: only its members see it.
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Page Turners', 'page-turners', 'running', $1, 'private', 'private') RETURNING id`,
    [alex.id],
  );
  const app = (await pool.query('SELECT id, slug, name, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  for (const m of [alex, priya]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, m.id]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, m.id]);
  }
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_mode', 'live');
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds, status, issue_number)
     VALUES ($1, $2, 'A book club that meets monthly', TRUE, 'filed', 1)`,
    [app.id, alex.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version, asked_text)
     VALUES ($1, 1, $2, 'First version of Page Turners', TRUE, 'A book club that meets monthly')`,
    [app.id, alex.id],
  );
  const PLAN = {
    bullets: ['A shared list of the books you are reading', 'The next meetup, with who is hosting'],
    questions: [{ question: 'Who\'s hosting the next meetup?', answers: [alex.username, priya.username] }],
  };
  const { rows: [run] } = await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note)
     VALUES ($1, 1, 'live', 'ready', 'Build the reading list.') RETURNING id`,
    [app.id],
  );

  let viewer = alex;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.user = { id: viewer.id, username: viewer.username }; next(); });
  server.use(appRoutes({}));
  const listening = server.listen(0);
  await new Promise((resolve) => listening.once('listening', resolve));
  t.after(() => {
    if (typeof listening.closeAllConnections === 'function') listening.closeAllConnections();
    listening.close();
  });

  const { madeAppOf, madeAppUrl, waitingPlan, madeLine } = loadTsx(MADE);
  // The made screen's own read: its URL, and what it takes from the answer.
  const get = async () => {
    const res = await fetch(`http://127.0.0.1:${listening.address().port}${madeAppUrl(app.slug)}`);
    assert.equal(res.status, 200);
    return res.json();
  };

  let card;
  await t.test('the bot\'s own plan path leaves the first version waiting on its creator', async () => {
    assert.equal(await bot.awaitGo(pool, { runId: run.id, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot }), 'waiting');
    const state = (await progress.requestStates(pool, { userId: alex.id }))
      .find((s) => Number(s.row.issue_number) === 1).state;
    assert.deepEqual([state.stage, state.waitingOn], ['plan', 'them']);
    ({ rows: [card] } = await pool.query(
      `SELECT m.id, m.conversation_id, m.metadata->'homeroomBot' AS meta
         FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
        WHERE d.run_id = $1 AND d.kind = 'plan'`,
      [run.id],
    ));
    assert.equal(card.meta.status, 'open');
  });

  await t.test('its creator\'s made screen finds the plan in the route\'s answer, and draws it', async () => {
    const body = await get();
    assert.deepEqual(Object.keys(body), ['app'], 'the record is under `app`');
    assert.equal(body.first_version, undefined, 'nothing at the top of the answer: what the made screen used to read');
    const fv = body.app.first_version;
    assert.equal(fv.mine, true);
    // #4053: it waits on its creator, said as theirs (buildLineOf).
    assert.deepEqual([fv.step, fv.of, fv.line, fv.ready], [3, 7, 'plan', false]);
    assert.deepEqual(fv.plan.bullets, PLAN.bullets);
    assert.ok(Number.isInteger(fv.plan.actionId), 'an action to decide, as a number');
    assert.equal(fv.plan.actionId, card.meta.actionId);

    const read = madeAppOf(body);
    assert.equal(read.status, 'running');
    assert.deepEqual(waitingPlan(read.firstVersion), {
      bullets: PLAN.bullets,
      questions: PLAN.questions,
      actionId: card.meta.actionId,
      messageId: Number(card.id),
      conversationId: Number(card.conversation_id),
    });
    assert.equal(madeLine(read.firstVersion, true), 'plan', 'Your plan is ready to review, at the foot of its thumbnail');
  });

  await t.test('another member reads the step, never the plan', async () => {
    viewer = priya;
    try {
      const read = madeAppOf(await get());
      assert.equal(read.firstVersion.mine, false);
      assert.equal(read.firstVersion.plan, undefined);
      assert.equal(waitingPlan(read.firstVersion), null);
      assert.equal(read.firstVersion.line, 'plan-member', 'Planning it, for everyone else');
    } finally {
      viewer = alex;
    }
  });

  await t.test('Build it, tapped anywhere: the next read has no plan to draw', async () => {
    const mayor = require('../src/services/homeroom-bot-mayor');
    const tapped = await mayor.decideOfferTap(pool, {}, { user: alex, actionId: card.meta.actionId, choice: 'build', answers: [] });
    assert.deepEqual(tapped, { ok: true, choice: 'build', label: 'Build it' });
    const read = madeAppOf(await get());
    assert.equal(read.firstVersion.plan, undefined);
    assert.equal(waitingPlan(read.firstVersion), null);
    // Build it was the plan's answer: what follows is the build to its maker,
    // step 4, "Building it", never the plan again (Evan, 5 October 2026), and
    // the bot's own account of it says building, not "writing the plan for
    // the build".
    assert.deepEqual([read.firstVersion.step, read.firstVersion.line], [4, 'building'], 'its build waits its turn on the build\'s step');
    const { rightNow } = await progress.progressFor(pool, { userId: alex.id, facts: false });
    const mine = rightNow.find((e) => e.firstVersion);
    assert.ok(mine, 'the first version is in progress');
    assert.deepEqual([mine.step, mine.stepName], [4, 'Building'], 'Step 4 of 7 · Building, in the chat (one story: the steps are named in a word)');
    assert.doesNotMatch(String(mine.doing), /plan/);
  });
});
