'use strict';

// #4530: the Homeroom bot stays quiet on a request nobody is talking to it.
//
// People talking among themselves after the bot already left its note get no
// second copy of it: not its question, not "a person needs to decide this
// one", not "couldn't find anything to build". It speaks again when somebody
// mentions @homeroom_bot, replies to one of its messages, or writes anything
// after a question it asked, on the discussion or on the GitHub issue. The
// rule itself is pure (homeroom-bot-addressed.js); here it is pinned, its
// two queries are held against the full PostgreSQL schema, and
// actOnVerdict is held at both sides of the gate.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-addressed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const holds = require('../src/services/homeroom-bot-holds');
const addressed = require('../src/services/homeroom-bot-addressed');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── The rule ──

const NOTE = (kind) => ({ kind, created_at: '2026-10-09T09:02:00Z' });
const AFTER = '2026-10-09T09:10:00Z';
const BEFORE = '2026-10-09T09:00:00Z';
const msg = (body, { at = AFTER, quotesBot = false, userId = null } = {}) => ({ body, createdAt: at, quotesBot, userId });
const comment = (author, body, at = AFTER) => ({ author, body, createdAt: at });

test('the bot speaks the first time it could leave a note here', () => {
  assert.deepEqual(addressed.addressed({ lastNote: null }), { speak: true, why: 'first_note' });
});

test('#6399: after "I\'m taking this up now", the read that follows speaks, whatever the words', () => {
  const promised = { kind: 'going_ahead', created_at: '2026-10-09T09:02:00Z', thread_message_id: 7 };
  assert.deepEqual(addressed.addressed({ lastNote: promised }), { speak: true, why: 'promised' });
  assert.deepEqual(addressed.addressed({ lastNote: promised, waitingOnly: true }), { speak: true, why: 'promised' },
    'a look somebody asked for speaks too');
  assert.deepEqual(addressed.addressed({ lastNote: promised, messages: [msg('thanks')] }), { speak: true, why: 'promised' });
  assert.equal(addressed.waitingOn({ lastNote: promised }), null, 'a go-ahead is still not a note it waits on');
});

test('#6311: a re-read says the same note only when its words have not changed', () => {
  const note = 'I think this is about Homeroom itself, not Ear trainer: the header is drawn by Homeroom.';
  assert.equal(addressed.sameNote(note, note), true);
  assert.equal(addressed.sameNote(note, 'I think this is about Homeroom itself, not Ear trainer: The header is drawn by Homeroom!'),
    true, 'case and punctuation ignored');
  assert.equal(addressed.sameNote(note, `${note} The button is the app's own.`), true, '80% of the words in common');
  assert.equal(addressed.sameNote(note, 'I think this is about Homeroom itself, not Ear trainer: sign-in is Homeroom\'s own.'),
    false, 'a different reason');
  assert.equal(addressed.sameNote('', note), false);
  assert.equal(addressed.sameNote(null, note), false, 'a missing previous text never matches');
});

test('people talking among themselves after a person note are not for the bot', () => {
  const result = addressed.addressed({
    lastNote: NOTE('person'),
    messages: [
      msg('written before the note', { at: BEFORE }),
      msg("I'd go with the list layout, it's easier on a phone"),
      msg('Agreed, let us ask the others at the next meeting'),
    ],
    comments: [comment('evan', 'Same on our side, no rush')],
  });
  assert.deepEqual(result, { speak: false, why: 'not_addressed' });
});

test('a mention speaks, and only a real one', () => {
  const speak = (body) => addressed.addressed({ lastNote: NOTE('person'), messages: [msg(body)] });
  assert.deepEqual(speak('hey @homeroom_bot what about the header?'), { speak: true, why: 'mention' });
  assert.deepEqual(speak('@HOMEROOM_BOT still there?'), { speak: true, why: 'mention' }, 'the mention is not case-bound');
  assert.deepEqual(speak('@homeroom_bot_x what about the header?'), { speak: false, why: 'not_addressed' },
    'a longer handle is somebody else');
  assert.deepEqual(speak('write me at a@homeroom_bot ok?'), { speak: false, why: 'not_addressed' },
    'the tail of an address is not a mention');
  assert.deepEqual(speak('(@homeroom_bot) thanks'), { speak: true, why: 'mention' }, 'punctuation around it is fine');
});

test('a reply to one of the bot\'s messages speaks', () => {
  const result = addressed.addressed({ lastNote: NOTE('person'), messages: [msg('the list one, please', { quotesBot: true })] });
  assert.deepEqual(result, { speak: true, why: 'reply' });
});

test('anything written after a question the bot asked is its answer', () => {
  const withMessage = addressed.addressed({ lastNote: NOTE('question'), messages: [msg('the blue one')] });
  assert.deepEqual(withMessage, { speak: true, why: 'answer' });
  const withComment = addressed.addressed({ lastNote: NOTE('question'), comments: [comment('drea', 'the blue one')] });
  assert.deepEqual(withComment, { speak: true, why: 'answer' });
  assert.deepEqual(addressed.addressed({ lastNote: NOTE('question') }), { speak: false, why: 'not_addressed' },
    'nothing after it yet');
});

test('on the GitHub issue, a mention of the bot or its login speaks, and its own comment does not', () => {
  const issue = addressed.addressed({
    lastNote: NOTE('person'),
    comments: [comment('evan', '@homeroom_bot try again with the dark theme')],
  });
  assert.deepEqual(issue, { speak: true, why: 'mention' });
  const byLogin = addressed.addressed({
    lastNote: NOTE('person'),
    comments: [comment('evan', '@Usernode-Bot please take another look')],
    botLogin: 'usernode-bot[bot]',
  });
  assert.deepEqual(byLogin, { speak: true, why: 'mention' }, 'the GitHub login mentions it too');
  const own = addressed.addressed({
    lastNote: NOTE('question'),
    comments: [
      comment('usernode-bot', 'Homeroom bot asked: which layout?'),
      comment('usernode-bot[bot]', '@homeroom_bot should never match its own words'),
    ],
    botLogin: 'usernode-bot[bot]',
  });
  assert.deepEqual(own, { speak: false, why: 'not_addressed' }, 'the bot does not answer itself');
});

test('the same text the holds module matches a mention with, both places build it', () => {
  assert.equal(holds.mentionPattern(), "(^|[^a-z0-9_])@(homeroom_bot|homeroombot|[\u200b\u200c\u200d\u2060]?homeroom bot)([^a-z0-9_-]|$)");
  const src = read('src/services/homeroom-bot-holds.js');
  assert.match(src, /AND m\.content ~\* \$3/);
  assert.match(src, /\[appId, numbers, mentionPattern\(\), windowHours\]/, 'recentMentions uses it');
});

test('#4610: "@Homeroom bot", as the composer writes it, is a mention too; a longer name is not', () => {
  const mention = new RegExp(holds.mentionPattern(), 'i');
  for (const text of [
    '@homeroom_bot can you look?',
    '@homeroombot can you look?',
    'thanks @HomeroomBot!',
    '@Homeroom bot inset it even more',
    '@\u200bHomeroom bot inset it even more',
    'thanks @\u200dHomeroom bot!',
    '@Homeroom bot',
  ]) assert.ok(mention.test(text), JSON.stringify(text));
  for (const text of ['@homeroom_botx', '@homeroombotx', '@Homeroom botany', 'ada@homeroom_bot.example', 'ada@homeroombot.example', 'Homeroom bot said so']) {
    assert.ok(!mention.test(text), JSON.stringify(text));
  }
});

test('#4530: its own GitHub comment is its own by the id it recorded, whatever the login lookup said', () => {
  // The login comes from the GitHub App's first installation; when that
  // names another account (or fails), the bot's own question read as a
  // person's answer to it.
  const own = { id: 5551, author: 'other-app[bot]', body: 'Homeroom bot asked: which layout?', createdAt: AFTER };
  const byLogin = { lastNote: NOTE('question'), comments: [own], botLogin: 'usernode-bot[bot]' };
  assert.deepEqual(addressed.addressed(byLogin), { speak: true, why: 'answer' }, 'by login alone it answers itself');
  assert.deepEqual(addressed.addressed({ ...byLogin, ownCommentIds: ['5551'] }), { speak: false, why: 'not_addressed' });
  assert.deepEqual(addressed.addressed({ ...byLogin, botLogin: '', ownCommentIds: ['5551'] }), { speak: false, why: 'not_addressed' },
    'with no login at all');
  const person = { id: 5552, author: 'drea', body: 'the list one', createdAt: AFTER };
  assert.deepEqual(addressed.addressed({ ...byLogin, comments: [own, person], ownCommentIds: ['5551'] }), { speak: true, why: 'answer' },
    'a person beside it still answers');
});

test('#4530: a look somebody asked for is held only while the bot waits on its own note', () => {
  const asked = (lastNote, more = {}) => addressed.addressed({ lastNote, waitingOnly: true, ...more });
  assert.deepEqual(asked(null), { speak: true, why: 'first_note' }, 'a request\'s first look speaks');
  assert.deepEqual(asked(NOTE('question')), { speak: false, why: 'not_addressed' }, 'its question, unanswered');
  assert.deepEqual(asked(NOTE('person')), { speak: false, why: 'not_addressed' });
  assert.deepEqual(asked(NOTE('question'), { messages: [msg('the blue one')] }), { speak: true, why: 'answer' });
  for (const kind of ['build_failed', 'held_proposals', 'proposal', 'blocked']) {
    assert.deepEqual(asked(NOTE(kind)), { speak: true, why: 'not_waiting' }, `after ${kind}, asking brings it back`);
  }
  // The request edited since the note: the issue's updated_at, past the note
  // and its comments by more than a comment's own stamp.
  assert.deepEqual(asked(NOTE('question'), { updatedAt: '2026-10-09T09:30:00Z' }), { speak: true, why: 'edited' });
  assert.deepEqual(asked(NOTE('question'), { updatedAt: '2026-10-09T09:02:02Z' }), { speak: false, why: 'not_addressed' },
    'the stamp its own comment put there is not an edit');
  assert.deepEqual(addressed.addressed({ lastNote: NOTE('person'), updatedAt: '2026-10-09T09:30:00Z' }),
    { speak: false, why: 'not_addressed' }, 'a look the request\'s own changes started keeps #4530\'s rule');
});

test('#4530: the bot waits on people while its note stands unanswered and the request is unchanged', () => {
  const note = (kind = 'question') => ({ kind, created_at: '2026-10-09T09:02:00Z', thread_message_id: 41 });
  assert.deepEqual(addressed.waitingOn({ lastNote: note() }), { kind: 'question', messageId: 41 });
  assert.deepEqual(addressed.waitingOn({ lastNote: { ...note('person'), thread_message_id: null } }), { kind: 'person', messageId: null });
  assert.equal(addressed.waitingOn({ lastNote: null }), null, 'nothing said yet');
  assert.equal(addressed.waitingOn({ lastNote: note('proposal') }), null, 'not one of its notes');
  assert.equal(addressed.waitingOn({ lastNote: note(), messages: [msg('the blue one')] }), null, 'answered in the discussion');
  assert.equal(addressed.waitingOn({ lastNote: note(), comments: [comment('drea', 'the blue one')] }), null, 'answered on GitHub only');
  assert.deepEqual(addressed.waitingOn({ lastNote: note('person'), messages: [msg('ask the others next week')] }),
    { kind: 'person', messageId: 41 }, 'people talking among themselves');
  // The issue's updated_at: its own comment's stamp, a moment after the note,
  // is not news; a later one no comment explains is an edit of the request.
  const ownComment = { id: 9, author: 'usernode-bot', body: 'Homeroom bot asked: which?', createdAt: '2026-10-09T09:02:01Z' };
  assert.deepEqual(addressed.waitingOn({
    lastNote: note(), comments: [ownComment], botLogin: 'usernode-bot', updatedAt: '2026-10-09T09:02:02Z',
  }), { kind: 'question', messageId: 41 });
  assert.equal(addressed.waitingOn({ lastNote: note(), updatedAt: '2026-10-09T09:30:00Z' }), null, 'edited since');
  assert.equal(addressed.waitingOn({ lastNote: note(), updatedAt: new Date('2026-10-09T09:30:00Z') }), null, 'pg hands back a Date');
  assert.deepEqual(addressed.waitingOn({
    lastNote: note('person'), comments: [comment('evan', 'no rush', '2026-10-09T09:30:00Z')], updatedAt: '2026-10-09T09:30:01Z',
  }), { kind: 'person', messageId: 41 }, 'a comment among people explains its own stamp');
  assert.equal(addressed.waitingOn({
    lastNote: note('person'), comments: [comment('evan', 'no rush', '2026-10-09T09:10:00Z')], updatedAt: '2026-10-09T09:30:00Z',
  }), null, 'and an edit after it is still news');
});

// #6146 (ViaTales #52, 1 Nov 2026): the bot's "a person needs to decide"
// note says "@snait can say Go ahead in a chat with me, or reply here". Its
// requester replied there with the composer, the next look kept the verdict,
// and it posted nothing: a plain message was taken for people talking among
// themselves. A plain message from the requester or a decider the note
// names is their answer.
const REQUESTER = 31;
const DECIDER = 50;
const OTHER = 40;

test('#6146: after a person note, a plain message from its requester or a named decider is their answer', () => {
  const after = (kind, userId, extra = {}) => addressed.addressed({
    lastNote: NOTE(kind), messages: [msg('Yep can you add it via commit?', { userId, ...extra })], answerers: [REQUESTER, DECIDER],
  });
  assert.deepEqual(after('person', REQUESTER), { speak: true, why: 'answer' }, 'the requester');
  assert.deepEqual(after('person', DECIDER), { speak: true, why: 'answer' }, 'a decider the note names');
  assert.deepEqual(after('person', OTHER), { speak: false, why: 'not_addressed' }, 'anyone else is still among themselves');
  assert.deepEqual(after('empty', REQUESTER), { speak: false, why: 'not_addressed' }, 'only person and question notes take an answer');
  assert.deepEqual(after('question', OTHER), { speak: true, why: 'answer' }, 'a question is answered by anyone, as before');
  assert.deepEqual(after('person', REQUESTER, { at: BEFORE }), { speak: false, why: 'not_addressed' }, 'only words after the note');
  // Quoting the bot or not: with the voice answering Replies, theirs is still
  // the note's answer.
  assert.deepEqual(addressed.addressed({
    lastNote: NOTE('person'), messages: [msg('go ahead', { userId: REQUESTER, quotesBot: true })], answerers: [REQUESTER], voiceAnswers: true,
  }), { speak: true, why: 'answer' });
  assert.deepEqual(addressed.addressed({
    lastNote: NOTE('person'), messages: [msg('go ahead', { userId: OTHER, quotesBot: true })], answerers: [REQUESTER], voiceAnswers: true,
  }), { speak: false, why: 'not_addressed' }, 'somebody else\'s Reply is the voice\'s, as before');
  assert.deepEqual(addressed.addressed({ lastNote: NOTE('person'), messages: [msg('go ahead', { userId: REQUESTER })] }),
    { speak: false, why: 'not_addressed' }, 'with nobody named to answer, as before');
});

test('#6146: a person note its requester answered is not waited on: Ask is not refused, and the card stops offering a Reply', () => {
  const note = { kind: 'person', created_at: '2026-10-09T09:02:00Z', thread_message_id: 41 };
  assert.equal(addressed.waitingOn({ lastNote: note, messages: [msg('Yep can you add it via commit?', { userId: REQUESTER })], answerers: [REQUESTER] }), null);
  assert.deepEqual(addressed.waitingOn({ lastNote: note, messages: [msg('ask the others', { userId: OTHER })], answerers: [REQUESTER] }),
    { kind: 'person', messageId: 41 }, 'still waiting after somebody else\'s words');
});

test('#6146: who answers a person note: its requester, and the deciders it names', async () => {
  const pool = (ids, fail = false) => ({
    queries: [],
    async query(sql, params) {
      this.queries.push([String(sql), params]);
      if (fail) throw new Error('database is down');
      return { rows: ids.map((id) => ({ id })) };
    },
  });
  const app = { id: 9, slug: 'viatales' };
  const named = { requester: 'evan', requesterDecides: false, deciders: [{ username: 'snait', role: 'creator' }, { username: 'ann', role: 'admin' }] };
  const both = pool([DECIDER, 51]);
  assert.deepEqual(await bot.answerersOf(both, app, { userId: REQUESTER }, named), [REQUESTER, DECIDER, 51]);
  assert.match(both.queries[0][0], /SELECT id FROM users WHERE username = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(both.queries[0][1], [['snait', 'ann']]);
  const alone = pool([]);
  assert.deepEqual(await bot.answerersOf(alone, app, { userId: REQUESTER }, { requesterDecides: true }), [REQUESTER], 'they decide alone');
  assert.equal(alone.queries.length, 0);
  assert.deepEqual(await bot.answerersOf(pool([]), app, null, named), [], 'no requester, nobody');
  assert.deepEqual(await bot.answerersOf(pool([], true), app, { userId: REQUESTER }, named), [REQUESTER],
    'the requester still answers when the deciders cannot be read');
});

test('#6146: the button and the card ask who answers only for a person note somebody wrote after', async () => {
  // One request: the note and the words since it (loadAddressed's queries).
  const one = (kind, rows) => ({
    async query(sql) {
      if (/FROM homeroom_bot_posts/.test(sql)) return { rows: [{ kind, created_at: '2026-10-09T09:02:00Z', thread_message_id: 41, own_comment_ids: [] }] };
      return { rows };
    },
  });
  const reads = [];
  const github = {
    async fetchPublicIssue(_o, _r, n) { reads.push('issue'); return { issue: { number: n, updatedAt: '2026-10-09T09:02:01Z' } }; },
    async fetchIssueComments() { reads.push('comments'); return { comments: [], truncated: false }; },
    async getBotUsername() { return 'usernode-bot'; },
  };
  const repo = { owner: 'o', repo: 'viatales' };
  const asked = [];
  const answerersOf = async () => { asked.push('who'); return [REQUESTER]; };
  const theirs = [{ id: 7, user_id: REQUESTER, content: 'Yep can you add it via commit?', created_at: AFTER, quotes_bot: false }];
  const ask = (pool, extra = {}) => addressed.waitingOnRequest(pool, { appId: 9, issueNumber: 52, botId: 77, github, repo, ...extra });
  assert.deepEqual(await ask(one('person', theirs)), { kind: 'person', messageId: 41 }, 'without answerers, as before');
  reads.length = 0;
  assert.equal(await ask(one('person', theirs), { answerersOf }), null, 'Ask is not refused after the requester answered');
  assert.deepEqual(reads, [], 'and GitHub is not read for it');
  assert.deepEqual(asked, ['who']);
  asked.length = 0;
  await ask(one('person', []), { answerersOf });
  await ask(one('question', []), { answerersOf });
  assert.deepEqual(asked, [], 'not asked with nothing written after the note, nor for a question');

  // The list: two queries for every request, and who answers only for the
  // person note with words after it.
  const list = {
    async query(sql) {
      if (/DISTINCT ON \(issue_number\)/.test(sql)) {
        return { rows: [
          { issue_number: 51, kind: 'question', created_at: '2026-10-09T09:02:00Z', thread_message_id: 61 },
          { issue_number: 52, kind: 'person', created_at: '2026-10-09T09:02:00Z', thread_message_id: 62 },
          { issue_number: 53, kind: 'person', created_at: '2026-10-09T09:02:00Z', thread_message_id: 63 },
        ] };
      }
      return { rows: [
        { issue_number: 52, user_id: REQUESTER, content: 'Yep can you add it via commit?', created_at: AFTER, quotes_bot: false },
        { issue_number: 53, user_id: OTHER, content: 'ask the others', created_at: AFTER, quotes_bot: false },
      ] };
    },
  };
  const askedFor = [];
  const waiting = await addressed.waitingByIssue(list, {
    appId: 9, botId: 77, issues: [51, 52, 53].map((number) => ({ number, updatedAt: '2026-10-09T09:02:01Z' })),
    answerersOf: async (n) => { askedFor.push(n); return [REQUESTER]; },
  });
  assert.deepEqual([...waiting.keys()].sort(), [51, 53], '52 was answered by its requester; 53 only talked about');
  assert.deepEqual(askedFor.sort(), [52, 53]);

  const dm = read('src/services/homeroom-bot-dm.js');
  assert.match(dm, /answerersOf: async \(\) => settingsModule\(\)\.answerersOf\(pool, app, await requesterOf\(pool, app\.id, n\)/);
  assert.match(dm, /waitingByIssue\(pool, \{ appId, botId: bot\.id, issues, answerersOf \}\)/);
});

// ── actOnVerdict at the gate ──

const PERSON_PARSED = { verdict: 'person', reason: 'which of the two layouts the group wants' };

function fakePool(routes = []) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push([String(sql), params]);
      for (const [pattern, answer] of routes) {
        if (pattern.test(String(sql))) {
          if (answer instanceof Error) throw answer;
          return answer;
        }
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

function verdictArgs(over = {}) {
  const pool = over.pool || fakePool();
  return {
    pool, config: {}, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'chores', name: 'Chores' },
    repo: { owner: 'o', repo: 'r' }, issueNumber: 12, issue: { title: 'Two layouts' },
    parsed: PERSON_PARSED, capSuppressed: null, runId: 900,
    seed: 's', seedReadAt: '2026-10-09T10:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'stage/build',
    deps: {
      github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
      ws: {}, threadContext: { async loadIssueThread() { return { messages: [] }; } },
      limits: { async recordSpend() {}, async checkBudget() { return {}; } },
      managedOpenRouter: { async usesIncludedKey() { return false; } }, domain: 'x',
    },
    ...over,
  };
}

function stubLive(t) {
  const real = { post: live.post, advanceSeen: live.advanceSeen };
  const seen = { posts: [], seen: [] };
  live.post = async (a) => { seen.posts.push(a); return {}; };
  live.advanceSeen = async (a) => { seen.seen.push(a); return { advanced: false, reason: 'nothing_posted' }; };
  t.after(() => Object.assign(live, real));
  return seen;
}

// The gate's two queries, as fake pool answers: the bot's last note, then
// what people said since it.
const NOTE_ROUTE = [/FROM homeroom_bot_posts/, { rows: [{ kind: 'person', created_at: '2026-10-09T09:02:00Z' }] }];
const talk = (...bodies) => [/metadata->'quote'/, {
  rows: bodies.map((body, i) => ({ id: i + 1, content: body, created_at: AFTER, quotes_bot: false })),
}];

test('a repeat person note stays quiet while people talk among themselves', async (t) => {
  const seen = stubLive(t);
  const pool = fakePool([
    NOTE_ROUTE,
    talk("I'd go with the list layout", 'Agreed, let us ask the others'),
  ]);
  const args = verdictArgs({ pool, relook: true });
  assert.equal(await bot.actOnVerdict(args), 'unaddressed');
  assert.equal(seen.posts.length, 0, 'nothing is posted, here or on GitHub');
  assert.equal(seen.seen.length, 1, 'the read is still recorded, so it is not read again for nothing');
  assert.deepEqual(pool.queries.find(([sql]) => /FROM homeroom_bot_posts/.test(sql))[1], [9, 12]);
  assert.deepEqual(pool.queries.find(([sql]) => /metadata->'quote'/.test(sql))[1],
    [9, 12, '2026-10-09T09:02:00Z', 77], 'the words after the note, for its user');
});

test('#6311: a re-read whose note would say the same thing posts nothing, and a changed reason posts', async (t) => {
  const seen = stubLive(t);
  const noteText = live.personHomeroomText({ ...PERSON_PARSED, project: 'Chores', requester: null, deciders: [] });
  const same = fakePool([
    [/SELECT p\.kind, m\.content/, { rows: [{ kind: 'person', content: noteText }] }],
    NOTE_ROUTE,
    [/metadata->'quote'/, { rows: [{ id: 4, content: 'the list one, please', created_at: AFTER, quotes_bot: true }] }],
  ]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: same, relook: true })), 'unchanged');
  assert.equal(seen.posts.length, 0, 'the same note is not posted again');

  seen.posts.length = 0;
  const changed = fakePool([
    [/SELECT p\.kind, m\.content/, { rows: [{ kind: 'person', content: 'I think a person needs to decide this one: something else entirely. The person who asked for it can say Go ahead in a chat with me, or reply here.' }] }],
    NOTE_ROUTE,
    [/metadata->'quote'/, { rows: [{ id: 4, content: 'now it is for a person', created_at: AFTER, quotes_bot: true }] }],
  ]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: changed, relook: true })), 'person');
  assert.equal(seen.posts.length, 1, 'a reason that changed is said');
});

test('the note is posted again after a mention, and after a reply to one of its messages', async (t) => {
  const seen = stubLive(t);
  const mentioned = fakePool([NOTE_ROUTE, talk('@homeroom_bot what did you mean by the header?')]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: mentioned, relook: true })), 'person');
  assert.equal(seen.posts.length, 1);
  assert.equal(seen.posts[0].kind, 'person');

  seen.posts.length = 0;
  const replied = fakePool([
    NOTE_ROUTE,
    [/metadata->'quote'/, { rows: [{ id: 4, content: 'the list one, please', created_at: AFTER, quotes_bot: true }] }],
  ]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: replied, relook: true })), 'person');
  assert.equal(seen.posts.length, 1, 'a Reply counts the same as a mention');
});

test('a first look posts as it always did, and runs no gate query', async (t) => {
  const seen = stubLive(t);
  const pool = fakePool();
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool, relook: false })), 'person');
  assert.equal(seen.posts.length, 1);
  assert.ok(!pool.queries.some(([sql]) => /homeroom_bot_posts/.test(sql)), 'the gate is not even asked');
});

// 6 Nov 2026 (#6430): a go-ahead typed in the request's own discussion is
// the same refusal as one typed in the chat: one plain answer, said to the
// person who gave it, and no note again.
test('#6430: a re-read after a thread go-ahead posts the one plain answer, not the note', async (t) => {
  const seen = stubLive(t);
  const pool = fakePool([[/goAheadCannot/, { rows: [] }]]);
  const parsed = {
    verdict: 'person', reason: 'it was evan\'s go-ahead, and production access is involved',
    goAheadDecides: false, firstStep: 'Just the three missing read tools',
  };
  const acted = await bot.actOnVerdict(verdictArgs({
    pool, relook: false, parsed, goAhead: { by: 'evan', where: 'thread', messageId: 41 },
  }));
  assert.equal(acted, 'person');
  assert.equal(seen.posts.length, 1, 'one post, not a note and an answer');
  const said = seen.posts[0].homeroomText;
  assert.match(said, /even with a go-ahead/);
  assert.match(said, /your go-ahead/, 'the reader is spoken to, never named in the third person');
  assert.doesNotMatch(said, /evan/i);
  assert.doesNotMatch(said, /\bapprove/i, 'it never says somebody has to approve it');
  assert.match(said, /A person has to build it, for example you with a coding agent/);
  assert.match(said, /I can build this part now: Just the three missing read tools\.$/);
  assert.equal(seen.posts[0].dm.goAheadDecides, false);
  assert.equal(seen.posts[0].dm.firstStep, 'Just the three missing read tools');
});

test('#6430: a re-read says nothing when the thread already answered that go-ahead', async (t) => {
  const seen = stubLive(t);
  const pool = fakePool([[/goAheadCannot/, { rows: [{ ok: 1 }] }]]);
  const parsed = { verdict: 'person', reason: 'x', goAheadDecides: false, firstStep: 'Just the read tools' };
  const acted = await bot.actOnVerdict(verdictArgs({
    pool, relook: false, parsed, goAhead: { by: 'evan', where: 'thread', messageId: 41 },
  }));
  assert.equal(acted, 'answered');
  assert.equal(seen.posts.length, 0, 'the refusal appears once, under itself never twice');
});

test('#6399: a person note after "I\'m taking this up now" is posted, with its suggestion buttons', async (t) => {
  const seen = stubLive(t);
  const promised = [/FROM homeroom_bot_posts/, { rows: [{ kind: 'going_ahead', created_at: '2026-10-09T09:02:00Z' }] }];
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: fakePool([promised]), relook: true })), 'person');
  assert.equal(seen.posts.length, 1, 'the promise is never the last word');
  assert.equal(seen.posts[0].kind, 'person');

  // #6399: a read somebody asked for again says what it found, even when its
  // words repeat the last note (#6311 would otherwise hold it).
  seen.posts.length = 0;
  const noteText = live.personHomeroomText({ ...PERSON_PARSED, project: 'Chores', requester: null, deciders: [] });
  const same = fakePool([
    [/SELECT p\.kind, m\.content/, { rows: [{ kind: 'person', content: noteText }] }],
    NOTE_ROUTE,
    talk('the list one, please'),
  ]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: same, relook: true, askedAgain: true })), 'person');
  assert.equal(seen.posts.length, 1, 'a read asked for again posts even when the note repeats');
  assert.equal(same.queries.some(([sql]) => /metadata->'quote'/.test(sql)), false, 'the gate is not asked');
});

test('a re-look that concludes the request is ready still acts', async (t) => {
  const seen = stubLive(t);
  const pool = fakePool();
  const args = verdictArgs({
    pool, relook: true,
    parsed: { verdict: 'ready', buildNote: 'Make the header sticky.', complicated: false },
  });
  assert.equal(await bot.actOnVerdict(args), 'build_queued');
  assert.equal(seen.posts.length, 0, 'the build, not a note, is what this look says');
  assert.ok(!pool.queries.some(([sql]) => /homeroom_bot_posts/.test(sql)), 'a ready verdict is not held for words');
});

test('a look that cannot check whether it was addressed speaks as before', async (t) => {
  const seen = stubLive(t);
  const pool = fakePool([
    [/FROM homeroom_bot_posts/, new Error('database is down')],
  ]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool, relook: true })), 'person');
  assert.equal(seen.posts.length, 1);
});

const QUESTION_PARSED = { verdict: 'question', question: 'Which range should the guesses take?', questionAnswers: ['1 to 100', '1 to 10'] };

test('#4530: an asked look that would only repeat the question it waits on posts nothing', async (t) => {
  const seen = stubLive(t);
  const pool = fakePool([[/FROM homeroom_bot_posts/, { rows: [{ kind: 'question', created_at: '2026-10-09T09:02:00Z' }] }]]);
  const args = verdictArgs({ pool, askedLook: true, parsed: QUESTION_PARSED });
  assert.equal(await bot.actOnVerdict(args), 'unaddressed');
  assert.equal(seen.posts.length, 0, 'not the same question again, here or on GitHub');
  assert.equal(seen.seen.length, 1, 'the read is still recorded');
});

test('#4530: an asked look speaks on a new request, after an answer, and after a word that was not a note', async (t) => {
  const seen = stubLive(t);
  // A request just filed (reason 'asked' too): no note before it.
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: fakePool(), askedLook: true, parsed: QUESTION_PARSED })), 'question');
  assert.equal(seen.posts.length, 1);
  assert.equal(seen.posts[0].kind, 'question');
  // Its question was answered.
  const answered = fakePool([
    [/FROM homeroom_bot_posts/, { rows: [{ kind: 'question', created_at: '2026-10-09T09:02:00Z' }] }],
    talk('1 to 100, please'),
  ]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: answered, askedLook: true, parsed: QUESTION_PARSED })), 'question');
  assert.equal(seen.posts.length, 2);
  // Its last word was a failed build: asking is how it comes back.
  const failed = fakePool([[/FROM homeroom_bot_posts/, { rows: [{ kind: 'build_failed', created_at: '2026-10-09T09:02:00Z' }] }]]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: failed, askedLook: true, parsed: QUESTION_PARSED })), 'question');
  assert.equal(seen.posts.length, 3);
  // A 'changed' look after the same failed build keeps #4530's rule.
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: failed, relook: true, parsed: QUESTION_PARSED })), 'unaddressed');
  assert.equal(seen.posts.length, 3);
  // The request was edited since its question: the button let it through,
  // and so does the gate.
  const waiting = fakePool([[/FROM homeroom_bot_posts/, { rows: [{ kind: 'question', created_at: '2026-10-09T09:02:00Z' }] }]]);
  const edited = verdictArgs({
    pool: waiting, askedLook: true, parsed: QUESTION_PARSED, issue: { title: 'Guess range', updatedAt: '2026-10-09T09:40:00Z' },
  });
  assert.equal(await bot.actOnVerdict(edited), 'question');
  assert.equal(seen.posts.length, 4);
});

// The requester (homeroom-bot-dm requesterOf) and a message of theirs.
const REQUESTER_ROUTE = [/FROM homeroom_bot_requesters q JOIN users/, {
  rows: [{ user_id: REQUESTER, username: 'evan', first_version: false, issue_title: 'Add Rumi', is_synthetic: false }],
}];
const said = (userId, body) => [/metadata->'quote'/, { rows: [{ id: 5, user_id: userId, content: body, created_at: AFTER, quotes_bot: false }] }];

test('#6146: a repeat person note is said again after its requester\'s or a named decider\'s plain reply, not anyone else\'s', async (t) => {
  const seen = stubLive(t);
  const answered = fakePool([NOTE_ROUTE, REQUESTER_ROUTE, said(REQUESTER, 'Yep can you add it via commit?')]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: answered, relook: true })), 'person');
  assert.equal(seen.posts.length, 1, 'the requester is answered');

  const named = { requester: 'evan', members: 3, requesterDecides: false, deciders: [{ username: 'snait', role: 'creator' }] };
  const byDecider = fakePool([
    NOTE_ROUTE, REQUESTER_ROUTE, [/SELECT id FROM users WHERE username = ANY/, { rows: [{ id: DECIDER }] }], said(DECIDER, 'Go ahead.'),
  ]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: byDecider, relook: true, decider: named })), 'person');
  assert.equal(seen.posts.length, 2, 'so is a decider the note names');

  const other = fakePool([NOTE_ROUTE, REQUESTER_ROUTE, said(OTHER, 'I would wait for the others.')]);
  assert.equal(await bot.actOnVerdict(verdictArgs({ pool: other, relook: true, decider: named })), 'unaddressed');
  assert.equal(seen.posts.length, 2, 'somebody else is still talking among themselves');
});

test('runTriage gates exactly the looks the request itself started, and the ones somebody asked for', () => {
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /relook: item\.reason === 'changed' \|\| item\.reason === READ_AGAIN_REASON,\s*\n/);
  assert.match(src, /askedLook: item\.reason === ASKED_REASON,\s*\n\s*comments,/);
  // #6399: only a read somebody asked for again is never held by the gate.
  assert.match(src, /askedAgain: item\.reason === READ_AGAIN_REASON && Number\(item\.requested_by\) > 0,/);
  assert.match(src, /const ASKED_REASON = 'asked';/);
  assert.match(src, /const gated = \(relook \|\| askedLook\) && !askedAgain && !capSuppressed && addressedMod\(\)\.NOTE_KINDS\.includes\(parsed\.verdict\);/);
  assert.match(src, /const gate = gated\n\s+\? await addressedMod\(\)\.shouldSpeak\(pool, \{/);
  assert.match(src, /waitingOnly: !relook,/);
  // The two doors that queue a look: the request page's button and a request
  // filed on a project the bot builds on. #6399: the page's button asks for a
  // read again when it is that request's card saying so.
  const dm = read('src/services/homeroom-bot-dm.js');
  assert.equal((dm.match(/reason: 'asked'/g) || []).length, 1);
  assert.match(dm, /reason: readAgain \? settingsModule\(\)\.READ_AGAIN_REASON : 'asked'/);
  assert.match(dm, /readAgain = false \}/);
});

// ── The queries, against the real schema ──

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `hrbot_addr_${crypto.randomBytes(6).toString('hex')}`;
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

test('the gate reads the last note and the words since it, against PostgreSQL', { timeout: 120000 }, async (t) => {
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
  const drea = await user('drea');
  const evan = await user('evan');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Chores', 'chores', 'running', $1, 'https://github.com/usernode-bot/chores', 'public', 'public')
     RETURNING id, slug, name, repo_url`,
    [evan.id],
  );
  const n = 12;

  // 9:02 the bot left its person note; 9:05 it spoke once more on the thread;
  // 9:10 drea replied to that line; 9:12 evan added to the talk; and one of
  // drea's messages is deleted, so it counts for nothing.
  await pool.query(
    `INSERT INTO homeroom_bot_posts (app_id, issue_number, kind, created_at)
     VALUES ($1, $2, 'person', '2026-10-09T09:02:00Z')`,
    [app.id, n],
  );
  const post = (userId, content, at, issueNo = n) => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
     VALUES ($1, $2, $3, 'message', 'issue', $4, $5::timestamptz) RETURNING id`,
    [app.id, userId, content, issueNo, at],
  );
  await post(homeroomBot.id, '@Drea @evan Homeroom bot thinks a person needs to decide this one.', '2026-10-09T09:02:30Z');
  const { rows: [botLine] } = await post(homeroomBot.id, 'The two layouts are the cards and the list.', '2026-10-09T09:05:00Z');
  // The Reply quotes the bot's line by id, as the chat's Reply action stores
  // it (metadata.quote.refMsgId).
  const reply = await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at, metadata)
     VALUES ($1, $2, $3, 'message', 'issue', $4, $5::timestamptz, $6::jsonb) RETURNING id`,
    [app.id, drea.id, 'The list one, please', n, '2026-10-09T09:10:00Z', JSON.stringify({ quote: { refMsgId: String(botLine.id) } })],
  );
  await post(evan.id, 'Agreed, let us ask the others at the next meeting.', '2026-10-09T09:12:00Z');
  const gone = await post(drea.id, 'deleted while thinking', '2026-10-09T09:13:00Z');
  await pool.query('UPDATE chat_messages SET deleted_at = NOW() WHERE id = $1', [gone.rows[0].id]);

  const loaded = await addressed.loadAddressed(pool, { appId: app.id, issueNumber: n, botId: homeroomBot.id });
  assert.equal(loaded.lastNote.kind, 'person');
  assert.equal(loaded.messages.length, 2, 'the bot\'s own lines and the deleted one are left out');
  assert.deepEqual(loaded.messages.map((m) => m.quotesBot), [true, false], 'the Reply names the bot\'s message');
  assert.deepEqual(loaded.messages.map((m) => m.userId), [drea.id, evan.id], '#6146: and who wrote each');
  assert.equal(new Date(loaded.messages[0].createdAt).toISOString(), '2026-10-09T09:10:00.000Z');

  const replied = await addressed.shouldSpeak(pool, { appId: app.id, issueNumber: n, botId: homeroomBot.id });
  assert.deepEqual(replied, { speak: true, why: 'reply' }, 'a Reply to its message, read back through the query');

  // A second request the bot noted on, where the two of them only talk to
  // each other, and then mention it.
  const other = 13;
  await pool.query(
    `INSERT INTO homeroom_bot_posts (app_id, issue_number, kind, created_at)
     VALUES ($1, $2, 'person', '2026-10-09T09:02:00Z')`,
    [app.id, other],
  );
  await post(drea.id, 'The list layout is easier on a phone.', '2026-10-09T09:10:00Z', other);
  await post(evan.id, 'Agreed, let us ask the others at the next meeting.', '2026-10-09T09:12:00Z', other);
  const quiet = await addressed.shouldSpeak(pool, { appId: app.id, issueNumber: other, botId: homeroomBot.id });
  assert.deepEqual(quiet, { speak: false, why: 'not_addressed' }, 'two people among themselves');
  assert.deepEqual(await addressed.shouldSpeak(pool, { appId: app.id, issueNumber: other, botId: homeroomBot.id, answerers: [drea.id] }),
    { speak: true, why: 'answer' }, '#6146: but drea asked for it, and her plain message is her answer');

  await post(evan.id, '@homeroom_bot then make it the list one', '2026-10-09T09:20:00Z', other);
  const now = await addressed.shouldSpeak(pool, { appId: app.id, issueNumber: other, botId: homeroomBot.id });
  assert.deepEqual(now, { speak: true, why: 'mention' }, 'a mention is heard through the same query');

  const nowhere = await addressed.shouldSpeak(pool, { appId: app.id, issueNumber: 99, botId: homeroomBot.id });
  assert.deepEqual(nowhere, { speak: true, why: 'first_note' }, 'no note on this request yet');
  assert.ok(reply.rows[0].id);
});

test('#4530: which requests the bot waits on, and its own comments by id, against PostgreSQL', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const homeroomBot = await user('homeroom_bot', true);
  const drea = await user('drea');
  const evan = await user('evan');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Number guessing', 'number-guessing', 'running', $1, 'https://github.com/usernode-bot/number-guessing', 'public', 'public')
     RETURNING id`,
    [evan.id],
  );
  const say = async (n, userId, content, at, metadata = null) => (await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at, metadata)
     VALUES ($1, $2, $3, 'message', 'issue', $4, $5::timestamptz, $6::jsonb) RETURNING id`,
    [app.id, userId, content, n, at, JSON.stringify(metadata || {})],
  )).rows[0].id;
  // A note as live.post leaves one: its row, its GitHub comment's id, and its
  // copy in the discussion from the bot's own user.
  const note = async (n, kind, at, commentId) => {
    const messageId = await say(n, homeroomBot.id, `Homeroom bot (${kind})`, at);
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, kind, created_at, github_comment_id, thread_message_id)
       VALUES ($1, $2, $3, $4::timestamptz, $5, $6)`,
      [app.id, n, kind, at, commentId, messageId],
    );
    return messageId;
  };
  await note(51, 'looking', '2026-10-09T09:00:00Z', 7001);
  const asked51 = await note(51, 'question', '2026-10-09T09:02:00Z', 7002); // unanswered
  await note(52, 'question', '2026-10-09T09:02:00Z', 7003);
  await say(52, drea.id, '1 to 100, please', '2026-10-09T09:05:00Z'); // answered
  const person53 = await note(53, 'person', '2026-10-09T09:02:00Z', 7004);
  await say(53, drea.id, 'Let us ask the others', '2026-10-09T09:05:00Z'); // among themselves
  const person54 = await note(54, 'person', '2026-10-09T09:02:00Z', 7005);
  await say(54, evan.id, 'the list one', '2026-10-09T09:05:00Z', { quote: { refMsgId: String(person54) } }); // a Reply to it
  await note(55, 'question', '2026-10-09T09:02:00Z', 7006);
  await note(55, 'proposal', '2026-10-09T09:20:00Z', 7007); // built since

  const loaded = await addressed.loadAddressed(pool, { appId: app.id, issueNumber: 51, botId: homeroomBot.id });
  assert.deepEqual([...loaded.ownCommentIds].sort(), ['7001', '7002'], 'every comment it recorded posting there');
  assert.equal(Number(loaded.lastNote.thread_message_id), asked51);

  const at = (h) => `2026-10-09T${h}Z`;
  const waiting = await addressed.waitingByIssue(pool, {
    appId: app.id, botId: homeroomBot.id,
    issues: [51, 52, 53, 54, 55, 56].map((number) => ({ number, updatedAt: at('09:02:01') })),
  });
  assert.deepEqual([...waiting.keys()].sort(), [51, 53]);
  assert.deepEqual(waiting.get(51), { kind: 'question', messageId: asked51 });
  assert.deepEqual(waiting.get(53), { kind: 'person', messageId: person53 });
  // #6146: drea is the one who decides on 53, so her plain message answers it.
  const answered = await addressed.waitingByIssue(pool, {
    appId: app.id, botId: homeroomBot.id, issues: [{ number: 53, updatedAt: at('09:02:01') }],
    answerersOf: async (n) => (n === 53 ? [drea.id] : []),
  });
  assert.equal(answered.size, 0, 'a person note its decider answered in the discussion');
  const edited = await addressed.waitingByIssue(pool, {
    appId: app.id, botId: homeroomBot.id, issues: [{ number: 51, updatedAt: at('09:40:00') }],
  });
  assert.equal(edited.size, 0, 'a request edited on GitHub since its note is news');
  assert.equal((await addressed.waitingByIssue(pool, { appId: app.id, botId: homeroomBot.id, issues: [] })).size, 0);

  // One request, with its GitHub issue read fresh and then its comments.
  const reads = [];
  const github = (comments, updatedAt = at('09:02:02')) => ({
    async fetchPublicIssue(owner, repo, n, opts) { reads.push(['issue', owner, repo, n, opts]); return { issue: { number: n, updatedAt } }; },
    async fetchIssueComments(owner, repo, n) { reads.push(['comments', n]); return { comments, truncated: false }; },
    async getBotUsername() { throw new Error('no installation'); },
  });
  const repo = { owner: 'usernode-bot', repo: 'number-guessing' };
  const one = (gh, issueNumber = 51) => addressed.waitingOnRequest(pool, { appId: app.id, issueNumber, botId: homeroomBot.id, github: gh, repo });
  const ownOnly = [{ id: 7002, author: 'usernode-bot[bot]', body: 'Homeroom bot asked: which range?', createdAt: at('09:02:01') }];
  assert.deepEqual(await one(github(ownOnly)), { kind: 'question', messageId: asked51 },
    'its own comment, known by its id with no login, is not an answer');
  assert.deepEqual(reads.map((r) => r[0]), ['issue', 'comments'], 'the issue first, then its comments');
  assert.deepEqual(reads[0].slice(1), ['usernode-bot', 'number-guessing', 51, { fresh: true }]);
  assert.equal(await one(github([...ownOnly, { id: 8001, author: 'drea-gh', body: '1 to 100', createdAt: at('09:03:00') }])), null,
    'answered on GitHub only');
  assert.equal(await one(github(ownOnly, at('09:40:00'))), null, 'edited since');
  reads.length = 0;
  assert.equal(await one(github(ownOnly), 52), null, 'answered in the discussion');
  assert.deepEqual(reads, [], 'and GitHub is not read for it');
  assert.equal(await one({
    async fetchPublicIssue() { return { issue: null, note: 'rate limited' }; },
    async fetchIssueComments() { throw new Error('not reached'); },
  }), null, 'what cannot be read leaves it not waiting');
  assert.equal(await one({
    async fetchPublicIssue(_o, _r, n) { return { issue: { number: n, updatedAt: at('09:02:02') } }; },
    async fetchIssueComments() { return { comments: [], truncated: true }; },
  }), null, 'nor a comment list cut short');
});
