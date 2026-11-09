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
  // ("Build it" read as an instruction). One story: a request's steps are
  // named the same way (contract 2.3).
  assert.deepEqual(progress.FIRST_VERSION_STEPS, [
    'Setting up', 'Reading', 'Planning', 'Building', 'Testing', 'Ready to try', 'Live',
  ]);
  assert.deepEqual(progress.REQUEST_STEPS, ['Reading', 'Planning', 'Building', 'Testing', 'Ready to try', 'Live']);
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
  // 14 Oct 2026: and `stopped`, which no stage is (firstVersionStopped).
  assert.deepEqual(progress.BUILD_LINE_STATES, ['planning', 'plan', 'plan-member', 'question', 'building', 'testing', 'ready', 'live', 'stopped']);
  // The chat's step names for steps 4 to 7 lead the line's own words
  // (frontend/src/features/first-session/build-line-words.js): one story
  // names a step in a word ("Building"), the thumbnail's line in a phrase
  // ("Building it").
  const words = require('node:fs').readFileSync(require('node:path').join(__dirname, '../frontend/src/features/first-session/build-line-words.js'), 'utf8');
  for (const [state, step] of [['building', 4], ['testing', 5], ['ready', 6], ['live', 7]]) {
    // The table holds each line's message id; its English is the step's name.
    const id = new RegExp(`\\b${state}: '(onboarding:buildLine\\.[A-Za-z]+)',`).exec(words);
    assert.ok(id, state);
    assert.ok(require('./lib/platform-i18n').message(id[1]).startsWith(progress.FIRST_VERSION_STEPS[step - 1]), state);
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

// #6528: a passing change is still Checking while its before & after shots
// are taken, so the ready bell waits for the pictures too.
test('#6528: a passing change holds at checking until its shots settle', () => {
  const head = 'a'.repeat(40);
  const open = {
    proposal_status: 'promoted', proposal_at: ago(20), check_state: 'passing',
    checks_sha: head, reviewed_head_sha: head,
  };
  const shooting = {
    shots_state: 'exploring', shots_run_id: 'r'.repeat(32),
    shots_detail: { headSha: head, required: true }, shots_updated_at: ago(5), checks_at: ago(5),
  };
  assert.deepEqual(stage({ ...open, ...shooting }), {
    stage: 'checks', since: ago(5),
    doing: 'it\'s waiting for approval, and its tests passed; its before and after shots are still being taken',
  });
  assert.equal(stage({ ...open, ...shooting, shots_state: 'verified' }).stage, 'vote');
  assert.equal(stage({ ...open, ...shooting, shots_detail: { headSha: head, required: false } }).stage, 'vote',
    'nothing visible to shoot is not held');
  assert.equal(stage({ ...open, ...shooting, checks_at: ago(50), shots_updated_at: ago(50) }).stage, 'vote',
    'the hold lapses after 45 minutes');
  assert.equal(stage({ ...open, ...shooting, first_version: true }).stage, 'vote',
    'a first version goes live without a vote and is not held');
});

// 13 Oct 2026 (D1): a project's first version goes live without a vote, so
// once its tests pass it waits on nobody, and while they run the bot does
// not say it is waiting for approval.
test('D1: a first version up for testing waits on nobody\'s approval', () => {
  const open = { proposal_status: 'promoted', proposal_at: ago(20), first_version: true };
  assert.deepEqual(stage({ ...open, check_state: 'passing' }), {
    stage: 'vote', since: ago(20), doing: 'its tests passed, and as the project\'s first version it goes live without a vote in a minute or two',
  });
  assert.equal(stage({ ...open, check_state: 'pending', check_phase: 'building' }).doing,
    'it goes live without a vote once its tests pass, and its tests are running: building the preview first');
  const failing = stage({ ...open, check_state: 'failing', test_results: [{ status: 'fail' }] });
  assert.equal(failing.doing, 'it goes live without a vote once its tests pass, and its tests failed (1 test did not pass)');
  assert.equal(progress.inFlight({ stage: 'vote' }), false, 'nor is it the bot\'s work in flight');
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
  // 3 Nov 2026: a project reads up to readsPerApp requests at once, each on
  // a session of its own: one read ahead holds nothing up then.
  assert.equal(progress.queuedWait(row, { busy, now, readsPerApp: 3, queuePosition: 1 }).doing, 'next in line for a free builder');
  const three = new Map([[7, [
    { issueNumber: 12, since: '2026-10-03T12:26:00Z', what: 'reading' },
    { issueNumber: 13, since: '2026-10-03T12:30:00Z', what: 'reading' },
    { issueNumber: 9, since: '2026-10-03T12:20:00Z', what: 'building' },
    { issueNumber: 11, since: '2026-10-03T12:35:00Z', what: 'reading' },
  ]]]);
  assert.equal(progress.queuedWait(row, { busy: three, now, readsPerApp: 4, queuePosition: 1 }).doing, 'next in line for a free builder',
    'three reads of four: a build is not one of them');
  assert.deepEqual(progress.queuedWait(row, { busy: three, now, readsPerApp: 3 }), {
    doing: 'waiting its turn: Ear Trainer is reading requests #12, #13 and #11 first (3 reads per project at a time)',
    waitingFor: { reason: 'project_busy', number: 12, doing: 'reading', minutesSoFar: 14, reading: 3, most: 3 },
  });
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot-progress.js'), 'utf8');
  assert.match(src, /queuedWait\(s\.row, \{ busy, working: busyCount, perPerson, queuePosition: s\.queuePosition, now, holds, readsPerApp \}\)/,
    'the bot\'s own setting, as the lane reads it');
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
  const five = [
    { issueNumber: 13, since: '2026-10-03T12:35:00Z', what: 'building' },
    { issueNumber: 11, since: '2026-10-03T12:30:00Z', what: 'building' },
    { issueNumber: 12, since: '2026-10-03T12:26:00Z', what: 'building' },
    { issueNumber: 16, since: '2026-10-03T12:22:00Z', what: 'building' },
    { issueNumber: 17, since: '2026-10-03T12:18:00Z', what: 'building' },
  ];
  const busy = new Map([[7, [...five, { issueNumber: 15, since: '2026-10-03T12:39:00Z', what: 'reading' }]]]);
  assert.deepEqual(progress.buildWait(row, { busy, now }), {
    doing: 'ready to build; Ear Trainer is building requests #17, #16, #12, #11, #13 first (up to 5 builds per project at a time)',
    waitingFor: { reason: 'project_building', number: 17, building: 5, most: 5, minutesSoFar: 22 },
  }, 'five under way hold the next; the one started first is the one it waits on');
  const four = new Map([[7, five.slice(0, 4)]]);
  assert.equal(progress.buildWait(row, { busy: four, now }).doing, 'ready to build; its build starts next',
    'four under way leave room for a fifth');
  assert.equal(progress.buildWait(row, { busy: new Map([[7, five.slice(2)]]), now, perProject: 2 }).doing,
    'ready to build; Ear Trainer is building requests #17, #16, #12 first (up to 2 builds per project at a time)',
    'a project\'s own number is the one it says');
  const reading = new Map([[7, [{ issueNumber: 15, since: '2026-10-03T12:39:00Z', what: 'reading' }]]]);
  assert.equal(progress.buildWait(row, { busy: reading, now }).doing, 'ready to build; its build starts next',
    'a request being read on the project does not hold a build');
  assert.equal(progress.buildWait(row, { working: 2, perPerson: 2 }).waitingFor.reason, 'person_limit');
  // Every screen draws it as ready to build, waiting its turn (services/work-state.js).
  const ws = require('../src/services/work-state');
  assert.deepEqual(ws.fromStage({ stage: 'build_queued' }, {}).line, { code: 'queued' });
  assert.equal(ws.stageSays(ws.fromStage({ stage: 'build_queued' }, {})), 'Ready to build');
});

test('#6216: a person\'s request says its project\'s own build number, not the default', async () => {
  const requested = {
    app_id: 7, slug: 'ear-trainer', name: 'Ear Trainer', repo_url: null, issue_number: 14, issue_title: 'Practice',
    first_version: false, queue_id: null, started_at: null, enqueued_at: null, queue_reason: null, held_until: null,
    run_id: 1, mode: 'live', verdict: 'ready', run_at: '2026-10-03T12:30:00Z', run_duration_ms: null,
    cap_suppressed: null, build_ok: null, build_error: null, build_session_id: null, run_proposal: null,
    build_waiting_at: '2026-10-03T12:31:00Z', plan_waiting_at: null,
    review_state: null, review_started_at: null, review_round: null, review_max_rounds: null, review_minutes: null,
    build_status: null, build_started_at: null, build_last_activity: null, build_turn_mode: null, build_turn_at: null,
    spec_at: null, proposal_session_id: null, proposal_status: null, check_state: null, check_phase: null,
    checks_progress: null, checks_at: null, test_results: null, checks_sha: null, reviewed_head_sha: null,
    imported_pr_head_sha: null, proposal_source: null, proposal_at: null, merged_at: null,
    request_closed: false, question_at: null,
  };
  // Two builds under way on the project, and the project's own number is 2:
  // the third waits, and the words use the project's number, not the default.
  const building = [13, 12].map((issueNumber, i) => ({ app_id: 7, issue_number: issueNumber, since: `2026-10-03T12:3${5 - i}:00Z`, what: 'building' }));
  const pool = {
    async query(sql) {
      const s = String(sql);
      if (/WITH mine AS \(/.test(s)) return { rows: [requested] };
      if (/'building' AS what/.test(s)) return { rows: building };
      return { rows: [] };
    },
  };
  const settings = { mode: 'live', perPerson: 3, readsPerApp: 3, appCaps: { 7: { building: 2 } } };
  const [, state] = (await progress.requestStates(pool, { userId: 5, settings }))
    .map((s) => [s, s.state]).find(([s]) => Number(s.row.issue_number) === 14);
  assert.equal(state.waitingFor?.most, 2, 'the project\'s own number');
  assert.match(state.doing, /up to 2 builds per project at a time/);
});

// #4539: a request closed while its plan waited for Build it, or while the
// question about it was still open, no longer waits on the person: the
// answer read from the records says it was not built because the request
// was closed. Its stage is null, so the tray moves it out of Needs you.
test('#4539: on a closed request the plan and the question stop waiting, and the outcome names the closure', () => {
  // The plan is ready and waits for Build it.
  const waiting = { mode: 'live', verdict: 'ready', build_ok: null, run_at: ago(50), plan_waiting_at: ago(49) };
  assert.deepEqual(stage({ ...waiting }), {
    stage: 'plan', since: ago(49), waitingOn: 'them', doing: 'the plan is ready and waits for Build it',
  });
  assert.equal(stage({ ...waiting, request_closed: true }), null, 'closed: the plan is not in progress any more');
  // The question the bot asked about it stops waiting too.
  assert.equal(stage({ question_at: ago(9), request_closed: true }), null);
  // With a proposal still open, only the question yields: the proposal's
  // own state is what shows.
  assert.equal(stage({ proposal_status: 'promoted', check_state: 'passing', proposal_at: ago(20), question_at: ago(9) }).stage, 'question');
  assert.equal(stage({ proposal_status: 'promoted', check_state: 'passing', proposal_at: ago(20), question_at: ago(9), request_closed: true }).stage,
    'vote', 'the closed request\'s open proposal still shows its state');
  // A build already begun is unchanged.
  assert.equal(stage({ ...waiting, request_closed: true, build_session_id: 7, build_status: 'active', build_started_at: ago(40) }).stage,
    'planning', 'a build under way builds on');
  // What it came to, for finishedLately and the DM's answer.
  assert.equal(progress.outcomeOf({ ...waiting, request_closed: true }), 'not built: the request was closed');
  assert.equal(progress.outcomeOf({ ...waiting }), null, 'open: nothing has come of it yet');
});

// 30 Oct 2026: Main said four closed requests were "ready to build, held
// back" while the bot tab left them out. The bot's refresh reads open
// requests only, so no build of a closed one is still to start: held back by
// a limit, waiting its turn or stalled, it is not in progress, and it came
// to "not built" like the waiting plan above.
test('#4539: on a closed request no build still to start reads as in progress', () => {
  const ready = { mode: 'live', verdict: 'ready', build_ok: null, run_at: ago(50) };
  const toStart = {
    held: { cap_suppressed: 'proposals_per_app' },
    heldTurn: { cap_suppressed: 'builds_per_app' },
    build_queued: { build_waiting_at: ago(45) },
    stalled: {},
  };
  for (const [name, extra] of Object.entries(toStart)) {
    assert.notEqual(stage({ ...ready, ...extra }), null, `${name}: in progress while the request is open`);
    assert.equal(stage({ ...ready, ...extra, request_closed: true }), null, `${name}: not in progress once it is closed`);
    assert.equal(progress.outcomeOf({ ...ready, ...extra, request_closed: true }), 'not built: the request was closed', name);
    assert.equal(progress.outcomeOf({ ...ready, ...extra }), null, `${name}: open, nothing has come of it yet`);
  }
  // A change already up for a vote still shows its own state.
  assert.equal(stage({ ...ready, cap_suppressed: 'proposals_per_app', request_closed: true,
    proposal_status: 'promoted', check_state: 'passing', proposal_at: ago(20) }).stage, 'vote');
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

// #6219 (3 Nov 2026): #6210's plan waited for Build it, but a question left
// open from its first, held pass made the request read as a question, and
// the Homeroom bot page (which leaves the question stage to the Needs you
// feed) listed it nowhere. A plan waiting for Build it is what the person
// acts on now: a question asked before the look that made it does not hide
// it. A question the plan's own look asked still wins.
test('#6219: a plan waiting for Build it wins over a question left open from before its look', () => {
  const waiting = { mode: 'live', verdict: 'ready', build_ok: null, run_at: ago(50), plan_waiting_at: ago(40) };
  assert.equal(stage({ ...waiting, question_at: ago(90) }).stage, 'plan', 'a question older than the run');
  assert.equal(stage({ ...waiting, question_at: ago(45) }).stage, 'question', 'the plan\'s own look asked it');
  assert.equal(stage({ ...waiting }).stage, 'plan');
  // Every page lists a plan as waiting for you (services/work-state.js),
  // which the bot page puts under Needs you; a question it leaves to the feed.
  const ws = require('../src/services/work-state');
  const plan = ws.fromStage({ stage: 'plan' }, {});
  assert.deepEqual([plan.stage, plan.why], ['waiting_for_you', 'plan']);
  assert.equal(ws.placeFor(plan, { requester: true }), 'needs');
});

// #6246 (4 Nov 2026): #6149's and #6081's plans waited for Build it but
// vanished from the Homeroom bot page's Needs you, while the Workshop still
// listed them. A plan waiting for Build it is what the person acts on now,
// whatever sits beside it: an older open question (#6219), a person's newer
// reply, a message from the bot, a queue row on hold, or a read under way.
test('#6246: a plan waiting for Build it stays the plan beside a reply or a queue row', () => {
  const waiting = { mode: 'live', verdict: 'ready', build_ok: null, run_at: ago(50), plan_waiting_at: ago(40) };
  const plan = {
    stage: 'plan', since: ago(40), waitingOn: 'them', doing: 'the plan is ready and waits for Build it',
  };
  // (a) A question left open from before the plan's look does not hide it.
  assert.deepEqual(stage({ ...waiting, question_at: ago(90) }), plan);
  // (b) A person's newer reply, with no queue row yet.
  assert.deepEqual(stage({ ...waiting, reply_at: ago(5), reply_user_id: 7 }), plan);
  // (c) A newer reply whose read has started (a claimed queue row).
  assert.deepEqual(stage({ ...waiting, reply_at: ago(5), started_at: ago(4) }), plan);
  // (d) A queue row waiting its turn, not yet started and not held.
  assert.deepEqual(stage({ ...waiting, queue_id: 8, enqueued_at: ago(3), reply_at: ago(5) }), plan);
  // (e) A queue row on hold until Monday.
  const heldUntil = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
  assert.deepEqual(stage({ ...waiting, queue_id: 8, enqueued_at: ago(600), held_until: heldUntil, reply_at: ago(5) }), plan);
  // The plan's own look asked the question: that still wins.
  assert.equal(stage({ ...waiting, question_at: ago(45) }).stage, 'question');
  // planWaits says the same on each of the rows above.
  for (const row of [
    { ...waiting, question_at: ago(90) },
    { ...waiting, reply_at: ago(5), reply_user_id: 7 },
    { ...waiting, reply_at: ago(5), started_at: ago(4) },
    { ...waiting, queue_id: 8, enqueued_at: ago(3), reply_at: ago(5) },
    { ...waiting, queue_id: 8, enqueued_at: ago(600), held_until: heldUntil, reply_at: ago(5) },
  ]) {
    assert.equal(progress.planWaits(row), true);
    assert.equal(stage(row).stage, 'plan');
  }
});

test('#6246: built, held, replaced or closed, a plan is no longer waiting', () => {
  const waiting = { mode: 'live', verdict: 'ready', build_ok: null, run_at: ago(50), plan_waiting_at: ago(40) };
  assert.equal(progress.planWaits(waiting), true);
  const notWaiting = {
    'built and waiting its turn': { build_waiting_at: ago(30) },
    'a build under way': { build_session_id: 7 },
    'the build stopped': { build_ok: false },
    'held by a limit': { cap_suppressed: 'proposals_per_app' },
    'the request closed': { request_closed: true },
    'replaced by a proposal': { run_proposal: 9 },
    'a shadow look': { mode: 'shadow' },
    'handed back to a person': { verdict: 'person' },
  };
  for (const [name, extra] of Object.entries(notWaiting)) {
    assert.equal(progress.planWaits({ ...waiting, ...extra }), false, name);
    assert.notEqual(stage({ ...waiting, ...extra })?.stage, 'plan', name);
  }
});

test('#6246: one SQL definition of a waiting plan, shared by the page and the Workshop', () => {
  const sql = progress.planWaitingSql();
  assert.match(sql, /run\.mode = 'live' AND run\.verdict = 'ready'/);
  assert.match(sql, /run\.awaiting_go_at IS NOT NULL/);
  assert.match(sql, /run\.live_build_waiting_at IS NULL/);
  assert.match(sql, /run\.build_ok IS NULL/);
  assert.match(sql, /run\.build_session_id IS NULL/);
  assert.match(sql, /run\.proposal_session_id IS NULL/);
  assert.match(sql, /run\.cap_suppressed IS NULL/);
  assert.match(sql, /ORDER BY run\.id DESC LIMIT 1/, 'the newest run, any mode, decides');
  assert.match(sql, /github_issue_number = m\.issue_number/);
  assert.match(sql, /homeroom_bot_closed_requests/);
  assert.doesNotMatch(sql, /\$\d/, 'no parameters of its own');
  assert.match(progress.planWaitingSql({ appId: 'q.app_id', issueNumber: 'q.issue_number' }),
    /run\.app_id = q\.app_id AND run\.issue_number = q\.issue_number/);
});

// #6228 (3 Nov 2026): a person's reply on a request the bot handed back is
// the bot's to read, so the request leaves Decide at once: it reads as
// 'reading' with `reply`, waiting until the bot's turn starts. The window
// keeps a reply the refresh does not queue from saying "reading" forever.
test('#6228: a fresh reply on a handed-back request reads as waiting to be read', () => {
  const handed = { mode: 'live', verdict: 'person', run_at: ago(10) };
  // Not queued yet: the refresh's window.
  assert.deepEqual(stage({ ...handed, reply_at: ago(1), reply_user_id: 7 }), {
    stage: 'reading', reply: true, waiting: true, since: ago(1), doing: 'reading the new reply in a moment',
  });
  // handedBack still says Decide on its own; stageOf answers first.
  assert.equal(progress.handedBack({ ...handed, reply_at: ago(1) }), 'decide');
  // Past the window with no queue row: back to how it was.
  assert.equal(stage({ ...handed, reply_at: ago(3) }), null);
  assert.equal(progress.REPLY_WAIT_MS, 2 * 60 * 1000);
  // Queued, on hold: it waits for the week, not a read.
  assert.equal(stage({ ...handed, queue_id: 4, enqueued_at: ago(45), held_until: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(), reply_at: ago(30) }).stage, 'on_hold');
  assert.deepEqual(stage({ ...handed, queue_id: 4, enqueued_at: ago(2), reply_at: ago(1) }), {
    stage: 'reading', reply: true, waiting: true, since: ago(1), doing: 'reading the new reply in a moment',
  });
  // The read started: reading the reply, with the reading clock.
  assert.deepEqual(stage({ ...handed, started_at: ago(1), reply_at: ago(2) }), {
    stage: 'reading', reply: true, since: ago(1), doing: 'reading the new reply', limit: 'reading',
  });
  // A reply older than the look was already read.
  assert.equal(stage({ ...handed, reply_at: ago(20), run_at: ago(10) }), null);
  // The request closed, or its change is up: unchanged.
  assert.equal(stage({ ...handed, request_closed: true, reply_at: ago(1) }), null);
  assert.equal(stage({ ...handed, proposal_status: 'promoted', proposal_at: ago(20), check_state: 'passing', reply_at: ago(1) }).stage, 'vote');
});

test('#6228: the reply read is one SQL definition, shared with the track', () => {
  const sql = progress.replyLateralSql();
  assert.match(sql, /cm\.thread_type = 'issue'/);
  assert.match(sql, /ru\.is_synthetic IS NOT TRUE/);
  assert.match(sql, /cm\.created_at > run\.created_at/);
  assert.match(progress.replyLateralSql({ appId: 'a.id', issueNumber: 'w.n' }), /cm\.app_id = a\.id/);
  // #6280: the track reads the same record fragment the bot page does, and
  // the reply lateral is in it, so the two cannot read a reply differently.
  const trackSrc = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot-track.js'), 'utf8');
  assert.match(trackSrc, /requestRecordJoinsSql\(\{ appId: 'a\.id', issueNumber: 'w\.n' \}\)/);
  assert.match(progress.requestRecordJoinsSql({ appId: 'a.id', issueNumber: 'w.n' }), /cm\.created_at > run\.created_at/);
});

// ── #6234: the bot's own fix of a change's failing checks, for its page ───
//
// On a request's page, the bot's change read "Its author needs to fix this
// before it can go live" while its author, the bot, was fixing it (its
// request's checks_failing queue row, started). changeBotFix reads where
// that fix stands, and the Testing card says it (AppView._changeTestingView).

function fixPool({ session, queue = [], runs = [], retried = false, down = false } = {}) {
  const asked = [];
  return {
    asked,
    async query(sql, params) {
      const s = String(sql);
      asked.push({ s, params });
      if (down) throw new Error('connection refused');
      if (/FROM chat_sessions cs/.test(s)) return { rows: session ? [session] : [] };
      if (/FROM homeroom_bot_queue/.test(s)) return { rows: queue };
      // homeroom-bot.js checksRetried: this head's fix ran out of time once.
      if (/AND error = \$2/.test(s)) return { rows: retried ? [{ one: 1 }] : [] };
      if (/FROM homeroom_bot_runs/.test(s)) return { rows: runs };
      return { rows: [] };
    },
  };
}

const BOT_CHANGE = {
  app_id: 9, status: 'promoted', check_state: 'failing', reviewed_head_sha: 'A'.repeat(40), linked_issues: [50], username: 'homeroom_bot',
};

test('#6234: where the bot\'s fix of its change\'s checks stands: fixing, queued, handed off, or nothing', async () => {
  const fixing = fixPool({ session: BOT_CHANGE, queue: [{ started_at: ago(10), enqueued_at: ago(12) }] });
  assert.deepEqual(await progress.changeBotFix(fixing, 5001), { state: 'fixing', since: ago(10), reason: null });
  const queueRead = fixing.asked.find((q) => /FROM homeroom_bot_queue/.test(q.s));
  assert.match(queueRead.s, /issue_number = ANY\(\$2::int\[\]\) AND reason = \$3/, 'the queue is keyed by request: reached through linked_issues');
  assert.deepEqual(queueRead.params, [9, [50], 'checks_failing']);
  // Its second try after running out of time (homeroom-bot.js checksRetried).
  const retried = fixPool({ session: BOT_CHANGE, queue: [{ started_at: ago(3), enqueued_at: ago(12) }], retried: true });
  assert.deepEqual(await progress.changeBotFix(retried, 5001), { state: 'fixing', since: ago(3), reason: 'retry' });
  assert.deepEqual(retried.asked.find((q) => /AND error = \$2/.test(q.s)).params, [5001, `checks: ran out of time on ${'a'.repeat(40)}, trying once more`]);
  // Waiting its turn.
  const queued = fixPool({ session: BOT_CHANGE, queue: [{ started_at: null, enqueued_at: ago(2) }] });
  assert.deepEqual(await progress.changeBotFix(queued, 5001), { state: 'queued', since: ago(2), reason: null });
  // Handed over: its newest run on this head gave it to a person or failed.
  const handed = fixPool({ session: BOT_CHANGE, runs: [{ id: 901 }] });
  assert.deepEqual(await progress.changeBotFix(handed, 5001), { state: 'handed_off', since: null, reason: null });
  const runRead = handed.asked.find((q) => /FROM homeroom_bot_runs/.test(q.s));
  assert.match(runRead.s, /proposal_session_id = \$1 AND LOWER\(checks_head_sha\) = \$2 AND verdict IN \('person', 'failed'\)/);
  assert.deepEqual(runRead.params, [5001, 'a'.repeat(40)], 'the head up for approval, lower-cased as the runs record it');
  // Nothing of the bot's recorded on this head: the card's usual words.
  assert.equal(await progress.changeBotFix(fixPool({ session: BOT_CHANGE }), 5001), null);
});

// #6388: the bot already leaves a failure that looks like the platform's to
// Homeroom's preview (homeroom-bot.js oweChecksFix). changeBotFix had no state
// for that, so the card fell back to "Its author needs to fix this".
test('#6388: a failure that looks like the platform is left to Homeroom, not the bot to fix', async () => {
  const infra = {
    name: 'Pages render with their stylesheets (platform check)',
    path: '/app/staging-demo-admins',
    status: 'fail',
    failureReason: 'HTTP 503 Service Unavailable for /b/594ec2a2…/usernode-native/v1/native.css',
  };
  const onHead = { ...BOT_CHANGE, checks_commit_sha: 'a'.repeat(40), test_results: [infra] };
  assert.deepEqual(await progress.changeBotFix(fixPool({ session: onHead }), 5001), { state: 'platform', since: null, reason: null });
  // A queue row for a fix still wins, as it always did.
  const queued = fixPool({ session: onHead, queue: [{ started_at: null, enqueued_at: ago(2) }] });
  assert.deepEqual(await progress.changeBotFix(queued, 5001), { state: 'queued', since: ago(2), reason: null });
  // An assertion failure is the change's own: no platform state.
  const own = fixPool({
    session: {
      ...onHead,
      test_results: [{ name: 'Signed-in people see the vote button', path: '/vote', status: 'fail', failureReason: 'Expected selector #vote-btn' }],
    },
  });
  assert.equal(await progress.changeBotFix(own, 5001), null);
  // A verdict on another commit says nothing about the head up for a vote.
  const older = fixPool({ session: { ...onHead, checks_commit_sha: 'b'.repeat(40) }, runs: [{ id: 901 }] });
  assert.deepEqual(await progress.changeBotFix(older, 5001), { state: 'handed_off', since: null, reason: null });
});

test('#6234: a change of a person\'s, one not up for a vote, one whose checks pass, and a read that fails all read as nothing', async () => {  const person = fixPool({ session: { ...BOT_CHANGE, username: 'maya' }, queue: [{ started_at: ago(1), enqueued_at: ago(2) }] });
  assert.equal(await progress.changeBotFix(person, 5001), null);
  assert.equal(person.asked.length, 1, 'nothing more is read for a person\'s change');
  for (const session of [
    { ...BOT_CHANGE, status: 'merged' },
    { ...BOT_CHANGE, status: 'active' },
    { ...BOT_CHANGE, check_state: 'pending' },
    { ...BOT_CHANGE, check_state: 'passing' },
    null,
  ]) {
    assert.equal(await progress.changeBotFix(fixPool({ session, queue: [{ started_at: ago(1), enqueued_at: ago(2) }] }), 5001), null);
  }
  assert.equal(await progress.changeBotFix(fixPool({ session: BOT_CHANGE, down: true }), 5001), null, 'a read that fails keeps today\'s words');
  assert.equal(await progress.changeBotFix(fixPool({ session: BOT_CHANGE }), 'x'), null);
  // A change with no request of its own has no queue row to read; its runs still count.
  const bare = fixPool({ session: { ...BOT_CHANGE, linked_issues: [] }, runs: [{ id: 1 }] });
  assert.deepEqual(await progress.changeBotFix(bare, 5001), { state: 'handed_off', since: null, reason: null });
  assert.ok(!bare.asked.some((q) => /FROM homeroom_bot_queue/.test(q.s)));
});

test('#6234: both reads of a change carry it, and the Homeroom bot page keeps its fixing stage', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  assert.match(read('src/routes/sessions.js'), /detail\.bot_fix = await require\('\.\.\/services\/homeroom-bot-progress'\)\s*\.changeBotFix\(pool, session\.id, \{ viewer: req\.user \}\)\.catch\(\(\) => null\);/);
  assert.match(read('src/routes/votes.js'), /proposal\.bot_fix = await require\('\.\.\/services\/homeroom-bot-progress'\)\s*\.changeBotFix\(pool, proposal\.id, \{ viewer: req\.user \}\)\.catch\(\(\) => null\);/);
  // The Homeroom bot page's own stage for it (ai-work.js BOT_STANDING), as
  // stageOf reads a started checks_failing row.
  const open = { proposal_status: 'promoted', proposal_at: ago(20), check_state: 'failing', checks_sha: 'a'.repeat(40), reviewed_head_sha: 'a'.repeat(40) };
  assert.deepEqual(stage({ ...open, started_at: ago(4), queue_reason: 'checks_failing' }),
    { stage: 'fixing', since: ago(4), doing: 'fixing what its tests found' });
  assert.equal(stage({ ...open, queue_id: 8, enqueued_at: ago(1), queue_reason: 'checks_failing' }).stage, 'fix_queued');
  const ws = require('../src/services/work-state');
  const fixing = ws.fromStage({ stage: 'fixing' }, {});
  assert.deepEqual([fixing.stage, fixing.line, ws.placeFor(fixing, { own: true })], ['building', { code: 'fixing' }, 'next']);
  // #6545: a fix waiting its turn is Checking with its failing tests, not a
  // change ready to vote on.
  const queued = ws.fromStage({ stage: 'fix_queued' }, {});
  assert.deepEqual([queued.stage, queued.line, ws.placeFor(queued, { own: true })], ['checking', { code: 'checks_failing' }, 'waiting']);
  const counted = ws.fromStage({ stage: 'fix_queued' }, { failed_checks: 4 });
  assert.deepEqual([counted.stage, counted.line], ['checking', { code: 'checks_failing', failing: 4 }]);
  // An update queued on a passing change still holds its vote.
  const followUp = ws.fromStage({ stage: 'followup_queued' }, {});
  assert.deepEqual([followUp.stage, followUp.line], ['up_for_vote', { code: 'update_queued' }]);
  assert.equal(require('../src/services/homeroom-bot-track').STEP_OF_STAGE[fixing.stage], 'build', 'its track lights Build');
});

// #6357 (evan): "homeroom bot says building time used up, but i think we're
// still under budget?" A request whose look threw THROWN_TRIES times in a
// row is held for a day (src/workflow/bot-request/machine.ts), and every
// reader said that hold was the week's building time, until Monday.
test('#6357: a hold says why: the week\'s building time, or a day\'s pause after repeated errors', () => {
  const inADay = new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString();
  const monday = '2026-10-05T00:00:00.000Z';
  const queued = { queue_id: 4, enqueued_at: ago(30) };
  // Recorded by the workflow.
  assert.deepEqual(progress.holdOf({ held_until: inADay, held_reason: 'cooldown' }, { now: NOW }), { kind: 'cooldown', until: inADay });
  assert.deepEqual(progress.holdOf({ held_until: monday, held_reason: 'allowance' }, { now: NOW }), { kind: 'allowance', until: monday });
  // Stored before it was: only an end on the week's reset is the allowance's.
  assert.deepEqual(progress.holdOf({ held_until: inADay }, { now: NOW }), { kind: 'cooldown', until: inADay });
  assert.deepEqual(progress.holdOf({ held_until: monday }, { now: NOW }), { kind: 'allowance', until: monday });
  assert.equal(require('../src/services/limits').weeklyResetAt(NOW), monday, 'the boundary is the week\'s reset');
  // No hold, or one over.
  assert.equal(progress.holdOf({ held_until: null }, { now: NOW }), null);
  assert.equal(progress.holdOf({ held_until: ago(1), held_reason: 'cooldown' }, { now: NOW }), null);
  // The stage: on hold either way, saying which, with its own end.
  assert.deepEqual(stage({ ...queued, held_until: inADay, held_reason: 'cooldown' }), {
    stage: 'on_hold', hold: 'cooldown', until: inADay, since: ago(30), waitingOn: 'time',
    doing: 'paused after repeated errors: trying again at 2026-10-03 16:04 UTC',
  });
  assert.deepEqual(stage({ ...queued, held_until: monday, held_reason: 'allowance' }), {
    stage: 'on_hold', until: monday, since: ago(30), waitingOn: 'time',
    doing: 'on hold until Monday: this week\'s building time is used up',
  });
  // Every screen's line (services/work-state.js) keeps them apart.
  const ws = require('../src/services/work-state');
  const cool = ws.fromStage(stage({ ...queued, held_until: inADay }), {});
  assert.deepEqual(cool.line, { code: 'cooldown' });
  assert.equal(ws.says(cool), 'Not started yet · Paused after repeated errors: Homeroom bot tries again later');
  const week = ws.fromStage(stage({ ...queued, held_until: monday }), {});
  assert.deepEqual(week.line, { code: 'on_hold' });
  assert.equal(ws.lineSays(week), 'On hold until Monday: this week\'s building time is used up');
  assert.equal(ws.placeFor(cool, { own: true }), 'waiting');
  assert.equal(ws.placeFor(week, { own: true }), 'waiting');
  // The same rule in SQL: the week's reset, Monday 00:00 UTC.
  assert.match(progress.HOLD_IS_ALLOWANCE_SQL, /q\.held_reason = 'allowance'/);
  const flat = (sql) => sql.replace(/\s+/g, ' ');
  assert.ok(flat(require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot-dm.js'), 'utf8'))
    .includes(flat(progress.HOLD_IS_ALLOWANCE_SQL)), 'the week\'s DM counts only the week\'s holds, by the same rule');
  assert.match(progress.HOLD_IS_ALLOWANCE_SQL, /q\.held_reason IS NULL\s+AND q\.held_until = date_trunc\('week', q\.held_until AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC'/);
});
