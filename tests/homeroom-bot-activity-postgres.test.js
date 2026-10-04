'use strict';

// #3736: activity cards in the Homeroom bot's DM, against the full
// PostgreSQL schema and through the real route.
//
//   - LIFECYCLE: starting work sends the requester one card in their DM with
//     the bot (live, to their sockets), and that card then reads its state
//     from the bot's records as they move: reading the request, writing the
//     plan, building it, and ended in a proposal up for a vote (then live).
//     The next look at the same request is a card of its own; the one before
//     it keeps what it came to.
//   - SCOPING: the signed-in person's cards and nobody else's, whatever the
//     request asks for, and never one on an app they can no longer view.
//   - the staging demo's two cards, in the viewer's own fixture only.
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
  const name = `hrbot_activity_${crypto.randomBytes(6).toString('hex')}`;
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

test('the Homeroom bot DM\'s activity cards: one per piece of work, read from its records, the viewer\'s own', { timeout: 120000 }, async (t) => {
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
  await setting('homeroom_bot_mode', 'shadow');
  await setting('homeroom_bot_dm_users', JSON.stringify([ada.username, sam.username]));
  await setting('homeroom_bot_live_apps', JSON.stringify(['seed-swap', 'sam-shop', 'hidden-lab']));
  const settings = await homeroomBot.readSettings(pool);

  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES
       ($1, 3, $4, 'Sort by date'), ($1, 4, $4, 'Dark mode'), ($1, 5, $4, 'Export'),
       ($2, 9, $5, 'Sam''s secret'), ($3, 2, $4, 'Hidden thing'), ($1, 6, $6, 'Lee''s idea')`,
    [seeds.id, samsApp.id, hidden.id, ada.id, sam.id, lee.id],
  );
  const requester = (who, title) => ({ userId: who.id, username: who.username, issueTitle: title, firstVersion: false });
  async function claim(app, issueNumber) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at)
       VALUES ($1, $2, 1, 'new', NOW()) RETURNING id`,
      [app.id, issueNumber],
    );
    return row.id;
  }
  async function run(app, issueNumber, fields) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id)
       VALUES ($1, $2, 'live', $3, $4) RETURNING id`,
      [app.id, issueNumber, fields.verdict, fields.buildSessionId || null],
    );
    return row.id;
  }
  const asAda = { id: ada.id, username: ada.username, isAdmin: false };
  const asSam = { id: sam.id, username: sam.username, isAdmin: false };
  const cardsOf = async (who) => (await activity.cardsFor(pool, { user: who, settings })).cards;
  const byId = async (who, id) => (await cardsOf(who)).find((card) => card.messageId === id);

  let first;
  await t.test('starting work sends the requester one card, live, quoting nothing they did not start here', async () => {
    const job = await claim(seeds, 3);
    const from = events.length;
    first = await activity.startCard(pool, {
      app: seeds, issueNumber: 3, requester: requester(ada, 'Sort by date'), bot, jobKey: job, settings,
    });
    assert.ok(first?.messageId, 'sent');
    const message = await conversations.getMessage(pool, asAda, first.conversationId, first.messageId);
    assert.equal(message.sender.id, bot.id);
    assert.deepEqual(message.metadata.homeroomBot, {
      kind: 'activity', appSlug: 'seed-swap', appName: 'Seed swap', issueNumber: 3, issueTitle: 'Sort by date',
    });
    assert.match(message.content, /^\*\*Seed swap\*\* · request #3: Sort by date\n\nI'm working on this now\./);
    assert.equal(message.reply, null);
    assert.ok(events.slice(from).some((e) => e.payload.type === 'conversation_message_created'
      && e.payload.messageId === first.messageId && e.memberIds.includes(ada.id)), 'it reaches their open DM at once');

    const again = await activity.startCard(pool, {
      app: seeds, issueNumber: 3, requester: requester(ada, 'Sort by date'), bot, jobKey: job, settings,
    });
    assert.equal(again.messageId, first.messageId, 'the same piece of work started again keeps its card');
    assert.equal(again.duplicate, true);
    const { rows } = await pool.query(`SELECT kind FROM homeroom_bot_dm_messages WHERE user_id = $1`, [ada.id]);
    assert.deepEqual(rows.map((r) => r.kind), ['activity'], 'recorded once, as the bot\'s news about the request');
  });

  await t.test('the card moves through the steps as the records do, and ends in the proposal', async () => {
    let card = await byId(asAda, first.messageId);
    assert.equal(card.state, 'working');
    assert.deepEqual([card.stage, card.step, card.of, card.stepName], ['reading', 1, 6, 'Read the request']);
    assert.match(card.doing, /^reading the request/);
    assert.equal(card.links.request, '#app/seed-swap/dev/issues/3');
    assert.ok(Date.parse(card.startedAt) <= Date.now());

    // Read: the queue row goes and the run says build it, in its session.
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 3', [seeds.id]);
    const { rows: [build] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title)
       VALUES ($1, $2, 'bot-build', 'active', 'Sort by date') RETURNING id`,
      [seeds.id, bot.id],
    );
    const runId = await run(seeds, 3, { verdict: 'ready', buildSessionId: build.id });
    card = await byId(asAda, first.messageId);
    assert.deepEqual([card.state, card.stage, card.step, card.stepName], ['working', 'planning', 2, 'Write a plan']);

    // Its plan posted: building.
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind) VALUES ($1, 3, $2, 'spec')`,
      [seeds.id, runId],
    );
    card = await byId(asAda, first.messageId);
    assert.deepEqual([card.state, card.stage, card.step, card.stepName, card.doing], ['working', 'building', 3, 'Build it', 'building it']);

    // Built: its proposal is up for a vote.
    await pool.query(`UPDATE chat_sessions SET status = 'promoted', promoted_at = NOW() WHERE id = $1`, [build.id]);
    await pool.query('UPDATE homeroom_bot_runs SET build_ok = TRUE, proposal_session_id = $2 WHERE id = $1', [runId, build.id]);
    card = await byId(asAda, first.messageId);
    assert.equal(card.state, 'done');
    assert.equal(card.outcome, 'proposed');
    assert.equal(card.links.proposal, `#app/seed-swap/dev/proposals/${build.id}`);
    assert.ok(card.endedAt, 'when it went up');
    assert.equal(card.step, undefined, 'a card done says what it came to, not a step');

    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [build.id]);
    assert.equal((await byId(asAda, first.messageId)).outcome, 'live');
  });

  await t.test('B4: a question ends a look; the next look at the request carries on in the same card', async () => {
    const asking = await activity.startCard(pool, {
      app: seeds, issueNumber: 4, requester: requester(ada, 'Dark mode'), bot, jobKey: await claim(seeds, 4), settings,
    });
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 4', [seeds.id]);
    await run(seeds, 4, { verdict: 'question' });
    const asked = await byId(asAda, asking.messageId);
    assert.equal(asked.state, 'done');
    assert.equal(asked.outcome, 'question');
    const { rows: [{ n: messagesBefore }] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM conversation_messages WHERE sender_id = $1', [bot.id],
    );

    // Answered: the bot looks again, and the same card follows it, where it
    // first appeared, from when this look began. Nothing new is sent.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await activity.startCard(pool, {
      app: seeds, issueNumber: 4, requester: requester(ada, 'Dark mode'), bot, jobKey: await claim(seeds, 4), settings,
    });
    assert.equal(again.messageId, asking.messageId);
    assert.equal(again.continued, true);
    const { rows: [{ n: messagesAfter }] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM conversation_messages WHERE sender_id = $1', [bot.id],
    );
    assert.equal(messagesAfter, messagesBefore, 'no second card');
    const card = await byId(asAda, asking.messageId);
    assert.equal(card.state, 'working');
    assert.equal(card.stage, 'reading');
    assert.equal(card.startedAt, asked.startedAt, 'its time counts from the first look');

    // A look that ended with nothing recorded (its row gone, no run): stopped.
    const lost = await activity.startCard(pool, {
      app: seeds, issueNumber: 5, requester: requester(ada, 'Export'), bot, jobKey: await claim(seeds, 5), settings,
    });
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 5', [seeds.id]);
    assert.equal((await byId(asAda, lost.messageId)).outcome, 'stopped');
  });

  // WP1 (#9): Plant Pal #1's card flipped to "Didn't finish" the moment a
  // second look at the request began, with its build healthy and nothing
  // said: a card with no outcome read as stopped as soon as a newer card on
  // its request existed.
  await t.test('WP1 (#9): a card whose build still waits or runs is working, whatever began after it', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 8, $2, 'Watering log')`,
      [seeds.id, ada.id],
    );
    const card = await activity.startCard(pool, {
      app: seeds, issueNumber: 8, requester: requester(ada, 'Watering log'), bot, jobKey: await claim(seeds, 8), settings,
    });
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 8', [seeds.id]);
    const { rows: [run8] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, live_build_waiting_at)
       VALUES ($1, 8, 'live', 'ready', NOW()) RETURNING id`,
      [seeds.id],
    );
    // A second look at the same request begins: B4, the same card, which
    // goes on following the build until it ends.
    const second = await activity.startCard(pool, {
      app: seeds, issueNumber: 8, requester: requester(ada, 'Watering log'), bot, jobKey: await claim(seeds, 8), settings,
    });
    assert.equal(second.messageId, card.messageId);
    let read = await byId(asAda, card.messageId);
    assert.deepEqual([read.state, read.stage, read.doing], ['working', 'build_queued', 'ready to build; waiting its turn to be built'],
      'its build waits its turn: not stopped');

    const { rows: [build] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, linked_issues)
       VALUES ($1, $2, 'bot-build-8', 'active', 'Watering log', '{8}') RETURNING id`,
      [seeds.id, bot.id],
    );
    await pool.query('UPDATE homeroom_bot_runs SET build_session_id = $2, live_build_waiting_at = NULL WHERE id = $1', [run8.id, build.id]);
    read = await byId(asAda, card.messageId);
    assert.deepEqual([read.state, read.stage, read.doing], ['working', 'building', 'building it'], 'and while it runs');

    await pool.query(`UPDATE chat_sessions SET status = 'promoted', promoted_at = NOW() WHERE id = $1`, [build.id]);
    await pool.query('UPDATE homeroom_bot_runs SET build_ok = TRUE, proposal_session_id = $2 WHERE id = $1', [run8.id, build.id]);
    read = await byId(asAda, card.messageId);
    assert.equal(read.outcome, 'proposed', 'and it ends in what its build came to');

    // A proposal withdrawn (a duplicate of a merged one, noteRequestMerged)
    // reads as closed, never as still up for a vote.
    await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [build.id]);
    assert.equal((await byId(asAda, card.messageId)).outcome, 'closed');

    // A build that ended with nothing recorded is not working for ever: its
    // session put away, the card stopped. B4: the look that started it
    // carried on in the same card, which reads from that look's start.
    const third = await activity.startCard(pool, {
      app: seeds, issueNumber: 8, requester: requester(ada, 'Watering log'), bot, jobKey: 'wp1-third', settings,
    });
    assert.equal(third.messageId, card.messageId);
    const { rows: [lost] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, archived_at, session_title)
       VALUES ($1, $2, 'bot-build-8b', 'archived', NOW(), 'Watering log') RETURNING id`,
      [seeds.id, bot.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id)
       VALUES ($1, 8, 'live', 'ready', $2)`,
      [seeds.id, lost.id],
    );
    // Its run is the newest look's: it began after that look did.
    const { rows: [order] } = await pool.query(
      `SELECT (SELECT created_at FROM homeroom_bot_runs WHERE build_session_id = $1)
                >= (SELECT (metadata->'homeroomBot'->>'lookAt')::timestamptz FROM conversation_messages WHERE id = $2) AS after`,
      [lost.id, third.messageId],
    );
    assert.equal(order.after, true);
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 8', [seeds.id]);
    assert.equal((await byId(asAda, third.messageId)).outcome, 'stopped');
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 8', [seeds.id]);
  });

  // WP1 (#10): the bot's answers read a request's newest look and newest
  // proposal only, so a second build of Plant Pal #1 was invisible to it and
  // it said "Nothing broke". Its progress now names the request's other
  // builds beside the one it describes.
  await t.test('WP1 (#10): progress names another build of the same request, and the build before', async () => {
    const progressSvc = require('../src/services/homeroom-bot-progress');
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES
         ($1, 10, $2, 'Plant list'), ($1, 11, $2, 'Reminders')`,
      [seeds.id, ada.id],
    );
    const session = async (status, issue) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, linked_issues, promoted_at)
       VALUES ($1, $2, $3, $4, 'x', $5, NOW()) RETURNING id`,
      [seeds.id, bot.id, `bot-${issue}-${status}`, status, [issue]],
    )).rows[0].id;
    const ready = async (issue, fields = {}) => (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id, proposal_session_id, build_ok, build_error)
       VALUES ($1, $2, 'live', 'ready', $3, $4, $5, $6) RETURNING id`,
      [seeds.id, issue, fields.build || null, fields.proposal || null, fields.ok ?? null, fields.error || null],
    )).rows[0].id;
    const entries = async () => {
      const p = await progressSvc.progressFor(pool, { userId: ada.id, settings, deps: { domain: null } });
      return new Map(p.rightNow.map((e) => [e.number, e]));
    };

    // #10: the first build's proposal is up for a vote while a second build
    // of the same request runs.
    const first = await session('promoted', 10);
    await ready(10, { build: first, proposal: first, ok: true });
    await ready(10, { build: await session('active', 10) });
    let entry = (await entries()).get(10);
    assert.equal(entry.proposal.proposal, first, 'it is still described by its proposal');
    assert.equal(entry.alsoBuilding.doing, 'another build of this same request is under way');
    assert.ok(entry.alsoBuilding.since);
    assert.equal(entry.earlierAttempt, undefined);

    // #11: a build that failed, then another look that builds it again.
    await ready(11, { build: await session('archived', 11), ok: false, error: 'the build ran past its time limit' });
    await ready(11, { build: await session('active', 11) });
    entry = (await entries()).get(11);
    assert.equal(entry.stage, 'planning');
    assert.equal(entry.alsoBuilding, undefined, 'the one it describes is not "also" building');
    assert.equal(entry.earlierAttempt.outcome, 'the build did not succeed: the build ran past its time limit');
    assert.ok(entry.earlierAttempt.when);

    // A request with one build says neither.
    for (const [n, e] of await entries()) {
      if (n !== 10 && n !== 11) assert.ok(!e.alsoBuilding && !e.earlierAttempt, `request #${n}`);
    }
    await pool.query('DELETE FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number IN (10, 11)', [seeds.id]);
  });

  await t.test('nobody else\'s cards, never an app they cannot view, and none for somebody the bot does not DM', async () => {
    const samsCard = await activity.startCard(pool, {
      app: samsApp, issueNumber: 9, requester: requester(sam, 'Sam\'s secret'), bot, jobKey: await claim(samsApp, 9), settings,
    });
    const hiddenCard = await activity.startCard(pool, {
      app: hidden, issueNumber: 2, requester: requester(ada, 'Hidden thing'), bot, jobKey: await claim(hidden, 2), settings,
    });
    const notOnList = await activity.startCard(pool, {
      app: seeds, issueNumber: 6, requester: requester(lee, 'Lee\'s idea'), bot, jobKey: await claim(seeds, 6), settings,
    });
    assert.equal(notOnList, null, 'lee is not somebody the bot talks to in a DM');

    const adas = await cardsOf(asAda);
    assert.ok(!adas.some((c) => c.messageId === samsCard.messageId), 'sam\'s card is not ada\'s');
    assert.ok(!adas.some((c) => c.messageId === hiddenCard.messageId), 'a private app she cannot view is left out');
    assert.deepEqual((await cardsOf(asSam)).map((c) => c.messageId), [samsCard.messageId],
      'sam\'s own, and not ada\'s card on sam\'s app');

    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [hidden.id, ada.id]);
    assert.ok((await cardsOf(asAda)).some((c) => c.messageId === hiddenCard.messageId), 'once she can view it, it shows');
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [hidden.id, ada.id]);

    assert.deepEqual(await activity.cardsFor(pool, { user: null }), { cards: [] });
  });

  await t.test('the route answers for the signed-in person only, whatever it is asked', async () => {
    const app = express();
    app.use(express.json());
    let actor = asAda;
    app.use((req, _res, next) => { req.user = actor; next(); });
    app.use(conversationRoutes({}, { pool }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => server.close());
    const call = async (as, url) => {
      actor = as;
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const own = await call(asAda, '/api/conversations/homeroom-bot/activity');
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(own.body, JSON.parse(JSON.stringify(await activity.cardsFor(pool, { user: asAda }))));
    assert.ok(own.body.cards.some((c) => c.messageId === first.messageId));
    for (const query of [`?user_id=${sam.id}`, `?userId=${sam.id}`, `?username=${sam.username}`, `?conversationId=${first.conversationId}`]) {
      const asked = await call(asAda, `/api/conversations/homeroom-bot/activity${query}`);
      assert.deepEqual(asked.body, own.body, query);
    }
    const his = await call(asSam, '/api/conversations/homeroom-bot/activity');
    assert.ok(!his.body.cards.some((c) => c.messageId === first.messageId));
    // Off staging, `?demo=1` is the real answer too.
    const demo = await call(asAda, '/api/conversations/homeroom-bot/activity?demo=1');
    assert.deepEqual(demo.body, own.body);
  });

  await t.test('a staging preview shows the demo DM\'s two cards, in the viewer\'s own fixture only', async () => {
    const staging = require('../src/services/staging-messages');
    const env = process.env.USERNODE_ENV;
    process.env.USERNODE_ENV = 'staging';
    try {
      const viewer = await user('viewer');
      const other = await user('other');
      const conversationId = await staging.ensureBotDmFixture(pool, viewer);
      await staging.ensureBotDmFixture(pool, viewer);
      const page = await conversations.listMessages(pool, viewer, conversationId, {});
      const cards = (page.messages || page).filter((m) => m.metadata?.homeroomBot?.kind === 'activity')
        .sort((a, b) => a.id - b.id);
      assert.deepEqual(cards.map((m) => m.metadata.homeroomBot.issueNumber), [9, 14], 'two cards, the one going newest, once');
      const demo = await activity.demoCards(pool, viewer);
      const going = demo.cards.find((c) => c.state === 'working');
      const ended = demo.cards.find((c) => c.state === 'done');
      assert.equal(going.messageId, cards[1].id);
      assert.deepEqual([going.step, going.of, going.stepName], [3, 6, 'Build it']);
      assert.equal(ended.messageId, cards[0].id);
      assert.equal(ended.outcome, 'proposed');
      const { rows } = await pool.query('SELECT 1 FROM homeroom_bot_dm_messages WHERE user_id = $1', [viewer.id]);
      assert.equal(rows.length, 0, 'a demo card stands for no request: nothing is recorded or posted');
      assert.deepEqual(await activity.demoCards(pool, other), { cards: [] }, 'another viewer\'s fixture is not theirs');
    } finally {
      if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
    }
  });
});
