'use strict';

// #3685: how far along the Homeroom bot is, in the parts that need no
// database: which stage each record means, which step that is, and the
// words the DM says when it answers from the records alone. The queries run
// against PostgreSQL in tests/homeroom-bot-mayor-postgres.test.js.
//
// Run with: node --test tests/homeroom-bot-progress.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const progress = require('../src/services/homeroom-bot-progress');

const NOW = new Date('2026-10-02T16:04:00Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
const stage = (row) => progress.stageOf(row, { now: NOW });

test('the steps a request and a first version go through, and which step each stage is', () => {
  // #4053: a first version's steps say what is happening, never what to do
  // ("Build it" read as an instruction). A request's steps keep their names.
  assert.deepEqual(progress.FIRST_VERSION_STEPS, [
    'Setting up the project', 'Reading the description', 'Planning it', 'Building it', 'Testing it', 'Ready to try', 'Live',
  ]);
  assert.deepEqual(progress.REQUEST_STEPS, ['Read the request', 'Write a plan', 'Build it', 'Test it', 'Approval', 'Live']);
  assert.equal(progress.stepNumber('setting_up', true), 1);
  assert.equal(progress.stepNumber('reading', true), 2);
  assert.equal(progress.stepNumber('reading', false), 1);
  assert.equal(progress.stepNumber('planning', false), 2);
  assert.equal(progress.stepNumber('building', true), 4);
  assert.equal(progress.stepNumber('checks', false), 4);
  assert.equal(progress.stepNumber('vote', false), 5);
  assert.equal(progress.stepNumber('nonsense', false), null);
});

test('#4053: the build line a first version\'s thumbnail shows, for its creator and for everyone else', () => {
  const line = (s, o) => progress.buildLineOf(s, o);
  const creator = { forCreator: true };
  // Steps 1 to 3: Homeroom bot is planning it, for everyone.
  for (const s of ['setting_up', 'queued', 'reading', 'held', 'stalled']) {
    assert.equal(line(s), 'planning', s);
    assert.equal(line(s, creator), 'planning', s);
  }
  // Its plan waits for Build it: blue for the person who started it alone.
  assert.equal(line('plan', creator), 'plan');
  assert.equal(line('plan'), 'plan-member');
  // A question waits on the person who started it: theirs, else still planning.
  assert.equal(line('question', { forCreator: true, question: true }), 'question');
  assert.equal(line('question', { question: true }), 'planning');
  assert.equal(line('question', creator), 'planning', 'not waiting on them');
  // From Build it on, the build's own plan and its turn are the build.
  for (const s of ['build_queued', 'starting', 'planning', 'building', 'proposing']) assert.equal(line(s), 'building', s);
  for (const s of ['checks', 'checks_failed', 'fix_queued', 'fixing']) assert.equal(line(s), 'testing', s);
  for (const s of ['vote', 'merging', 'followup_queued', 'revising']) assert.equal(line(s), 'ready', s);
  assert.equal(line('nonsense'), null);
  assert.deepEqual(progress.BUILD_LINE_STATES, ['planning', 'plan', 'plan-member', 'question', 'building', 'testing', 'ready', 'live']);
  // The chat's step names for steps 4 to 7 are the line's own words
  // (frontend/src/features/first-session/build-line-words.js).
  const words = require('node:fs').readFileSync(require('node:path').join(__dirname, '../frontend/src/features/first-session/build-line-words.js'), 'utf8');
  for (const [state, step] of [['building', 4], ['testing', 5], ['ready', 6], ['live', 7]]) {
    assert.ok(words.includes(`${/-/.test(state) ? `'${state}'` : state}: '${progress.FIRST_VERSION_STEPS[step - 1]}',`), state);
  }
});

test('a request being read, asked about, or waiting in the queue', () => {
  assert.deepEqual(stage({ started_at: ago(3) }), {
    stage: 'reading', since: ago(3), doing: 'reading the request to decide whether to ask a question or build it', limit: 'reading',
  });
  assert.match(stage({ started_at: ago(3), first_version: true }).doing, /^reading the description/);
  assert.deepEqual(stage({ question_at: ago(9) }), {
    stage: 'question', since: ago(9), doing: 'waiting for an answer to the question asked', waitingOn: 'them',
  });
  assert.equal(stage({ queue_id: 4, enqueued_at: ago(1), queue_position: 2 }).doing, 'waiting for a free builder');
  assert.equal(stage({ verdict: 'person', mode: 'live' }), null, 'nothing in progress');
});

test('a build in progress is read from its run and its session, never the queue', () => {
  const ready = { mode: 'live', verdict: 'ready', build_ok: null, run_at: ago(5) };
  assert.equal(stage({ ...ready }).stage, 'starting', 'a ready verdict with no session yet');
  assert.equal(stage({ ...ready, run_at: ago(40) }).stage, 'stalled', 'and past the grace, it says nothing is recorded');
  assert.match(stage({ ...ready, run_at: ago(40) }).doing, /nothing about the build has been recorded since/);
  const planning = stage({ ...ready, build_session_id: 7, build_status: 'active', build_started_at: ago(4) });
  assert.deepEqual(planning, { stage: 'planning', since: ago(4), doing: 'writing the plan for the build', limit: 'plan' });
  const building = stage({ ...ready, build_session_id: 7, build_status: 'active', build_started_at: ago(12), spec_at: ago(6) });
  assert.deepEqual(building, { stage: 'building', since: ago(6), doing: 'building it', limit: 'build' });
  assert.equal(stage({ ...ready, build_session_id: 7, build_status: 'active', build_turn_mode: 'build', build_turn_at: ago(2) }).stage,
    'building', 'a build whose plan failed is still a build');
  assert.equal(stage({ ...ready, build_session_id: 7, build_status: 'paused', spec_at: ago(30) }).stage, 'proposing');
  assert.equal(stage({ ...ready, build_session_id: 7, build_status: 'archived' }), null, 'a failed attempt is not in progress');
  assert.equal(stage({ ...ready, cap_suppressed: 'proposals_per_app' }).stage, 'held');
  assert.equal(stage({ ...ready, mode: 'shadow', build_session_id: 7, build_status: 'active' }), null,
    'a shadow build is never their work');
  assert.equal(stage({ ...ready, build_ok: false }), null);
  assert.equal(stage({ ...ready, started_at: ago(1) }).stage, 'reading', 'a new look comes first');
});

test('a proposal: its checks, then the group\'s vote', () => {
  const open = { proposal_status: 'promoted', proposal_at: ago(20) };
  const running = stage({ ...open, check_state: 'pending', check_phase: 'testing', checks_at: ago(8),
    checks_progress: { ran: 120, expected: 338, failed: 0 } });
  assert.equal(running.stage, 'checks');
  assert.equal(running.doing, 'it\'s waiting for approval, and its tests are running: 120 of 338 done, 0 failed so far');
  assert.equal(running.since, ago(8));
  assert.equal(stage({ ...open, check_state: 'pending', check_phase: 'building' }).doing,
    'it\'s waiting for approval, and its tests are running: building the preview first');
  const failing = stage({ ...open, check_state: 'failing', test_results: [{ status: 'pass' }, { status: 'fail' }, { status: 'fail' }] });
  assert.equal(failing.stage, 'checks_failed');
  assert.equal(failing.doing, 'it\'s waiting for approval, and its tests failed (2 tests did not pass)');
  assert.deepEqual(stage({ ...open, check_state: 'passing' }), {
    stage: 'vote', since: ago(20), doing: 'it\'s waiting for approval', waitingOn: 'the group',
  });
  assert.equal(stage({ ...open, check_state: 'skipped' }).stage, 'vote');
  assert.equal(stage({ ...open, check_state: 'failing', started_at: ago(1), queue_reason: 'checks_failing' }).stage, 'fixing');
  assert.equal(stage({ ...open, started_at: ago(1), queue_reason: 'changed' }).stage, 'revising');
  // #3734: a follow-up waiting its turn is the bot's next step, not the vote:
  // a change asked for in the DM (#3740), a reply, or its own red checks.
  assert.deepEqual(stage({ ...open, check_state: 'passing', queue_id: 8, enqueued_at: ago(1), queue_reason: 'dm_revise', queue_position: 1 }), {
    stage: 'followup_queued', since: ago(1), doing: 'waiting for a free builder to follow up on the newest replies on the change',
  });
  assert.equal(stage({ ...open, check_state: 'passing', queue_id: 8, enqueued_at: ago(1), question_at: ago(5) }).stage, 'followup_queued',
    'a reply since the question is read next');
  assert.deepEqual(stage({ ...open, check_state: 'failing', queue_id: 8, enqueued_at: ago(1), queue_reason: 'checks_failing' }), {
    stage: 'fix_queued', since: ago(1), doing: 'waiting for a free builder to fix what its tests found',
  });
  assert.equal(stage({ proposal_status: 'merging', queue_id: 8, enqueued_at: ago(1) }).stage, 'merging',
    'a proposal being merged is not followed up on');
  assert.equal(progress.stepNumber('followup_queued', false), 5);
  assert.equal(progress.stepNumber('fix_queued', false), 4);
  assert.equal(stage({ ...open, check_state: 'passing', question_at: ago(2) }).stage, 'question');
  assert.equal(stage({ proposal_status: 'merging', proposal_at: ago(2) }).stage, 'merging');
  assert.equal(stage({ proposal_status: 'merged' }), null, 'live is finished, not in progress');
  assert.equal(progress.outcomeOf({ proposal_status: 'merged' }), 'approved and live');
  assert.equal(progress.outcomeOf({ mode: 'live', build_ok: false, build_error: 'the build ran past its time limit' }),
    'the build did not succeed: the build ran past its time limit');
  assert.equal(progress.outcomeOf({ mode: 'live', build_ok: false, build_error: 'skipped: the request was closed before its build started' }),
    'not built: the request was closed before its build started');
  assert.equal(progress.outcomeOf({ mode: 'shadow', verdict: 'person' }), null);
});

test('#3734: in flight is what the bot is doing now or has in its queue, never what waits on others', () => {
  for (const name of ['setting_up', 'queued', 'reading', 'starting', 'planning', 'building', 'proposing',
    'followup_queued', 'revising', 'fix_queued', 'fixing', 'merging']) {
    assert.equal(progress.inFlight({ stage: name }), true, name);
  }
  for (const name of ['question', 'vote', 'checks', 'checks_failed', 'held', 'stalled']) {
    assert.equal(progress.inFlight({ stage: name }), false, name);
  }
  assert.equal(progress.inFlight({ stage: 'setting_up', waitingOn: 'them' }), false, 'a project waiting for its secrets waits on them');
  assert.equal(progress.inFlight(null), false);
  for (const busy of progress.BUSY_STAGES) assert.ok(progress.IN_FLIGHT_STAGES.has(busy), `${busy}: busy is in flight`);
});

test('a first version\'s setup: which part runs, when this process knows', () => {
  const row = { app_status: 'creating', app_created_at: ago(2), created_at: ago(2) };
  assert.deepEqual(progress.setupOf(row, { phase: { phase: 'repository' } }), {
    stage: 'setting_up', since: ago(2), doing: 'setting up the project: part 2 of 4, making its code repository',
  });
  assert.equal(progress.setupOf(row).doing, 'setting up the project', 'no part is invented when it is not known here');
  assert.equal(progress.setupOf({ ...row, app_status: 'running' }).doing,
    'the project is set up; its first request is being filed to start on it');
  assert.equal(progress.setupOf({ ...row, app_status: 'awaiting_secrets' }).waitingOn, 'them');
  assert.ok(progress.setupOf({ ...row, app_status: 'error' }).outcome);
  assert.ok(progress.setupOf({ ...row, status: 'failed' }).outcome);
  assert.deepEqual(Object.keys(progress.SETUP_PARTS), require('../src/services/app-creation-phase').PHASES,
    'every part of the setup has words, in its order');
});

test('links go to the platform\'s own pages, and only when there is a domain', () => {
  assert.deepEqual(progress.links('app.example.com', { slug: 'ear-trainer', number: 1, proposal: 42 }), {
    project: 'https://app.example.com/#app/ear-trainer',
    request: 'https://app.example.com/#app/ear-trainer/dev/issues/1',
    proposal: 'https://app.example.com/#app/ear-trainer/dev/proposals/42',
  });
  assert.deepEqual(progress.links(null, { slug: 'ear-trainer' }), {});
});

test('the records, said in plain words when the model could not answer', () => {
  const text = progress.progressText({
    botIsOn: true,
    rightNow: [
      { projectName: 'Ear Trainer', title: 'First version', step: 1, of: 7, doing: 'setting up the project: part 2 of 4, making its code repository', minutesSoFar: 2 },
      { projectName: 'Seed swap', number: 3, title: 'Sort by date', step: 3, of: 6, doing: 'building it', minutesSoFar: 1 },
      { projectName: 'Note board', number: 5, title: 'Pin notes', step: 5, of: 6, doing: 'its proposal is up for the group\'s vote', minutesSoFar: 0 },
    ],
  });
  assert.equal(text, [
    'Here is where things stand, from my records:',
    '',
    '- Ear Trainer, its first version: step 1 of 7, setting up the project: part 2 of 4, making its code repository, for 2 minutes so far.',
    '- Seed swap request #3 (Sort by date): step 3 of 6, building it, for 1 minute so far.',
    '- Note board request #5 (Pin notes): step 5 of 6, its proposal is up for the group\'s vote, for under a minute so far.',
  ].join('\n'));
  assert.match(progress.progressText({ botIsOn: false, rightNow: [{ projectName: 'A', number: 1, doing: 'x' }] }),
    /I'm switched off right now, so this waits until I'm back on\.$/);
  assert.equal(progress.progressText({ rightNow: [] }), 'I\'m not working on anything for you right now.');
  assert.equal(progress.progressText({ rightNow: [], finishedLately: [{ projectName: 'Seed swap', number: 3, outcome: 'approved and live' }] }),
    'I\'m not working on anything for you right now. Most recently, Seed swap request #3: approved and live.');
  assert.doesNotMatch(text, /—/, 'no em dash in what the bot says');
});

test('#3771: a request in the queue says what it waits for', () => {
  const row = { app_id: 7, issue_number: 14, name: 'Ear Trainer', slug: 'ear-trainer' };
  const now = new Date('2026-10-03T12:40:00Z');
  const busy = new Map([[7, [{ issueNumber: 12, since: '2026-10-03T12:26:00Z', what: 'reading' }]]]);
  assert.deepEqual(progress.queuedWait(row, { busy, now }), {
    doing: 'waiting its turn: Ear Trainer is reading request #12 first (one read per project at a time)',
    waitingFor: { reason: 'project_busy', number: 12, doing: 'reading', minutesSoFar: 14 },
  });
  // A build runs on a session of its own: it holds no read up.
  const building = new Map([[7, [{ issueNumber: 12, since: '2026-10-03T12:26:00Z', what: 'building' }]]]);
  assert.equal(progress.queuedWait(row, { busy: building, queuePosition: 1 }).doing, 'next in line for a free builder');
  // Its own row being read is not something it waits for.
  const self = new Map([[7, [{ issueNumber: 14, since: '2026-10-03T12:39:00Z', what: 'reading' }]]]);
  assert.equal(progress.queuedWait(row, { busy: self, queuePosition: 1 }).doing, 'next in line for a free builder');
  assert.deepEqual(progress.queuedWait(row, { working: 2, perPerson: 2 }).waitingFor, { reason: 'person_limit', inProgress: 2, most: 2 });
  assert.equal(progress.queuedWait(row, { working: 2, perPerson: 2 }).doing,
    'waiting its turn: 2 things of theirs are in progress, the most at once for one person');
  assert.equal(progress.queuedWait(row, { queuePosition: 4 }).doing, 'waiting for a free builder');
  assert.deepEqual(progress.queuedWait(row, {}), {}, 'with nothing known, the stage\'s own words stand');
});

test('a ready request waiting for its build slot says so, and what it waits for', () => {
  const now = new Date('2026-10-03T12:40:00Z');
  const row = {
    app_id: 7, issue_number: 14, name: 'Ear Trainer', slug: 'ear-trainer', mode: 'live', verdict: 'ready',
    build_ok: null, run_proposal: null, build_session_id: null, run_at: '2026-10-03T12:30:00Z',
    build_waiting_at: '2026-10-03T12:31:00Z',
  };
  const state = progress.stageOf(row, { now });
  assert.deepEqual(state, { stage: 'build_queued', since: '2026-10-03T12:31:00Z', doing: 'ready to build; waiting its turn to be built' });
  assert.equal(progress.stepNumber('build_queued', false), 2, 'the plan is the next step');
  assert.ok(progress.IN_FLIGHT_STAGES.has('build_queued') && !progress.BUSY_STAGES.has('build_queued'),
    'in the bot\'s hands, not this minute');
  // Its session exists: it is under way, not waiting.
  assert.notEqual(progress.stageOf({ ...row, build_session_id: 5001, build_status: 'active' }, { now }).stage, 'build_queued');

  // Newest first, as projectsBusy lists them.
  const three = [
    { issueNumber: 13, since: '2026-10-03T12:35:00Z', what: 'building' },
    { issueNumber: 11, since: '2026-10-03T12:30:00Z', what: 'building' },
    { issueNumber: 12, since: '2026-10-03T12:26:00Z', what: 'building' },
  ];
  const busy = new Map([[7, [...three, { issueNumber: 15, since: '2026-10-03T12:39:00Z', what: 'reading' }]]]);
  assert.deepEqual(progress.buildWait(row, { busy, now }), {
    doing: 'ready to build; Ear Trainer is building requests #12, #11, #13 first (up to 3 builds per project at a time)',
    waitingFor: { reason: 'project_building', number: 12, building: 3, most: 3, minutesSoFar: 14 },
  }, 'three under way hold the next; the one started first is the one it waits on');
  const two = new Map([[7, three.slice(0, 2)]]);
  assert.equal(progress.buildWait(row, { busy: two, now }).doing, 'ready to build; its build starts next',
    'two under way leave room for a third');
  assert.equal(progress.buildWait(row, { busy: new Map([[7, three.slice(2)]]), now, perProject: 1 }).doing,
    'ready to build; Ear Trainer is building request #12 first (up to 1 build per project at a time)');
  const reading = new Map([[7, [{ issueNumber: 15, since: '2026-10-03T12:39:00Z', what: 'reading' }]]]);
  assert.equal(progress.buildWait(row, { busy: reading, now }).doing, 'ready to build; its build starts next',
    'a request being read on the project does not hold a build');
  assert.equal(progress.buildWait(row, { working: 2, perPerson: 2 }).waitingFor.reason, 'person_limit');
  const tray = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot-tray.js'), 'utf8');
  assert.match(tray, /build_queued: 'queued',/, 'the tray draws it as waiting its turn');
});

// WP1 (#10): a second build of one request was invisible to the bot's
// answers, which read the request's newest look and newest proposal only.
// The PostgreSQL side is tests/homeroom-bot-activity-postgres.test.js.
test('WP1: another build of a request, and the build before, in plain words', () => {
  assert.equal(progress.buildUnderWay({ live_build_waiting_at: ago(3) }), true, 'waiting its turn');
  assert.equal(progress.buildUnderWay({ build_session_id: 5, build_status: 'active' }), true, 'under way');
  assert.equal(progress.buildUnderWay({ build_session_id: 5, build_status: 'paused' }), true, 'being proposed');
  assert.equal(progress.buildUnderWay({ build_session_id: 5, build_status: 'archived' }), false, 'put away');
  assert.equal(progress.buildUnderWay({ build_session_id: 5, build_status: 'active', build_ok: false }), false, 'ended');
  assert.equal(progress.buildUnderWay({ live_build_waiting_at: ago(3), cap_suppressed: 'proposals_per_app' }), false, 'held');
  assert.equal(progress.buildUnderWay({ build_session_id: 5, build_status: 'promoted', proposal_session_id: 5 }), false, 'proposed');

  const said = (run) => progress.attemptOutcome(run);
  assert.equal(said({ proposal_session_id: 6190, proposal_status: 'promoted' }), 'built; it\'s waiting for approval');
  assert.equal(said({ proposal_session_id: 6190, proposal_status: 'merged' }), 'built; approved and live');
  assert.equal(said({ proposal_session_id: 6190, proposal_status: 'merging' }), 'built; it\'s going live now');
  assert.equal(said({ proposal_session_id: 6191, proposal_status: 'archived' }), 'built; the change was closed');
  assert.equal(said({ build_ok: true }), 'built');
  assert.equal(said({ build_ok: false, build_error: 'skipped: the request already has a proposal (6190)' }),
    'stopped before it was built: the request already has a proposal (6190)', 'a skip stopped; it did not fail');
  assert.equal(said({ build_ok: false, build_error: 'blocked: needs a paid API' }), 'found it cannot be built as written: needs a paid API');
  assert.equal(said({ build_ok: false, build_error: 'the build ran past its time limit' }), 'the build did not succeed: the build ran past its time limit');
  assert.equal(said({ build_ok: false }), 'the build did not succeed');
  assert.equal(said({ cap_suppressed: 'proposals_per_app' }), 'held back by a limit, never built');
  assert.equal(said({ build_error: 'superseded: a later verdict on the same issue' }), 'never built: a later verdict on the same issue');
  assert.equal(said({}), 'nothing recorded about how it ended');
});
