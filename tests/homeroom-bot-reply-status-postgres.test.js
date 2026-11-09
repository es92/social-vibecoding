'use strict';

// #6538: the bot's status line outside a request, against the full schema:
// a change's discussion, a channel and a reply thread read their newest
// person's message, the place's voice turns and the bot's answer from real
// rows, and publish the place it found.
//
// Run with: node --test tests/homeroom-bot-reply-status-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('#6538: a change, a channel and a reply thread read their own place', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `bot_reply_status_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  const replyStatus = require('../src/services/homeroom-bot-reply-status');
  const { rows: [person] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('evan', 'x') RETURNING id",
  );
  const { rows: [bot] } = await pool.query(
    "INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id",
  );
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status) VALUES ('t', $1, 'ready') RETURNING id",
    [`t-${crypto.randomBytes(4).toString('hex')}`],
  );
  const say = async ({ userId, content, type, ref, minutesAgo = 0 }) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
       VALUES ($1, $2, $3, 'message', $4::varchar, $5::integer, NOW() - ($6 || ' minutes')::interval) RETURNING id`,
      [app.id, userId, content, type, ref, String(minutesAgo)],
    );
    return Number(row.id);
  };
  const frames = [];
  const deps = { ws: { broadcast: (appId, data) => frames.push([appId, data]) } };

  // ── A change's discussion ──────────────────────────────────────────────
  const ask = await say({ userId: person.id, content: '@Homeroom bot why did the checks fail?', type: 'session', ref: 9 });
  // An unrelated change's message is never this place's.
  await say({ userId: person.id, content: 'looks good', type: 'session', ref: 10 });
  const place = { type: 'session', ref: 9 };
  let read = await replyStatus.readStatus(pool, { appId: app.id, place });
  assert.deepEqual(read, { status: null, replyId: ask, authorId: Number(person.id) });

  const out = await replyStatus.publish(pool, {
    appId: app.id, place, voiceOwed: true, answerable: true, deps,
  });
  assert.equal(out, 'will_read');
  assert.deepEqual(frames.at(-1), [app.id, {
    type: 'bot_status', thread: { type: 'session', ref: 9 }, status: 'will_read', authorId: Number(person.id), replyId: ask,
  }]);

  // A turn running since the message: reading, only because it is answering.
  await pool.query(
    `INSERT INTO homeroom_bot_voice_turns (app_id, place_type, place_ref, place_key, speaker_id, through_message_id)
     VALUES ($1, 'session', 9, $2, $3, $4)`,
    [app.id, `${app.id}:session:9`, person.id, ask],
  );
  read = await replyStatus.readStatus(pool, { appId: app.id, place });
  assert.equal(read.status, 'reading');
  read = await replyStatus.readStatus(pool, { appId: app.id, place, answerable: false });
  assert.equal(read.status, null, 'an ordinary message never lights the line');

  // The bot's answer in the change ends the line.
  await say({ userId: bot.id, content: 'The third check timed out.', type: 'session', ref: 9 });
  read = await replyStatus.readStatus(pool, { appId: app.id, place });
  assert.equal(read.status, null);

  // ── A channel: its answer lands in the reply thread under the message ──
  const channelMessage = await say({ userId: person.id, content: '@Homeroom bot what changed this week?', type: null, ref: null });
  const chatPlace = { type: 'chat', ref: null };
  read = await replyStatus.readStatus(pool, { appId: app.id, place: chatPlace });
  assert.deepEqual(read, { status: null, replyId: channelMessage, authorId: Number(person.id) });
  await replyStatus.publish(pool, { appId: app.id, place: chatPlace, voiceOwed: true, answerable: true, deps });
  assert.deepEqual(frames.at(-1), [app.id, {
    type: 'bot_status', thread: { type: 'chat', ref: null }, status: 'will_read', authorId: Number(person.id), replyId: channelMessage,
  }]);
  await say({ userId: bot.id, content: 'Three changes this week.', type: 'message', ref: channelMessage });
  read = await replyStatus.readStatus(pool, { appId: app.id, place: chatPlace });
  assert.equal(read.status, null, 'the answer in the reply thread is the channel\'s answer');

  // ── A reply thread reads its own messages ──────────────────────────────
  const reply = await say({ userId: person.id, content: '@Homeroom bot and this one?', type: 'message', ref: channelMessage });
  read = await replyStatus.readStatus(pool, { appId: app.id, place: { type: 'message', ref: channelMessage } });
  assert.deepEqual(read, { status: null, replyId: reply, authorId: Number(person.id) });
});
