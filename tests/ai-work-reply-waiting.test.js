'use strict';

// #6228 (3 Nov 2026): a person's reply on a request the bot handed back
// leaves Needs you (Decide) the moment it is stored. #6245, #6246, #6313:
// a plan is timed from when it began waiting, wins over a reply, and a read
// queued after a plan that failed is retrying the plan.
//
// 5 Nov 2026 (docs/plans/bot-one-model.md, step 3): these are decided once,
// by the stored work state (services/work-state.js derive, from the shared
// per-request facts), and the Homeroom bot page places that state for the
// viewer (services/ai-work.js standing). Both halves are pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { standing, listsOf } = require('../src/services/ai-work');
const { derive } = require('../src/services/work-state');

const NOW = new Date('2026-11-03T17:00:00Z');
const row = {
  state: 'open', kind: 'request', number: 6209, request_id: 1, request_state: 'open', own: true,
  request_at: '2026-11-03T15:00:00Z', created_at: '2026-11-03T15:00:00Z',
};
// A request's facts row (work-state.js REQUEST_FACTS_SQL), as derive reads it.
const facts = (extra = {}) => ({
  app_id: 1, issue_number: 6209, request_closed: false, request_at: '2026-11-03T15:00:00Z', ...extra,
});
const stored = (extra) => ({ ...derive(facts(extra), { now: NOW }), requesterId: 7 });
const handedBack = { mode: 'live', verdict: 'person', run_at: '2026-11-03T15:00:00Z' };

test('#6228: a reply the bot will read is Reading your reply, In progress, not Decide', () => {
  const reading = stored({ ...handedBack, queue_id: 3, started_at: '2026-11-03T16:52:00Z', reply_at: '2026-11-03T16:50:00Z' });
  assert.deepEqual([reading.stage, reading.line], ['reading', { code: 'reply' }]);
  assert.deepEqual(standing(row, 7, NOW, 99, reading), {
    group: 'next',
    work: {
      stage: 'reading', why: null, reason: null, line: { code: 'reply' }, since: '2026-11-03T16:52:00.000Z',
      words: { stage: { id: 'core:work.stage.reading' }, stageOthers: { id: 'core:work.stage.reading' }, line: { id: 'core:work.line.reply' } },
    },
    at: '2026-11-03T16:52:00.000Z',
  });
  // A plain read of the request is unchanged.
  const plain = stored({ ...handedBack, queue_id: 3, started_at: '2026-11-03T16:52:00Z' });
  assert.deepEqual([plain.stage, plain.line], ['reading', null]);
});

test('#6228: a reply stored with its read queued leaves Decide at once, for every viewer', () => {
  const waits = stored({ ...handedBack, queue_id: 3, enqueued_at: '2026-11-03T16:58:00Z', reply_at: '2026-11-03T16:57:00Z' });
  assert.notEqual(waits.why, 'decide', 'no longer the requester\'s to decide');
  assert.equal(standing(row, 8, NOW, 99, waits, { decides: true }).group === 'needs', false);
  // With no reply and no queue row, it is the requester's to decide.
  const back = stored(handedBack);
  assert.deepEqual([back.stage, back.why], ['waiting_for_you', 'decide']);
  assert.equal(standing(row, 8, NOW, 99, back, { decides: true }).group, 'needs');
  assert.equal(standing(row, 8, NOW, 99, back, { decides: false }).group, 'waiting', 'anyone else waits on that person');
});

// #6245 (4 Nov 2026): what the bot waits on you for is timed from when it
// began waiting, never from the change's or its page's last activity (a
// view bumps that), so the row keeps its place in Needs you.
test('#6245: a plan or a hand-back is timed from when it began waiting on you', () => {
  const touched = { ...row, last_activity_at: '2026-11-03T16:59:00Z' };
  const plan = stored({ mode: 'live', verdict: 'ready', run_at: '2026-11-03T15:00:00Z', plan_waiting_at: '2026-11-03T16:30:00Z' });
  assert.deepEqual([plan.stage, plan.why], ['waiting_for_you', 'plan']);
  assert.equal(standing(touched, 7, NOW, 99, plan).at, '2026-11-03T16:30:00.000Z', 'its own waiting time');
  const back = stored(handedBack);
  assert.equal(standing(touched, 7, NOW, 99, back).at, '2026-11-03T15:00:00.000Z', 'when the bot handed it back, not the activity');
  const stopped = stored({ mode: 'live', verdict: 'ready', build_ok: false, build_error: 'turn timed out', run_at: '2026-11-03T15:00:00Z' });
  assert.deepEqual([stopped.stage, standing(touched, 7, NOW, 99, stopped).at], ['stopped', '2026-11-03T15:00:00.000Z']);
});

// #6246 (4 Nov 2026): a plan waiting for Build it is Needs you's even when a
// reply waits to be read beside it.
test('#6246: a waiting plan wins over a reply being read', () => {
  const plan = stored({
    mode: 'live', verdict: 'ready', run_at: '2026-11-03T16:30:00Z', plan_waiting_at: '2026-11-03T16:40:00Z',
    reply_at: '2026-11-03T16:50:00Z', queue_id: 3, enqueued_at: '2026-11-03T16:51:00Z',
  });
  assert.deepEqual([plan.stage, plan.why], ['waiting_for_you', 'plan']);
  assert.deepEqual(standing(row, 7, NOW, 99, plan), {
    group: 'needs',
    work: {
      stage: 'waiting_for_you', why: 'plan', reason: null, line: null, since: '2026-11-03T16:40:00.000Z',
      words: { stage: { id: 'core:work.why.plan' }, stageOthers: { id: 'core:work.whyOthers.plan' }, line: null },
    },
    at: '2026-11-03T16:40:00.000Z',
  });
});

// #6313 (4 Nov 2026): a request queued for another read after Homeroom bot
// could not write its plan says it is retrying the plan, not that it waits
// for a free builder; once a read starts, the plain reading line returns.
test('#6313: a read queued after a plan that could not be written is retrying the plan', () => {
  const failedPlan = {
    mode: 'live', verdict: 'ready', build_ok: false, build_error: 'no plan could be written', run_at: '2026-11-03T16:50:00Z',
    queue_id: 3, enqueued_at: '2026-11-03T16:58:00Z',
  };
  const queued = stored(failedPlan);
  const words = require('../src/services/work-state').says(queued);
  assert.deepEqual([queued.stage, queued.line], ['planning', { code: 'retry_plan' }]);
  assert.equal(standing(row, 7, NOW, 99, queued).group, 'waiting');
  assert.equal(words, 'Planning · Trying the plan again');
  // A queued read after some other failure is the plain queue.
  const other = stored({ ...failedPlan, build_error: 'turn timed out' });
  assert.deepEqual([other.stage, other.line.code], ['reading', 'queued']);
  // A read under way is reading the request, whatever failed before.
  assert.deepEqual(stored({ ...failedPlan, started_at: '2026-11-03T16:59:00Z' }).stage, 'reading');
  // The bot's own answer names it in the stage words the page shows.
  const lists = listsOf([], {
    private: [], needs: [], live: [], next: [],
    waiting: [{ ...standing(row, 7, NOW, 99, queued), app: { slug: 'homeroom' }, number: 6209, title: 'T', threadId: 5 }],
  }, { botUsername: 'homeroom-bot' });
  assert.equal(lists.waiting[0].says, words);
});

// 6 Nov 2026: a thread with a request number but no request row (an old
// request from before the move off GitHub, never mirrored into `requests`)
// is not listed. Before, it fell back to "waiting to be read" and drew a row
// with no title, "Not started yet", that opened the project's Workshop:
// twelve of them under Not moving on Evan's tab.
test('a thread whose request has no row is not listed as Not started yet', () => {
  const orphan = { state: 'open', kind: 'request', number: 52, request_id: null, request_state: null, own: true,
    created_at: '2026-04-20T10:00:00Z' };
  assert.equal(standing(orphan, 7, NOW, 99, null), null, 'no row on the tab');
  // 11 Nov 2026: the tab reads stored rows alone (statesFor makes a missing
  // one first, and only for a request that has a row: shapeThread), so a
  // thread with no stored state is not listed, open or not.
  assert.equal(standing(row, 7, NOW, 99, null), null);
  assert.equal(require('../src/services/ai-work').fallbackState, undefined, 'no second decider');
});

// #6807: a change whose failing check is not its own, while Homeroom bot gets
// that check fixed, is the bot still working: In progress, Fixing, never
// Needs you with Ask again.
test('#6807: a change waiting on a fix for the check it fails on is In progress, not Needs you', () => {
  const botChange = {
    ...row, own: true, change_id: 5001, change_status: 'promoted', change_user: 99, needs_fix: true, bot_handed_off: true,
  };
  const failing = {
    proposal_status: 'promoted', proposal_at: '2026-11-03T15:00:00Z', check_state: 'failing',
    checks_sha: 'a'.repeat(40), reviewed_head_sha: 'a'.repeat(40),
  };
  const fixing = stored({ ...failing, flake_fixing: true });
  assert.deepEqual([fixing.stage, fixing.line], ['checking', { code: 'fixing_check' }]);
  const placed = standing(botChange, 7, NOW, 99, fixing);
  assert.equal(placed.group, 'next', 'Waiting & in progress');
  assert.equal(placed.botFixFailed, undefined, 'nothing asks the requester to act');
  assert.deepEqual(placed.work.words.line, { id: 'core:work.line.fixingCheck' });
  assert.deepEqual(placed.work.words.stage, { id: 'core:work.stage.fixing' });
  // Without the wait it is the requester's again, as today.
  const stopped = standing(botChange, 7, NOW, 99, stored(failing));
  assert.deepEqual([stopped.group, stopped.botFixFailed], ['needs', true]);
});
