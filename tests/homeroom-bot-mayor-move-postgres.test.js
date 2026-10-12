'use strict';

// #4239: a request about Homeroom itself, filed on a project's board, moved
// to Homeroom's own board by its requester's tap, against the full
// PostgreSQL schema. GitHub is a stub that records what it is asked to do.
// What is checked: the offer (from the chat model's offer_move_request, and
// from a triage's `platform` flag in the person DM), and what the tap does:
// the request filed on Homeroom's board with its original words and a
// footer, a link left on the original, and the original closed at once only
// when its author tapped and nobody else took part, else put to a vote.
// Beside it, the bot's other offers about where a request belongs: a vote on
// closing one a triage found already done, and "Did you mean ...?" before a
// request is filed on a project named inexactly (#4501).
//
// Run with: node --test tests/homeroom-bot-mayor-move-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const systemMessages = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushSessionUpdate() {},
    async sendSystemMessage(_pool, appId, content, _type, _meta, thread) {
      systemMessages.push({ appId, content, thread });
      return { id: systemMessages.length };
    },
    pushIssueUpdate() {},
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};
const githubId = require.resolve('../src/services/github');
const gh = { created: [], comments: [], closed: [], issues: new Map(), threads: new Map() };
const githubStub = {
  isEnabled: () => true,
  async getIssue(owner, repo, number) {
    const issue = gh.issues.get(`${repo}#${number}`);
    if (!issue) throw Object.assign(new Error('Not Found'), { status: 404 });
    return issue;
  },
  async fetchPublicIssue(_owner, _repo, number) { return { issue: { number, title: `Issue ${number}`, state: 'open' } }; },
  async fetchIssueComments(_owner, repo, number) { return { comments: gh.threads.get(`${repo}#${number}`) || [], truncated: false }; },
  async createIssue(owner, repo, { title, body }) {
    gh.created.push({ owner, repo, title, body });
    return { number: 900 + gh.created.length, title };
  },
  async createIssueComment(owner, repo, number, body) { gh.comments.push({ repo, number, body }); return { id: 1 }; },
  async closeIssue(owner, repo, number) { gh.closed.push({ repo, number }); return {}; },
  noteIssueCreated() {},
  noteIssuesClosed() {},
  invalidateIssuesCache() {},
  safeMention: (s) => s,
};
require.cache[githubId] = {
  id: githubId, filename: githubId, loaded: true,
  exports: new Proxy(githubStub, { get: (t, k) => (k in t ? t[k] : async () => null) }),
};

const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const mayor = require('../src/services/homeroom-bot-mayor');
const homeroomBot = require('../src/services/homeroom-bot');

const CONFIG = { openrouterApiBase: 'https://openrouter.test/api/v1', openrouterOrigin: 'https://test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };

function scripted(steps) {
  let i = 0;
  return async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const calls = step.map((c, n) => ({
      id: `call_${i}_${n}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1] || {}) },
    }));
    return {
      content: '', toolCalls: calls,
      assistantMessage: { role: 'assistant', content: null, tool_calls: calls },
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.0001 },
    };
  };
}

test('#4239: moving a request about Homeroom itself to Homeroom\'s own board', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_move_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

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
  async function project(slug, owner, { members = [], visibility = 'public', title = null } = {}) {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, $5, 'public') RETURNING id`,
      [title || slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), slug, owner.id,
        `https://github.com/usernode-bot/${slug}`, visibility],
    );
    const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
    for (const member of [owner, ...members]) {
      await pool.query(
        'INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [app.community_id, member.id],
      );
    }
    return app;
  }

  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  const homeroom = await project('usernode-2d5619', sam, { members: [ada], title: 'Homeroom' });
  const ears = await project('ear-trainer', ada, { members: [sam] });
  await setting('homeroom_bot_mode', 'shadow');
  const settings = await homeroomBot.readSettings(pool);
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
  const workflow = { governsKind: () => false, async fileProposal() {} };

  // A request Ada filed on Ear Trainer, about Homeroom's header.
  async function request(n, { by = ada, title = `Header ${n}`, body = 'The header frame covers the app.' } = {}) {
    gh.issues.set(`ear-trainer#${n}`, { number: n, state: 'open', title, body, user: { login: 'usernode-bot' } });
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
       VALUES ($1, $2, $3, $4, 'general', '{}', $5)`,
      [ears.id, n, title, body, by.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, $4)
       ON CONFLICT (app_id, issue_number) DO NOTHING`,
      [ears.id, n, ada.id, title],
    );
  }
  async function turn(text, steps) {
    const { message } = await conversations.sendMessage(pool, ada, opened.conversationId, { content: text });
    return mayor.runDmTurn(pool, CONFIG, {
      bot, user: ada, settings, conversationId: opened.conversationId, message,
      deps: {
        chat: scripted(steps), apiKey: 'sk-test', sleep: async () => {}, schedule: () => {},
        openMcp: async () => { throw new Error('no grant'); }, domain: 'app.test',
      },
    });
  }
  async function read(sent) {
    return conversations.getMessage(pool, ada, opened.conversationId, sent.messageId);
  }
  const actionOf = async (messageId) => (await pool.query(
    'SELECT * FROM homeroom_bot_dm_actions WHERE message_id = $1', [messageId],
  )).rows[0];
  const tap = (action, choice, who = ada) => mayor.decideOfferTap(pool, CONFIG, {
    user: who, actionId: action.id, choice, deps: { bot, workflow, domain: 'app.test' },
  });

  await t.test('the chat model offers it; Move it to Homeroom by its untouched author files it there and closes the original', async () => {
    await request(6, { title: 'Header covers the app' });
    const offered = await turn('the header covers my app, can you move this to homeroom?', [
      [['offer_move_request', { project: 'ear-trainer', number: 6, reason: 'The header is drawn by Homeroom' }]],
      [['reply', { text: 'Want me to move it?' }]],
    ]);
    const meta = (await read(offered)).metadata.homeroomBot;
    assert.deepEqual(meta.actions.map((a) => a.label), ['Move it to Homeroom', 'Keep it here']);
    assert.equal(meta.question, 'Move this request from Ear trainer to Homeroom\'s own board?');
    const action = await actionOf(offered.messageId);
    assert.deepEqual([action.kind, action.source_issue_number, action.app_id, action.title],
      ['move_request', 6, ears.id, 'Header covers the app']);
    assert.equal(meta.actionId, Number(action.id));
    assert.equal(gh.created.length, 0, 'nothing moves before the tap');

    assert.deepEqual(await tap(action, 'yes'), { ok: true, choice: 'yes', label: 'Move it to Homeroom' });
    assert.equal(gh.created.length, 1);
    const filed = gh.created[0];
    assert.equal(filed.repo, 'usernode-2d5619', 'on Homeroom\'s own repository');
    assert.equal(filed.title, 'Header covers the app');
    assert.match(filed.body, /^The header frame covers the app\.\n\n---\nMoved from Ear trainer #6 \(https:\/\/app\.test\/#app\/ear-trainer\/dev\/issues\/6\), first asked by @ada_\d+\.$/);
    const { rows: [twin] } = await pool.query(
      'SELECT created_by FROM issues WHERE app_id = $1 AND github_issue_number = $2', [homeroom.id, 901],
    );
    assert.equal(twin.created_by, ada.id, 'credited to its author');
    const { rows: [asker] } = await pool.query(
      'SELECT user_id FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = 901', [homeroom.id],
    );
    assert.equal(asker.user_id, ada.id, 'and its news reaches her');
    assert.deepEqual(gh.comments.map((c) => [c.repo, c.number]), [['ear-trainer', 6]]);
    assert.match(gh.comments[0].body, /^Moved to Homeroom's own board as request #901: https:\/\/app\.test\/#app\/usernode-2d5619\/dev\/issues\/901/);
    assert.deepEqual(gh.closed, [{ repo: 'ear-trainer', number: 6 }], 'nobody else is in it, so it closes at once');
    const { rows: [original] } = await pool.query(
      'SELECT status FROM issues WHERE app_id = $1 AND github_issue_number = 6', [ears.id],
    );
    assert.equal(original.status, 'closed');
    const { rows: votes } = await pool.query('SELECT id FROM issues WHERE kind = \'close_issue\'');
    assert.equal(votes.length, 0, 'no vote needed');
    const decided = await pool.query('SELECT status, issue_number FROM homeroom_bot_dm_actions WHERE id = $1', [action.id]);
    assert.deepEqual(decided.rows[0], { status: 'done', issue_number: 901 });
    const { rows: [ack] } = await pool.query(
      'SELECT content FROM conversation_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [opened.conversationId],
    );
    assert.match(ack.content, /^\*\*Homeroom\*\* · request #901: Header covers the app\n\nMoved\. It's on Homeroom's own board now, with a link to it left on the original\. I closed the original on Ear trainer, since nobody else had joined in on it\.$/);
    assert.equal((await tap(action, 'yes')).status, 409, 'decided once');
    assert.equal(gh.created.length, 1);
  });

  await t.test('somebody else took part: the original is put to its group\'s vote, never closed', async () => {
    await request(7);
    // Sam wrote in its discussion.
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref)
       VALUES ($1, $2, 'Same here', 'message', 'issue', 7)`,
      [ears.id, sam.id],
    );
    const offered = await turn('move #7 too', [
      [['offer_move_request', { project: 'ear-trainer', number: 7, reason: 'Homeroom header' }]],
      [['reply', { text: 'Tap below.' }]],
    ]);
    const closedBefore = gh.closed.length;
    assert.equal((await tap(await actionOf(offered.messageId), 'yes')).ok, true);
    assert.equal(gh.closed.length, closedBefore, 'not closed');
    const { rows: [vote] } = await pool.query(
      `SELECT title, payload, created_by, status FROM issues WHERE app_id = $1 AND kind = 'close_issue'`, [ears.id],
    );
    assert.equal(vote.status, 'open');
    assert.equal(vote.created_by, ada.id);
    assert.equal(vote.payload.issueNumber, 7);
    assert.match(vote.payload.reason, /^Moved to Homeroom's own board as request #902 \(https:\/\/app\.test\/#app\/usernode-2d5619\/dev\/issues\/902\): it is about the Homeroom platform itself, not Ear trainer\.$/);
    assert.ok(systemMessages.some((m) => m.thread?.type === 'issue' && m.thread.ref === 7 && /proposed closing issue #7/.test(m.content)));
    const { rows: [ack] } = await pool.query(
      'SELECT content FROM conversation_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [opened.conversationId],
    );
    assert.match(ack.content, /The original on Ear trainer stays open until its group votes on closing it, because others wrote in its discussion\.$/);
  });

  await t.test('each kind of involvement, and a comment on GitHub, sends it to a vote', async () => {
    const move = require('../src/services/homeroom-bot-move');
    const repo = { owner: 'usernode-bot', repo: 'ear-trainer' };
    await request(8);
    const involved = () => move.othersInvolved(pool, { app: ears, repo, issueNumber: 8, authorId: ada.id, bot });
    assert.deepEqual(await involved(), [], 'untouched');
    // Its author's own claim, and the bot's own comment, are nobody else.
    await pool.query('INSERT INTO issue_claims (app_id, github_issue_number, user_id) VALUES ($1, 8, $2)', [ears.id, ada.id]);
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref) VALUES ($1, $2, 'Hi', 'message', 'issue', 8)`,
      [ears.id, bot.id],
    );
    gh.threads.set('ear-trainer#8', [{ id: 55, author: 'usernode-bot', body: 'I left this for the group.' }]);
    assert.deepEqual(await involved(), []);
    await pool.query('INSERT INTO issue_claims (app_id, github_issue_number, user_id) VALUES ($1, 8, $2)', [ears.id, sam.id]);
    assert.deepEqual(await involved(), ['somebody else claimed it']);
    await pool.query('DELETE FROM issue_claims WHERE user_id = $1', [sam.id]);
    const { rows: [twin] } = await pool.query('SELECT id FROM issues WHERE app_id = $1 AND github_issue_number = 8', [ears.id]);
    await pool.query('INSERT INTO issue_votes (issue_id, user_id, vote) VALUES ($1, $2, \'up\')', [twin.id, sam.id]);
    assert.deepEqual(await involved(), ['others voted on it']);
    await pool.query('DELETE FROM issue_votes');
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues) VALUES ($1, $2, 'active', ARRAY[8])`,
      [ears.id, sam.id],
    );
    assert.deepEqual(await involved(), ['a proposal is linked to it']);
    await pool.query('DELETE FROM chat_sessions WHERE app_id = $1', [ears.id]);
    gh.threads.set('ear-trainer#8', [{ id: 56, author: 'someone-else', body: 'Me too' }]);
    assert.deepEqual(await involved(), ['others commented on it']);
    gh.threads.delete('ear-trainer#8');
  });

  await t.test('a requester who did not file it moves it, and the original goes to a vote', async () => {
    await request(9, { by: sam });
    const offered = await turn('move #9', [
      [['offer_move_request', { project: 'ear-trainer', number: 9, reason: 'Homeroom header' }]],
      [['reply', { text: 'Tap below.' }]],
    ]);
    const closedBefore = gh.closed.length;
    assert.equal((await tap(await actionOf(offered.messageId), 'yes')).ok, true);
    assert.equal(gh.closed.length, closedBefore, 'never closed for somebody else');
    assert.match(gh.created.at(-1).body, /first asked by @sam_\d+\.$/, 'and credited to who first asked');
    const { rows } = await pool.query(
      `SELECT 1 FROM issues WHERE app_id = $1 AND kind = 'close_issue' AND (payload->>'issueNumber')::int = 9`, [ears.id],
    );
    assert.equal(rows.length, 1);
  });

  await t.test('Keep it here moves nothing; what cannot be moved is not offered', async () => {
    await request(10);
    const offered = await turn('move #10', [
      [['offer_move_request', { project: 'ear-trainer', number: 10, reason: 'Homeroom header' }]],
      [['reply', { text: 'Tap below.' }]],
    ]);
    const before = gh.created.length;
    assert.deepEqual(await tap(await actionOf(offered.messageId), 'no'), { ok: true, choice: 'no', label: 'Keep it here' });
    assert.equal(gh.created.length, before);
    assert.equal((await actionOf(offered.messageId)).status, 'declined');

    const move = require('../src/services/homeroom-bot-move');
    // Somebody else's request, one on Homeroom's own board, and a closed one.
    await request(11, { by: sam });
    await pool.query('DELETE FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = 11', [ears.id]);
    const stranger = await user('cy');
    assert.equal((await move.moveGate(pool, { app: ears, issueNumber: 11, user: stranger })).code, 'not_theirs');
    // The project's creator may move it (HOMESTEAD #33 and #35 waited on a
    // requester who never tapped), and so may one of its admins.
    assert.equal((await move.moveGate(pool, { app: ears, issueNumber: 11, user: ada })).ok, true, 'its creator');
    await pool.query('INSERT INTO app_admins (app_id, user_id) VALUES ($1, $2)', [ears.id, stranger.id]);
    require('../src/services/app-admins').invalidateAppAdmins(ears.id);
    assert.equal((await move.moveGate(pool, { app: ears, issueNumber: 11, user: stranger })).ok, true, 'an admin');
    assert.equal((await move.moveGate(pool, { app: homeroom, issueNumber: 1, user: ada })).code, 'already_there');
    await request(12);
    gh.issues.get('ear-trainer#12').state = 'closed';
    assert.equal((await move.moveGate(pool, { app: ears, issueNumber: 12, user: ada })).code, 'closed');
    const refused = await turn('move #12', [
      [['offer_move_request', { project: 'ear-trainer', number: 12, reason: 'x' }]],
      [['reply', { text: 'I can\'t move that one.' }]],
    ]);
    assert.equal((await read(refused)).metadata.homeroomBot.kind, 'chat', 'no offer under it');
  });

  await t.test('a triage that says it is about Homeroom tells the requester and offers the move once', async () => {
    await request(13, { title: 'Invite message wording' });
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, reason, about_platform)
       VALUES ($1, 13, 'live', 'person', $2, TRUE)`,
      [ears.id, 'The invite message is Homeroom\'s'],
    );
    const post = (postId) => dm.relayIssuePost({
      pool, app: ears, issueNumber: 13, kind: 'person', postId, bot,
      dm: { reason: 'The invite message is written by Homeroom.', platform: true },
    });
    const told = await post(501);
    const person = await read(told);
    assert.match(person.content, /This is about Homeroom itself rather than Ear trainer/);
    // One story: the verdict and its offer are one message, with no Go ahead.
    assert.deepEqual(person.metadata.homeroomBot.actions.map((a) => a.label), ['Move it to Homeroom', 'Keep it here'], 'no Go ahead');
    const { rows: offers } = await pool.query(
      `SELECT * FROM homeroom_bot_dm_actions WHERE kind = 'move_request' AND source_issue_number = 13`,
    );
    assert.equal(offers.length, 1);
    assert.equal(offers[0].conversation_id, opened.conversationId);
    assert.equal(Number(offers[0].message_id), Number(person.id), 'the offer is the verdict\'s own message');
    assert.equal(person.metadata.homeroomBot.actionId, Number(offers[0].id));
    await post(502);
    const { rows: again } = await pool.query(
      `SELECT 1 FROM homeroom_bot_dm_actions WHERE kind = 'move_request' AND source_issue_number = 13`,
    );
    assert.equal(again.length, 1, 'offered once');

    // The chat model sees why it was left.
    const detail = await mayor.requestDetail(pool, { user: ada, project: 'ear-trainer', number: 13, settings });
    assert.equal(detail.recentLooks[0].aboutHomeroom, true);
  });

  await t.test('#4501: a project named inexactly is asked about on the card; its exact name files as before', async () => {
    const guessed = await read(await turn('file this on ear trainr: show interval names', [
      [['offer_request', { project: 'ear-trainer', named: 'Ear Trainr', title: 'Show interval names', details: 'Name each interval.' }]],
      [['reply', { text: 'Here is what I would file.' }]],
    ]));
    const meta = guessed.metadata.homeroomBot;
    assert.equal(meta.question, 'Did you mean Ear trainer?');
    assert.deepEqual(meta.actions.map((a) => [a.id, a.label, a.type]), [
      ['yes', 'Yes, file it', 'server'], ['other', 'No, another app', 'prompt'], ['open_app', 'Open Ear trainer', 'open'],
    ]);
    assert.equal(meta.actions[2].target, '#app/ear-trainer/app');
    assert.match(guessed.content, /\*\*Ear trainer\*\* · new request: Show interval names/, 'the card still names the request');

    const exact = await read(await turn('file this on ear trainer: show chord names', [
      [['offer_request', { project: 'ear-trainer', named: 'ear-trainer', title: 'Show chord names', details: 'Name each chord.' }]],
      [['reply', { text: 'Here is what I would file.' }]],
    ]));
    assert.equal(exact.metadata.homeroomBot.question, 'File this as a request on Ear trainer?');
    assert.deepEqual(exact.metadata.homeroomBot.actions.map((a) => a.label), ['File it', 'Not now']);

    // Yes files it, as File it does.
    const action = await actionOf(guessed.id);
    const went = await tap(action, 'yes');
    assert.equal(went.ok, true);
    assert.ok(gh.created.some((c) => c.repo === 'ear-trainer' && c.title === 'Show interval names'));
  });

  await t.test('a triage that finds a request already done tells the requester, offers a vote on closing it once, and a tap opens it', async () => {
    await request(14, { title: 'Show my votes' });
    const post = (postId, kind = 'person') => dm.relayIssuePost({
      pool, app: ears, issueNumber: 14, kind, postId, bot,
      dm: { reason: 'It is there already: open Profile, then Your votes.', done: true },
    });
    const told = await read(await post(601));
    // One story: one message, the verdict with its offer's buttons.
    assert.match(told.content, /This looks done already: It is there already: open Profile, then Your votes\.$/);
    assert.deepEqual(told.metadata.homeroomBot.actions.map((a) => a.label), ['Propose to close', 'Tell me what\'s missing'],
      'no Go ahead: there is nothing to decide');
    const offers = async () => (await pool.query(
      `SELECT * FROM homeroom_bot_dm_actions WHERE kind = 'close_request' AND source_issue_number = 14`,
    )).rows;
    const [offer] = await offers();
    assert.equal(offer.conversation_id, opened.conversationId);
    assert.equal(offer.details, 'It is there already: open Profile, then Your votes.', 'the vote\'s reason');
    assert.equal(Number(offer.message_id), Number(told.id), 'the offer is the verdict\'s own message');
    await post(602, 'empty');
    assert.equal((await offers()).length, 1, 'offered once');

    const went = await tap(offer, 'yes');
    assert.equal(went.ok, true);
    const { rows: votes } = await pool.query(
      `SELECT created_by, payload FROM issues WHERE app_id = $1 AND kind = 'close_issue' AND (payload->>'issueNumber')::int = 14`,
      [ears.id],
    );
    assert.equal(votes.length, 1, 'the request\'s own close vote');
    assert.equal(Number(votes[0].created_by), Number(ada.id), 'proposed by them');

    // Not offered again while that vote is open, to anybody.
    await request(15, { title: 'Show my votes again' });
    await pool.query(
      `INSERT INTO issues (app_id, title, description, kind, payload, created_by, status)
       VALUES ($1, 'Close #15', 'x', 'close_issue', '{"issueNumber":15}', $2, 'open')`,
      [ears.id, sam.id],
    );
    await dm.relayIssuePost({ pool, app: ears, issueNumber: 15, kind: 'person', postId: 603, bot, dm: { reason: 'Done.', done: true } });
    assert.equal((await pool.query(
      `SELECT 1 FROM homeroom_bot_dm_actions WHERE kind = 'close_request' AND source_issue_number = 15`,
    )).rows.length, 0);
  });
});
