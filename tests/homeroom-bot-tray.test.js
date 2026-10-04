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
    step: 1, of: 6, stepName: 'Read the request', doing: 'reading the request to decide whether to ask a question or build it',
    ...extra,
  });
  assert.deepEqual(tray.jobOfProgress(item({ stage: 'reading' })), {
    key: 'ear trainer#12', appSlug: 'ear trainer', appName: 'Ear Trainer', issueNumber: 12, title: 'Sort by date', firstVersion: false,
    phase: 'looking', stage: 'reading', step: 1, of: 6, stepName: 'Read the request',
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
  assert.equal(tray.outcomeOf({ verdict: 'ready', proposal_session_id: 5, proposal_status: 'merging' }), 'proposed');
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
  stepName: 'Group vote', doing: 'reading the newest replies on its proposal', busyNow: true, since: at(0.15).toISOString(), ...extra,
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
  assert.deepEqual([five.step, five.of, five.stepName], [5, 6, 'Group vote']);
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

test('a build the bot is still on is the work Now shows, not an earlier run; one nothing finished yet says so, never that it stopped', () => {
  const rows = [run(2, 7, 1, { verdict: 'ready' }), run(1, 7, 20, { verdict: 'question' })];
  const building = tray.arrange([entry(7, 'building', { step: 3, stepName: 'Build it' })], rows);
  assert.deepEqual(building.now[0].earlier.map((r) => r.outcome), ['question']);
  // #8 (WP3): out of Now (the bot switched off, or the build gone quiet),
  // it is not "stopped", and the question it moved past is not its news.
  const stalled = tray.arrange([], rows);
  assert.deepEqual(stalled.history.map((job) => [job.outcome, job.doing]), [[null, tray.NOT_FINISHED]]);
  assert.deepEqual(stalled.needsYou, [], 'a question since answered does not need them');
  assert.deepEqual(stalled.history[0].earlier.map((r) => r.outcome), ['question'], 'and the run still going is not an earlier run');
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

test('the staging demo draws work in flight at the step its card shows, a question waiting, and a history, and links nowhere', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const demo = tray.demoWork(now);
  assert.deepEqual(demo.now.map((job) => job.phase), ['building', 'building', 'follow_up_queued']);
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
  assert.ok(demo.history.length >= 2);
  assert.ok(demo.history.some((job) => job.earlier.length >= 2), 'a request the bot came back to');
  const all = [...demo.now, ...demo.needsYou, ...demo.history];
  assert.equal(new Set(all.map((job) => job.key)).size, all.length, 'one entry per request');
  for (const job of all) {
    assert.equal(job.href, null, 'no project stands behind the demo');
    assert.deepEqual(job.links, { request: null, proposal: null, project: null });
    assert.equal(job.appName, 'Staging demo app');
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
    { key: bot.KEY_LIVE_APPS, value: JSON.stringify(['a1', 'a2']) },
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

// ── The tray, drawn ───────────────────────────────────────────────────

const NOW = new Date('2026-10-02T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
const nowhere = { request: null, proposal: null, project: null };
const job = (extra) => ({
  key: `ear-trainer#${extra.issueNumber || 'first'}`, appSlug: 'ear-trainer', appName: 'Ear Trainer', issueNumber: null, title: null,
  firstVersion: false, href: null, links: nowhere, earlier: [], ...extra,
});
const working = (extra) => job({ phase: 'building', step: null, of: null, stepName: null, doing: null, since: null, ...extra });
const past = (extra) => job({ id: 1, outcome: 'live', doing: null, at: minutesAgo(60), ...extra });
const work = (extra) => ({ now: [], needsYou: [], history: [], ...extra });

function status(w) {
  const { trayStatus } = loadTsx(TRAY);
  return trayStatus(w, NOW);
}

function drawPanel(props) {
  const { BotWorkPanelView } = loadTsx(TRAY);
  return renderToHtml(createElement(BotWorkPanelView, { now: NOW, ...props }));
}

test('the status line says what the bot is working on, else what waits on them, else the last thing it did', () => {
  assert.deepEqual(status(null), { kind: 'idle', long: 'Activity', short: 'Activity' }, 'before the first read');
  assert.deepEqual(status(work({})), { kind: 'idle', long: 'Activity', short: 'Activity' }, 'nothing at all yet');

  const one = status(work({ now: [working({ issueNumber: 5, phase: 'following_up' })] }));
  assert.deepEqual(one, { kind: 'working', long: 'Working on Ear Trainer #5 · following up', short: 'Working on #5' });
  assert.equal(status(work({ now: [working({ firstVersion: true, phase: 'setting_up' })] })).long,
    'Working on Ear Trainer first version · setting up');

  const busy = status(work({
    now: [working({ issueNumber: 5 }), working({ issueNumber: 6, phase: 'queued' })],
    needsYou: [past({ issueNumber: 7, outcome: 'question' })],
  }));
  assert.deepEqual(busy, { kind: 'working', long: 'Working on 2 requests · 1 needs you', short: 'Working · 1 needs you' },
    'a phone\'s line keeps what waits on them');
  assert.equal(status(work({ now: [working({ issueNumber: 5 })], needsYou: [past({ issueNumber: 7 })] })).short, 'Working · 1 needs you');

  assert.deepEqual(status(work({ needsYou: [past({ issueNumber: 7, outcome: 'question' })] })),
    { kind: 'you', long: 'Ear Trainer #7 needs you', short: '#7 needs you' });
  assert.deepEqual(status(work({ needsYou: [past({ issueNumber: 7 }), past({ issueNumber: 8 })] })),
    { kind: 'you', long: '2 requests need you', short: '2 need you' });

  assert.deepEqual(status(work({ history: [past({ issueNumber: 9, outcome: 'answer', at: minutesAgo(60 * 16) })] })),
    { kind: 'last', long: 'Last: answered on Ear Trainer #9 · 16h ago', short: 'Last: answered on #9 · 16h ago' });
});

test('the status line under the bot\'s name: a dot while it works, both lengths, and words only', () => {
  const { BotWorkStatusView, trayStatus } = loadTsx(TRAY);
  const draw = (w) => renderToHtml(createElement(BotWorkStatusView, { status: trayStatus(w, NOW) }));
  const busy = draw(work({ now: [working({ issueNumber: 14, phase: 'building' })] }));
  assert.match(busy, /^<div class="messages-thread-sub [^"]*text-\[color:var\(--brand-ink\)\]" data-bot-work-status="working">/);
  assert.match(busy, /animate-ping/);
  assert.match(busy, /<span class="hidden sm:inline">Working on Ear Trainer #14 · building<\/span><span class="sm:hidden">Working on #14<\/span>/);
  // #3770: the Activity disc is the toggle, so the line draws no chevron of one.
  assert.doesNotMatch(busy, /<svg|rotate-180/);
  const quiet = draw(work({ history: [past({ issueNumber: 9 })] }));
  assert.match(quiet, /data-bot-work-status="last"/);
  assert.doesNotMatch(quiet, /animate-ping|brand-ink/);
});

test('#3770: the Activity disc opens the panel, and its badge is the live dot, or what waits on the viewer', () => {
  const { BotWorkButtonView } = loadTsx(TRAY);
  const draw = (w, open = false) => renderToHtml(createElement(BotWorkButtonView, { work: w, open }));
  const quiet = draw(work({ history: [past({ issueNumber: 9 })] }));
  assert.match(quiet, /^<button type="button" class="messages-thread-action messages-bot-work-button" aria-label="Activity" title="Activity" aria-expanded="false" aria-controls="messages-bot-work-panel" data-bot-work-toggle="">/,
    'one of the header\'s discs, named, and the toggle the panel\'s Escape and outside press find');
  assert.match(quiet, /<svg [^>]*aria-hidden="true"><path [^>]*d="M12 6v6h4\.5m4\.5 0a9 9 0 11-18 0 9 9 0 0118 0z"><\/path><\/svg><\/button>$/,
    'the clock, and no badge with nothing going on');
  assert.equal(draw(null), quiet, 'before the first read, the same');
  assert.match(draw(work({}), true), /aria-expanded="true"/, 'open');

  // The bot working: the live dot, carrying the state the declared check
  // (dapp.json homeroom-bot-dm-activity-tray) selects the toggle by.
  const busy = draw(work({ now: [working({ issueNumber: 14 })] }));
  assert.match(busy, /<span class="messages-bot-work-badge messages-bot-work-dot" data-bot-work-status="working"><span class="relative flex h-2 w-2 shrink-0" aria-hidden="true">/);
  assert.match(busy, /animate-ping/);

  // Something waiting on the viewer: how many, which wins over the dot.
  const both = draw(work({ now: [working({ issueNumber: 14 })], needsYou: [past({ issueNumber: 7, outcome: 'question' })] }));
  assert.match(both, /<span class="messages-bot-work-badge messages-bot-work-count" data-bot-work-status="working" aria-hidden="true">1<\/span><\/button>$/);
  assert.doesNotMatch(both, /animate-ping/);
  const waiting = draw(work({ needsYou: [past({ issueNumber: 7 }), past({ issueNumber: 8 })] }));
  assert.match(waiting, /data-bot-work-status="you" aria-hidden="true">2<\/span>/);
  const many = draw(work({ needsYou: Array.from({ length: 12 }, (_, i) => past({ issueNumber: i + 1 })) }));
  assert.match(many, /aria-hidden="true">9\+<\/span>/);

  const check = JSON.parse(read('dapp.json')).tests.find((t) => t.id === 'homeroom-bot-dm-activity-tray');
  assert.match(check.expectSelector, /> \.messages-thread-header \[data-bot-work-toggle\]\[aria-expanded=false\]:has\(\[data-bot-work-status=working\]\)$/,
    'the check finds the disc, closed, with the bot at work');

  const css = read('public/css/app.css');
  assert.match(css, /\.messages-bot-work-button \{ position: relative; \}/);
  assert.match(css, /\.messages-bot-work-count \{[^}]*color: var\(--accent-ink\);\s*background: var\(--accent\);/, 'a number for the viewer, in the accent');
  assert.doesNotMatch(css, /\.messages-bot-work-button[^{]*\{[^}]*display: none/, 'drawn on a phone too, unlike the full-width toggle');
});

test('the panel: Now with the step it is at, Needs you, and History folded away', () => {
  const html = drawPanel({
    work: work({
      now: [working({
        issueNumber: 12, title: 'Sort by date', phase: 'building', step: 3, of: 6, stepName: 'Build it', doing: 'building it',
        since: minutesAgo(4), href: '#app/ear-trainer/dev/issues/12',
        links: { request: '#app/ear-trainer/dev/issues/12', proposal: null, project: null },
        earlier: [{ id: 3, outcome: 'question', at: minutesAgo(60 * 20) }],
      })],
      needsYou: [past({
        id: 4, issueNumber: 14, title: 'Add a metronome', outcome: 'question', at: minutesAgo(35),
        links: { request: '#app/ear-trainer/dev/issues/14', proposal: null, project: null },
      })],
      history: [past({
        id: 2, issueNumber: 9, title: 'Item counts', outcome: 'proposed', at: minutesAgo(90),
        links: { request: '#app/ear-trainer/dev/issues/9', proposal: '#app/ear-trainer/dev/proposals/40', project: null },
      }), past({ id: 1, firstVersion: true, outcome: 'live', at: minutesAgo(60 * 24 * 3) })],
    }),
  });
  assert.match(html, /<section id="messages-bot-work-panel" class="absolute inset-x-3 [^"]*" aria-label="Homeroom bot activity" data-bot-work-panel="">/);
  assert.match(html, />Now</);
  assert.match(html, /data-bot-work-tile="now" data-bot-work-tone="working"/);
  assert.match(html, /aria-label="Step 3 of 6: Build it"/, 'the ring the activity cards draw');
  assert.match(html, /Step 3 of 6 · Build it/);
  assert.match(html, /Ear Trainer #12: Sort by date/);
  assert.match(html, /Building it · 4m so far/);
  assert.match(html, /<a href="#app\/ear-trainer\/dev\/issues\/12" [^>]*data-bot-work-link="">Request #12<\/a>/);
  assert.match(html, /<button type="button" [^>]*aria-expanded="false" data-bot-work-earlier="1">1 earlier run/);
  assert.match(html, />Needs you</);
  assert.match(html, /data-bot-work-tile="you" data-bot-work-tone="you"/);
  assert.match(html, /Asked you a question · 35m ago/);
  assert.match(html, /<button type="button" [^>]*aria-expanded="false" aria-controls="messages-bot-work-history" data-bot-work-history-toggle="">Show history \(2\)/);
  assert.doesNotMatch(html, /Item counts|data-bot-work-tile="history"/, 'History starts folded away');
  assert.doesNotMatch(html, /I’m not working on anything/);

  const unfolded = drawPanel({
    historyOpen: true,
    work: work({
      history: [past({
        id: 2, issueNumber: 9, title: 'Item counts', outcome: 'proposed', at: minutesAgo(90),
        links: { request: '#app/ear-trainer/dev/issues/9', proposal: '#app/ear-trainer/dev/proposals/40', project: null },
        earlier: [{ id: 5, outcome: 'revise', at: minutesAgo(100) }, { id: 6, outcome: 'answer', at: minutesAgo(110) }],
      }), past({ id: 1, firstVersion: true, outcome: 'live', at: minutesAgo(60 * 24 * 3), links: { request: null, proposal: null, project: '#app/ear-trainer/app' } }),
      past({ id: 7, issueNumber: 3, outcome: 'build_failed', at: minutesAgo(60 * 24 * 4) })],
    }),
  });
  assert.match(unfolded, /aria-expanded="true" aria-controls="messages-bot-work-history" data-bot-work-history-toggle="">Hide history/);
  assert.match(unfolded, /<div id="messages-bot-work-history"/);
  assert.match(unfolded, /data-bot-work-tile="history" data-bot-work-tone="done"/);
  assert.match(unfolded, /Built it\. Waiting for approval · 1h ago/, 'the cards\' words');
  assert.match(unfolded, />Open change<\/a>/);
  assert.match(unfolded, /2 earlier runs/);
  assert.match(unfolded, /Ear Trainer first version/);
  assert.match(unfolded, /Built it\. It’s live/);
  assert.match(unfolded, />Open project<\/a>/);
  assert.match(unfolded, /data-bot-work-tone="trouble"[\s\S]*Couldn’t finish building it/);
  assert.match(unfolded, /I’m not working on anything for you right now\./, 'nothing in hand and nothing waiting');
});

test('a new project waiting for its secrets says so in its own words', () => {
  const html = drawPanel({
    work: work({ needsYou: [past({ id: 0, firstVersion: true, outcome: null, doing: 'the project is waiting for its secrets to be set on its page before it can start', at: minutesAgo(10) })] }),
  });
  assert.match(html, /The project is waiting for its secrets to be set on its page before it can start · 10m ago/);
});

test('the panel with nothing yet, before its first read, and when the read failed', () => {
  const empty = drawPanel({ work: work({}) });
  assert.match(empty, /I’m not working on anything for you right now\./);
  assert.match(empty, /Nothing yet\. When I work on a request of yours, it shows up here\./);
  assert.doesNotMatch(empty, /Show history/);
  const loading = drawPanel({ work: null });
  assert.match(loading, /role="status">Loading activity</);
  const failed = drawPanel({ work: null, failed: true });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Couldn’t load what I’m working on\./);
  assert.match(failed, />Try again</);
  const stale = drawPanel({ work: work({}), failed: true });
  assert.match(stale, /may be out of date/, 'a failed refresh keeps what was read, and says so');
});

test('a tile with nowhere to open has no links', () => {
  const html = drawPanel({ work: tray.demoWork(NOW.getTime()), historyOpen: true });
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /Staging demo app #14: Staging demo, show a total under the list/);
  assert.match(html, /Asked you a question · 35m ago/);
  assert.match(html, /Waiting in the queue \(number 1\) to follow up on the newest replies on its proposal · 1m so far/);
});

test('every phase and ending has words', () => {
  const { PHASE_LABELS, SHORT_PHASES, LAST_WORDS, jobTitle, jobName, newestBotMessageId, WORK_CHANGED_EVENT } = loadTsx(TRAY);
  assert.deepEqual(Object.keys(PHASE_LABELS).sort(), [...tray.PHASES].sort());
  assert.deepEqual(Object.keys(SHORT_PHASES).sort(), [...tray.PHASES].sort());
  assert.deepEqual(Object.keys(LAST_WORDS).sort(), [...tray.OUTCOMES].sort());
  for (const outcome of tray.OUTCOMES) assert.match(LAST_WORDS[outcome]('Ear Trainer #3'), /Ear Trainer #3/, outcome);
  assert.equal(WORK_CHANGED_EVENT, 'homeroom-bot-work-changed');
  assert.equal(jobTitle(job({ firstVersion: true, title: 'ignored' })), 'Ear Trainer first version');
  assert.equal(jobTitle(job({ issueNumber: 3, title: 'Sort' })), 'Ear Trainer #3: Sort');
  assert.equal(jobName(job({ issueNumber: 3, title: 'Sort' })), 'Ear Trainer #3');
  const message = (id, isBot) => ({ id, sender: { id: isBot ? 1 : 2, username: isBot ? 'homeroom_bot' : 'ada', ...(isBot ? { bot: true } : {}) } });
  assert.equal(newestBotMessageId([message(4, true), message(7, true), message(9, false), message(-3, false)]), 7);
  assert.equal(newestBotMessageId([message(9, false)]), null);
});

test('the client keeps only the platform\'s own addresses as links, and known words', () => {
  const { normalizeBotWork } = loadTsx(API);
  const w = normalizeBotWork({
    now: [
      { appSlug: 'a', appName: 'A', issueNumber: 3, phase: 'building', since: 'x', href: 'javascript:alert(1)',
        links: { request: 'https://example.test/x', proposal: '#app/a/dev/proposals/4' }, step: 3, of: 6, stepName: 'Build it' },
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
  assert.deepEqual([w.now[0].step, w.now[0].of, w.now[0].stepName], [3, 6, 'Build it']);
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

test('only a conversation with the Homeroom bot carries the tray: its Activity disc toggles the panel, which drops from under the header', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const botDm = !!snap\.active && snap\.active\.id === conversationId && snap\.active\.kind === 'direct'\s*&& snap\.active\.membershipStatus === 'member' && snap\.active\.homeroomBot === true;/);
  // The panel's anchor sits right under the header, so the panel covers the transcript and moves nothing.
  assert.match(screen, /\{embedded \? null : <ThreadHeader \/>\}\s*(?:\{\/\*[^\n]*\*\/\}\s*)?\{botDm && !embedded \? <BotWorkPanel \/> : null\}/);
  assert.match(screen, /\{botDm \? <BotWorkSync conversationId=\{conversationId\} newsKey=\{newestBotMessageId\(snap\.messages\)\} \/> : null\}/);

  const header = screen.slice(screen.indexOf('function ThreadHeader()'), screen.indexOf('function isCardMessage('));
  assert.match(header, /const botDm = active\.kind === 'direct' && !!active\.homeroomBot && active\.membershipStatus === 'member';/);
  // #3770: the disc, just before the full-width toggle; the name block above
  // the status line is no longer a toggle, and draws no chevron.
  assert.match(header, /\{botDm \? <BotWorkButton \/> : null\}\s*<FullWidthToggle \/>/);
  const nameBlock = header.slice(header.indexOf('className="min-w-0 text-left flex-1"'), header.indexOf('</button>', header.indexOf('className="min-w-0 text-left flex-1"')));
  assert.match(nameBlock, /onClick=\{\(\) => \{ if \(active\.kind === 'group'\) openDialog\('messagesMembers'\); \}\}/);
  assert.doesNotMatch(nameBlock, /toggleBotWork|aria-expanded|aria-controls|data-bot-work-toggle|ChevronDownIcon/);
  assert.match(nameBlock, /\{botDm \? <BotWorkStatusLine \/> : <div className="messages-thread-sub">\{subtitle\}<\/div>\}/);
  assert.doesNotMatch(header, /useBotWork\(\)|toggleBotWork|BOT_WORK_PANEL_ID/, 'the disc reads the tray\'s store itself');
  assert.doesNotMatch(header, /Activity &amp; history|data-bot-work-open/, 'the ⋯ menu no longer needs a way in');

  // A press on the full-width toggle widens the pane under the panel and leaves it open.
  const fullWidth = screen.slice(screen.indexOf('function FullWidthToggle()'), screen.indexOf('function ThreadHeader()'));
  assert.match(fullWidth, /title=\{label\}\s*data-bot-work-keep=""/);
  const tray = read(TRAY);
  const panel = tray.slice(tray.indexOf('export function BotWorkPanel()'), tray.indexOf('export function BotWorkSync('));
  assert.match(panel, /target\.closest\?\.\('\[data-bot-work-toggle\], \[data-bot-work-keep\]'\)\) return;\s*setBotWorkOpen\(false\);/);
  assert.match(panel, /setBotWorkOpen\(false\);\s*document\.querySelector<HTMLElement>\('\[data-bot-work-toggle\]'\)\?\.focus/, 'Escape hands focus back to the disc');

  const { BOT_WORK_PANEL_ID } = loadTsx(TRAY);
  assert.equal(BOT_WORK_PANEL_ID, 'messages-bot-work-panel');
});
