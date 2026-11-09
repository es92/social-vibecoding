'use strict';
// Automatic challenge scoring.
//
// Three layers, tested where each of them actually lives:
//
//   challenge-rules.js    pure. Windows, payout arithmetic, the cap, and the
//                         reason a rule is skipped — plain data in, plain
//                         data out, no pool anywhere.
//   challenge-scorer.js   the tick, against a scripted pool. The properties
//                         that matter are idempotence (a second run writes
//                         nothing), the dry-run contract (reads everything,
//                         writes nothing, grades nothing) and the shape of
//                         the ledger row it produces.
//   challenge-grader.js   the pre-filter and the clamp, with a stub engine —
//                         a grading failure must leave the unit for the next
//                         tick rather than credit a guess.
//
// The ledger-row shape has its own test because it is the one thing three
// other files already depend on: `metadata.kind = 'challenge_completion'` is
// what the completion unique index and the home panel's "done" rule key on,
// and a counted measure that emitted it would have its second credit refused
// by the database.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let currentMockPool = null;
poolMod.getPool = () => currentMockPool;

const rules = require('../src/services/topochain/challenge-rules');
const grader = require('../src/services/topochain/challenge-grader');
// The scorer's lock lives on the process's lock connection
// (src/db/session-locks.js; tests/session-locks-postgres.test.js runs it).
// Its stand-in asks the fake pool, which says whether it is held.
{
  const locksPath = require.resolve('../src/db/session-locks');
  const { BUSY } = require(locksPath);
  require.cache[locksPath] = { id: locksPath, filename: locksPath, loaded: true, exports: {
    BUSY,
    ifSessionLockFree: async (pool, key, fn) => {
      const { rows: [r] } = await pool.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', key);
      if (!r || r.acquired !== true) return BUSY;
      try { return await fn(); } finally { await pool.query('SELECT pg_advisory_unlock($1, $2)', key); }
    },
  } };
}
const scorer = require('../src/services/topochain/challenge-scorer');
const { challengeScoringAdminRoutes, parseRuleFields } = require('../src/routes/topochain/admin/challenge-scoring');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-16T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// A challenge row as RULE_CHALLENGES_SQL returns it: challenge columns bare,
// template columns `t_`-prefixed, plus the event's dates for the fallback.
const challengeRow = (extra = {}) => ({
  rule_id: 1,
  rule_name: 'Try apps',
  measure: 'TRY_APPS',
  rule_target: null,
  rule_points: null,
  rule_enabled: true,
  challenge_id: 74,
  season_event_id: 10,
  enabled: true,
  completed: false,
  schedule_start: iso(NOW - 3 * DAY),
  schedule_end: iso(NOW + 4 * DAY),
  metric_target: 3,
  reward: '500 pts',
  t_category: 'ONBOARDING',
  t_goal: 'Try 3 apps',
  t_schedule_start: null,
  t_schedule_end: null,
  t_metric_target: 3,
  t_reward: '500 pts',
  event_starts_at: iso(NOW - 10 * DAY),
  event_ends_at: iso(NOW + 10 * DAY),
  ...extra,
});

const rule = (extra = {}) => ({
  id: 1, name: 'Try apps', measure: 'TRY_APPS', target: null, points: null, enabled: true, ...extra,
});

// ─── Rewards ───────────────────────────────────────────────────────────

test('reward parsing is the home panel\'s, unchanged by the move', () => {
  assert.equal(rules.parseRewardPoints('500 pts'), 500);
  assert.equal(rules.parseRewardPoints('1,000 pts'), 1000);
  assert.equal(rules.parseRewardPoints('Up to 2,000 pts'), 2000);
  assert.equal(rules.parseRewardPoints('Up to 500 pts / issue'), null);
  assert.equal(rules.parseRewardPoints('½ of your final credits'), null);
  assert.equal(rules.parseRewardPoints(null), null);
  // The home panel re-exports it, so the two surfaces cannot drift.
  const panels = require('../src/routes/home-panels');
  assert.equal(panels.parseRewardPoints('Up to 6,500 pts'), 6500);
});

// ─── Windows ───────────────────────────────────────────────────────────

test('a window falls back challenge → template → event', () => {
  const onChallenge = rules.resolveWindow(challengeRow(), { now: NOW });
  assert.equal(onChallenge.startMs, NOW - 3 * DAY);
  assert.equal(onChallenge.open, true);

  const onTemplate = rules.resolveWindow(challengeRow({
    schedule_start: null, schedule_end: null,
    t_schedule_start: iso(NOW - DAY), t_schedule_end: iso(NOW + DAY),
  }), { now: NOW });
  assert.equal(onTemplate.startMs, NOW - DAY);

  // A persistent challenge carries no dates at all and inherits the event's,
  // which is what makes "open all season" need no typing.
  const onEvent = rules.resolveWindow(challengeRow({
    schedule_start: null, schedule_end: null, t_schedule_start: null, t_schedule_end: null,
  }), { now: NOW });
  assert.equal(onEvent.startMs, NOW - 10 * DAY);
  assert.equal(onEvent.open, true);
});

test('a window that closed minutes ago still pays; a week later it does not', () => {
  const justClosed = challengeRow({ schedule_end: iso(NOW - 5 * 60 * 1000) });
  assert.equal(rules.resolveWindow(justClosed, { now: NOW }).open, true,
    'Sunday 23:55 must still be credited by the tick that runs after midnight');
  const longClosed = challengeRow({ schedule_end: iso(NOW - 8 * DAY) });
  assert.equal(rules.resolveWindow(longClosed, { now: NOW }).open, false);
});

// ─── Why a rule is skipped ─────────────────────────────────────────────

test('every skip names the thing the operator has to change', () => {
  const r = rule();
  assert.equal(rules.skipReason(r, challengeRow(), { now: NOW }), null);
  assert.equal(rules.skipReason(rule({ enabled: false }), challengeRow(), { now: NOW }),
    'rule is switched off');
  assert.equal(rules.skipReason(rule({ measure: 'NOPE' }), challengeRow(), { now: NOW }),
    'unknown measure NOPE');
  assert.equal(rules.skipReason(r, challengeRow({ enabled: false }), { now: NOW }),
    'challenge is switched off');
  assert.equal(rules.skipReason(r, challengeRow({ completed: true }), { now: NOW }),
    'challenge is closed');
  assert.equal(
    rules.skipReason(r, challengeRow({ schedule_start: iso(NOW + DAY) }), { now: NOW }),
    'window has not started'
  );
  assert.match(
    rules.skipReason(r, challengeRow({ reward: 'Unlocks future rewards', t_reward: 'Unlocks future rewards' }), { now: NOW }),
    /^no points/
  );
  assert.match(
    rules.skipReason(r, challengeRow({ metric_target: null, t_metric_target: null }), { now: NOW }),
    /^no target/
  );
  // A count of one is a target, not a missing one (#3570): "Try an app" is
  // TRY_APPS at 1, and this used to report it as "no target" and pay nobody.
  assert.equal(rules.skipReason(r, challengeRow({ metric_target: 1, t_metric_target: 1 }), { now: NOW }), null);
  assert.match(
    rules.skipReason(r, challengeRow({ metric_target: 0, t_metric_target: 0 }), { now: NOW }),
    /^no target/
  );
});

test('a measure that never reads a target does not ask for one', () => {
  // Found in the first live preview: "Sent a proposal" is one proposal and
  // done, and demanding a number it never reads made a correct rule report
  // itself as misconfigured. Having a target UNIT and needing a target are
  // different questions.
  const sent = rule({ measure: 'PROPOSAL_SENT' });
  const row = challengeRow({
    measure: 'PROPOSAL_SENT', metric_target: null, t_metric_target: null,
    reward: '1,000 pts', t_reward: '1,000 pts',
  });
  assert.equal(rules.skipReason(sent, row, { now: NOW }), null);

  // The minutes measure DOES read the number, so it still says so.
  const minutes = rule({ measure: 'USE_APPS_MINUTES' });
  assert.match(rules.skipReason(minutes, row, { now: NOW }), /^no target/);
  assert.equal(rules.skipReason(rule({ measure: 'USE_APPS_MINUTES', target: 10 }), row, { now: NOW }), null);
});

test('a rule\'s own numbers win over the challenge\'s, and blank falls back', () => {
  const row = challengeRow();
  assert.equal(rules.effectiveTarget(rule(), row), 3);
  assert.equal(rules.effectivePoints(rule(), row), 500);
  assert.equal(rules.effectiveTarget(rule({ target: 5 }), row), 5);
  assert.equal(rules.effectivePoints(rule({ points: 750 }), row), 750);
  // The reason Points exists at all: a reward that will not parse.
  const prose = challengeRow({ reward: 'Up to 2,000 pts a week', t_reward: 'Up to 2,000 pts a week' });
  assert.equal(rules.effectivePoints(rule(), prose), null);
  assert.equal(rules.effectivePoints(rule({ points: 2000 }), prose), 2000);
});

// ─── Payout ────────────────────────────────────────────────────────────

test('payout shapes match the scoring sentence each challenge prints', () => {
  // "500 pts after the third app." — nothing, nothing, then the lot.
  assert.deepEqual([0, 1, 2].map((index) => rules.unitPoints({
    payout: 'on_target', points: 500, target: 3, index,
  })), [0, 0, 500]);

  // "250 pts per account, 500 pts for both."
  assert.deepEqual([0, 1].map((index) => rules.unitPoints({
    payout: 'per_unit', points: 500, target: 2, index,
  })), [250, 250]);

  // A single completion takes the whole reward.
  assert.equal(rules.unitPoints({ payout: 'full', points: 1000, target: 1, index: 0 }), 1000);

  // A graded unit gets the ceiling; the grader lowers it.
  assert.equal(rules.unitPoints({ payout: 'graded', points: 1000, target: 4, index: 0 }), 250);
});

test('an uneven split still pays the whole reward, with the remainder on the last unit', () => {
  const paid = [0, 1, 2].map((index) => rules.unitPoints({
    payout: 'per_unit', points: 1000, target: 3, index,
  }));
  assert.deepEqual(paid, [333, 333, 334]);
  assert.equal(paid.reduce((a, b) => a + b, 0), 1000, 'no rounding tail reaches the leaderboard');
});

// ─── Planning ──────────────────────────────────────────────────────────

const candidate = (userId, key, at = iso(NOW - HOUR)) => ({
  userId, sourceKey: key, activityAt: at, description: key,
});

test('planning pays the third app and ignores the ones already credited', () => {
  const credited = new Map([[7, { keys: new Set(['app:1']), count: 1 }]]);
  const plan = rules.planCredits(rule(), challengeRow(), {
    candidates: [candidate(7, 'app:1'), candidate(7, 'app:2'), candidate(7, 'app:3')],
    credited,
    now: NOW,
  });
  assert.deepEqual(plan.map((c) => c.sourceKey), ['app:2', 'app:3']);
  assert.deepEqual(plan.map((c) => c.points), [0, 500]);
});

test('the target is a cap: a fourth app earns nothing more', () => {
  const plan = rules.planCredits(rule(), challengeRow(), {
    candidates: [1, 2, 3, 4].map((n) => candidate(7, `app:${n}`)),
    now: NOW,
  });
  assert.equal(plan.length, 3);
  assert.equal(plan.reduce((sum, c) => sum + c.points, 0), 500);
});

test('two candidates in ONE run cannot both be "the last unit"', () => {
  // Without the running tally inside planCredits, both accounts would see
  // index 1 and the challenge would pay 250 + 250 on top of an existing one.
  const plan = rules.planCredits(rule({ measure: 'CONNECT_ACCOUNTS' }), challengeRow({
    measure: 'CONNECT_ACCOUNTS', metric_target: 2, t_metric_target: 2,
  }), {
    candidates: [candidate(7, 'provider:github'), candidate(7, 'provider:x')],
    now: NOW,
  });
  assert.deepEqual(plan.map((c) => c.points), [250, 250]);
});

test('a windowed measure refuses a candidate from before the window opened', () => {
  const plan = rules.planCredits(rule(), challengeRow(), {
    candidates: [candidate(7, 'app:1', iso(NOW - 30 * DAY)), candidate(7, 'app:2')],
    now: NOW,
  });
  assert.deepEqual(plan.map((c) => c.sourceKey), ['app:2']);
});

test('a state measure counts what happened before the season, on purpose', () => {
  // Somebody who linked GitHub last month has it linked. A persistent
  // challenge that refused to see that would ask them to redo it.
  const plan = rules.planCredits(rule({ measure: 'CONNECT_ACCOUNTS' }), challengeRow({
    measure: 'CONNECT_ACCOUNTS', metric_target: 2, t_metric_target: 2,
  }), {
    candidates: [candidate(7, 'provider:github', iso(NOW - 60 * DAY))],
    now: NOW,
  });
  assert.equal(plan.length, 1);
});

test('a counted measure never emits the completion marker, a single one always does', () => {
  const counted = rules.planCredits(rule(), challengeRow(), {
    candidates: [candidate(7, 'app:1')], now: NOW,
  });
  assert.equal(counted[0].completion, false,
    'three tried apps are three rows; the completion index would refuse the second');
  const single = rules.planCredits(rule({ measure: 'PROPOSAL_SENT' }), challengeRow({
    measure: 'PROPOSAL_SENT', reward: '1,000 pts', t_reward: '1,000 pts',
  }), { candidates: [candidate(7, 'session:5')], now: NOW });
  assert.equal(single[0].completion, true);
  assert.equal(single[0].points, 1000);
});

// ─── Grading ───────────────────────────────────────────────────────────

test('the pre-filter rejects junk without spending a model call', () => {
  const seen = new Set();
  assert.equal(grader.preFilter('USEFUL_FEEDBACK', { text: 'broken' }, seen), 'too short to act on');
  const real = { text: 'The save button on the recipe screen does nothing when the title is empty.' };
  assert.equal(grader.preFilter('USEFUL_FEEDBACK', real, seen), null);
  assert.equal(grader.preFilter('USEFUL_FEEDBACK', real, seen), 'the same report was already credited',
    'sending the same sentence four times earns one credit');
  // Accepted proposals passed a group vote, so there is nothing to pre-filter.
  assert.equal(grader.preFilter('PROPOSAL_ACCEPTED', { text: 'x' }, seen), null);
  // The ungraded First-challenge measure reads the same reports through the
  // same filter (#3568): "test" does not tick "Suggest an improvement".
  assert.equal(grader.preFilter('FEEDBACK_SENT', { text: 'test' }, new Set()), 'too short to act on');
  assert.equal(grader.preFilter('FEEDBACK_SENT', real, new Set()), null);
});

test('a score is clamped into the band and never reaches zero', () => {
  assert.equal(grader.clampScore(180, 250), 180);
  assert.equal(grader.clampScore(400, 250), 250);
  assert.equal(grader.clampScore(0, 250), 1,
    'zero would mean writing no row, which would mean re-grading the same text every tick');
  assert.equal(grader.clampScore('not a number', 250), null);
});

test('a grading failure leaves the unit for the next tick instead of crediting a guess', async () => {
  const failing = { isEnabled: () => true, gradeChallengeUnit: async () => { throw new Error('529'); } };
  const errors = [];
  const out = await grader.gradeAll(
    [{ measure: 'USEFUL_FEEDBACK', gradeInput: { text: 'a real report about a real thing' }, points: 250 }],
    { llm: failing, onError: (e) => errors.push(e.message) }
  );
  assert.deepEqual(out, []);
  assert.deepEqual(errors, ['529']);
});

test('grading returns the model\'s score, with its reason written to the builder (#3200)', async () => {
  const stub = {
    isEnabled: () => true,
    gradeChallengeUnit: async ({ system, user }) => {
      assert.match(system, /ACTIONABLE/, 'the rubric reaches the model');
      assert.match(user, /save button/);
      return { score: 200, reason: 'Says what broke and where.', model: 'claude-haiku-4-5' };
    },
  };
  const out = await grader.gradeAll([{
    measure: 'USEFUL_FEEDBACK',
    gradeInput: { text: 'The save button does nothing', appName: 'Recipes' },
    points: 250,
  }], { llm: stub });
  assert.equal(out[0].points, 200);
  assert.equal(out[0].grade.reason, 'Says what broke and where.');
});

test('both rubrics ask for a reason written to the person who did it, not an admin (#3200)', () => {
  // The reason is shown on the Leaderboard under the activity now, so a
  // reason addressed to an admin reads wrong to the builder reading it.
  for (const [name, rubric] of Object.entries(grader.RUBRICS)) {
    const system = rubric.system(250);
    assert.doesNotMatch(system, /for an admin/, `${name} no longer addresses the reason to an admin`);
    assert.match(system, /written to the person who did it, in plain words, saying what made it worth more or less/,
      `${name} asks for the builder's reason`);
  }
});

// ─── The tick, against a scripted pool ─────────────────────────────────

// A pool that answers by matching the query text. Deliberately not a SQL
// engine: what these tests pin is the ORDER of operations and what ends up in
// `inserted`, not Postgres's behaviour.
function scriptedPool({ challenges = [], candidates = [], credited = [], feedback = [], ledgerNewer = false } = {}) {
  const inserted = [];
  const runs = [];
  const handle = async (sql, params) => {
    if (sql.includes('FROM challenge_scoring_rules')) return { rows: challenges };
    if (sql.includes("metadata->>'source_key' AS source_key")) return { rows: credited };
    if (sql.includes('FROM app_activity')) return { rows: candidates };
    if (sql.includes('FROM feedback_reports')) return { rows: feedback };
    if (sql.includes('INSERT INTO challenge_scorer_runs')) { runs.push(params); return { rows: [{ id: runs.length }] }; }
    if (sql.includes('UPDATE challenge_scorer_runs')) { runs.push(params); return { rows: [] }; }
    if (sql.includes('INSERT INTO user_activities')) {
      // The unique index is what makes a second run free; model it.
      const key = `${params[7]}:${params[0]}:${JSON.parse(params[5]).source_key}`;
      if (inserted.some((r) => r.key === key)) return { rows: [] };
      inserted.push({ key, params, metadata: JSON.parse(params[5]) });
      return { rows: [{ id: inserted.length }] };
    }
    if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) return { rows: [] };
    if (sql.includes('MAX(snapshot_at)')) return { rows: [{ at: new Date(NOW) }] };
    if (sql === scorer.LEDGER_NEWER_SQL) return { rows: [{ newer: ledgerNewer }] };
    return { rows: [] };
  };
  return {
    inserted,
    runs,
    async query(sql, params) { return handle(sql, params); },
    async connect() {
      return { async query(sql, params) { return handle(sql, params); }, release() {} };
    },
  };
}

const appActivityRows = [
  { user_id: 7, app_id: 1, app_name: 'Recipes', last_date: '2026-09-15', seconds: 120 },
  { user_id: 7, app_id: 2, app_name: 'Runs', last_date: '2026-09-15', seconds: 90 },
  { user_id: 7, app_id: 3, app_name: 'Notes', last_date: '2026-09-16', seconds: 45 },
];

test('a run writes one ledger row per unit, in the shape the rest of the platform reads', async () => {
  const pool = scriptedPool({ challenges: [challengeRow()], candidates: appActivityRows });
  const summary = await scorer.score(pool, { now: NOW });

  assert.equal(summary.credits, 3);
  assert.deepEqual(pool.inserted.map((r) => r.metadata.source_key), ['app:1', 'app:2', 'app:3']);
  assert.deepEqual(pool.inserted.map((r) => Number(r.params[3])), [0, 0, 500]);

  const [first] = pool.inserted;
  assert.equal(first.params[2], 'ONBOARDING', 'credited under the template category, like every other credit');
  assert.equal(first.metadata.measure, 'TRY_APPS');
  assert.equal(first.metadata.rule_id, 1);
  assert.equal(first.metadata.kind, undefined, 'a counted measure must not claim completion');
  assert.match(first.params[4], /Tried Recipes/);
  // The credit is dated when the thing happened, so it sits inside its week.
  assert.match(first.params[6], /^2026-09-15/);
});

test('running again writes nothing: the same units are already credited', async () => {
  const pool = scriptedPool({ challenges: [challengeRow()], candidates: appActivityRows });
  await scorer.score(pool, { now: NOW });
  const before = pool.inserted.length;

  // Second tick: the ledger now holds what the first wrote.
  const pool2 = scriptedPool({
    challenges: [challengeRow()],
    candidates: appActivityRows,
    credited: pool.inserted.map((r) => ({ user_id: r.params[0], source_key: r.metadata.source_key })),
  });
  const summary = await scorer.score(pool2, { now: NOW });
  assert.equal(before, 3);
  assert.equal(summary.credits, 0);
  assert.equal(pool2.inserted.length, 0);
});

test('a dry run reads everything and writes nothing', async () => {
  const pool = scriptedPool({ challenges: [challengeRow()], candidates: appActivityRows });
  const summary = await scorer.score(pool, { now: NOW, dryRun: true });
  assert.equal(summary.credits, 3, 'it still says what it would pay');
  assert.equal(pool.inserted.length, 0);
});

test('a dry run of a graded measure spends no model call', async () => {
  const graded = challengeRow({
    measure: 'USEFUL_FEEDBACK', rule_name: 'Feedback', metric_target: 4, t_metric_target: 4,
    reward: '1,000 pts', t_reward: '1,000 pts', t_goal: 'Send useful feedback',
  });
  const pool = scriptedPool({ challenges: [graded] });
  pool.query = async (sql) => {
    if (sql.includes('FROM challenge_scoring_rules')) return { rows: [graded] };
    if (sql.includes('FROM feedback_reports')) {
      return {
        rows: [{
          id: 5, user_id: 7, created_at: new Date(NOW - HOUR), title: 'Save fails',
          description: 'The save button on the recipe screen does nothing when the title is empty.',
          app_name: 'Recipes',
        }],
      };
    }
    if (sql.includes("metadata->>'source_key' AS source_key")) return { rows: [] };
    return { rows: [] };
  };
  const summary = await scorer.score(pool, { now: NOW, dryRun: true });
  assert.equal(summary.challenges[0].to_grade, 1);
  assert.equal(summary.credits, 0);
  assert.equal(summary.graded, 0);
});

// Both caught by the first end-to-end run, not by the tests above — they
// exercised the filter and the plan separately, and the defect was the ORDER
// the scorer ran them in.
const feedbackChallenge = () => challengeRow({
  measure: 'USEFUL_FEEDBACK', rule_name: 'Feedback', metric_target: 4, t_metric_target: 4,
  reward: '1,000 pts', t_reward: '1,000 pts', t_goal: 'Send useful feedback', t_category: 'WEEKLY',
});
const feedbackRow = (id, description, minutesAgo) => ({
  id, user_id: 7, created_at: new Date(NOW - minutesAgo * 60000), title: 'Report', description, app_name: 'Recipes',
});
const realReport = (n) => `Report ${n}: the save button on the recipe screen does nothing when the title is empty, and no error is shown.`;
const fixedGrader = {
  isEnabled: () => true,
  async gradeChallengeUnit() { return { score: 200, reason: 'Says what broke and where.', model: 'stub' }; },
};

test('junk sent first never holds a weekly slot: the real reports behind it are paid', async () => {
  const pool = scriptedPool({
    challenges: [feedbackChallenge()],
    feedback: [
      feedbackRow(1, 'test', 90), feedbackRow(2, 'test', 89), feedbackRow(3, 'asdf', 88), feedbackRow(4, 'hi', 87),
      feedbackRow(5, realReport(1), 60), feedbackRow(6, realReport(2), 50), feedbackRow(7, realReport(3), 40),
    ],
  });
  const summary = await scorer.score(pool, { now: NOW, llm: fixedGrader });

  assert.deepEqual(pool.inserted.map((r) => r.metadata.source_key), ['feedback:5', 'feedback:6', 'feedback:7'],
    'planning first gave all four slots to the junk, and nothing was ever written');
  assert.equal(summary.challenges[0].rejected, 4);
});

test('a report already paid for is a duplicate the next time it is sent', async () => {
  const pool = scriptedPool({
    challenges: [feedbackChallenge()],
    feedback: [feedbackRow(5, realReport(1), 60), feedbackRow(9, realReport(1), 5)],
    credited: [{ user_id: 7, source_key: 'feedback:5' }],
  });
  const summary = await scorer.score(pool, { now: NOW, llm: fixedGrader });

  assert.equal(pool.inserted.length, 0, 'the bag used to start empty each run, so the copy earned a second credit');
  assert.equal(summary.challenges[0].rejected, 1);
});

test('a skipped rule reports the reason instead of failing silently', async () => {
  const closed = challengeRow({ schedule_end: iso(NOW - 8 * DAY) });
  const pool = scriptedPool({ challenges: [closed] });
  const summary = await scorer.score(pool, { now: NOW });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.challenges[0].skipped, 'window has closed');
  assert.equal(pool.inserted.length, 0);
});

// The standings: a new snapshot (a chart point) every six hours, and the
// latest one rewritten in place whenever the ledger is newer (#3650: a member
// saw the challenge's points long before the leaderboard's).
function standingsPool({ at, fresh, newer }) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      if (sql === scorer.LAST_AGGREGATE_SQL) return { rows: at ? [{ at: new Date(at), fresh: fresh ? new Date(fresh) : null }] : [] };
      if (sql === scorer.LEDGER_NEWER_SQL) return { rows: [{ newer: newer(params[0]) }] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
}
function withBuilder(fn) {
  const builder = require('../src/services/topochain/snapshot-builder');
  const real = builder.buildSnapshots;
  const calls = [];
  builder.buildSnapshots = async (pool, opts = {}) => { calls.push(opts); return { events: [{}] }; };
  return fn(calls).finally(() => { builder.buildSnapshots = real; });
}

test('the standings are left alone while nothing in the ledger is newer than them', () => withBuilder(async (calls) => {
  const pool = standingsPool({ at: NOW, fresh: NOW + 10 * MIN, newer: () => false });
  assert.equal(await scorer.maybeAggregate(pool, { hours: 6, now: NOW + HOUR }), null);
  assert.equal(calls.length, 0);
  assert.equal(pool.seen[1].params[0].getTime(), NOW + 10 * MIN - scorer.REFRESH_OVERLAP_MS,
    'compared with a minute behind when the snapshot was last WRITTEN, or a refresh would repeat on every check');
}));

test('a credit that committed during the last rebuild is still newer than the snapshot', () => withBuilder(async (calls) => {
  // The builder reads the sums, then upserts with `updated_at = NOW()`. A
  // credit that committed in that window is missing from the snapshot but is
  // older than the new `fresh`, so a comparison against `fresh` alone never
  // saw it and it waited for the next six-hour generation (#6499).
  const fresh = NOW + 10 * MIN;
  const creditAt = fresh - 30_000;
  const pool = standingsPool({ at: NOW, fresh, newer: (cutoff) => creditAt > cutoff.getTime() });
  assert.deepEqual(await scorer.maybeAggregate(pool, { hours: 6, now: NOW + HOUR }),
    { events: 1, refreshed: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].now.getTime(), NOW, 'still a rewrite in place, not a new chart point');
}));

test('a newer credit refreshes the latest snapshot in place, not a new chart point', () => withBuilder(async (calls) => {
  const pool = standingsPool({ at: NOW, fresh: NOW, newer: () => true });
  const result = await scorer.maybeAggregate(pool, { hours: 6, now: NOW + 2 * HOUR });
  assert.deepEqual(result, { events: 1, refreshed: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].now.getTime(), NOW, 'rebuilt AT the latest snapshot_at: the builder upserts, so the history keeps its points');
}));

test('a snapshot older than the cadence gets a new one, as before', () => withBuilder(async (calls) => {
  const pool = standingsPool({ at: NOW - 7 * HOUR, fresh: NOW - 7 * HOUR, newer: () => true });
  assert.deepEqual(await scorer.maybeAggregate(pool, { hours: 6, now: NOW }), { events: 1 });
  assert.equal(calls[0].now, undefined, 'stamped now: a new point on the chart');
  const none = standingsPool({ at: null, newer: () => false });
  assert.deepEqual(await scorer.maybeAggregate(none, { hours: 6, now: NOW }), { events: 1 }, 'and with no snapshot at all');
  assert.equal(await scorer.maybeAggregate(none, { hours: 0, now: NOW }), null, 'hours 0 leaves it to the admin button');
}));

test('a pass that credits points refreshes the standings even when the scheduled check is not due', () => withBuilder(async (calls) => {
  // #6499: credits were written on a beat that skipped the standings, so a
  // place did not move until a later batch. The same pass now rebuilds them.
  const pool = scriptedPool({ challenges: [challengeRow()], candidates: appActivityRows, ledgerNewer: true });
  const summary = await scorer.runOnce(pool, { trigger: 'schedule', now: NOW, aggregate: false });

  assert.equal(summary.credits, 3);
  assert.equal(calls.length, 1, 'the pass that wrote the credits also rebuilt the standings');
  assert.equal(calls[0].now.getTime(), NOW, 'rewritten at the latest snapshot_at: no new chart point');
  assert.deepEqual(summary.aggregated, { events: 1, refreshed: true });
  assert.equal(summary.aggregateChecked, true);
}));

test('a pass with no credits leaves the standings to the scheduled check', () => withBuilder(async (calls) => {
  const pool = scriptedPool({ challenges: [challengeRow()], candidates: [], ledgerNewer: true });
  const summary = await scorer.runOnce(pool, { trigger: 'schedule', now: NOW, aggregate: false });
  assert.equal(summary.credits, 0);
  assert.equal(calls.length, 0);
  assert.equal(summary.aggregateChecked, undefined);
}));

// ─── Dates ─────────────────────────────────────────────────────────────

test('a date column is pinned to noon UTC, whatever timezone the server keeps', () => {
  // `app_activity.date` is a DATE, and node-postgres hands it back as a Date
  // at LOCAL midnight. Taking that as-is stamped the credit a day early on a
  // server east of UTC — which is not cosmetic: activity on the FIRST day of
  // a window then falls before the window opened, and planCredits drops the
  // credit. Found by the first end-to-end run, on a machine two hours ahead.
  const localMidnight = new Date(2026, 8, 16, 0, 0, 0);
  assert.equal(scorer.dateToIso(localMidnight), '2026-09-16T12:00:00.000Z');
  assert.equal(scorer.dateToIso('2026-09-16'), '2026-09-16T12:00:00.000Z');
  assert.equal(scorer.dateToIso(null), null);
});

test('a credit dated on the first day of the window survives the window guard', () => {
  const start = Date.parse('2026-09-14T00:00:00Z');
  const row = challengeRow({ schedule_start: iso(start) });
  const plan = rules.planCredits(rule(), row, {
    candidates: [candidate(7, 'app:1', scorer.dateToIso(new Date(2026, 8, 14, 0, 0, 0)))],
    now: NOW,
  });
  assert.equal(plan.length, 1, 'noon on the opening day is inside the window in every timezone');
});

test('a challenge on a SEASON-type event is scored, not skipped', () => {
  // Found setting the rules up on production: all nine Pre Season 2
  // challenges hang off the season-type event, and the sweep had borrowed
  // `se.type = 'regular'` from the snapshot builder — which sweeps regular
  // events because those are the scoring sprints it computes standings for.
  // The result was seven correctly configured rules all reporting "No live
  // challenge" and a service that silently did nothing.
  const sql = scorer.RULE_CHALLENGES_SQL;
  assert.ok(!/se\.type\s*=/.test(sql),
    'challenges are scored wherever the organiser attached them');
  // The gates that DO matter are still there: a staff dry-run season, a
  // paused event and a closed season must never pay anyone.
  assert.match(sql, /se\.internal = FALSE/);
  assert.match(sql, /se\.is_active = TRUE/);
  assert.match(sql, /COALESCE\(s\.is_active, FALSE\) = TRUE/);
});

// ─── The admin API ─────────────────────────────────────────────────────

test('a rule must name exactly one binding', () => {
  const base = { name: 'Try apps', measure: 'TRY_APPS' };
  assert.deepEqual(parseRuleFields({ ...base, challenge_template_id: 23 }, { required: true }).details, {});
  assert.match(
    parseRuleFields({ ...base }, { required: true }).details.challenge_template_id[0],
    /Bind the rule/
  );
  assert.match(
    parseRuleFields({ ...base, challenge_template_id: 23, challenge_id: 74 }, { required: true })
      .details.challenge_template_id[0],
    /not both/
  );
});

test('only a measure the platform implements can be saved', () => {
  const { details } = parseRuleFields(
    { name: 'x', measure: 'RUN_ARBITRARY_SCRIPT', challenge_template_id: 23 }, { required: true }
  );
  assert.match(details.measure[0], /must be one of/);
});

test('blank target and points are stored as blank, not as zero', () => {
  const { fields } = parseRuleFields(
    { name: 'x', measure: 'TRY_APPS', challenge_template_id: 23, target: '', points: '' },
    { required: true }
  );
  assert.equal(fields.target, null);
  assert.equal(fields.points, null);
});

function buildApp(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role === 'user') req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false };
    else if (role === 'readonly') req.user = { id: 901, username: 'ro', isAdmin: true, canAdminWrite: false };
    else req.user = { id: 902, username: 'admin', isAdmin: true, canAdminWrite: true };
    next();
  });
  app.use(challengeScoringAdminRoutes({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('the screen loads in one request: measures, rules and recent runs', async (t) => {
  // The GET handler reads the PROCESS clock (`Date.now()`), not the pinned
  // `NOW` the pure-function tests pass in — so freeze it to `NOW` here, or
  // the fixture ages into "window has closed" the week after the pinned
  // date (which is how it first failed).
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const live = challengeRow();
  currentMockPool = scriptedPool({ challenges: [live] });
  currentMockPool.query = async (sql) => {
    if (sql.includes('LEFT JOIN challenge_templates ct ON ct.id = r.challenge_template_id')) {
      return {
        rows: [{
          id: 1, name: 'Try apps', measure: 'TRY_APPS', challenge_template_id: 23, challenge_id: null,
          target: null, points: null, enabled: true, notes: null,
          created_at: new Date(NOW), updated_at: new Date(NOW), template_goal: 'Try 3 apps',
        }],
      };
    }
    if (sql.includes('FROM challenge_scorer_runs')) return { rows: [] };
    if (sql.includes('FROM challenge_scoring_rules')) return { rows: [live] };
    return { rows: [] };
  };
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/challenge-scoring`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data.measures.map((m) => m.key).sort(), rules.MEASURE_KEYS.slice().sort());
    assert.equal(body.data.rules[0].bound_to.kind, 'template');
    // The live column: which challenges this rule pays into, and why not.
    assert.equal(body.data.rules[0].covers[0].challenge_id, 74);
    assert.equal(body.data.rules[0].covers[0].points, 500);
    assert.equal(body.data.rules[0].covers[0].skipped, null);
  } finally { server.close(); }
});

test('a view-only admin can read the rules but not change or run them', async () => {
  currentMockPool = scriptedPool();
  const { server, base } = await listen(buildApp('readonly'));
  try {
    for (const [method, path, body] of [
      ['POST', '/api/v4/admin/challenge-scoring/rules', { name: 'x', measure: 'TRY_APPS', challenge_template_id: 1 }],
      ['PUT', '/api/v4/admin/challenge-scoring/rules/1', { name: 'x' }],
      ['DELETE', '/api/v4/admin/challenge-scoring/rules/1', undefined],
      ['POST', '/api/v4/admin/challenge-scoring/run', { dry_run: true }],
    ]) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(res.status, 403, `${method} ${path} is a write`);
    }
  } finally { server.close(); }
});

test('a second rule on the same challenge is refused as a fixable mistake, not a 500', async () => {
  currentMockPool = {
    async query(sql) {
      if (sql.includes('INSERT INTO challenge_scoring_rules')) {
        const err = new Error('duplicate key');
        err.constraint = 'challenge_scoring_rules_template_unique';
        throw err;
      }
      return { rows: [] };
    },
    async connect() { return { async query() { return { rows: [] }; }, release() {} }; },
  };
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/challenge-scoring/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second', measure: 'TRY_APPS', challenge_template_id: 23 }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.details.challenge_template_id[0], /already scores this challenge/);
  } finally { server.close(); }
});

// ─── Schema ────────────────────────────────────────────────────────────

test('the schema carries the index that makes re-running the scorer free', () => {
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS user_activities_source_key_unique/);
  assert.match(schema, /ON user_activities \(challenge_id, user_id, \(metadata->>'source_key'\)\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS challenge_scoring_rules/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS challenge_scorer_runs/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS feedback_reports/);
  // Free text a person wrote about their own use of the product.
  assert.match(schema, /COMMENT ON TABLE feedback_reports IS 'staging:private';/);
  // Exactly one binding, enforced by the database and not only by the API.
  assert.match(schema, /CONSTRAINT challenge_scoring_rules_one_binding CHECK/);
});

// ─── Cadence: each rule on its own interval ────────────────────────────
//
// One timer beats once a minute; a rule runs on the beats where it is due.
// What these pin is the contract that makes that safe to operate: a rule
// nobody has touched runs exactly as often as the whole service used to, a
// beat with nothing due leaves no trace, the cheap rules never wait behind
// the model calls, and a rule the run's budget cut short is first in line a
// minute later instead of a whole interval later.

const MIN = 60 * 1000;
const { anatomy, dedent, READS } = require('../src/services/topochain/challenge-anatomy');

test('an interval is one of a fixed list, and blank follows the deployment default', () => {
  assert.deepEqual(rules.INTERVAL_CHOICES, [1, 2, 5, 10, 15, 30, 60]);
  // Every choice is a whole number of beats, so a rule can never say one
  // interval and run on another.
  for (const m of rules.INTERVAL_CHOICES) assert.equal(m % rules.FLOOR_MINUTES, 0);
  assert.equal(rules.effectiveInterval({ intervalMinutes: 2 }, 10), 2);
  assert.equal(rules.effectiveInterval({ intervalMinutes: null }, 10), 10);
  assert.equal(rules.effectiveInterval({}, 10), 10);
  // A value that is not on the list (a hand-written UPDATE) is not honoured.
  assert.equal(rules.effectiveInterval({ intervalMinutes: 3 }, 10), 10);
});

test('a rule is due once its interval has passed, give or take a quarter of a beat', () => {
  const at = (msAgo) => ({ intervalMinutes: 2, lastScoredAt: new Date(NOW - msAgo) });
  assert.equal(rules.isDue({ intervalMinutes: 2 }, { now: NOW, defaultMinutes: 10 }), true, 'never scored is due now');
  assert.equal(rules.isDue(at(1 * MIN), { now: NOW, defaultMinutes: 10 }), false);
  // The beat is a timer and timers drift: 2 ms early must not cost a minute.
  assert.equal(rules.isDue(at(2 * MIN - 2), { now: NOW, defaultMinutes: 10 }), true);
  // A deploy kicks the scorer half a beat before its first real beat. That
  // beat must be clearly NOT due for a one-minute rule, not a coin toss.
  assert.equal(rules.isDue({ intervalMinutes: 1, lastScoredAt: new Date(NOW - MIN / 2) }, { now: NOW, defaultMinutes: 10 }), false);
  assert.equal(rules.isDue(at(2 * MIN), { now: NOW, defaultMinutes: 10 }), true);
  // Blank follows the default, with the same slack.
  assert.equal(rules.isDue({ lastScoredAt: iso(NOW - 9 * MIN) }, { now: NOW, defaultMinutes: 10 }), false);
  assert.equal(rules.isDue({ lastScoredAt: iso(NOW - 10 * MIN) }, { now: NOW, defaultMinutes: 10 }), true);
  assert.equal(rules.nextDueAt(at(1 * MIN), { defaultMinutes: 10 }), NOW + 1 * MIN);
  assert.equal(rules.nextDueAt({ intervalMinutes: 2 }, { defaultMinutes: 10 }), null, 'never run: due now, no time to print');
});

test('with the schedule switched off, no rule is ever due whatever it asks for', () => {
  assert.equal(rules.effectiveInterval({ intervalMinutes: 1 }, 0), null);
  assert.equal(rules.isDue({ intervalMinutes: 1 }, { now: NOW, defaultMinutes: 0 }), false);
  assert.equal(rules.nextDueAt({ intervalMinutes: 1, lastScoredAt: iso(NOW) }, { defaultMinutes: 0 }), null);
});

test('a run takes the SQL-only rules before the graded ones, longest-waiting first', () => {
  const order = [
    { id: 1, measure: 'USEFUL_FEEDBACK', lastScoredAt: iso(NOW - 60 * MIN) },
    { id: 2, measure: 'TRY_APPS', lastScoredAt: iso(NOW - 2 * MIN) },
    { id: 3, measure: 'CONNECT_ACCOUNTS', lastScoredAt: iso(NOW - 9 * MIN) },
    { id: 4, measure: 'PROPOSAL_ACCEPTED', lastScoredAt: null },
    { id: 5, measure: 'PROPOSAL_SENT', lastScoredAt: null },
  ].sort(rules.runOrder).map((r) => r.id);
  // 5 has never run, then 3 has waited longer than 2; only then the two that
  // call a model — so a connected account never waits on a stranger's report
  // being marked, however low the feedback rule's id is.
  assert.deepEqual(order, [5, 3, 2, 4, 1]);
});

// A pool for the cadence tests: several rules at once, the stamps recorded.
function cadencePool({
  ruleRows = [], dueRows = [], candidates = [], feedback = [], lastScheduledRun = null, locked = false,
  ledgerNewer = false,
} = {}) {
  const pool = {
    inserted: [], runStarts: [], runEnds: [], stamps: [], cutShort: [], seen: [],
  };
  const handle = async (sql, params) => {
    pool.seen.push(sql);
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: !locked }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [] };
    if (sql.includes('SET last_scored_at')) { pool.stamps.push({ id: params[0], at: params[1], pass: JSON.parse(params[2]) }); return { rows: [] }; }
    if (sql.includes('UPDATE challenge_scoring_rules SET last_pass')) { pool.cutShort.push({ id: params[0], pass: JSON.parse(params[1]) }); return { rows: [] }; }
    if (sql.includes('JOIN challenges c')) return { rows: ruleRows };
    if (sql.includes('FROM challenge_scoring_rules')) return { rows: dueRows };
    if (sql.includes("trigger = 'schedule'")) return { rows: [{ at: lastScheduledRun }] };
    if (sql.includes("metadata->>'source_key' AS source_key")) return { rows: [] };
    if (sql.includes('FROM app_activity')) return { rows: candidates };
    if (sql.includes('FROM feedback_reports')) return { rows: feedback };
    if (sql.includes('INSERT INTO challenge_scorer_runs')) { pool.runStarts.push(params); return { rows: [{ id: pool.runStarts.length }] }; }
    if (sql.includes('UPDATE challenge_scorer_runs')) { pool.runEnds.push(params); return { rows: [] }; }
    if (sql.includes('INSERT INTO user_activities')) { pool.inserted.push(params); return { rows: [{ id: pool.inserted.length }] }; }
    if (sql.includes('MAX(snapshot_at)')) return { rows: [{ at: new Date(NOW) }] };
    if (sql === scorer.LEDGER_NEWER_SQL) return { rows: [{ newer: ledgerNewer }] };
    return { rows: [] };
  };
  pool.query = handle;
  pool.connect = async () => ({ query: handle, release() {} });
  return pool;
}

const connectRow = (extra = {}) => challengeRow({
  rule_id: 2, rule_name: 'Connect', measure: 'CONNECT_ACCOUNTS', challenge_id: 77,
  metric_target: 2, t_metric_target: 2, t_goal: 'Connect X and GitHub', ...extra,
});

test('the schedule runs only the rules that are due, and stamps them with the time of the run', async () => {
  const pool = cadencePool({ ruleRows: [challengeRow(), connectRow()], candidates: appActivityRows });
  const summary = await scorer.score(pool, { now: NOW, only: new Set([1]) });

  assert.deepEqual(summary.challenges.map((c) => c.rule_id), [1], 'rule 2 is not due, so it is not part of this run');
  assert.equal(pool.inserted.length, 3);
  assert.deepEqual(pool.stamps.map((s) => s.id), [1]);
  // The run's own clock, not the wall clock at the end of the pass: that is
  // what keeps "every 2 minutes" from sliding by the length of each pass.
  assert.equal(pool.stamps[0].at, iso(NOW));
  // What the pass cost is kept on the rule, measured.
  assert.equal(pool.stamps[0].pass.candidates, 3);
  assert.equal(pool.stamps[0].pass.credits, 3);
  assert.equal(typeof pool.stamps[0].pass.ms, 'number');
  assert.equal(summary.challenges[0].candidates, 3);
  assert.equal(typeof summary.challenges[0].ms, 'number');
});

test('Run now covers every rule, whatever the intervals say', async () => {
  const pool = cadencePool({ ruleRows: [challengeRow(), connectRow()], candidates: appActivityRows });
  const summary = await scorer.score(pool, { now: NOW });
  assert.deepEqual(summary.challenges.map((c) => c.rule_id).sort(), [1, 2]);
  assert.deepEqual(pool.stamps.map((s) => s.id).sort(), [1, 2]);
});

test('a pass the run budget cut short is not stamped, so it is due again on the next beat', async () => {
  // 200 people with three apps each is 600 credits; one run writes 500.
  const many = [];
  for (let u = 1; u <= 200; u += 1) {
    for (let a = 1; a <= 3; a += 1) many.push({ user_id: u, app_id: a, app_name: `App ${a}`, last_date: '2026-09-15', seconds: 60 });
  }
  const pool = cadencePool({ ruleRows: [challengeRow(), connectRow()], candidates: many });
  const summary = await scorer.score(pool, { now: NOW, only: new Set([1, 2]) });

  assert.equal(summary.credits, scorer.MAX_CREDITS_PER_RUN);
  // Rule 1 took the whole budget and still had a hundred credits to write;
  // rule 2 was never reached. NEITHER is stamped, so both are due a minute
  // from now rather than an interval from now — and the rule detail is told
  // why the first one stopped.
  assert.equal(pool.stamps.length, 0);
  assert.deepEqual(pool.cutShort.map((c) => c.id), [1]);
  assert.equal(pool.cutShort[0].pass.cut_short, true);
  assert.deepEqual(summary.challenges.map((c) => c.rule_id), [1]);
});

test('a dry run stamps nothing', async () => {
  const pool = cadencePool({ ruleRows: [challengeRow()], candidates: appActivityRows });
  await scorer.score(pool, { now: NOW, dryRun: true });
  assert.equal(pool.stamps.length + pool.cutShort.length, 0);
});

test('a due rule with no live challenge is stamped all the same', async () => {
  // Otherwise it is due on every beat, and every beat becomes a recorded run.
  const pool = cadencePool({ ruleRows: [challengeRow()], candidates: appActivityRows });
  await scorer.score(pool, { now: NOW, only: new Set([1, 9]) });
  assert.deepEqual(pool.stamps.map((s) => s.id).sort(), [1, 9]);
  assert.equal(pool.stamps.find((s) => s.id === 9).pass.idle, 'no live challenge');
});

test('a grader that is down does not turn a graded rule into an every-beat retry', async () => {
  const graded = challengeRow({
    rule_id: 3, rule_name: 'Feedback', measure: 'USEFUL_FEEDBACK', challenge_id: 82,
    metric_target: 4, t_metric_target: 4, reward: '1,000 pts', t_reward: '1,000 pts',
  });
  const pool = cadencePool({
    ruleRows: [graded],
    feedback: [{ id: 5, user_id: 7, created_at: new Date(NOW - HOUR), title: 'Save fails', description: realReport(1), app_name: 'Recipes' }],
  });
  const down = { isEnabled: () => true, gradeChallengeUnit: async () => { throw new Error('529'); } };
  const summary = await scorer.score(pool, { now: NOW, only: new Set([3]), llm: down });
  assert.equal(summary.grading, '529');
  assert.equal(pool.inserted.length, 0, 'nothing is credited at a guess');
  // Stamped: the rest waits on the MODEL, and retries on the rule's interval.
  // Only this service's own budget leaves a rule unstamped.
  assert.deepEqual(pool.stamps.map((s) => s.id), [3]);
});

test('a beat with nothing due is not a run, and records nothing', async () => {
  const pool = cadencePool({
    dueRows: [{ id: 1, measure: 'TRY_APPS', interval_minutes: 10, last_scored_at: new Date(NOW - 3 * MIN) }],
    lastScheduledRun: new Date(NOW - 3 * MIN),
  });
  const result = await scorer.tick(pool, { challengeScorer: { intervalMinutes: 10 } }, { now: NOW });
  assert.deepEqual(result, { idle: true });
  assert.equal(pool.runStarts.length, 0);
  assert.equal(pool.seen.some((sql) => sql.includes('JOIN challenges c')), false, 'it never even reads the challenges');
});

test('a beat runs exactly the due rules', async () => {
  const pool = cadencePool({
    ruleRows: [challengeRow(), connectRow()],
    candidates: appActivityRows,
    dueRows: [
      { id: 1, measure: 'TRY_APPS', interval_minutes: 2, last_scored_at: new Date(NOW - 2 * MIN) },
      { id: 2, measure: 'CONNECT_ACCOUNTS', interval_minutes: null, last_scored_at: new Date(NOW - 2 * MIN) },
    ],
    lastScheduledRun: new Date(NOW - 2 * MIN),
  });
  const result = await scorer.tick(pool, { challengeScorer: { intervalMinutes: 10 } }, { now: NOW });
  assert.equal(result.credits, 3);
  assert.equal(pool.runStarts.length, 1);
  assert.deepEqual(pool.stamps.map((s) => s.id), [1], 'the ten-minute rule was scored two minutes ago and sits this one out');
});

test('a credit-forced refresh restarts the scheduled check clock', () => withBuilder(async (calls) => {
  // The beat was not due a scheduled check, but it wrote credits, so it
  // rebuilt the standings. That rebuild IS the check: the next one is a full
  // interval away rather than on the very next beat.
  const pool = cadencePool({
    ruleRows: [challengeRow()],
    candidates: appActivityRows,
    dueRows: [{ id: 1, measure: 'TRY_APPS', interval_minutes: null, last_scored_at: new Date(NOW - 20 * MIN) }],
    ledgerNewer: true,
  });
  const result = await scorer.tick(pool,
    { challengeScorer: { intervalMinutes: 10 } },
    { now: NOW, lastAggregateCheckAt: NOW - MIN });
  assert.equal(result.credits, 3);
  assert.equal(calls.length, 1);
  assert.equal(result.aggregateCheckedAt, NOW);
}));

test('a quiet stretch still gets one run per default interval', async () => {
  // No rule is due — or there are no rules at all — and the service still has
  // to be seen alive, and the standings still have to be rebuilt.
  const pool = cadencePool({ dueRows: [], lastScheduledRun: new Date(NOW - 10 * MIN) });
  const result = await scorer.tick(pool, { challengeScorer: { intervalMinutes: 10 } }, { now: NOW });
  assert.equal(result.credits, 0);
  assert.equal(pool.runStarts.length, 1);
  assert.equal(pool.runStarts[0][0], 'schedule');
});

test('a beat that cannot take the lock does nothing at all', async () => {
  const pool = cadencePool({ locked: true, dueRows: [{ id: 1, measure: 'TRY_APPS', interval_minutes: 1, last_scored_at: null }] });
  assert.deepEqual(await scorer.tick(pool, { challengeScorer: { intervalMinutes: 10 } }, { now: NOW }), { busy: true });
  assert.equal(pool.runStarts.length, 0);
});

test('only an interval on the list can be saved, and blank means the default', () => {
  assert.equal(parseRuleFields({ interval_minutes: 5 }, { required: false }).fields.interval_minutes, 5);
  assert.equal(parseRuleFields({ interval_minutes: '15' }, { required: false }).fields.interval_minutes, 15);
  assert.equal(parseRuleFields({ interval_minutes: '' }, { required: false }).fields.interval_minutes, null);
  assert.equal(parseRuleFields({ interval_minutes: null }, { required: false }).fields.interval_minutes, null);
  for (const bad of [3, 0, -5, 'soon', 1440]) {
    const { details } = parseRuleFields({ interval_minutes: bad }, { required: false });
    assert.match(details.interval_minutes[0], /must be one of 1, 2, 5, 10, 15, 30, 60 minutes/, String(bad));
  }
});

test('the screen is told each rule\'s interval, when it last ran and when it is next due', async () => {
  currentMockPool = scriptedPool();
  currentMockPool.query = async (sql) => {
    if (sql.includes('LEFT JOIN challenge_templates ct ON ct.id = r.challenge_template_id')) {
      return {
        rows: [
          { id: 1, name: 'Try apps', measure: 'TRY_APPS', challenge_template_id: 23, enabled: true,
            interval_minutes: 2, last_scored_at: new Date(NOW), last_pass: { at: iso(NOW), ms: 12, candidates: 3, credits: 3 } },
          { id: 2, name: 'Connect', measure: 'CONNECT_ACCOUNTS', challenge_template_id: 26, enabled: true,
            interval_minutes: null, last_scored_at: null, last_pass: null },
        ],
      };
    }
    return { rows: [] };
  };
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 902, isAdmin: true, canAdminWrite: true }; next(); });
  app.use(challengeScoringAdminRoutes({ challengeScorer: { intervalMinutes: 10 } }));
  const { server, base } = await listen(app);
  try {
    const body = await (await fetch(`${base}/api/v4/admin/challenge-scoring`)).json();
    const [own, inherited] = body.data.rules;
    assert.equal(own.interval_minutes, 2);
    assert.equal(own.effective_interval_minutes, 2);
    assert.equal(Date.parse(own.next_due_at), NOW + 2 * MIN);
    assert.equal(own.last_pass.ms, 12);
    assert.equal(inherited.interval_minutes, null, 'blank stays blank…');
    assert.equal(inherited.effective_interval_minutes, 10, '…and the screen is told what that means');
    assert.equal(inherited.next_due_at, null);
    // The choices come from the server, so the form cannot offer one the
    // validator then refuses.
    assert.deepEqual(body.data.schedule.interval_choices, rules.INTERVAL_CHOICES);
    assert.equal(body.data.schedule.interval_minutes, 10);
  } finally { server.close(); }
});

// ─── How it scores: the panel cannot drift from the scorer ─────────────
//
// The admin's rule detail prints the statement a rule executes, the rubric a
// model is sent and the limits a run is held to. Each is taken from the code
// that runs; these hold them there.

test('the statement printed for a measure is the statement the scorer executes', async () => {
  for (const measure of rules.MEASURE_KEYS) {
    const seen = [];
    const pool = { async query(sql) { seen.push(sql); return { rows: [] }; } };
    await scorer.loadCandidates(pool, measure, { startMs: NOW - DAY, endMs: NOW + DAY }, { target: 3 });
    assert.equal(seen.length, 1, measure);
    assert.equal(seen[0], scorer.MEASURE_SQL[measure], `${measure}: MEASURE_SQL is what loadCandidates runs`);
    const read = anatomy(measure, { points: 1000, target: 4 }).steps[0];
    assert.equal(read.kind, 'read');
    // Printed without the indentation the module gives it, and otherwise the
    // same statement token for token.
    assert.equal(read.sql, dedent(scorer.MEASURE_SQL[measure]));
    assert.equal(read.sql.replace(/\s+/g, ' '), scorer.MEASURE_SQL[measure].trim().replace(/\s+/g, ' '));
    assert.match(read.sql, /^SELECT /, 'the first line is flush left, like the rest');
    // Every table it names is really in the statement.
    for (const table of read.tables) assert.match(read.sql, new RegExp(`\\b${table}\\b`), `${measure} reads ${table}`);
  }
});

test('the source key printed for a measure is the key its credits really carry', async () => {
  const row = {
    user_id: 7, app_id: 3, app_name: 'Notes', last_date: '2026-09-15', seconds: 900, session_id: 11,
    promoted_at: new Date(NOW), event_id: 12, created_at: new Date(NOW), id: 13, provider: 'x',
    linked_at: new Date(NOW), at: new Date(NOW),
    // VOTE_CAST names the proposal or request voted on (#3569).
    kind: 'pr', ref_id: 14,
  };
  for (const measure of rules.MEASURE_KEYS) {
    const pool = { async query() { return { rows: [row] }; } };
    const [candidate] = await scorer.loadCandidates(pool, measure, { startMs: NOW - DAY, endMs: NOW + DAY }, { target: 3 });
    assert.ok(candidate.sourceKey.startsWith(READS[measure].key), `${measure}: ${candidate.sourceKey}`);
    const paid = anatomy(measure, { points: 1000, target: 4 }).steps.find((s) => s.kind === 'paid');
    assert.ok(paid.text.includes(READS[measure].keyLabel));
    assert.equal(paid.sql, dedent(scorer.CREDITED_SQL));
  }
});

test('the rubric, the model and the input limits printed are the ones the grader sends', async () => {
  const shown = anatomy('USEFUL_FEEDBACK', { points: 1000, target: 4 });
  const step = shown.steps.find((s) => s.kind === 'grade');
  assert.equal(shown.lane, 'sql_model');
  assert.equal(step.model, grader.GRADE_MODEL);
  assert.equal(step.rubric, grader.RUBRICS.USEFUL_FEEDBACK.system(250), 'called with the rule\'s own per-unit ceiling');
  assert.ok(step.text.includes('from 1 to 250'));
  assert.ok(step.text.includes(`at most ${scorer.MAX_GRADES_PER_RUN} in a run`));

  let sent = null;
  const engine = { isEnabled: () => true, gradeChallengeUnit: async (args) => { sent = args; return { score: 100, reason: 'ok', model: args.model }; } };
  await grader.grade({
    measure: 'USEFUL_FEEDBACK', max: 250, llm: engine,
    input: { title: 't'.repeat(999), text: 'x'.repeat(9999) },
  });
  assert.equal(sent.model, grader.GRADE_MODEL);
  assert.equal(sent.system, step.rubric);
  assert.ok(sent.user.includes('x'.repeat(grader.GRADE_TEXT_CHARS)) && !sent.user.includes('x'.repeat(grader.GRADE_TEXT_CHARS + 1)));
  assert.ok(sent.user.includes('t'.repeat(grader.GRADE_TITLE_CHARS)) && !sent.user.includes('t'.repeat(grader.GRADE_TITLE_CHARS + 1)));
  assert.ok(step.text.includes('first 200 characters') && step.text.includes('first 2,000'));

  // The transport's default names the same model, for a caller that passes
  // none, and its fallback is the one the panel names beside it.
  const llm = require('../src/services/llm');
  const llmSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/services/llm.js'), 'utf8');
  assert.match(llmSource, /gradeChallengeUnit\(\{[^)]*model = HELPER_MODEL/);
  assert.equal(llm.HELPER_MODEL, grader.GRADE_MODEL);
  assert.equal(llm.HELPER_FALLBACK_MODEL, grader.GRADE_FALLBACK_MODEL);
  assert.ok(step.text.includes(`${grader.GRADE_FALLBACK_MODEL} when it does not answer in time`));
});

test('a measure that calls no model says so, and only feedback has a junk filter', () => {
  // Both feedback measures since #3568: FEEDBACK_SENT reads the same reports
  // ungraded, through the same filter. The panel keys on the `screened` flag
  // the scorer runs the filter by, so the two cannot disagree.
  assert.deepEqual(rules.MEASURE_KEYS.filter((m) => rules.MEASURES[m].screened === true),
    ['USEFUL_FEEDBACK', 'FEEDBACK_SENT']);
  for (const measure of rules.MEASURE_KEYS) {
    const shown = anatomy(measure, { points: 1000, target: 4 });
    const kinds = shown.steps.map((s) => s.kind);
    const graded = rules.MEASURES[measure].graded === true;
    assert.equal(shown.lane, graded ? 'sql_model' : 'sql', measure);
    assert.equal(kinds.includes('grade'), graded, measure);
    assert.equal(kinds.includes('filter'), rules.MEASURES[measure].screened === true, measure);
    assert.deepEqual([kinds[0], kinds[kinds.length - 1]], ['read', 'write'], measure);
  }
  const filter = anatomy('USEFUL_FEEDBACK', {}).steps.find((s) => s.kind === 'filter');
  assert.ok(filter.text.includes(`under ${grader.MIN_FEEDBACK_CHARS} characters`));
  // No numbers yet (a new rule, nothing picked): steps still render, and the
  // rubric waits rather than being printed for a ceiling nobody chose.
  const bare = anatomy('USEFUL_FEEDBACK', {}).steps.find((s) => s.kind === 'grade');
  assert.equal(bare.rubric, null);
  assert.equal(anatomy('NOPE', {}), null);
});

test('how a rule scores is readable by a view-only admin, and only for a real measure', async () => {
  currentMockPool = scriptedPool();
  const { server, base } = await listen(buildApp('readonly'));
  try {
    const res = await fetch(`${base}/api/v4/admin/challenge-scoring/anatomy?measure=PROPOSAL_ACCEPTED&points=1000&target=2`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.lane, 'sql_model');
    assert.equal(body.data.steps.find((s) => s.kind === 'grade').rubric, grader.RUBRICS.PROPOSAL_ACCEPTED.system(500));
    assert.equal((await fetch(`${base}/api/v4/admin/challenge-scoring/anatomy?measure=DROP_TABLE`)).status, 404);
  } finally { server.close(); }
});

test('the rule panel shows how it scores in full, and the list only says how often', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/admin/topochain/challenge-scoring.tsx'), 'utf8');
  const form = src.slice(src.indexOf('function RuleForm('), src.indexOf('function ChallengeScoringScreen('));
  const screen = src.slice(src.indexOf('function ChallengeScoringScreen('));
  // In the rule's own panel, rendered outright — not in the overview, and not
  // behind a toggle (owner decision, 2026-09-17).
  assert.equal((src.match(/<HowItScores /g) || []).length, 1);
  assert.ok(form.includes('<HowItScores '));
  assert.equal(screen.includes('HowItScores'), false);
  const panel = src.slice(src.indexOf('function HowItScores('), src.indexOf('// The rule, read back as a sentence'));
  assert.equal(/<details|useState|onClick/.test(panel), false, 'nothing in it opens or closes');
  // The overview's part is the interval.
  assert.match(screen, /label: 'Runs', cell: \(r\) => <RunsCell /);
  // The choices are the server's, so the form cannot offer one the validator refuses.
  assert.ok(form.includes('schedule?.interval_choices'));
  assert.equal(/\[\s*1,\s*2,\s*5/.test(src), false, 'no second copy of the list in the client');
  // A view-only admin reads the same panel with the fields switched off.
  assert.ok(src.includes('<fieldset disabled={readOnly}'));
  assert.ok(screen.includes('readOnly={!write}'));
});

test('the schema carries the cadence columns', () => {
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE challenge_scoring_rules ADD COLUMN IF NOT EXISTS interval_minutes INTEGER/);
  assert.match(schema, /ALTER TABLE challenge_scoring_rules ADD COLUMN IF NOT EXISTS last_scored_at TIMESTAMPTZ/);
  assert.match(schema, /ALTER TABLE challenge_scoring_rules ADD COLUMN IF NOT EXISTS last_pass JSONB/);
});

// ─── What a participant's card says about the schedule (#3185) ─────────
//
// Progress on a scored challenge moves only when a run writes credits, so the
// card says how often that is and when it last happened. The rule it states
// must be one that really scores the challenge now: a card that promised an
// update the scorer is not going to make would be worse than no line.

const cadenceRule = (extra = {}) => rule({ intervalMinutes: 15, lastScoredAt: iso(NOW - 5 * MIN), ...extra });

test('a card is told its rule\'s interval and when it last ran to its end', () => {
  assert.deepEqual(rules.cadenceOf([cadenceRule()], challengeRow(), { now: NOW, defaultMinutes: 10 }),
    { intervalMinutes: 15, lastScoredAt: NOW - 5 * MIN });
  assert.equal(rules.cadenceOf([cadenceRule({ intervalMinutes: null })], challengeRow(), { now: NOW, defaultMinutes: 10 })
    .intervalMinutes, 10, 'blank follows the deployment default, as the scheduler does');
  assert.equal(rules.cadenceOf([cadenceRule({ intervalMinutes: 3 })], challengeRow(), { now: NOW, defaultMinutes: 10 })
    .intervalMinutes, 10, 'an interval off the list is not the one it runs on');
});

test('a card is told nothing the scorer is not going to do', () => {
  const at = { now: NOW, defaultMinutes: 10 };
  assert.equal(rules.cadenceOf([], challengeRow(), at), null, 'no rule counts it');
  assert.equal(rules.cadenceOf(undefined, challengeRow(), at), null);
  assert.equal(rules.cadenceOf([cadenceRule()], challengeRow(), { now: NOW, defaultMinutes: 0 }), null,
    'the schedule is switched off');
  assert.equal(rules.cadenceOf([cadenceRule({ lastScoredAt: null })], challengeRow(), at), null,
    'never run yet: due on the next beat, no time to print');
  assert.equal(rules.cadenceOf([cadenceRule({ enabled: false })], challengeRow(), at), null, 'rule switched off');
  assert.equal(rules.cadenceOf([cadenceRule()], challengeRow({ completed: true }), at), null, 'challenge closed');
  assert.equal(rules.cadenceOf([cadenceRule()], challengeRow({ schedule_start: iso(NOW + DAY) }), at), null,
    'window not open yet');
  assert.equal(rules.cadenceOf([cadenceRule()], challengeRow({ reward: 'Up to 500 pts / app', t_reward: null }), at), null,
    'a rule the scorer skips as misconfigured');
});

test('two rules on one challenge: the shorter interval and the more recent pass', () => {
  const both = [
    cadenceRule({ id: 1, intervalMinutes: 30, lastScoredAt: iso(NOW - 2 * MIN) }),
    cadenceRule({ id: 2, intervalMinutes: 5, lastScoredAt: iso(NOW - 4 * MIN) }),
  ];
  assert.deepEqual(rules.cadenceOf(both, challengeRow(), { now: NOW, defaultMinutes: 10 }),
    { intervalMinutes: 5, lastScoredAt: NOW - 2 * MIN });
  const oneSkipped = [both[0], { ...both[1], enabled: false }];
  assert.deepEqual(rules.cadenceOf(oneSkipped, challengeRow(), { now: NOW, defaultMinutes: 10 }),
    { intervalMinutes: 30, lastScoredAt: NOW - 2 * MIN }, 'a rule that does not score it says nothing');
});

test('the challenge list reads every card\'s cadence in one query, and none with the schedule off', async () => {
  const calls = [];
  const ruleRows = [
    // Bound to challenge 74's template: covers it.
    { id: 1, measure: 'TRY_APPS', target: null, points: null, challenge_id: null, challenge_template_id: 5,
      interval_minutes: 15, last_scored_at: new Date(NOW - 5 * MIN),
      event_starts_at: new Date(NOW - 10 * DAY), event_ends_at: new Date(NOW + 10 * DAY) },
    // Bound to challenge 75 itself, but its reward is prose: skipped, so no line.
    { id: 2, measure: 'PROPOSAL_SENT', target: null, points: null, challenge_id: 75, challenge_template_id: null,
      interval_minutes: null, last_scored_at: new Date(NOW - MIN),
      event_starts_at: new Date(NOW - 10 * DAY), event_ends_at: new Date(NOW + 10 * DAY) },
  ];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: ruleRows }; } };
  const rows = [
    challengeRow({ id: 74, challenge_template_id: 5 }),
    challengeRow({ id: 75, challenge_template_id: 6, reward: 'Half of your credits', t_reward: null }),
    challengeRow({ id: 76, challenge_template_id: 7 }),
  ];
  const out = await scorer.loadCadence(pool, 10, rows, { defaultMinutes: 10, now: NOW });
  assert.equal(calls.length, 1, 'one read for the whole list');
  assert.deepEqual(calls[0].params, [10, [74, 75, 76], [5, 6, 7]]);
  assert.equal(calls[0].sql, scorer.CADENCE_RULES_SQL);
  assert.deepEqual([...out.keys()], [74], 'only the challenges something counts');
  assert.deepEqual(out.get(74), { intervalMinutes: 15, lastScoredAt: NOW - 5 * MIN });

  // A challenge with no dates of its own takes its window from the event the
  // query read beside the rules.
  const undated = challengeRow({ id: 74, challenge_template_id: 5, schedule_start: null, schedule_end: null });
  const future = [{ ...ruleRows[0], event_starts_at: new Date(NOW + DAY) }];
  const quiet = { query: async () => ({ rows: future }) };
  assert.equal((await scorer.loadCadence(quiet, 10, [undated], { defaultMinutes: 10, now: NOW })).size, 0,
    'an event that has not started is not being counted');

  calls.length = 0;
  assert.equal((await scorer.loadCadence(pool, 10, rows, { defaultMinutes: 0, now: NOW })).size, 0);
  assert.equal((await scorer.loadCadence(pool, 10, [], { defaultMinutes: 10, now: NOW })).size, 0);
  assert.equal(calls.length, 0, 'the schedule off, or nothing listed: Postgres is not asked');
});

// #3253, #3248: the page says what a rule counts — that a proposal counts
// once it is put to the vote, and that a counted measure stops at its target —
// so the read names the measure and, for a counted one, that target. Unlike
// the cadence it does not wait for a first run.
test('countedByOf names the scoring rule\'s measure, and the cap a counted measure stops at', () => {
  const at = { now: NOW, defaultMinutes: 10 };
  assert.deepEqual(rules.countedByOf([rule({ measure: 'PROPOSAL_SENT' })], challengeRow(), at),
    { measure: 'PROPOSAL_SENT', target: null }, 'one is enough: no cap to state');
  assert.deepEqual(rules.countedByOf([rule({ measure: 'PROPOSAL_ACCEPTED', target: 2 })], challengeRow(), at),
    { measure: 'PROPOSAL_ACCEPTED', target: 2 }, 'the rule\'s own target is where crediting stops');
  assert.deepEqual(rules.countedByOf([rule({ measure: 'PROPOSAL_SENT', lastScoredAt: null })], challengeRow(), at),
    { measure: 'PROPOSAL_SENT', target: null }, 'known before the first run');
  assert.equal(rules.countedByOf([], challengeRow(), at), null);
  assert.equal(rules.countedByOf([rule({ enabled: false })], challengeRow(), at), null, 'rule switched off');
  assert.equal(rules.countedByOf([rule()], challengeRow({ completed: true }), at), null, 'challenge closed');
  assert.equal(rules.countedByOf([rule()], challengeRow(), { now: NOW, defaultMinutes: 0 }), null, 'schedule off');
  assert.deepEqual(rules.countedByOf([rule({ enabled: false }), rule({ id: 2, measure: 'PROPOSAL_SENT' })], challengeRow(), at),
    { measure: 'PROPOSAL_SENT', target: null }, 'the first rule that scores it');
});

test('the list read returns the measure beside the cadence, from one query', async () => {
  const ruleRows = [
    { id: 1, measure: 'PROPOSAL_ACCEPTED', target: 2, points: null, challenge_id: 74, challenge_template_id: null,
      interval_minutes: 15, last_scored_at: null,
      event_starts_at: new Date(NOW - 10 * DAY), event_ends_at: new Date(NOW + 10 * DAY) },
  ];
  let calls = 0;
  const pool = { query: async () => { calls += 1; return { rows: ruleRows }; } };
  const out = await scorer.loadRuleFacts(pool, 10, [challengeRow({ id: 74 })], { defaultMinutes: 10, now: NOW });
  assert.equal(calls, 1);
  assert.equal(out.cadence.size, 0, 'never run: no cadence line yet');
  assert.deepEqual(out.countedBy.get(74), { measure: 'PROPOSAL_ACCEPTED', target: 2 });
});

test('the cadence read is scoped the way the scorer\'s own is', () => {
  const sql = scorer.CADENCE_RULES_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /^ \/\* challenge scoring cadence \*\//, 'labelled, so a scripted pool can answer it');
  assert.match(sql, /WHERE r\.enabled = TRUE/, 'a switched-off rule counts nothing');
  assert.match(sql, /r\.challenge_id = ANY\(\$2::bigint\[\]\) OR r\.challenge_template_id = ANY\(\$3::bigint\[\]\)/,
    'both bindings, the list\'s own challenges and templates');
  assert.match(sql, /se\.is_active = TRUE AND COALESCE\(s\.is_active, FALSE\) = TRUE/,
    'the live events RULE_CHALLENGES_SQL scores, and no others');
  assert.match(scorer.RULE_CHALLENGES_SQL.replace(/\s+/g, ' '), /se\.is_active = TRUE AND COALESCE\(s\.is_active, FALSE\) = TRUE/);
});

// ─── The community measures ────────────────────────────────────────────
//
// Season 2's "Find people to build with", "Build for your community" and
// "Invite 3 people". The first two are state (a membership or a project from
// before the season counts); the third counts people, 250 pts each.

test('"Invite 3 people" pays 250 a person and stops at the third', () => {
  const row = challengeRow({
    measure: 'INVITES_JOINED', metric_target: 3, t_metric_target: 3,
    reward: 'Up to 750 pts', t_reward: 'Up to 750 pts', t_category: 'PERSISTENT',
  });
  const plan = rules.planCredits(rule({ measure: 'INVITES_JOINED' }), row, {
    candidates: [candidate(7, 'invitee:21'), candidate(7, 'invitee:22'), candidate(7, 'invitee:23'), candidate(7, 'invitee:24')],
    now: NOW,
  });
  assert.deepEqual(plan.map((c) => c.points), [250, 250, 250]);
  assert.equal(plan.every((c) => c.completion === false), true, 'three people are three rows, not a completion');
  assert.equal(rules.skipReason(rule({ measure: 'INVITES_JOINED' }), row, { now: NOW }), null);
});

test('joining a community and making an app for one are single state credits', () => {
  for (const measure of ['COMMUNITY_JOINED', 'COMMUNITY_APP_CREATED']) {
    const spec = rules.MEASURES[measure];
    assert.equal(spec.windowed, false, `${measure} is state`);
    assert.equal(spec.counted, false, measure);
    const plan = rules.planCredits(rule({ measure }), challengeRow({
      measure, metric_target: null, t_metric_target: null, reward: '500 pts', t_reward: '500 pts',
    }), { candidates: [candidate(7, 'community', iso(NOW - 90 * DAY))], now: NOW });
    assert.equal(plan.length, 1, `${measure}: a membership from before the season counts`);
    assert.equal(plan[0].completion, true);
    assert.equal(plan[0].points, 500);
  }
});

test('the community audience test is the Workshop\'s: never "Just you", never the platform\'s own project', () => {
  const communities = require('../src/services/communities');
  const flat = (s) => s.replace(/\s+/g, ' ');
  // The same three branches audienceSql derives 'open' and 'invited' from.
  const audience = flat(communities.audienceSql('a', 'x'));
  assert.match(audience, /a\.view_visibility = 'public'/);
  assert.match(audience, /ic\.status = 'invited'/);
  for (const measure of ['COMMUNITY_JOINED', 'COMMUNITY_APP_CREATED']) {
    const sql = flat(scorer.MEASURE_SQL[measure]);
    assert.match(sql, /a\.self_hosted = FALSE/, `${measure}: the platform's project is everyone's, not a choice`);
    assert.match(sql, /a\.status NOT IN \('creating', 'failed', 'deleted'\)/, `${measure}: a project that never got built is nobody's community`);
    assert.match(sql, /a\.view_visibility = 'public'/, measure);
    assert.match(sql, /\) > 1/, `${measure}: a private project counts once somebody else is in it`);
    assert.match(sql, /ic\.app_id = a\.id AND ic\.status = 'invited'/, `${measure}: or somebody is invited`);
  }
  assert.match(flat(scorer.MEASURE_SQL.COMMUNITY_JOINED), /m\.source <> 'auto'/,
    'being put in by the platform is not joining');
});

test('an invitee counts once, for the first invite they took inside the window, and only once they joined', async () => {
  const sql = scorer.MEASURE_SQL.INVITES_JOINED.replace(/\s+/g, ' ');
  assert.match(sql, /x\.status = 'joined' AND x\.applied_at IS NOT NULL/, 'a queued person has not joined yet');
  assert.match(sql, /c\.status = 'member' AND c\.invited_by IS NOT NULL AND c\.accepted_at IS NOT NULL/,
    'a pending username or email invite is not a person who came');
  assert.match(sql, /DISTINCT ON \(t\.invitee_id\)/);
  assert.match(sql, /ORDER BY t\.invitee_id ASC, t\.at ASC/, 'the earliest invite names the one inviter');
  assert.match(sql, /t\.inviter_id <> t\.invitee_id/);
  const dedupAt = sql.indexOf('ORDER BY t.invitee_id ASC');
  const windowAt = sql.indexOf('AND t.at >= $1 AND t.at <= $2');
  assert.ok(windowAt !== -1 && windowAt < dedupAt,
    'the window narrows the invite rows before the first one is picked (#4048)');
  assert.ok(!/\bWHERE f\.at\b/.test(sql), 'the outer query does not filter the window a second time');

  const seen = [];
  const pool = {
    async query(text, params) {
      seen.push(params);
      return { rows: [{ user_id: 7, invitee_id: 21, at: new Date(NOW - HOUR), invitee_username: 'ana' },
        { user_id: 7, invitee_id: 22, at: new Date(NOW - HOUR), invitee_username: null }] };
    },
  };
  const out = await scorer.loadCandidates(pool, 'INVITES_JOINED', { startMs: NOW - DAY, endMs: NOW + DAY }, { target: 3 });
  assert.deepEqual(seen[0].slice(0, 2), [iso(NOW - DAY), iso(NOW + DAY)], 'windowed: from the challenge\'s own start');
  assert.deepEqual(out.map((c) => c.sourceKey), ['invitee:21', 'invitee:22']);
  assert.deepEqual(out.map((c) => c.description), ['@ana joined by your invite', 'Somebody joined by your invite']);
});

test('a join through a later invite inside the window credits that inviter (#4048)', async () => {
  const sql = scorer.MEASURE_SQL.INVITES_JOINED.replace(/\s+/g, ' ');
  // A fake pool that evaluates the scenario in JS the way the SQL does:
  // one row per record of an invite taken, the window applied before or
  // after the one-row-per-invitee pick exactly where the SQL text puts it,
  // then the earliest row per invitee credits its inviter.
  const windowAt = sql.indexOf('AND t.at >= $1 AND t.at <= $2');
  assert.ok(windowAt !== -1 && windowAt < sql.indexOf('ORDER BY t.invitee_id'),
    'the SQL narrows the invite rows to the window before it picks one per person');
  assert.ok(!/\bWHERE f\.at\b/.test(sql), 'the outer query does not filter the window a second time');
  const inside = windowAt !== -1 && windowAt < sql.indexOf('ORDER BY t.invitee_id');
  const poolFor = (rows) => ({
    async query(text, params) {
      const inWindow = (r) => r.at >= new Date(params[0]) && r.at <= new Date(params[1]);
      let picked = rows.filter((r) => r.inviter_id !== r.invitee_id);
      if (inside) picked = picked.filter(inWindow);
      picked.sort((a, b) => a.invitee_id - b.invitee_id || a.at - b.at || a.inviter_id - b.inviter_id);
      const first = new Map();
      for (const r of picked) if (!first.has(r.invitee_id)) first.set(r.invitee_id, r);
      let out = [...first.values()]
        .map((r) => ({ user_id: r.inviter_id, invitee_id: r.invitee_id, at: r.at, invitee_username: null }));
      if (!inside) out = out.filter(inWindow);
      out.sort((a, b) => a.user_id - b.user_id || a.at - b.at || a.invitee_id - b.invitee_id);
      return { rows: out.slice(0, params[2]) };
    },
  });
  const rows = [
    { inviter_id: 5, invitee_id: 21, at: new Date(NOW - 90 * DAY) }, // ana's first invite ever, before the window
    { inviter_id: 7, invitee_id: 21, at: new Date(NOW - HOUR) },     // she took the reporter's invite inside it
    { inviter_id: 5, invitee_id: 23, at: new Date(NOW - 90 * DAY) }, // his only invite ever: before the window
  ];
  const out = await scorer.loadCandidates(poolFor(rows), 'INVITES_JOINED', { startMs: NOW - DAY, endMs: NOW + DAY }, { target: 3 });
  assert.deepEqual(out.map((c) => [c.userId, c.sourceKey, c.activityAt]), [[7, 'invitee:21', iso(NOW - HOUR)]],
    'the in-window join credits the reporter, and the person whose only invite predates the window credits nobody');
  const onlyBefore = await scorer.loadCandidates(poolFor([rows[2]]), 'INVITES_JOINED', { startMs: NOW - DAY, endMs: NOW + DAY }, { target: 3 });
  assert.deepEqual(onlyBefore, [], 'a person whose every invite was taken before the window still yields nothing');
});

test('the two state measures credit once each, under a fixed key, whenever the state began', async () => {
  const pool = {
    async query(text) {
      if (text === scorer.MEASURE_SQL.COMMUNITY_JOINED) return { rows: [{ user_id: 7, joined_at: new Date(NOW - 90 * DAY) }] };
      if (text === scorer.MEASURE_SQL.COMMUNITY_APP_CREATED) return { rows: [{ user_id: 7, created_at: null }] };
      return { rows: [] };
    },
  };
  const joined = await scorer.loadCandidates(pool, 'COMMUNITY_JOINED', { startMs: NOW - DAY, endMs: NOW + DAY }, {});
  assert.deepEqual(joined.map((c) => [c.userId, c.sourceKey, c.description]), [[7, 'community', 'Joined a community']]);
  assert.equal(joined[0].activityAt, iso(NOW - 90 * DAY), 'a membership from before the season keeps its own date');
  const made = await scorer.loadCandidates(pool, 'COMMUNITY_APP_CREATED', { startMs: NOW - DAY, endMs: NOW + DAY }, {});
  assert.deepEqual(made.map((c) => [c.userId, c.sourceKey, c.description]), [[7, 'community-app', 'Created an app for a community']]);
  assert.ok(made[0].activityAt, 'a missing date still stamps the credit');
});

// ─── Counting a join on the spot (#3564) ───────────────────────────────
//
// "Find people to build with" read "Not started" after a join because the
// measure was only taken on the rule's next scheduled pass. The doors now
// run the two community state measures themselves (scoreOnJoin); the
// behaviour is proven against a real database in
// tests/challenge-join-scoring-postgres.test.js, and these pin the parts a
// later edit could quietly undo.

test('a join runs only the community STATE measures, which are race-free without the lock', () => {
  assert.deepEqual([...scorer.JOIN_MEASURES], ['COMMUNITY_JOINED', 'COMMUNITY_APP_CREATED']);
  for (const measure of scorer.JOIN_MEASURES) {
    const spec = rules.MEASURES[measure];
    // Outside the tick's advisory lock, only a single completion under a
    // fixed key is safe: the completion index refuses the racing copy. A
    // counted measure's cap is enforced by the plan, which needs the lock.
    assert.equal(spec.counted, false, `${measure}: one completion, never a count`);
    assert.equal(spec.graded, false, `${measure}: no model call on somebody's Join tap`);
    assert.equal(spec.windowed, false, `${measure}: state, so a join before the season counts too`);
  }
  assert.ok(!scorer.JOIN_MEASURES.includes('INVITES_JOINED'), 'the counted invite measure waits for the locked schedule');
  // #3568/#3569/#3570 made the join's pass one door of scoreOn; the rule
  // lookup it starts with is the shared one, renamed for that.
  const sql = scorer.ON_THE_SPOT_RULES_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /WHERE enabled = TRUE AND measure = ANY\(\$1::text\[\]\)/, 'a switched-off rule is not run on a join');
  // Said where the operator picks the interval: for these two it is the
  // backstop, and for every other measure nothing changed.
  for (const measure of rules.MEASURE_KEYS) {
    const { cost } = anatomy(measure, { points: 1000, target: 4 });
    assert.equal(cost.includes('A join also runs it on the spot'), scorer.JOIN_MEASURES.includes(measure), measure);
  }
});

test('scoreOnJoin is a no-op when scoring is off, and never throws into the join', async () => {
  const seen = [];
  const quiet = { async query(text) { seen.push(text); return { rows: [] }; } };
  assert.equal(await scorer.scoreOnJoin(quiet, { challengeScorer: { intervalMinutes: 0 } }), null);
  assert.equal(seen.length, 0, 'interval 0 asks Postgres nothing');
  assert.equal(await scorer.scoreOnJoin(quiet, { challengeScorer: { intervalMinutes: 10 } }), null);
  assert.deepEqual(seen, [scorer.ON_THE_SPOT_RULES_SQL], 'no rule on either measure: one read, then nothing');
  const failing = { async query() { throw new Error('boom'); } };
  assert.equal(await scorer.scoreOnJoin(failing, { challengeScorer: { intervalMinutes: 10 } }), null);
});

test('every door a person joins a community through counts the join before it answers', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const doors = {
    // The Join button (Discover, a project's page).
    'src/routes/apps.js': /await communities\.join\(pool, app, req\.user\.id\);\s*(?:\/\/[^\n]*\n\s*)*await challengeScorer\.scoreOnJoin\(pool, config\);/,
    // The join screen, once for the whole answer.
    'src/routes/onboarding.js': /if \(result\.joined\.length\) await challengeScorer\.scoreOnJoin\(pool, config\);/,
    // An invite link followed while signed in, and one carried through sign-up.
    'src/routes/community-invites.js': /if \(result\.status === 'joined'\) await challengeScorer\.scoreOnJoin\(pool, config\);/,
    'src/routes/auth.js': /if \(invite && invite\.status === 'joined'\) await challengeScorer\.scoreOnJoin\(pool, config\);/,
    // A collaborator invite accepted.
    'src/routes/collaborators.js': /if \(!result\.alreadyMember\) await challengeScorer\.scoreOnJoin\(pool, config\);/,
  };
  for (const [file, pattern] of Object.entries(doors)) {
    const src = read(file);
    assert.match(src, /require\('\.\.\/services\/topochain\/challenge-scorer'\)/, file);
    assert.match(src, pattern, `${file} counts the join on the spot`);
  }
});

// ─── Weekly challenges: the cap starts again every Monday 00:00 UTC ──────
//
// "Up to 2 count each week" used to be up to 2 per challenge ROW, and Season
// 2 runs each weekly challenge as one row for the whole season, so the
// pre-season week's credits capped people for the rest of it.

test('a week starts on Monday 00:00 UTC', () => {
  const at = (s) => rules.weekStartMs(Date.parse(s));
  assert.equal(at('2026-10-05T00:00:00Z'), Date.parse('2026-10-05T00:00:00Z'), 'Monday midnight starts its own week');
  assert.equal(at('2026-10-04T23:59:59Z'), Date.parse('2026-09-28T00:00:00Z'), 'Sunday night is the week before');
  assert.equal(at('2026-10-07T13:00:00Z'), Date.parse('2026-10-05T00:00:00Z'));
  assert.equal(rules.isWeekly({ t_category: 'WEEKLY' }), true);
  assert.equal(rules.isWeekly({ category: ' weekly ' }), true);
  assert.equal(rules.isWeekly({ t_category: 'PERSISTENT' }), false);
});

test('a weekly challenge is scored this week, and last week only while its grace lasts', () => {
  const window = { startMs: Date.parse('2026-09-22T22:00:00Z'), endMs: Date.parse('2026-12-31T22:59:00Z'), open: true };
  const wed = rules.weeklyWindows(window, { now: Date.parse('2026-10-07T12:00:00Z') });
  assert.deepEqual(wed.map((w) => [iso(w.startMs), iso(w.endMs)]),
    [['2026-10-05T00:00:00.000Z', '2026-10-11T23:59:59.999Z']], 'midweek: this week alone');
  const mon = rules.weeklyWindows(window, { now: Date.parse('2026-10-05T03:00:00Z') });
  assert.deepEqual(mon.map((w) => iso(w.startMs)), ['2026-09-28T00:00:00.000Z', '2026-10-05T00:00:00.000Z'],
    'early Monday: last week too, so a Sunday-night action is still paid');
  // Clipped to the challenge: a start of 5 Oct means last week is never scored.
  const fromMonday = rules.weeklyWindows({ ...window, startMs: Date.parse('2026-10-05T00:00:00Z') }, { now: Date.parse('2026-10-05T03:00:00Z') });
  assert.deepEqual(fromMonday.map((w) => iso(w.startMs)), ['2026-10-05T00:00:00.000Z']);
});

const weeklyRow = (extra = {}) => challengeRow({
  measure: 'PROPOSAL_ACCEPTED', metric_target: 2, t_metric_target: 2, reward: 'Up to 1,000 pts',
  t_reward: 'Up to 1,000 pts', t_category: 'WEEKLY',
  schedule_start: '2026-09-22T22:00:00Z', schedule_end: '2026-12-31T22:59:00Z', ...extra,
});
const credits = (entries) => {
  const map = new Map();
  for (const [userId, key, at] of entries) {
    const state = map.get(userId) || { keys: new Set(), count: 0, weeks: new Map() };
    state.keys.add(key);
    state.count += 1;
    const week = rules.weekStartMs(Date.parse(at));
    state.weeks.set(week, (state.weeks.get(week) || 0) + 1);
    map.set(userId, state);
  }
  return map;
};

test('the weekly cap counts only the candidate’s own week', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  // Two accepted last week: capped then, free again now.
  const held = credits([[17, 'merged:1', '2026-09-30T10:00:00Z'], [17, 'merged:2', '2026-10-01T10:00:00Z']]);
  const plan = rules.planCredits(rule({ measure: 'PROPOSAL_ACCEPTED' }), weeklyRow(), {
    candidates: [
      candidate(17, 'merged:3', '2026-10-05T09:00:00Z'),
      candidate(17, 'merged:4', '2026-10-06T09:00:00Z'),
      candidate(17, 'merged:5', '2026-10-07T09:00:00Z'),
    ],
    credited: held, now,
  });
  assert.deepEqual(plan.map((c) => c.sourceKey), ['merged:3', 'merged:4'], 'two this week, the third waits for Monday');
  assert.ok(plan.every((c) => c.points === 500 && c.completion === false));

  // The same credits on a challenge that is not weekly still cap it for good.
  const persistent = rules.planCredits(rule({ measure: 'PROPOSAL_ACCEPTED' }), weeklyRow({ t_category: 'PERSISTENT' }), {
    candidates: [candidate(17, 'merged:3', '2026-10-05T09:00:00Z')], credited: held, now,
  });
  assert.equal(persistent.length, 0);
});

test('a one-off measure on a weekly challenge pays every week, and never as THE completion', () => {
  const row = weeklyRow({ measure: 'USE_APPS_MINUTES', metric_target: null, t_metric_target: null, reward: '1,000 pts', t_reward: '1,000 pts' });
  const r = rule({ measure: 'USE_APPS_MINUTES', target: 10 });
  const now = Date.parse('2026-10-07T12:00:00Z');
  const held = credits([[7, 'window:2026-09-28', '2026-10-02T12:00:00Z']]);
  const plan = rules.planCredits(r, row, { candidates: [candidate(7, 'window:2026-10-05', '2026-10-06T12:00:00Z')], credited: held, now });
  assert.equal(plan.length, 1, 'a new week, a new 1,000 pts');
  assert.equal(plan[0].completion, false, 'one completion per person per challenge is a database rule; a weekly one must not take it');
  const again = rules.planCredits(r, row, {
    candidates: [candidate(7, 'window:2026-10-05', '2026-10-06T12:00:00Z')],
    credited: credits([[7, 'window:2026-10-05', '2026-10-06T12:00:00Z']]), now,
  });
  assert.equal(again.length, 0, 'once a week');
});

test('the scorer loads a weekly challenge a week at a time, and counts what is held per week', async () => {
  const seen = [];
  const pool = { async query(sql, params) { seen.push(params); return { rows: [{ user_id: 7, seconds: 900, last_date: '2026-10-06' }] }; } };
  const [c] = await scorer.loadCandidates(pool, 'USE_APPS_MINUTES',
    { startMs: Date.parse('2026-10-05T00:00:00Z'), endMs: Date.parse('2026-10-11T23:59:59.999Z') }, { target: 10 });
  assert.equal(c.sourceKey, 'window:2026-10-05', 'each week’s unit has a key of its own');
  assert.equal(seen[0][0], '2026-10-05T00:00:00.000Z');
  assert.match(scorer.CREDITED_SQL, /activity_at/, 'the cap reads when each credit was earned');
  const credited = await scorer.loadCredited({
    async query() {
      return { rows: [
        { user_id: 17, source_key: 'merged:1', activity_at: new Date('2026-09-30T10:00:00Z') },
        { user_id: 17, source_key: 'merged:2', activity_at: new Date('2026-10-06T10:00:00Z') },
      ] };
    },
  }, 81);
  const state = credited.get(17);
  assert.equal(state.count, 2);
  assert.equal(state.weeks.get(Date.parse('2026-09-28T00:00:00Z')), 1);
  assert.equal(state.weeks.get(Date.parse('2026-10-05T00:00:00Z')), 1);
});

test('progress on a weekly challenge counts this week’s credits only, on every list', () => {
  const onboarding = require('../src/services/topochain/challenge-onboarding');
  const panels = require('../src/routes/home-panels');
  const sql = onboarding.COUNTS_THIS_WEEK_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /UPPER\(TRIM\(COALESCE\(ct\.category, ''\)\)\) <> 'WEEKLY'/, 'any other challenge counts every credit');
  assert.match(sql, /ua\.activity_at >= date_trunc\('week', NOW\(\) AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC'/,
    'a weekly one from Monday 00:00 UTC, the week the scorer caps by');
  assert.ok(panels.MY_COUNT_SQL.includes(onboarding.COUNTS_THIS_WEEK_SQL), 'Home and the profile');
  const fs = require('fs');
  const path = require('path');
  const pub = fs.readFileSync(path.join(__dirname, '..', 'src/routes/topochain/public.js'), 'utf8');
  assert.match(pub, /AND \$\{COUNTS_THIS_WEEK_SQL\}/, 'the Challenges tab’s list');
  const mobile = fs.readFileSync(path.join(__dirname, '..', 'src/routes/topochain/mobile.js'), 'utf8');
  assert.match(mobile, /isWeekly\(\{ category: item\.category \}\)/, 'and the phone app’s, in JS');
});
