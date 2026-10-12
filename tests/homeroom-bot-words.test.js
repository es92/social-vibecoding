'use strict';

// The Homeroom bot's notes, in its own voice in Homeroom
// (src/services/homeroom-bot-words.js). Every fixed note the bot posts on a
// request or a change goes through firstPerson for its Homeroom copy; GitHub
// keeps it as written. A new note that still speaks about the bot in the
// third person fails here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { firstPerson } = require('../src/services/homeroom-bot-words');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const holds = require('../src/services/homeroom-bot-holds');
const dm = require('../src/services/homeroom-bot-dm');

const SPEC = '# Hourly feed refresh\n\nRefresh every hour.';
const BOT = { id: 1, username: 'homeroom_bot' };

function notes() {
  const now = new Date('2026-10-09T12:00:00Z');
  const held = [{ kind: 'claim', username: 'ada', since: '2026-10-08T12:00:00Z' }];
  return [
    live.lookingText(),
    live.questionText({ question: 'Which list?' }),
    live.questionText({ question: 'a', plan: { questions: [{ question: 'One?' }, { question: 'Two?' }] } }),
    live.personText({ reason: 'That changes sign-in.' }),
    live.personText({ reason: 'Sign-in is a platform setting', platform: true, project: 'Plant Pal' }),
    live.emptyText({ reason: 'Nothing named.' }),
    live.proposalText({ link: 'https://x/1', prNumber: 12 }),
    live.liveText({ title: 'Dark mode' }),
    live.retryCommentText(),
    live.buildFailedText('budget: wall clock'),
    live.buildFailedText('the turn produced no change'),
    live.buildFailedText('restarted mid-build'),
    live.heldText({ cap: 'proposals_per_app', limit: 5 }),
    live.heldText({ cap: 'proposals_per_app', limit: 5, project: 'Plant Pal' }),
    live.heldText({ cap: 'proposals_total', limit: 100 }),
    live.heldText({ cap: 'question_tripwire', verdict: 'question', limit: 10 }),
    live.heldText({ cap: 'question_tripwire', verdict: 'plan', limit: 10 }),
    live.blockedText('That needs a payment provider.'),
    live.specCommentText(SPEC),
    live.specCommentText(SPEC, { approved: true }),
    live.planCommentText({ spec: SPEC, questions: [{ question: 'Hourly?', answers: ['Yes'] }] }),
    live.specCard({ sessionId: 1, version: 1, spec: SPEC, bot: BOT }).content,
    live.specCard({ sessionId: 1, version: 1, spec: SPEC, bot: BOT, asking: true }).content,
    live.specCard({ sessionId: 1, version: 1, spec: SPEC, bot: BOT, approved: true }).content,
    followup.answerText({ reply: 'It sorts by date now.' }),
    followup.askText({ reply: 'Which header?' }),
    followup.personText({ reply: 'That is a product call.' }),
    followup.revisedText({ summary: 'Moved the bar into the header.', reply: 'Done.' }),
    followup.revisionFailedText({ why: 'revise: the turn produced no change' }),
    followup.revisionFailedText({ why: 'x', canRevise: false }),
    followup.workingText(),
    followup.waitText('session_busy'),
    followup.waitText('allowance'),
    followup.waitText('budget'),
    followup.waitText('paused'),
    followup.replyFailedText({ why: 'it ran out of time', retrying: true }),
    followup.replyFailedText({ why: 'it ran out of time' }),
    followup.checksRevisedText({ summary: 'Seeded the demo list.' }),
    followup.checksRevisedText({ summary: 'Fixed the save.', broken: true, failing: false }),
    followup.checksRetryText(),
    followup.checksPersonText({ why: 'That needs a decision', failingCount: 2 }),
    followup.checksPersonText({ why: 'x', broken: [{ claim: 'Save works' }] }),
    followup.checksPersonText({ why: 'it has already updated this change 3 times, as many as it may on its own', failingCount: 1 }),
    followup.checksPersonText({ why: 'its attempt to fix them ran out of time', failingCount: 2 }),
    followup.checksRetryText({ skipped: true, failing: false }),
    followup.checksRevisedText({ summary: 'Seeded it.', skipped: true, failing: false }),
    followup.replyFailedText({ why: 'it ran out of time' }),
    followup.replyFailedText({ why: 'something went wrong while it worked on it', retrying: true }),
    followup.checksNotChangeText({ failingCount: 1 }),
    holds.leavingText(held, now),
    holds.leavingText([{ kind: 'proposal', username: 'ada', since: '2026-10-08T12:00:00Z' }], now),
    holds.goingText({ asker: 'evan' }),
    holds.goingText({ asker: 'evan', holders: held }),
    dm.updateFailedWords('budget: wall clock', 'this change', 'bot'),
  ];
}

test('every fixed note reads in the bot\'s own voice in Homeroom', () => {
  for (const note of notes()) {
    const own = firstPerson(note);
    assert.doesNotMatch(own, /Homeroom bot/, `still about the bot: ${own}`);
    assert.doesNotMatch(own, /\bit will (look|try) again\b/, `still "it will": ${own}`);
    assert.doesNotMatch(own, /\bIt (will|is|builds)\b/, `still "It": ${own}`);
  }
});

// One request, one story: in Homeroom the bot speaks of itself in the first
// person and in whole sentences, and in Homeroom's words: a request, a
// change, never an issue or a proposal, and no pull request number.
test('every fixed note uses Homeroom\'s words, and the bot never speaks of itself as "it"', () => {
  for (const note of notes()) {
    const own = firstPerson(note);
    assert.doesNotMatch(own, /\bissue\b|\bproposal\b|PR #\d/i, `not Homeroom's words: ${own}`);
    assert.doesNotMatch(own, /\bits attempt\b|\bit ran out of time\b|\bas many as it may\b|\bwhile it worked\b/, `still "it": ${own}`);
  }
});

test('the words people and the model wrote pass through unchanged', () => {
  assert.equal(firstPerson('It changes sign-in, so a person decides.'), 'It changes sign-in, so a person decides.');
  assert.equal(firstPerson('The Homeroom bot docs say so.'), 'The Homeroom bot docs say so.');
  assert.equal(firstPerson(''), '');
  assert.equal(firstPerson(null), null);
  assert.equal(
    firstPerson(live.questionText({ question: 'Which list should it use?' })),
    // "Issue" is GitHub's word: in Homeroom the request is where you reply.
    'I have a question before I can build this:\n\nWhich list should it use?\n\nReply here and I\'ll look again.',
  );
});

test('a follow-up\'s answer loses its header: the bubble already says who is talking', () => {
  assert.equal(firstPerson(followup.answerText({ reply: 'It sorts by date now.' })), 'It sorts by date now.');
  assert.equal(
    firstPerson(followup.revisedText({ summary: 'Moved the bar into the header.' })),
    // One note per update: the cleared votes are the platform's line to say.
    'I updated this change: Moved the bar into the header.',
  );
});
