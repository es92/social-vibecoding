'use strict';

// #3736: activity cards in the Homeroom bot's DM.
//
// tests/homeroom-bot-activity-postgres.test.js pins a card's whole life on
// the real schema and through the real route: started by the live loop,
// moving through the steps, ending, and whose cards are read. This file
// pins the rest without a database:
//
//   - the service's pure rules: what a piece of work came to, from the first
//     live run after its card began; a card still going takes its step from
//     progressFor; where a card's links go;
//   - starting a card: only for somebody the bot talks to in a DM, one per
//     claimed queue row, recorded as the bot's news about the request, and
//     never a reason the work fails;
//   - where it starts: beside the "looking into it" post, so never for a
//     follow-up, a restart or a backlog pass;
//   - work already under way without a card (catchUpCards): which stages
//     are a piece of work a card follows, the key and the start each one is
//     given, which requests a card already follows, and the words of a card
//     that joins work begun earlier. The PostgreSQL side is
//     tests/homeroom-bot-activity-catch-up-postgres.test.js;
//   - the client: what it keeps of a read, the card drawn in every state,
//     the row drawing it in place of the message's words, the store reading
//     again on `homeroom_bot_work_changed` and on the bot's news, and asking
//     once per opening of the DM for the cards work under way is missing.
//
// Run with: node --test tests/homeroom-bot-activity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CARD = 'frontend/src/features/messages/bot-activity.tsx';
const STORE = 'frontend/src/features/messages/bot-activity-store.ts';
const API = 'frontend/src/features/messages/api.ts';

const activity = require('../src/services/homeroom-bot-activity');
const dmSvc = require('../src/services/homeroom-bot-dm');

// ── What a piece of work came to ──

test('a card\'s outcome is the first live run after it began: its verdict, and for a build what the build came to', () => {
  const run = (extra) => ({ run_id: 1, ...extra });
  assert.equal(activity.outcomeOf({}), null, 'no run yet: still going');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready' })), null, 'a build not finished: still going');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', proposal_session_id: 4, proposal_status: 'promoted' })), 'proposed');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', proposal_session_id: 4, proposal_status: 'merging' })), 'proposed');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', proposal_session_id: 4, proposal_status: 'merged' })), 'live');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', proposal_session_id: 4, proposal_status: 'closed' })), 'closed');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', build_ok: true })), 'proposed', 'built, its proposal a moment from recorded');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', build_ok: false, build_error: 'turn timed out' })), 'build_failed');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', build_ok: false, build_error: 'blocked: needs a paid API' })), 'blocked');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', build_ok: false, build_error: 'skipped: the request was closed before its build started' })), 'stopped',
    'a build its request was closed before never started: nothing went wrong in it');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', cap_suppressed: 'proposals_per_app' })), 'held');
  assert.equal(activity.outcomeOf(run({ verdict: 'question', cap_suppressed: 'questions_per_day' })), 'held',
    'a question held back by a cap was never asked');
  for (const verdict of ['question', 'person', 'empty', 'failed', 'answer', 'revise']) {
    assert.equal(activity.outcomeOf(run({ verdict })), verdict);
  }
  assert.equal(activity.outcomeOf(run({ verdict: 'something new' })), 'failed');
  for (const outcome of ['question', 'proposed', 'live', 'closed', 'blocked', 'build_failed', 'person', 'empty', 'failed', 'held', 'stopped']) {
    assert.ok(activity.OUTCOMES.includes(outcome), outcome);
  }
});

test('a card still going takes its step from progressFor; with nothing in progress it stopped', () => {
  const row = { message_id: 31, created_at: '2026-10-02T11:51:00Z', slug: 'ear trainer', issue_number: 12 };
  const entry = {
    project: 'ear trainer', number: 12, stage: 'building', step: 3, of: 6, stepName: 'Build it', doing: 'building it',
    since: '2026-10-02T11:56:00.000Z', stepTimeLimitMinutes: 30,
  };
  const going = activity.cardOf(row, entry);
  assert.deepEqual(going, {
    messageId: 31, startedAt: '2026-10-02T11:51:00.000Z',
    links: { request: '#app/ear%20trainer/dev/issues/12', proposal: null },
    state: 'working', stage: 'building', step: 3, of: 6, stepName: 'Build it', doing: 'building it',
    stepSince: '2026-10-02T11:56:00.000Z', stepLimitMinutes: 30,
  });
  assert.equal(activity.cardOf(row, { ...entry, waitingOn: 'them' }).waitingOn, 'them');

  const gone = activity.cardOf(row, null);
  assert.equal(gone.state, 'done');
  assert.equal(gone.outcome, 'stopped', 'no run and nothing in progress: it stopped, never "still going" forever');
  assert.equal(gone.endedAt, null);
  const superseded = activity.cardOf({ ...row, next_at: '2026-10-02T11:58:00Z' }, entry);
  assert.equal(superseded.outcome, 'stopped', 'a newer card on the same request is the one going');

  const asked = activity.cardOf({ ...row, run_id: 5, verdict: 'question', run_at: '2026-10-02T11:53:00Z' }, entry);
  assert.equal(asked.state, 'done');
  assert.equal(asked.outcome, 'question', 'an outcome wins over whatever the request is doing since');
  assert.equal(asked.endedAt, '2026-10-02T11:53:00.000Z');
  const proposed = activity.cardOf({
    ...row, run_id: 5, verdict: 'ready', proposal_session_id: 40, proposal_status: 'promoted',
    run_at: '2026-10-02T11:53:00Z', proposal_at: '2026-10-02T12:14:00Z',
  }, null);
  assert.equal(proposed.outcome, 'proposed');
  assert.equal(proposed.endedAt, '2026-10-02T12:14:00.000Z', 'a build ends when its proposal goes up');
  assert.deepEqual(proposed.links, { request: '#app/ear%20trainer/dev/issues/12', proposal: '#app/ear%20trainer/dev/proposals/40' });
  assert.equal(activity.cardOf({ ...row, run_id: 5, verdict: 'ready', build_ok: false }, null).endedAt, null,
    'no record says when a build stopped');
});

// WP1 (#9): Plant Pal #1's card read "Didn't finish" the moment a second
// look at the request began, with its build healthy and nothing said.
test('WP1: a card whose build still waits or runs is working, whatever began after it', () => {
  const row = {
    message_id: 31, created_at: '2026-10-03T16:44:00Z', slug: 'plant-pal', issue_number: 1,
    run_id: 776, verdict: 'ready', run_at: '2026-10-03T16:45:36Z', next_at: '2026-10-03T16:55:03Z',
  };
  const waiting = activity.cardOf({ ...row, build_waiting_at: '2026-10-03T16:45:36Z' }, null);
  assert.deepEqual([waiting.state, waiting.stage, waiting.doing], ['working', 'build_queued', 'ready to build; waiting its turn to be built']);
  const building = activity.cardOf({ ...row, build_status: 'active' }, null);
  assert.deepEqual([building.state, building.stage, building.step, building.doing], ['working', 'building', null, 'building it'],
    'a newer card on its request does not end it');
  assert.equal(activity.cardOf({ ...row, build_status: 'paused' }, null).state, 'working', 'proposing it');
  // The newer card's progress is the request's, not this card's.
  const entry = { stage: 'reading', step: 1, of: 6, stepName: 'Read the request', doing: 'reading the request' };
  assert.equal(activity.cardOf({ ...row, build_status: 'active' }, entry).stage, 'building');
  // Its own progress, while it is the newest card, is read as before.
  const own = activity.cardOf({ ...row, next_at: null, build_status: 'active' }, { stage: 'building', step: 3, of: 6, stepName: 'Build it', doing: 'building it' });
  assert.deepEqual([own.stage, own.step], ['building', 3]);
  // A build with nothing under way any more (its session put away, never
  // recorded) is not working for ever, and an outcome always wins.
  assert.equal(activity.cardOf({ ...row, build_status: 'archived' }, null).outcome, 'stopped');
  assert.equal(activity.cardOf({ ...row, build_status: 'active', build_ok: false, build_error: 'skipped: the request already has a proposal (6190)' }, null).outcome, 'stopped');
  assert.equal(activity.cardOf({ ...row, build_waiting_at: '2026-10-03T16:45:36Z', cap_suppressed: 'proposals_per_app' }, null).outcome, 'held');
  // A proposal withdrawn (a duplicate, noteRequestMerged) is closed.
  assert.equal(activity.outcomeOf({ run_id: 1, verdict: 'ready', proposal_session_id: 6191, proposal_status: 'archived' }), 'closed');
  // The read carries what the rule needs.
  const service = read('src/services/homeroom-bot-activity.js');
  assert.match(service, /run\.live_build_waiting_at AS build_waiting_at, bs\.status AS build_status,/);
  assert.match(service, /LEFT JOIN chat_sessions bs ON bs\.id = run\.build_session_id/);
});

// WP1 (#10): the bot's model reads the DM as text and never sees a card, so
// its history says what each card shows, in the card's own words.
test('WP1: a card in words, as the person reads it, in the client\'s own labels', () => {
  assert.equal(activity.cardWords({ state: 'done', outcome: 'stopped' }), 'Didn\'t finish: Stopped before it finished');
  assert.equal(activity.cardWords({ state: 'done', outcome: 'proposed' }), 'Done: Built it. Waiting for approval');
  assert.equal(activity.cardWords({ state: 'working', step: 3, of: 6, stepName: 'Build it', doing: 'building it' }), 'Step 3 of 6 · Build it: building it');
  assert.equal(activity.cardWords({ state: 'working', step: null, of: null, doing: 'building it' }), 'Working on it: building it');
  assert.equal(activity.cardWords(null), null);
  assert.equal(activity.cardWords({ state: 'done', outcome: 'something new' }), null);
  // The same words the client draws (curly apostrophes there).
  const tsx = read(CARD);
  const table = (name) => {
    const body = tsx.slice(tsx.indexOf(`export const ${name}`), tsx.indexOf('};', tsx.indexOf(`export const ${name}`)));
    return Object.fromEntries([...body.matchAll(/(\w+): '([^']*)'/g)].map((m) => [m[1], m[2].replace(/’/g, '\'')]));
  };
  assert.deepEqual(table('ACTIVITY_OUTCOME_LABELS'), { ...activity.OUTCOME_LABELS });
  assert.deepEqual(table('ACTIVITY_OUTCOME_TONES'), { ...activity.OUTCOME_TONES });
  assert.deepEqual(table('TONE_WORDS'), { ...activity.TONE_WORDS });
  for (const outcome of activity.OUTCOMES) assert.ok(activity.OUTCOME_LABELS[outcome], outcome);
});

test('a card links its request, and its proposal only once people can open it', () => {
  const row = { slug: 'x', issue_number: 3, proposal_session_id: 9 };
  for (const status of ['promoted', 'merging', 'merged']) {
    assert.equal(activity.linksOf({ ...row, proposal_status: status }).proposal, '#app/x/dev/proposals/9', status);
  }
  for (const status of ['active', 'paused', 'closed', null]) {
    assert.equal(activity.linksOf({ ...row, proposal_status: status }).proposal, null, String(status));
  }
  assert.equal(activity.linksOf(row).request, '#app/x/dev/issues/3');
});

test('a card that joined work under way starts when that work began, not when the card was sent', () => {
  const row = {
    message_id: 40, created_at: '2026-10-02T12:00:00Z', began: '2026-10-02T11:22:00Z', slug: 'x', issue_number: 3,
  };
  assert.equal(activity.cardOf(row, { project: 'x', number: 3, stage: 'planning' }).startedAt, '2026-10-02T11:22:00.000Z');
  assert.equal(activity.cardOf({ ...row, began: null }, null).startedAt, '2026-10-02T12:00:00.000Z',
    'a card the loop sent began when it was sent');
  // The read pairs each card with the first run from that moment, and reads
  // past a build a restart sent back to be looked at again.
  const service = read('src/services/homeroom-bot-activity.js');
  assert.match(service, /CASE WHEN m\.metadata->'homeroomBot'->>'startedAt'/);
  // B4: a card carried on through several looks is read from the newest
  // look's start, and counts its time from the first.
  assert.match(service, /CASE WHEN m\.metadata->'homeroomBot'->>'lookAt'/);
  assert.match(service, /COALESCE\(started_at, created_at\) AS first_at,\s+COALESCE\(look_at, started_at, created_at\) AS began/);
  assert.equal(activity.cardOf({ ...row, first_at: '2026-10-02T10:00:00Z' }, { project: 'x', number: 3, stage: 'planning' }).startedAt,
    '2026-10-02T10:00:00.000Z');
  assert.match(service, /AND r\.created_at >= c\.began\s+AND \(nxt\.began IS NULL OR r\.created_at < nxt\.began\)/);
  assert.match(service, /AND NOT \(r\.build_ok IS FALSE AND right\(COALESCE\(r\.build_error, ''\), char_length\(\$3::text\)\) = \$3::text\)/);
  const bot = read('src/services/homeroom-bot.js');
  assert.match(bot, /error: `interrupted: \$\{plan\.lost \? \(plan\.why \|\| 'the turn was lost'\) : 'the spec turn was cut short'\}`\s*\+ ` \$\{RESTARTED_BUILD_NOTE\}`/,
    'the restart\'s requeue writes the note the card reads past');
});

// ── Starting one ──

function startDeps({ dmUsers = ['ada'], sendResult, sendThrows = false } = {}) {
  const sent = [];
  const queries = [];
  const pool = { async query(sql, params) { queries.push([String(sql), params]); return { rows: [] }; } };
  const dm = {
    isDmUser: dmSvc.isDmUser,
    hasBot: dmSvc.hasBot,
    requestLine: dmSvc.requestLine,
    async requestStart() { return 77; },
    async sendDm(_pool, args) {
      if (sendThrows) throw new Error('database gone');
      sent.push(args);
      return sendResult === undefined ? { conversationId: 5, messageId: 900, duplicate: false } : sendResult;
    },
  };
  return { pool, dm, sent, queries, settings: { dmUsers } };
}

const app = { id: 11, slug: 'ear-trainer', name: 'Ear Trainer' };
const bot = { id: 1, username: 'homeroom_bot' };
const ada = { userId: 7, username: 'ada', issueTitle: 'Sort by date', firstVersion: false };

test('starting work sends the requester ONE card, keyed by the queue row it was claimed from, and records it', async () => {
  const { pool, dm, sent, queries, settings } = startDeps();
  const out = await activity.startCard(pool, { app, issueNumber: 12, requester: ada, bot, jobKey: 345, settings, deps: { dm } });
  assert.deepEqual(out, { conversationId: 5, messageId: 900, duplicate: false });
  assert.equal(sent.length, 1);
  const [card] = sent;
  assert.equal(card.userId, 7);
  assert.equal(card.idempotencyKey, 'hrbot-activity-345', 'a look handed back and started again keeps its card');
  assert.equal(card.replyToId, 77, 'it quotes the message the request started from, as the bot\'s other news does');
  assert.deepEqual(card.metadata, {
    kind: 'activity', appSlug: 'ear-trainer', appName: 'Ear Trainer', issueNumber: 12, issueTitle: 'Sort by date',
  });
  assert.match(card.content, /^\*\*Ear Trainer\*\* · request #12: Sort by date\n\nI'm working on this now\. This card updates as I go\.$/);
  const insert = queries.find(([sql]) => /INSERT INTO homeroom_bot_dm_messages/.test(sql));
  assert.ok(insert, 'recorded as the bot\'s news about the request');
  assert.deepEqual(insert[1], [900, 7, 5, 11, 12, 'activity']);
});

test('a first version\'s card says so', async () => {
  const { pool, dm, sent, settings } = startDeps();
  await activity.startCard(pool, {
    app, issueNumber: 1, requester: { ...ada, issueTitle: null, firstVersion: true }, bot, jobKey: 9, settings, deps: { dm },
  });
  assert.equal(sent[0].metadata.firstVersion, true);
  assert.match(sent[0].content, /^\*\*Ear Trainer\*\*, its first version\n\nI'm working on the first version now\./);
});

test('no card for somebody the bot does not talk to in a DM, nor without a requester or a job', async () => {
  const off = startDeps({ dmUsers: ['sam'] });
  assert.equal(await activity.startCard(off.pool, { app, issueNumber: 12, requester: ada, bot, jobKey: 1, settings: off.settings, deps: { dm: off.dm } }), null);
  assert.equal(off.sent.length, 0);
  const on = startDeps();
  assert.equal(await activity.startCard(on.pool, { app, issueNumber: 12, requester: null, bot, jobKey: 1, settings: on.settings, deps: { dm: on.dm } }), null);
  assert.equal(await activity.startCard(on.pool, { app, issueNumber: 12, requester: ada, bot, jobKey: null, settings: on.settings, deps: { dm: on.dm } }), null);
  assert.equal(await activity.startCard(on.pool, { app, issueNumber: 0, requester: ada, bot, jobKey: 1, settings: on.settings, deps: { dm: on.dm } }), null);
  assert.equal(on.sent.length, 0);
});

test('the same piece of work sent again is not recorded twice, and a card that cannot be sent never costs the work', async () => {
  const dup = startDeps({ sendResult: { conversationId: 5, messageId: 900, duplicate: true } });
  await activity.startCard(dup.pool, { app, issueNumber: 12, requester: ada, bot, jobKey: 3, settings: dup.settings, deps: { dm: dup.dm } });
  assert.ok(!dup.queries.some(([sql]) => /INSERT INTO homeroom_bot_dm_messages/.test(sql)));
  const refused = startDeps({ sendResult: null });
  assert.equal(await activity.startCard(refused.pool, { app, issueNumber: 12, requester: ada, bot, jobKey: 3, settings: refused.settings, deps: { dm: refused.dm } }), null);
  const broken = startDeps({ sendThrows: true });
  assert.equal(await activity.startCard(broken.pool, { app, issueNumber: 12, requester: ada, bot, jobKey: 3, settings: broken.settings, deps: { dm: broken.dm } }), null);
});

test('the live loop starts a card where it tells the request it is looking: never for a follow-up, a restart or a backlog pass', () => {
  const source = read('src/services/homeroom-bot.js');
  const body = source.slice(source.indexOf('async function runTriage('), source.indexOf('function shadowBuildSkipReason('));
  const followUp = body.indexOf('return runFollowUp(pool, config, {');
  const looking = body.indexOf("kind: 'looking', text: live.lookingText(), sender: bot,");
  const start = body.indexOf('await activity().startCard(pool, {');
  const reading = body.indexOf('const seedReadAt = new Date().toISOString();');
  assert.ok(followUp > -1 && looking > -1 && start > -1 && reading > -1);
  assert.ok(followUp < looking && looking < start && start < reading,
    'after a follow-up has returned and the looking post is made, before the request is read');
  assert.match(body.slice(looking, reading),
    /if \(item\.reason !== RESTART_REASON && item\.reason !== APP_AGAIN_REASON\) \{\s*await activity\(\)\.startCard\(pool, \{ app, issueNumber, requester, bot, jobKey: item\.id, settings, deps: \{ dm: deps\.dm \} \}\);/);
  // Inside the live branch: shadow triage has no card.
  const live = body.lastIndexOf('if (liveMode) {', looking);
  assert.ok(live > -1 && body.indexOf('const open = await live.openBotProposal', live) < looking);
});

// ── Work already under way without a card ──

const progressSvc = require('../src/services/homeroom-bot-progress');
const traySvc = require('../src/services/homeroom-bot-tray');

test('work under way is a look being read, or the plan and build its ready verdict started: what the tray lists as looking or building', () => {
  for (const stage of activity.UNDER_WAY_STAGES) {
    assert.ok(progressSvc.BUSY_STAGES.has(stage), `${stage}: the bot is working on it this minute`);
    assert.ok(progressSvc.IN_FLIGHT_STAGES.has(stage), `${stage}: the tray lists it under Now`);
    assert.ok(['looking', 'building'].includes(traySvc.PHASE_OF_STAGE[stage]), stage);
  }
  // Everything else the tray lists under Now is not a look of the request's
  // own: waiting in the queue, a ready verdict waiting its turn to be built,
  // a follow-up on its proposal, a merge, a project being set up. None of
  // them is given a card.
  const others = [...progressSvc.IN_FLIGHT_STAGES].filter((stage) => !activity.UNDER_WAY_STAGES.includes(stage)).sort();
  assert.deepEqual(others, ['build_queued', 'fix_queued', 'fixing', 'followup_queued', 'merging', 'queued', 'revising', 'setting_up']);
});

test('a look being read is keyed as the loop keys its card; a plan or build by its run, begun when its look began', () => {
  const reading = { stage: 'reading', since: '2026-10-02T11:50:00Z' };
  const row = { queue_id: 345, started_at: '2026-10-02T11:50:00Z', queue_reason: 'new', run_id: 8, run_at: '2026-10-01T09:00:00Z' };
  assert.deepEqual(activity.pieceOf(row, reading), { key: 'hrbot-activity-345', startedAt: '2026-10-02T11:50:00.000Z' });
  assert.equal(activity.pieceOf(row, reading).key, activity.jobCardKey(345),
    'the same message as the loop\'s own card for that look, whichever is sent first');
  assert.equal(activity.pieceOf({ ...row, queue_reason: 'restart' }, reading).key, 'hrbot-activity-345',
    'a restart\'s look is keyed the same way (whether it already has a card is the read\'s to say)');
  assert.equal(activity.pieceOf({ ...row, queue_reason: 'app_again' }, reading, { quietReasons: ['app_again'] }), null,
    'a backlog pass says nothing while it reads');
  assert.equal(activity.pieceOf({ ...row, queue_id: null }, reading), null);

  const ran = { run_id: 9, run_at: '2026-10-02T12:00:00Z', run_duration_ms: 300000, queue_id: null, queue_reason: null };
  for (const stage of ['starting', 'planning', 'building', 'proposing']) {
    assert.deepEqual(activity.pieceOf(ran, { stage }), { key: 'hrbot-activity-run-9', startedAt: '2026-10-02T11:55:00.000Z' }, stage);
  }
  assert.equal(activity.pieceOf({ ...ran, run_duration_ms: null }, { stage: 'building' }).startedAt, '2026-10-02T12:00:00.000Z');
  assert.ok(activity.pieceOf(ran, { stage: 'planning' }, { quietReasons: ['app_again'] }),
    'a backlog pass that went on to build is work under way like any other');
  assert.equal(activity.pieceOf({ ...ran, run_id: null }, { stage: 'building' }), null);

  for (const stage of ['queued', 'build_queued', 'question', 'held', 'stalled', 'revising', 'fixing', 'followup_queued', 'fix_queued', 'merging', 'checks', 'vote', 'setting_up']) {
    assert.equal(activity.pieceOf({ ...row, ...ran }, { stage }), null, stage);
  }
  assert.equal(activity.pieceOf(ran, { stage: 'building', waitingOn: 'them' }), null);
  assert.equal(activity.pieceOf(ran, null), null);
});

test('a request whose newest card has come to nothing yet is followed by it; one whose newest card ended is not', () => {
  const followed = activity.followedRequests([
    { app_id: 1, issue_number: 3, run_id: null },
    { app_id: 1, issue_number: 4, run_id: 5, verdict: 'question' },
    { app_id: 1, issue_number: 5, run_id: 6, verdict: 'ready' },
    { app_id: 1, issue_number: 6, run_id: 7, verdict: 'ready', build_ok: false, build_error: 'the build ran past its time limit' },
    { app_id: 2, issue_number: 3, run_id: 8, verdict: 'ready', proposal_session_id: 4, proposal_status: 'promoted' },
    // Older cards: the newest on each request decides.
    { app_id: 1, issue_number: 4, run_id: null },
    { app_id: 1, issue_number: 3, run_id: 2, verdict: 'empty' },
  ]);
  assert.deepEqual([...followed].sort(), ['1#3', '1#5'], 'no run yet, or a build not finished');
});

test('a card that joins work under way says, in plain words, that the work was started earlier', () => {
  const context = { appName: 'Ear Trainer', issueNumber: 12, issueTitle: 'Sort by date', firstVersion: false };
  assert.equal(activity.cardText(context, dmSvc, { joined: true }),
    '**Ear Trainer** · request #12: Sort by date\n\nI started on this earlier and I\'m still working on it. This card updates as I go.');
  assert.equal(activity.cardText({ ...context, firstVersion: true }, dmSvc, { joined: true }),
    '**Ear Trainer**, its first version\n\nI started on the first version earlier and I\'m still working on it. This card updates as I go.');
  assert.equal(activity.cardText(context, dmSvc),
    '**Ear Trainer** · request #12: Sort by date\n\nI\'m working on this now. This card updates as I go.', 'unchanged for a card sent as the work starts');
  for (const joined of [true, false]) assert.doesNotMatch(activity.cardText(context, dmSvc, { joined }), /—/);
});

test('catching up gives nobody else\'s work a card, and does nothing for somebody the bot does not DM, while it is off, or on staging', async () => {
  const queries = [];
  const pool = {
    async query(sql) { queries.push(String(sql)); return { rows: [] }; },
    async connect() { throw new Error('no lock is taken when there is nothing to do'); },
  };
  const deps = (over = {}) => ({
    dm: { isDmUser: dmSvc.isDmUser, hasBot: dmSvc.hasBot },
    liveSvc: { isStaging: () => false, isLiveFor: () => true, ...over.liveSvc },
    botSvc: { APP_AGAIN_REASON: 'app_again', async readSettings() { throw new Error('settings were passed'); } },
  });
  const ada = { id: 7, username: 'ada' };
  const on = { mode: 'shadow', dmUsers: ['ada'] };
  assert.deepEqual(await activity.catchUpCards(pool, { user: { id: 8, username: 'sam' }, settings: on, deps: deps() }), { added: 0 });
  assert.deepEqual(await activity.catchUpCards(pool, { user: ada, settings: { ...on, mode: 'off' }, deps: deps() }), { added: 0 });
  assert.deepEqual(await activity.catchUpCards(pool, { user: ada, settings: on, deps: deps({ liveSvc: { isStaging: () => true } }) }), { added: 0 });
  assert.deepEqual(await activity.catchUpCards(pool, { user: null, settings: on, deps: deps() }), { added: 0 });
  assert.deepEqual(queries, [], 'nothing is read for any of them');
  // A fault is never the page's problem.
  const broken = { async query() { throw new Error('database gone'); }, async connect() { throw new Error('database gone'); } };
  assert.deepEqual(await activity.catchUpCards(broken, { user: ada, settings: on, deps: deps() }), { added: 0 });
});

// ── The route and the demo ──

test('the route reads the signed-in person\'s cards and nothing the request names', () => {
  const routes = read('src/routes/conversations.js');
  const start = routes.indexOf("router.get('/api/conversations/homeroom-bot/activity'");
  assert.ok(start > -1, 'the route exists');
  assert.ok(start < routes.indexOf("router.get('/api/conversations/:id',"), 'and is declared before the id routes');
  const body = routes.slice(start, routes.indexOf('\n  });', start));
  assert.match(body, /activity\.cardsFor\(pool, \{ user: req\.user, config \}\)/);
  assert.match(body, /if \(isDemo\(req\)\) return res\.json\(await activity\.demoCards\(pool, req\.user\)\);/);
  assert.doesNotMatch(body, /req\.(?:params|body)|req\.query\.(?!demo)/, 'no user, conversation or message is read from the request');
  const service = read('src/services/homeroom-bot-activity.js');
  assert.match(service, /WHERE d\.user_id = \$1 AND d\.kind = 'activity'/);
});

test('catching up is a POST of its own, for the signed-in person, naming nothing, from the page only', () => {
  const routes = read('src/routes/conversations.js');
  const start = routes.indexOf("router.post('/api/conversations/homeroom-bot/activity', conversationMessageLimiter, sameOriginBrowserOnly, async (req, res) => {");
  assert.ok(start > -1, 'the route exists, rate-limited and same-origin only');
  assert.ok(start < routes.indexOf("router.post('/api/conversations/:id/"), 'and is declared before the id routes');
  const body = routes.slice(start, routes.indexOf('\n  });', start));
  assert.match(body, /return res\.json\(await activity\.catchUpCards\(pool, \{ user: req\.user \}\)\);/);
  assert.match(body, /if \(isDemo\(req\)\) return res\.json\(await stagingMessages\.ensureDemoUnderWayCard\(pool, req\.user\)\);/);
  assert.doesNotMatch(body, /req\.(?:params|body)|req\.query\.(?!demo)/, 'no user, conversation or message is read from the request');
  // The read stays a read.
  const getStart = routes.indexOf("router.get('/api/conversations/homeroom-bot/activity'");
  assert.doesNotMatch(routes.slice(getStart, routes.indexOf('\n  });', getStart)), /catchUpCards|ensureDemoUnderWayCard/);
});

test('the staging demo has one card being built and one that ended in a proposal, opening nothing', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const demo = activity.demoState({ working: 41, done: 40 }, now);
  const [working, done] = demo.cards;
  assert.equal(working.messageId, 41);
  assert.equal(working.state, 'working');
  assert.deepEqual([working.step, working.of, working.stepName], [3, 6, 'Build it']);
  assert.equal(done.messageId, 40);
  assert.equal(done.outcome, 'proposed');
  for (const card of demo.cards) assert.deepEqual(card.links, { request: null, proposal: null });
  assert.deepEqual(activity.demoState({}, now), { cards: [] }, 'a fixture without its cards has no state to show');
  // And the card opening the demo DM gives work already under way: its plan,
  // begun well before the card, as the tray's demo lists it.
  const [joined] = activity.demoState({ underWay: 42 }, now).cards;
  assert.equal(joined.messageId, 42);
  assert.deepEqual([joined.state, joined.step, joined.of, joined.stepName], ['working', 2, 6, 'Write a plan']);
  assert.equal(joined.startedAt, new Date(now - activity.DEMO_UNDER_WAY.startedMinutesAgo * 60000).toISOString());
  const fixtureSource = read('src/services/staging-messages.js');
  assert.match(fixtureSource, /async function ensureDemoUnderWayCard\(pool, user\) \{\n  if \(process\.env\.USERNODE_ENV !== 'staging' \|\| !user\?\.id\) return \{ added: 0 \};/);
  assert.match(fixtureSource, /idempotency_key: activity\.DEMO_CARD_KEYS\.underWay,/);
  assert.match(fixtureSource, /kind: 'activity', appName: 'Staging demo app', issueNumber, issueTitle, mirrors: true, startedAt,/);
  // The fixture sends its two cards with the keys demoCards finds them by.
  const fixture = read('src/services/staging-messages.js');
  assert.match(fixture, /require\('\.\/homeroom-bot-activity'\)\.DEMO_CARD_KEYS/);
  assert.match(fixture, /key: cardKeys\.done, issueNumber: 9/);
  assert.match(fixture, /key: cardKeys\.working, issueNumber: 14/);
  assert.match(fixture, /kind: 'activity', appName: 'Staging demo app'/);
});

// ── The client ──

test('the client keeps only in-app links, whole steps and known endings, and never reads an unknown state as going', () => {
  const { normalizeBotActivity } = loadTsx(API);
  const cards = normalizeBotActivity({
    cards: [
      {
        messageId: 31, state: 'working', startedAt: 'a', step: 3, of: 6, stepName: 'Build it', doing: 'building it',
        links: { request: '#app/x/dev/issues/3', proposal: 'javascript:alert(1)' }, outcome: 'proposed',
      },
      { messageId: 32, state: 'working', step: 7, of: 6, links: { request: 'https://example.test/x' } },
      { messageId: 33, state: 'done', outcome: 'live', endedAt: 'b', step: 2, of: 6, doing: 'x', links: { proposal: '#app/x/dev/proposals/9' } },
      { messageId: 34, state: 'done', outcome: 'nonsense' },
      { messageId: 35, state: 'paused' },
      { state: 'working' },
    ],
  });
  assert.deepEqual(cards.map((c) => c.messageId), [31, 32, 33, 34, 35], 'a card without a message is dropped');
  assert.deepEqual(cards[0], {
    messageId: 31, state: 'working', startedAt: 'a', links: { request: '#app/x/dev/issues/3', proposal: null },
    step: 3, of: 6, stepName: 'Build it', doing: 'building it', outcome: null, endedAt: null,
  });
  assert.equal(cards[1].step, null, 'step 7 of 6 is not a step');
  assert.equal(cards[1].links.request, null);
  assert.deepEqual([cards[2].state, cards[2].outcome, cards[2].endedAt, cards[2].step, cards[2].doing], ['done', 'live', 'b', null, null]);
  assert.equal(cards[2].links.proposal, '#app/x/dev/proposals/9');
  assert.equal(cards[3].outcome, 'stopped');
  assert.deepEqual([cards[4].state, cards[4].outcome], ['done', 'stopped']);
  assert.deepEqual(normalizeBotActivity(null), []);
});

const NOW = new Date('2026-10-02T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
const META = { kind: 'activity', appSlug: 'ear-trainer', appName: 'Ear Trainer', issueNumber: 12, issueTitle: 'Sort by date', mirrors: true };
const working = (extra = {}) => ({
  messageId: 31, state: 'working', startedAt: minutesAgo(9), links: { request: '#app/ear-trainer/dev/issues/12', proposal: null },
  step: 3, of: 6, stepName: 'Build it', doing: 'building it', outcome: null, endedAt: null, ...extra,
});
const done = (outcome, extra = {}) => ({
  messageId: 31, state: 'done', startedAt: minutesAgo(90), links: { request: '#app/ear-trainer/dev/issues/12', proposal: null },
  step: null, of: null, stepName: null, doing: null, outcome, endedAt: minutesAgo(67), ...extra,
});

function draw(props) {
  const { BotActivityCardView } = loadTsx(CARD);
  return renderToHtml(createElement(BotActivityCardView, { meta: META, loaded: true, now: NOW, ...props }));
}

test('a card going: its step as a ring and in words, what it is doing, how long so far, and its request', () => {
  const html = draw({ card: working() });
  assert.match(html, /^<div class="[^"]*rounded-2xl[^"]*" role="group" aria-label="Homeroom bot activity: Ear Trainer #12: Sort by date" data-bot-activity="working">/);
  assert.match(html, /<svg [^>]*role="img" aria-label="Step 3 of 6: Build it">/);
  assert.match(html, />3\/6<\/text>/);
  assert.match(html, /stroke-dasharray="47\.125 94\.25"/, 'half the ring: step 3 of 6');
  assert.match(html, /data-bot-activity-eyebrow="">Step 3 of 6 · Build it</);
  assert.match(html, /motion-safe:animate-ping/, 'a live dot while it goes');
  assert.match(html, />Ear Trainer #12: Sort by date</);
  assert.match(html, /<span role="status">Building it<\/span><span> · 9m so far<\/span>/,
    'only what it is doing is announced; the clock beside it is not, every half minute');
  assert.match(html, /<a href="#app\/ear-trainer\/dev\/issues\/12" class="[^"]*rounded-full[^"]*" data-bot-activity-link="">Request #12<\/a>/);
  assert.doesNotMatch(html, /Open change/);

  const queued = draw({ card: working({ step: 1, stepName: 'Read the request', doing: 'waiting in the queue (number 3) to be read', startedAt: minutesAgo(75) }) });
  assert.match(queued, /Waiting in the queue \(number 3\) to be read<\/span><span> · 1h 15m so far/);
  const unstepped = draw({ card: working({ step: null, of: null, stepName: null, doing: null }) });
  assert.match(unstepped, /data-bot-activity-eyebrow="">Working on it</);
  assert.doesNotMatch(unstepped, /role="img"/);
  assert.match(unstepped, /<span role="status">Working on it<\/span>/);
});

test('a card done: what it came to, at a glance and in words, how long it took, and where to open it', () => {
  const proposed = draw({ card: done('proposed', { links: { request: '#app/ear-trainer/dev/issues/12', proposal: '#app/ear-trainer/dev/proposals/40' } }) });
  assert.match(proposed, /data-bot-activity="done" data-bot-activity-outcome="proposed"/);
  assert.match(proposed, /data-bot-activity-eyebrow="">Done</);
  assert.match(proposed, /<span role="status">Built it\. Waiting for approval<\/span><span> · took 23m<\/span>/);
  assert.match(proposed, /d="M5 13l4 4L19 7"/, 'a check where the ring was');
  assert.match(proposed, />Open change<\/a><a [^>]*>Request #12<\/a>/, 'the change first');
  assert.doesNotMatch(proposed, /animate-ping|role="img"/);

  const asked = draw({ card: done('question') });
  assert.match(asked, /data-bot-activity-eyebrow="">Needs you</);
  assert.match(asked, /Asked you a question/);
  const failed = draw({ card: done('build_failed', { endedAt: null }) });
  assert.match(failed, /data-bot-activity-eyebrow="">Didn’t finish</);
  assert.match(failed, /<span role="status">Couldn’t finish building it<\/span><\/p>/, 'no "took" without an end');
  assert.match(failed, /bg-red-500\/10 text-red-700 [^"]*dark:text-red-400/);
  assert.match(draw({ card: done('person') }), /data-bot-activity-eyebrow="">Ended</);
  assert.match(draw({ card: done('stopped', { endedAt: null }) }), /Stopped before it finished/);
});

test('a card before its state is read, when the read failed, and when there is none to show', () => {
  const pending = draw({ card: null, loaded: false });
  assert.match(pending, /data-bot-activity="pending"/);
  assert.match(pending, />Ear Trainer #12: Sort by date</, 'the title, from the message itself, at once');
  assert.match(pending, /aria-hidden="true"><\/div><\/div><\/div><\/div>$/, 'and a placeholder line for its state');
  const failed = draw({ card: null, failed: true });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Couldn’t load how far along this is\./);
  assert.match(failed, /<button type="button" class="[^"]*">Try again<\/button>/);
  const none = draw({ card: null, loaded: true });
  assert.match(none, /No progress to show for this one\./);
  assert.doesNotMatch(none, /data-bot-activity-link/);
});

test('every ending has words and a look, and the title is the tray\'s name for the same work', () => {
  const { ACTIVITY_OUTCOME_LABELS, ACTIVITY_OUTCOME_TONES, activityTitle, spanText } = loadTsx(CARD);
  assert.deepEqual(Object.keys(ACTIVITY_OUTCOME_LABELS).sort(), [...activity.OUTCOMES].sort());
  assert.deepEqual(Object.keys(ACTIVITY_OUTCOME_TONES).sort(), [...activity.OUTCOMES].sort());
  assert.equal(activityTitle(META), 'Ear Trainer #12: Sort by date');
  assert.equal(activityTitle({ kind: 'activity', appName: 'Ear Trainer', issueNumber: 1, firstVersion: true }), 'Ear Trainer first version');
  assert.equal(activityTitle({ kind: 'activity', appSlug: 'notes', issueNumber: 3 }), 'notes #3');
  assert.equal(spanText(minutesAgo(0.5), NOW), 'under a minute');
  assert.equal(spanText(minutesAgo(59), NOW), '59m');
  assert.equal(spanText(minutesAgo(60), NOW), '1h');
  assert.equal(spanText(minutesAgo(60 * 26 + 5), NOW), '1d 2h');
  assert.equal(spanText(minutesAgo(-5), NOW), 'under a minute', 'a clock ahead of the server never reads negative');
  assert.equal(spanText(null, NOW), null);
});

test('the row draws a bot\'s activity message as the card, in place of its words', () => {
  const { isActivityMessage } = loadTsx(CARD);
  const message = (extra) => ({
    id: 31, sender: { id: 1, username: 'homeroom_bot', bot: true }, content: 'words', metadata: { homeroomBot: META }, ...extra,
  });
  assert.equal(isActivityMessage(message()), true);
  assert.equal(isActivityMessage(message({ sender: { id: 2, username: 'ada' } })), false, 'only the bot\'s');
  assert.equal(isActivityMessage(message({ metadata: { homeroomBot: { ...META, kind: 'spec' } } })), false);
  assert.equal(isActivityMessage(message({ deleted: true })), false);
  const row = read('frontend/src/features/messages/message-row.tsx');
  // #3770: handed the words a message is drawn with, for a card with nothing on record.
  assert.match(row, /const words = message\.content\s*\? <MessageMarkdown content=\{message\.content\} channels=\{channels\} appSlug=\{botMeta\(message\)\?\.appSlug\} \/>\s*: null;/);
  // B5: led by the bot's hello, on the first card it sends somebody.
  // B6: then a plan and two questions at once, which stand in place of their words too.
  assert.match(row, /\) : isActivityMessage\(message\) \? \([\s\S]{0,600}homeroomBot\?\.hello \? <p className="messages-bot-hello">[\s\S]{0,120}<BotActivityCard message=\{message\} words=\{words\} \/>\s*<\/>\s*\) : isPlanMessage\(message\) \? \(/);
  assert.match(row, /<BotPlanCard message=\{message\} conversationId=\{conversationId\} \/>\s*\) : isTwoQuestions\(message\) \? \(\s*<BotTwoQuestions message=\{message\} conversationId=\{conversationId\} \/>\s*\) : words\}/);
});

// ── #3770: an older card keeps its words ──

/** What a landed read returned: a card on each of `ids`. The third read asked for. */
const landedWith = (ids, extra = {}) => ({
  cards: new Map(ids.map((id) => [id, done('proposed', { messageId: id })])), loaded: true, failed: false, landed: 3, ...extra,
});

test('what the reads say of a card: its state, nothing from a read that knew of it, or not yet', () => {
  const { cardRecord } = loadTsx(STORE);
  assert.equal(cardRecord({ cards: new Map(), loaded: false, failed: false, landed: 0 }, 31, 0), 'pending', 'before the first read lands');
  assert.equal(cardRecord({ cards: new Map(), loaded: false, failed: true, landed: 0 }, 31, 0), 'failed');
  assert.equal(cardRecord(landedWith([40, 41]), 41, 3), 'record');
  assert.equal(cardRecord(landedWith([40, 41]), 31, 3), 'none', 'older than a card the server answered for: past its newest');
  assert.equal(cardRecord(landedWith([40, 41], { failed: true }), 31, 3), 'none', 'a failed refresh does not bring it back');
  assert.equal(cardRecord(landedWith([40, 41]), 45, 3), 'pending',
    'newer than every card the last read answered for: the bot has just sent it, and its news is being read');
  assert.equal(cardRecord(landedWith([40, 41], { failed: true }), 45, 3), 'failed');
  assert.equal(cardRecord(landedWith([40, 41]), 45, 2), 'none', 'a read asked for after it was drawn had nothing for it');
  assert.equal(cardRecord(landedWith([]), 45, 3), 'pending');
  assert.equal(cardRecord(landedWith([]), 45, 2), 'none');
});

test('an older card the server keeps no state for draws its message\'s words; one not read yet stays the card', () => {
  const { cardRecord } = loadTsx(STORE);
  let snapshot = null;
  let drawnAt = 3;
  const { BotActivityCard } = loadTsx(CARD, {
    stubs: {
      './bot-activity-store': {
        cardRecord,
        readsAsked: () => drawnAt,
        useBotActivity: () => snapshot,
        ensureBotActivity() {},
        loadBotActivity() {},
        useBotActivitySync() {},
      },
    },
  });
  const draw = (snap, { at = 3, content = 'I’m looking at **Ear Trainer #12** now.' } = {}) => {
    snapshot = snap;
    drawnAt = at;
    const message = { id: 31, sender: { id: 1, username: 'homeroom_bot', bot: true }, content, metadata: { homeroomBot: META } };
    // The row hands the card the words it draws any message with (message-row.tsx).
    const words = content ? createElement('div', { className: 'messages-markdown' }, content) : null;
    return renderToHtml(createElement(BotActivityCard, { message, words }));
  };
  assert.equal(draw(landedWith([40])), '<div class="messages-markdown">I’m looking at **Ear Trainer #12** now.</div>',
    'the words, and no "No progress to show"');
  const loading = draw({ cards: new Map(), loaded: false, failed: false, landed: 0 }, { at: 0 });
  assert.match(loading, /data-bot-activity="pending"/, 'the first read in flight: the card, waiting');
  assert.doesNotMatch(loading, /messages-markdown|No progress/);
  const fresh = draw(landedWith([30]));
  assert.match(fresh, /data-bot-activity="pending"/, 'just sent, newer than the last read: still the card');
  assert.doesNotMatch(fresh, /messages-markdown|No progress/);
  assert.match(draw(landedWith([31])), /data-bot-activity="done" data-bot-activity-outcome="proposed"/, 'one on record is the card');
  assert.match(draw(landedWith([40]), { content: '' }), /No progress to show for this one\./, 'with no words to keep, it says so');
  assert.match(draw(landedWith([30], { failed: true })), /Couldn’t load how far along this is\./);
});

test('only the bot\'s DM keeps the cards current, beside its tray', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /\{botDm \? <BotWorkSync [^\n]*\n[^\n]*\n\s*\{botDm \? <BotActivitySync conversationId=\{conversationId\} newsKey=\{newestBotMessageId\(snap\.messages\)\} \/> : null\}/);
});

test('the staging preview\'s declared check finds the card being built in the demo DM, beside the tray, and the card opening it gave work under way', () => {
  const check = JSON.parse(read('dapp.json')).tests.find((t) => t.id === 'homeroom-bot-dm-activity-tray');
  assert.equal(check.path, '/?demo=1#messages/910005');
  // A step ring is drawn only while a card's work goes, and the panel (which
  // leads its tiles with the same ring) is not drawn while it is closed, as
  // the check requires: a ring here is a card in the transcript.
  assert.match(check.expectSelector, /\.messages-thread-pane:has\(\[aria-label="Step 3 of 6: Build it"\]\)/);
  assert.match(check.expectSelector, /:has\(\[aria-label="Step 2 of 6: Write a plan"\]\) > \.messages-thread-header /);
  assert.ok(check.expectSelector.length <= 256, 'within what the runner reads');
  assert.equal(check.expectText, 'Working on 3', 'the tray counts the work the new card follows');
  for (const file of ['src/services/homeroom-bot-activity.js', 'src/services/staging-messages.js', 'src/routes/conversations.js']) {
    assert.ok(check.impact.includes(file), file);
  }
});

// ── Kept current: the loop's announcement and the bot's news ──

/** A React small enough to step through: the three hooks the store uses, effects included. */
function createFakeReact() {
  const slots = [];
  let cursor = 0;
  let renderFn = null;
  let effects = [];
  const changed = (prev, next) => !prev || !next || prev.length !== next.length || prev.some((v, i) => !Object.is(v, next[i]));
  const slot = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = init();
    return slots[i];
  };
  function render() {
    cursor = 0;
    effects = [];
    renderFn();
    for (const run of effects) run();
  }
  const React = {
    useRef: (current) => slot(() => ({ current })),
    useEffect(effect, deps) {
      const s = slot(() => ({ fresh: true, deps: undefined, cleanup: undefined }));
      if (!s.fresh && !changed(s.deps, deps)) return;
      s.fresh = false;
      s.deps = deps;
      effects.push(() => {
        if (typeof s.cleanup === 'function') s.cleanup();
        s.cleanup = effect();
      });
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      slot(() => ({ unsubscribe: subscribe(() => render()) }));
      return getSnapshot();
    },
  };
  return {
    React,
    mount(fn) { renderFn = fn; render(); },
    render,
    unmount() { for (const s of slots) if (s && typeof s.cleanup === 'function') s.cleanup(); },
  };
}

function loadStore(t, { responses, catchUps = [] }) {
  const saved = ['window', 'document'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const win = new EventTarget();
  const timers = new Map();
  let timerId = 0;
  win.setInterval = (fn, ms) => { timerId += 1; timers.set(timerId, { fn, ms }); return timerId; };
  win.clearInterval = (id) => { timers.delete(id); };
  globalThis.window = win;
  globalThis.document = { visibilityState: 'visible' };
  const reads = [];
  const asked = [];
  const events = [];
  const api = {
    getHomeroomBotActivity(options) {
      reads.push(options);
      const next = responses.shift();
      return typeof next === 'function' ? next() : Promise.resolve(next || []);
    },
    catchUpHomeroomBotActivity() {
      asked.push(true);
      const next = catchUps.shift();
      return typeof next === 'function' ? next() : Promise.resolve(next || 0);
    },
  };
  const fake = createFakeReact();
  const store = loadTsx(STORE, {
    stubs: {
      react: fake.React,
      './api': api,
      './bot-work': { WORK_CHANGED_EVENT: 'homeroom-bot-work-changed' },
      './store': { handleEvent(event) { events.push(event); } },
    },
  });
  return { store, fake, reads, timers, win, asked, events };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the store reads again when the loop announces work for the viewer, and when the bot\'s news lands', async (t) => {
  const { WORK_CHANGED_EVENT } = loadTsx('frontend/src/features/messages/bot-work.tsx');
  assert.equal(WORK_CHANGED_EVENT, 'homeroom-bot-work-changed', 'the window event app.js turns homeroom_bot_work_changed into');

  const reading = { messageId: 31, state: 'working', step: 1, of: 6, doing: 'reading the request', links: {} };
  const building = { ...reading, step: 3, doing: 'building it' };
  const ended = { messageId: 31, state: 'done', outcome: 'proposed', links: {} };
  const { store, fake, reads, timers, win } = loadStore(t, { responses: [[reading], [building], [ended]] });
  let newsKey = 50;
  fake.mount(() => store.useBotActivitySync(5, newsKey));
  await settle();
  assert.deepEqual(reads, [{ fresh: false }], 'opening the DM reads once; its first news is what was there');
  assert.equal(store.getBotActivity().cards.get(31).step, 1);
  assert.equal(timers.size, 1, 'a card going is asked about now and then');

  // The live loop started or ended a piece of work for this person.
  win.dispatchEvent(new Event('homeroom-bot-work-changed'));
  await settle();
  assert.deepEqual(reads, [{ fresh: false }, { fresh: true }], 'a re-read, past the worker\'s offline copy');
  assert.equal(store.getBotActivity().cards.get(31).doing, 'building it');

  // The bot's news landed in the DM.
  newsKey = 51;
  fake.render();
  await settle();
  assert.equal(reads.length, 3);
  assert.equal(store.getBotActivity().cards.get(31).outcome, 'proposed');
  assert.equal(timers.size, 0, 'nothing going: no more asking');

  fake.unmount();
  win.dispatchEvent(new Event('homeroom-bot-work-changed'));
  await settle();
  assert.equal(reads.length, 3, 'leaving the DM stops listening');
});

test('only the newest read lands, a failed one keeps what was read, and a card drawn first reads once', async (t) => {
  let release;
  const slow = () => new Promise((resolve) => { release = () => resolve([{ messageId: 31, state: 'working', links: {} }]); });
  const { store, reads } = loadStore(t, {
    responses: [slow, [{ messageId: 31, state: 'done', outcome: 'question', links: {} }], () => Promise.reject(new Error('offline'))],
  });
  store.ensureBotActivity();
  store.ensureBotActivity();
  assert.equal(reads.length, 1, 'cards drawn before any read ask once between them');
  const newer = store.loadBotActivity();
  await newer;
  assert.equal(store.getBotActivity().cards.get(31).outcome, 'question');
  release();
  await settle();
  assert.equal(store.getBotActivity().cards.get(31).outcome, 'question', 'the older read, landing late, is dropped');
  await store.loadBotActivity();
  assert.equal(store.getBotActivity().failed, true);
  assert.equal(store.getBotActivity().cards.get(31).outcome, 'question', 'what was read before stays');
  store.ensureBotActivity();
  assert.equal(reads.length, 3, 'already read: nothing more to ensure');
});

test('opening the DM asks once for the cards work under way is missing; one added re-reads the transcript and the cards', async (t) => {
  const joined = { messageId: 60, state: 'working', step: 2, of: 6, doing: 'writing the plan for the build', links: {} };
  const { store, fake, reads, asked, events } = loadStore(t, {
    responses: [[], [joined], []],
    catchUps: [1, 0, () => Promise.reject(new Error('offline'))],
  });
  let conversationId = 5;
  let newsKey = 50;
  fake.mount(() => store.useBotActivitySync(conversationId, newsKey));
  await settle();
  assert.equal(asked.length, 1, 'asked once, as the DM opens');
  assert.deepEqual(events, [{ type: 'conversation_message_created', conversationId: 5 }],
    'the new card is read into the transcript as the bot\'s news is, whether or not the socket said so');
  assert.deepEqual(reads, [{ fresh: false }, { fresh: true }], 'and the cards read again, past the offline copy');
  assert.equal(store.getBotActivity().cards.get(60).step, 2);

  // The card landing in the transcript is news like any other; nothing asks again.
  newsKey = 60;
  fake.render();
  await settle();
  assert.equal(asked.length, 1);

  // Another conversation asks again; nothing added means nothing more to read.
  conversationId = 6;
  fake.render();
  await settle();
  assert.equal(asked.length, 2);
  assert.equal(events.length, 1);
  assert.equal(reads.length, 4, 'the news re-read, then only the read every opening makes');

  // A failed ask costs nothing.
  conversationId = 7;
  fake.render();
  await settle();
  assert.equal(asked.length, 3);
  assert.equal(events.length, 1);
  fake.unmount();
});

test('#3770: what was read says which read it was, so a card knows whether one was asked for after it was drawn', async (t) => {
  const { store } = loadStore(t, {
    responses: [[{ messageId: 40, state: 'done', outcome: 'live', links: {} }], () => Promise.reject(new Error('offline'))],
  });
  assert.deepEqual([store.readsAsked(), store.getBotActivity().landed], [0, 0]);
  await store.loadBotActivity();
  assert.deepEqual([store.readsAsked(), store.getBotActivity().landed], [1, 1]);
  await store.loadBotActivity();
  assert.deepEqual([store.readsAsked(), store.getBotActivity().landed, store.getBotActivity().failed], [2, 1, true],
    'a failed read leaves the one that landed');
});

test('#3767: a request filed in the DM gets its card at once, and the card says it was filed', () => {
  const ctx = { appName: 'Ear Trainer', issueNumber: 13, issueTitle: 'Use MIDI', firstVersion: false };
  assert.equal(activity.cardText(ctx, dmSvc, { filed: true }), '**Ear Trainer** · request #13: Use MIDI\n\nFiled. This card follows it from here.');
  assert.match(activity.cardText(ctx, dmSvc), /I'm working on this now\. This card updates as I go\.$/);
});
