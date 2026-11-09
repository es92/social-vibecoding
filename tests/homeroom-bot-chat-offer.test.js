'use strict';

// WP-C: somebody new to a project adds something back from its chat.
//
// A newcomer (joined in the last two weeks, nothing asked for there yet)
// need not mention Homeroom bot: when a message of theirs reads as an idea
// for the app, their own card offers "Suggest it" / "Not now". Suggest it
// files it as a request in their name, whether or not the bot is theirs; the
// first request somebody files says it stays with their name on it. Never
// for the project's maker, a member of long standing, somebody who has asked
// already, a message of a few words, or past the budget of reads.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/homeroom-bot-chat-offer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

// The card's two fixed lines, as the catalog holds them (bot-request.tsx reads them by id).
const STAYS_LINE = 'It stays in the project’s requests with your name on it.';
const SHARED_LINE = message('chat:group.botCard.shared');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const botChat = require('../src/services/homeroom-bot-chat');
const mayor = require('../src/services/homeroom-bot-mayor');

test('WP-C: the offer card, and the line under a first request', () => {
  const { BotRequestCardView, cardWords } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  assert.equal(cardWords({ kind: 'offer', title: 'Add a Sunday reminder' }),
    'Suggest this to the group? It goes in the project’s requests as “Add a Sunday reminder”, in your name.');
  const offer = renderToHtml(createElement(BotRequestCardView, { card: { messageId: 5, kind: 'offer', title: 'Add tags', issueNumber: null } }));
  assert.match(offer, /data-bot-request-card="offer"/);
  assert.match(offer, /data-bot-request-action="file"><span>Suggest it/);
  assert.match(offer, /data-bot-request-action="not-now"><span>Not now/);
  assert.equal(cardWords({ kind: 'group', title: 'Add tags', first: true }), `Filed as a request for the group: Add tags. ${STAYS_LINE}`);
  // The line is the end of a whole catalog message that follows what the card already said.
  assert.equal(cardWords({ kind: 'group', title: 'Add tags', first: true }), message('chat:group.botCard.withStays', { words: 'Filed as a request for the group: Add tags.' }));
  assert.equal(cardWords({ kind: 'group', title: 'Add tags' }), 'Filed as a request for the group: Add tags.', 'only the first says it');
  assert.equal(message('chat:group.botCard.withStays', { words: 'X.' }), `X. ${STAYS_LINE}`);
});

// 5 October 2026 (Evan, on his phone): "if you choose to submit it an idea,
// it should also at that point share it with the group that homeroom bot is
// looking at it? Not just stay private at that point". The room's status chip
// on the message is gone (5 Nov 2026): Suggest it files the request, which is
// the project's for everyone to see, and her card says so; nothing is written
// on the message or sent to the room. Without PostgreSQL: the pool answers the
// path's own queries, and nothing but Suggest it runs.
test('WP-C: Suggest it files it for the project, and only her card is sent', async (t) => {
  const { BotRequestCardView, cardWords, sharedNow } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  const APP = { id: 7, slug: 'page-turners', name: 'Page Turners', repo_url: 'https://github.com/example/page-turners' };
  const priya = { id: 21, username: 'priya', hasPlatformAccess: true };
  const MSG = 501;
  const TITLE = 'Keep a list of the books we have read';
  const TEXT = 'Could it also keep a list of the books we have read, with star ratings?';
  const suggest = async ({ held }) => {
    const order = [];
    const frames = [];
    const pushed = [];
    let request = {
      chat_message_id: MSG, app_id: APP.id, requester_id: priya.id, kind: 'offer', title: TITLE, issue_number: null, session_id: null,
    };
    const pool = {
      async query(sql, params = []) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (s.startsWith('SELECT id, user_id, content, thread_type')) {
          return { rows: [{ id: MSG, user_id: priya.id, content: TEXT, thread_type: null, msg_type: 'message', deleted_at: null, posted_via: null }] };
        }
        if (s.startsWith('SELECT * FROM chat_bot_requests WHERE chat_message_id')) return { rows: [request] };
        if (s.startsWith('SELECT COUNT(*)::int AS n FROM chat_bot_requests')) return { rows: [{ n: 0 }] };
        if (s.startsWith('INSERT INTO chat_bot_requests')) {
          request = { ...request, kind: params[3], issue_number: params[4], title: params[5], session_id: params[6] };
          order.push('recorded');
          return { rows: [request] };
        }
        if (s.startsWith('SELECT n.id FROM notifications')) return { rows: [] };
        if (s.startsWith('SELECT r.chat_message_id, r.kind, r.issue_number, r.app_id,')) {
          return {
            rows: [{
              chat_message_id: MSG, kind: request.kind, issue_number: request.issue_number, app_id: APP.id,
              queued: true, queue_waiting: true, queue_reason: 'chat_request', first_version: false, issue_status: 'open',
              run_id: null, session_id: null, session_status: null, check_state: null, session_live_at: null,
            }],
          };
        }
        if (s.startsWith('SELECT MIN(github_issue_number)')) return { rows: [{ n: request.issue_number }] };
        // A write on the message (the chip it used to wear) is recorded, so the test sees there is none.
        if (s.startsWith('UPDATE chat_messages')) {
          order.push('message written');
          return { rows: [{ id: MSG }] };
        }
        throw new Error(`a query Suggest it should not make: ${s.slice(0, 90)}`);
      },
    };
    const deps = {
      dm: { hasBot: () => true, botAccount: async () => ({ id: 1 }), typicalMinutes: async () => 10 },
      botSvc: {
        readSettings: async () => ({}),
        firstVersionHolds: async () => new Set(held ? [APP.id] : []),
        heldForFirstVersion: (holds, { appId }) => holds.has(Number(appId)),
      },
      liveSvc: { isLiveFor: () => true },
      mayor: { fileRequest: async () => { order.push('filed'); return { issueNumber: 4, queueId: null }; } },
      // Its stored work state: filed and queued, waiting to be read.
      workState: {
        ensure: async () => {},
        forRequests: async (_pool, appId, numbers) => new Map(numbers.map((n) => [n, { stage: 'reading', line: { code: 'queued' } }])),
      },
      ws: {
        broadcast: (appId, frame) => { order.push('broadcast'); frames.push({ appId, frame }); },
        pushToUser: (userId, frame) => pushed.push({ userId, frame }),
      },
    };
    const out = await botChat.requestFromMessage(pool, null, { app: APP, user: priya, messageId: MSG, deps });
    return { out, order, frames, pushed };
  };

  await t.test('the first version is live: it waits to be read', async () => {
    const { out, order, frames, pushed } = await suggest({ held: false });
    assert.equal(out.ok, true);
    assert.deepEqual([out.card.kind, out.card.issueNumber, out.card.first, out.card.state.stage], ['filed', 4, true, 'reading']);
    // Filed and recorded before Suggest it answers; nothing written on the
    // message and nothing sent to the room.
    assert.deepEqual(order, ['filed', 'recorded']);
    assert.deepEqual(frames, []);
    // The card is hers alone.
    assert.deepEqual(pushed.map((p) => [p.userId, p.frame.type]), [[priya.id, 'bot_request_card']]);
    // Her card says the group can see it, under what it said before.
    assert.equal(cardWords(out.card), `Got it: ${TITLE}. Usually about 10 minutes. It stays in the project’s requests with your name on it.`);
    assert.equal(sharedNow(out.card), true);
    const card = renderToHtml(createElement(BotRequestCardView, { card: out.card }));
    assert.match(card, /Only you can see this/);
    // React writes the line's apostrophe as an entity.
    assert.ok(card.includes(`data-bot-request-shared="">${SHARED_LINE.replace(/'/g, '&#x27;')}</p>`));
  });

  await t.test('the first version is still being built: it waits for the first version', async () => {
    const { out, order, frames } = await suggest({ held: true });
    assert.equal(out.card.state.stage, 'waiting_first_version');
    assert.equal(out.card.typicalMinutes, undefined, 'nobody knows how long it waits');
    assert.deepEqual(order, ['filed', 'recorded']);
    assert.deepEqual(frames, []);
    assert.equal(sharedNow(out.card), true);
  });
});

test('WP-C: the card says the group can see it only while the bot has it and has not started building', () => {
  const { sharedNow, BotRequestCardView } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  // 5 Nov 2026: what the room can see is the request in the project's list, not a chip on the message.
  assert.equal(SHARED_LINE, 'Everyone here can see it in the project\'s requests.');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/group-chat/bot-request.tsx'), 'utf8'),
    /data-bot-request-shared="">\{t\('chat:group\.botCard\.shared'\)\}<\/p>/);
  const filed = (stage) => ({ messageId: 5, kind: 'filed', title: 'Add tags', issueNumber: 3, ...(stage ? { state: { stage } } : {}) });
  for (const stage of [null, 'reading', 'waiting', 'waiting_first_version']) assert.equal(sharedNow(filed(stage)), true, String(stage));
  for (const stage of ['building', 'checking', 'proposed', 'live', 'stopped', 'question']) assert.equal(sharedNow(filed(stage)), false, stage);
  // Nothing to say: filed for the group (its card says so), an offer, a fix (on a change already up).
  assert.equal(sharedNow({ messageId: 5, kind: 'group', title: 'Add tags', issueNumber: 3 }), false);
  assert.equal(sharedNow({ messageId: 5, kind: 'offer', title: 'Add tags', issueNumber: null }), false);
  assert.equal(sharedNow({ messageId: 5, kind: 'revise', title: 'Add tags', issueNumber: 3, state: { stage: 'fixing' } }), false);
  assert.doesNotMatch(renderToHtml(createElement(BotRequestCardView, { card: filed('building') })), /data-bot-request-shared/);
  assert.doesNotMatch(SHARED_LINE, /—/);
});

test('WP-C: a message is counted in words', () => {
  assert.equal(botChat.wordCount('  could it   show the weather '), 5);
});

test('WP-C: an unaddressed message is read as an idea, not as something said to the bot', () => {
  const llm = read('src/services/llm.js');
  assert.match(llm, /async function readChatAsk\(\{ text, appName = null, toBot = true, changes = \[\], apiKey, telemetryContext \}\)/);
  assert.match(llm, /'Somebody new to the group wrote this'/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CHECK \(kind IN \('filed', 'group', 'unsure', 'question', 'dismissed', 'offer', 'revise'\)\)/);
  // No first-session card describes the offer: it is the bot's own to make
  // in Discussion (the invited person's tour that ended there is gone, 15
  // Oct 2026).
  assert.doesNotMatch(read('frontend/src/features/first-session/tour-steps.ts'), /sayHi|Discussion/);
});

test('WP-C: offers against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_offer_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  await user('homeroom_bot', true);
  const maya = await user('maya');
  const sam = await user('sam');
  const vet = await user('vet');
  const { rows: [community] } = await pool.query('INSERT INTO communities DEFAULT VALUES RETURNING id');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url, community_id)
     VALUES ('Run Club', 'run-club', 'running', $1, 'private', 'private', 'https://github.com/example/run-club', $2)
     RETURNING id, slug, name, repo_url, community_id`,
    [maya.id, community.id],
  );
  await pool.query(
    `INSERT INTO community_members (community_id, user_id, joined_at) VALUES
       ($1, $2, NOW() - INTERVAL '90 days'), ($1, $3, NOW() - INTERVAL '1 day'), ($1, $4, NOW() - INTERVAL '60 days')`,
    [community.id, maya.id, sam.id, vet.id],
  );
  // The bot is nobody's here: Sam's suggestion is filed for the group.
  const created = [];
  const pushed = [];
  let reads = 0;
  let nextIssue = 10;
  const deps = (answer) => ({
    readAsk: async (args) => { reads += 1; assert.equal(args.toBot, false); return answer; },
    takeOfferRead: () => true,
    github: {
      isEnabled: () => true,
      safeMention: (s) => s,
      createIssue: async (owner, repo, issue) => { created.push(issue); nextIssue += 1; return { number: nextIssue }; },
    },
    ws: {
      broadcast: () => {},
      pushToUser: (userId, frame) => pushed.push({ userId, frame }),
      sendSystemMessage: async () => {},
      pushIssueUpdate: () => {},
    },
    notifications: { createIssueOpenedNotifications: async () => [] },
  });
  const say = async (who, content) => (await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata) VALUES ($1, $2, $3, 'message', '{}') RETURNING id`,
    [app.id, who.id, content],
  )).rows[0].id;
  const note = (who, id, content, answer) => botChat.noteChatMessage(pool, null, {
    appId: app.id, userId: who.id, messageId: id, content, deps: deps(answer),
  });
  const change = { kind: 'change', title: 'Show the weather for Sunday' };

  await t.test('a newcomer\'s idea is offered to them alone, and Suggest it files it in their name', async () => {
    const text = 'it would be great if it showed the weather for Sunday';
    const id = await say(sam, text);
    const card = await note(sam, id, text, change);
    assert.deepEqual([card.kind, card.title], ['offer', 'Show the weather for Sunday']);
    assert.equal(pushed.at(-1).userId, sam.id, 'his card alone');
    assert.equal(created.length, 0, 'nothing filed until he says so');
    const filed = await botChat.requestFromMessage(pool, null, {
      app, user: { id: sam.id, username: 'sam' }, messageId: id, deps: deps(null),
    });
    assert.equal(filed.ok, true);
    assert.deepEqual([filed.card.kind, filed.card.first], ['group', true]);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'Show the weather for Sunday');
    assert.match(created[0].body, /Asked in Run Club's chat by @sam\./);
    const { rows: [issue] } = await pool.query('SELECT created_by FROM issues WHERE app_id = $1 AND github_issue_number = 11', [app.id]);
    assert.equal(issue.created_by, sam.id, 'in his name');
    // After a reload his card is still the first one.
    const mine = await botChat.myRequests(pool, { app, user: { id: sam.id, username: 'sam' } });
    assert.deepEqual(mine.cards.map((c) => [c.kind, !!c.first]), [['group', true]]);
  });

  await t.test('once somebody has asked for something, no more offers', async () => {
    const before = reads;
    const text = 'could we also have a leaderboard for the month';
    const id = await say(sam, text);
    assert.equal(await note(sam, id, text, change), null);
    assert.equal(reads, before, 'not even read');
  });

  await t.test('never for the maker, a member of long standing, or a few words', async () => {
    const before = reads;
    for (const who of [maya, vet]) {
      const text = 'it would be great if it showed the weather';
      assert.equal(await note(who, await say(who, text), text, change), null);
    }
    const { rows: [fresh] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ('ali', 'x', TRUE) RETURNING id, username`);
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [community.id, fresh.id]);
    assert.equal(await note(fresh, await say(fresh, 'hi everyone'), 'hi everyone', change), null);
    assert.equal(reads, before, 'none of them read');
    // A newcomer's greeting is read, and is not an idea: no card, no row.
    const hello = 'hello everyone, glad to be here';
    const id = await say(fresh, hello);
    assert.equal(await note(fresh, id, hello, { kind: 'question', title: null }), null);
    assert.equal(reads, before + 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM chat_bot_requests WHERE chat_message_id = $1', [id])).rows[0].n, 0);
  });

  await t.test('Not now takes the offer away; two offers per project at most', async () => {
    const { rows: [lee] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ('lee', 'x', TRUE) RETURNING id, username`);
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [community.id, lee.id]);
    const text = 'maybe the list could be sorted by distance';
    const first = await say(lee, text);
    assert.equal((await note(lee, first, text, change)).kind, 'offer');
    await botChat.requestFromMessage(pool, null, { app, user: { id: lee.id, username: 'lee' }, messageId: first, dismiss: true, deps: deps(null) });
    assert.equal((await pool.query('SELECT kind FROM chat_bot_requests WHERE chat_message_id = $1', [first])).rows[0].kind, 'dismissed');
    const second = await say(lee, text);
    assert.equal((await note(lee, second, text, change)).kind, 'offer');
    const third = await say(lee, text);
    assert.equal(await note(lee, third, text, change), null, 'two is enough');
    // An offer is only ever its own maker's to take.
    const taken = await botChat.requestFromMessage(pool, null, { app, user: { id: sam.id, username: 'sam' }, messageId: second, deps: deps(null) });
    assert.equal(taken.status, 403);
  });

  // 17 Oct 2026: counted from rows, so the budget holds across processes
  // and restarts (it was a counter in each process's memory).
  await t.test('the reads behind offers are budgeted per person a day and for everybody an hour, from rows', async () => {
    await pool.query('DELETE FROM homeroom_bot_offer_reads');
    for (let i = 0; i < botChat.OFFER_READS_PER_DAY; i += 1) assert.equal(await botChat.takeOfferRead(pool, sam.id, 900000 + i), true);
    assert.equal(await botChat.takeOfferRead(pool, sam.id, 900100), false, 'their day is spent');
    assert.equal(await botChat.takeOfferRead(pool, vet.id, 900101), true, 'somebody else\'s is not');
    assert.equal(await botChat.takeOfferRead(pool, vet.id, 900101), false, 'a message is read once');
    await pool.query(`UPDATE homeroom_bot_offer_reads SET read_at = NOW() - INTERVAL '25 hours' WHERE user_id = $1`, [sam.id]);
    assert.equal(await botChat.takeOfferRead(pool, sam.id, 900102), true, 'a new day');
    await pool.query(
      `INSERT INTO homeroom_bot_offer_reads (user_id, message_id) SELECT $1, 950000 + g FROM generate_series(1, $2::int) g`,
      [maya.id, botChat.OFFER_READS_PER_HOUR]);
    assert.equal(await botChat.takeOfferRead(pool, vet.id, 900103), false, 'everybody\'s hour is spent');
    await pool.query(`UPDATE homeroom_bot_offer_reads SET read_at = NOW() - INTERVAL '61 minutes'`);
    assert.equal(await botChat.takeOfferRead(pool, vet.id, 900104), true, 'a new hour');
  });

  // #6248: the preview beside the chat reads the saved draft, not the
  // message's 1200-character clip, and only its own person's open one.
  await t.test('readDraft reads the viewer\'s own open file_request in full, and nothing else', async () => {
    const long = `${'week by week. '.repeat(120)}and an ending past the clip`;
    assert.ok(long.length > 1200);
    const { rows: [action] } = await pool.query(
      `INSERT INTO homeroom_bot_dm_actions (user_id, app_id, kind, title, details)
       VALUES ($1, $2, 'file_request', 'Add a search box', $3) RETURNING id`,
      [sam.id, app.id, long]);
    const mine = await mayor.readDraft(pool, { user: { id: sam.id, username: 'sam' }, actionId: action.id });
    assert.equal(mine.ok, true);
    assert.equal(mine.title, 'Add a search box');
    assert.equal(mine.details, long, 'the whole saved description');
    assert.deepEqual(mine.app, { slug: 'run-club', name: 'Run Club' });
    assert.equal(mine.footer, 'Filed from sam\'s chat with Homeroom bot.');
    assert.equal((await mayor.readDraft(pool, { user: { id: maya.id, username: 'maya' }, actionId: action.id })).ok, false,
      'somebody else\'s draft');
    await pool.query(`UPDATE homeroom_bot_dm_actions SET status = 'done' WHERE id = $1`, [action.id]);
    assert.equal((await mayor.readDraft(pool, { user: { id: sam.id, username: 'sam' }, actionId: action.id })).ok, false,
      'a decided draft');
    const { rows: [other] } = await pool.query(
      `INSERT INTO homeroom_bot_dm_actions (user_id, app_id, kind, title, details)
       VALUES ($1, $2, 'post_reply', 'Post this', 'words') RETURNING id`,
      [sam.id, app.id]);
    assert.equal((await mayor.readDraft(pool, { user: { id: sam.id, username: 'sam' }, actionId: other.id })).ok, false,
      'not a file_request');
  });
});
