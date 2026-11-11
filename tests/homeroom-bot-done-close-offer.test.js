'use strict';

// #6321: when the bot finds a request already works, its note in the request's
// thread carries Propose to close and Keep it open for any member, whichever
// verdict said so. Nothing is filed until somebody taps, a tap opens the same
// close vote the request page opens with the tapper as its proposer, the first
// tap decides it for everybody, and every other offer stays its one person's.
// GitHub is a stub that records what it is asked to do.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-done-close-offer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Messages are real rows, because an offer is tied to its note's.
let messagePool = null;
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushSessionUpdate() {},
    pushIssueUpdate() {},
    broadcast() {},
    async sendSystemMessage(_pool, appId, content, type, meta, thread) {
      const { rows: [row] } = await messagePool.query(
        `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
         VALUES ($1, $2, 'system', $3, $4, $5) RETURNING id`,
        [appId, content, JSON.stringify(meta || {}), thread?.type || null, thread?.ref || null],
      );
      return { id: Number(row.id) };
    },
    async sendBotMessage(_pool, appId, message) {
      const { rows: [row] } = await messagePool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
         VALUES ($1, $2, $3, 'message', $4, $5, $6) RETURNING id`,
        [appId, message.user.id, message.content, JSON.stringify(message.metadata || {}), message.thread?.type || null, message.thread?.ref || null],
      );
      return { id: Number(row.id) };
    },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};
const githubId = require.resolve('../src/services/github');
const gh = { comments: [], issues: new Map() };
const githubStub = {
  isEnabled: () => true,
  async getIssue(_owner, repo, number) {
    const issue = gh.issues.get(`${repo}#${number}`);
    if (!issue) throw Object.assign(new Error('Not Found'), { status: 404 });
    return issue;
  },
  async fetchIssueComments() { return { comments: [], truncated: false }; },
  async createIssueComment(_owner, repo, number, body) {
    gh.comments.push({ repo, number, body });
    return { id: gh.comments.length, created_at: new Date().toISOString() };
  },
  safeMention: (s) => s,
};
require.cache[githubId] = {
  id: githubId, filename: githubId, loaded: true,
  exports: new Proxy(githubStub, { get: (t, k) => (k in t ? t[k] : async () => null) }),
};

const homeroomBot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const addressed = require('../src/services/homeroom-bot-addressed');
const realVoice = require('../src/services/homeroom-bot-voice');
const communities = require('../src/services/communities');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const machine = require('../src/workflow/bot-voice/machine.ts');

const CONFIG = { openrouterApiBase: 'https://openrouter.test/api/v1', openrouterOrigin: 'https://test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };
const REASON = 'Signed-out visitors can open the library and every recipe.';
const NOTE = `Already works: ${REASON} Anyone in the project can tap Propose to close below to start a vote, or reply here if something is missing.`;
// #6413: its requester or a decider asked to close it: same offer, no Go ahead.
const WITHDRAWN_NOTE = `Asked to close: ${REASON} Tap Propose to close below to start a vote. It stays open until the group votes for it, or reply here to keep it going.`;

// ── The note, with its database stubbed ──────────────────────────────────

async function noteFor(parsed, {
  openVotes = [], last = null, posted = { messageId: 500 }, relook = false, postRow = null, messageMeta = null,
} = {}) {
  const says = [];
  const queries = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      queries.push({ sql: s, params });
      if (/INSERT INTO bot_cards/.test(s)) return { rows: [{ id: 77 }] };
      if (/kind = 'close_issue'/.test(s)) return { rows: openVotes };
      // #6582: the post row an older step result left, and the note's own metadata.
      if (/SELECT thread_message_id FROM homeroom_bot_posts/.test(s)) return { rows: postRow ? [postRow] : [] };
      if (/SELECT metadata FROM chat_messages/.test(s)) return { rows: messageMeta ? [messageMeta] : [] };
      return { rows: [] };
    },
  };
  const real = {
    post: live.post, advanceSeen: live.advanceSeen, mentionTargets: live.mentionTargets,
    shouldSpeak: addressed.shouldSpeak, lastNoteText: addressed.lastNoteText,
  };
  live.post = async (args) => { says.push(args); return posted; };
  live.advanceSeen = async () => ({});
  live.mentionTargets = async () => [];
  addressed.shouldSpeak = async () => ({ speak: true });
  addressed.lastNoteText = async () => last;
  try {
    await homeroomBot.actOnVerdict({
      pool, config: {}, bot: { id: 2 }, app: { id: 1, slug: 'x', name: 'X' },
      repo: { owner: 'o', repo: 'r' }, issueNumber: 7, issue: { title: 'Open the library' },
      parsed: { reason: REASON, platform: false, done: true, ...parsed },
      decider: { requesterDecides: true }, relook,
      capSuppressed: null, runId: 3, seed: '', seedReadAt: 'now', postedAt: [], turnBudgetMs: 1000, model: 'm',
      deps: { github: {}, ws: {} },
    });
  } finally {
    Object.assign(live, { post: real.post, advanceSeen: real.advanceSeen, mentionTargets: real.mentionTargets });
    Object.assign(addressed, { shouldSpeak: real.shouldSpeak, lastNoteText: real.lastNoteText });
  }
  return { says, queries, offers: queries.filter((q) => /INSERT INTO bot_cards/.test(q.sql)) };
}

for (const verdict of ['person', 'empty']) {
  test(`a done ${verdict} note says it already works and carries the offer, for nobody in particular`, async () => {
    const { says, offers, queries } = await noteFor({ verdict });
    assert.equal(says.length, 1);
    assert.equal(says[0].kind, verdict);
    assert.equal(says[0].homeroomText, NOTE);
    assert.doesNotMatch(says[0].homeroomText, /couldn't find anything to build/);
    // GitHub's copy keeps plain words: it has no buttons.
    assert.equal(says[0].text, `Homeroom bot found this already works: ${REASON}\n\nAnyone in the project can propose to close it, or reply here if something is missing.`);
    assert.equal(says[0].dm.done, true, 'the requester\'s DM keeps its own close offer');
    const meta = says[0].metadata.homeroomBot;
    assert.equal(meta.kind, 'voice');
    assert.deepEqual(meta.offer, { id: 77, kind: 'close_request', status: 'open', forUserId: null });
    assert.deepEqual(meta.actions.map((a) => [a.id, a.label, a.style]), [
      ['yes', 'Propose to close', 'primary'], ['no', 'Keep it open', 'secondary'],
    ]);
    assert.equal(offers.length, 1);
    assert.equal(offers[0].params[1], 'close_request');
    assert.deepEqual(JSON.parse(offers[0].params[2]), { issueNumber: 7, title: 'Open the library', why: REASON });
    assert.equal(offers[0].params[3], null);
    assert.ok(queries.some((q) => /UPDATE bot_cards SET chat_message_id/.test(q.sql) && q.params[1] === 500), 'tied to the note');
  });

  test(`a done ${verdict} note adds no buttons while a close vote is open, and keeps its words`, async () => {
    const { says, offers } = await noteFor({ verdict }, { openVotes: [{ id: 9 }] });
    assert.equal(says[0].homeroomText, NOTE);
    assert.equal(says[0].metadata, undefined);
    assert.equal(offers.length, 0);
  });

  test(`an unchanged repeat of a done ${verdict} note says nothing and offers nothing, whichever verdict said it first`, async () => {
    for (const kind of ['person', 'empty']) {
      const { says, offers } = await noteFor({ verdict }, { relook: true, last: { kind, text: NOTE } });
      assert.equal(says.length, 0);
      assert.equal(offers.length, 0);
    }
  });

  test(`a done ${verdict} note that could not be posted drops its offer`, async () => {
    const { queries } = await noteFor({ verdict }, { posted: null });
    assert.ok(queries.some((q) => /DELETE FROM bot_cards/.test(q.sql) && q.params[0] === 77));
  });
}

// #6413: a read that says its requester (or a decider) asked to close it gets
// the same close offer, whichever of person or empty the read landed on.
for (const verdict of ['person', 'empty']) {
  test(`a withdrawn ${verdict} note offers the close vote and never Go ahead`, async () => {
    const { says, offers } = await noteFor({ verdict, done: false, withdrawn: true });
    assert.equal(says.length, 1);
    assert.equal(says[0].kind, verdict);
    assert.equal(says[0].homeroomText, WITHDRAWN_NOTE);
    assert.doesNotMatch(says[0].homeroomText, /couldn't find anything to build/);
    assert.doesNotMatch(says[0].homeroomText, /Go ahead/);
    // GitHub's copy says the same, without naming the button.
    assert.equal(says[0].text, `Homeroom bot was asked to close this: ${REASON}\n\nAnyone in the project can propose to close it, or reply here to keep it going.`);
    assert.equal(says[0].dm.withdrawn, true);
    assert.equal(says[0].dm.quiet, true);
    assert.equal(says[0].dm.done, undefined, 'not marked done');
    const meta = says[0].metadata.homeroomBot;
    assert.equal(meta.kind, 'voice');
    assert.deepEqual(meta.offer, { id: 77, kind: 'close_request', status: 'open', forUserId: null });
    assert.deepEqual(meta.actions.map((a) => [a.id, a.label, a.style]), [
      ['yes', 'Propose to close', 'primary'], ['no', 'Keep it open', 'secondary'],
    ]);
    assert.equal(offers.length, 1);
    assert.equal(offers[0].params[1], 'close_request');
    assert.deepEqual(JSON.parse(offers[0].params[2]), { issueNumber: 7, title: 'Open the library', why: REASON });
    assert.equal(offers[0].params[3], null);
  });

  test(`a withdrawn ${verdict} note adds no buttons while a close vote is open`, async () => {
    const { says, offers } = await noteFor({ verdict, done: false, withdrawn: true }, { openVotes: [{ id: 9 }] });
    assert.equal(says[0].homeroomText, WITHDRAWN_NOTE);
    assert.equal(says[0].metadata, undefined);
    assert.equal(offers.length, 0);
  });
}

test('done wins when the read says both done and withdrawn', async () => {
  const { says } = await noteFor({ verdict: 'person', done: true, withdrawn: true });
  assert.equal(says[0].homeroomText, NOTE);
  assert.equal(says[0].dm.done, true);
  assert.equal(says[0].dm.withdrawn, undefined);
});

test('#6413: parseVerdict reads withdrawn only on person or empty, and never with platform', () => {
  assert.equal(homeroomBot.parseVerdict('{"verdict":"person","reason":"x","withdrawn":true}').withdrawn, true);
  assert.equal(homeroomBot.parseVerdict('{"verdict":"empty","reason":"x","withdrawn":true}').withdrawn, true);
  assert.equal(homeroomBot.parseVerdict('{"verdict":"ready","build_note":"x","withdrawn":true}').withdrawn, false);
  assert.equal(homeroomBot.parseVerdict('{"verdict":"person","reason":"x","platform":true,"withdrawn":true}').withdrawn, false);
  assert.equal(homeroomBot.parseVerdict('{"verdict":"person","reason":"x"}').withdrawn, false);
});

test('#6413: the triage knows a requester or decider can withdraw a request', () => {
  const prompt = require('node:fs').readFileSync(require.resolve('../src/prompts/homeroom-bot-triage.md'), 'utf8');
  assert.match(prompt, /`withdrawn`: true only with `person` or `empty`, when its requester, or a project decider, says in the discussion to close, drop or withdraw it/);
  assert.match(prompt, /It omits `go_ahead` and `first_step`, offering no Go ahead\./);
  assert.match(prompt, /"withdrawn": true \(person or empty, when its requester or a decider said to close it\),/);
});

test('an empty verdict that is not done keeps its own words, with no offer', async () => {
  const { says, offers } = await noteFor({ verdict: 'empty', done: false });
  assert.match(says[0].text, /couldn't find anything to build/);
  assert.equal(says[0].homeroomText, undefined);
  assert.equal(says[0].metadata, undefined);
  assert.equal(offers.length, 0);
});

test('a person note that is not done offers no close', async () => {
  const { says, offers } = await noteFor({ verdict: 'person', done: false });
  assert.match(says[0].homeroomText, /a person needs to decide/);
  assert.equal(offers.length, 0);
});

// #6582: a step result stored before it carried the message id still ties the
// offer, through the post row that names the message it made.
test('a stored step result without a message id ties its offer through the post row', async () => {
  const { queries } = await noteFor({ verdict: 'person' }, { posted: { postId: 901 }, postRow: { thread_message_id: 502 } });
  const tie = queries.find((q) => /UPDATE bot_cards SET chat_message_id/.test(q.sql));
  assert.ok(tie, 'the offer is tied, not dropped');
  assert.deepEqual(tie.params, [77, 502]);
  assert.ok(!queries.some((q) => /DELETE FROM bot_cards/.test(q.sql)));
});

test('the note names a different offer than the one this post made: it is dropped, never re-pointed', async () => {
  const { queries } = await noteFor({ verdict: 'person' }, {
    posted: { messageId: 500 }, messageMeta: { metadata: { homeroomBot: { offer: { id: 999 } } } },
  });
  assert.ok(queries.some((q) => /DELETE FROM bot_cards/.test(q.sql)), 'the offer this post did not use goes');
  assert.ok(!queries.some((q) => /UPDATE bot_cards SET chat_message_id/.test(q.sql)), 'and is not tied to that note');
});

test('the triage counts a requester or decider saying it works as done', () => {
  const prompt = require('node:fs').readFileSync(require.resolve('../src/prompts/homeroom-bot-triage.md'), 'utf8');
  assert.match(prompt, /When the requester, or somebody who decides on the project, says in the discussion that it works and can be closed \("you can propose closing this"\), and the code agrees, that is `done`\./);
});

// ── A tap, against the full schema and the bot-voice machine ─────────────

test('#6321: a tap under the note, by any member, once', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_done_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  messagePool = pool;
  let rt = null;
  t.after(async () => {
    if (rt) await rt.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ($1, 'x', TRUE, $2) RETURNING id, username`, [username, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  const ada = await user('ada');
  const ben = await user('ben');
  const cleo = await user('cleo');
  const { rows: [{ id: appId }] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Recipes', 'recipes', 'running', $1, 'https://github.com/usernode-bot/recipes', 'public', 'public') RETURNING id`,
    [ada.id],
  );
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [appId]);
  for (const member of [ada, ben]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, member.id]);
  }

  const deps = { bot, github: githubStub, domain: 'app.test', workflow: { async fileProposal() {} } };
  const fake = () => ({ maxAttempts: 1, backoffMs: () => 0, leaseMs: 600, async run() { return { ok: true }; } });
  const services = Object.fromEntries(Object.values(machine.WORK).map((kind) => [kind, fake()]));
  services[machine.WORK.act] = {
    maxAttempts: 1, backoffMs: () => 0, leaseMs: 5000,
    async run({ input }) { return realVoice.actOnOffer(pool, CONFIG, { ...input, deps }); },
  };
  rt = createRuntime({ pool, machines: [machine.botVoice()], pollMs: 50, publish: async () => {}, services });
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  let requestKey = 0;
  const tap = async (who, offerId, number, choice = 'yes') => {
    const place = { type: 'issue', ref: number };
    const id = await rt.append('bot-voice', machine.voiceKey(app.id, place),
      { type: 'OfferTapped', payload: { appId: app.id, place, offerId, userId: who.id, choice } },
      { requestKey: `done-${++requestKey}`, source: { kind: 'route' } });
    await settle();
    const { rows: [event] } = await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id]);
    return event;
  };
  // The note the verdict really posts, through live.post.
  const verdictNote = async (number, verdict = 'empty') => {
    gh.issues.set(`recipes#${number}`, { number, title: `Request ${number}`, state: 'open' });
    await homeroomBot.actOnVerdict({
      pool, config: CONFIG, bot, app, repo: { owner: 'usernode-bot', repo: 'recipes' }, issueNumber: number,
      issue: { title: `Request ${number}` },
      parsed: { verdict, reason: REASON, platform: false, done: true },
      decider: { requesterDecides: true }, capSuppressed: null, runId: null, seed: '', seedReadAt: 'now',
      postedAt: [], turnBudgetMs: 1000, model: 'm', deps: { github: githubStub, ws: require(wsId), notifications: { async createMentionNotifications() { return []; }, async hydrateAndPush() {} } },
    });
    const { rows: [note] } = await pool.query(
      `SELECT id, content, metadata FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2 AND user_id = $3 ORDER BY id LIMIT 1`,
      [app.id, number, bot.id],
    );
    const { rows: [offer] } = await pool.query("SELECT *, user_id AS for_user_id FROM bot_cards WHERE place = 'thread' AND chat_message_id = $1", [note.id]);
    return { note, offer };
  };
  // A thread's offers are Homeroom bot's cards (bot_cards); one made before is still in its old table.
  const offerRow = async (id) => (await pool.query(
    'SELECT status, result FROM bot_cards WHERE id = $1 UNION ALL SELECT status, result FROM homeroom_bot_voice_offers WHERE id = $1 LIMIT 1', [id])).rows[0];
  const closeVotes = async (number) => (await pool.query(
    `SELECT created_by FROM issues WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open' AND (payload->>'issueNumber')::int = $2`,
    [app.id, number],
  )).rows;
  const said = async (number) => (await pool.query(
    `SELECT content FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2 AND user_id = $3 ORDER BY id`,
    [app.id, number, bot.id],
  )).rows.map((r) => r.content);

  await t.test('a member who did not ask for it taps yes: the vote is theirs, and the first tap decides it for everybody', async () => {
    const { note, offer } = await verdictNote(77);
    assert.equal(note.content, NOTE);
    assert.equal(offer.for_user_id, null);
    assert.equal(offer.status, 'open');
    assert.equal(note.metadata.homeroomBot.offer.id, Number(offer.id));
    assert.deepEqual(await closeVotes(77), [], 'nothing is filed until somebody taps');

    assert.equal((await tap(ben, Number(offer.id), 77)).result, 'accepted');
    assert.deepEqual((await closeVotes(77)).map((r) => r.created_by), [ben.id]);
    assert.equal((await offerRow(offer.id)).status, 'done');
    const words = await said(77);
    assert.match(words[words.length - 1], /^Done: a vote on closing request .* is open\. It closes if the group votes for it\.$/);
    const { rows: [after] } = await pool.query('SELECT metadata FROM chat_messages WHERE id = $1', [note.id]);
    assert.deepEqual(after.metadata.homeroomBot.actions, [], 'the buttons are gone');

    assert.deepEqual(await tap(ada, Number(offer.id), 77), { result: 'rejected', reason: 'already_decided' }, 'a second tap');
    assert.equal((await closeVotes(77)).length, 1, 'no second vote');
  });

  await t.test('Keep it open takes the buttons away and files nothing', async () => {
    const { offer } = await verdictNote(78, 'person');
    assert.equal((await tap(ben, Number(offer.id), 78, 'no')).result, 'accepted');
    assert.equal((await offerRow(offer.id)).status, 'declined');
    assert.deepEqual(await closeVotes(78), []);
  });

  await t.test('a vote opened after the note: the tap says so and opens no other', async () => {
    const { offer } = await verdictNote(79);
    await pool.query(
      `INSERT INTO issues (app_id, title, kind, payload, created_by) VALUES ($1, 'Close issue #79', 'close_issue', $2, $3)`,
      [app.id, JSON.stringify({ issueNumber: 79 }), ada.id],
    );
    assert.equal((await tap(ben, Number(offer.id), 79)).result, 'accepted');
    assert.equal((await offerRow(offer.id)).status, 'failed');
    const words = await said(79);
    assert.equal(words[words.length - 1], 'A vote on closing it is already open.');
    assert.equal((await closeVotes(79)).length, 1);
  });

  await t.test('a vote already open when the note posts: no offer', async () => {
    await pool.query(
      `INSERT INTO issues (app_id, title, kind, payload, created_by) VALUES ($1, 'Close issue #80', 'close_issue', $2, $3)`,
      [app.id, JSON.stringify({ issueNumber: 80 }), ada.id],
    );
    const { note, offer } = await verdictNote(80);
    assert.equal(note.content, NOTE);
    assert.equal(offer, undefined);
    assert.equal(note.metadata.homeroomBot, undefined);
  });

  await t.test('somebody who is not a member is asked to join first, at the route', async () => {
    const gate = communities.requireAppMembership(pool);
    const answer = async (who) => {
      const out = { next: false, status: null, body: null };
      await gate({ params: { slug: 'recipes' }, user: { id: who.id } }, {
        status(code) { out.status = code; return this; },
        json(body) { out.body = body; return this; },
      }, () => { out.next = true; });
      return out;
    };
    const refused = await answer(cleo);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'join_required');
    assert.equal((await answer(ben)).next, true);
    // The act holds the same line, whatever reached it.
    const { offer } = await verdictNote(81);
    assert.equal((await tap(cleo, Number(offer.id), 81)).result, 'accepted');
    assert.equal((await offerRow(offer.id)).result.error, 'join_required');
    assert.deepEqual(await closeVotes(81), []);
  });

  await t.test('every other offer stays its one person\'s', async () => {
    const offerUnder = async (number, kind, forUserId) => {
      const { rows: [message] } = await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
         VALUES ($1, $2, 'A note', 'message', '{}', 'issue', $3) RETURNING id`,
        [app.id, bot.id, number],
      );
      const { rows: [offer] } = await pool.query(
        `INSERT INTO homeroom_bot_voice_offers (app_id, kind, args, for_user_id, message_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [app.id, kind, JSON.stringify({ issueNumber: number }), forUserId, message.id],
      );
      return Number(offer.id);
    };
    const notForYou = { result: 'rejected', reason: 'not_for_you' };
    assert.deepEqual(await tap(ben, await offerUnder(82, 'copy_request', null), 82), notForYou, 'no one person\'s copy offer is not anybody\'s');
    assert.deepEqual(await tap(ben, await offerUnder(83, 'copy_request', ada.id), 83), notForYou);
    assert.deepEqual(await tap(ben, await offerUnder(84, 'close_request', ada.id), 84), notForYou, 'the voice\'s close offer is its asker\'s');
  });
});
