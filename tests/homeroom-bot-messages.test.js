// #3288: the Homeroom bot posts ordinary messages from its own user.
//
// Its thread posts used to be system messages: no author, drawn as centred
// grey lines, which made a conversation with it read like platform notices.
// They are messages from the homeroom_bot user now, drawn as its bubbles,
// with the proposal card still hanging under the post that links one.
//
// The system-message kind was also what kept the bot from answering itself,
// so most of this file pins the new guard: a synthetic author is never "a
// person replied", wherever that question is asked.
//
// Run with: node --test tests/homeroom-bot-messages.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const APP = { id: 9, slug: 'rss-reader-4113da' };
const REPO = { owner: 'usernode-bot', repo: 'rss-reader-4113da' };
const BOT = { id: 77, username: 'homeroom_bot' };

// ── ws.sendBotMessage ────────────────────────────────────────────────────

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// The same isolation tests/agent-posted-via.test.js uses for ws.js, with
// the notification and event modules counting what is called on them.
function loadWs(calls) {
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'ws') return { WebSocketServer: class {} };
    if (request === 'jsonwebtoken') return { verify: () => ({}), sign: () => '' };
    return origLoad.call(this, request, ...rest);
  };
  const ids = {
    pool: require.resolve('../src/db/pool'),
    logger: require.resolve('../src/services/logger'),
    notifications: require.resolve('../src/services/notifications'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    subject: require.resolve('../src/services/ws'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }) }) });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.notifications, {
    createReplyNotification: async () => { calls.push('reply'); return []; },
    createMentionNotifications: async () => { calls.push('mention'); return []; },
  });
  stub(ids.events, { record() { calls.push('event'); }, EVENT_TYPES: {} });
  stub(ids.appAccess, { checkAppAccess: async () => true });
  delete require.cache[ids.subject];
  const ws = require('../src/services/ws');
  Module._load = origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
  }
  return ws;
}

test('sendBotMessage writes an ordinary message authored by the bot, and nothing a person\'s post also does', async () => {
  const calls = [];
  const ws = loadWs(calls);
  const seen = [];
  const pool = {
    async query(sql, params) {
      seen.push({ sql: String(sql), params });
      if (/INSERT INTO chat_messages/.test(sql)) return { rows: [{ id: 555, created_at: '2026-09-27T10:00:00.000Z' }] };
      return { rows: [] };
    },
  };
  const out = await ws.sendBotMessage(pool, 9, {
    user: BOT, content: '@evan Homeroom bot built this: https://x', metadata: { vote: { sessionId: 5128, prNumber: 25 } },
    thread: { type: 'issue', ref: 24 },
  });
  assert.deepEqual(out, { id: 555, createdAt: '2026-09-27T10:00:00.000Z' });
  const insert = seen.find((q) => /INSERT INTO chat_messages/.test(q.sql));
  assert.match(insert.sql, /VALUES \(\$1, \$2, \$3, \$7, \$4, \$5, \$6\)/);
  assert.equal(insert.params[6], 'message', 'a message row, not a system line');
  assert.deepEqual(insert.params.slice(0, 3), [9, 77, '@evan Homeroom bot built this: https://x'], 'authored by the bot');
  assert.equal(insert.params[3], JSON.stringify({ vote: { sessionId: 5128, prNumber: 25 } }), 'the card rides in its metadata');
  assert.deepEqual(insert.params.slice(4, 6), ['issue', 24]);
  assert.deepEqual(calls, [], 'no @-parsing of model-written text, no event, no reply notification');

  // The spec card is the one other kind it may write; anything else is a message.
  await ws.sendBotMessage(pool, 9, { user: BOT, content: 'spec', thread: { type: 'issue', ref: 24 }, msgType: 'spec_share' });
  await ws.sendBotMessage(pool, 9, { user: BOT, content: 'x', thread: { type: 'issue', ref: 24 }, msgType: 'system' });
  const kinds = seen.filter((q) => /INSERT INTO chat_messages/.test(q.sql)).map((q) => q.params[6]);
  assert.deepEqual(kinds, ['message', 'spec_share', 'message'], 'never a system line, vote or anything else');

  assert.equal(await ws.sendBotMessage(pool, 9, { user: BOT, content: 'x' }), null, 'thread posts only');
  assert.equal(await ws.sendBotMessage(pool, 9, { user: BOT, content: '   ', thread: { type: 'issue', ref: 24 } }), null);
});

test('sendBotMessage broadcasts the frame a person\'s post does, and never wakes the bot', () => {
  const src = read('src/services/ws.js');
  const body = src.slice(src.indexOf('async function sendBotMessage'), src.indexOf('function getOnlineUsers'));
  assert.match(body, /await broadcastFromSender\(pool, appId, \{/, 'a viewer who blocked the account does not receive it');
  for (const field of ["type: 'chat'", 'userId: Number(user.id)', 'username: user.username', 'msgType: kind', 'postedVia: null']) {
    assert.ok(body.includes(field), `the frame carries ${field}`);
  }
  assert.doesNotMatch(body, /noteIssueActivityForBot|noteProposalActivityForBot/, 'this is the bot talking');
  assert.doesNotMatch(body, /createMentionNotifications/);
  assert.doesNotMatch(body, /checkAppAccess|chatNeedsJoin/, 'the people gates are not its gates');
});

// ── live.post ────────────────────────────────────────────────────────────

function postHarness() {
  const sent = { bot: [], system: [], mentions: [] };
  const pool = {
    async query(sql) {
      if (/INSERT INTO homeroom_bot_posts/.test(String(sql))) return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
  };
  const ws = {
    async sendBotMessage(_pool, appId, args) { sent.bot.push({ appId, ...args }); return { id: 100 + sent.bot.length }; },
    async sendSystemMessage(...args) { sent.system.push(args); return { id: 900 }; },
  };
  const github = { async createIssueComment() { return { id: 1, created_at: '2026-09-27T10:00:00Z' }; } };
  const notifications = {
    async createMentionNotifications(_pool, args) { sent.mentions.push(args); return []; },
    async hydrateAndPush() {},
  };
  return { pool, ws, github, notifications, sent };
}

test('with the bot as sender, every thread post is its message: the issue, the proposal thread, the card', async () => {
  const h = postHarness();
  await live.post({
    pool: h.pool, github: h.github, ws: h.ws, app: APP, repo: REPO, issueNumber: 24, kind: 'proposal',
    text: 'Homeroom bot built this', msgType: 'vote', metadata: { vote: { sessionId: 5128, prNumber: 25 } },
    mention: 'evan', senderId: BOT.id, sender: BOT, notifications: h.notifications, proposalSessionId: 5128,
  });
  assert.equal(h.sent.system.length, 0, 'no system line anywhere');
  assert.equal(h.sent.bot.length, 2);
  const [issue, proposal] = h.sent.bot;
  assert.deepEqual(issue.user, BOT);
  assert.deepEqual(issue.thread, { type: 'issue', ref: 24 });
  assert.equal(issue.content, '@evan Homeroom bot built this', 'the poster is named in the thread');
  // With the post's mark, so a retry finds it rather than posting it again
  // (homeroom-bot-live.js threadMessageOf).
  assert.deepEqual(issue.metadata, { vote: { sessionId: 5128, prNumber: 25 }, hrbotPost: '1' }, 'so the chat hangs the card under it');
  assert.deepEqual(proposal.thread, { type: 'session', ref: 5128 });
  assert.equal(proposal.metadata, null, 'the card is on the issue post, not repeated');
  assert.equal(h.sent.mentions.length, 1, 'the poster is notified once');
  assert.equal(h.sent.mentions[0].content, '@evan', 'by handle alone, never the model\'s text');
  assert.equal(h.sent.mentions[0].senderId, BOT.id);
  assert.equal(h.sent.mentions[0].chatMessageId, 101, 'pointing at the bot\'s message');
});

test('without a sender it is the system line it always was', async () => {
  const h = postHarness();
  await live.post({
    pool: h.pool, github: h.github, ws: h.ws, app: APP, repo: REPO, issueNumber: 24, kind: 'question', text: 'q',
  });
  assert.equal(h.sent.bot.length, 0);
  assert.equal(h.sent.system.length, 1);
});

test('every live post names the bot as its sender', () => {
  const src = read('src/services/homeroom-bot.js');
  const posts = [...src.matchAll(/live\.post\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
  assert.equal(posts.length, 4, 'looking, a verdict, a follow-up, a checks hand-off');
  for (const args of posts) assert.match(args, /sender: bot/);
});

// ── The bot never reads itself as a person replying ─────────────────────

test('the queue\'s thread-activity queries leave synthetic authors out', () => {
  const src = read('src/services/homeroom-bot.js');
  const issue = src.slice(src.indexOf('async function threadActivityByIssue'), src.indexOf('async function proposalThreadActivityByIssue'));
  assert.match(issue, /LEFT JOIN users u ON u\.id = m\.user_id/);
  assert.match(issue, /u\.is_synthetic IS NOT TRUE/);
  const proposal = src.slice(src.indexOf('async function proposalThreadActivityByIssue'), src.indexOf('function latestOf'));
  assert.match(proposal, /author\.is_synthetic IS NOT TRUE/);
});

test('its own thread messages are not replies to follow up on', () => {
  const since = Date.parse('2026-09-27T09:00:00Z');
  const replies = followup.newReplies({
    issueThread: [
      { author: 'homeroom_bot', body: 'Homeroom bot is looking at this request.', createdAt: '2026-09-27T09:30:00Z' },
      { author: 'evan', body: 'darker please', createdAt: '2026-09-27T09:40:00Z' },
    ],
    proposalThread: [{ author: 'Homeroom_Bot', body: 'answered', createdAt: '2026-09-27T09:50:00Z' }],
    botUsername: live.BOT_USERNAME,
    sinceMs: since,
  });
  assert.deepEqual(replies.map((r) => r.author), ['evan']);
});

test('"somebody replied while it worked" does not count its own message', async () => {
  const updates = [];
  const pool = { async query(sql, params) { updates.push({ sql: String(sql), params }); return { rows: [] }; } };
  const github = { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } };
  const threadContext = {
    async loadIssueThread() { return { messages: [{ author: 'homeroom_bot', createdAt: '2026-09-27T10:00:04Z' }] }; },
    async loadProposalThread() { return { messages: [{ author: 'homeroom_bot', createdAt: '2026-09-27T10:00:04Z' }] }; },
  };
  const out = await live.advanceSeen({
    pool, github, threadContext, app: APP, repo: REPO, issueNumber: 24, runId: 900,
    since: '2026-09-27T10:00:00Z', postedAt: ['2026-09-27T10:00:05Z'], proposalSessionId: 5128,
  });
  assert.equal(out.advanced, true, 'its own post is not a person\'s reply');

  threadContext.loadIssueThread = async () => ({ messages: [{ author: 'evan', createdAt: '2026-09-27T10:00:03Z' }] });
  const again = await live.advanceSeen({
    pool, github, threadContext, app: APP, repo: REPO, issueNumber: 24, runId: 900,
    since: '2026-09-27T10:00:00Z', postedAt: ['2026-09-27T10:00:05Z'],
  });
  assert.deepEqual(again, { advanced: false, reason: 'someone_replied' }, 'while a person\'s still is');
});

test('one name for the bot, in the live module', () => {
  assert.equal(live.BOT_USERNAME, 'homeroom_bot');
  assert.match(read('src/services/homeroom-bot.js'), /const \{ BOT_USERNAME \} = live;/);
});

// ── Rendering: a bubble, with the card under it ─────────────────────────

function loadGroupChat() {
  const gcJs = read('public/js/group-chat.js');
  const document = {
    createElement: () => ({ style: {}, set textContent(v) { this._t = v; }, get innerHTML() { return this._t || ''; } }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams, document,
    window: { matchMedia: () => ({ matches: false }) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'evan' } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${gcJs}\nglobalThis.__M = { GroupChat };`, sandbox);
  return sandbox.__M.GroupChat;
}

test('the bot\'s proposal post is a message row that carries the vote card', () => {
  const gc = loadGroupChat();
  const row = gc._messageView({
    id: 3, msg_type: 'message', user_id: 77, username: 'homeroom_bot',
    content: '@evan Homeroom bot built this and opened a proposal (PR #25): https://x',
    metadata: { vote: { sessionId: 5128, prNumber: 25 } }, created_at: '2026-09-27T10:00:00Z',
  });
  assert.equal(row.kind, 'message', 'a bubble with its name');
  assert.equal(row.username, 'homeroom_bot');
  assert.equal(JSON.stringify(row.voteRef), JSON.stringify({ sessionId: '5128', prNumber: '25' }));

  const typed = gc._messageView({ id: 4, msg_type: 'message', user_id: 5, username: 'evan', content: 'see PR #25', created_at: '2026-09-27T10:00:00Z' });
  assert.equal(typed.voteRef, null, 'a "PR #N" anybody can type is not a card');
  const gone = gc._messageView({ id: 5, msg_type: 'message', user_id: 77, username: 'homeroom_bot', deleted: true, content: '', metadata: { vote: { sessionId: 5128 } }, created_at: '2026-09-27T10:00:00Z' });
  assert.equal(gone.voteRef, null, 'a deleted post loses its card with its words');
});

test('a message row hangs the same vote card a vote row does, and no module-filled host', () => {
  // #6236: the card is React's (features/group-chat/vote-card.tsx) — the
  // line with See the vote on a request's page, the small card with Preview
  // and Vote elsewhere — drawn from the row's model, never filled by
  // group-chat.js. Pinned in tests/vote-row-card.test.js; here only that
  // the bubble carries it.
  const tsx = read('frontend/src/features/group-chat/transcript.tsx');
  const row = tsx.slice(tsx.indexOf('export const MessageRow'), tsx.indexOf('export const MessageRow') + 7000);
  assert.match(row, /\{msg\.voteRef \? \(seeVote\s*\? <VoteLine sessionId=\{seeVote\.sessionId\} number=\{seeVote\.number\} title=\{seeVote\.title\} \/>\s*: <VoteCard msg=\{msg\} \/>\) : null\}/);
  assert.doesNotMatch(tsx, /data-vote-controls=""|gc-vote-inline/, 'no host left for the module to fill');
  assert.match(read('public/css/app.css'), /\.gc-vote-card \{[^}]*border-radius: 20px;[^}]*background: var\(--dc-sheet-solid\);/);
});

// ── And it is not somebody active on the project ────────────────────────

test('the hub\'s activity counts people only', () => {
  const src = read('src/services/communities.js');
  // The week's count is activityCounts', which the hub and a visitor's page share.
  const fn = src.slice(src.indexOf('async function activityCounts'), src.indexOf('const ACTIVE_PEOPLE_SHOWN'));
  const joins = fn.match(/JOIN users u ON u\.id = (?:w|who)\.user_id AND u\.is_synthetic IS NOT TRUE/g) || [];
  assert.equal(joins.length, 3, 'the fourteen-day trend, the week\'s count and the people it names');
});
