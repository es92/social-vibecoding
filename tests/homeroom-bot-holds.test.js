'use strict';

// #3751: the Homeroom bot, mentioned on a request a person holds.
//
// tests/homeroom-bot-holds-postgres.test.js runs the whole thing on the real
// schema through refreshApp. This file pins the rules and the words without
// a database: when a mention is answered with who holds the request, when a
// later mention is the go-ahead, what a go-ahead covers, and that a
// proposal up for a vote is left to the vote.
//
// Run with: node --test tests/homeroom-bot-holds.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const holds = require('../src/services/homeroom-bot-holds');

const NOW = new Date('2026-10-03T10:10:00Z');
const at = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();
const claim = (username, minutesAgo) => ({ kind: 'claim', username, since: at(minutesAgo) });
const mention = (username, minutesAgo, id = minutesAgo) => ({ id, username, created_at: at(minutesAgo) });
const note = (kind, minutesAgo) => ({ kind, created_at: at(minutesAgo) });
const DAYS3 = 3 * 24 * 60;

test('a mention on a request somebody else claimed is answered with who holds it', () => {
  const verdict = holds.decide({ holds: [claim('chinchan8', DAYS3)], mentions: [mention('evan', 7)] });
  assert.equal(verdict.action, 'leave');
  assert.equal(verdict.mention.username, 'evan');
  assert.equal(holds.leavingText(verdict.holds, NOW),
    'chinchan8 claimed this request 3 days ago, so Homeroom bot is leaving it to them. '
    + 'If you still want Homeroom bot to build it, mention it here again and it will go ahead.');
});

test('one answer per mention: nothing new to say until somebody mentions the bot again', () => {
  const state = { holds: [claim('chinchan8', DAYS3)], notes: [note(holds.LEAVING_KIND, 6)] };
  assert.equal(holds.decide({ ...state, mentions: [mention('evan', 7)] }).action, 'none');
  assert.equal(holds.decide({ ...state, mentions: [] }).action, 'none');
  // Two mentions before the bot answered get one answer.
  const twice = holds.decide({ holds: state.holds, mentions: [mention('evan', 9), mention('evan', 8)] });
  assert.equal(twice.action, 'leave');
  assert.equal(twice.mention.created_at, at(8), 'the newest one is the one answered');
});

test('a mention after that answer is the go-ahead, and it covers the holds that were there', () => {
  const asked = holds.decide({
    holds: [claim('chinchan8', DAYS3)], notes: [note(holds.LEAVING_KIND, 6)], mentions: [mention('evan', 7), mention('evan', 2)],
  });
  assert.equal(asked.action, 'go');
  assert.deepEqual(asked.others.map((h) => h.username), ['chinchan8']);
  assert.equal(holds.goingText({ asker: 'evan', holders: ['chinchan8'] }),
    'evan asked Homeroom bot to build this anyway, so it is taking it up now. '
    + 'It will reply here with a question, a note or a proposal.');

  // From then on the request is the bot's to work on...
  const after = { notes: [note(holds.LEAVING_KIND, 6), note(holds.GOING_KIND, 1)] };
  assert.equal(holds.decide({ ...after, holds: [claim('chinchan8', DAYS3)] }).action, 'clear');
  // ...the asker's own claim made in between included...
  assert.equal(holds.decide({ ...after, holds: [claim('chinchan8', DAYS3), claim('evan', 3)] }).action, 'clear');
  // ...until somebody starts on it again after the go-ahead.
  assert.equal(holds.decide({ ...after, holds: [claim('chinchan8', DAYS3), claim('sam', 0)] }).action, 'none');
  assert.equal(holds.decide({ ...after, holds: [claim('sam', 0)], mentions: [mention('evan', -1)] }).action, 'leave',
    'and a mention then is answered afresh');
});

test('holding it yourself and mentioning the bot is asking it to go ahead', () => {
  const verdict = holds.decide({ holds: [claim('evan', 30)], mentions: [mention('EVAN', 2)] });
  assert.equal(verdict.action, 'go');
  assert.deepEqual(verdict.others, []);
  assert.equal(holds.goingText({ asker: 'evan', holders: [] }),
    'Homeroom bot is taking this up now, as asked. It will reply here with a question, a note or a proposal.');
});

test('a proposal up for a vote is left to the vote, however often the bot is asked', () => {
  const proposal = { kind: 'proposal', username: 'chinchan8', since: at(60) };
  const first = holds.decide({ holds: [proposal, claim('chinchan8', DAYS3)], mentions: [mention('evan', 5)] });
  assert.equal(first.action, 'leave');
  assert.equal(holds.leavingText(first.holds, NOW),
    'chinchan8\'s change for it is waiting for approval, so Homeroom bot is leaving it to the vote.');
  const again = holds.decide({
    holds: [proposal], notes: [note(holds.LEAVING_KIND, 4)], mentions: [mention('evan', 5), mention('evan', 1)],
  });
  assert.equal(again.action, 'leave', 'no go-ahead past a vote');
});

test('the words: each hold, how long ago, and more than two people', () => {
  assert.equal(holds.ageText(at(20), NOW), 'less than an hour ago');
  assert.equal(holds.ageText(at(61), NOW), 'an hour ago');
  assert.equal(holds.ageText(at(5 * 60), NOW), '5 hours ago');
  assert.equal(holds.ageText(at(25 * 60), NOW), 'a day ago');
  assert.equal(holds.ageText(at(DAYS3), NOW), '3 days ago');
  assert.equal(holds.ageText(null, NOW), 'earlier');
  const session = { kind: 'session', username: 'ada', since: at(120) };
  assert.equal(holds.leavingText([session], NOW),
    'ada has a change in progress for it (last worked on 2 hours ago), so Homeroom bot is leaving it to them. '
    + 'If you still want Homeroom bot to build it, mention it here again and it will go ahead.');
  // One person with a claim and a session reads once, by what they are doing.
  assert.deepEqual(holds.holdsByPerson([claim('ada', 300), session]).map((h) => h.kind), ['session']);
  const four = [claim('a1', 1), claim('a2', 2), claim('a3', 3), claim('a4', 4)];
  assert.match(holds.leavingText(four, NOW), /^a1 claimed this request less than an hour ago and a2 claimed this request less than an hour ago, and 2 more, so /);
  for (const text of [holds.leavingText(four, NOW), holds.goingText({ asker: 'evan', holders: ['ada'] })]) {
    assert.doesNotMatch(text, /@/, 'no @ in the words: the post tags people itself, and GitHub must not be pinged');
    assert.doesNotMatch(text, /—/, 'no em dash');
  }
});

// ── Answering, against a pool that records what was posted ─────────────

function fakePool({ mentions = [], notes = [], optouts = [] }) {
  const posts = [];
  return {
    posts,
    async query(sql, params) {
      const s = String(sql);
      if (/FROM chat_messages m/.test(s)) {
        assert.match(params[2], /@\(homeroom_bot\|/);
        return { rows: mentions };
      }
      if (/SELECT issue_number, kind, created_at FROM homeroom_bot_posts/.test(s)) return { rows: notes };
      if (/FROM homeroom_bot_mention_optouts/.test(s)) return { rows: optouts.map((username) => ({ username })) };
      if (/INSERT INTO homeroom_bot_posts/.test(s)) { posts.push(params[3]); return { rows: [{ id: posts.length }] }; }
      if (/UPDATE homeroom_bot_posts/.test(s)) return { rows: [] };
      throw new Error(`unexpected query: ${s.slice(0, 80)}`);
    },
  };
}

function fakes() {
  const comments = [];
  const messages = [];
  return {
    comments,
    messages,
    github: { async createIssueComment(owner, repo, n, text) { comments.push({ n, text }); return { id: comments.length }; } },
    ws: { async sendBotMessage(pool, appId, { content, thread }) { messages.push({ content, thread }); return { id: 100 + messages.length }; } },
    notifications: { async createMentionNotifications() { return []; }, async hydrateAndPush() {} },
  };
}

const APP = { id: 9, slug: 'todo-list-b91765' };
const REPO = { owner: 'usernode-bot', repo: 'todo-list-b91765' };
const BOT = { id: 77, username: 'homeroom_bot' };

test('answerMentions posts the answer, tagging the person who asked, and keeps the hold', async () => {
  const pool = fakePool({ mentions: [{ n: 75, id: 1, created_at: at(7), username: 'evan' }] });
  const f = fakes();
  const cleared = await holds.answerMentions(pool, {
    app: APP, repo: REPO, github: f.github, bot: BOT, now: NOW,
    holders: new Map([[75, [claim('chinchan8', DAYS3)]], [76, [claim('sam', 10)]]]),
    deps: { ws: f.ws, notifications: f.notifications },
  });
  assert.deepEqual([...cleared], []);
  assert.deepEqual(pool.posts, [holds.LEAVING_KIND], 'one answer, on the request that was mentioned');
  assert.match(f.messages[0].content, /^@evan chinchan8 claimed this request 3 days ago, so Homeroom bot is leaving it to them\./);
  assert.deepEqual(f.messages[0].thread, { type: 'issue', ref: 75 });
  assert.match(f.comments[0].text, /^chinchan8 claimed this request/, 'on GitHub too, with nobody @-tagged');
});

test('answerMentions goes ahead on the second mention, tagging whoever held it unless they opted out', async () => {
  const mentions = [{ n: 75, id: 1, created_at: at(7), username: 'evan' }, { n: 75, id: 2, created_at: at(1), username: 'evan' }];
  const notes = [{ issue_number: 75, ...note(holds.LEAVING_KIND, 6) }];
  const f = fakes();
  const pool = fakePool({ mentions, notes });
  const cleared = await holds.answerMentions(pool, {
    app: APP, repo: REPO, github: f.github, bot: BOT, now: NOW,
    holders: new Map([[75, [claim('chinchan8', DAYS3), claim('evan', 3)]]]),
    deps: { ws: f.ws, notifications: f.notifications },
  });
  assert.deepEqual([...cleared], [75]);
  assert.deepEqual(pool.posts, [holds.GOING_KIND]);
  assert.match(f.messages[0].content, /^@chinchan8 evan asked Homeroom bot to build this anyway, so it is taking it up now\./);

  const quiet = fakes();
  const optedOut = fakePool({ mentions, notes, optouts: ['chinchan8'] });
  await holds.answerMentions(optedOut, {
    app: APP, repo: REPO, github: quiet.github, bot: BOT, now: NOW,
    holders: new Map([[75, [claim('chinchan8', DAYS3)]]]),
    deps: { ws: quiet.ws, notifications: quiet.notifications },
  });
  assert.match(quiet.messages[0].content, /^evan asked Homeroom bot/, 'somebody who asked not to be tagged is not');
});

test('answerMentions never throws: a failure leaves every hold in place', async () => {
  const pool = { async query() { throw new Error('database gone'); } };
  const cleared = await holds.answerMentions(pool, {
    app: APP, repo: REPO, github: {}, bot: BOT, holders: new Map([[75, [claim('chinchan8', DAYS3)]]]),
  });
  assert.deepEqual([...cleared], []);
});

test('the refresh answers mentions on live apps only, and lets a go-ahead through (homeroom-bot.js)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/services/homeroom-bot.js'), 'utf8');
  const refresh = src.slice(src.indexOf('async function refreshApp('), src.indexOf('async function refreshQueue('));
  assert.match(refresh, /if \(capRoom && bot && busy\.size\) \{\s*const cleared = await require\('\.\/homeroom-bot-holds'\)\.answerMentions\(/);
  assert.match(refresh, /for \(const n of cleared\) busy\.delete\(n\);/);
  assert.match(refresh, /busy: busy\.has\(n\),/);
  const again = src.slice(src.indexOf('async function retriageApp('), src.indexOf("log.info('homeroom-bot', 'App queued to be triaged again'"));
  assert.match(again, /goneAhead\(pool, app\.id, holders\)/, 'Triage again respects a go-ahead too');
});
