'use strict';

// A chat request held for its project's first version (5 October run-through).
//
// "Page Turners", a group project. Its first version, which Homeroom bot was
// still building, was not live. Priya, invited that day, wrote an idea in the
// project's chat and tapped Suggest it. Request #2 was filed and held, as
// #3855 holds everything else on a project until its first version is live
// (homeroom-bot.js FIRST_VERSION_PENDING_SQL), and her DM with the bot said
// "Filed. Waiting for the first version to go live. I'll start on this as
// soon as it does." The chat said otherwise: her card read "Got it: Add list
// of books read with star ratings. Usually about 10 minutes.", and the chip
// on her message, which everybody sees, read Reading.
//
// Now a request queued, not started, while its project's first version is
// not live (the bot's own rule: firstVersionHolds, heldForFirstVersion) is at
// its own stage. Its card says what the DM says, and its chip is the waiting
// one (status waiting_first_version: "⏳ Homeroom bot has this", never that
// it is looking at it) from the moment it is filed. When the first version
// merges, the loop is
// woken for it; the moment it is picked up moves the card and the chip on,
// and a read of the cards after the hold ends puts back a chip no moment
// moved.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-chat-first-version-wait.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const botChat = require('../src/services/homeroom-bot-chat');

const BOOKS = 'Add list of books read with star ratings';
const WAIT = 'Waiting for the first version to go live. I’ll start on this as soon as it does.';
const STAYS = 'It stays in the project’s requests with your name on it.';

test('a held request has its own stage, and only while it is held', () => {
  const stage = (row) => botChat.stageOf({ kind: 'filed', ...row });
  assert.ok(botChat.CARD_STAGES.includes('waiting_first_version'));
  assert.equal(stage({ held_first_version: true }), 'waiting_first_version', 'queued behind the first version');
  assert.equal(stage({ held_first_version: true, run_id: 1, verdict: 'question' }), 'waiting_first_version',
    'answered and queued again: it waits for the first version, whatever it came to before');
  assert.equal(stage({ held_first_version: false }), 'reading', 'the hold over: read as before');
  assert.equal(stage({}), 'reading');
  // What the records already settle comes first: the bot's change for it
  // (a follow-up on it is never held), or a request closed.
  assert.equal(stage({ held_first_version: true, session_status: 'promoted', check_state: 'running' }), 'checking');
  assert.equal(stage({ held_first_version: true, issue_status: 'closed' }), 'closed');
  // A fix is never held: it runs on its change's own branch.
  assert.equal(botChat.stageOf({ kind: 'revise', session_status: 'promoted', held_first_version: true }), 'fixing');
});

test('the chip a held request wears, and the one it gets back once the hold ends', () => {
  const row = { kind: 'filed', issue_number: 2, session_id: null };
  assert.deepEqual(botChat.chipFor(row, 'waiting_first_version'), { issueNumber: 2, status: 'waiting_first_version' },
    'Waiting, never Reading');
  const waiting = { issueNumber: 2, status: 'waiting_first_version' };
  assert.deepEqual(botChat.chipFor(row, 'reading', waiting), { issueNumber: 2, status: 'reading' },
    'the first version went live and nothing moved the chip yet');
  assert.deepEqual(botChat.chipFor(row, 'waiting', waiting), { issueNumber: 2, status: 'reading' });
  assert.deepEqual(botChat.chipFor(row, 'building', waiting), { issueNumber: 2, status: 'building' });
  assert.equal(botChat.chipFor(row, 'stopped', waiting), null, 'it ended: no chip');
  assert.equal(botChat.chipFor(row, 'reading', { issueNumber: 2, status: 'reading' }), undefined,
    'any other chip is the moments\' to move, as before');
  assert.equal(botChat.chipFor(row, 'reading'), undefined);
});

test('a Reading chip the moments missed catches up with the card', () => {
  // Production run-through, 5 Oct 2026: the chip in the project's chat said
  // Reading through the whole build while the requester's card said
  // "Building it now". Reading the cards puts it right (cardsOf, reconcile).
  const row = { kind: 'filed', issue_number: 2, session_id: null };
  const reading = { issueNumber: 2, status: 'reading' };
  for (const stage of ['building', 'checking', 'approved']) {
    assert.deepEqual(botChat.chipFor(row, stage, reading), { issueNumber: 2, status: 'building' }, stage);
  }
  assert.equal(botChat.chipFor(row, 'waiting', reading), undefined, 'still before the build: as it is');
  // Never backwards, and Live is still only the app's answer to say.
  assert.equal(botChat.chipFor(row, 'reading', { issueNumber: 2, status: 'building' }), undefined);
  assert.equal(botChat.chipFor(row, 'live', reading), undefined);
});

test('what the card and the chip say while it waits', () => {
  const { BotStatusChip, BotRequestCardView, cardWords } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  // The wait line is the end of a whole catalog message that starts with what was taken.
  const FIRST_VERSION_WAIT_LINE = message('chat:group.botCard.filed.firstVersionWait', { title: 'X' }).slice('Got it: X. '.length);
  assert.equal(message('chat:group.botCard.filed.firstVersionWait', { title: 'X' }), `Got it: X. ${WAIT}`);
  assert.equal(FIRST_VERSION_WAIT_LINE, WAIT);
  // The DM card's own words (homeroom-bot-activity.js), in the chat card's typography.
  const { FIRST_VERSION_WAIT_WORDS } = require('../src/services/homeroom-bot-activity');
  assert.equal(FIRST_VERSION_WAIT_LINE.replace(/’/g, '\''), FIRST_VERSION_WAIT_WORDS);
  const card = { kind: 'filed', title: BOOKS, messageId: 1, issueNumber: 2, first: true, state: { stage: 'waiting_first_version' } };
  assert.equal(cardWords(card), `Got it: ${BOOKS}. ${WAIT} ${STAYS}`);
  assert.equal(cardWords({ ...card, first: false }), `Got it: ${BOOKS}. ${WAIT}`);
  assert.ok(!/Usually about/.test(cardWords({ ...card, typicalMinutes: 10 })), 'no time while it waits');
  assert.ok(!/—/.test(cardWords(card)));
  assert.match(renderToHtml(createElement(BotRequestCardView, { card })), /data-bot-request-action="progress"><span>See progress/);
  // Everybody in the room: Homeroom bot has it (5 October 2026: the room is
  // told the bot took it), and a screen reader hears that it waits for the
  // first version. Never that it is looking at it.
  const chip = { status: 'waiting_first_version', issueNumber: 2, sessionId: null };
  const theirs = renderToHtml(createElement(BotStatusChip, { chip }));
  const said = 'Homeroom bot has this, and starts on it once the first version is live';
  assert.match(theirs, new RegExp(`<span[^>]*data-bot-request="waiting_first_version"[^>]*aria-label="${said}"[^>]*>.*⏳.*Homeroom bot has this<`));
  assert.ok(!/Reading|looking at/.test(theirs));
  assert.match(renderToHtml(createElement(BotStatusChip, { chip, mine: true })),
    new RegExp(`<button[^>]*data-bot-request="waiting_first_version"[^>]*aria-label="${said}"`));
  // The other chips keep their values (a declared check selects on building).
  assert.match(renderToHtml(createElement(BotStatusChip, { chip: { status: 'reading', issueNumber: 2, sessionId: null } })),
    /data-bot-request="reading"[^>]*aria-label="Homeroom bot is looking at this"/);
  assert.match(renderToHtml(createElement(BotStatusChip, { chip: { status: 'building', issueNumber: 2, sessionId: null } })),
    /data-bot-request="building"/);
  // The chat draws the chip, and reads the cards again each minute while one waits.
  const gc = read('public/js/group-chat.js');
  assert.match(gc, /'fixing', 'waiting_first_version'\]\.includes\(value\.status\)/);
  assert.match(gc, /_BOT_CARD_GOING: new Set\(\['waiting_first_version', /);
});

test('the merge wakes the loop for what waited, and its pick-up moves the chat request on', () => {
  const src = read('src/services/homeroom-bot.js');
  // noteRequestMerged: the first version merged, the loop is woken.
  assert.match(src, /noteIssueActivity\(\{ appId, issueNumber: Number\(firstVersion\[0\]\.issue_number\), reason: 'first_version_live' \}\);/);
  // processOne, picking the request up: its chat message reads Reading, and
  // noteRequestStatus pushes the requester's cards (followCards).
  assert.match(src, /await activity\(\)\.startCard\(pool, \{\s*app, issueNumber, requester, bot, jobKey: item\.id, settings, inDm: DM_REASONS\.has\(item\.reason\), reason: item\.reason,\s*deps: \{ dm: deps\.dm \},\s*\}\);\s*\/\/ B9: [^\n]*\n\s*await require\('\.\/homeroom-bot-chat'\)\.noteRequestStatus\(pool, \{ appId: app\.id, issueNumber, status: 'reading' \}\);/);
});

test('Page Turners, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_fvwait_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const bot = require('../src/services/homeroom-bot');
  t.after(async () => {
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess", is_admin AS "isAdmin"`,
    [username, synthetic],
  )).rows[0];
  const botUser = await user('homeroom_bot', true);
  const maya = await user('maya');
  const priya = await user('priya');
  const { rows: [community] } = await pool.query('INSERT INTO communities DEFAULT VALUES RETURNING id');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url, community_id)
     VALUES ('Page Turners', 'page-turners', 'running', $1, 'private', 'private', 'https://github.com/example/page-turners', $2)
     RETURNING id, slug, name, repo_url, community_id`,
    [maya.id, community.id],
  );
  // Maya made it a month ago; Priya was invited today.
  await pool.query(
    `INSERT INTO community_members (community_id, user_id, joined_at) VALUES ($1, $2, NOW() - INTERVAL '30 days'), ($1, $3, NOW() - INTERVAL '1 hour')`,
    [community.id, maya.id, priya.id],
  );
  for (const person of [maya, priya]) {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, person.id]);
  }
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_mode', 'live');

  // Maya's first version, request #1: the bot read it and is building it.
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number, filed_at)
     VALUES ($1, $2, 'A book club: what we are reading and when we meet', 'filed', 1, NOW() - INTERVAL '20 minutes')`,
    [app.id, maya.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version)
     VALUES ($1, 1, $2, 'Page Turners, first version', TRUE)`,
    [app.id, maya.id],
  );
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
     VALUES ($1, 1, 'Page Turners, first version', 'brief', 'general', '{}', $2)`,
    [app.id, maya.id],
  );
  const { rows: [firstRun] } = await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, live_build_waiting_at, build_note)
     VALUES ($1, 1, 'live', 'ready', NOW() - INTERVAL '5 minutes', 'build it') RETURNING id`,
    [app.id],
  );

  let nextIssue = 1;
  const frames = [];
  const pushed = [];
  const deps = (answer) => ({
    readAsk: async () => answer,
    takeOfferRead: () => true,
    // The chat's own path for a mention, as it is with the bot's voice off
    // in chats (homeroom-bot-voice.js answers it otherwise).
    voice: { enabledFor: async () => false, recordAsk: async () => null, dropAsks: async () => {} },
    github: {
      isEnabled: () => true,
      safeMention: (s) => s,
      createIssue: async () => { nextIssue += 1; return { number: nextIssue }; },
    },
    ws: {
      broadcast: (appId, frame) => frames.push(frame),
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
  const metaOf = async (id) => (await pool.query('SELECT metadata FROM chat_messages WHERE id = $1', [id])).rows[0].metadata;
  const framesFor = (id) => frames.filter((f) => f.type === 'bot_request_status' && f.messageId === id);
  const cardsTo = (who) => pushed.filter((p) => p.userId === who.id && p.frame.type === 'bot_request_card').map((p) => p.frame.card);
  const mine = async () => (await botChat.myRequests(pool, { app, user: priya, deps: deps(null) })).cards;
  const readable = async () => (await bot.liveCandidates(pool, {
    liveSlugs: [app.slug], excludeAppIds: [], pausedApps: [], busyAppIds: [], botId: botUser.id,
  })).map((r) => Number(r.issue_number));
  const { cardWords } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');

  let booksId;
  await t.test('Suggest it, while the first version is being built: the card and the chip say it waits', async () => {
    const text = 'It would be nice to keep a list of the books we have read, with star ratings';
    booksId = await say(priya, text);
    const offer = await botChat.noteChatMessage(pool, null, {
      appId: app.id, userId: priya.id, messageId: booksId, content: text, deps: deps({ kind: 'change', title: BOOKS }),
    });
    assert.equal(offer.kind, 'offer');
    frames.length = 0;
    const filed = await botChat.requestFromMessage(pool, null, { app, user: priya, messageId: booksId, deps: deps(null) });
    assert.equal(filed.ok, true);
    const { card } = filed;
    assert.deepEqual([card.kind, card.issueNumber, card.first, card.state.stage], ['filed', 2, true, 'waiting_first_version']);
    assert.equal(card.typicalMinutes, undefined, 'no "Usually about 10 minutes"');
    assert.equal(cardWords(card), `Got it: ${BOOKS}. ${WAIT} ${STAYS}`);
    // The bot's own loop agrees: #2 keeps its place and is not read.
    const { rows: [queued] } = await pool.query('SELECT started_at FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 2', [app.id]);
    assert.equal(queued.started_at, null);
    assert.deepEqual(await readable(), []);
    // Everybody in the room sees Waiting, from the start: never Reading.
    assert.deepEqual((await metaOf(booksId)).botRequest, { issueNumber: 2, status: 'waiting_first_version' });
    assert.deepEqual(framesFor(booksId).map((f) => f.botRequest.status), ['waiting_first_version']);
    // Her DM with the bot says the same.
    const { rows: dm } = await pool.query(
      `SELECT content FROM conversation_messages WHERE content LIKE '%request #2%' AND content LIKE '%Filed. Waiting for the first version to go live.%'`,
    );
    // One story: asked in the chat, it still gets its card in her DM with
    // the bot (every request has one), whose thread says where it came from.
    assert.equal(dm.length, 1, 'its card in her DM, saying it waits');
    const { rows: origin } = await pool.query(
      `SELECT content FROM conversation_messages WHERE content LIKE 'You asked for this in %chat. It''s request #2.'`,
    );
    assert.equal(origin.length, 1, 'its thread starts with where it was asked');
    // After a reload (GET my-bot-requests): the same card, and the chip left as it is.
    frames.length = 0;
    const again = (await mine()).find((c) => c.messageId === booksId);
    assert.equal(again.state.stage, 'waiting_first_version');
    assert.equal(cardWords(again), `Got it: ${BOOKS}. ${WAIT} ${STAYS}`);
    assert.equal(framesFor(booksId).length, 0);
  });

  let goalId;
  await t.test('a mention while it is held waits the same way', async () => {
    const text = '@homeroom_bot could we set a reading goal for the year?';
    goalId = await say(priya, text);
    const out = await botChat.noteChatMessage(pool, null, {
      appId: app.id, userId: priya.id, messageId: goalId, content: text, deps: deps({ kind: 'change', title: 'Add a yearly reading goal' }),
    });
    assert.equal(out.ok, true);
    assert.deepEqual([out.card.issueNumber, out.card.state.stage], [3, 'waiting_first_version']);
    assert.equal(cardWords(out.card), `Got it: Add a yearly reading goal. ${WAIT}`);
    assert.deepEqual((await metaOf(goalId)).botRequest, { issueNumber: 3, status: 'waiting_first_version' });
    // An admin's Run now is not held, as in the bot's read lane: that card
    // reads as any queued request, and only the held one goes without a time.
    const { rows: [{ reason }] } = await pool.query('SELECT reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 2', [app.id]);
    await pool.query(`UPDATE homeroom_bot_queue SET reason = 'admin' WHERE app_id = $1 AND issue_number = 2`, [app.id]);
    const byId = new Map((await mine()).map((c) => [c.messageId, c]));
    assert.equal(byId.get(booksId).state.stage, 'reading');
    assert.ok(Number.isFinite(byId.get(booksId).typicalMinutes));
    assert.equal(byId.get(goalId).state.stage, 'waiting_first_version');
    assert.equal(byId.get(goalId).typicalMinutes, undefined, 'no time on the held card, even beside one that has one');
    await pool.query('UPDATE homeroom_bot_queue SET reason = $2 WHERE app_id = $1 AND issue_number = 2', [app.id, reason]);
  });

  await t.test('a Reading chip a missed moment left on a held request is put right', async () => {
    // As on production before this change: the chip said Reading.
    await pool.query(
      `UPDATE chat_messages SET metadata = jsonb_set(metadata, '{botRequest,status}', '"reading"') WHERE id = $1`, [booksId],
    );
    frames.length = 0;
    await mine();
    assert.deepEqual((await metaOf(booksId)).botRequest, { issueNumber: 2, status: 'waiting_first_version' });
    assert.deepEqual(framesFor(booksId).map((f) => f.botRequest), [{ issueNumber: 2, status: 'waiting_first_version' }]);
  });

  await t.test('built and up for approval: still waiting', async () => {
    const { rows: [first] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, linked_issues, check_state, pr_number)
       VALUES ($1, $2, 'hrbot/first', 'promoted', 'Page Turners', NOW(), ARRAY[1], 'passing', 1) RETURNING id`,
      [app.id, botUser.id],
    );
    await pool.query(
      'UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_ok = TRUE, proposal_session_id = $2 WHERE id = $1',
      [firstRun.id, first.id],
    );
    assert.deepEqual((await mine()).map((c) => c.state.stage), ['waiting_first_version', 'waiting_first_version']);
  });

  await t.test('the first version merges: the pick-up moves her card and chip on, and a re-read moves the rest', async () => {
    const { rows: [first] } = await pool.query(
      `SELECT id FROM chat_sessions WHERE app_id = $1 AND linked_issues = ARRAY[1]`, [app.id],
    );
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [first.id]);
    const logger = require('../src/services/logger');
    const said = [];
    const realInfo = logger.info;
    logger.info = (cat, msg, data) => { said.push({ msg, data }); };
    try {
      await bot.noteRequestMerged(pool, { id: first.id }, { worker: { async stopTurn() {} } });
    } finally {
      logger.info = realInfo;
    }
    assert.ok(said.some((s) => /first version is live; what waited for it is picked up now/.test(s.msg)),
      'the loop is woken for what waited');
    assert.deepEqual(await readable(), [2, 3], 'both are read now, in their order');

    // The loop picks #2 up (processOne): claimed, and its chat message told.
    await pool.query('UPDATE homeroom_bot_queue SET started_at = NOW() WHERE app_id = $1 AND issue_number = 2', [app.id]);
    frames.length = 0;
    pushed.length = 0;
    await botChat.noteRequestStatus(pool, { appId: app.id, issueNumber: 2, status: 'reading', deps: deps(null) });
    assert.deepEqual((await metaOf(booksId)).botRequest, { issueNumber: 2, status: 'reading' });
    const books = cardsTo(priya).find((c) => c.messageId === booksId);
    assert.equal(books.state.stage, 'reading');
    assert.ok(Number.isFinite(books.typicalMinutes));
    assert.equal(cardWords(books), `Got it: ${BOOKS}. Usually about ${books.typicalMinutes} minutes. ${STAYS}`);
    assert.equal(framesFor(goalId).length, 0, 'the other request\'s moment has not come');
    assert.equal((await metaOf(goalId)).botRequest.status, 'waiting_first_version');

    // #3 is not picked up yet (the project reads one at a time). The chat's
    // minute re-read (GET my-bot-requests) says it is no longer held, and
    // puts its chip back to the one any queued request wears.
    frames.length = 0;
    const goal = (await mine()).find((c) => c.messageId === goalId);
    assert.equal(goal.state.stage, 'reading');
    assert.equal(cardWords(goal), `Got it: Add a yearly reading goal. Usually about ${goal.typicalMinutes} minutes.`);
    assert.deepEqual((await metaOf(goalId)).botRequest, { issueNumber: 3, status: 'reading' });
    assert.deepEqual(framesFor(goalId).map((f) => f.botRequest), [{ issueNumber: 3, status: 'reading' }]);
  });
});
