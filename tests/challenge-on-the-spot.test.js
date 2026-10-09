'use strict';
// The First challenges count the moment they are done (#3568, #3569, #3570).
//
// #3564 made a join count on the spot: every door a person joins through ran
// the two community measures there and then instead of leaving them to the
// rule's next scheduled pass. These are the same fix at the other steps —
// "Suggested an improvement, but the challenge still says not started" was
// the report — through one generalised call, scoreOn(pool, config,
// measures), and two new measures for the steps nothing measured:
//
//   VOTE_CAST       a vote on somebody else's proposal or request
//   FEEDBACK_SENT   a report that gets past the junk filter, ungraded
//
// and TRY_APPS, scored from the app heartbeat on the one heartbeat that
// takes somebody's time in an app across its floor (now 10 seconds).
//
// This file pins the pure parts and the call shapes against scripted pools;
// tests/challenge-on-the-spot-postgres.test.js proves the behaviour against
// the real schema, through the real routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('../src/services/topochain/challenge-rules');
const grader = require('../src/services/topochain/challenge-grader');
const scorer = require('../src/services/topochain/challenge-scorer');
const { anatomy, ON_THE_SPOT_TEXT } = require('../src/services/topochain/challenge-anatomy');
const { CHALLENGE_SCORER_LOCK } = require('../src/services/advisory-locks');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const flat = (s) => String(s).replace(/\s+/g, ' ');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ON = { challengeScorer: { intervalMinutes: 10 } };
const OFF = { challengeScorer: { intervalMinutes: 0 } };

// A challenge row as RULE_CHALLENGES_SQL returns it.
const challengeRow = (extra = {}) => ({
  rule_id: 1, rule_name: 'Rule', measure: 'VOTE_CAST', rule_target: null, rule_points: null,
  rule_enabled: true, rule_interval_minutes: null, rule_last_scored_at: null,
  challenge_id: 90, season_event_id: 10, enabled: true, completed: false,
  schedule_start: null, schedule_end: null, metric_target: null, reward: '300 pts',
  template_id: 9, t_category: 'ONBOARDING', t_goal: 'Vote on a change',
  t_schedule_start: null, t_schedule_end: null, t_metric_target: null, t_reward: '300 pts',
  event_starts_at: iso(NOW - 10 * DAY), event_ends_at: iso(NOW + 60 * DAY),
  ...extra,
});

// A pool that answers by statement, and records what it was asked.
function spotPool({
  ruleRows = [], challenges = [], candidates = {}, credited = [], total = 0, locked = false, fail = null,
} = {}) {
  const pool = { seen: [], inserted: [], stamps: [], locks: [], unlocks: [], connects: 0, released: 0 };
  const handle = async (sql, params) => {
    pool.seen.push(sql);
    if (fail && sql.includes(fail)) throw new Error('connection reset');
    if (sql.includes('pg_try_advisory_lock')) { pool.locks.push(params); return { rows: [{ acquired: !locked }] }; }
    if (sql.includes('pg_advisory_unlock')) { pool.unlocks.push(params); return { rows: [] }; }
    if (sql === scorer.ON_THE_SPOT_RULES_SQL) {
      return { rows: ruleRows.filter((r) => params[0].includes(r.measure)) };
    }
    if (sql === scorer.APP_TIME_SQL) return { rows: [{ total: String(total) }] };
    if (sql === scorer.RULE_CHALLENGES_SQL) return { rows: challenges };
    if (sql === scorer.CREDITED_SQL) return { rows: credited };
    if (candidates[sql]) return { rows: candidates[sql] };
    if (sql.includes('SET last_scored_at')) { pool.stamps.push(params[0]); return { rows: [] }; }
    if (sql.includes('INSERT INTO user_activities')) {
      pool.inserted.push({ params, metadata: JSON.parse(params[5]) });
      return { rows: [{ id: pool.inserted.length }] };
    }
    return { rows: [] };
  };
  pool.query = handle;
  pool.connect = async () => { pool.connects += 1; return { query: handle, release() { pool.released += 1; } }; };
  return pool;
}

// ─── The two new measures ──────────────────────────────────────────────

test('a vote and a report are single completions inside the window, and never call a model', () => {
  for (const measure of ['VOTE_CAST', 'FEEDBACK_SENT']) {
    const spec = rules.MEASURES[measure];
    assert.ok(rules.MEASURE_KEYS.includes(measure), `${measure} is offered in the rule editor`);
    assert.equal(spec.counted, false, `${measure}: one is enough`);
    assert.equal(spec.payout, 'full', measure);
    assert.equal(spec.targetUnit, null, `${measure}: so the form asks for no target`);
    assert.equal(spec.graded, false, `${measure}: nobody's first step waits on a model`);
    // An action, not a state: counting all time would pay every existing
    // voter the whole reward on the first pass after the rule is created.
    assert.equal(spec.windowed, true, `${measure}: windowed, like TRY_APPS and PROPOSAL_SENT`);
    assert.equal(rules.skipReason({ id: 1, measure, enabled: true }, challengeRow({ measure }), { now: NOW }), null,
      `${measure}: scores with the challenge's own reward and no target`);
  }
  assert.equal(rules.MEASURES.FEEDBACK_SENT.screened, true, 'the junk filter still applies');
  assert.notEqual(rules.MEASURES.VOTE_CAST.screened, true);
});

test('a vote on your own proposal or request is not a candidate, and the window bounds both tables', () => {
  const sql = flat(scorer.MEASURE_SQL.VOTE_CAST);
  assert.match(sql, /FROM pr_votes pv JOIN chat_sessions cs ON cs\.id = pv\.session_id/);
  assert.match(sql, /cs\.user_id IS DISTINCT FROM pv\.user_id/, 'an author voting on what they put up has not judged anybody\'s change');
  assert.match(sql, /FROM issue_votes iv JOIN issues i ON i\.id = iv\.issue_id/);
  assert.match(sql, /i\.created_by IS DISTINCT FROM iv\.user_id/, 'nor has somebody voting on their own request');
  assert.match(sql, /pv\.created_at >= \$1 AND pv\.created_at <= \$2/);
  assert.match(sql, /iv\.created_at >= \$1 AND iv\.created_at <= \$2/);
  assert.match(sql, /SELECT DISTINCT ON \(v\.user_id\)/, 'one row a person, so the candidate limit counts people');
  assert.match(sql, /ORDER BY v\.user_id ASC, v\.created_at ASC/, 'their earliest vote in the window');
});

// The first-session test (2026-10-03): the Homeroom bot is the author of the
// proposal it writes for somebody's request, so "not their own proposal"
// paid the requester for voting on their own solo app's first version, and
// the in-app "Suggest an improvement" on that app paid both feedback measures.
const BOT_BUILD = /NOT EXISTS \(SELECT 1 FROM homeroom_bot_requesters r WHERE r\.app_id = cs\.app_id AND r\.issue_number = cs\.created_from_issue_number AND r\.user_id = (pv\.user_id|\$1)\)/;
const NOT_JUST_YOU = "a.view_visibility = 'public' OR (SELECT COUNT(*) FROM community_members o WHERE o.community_id = a.community_id) > 1 OR EXISTS (SELECT 1 FROM app_collaborators ic WHERE ic.app_id = a.id AND ic.status = 'invited')";

test('a vote on the bot\'s build of your own request, or in a "Just you" project, is not a candidate', () => {
  const sql = flat(scorer.MEASURE_SQL.VOTE_CAST);
  assert.match(sql, BOT_BUILD);
  assert.equal(sql.match(BOT_BUILD)[1], 'pv.user_id', 'the voter\'s own request');
  // The audience test COMMUNITY_JOINED reads (there over the membership's
  // community, here over the vote's project); the look has no project and
  // is not affected.
  assert.ok(flat(scorer.MEASURE_SQL.COMMUNITY_JOINED)
    .replace('o.community_id = m.community_id', 'o.community_id = a.community_id').includes(NOT_JUST_YOU));
  assert.ok(sql.includes(`AND (v.app_id IS NULL OR ${NOT_JUST_YOU})`));
  assert.ok(sql.indexOf('WHERE v.user_id IS NOT NULL') < sql.indexOf('ORDER BY v.user_id ASC'),
    'filtered before DISTINCT ON picks the earliest, so the credit is the earliest vote that counts');
  // The card's Vote step points only at votes that pay: the Needs you
  // count per project carries the same two tests.
  const owed = flat(require('../src/routes/workshop-overview').OWED_BY_COMMUNITY_SQL);
  assert.match(owed, BOT_BUILD);
  assert.equal(owed.match(BOT_BUILD)[1], '$1', 'the viewer\'s own request');
  assert.ok(owed.includes(NOT_JUST_YOU.replace('community_members o WHERE o.', 'community_members om WHERE om.')));
  assert.match(owed, /THEN COUNT\(\*\) FILTER \(WHERE o\.pays\) ELSE 0 END\)::int AS paying/);
  // And the admin is told.
  assert.match(rules.MEASURES.VOTE_CAST.summary, /nor do votes on what the Homeroom bot built from their own request or votes in a project only they can see/);
  const shown = anatomy('VOTE_CAST', { points: 250, target: null });
  assert.match(shown.steps[0].text, /a vote on what the Homeroom bot built from a request they made and any vote in a "Just you" project/);
  assert.ok(shown.steps[0].tables.includes('homeroom_bot_requesters'));
});

test('a report on a project you made, or a "Just you" one, is not feedback for either measure', () => {
  const sql = flat(scorer.MEASURE_SQL.USEFUL_FEEDBACK);
  assert.ok(sql.includes(`AND (fr.app_id IS NULL OR $4::boolean OR (a.created_by IS DISTINCT FROM fr.user_id AND (${NOT_JUST_YOU})))`),
    'about the platform, or somebody else\'s project that somebody else is in, or anything on a First challenge (#4603)');
  assert.equal(scorer.MEASURE_SQL.FEEDBACK_SENT, scorer.MEASURE_SQL.USEFUL_FEEDBACK, 'both measures, one statement');
  for (const measure of ['USEFUL_FEEDBACK', 'FEEDBACK_SENT']) {
    assert.match(rules.MEASURES[measure].summary, /a project they made,? or one only they can see/, measure);
    assert.match(anatomy(measure, { points: 250, target: 4 }).steps[0].text, /a project they made/, measure);
  }
});

test('a vote credit names what was voted on, and is dated when it was cast', async () => {
  const seen = [];
  const pool = {
    async query(sql, params) {
      seen.push(params);
      return { rows: [
        { user_id: 7, kind: 'pr', ref_id: 31, created_at: new Date(NOW - HOUR), app_name: 'Recipes' },
        { user_id: 8, kind: 'issue', ref_id: 4, created_at: new Date(NOW - 2 * HOUR), app_name: null },
        { user_id: 9, kind: 'workshop', ref_id: 9, created_at: new Date(NOW - 3 * HOUR), app_name: null },
      ] };
    },
  };
  const out = await scorer.loadCandidates(pool, 'VOTE_CAST', { startMs: NOW - DAY, endMs: NOW + DAY }, {});
  assert.deepEqual(seen[0], [iso(NOW - DAY), iso(NOW + DAY), scorer.CANDIDATE_LIMIT]);
  assert.deepEqual(out.map((c) => [c.userId, c.sourceKey, c.description]), [
    [7, 'vote:pr:31', 'Voted on a change to Recipes'],
    [8, 'vote:issue:4', 'Voted on a change'],
    [9, 'vote:workshop:9', 'Looked at the Workshop when nothing was up for a vote'],
  ]);
  assert.equal(out[0].activityAt, iso(NOW - HOUR));
});

// evan, 2026-10-01: with nothing up for a vote in any community a newcomer is
// in, the Getting started card's Vote step is a look at the Workshop, which
// the server records only then. VOTE_CAST counts that look as it counts a
// vote: the same window, one credit a person, whichever came first.
test('a look at the Workshop when nothing was up for a vote counts for VOTE_CAST, and the admin is told so', () => {
  const sql = flat(scorer.MEASURE_SQL.VOTE_CAST);
  assert.match(sql, /SELECT w\.user_id, 'workshop' AS kind, w\.user_id AS ref_id, w\.created_at, NULL AS app_id/);
  assert.match(sql, /CASE WHEN \(u\.getting_started_seen->>'vote_workshop'\) ~ '\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\[T \]' THEN \(u\.getting_started_seen->>'vote_workshop'\)::timestamptz END AS created_at/,
    'a value that is not a timestamp is no row, not a failed pass');
  assert.match(sql, /WHERE w\.created_at >= \$1 AND w\.created_at <= \$2/, 'the same window as a vote');
  assert.doesNotMatch(sql, /'workshop'\)|->>'workshop'/, 'never the retired card\'s "workshop" key');
  const spec = rules.MEASURES.VOTE_CAST;
  assert.equal(spec.label, 'Voted on a change, or looked at the Workshop when nothing was up for a vote');
  assert.match(spec.phrase, /or looks at the Workshop when nothing is up for a vote$/);
  assert.match(spec.summary, /neither does a look while a vote was waiting/);
  const shown = anatomy('VOTE_CAST', { points: 250, target: null });
  assert.match(shown.steps[0].text, /their look at the Workshop when nothing was up for a vote/);
  assert.ok(shown.steps[0].tables.includes('users'));
});

test('"Suggest an improvement": junk first, then a real report, is one credit of the whole reward and no model call', async () => {
  const row = challengeRow({ measure: 'FEEDBACK_SENT', t_goal: 'Suggest an improvement', reward: '250 pts', t_reward: '250 pts' });
  const report = (id, description, minutesAgo) => ({
    id, user_id: 7, created_at: new Date(NOW - minutesAgo * 60000), title: 'Report', description, app_name: null,
  });
  const pool = spotPool({
    challenges: [row],
    candidates: {
      [scorer.MEASURE_SQL.FEEDBACK_SENT]: [
        report(1, 'test', 30),
        report(2, 'The vote button on the Workshop does nothing the first time I press it.', 20),
        report(3, 'The search box on Discover forgets what I typed when I go back.', 10),
      ],
    },
  });
  assert.equal(scorer.MEASURE_SQL.FEEDBACK_SENT, scorer.MEASURE_SQL.USEFUL_FEEDBACK,
    'the same reports the weekly graded challenge reads, not a copy of the statement');
  const noModel = { isEnabled: () => true, gradeChallengeUnit: async () => { throw new Error('graded'); } };
  const summary = await scorer.score(pool, { now: NOW, llm: noModel });
  assert.equal(summary.graded, 0);
  assert.equal(summary.challenges[0].rejected, 1, '"test" is dropped before it can hold the one slot');
  assert.equal(pool.inserted.length, 1);
  const [credit] = pool.inserted;
  assert.equal(credit.metadata.source_key, 'feedback:2', 'the first report worth reading');
  assert.equal(credit.metadata.kind, 'challenge_completion', 'one completion; the index refuses a second');
  assert.equal(credit.metadata.grade, undefined);
  assert.equal(Number(credit.params[3]), 250);
  assert.equal(credit.params[4], 'Sent feedback on Homeroom');
});

test('"Try an app": a count of one pays the first app in full and nothing after it', () => {
  const row = challengeRow({
    measure: 'TRY_APPS', t_goal: 'Try an app', metric_target: 1, t_metric_target: 1,
    reward: '500 pts', t_reward: '500 pts',
  });
  const r = { id: 1, measure: 'TRY_APPS', enabled: true };
  assert.equal(rules.skipReason(r, row, { now: NOW }), null, 'used to be skipped as "no target"');
  const app = (n) => ({ userId: 7, sourceKey: `app:${n}`, activityAt: iso(NOW - HOUR) });
  const plan = rules.planCredits(r, row, { candidates: [app(1), app(2)], now: NOW });
  assert.deepEqual(plan.map((c) => [c.sourceKey, c.points, c.completion]), [['app:1', 500, false]]);
  const again = rules.planCredits(r, row, {
    candidates: [app(1), app(2)], credited: new Map([[7, { keys: new Set(['app:1']), count: 1 }]]), now: NOW,
  });
  assert.deepEqual(again, [], 'the cap is one');
  // And the "Try 3 apps" shape is unchanged.
  const three = rules.planCredits(r, row, { candidates: [app(1), app(2), app(3)], now: NOW });
  assert.equal(three.length, 1);
});

// ─── The 10-second floor and its crossing ──────────────────────────────

test('the floor is 10 seconds, and a heartbeat crosses it once', async () => {
  assert.equal(rules.TRY_APPS_MIN_SECONDS, 10, '#3570: 30 was long enough to look around and leave');
  assert.match(rules.MEASURES.TRY_APPS.summary, /at least 10 seconds in each/);
  const crossed = (before, after) => rules.crossedTryAppsFloor({ before, after });
  assert.equal(crossed(0, 10), true);
  assert.equal(crossed(9, 39), true);
  assert.equal(crossed(0, 9), false, 'not there yet');
  assert.equal(crossed(10, 40), false, 'already past it: the heartbeats after the crossing run nothing');
  assert.equal(crossed(undefined, 40), false);
  // The engaged collector owns the early receipt now; its clock/HTTP tests
  // verify one crossing per open alongside the regular 30-second flush.
  const { TRY_APP_FLUSH_MS } = await import('../frontend/src/features/app-frame/app-activity.js');
  assert.equal(TRY_APP_FLUSH_MS, rules.TRY_APPS_MIN_SECONDS * 1000,
    'the client sends earned time at the server reward threshold');
});

// ─── scoreOn: the same guarantees at every door ────────────────────────

test('scoreOn is a no-op with scoring off, for a graded measure, or with no rule', async () => {
  const pool = spotPool();
  assert.equal(await scorer.scoreOn(pool, OFF, ['VOTE_CAST']), null);
  assert.equal(pool.seen.length, 0, 'interval 0 asks Postgres nothing');
  assert.equal(await scorer.scoreOn(pool, ON, ['USEFUL_FEEDBACK', 'PROPOSAL_ACCEPTED']), null);
  assert.equal(pool.seen.length, 0, 'a model call never sits inside somebody\'s tap');
  assert.equal(await scorer.scoreOn(pool, ON, ['NOPE']), null);
  assert.equal(pool.seen.length, 0);
  assert.equal(await scorer.scoreOn(pool, ON, ['VOTE_CAST']), null);
  assert.deepEqual(pool.seen, [scorer.ON_THE_SPOT_RULES_SQL], 'no rule on the measure: one read, then nothing');
  const failing = spotPool({ fail: 'challenge_scoring_rules' });
  assert.equal(await scorer.scoreOn(failing, ON, ['VOTE_CAST']), null, 'a failure is logged, never thrown into the action');
});

test('a single completion is scored without the lock, through the same pass as the schedule', async () => {
  const pool = spotPool({
    ruleRows: [{ id: 1, measure: 'VOTE_CAST' }],
    challenges: [challengeRow()],
    candidates: { [scorer.MEASURE_SQL.VOTE_CAST]: [{ user_id: 7, kind: 'pr', ref_id: 31, created_at: new Date(NOW - HOUR), app_name: 'Recipes' }] },
  });
  const summary = await scorer.scoreOnVote(pool, ON, { now: NOW });
  assert.equal(summary.credits, 1);
  assert.equal(pool.locks.length, 0, 'the completion index refuses a racing copy, so no lock is needed');
  assert.equal(pool.inserted[0].metadata.kind, 'challenge_completion');
  assert.equal(pool.inserted[0].metadata.measure, 'VOTE_CAST');
  assert.deepEqual(pool.stamps, [1], 'stamped like a scheduled pass of that rule');
});

test('a counted measure is scored only under the tick\'s lock, and a held lock skips it', async () => {
  const tryRow = challengeRow({ measure: 'TRY_APPS', metric_target: 1, t_metric_target: 1, reward: '500 pts', t_reward: '500 pts' });
  const tried = [{ user_id: 7, app_id: 3, app_name: 'Notes', last_date: '2026-10-01', seconds: 12 }];
  const pool = spotPool({
    ruleRows: [{ id: 1, measure: 'TRY_APPS' }], challenges: [tryRow],
    candidates: { [scorer.MEASURE_SQL.TRY_APPS]: tried },
  });
  const summary = await scorer.scoreOn(pool, ON, ['TRY_APPS'], { now: NOW });
  assert.equal(summary.credits, 1);
  assert.deepEqual(pool.locks, [[CHALLENGE_SCORER_LOCK, 0]], 'the lock the tick plans under');
  assert.deepEqual(pool.unlocks, [[CHALLENGE_SCORER_LOCK, 0]], 'and given back');
  assert.equal(pool.released, pool.connects, 'every connection it took, the lock\'s included');

  // Two plans at once could each pay a different "last unit". So when the
  // tick (or another heartbeat) holds the lock, this pass does not run at
  // all; the rule's next pass counts it, late but once.
  const busy = spotPool({
    ruleRows: [{ id: 1, measure: 'TRY_APPS' }], challenges: [tryRow], locked: true,
    candidates: { [scorer.MEASURE_SQL.TRY_APPS]: tried },
  });
  assert.deepEqual(await scorer.scoreOn(busy, ON, ['TRY_APPS'], { now: NOW }), { busy: true });
  assert.equal(busy.seen.includes(scorer.RULE_CHALLENGES_SQL), false, 'nothing is read or planned');
  assert.equal(busy.inserted.length, 0);
  assert.equal(busy.unlocks.length, 0, 'a lock it never took is not released');
  assert.equal(busy.connects, 1);
  assert.equal(busy.released, 1, 'the connection is');
});

test('every door runs the measures it can complete, and only those', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(scorer.ON_THE_SPOT)), {
    join: ['COMMUNITY_JOINED', 'COMMUNITY_APP_CREATED'],
    vote: ['VOTE_CAST'],
    feedback: ['FEEDBACK_SENT'],
    appTime: ['TRY_APPS'],
  });
  assert.equal(scorer.JOIN_MEASURES, scorer.ON_THE_SPOT.join);
  const all = Object.values(scorer.ON_THE_SPOT).flat();
  for (const measure of all) assert.equal(rules.MEASURES[measure].graded, false, measure);
  assert.deepEqual(all.filter((m) => rules.MEASURES[m].counted), ['TRY_APPS'],
    'the one counted measure on the spot is the one scoreOn locks for');
  assert.ok(!all.includes('INVITES_JOINED'), 'its "three and no more" waits for the locked schedule');
});

// ─── The heartbeat: a pass on the crossing, and on nothing else ────────

test('the heartbeat reads nothing once today is past the floor', async () => {
  const pool = spotPool({ total: 40 });
  const beat = (extra) => scorer.scoreOnAppTime(pool, ON, { appId: 3, userId: 7, seconds: 30, daySeconds: 30, ...extra });
  assert.equal(await beat({ seconds: 30, daySeconds: 60 }), null);
  assert.equal(pool.seen.length, 0, 'today was already at 30 before this heartbeat: so was the total');
  assert.equal(await beat({ daySeconds: undefined }), null);
  assert.equal(pool.seen.length, 0, 'nothing to go on is not a crossing');
  assert.equal(await scorer.scoreOnAppTime(pool, OFF, { appId: 3, userId: 7, seconds: 12, daySeconds: 12 }), null);
  assert.equal(pool.seen.length, 0, 'scoring off: not even the read');
});

test('the heartbeat that crosses the floor runs a pass; the one before it reads and stops', async () => {
  const below = spotPool({ total: 6, ruleRows: [{ id: 1, measure: 'TRY_APPS' }] });
  assert.equal(await scorer.scoreOnAppTime(below, ON, { appId: 3, userId: 7, seconds: 6, daySeconds: 6 }), null);
  assert.deepEqual(below.seen, [scorer.APP_TIME_SQL], 'one indexed SUM, and no rule lookup');

  // Six seconds yesterday and six today is a crossing too: the total is
  // every day's, not the day row's.
  const crossing = spotPool({ total: 12, ruleRows: [{ id: 1, measure: 'TRY_APPS' }], challenges: [] });
  await scorer.scoreOnAppTime(crossing, ON, { appId: 3, userId: 7, seconds: 6, daySeconds: 6, now: NOW });
  assert.deepEqual(crossing.seen.slice(0, 2), [scorer.APP_TIME_SQL, scorer.ON_THE_SPOT_RULES_SQL]);
  assert.ok(crossing.seen.includes(scorer.RULE_CHALLENGES_SQL), 'the pass ran');
  assert.deepEqual(crossing.locks, [[CHALLENGE_SCORER_LOCK, 0]]);

  const failing = spotPool({ fail: 'FROM app_activity' });
  assert.equal(await scorer.scoreOnAppTime(failing, ON, { appId: 3, userId: 7, seconds: 6, daySeconds: 6 }), null,
    'a failed read is logged; the heartbeat still answers');
  const sql = flat(scorer.APP_TIME_SQL);
  assert.match(sql, /SUM\(seconds_spent\)/);
  assert.match(sql, /WHERE app_id = \$1 AND user_id = \$2/, 'every day: the route knows no window');
});

// ─── The doors ─────────────────────────────────────────────────────────

test('every vote door counts the vote before it answers', () => {
  const votes = read('src/routes/votes.js');
  const route = votes.slice(votes.indexOf("router.post('/api/sessions/:id/vote'"));
  const body = route.slice(0, route.indexOf('settleVoteInBackground({ config, pool, session, revision })'));
  assert.match(votes, /require\('\.\.\/services\/topochain\/challenge-scorer'\)/);
  assert.match(body, /await challengeScorer\.scoreOnVote\(pool, config\);\s*res\.json\(\{ ok: true, merged: false(?:, \.\.\.readyCard)? \}\);/,
    'a proposal vote: credited before the voter is answered');
  assert.ok(body.indexOf('scoreOnVote') > body.indexOf('if (reasonOnly) {'),
    'on a real vote only, behind the same gate as every other side effect');

  const issues = read('src/routes/issues.js');
  const issueRoute = issues.slice(issues.indexOf("router.post('/api/issues/:id/vote'"));
  const issueBody = issueRoute.slice(0, issueRoute.indexOf('router.', 10));
  assert.match(issues, /require\('\.\.\/services\/topochain\/challenge-scorer'\)/);
  assert.match(issueBody, /pushIssueUpdate\(\{ action: 'voted', appSlug: issue\.app_slug, appId: issue\.app_id, issueId: issue\.id, vote \}\);\s*(?:\/\/[^\n]*\n\s*)*await challengeScorer\.scoreOnVote\(pool, config\);/,
    'a request vote: after the broadcast, before the apply');
  assert.ok(issueBody.indexOf('scoreOnVote') > issueBody.indexOf('return res.json({ ok: true, toggled: true });'),
    'taking a vote back is not casting one');
});

test('a report counts before the person is answered, on both targets', () => {
  const src = read('src/routes/feedback.js');
  assert.match(src, /require\('\.\.\/services\/topochain\/challenge-scorer'\)/);
  const doors = src.match(/await recordFeedbackReport\(pool, \{[^}]*\}\);\s*(?:\/\/[^\n]*\n\s*)*await challengeScorer\.scoreOnFeedback\(pool, config\);/g) || [];
  assert.equal(doors.length, 2, 'app feedback and platform feedback, each after the receipt it reads');
  assert.equal((src.match(/await challengeScorer\.scoreOnFeedback\(/g) || []).length, 2);
});

test('the heartbeat hands the scorer what it needs to find the crossing', () => {
  const src = read('src/routes/apps.js');
  const route = src.slice(src.indexOf("router.post('/api/apps/:slug/activity'"));
  const body = route.slice(0, route.indexOf("res.json({ ok: true });"));
  assert.match(body, /RETURNING \(xmax = 0\) AS inserted, seconds_spent`/, 'today\'s total, from the same statement');
  assert.match(body, /await challengeScorer\.scoreOnAppTime\(pool, config, \{\s*appId: appRows\[0\]\.id,\s*userId: req\.user\.id,\s*seconds,\s*daySeconds: activityRows\[0\]\?\.seconds_spent,\s*\}\);/);
});

// ─── What the admin reads ──────────────────────────────────────────────

test('"How it scores" says the interval is the backstop exactly where an action runs the measure', () => {
  assert.deepEqual(Object.keys(ON_THE_SPOT_TEXT).sort(), Object.keys(scorer.ON_THE_SPOT).sort());
  for (const measure of rules.MEASURE_KEYS) {
    const { cost } = anatomy(measure, { points: 1000, target: 4 });
    const door = Object.keys(scorer.ON_THE_SPOT).find((d) => scorer.ON_THE_SPOT[d].includes(measure));
    for (const [d, text] of Object.entries(ON_THE_SPOT_TEXT)) {
      assert.equal(cost.includes(text), d === door, `${measure} / ${d}`);
    }
  }
  assert.ok(ON_THE_SPOT_TEXT.appTime.includes(`${rules.TRY_APPS_MIN_SECONDS} seconds`));
  // A target of one reads in the singular.
  const paid = anatomy('TRY_APPS', { points: 500, target: 1 }).steps.find((s) => s.kind === 'paid');
  assert.ok(paid.text.endsWith('A person stops at 1 app per window.'), paid.text);
  assert.ok(anatomy('TRY_APPS', { points: 500, target: 3 }).steps.find((s) => s.kind === 'paid')
    .text.endsWith('A person stops at 3 apps per window.'));
});

test('the rule editor offers the new measures and reads a count of one as one', () => {
  const route = read('src/routes/topochain/admin/challenge-scoring.js');
  assert.match(route, /phrase_one: rules\.MEASURES\[key\]\.phraseOne \|\| null,/);
  assert.equal(rules.MEASURES.TRY_APPS.phraseOne, 'opens an app they did not make');
  const tsx = read('frontend/src/features/admin/topochain/challenge-scoring.tsx');
  assert.match(tsx, /phrase_one: string \| null;/);
  assert.match(tsx, /const phrase = one && measure\.phrase_one\s*\? measure\.phrase_one/);
  assert.match(tsx, /if \(one && \(measure\.payout === 'on_target' \|\| measure\.payout === 'per_unit'\)\) \{\s*return `credits \$\{pts\(points\)\} when someone \$\{phrase\}\.`;/,
    'not "opens 1 different apps. Nothing before that."');
  // The picker is built from the server's catalogue, so nothing in the
  // client names a measure for it to fall out of step with.
  assert.equal(/'VOTE_CAST'|'FEEDBACK_SENT'/.test(tsx), false);
});

test('the junk filter is the grader\'s, applied by the flag the scorer reads', () => {
  const src = read('src/services/topochain/challenge-scorer.js');
  assert.match(src, /if \(MEASURES\[rule\.measure\]\.screened\) \{/);
  assert.equal(grader.preFilter('VOTE_CAST', { text: '' }, new Set()), null, 'a vote has no text to judge');
});
