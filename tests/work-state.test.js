'use strict';

// 5 Nov 2026 (docs/plans/bot-one-model.md, step 3): one work state per
// request and change. These pin the decider, where an item goes for each
// viewer, and the moments a change of stage rings.

const test = require('node:test');
const assert = require('node:assert/strict');
const ws = require('../src/services/work-state');

const NOW = new Date('2026-11-05T12:00:00Z');
const ago = (min) => new Date(NOW.getTime() - min * 60 * 1000).toISOString();
const base = { app_id: 1, issue_number: 7, mode: 'live', run_at: ago(30), request_closed: false };
const derive = (extra) => ws.derive({ ...base, ...extra }, { now: NOW });

test('the ten stages, and nothing else, are what a request can be in', () => {
  assert.deepEqual(ws.STAGES, ['reading', 'planning', 'waiting_for_you', 'building', 'checking',
    'up_for_vote', 'going_live', 'live', 'stopped', 'closed']);
  assert.deepEqual(ws.WHYS, ['question', 'plan', 'decide', 'already_works', 'needs_detail']);
});

// #6399: #6351's hand-back reason named a limit Homeroom lifted on 6 Nov
// 2026 (it could not read a plan a person posted), so its card offers to
// read it again rather than keeping a reason that is no longer true.
test('#6399: a hand-back reason a release has since lifted is out of date', () => {
  const line = {
    code: 'reason',
    text: "A design decision: the new look exists only in evan's version 3 plan, which cannot be read here, and the request does not say whether the p…",
  };
  const before = { stage: 'waiting_for_you', why: 'decide', line, since: '2026-11-05T11:19:00Z' };
  assert.equal(ws.outdatedReason(before), 'posted_plan');
  assert.equal(ws.outdatedReason({ ...before, since: '2026-11-06T14:00:00Z' }), null,
    'a reason given after the fix is current');
  assert.equal(ws.outdatedReason({ ...before, line: { code: 'reason', text: 'It cannot read what the plan says.' } }),
    'posted_plan', 'the other word order');
  assert.equal(ws.outdatedReason({ ...before, line: { code: 'reason', text: 'Not a small change.' } }), null,
    'an unrelated decide reason');
  assert.equal(ws.outdatedReason({ ...before, stage: 'building' }), null);
  assert.equal(ws.outdatedReason({ ...before, line: { code: 'queued', place: 2 } }), null, 'not a reason line');
  assert.equal(ws.outdatedReason(null), null);
});

test('the bot\'s own step maps to one stage, with its queue or hold on the second line', () => {
  const reading = derive({ queue_id: 3, started_at: ago(1), verdict: null });
  assert.equal(reading.stage, 'reading');
  assert.equal(reading.whoseMove, 'bot');
  const queued = derive({ queue_id: 3, enqueued_at: ago(5), queue_place: 4, verdict: null, run_at: null, mode: null });
  assert.deepEqual([queued.stage, queued.line], ['reading', { code: 'queued', place: 4 }]);
  const held = derive({ verdict: 'ready', build_ok: null, cap_suppressed: 'builds_per_app' });
  assert.deepEqual([held.stage, held.line.code], ['building', 'held_builds']);
  const building = derive({ verdict: 'ready', build_ok: null, build_session_id: 9, build_status: 'active', spec_at: ago(10) });
  assert.equal(building.stage, 'building');
  const planning = derive({ verdict: 'ready', build_ok: null, build_session_id: 9, build_status: 'active' });
  assert.equal(planning.stage, 'planning');
});

test('the requester\'s move is always waiting_for_you, with why', () => {
  const plan = derive({ verdict: 'ready', build_ok: null, plan_waiting_at: ago(20) });
  assert.deepEqual([plan.stage, plan.why, plan.whoseMove], ['waiting_for_you', 'plan', 'requester']);
  const question = derive({ question_at: ago(3), verdict: 'question' });
  assert.deepEqual([question.stage, question.why], ['waiting_for_you', 'question']);
  const askedInThread = derive({ verdict: 'question' });
  assert.deepEqual([askedInThread.stage, askedInThread.why], ['waiting_for_you', 'question'], 'a question asked in the request\'s thread');
  const decide = derive({ verdict: 'person', run_reason: 'Not a small change.\nIt touches every page.' });
  assert.deepEqual([decide.stage, decide.why, decide.line], ['waiting_for_you', 'decide', { code: 'reason', text: 'Not a small change.' }]);
  const works = derive({ verdict: 'person', run_already_done: true });
  assert.equal(works.why, 'already_works');
  const empty = derive({ verdict: 'empty' });
  assert.equal(empty.why, 'needs_detail');
  const blocked = derive({ verdict: 'ready', build_ok: false, build_error: 'blocked: no screen to draw' });
  assert.equal(blocked.why, 'needs_detail');
});

test('a change\'s stages: checking, up for a vote, going live, live; a first version goes live without a vote', () => {
  const change = { proposal_session_id: 50, proposal_at: ago(60), checks_sha: 'a', reviewed_head_sha: 'a', verdict: 'ready', build_ok: true };
  assert.equal(derive({ ...change, proposal_status: 'promoted', check_state: 'pending' }).stage, 'checking');
  const failing = derive({ ...change, proposal_status: 'promoted', check_state: 'failing', failed_checks: 2 });
  assert.deepEqual([failing.stage, failing.line], ['checking', { code: 'checks_failing', failing: 2 }]);
  const vote = derive({ ...change, proposal_status: 'promoted', check_state: 'passing' });
  assert.deepEqual([vote.stage, vote.whoseMove], ['up_for_vote', 'group']);
  const first = derive({ ...change, proposal_status: 'promoted', check_state: 'passing', first_version: true });
  assert.deepEqual([first.stage, first.line], ['going_live', { code: 'first_version' }]);
  assert.equal(derive({ ...change, proposal_status: 'merging' }).stage, 'going_live');
  assert.equal(derive({ ...change, proposal_status: 'merged', merged_at: ago(5) }).stage, 'live');
});

test('stopped says why; a closed request is closed; a claim is being built by its claimer', () => {
  const stopped = derive({ verdict: 'ready', build_ok: false, build_error: 'the build turn failed' });
  assert.deepEqual([stopped.stage, stopped.reason], ['stopped', 'build_failed']);
  assert.equal(derive({ verdict: 'failed' }).reason, 'look_failed');
  assert.equal(derive({ verdict: 'person', request_closed: true }).stage, 'closed');
  const claimed = derive({ verdict: null, mode: null, claimed_by: 'ada', claimed_at: ago(2) });
  assert.deepEqual([claimed.stage, claimed.whoseMove, claimed.line], ['building', 'builder', { code: 'claimed', by: 'ada' }]);
  const nothing = derive({ verdict: null, mode: null, run_at: null });
  assert.deepEqual([nothing.stage, nothing.line], ['reading', { code: 'waiting' }]);
});

test('a private thread holding it for the requester\'s plan wins over waiting in line', () => {
  const held = derive({ queue_id: 3, enqueued_at: ago(5), verdict: null, mode: null, awaiting_plan: true });
  assert.deepEqual([held.stage, held.line, held.whoseMove], ['planning', { code: 'planning_with_you' }, 'requester']);
});

test('a change with no request of its own', () => {
  assert.equal(ws.deriveChange({ status: 'active', last_activity_at: ago(1) }).stage, 'building');
  assert.equal(ws.deriveChange({ status: 'promoted', check_state: 'pending' }).stage, 'checking');
  assert.equal(ws.deriveChange({ status: 'promoted', check_state: 'passing' }).stage, 'up_for_vote');
  assert.equal(ws.deriveChange({ status: 'merged', merged_at: ago(3) }).stage, 'going_live');
  assert.equal(ws.deriveChange({ status: 'merged', live_at: ago(3) }).stage, 'live');
  assert.equal(ws.deriveChange({ status: 'closed' }).stage, 'closed');
});

test('where an item goes depends on whose move it is and who is looking', () => {
  const needs = { stage: 'waiting_for_you', why: 'decide' };
  assert.equal(ws.placeFor(needs, { requester: true }), 'needs');
  assert.equal(ws.placeFor(needs, { own: true }), 'waiting');
  assert.equal(ws.placeFor(needs, {}), null);
  assert.equal(ws.placeFor({ stage: 'building' }, { own: true }), 'next');
  assert.equal(ws.placeFor({ stage: 'reading', line: { code: 'queued' } }, { own: true }), 'waiting');
  assert.equal(ws.placeFor({ stage: 'up_for_vote' }, { own: true, voteOwed: true }), null, 'the feed lists the vote');
  assert.equal(ws.placeFor({ stage: 'up_for_vote' }, { own: true }), 'waiting');
  assert.equal(ws.placeFor({ stage: 'live', since: new Date().toISOString() }, { own: true }), 'live');
  assert.equal(ws.placeFor({ stage: 'live', since: ago(60 * 24 * 8) }, { own: true }), null, 'a week on, it is history');
  assert.equal(ws.placeFor({ stage: 'closed' }, { requester: true }), null);
});

// 6 Nov 2026 (#6402): a change still being checked says what it waits on, and
// is not asked for a vote until its checks pass and it merges cleanly.
test('a checking change words its wait: about N min left, or waiting to sync with main', () => {
  const estimate = { buildMs: 180000, checksMs: 540000 };
  // Ten minutes into a twelve-minute median run: about two minutes left.
  const running = ws.deriveChange({
    status: 'promoted', check_state: 'pending', check_phase: 'testing',
    checks_at: ago(10), checks_estimate: estimate,
  }, { now: NOW });
  assert.deepEqual([running.stage, running.line], ['checking', { code: 'checks_running', minutes: 2 }]);
  assert.equal(ws.lineSays(running), 'About 2 min left');
  // The phase may be absent on an old row: pending alone is still a run.
  const legacy = ws.deriveChange({
    status: 'promoted', check_state: 'pending', checks_at: ago(11), checks_estimate: estimate,
  }, { now: NOW });
  assert.deepEqual(legacy.line, { code: 'checks_running', minutes: 1 });
  // No estimate, a run past it, or a queued run: the stage word alone.
  assert.equal(ws.deriveChange({ status: 'promoted', check_state: 'pending', checks_at: ago(1) }, { now: NOW }).line, null);
  assert.equal(ws.deriveChange({
    status: 'promoted', check_state: 'pending', checks_at: ago(30), checks_estimate: estimate,
  }, { now: NOW }).line, null);
  assert.equal(ws.deriveChange({
    status: 'promoted', check_state: 'pending', check_phase: 'queued', checks_at: ago(1), checks_estimate: estimate,
  }, { now: NOW }).line, null);
  // Checks deferred until it merges cleanly, or a recorded conflict the lane
  // is resolving: "Syncing with main" (#6531).
  const deferred = ws.deriveChange({
    status: 'promoted', check_state: 'pending', check_phase: 'deferred', checks_estimate: estimate,
  }, { now: NOW });
  assert.deepEqual([deferred.stage, deferred.line], ['checking', { code: 'syncing' }]);
  assert.equal(ws.stageSays(deferred), 'Syncing with main');
  assert.equal(ws.lineSays(deferred), null, 'the stage word carries it; no second line');
  for (const extra of [{ merge_conflict_state: 'conflict' }, { integration_merges_clean: false }]) {
    assert.deepEqual(ws.deriveChange({ status: 'promoted', check_state: 'pending', ...extra }, { now: NOW }).line,
      { code: 'syncing' });
  }
  assert.deepEqual(ws.deriveChange({ status: 'promoted', check_state: 'pending', integration_merges_clean: false,
    integration_block_reasons: ['integrating'] }, { now: NOW }).line, { code: 'syncing' });
  // #6531: a conflict only a yes can move is up for a vote, with its line.
  const onYes = ws.deriveChange({
    status: 'promoted', check_state: 'passing', integration_merges_clean: false,
    integration_block_reasons: ['awaiting_approval'],
  }, { now: NOW });
  assert.deepEqual([onYes.stage, onYes.line], ['up_for_vote', { code: 'conflict_on_yes' }]);
  assert.equal(ws.lineSays(onYes), 'Conflicts with main: Homeroom resolves it once you approve');
  // A passing change that has since stopped merging cleanly moves back to
  // waiting, and is not up for a vote.
  const moved = ws.deriveChange({ status: 'promoted', check_state: 'passing',
    integration_merges_clean: false, integration_block_reasons: ['integrating'] }, { now: NOW });
  assert.deepEqual([moved.stage, moved.line], ['checking', { code: 'syncing' }]);
  // A conflict the platform gave up on is its author's.
  assert.deepEqual(ws.deriveChange({ status: 'promoted', check_state: 'pending', integration_merges_clean: false,
    integration_block_reasons: ['unresolvable'] }, { now: NOW }).line, { code: 'sync_wait' });
  // Failing checks after the free resolution was spent stay failing: the fix
  // is what is owed, not a sync.
  const failed = ws.deriveChange({ status: 'promoted', check_state: 'failing', merge_conflict_state: 'conflict',
    integration_block_reasons: ['checks_failing'] }, { now: NOW });
  assert.deepEqual(failed.line, { code: 'checks_failing' });
  // ...but while the lane is catching that stale verdict up, it is syncing.
  assert.deepEqual(ws.deriveChange({ status: 'promoted', check_state: 'failing', integration_merges_clean: false,
    integration_block_reasons: ['integrating'] }, { now: NOW }).line, { code: 'syncing' });
});

test('the new wait words are the catalog\'s, keyed by the same entries', () => {
  const core = require('../frontend/locales/en/core.json');
  assert.equal(ws.WORDS['work.line.checksRunning_one'], core['work.line.checksRunning_one'].text);
  assert.equal(ws.WORDS['work.line.checksRunning_other'], core['work.line.checksRunning_other'].text);
  assert.equal(ws.WORDS['work.line.syncWait'], core['work.line.syncWait'].text);
  assert.equal(ws.WORDS['work.stage.syncing'], core['work.stage.syncing'].text);
  assert.equal(ws.WORDS['work.line.conflictOnYes'], core['work.line.conflictOnYes'].text);
});

test('#6528: a passing change reads Checking until its before & after shots settle, then rings ready', () => {
  const head = 'a'.repeat(40);
  const change = {
    proposal_session_id: 50, proposal_at: ago(60), checks_sha: head, reviewed_head_sha: head,
    verdict: 'ready', build_ok: true, proposal_status: 'promoted', check_state: 'passing',
  };
  const shooting = {
    shots_state: 'exploring', shots_run_id: 'r'.repeat(32),
    shots_detail: { headSha: head, required: true }, shots_updated_at: ago(5), checks_at: ago(5),
  };
  const held = derive({ ...change, ...shooting });
  assert.deepEqual([held.stage, held.line, held.whoseMove], ['checking', null, 'bot']);
  assert.equal(ws.bellOf(held, held), null, 'staying in checking rings nothing');
  const vote = derive({ ...change, ...shooting, shots_state: 'verified' });
  assert.deepEqual([vote.stage, vote.whoseMove], ['up_for_vote', 'group']);
  assert.equal(ws.bellOf(held, vote), 'ready');
});

test('a change of stage rings: needs you, ready to vote, stopped, live; a moved line rings nothing', () => {
  assert.equal(ws.bellOf({ stage: 'reading' }, { stage: 'waiting_for_you', why: 'question' }), 'needs_you');
  assert.equal(ws.bellOf({ stage: 'waiting_for_you', why: 'question' }, { stage: 'waiting_for_you', why: 'question' }), null);
  assert.equal(ws.bellOf({ stage: 'waiting_for_you', why: 'question' }, { stage: 'waiting_for_you', why: 'plan' }), 'needs_you');
  assert.equal(ws.bellOf({ stage: 'checking' }, { stage: 'up_for_vote' }), 'ready');
  assert.equal(ws.bellOf({ stage: 'building' }, { stage: 'stopped', reason: 'build_failed' }), 'stopped');
  assert.equal(ws.bellOf({ stage: 'going_live' }, { stage: 'live' }), 'live');
  assert.equal(ws.bellOf({ stage: 'reading', line: { code: 'queued' } }, { stage: 'reading' }), null);
  assert.equal(ws.bellOf(null, { stage: 'building' }), null);
});

test('an instance key names what it is about', async () => {
  const db = { query: async (sql, params) => {
    if (/FROM homeroom_bot_runs WHERE id/.test(sql)) return { rows: [{ app_id: 4, issue_number: params[0] + 1 }] };
    if (/FROM work_states WHERE app_id/.test(sql)) return { rows: [{ app_id: 4, item_kind: 'request', item_ref: 12, session_id: 9 }] };
    return { rows: [] };
  } };
  assert.deepEqual(await ws.itemsOf(db, { machine: 'bot-request', key: 'request:4:12' }), [{ appId: 4, issueNumber: 12 }]);
  assert.deepEqual(await ws.itemsOf(db, { machine: 'bot-build', key: 'run:41@w123' }), [{ appId: 4, issueNumber: 42 }]);
  assert.deepEqual(await ws.itemsOf(db, { machine: 'proposal', key: 'session:9' }), [{ sessionId: 9 }]);
  assert.deepEqual(await ws.itemsOf(db, { machine: 'app-delivery', key: 'app:4' }), [{ appId: 4, issueNumber: 12 }]);
  assert.deepEqual(await ws.itemsOf(db, { machine: 'bot-dm', key: 'user:3' }), [], 'a machine that moves no request');
});

// 5 Oct 2026 (Page Turners), kept in the stored stage on 5 Nov: a request
// filed or queued while its project's first version is not live waits for
// it, by the bot's own rule (homeroom-bot.js heldForFirstVersion, which
// refresh reads), and its second line says so on every screen.
test('a request waiting for its project\'s first version says so', () => {
  const held = derive({ queue_id: 3, enqueued_at: ago(5), queue_place: 2, verdict: null, run_at: null, mode: null, held_first_version: true });
  assert.deepEqual([held.stage, held.line], ['reading', { code: 'first_version_wait' }]);
  assert.equal(ws.stageSays(held), 'Not started yet');
  assert.equal(ws.lineSays(held), 'Waiting for the first version to go live');
  // Once it is being read, the hold is over.
  const reading = derive({ queue_id: 3, started_at: ago(1), enqueued_at: ago(5), verdict: null, run_at: null, mode: null, held_first_version: true });
  assert.equal(reading.stage, 'reading');
  assert.notDeepEqual(reading.line, { code: 'first_version_wait' });
});
