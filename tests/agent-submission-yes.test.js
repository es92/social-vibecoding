'use strict';

// 11 Nov 2026: proposing is never a yes. Opening a change or a decision, on
// Homeroom or through a coding agent (the connector's submit_work or
// propose_featured_illustration, a local agent's hand-off), says nothing:
// its author's yes counts like anyone's, once they tap it ("Submitting
// anything shouldn't count as a yes"). The first case was a change a coding
// agent submitted (29 Oct 2026: "they should just have to manually do it,
// not have it auto-done by the connector"); a card picture filed through the
// connector then went live the moment it was filed, as its creator's yes.
//
// This holds the rule (governance-rules.ts, "PROPOSING IS NOT A YES") and
// the places that read it: the batch options behind the lists, the ballot,
// and the AI tab, which leaves a vote you owe to Needs you.
// tests/agent-submission-yes-postgres.test.js runs it against the schema.
//
// Run with: node --test tests/agent-submission-yes.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/services/governance-rules');
const governance = require('../src/services/governance');
const aiWork = require('../src/services/ai-work');
const { loadTsx } = require('./lib/render-tsx');

const NOW = Date.UTC(2026, 10, 11, 15);
const OPENED = new Date(NOW - 60 * 1000).toISOString();

// ada (1) made the project; sam (2) and kim (3) are members.
const ADA = 1;
const SAM = 2;
const KIM = 3;

const facts = () => ({
  creatorId: ADA, memberCount: 3, membersActive: 3, adminIds: [], groups: new Map(), activeIds: null,
});
const preset = (key) => ({ approverPolicy: 'anyone', approvalsRequired: null, rules: rules.parseRulesBlock({ preset: key }) });

function gate(gov, { yes = [], no = [], author = SAM } = {}) {
  const f = facts();
  return governance.computeGate(gov, f.membersActive, yes.length, no.length, OPENED, NOW, {
    voters: { yes: new Set(yes), no: new Set(no) },
    rulesFacts: f,
    authorId: author,
    memberCount: f.memberCount,
  });
}

test('Open floor: a change waits for a tap, its author\'s or anyone\'s', () => {
  const waiting = gate(preset('open_floor'));
  assert.equal(waiting.mergeable, false, 'proposing it is not a yes');
  assert.equal(waiting.qualifiedYes, 0, 'and no yes is shown for it');
  assert.equal(gate(preset('open_floor'), { yes: [SAM] }).mergeable, true, 'the author\'s own tap counts');
  assert.equal(gate(preset('open_floor'), { yes: [KIM] }).mergeable, true, 'as does anyone else\'s');
});

test('Two yeses: two taps, the author\'s among them if they want', () => {
  assert.equal(gate(preset('two_yeses'), { yes: [KIM] }).mergeable, false, 'one more is not two');
  assert.equal(gate(preset('two_yeses'), { yes: [KIM, SAM] }).mergeable, true);
  assert.equal(gate(preset('two_yeses'), { yes: [KIM, ADA] }).mergeable, true, 'any two people');
});

test('You or the group: the creator\'s own change is theirs to approve with a tap', () => {
  const proposed = gate(preset('you_or_the_group'), { author: ADA });
  assert.equal(proposed.creatorYes, false, 'nobody has said yes yet');
  assert.equal(proposed.mergeable, false);
  const tapped = gate(preset('you_or_the_group'), { author: ADA, yes: [ADA] });
  assert.equal(tapped.creatorYes, true);
  assert.equal(tapped.mergeable, true);
  const said = gate(preset('you_or_the_group'), { author: SAM, yes: [ADA] });
  assert.equal(said.creatorYes, true, 'the creator\'s tap on somebody else\'s change');
  assert.equal(said.mergeable, true);
});

test('a decision the creator opened (a card picture, a rename) waits for their tap too', () => {
  // A governance vote is decided by the same gate, with its opener as author.
  const opened = gate(preset('you_or_the_group'), { author: ADA });
  assert.equal(opened.mergeable, false);
  assert.equal(gate({ approverPolicy: 'anyone', approvalsRequired: null,
    rules: rules.parseRulesBlock({ rules: [{ group: 'creator', atLeast: 1 }] }) }, { author: ADA }).mergeable, false,
  'the creator\'s yes, unsaid');
});

test('Group vote counts votes as cast, as it always did', () => {
  assert.equal(gate(preset('group_vote')).mergeable, false);
  assert.equal(gate(preset('group_vote'), { author: ADA }).mergeable, false);
});

test('rulesGateOpts carries the author for the member floor and nothing about proposing', () => {
  const ctx = { facts: facts(), voters: new Map() };
  const opts = governance.rulesGateOpts(ctx, 7, SAM, null);
  assert.equal(opts.authorId, SAM);
  for (const gone of ['authorIsBot', 'madeByAgent', 'authorWithdrew']) {
    assert.equal(gone in opts, false, `${gone} is no longer read`);
  }
  for (const gone of ['authorIsBot', 'madeByAgent', 'authorWithdrew', 'botAuthoredBatch', 'agentMadeBatch', 'authorWithdrewBatch']) {
    assert.equal(typeof governance[gone], 'undefined', `governance.${gone} is gone`);
  }
});

test('on a ballot your own change is not your pick until you make it', () => {
  const { ballotOf, ballotVotes } = loadTsx('frontend/src/features/dev-board/topic/thread-model.ts');
  const thread = { number: 11 };
  const mine = { type: 'change', id: 51, state: 'review', closes: [11], mine: true, myVote: null, epoch: 1 };
  const theirs = { type: 'change', id: 52, state: 'review', closes: [11], mine: false, myVote: null, epoch: 1 };
  const ballot = ballotOf({ thread, items: [mine, theirs] });
  assert.equal(ballot.pick, null, 'proposing it picked nothing');
  assert.deepEqual(JSON.parse(JSON.stringify(ballotVotes(ballot, 51))), [
    { kind: 'change', sessionId: 51, vote: 'yes', epoch: 1 },
  ], 'choosing it casts the yes');
});

test('the AI tab leaves your own change to Needs you until you vote on it', () => {
  // check_state: 'passing' so this row is a change waiting on votes, which is
  // what this test is about; one still waiting for its checks says so instead
  // (#6060), pinned in tests/ai-screen.test.js.
  const row = { change_status: 'promoted', check_state: 'passing', change_user: SAM, state: 'open', promoted_at: OPENED, voted: false };
  const vote = { stage: 'up_for_vote', why: null, reason: null, line: null, since: OPENED };
  assert.equal(aiWork.standing(row, SAM), null, 'yours, unvoted: a vote you owe, however it was made');
  assert.deepEqual(aiWork.standing({ ...row, voted: true, my_vote: 'yes' }, SAM),
    { group: 'waiting', work: vote, at: OPENED, myVote: 'yes' });
  assert.equal(aiWork.standing(row, KIM), null, 'someone else\'s, unvoted, is owed as before');
});
