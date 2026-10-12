'use strict';

// The Homeroom bot's voice (src/services/homeroom-bot-voice.js) against the
// full PostgreSQL schema, with the model scripted:
//
//   - asked to change its own change in the change's discussion, it queues
//     the change as an ask (its follow-up goes first in the queue) and says
//     so in one reply there, quoting who asked;
//   - mentioned in a project's chat, it answers in a reply thread under the
//     message, and offers to file a request with File it / Not now, which
//     only the person it was offered to decides, once;
//   - a burst is one turn: a second turn while one holds the place is
//     refused, and a turn reads only what is new since the last;
//   - when the change's update ends, the people who asked hear what came of
//     it, where they asked (reportFollowUp), in the plain words when no
//     model answers.
//
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const voice = require('../src/services/homeroom-bot-voice');

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
  const name = `hrbot_voice_${crypto.randomBytes(6).toString('hex')}`;
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

/** A model that answers each request of a turn with the next step of `script`. */
function scripted(script) {
  const seen = [];
  let i = 0;
  const chat = async (req) => {
    seen.push(req);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (typeof step === 'function') return step(req);
    if (step.tool) {
      return {
        content: '',
        toolCalls: [{ id: `call${i}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }],
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 },
      };
    }
    return { content: step.text || '', toolCalls: [], usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 } };
  };
  return { chat, seen };
}

test('the voice on the real schema', { timeout: 180000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  const homeroomBot = await user('homeroom_bot', { synthetic: true });
  const evan = await user('evan');
  const sam = await user('sam');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Todo List', 'todo-list', 'running', $1, 'https://github.com/usernode-bot/todo-list', 'public', 'public')
     RETURNING id`,
    [evan.id],
  );
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
  if (app.community_id != null) {
    await pool.query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`,
      [app.community_id, evan.id, sam.id],
    );
  }
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'live')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  await pool.query(
    'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 12, $2, $3)',
    [app.id, evan.id, 'Blue header'],
  );
  const { rows: [change] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, linked_issues, promoted_at, pr_number)
     VALUES ($1, $2, 'dev/homeroom_bot-blue', 'promoted', 'Blue header', $3, NOW(), 31) RETURNING id`,
    [app.id, homeroomBot.id, [12]],
  );

  const sent = [];
  const broadcasts = [];
  const ws = {
    async sendBotMessage(p, appId, { user: from, content, metadata = null, thread }) {
      const { rows: [row] } = await p.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
         VALUES ($1, $2, $3, 'message', $4, $5, $6) RETURNING id, created_at`,
        [appId, from.id, content, JSON.stringify(metadata || {}), thread.type, thread.ref],
      );
      sent.push({ id: row.id, content, metadata, thread });
      return { id: row.id, createdAt: row.created_at };
    },
    broadcast(appId, frame) { broadcasts.push(frame); },
    async broadcastThreadSummary() {},
  };
  const notifications = { async createMentionNotifications() { return []; }, async hydrateAndPush() {} };
  const say = async (who, content, thread = null, metadata = {}) => (await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, $3, 'message', $4, $5, $6) RETURNING id`,
    [app.id, who.id, content, JSON.stringify(metadata), thread?.type || null, thread?.ref ?? null],
  )).rows[0].id;
  // Every turn runs when the test says so, not after a timer.
  const due = [];
  const base = (model) => ({
    ws, notifications, chat: model.chat, apiKey: 'test-key', noPlatform: true, schedule: (fn) => { due.push(fn); return true; },
  });
  const runDue = async () => {
    const out = [];
    while (due.length) out.push(await due.shift()());
    return out;
  };

  await t.test('asked to change its own change, it queues the ask and says so where it was asked', async () => {
    sent.length = 0;
    const model = scripted([
      { tool: 'update_change', args: { instruction: 'Make the header blue on every page, not only the home page' } },
      { tool: 'reply', args: { text: 'Got it: I\'ll make the header blue on every page. Updating it resets its approvals, so the group looks again.' } },
    ]);
    const place = { type: 'session', ref: change.id };
    const id = await say(evan, 'Can the header be blue on every page, not just home?', place);
    const heard = await voice.noteMessage(pool, {}, { appId: app.id, messageId: id, deps: base(model) });
    assert.deepEqual(heard, { scheduled: true, why: 'own_change' });
    const [turn] = await runDue();
    assert.equal(turn.outcome, 'replied');

    const { rows: asks } = await pool.query('SELECT * FROM homeroom_bot_change_asks WHERE session_id = $1', [change.id]);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].status, 'queued');
    assert.equal(asks[0].instruction, 'Make the header blue on every page, not only the home page');
    assert.equal(asks[0].asker_id, evan.id);
    assert.equal(asks[0].message_id, id, 'where it was asked, which is where the answer goes');
    assert.equal(asks[0].place_type, 'session');
    const { rows: queue } = await pool.query('SELECT issue_number, reason, priority FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
    assert.deepEqual(queue, [{ issue_number: 12, reason: 'voice_update', priority: 0 }], 'its follow-up goes first');

    assert.equal(sent.length, 1, 'one reply');
    assert.deepEqual(sent[0].thread, place, 'in the change\'s discussion');
    assert.equal(sent[0].metadata.quote.refMsgId, id, 'quoting who it answers');
    assert.equal(sent[0].metadata.homeroomBot.kind, 'voice');
    assert.doesNotMatch(sent[0].content, /^Homeroom bot/);
    // The model saw the place and the facts, and only this project.
    const first = model.seen[0];
    assert.match(first.messages[1].content, /Can the header be blue on every page/);
    assert.match(first.messages[1].content, /built by you/);
    assert.ok(first.tools.some((tl) => tl.function.name === 'update_change'));

    const { rows: [record] } = await pool.query(
      `SELECT outcome, place_key, reply_message_id, through_message_id, tools FROM homeroom_bot_voice_turns ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(record.outcome, 'replied');
    assert.equal(record.place_key, `${app.id}:session:${change.id}`);
    assert.equal(record.reply_message_id, sent[0].id);
    assert.deepEqual(record.tools, ['update_change', 'reply']);

    // The same message is not answered again: the next turn reads nothing new.
    due.push(() => voice.runPlace(pool, {}, { appId: app.id, place, deps: base(model) }));
    const [again] = await runDue();
    assert.equal(again.outcome, 'quiet');
    assert.equal(sent.length, 1);
  });

  await t.test('words a DM passed on as an ask are the follow-up\'s, not answered again', async () => {
    const place = { type: 'session', ref: change.id };
    const id = await say(sam, 'Make the footer smaller too', place);
    const asked = await voice.recordAsk(pool, {
      appId: app.id, sessionId: change.id, issueNumber: 12, askerId: sam.id, instruction: 'Make the footer smaller too',
      source: 'dm', place, messageId: id, deps: base(scripted([{ text: 'x' }])),
    });
    assert.ok(asked.id);
    assert.equal(asked.running, false);
    const heard = await voice.noteMessage(pool, {}, { appId: app.id, messageId: id, deps: base(scripted([{ text: 'x' }])) });
    assert.deepEqual(heard, { scheduled: false, why: 'queued_as_ask' });
  });

  await t.test('mentioned in the project\'s chat, it answers in a reply thread and offers to file it', async () => {
    sent.length = 0;
    broadcasts.length = 0;
    // No change of its own is up here for this test.
    await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [change.id]);
    const model = scripted([
      { tool: 'offer_request', args: { title: 'Sort the list by due date', details: 'Could the list sort by due date?' } },
      { tool: 'reply', args: { text: 'That sounds like a good request. I drafted it: tap File it under this to send it to the group.' } },
    ]);
    const id = await say(sam, '@Homeroom bot could the list sort by due date?');
    const quiet = await voice.noteMessage(pool, {}, {
      appId: app.id, messageId: await say(sam, 'thanks everyone'), hint: { content: 'thanks everyone', thread: null, quoted: false }, deps: base(model),
    });
    assert.deepEqual(quiet, { scheduled: false, why: 'not_addressed' }, 'people talking to each other read nothing');
    const heard = await voice.noteMessage(pool, {}, {
      appId: app.id, messageId: id, hint: { content: '@Homeroom bot could the list sort by due date?', thread: null, quoted: false }, deps: base(model),
    });
    assert.deepEqual(heard, { scheduled: true, why: 'mentioned' });
    await runDue();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].thread, { type: 'message', ref: id }, 'in a reply thread under the message, not in the room\'s stream');
    const offer = sent[0].metadata.homeroomBot.offer;
    assert.equal(offer.kind, 'file_request');
    assert.equal(offer.status, 'open');
    assert.equal(offer.forUserId, sam.id);
    assert.deepEqual(sent[0].metadata.homeroomBot.actions.map((a) => a.label), ['File it', 'Not now']);
    const { rows: [row] } = await pool.query('SELECT kind, args, status, message_id FROM homeroom_bot_voice_offers WHERE id = $1', [offer.id]);
    assert.equal(row.message_id, sent[0].id);
    assert.equal(row.args.title, 'Sort the list by due date');
    assert.equal(row.args.messageId, id);

    // Only the person it was offered to decides it, and only once.
    const other = await voice.decideOffer(pool, {}, { app, user: evan, messageId: sent[0].id, choice: 'yes', deps: { ws } });
    assert.equal(other.status, 403);
    // File it, with the filing itself stood in for.
    const filed = [];
    const chatSvc = {
      ...require('../src/services/homeroom-bot-chat'),
      async fileMessage(p, cfg, args) { filed.push(args); return { messageId: args.messageId, kind: 'filed', issueNumber: 13 }; },
      pushCard() {},
    };
    const yes = await voice.decideOffer(pool, {}, { app, user: sam, messageId: sent[0].id, choice: 'yes', deps: { ws, chatSvc } });
    assert.equal(yes.ok, true);
    assert.equal(yes.decision, 'done');
    assert.equal(filed.length, 1);
    assert.equal(filed[0].title, 'Sort the list by due date');
    assert.equal(filed[0].messageId, id, 'the chip goes on their message');
    assert.match(sent[sent.length - 1].content, /Filed as request #13/);
    const again = await voice.decideOffer(pool, {}, { app, user: sam, messageId: sent[0].id, choice: 'no', deps: { ws } });
    assert.equal(again.status, 409, 'decided once');
    const { rows: [message] } = await pool.query('SELECT metadata FROM chat_messages WHERE id = $1', [sent[0].id]);
    assert.equal(message.metadata.homeroomBot.offer.status, 'done');
    assert.deepEqual(message.metadata.homeroomBot.actions, [], 'the buttons go for everybody');
    assert.ok(broadcasts.some((f) => f.type === 'chat_message_updated' && f.id === sent[0].id));
  });

  await t.test('switched off in chats, a mention is the old path\'s and the voice says nothing', async () => {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_voice_chat', 'off')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const id = await say(sam, '@Homeroom bot hello?');
    const heard = await voice.noteMessage(pool, {}, { appId: app.id, messageId: id, deps: base(scripted([{ text: 'x' }])) });
    assert.deepEqual(heard, { scheduled: false, why: 'switched_off' });
    assert.equal(await voice.enabledFor(pool, 'chat'), false);
    assert.equal(await voice.enabledFor(pool, 'session'), true);
    await pool.query(`DELETE FROM platform_settings WHERE key = 'homeroom_bot_voice_chat'`);
  });

  await t.test('one turn at a time in one place', async () => {
    const turns = await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_voice_turns WHERE finished_at IS NULL');
    assert.equal(turns.rows[0].n, 0, 'every turn let go of its place');
    await pool.query(
      `INSERT INTO homeroom_bot_voice_turns (app_id, place_type, place_ref, place_key) VALUES ($1, 'chat', NULL, $2)`,
      [app.id, `${app.id}:chat:`],
    );
    const busy = await voice.runPlace(pool, {}, { appId: app.id, place: { type: 'chat', ref: null }, deps: base(scripted([{ text: 'x' }])) });
    assert.deepEqual(busy, { outcome: 'busy' });
    await pool.query('UPDATE homeroom_bot_voice_turns SET finished_at = NOW() WHERE finished_at IS NULL');
  });

  await t.test('when the update ends, the people who asked hear what came of it, where they asked', async () => {
    sent.length = 0;
    await pool.query(`UPDATE chat_sessions SET status = 'promoted' WHERE id = $1`, [change.id]);
    const runTag = 'fu-test-1';
    const asks = await voice.takeAsks(pool, { sessionId: change.id, runTag });
    assert.equal(asks.length, 2, 'both asks waiting on it, oldest first');
    assert.deepEqual(asks.map((a) => a.asker), [evan.username, sam.username]);
    const { rows: [session] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [change.id]);
    // No model answers: the plain words go.
    const failing = { chat: async () => { throw Object.assign(new Error('down'), { code: 'provider_error' }); }, sleep: async () => {} };
    const n = await voice.reportFollowUp(pool, {}, {
      app, session, bot: homeroomBot, asks,
      outcome: { action: 'revise', moved: true, summary: 'The header is blue on every page, and the footer is smaller.' },
      deps: { ws, notifications, apiKey: 'test-key', ...failing },
    });
    assert.equal(n, 1, 'both were asked in the change\'s discussion: one message there');
    assert.deepEqual(sent[0].thread, { type: 'session', ref: change.id });
    assert.equal(sent[0].content, 'Done: The header is blue on every page, and the footer is smaller.');
    assert.equal(sent[0].metadata.quote.author, sam.username, 'quoting the newest ask');
    await voice.finishAsks(pool, { runTag, runId: null });
    const { rows } = await pool.query('SELECT status FROM homeroom_bot_change_asks WHERE session_id = $1 ORDER BY id', [change.id]);
    assert.deepEqual(rows.map((r) => r.status), ['done', 'done']);
    assert.equal(await voice.asksWaiting(pool, change.id), false);
  });

  await t.test('an ask that keeps failing gives up after its tries, and one that never got going is not a try', async () => {
    const place = { type: 'session', ref: change.id };
    const id = await say(evan, 'Bigger buttons please', place);
    await pool.query(
      `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, asker_id, instruction, place_type, place_ref, message_id)
       VALUES ($1, $2, 12, $3, 'Make the buttons bigger', 'session', $2, $4)`,
      [app.id, change.id, evan.id, id],
    );
    await voice.takeAsks(pool, { sessionId: change.id, runTag: 'r1' });
    assert.deepEqual(await voice.releaseAsks(pool, { runTag: 'r1', refund: true }), [], 'refused: waits, untried');
    await voice.takeAsks(pool, { sessionId: change.id, runTag: 'r2' });
    assert.deepEqual(await voice.releaseAsks(pool, { runTag: 'r2' }), [], 'first failure: tried again');
    assert.equal(await voice.asksWaiting(pool, change.id), true);
    await voice.takeAsks(pool, { sessionId: change.id, runTag: 'r3' });
    const gaveUp = await voice.releaseAsks(pool, { runTag: 'r3' });
    assert.equal(gaveUp.length, 1, 'second failure: gives up, and the voice says so');
    assert.equal(gaveUp[0].asker, evan.username);
    assert.equal(await voice.asksWaiting(pool, change.id), false);
    // A merge drops whatever still waits.
    await pool.query(
      `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, instruction) VALUES ($1, $2, 12, 'x')`,
      [app.id, change.id],
    );
    await voice.dropAsks(pool, change.id);
    assert.equal(await voice.asksWaiting(pool, change.id), false);
  });

  await t.test('admins read its week in counts and codes, never anybody\'s words', async () => {
    // A turn that failed, with what failed on the way.
    await pool.query(
      `INSERT INTO homeroom_bot_voice_turns (app_id, place_type, place_ref, place_key, outcome, error, failures, rounds, finished_at)
       VALUES ($1, 'issue', 12, $2, 'failed', 'no_key', ARRAY['v1:rate_limited:429'], 1, NOW())`,
      [app.id, `${app.id}:issue:12`],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, instruction, source) VALUES ($1, $2, 12, 'Make the logo bigger', 'chat')`,
      [app.id, change.id],
    );
    const summary = await voice.voiceSummary(pool);
    assert.ok(summary.turns >= 3);
    assert.ok(summary.replied >= 2, 'the change\'s reply and the chat\'s');
    assert.equal(summary.failed, 1);
    assert.ok(summary.byPlace.session.replied >= 1);
    assert.ok(summary.byPlace.chat.replied >= 1);
    assert.equal(summary.byPlace.issue.failed, 1);
    assert.ok(summary.people >= 2);
    const failure = summary.recentFailures.find((f) => f.place === 'issue');
    assert.deepEqual({ ...failure, at: null }, {
      at: null, app: 'todo-list', place: 'issue', ref: 12, outcome: 'failed', error: 'no_key', failures: ['v1:rate_limited:429'], rounds: 1,
    });
    assert.equal(summary.asks.byStatus.queued, 1);
    assert.ok(summary.asks.byStatus.done >= 2);
    assert.equal(summary.asks.bySource.chat, 1);
    assert.deepEqual(summary.asks.waiting.map((w) => [w.change, w.status, w.asks]), [[change.id, 'queued', 1]]);
    assert.deepEqual(summary.offers.file_request, { done: 1 });
    assert.doesNotMatch(JSON.stringify(summary), /logo|header|due date|Sort the list/, 'never the words');
    // And it rides with the console's payload, which the connector reads.
    const payload = await require('../src/services/homeroom-bot').adminPayload(pool, {}, {});
    assert.equal(payload.voice.turns, summary.turns);
  });
});
