'use strict';

// Activity cards for the Homeroom bot's work already under way, against the
// full PostgreSQL schema and through the real route (services/homeroom-bot-
// activity.js catchUpCards).
//
// The loop sends a card when a look starts. Work that began before cards
// existed, a restart's second look at work that had none, and a backlog
// pass that went on to build never got one: the tray showed the work and
// the transcript did not. Opening the DM now gives each piece of the
// person's work that is under way, and has no card, exactly one:
//
//   - a look being read, keyed as the loop keys its own card for that look
//     (so the two are one message), and a build already under way, whose
//     run was recorded BEFORE its card and is still the run the card reads;
//   - never a second: not on a second opening, not for the loop's own card
//     afterwards, not for a restart of a look that has a card (that card
//     follows the restarted look instead of ending at the interrupted
//     build), not for two openings at once;
//   - a backlog pass is left alone while it reads, and carded once it
//     builds; a follow-up on a proposal and a request still waiting in the
//     queue get none;
//   - the signed-in person's own work only: never somebody else's into
//     their DM, nothing for somebody the bot does not DM, nothing on a
//     project they cannot view or the bot does not act on, nothing while the
//     bot is off;
//   - the staging demo's stand-in, in the viewer's own fixture only.
//
// tests/homeroom-bot-activity.test.js pins the pure rules and the client.
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const events = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds, payload) { events.push({ memberIds: [...memberIds], payload }); return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

let routePool = null;
const poolMod = require('../src/db/pool');
poolMod.getPool = () => routePool;

const activity = require('../src/services/homeroom-bot-activity');
const homeroomBot = require('../src/services/homeroom-bot');
const conversations = require('../src/services/conversations');
const { conversationRoutes } = require('../src/routes/conversations');

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `hrbot_catch_up_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

test('the Homeroom bot DM gives work already under way its activity card: once, the viewer\'s own, read from when it began', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  routePool = pool;

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  async function setting(key, value) {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
  async function project(slug, owner, { visibility = 'public' } = {}) {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, $5, $5) RETURNING id`,
      [slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), slug, owner.id,
        `https://github.com/usernode-bot/${slug}`, visibility],
    );
    const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
    return app;
  }

  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  const lee = await user('lee');
  const seeds = await project('seed-swap', ada);
  const samsApp = await project('sam-shop', sam);
  const hidden = await project('hidden-lab', sam, { visibility: 'private' });
  const notLive = await project('quiet-notes', ada);
  await setting('homeroom_bot_mode', 'shadow');
  await setting('homeroom_bot_dm_users', JSON.stringify([ada.username, sam.username]));
  await setting('homeroom_bot_live_apps', JSON.stringify(['seed-swap', 'sam-shop', 'hidden-lab']));
  let settings = await homeroomBot.readSettings(pool);

  async function requested(app, issueNumber, who, title) {
    await pool.query(
      'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, $4)',
      [app.id, issueNumber, who.id, title],
    );
  }
  /** A queue row: claimed `minutesAgo` minutes ago, or waiting (null). */
  async function queued(app, issueNumber, { reason = 'new', minutesAgo = 0 } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at)
       VALUES ($1, $2, 1, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() - make_interval(mins => $4::int) END)
       RETURNING id, started_at`,
      [app.id, issueNumber, reason, minutesAgo],
    );
    return row;
  }
  const dequeue = (app, issueNumber) => pool.query(
    'DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2', [app.id, issueNumber],
  );
  async function buildSession(app, status = 'active') {
    const { rows: [row] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title)
       VALUES ($1, $2, $3, $4, 'A build') RETURNING id`,
      [app.id, bot.id, `bot-build-${++seq}`, status],
    );
    return row.id;
  }
  /** A live run, `minutesAgo` minutes ago, its look having taken `durationMs`. */
  async function run(app, issueNumber, { verdict = 'ready', buildSessionId = null, minutesAgo = 0, durationMs = null } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id, duration_ms, created_at)
       VALUES ($1, $2, 'live', $3, $4, $5, NOW() - make_interval(mins => $6::int))
       RETURNING id, created_at`,
      [app.id, issueNumber, verdict, buildSessionId, durationMs, minutesAgo],
    );
    return row;
  }
  const asAda = { id: ada.id, username: ada.username, isAdmin: false };
  const asSam = { id: sam.id, username: sam.username, isAdmin: false };
  const asLee = { id: lee.id, username: lee.username, isAdmin: false };
  const catchUp = (who) => activity.catchUpCards(pool, { user: who, settings });
  /** The bot's activity cards in `who`'s DM with it, oldest first. */
  async function cardMessages(who) {
    const { rows } = await pool.query(
      `SELECT m.id, m.idempotency_key, m.content, m.metadata, m.created_at, m.conversation_id
         FROM conversation_messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
         JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
        WHERE m.sender_id = $2 AND m.metadata->'homeroomBot'->>'kind' = 'activity'
        ORDER BY m.id`,
      [who.id, bot.id],
    );
    return rows;
  }
  const cardOf = async (who, messageId) => (await activity.cardsFor(pool, { user: who, settings })).cards
    .find((card) => card.messageId === messageId);

  await requested(seeds, 3, ada, 'Sort by date');
  await requested(seeds, 4, ada, 'Dark mode');
  await requested(seeds, 5, ada, 'Export');
  await requested(seeds, 6, ada, 'Search');
  await requested(seeds, 7, ada, 'Tags');
  await requested(seeds, 8, ada, 'Undo');
  await requested(seeds, 9, ada, 'Print');
  await requested(seeds, 10, lee, 'Lee\'s idea');
  await requested(seeds, 11, ada, 'Share');
  await requested(samsApp, 9, sam, 'Sam\'s secret');
  await requested(hidden, 2, ada, 'Hidden thing');
  await requested(notLive, 1, ada, 'Quiet one');

  let reading;
  await t.test('a look being read without a card gets one, keyed as the loop keys its own; a second opening adds none, nor the loop\'s card after', async () => {
    reading = await queued(seeds, 3, { minutesAgo: 20 });
    const from = events.length;
    assert.deepEqual(await catchUp(asAda), { added: 1 });
    const [message] = await cardMessages(ada);
    assert.equal(message.idempotency_key, `hrbot-activity-${reading.id}`);
    assert.equal(message.content, '**Seed swap** · request #3: Sort by date\n\n'
      + 'I started on this earlier and I\'m still working on it. This card updates as I go.');
    assert.equal(message.metadata.homeroomBot.kind, 'activity');
    assert.equal(message.metadata.homeroomBot.startedAt, reading.started_at.toISOString(), 'it carries when the look began');
    assert.ok(events.slice(from).some((e) => e.payload.type === 'conversation_message_created'
      && e.payload.messageId === message.id && e.memberIds.includes(ada.id)), 'it reaches their open DM at once');
    const { rows: recorded } = await pool.query(
      'SELECT kind, app_id, issue_number FROM homeroom_bot_dm_messages WHERE message_id = $1', [message.id],
    );
    assert.deepEqual(recorded, [{ kind: 'activity', app_id: seeds.id, issue_number: 3 }], 'recorded as the bot\'s news about the request');

    const card = await cardOf(asAda, message.id);
    assert.deepEqual([card.state, card.stage, card.step, card.stepName], ['working', 'reading', 1, 'Read the request']);
    assert.equal(card.startedAt, reading.started_at.toISOString(), 'from when the look began, before the card');

    assert.deepEqual(await catchUp(asAda), { added: 0 }, 'a second opening adds none');
    const loop = await activity.startCard(pool, {
      app: seeds, issueNumber: 3, requester: { userId: ada.id, username: ada.username, issueTitle: 'Sort by date' },
      bot, jobKey: reading.id, settings,
    });
    assert.equal(loop.messageId, message.id, 'the loop\'s own card for the look is the same message');
    assert.equal(loop.duplicate, true);
    assert.equal((await cardMessages(ada)).length, 1);
  });

  await t.test('a build already under way, its run recorded before its card, gets one card that reads that run to its end', async () => {
    await dequeue(seeds, 3);
    const session = await buildSession(seeds);
    // Read 12 minutes ago, after a look of 5: before any card existed.
    const ready = await run(seeds, 4, { buildSessionId: session, minutesAgo: 12, durationMs: 5 * 60 * 1000 });
    assert.deepEqual(await catchUp(asAda), { added: 1 }, 'the build on #4 (the look on #3 still has its card)');
    const message = (await cardMessages(ada)).at(-1);
    assert.equal(message.idempotency_key, `hrbot-activity-run-${ready.id}`);
    assert.ok(ready.created_at < message.created_at, 'its run predates the card');
    const began = new Date(ready.created_at.getTime() - 5 * 60 * 1000).toISOString();
    assert.equal(message.metadata.homeroomBot.startedAt, began, 'when its look began');

    let card = await cardOf(asAda, message.id);
    assert.deepEqual([card.state, card.stage, card.step, card.stepName], ['working', 'planning', 2, 'Write a plan']);
    assert.equal(card.startedAt, began);
    await pool.query(`INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind) VALUES ($1, 4, $2, 'spec')`, [seeds.id, ready.id]);
    card = await cardOf(asAda, message.id);
    assert.deepEqual([card.state, card.stage, card.step], ['working', 'building', 3]);

    // The run it joined ends in a proposal: that is what the card came to.
    await pool.query(`UPDATE chat_sessions SET status = 'promoted', promoted_at = NOW() WHERE id = $1`, [session]);
    await pool.query('UPDATE homeroom_bot_runs SET build_ok = TRUE, proposal_session_id = $2 WHERE id = $1', [ready.id, session]);
    card = await cardOf(asAda, message.id);
    assert.equal(card.state, 'done');
    assert.equal(card.outcome, 'proposed');
    assert.equal(card.links.proposal, `#app/seed-swap/dev/proposals/${session}`);
    assert.deepEqual(await catchUp(asAda), { added: 0 }, 'a proposal up for a vote is not work under way');
  });

  await t.test('a restart of a look with a card gets no second, and its card follows the restarted look, not the interrupted build', async () => {
    const first = await queued(seeds, 5);
    const sent = await activity.startCard(pool, {
      app: seeds, issueNumber: 5, requester: { userId: ada.id, username: ada.username, issueTitle: 'Export' },
      bot, jobKey: first.id, settings,
    });
    await dequeue(seeds, 5);
    const session = await buildSession(seeds);
    const interrupted = await run(seeds, 5, { buildSessionId: session });
    assert.equal((await cardOf(asAda, sent.messageId)).stage, 'planning');

    // The platform restarts mid-build: recovery records the build as
    // interrupted and sends the issue back (homeroom-bot.js
    // completeRecoveredLive, requeueForRestart). Its queue row was gone, so
    // the look that takes it up again is a new row, with a new id.
    await pool.query(
      `UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = $2 WHERE id = $1`,
      [interrupted.id, `interrupted: the worker is gone ${homeroomBot.RESTARTED_BUILD_NOTE}`],
    );
    await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [session]);
    const again = await queued(seeds, 5, { reason: homeroomBot.RESTART_REASON });
    assert.notEqual(again.id, first.id, 'a restart\'s re-queue is a new queue row when the old one is gone');

    const before = (await cardMessages(ada)).length;
    assert.deepEqual(await catchUp(asAda), { added: 0 }, 'its card already follows it');
    assert.equal((await cardMessages(ada)).length, before);
    let card = await cardOf(asAda, sent.messageId);
    assert.deepEqual([card.state, card.stage], ['working', 'reading'], 'not "couldn\'t finish building it"');

    // The restarted look builds, and that is what the card follows to its end.
    await dequeue(seeds, 5);
    const rebuilt = await run(seeds, 5, { buildSessionId: await buildSession(seeds) });
    card = await cardOf(asAda, sent.messageId);
    assert.deepEqual([card.state, card.stage], ['working', 'planning']);
    await pool.query(`UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = 'the build ran past its time limit' WHERE id = $1`, [rebuilt.id]);
    card = await cardOf(asAda, sent.messageId);
    assert.deepEqual([card.state, card.outcome], ['done', 'build_failed'], 'a build that really failed still ends it');
    assert.deepEqual(await catchUp(asAda), { added: 0 });
  });

  await t.test('a look the platform restarted on work that never had a card gets exactly one', async () => {
    const session = await buildSession(seeds, 'archived');
    const lost = await run(seeds, 6, { buildSessionId: session, minutesAgo: 120 });
    await pool.query(
      `UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = $2 WHERE id = $1`,
      [lost.id, `interrupted: the worker is gone ${homeroomBot.RESTARTED_BUILD_NOTE}`],
    );
    const restarted = await queued(seeds, 6, { reason: homeroomBot.RESTART_REASON, minutesAgo: 3 });
    assert.deepEqual(await catchUp(asAda), { added: 1 });
    const message = (await cardMessages(ada)).at(-1);
    assert.equal(message.idempotency_key, `hrbot-activity-${restarted.id}`);
    assert.equal(message.metadata.homeroomBot.issueNumber, 6);
    assert.deepEqual(await catchUp(asAda), { added: 0 });
    await dequeue(seeds, 6);
    await run(seeds, 6, { buildSessionId: await buildSession(seeds) });
    assert.deepEqual(await catchUp(asAda), { added: 0 }, 'its plan is the same piece of work');
    const card = await cardOf(asAda, message.id);
    assert.deepEqual([card.state, card.stage], ['working', 'planning']);
  });

  await t.test('a backlog pass is left alone while it reads and gets its card once it builds; a follow-up and a request still waiting get none', async () => {
    const before = (await cardMessages(ada)).length;
    await queued(seeds, 7, { reason: homeroomBot.APP_AGAIN_REASON });
    assert.deepEqual(await catchUp(asAda), { added: 0 }, 'a backlog pass says nothing while it reads');
    await dequeue(seeds, 7);
    const ready = await run(seeds, 7, { buildSessionId: await buildSession(seeds) });
    assert.deepEqual(await catchUp(asAda), { added: 1 }, 'building it is work under way');
    assert.equal((await cardMessages(ada)).at(-1).idempotency_key, `hrbot-activity-run-${ready.id}`);

    // #8: a follow-up on its proposal, up for a vote. #9: waiting in the queue.
    const proposal = await buildSession(seeds, 'promoted');
    const proposed = await run(seeds, 8, { buildSessionId: proposal, minutesAgo: 60 });
    await pool.query('UPDATE homeroom_bot_runs SET build_ok = TRUE, proposal_session_id = $2 WHERE id = $1', [proposed.id, proposal]);
    await queued(seeds, 8, { reason: 'changed' });
    await queued(seeds, 9, { minutesAgo: null });
    assert.deepEqual(await catchUp(asAda), { added: 0 });
    assert.equal((await cardMessages(ada)).length, before + 1);
  });

  await t.test('never somebody else\'s work, nothing for somebody the bot does not DM, nor on a project they cannot view or the bot does not act on', async () => {
    await queued(samsApp, 9);
    await queued(seeds, 10);
    await queued(hidden, 2);
    await queued(notLive, 1);
    const adas = (await cardMessages(ada)).length;
    assert.deepEqual(await catchUp(asAda), { added: 0 }, 'sam\'s and lee\'s work is not hers; she cannot view hidden-lab; quiet-notes is not live');
    assert.equal((await cardMessages(ada)).length, adas);
    assert.deepEqual(await cardMessages(sam), [], 'ada opening her DM sends sam nothing');
    assert.deepEqual(await catchUp(asLee), { added: 0 }, 'lee is not somebody the bot talks to in a DM');
    assert.deepEqual(await cardMessages(lee), []);

    assert.deepEqual(await catchUp(asSam), { added: 1 }, 'sam\'s own');
    const [samsCard] = await cardMessages(sam);
    assert.equal(samsCard.metadata.homeroomBot.appSlug, 'sam-shop');
    assert.equal((await cardMessages(ada)).length, adas, 'and nothing of his reaches her');

    // The only thing between her and the hidden project's card was viewing it.
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [hidden.id, ada.id]);
    assert.deepEqual(await catchUp(asAda), { added: 1 });
    assert.equal((await cardMessages(ada)).at(-1).metadata.homeroomBot.appSlug, 'hidden-lab');
    for (const app of [samsApp, hidden, notLive]) await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
    await dequeue(seeds, 10);
  });

  await t.test('B4: work under way on a request whose card ended carries on in that card, with no second', async () => {
    await requested(seeds, 12, ada, 'Rename notes');
    await queued(seeds, 12, { minutesAgo: 30 });
    assert.deepEqual(await catchUp(asAda), { added: 1 });
    const message = (await cardMessages(ada)).at(-1);
    await dequeue(seeds, 12);
    await run(seeds, 12, { verdict: 'question', minutesAgo: 20 });
    assert.equal((await cardOf(asAda, message.id)).outcome, 'question');

    // Answered, and read again: the same card follows it, from then.
    const count = (await cardMessages(ada)).length;
    const again = await queued(seeds, 12, { minutesAgo: 5 });
    assert.deepEqual(await catchUp(asAda), { added: 0 }, 'no second card');
    assert.equal((await cardMessages(ada)).length, count);
    const card = await cardOf(asAda, message.id);
    assert.deepEqual([card.state, card.stage], ['working', 'reading']);
    const { rows: [stored] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [message.id]);
    assert.equal(stored.metadata.homeroomBot.lookAt, again.started_at.toISOString(), 'read from when this look began');
    await dequeue(seeds, 12);
  });

  await t.test('two openings at once send one card, and the bot switched off has nothing under way', async () => {
    const before = (await cardMessages(ada)).length;
    const share = await queued(seeds, 11);
    const both = await Promise.all([catchUp(asAda), catchUp(asAda), catchUp(asAda)]);
    assert.equal(both.reduce((sum, r) => sum + r.added, 0), 1);
    const added = (await cardMessages(ada)).slice(before);
    assert.deepEqual(added.map((m) => m.idempotency_key), [`hrbot-activity-${share.id}`]);
    await dequeue(seeds, 11);

    await setting('homeroom_bot_mode', 'off');
    settings = await homeroomBot.readSettings(pool);
    await dequeue(seeds, 9);
    await queued(seeds, 9, { minutesAgo: 1 });
    assert.deepEqual(await catchUp(asAda), { added: 0 });
    await setting('homeroom_bot_mode', 'shadow');
    settings = await homeroomBot.readSettings(pool);
    await dequeue(seeds, 9);
  });

  await t.test('the route catches up for the signed-in person only, whatever it is asked, and from the page only', async () => {
    const app = express();
    app.use(express.json());
    let actor = asAda;
    app.use((req, _res, next) => { req.user = actor; next(); });
    app.use(conversationRoutes({}, { pool }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (as, url, { headers = {}, body = '{}' } = {}) => {
      actor = as;
      const res = await fetch(`${base}${url}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers }, body,
      });
      return { status: res.status, body: await res.json(), headers: res.headers };
    };

    // Sam has new work under way; ada asks, naming him every way she can.
    await queued(samsApp, 12);
    await requested(samsApp, 12, sam, 'Sam again');
    const adas = (await cardMessages(ada)).length;
    for (const query of [`?user_id=${sam.id}`, `?userId=${sam.id}`, `?username=${sam.username}`]) {
      const asked = await post(asAda, `/api/conversations/homeroom-bot/activity${query}`,
        { body: JSON.stringify({ userId: sam.id, user_id: sam.id, username: sam.username }) });
      assert.equal(asked.status, 200, query);
      assert.deepEqual(asked.body, { added: 0 }, query);
      assert.equal(asked.headers.get('cache-control'), 'private, no-store');
    }
    assert.equal((await cardMessages(ada)).length, adas);
    assert.equal((await cardMessages(sam)).length, 1, 'nothing reached sam from her asking');

    const refused = await post(asSam, '/api/conversations/homeroom-bot/activity', { headers: { 'Sec-Fetch-Site': 'same-site' } });
    assert.equal(refused.status, 403, 'a page on a sibling subdomain cannot make it send');
    const his = await post(asSam, '/api/conversations/homeroom-bot/activity');
    assert.deepEqual(his.body, { added: 1 });
    assert.equal((await cardMessages(sam)).length, 2);
    // Off staging, `?demo=1` is the real answer too.
    assert.deepEqual((await post(asSam, '/api/conversations/homeroom-bot/activity?demo=1')).body, { added: 0 });
    // The read stays a read.
    actor = asAda;
    const read = await fetch(`${base}/api/conversations/homeroom-bot/activity`);
    assert.equal(read.status, 200);
    assert.ok(Array.isArray((await read.json()).cards));
  });

  await t.test('a staging preview: catching up for real does nothing, and opening the demo DM gives its work under way a card, once, in the viewer\'s own fixture', async () => {
    const staging = require('../src/services/staging-messages');
    const env = process.env.USERNODE_ENV;
    process.env.USERNODE_ENV = 'staging';
    try {
      await queued(seeds, 9, { minutesAgo: 1 });
      assert.deepEqual(await catchUp(asAda), { added: 0 }, 'a staging copy never acts, so nothing of it is under way');
      await dequeue(seeds, 9);

      const viewer = await user('viewer');
      const other = await user('other');
      assert.deepEqual(await staging.ensureDemoUnderWayCard(pool, viewer), { added: 0 }, 'no fixture yet, nothing to add to');
      const conversationId = await staging.ensureBotDmFixture(pool, viewer);
      assert.deepEqual(await staging.ensureDemoUnderWayCard(pool, viewer), { added: 1 });
      assert.deepEqual(await staging.ensureDemoUnderWayCard(pool, viewer), { added: 0 }, 'once');
      await staging.ensureBotDmFixture(pool, viewer);
      const page = await conversations.listMessages(pool, viewer, conversationId, {});
      const messages = [...(page.messages || page)].sort((a, b) => a.id - b.id);
      const cards = messages.filter((m) => m.metadata?.homeroomBot?.kind === 'activity');
      assert.deepEqual(cards.map((m) => m.metadata.homeroomBot.issueNumber), [9, 14, 15], 'the new card is the newest');
      const joined = cards[2];
      assert.equal(messages.at(-1).id, joined.id, 'at the end of the DM');
      assert.match(joined.content, /^\*\*Staging demo app\*\* · request #15: Staging demo, add a search box\n\nI started on this earlier/);
      const demo = await activity.demoCards(pool, viewer);
      const state = demo.cards.find((c) => c.messageId === joined.id);
      assert.deepEqual([state.state, state.step, state.of, state.stepName], ['working', 2, 6, 'Write a plan']);
      assert.ok(Date.parse(state.startedAt) < Date.parse(joined.createdAt || joined.created_at), 'it began before its card');
      const { rows } = await pool.query('SELECT 1 FROM homeroom_bot_dm_messages WHERE user_id = $1', [viewer.id]);
      assert.equal(rows.length, 0, 'a demo card stands for no request: nothing is recorded or posted');
      assert.deepEqual(await staging.ensureDemoUnderWayCard(pool, other), { added: 0 }, 'another viewer has no fixture of theirs');
      assert.ok(!(await activity.demoCards(pool, other)).cards.length);
    } finally {
      if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
    }
  });
});
