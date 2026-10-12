// The Homeroom bot console and get_homeroom_bot say why queued requests
// wait, count the queue from the same snapshot they list, show a run a cap
// holds, count the move offers, and label the mode and the voice's week.
//
// type-racer-battle-1c07b0's requests #2, #5 and #6 waited from 10 October
// with `waiting: null`, next in line by every account, while the project's
// first version was still up for a vote: liveCandidates passed over them in
// silence. The queue's count (every row not running) and its list (the first
// 12 rows, running first) came from two queries and described two sets.
//
// These pin, without a database: queueWait's reasons and their order; the
// one-statement snapshot and what it derives from it; the connector's shape;
// the console's words; the move offers' record and summary; the
// configuration comparison leaving platform failures out on both sides; and
// the interruption incident's words for a kept plan.
//
// Run with: node --test tests/homeroom-bot-queue-waits.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const move = require('../src/services/homeroom-bot-move');
const data = require('../src/services/bench/connector-data');
const botConfigs = require('../src/services/bot-configs');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const LATER = '2026-10-12T12:10:00.000Z';

test('queueWait: every reason the loop passes a row over for, in the order it meets them', () => {
  const w = (row, ctx = {}) => bot.queueWait({ app_id: 9, issue_number: 5, ...row }, { now: NOW, ...ctx });
  // The three it said before, first, unchanged.
  assert.deepEqual(w({ wait_reason: 'session_busy', wait_until: LATER, app_paused: true }), { reason: 'session_busy', until: LATER });
  assert.deepEqual(w({ held_until: LATER, first_version_pending: true }), { reason: 'allowance', until: LATER });
  assert.deepEqual(w({}, { fault: { until: Date.parse(LATER) }, off: true }), { reason: 'platform_fault', until: LATER });
  // The bot off, or paused on its spent budget until its next pass.
  assert.deepEqual(w({ app_paused: true }, { off: true }), { reason: 'bot_paused', until: null });
  assert.deepEqual(w({ app_paused: true }, { budgetUntil: Date.parse(LATER) }), { reason: 'bot_paused', until: LATER });
  assert.equal(w({}, { budgetUntil: NOW - 1 }), null, 'a budget pause that is over is none');
  assert.deepEqual(w({ app_paused: true, first_version_pending: true }), { reason: 'app_paused', until: null });
  // The project's first version is not live: named, with its request.
  assert.deepEqual(w({ first_version_pending: true, first_version_issue: 1, build_pending: true }),
    { reason: 'first_version_pending', until: null, firstVersionIssue: 1 });
  assert.deepEqual(w({ first_version_pending: true, first_version_issue: null }),
    { reason: 'first_version_pending', until: null, firstVersionIssue: null }, 'not filed yet');
  assert.equal(w({ first_version_pending: true, reason: 'admin' }), null, 'an admin\'s Run now is not held');
  assert.equal(w({ first_version_pending: true, follow_up_session_id: 40 }), null, 'nor a follow-up');
  assert.deepEqual(w({ build_pending: true }), { reason: 'build_pending', until: null });
  // Its app's session taken, or the app backed off until a time.
  const busyApps = new Map([[9, null]]);
  assert.deepEqual(w({}, { busyApps }), { reason: 'session_busy', until: null });
  assert.deepEqual(w({}, { busyApps: new Map([[9, Date.parse(LATER)]]) }), { reason: 'session_busy', until: LATER });
  assert.equal(w({ follow_up_session_id: 40 }, { busyApps }), null, 'a follow-up runs on its proposal\'s session');
  // Its person already has their share running.
  const personCounts = new Map([['u7', 3]]);
  assert.deepEqual(w({ person_id: 7 }, { personCounts, perPerson: 3 }), { reason: 'per_person', until: null });
  assert.equal(w({ person_id: 7 }, { personCounts, perPerson: 4 }), null);
  assert.deepEqual(w({ person_id: null }, { personCounts: new Map([['a9', 1]]), perPerson: 1 }),
    { reason: 'per_person', until: null }, 'nobody known: the app is its person, as pickLive counts');
  // A person still writing: read 20 seconds after their last word.
  assert.deepEqual(w({ settle_from: new Date(NOW - 5000).toISOString() }),
    { reason: 'settling', until: new Date(NOW + 15000).toISOString() });
  assert.equal(w({ settle_from: new Date(NOW - 25000).toISOString() }), null);
  assert.equal(w({ started_at: '2026-10-12T11:00:00Z', app_paused: true }, { off: true }), null, 'a running row waits for nothing');
});

test('queueSnapshot: the counts and the rows listed come from one statement, and what it derives from them', async () => {
  bot._resetForTests();
  const calls = [];
  const rows = [
    { id: 1, app_id: 9, issue_number: 3, started_at: '2026-10-12T11:59:00Z', person_id: 7, follow_up_session_id: null, waiting_total: 4, running_total: 1 },
    { id: 2, app_id: 9, issue_number: 4, started_at: null, person_id: 8, waiting_total: 4, running_total: 1 },
    { id: 3, app_id: 10, issue_number: 2, started_at: null, person_id: 7, first_version_pending: true, first_version_issue: 1, waiting_total: 4, running_total: 1 },
    { id: 4, app_id: 11, issue_number: 6, started_at: null, person_id: 7, waiting_total: 4, running_total: 1 },
  ];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rows }; } };
  const q = await bot.queueSnapshot(pool, { mode: 'shadow', pausedApps: ['quiet-app'], perPerson: 1 }, { botId: 77, now: NOW });
  assert.equal(calls.length, 1, 'one statement, so one snapshot');
  assert.match(calls[0].sql, /COUNT\(\*\) FILTER \(WHERE q\.started_at IS NULL\) OVER \(\)::int AS waiting_total/);
  assert.match(calls[0].sql, /COUNT\(\*\) FILTER \(WHERE q\.started_at IS NOT NULL\) OVER \(\)::int AS running_total/);
  assert.match(calls[0].sql, /WHERE \(q\.started_at IS NULL AND q\.rn <= \$5\) OR \(q\.started_at IS NOT NULL AND q\.rn <= \$6\)/);
  assert.deepEqual(calls[0].params, [['quiet-app'], 7, 20, 77, 12, 40]);
  assert.equal(q.depth, 4);
  assert.equal(q.running, 1);
  assert.equal(q.listedRunning, 1);
  assert.equal(q.listedWaiting, 3);
  assert.ok(q.items.every((i) => !('waiting_total' in i) && !('running_total' in i)));
  assert.deepEqual(q.items.map((i) => i.waiting && i.waiting.reason), [
    undefined, 'session_busy', 'first_version_pending', 'per_person',
  ].map((r) => r || null));
  // The bot off: everything waiting says so.
  const off = await bot.queueSnapshot(pool, { mode: 'off' }, { now: NOW });
  assert.deepEqual(off.items.slice(1).map((i) => i.waiting.reason), ['bot_paused', 'bot_paused', 'bot_paused']);
  const empty = await bot.queueSnapshot({ query: async () => ({ rows: [] }) }, {}, { now: NOW });
  assert.deepEqual(empty, { depth: 0, running: 0, items: [], listedWaiting: 0, listedRunning: 0 });

  // The snapshot reads the rules liveCandidates applies, from the same constants.
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /const queue = await queueSnapshot\(pool, settings, \{ botId: botRow\?\.id \?\? null \}\);/);
  assert.match(src, /queue: \{ \.\.\.queue, buildsWaiting: builds\.waiting \},/);
  assert.doesNotMatch(src, /SELECT COUNT\(\*\)::int AS depth FROM homeroom_bot_queue/, 'no second count of another set');
  const snap = src.slice(src.indexOf('const QUEUE_SNAPSHOT_SQL'), src.indexOf('async function queueSnapshot'));
  assert.match(snap, /AND \$\{FIRST_VERSION_PENDING_SQL\}/);
  assert.match(snap, /b\.created_at > NOW\(\) - make_interval\(days => \$2\)/);
  assert.match(snap, /m\.created_at > NOW\(\) - make_interval\(secs => \$3\)/);
});

test('get_homeroom_bot: the queue, a held run, the mode, the week and the move offers', async () => {
  const fake = {
    adminPayload: async () => ({
      settings: { mode: 'shadow' }, bot: null, totals: { days: 7 },
      caps: { proposalsPerApp: 5, proposalsTotal: 40, questionsPerAppPerDay: 10 },
      queue: {
        depth: 15, running: 1, listedWaiting: 12, listedRunning: 1,
        items: [
          { app_slug: 'type-racer-battle-1c07b0', issue_number: 5, reason: 'new', enqueued_at: '2026-10-10T10:00:00Z',
            waiting: { reason: 'first_version_pending', until: null, firstVersionIssue: 1 } },
          { app_slug: 'notes', issue_number: 9, reason: 'thread', enqueued_at: '2026-10-12T11:59:50Z',
            waiting: { reason: 'settling', until: '2026-10-12T12:00:10Z' } },
        ],
      },
      runs: [
        { id: 900, app_slug: 'notes', issue_number: 4, mode: 'live', verdict: 'ready', cap_suppressed: 'proposals_per_app' },
        { id: 899, app_slug: 'notes', issue_number: 3, mode: 'live', verdict: 'question', cap_suppressed: 'question_tripwire' },
        { id: 898, app_slug: 'notes', issue_number: 2, mode: 'live', verdict: 'ready', build_queued_at: '2026-10-12T11:00:00Z' },
      ],
      dmChat: { turns: 3, failed: 0, recovered: 0, people: 2, costUsd: 0.1 },
      voice: { turns: 4, replied: 4 },
      moveOffers: {
        days: 7, sent: 3, moved: 1, kept: 1, open: 1, failed: 0, notOffered: 2,
        notOfferedByWhy: { no_bot: 1, repeat_held: 1, something_else: 4 },
        notOfferedRecent: [{ runId: 12, app: 'notes', issueNumber: 7, why: 'no_bot', at: '2026-10-11T10:00:00Z' }],
      },
    }),
  };
  const out = await data.botOverview(null, {}, {}, { bot: fake, weekStartUtc: () => new Date('2026-10-12T00:00:00Z') });
  assert.equal(out.settings.mode, 'shadow', 'the stored value stays');
  assert.equal(out.settings.modeLabel, 'on');
  assert.equal(data.modeLabelOf('off'), 'off');
  assert.equal(data.modeLabelOf(null), null);
  assert.equal(out.queue.depth, 15);
  assert.equal(out.queue.running, 1);
  assert.equal(out.queue.listedWaiting, 12);
  assert.deepEqual(out.queue.items[0].waiting, { reason: 'first_version_pending', until: null, firstVersionIssue: 1 });
  assert.deepEqual(out.queue.items[1].waiting, { reason: 'settling', until: '2026-10-12T12:00:10.000Z' });
  // A held ready verdict has a build state and says why.
  assert.deepEqual(out.runs[0].build, {
    state: 'held', ok: undefined, branch: null, sha: null, commits: null, error: null, at: null, queuedAt: null,
  });
  assert.deepEqual(out.runs[0].held, { cap: 'proposals_per_app', limit: 5, why: 'held: 5 proposals open on this app' });
  assert.deepEqual(out.runs[1].held, { cap: 'question_tripwire', limit: 10, why: 'held: 10 questions asked on this app today' });
  assert.equal(out.runs[1].build, null, 'a held question has no build');
  assert.equal(out.runs[2].held, null);
  assert.equal(out.runs[2].build.state, 'queued', 'a build under way is not read as held');
  assert.deepEqual(data.heldOf('not_a_cap', {}), { cap: null, limit: null, why: 'held by a cap' });
  // Week-to-date, said so; the totals are 7 days.
  assert.equal(out.dmChat.period, 'this_week');
  assert.equal(out.dmChat.since, '2026-10-12T00:00:00.000Z');
  assert.equal(out.voice.period, 'this_week');
  assert.equal(out.voice.turns, 4);
  // The move offers: codes and counts only.
  assert.deepEqual(out.moveOffers.notOfferedByWhy, { no_bot: 1, repeat_held: 1 });
  assert.deepEqual(out.moveOffers.notOfferedRecent, [{ runId: 12, app: 'notes', issueNumber: 7, why: 'no_bot', at: '2026-10-11T10:00:00.000Z' }]);
  assert.equal(out.moveOffers.sent, 3);
  assert.equal(out.moveOffers.moved, 1);
  assert.equal(out.moveOffers.kept, 1);

  const tools = read('src/services/mcp-tools.js');
  assert.match(tools, /moveOffers: b\.moveOffers \|\| null,/);
  assert.match(tools, /depth: sNum\(b\.queue\?\.depth\), running: sNum\(b\.queue\?\.running\),/);
  assert.match(tools, /first_version_pending for its project\\'s first version not live yet/);
});

function loadBotSection() {
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx } = require('./lib/render-tsx');
  return loadTsx('frontend/src/features/admin/admin-homeroom-bot.tsx', {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, {
          get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)),
        }),
      },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
}

test('the console says why each row waits, counts waiting and running alike, and says what a cap held', () => {
  const { waitLine, queueCountLine, queueMoreLine, heldLine, moveOffersLine } = loadBotSection();
  assert.equal(waitLine({ reason: 'first_version_pending', until: null, firstVersionIssue: 1 }),
    'waiting: the project\'s first version (#1) is not live yet');
  assert.equal(waitLine({ reason: 'first_version_pending', until: null }), 'waiting: the project\'s first version is not live yet');
  assert.equal(waitLine({ reason: 'per_person', until: null }), 'waiting: its person already has as much running as they may');
  assert.equal(waitLine({ reason: 'build_pending', until: null }), 'waiting: a build of this request is waiting or under way');
  assert.equal(waitLine({ reason: 'app_paused', until: null }), 'waiting: its app is paused');
  assert.equal(waitLine({ reason: 'bot_paused', until: null }), 'waiting: the bot is off or its weekly budget is spent');
  assert.equal(waitLine({ reason: 'session_busy', until: null }), 'waiting: a turn is running on its session');
  assert.match(waitLine({ reason: 'settling', until: LATER }), /^waiting: somebody is still writing on it, until \S/);

  const queue = { depth: 15, running: 2, items: [], listedWaiting: 12, listedRunning: 2 };
  assert.equal(queueCountLine(queue), '15 waiting, 2 running');
  assert.equal(queueMoreLine(queue), 'Showing the first 12 of 15 waiting, in the order they are read.');
  assert.equal(queueMoreLine({ ...queue, depth: 12 }), '');
  assert.equal(queueCountLine(null), '');

  const caps = { proposalsPerApp: 5, proposalsTotal: 40, questionsPerAppPerDay: 10 };
  assert.equal(heldLine('proposals_per_app', caps), 'held: 5 proposals open on this app');
  assert.equal(heldLine('proposals_total', caps), 'held: the bot\'s ceiling of 40 proposals open across Homeroom');
  assert.equal(heldLine('question_tripwire', caps), 'held: 10 questions asked on this app today');
  assert.equal(heldLine(null, caps), '');
  // The console and the connector say a hold alike.
  for (const cap of ['proposals_per_app', 'proposals_total', 'question_tripwire']) {
    assert.equal(heldLine(cap, caps), data.heldOf(cap, caps).why, cap);
  }

  assert.equal(moveOffersLine(null), '');
  assert.equal(moveOffersLine({ days: 7, sent: 0, moved: 0, kept: 0, open: 0, failed: 0, notOffered: 0, notOfferedByWhy: {} }), '');
  assert.equal(
    moveOffersLine({ days: 7, sent: 3, moved: 1, kept: 1, open: 1, failed: 0, notOffered: 2, notOfferedByWhy: { no_bot: 1, repeat_held: 1 } }),
    '3 offers to move a request to Homeroom in the last 7 days (1 moved, 1 kept, 1 not answered yet); 2 about Homeroom with no offer (1 its requester does not have the bot, 1 the note was not repeated).',
  );

  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /id="admin-homeroom-bot-queue-depth">\s*\{queueCountLine\(payload\?\.queue\)\}/);
  assert.match(tsx, /id="admin-homeroom-bot-queue-more"/);
  assert.match(tsx, /id="admin-homeroom-bot-move-offers">\{movesLine\}/);
  assert.match(tsx, /<span data-run-held=\{run\.cap_suppressed\}>\{heldLine\(run\.cap_suppressed, payload\?\.caps\)\}<\/span>/);
  assert.doesNotMatch(tsx, /would be held/, 'the caps act now');
});

test('a move offer records what became of it on the run, and the week counts them', async () => {
  assert.deepEqual([...move.MOVE_OFFER_OUTCOMES], ['sent', 'no_requester', 'no_bot', 'repeat_held', 'already_offered', 'not_sent']);
  const writes = [];
  const pool = { async query(sql, params) { writes.push({ sql, params }); return { rows: [] }; } };
  await move.noteMoveOffer(pool, 41, 'no_bot');
  await move.noteMoveOffer(pool, null, 'no_bot');
  await move.noteMoveOffer(pool, 41, 'whatever');
  assert.equal(writes.length, 1, 'only a known outcome on a real run');
  assert.match(writes[0].sql, /UPDATE homeroom_bot_runs SET move_offer = \$2 WHERE id = \$1 AND about_platform/);
  assert.deepEqual(writes[0].params, [41, 'no_bot']);
  await move.noteMoveOffer({ query: async () => { throw new Error('down'); } }, 41, 'sent');

  const summaryPool = {
    async query(sql) {
      if (/FROM homeroom_bot_dm_actions\s+WHERE kind = 'move_request'/.test(sql)) {
        return { rows: [{ sent: 4, moved: 2, kept: 1, open: 1, failed: 0 }] };
      }
      return { rows: [
        { id: 30, issue_number: 6, created_at: '2026-10-11T10:00:00Z', app_slug: 'notes', why: 'no_bot' },
        { id: 29, issue_number: 5, created_at: '2026-10-10T10:00:00Z', app_slug: 'notes', why: 'unrecorded' },
        { id: 28, issue_number: 4, created_at: '2026-10-09T10:00:00Z', app_slug: 'todo', why: 'no_bot' },
      ] };
    },
  };
  const m = await move.moveOfferSummary(summaryPool);
  assert.equal(m.days, 7);
  assert.deepEqual({ sent: m.sent, moved: m.moved, kept: m.kept, open: m.open }, { sent: 4, moved: 2, kept: 1, open: 1 });
  assert.equal(m.notOffered, 3);
  assert.deepEqual(m.notOfferedByWhy, { no_bot: 2, unrecorded: 1 });
  assert.deepEqual(m.notOfferedRecent[0], { runId: 30, app: 'notes', issueNumber: 6, why: 'no_bot', at: '2026-10-11T10:00:00.000Z' });

  // Each gate records its outcome where it decides.
  const dm = read('src/services/homeroom-bot-dm.js');
  assert.match(dm, /await noteMove\(requester \? 'no_bot' : 'no_requester'\);/);
  assert.match(dm, /await noteMove\('not_sent'\);/);
  assert.match(dm, /reason: dm\.reason, runId,\n/);
  const src = read('src/services/homeroom-bot-move.js');
  assert.match(src, /await noteMoveOffer\(pool, runId, 'already_offered'\);/);
  // One story: the offer is folded into the verdict's message (foldOffer), and
  // recorded as sent once that message is (foldedOfferSent).
  assert.match(src, /if \(offer\.kind === 'move_request'\) await noteMoveOffer\(pool, offer\.runId, 'sent'\);/);
  assert.match(read('src/services/homeroom-bot.js'),
    /acted = 'unaddressed';\n\s+\/\/ [^\n]+\n\s+if \(parsed\.verdict === 'person' && parsed\.platform\) \{\n\s+await require\('\.\/homeroom-bot-move'\)\.noteMoveOffer\(pool, runId, 'repeat_held'\);/);
  assert.match(read('src/db/schema.sql'), /ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS move_offer TEXT;/);
});

test('configuration comparison: the platform\'s failures are left out of the build rate on both sides alike', () => {
  const f = botConfigs.platformFailureOf;
  // A side build the platform failed (recorded skipped) and a live build a
  // restart failed are the platform's; a build that failed on its own is not.
  assert.equal(f({ status: 'skipped', built: false, error: 'the platform failed the side build: no worker' }), true);
  assert.equal(f({ status: 'skipped', built: false, error: 'capped: its run had spent $5.00 of its $5.00 cap' }), false);
  assert.equal(f({ status: 'done', built: false, error: 'the build ran past its time limit (finished after a restart)' }), true);
  assert.equal(f({ status: 'done', built: false, error: 'the platform restarted in the middle of each of its last 3 tries at building this' }), true);
  assert.equal(f({ status: 'done', built: false, error: 'the build produced no change to propose' }), false);
  assert.equal(f({ status: 'done', built: true, error: null }), false);

  const src = read('src/services/bot-configs.js');
  assert.match(src, /WHERE \(r\.status = 'done' OR \(r\.status = 'skipped' AND r\.error LIKE 'the platform failed%'\)\) AND v\.scope = \$1/);
  assert.match(src, /const rated = mine\.filter\(\(r\) => !platformFailureOf\(r\)\)\.length;/);
  assert.match(src, /buildRate: rated \? builtN \/ rated : null,/);
  assert.match(src, /platformFailures,/);
  const tsx = read('frontend/src/features/admin/admin-bot-configs.tsx');
  assert.match(tsx, /platform failure\$\{s\.platformFailures === 1 \? '' : 's'\}, left out/);
});

test('an interruption whose plan was kept says it resumed from it', () => {
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /await noteIncident\('resumed', plan\.lost \? what : 'resumed from its saved plan'\);/);
  assert.match(src, /const noteIncident = \(outcome, why = what\) => incidents\(\)\.record\(pool, \{/);
});
