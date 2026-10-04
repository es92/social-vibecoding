'use strict';

// B4: the person stays the author, and the bot speaks in plain words.
//
//   - what somebody asked for is kept in their own words (asked_text): their
//     message to the bot, the description they wrote when they asked for a
//     change, a first version's brief. Their activity card leads with it.
//   - a change the bot built credits them in its description.
//   - a change is named a change on its card, with where it is in words.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-your-words.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const dm = require('../src/services/homeroom-bot-dm');
const live = require('../src/services/homeroom-bot-live');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const CARD = 'frontend/src/features/messages/bot-activity.tsx';

test('B4: what they asked for, as one line, cut at a word', () => {
  assert.equal(dm.askedLine('  Add a weekly\nreminder on Sunday mornings  '), 'Add a weekly reminder on Sunday mornings');
  assert.equal(dm.askedLine(''), null);
  assert.equal(dm.askedLine(null), null);
  const long = 'Could the plant list show which plants need water today, sorted by how thirsty they are, with a little drop next to each one please';
  const line = dm.askedLine(long);
  assert.ok(line.length <= 121, line);
  assert.match(line, /…$/);
  assert.ok(long.startsWith(line.slice(0, -1)), 'their words, cut, never rewritten');
  assert.doesNotMatch(line, /\s…$/, 'cut at a word, not after a space');
});

test('B4: the card leads with their words, and the project moves to the status line', () => {
  const { BotActivityCardView } = loadTsx(CARD);
  const meta = {
    kind: 'activity', appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 4, issueTitle: 'Weekly reminder',
    askedText: 'Add a weekly reminder on Sunday mornings',
  };
  const now = new Date('2026-10-02T12:00:00Z');
  const card = {
    messageId: 1, state: 'working', startedAt: '2026-10-02T11:56:00Z', links: { request: '#app/plant-pal/dev/issues/4', proposal: null },
    step: 3, of: 6, stepName: 'Build it', doing: 'building it', outcome: null, endedAt: null,
  };
  const html = renderToHtml(createElement(BotActivityCardView, { meta, card, loaded: true, now }));
  assert.match(html, /class="line-clamp-2 [^"]*" data-bot-activity-asked="">You asked: Add a weekly reminder on Sunday mornings</);
  assert.match(html, /<span>Plant Pal · <\/span><span role="status">Building it<\/span><span> · 4m so far<\/span>/);
  // A card from before, with no words of theirs, keeps the request's name.
  const before = renderToHtml(createElement(BotActivityCardView, { meta: { ...meta, askedText: undefined }, card, loaded: true, now }));
  assert.match(before, /class="truncate [^"]*">Plant Pal #4: Weekly reminder</);
  assert.doesNotMatch(before, /You asked|data-bot-activity-asked/);
  // Its words travel with the message.
  const { normalizeBotMeta } = loadTsx('frontend/src/features/messages/api.ts');
  assert.equal(normalizeBotMeta({ homeroomBot: meta }).homeroomBot.askedText, meta.askedText);
});

test('B4: a change the bot built credits who asked for it, once', () => {
  assert.equal(live.creditedDescription('Adds a reminder.', 'maya'), 'Adds a reminder.\n\nAsked for by @maya');
  assert.equal(live.creditedDescription('Adds a reminder.\n\nAsked for by @maya', 'maya'), 'Adds a reminder.\n\nAsked for by @maya');
  assert.equal(live.creditedDescription('Adds a reminder.', null), 'Adds a reminder.');
});

test('B4: a change is named a change on its card', () => {
  const src = fs.readFileSync(require.resolve('../frontend/src/features/messages/format.tsx'), 'utf8');
  assert.match(src, /proposal: 'Change',/);
});

test('B4: their words and the credit, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_words_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  const maya = await user('maya');
  const sam = await user('sam');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url) VALUES ('Plant Pal', 'plant-pal', 'running', $1,
       'https://github.com/usernode-bot/plant-pal') RETURNING id, slug, name`,
    [maya.id],
  );

  await t.test('a request she filed on the platform is recorded with the description she wrote', async () => {
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, created_by)
       VALUES ($1, 4, 'Weekly reminder', 'Add a weekly reminder on Sunday mornings', 'general', $2)`,
      [app.id, maya.id],
    );
    const original = live.issuePoster;
    live.issuePoster = async () => 'maya';
    t.after(() => { live.issuePoster = original; });
    const requester = await dm.recordRequester(pool, { app, repo: { owner: 'usernode-bot', repo: 'plant-pal' }, issueNumber: 4, issue: { title: 'Weekly reminder' } });
    assert.equal(requester.askedText, 'Add a weekly reminder on Sunday mornings');
    assert.equal((await dm.requesterOf(pool, app.id, 4)).askedText, 'Add a weekly reminder on Sunday mornings', 'and read back');
  });

  await t.test('her card carries her words', async () => {
    const opened = await require('../src/services/conversations').ensureAdmittedDirect(pool, bot.id, maya.id);
    assert.ok(opened);
    const settings = { audience: 'everyone', dmUsers: [], mode: 'live' };
    const sent = await require('../src/services/homeroom-bot-activity').startCard(pool, {
      app, issueNumber: 4, requester: await dm.requesterOf(pool, app.id, 4), bot, jobKey: 'words-1', settings,
    });
    const { rows: [msg] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [sent.messageId]);
    assert.equal(msg.metadata.homeroomBot.askedText, 'Add a weekly reminder on Sunday mornings');
  });

  await t.test('her change credits her in its description, and its author stays the bot', async () => {
    const { rows: [change] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, linked_issues)
       VALUES ($1, $2, 'bot-build-4', 'active', 'Weekly reminder', '{4}') RETURNING id`,
      [app.id, bot.id],
    );
    const out = await live.prepareProposal({
      pool, bot, sessionId: change.id, spec: null,
      buildText: 'Done.\n\n==== DESCRIPTION ====\nAdds a reminder every Sunday at 9am.\n==== END DESCRIPTION ====',
    });
    assert.match(out.description, /Asked for by @maya$/);
    const { rows: [row] } = await pool.query(
      `SELECT metadata FROM chat_session_messages WHERE session_id = $1 AND role = 'system' ORDER BY id DESC LIMIT 1`,
      [change.id],
    );
    assert.match(row.metadata.proposalDescription, /\n\nAsked for by @maya$/, 'in what the summary is built from');
    const { rows: [owner] } = await pool.query('SELECT user_id FROM chat_sessions WHERE id = $1', [change.id]);
    assert.equal(owner.user_id, bot.id);
  });

  await t.test('a change card says where it is in words, "your approval" only for the one person it is for', async () => {
    const sharedObjects = require('../src/services/shared-objects');
    const { rows: [up] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at)
       VALUES ($1, $2, 'bot-up', 'promoted', 'Weekly reminder', NOW()) RETURNING id`,
      [app.id, bot.id],
    );
    const { rows: [{ community_id: communityId }] } = await pool.query('SELECT community_id FROM apps WHERE id = $1', [app.id]);
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [communityId, maya.id]);
    const cardFor = async (viewer) => sharedObjects.hydrateLink(pool, { id: viewer.id, username: viewer.username, isAdmin: false },
      { type: 'proposal', app_slug: app.slug, session_id: up.id });
    const mine = await cardFor(maya);
    assert.equal(mine.state, 'waiting for your approval');
    assert.equal(mine.author, null, 'no "by homeroom_bot" under it');
    assert.equal((await cardFor(sam)).state, 'waiting for approval', 'somebody else reads it plainly');
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [communityId, sam.id]);
    assert.equal((await cardFor(maya)).state, 'waiting for approval', 'with others in it, it waits for theirs too');
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [up.id]);
    assert.equal((await cardFor(maya)).state, 'live');
  });
});
