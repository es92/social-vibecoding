'use strict';

// #3692: the activity tray in the Homeroom bot's DM.
//
// tests/homeroom-bot-tray-postgres.test.js pins whose work the endpoint reads
// on the real schema. This file pins the rest without a database:
//
//   - the service's pure rules: how an in-flight entry of the bot's own
//     progress (homeroom-bot-progress.js) is drawn, what a run came to in
//     the activity cards' words, where an entry opens, and how the entries
//     are arranged: one per request, in Now, Needs you or History, with the
//     request's other runs folded in;
//   - the live loop announcing, to the person it is for, when it starts and
//     finishes their work (the tray's realtime), and app.js turning that
//     announcement into the window event the tray listens for;
//   - the tray's render: the status line under the bot's name in each state,
//     the Activity disc and its badge, the panel's groups and tiles, History
//     folded away, its loading and failed states, and links that only ever
//     go to the platform's own addresses;
//   - where it is mounted: the bot's DM only, its header's Activity disc the
//     toggle (#3770; the name block no longer is), the panel dropped over
//     the transcript from under the header and left open by the full-width
//     toggle.
//
// Run with: node --test tests/homeroom-bot-tray.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message: englishText } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const TRAY = 'frontend/src/features/messages/bot-work.tsx';
const API = 'frontend/src/features/messages/api.ts';

const tray = require('../src/services/homeroom-bot-tray');
const bot = require('../src/services/homeroom-bot');
const activity = require('../src/services/homeroom-bot-activity');

// ── The service's rules ───────────────────────────────────────────────

test('#3734: Now is the bot\'s own progress, its in-flight entries drawn as steps', () => {
  const progress = require('../src/services/homeroom-bot-progress');
  // Every stage the bot calls in flight has a step the tray draws, and the
  // tray draws nothing the bot does not call in flight.
  assert.deepEqual(Object.keys(tray.PHASE_OF_STAGE).sort(), [...progress.IN_FLIGHT_STAGES].sort());
  const item = (extra) => ({
    project: 'ear trainer', projectName: 'Ear Trainer', number: 12, title: 'Sort by date', since: '2026-10-02T10:00:00.000Z',
    step: 1, of: 6, stepName: 'Reading', doing: 'reading the request to decide whether to ask a question or build it',
    ...extra,
  });
  assert.deepEqual(tray.jobOfProgress(item({ stage: 'reading' })), {
    key: 'ear trainer#12', appSlug: 'ear trainer', appName: 'Ear Trainer', issueNumber: 12, title: 'Sort by date', firstVersion: false,
    phase: 'looking', stage: 'reading', step: 1, of: 6, stepName: 'Reading',
    doing: 'reading the request to decide whether to ask a question or build it',
    since: '2026-10-02T10:00:00.000Z', href: '#app/ear%20trainer/dev/issues/12',
    links: { request: '#app/ear%20trainer/dev/issues/12', proposal: null, project: null },
    earlier: [],
  });
  for (const stage of ['starting', 'planning', 'building', 'proposing']) {
    assert.equal(tray.jobOfProgress(item({ stage })).phase, 'building', stage);
  }
  assert.equal(tray.jobOfProgress(item({ stage: 'queued' })).phase, 'queued');
  // A follow-up on its proposal, waiting its turn or running, opens the proposal.
  const onProposal = { proposal: { proposal: 40, status: 'up for a vote' } };
  for (const [stage, phase] of [['followup_queued', 'follow_up_queued'], ['fix_queued', 'follow_up_queued'],
    ['revising', 'following_up'], ['fixing', 'following_up'], ['merging', 'merging']]) {
    const job = tray.jobOfProgress(item({ stage, ...onProposal }));
    assert.equal(job.phase, phase, stage);
    assert.equal(job.href, '#app/ear%20trainer/dev/proposals/40', stage);
    assert.equal(job.links.proposal, '#app/ear%20trainer/dev/proposals/40', stage);
    assert.equal(job.links.request, '#app/ear%20trainer/dev/issues/12', stage);
  }
  assert.equal(tray.jobOfProgress(item({ stage: 'reading', ...onProposal })).links.proposal, null,
    'a step that is not about the proposal does not offer it');
  const setup = tray.jobOfProgress({ project: 'ear-trainer', projectName: 'Ear Trainer', title: 'First version', firstVersion: true, stage: 'setting_up' });
  assert.deepEqual([setup.key, setup.phase, setup.firstVersion, setup.title, setup.issueNumber, setup.href, setup.links.project],
    ['ear-trainer#first', 'setting_up', true, null, null, '#app/ear-trainer/app', '#app/ear-trainer/app']);
  assert.deepEqual([setup.step, setup.of], [null, null], 'no step without one');
  assert.deepEqual([tray.jobOfProgress(item({ stage: 'reading', step: 9 })).step], [null], 'a step past the last is no step');
  // What waits on the person or the group, or on the checks, is not in flight.
  for (const stage of ['question', 'vote', 'checks', 'checks_failed', 'held', 'stalled']) {
    assert.equal(tray.jobOfProgress(item({ stage })), null, stage);
  }
  assert.equal(tray.jobOfProgress(item({ stage: 'setting_up', waitingOn: 'them' })), null, 'a project waiting for its secrets');
});

test('what a run came to, in the activity cards\' words', () => {
  assert.deepEqual(tray.OUTCOMES, activity.OUTCOMES, 'one vocabulary');
  assert.equal(tray.outcomeOf({ verdict: 'ready', proposal_session_id: 5, proposal_status: 'promoted' }), 'proposed');
  assert.equal(tray.outcomeOf({ verdict: 'ready', proposal_session_id: 5, proposal_status: 'merging' }), 'going_live', '#4227');
  assert.equal(tray.outcomeOf({ verdict: 'ready', proposal_session_id: 5, proposal_status: 'merged' }), 'live');
  assert.equal(tray.outcomeOf({ verdict: 'ready', proposal_session_id: 5, proposal_status: 'closed' }), 'closed');
  assert.equal(tray.outcomeOf({ verdict: 'ready', build_ok: true }), 'proposed', 'a build that finished is a proposal');
  assert.equal(tray.outcomeOf({ verdict: 'ready', build_ok: false }), 'build_failed');
  assert.equal(tray.outcomeOf({ verdict: 'ready', build_ok: false, build_error: 'blocked: needs a secret' }), 'blocked');
  assert.equal(tray.outcomeOf({ verdict: 'ready', build_ok: false, build_error: 'skipped: the request was closed before its build started' }), 'stopped');
  assert.equal(tray.outcomeOf({ verdict: 'ready', build_ok: null }), null, 'a build nothing has finished yet');
  assert.equal(tray.outcomeOf({ verdict: 'question', cap_suppressed: 'questions_per_app' }), 'held', 'a held verdict was never sent');
  for (const verdict of ['question', 'person', 'empty', 'failed', 'answer', 'revise']) {
    assert.equal(tray.outcomeOf({ verdict }), verdict);
  }
  assert.equal(tray.outcomeOf({ verdict: 'something new' }), 'failed');
  assert.deepEqual([...tray.NEEDS_YOU].sort(), ['blocked', 'empty', 'question']);
});

test('an entry opens its proposal once people can open it, else its request', () => {
  const row = { slug: 'ear trainer', issue_number: 12, proposal_session_id: 40 };
  assert.equal(tray.hrefOf({ ...row, proposal_status: 'promoted' }), '#app/ear%20trainer/dev/proposals/40');
  assert.equal(tray.hrefOf({ ...row, proposal_status: 'merged' }), '#app/ear%20trainer/dev/proposals/40');
  assert.equal(tray.hrefOf({ ...row, proposal_status: 'open' }), '#app/ear%20trainer/dev/issues/12',
    'a proposal nobody else can open yet');
  assert.equal(tray.hrefOf({ ...row, proposal_status: 'closed' }), '#app/ear%20trainer/dev/issues/12');
  assert.equal(tray.hrefOf({ slug: 'x', issue_number: 3 }), '#app/x/dev/issues/3');
});

// The person's live runs as pastRuns reads them, newest first.
const at = (hoursAgo) => new Date(Date.parse('2026-10-03T12:00:00Z') - hoursAgo * 3600000);
const run = (id, issue, hoursAgo, extra = {}) => ({
  id, issue_number: issue, verdict: 'question', build_ok: null, build_error: null, cap_suppressed: null,
  proposal_session_id: null, created_at: at(hoursAgo), proposal_status: null, proposal_at: null, merged_at: null,
  slug: 'ear-trainer', name: 'Ear Trainer', issue_title: `Request ${issue}`, first_version: false, ...extra,
});
const entry = (number, stage, extra = {}) => ({
  project: 'ear-trainer', projectName: 'Ear Trainer', number, title: `Request ${number}`, stage, step: 5, of: 6,
  stepName: 'Ready to try', doing: 'reading the newest replies on the change', busyNow: true, since: at(0.15).toISOString(), ...extra,
});

test('each request appears once: in Now while the bot has it, else in Needs you while it waits on them, else in History', () => {
  const rows = [
    run(10, 9, 16, { verdict: 'answer' }),
    run(9, 9, 16.1, { verdict: 'revise' }),
    run(8, 5, 16.2, { verdict: 'failed' }),
    run(7, 9, 16.3, { verdict: 'answer' }),
    run(6, 9, 30, { verdict: 'ready', proposal_session_id: 40, proposal_status: 'promoted', proposal_at: at(29) }),
    run(5, 14, 40, { verdict: 'ready', build_ok: false, build_error: 'blocked: the request needs a secret nobody set' }),
    run(4, 21, 50, { verdict: 'person' }),
    run(3, 22, 60, { verdict: 'ready', cap_suppressed: 'proposals_per_app' }),
  ];
  const entries = [entry(5, 'revising', { proposal: { proposal: 41 } })];
  const work = tray.arrange(entries, rows);

  assert.deepEqual(work.now.map((job) => job.key), ['ear-trainer#5']);
  const five = work.now[0];
  assert.equal(five.phase, 'following_up');
  assert.deepEqual([five.step, five.of, five.stepName], [5, 6, 'Ready to try']);
  assert.deepEqual(five.earlier, [{ id: 8, outcome: 'failed', at: at(16.2).toISOString() }], 'its run before, folded in');

  assert.deepEqual(work.needsYou.map((job) => [job.key, job.outcome]), [['ear-trainer#14', 'blocked']],
    'a request it cannot build as written waits on them');

  assert.deepEqual(work.history.map((job) => [job.key, job.outcome]), [
    ['ear-trainer#9', 'answer'], ['ear-trainer#21', 'person'], ['ear-trainer#22', 'held'],
  ], 'newest news first, and a request the bot came back to four times is one entry');
  const nine = work.history[0];
  assert.equal(nine.id, 10);
  assert.equal(nine.title, 'Request 9');
  assert.deepEqual(nine.earlier.map((r) => r.outcome), ['revise', 'answer', 'proposed']);
  assert.equal(nine.earlier[2].at, at(29).toISOString(), 'a proposal is dated by the proposal');
  assert.equal(nine.proposalId, 40);
  assert.deepEqual(nine.links, {
    request: '#app/ear-trainer/dev/issues/9', proposal: '#app/ear-trainer/dev/proposals/40', project: null,
  });
  assert.equal(nine.href, '#app/ear-trainer/dev/proposals/40');
});

test('a proposal merged after the bot answered on it says it is live, dated when it merged', () => {
  const rows = [
    run(3, 9, 10, { verdict: 'answer' }),
    run(2, 9, 30, { verdict: 'ready', proposal_session_id: 40, proposal_status: 'merged', proposal_at: at(29), merged_at: at(2) }),
  ];
  const [nine] = tray.arrange([], rows).history;
  assert.deepEqual([nine.outcome, nine.at, nine.id], ['live', at(2).toISOString(), 2]);
  assert.deepEqual(nine.earlier.map((r) => [r.id, r.outcome]), [[3, 'answer']]);
});

test('what the bot\'s progress says waits on them is Needs you, the question it asked or the secrets a project waits for', () => {
  const rows = [run(2, 12, 1), run(1, 12, 30, { verdict: 'empty' })];
  const entries = [
    entry(12, 'question', { waitingOn: 'them', busyNow: false, since: at(0.5).toISOString() }),
    { project: 'seed-swap', projectName: 'Seed swap', title: 'First version', firstVersion: true, stage: 'setting_up',
      waitingOn: 'them', doing: 'the project is waiting for its secrets to be set on its page before it can start', since: at(3).toISOString() },
    entry(30, 'vote', { waitingOn: 'the group', busyNow: false }),
  ];
  const work = tray.arrange(entries, rows);
  assert.deepEqual(work.now, []);
  assert.deepEqual(work.needsYou.map((job) => job.key), ['ear-trainer#12', 'seed-swap#first']);
  const [question, secrets] = work.needsYou;
  assert.deepEqual([question.outcome, question.id, question.at], ['question', 2, at(0.5).toISOString()]);
  assert.deepEqual(question.earlier.map((r) => r.outcome), ['empty']);
  assert.equal(secrets.outcome, null);
  assert.match(secrets.doing, /waiting for its secrets/);
  assert.equal(secrets.links.project, '#app/seed-swap/app');
  assert.deepEqual(work.history, [], 'the group\'s vote is not theirs, and it has no run here');
});

// #4539: a request closed while it still waited on its person leaves Needs
// you and reads stopped in History, the tile a build stopped by its request
// closing already gets. Nothing is retired, so reopening brings it back.
test('#4539: a request closed while it waited on its person reads stopped, in History and not Needs you', () => {
  // Its plan was ready and waited for Build it.
  const waiting = [run(10, 9, 1, { verdict: 'ready', awaiting_go_at: at(1).toISOString() })];
  const open = tray.arrange([], waiting);
  assert.deepEqual(open.history.map((job) => [job.outcome, job.doing]), [[null, tray.NOT_FINISHED]], 'open, it is not an ending');
  const closed = tray.arrange([], [run(10, 9, 1, { verdict: 'ready', awaiting_go_at: at(1).toISOString(), request_closed: true })]);
  assert.deepEqual(closed.needsYou, [], 'a closed request needs nobody');
  const [stopped] = closed.history;
  assert.deepEqual([stopped.key, stopped.outcome, stopped.doing], ['ear-trainer#9', 'stopped', null]);
  // So does its question that was never answered; an open one still waits.
  const asked = tray.arrange([], [run(12, 4, 2, { request_closed: true })]);
  assert.deepEqual(asked.needsYou, []);
  assert.deepEqual(asked.history.map((job) => [job.key, job.outcome]), [['ear-trainer#4', 'stopped']]);
  assert.deepEqual(tray.arrange([], [run(12, 4, 2, {})]).needsYou.map((job) => [job.key, job.outcome]), [['ear-trainer#4', 'question']]);
  // Its earlier runs keep their own words.
  const withEarlier = tray.arrange([], [run(12, 9, 0.5, { request_closed: true }), run(11, 9, 1, { verdict: 'question' })]);
  assert.deepEqual(withEarlier.history.map((job) => job.outcome), ['stopped']);
  assert.deepEqual(withEarlier.history[0].earlier.map((r) => [r.id, r.outcome]), [[11, 'question']]);
  // A proposal still open shows the proposal's state, not the stop: the
  // closed request's lead is its proposal's run.
  const proposed = tray.arrange([], [run(12, 9, 2, { request_closed: true, verdict: 'ready',
    proposal_session_id: 40, proposal_status: 'promoted', proposal_at: at(2.5) })]);
  assert.deepEqual(proposed.history.map((job) => [job.id, job.outcome]), [[12, 'proposed']]);
});

test('a build the bot is still on is the work Now shows, not an earlier run; one nothing finished yet says so, never that it stopped', () => {
  const rows = [run(2, 7, 1, { verdict: 'ready' }), run(1, 7, 20, { verdict: 'question' })];
  const building = tray.arrange([entry(7, 'building', { step: 3, stepName: 'Building' })], rows);
  assert.deepEqual(building.now[0].earlier.map((r) => r.outcome), ['question']);
  // #8 (WP3): out of Now (the bot switched off, or the build gone quiet),
  // it is not "stopped", and the question it moved past is not its news.
  const stalled = tray.arrange([], rows);
  assert.deepEqual(stalled.history.map((job) => [job.outcome, job.doing]), [[null, tray.NOT_FINISHED]]);
  assert.deepEqual(stalled.needsYou, [], 'a question since answered does not need them');
  assert.deepEqual(stalled.history[0].earlier.map((r) => r.outcome), ['question'], 'and the run still going is not an earlier run');
});

// B6, first session 4 October: a newcomer's first version showed "2 earlier
// runs" beside its build. They were its plans, replaced by Change something
// before Build it was tapped: to them, the plan being updated.
test('B6: a first version\'s plan replaced before Build it is not one of its earlier runs, in Now, Needs you or History', () => {
  const fv = { slug: 'flat-4b-chores', name: 'Flat 4B Chores', issue_title: 'First version of Flat 4B Chores', first_version: true };
  const replaced = (id, hoursAgo, why) => run(id, 1, hoursAgo, {
    ...fv, verdict: 'ready', build_ok: false, build_error: `skipped: ${why}`, plan_only: true,
  });
  const rows = [
    run(4, 1, 0.2, { ...fv, verdict: 'ready' }),
    replaced(3, 0.4, 'its creator asked to change the plan'),
    replaced(2, 0.6, 'the request was read again'),
    run(1, 1, 0.8, { ...fv, verdict: 'failed' }),
  ];
  const building = { project: 'flat-4b-chores', projectName: 'Flat 4B Chores', number: 1, firstVersion: true, stage: 'building',
    step: 4, of: 7, stepName: 'Building', doing: 'building it', busyNow: true, since: at(0.1).toISOString() };
  const now = tray.arrange([building], rows).now[0];
  assert.deepEqual([now.firstVersion, now.stepName, now.doing], [true, 'Building', 'building it']);
  assert.deepEqual(now.earlier.map((r) => [r.id, r.outcome]), [[1, 'failed']], 'its plans are not earlier runs; a look that failed still is');
  const built = [run(4, 1, 0.2, { ...fv, verdict: 'ready', proposal_session_id: 40, proposal_status: 'promoted', proposal_at: at(0.05) }), ...rows.slice(1)];
  const history = tray.arrange([], built).history[0];
  assert.deepEqual([history.id, history.outcome], [4, 'proposed']);
  assert.deepEqual(history.earlier.map((r) => r.id), [1], 'nor once it is built');
  const waiting = { ...building, stage: 'question', waitingOn: 'them', busyNow: false };
  const needsYou = tray.arrange([waiting], [run(6, 1, 0.05, { ...fv }), ...rows]).needsYou[0];
  assert.deepEqual(needsYou.earlier.map((r) => r.id), [4, 1]);
  assert.equal(tray.planOnly({ plan_only: true }), true);
  assert.equal(tray.planOnly({ verdict: 'ready', build_ok: false, build_error: 'skipped: the request was closed before its build started' }), false,
    'a build that stopped is still an earlier run');
  // The read says which runs were only a plan: one awaitGo wrote, never
  // gone ahead with (goAhead records the choices), that stopped unbuilt.
  const source = read('src/services/homeroom-bot-tray.js');
  assert.match(source, /\(r\.plan IS NOT NULL AND r\.plan->'chosen' IS NULL AND r\.build_ok IS FALSE\s+AND r\.build_session_id IS NULL AND r\.proposal_session_id IS NULL\) AS plan_only,/);
  assert.match(read('src/services/homeroom-bot.js'), /plan = COALESCE\(plan, '\{\}'::jsonb\) \|\| jsonb_build_object\('chosen', \$3::jsonb\)/);
});

test('#8 (WP3): a second build of a request leads History with neither "stopped" nor its own news', () => {
  // Plant Pal, 3 October: run A's proposal went up for a vote, and run B
  // built the same request again. Out of Now (the vote is the group's), the
  // request's news is A's proposal, not B "stopped".
  const voting = [
    run(2, 3, 1, { verdict: 'ready' }),
    run(1, 3, 2, { verdict: 'ready', proposal_session_id: 40, proposal_status: 'promoted', proposal_at: at(1.5) }),
  ];
  const [up] = tray.arrange([], voting).history;
  assert.deepEqual([up.outcome, up.id, up.proposalId], ['proposed', 1, 40]);
  assert.deepEqual(up.earlier, [], 'the build still going is not one of its earlier runs');
  // A merged, and B's duplicate withdrawn: it went live, which is the news.
  const merged = [
    run(2, 3, 1.5, { verdict: 'ready', proposal_session_id: 41, proposal_status: 'archived', proposal_at: at(1.2) }),
    run(1, 3, 2, { verdict: 'ready', proposal_session_id: 40, proposal_status: 'merged', proposal_at: at(1.8), merged_at: at(1) }),
  ];
  const [live] = tray.arrange([], merged).history;
  assert.deepEqual([live.outcome, live.id, live.at], ['live', 1, at(1).toISOString()]);
  assert.deepEqual(live.earlier.map((r) => [r.id, r.outcome]), [[2, 'closed']], 'the withdrawn one, folded in as closed');
  // A run begun after it went live is new work, and is the news.
  const after = [run(3, 3, 0.5, { verdict: 'question' }), ...merged];
  assert.deepEqual(tray.arrange([], after).needsYou.map((job) => [job.id, job.outcome]), [[3, 'question']]);
  assert.equal(tray.leadOf(after).id, 3);
});

test('#8 (WP3): a proposal withdrawn or set aside reads as closed, and opens its request', () => {
  const row = { verdict: 'ready', proposal_session_id: 40, slug: 'x', issue_number: 3 };
  assert.equal(tray.outcomeOf({ ...row, proposal_status: 'archived' }), 'closed');
  assert.equal(tray.outcomeOf({ ...row, proposal_status: 'closed' }), 'closed');
  assert.equal(tray.hrefOf({ ...row, proposal_status: 'archived' }), '#app/x/dev/issues/3');
});

test('#8 (WP3): the tray reads again when one of the bot\'s proposals is promoted, merged or closed', async () => {
  const dmSrc = read('src/services/homeroom-bot-dm.js');
  const merged = dmSrc.slice(dmSrc.indexOf('async function noteProposalMerged('), dmSrc.indexOf('// ── A person writing to the bot'));
  assert.match(merged, /if \(requester\) require\('\.\/homeroom-bot-tray'\)\.noteWorkChanged\(requester\.userId, deps\);\n {2}const settings = /,
    'merged: before anything about the DM, whose list it may not be on');
  const votes = read('src/routes/votes.js');
  const promote = votes.slice(votes.indexOf("router.post('/api/sessions/:id/promote'"), votes.indexOf("log.info('votes', 'Session promoted'"));
  assert.match(promote, /if \(req\.user\?\.is_synthetic\) void require\('\.\.\/services\/homeroom-bot-dm'\)\.noteProposalChanged\(pool, session\.id\);/, 'promoted');
  const lifecycle = read('src/services/session-lifecycle.js');
  const archive = lifecycle.slice(lifecycle.indexOf('async function finalizeArchivedSession('), lifecycle.indexOf('async function unarchiveSession('));
  assert.match(archive, /await require\('\.\/homeroom-bot-dm'\)\.noteProposalChanged\(pool, sessionId\);/, 'closed, by any path');

  // Whoever asked for the request its run is on, found by its proposal or
  // by its build (a proposal just promoted is not recorded on its run yet).
  const dm = require('../src/services/homeroom-bot-dm');
  const pushed = [];
  const ws = { pushToUser(id, event) { pushed.push([id, event.type]); return 1; } };
  const queries = [];
  const pool = { async query(sql, params) { queries.push([sql, params]); return { rows: params[0] === 40 ? [{ user_id: 7 }] : [] }; } };
  assert.equal(await dm.noteProposalChanged(pool, 40, { ws }), 7);
  assert.deepEqual(pushed, [[7, 'homeroom_bot_work_changed']]);
  assert.match(queries[0][0], /WHERE r\.proposal_session_id = \$1 OR r\.build_session_id = \$1/);
  assert.equal(await dm.noteProposalChanged(pool, 41, { ws }), null, 'somebody else\'s session: nobody');
  assert.equal(await dm.noteProposalChanged({ async query() { throw new Error('down'); } }, 40, { ws }), null, 'never throws');
  assert.equal(pushed.length, 1);
});

test('History lists at most its limit of requests', () => {
  const rows = Array.from({ length: tray.HISTORY_LIMIT + 5 }, (_, i) => run(100 - i, i + 1, i, { verdict: 'person' }));
  assert.equal(tray.arrange([], rows).history.length, tray.HISTORY_LIMIT);
});

test('#4201: every entry the endpoint returns carries its app\'s icon: its image, else its emoji, else nothing', async () => {
  assert.deepEqual(tray.iconOf({ icon_image_id: 'ab12', icon_emoji: '🎵' }), { iconUrl: '/app-icons/ab12', iconEmoji: '🎵' });
  assert.deepEqual(tray.iconOf({ icon_image_id: null, icon_emoji: '🎵' }), { iconUrl: null, iconEmoji: '🎵' });
  assert.deepEqual(tray.iconOf({}), { iconUrl: null, iconEmoji: null });
  assert.deepEqual(tray.iconOf(null), { iconUrl: null, iconEmoji: null });

  // workFor reads the icon with the access columns, in the one static query.
  const queries = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      queries.push(s);
      if (/FROM homeroom_bot_requesters q/.test(s)) {
        return { rows: [
          run(10, 5, 0, { slug: 'ear-trainer', name: 'Ear Trainer', verdict: 'question', build_ok: null }),
          run(11, 9, 5, { slug: 'note-board', name: 'Note Board', verdict: 'build', build_ok: true, proposal_session_id: 40, proposal_status: 'promoted' }),
          run(12, 3, 9, { slug: 'seed-swap', name: 'Seed Swap', verdict: 'person' }),
        ] };
      }
      if (/FROM apps WHERE slug = ANY\(\$1::text\[\]\)/.test(s)) {
        return { rows: [
          { id: 1, slug: 'ear-trainer', created_by: 7, view_visibility: 'public', icon_image_id: 'ab12', icon_emoji: '🎵' },
          { id: 2, slug: 'note-board', created_by: 7, view_visibility: 'public', icon_image_id: null, icon_emoji: '📝' },
          { id: 3, slug: 'seed-swap', created_by: 7, view_visibility: 'public', icon_image_id: null, icon_emoji: null },
        ] };
      }
      return { rows: [] };
    },
  };
  const w = await tray.workFor(pool, { user: { id: 7, username: 'ada' }, settings: { mode: 'off' } });
  assert.match(queries.find((s) => /FROM apps WHERE slug/.test(s)), /icon_image_id, icon_emoji/);
  const icons = Object.fromEntries([...w.now, ...w.needsYou, ...w.history].map((j) => [j.appSlug, [j.iconUrl, j.iconEmoji]]));
  assert.deepEqual(icons, {
    'ear-trainer': ['/app-icons/ab12', '🎵'],
    'note-board': [null, '📝'],
    'seed-swap': [null, null],
  });
  assert.equal(w.needsYou[0].appSlug, 'ear-trainer', 'Needs you carries it too');
  // Every group is dressed, Now included.
  const dressed = tray.withIcons({ now: [{ appSlug: 'a' }], needsYou: [], history: [{ appSlug: 'b' }] }, new Map([['a', tray.iconOf({ icon_emoji: '🧪' })]]));
  assert.deepEqual(dressed.now[0], { appSlug: 'a', iconUrl: null, iconEmoji: '🧪' });
  assert.deepEqual(dressed.history[0], { appSlug: 'b', iconUrl: null, iconEmoji: null }, 'an app with no icon known carries nulls');
});

// One story: the demo is drawn as the strip above the chat, a representative
// one: 1 needs you, 2 ready to try, 2 in progress, 1 done today.
test('the staging demo draws work in flight at the step its card shows, a question waiting, and a history, and links nowhere', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const demo = tray.demoWork(now);
  assert.deepEqual(demo.now.map((job) => job.phase), ['building', 'building']);
  assert.ok(demo.now.every((job) => tray.PHASES.includes(job.phase)));
  const card = activity.demoState({ working: 1 }, now).cards[0];
  assert.deepEqual([demo.now[0].step, demo.now[0].of, demo.now[0].stepName], [card.step, card.of, card.stepName],
    'the tray and the fixture\'s card say the same step');
  // The work begun before it had a card, which opening the demo DM gives one.
  const joined = activity.demoState({ underWay: 2 }, now).cards[0];
  assert.equal(demo.now[1].issueNumber, activity.DEMO_UNDER_WAY.issueNumber);
  assert.equal(demo.now[1].title, activity.DEMO_UNDER_WAY.issueTitle);
  assert.deepEqual([demo.now[1].stage, demo.now[1].step, demo.now[1].of, demo.now[1].stepName, demo.now[1].doing],
    [joined.stage, joined.step, joined.of, joined.stepName, joined.doing], 'the tray and the card it was given say the same step');
  assert.deepEqual(demo.needsYou.map((job) => job.outcome), ['question']);
  assert.equal(demo.needsYou[0].issueNumber, 18);
  assert.equal(demo.needsYou[0].ask.question, 'Which night should the rota start on?');
  assert.deepEqual(demo.history.map((job) => job.outcome), ['proposed', 'live', 'proposed']);
  assert.deepEqual([demo.history[0], demo.history[2]].map((job) => [job.ready.approve, job.ready.waiting]), [[true, null], [false, '@ada']]);
  assert.ok(Date.parse(demo.history[1].at) > now - 24 * 3600 * 1000, 'done today');
  assert.ok(demo.history.some((job) => job.earlier.length >= 1), 'a request the bot came back to');
  // With the fixture's messages, rows open their threads and act on their own message.
  const placed = tray.demoWork(now, { story: 70, storyQuestion: 74, ready: 61, working: 50, underWay: 80, done: 51 });
  assert.deepEqual([placed.needsYou[0].cardId, placed.needsYou[0].ask.messageId, placed.history[0].ready.messageId, placed.now[1].cardId],
    [70, 74, 61, 80]);
  const all = [...demo.now, ...demo.needsYou, ...demo.history];
  assert.equal(new Set(all.map((job) => job.key)).size, all.length, 'one entry per request');
  for (const job of all) {
    assert.equal(job.href, null, 'no project stands behind the demo');
    assert.deepEqual(job.links, { request: null, proposal: null, project: null });
    assert.ok(['Staging demo app', 'Staging demo plants'].includes(job.appName), 'the fixture\'s own demo projects');
    for (const r of job.earlier) assert.ok(activity.OUTCOMES.includes(r.outcome));
  }
  assert.ok(demo.history.every((job, i, list) => i === 0 || Date.parse(list[i - 1].at) > Date.parse(job.at)), 'newest first');
});

test('the route reads the signed-in person and nothing the request names', () => {
  const routes = read('src/routes/conversations.js');
  const start = routes.indexOf("router.get('/api/conversations/homeroom-bot/work'");
  assert.ok(start > -1, 'the route exists');
  assert.ok(start < routes.indexOf("router.get('/api/conversations/:id',"), 'and is declared before the id routes');
  const body = routes.slice(start, routes.indexOf('\n  });', start));
  assert.match(body, /tray\.workFor\(pool, \{ user: req\.user \}\)/);
  assert.doesNotMatch(body, /req\.(?:params|body)|req\.query\.(?!demo)/, 'no user, id or slug is read from the request');
  assert.match(read('src/services/homeroom-bot-tray.js'), /WHERE q\.user_id = \$1 AND r\.mode = 'live'/);
});

// ── The realtime: the live loop says when it starts and ends ──────────

/** A pool that answers the loop's queries, with live candidates to start (as homeroom-bot-at-once.test.js). */
function loopPool({ settings, candidates = [], apps = [] }) {
  const client = {
    async query(sql) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    async connect() { return client; },
    async query(sql, params) {
      const s = String(sql);
      if (/SELECT key, value FROM platform_settings/.test(s)) return { rows: settings };
      if (/FROM users WHERE username = \$1/.test(s)) return { rows: [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
      if (/COALESCE\(r\.user_id, i\.created_by\) AS person_id/.test(s) && /WHERE q\.started_at IS NULL/.test(s)) {
        return { rows: candidates.filter((c) => !params[1].includes(c.app_id)) };
      }
      if (/FROM apps WHERE id = ANY\(\$1::int\[\]\)/.test(s)) return { rows: apps.filter((a) => params[0].includes(a.id)) };
      if (/SET started_at = NOW\(\) WHERE id = \$1 AND started_at IS NULL RETURNING id/.test(s)) return { rows: [{ id: params[0] }] };
      return { rows: [] };
    },
  };
}

test('the live loop tells the person a piece of work is for when it starts and when it ends', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_PER_PERSON, value: '2' },
    { key: bot.KEY_LIVE_AT_ONCE, value: '6' },
  ];
  const row = (id, appId, personId) => ({ id, app_id: appId, issue_number: id, priority: 1, reason: 'new', person_id: personId });
  const apps = [101, 102].map((id, i) => ({ id, slug: `a${i + 1}`, name: `a${i + 1}`, repo_url: `https://github.com/o/a${i + 1}`, self_hosted: false }));
  const pool = loopPool({ settings, candidates: [row(1, 101, 7), row(2, 102, null)], apps });
  const pushes = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    drain: false,
    ws: { pushToUser(userId, payload) { pushes.push([userId, payload.type]); return 1; } },
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    limits: { async checkBudget() { await gate; return { error: true, reason: 'weekly_cap' }; } },
    worker: { async listWorkerVolumes() { return []; } },
  };
  const out = await bot.runOnce(pool, {}, deps);
  assert.equal(out.dispatched, 2);
  assert.deepEqual(pushes, [[7, 'homeroom_bot_work_changed']],
    'started: person 7 hears it; an issue nobody on Homeroom filed tells nobody');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(pushes, [[7, 'homeroom_bot_work_changed'], [7, 'homeroom_bot_work_changed']], 'and ended');
  bot._resetForTests();
});

test('a failed announcement never costs the work', () => {
  const ws = { pushToUser() { throw new Error('socket gone'); } };
  assert.equal(tray.noteWorkChanged(7, { ws }), 0);
});

test('app.js turns the announcement into the tray\'s window event, and asks again after a reconnect', () => {
  const app = read('public/js/app.js');
  const { WORK_CHANGED_EVENT } = loadTsx(TRAY);
  assert.equal(WORK_CHANGED_EVENT, 'homeroom-bot-work-changed');
  assert.match(app, /case 'homeroom_bot_work_changed':\s*(?:\/\/[^\n]*\n\s*)*window\.dispatchEvent\(new CustomEvent\('homeroom-bot-work-changed'\)\);\s*break;/);
  const resync = app.slice(app.indexOf('  resyncCurrentView() {'), app.indexOf('// #1038:', app.indexOf('  resyncCurrentView() {')));
  assert.match(resync, /window\.dispatchEvent\?\.\(new CustomEvent\('homeroom-bot-work-changed'\)\)/);
});

// ── The strip, drawn ──────────────────────────────────────────────────
//
// One request, one story: the tray is drawn as the "Your requests" strip
// under the chat's header (bot-strip.tsx, pinned in full by
// tests/messages-bot-strip.test.js). The Activity disc, its panel of tiles
// and the header's long status line it replaced are gone, and so are the
// tests that drew them; what they held that still matters is held here:
// every phase and ending has words, in the person's vocabulary, and a row
// with nowhere to open links nowhere.

const NOW = new Date('2026-10-02T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
const nowhere = { request: null, proposal: null, project: null };
const job = (extra) => ({
  key: `ear-trainer#${extra.issueNumber || 'first'}`, appSlug: 'ear-trainer', appName: 'Ear Trainer', iconUrl: null, iconEmoji: null,
  issueNumber: null, title: null, firstVersion: false, href: null, links: nowhere, earlier: [], ...extra,
});
const STRIP = 'frontend/src/features/messages/bot-strip.tsx';

function drawStrip(props) {
  const { BotStripView } = loadTsx(STRIP);
  return renderToHtml(createElement(BotStripView, { now: NOW, ...props }));
}

test('a new project waiting for its secrets needs its person, and says so', () => {
  // The activity drawer, open (it starts closed: messages-bot-strip.test.js).
  const html = drawStrip({ remembered: true, work: { now: [], history: [], needsYou: [job({ id: 0, firstVersion: true, outcome: null, doing: 'waiting for its secrets', at: minutesAgo(10) })] } });
  assert.match(html, /data-bot-strip-group="needs"/);
  assert.match(html, /Ear Trainer, first version/);
  assert.match(html, /Waiting for its secrets/);
});

test('the demo strip draws with nowhere to link: its rows open their threads, never a page', () => {
  const html = drawStrip({ remembered: true, work: tray.demoWork(NOW.getTime()) });
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /Staging demo, a weekly dinner rota/);
  assert.match(html, /Which night should the rota start on\?/, 'the question itself');
  assert.match(html, /1 needs you/);
});

test('every phase and ending has words', () => {
  const { doingWord, needsRow, readyState } = loadTsx(STRIP);
  const { jobTitle, jobName, newestBotMessageId, WORK_CHANGED_EVENT } = loadTsx(TRAY);
  for (const phase of tray.PHASES) assert.ok(doingWord(job({ phase })), phase);
  for (const outcome of tray.OUTCOMES) {
    assert.ok(needsRow(job({ outcome })).state, `needs: ${outcome}`);
    assert.ok(readyState(job({ outcome })), `ready: ${outcome}`);
  }
  assert.equal(doingWord(job({ phase: 'merging' })), 'going live');
  assert.equal(WORK_CHANGED_EVENT, 'homeroom-bot-work-changed');
  assert.equal(jobTitle(job({ firstVersion: true, title: 'ignored' })), 'Ear Trainer first version');
  assert.equal(jobTitle(job({ issueNumber: 3, title: 'Sort' })), 'Ear Trainer #3: Sort');
  assert.equal(jobName(job({ issueNumber: 3, title: 'Sort' })), 'Ear Trainer #3');
  const message = (id, isBot) => ({ id, sender: { id: isBot ? 1 : 2, username: isBot ? 'homeroom_bot' : 'ada', ...(isBot ? { bot: true } : {}) } });
  assert.equal(newestBotMessageId([message(4, true), message(7, true), message(9, false), message(-3, false)]), 7);
  assert.equal(newestBotMessageId([message(9, false)]), null);
});

// 4 October: the header said "Last: proposed Flat 4B Chore…". What the strip
// and the cards say is the person's vocabulary, never the platform's.
test('the strip and the cards say every ending in the person\'s words', () => {
  const { doingWord, needsRow, readyState } = loadTsx(STRIP);
  const { ACTIVITY_OUTCOME_LABELS } = loadTsx('frontend/src/features/messages/bot-activity.tsx');
  const activity = require('../src/services/homeroom-bot-activity');
  const plain = (s) => s.replace(/’/g, '\'').toLowerCase();
  // Each card says what the server's card says: the words the two have in common.
  const SHARED = {
    question: 'asked you', proposed: 'waiting for approval', live: 'live', closed: 'was closed',
    blocked: 'written', build_failed: 'finish building', person: 'the group', empty: 'nothing to build',
    failed: 'finish looking', held: 'for now', stopped: 'stopped', answer: 'answered on', revise: 'updated the change',
    checking: 'before you try it', needs_look: 'needs a look', going_live: 'going live',
  };
  assert.deepEqual(Object.keys(SHARED).sort(), [...tray.OUTCOMES].sort());
  for (const outcome of tray.OUTCOMES) {
    const words = SHARED[outcome];
    assert.ok(plain(activity.OUTCOME_LABELS[outcome]).includes(words), `server card: ${outcome}`);
    assert.ok(plain(englishText(ACTIVITY_OUTCOME_LABELS[outcome])).includes(words), `client card: ${outcome}`);
  }
  const said = [
    ...tray.PHASES.map((phase) => doingWord(job({ phase }))),
    ...tray.OUTCOMES.flatMap((outcome) => [needsRow(job({ outcome })).state, readyState(job({ outcome }))]),
    ...Object.values(ACTIVITY_OUTCOME_LABELS).map((id) => englishText(id)), ...Object.values(activity.OUTCOME_LABELS), ...Object.values(activity.TONE_WORDS),
  ];
  for (const line of said) assert.doesNotMatch(line, /propos|merg|\bPR\b|pull request|staging|—/i, line);
});

test('the client keeps only the platform\'s own addresses as links, and known words', () => {
  const { normalizeBotWork } = loadTsx(API);
  const w = normalizeBotWork({
    now: [
      { appSlug: 'a', appName: 'A', issueNumber: 3, phase: 'building', since: 'x', href: 'javascript:alert(1)',
        links: { request: 'https://example.test/x', proposal: '#app/a/dev/proposals/4' }, step: 3, of: 6, stepName: 'Building' },
      { appSlug: 'b', appName: 'B', phase: 'dancing', href: '#app/b/app', firstVersion: true, step: 7, of: 6 },
      ...tray.PHASES.map((phase) => ({ appSlug: 'c', appName: 'C', issueNumber: 1, phase })),
    ],
    needsYou: [
      { id: 0, appSlug: 'a', firstVersion: true, doing: 'waiting for its secrets' },
      { appSlug: 'a', issueNumber: 8 },
    ],
    history: [
      { id: 2, appSlug: 'a', issueNumber: 3, outcome: 'live', href: 'https://example.test/x',
        earlier: [{ id: 5, outcome: 'nonsense', at: 'x' }, { outcome: 'live' }] },
      { id: 1, appSlug: 'a', issueNumber: 1, outcome: 'nonsense', href: '#app/a/dev/issues/1' },
    ],
  });
  assert.equal(w.now[0].href, null);
  assert.deepEqual(w.now[0].links, { request: null, proposal: '#app/a/dev/proposals/4', project: null });
  assert.deepEqual([w.now[0].step, w.now[0].of, w.now[0].stepName], [3, 6, 'Building']);
  assert.equal(w.now[0].key, 'a#3');
  assert.equal(w.now[1].href, '#app/b/app');
  assert.equal(w.now[1].phase, 'looking');
  assert.equal(w.now[1].firstVersion, true);
  assert.deepEqual([w.now[1].step, w.now[1].of], [null, null], 'a step past the last is no step');
  assert.deepEqual(w.now.slice(2).map((j) => j.phase), [...tray.PHASES], 'every step the server draws is kept');
  assert.equal(w.needsYou.length, 1, 'an entry with neither an ending nor words is dropped');
  assert.deepEqual([w.needsYou[0].outcome, w.needsYou[0].doing], [null, 'waiting for its secrets']);
  assert.equal(w.history[0].href, null);
  assert.equal(w.history[0].appName, 'a', 'a missing name falls back to the slug');
  assert.deepEqual(w.history[0].earlier, [{ id: 5, outcome: 'stopped', at: 'x' }], 'an unknown earlier ending reads as stopped; one without an id is dropped');
  assert.equal(w.history[1].outcome, 'failed');
  const icons = normalizeBotWork({ history: [
    { id: 1, appSlug: 'a', outcome: 'live', iconUrl: '/app-icons/ab12', iconEmoji: '🎵' },
    { id: 2, appSlug: 'b', outcome: 'live', iconUrl: 'https://example.test/x.png' },
    { id: 3, appSlug: 'c', outcome: 'live', iconUrl: 'javascript:alert(1)' },
  ] }).history;
  assert.deepEqual(icons.map((j) => [j.iconUrl, j.iconEmoji]), [['/app-icons/ab12', '🎵'], [null, null], [null, null]],
    '#4201: an icon is only ever one the platform serves');
  assert.deepEqual(normalizeBotWork(null), { now: [], needsYou: [], history: [] });
});

test('a conversation is the bot\'s DM only when the server says so, and only a direct one', () => {
  const { normalizeConversation } = loadTsx(API);
  const direct = { id: 5, kind: 'direct', membershipStatus: 'member' };
  assert.equal(normalizeConversation({ ...direct, homeroomBot: true }).homeroomBot, true);
  assert.equal(normalizeConversation({ ...direct, homeroomBot: 'yes' }).homeroomBot, undefined);
  assert.equal(normalizeConversation(direct).homeroomBot, undefined);
  assert.equal(normalizeConversation({ ...direct, kind: 'group', homeroomBot: true }).homeroomBot, undefined);
  const service = read('src/services/conversations.js');
  assert.match(service, /\(peer_user\.is_synthetic IS TRUE AND peer_user\.username = 'homeroom_bot'\) AS peer_is_homeroom_bot/);
  assert.match(service, /\.\.\.\(accepted && row\.kind === 'direct' && row\.peer_is_homeroom_bot \? \{ homeroomBot: true \} : \{\}\)/);
});

// ── Where it is mounted ───────────────────────────────────────────────

test('only a conversation with the Homeroom bot carries the strip, pinned right under its header', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const botDm = !!snap\.active && snap\.active\.id === conversationId && snap\.active\.kind === 'direct'\s*&& snap\.active\.membershipStatus === 'member' && snap\.active\.homeroomBot === true;/);
  // One request, one story: the strip sits right under the header, in the pane's flow.
  assert.match(screen, /\{embedded \? null : <ThreadHeader \/>\}\s*(?:\{\/\*[^\n]*\*\/\}\s*)?\{botDm && !embedded \? <BotStrip \/> : null\}/);
  assert.match(screen, /\{botDm \? <BotWorkSync conversationId=\{conversationId\} newsKey=\{newestBotMessageId\(snap\.messages\)\} \/> : null\}/);

  const header = screen.slice(screen.indexOf('function ThreadHeader()'), screen.indexOf('function isCardMessage('));
  assert.match(header, /const botDm = active\.kind === 'direct' && !!active\.homeroomBot && active\.membershipStatus === 'member';/);
  // The Activity disc and the long status line are gone; the line under
  // the bot's name says what it is for.
  assert.doesNotMatch(header, /BotWorkButton|BotWorkStatusLine|data-bot-work-toggle/);
  assert.match(header, /\{botDm \? t\('messages:header\.subtitle\.homeroomBot'\) : subtitle\}/);
  assert.equal(englishText('messages:header.subtitle.homeroomBot'), 'Builds what you ask for');
  const trayModule = read(TRAY);
  assert.doesNotMatch(trayModule, /BotWorkPanel|BotWorkButton|BotWorkStatus|trayStatus/, 'the store and its sync alone');
});

// One story: where each request is in its person's chat with the bot, for
// the strip's rows and buttons (homeroom-bot-tray.js threadsOf).
test('the strip learns each request\'s card, what waits on its person, and its ready card from the chat\'s records', () => {
  const rows = [
    { message_id: 90, kind: 'proposal', slug: 'a', issue_number: 2, meta: {
      status: 'open', sessionId: 5, epoch: 1, actions: [{ id: 'try' }, { id: 'approve' }], waiting: 'you and @ada',
    } },
    { message_id: 80, kind: 'question', slug: 'a', issue_number: 3, meta: { status: 'open', question: 'Which night?', said: 'question' } },
    { message_id: 70, kind: 'question', slug: 'a', issue_number: 4, meta: { status: 'answered', question: 'Old?' } },
    { message_id: 60, kind: 'activity', slug: 'a', issue_number: 3, thread_root_id: null, meta: {} },
    { message_id: 55, kind: 'proposal', slug: 'a', issue_number: 2, meta: { status: 'closed', sessionId: 4 } },
    { message_id: 50, kind: 'activity', slug: 'a', issue_number: 2, thread_root_id: null, meta: {} },
    { message_id: 40, kind: 'build_failed', slug: 'a', issue_number: 5, meta: { status: 'open', said: 'build_time' } },
  ];
  const found = tray.threadsOf(rows);
  assert.deepEqual(found.get(tray.keyOf('a', 3)), { ask: { messageId: 80, kind: 'question', said: 'question', question: 'Which night?' }, cardId: 60 });
  assert.deepEqual(found.get(tray.keyOf('a', 2)), {
    ready: { messageId: 90, sessionId: 5, epoch: 1, open: true, approve: true, waiting: 'you and @ada' }, cardId: 50,
  }, 'the newest ready card, and its approve only while open');
  assert.equal(found.get(tray.keyOf('a', 4)).ask, undefined, 'an answered question waits on nobody');
  assert.deepEqual(found.get(tray.keyOf('a', 5)).ask, { messageId: 40, kind: 'build_failed', said: 'build_time' });
});
