'use strict';

// Who the Homeroom bot tags. Its posts on an issue (every answer, the spec,
// the proposal, every follow-up) @-mention whoever filed the issue and
// everybody who took part in its discussion: its Homeroom thread, the
// proposal's thread, and GitHub comments from accounts linked to Homeroom.
// Never the bot or another synthetic account, never more than six people,
// and never somebody who asked the bot to stop tagging them on that issue.
//
// That ask is read by the triage and follow-up turns (`stop_mentioning`),
// not by a keyword match: requests are often ABOUT notifications ("stop the
// app notifying me at night"), and a keyword match would silently stop
// tagging the very person who filed one. Recorded per issue, and only for
// somebody who actually wrote there: nobody can opt somebody else out.
//
// The SQL runs against the full PostgreSQL schema when a database is
// reachable, like the repository's other postgres tests; the rest is stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// ── Reading the ask ─────────────────────────────────────────────────────

test('both turns are told what counts as asking the bot to stop, and what does not', () => {
  const triage = read('src/prompts/homeroom-bot-triage.md');
  assert.match(triage, /`stop_mentioning`: the names, exactly as the discussion shows them, of anybody who asked the Homeroom bot itself to stop tagging, messaging or notifying them/);
  assert.match(triage, /a request about the app's own notifications \("stop the app notifying me at night"\) is part of the request, not this/);
  assert.match(triage, /"stop_mentioning": \[/);
  const src = read('src/services/homeroom-bot-followup.js');
  assert.match(src, /`stop_mentioning`: the names, exactly as the replies show them, of anybody who asked the Homeroom bot itself to stop tagging/);
  assert.match(src, /not about the app\\'s own notifications/);
});

test('the names are cleaned: one each, no @, nothing that is not a handle', () => {
  assert.deepEqual(live.parseStopMentioning(['@evan', 'evan', ' maya ', 'Robert Tables; DROP', '', 7, null, 'octo-cat']), ['evan', 'maya', 'octo-cat']);
  assert.deepEqual(live.parseStopMentioning('evan'), []);
  const v = bot.parseVerdict('```json\n{"verdict":"person","reason":"x","stop_mentioning":["@maya"]}\n```');
  assert.deepEqual(v.stopMentioning, ['maya']);
  assert.deepEqual(bot.parseVerdict('```json\n{"verdict":"person","reason":"x"}\n```').stopMentioning, []);
  assert.deepEqual(followup.parseFollowUp('```json\n{"action":"answer","reply":"Will do.","stop_mentioning":["maya"]}\n```').stopMentioning, ['maya']);
});

test('asking to be tagged again is read the same way, from both turns', () => {
  const triage = read('src/prompts/homeroom-bot-triage.md');
  assert.match(triage, /`resume_mentioning`: the names of anybody who, after asking the bot to stop, asked to be tagged again/);
  assert.match(triage, /List a person in whichever of the two they asked for most recently, never in both\./);
  assert.match(triage, /"resume_mentioning": \[/);
  assert.match(read('src/services/homeroom-bot-followup.js'), /`resume_mentioning`: anybody who, after asking the bot to stop, asked to be tagged again/);
  assert.deepEqual(bot.parseVerdict('```json\n{"verdict":"person","reason":"x","resume_mentioning":["@maya"]}\n```').resumeMentioning, ['maya']);
  assert.deepEqual(followup.parseFollowUp('```json\n{"action":"answer","reply":"Sure.","resume_mentioning":["maya"]}\n```').resumeMentioning, ['maya']);
});

test('the dashboard lists who asked, and an admin can tag somebody again after a misread', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /id="admin-homeroom-bot-optouts"/);
  assert.match(tsx, /<h3 className=\{AdminUI\.cardTitle\}>Asked not to be tagged<\/h3>/);
  assert.match(tsx, /\{`@\$\{o\.username\} on \$\{o\.app_name\} #\$\{o\.issue_number\}`\}/);
  assert.match(tsx, /write\('\/api\/admin\/homeroom-bot\/mention-optouts\/remove', 'POST',/);
  assert.match(tsx, /Tag again from here only\n\s+when the bot misread what somebody said\./);
  assert.match(tsx, /\{canWrite \? \(\n\s+<button type="button" className=\{AdminUI\.btn\.outlineSm\} disabled=\{busy !== ''\} onClick=\{\(\) => tagAgain\(o\)\}>/,
    'a view-only admin sees the list, not the button');
  const routes = read('src/routes/admin.js');
  assert.match(routes, /router\.post\('\/api\/admin\/homeroom-bot\/mention-optouts\/remove', requireAdminWrite,/);
});

// ── Posting to several people ───────────────────────────────────────────

test('a post tags everyone in the thread and notifies each of them; GitHub gets no platform handles', async () => {
  const sent = [];
  const notified = [];
  const comments = [];
  const pool = { async query(sql) { return /INSERT INTO homeroom_bot_posts/.test(String(sql)) ? { rows: [{ id: 1 }] } : { rows: [] }; } };
  const ws = { async sendBotMessage(_p, _a, args) { sent.push(args); return { id: 700 }; } };
  const github = { async createIssueComment(_o, _r, _n, body) { comments.push(body); return { id: 1 }; } };
  const notifications = {
    async createMentionNotifications(_p, args) { notified.push(args); return [{ id: 1 }, { id: 2 }]; },
    async hydrateAndPush() {},
  };
  const app = { id: 9, slug: 'rss' };
  const BOT = { id: 77, username: 'homeroom_bot' };
  await live.post({
    pool, github, ws, app, repo: { owner: 'o', repo: 'r' }, issueNumber: 24, kind: 'question',
    text: 'Homeroom bot has a question.', mentions: ['evan', 'maya'], sender: BOT, notifications,
  });
  assert.equal(sent[0].content, '@evan @maya Homeroom bot has a question.');
  assert.deepEqual(notified, [{ appId: 9, chatMessageId: 700, senderId: 77, content: '@evan @maya' }],
    'the notification is built from the handles alone, never the model\'s text');
  assert.equal(comments[0], 'Homeroom bot has a question.', '#723: a platform handle on GitHub would notify a stranger');

  sent.length = 0;
  const card = live.specCard({ sessionId: 5, version: 1, spec: '# T\n\n## User-facing changes\nx', bot: BOT });
  await live.post({
    pool, github, ws, app, repo: { owner: 'o', repo: 'r' }, issueNumber: 24, kind: 'spec',
    text: 'spec', mentions: ['evan'], mention: 'evan', sender: BOT, notifications, threadMessage: card,
  });
  assert.match(sent[0].content, /^@evan 📋 Plan v1: T\. I'm building it now\./, 'a card with tags carries them once');
});

// ── Recorded before anything is posted ──────────────────────────────────

test('triage records the ask before the verdict is posted, so that very post leaves them out', async (t) => {
  const order = [];
  const realApply = live.applyMentionAsks;
  t.after(() => { live.applyMentionAsks = realApply; });
  live.applyMentionAsks = async (args) => { order.push(['asks', args.stop, args.resume, args.runId]); return {}; };
  const pool = {
    async query(sql) {
      const s = String(sql);
      if (/SELECT \* FROM chat_sessions/.test(s)) return { rows: [{ id: 501, user_id: 77, app_id: 9, branch_name: 'main', agent_backend: 'codex_openrouter' }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) { order.push(['run']); return { rows: [{ id: 900 }] }; }
      if (/COUNT\(\*\)::int AS cnt/.test(s)) return { rows: [{ cnt: 0 }] };
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true, getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 12, title: 't', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {}, async ensureWorker() { return 'w'; },
      async execInWorker() { return { lastResultText: '```json\n{"verdict":"person","reason":"Taste.","stop_mentioning":["maya"],"resume_mentioning":["sam"]}\n```' }; },
      isInFlight: () => false, async clearActiveTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: () => 'seed',
      async runCodexAttemptLoop({ dispatchOnce }) { return { result: await dispatchOnce({}), estimatedCostUsd: 0 }; },
    },
    activeWorkers: new Set(), sessionLifecycle: {},
  };
  const out = await bot.runTriage(pool, {}, {
    bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'todo', repo_url: 'https://github.com/o/r' },
    item: { id: 1, issue_number: 12 }, mode: 'shadow', settings: { mode: 'shadow', turnSeconds: 60 }, deps,
  });
  assert.equal(out.verdict, 'person');
  assert.deepEqual(order, [['run'], ['asks', ['maya'], ['sam'], 900]]);
  const src = read('src/services/homeroom-bot.js');
  const tri = src.slice(src.lastIndexOf('await supersedeEarlierBuilds(pool, { app, issueNumber, runId });'), src.indexOf("log.info('homeroom-bot', 'Triaged', {"));
  assert.match(tri, /live\.applyMentionAsks\(/, 'recorded before actOnVerdict runs, in the same run');
  const fu = src.slice(src.indexOf('const parsed = followup.parseFollowUp(result.lastResultText);'), src.indexOf('const moved = followup.headMoved({'));
  assert.match(fu, /live\.applyMentionAsks\(\{\n\s+pool, github, app, repo, issueNumber, stop: parsed\.stopMentioning, resume: parsed\.resumeMentioning,\n\s+proposalSessionId: session\.id,/,
    'a follow-up reads it too, from the proposal\'s thread as well');
  assert.match(src, /mentions: live\.tagsPoster\(kind\) \? targets : \[\], notifications: deps\.notifications \|\| null,/,
    'follow-up replies tag the same people');
});

// ── Against the real schema ─────────────────────────────────────────────

test('who is tagged, and who can opt out, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_mentions_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

  const user = async (username, { synthetic = false, login = null } = {}) => (await pool.query(
    `INSERT INTO users (username, password, is_synthetic, github_login) VALUES ($1, 'x', $2, $3) RETURNING id, username`,
    [username, synthetic, login],
  )).rows[0];
  const BOT = await user('homeroom_bot', { synthetic: true });
  const evan = await user('evan');
  const maya = await user('maya');
  const sam = await user('sam');
  const octo = await user('octo', { login: 'OctoCat' });
  const demo = await user('demo_partner', { synthetic: true });
  const extra = await Promise.all(['p1', 'p2', 'p3', 'p4', 'p5'].map((u) => user(u)));
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('RSS', 'rss', 'running', 'https://github.com/o/rss') RETURNING id, slug`,
  )).rows[0];
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, created_by) VALUES ($1, 24, 'Dark mode', $2)`,
    [app.id, evan.id],
  );
  const say = (u, thread, ref, content = 'hi', type = 'message') => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref) VALUES ($1, $2, $3, $4, $5, $6)`,
    [app.id, u.id, content, type, thread, ref],
  );
  await say(maya, 'issue', 24);
  await say(evan, 'issue', 24);
  await say(maya, 'issue', 24, 'again');
  await say(demo, 'issue', 24, 'a synthetic account');
  await say(BOT, 'issue', 24, 'the bot itself');
  await say(sam, 'session', 5001, 'on the proposal');
  await say(sam, 'issue', 99, 'another issue');
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, deleted_at)
     VALUES ($1, $2, 'deleted', 'message', 'issue', 24, NOW())`,
    [app.id, extra[0].id],
  );
  const github = {
    async fetchIssueComments() {
      return { comments: [{ author: 'octocat', body: 'me too' }, { author: 'dependabot[bot]', body: 'x' }, { author: 'usernode-bot', body: 'x' }, { author: 'stranger', body: 'x' }] };
    },
  };
  const repo = { owner: 'o', repo: 'rss' };
  const targets = (extraArgs = {}) => live.mentionTargets({
    pool, github, app, repo, issueNumber: 24, issue: { body: '' }, botLogin: 'usernode-bot', bot: BOT, ...extraArgs,
  });

  await t.test('whoever filed it first, then everyone who joined in, earliest first', async () => {
    assert.deepEqual(await targets(), ['evan', 'maya', 'octo']);
    assert.deepEqual(await targets({ proposalSessionId: 5001 }), ['evan', 'maya', 'sam', 'octo'],
      'on a follow-up, the proposal\'s thread too');
  });

  await t.test('at most six people', async () => {
    for (const u of extra) await say(u, 'issue', 24);
    const many = await targets({ proposalSessionId: 5001 });
    assert.equal(many.length, live.MAX_MENTIONS);
    assert.deepEqual(many.slice(0, 3), ['evan', 'maya', 'sam']);
    await pool.query('DELETE FROM chat_messages WHERE user_id = ANY($1::int[])', [extra.map((u) => u.id)]);
  });

  await t.test('somebody who asked is left out of that issue from then on, and only that issue', async () => {
    const recorded = await live.recordMentionOptOuts({
      pool, github, app, repo, issueNumber: 24, names: ['maya', 'OctoCat', 'sam', 'nobody'],
    });
    assert.deepEqual(recorded.sort(), ['maya', 'octo'],
      'sam wrote only on another issue and the proposal, not here; nobody wrote nothing');
    assert.deepEqual(await targets(), ['evan']);
    assert.deepEqual(await live.recordMentionOptOuts({ pool, github, app, repo, issueNumber: 24, names: ['maya'] }), ['maya'], 'idempotent');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_mention_optouts');
    assert.equal(rows[0].n, 2);
    const other = await live.mentionTargets({
      pool, github: { async fetchIssueComments() { return { comments: [] }; } }, app, repo, issueNumber: 99, issue: {}, bot: BOT,
    });
    assert.deepEqual(other, ['sam'], 'per issue');
    const onProposal = await live.recordMentionOptOuts({
      pool, github, app, repo, issueNumber: 24, names: ['sam'], proposalSessionId: 5001,
    });
    assert.deepEqual(onProposal, ['sam'], 'a reply on the proposal counts, when the follow-up read it there');
  });

  await t.test('an issue the bot filed itself tags nobody for filing it', async () => {
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, created_by) VALUES ($1, 30, 'Bot filed', $2)`,
      [app.id, BOT.id],
    );
    const none = await live.mentionTargets({
      pool, github: { async fetchIssueComments() { return { comments: [] }; } }, app, repo, issueNumber: 30, issue: {}, bot: BOT,
    });
    assert.deepEqual(none, []);
  });

  await t.test('a synthetic account or the bot can never be tagged or opt anyone out', async () => {
    assert.deepEqual(await live.recordMentionOptOuts({ pool, github, app, repo, issueNumber: 24, names: ['demo_partner', 'homeroom_bot'] }), []);
    await pool.query('DELETE FROM homeroom_bot_mention_optouts');
    const all = await targets();
    assert.ok(!all.includes('demo_partner') && !all.includes('homeroom_bot'));
  });

  await t.test('somebody who asked to stop can ask to be tagged again, and only for themselves', async () => {
    await live.recordMentionOptOuts({ pool, github, app, repo, issueNumber: 24, names: ['maya', 'OctoCat'] });
    assert.deepEqual(await targets(), ['evan']);
    assert.deepEqual(await live.clearMentionOptOuts({ pool, github, app, repo, issueNumber: 24, names: ['maya', 'sam', 'nobody'] }), ['maya'],
      'sam never wrote on #24, nobody never wrote at all');
    assert.deepEqual(await targets(), ['evan', 'maya']);
    assert.deepEqual(await live.clearMentionOptOuts({ pool, github, app, repo, issueNumber: 24, names: ['maya'] }), [], 'nothing left to clear');
  });

  await t.test('stop and resume together: a name in both is left as it was', async () => {
    const out = await live.applyMentionAsks({ pool, github, app, repo, issueNumber: 24, stop: ['maya', 'evan'], resume: ['Maya', 'octocat'] });
    assert.deepEqual(out, { stopped: ['evan'], resumed: ['octo'] });
    const { rows } = await pool.query(
      `SELECT u.username FROM homeroom_bot_mention_optouts o JOIN users u ON u.id = o.user_id WHERE o.issue_number = 24 ORDER BY 1`,
    );
    assert.deepEqual(rows.map((r) => r.username), ['evan'], 'maya untouched (tagged), octo back in, evan out');
  });

  await t.test('the dashboard\'s list, and an admin\'s tag again', async () => {
    const list = await bot.mentionOptOutList(pool);
    assert.equal(list.total, 1);
    assert.deepEqual(list.items.map((o) => [o.app_slug, o.issue_number, o.username]), [['rss', 24, 'evan']]);
    assert.ok(list.items[0].created_at);
    await live.recordMentionOptOuts({ pool, github, app, repo, issueNumber: 24, names: ['maya'] });
    assert.deepEqual(await bot.removeMentionOptOut(pool, { slug: 'rss', issueNumber: 24, username: 'EVAN' }), { ok: true });
    assert.deepEqual((await bot.mentionOptOutList(pool)).items.map((o) => o.username), ['maya'], 'that one person only');
    await pool.query('DELETE FROM homeroom_bot_mention_optouts');
    assert.equal((await bot.removeMentionOptOut(pool, { slug: 'rss', issueNumber: 24, username: 'evan' })).status, 404);
    assert.equal((await bot.removeMentionOptOut(pool, { slug: 'Bad Slug', issueNumber: 24, username: 'evan' })).status, 400);
    assert.equal((await bot.removeMentionOptOut(pool, { slug: 'rss', issueNumber: 0, username: 'evan' })).status, 400);
  });
});
