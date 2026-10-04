'use strict';

// B8: one front door. A request asked for on the platform (Ask for a change)
// goes to Homeroom bot as one filed in its chat does: recorded as the
// asker's, in their words, first in its queue with its card in their DM, and
// the confirmation says how long it usually takes. Only members file one.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-front-door.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('B8: Ask for a change is gated on membership and hands its request to the bot', () => {
  const route = read('src/routes/feedback.js');
  assert.match(route, /const join = await communities\.appNeedsJoin\(pool, appSlug, req\.user\);\s*if \(join\) return res\.status\(403\)\.json\(join\);/);
  assert.ok(route.indexOf('appNeedsJoin') < route.indexOf('github.createIssue(issueOwner'), 'before anything is filed');
  assert.match(route, /noteRequestFiled\(pool, \{\s*app: appContext, user: req\.user, issueNumber: issue\.number, title, askedText: description\.trim\(\),/);
  assert.match(route, /\.\.\.\(homeroomBot \? \{ homeroomBot \} : \{\}\),/);
  const convs = read('src/routes/conversations.js');
  assert.match(convs, /router\.post\('\/api\/conversations\/homeroom-bot', conversationMessageLimiter, sameOriginBrowserOnly,/);
});

test('B8: the doors that open the chat with Homeroom bot, and what they are called', () => {
  assert.match(read('frontend/src/features/app-context/app-context-sheet.tsx'), /label="Build it yourself"/);
  const row = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.ok(row.indexOf('data-plus="issue"') < row.indexOf('data-plus="new-change"'), 'Ask for a change leads the hub\'s ⋯');
  assert.match(row, /title="Build it yourself"\s+sub="With a coding agent, then ask for approval"/);
  assert.match(read('frontend/src/features/home/tour/tour-steps.ts'), /body: 'Tell Homeroom bot what should change\. It builds it for you, or passes it to the group as a request\. To build it yourself with a coding agent, tap Build it yourself\.'/);
  assert.match(read('frontend/src/features/dialogs/create-app.tsx'), /openLabel=\{botChat \? 'Open chat' : 'Open project'\}/);
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /openBot: \(\) => \{ void openBot\(\); \},/);
  for (const f of ['game-2d', 'game-3d', 'multimedia-social', 'social-productivity']) {
    assert.match(read(`app-templates/${f}/public/index.html`), /To change this app, ask Homeroom bot: tap the Homeroom icon, then <strong class="font-semibold">Ask for a change<\/strong>\./, f);
  }
});

test('B8: filing, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_door_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));
  const dm = require('../src/services/homeroom-bot-dm');
  const communities = require('../src/services/communities');
  const user = async (username, extra = {}) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic, is_admin) VALUES ($1, 'x', TRUE, $2, $3)
     RETURNING id, username, is_synthetic AS "isSynthetic", is_admin AS "isAdmin", has_platform_access AS "hasPlatformAccess"`,
    [username, !!extra.synthetic, !!extra.admin],
  )).rows[0];
  await user('homeroom_bot', { synthetic: true });
  const maya = await user('maya');
  const sam = await user('sam');
  const boss = await user('boss', { admin: true });
  const project = async (slug, label) => {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, 'public', 'public') RETURNING id`,
      [label, slug, maya.id],
    );
    const app = (await pool.query('SELECT id, slug, name, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, maya.id]);
    return app;
  };
  const plantPal = await project('plant-pal', 'Plant Pal');
  const quiet = await project('quiet-notes', 'Quiet notes');
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_dm_users', JSON.stringify(['maya']));
  await set('homeroom_bot_mode', 'live');
  await set('homeroom_bot_live_apps', JSON.stringify(['plant-pal']));

  await t.test('only a member files a request; an admin always may', async () => {
    const refused = await communities.appNeedsJoin(pool, 'plant-pal', sam);
    assert.equal(refused.code, 'join_required');
    assert.deepEqual(refused.app, { slug: 'plant-pal', name: 'Plant Pal' });
    assert.equal(await communities.appNeedsJoin(pool, 'plant-pal', maya), null);
    assert.equal(await communities.appNeedsJoin(pool, 'plant-pal', boss), null);
    assert.equal(await communities.appNeedsJoin(pool, 'nowhere', sam), null, 'a missing app is the route\'s own 404');
  });

  await t.test('on a project the bot builds on, it goes to the bot first, in her words, with its card', async () => {
    const out = await dm.noteRequestFiled(pool, {
      app: plantPal, user: maya, issueNumber: 12, title: 'Weekly reminder', askedText: 'Remind me to water on Sundays',
    });
    assert.deepEqual(out, { botWillBuild: true, typicalMinutes: dm.TYPICAL_BUILD_MINUTES });
    const { rows: [mine] } = await pool.query(
      'SELECT user_id, issue_title, asked_text FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = 12', [plantPal.id],
    );
    assert.deepEqual(mine, { user_id: maya.id, issue_title: 'Weekly reminder', asked_text: 'Remind me to water on Sundays' });
    const { rows: [queued] } = await pool.query(
      'SELECT priority, reason, payer_user_id FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 12', [plantPal.id],
    );
    assert.deepEqual(queued, { priority: 0, reason: 'asked', payer_user_id: maya.id });
    const { rows: cards } = await pool.query(
      `SELECT m.content, m.metadata FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
        WHERE d.user_id = $1 AND d.app_id = $2 AND d.issue_number = 12 AND d.kind = 'activity'`,
      [maya.id, plantPal.id],
    );
    assert.equal(cards.length, 1);
    assert.match(cards[0].content, /Filed\. This card follows it from here\./);
    assert.equal(cards[0].metadata.homeroomBot.askedText, 'Remind me to water on Sundays');
  });

  await t.test('elsewhere it goes to the group; and nothing for somebody the bot does not talk to', async () => {
    assert.deepEqual(await dm.noteRequestFiled(pool, { app: quiet, user: maya, issueNumber: 3, title: 'Tags', askedText: 'Tags please' }),
      { botWillBuild: false });
    const { rows: [mine] } = await pool.query('SELECT asked_text FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = 3', [quiet.id]);
    assert.equal(mine.asked_text, 'Tags please', 'still recorded as hers, for when it does');
    assert.equal(await dm.noteRequestFiled(pool, { app: plantPal, user: sam, issueNumber: 13, title: 'x', askedText: 'y' }), null);
  });

  await t.test('how long it usually takes is the median of its own record, once there is enough of it', async () => {
    assert.equal(await dm.typicalMinutes(pool), dm.TYPICAL_BUILD_MINUTES, 'too little record');
    for (const minutes of [4, 5, 6, 12, 30]) {
      const { rows: [s] } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at)
         VALUES ($1, $2, $3, 'promoted', 'x', NOW()) RETURNING id`,
        [plantPal.id, maya.id, `b-${minutes}`],
      );
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, created_at, duration_ms)
         VALUES ($1, $2, 'live', 'ready', $3, NOW() - make_interval(mins => $4), 0)`,
        [plantPal.id, 100 + minutes, s.id, minutes],
      );
    }
    assert.equal(await dm.typicalMinutes(pool), 6);
  });
});
