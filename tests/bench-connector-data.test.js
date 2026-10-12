'use strict';

// What a full admin's connector reads of the live Homeroom bot and of the
// recent before/after screenshots (services/bench/connector-data.js): the
// console's own payloads, curated field by field, so a field added to
// either screen later never reaches a connector by accident.

const test = require('node:test');
const assert = require('node:assert/strict');

const data = require('../src/services/bench/connector-data');

test('the bot\'s run filters are checked, and a page is 1 to 50 runs', () => {
  assert.deepEqual(data.botFilters({}), { app: null, before: null, limit: 20, budgetOnly: false, verdict: null });
  assert.deepEqual(data.botFilters({ app: 'Bad Slug!', verdict: 'nope', before: 'x', limit: 500 }), { app: null, before: null, limit: 50, budgetOnly: false, verdict: null });
  assert.deepEqual(data.botFilters({ app: 'bread-bot', verdict: 'budget', before: '41', limit: 0 }), { app: 'bread-bot', before: 41, limit: 20, budgetOnly: true, verdict: null });
  assert.equal(data.botFilters({ verdict: 'question' }).verdict, 'question');
});

test('the bot overview carries the console\'s fields it names, and nothing else', async () => {
  let asked;
  const bot = {
    async adminPayload(_pool, _config, f) {
      asked = f;
      return {
        settings: {
          mode: 'live', audience: 'list', pausedApps: ['quiet'], everyoneSince: '2026-10-09T15:00:00.000Z',
          turnSeconds: 600, concurrency: 2, secretThing: 'never',
        },
        bot: { models: { triage: 'a/b' }, weeklyLimitCents: 5000, weeklySpentCents: 1200, hasIncludedKey: true, apiKey: 'sk-never' },
        defaultModel: 'a/b',
        totals: { question: 2 },
        queue: { depth: 1, items: [{ app_slug: 'bread', issue_number: 3, reason: 'new', enqueued_at: '2026-10-01T00:00:00Z' }] },
        runs: [{
          id: 9, app_slug: 'bread', issue_number: 3, verdict: 'question', question: 'q'.repeat(500), cost_usd: '0.12',
          build_ok: true, build_branch: 'b', build_sha: 'c'.repeat(40), replayStages: ['triage'], created_at: '2026-10-01T00:00:00Z',
          prompt: 'never', user_email: 'never@example.com',
        }],
      };
    },
  };
  const out = await data.botOverview(null, {}, { app: 'bread', limit: 1 }, { bot });
  assert.equal(asked.app, 'bread');
  assert.equal(out.settings.mode, 'live');
  assert.equal(out.settings.secretThing, undefined);
  assert.equal(out.settings.audience, undefined, 'the retired audience is not carried');
  assert.deepEqual(out.settings.pausedApps, ['quiet'], 'what the bot leaves alone, now that every app is live');
  assert.equal(out.settings.everyoneSince, '2026-10-09T15:00:00.000Z');
  assert.equal(out.spend.apiKey, undefined);
  assert.equal(out.runs[0].costUsd, 0.12);
  assert.equal(out.runs[0].question.length, 400, 'a question is clipped');
  assert.equal(out.runs[0].prompt, undefined);
  assert.equal(out.runs[0].user_email, undefined);
  assert.equal(out.runs[0].build.ok, true);
  assert.equal(out.runs[0].build.state, 'built');
  assert.equal(out.runs[0].readReason, null, 'a run from before read reasons');
  assert.equal(out.runs[0].specChars, null, 'a run with no spec has no size');
  assert.equal(out.runs[0].build_spec_md, undefined, 'the size, not the spec itself');
  assert.equal(out.buildLane, null, 'no lane in the payload, none here');
  assert.equal(out.nextBefore, 9, 'a full page names the next one');
  assert.equal(out.queue.items[0].app, 'bread');
});

test('botOverview: a run whose verdict could not be read carries its kept reply, and no other run does', async () => {
  const bot = {
    adminPayload: async () => ({
      settings: {}, runs: [
        { id: 2, verdict: 'failed', error: 'unparseable: Verdict below.', created_at: '2026-10-01T00:00:00Z',
          unreadable_reply: { reply: { text: 'Reading. Verdict below.', chars: 23 }, repair: { text: 'x'.repeat(20_000), chars: 20_000 } } },
        { id: 1, verdict: 'failed', error: 'budget: wall clock', created_at: '2026-10-01T00:00:00Z' },
      ],
    }),
  };
  const out = await data.botOverview(null, {}, {}, { bot });
  assert.deepEqual(out.runs[0].unreadableReply.reply, { text: 'Reading. Verdict below.', chars: 23 });
  assert.equal(out.runs[0].unreadableReply.repair.chars, 20_000);
  assert.ok(out.runs[0].unreadableReply.repair.text.length <= 16 * 1024 + 200, 'bounded however it was stored');
  assert.equal(out.runs[0].error, 'unparseable: Verdict below.');
  assert.equal(out.runs[1].unreadableReply, null);
});

test('a ready verdict that was never built says where it got to and why; a run says what started its read', async () => {
  const run = (over) => ({ id: 9, app_slug: 'bread', issue_number: 3, verdict: 'ready', created_at: '2026-10-01T00:00:00Z', ...over });
  const bot = {
    async adminPayload() {
      return {
        settings: {}, bot: null, totals: {}, queue: { depth: 0, items: [] },
        builds: {
          queued: 2, building: 1, built: 40, failed: 3,
          lane: { at: '2026-10-09T10:00:00Z', started: 0, inFlight: 2, paused: 'budget', detail: 'weekly limit reached' },
          fault: null,
        },
        runs: [
          run({ id: 6, build_error: "skipped: the platform's own repository is left out", read_reason: 'changed:github' }),
          run({ id: 5, build_error: 'superseded: a later verdict on the same issue', read_reason: 'new' }),
          run({ id: 4, build_queued_at: '2026-10-09T09:00:00Z', read_reason: 'retry_failed' }),
          run({ id: 3, build_queued_at: '2026-10-09T09:00:00Z', build_at: '2026-10-09T09:05:00Z', read_reason: 'Not A Reason!' }),
          run({ id: 2, build_ok: false, build_error: 'the build ran past its time limit' }),
          run({ id: 1, verdict: 'person' }),
        ],
      };
    },
  };
  const out = await data.botOverview(null, {}, {}, { bot });
  assert.deepEqual(out.runs.map((r) => r.build && r.build.state), ['not_built', 'superseded', 'queued', 'building', 'failed', null]);
  assert.match(out.runs[0].build.error, /platform's own repository/);
  assert.equal(out.runs[2].build.queuedAt, '2026-10-09T09:00:00.000Z');
  assert.deepEqual(out.runs.map((r) => r.readReason), ['changed:github', 'new', 'retry_failed', null, null, null],
    'fixed-shape reasons only');
  assert.deepEqual(out.buildLane, {
    queued: 2, building: 1,
    lastPass: { at: '2026-10-09T10:00:00Z', started: 0, inFlight: 2, paused: 'budget', detail: 'weekly limit reached' },
    fault: null,
  });
});

test('the voice outside the DM: its switches, its week in counts and codes, and the incidents, never anybody\'s words', async () => {
  const bot = {
    async adminPayload() {
      return {
        settings: { mode: 'live', voiceSession: true, voiceIssue: false },
        bot: null, totals: {}, queue: { depth: 0, items: [] }, runs: [],
        voice: {
          turns: 12, replied: 9, quiet: 2, fallback: 0, failed: 1, people: 5, costUsd: 0.031,
          byPlace: { session: { replied: 6, quiet: 1, failed: 1 }, chat: { replied: 3, quiet: 1, words: 'never' }, governance: { replied: 1 } },
          recentFailures: [{
            at: '2026-10-10T09:00:00.000Z', app: 'bread', place: 'session', ref: 70, outcome: 'failed',
            error: 'no_key', failures: ['v1:rate_limited:429', 'Make the header blue please', 'claims:started'], rounds: 2, text: 'never',
          }],
          asks: {
            byStatus: { queued: 1, done: 4, failed: 1, secret: 9 },
            bySource: { thread: 3, dm: 2, 'Not A Source': 1 },
            waiting: [{ app: 'bread', change: 70, issueNumber: 12, status: 'queued', asks: 1, since: '2026-10-10T08:00:00.000Z', tries: 1, instruction: 'never' }],
          },
          offers: { file_request: { done: 2, declined: 1 }, withdraw_change: { open: 1 }, mystery: { open: 3 } },
        },
        incidents: {
          days: 7, total: 1,
          items: [{ at: '2026-10-10T09:00:00.000Z', kind: 'checks_not_change', app: 'bread', runId: 5, issueNumber: 12, why: 'w'.repeat(400), outcome: null, detail: 'never' }],
        },
      };
    },
  };
  const out = await data.botOverview(null, {}, {}, { bot });
  assert.deepEqual(
    [out.settings.voiceSession, out.settings.voiceIssue, out.settings.voiceChat], [true, false, true],
    'on unless switched off, as the bot reads them',
  );
  assert.deepEqual(out.voice.byPlace, { session: { replied: 6, quiet: 1, failed: 1 }, chat: { replied: 3, quiet: 1 } });
  assert.equal(out.voice.turns, 12);
  assert.equal(out.voice.people, 5);
  assert.deepEqual(out.voice.recentFailures, [{
    at: '2026-10-10T09:00:00.000Z', app: 'bread', place: 'session', ref: 70, outcome: 'failed',
    error: 'no_key', failures: ['v1:rate_limited:429', 'claims:started'], rounds: 2,
  }], 'codes only: a message or anybody\'s words never ride along');
  assert.deepEqual(out.voice.asks.byStatus, { queued: 1, done: 4, failed: 1 });
  assert.deepEqual(out.voice.asks.bySource, { thread: 3, dm: 2 });
  assert.deepEqual(out.voice.asks.waiting, [{ app: 'bread', change: 70, issueNumber: 12, status: 'queued', asks: 1, since: '2026-10-10T08:00:00.000Z', tries: 1 }]);
  assert.deepEqual(out.voice.offers, { file_request: { done: 2, declined: 1 }, withdraw_change: { open: 1 } });
  assert.equal(out.incidents.items[0].kind, 'checks_not_change');
  assert.equal(out.incidents.items[0].why.length, 300, 'a reason is clipped');
  assert.equal(out.incidents.items[0].detail, undefined);
  assert.doesNotMatch(JSON.stringify(out), /never/);

  const none = await data.botOverview(null, {}, {}, { bot: { async adminPayload() { return { settings: {}, queue: {}, runs: [] }; } } });
  assert.equal(none.voice, null);
  assert.equal(none.incidents, null);
});

test('recent shots page through the gallery\'s own listing and counts, and keep only what they name', async () => {
  const gallery = {
    async listProposals(_pool, q) {
      assert.equal(q.app, 'bread');
      assert.equal(q.before_id, 7);
      return {
        proposals: [{
          id: 70, appSlug: 'bread', appName: 'Bread', prNumber: 12, prUrl: 'https://github.com/x/y/pull/12', title: 'Add rye',
          mergedAt: '2026-10-01T00:00:00Z', captureState: 'ok', authorEmail: 'never@example.com',
          shots: {
            state: 'verified', claims: [{ id: 'c1', claim: 'Rye is a choice' }], artifacts: [{ media: 'png' }, { media: 'png' }, { media: 'webm' }],
            shotNotices: [
              { text: 'The flour table is cut off. '.repeat(20), change: 'c1', screen: 'phone', shot: 'screen', alsoBefore: true, extra: 'dropped' },
              { text: 'An error shows.', change: 'c1', screen: 'desktop', shot: 'clip', alsoBefore: 'maybe' },
            ],
          },
          visuals: [{}, {}],
        }],
        nextCursor: { before: '2026-09-30T00:00:00Z', before_id: 69 },
      };
    },
    async shotsStats(_pool, q) {
      assert.deepEqual(q, { app: 'bread', days: '14' }, 'the window and the app, never the capture problem');
      return { window: { days: 14 }, proposals: 3 };
    },
    async galleryStats() { assert.fail('the retired pipeline\'s counters are the console strip\'s, not the connector\'s'); },
  };
  const out = await data.recentShots(null, { app: 'bread', beforeId: 7 }, { gallery });
  const p = out.proposals[0];
  assert.equal(p.sessionId, 70);
  assert.equal(p.shots.images, 2);
  assert.equal(p.shots.clips, 1);
  // What the shots agent noticed on the after build, as the card lists it, bounded.
  assert.equal(p.shots.shotNotices.length, 2);
  assert.equal(p.shots.shotNotices[0].text.length, 300);
  assert.deepEqual({ ...p.shots.shotNotices[0], text: null },
    { text: null, change: 'c1', screen: 'phone', shot: 'screen', alsoBefore: true });
  assert.deepEqual(p.shots.shotNotices[1], { text: 'An error shows.', change: 'c1', screen: 'desktop', shot: null, alsoBefore: 'unknown' });
  assert.equal(p.legacyCaptures, 2);
  assert.equal(p.authorEmail, undefined);
  assert.deepEqual(out.nextCursor, { before: '2026-09-30T00:00:00.000Z', beforeId: 69 });
  assert.deepEqual((await data.shotStats(null, { app: 'bread', problem: 'root_only', days: '14' }, { gallery })).stats,
    { window: { days: 14 }, proposals: 3 });
});

// A run that shot one change of three (PR 4777) read as a success: the
// listing gave its state and not its changes.
test('each run in recent shots says how each declared change came out, and counts them', async () => {
  const claim = (n) => ({ id: `c${n}`, claim: `Change ${n}` });
  const gallery = {
    async listProposals() {
      return {
        proposals: [
          { id: 80, shots: {
            state: 'verified', artifacts: [], claims: [claim(1), claim(2), claim(3)],
            shotResults: [
              { id: 'c1', status: 'ready' }, { id: 'c2', status: 'skipped', reason: 'Needs a wallet.' },
              { id: 'c3', status: 'skipped', reason: 'Needs a second member.' },
            ],
          } },
          { id: 81, shots: {
            state: 'verified', artifacts: [], claims: [claim(1), claim(2)],
            shotResults: [{ id: 'c1', status: 'unchanged', note: 'any visible difference.' }, { id: 'c2', status: 'failed' }],
          } },
          // Stopped before it saved anything: no results to count.
          { id: 82, shots: { state: 'failed', failureCode: 'shots_agent_failed', artifacts: [], claims: [claim(1)], shotResults: [] } },
          { id: 83, shots: { state: 'verified', artifacts: [], claims: [claim(1)], shotResults: [{ id: 'c1', status: 'published' }] } },
        ],
        nextCursor: null,
      };
    },
  };
  const out = await data.recentShots(null, {}, { gallery });
  const [partial, unchanged, stopped, odd] = out.proposals.map((p) => p.shots);
  assert.deepEqual(partial.changes, { declared: 3, ready: 1, unchanged: 0, skipped: 2, failed: 0 });
  assert.deepEqual(partial.claims.map((c) => c.status), ['ready', 'skipped', 'skipped']);
  assert.deepEqual(unchanged.changes, { declared: 2, ready: 0, unchanged: 1, skipped: 0, failed: 1 });
  assert.deepEqual(unchanged.claims, [
    { id: 'c1', claim: 'Change 1', status: 'unchanged' }, { id: 'c2', claim: 'Change 2', status: 'failed' },
  ]);
  assert.deepEqual(stopped.changes, { declared: 1, ready: 0, unchanged: 0, skipped: 0, failed: 0 });
  assert.equal(stopped.claims[0].status, null);
  assert.equal(odd.claims[0].status, null, 'a status it does not know is not passed on');
});

test('one proposal\'s shots: only a verified run\'s stills, focus first, within the count and the bytes', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const pool = (session, artifacts) => ({
    async query(sql) {
      if (/FROM chat_sessions/.test(sql)) return { rows: session ? [session] : [] };
      return { rows: artifacts };
    },
  });
  assert.equal((await data.shotImages(pool(null, []), 1)).status, 404);
  const unverified = await data.shotImages(pool({ id: 1, shots_run_id: 4, shots_state: 'failed' }, []), 1);
  assert.deepEqual(unverified.images, []);
  assert.match(unverified.note, /no verified/);

  const rows = Array.from({ length: data.MAX_SHOT_IMAGES + 3 }, (_, i) => ({
    id: i, story_id: `c${i}`, viewport: 'phone', side: i % 2 ? 'head' : 'base', variant: 'focus', content_type: 'image/png', data: png, width: 1, height: 1,
  }));
  const out = await data.shotImages(pool({ id: 1, shots_run_id: 4, shots_state: 'verified', pr_number: 12, app_slug: 'bread' }, rows), 1);
  assert.equal(out.images.length, data.MAX_SHOT_IMAGES);
  assert.equal(out.leftOut, 3);
  assert.equal(out.images[0].caption, 'c0 · phone · before · focus');
  assert.equal(out.images[1].caption, 'c1 · phone · after · focus');
  assert.equal(out.prNumber, 12);
});

test('a failed run in recent shots carries its code, its reason in full and how the shots agent ended', async () => {
  const reason = `The shots agent stopped with an error before it finished. ${'detail '.repeat(100)}`;
  const gallery = {
    async listProposals() {
      return {
        proposals: [
          { id: 71, shots: { state: 'failed', failureCode: 'shots_agent_failed', failureReason: reason, claims: [], artifacts: [] } },
          { id: 72, shots: { state: 'failed', failureCode: 'shots_capture_incomplete', failureReason: 'Needs a wallet.', claims: [], artifacts: [] } },
          { id: 73, shots: { state: 'verified', claims: [], artifacts: [] } },
        ],
        nextCursor: null,
      };
    },
  };
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [
        { session_id: 71, dispatches: [
          { outcome: 'failed', code: 'shots_agent_failed', exitCode: -1, exitCause: 'oom_killed' },
        ] },
        { session_id: 72, dispatches: [{ outcome: 'completed' }] },
      ] };
    },
  };
  const out = await data.recentShots(pool, {}, { gallery });
  assert.deepEqual(queries[0].params, [[71, 72]], 'only the failed runs are looked up');
  const [died, skipped, verified] = out.proposals;
  assert.equal(died.shots.failureCode, 'shots_agent_failed');
  assert.ok(died.shots.failure.length > 200 && died.shots.failure.length <= 1200, 'the reason past its first line');
  assert.deepEqual(died.shots.agentExit, { code: 'shots_agent_failed', exitCode: -1, exitCause: 'oom_killed' });
  assert.equal(skipped.shots.failure, 'Needs a wallet.');
  assert.equal(Object.hasOwn(skipped.shots, 'agentExit'), false, 'an agent that finished has no exit to report');
  assert.equal(Object.hasOwn(verified.shots, 'agentExit'), false);

  // A lookup that fails never fails the listing.
  const broken = { async query() { throw new Error('relation does not exist'); } };
  assert.equal((await data.recentShots(broken, {}, { gallery })).proposals.length, 3);
});

test('a run carries the size of the spec its build worked from, to read against how the build went', async () => {
  const bot = {
    async adminPayload() {
      return {
        settings: {}, bot: null, totals: {}, queue: { depth: 0, items: [] },
        runs: [{
          id: 3, app_slug: 'bread', issue_number: 1, verdict: 'ready', build_ok: false,
          build_error: 'the build ran past its time limit', build_spec_md: '# Plan\n'.concat('x'.repeat(9993)),
          bot_config_version_id: 4, created_at: '2026-10-01T00:00:00Z',
        }],
      };
    },
  };
  const [run] = (await data.botOverview(null, {}, {}, { bot })).runs;
  assert.equal(run.specChars, 10000);
  assert.equal(run.build.state, 'failed');
  assert.equal(run.botConfig.versionId, 4);
});
