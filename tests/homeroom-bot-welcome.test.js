'use strict';

// The Homeroom bot's one welcome, when it went on for everyone
// (services/homeroom-bot-welcome.js):
//
//   - the words say what it does and where to start, plainly, with
//     questions to tap;
//   - it reaches everybody who had an account then and may use the
//     platform, once, as their one hello, and nobody the bot already met;
//   - it waits while the bot is Off, never runs on a staging copy, goes a
//     batch at a time, and stops for good once nobody is left;
//   - a send that fails gives the claim back, so the next pass tries again.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-welcome.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const welcome = require('../src/services/homeroom-bot-welcome');

test('the welcome says what the bot does and where to start, in plain words', () => {
  assert.match(welcome.WELCOME_TEXT, /^Hi, I'm Homeroom bot, the AI that builds things on Homeroom\. As of today I work for everyone\./);
  assert.match(welcome.WELCOME_TEXT, /\n\nWant to make something new\? Tap New project on your Home screen, say what it should do, and I'll build a first version you can try\.\n\n/);
  assert.match(read('frontend/src/features/home/create-tile.tsx'), /export const CREATE_TILE_LABEL = 'New project';/,
    'the tile it names is called that');
  assert.match(welcome.WELCOME_TEXT, /Post a request on it, or tap Suggest an improvement on its page/);
  assert.match(welcome.WELCOME_TEXT, /I'll ask here, with answers you can tap\.$/);
  assert.ok(welcome.WELCOME_PROMPTS.length <= 3, 'at most three questions to tap');
  for (const text of [welcome.WELCOME_TEXT, ...welcome.WELCOME_PROMPTS]) assert.doesNotMatch(text, /—|homeroom_bot/);
});

test('the leader starts it beside the other welcome, and stops it on the way down', () => {
  const server = read('server.js');
  assert.match(server, /require\('\.\/src\/services\/welcome-dm'\)\.start\(config\);[\s\S]{0,400}require\('\.\/src\/services\/homeroom-bot-welcome'\)\.start\(config\);/);
  assert.match(server, /require\('\.\/src\/services\/homeroom-bot-welcome'\)\.stop\(\)/);
  assert.match(read('src/db/schema.sql'), /CHECK \(kind IN \('maker', 'member', 'joiner', 'welcome', 'tour', 'known'\)\)/);
});

test('the welcome, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_welcome_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const staging = process.env.USERNODE_ENV;
  t.after(async () => {
    if (staging === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = staging;
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  delete process.env.USERNODE_ENV;
  const schema = read('src/db/schema.sql');
  await pool.query(schema);
  const conversations = require('../src/services/conversations');
  const dm = require('../src/services/homeroom-bot-dm');
  const user = async (username, extra = {}) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic, test_account_created_at, created_at)
     VALUES ($1, 'x', $2, $3, $4, $5) RETURNING id, username`,
    [username, extra.access !== false, !!extra.synthetic, extra.test ? new Date() : null, extra.createdAt || new Date(Date.now() - 86_400_000)],
  )).rows[0];
  const setMode = (mode) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [mode],
  );
  const welcomed = async (id) => (await pool.query(
    `SELECT m.content, m.metadata FROM conversation_messages m
       JOIN homeroom_bot_hellos h ON h.message_id = m.id
      WHERE h.user_id = $1 AND h.kind = 'welcome'`, [id],
  )).rows;

  const bot = await user('homeroom_bot', { synthetic: true });
  const maya = await user('maya');
  const ben = await user('ben');
  const old = await user('old_friend');
  const waiting = await user('waiting_room', { access: false });
  const tester = await user('tester_1', { test: true });
  const capture = await user('capture_1', { synthetic: true });
  // Met the bot already: it wrote to old_friend before this.
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, old.id);
  await conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, { content: 'Your change is live now.' });
  // Made after the bot went on for everyone: met through its other hellos.
  const since = (await pool.query("SELECT value FROM platform_settings WHERE key = 'homeroom_bot_audience_since'")).rows[0].value;
  assert.ok(Number.isFinite(Date.parse(since)), 'schema.sql wrote the moment once');
  const late = await user('late_comer', { createdAt: new Date(Date.parse(since) + 60_000) });

  await t.test('nothing goes while the bot is Off, or on a staging copy', async () => {
    await setMode('off');
    assert.equal((await welcome.sweep(pool)).off, true);
    await setMode('shadow');
    process.env.USERNODE_ENV = 'staging';
    assert.equal((await welcome.sweep(pool)).staging, true);
    delete process.env.USERNODE_ENV;
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_hellos');
    assert.equal(rows[0].n, 0);
  });

  await t.test('a batch at a time, to the people who may use the platform and have not met the bot', async () => {
    const first = await welcome.sweep(pool, { batchSize: 1 });
    assert.equal(first.sent, 1, 'one person in a batch of one');
    const rest = await welcome.sweep(pool);
    assert.equal(first.sent + rest.sent, 2, 'maya and ben');
    assert.equal(rest.skipped, 1, 'old_friend: the bot already wrote to them');
    for (const person of [maya, ben]) {
      const [msg] = await welcomed(person.id);
      assert.equal(msg.content, welcome.WELCOME_TEXT);
      const meta = msg.metadata.homeroomBot;
      assert.equal(meta.kind, 'hello_welcome');
      assert.equal(meta.status, 'open');
      assert.deepEqual(meta.actions.map((a) => [a.type, a.label]), welcome.WELCOME_PROMPTS.map((label) => ['prompt', label]));
    }
    const { rows: [known] } = await pool.query('SELECT kind FROM homeroom_bot_hellos WHERE user_id = $1', [old.id]);
    assert.equal(known.kind, 'known', 'recorded as met, never greeted');
    for (const person of [waiting, tester, capture, late]) {
      assert.deepEqual(await welcomed(person.id), [], `${person.username} is not welcomed`);
    }
    const { rows: rung } = await pool.query(
      "SELECT 1 FROM notifications WHERE user_id = ANY($1::int[])", [[maya.id, ben.id]],
    );
    assert.equal(rung.length, 0, 'quiet: it waits unread and rings nothing');
  });

  await t.test('it is their one hello: no maker hello follows it', async () => {
    assert.equal(await dm.claimHello(pool, { userId: maya.id, botId: bot.id, kind: 'maker' }), false);
  });

  await t.test('once nobody is left it stops for good', async () => {
    const last = await welcome.sweep(pool);
    assert.equal(last.done, true);
    const { rows } = await pool.query('SELECT 1 FROM platform_settings WHERE key = $1', [welcome.KEY_DONE]);
    assert.equal(rows.length, 1);
    await pool.query('DELETE FROM homeroom_bot_hellos WHERE user_id = $1', [ben.id]);
    assert.equal((await welcome.sweep(pool)).done, true, 'and never runs again, whoever is left');
    await pool.query('DELETE FROM platform_settings WHERE key = $1', [welcome.KEY_DONE]);
  });

  await t.test('a send that throws gives the claim back for the next pass', async () => {
    const zoe = await user('zoe');
    const sendDm = dm.sendDm;
    dm.sendDm = async () => { throw new Error('database went away'); };
    try {
      await assert.rejects(welcome.welcomeOne(pool, { userId: zoe.id, bot }), /database went away/);
    } finally {
      dm.sendDm = sendDm;
    }
    const { rows } = await pool.query('SELECT 1 FROM homeroom_bot_hellos WHERE user_id = $1', [zoe.id]);
    assert.equal(rows.length, 0, 'the claim is given back');
    assert.equal(await welcome.welcomeOne(pool, { userId: zoe.id, bot }), 'sent', 'and the next pass welcomes her');
    assert.equal(await welcome.welcomeOne(pool, { userId: zoe.id, bot }), 'skipped', 'once');
    assert.equal((await welcomed(zoe.id)).length, 1);
  });
});
