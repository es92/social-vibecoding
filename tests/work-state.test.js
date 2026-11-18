'use strict';

// 5 Nov 2026 (docs/plans/bot-one-model.md, step 3): one work state per
// request and change. These pin the decider, where an item goes for each
// viewer, and the moments a change of stage rings.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ws = require('../src/services/work-state');
const ROOT = path.join(__dirname, '..');

const NOW = new Date('2026-11-05T12:00:00Z');
const ago = (min) => new Date(NOW.getTime() - min * 60 * 1000).toISOString();
const base = { app_id: 1, issue_number: 7, mode: 'live', run_at: ago(30), request_closed: false };
const derive = (extra) => ws.derive({ ...base, ...extra }, { now: NOW });

// #6563: an approved, tested change whose merge GitHub is holding is not
// going live yet. #6594: waiting on GitHub's required checks is still
// approved; only GitHub itself holding the merge reads "Waiting to merge".
test('an approved change waiting on GitHub says Approved, and a GitHub hold says Waiting to merge', () => {
  const held = { stage: 'going_live', line: { code: 'github_checks' } };
  assert.equal(ws.stageSays(held), 'Approved');
  assert.equal(ws.stageSays({ stage: 'going_live', line: { code: 'github_wait' } }), 'Waiting to merge');
  assert.equal(ws.lineSays(held), "Waiting on GitHub's checks");
  assert.equal(ws.lineSays({ stage: 'going_live', line: { code: 'github_wait' } }), 'Waiting on GitHub');
  assert.equal(ws.stageSays({ stage: 'going_live' }), 'Going live', 'a plain merge keeps its word');
  // 11 Nov 2026: the mapping exists once, on the server, and ships with the
  // row as phrase ids of the core catalog (`words`), so the browser says
  // the same words without a table of its own.
  assert.deepEqual(ws.phrasesOf(held), {
    stage: { id: 'core:work.stage.approved' },
    stageOthers: { id: 'core:work.stage.approved' },
    line: { id: 'core:work.line.githubChecks' },
  });
  const githubWait = { stage: 'going_live', line: { code: 'github_wait' } };
  assert.deepEqual(ws.phrasesOf(githubWait).stage, { id: 'core:work.stage.waitingToMerge' });
  const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/core.json'), 'utf8'));
  assert.equal(core['work.stage.waitingToMerge'].text, ws.stageSays(githubWait), 'the server reads the catalog\'s words');
  assert.equal(core['work.stage.approved'].text, ws.stageSays(held));
});

// 11 Nov 2026: the words of every stage, why, reason and line are phrase
// ids that exist in the core catalog, with their values; the English the
// server says is that catalog's.
test('every phrase an item can carry is in the core catalog', () => {
  const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/core.json'), 'utf8'));
  const has = (phrase) => {
    const key = phrase.id.replace(/^core:/, '');
    return !!core[key] || (!!core[`${key}_one`] && !!core[`${key}_other`]);
  };
  const items = [
    ...ws.STAGES.map((stage) => ({ stage })),
    ...ws.WHYS.map((why) => ({ stage: 'waiting_for_you', why })),
    ...ws.REASONS.map((reason) => ({ stage: 'stopped', reason })),
    ...['queued', 'first_version_wait', 'held_builds', 'held_waiting', 'on_hold', 'cooldown', 'reply', 'retry_plan',
      'starting', 'proposing', 'fixing', 'revising', 'update_queued', 'checks_failing', 'sync_wait', 'conflict_on_yes',
      'github_checks', 'github_checks_failing', 'github_wait', 'first_version', 'planning_with_you', 'waiting', 'shots',
      'approved_checking']
      .map((code) => ({ stage: 'building', line: { code } })),
    { stage: 'checking', line: { code: 'approved_checking' } },
    { stage: 'up_for_vote', line: { code: 'earlier_yes', count: 2 } },
    { stage: 'reading', line: { code: 'queued', place: 3 } },
    { stage: 'building', line: { code: 'reviewing', round: 1, of: 2 } },
    { stage: 'checking', line: { code: 'checks_failing', failing: 2 } },
    { stage: 'checking', line: { code: 'checks_running', minutes: 4 } },
    { stage: 'building', line: { code: 'claimed', by: 'ada' } },
    { stage: 'waiting_for_you', why: 'decide', line: { code: 'reason', text: 'It needs a person.' } },
  ];
  for (const item of items) {
    const words = ws.phrasesOf(item);
    for (const phrase of [words.stage, words.stageOthers, words.line].filter(Boolean)) {
      assert.ok(has(phrase), `${phrase.id} is in the catalog`);
    }
    assert.ok(ws.says(item), `${JSON.stringify(item)} says something`);
  }
  assert.equal(ws.lineSays({ stage: 'reading', line: { code: 'queued', place: 3 } }), 'Number 3 in line');
  assert.equal(ws.lineSays({ stage: 'checking', line: { code: 'checks_failing', failing: 1 } }), '1 test failing');
  assert.equal(ws.lineSays({ stage: 'checking', line: { code: 'checks_failing', failing: 2 } }), '2 tests failing');
  assert.deepEqual(ws.phrasesOf({ stage: 'checking', line: { code: 'checks_failing', failing: 2 } }).line,
    { id: 'core:work.line.checksFailingCount', values: { count: 2 } });
  assert.equal(ws.stageSays({ stage: 'waiting_for_you', why: 'plan' }, { yours: false }), core['work.whyOthers.plan'].text);
  // 11 Nov 2026 (one model): the browser words nothing itself; it draws the
  // words the server sends with the standing.
  const ts = fs.readFileSync(path.join(ROOT, 'frontend/src/lib/work-state.ts'), 'utf8');
  assert.match(ts, /const said = words \? \(yours \? words\.stage : words\.stageOthers\) : null;/);
  assert.doesNotMatch(ts, /github_checks|waitingToMerge/);
});

// #6594: once a change has the votes its rule needs, nothing says "Up for a
// vote" while its checks run. #6695: it is still being tested, so it says
// Checking; Approved is kept for GitHub's own required checks.
test('#6695: a change whose votes are in says Checking while its tests run', () => {
  const request = (extra) => derive({ proposal_status: 'promoted', ...extra });
  const running = request({ votes_in: true, check_state: 'pending' });
  assert.equal(running.stage, 'checking');
  assert.deepEqual(running.line, { code: 'approved_checking' });
  assert.equal(ws.stageSays(running), 'Checking');
  assert.equal(ws.lineSays(running), 'Checking the latest version');
  assert.equal(ws.says(running), 'Checking · Checking the latest version', 'as the request words it');

  const failing = request({ votes_in: true, check_state: 'failing' });
  assert.equal(failing.stage, 'checking');
  assert.deepEqual(failing.line, { code: 'checks_failing' }, 'a failure keeps today’s failing words');

  const passing = request({ votes_in: true, check_state: 'passing' });
  assert.equal(passing.stage, 'going_live', 'its votes are in and it is being merged');

  const github = request({ votes_in: true, check_state: 'passing', integration_block_reasons: ['github_checks'] });
  assert.equal(ws.stageSays(github), 'Approved');
  assert.equal(ws.lineSays(github), "Waiting on GitHub's checks");

  // A change with no request of its own reads the same.
  const change = (extra) => ws.deriveChange({ status: 'promoted', check_state: 'pending', ...extra }, { now: NOW });
  assert.deepEqual(change({ votes_in: true }).line, { code: 'approved_checking' });
  assert.equal(ws.deriveChange({ status: 'promoted', check_state: 'passing', votes_in: true }, { now: NOW }).stage, 'going_live');
  assert.equal(ws.deriveChange({ status: 'promoted', check_state: 'failing', votes_in: true }, { now: NOW }).line.code,
    'checks_failing', 'a failure stays a failure');

  // Without its votes it still asks for one, and says why a push retired them.
  const retired = change({ check_state: 'passing', earlier_yes: 4 });
  assert.equal(retired.stage, 'up_for_vote');
  assert.deepEqual(retired.line, { code: 'earlier_yes', count: 4 });
  assert.equal(ws.lineSays(retired), 'Changed since its 4 yes votes, which count again once each is confirmed');
  assert.equal(ws.lineSays({ stage: 'up_for_vote', line: { code: 'earlier_yes', count: 1 } }),
    'Changed since its yes vote, which counts again once confirmed');
  const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/core.json'), 'utf8'));
  for (const key of ['work.stage.checking', 'work.line.approvedChecking', 'work.line.earlierYes_one', 'work.line.earlierYes_other']) {
    assert.ok(core[key] && core[key].text, `${key} is in the catalog`);
  }
  // The words ship with the row as phrase ids (`words`); the English is the catalog's.
  assert.deepEqual(ws.phrasesOf(running), {
    stage: { id: 'core:work.stage.checking' },
    stageOthers: { id: 'core:work.stage.checking' },
    line: { id: 'core:work.line.approvedChecking' },
  });
  assert.deepEqual(ws.phrasesOf(retired).line, { id: 'core:work.line.earlierYes', values: { count: 4 } });
  assert.equal(core['work.stage.checking'].text, ws.stageSays(running));
  assert.equal(core['work.line.approvedChecking'].text, ws.lineSays(running));
  // 11 Nov 2026 (one model): a change whose votes are in is not open for
  // votes, so Needs you and the vote digest never ask for one.
  assert.equal(ws.voteOpenOf(change({ votes_in: true })), false);
  assert.equal(ws.voteOpenOf(ws.deriveChange({ status: 'promoted', check_state: 'passing', votes_in: true }, { now: NOW })), false);
  assert.equal(ws.voteOpenOf(retired), true, 'retired yes votes still ask for a vote');
  assert.match(ws.APPROVED_SQL('w'), /w\.stage = 'going_live' OR w\.line->>'code' IN \('approved_checking', 'github_checks'\)/);
});

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

// 13 Nov 2026: a tester's request read "Ready to build · Number 1 in line"
// beside Let the bot build it now. Its build had reached the line, and their
// own private thread held it: the lane starts no such build, so it waited
// for them, and the queue's words were false.
test('a private thread holds a request that had reached the build line too: it waits for its requester, not for a slot', () => {
  const ready = { verdict: 'ready', build_ok: null, build_waiting_at: ago(4), build_place: 1 };
  const queued = derive(ready);
  assert.deepEqual([queued.stage, queued.line, queued.whoseMove], ['building', { code: 'queued', place: 1 }, 'bot']);
  assert.equal(ws.says(queued), 'Ready to build · Number 1 in line', 'with no hold, the line');
  const held = derive({ ...ready, awaiting_plan: true });
  assert.deepEqual([held.stage, held.line, held.whoseMove], ['planning', { code: 'planning_with_you', ready: true }, 'requester']);
  assert.equal(ws.says(held), 'Planning · Planning it with you in a private thread', 'the reading stage\'s own words');
  assert.deepEqual(ws.phrasesOf(held), ws.phrasesOf(derive({ queue_id: 3, enqueued_at: ago(5), verdict: null, mode: null, awaiting_plan: true })),
    'every screen draws it as it draws a held request still waiting to be read');
  // One of the project's limits holding the build is the same: its turn is
  // not taken back up while the thread holds it.
  for (const cap of ['builds_per_app', 'proposals_per_app']) {
    const capped = { verdict: 'ready', build_ok: null, cap_suppressed: cap };
    assert.equal(derive(capped).stage, 'building', cap);
    assert.deepEqual(derive({ ...capped, awaiting_plan: true }).line, { code: 'planning_with_you', ready: true }, cap);
  }
  // It is nobody's wait and no work under way: not busy, in Waiting, and the
  // bot is not "on it" for the page, though its build is still in the bot's
  // queue, so asking the bot to build it again is refused.
  assert.equal(ws.busyNow(held), false);
  assert.equal(ws.placeFor(held, { requester: true }), 'waiting');
  assert.deepEqual(ws.botWorkOf(held), { what: 'queued', since: held.since });
  assert.equal(ws.botWorkOf(derive({ queue_id: 3, enqueued_at: ago(5), verdict: null, mode: null, awaiting_plan: true })), null);
  // A build that started is the bot's: the hold is over by then. A person's
  // claim on a ready request is still theirs.
  const started = derive({ ...ready, build_waiting_at: null, build_session_id: 9, build_started_at: ago(2), awaiting_plan: true });
  assert.deepEqual([started.line, started.whoseMove], [null, 'bot'], 'the bot writing its own plan for a build under way');
  const claimed = derive({ ...ready, awaiting_plan: true, claimed_by: 'ada', claimed_at: ago(40) });
  assert.deepEqual(claimed.line, { code: 'claimed', by: 'ada' });
  // A change up for a vote is never held.
  assert.equal(derive({ proposal_session_id: 50, proposal_at: ago(60), checks_sha: 'a', reviewed_head_sha: 'a', verdict: 'ready', build_ok: true,
    proposal_status: 'promoted', check_state: 'passing', awaiting_plan: true }).stage, 'up_for_vote');
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
  assert.equal(ws.voteOpenOf(onYes), true);
  // ...but only once it could take one, as voteReadySql reads it: its checks
  // passed on the head up for a vote, it is not a first version, and its
  // shots are not still being taken. Until then it is checking, never open
  // for votes.
  const yesOnly = { status: 'promoted', integration_merges_clean: false, integration_block_reasons: ['awaiting_approval'] };
  const notYet = (row) => {
    const out = ws.deriveChange({ ...yesOnly, ...row }, { now: NOW });
    assert.equal(ws.voteOpenOf(out), false, JSON.stringify(row));
    return [out.stage, out.line];
  };
  assert.deepEqual(notYet({ check_state: 'pending' }), ['checking', { code: 'conflict_on_yes' }]);
  assert.deepEqual(notYet({ check_state: 'running', check_phase: 'testing' }), ['checking', { code: 'conflict_on_yes' }]);
  assert.deepEqual(notYet({ check_state: 'failing', failed_checks: 2 }), ['checking', { code: 'checks_failing', failing: 2 }]);
  assert.deepEqual(notYet({ check_state: 'passing', reviewed_head_sha: 'new', checks_commit_sha: 'old' }),
    ['checking', { code: 'conflict_on_yes' }], 'a pass of another head says nothing of this one');
  assert.deepEqual(notYet({ check_state: 'passing', first_version: true }), ['checking', { code: 'conflict_on_yes' }]);
  assert.deepEqual(notYet({
    check_state: 'passing', reviewed_head_sha: 'h1', checks_commit_sha: 'h1', checks_at: NOW.toISOString(),
    shots_state: 'exploring', shots_run_id: 'r'.repeat(32), shots_updated_at: NOW.toISOString(),
    shots_detail: { headSha: 'h1', required: true },
  }), ['checking', { code: 'conflict_on_yes' }], 'its shots are still being taken');
  // A request's own step reads the same, from its facts row's columns.
  const facts = { integration_merges_clean: false, integration_block_reasons: ['awaiting_approval'] };
  const step = (stage, row) => {
    const out = ws.fromStage({ stage, since: NOW.toISOString() }, { ...facts, ...row }, NOW);
    return [out.stage, out.line];
  };
  assert.deepEqual(step('checks', { check_state: 'pending' }), ['checking', { code: 'conflict_on_yes' }]);
  assert.deepEqual(step('checks_failed', { check_state: 'failing', failed_checks: 1 }), ['checking', { code: 'checks_failing', failing: 1 }]);
  assert.deepEqual(step('checks', { check_state: 'passing', first_version: true }), ['checking', { code: 'conflict_on_yes' }]);
  assert.deepEqual(step('checks', { check_state: 'passing', reviewed_head_sha: 'b', checks_sha: 'a' }), ['checking', { code: 'conflict_on_yes' }]);
  assert.deepEqual(step('checks', { check_state: 'passing' }), ['up_for_vote', { code: 'conflict_on_yes' }]);
  assert.deepEqual(step('vote', { check_state: 'passing' }), ['up_for_vote', { code: 'conflict_on_yes' }]);
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
  assert.equal(ws.lineSays({ line: { code: 'checks_running', minutes: 1 } }),
    core['work.line.checksRunning_one'].text.replace('{{count}}', '1'));
  assert.equal(ws.lineSays({ line: { code: 'checks_running', minutes: 5 } }),
    core['work.line.checksRunning_other'].text.replace('{{count}}', '5'));
  assert.equal(ws.lineSays({ line: { code: 'sync_wait' } }), core['work.line.syncWait'].text);
  assert.equal(ws.stageSays({ stage: 'checking', line: { code: 'syncing' } }), core['work.stage.syncing'].text);
  assert.equal(ws.lineSays({ line: { code: 'conflict_on_yes' } }), core['work.line.conflictOnYes'].text);
  assert.equal(ws.lineSays({ line: { code: 'shots' } }), core['work.line.shots'].text);
});

test('a change waiting only on its screenshots says so in its stage word, not Checking', () => {
  const core = require('../frontend/locales/en/core.json');
  const held = { stage: 'checking', line: { code: 'shots' } };
  assert.deepEqual(ws.phrasesOf(held), {
    stage: { id: 'core:work.stage.shots' },
    stageOthers: { id: 'core:work.stage.shots' },
    line: { id: 'core:work.line.shots' },
  });
  assert.equal(core['work.stage.shots'].text, 'Taking screenshots');
  assert.equal(ws.stageSays(held), 'Taking screenshots');
  assert.equal(ws.stageSays(held, { yours: false }), 'Taking screenshots');
  assert.equal(ws.says(held), 'Taking screenshots · Tests passed: only the before and after screenshots are left');
  // Tests still running, or failing, are still Checking.
  assert.equal(ws.stageSays({ stage: 'checking' }), core['work.stage.checking'].text);
  assert.equal(ws.stageSays({ stage: 'checking', line: { code: 'checks_running', minutes: 3 } }), core['work.stage.checking'].text);
  assert.equal(ws.stageSays({ stage: 'checking', line: { code: 'checks_failing' } }), core['work.stage.checking'].text);
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
  assert.deepEqual([held.stage, held.line, held.whoseMove], ['checking', { code: 'shots' }, 'bot']);
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

// #6600: a takeover Homeroom bot runs on a change is that change's update,
// and one whose last attempt failed says so.
test('#6600: a takeover running says the bot is fixing it, and a failed one says it could not', () => {
  const failing = { stage: 'checking', since: '2026-11-11T17:00:00.000Z', line: { code: 'checks_failing', failing: 3 } };
  const running = ws.withUpdate(failing, { coming: 'running' });
  assert.deepEqual([running.stage, running.line], ['building', { code: 'fixing' }]);
  assert.equal(ws.lineSays(running), 'Fixing what its tests found');
  // A vote it would have asked for is held as an update, as any running one.
  const vote = { stage: 'up_for_vote', since: '2026-11-11T17:00:00.000Z', line: null };
  assert.deepEqual(ws.withUpdate(vote, { coming: 'running' }).line, { code: 'revising' });
  // Anything else is left as it is.
  assert.equal(ws.withUpdate({ stage: 'going_live' }, { coming: 'running' }).stage, 'going_live');
  // A queued update holds only a vote (#6545).
  assert.deepEqual(ws.withUpdate(vote, { coming: 'queued' }).line, { code: 'update_queued' });
  assert.deepEqual(ws.withUpdate(failing, { coming: 'queued' }).line, { code: 'checks_failing', failing: 3 });
  // Its last attempt failed: the change keeps its stage, its line saying so.
  const failed = ws.withUpdate(failing, { failed: 'the failing check is still failing' });
  assert.deepEqual([failed.stage, failed.line], ['checking', { code: 'bot_fix_failed' }]);
  assert.equal(ws.says(failed), "Checking · Homeroom bot couldn't fix it");
  // A running one wins over an older failure, and a passing change is untouched.
  assert.deepEqual(ws.withUpdate(failing, { coming: 'running', failed: 'x' }).line, { code: 'fixing' });
  assert.equal(ws.withUpdate({ stage: 'up_for_vote', line: null }, { failed: 'x' }).line, null);
  // The stored state of a request's own change reads the same through derive.
  const held = derive({
    proposal_status: 'promoted', proposal_at: ago(20), check_state: 'failing',
    update_failed: 'the failing check is still failing',
  });
  assert.deepEqual([held.stage, held.line], ['checking', { code: 'bot_fix_failed' }]);
  const lc = derive({
    lc_status: 'promoted', lc_promoted_at: ago(20), lc_check_state: 'failing', lc_update_failed: 'it did not finish',
  });
  assert.deepEqual([lc.stage, lc.line], ['checking', { code: 'bot_fix_failed' }]);
});

// #6807: a change whose failing check is not its own, while Homeroom bot is
// getting that check fixed in another request, is the bot still working:
// Checking, with Fixing for the stage word.
test('#6807: a change waiting on a fix for the check it fails on reads Fixing', () => {
  const mapped = ws.fromStage({ stage: 'flake_fixing', since: ago(5) }, {});
  assert.deepEqual([mapped.stage, mapped.line], ['checking', { code: 'fixing_check' }]);
  assert.equal(ws.placeFor(mapped, { own: true }), 'waiting', 'Waiting, not Needs you');
  assert.deepEqual(ws.phrasesOf(mapped), {
    stage: { id: 'core:work.stage.fixing' },
    stageOthers: { id: 'core:work.stage.fixing' },
    line: { id: 'core:work.line.fixingCheck' },
  });
  const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/core.json'), 'utf8'));
  assert.equal(core['work.stage.fixing'].text, ws.stageSays(mapped));
  assert.equal(core['work.line.fixingCheck'].text, ws.lineSays(mapped));
  assert.equal(ws.lineSays(mapped), 'Fixing the check it fails on', 'the bot tab\'s second line');
  // The change's own facts: a failing verdict with an open wait.
  const row = {
    status: 'promoted', check_state: 'failing', promoted_at: ago(20), checks_at: ago(18),
    reviewed_head_sha: 'a'.repeat(40), checks_commit_sha: 'a'.repeat(40),
  };
  const fixing = ws.deriveChange({ ...row, flake_fixing: true }, { now: NOW });
  assert.deepEqual([fixing.stage, fixing.line], ['checking', { code: 'fixing_check' }]);
  assert.equal(ws.deriveChange({ ...row, flake_fixing: false }, { now: NOW }).line.code, 'checks_failing', 'no wait: as today');
  // A takeover whose last attempt failed says nothing over it: the fix for
  // the check that fails without the change is not the change's own.
  assert.deepEqual(ws.withUpdate(fixing, { coming: null, failed: 'it did not finish' }).line, { code: 'fixing_check' });
  // A request draws the same state.
  const request = ws.derive({ app_id: 1, issue_number: 7, request_closed: false,
    proposal_status: 'promoted', proposal_at: ago(20), check_state: 'failing', checks_at: ago(18),
    checks_sha: 'a'.repeat(40), reviewed_head_sha: 'a'.repeat(40), flake_fixing: true }, { now: NOW });
  assert.deepEqual([request.stage, request.line], ['checking', { code: 'fixing_check' }]);
});
