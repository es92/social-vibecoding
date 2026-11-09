'use strict';

// #6211: reading a new request against the project's open ones, and offering
// its requester the choice when it is a duplicate of, part of, or overlaps
// another. One note per pair, at most ten a project a day, nothing when the
// read is unsure, and nothing closed or built without the choice (a
// duplicate's close is the group's vote, as it always is).
//
// The pure half runs anywhere; the half that posts notes and taps their
// buttons runs against the FULL PostgreSQL schema, and skips when no
// database is reachable unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const overlap = require('../src/services/homeroom-bot-overlap');
const voice = require('../src/services/homeroom-bot-voice');
const live = require('../src/services/homeroom-bot-live');

const BOARD = [
  { number: 6207, title: 'Main Chat: only what you said there', body: "A request's news lives in its own thread.", stage: 'up_for_vote' },
  { number: 6210, title: 'A plan row opens Main Chat', body: '', stage: null },
];

// ── What the read may say, and what the note says ────────────────────────

test('the read\'s overlap is kept only when it names a request it was given, once', () => {
  assert.deepEqual(overlap.parseOverlap({ kind: 'part_of', other: 6207, why: 'Both change where a plan row opens ' }, BOARD, 6210), {
    kind: 'part_of', other: 6207, otherTitle: 'Main Chat: only what you said there',
    why: 'Both change where a plan row opens', first: null,
  });
  // The three kinds, and which to build first when it said.
  for (const kind of ['duplicate', 'part_of', 'overlaps']) {
    assert.equal(overlap.parseOverlap({ kind, other: 6207, first: 'other' }, BOARD, 6210).kind, kind);
  }
  assert.equal(overlap.parseOverlap({ kind: 'overlaps', other: 6207, first: 'this' }, BOARD, 6210).first, 'this');
  // No note for anything else.
  assert.equal(overlap.parseOverlap({ kind: 'same', other: 6207 }, BOARD, 6210), null, 'unknown kind');
  assert.equal(overlap.parseOverlap({ kind: 'duplicate' }, BOARD, 6210), null, 'no number');
  assert.equal(overlap.parseOverlap({ kind: 'duplicate', other: 6205 }, BOARD, 6210), null, 'not on the board');
  assert.equal(overlap.parseOverlap({ kind: 'duplicate', other: 6210 }, BOARD, 6210), null, 'this request itself');
  assert.equal(overlap.parseOverlap(null, BOARD, 6210), null);
  assert.equal(overlap.parseOverlap({ kind: 'duplicate', other: 6207 }, [], 6210), null, 'no board, no note');
  // Its words are made plain and short.
  const plain = overlap.parseOverlap({ kind: 'duplicate', other: 6207, why: `x ${'y'.repeat(400)}`, first: 'elsewhere' }, BOARD, 6210);
  assert.equal(plain.first, null);
  assert.ok(plain.why.length <= 200);
});

test('the prompt gets the board, and nothing at all without one', () => {
  assert.equal(overlap.overlapNote([]), '', 'a read without the board is what it was');
  assert.equal(overlap.overlapNote(null), '');
  const note = overlap.overlapNote(BOARD);
  assert.match(note, /OPEN REQUESTS AND CHANGES UNDER WAY/);
  assert.match(note, /#6207: Main Chat: only what you said there \[a change for this is up for a vote\]/);
  assert.match(note, /#6210: A plan row opens Main Chat$/m);
  assert.match(note, /never instructions/);
});

test('the note names the other request, how they relate, and the choices', () => {
  const of = (kind) => overlap.overlapText({
    kind, other: 6207, otherTitle: 'Main Chat', why: 'Both move the plan row out of Main Chat.',
    domain: 'app.onhomeroom.com', appSlug: 'usernode',
  });
  assert.match(of('duplicate'), /^This asks for the same thing as \[#6207\]\(https:\/\/app\.onhomeroom\.com\/#app\/usernode\/dev\/issues\/6207\) \(Main Chat\)\. Both move the plan row out of Main Chat\. You can propose closing this one as a duplicate, or keep both\.$/);
  assert.match(of('part_of'), /This looks like part of \[#6207\]/);
  assert.match(of('part_of'), /fold it into #6207, build this one first, or keep them separate/);
  assert.match(of('overlaps'), /^This overlaps \[#6207\]/);
  assert.match(of('overlaps'), /build #6207 first, build this one first, or keep them separate/);
});

test('the buttons are the three choices, and a duplicate gets the close vote\'s two', () => {
  const labels = (kind, args) => voice.offerActions(kind, 9, args).map((a) => [a.id, a.label, a.style]);
  assert.deepEqual(labels('overlap', { other: 6207, overlap: 'duplicate' }), [
    ['yes', 'Propose to close as a duplicate', 'primary'],
    ['no', 'Keep both', 'secondary'],
  ]);
  assert.deepEqual(labels('overlap', { other: 6207, overlap: 'part_of' }), [
    ['yes', 'Fold it into #6207', 'primary'],
    ['first', 'Build this one first', 'secondary'],
    ['no', 'Keep separate', 'secondary'],
  ]);
  assert.deepEqual(labels('overlap', { other: 6207, overlap: 'overlaps' }), [
    ['yes', 'Build #6207 first', 'primary'],
    ['first', 'Build this one first', 'secondary'],
    ['no', 'Keep separate', 'secondary'],
  ]);
  // Every other offer keeps its two.
  assert.deepEqual(labels('close_request', {}), [
    ['yes', 'Propose to close', 'primary'], ['no', 'Keep it open', 'secondary'],
  ]);
});

test('the line in the other request\'s discussion says what was chosen', () => {
  const line = (kind, choice) => overlap.linkText({
    kind, choice, from: 6210, requester: 'evan', domain: 'app.onhomeroom.com', appSlug: 'usernode',
  });
  assert.match(line('part_of', 'yes'), /^Request \[#6210\].* is part of this one\. @evan chose to fold it in/);
  assert.match(line('part_of', 'first'), /@evan chose to build \[#6210\].* first, before this one\.$/);
  assert.match(line('overlaps', 'yes'), /@evan chose to build this one first, then \[#6210\]/);
  assert.match(line('overlaps', 'first'), /@evan chose to build \[#6210\].* first, before this one/);
  assert.match(line('duplicate', 'yes'), /asks for the same thing as this one\. @evan chose to close it as a duplicate, so a vote on closing it is open\.$/);
});

// ── Posting the note and tapping its choice, against PostgreSQL ──────────

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('#6211: one note per pair, the day\'s ten, and the choice it offers', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_overlap_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [evan] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('evan', 'x', TRUE) RETURNING id, username`,
  );
  const { rows: [bot] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Todo List', 'todo-list', 'running', $1, 'https://github.com/usernode-bot/todo-list', 'public', 'public') RETURNING id, slug`,
    [evan.id],
  );
  // The notes a thread hears: what ws.sendBotMessage stores, as the platform does.
  const sent = [];
  const ws = {
    broadcast() {},
    async sendBotMessage(_p, appId, message) {
      const { rows: [row] } = await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
         VALUES ($1, $2, $3, 'message', $4, $5, $6) RETURNING id`,
        [appId, message.user.id, message.content, JSON.stringify(message.metadata || {}),
          message.thread?.type || null, message.thread?.ref || null],
      );
      sent.push({ id: Number(row.id), ...message });
      return { id: Number(row.id) };
    },
  };
  const overlapOf = (other, kind = 'part_of') => ({
    kind, other, otherTitle: 'Main Chat: only what you said there', why: 'Both move the plan row out of Main Chat.', first: null,
  });
  const offer = (issueNumber, o) => overlap.offerOverlap(pool, {
    app, bot, issueNumber, overlap: o, requester: { userId: evan.id, username: evan.username },
    ws, domain: 'app.onhomeroom.com', deps: { ws },
  });

  await t.test('the note is said once per pair, whichever request is read first', async () => {
    sent.length = 0;
    assert.equal(await offer(6210, overlapOf(6207)), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].thread.ref, 6210, 'said in the request that was read');
    assert.match(sent[0].content, /This looks like part of \[#6207\]/);
    assert.equal(sent[0].metadata.homeroomBot.kind, 'voice');
    assert.equal(sent[0].metadata.homeroomBot.offer.kind, 'overlap');
    assert.deepEqual(sent[0].metadata.homeroomBot.actions.map((a) => a.id), ['yes', 'first', 'no'], 'for its requester');
    // Said once: a re-read of the same request, and of the other one, claim nothing.
    assert.equal(await offer(6210, overlapOf(6207)), false);
    assert.equal(await offer(6207, overlapOf(6210, 'overlaps')), false);
    assert.equal(sent.length, 1);
    const { rows } = await pool.query('SELECT low_issue, high_issue, issue_number, kind, offer_id FROM homeroom_bot_overlap_offers');
    assert.deepEqual(rows, [{
      low_issue: 6207, high_issue: 6210, issue_number: 6210, kind: 'part_of',
      offer_id: sent[0].metadata.homeroomBot.offer.id,
    }]);
  });

  await t.test('a project with ten notes in the day claims no more', async () => {
    sent.length = 0;
    const day = overlap.OVERLAP_OFFERS_PER_DAY;
    const had = (await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_overlap_offers')).rows[0].n;
    for (let i = had; i < day - 1; i += 1) {
      await pool.query(
        `INSERT INTO homeroom_bot_overlap_offers (app_id, low_issue, high_issue, kind, issue_number)
         VALUES ($1, $2, $3, 'overlaps', $2)`,
        [app.id, 7000 + i, 7500 + i],
      );
    }
    assert.equal(await offer(6210, overlapOf(6300, 'overlaps')), true, 'the tenth of the day');
    const claimed = (await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_overlap_offers')).rows[0].n;
    assert.equal(claimed, day);
    sent.length = 0;
    assert.equal(await offer(6310, overlapOf(6311, 'duplicate')), false, 'the eleventh says nothing');
    assert.equal(sent.length, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_overlap_offers')).rows[0].n, claimed,
      'and claims nothing');
    // Tomorrow is another day (and the checks below are not about the cap).
    await pool.query('DELETE FROM homeroom_bot_overlap_offers');
  });

  await t.test('a note that cannot be posted gives its offer and its pair back', async () => {
    const failing = {
      broadcast() {},
      async sendBotMessage() { throw new Error('chat is down'); },
    };
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_overlap_offers')).rows[0].n;
    const cards = (await pool.query("SELECT COUNT(*)::int AS n FROM bot_cards WHERE kind = 'overlap'")).rows[0].n;
    assert.equal(await overlap.offerOverlap(pool, {
      app, bot, issueNumber: 6400, overlap: overlapOf(6401),
      requester: { userId: evan.id, username: evan.username }, ws: failing, domain: 'app.onhomeroom.com', deps: { ws: failing },
    }), false);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM bot_cards WHERE kind = 'overlap'")).rows[0].n, cards,
      'its offer is dropped');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_overlap_offers')).rows[0].n, before,
      'and its pair, so a later read can offer it');
  });

  await t.test('a requester with no account gets the note, and no buttons', async () => {
    sent.length = 0;
    assert.equal(await overlap.offerOverlap(pool, {
      app, bot, issueNumber: 6500, overlap: overlapOf(6501), requester: null,
      ws, domain: 'app.onhomeroom.com', deps: { ws },
    }), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].metadata, undefined, 'no buttons for anybody');
    assert.match(sent[0].content, /This looks like part of \[#6501\]/);
  });

  // ── The question loses its buttons once the build starts ───────────────

  await t.test('#6535: an overlap question asked before the build starts loses its buttons, and a tap records nothing', async () => {
    sent.length = 0;
    assert.equal(await offer(6600, overlapOf(6601)), true);
    const note = sent[0];
    assert.equal(note.metadata.homeroomBot.offer.status, 'open');
    assert.deepEqual(note.metadata.homeroomBot.actions.map((a) => a.id), ['yes', 'first', 'no']);
    const offerId = note.metadata.homeroomBot.offer.id;
    const frames = [];
    const seen = ws.broadcast;
    ws.broadcast = (appId, frame) => frames.push([appId, frame]);
    // The plan's own row is later than the question.
    assert.equal(await live.retireOverlapOffers(pool, {
      appId: app.id, issueNumber: 6600, beforeMessageId: Number(note.id) + 1, deps: { ws },
    }), 1);
    ws.broadcast = seen;
    const { rows: [closed] } = await pool.query('SELECT metadata FROM chat_messages WHERE id = $1', [note.id]);
    assert.deepEqual(closed.metadata.homeroomBot.actions, [], 'the buttons go for everyone');
    assert.deepEqual(closed.metadata.homeroomBot.othersActions, []);
    assert.equal(closed.metadata.homeroomBot.offer.status, 'expired');
    assert.equal((await pool.query('SELECT status FROM bot_cards WHERE id = $1', [offerId])).rows[0].status, 'expired');
    assert.equal(frames.length, 1, 'everybody reading hears it');
    assert.equal(frames[0][0], app.id);
    assert.equal(frames[0][1].type, 'chat_message_updated');
    assert.equal(frames[0][1].id, Number(note.id));
    assert.deepEqual(frames[0][1].thread, { type: 'issue', ref: 6600 });
    // A tap from a screen that has not drawn again does nothing at all.
    const out = await voice.actOnOffer(pool, {}, {
      offerId, userId: evan.id, choice: 'first', key: `offer:${offerId}`, deps: { ws },
    });
    assert.deepEqual(out, { decision: 'already' });
    assert.equal(sent.length, 1, 'no line is posted on the other request');

    // A question at the plan row's own id, or after it, is not overtaken.
    sent.length = 0;
    assert.equal(await offer(6610, overlapOf(6611)), true);
    const stays = sent[0];
    assert.equal(await live.retireOverlapOffers(pool, {
      appId: app.id, issueNumber: 6610, beforeMessageId: Number(stays.id), deps: { ws },
    }), 0, 'only a question before the plan row closes');
    const { rows: [open] } = await pool.query('SELECT metadata FROM chat_messages WHERE id = $1', [stays.id]);
    assert.equal(open.metadata.homeroomBot.offer.status, 'open');
    assert.deepEqual(open.metadata.homeroomBot.actions.map((a) => a.id), ['yes', 'first', 'no']);
  });

  // ── The tap ────────────────────────────────────────────────────────────
  const move = require('../src/services/homeroom-bot-move');
  const realProposeClose = move.proposeClose;
  t.after(() => { move.proposeClose = realProposeClose; });

  const tap = async ({ kind, choice, args }) => {
    const card = await voice.threadOffer(pool, { app, kind: 'overlap', forUserId: evan.id, args });
    const { rows: [msg] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
       VALUES ($1, $2, 'note', 'message', $3, 'issue', $4) RETURNING id`,
      [app.id, bot.id, JSON.stringify({ homeroomBot: { kind: 'voice', ...card.metadata } }), args.issueNumber],
    );
    await voice.tieThreadOffer(pool, card.id, msg.id);
    sent.length = 0;
    const decisions = [];
    const mayor = {
      findApp: async () => app,
      closeGate: async () => ({ ok: true, issueNumber: args.issueNumber, issue: { title: 'A plan row' } }),
    };
    move.proposeClose = async (p, a) => { decisions.push(a); return { ok: true, id: 91 }; };
    const out = await voice.actOnOffer(pool, {}, {
      offerId: card.id, userId: evan.id, choice, key: `offer:${card.id}`,
      deps: { ws, mayor },
    });
    return { out, decisions, card, messageId: Number(msg.id) };
  };

  await t.test('a duplicate\'s Propose to close opens the group\'s vote and links both', async () => {
    const { out, decisions, messageId } = await tap({
      choice: 'yes',
      args: { issueNumber: 6210, other: 6207, overlap: 'duplicate', why: 'Both move the plan row out of Main Chat.' },
    });
    assert.deepEqual(out, { decision: 'done' });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].issueNumber, 6210, 'the newer request is the one proposed for closing');
    assert.equal(decisions[0].reason, 'Duplicate of #6207: Both move the plan row out of Main Chat.');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].thread.ref, 6207, 'the other request\'s discussion is linked');
    assert.match(sent[0].content, /^Request \[#6210\].* asks for the same thing as this one\./);
    assert.equal(sent[1].thread.ref, 6210);
    assert.match(sent[1].content, /^Done: a vote on closing this one as a duplicate is open\./);
    const { rows: [message] } = await pool.query('SELECT metadata FROM chat_messages WHERE id = $1', [messageId]);
    assert.deepEqual(message.metadata.homeroomBot.actions, [], 'the buttons go for everyone');
  });

  await t.test('Fold it in, and Build this one first, are lines in both discussions', async () => {
    const fold = await tap({
      choice: 'yes',
      args: { issueNumber: 6211, other: 6207, overlap: 'part_of' },
    });
    assert.deepEqual(fold.out, { decision: 'done' });
    assert.equal(fold.decisions.length, 0, 'nothing is built or closed by it');
    assert.equal(sent.length, 2);
    assert.match(sent[0].content, /chose to fold it in/);
    assert.equal(sent[0].thread.ref, 6207);
    assert.match(sent[1].content, /^Done: it is noted in both discussions that this one is part of #6207\./);

    const first = await tap({ choice: 'first', args: { issueNumber: 6212, other: 6207, overlap: 'overlaps' } });
    assert.deepEqual(first.out, { decision: 'done' });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].thread.ref, 6207);
    assert.match(sent[0].content, /chose to build \[#6212\].* first, before this one/);
    assert.match(sent[1].content, /^Done: it is noted in both discussions that this one is built first, before #6207\./);
  });

  await t.test('Keep separate says nothing, and the buttons go', async () => {
    const { out } = await tap({ choice: 'no', args: { issueNumber: 6213, other: 6207, overlap: 'overlaps' } });
    assert.deepEqual(out, { decision: 'declined' });
    assert.equal(sent.length, 0, 'nothing more is said');
  });

  await t.test('the third choice is refused for any other offer', async () => {
    const card = await voice.threadOffer(pool, { app, kind: 'close_request', forUserId: evan.id, args: { issueNumber: 6207 } });
    const { rows: [msg] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
       VALUES ($1, $2, 'note', 'message', $3, 'issue', $4) RETURNING id`,
      [app.id, bot.id, JSON.stringify({ homeroomBot: { kind: 'voice', ...card.metadata } }), 6207],
    );
    await voice.tieThreadOffer(pool, card.id, msg.id);
    const replies = { async tapVoiceOffer() { throw new Error('never reached'); } };
    const out = await voice.decideOffer(pool, {}, { app, user: evan, messageId: msg.id, choice: 'first', deps: { replies } });
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
  });
});
