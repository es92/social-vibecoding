// /api/home-panels — the home screen's Challenges card (#911) and the
// fixed sections that remain visible for every signed-in account (#1801).
//
// Contracts guarded here:
//
//   1. Me-scoped: no req.user -> 401, never anonymous data.
//   2. "Open" means enabled AND NOT organiser-completed AND inside the
//      effective schedule window, on a PUBLIC event of the season that is
//      running right now. No live season -> an empty panel, not an error.
//   3. Progress is DERIVED (no authoritative per-user value exists — see
//      resolveProgress's comment): binary from "any activity row", numeric
//      from the ledger row count, 'blocks_produced' from the newest
//      snapshot, clamped to the target.
//   4. points_remaining is withheld (null) unless EVERY open row's reward
//      parses as a plain number — organiser prose is never guessed at.
//   5. Legacy hidden preferences cannot suppress any fixed section.
//   6. The retired visibility endpoint cannot mutate preferences.
//   7. ?demo=1 is a no-op outside staging.
//
// Pure-function tests plus HTTP tests against a throwaway express app and
// a substring-dispatching mock pool (the idiom of
// tests/challenges-web-routes.test.js) — no live DB.
//
// Run with: node --test tests/home-panels-api.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// ─── Mock pool ────────────────────────────────────────────────────────
//
// `state` carries the fixture: the current season (or null), the joined
// challenge rows the row query should return, and the hidden array.
function makeMockPool(state) {
  const calls = [];
  const pool = {
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      // These pre-onboarding fixtures contain no introductory definitions.
      // Progression with a real catalog is exercised in challenge-onboarding.
      if (sql.startsWith('/* challenge onboarding */')) return { rows: [] };
      calls.push({ sql, params });

      // Model legacy stored preferences to catch accidental reads or writes.
      if (sql.includes('SELECT home_panels_hidden FROM users')) {
        return { rows: [{ home_panels_hidden: state.hidden ?? [] }] };
      }
      if (sql.startsWith('UPDATE users SET home_panels_hidden')) {
        const key = params[1];
        const cur = (state.hidden ?? []).filter((k) => k !== key);
        state.hidden = sql.includes('array_append') ? [...cur, key] : cur;
        return { rows: [{ home_panels_hidden: state.hidden }] };
      }
      if (sql.includes('FROM seasons')) {
        return { rows: state.season ? [state.season] : [] };
      }
      // The COUNT(*) totals query. It counts the EXPANDED scope and narrows
      // to the collapsed one with a FILTER, which is how one statement
      // produces both `total` (open) and `all_total` (what an expansion
      // would draw) — see #1824.
      if (sql.includes('AS all_total')) {
        // The totals query runs over the WHOLE open set, so the fixture
        // may declare `allRows` (what the season really has) separately
        // from `rows` (the capped page the row query returns). Defaults to
        // `rows` when a test doesn't care about the difference.
        const all = state.allRows || state.rows || [];
        const isDone = (r) => Number(r.my_activity_count) > 0;
        const total = state.total != null ? state.total : all.length;
        return {
          rows: [{
            total,
            // A fixture that wants finished/out-of-window challenges behind
            // the expansion says so; absent means the open set is all there
            // is, which is what most of these tests are about.
            all_total: state.allTotal != null ? state.allTotal : total,
            done: all.filter(isDone).length,
            // array_agg(COALESCE(c.reward, ct.reward)) FILTER (NOT done)
            open_rewards: all.filter((r) => !isDone(r))
              .map((r) => (r.reward != null ? r.reward : r.t_reward)),
          }],
        };
      }
      // The desktop LEADERBOARD fill's PRIMARY board: the Topochain
      // standings, via src/services/topochain/event-standings.js. Three
      // reads, one per step of that module.
      //
      //   1. which public event has standings (resolveDefaultPublicEvent)
      if (sql.includes('FROM season_events') && sql.includes('display_leaderboard = TRUE')) {
        if (state.eventThrows) throw new Error('event resolution exploded');
        return { rows: state.event ? [state.event] : [] };
      }
      //   2. a 'regular' event's stored snapshot rows (EVENT_LEADERBOARD_SQL).
      //      Matched on its DISTINCT ON, not on the table name: the
      //      challenges row/COUNT queries read leaderboard_snapshots too
      //      (MY_BLOCKS_SQL) and would be swallowed by a looser guard.
      if (sql.includes('DISTINCT ON (ls.user_id) ls.*')) {
        if (state.standingsThrows) throw new Error('standings exploded');
        return { rows: state.standings || [] };
      }
      //   3. any other event type -> the shared §4.10 standings aggregate
      if (sql.includes('SUM(l.total_points)')) {
        if (state.standingsThrows) throw new Error('standings exploded');
        return { rows: state.seasonStandings || [] };
      }
      // The FALLBACK board — src/services/leaderboard-users.js ranking every
      // user. `fillUsers` is the ranked list the fixture wants; absent means
      // "no board", which the route must survive.
      if (sql.includes('FROM users u') && sql.includes('kudos_received_prs_merged')) {
        if (state.fillThrows) throw new Error('leaderboard exploded');
        return { rows: state.fillUsers || [] };
      }
      // The row query.
      if (sql.includes('FROM challenges c')) {
        // Honour the real LIMIT the route passes ($3) rather than a
        // hardcoded page size, so the row cap is genuinely exercised.
        const limit = Number(params[2]) || (state.rows || []).length;
        return { rows: (state.rows || []).slice(0, limit) };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
  return { pool, calls };
}

// A joined challenges⋈challenge_templates row with the per-user aggregates,
// as the route's own SELECT produces it.
function row(over = {}) {
  return {
    id: 1,
    season_event_id: 100,
    goal: null, task: null, reward: null,
    schedule_start: null, schedule_end: null,
    cta_label: null, cta_link: null,
    metric_type: null, metric_target: null, metric_label: null,
    enabled: true, completed: false, display_order: 1,
    featured: false, featured_order: null,
    t_id: 10, t_category: 'community',
    t_goal: 'Template goal', t_task: 'Template task', t_reward: '250 pts',
    t_cta_label: null, t_cta_link: null,
    t_metric_type: null, t_metric_target: null, t_metric_label: null,
    t_schedule_start: null, t_schedule_end: null, t_illustration: null, t_illustration_tone: null,
    my_activity_count: 0, my_points: 0, my_blocks: null,
    ...over,
  };
}

// Builds an app with req.user injected (or not) and the route's pool
// swapped for the mock.
function makeApp(state, { user } = {}) {
  const { pool, calls } = makeMockPool(state);
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  let routes;
  try {
    delete require.cache[require.resolve('../src/routes/home-panels')];
    routes = require('../src/routes/home-panels').homePanelRoutes();
  } finally {
    poolModule.getPool = originalGetPool;
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use(routes);
  return { app, calls, state };
}

const USER = { id: 7, username: 'viewer', isAdmin: false };
const SEASON = { id: 1, name: 'Season 1' };

async function get(app, url) {
  const server = app.listen(0);
  // The harness preload (tests/lib/test-net.js) pins hostless listens to
  // 127.0.0.1, which makes the bind complete on the next tick instead of
  // synchronously — so wait for it before reading the assigned port.
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

async function post(app, url, payload) {
  const server = app.listen(0);
  // The harness preload (tests/lib/test-net.js) pins hostless listens to
  // 127.0.0.1, which makes the bind complete on the next tick instead of
  // synchronously — so wait for it before reading the assigned port.
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

// ─── Pure functions ───────────────────────────────────────────────────

const { parseRewardPoints, resolveProgress, buildChallengeRow, PANEL_REGISTRY } =
  require('../src/routes/home-panels');

test('parseRewardPoints: only confidently-numeric rewards yield a number', () => {
  assert.equal(parseRewardPoints('1500'), 1500);
  assert.equal(parseRewardPoints('300 pts'), 300);
  assert.equal(parseRewardPoints('250 points'), 250);
  assert.equal(parseRewardPoints('Up to 6,500 pts'), 6500);
  assert.equal(parseRewardPoints('6,500'), 6500);
  // Organiser prose is never guessed at.
  assert.equal(parseRewardPoints('½ of your final credits'), null);
  assert.equal(parseRewardPoints('Unlocks future rewards'), null);
  assert.equal(parseRewardPoints('Up to 500 pts / issue'), null);
  assert.equal(parseRewardPoints(null), null);
  assert.equal(parseRewardPoints(''), null);
});

test('resolveProgress: no metric target is binary, credited by any ledger row', () => {
  assert.deepEqual(resolveProgress({ metricKind: null, metricTarget: null, activityCount: 0 }),
    { done: false, current: null, target: null });
  assert.deepEqual(resolveProgress({ metricKind: null, metricTarget: null, activityCount: 1 }),
    { done: true, current: null, target: null });
  // A metric_type with no usable target falls back to binary rather than
  // rendering a bar against NaN.
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: 0, activityCount: 2 }),
    { done: true, current: null, target: null });
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: null, activityCount: 0 }),
    { done: false, current: null, target: null });
});

test('resolveProgress: numeric counts ledger rows and clamps to the target', () => {
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: 8, activityCount: 3 }),
    { done: false, current: 3, target: 8 });
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: 8, activityCount: 8 }),
    { done: true, current: 8, target: 8 });
  // Over-target never exceeds the bar.
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: 3, activityCount: 9 }),
    { done: true, current: 3, target: 3 });
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: 5, activityCount: 0 }),
    { done: false, current: 0, target: 5 });
});

test("resolveProgress: 'blocks_produced' reads the snapshot, not the ledger", () => {
  assert.deepEqual(
    resolveProgress({ metricKind: 'blocks_produced', metricTarget: 10, activityCount: 0, blocks: 4 }),
    { done: false, current: 4, target: 10 }
  );
  // target <= 1 with ledger credit is done even when the snapshot lags.
  assert.deepEqual(
    resolveProgress({ metricKind: 'blocks_produced', metricTarget: 1, activityCount: 1, blocks: 0 }),
    { done: true, current: 0, target: 1 }
  );
});

test('buildChallengeRow: carries the event id a Home card deep-links with', () => {
  assert.equal(buildChallengeRow(row({ season_event_id: '42' })).season_event_id, 42,
    'with the challenge id it addresses #leaderboard/challenges/<event>/<challenge>');
  assert.equal(buildChallengeRow(row({ season_event_id: null })).season_event_id, null);
});

test('buildChallengeRow: the challenge row overrides the template per field', () => {
  const built = buildChallengeRow(row({
    goal: 'Challenge goal',
    reward: null,               // falls back to the template
    metric_type: 'count', metric_target: '4.0000', metric_label: 'Votes cast',
    cta_link: 'https://example.invalid/go', cta_label: null,
    my_activity_count: 2, my_points: '400',
  }));
  assert.equal(built.goal, 'Challenge goal');
  assert.equal(built.task, 'Template task');       // template wins when unset
  assert.equal(built.reward, '250 pts');
  assert.equal(built.label, 'COMMUNITY');          // template category, uppercased
  assert.deepEqual(built.metric, { kind: 'count', label: 'Votes cast', target: 4 });
  assert.deepEqual(built.progress, { done: false, current: 2, target: 4 });
  assert.equal(built.earned_points, 400);
  assert.deepEqual(built.cta, { label: 'Get Started', link: 'https://example.invalid/go' });
  assert.equal(built.ends_at, null, 'no end of its own and no event end: the card uses the season end');
  assert.equal(built.open, true, 'a row without is_open is one of the collapsed panel’s open rows');
  assert.equal(buildChallengeRow(row({ event_ends_at: '2026-09-25T00:00:00.000Z' })).ends_at,
    '2026-09-25T00:00:00.000Z', 'the event’s end — the date the Challenges tab falls back to');
  assert.equal(buildChallengeRow(row({
    t_schedule_end: '2026-09-20T00:00:00.000Z', event_ends_at: '2026-09-25T00:00:00.000Z',
  })).ends_at, '2026-09-20T00:00:00.000Z', 'the template end over the event end');
  assert.equal(buildChallengeRow(row({
    schedule_end: '2026-09-17T00:00:00.000Z', t_schedule_end: '2026-09-20T00:00:00.000Z',
  })).ends_at, '2026-09-17T00:00:00.000Z', 'and the challenge override over both, like the open-row filter');
  assert.equal(buildChallengeRow(row({ is_open: false })).open, false, 'an expanded-list row that is not open');
});

test('buildChallengeRow: no cta_link means no cta, and a missing category is OTHER', () => {
  const built = buildChallengeRow(row({ t_category: null }));
  assert.equal(built.cta, null);
  assert.equal(built.label, 'OTHER');
});

test('buildChallengeRow: passes the template\'s illustration slug through, null when it has none', () => {
  assert.equal(buildChallengeRow(row({ t_illustration: 'block-production' })).illustration, 'block-production');
  assert.equal(buildChallengeRow(row()).illustration, null);
  assert.equal(buildChallengeRow(row({ t_illustration: undefined })).illustration, null,
    'a row without the column still carries the key, so the client sees one shape');
});

test('buildChallengeRow: carries an uploaded illustration\'s tone, null for a built-in slug or none', () => {
  const slug = `u-${'d'.repeat(32)}`;
  const built = buildChallengeRow(row({ t_illustration: slug, t_illustration_tone: 'coral' }));
  assert.equal(built.illustration, slug);
  assert.equal(built.illustration_tone, 'coral');
  assert.equal(buildChallengeRow(row({ t_illustration: 'block-production' })).illustration_tone, null);
  assert.equal(buildChallengeRow(row()).illustration_tone, null);
  assert.equal(buildChallengeRow(row({ t_illustration_tone: undefined })).illustration_tone, null,
    'a row without the column still carries the key');
});

test('the registry is ordered and carries the challenges panel', () => {
  assert.ok(PANEL_REGISTRY.some((p) => p.key === 'challenges' && p.title === 'Challenges'));
  for (const p of PANEL_REGISTRY) {
    assert.equal(typeof p.build, 'function', `${p.key} needs a builder`);
  }
});

// ─── GET /api/home-panels ─────────────────────────────────────────────

test('GET /api/home-panels: 401 without a signed-in user', async () => {
  const { app } = makeApp({ season: SEASON, rows: [] });
  const { status } = await get(app, '/api/home-panels');
  assert.equal(status, 401);
});

test('GET /api/home-panels: no live season -> an empty panel, not an error', async () => {
  const { app } = makeApp({ season: null, rows: [] }, { user: USER });
  const { status, body } = await get(app, '/api/home-panels');
  assert.equal(status, 200);
  assert.deepEqual(body.registry.map((r) => r.key), ['challenges', 'discover', 'create']);
  // Three built entries: the challenges payload plus the two MARKER widgets
  // (discover / create), which build nothing but still ride the response so
  // the client can find every renderable in one place.
  assert.deepEqual(body.panels.map((p) => p.key), ['challenges', 'discover', 'create']);
  const ch = body.panels.find((p) => p.key === 'challenges');
  assert.equal(ch.total, 0);
  assert.equal(ch.season, null);
  assert.deepEqual(ch.challenges, []);
});

test('GET /api/home-panels: the open-challenge filter is in the SQL, both queries', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  await get(app, '/api/home-panels');
  const challengeQueries = calls.filter((c) => c.sql.includes('FROM challenges c'));
  assert.equal(challengeQueries.length, 2, 'rows + totals');
  for (const q of challengeQueries) {
    assert.match(q.sql, /se\.internal = FALSE/);
    assert.match(q.sql, /c\.enabled = TRUE/);
    assert.match(q.sql, /se\.season_id = \$2/);
  }
  // The open predicate is judged where each query NARROWS by it: the row
  // query's WHERE (its SELECT list also carries the predicate, as `is_open`,
  // so a match anywhere in its text would pass without the filter) and the
  // totals query's FILTERs (its outer WHERE is the expanded scope).
  const rowQuery = challengeQueries.find((q) => /LIMIT \$3/.test(q.sql));
  const totalsQuery = challengeQueries.find((q) => q !== rowQuery);
  const rowWhere = rowQuery.sql.slice(rowQuery.sql.lastIndexOf('WHERE se.season_id'));
  const totalsFilters = totalsQuery.sql.slice(0, totalsQuery.sql.lastIndexOf('WHERE se.season_id'));
  for (const narrowing of [rowWhere, totalsFilters]) {
    assert.match(narrowing, /c\.completed = FALSE/);
    assert.match(narrowing, /COALESCE\(c\.schedule_start, ct\.schedule_start/);
    assert.match(narrowing, /COALESCE\(c\.schedule_end, ct\.schedule_end/);
  }
  assert.match(rowQuery.sql, /se\.ends_at AS event_ends_at/, 'each row carries its event’s end for the card deadline');
  assert.match(rowQuery.sql, /\(\s*c\.completed = FALSE[\s\S]*?\) AS is_open/, 'and whether it is open now');
});

test('GET /api/home-panels: rows are capped and totals report the real count', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => row({ id: i + 1, display_order: i + 1 }));
  const { app } = makeApp({ season: SEASON, rows }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const panel = body.panels[0];
  assert.equal(panel.challenges.length, 4,
    'four 44px rows is what fits under the two-app-row height cap');
  assert.equal(panel.total, 8, 'so the client can say "See all 8 challenges"');
});

test('GET /api/home-panels: done/earned come from the viewer\'s own ledger rows', async () => {
  const rows = [
    row({ id: 1, my_activity_count: 0, my_points: 0 }),
    row({ id: 2, my_activity_count: 1, my_points: '250' }),
  ];
  const { app } = makeApp({ season: SEASON, rows }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const panel = body.panels[0];
  assert.equal(panel.done, 1);
  const byId = new Map(panel.challenges.map((c) => [c.id, c]));
  assert.equal(byId.get(1).progress.done, false);
  assert.equal(byId.get(1).earned_points, 0);
  assert.equal(byId.get(2).progress.done, true);
  assert.equal(byId.get(2).earned_points, 250);
});

test('GET /api/home-panels: ordering is not-done-first, then featured, then display order', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  await get(app, '/api/home-panels');
  const rowQuery = calls.find((c) => c.sql.includes('FROM challenges c')
    && c.sql.includes('ORDER BY'));
  // The OUTER ORDER BY — the my_blocks subquery has one of its own.
  const order = rowQuery.sql.slice(rowQuery.sql.lastIndexOf('ORDER BY ('));
  // The sort keys, in order: done-ness (the CASE, not a bare row count —
  // see below), then featured, then the organiser's order.
  assert.match(order, /^ORDER BY \(\s*CASE/);
  assert.ok(order.indexOf('featured IS NOT TRUE') > order.indexOf('CASE'));
  assert.ok(order.indexOf('c.display_order ASC') > order.indexOf('featured IS NOT TRUE'));
  assert.ok(order.indexOf('c.id ASC') > order.indexOf('c.display_order ASC'));
});

test('the SQL done rule mirrors resolveProgress — "has a ledger row" is NOT done', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  await get(app, '/api/home-panels');
  const queries = calls.filter((c) => c.sql.includes('FROM challenges c'));
  assert.equal(queries.length, 2);
  for (const q of queries) {
    // A numeric challenge is done only at/over its target. Regression lock:
    // an earlier version keyed off "any activity row", which sorted a 3-of-8
    // row in with the finished ones and counted it as done.
    assert.match(q.sql, />= COALESCE\(c\.metric_target, ct\.metric_target\)/);
    // Binary (no metric) still means "any activity row".
    assert.match(q.sql, /WHEN COALESCE\(c\.metric_type, ct\.metric_type\) IS NULL/);
    // …and blocks come from the snapshot, not the ledger.
    assert.match(q.sql, /= 'blocks_produced' THEN COALESCE\(\(SELECT ls\.event_total_produced_blocks/);
  }
  // The totals COUNT uses the same expression, so "N of M done" and the
  // per-row chips cannot disagree. It is a FILTER over the collapsed scope
  // AND the done rule now, because the same statement also counts the
  // expanded scope for `all_total` (#1824).
  const totals = queries.find((q) => q.sql.includes('AS all_total'));
  assert.match(totals.sql, /COUNT\(\*\) FILTER \( WHERE \(.*?\) AND \( CASE WHEN COALESCE\(c\.metric_type/);
});

test('GET /api/home-panels: the query\'s done verdict wins over recomputation', async () => {
  // my_done is what the SQL decided; the payload must echo it rather than
  // re-deriving a different answer from the same row.
  const rows = [row({ id: 1, my_activity_count: 3, my_done: false,
    metric_type: 'count', metric_target: 8, metric_label: 'Apps tested' })];
  const { app } = makeApp({ season: SEASON, rows }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const ch = body.panels[0].challenges[0];
  assert.equal(ch.progress.done, false, 'a 3-of-8 row is not done');
  assert.deepEqual(ch.progress, { done: false, current: 3, target: 8 });
});

test('GET /api/home-panels: a challenge whose template vanished is skipped, not fatal', async () => {
  const rows = [row({ id: 1 }), row({ id: 2, t_id: null })];
  const { app } = makeApp({ season: SEASON, rows }, { user: USER });
  const { status, body } = await get(app, '/api/home-panels');
  assert.equal(status, 200);
  assert.deepEqual(body.panels[0].challenges.map((c) => c.id), [1]);
});

test('GET /api/home-panels: points_remaining totals open rewards only when all are numeric', async () => {
  const numeric = [
    row({ id: 1, reward: '300 pts', my_activity_count: 0 }),
    row({ id: 2, reward: 'Up to 1,000 pts', my_activity_count: 0 }),
    // A done row does not count toward what's still on the table.
    row({ id: 3, reward: '500', my_activity_count: 1 }),
  ];
  const { app } = makeApp({ season: SEASON, rows: numeric }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  assert.equal(body.panels[0].points_remaining, 1300);

  const prose = [
    row({ id: 1, reward: '300 pts', my_activity_count: 0 }),
    row({ id: 2, reward: '½ of your final credits', my_activity_count: 0 }),
  ];
  const { app: app2 } = makeApp({ season: SEASON, rows: prose }, { user: USER });
  const { body: body2 } = await get(app2, '/api/home-panels');
  assert.equal(body2.panels[0].points_remaining, null,
    'one bit of prose withholds the whole figure');
});

test('GET /api/home-panels: points_remaining covers ALL open rows, not just the page', async () => {
  // Six open challenges, only four returned (the row cap). "pts left" has
  // to count all six — summing the page would understate it the moment a
  // fifth challenge opens, which is exactly the regression the cap invites.
  const allRows = Array.from({ length: 6 }, (_, i) =>
    row({ id: i + 1, reward: '100 pts', my_activity_count: 0 }));
  const { app } = makeApp(
    { season: SEASON, rows: allRows.slice(0, 4), allRows, total: 6 },
    { user: USER }
  );
  const { body } = await get(app, '/api/home-panels');
  const panel = body.panels[0];
  assert.equal(panel.challenges.length, 4, 'the page is capped');
  assert.equal(panel.total, 6);
  assert.equal(panel.points_remaining, 600,
    'six open rows at 100 each — not 400 from the four returned');
});

test('GET /api/home-panels: prose in an OFF-page open reward still withholds the total', async () => {
  // The prose row is beyond the cap, so a page-scoped sum would have
  // happily reported a number that ignores it.
  const allRows = [
    ...Array.from({ length: 4 }, (_, i) =>
      row({ id: i + 1, reward: '100 pts', my_activity_count: 0 })),
    row({ id: 5, reward: '½ of your final credits', my_activity_count: 0 }),
  ];
  const { app } = makeApp(
    { season: SEASON, rows: allRows.slice(0, 4), allRows, total: 5 },
    { user: USER }
  );
  const { body } = await get(app, '/api/home-panels');
  assert.equal(body.panels[0].points_remaining, null);
});

test('the totals query asks for the open rewards, and the row query is capped at 4', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  await get(app, '/api/home-panels');
  const totals = calls.find((c) => c.sql.includes('AS all_total'));
  assert.match(totals.sql, /array_agg\(COALESCE\(c\.reward, ct\.reward\)\) FILTER \( WHERE \(.*?\) AND NOT \(/,
    'open rewards come from the full-predicate query, not the page');
  // One statement, two counts: the collapsed scope for `total` and the
  // expanded one for `all_total`, so the footer can tell "nothing to expand"
  // from "finished challenges behind the toggle" (#1824) with no extra trip.
  assert.match(totals.sql, /COUNT\(\*\)::int AS all_total/);
  const outerWhere = totals.sql.slice(totals.sql.lastIndexOf('WHERE se.season_id'));
  assert.doesNotMatch(outerWhere, /c\.completed = FALSE/,
    'the outer WHERE is the expanded scope; open-only lives in the FILTERs');
  const rowQuery = calls.find((c) => c.sql.includes('LIMIT $3'));
  // Four 40px rows is what fits the DESKTOP tile under --home-panel-max-h;
  // the footer reads "See all N" when total exceeds it. The phone shape draws
  // only two of them (#968) but the server still sends four: it has no idea
  // what viewport is asking, and sending the desktop budget is what lets a
  // window dragged across 640px repaint from cache with no refetch.
  assert.equal(rowQuery.params[2], 4);
  const route = read('src/routes/home-panels.js');
  assert.match(route, /const CHALLENGE_ROW_LIMIT = 4;/);
});

test('GET /api/home-panels: legacy hidden preferences never suppress fixed sections', async () => {
  for (const hidden of [[], ['challenges'], ['challenges', 'create'], ['discover', 'retired-panel']]) {
    const { app, calls, state } = makeApp(
      { season: SEASON, rows: [row()], hidden }, { user: USER }
    );
    // A second read models reload/another device: no one-off preference reset.
    for (let visit = 0; visit < 2; visit++) {
      const { status, body } = await get(app, '/api/home-panels');
      assert.equal(status, 200);
      assert.deepEqual(body.panels.map((p) => p.key), ['challenges', 'discover', 'create']);
      assert.equal(body.panels[0].challenges.length, 1, 'real challenge data is restored');
      assert.deepEqual(body.hidden, [], 'cached clients also see every section');
      assert.ok(body.registry.every((p) => p.removable === false));
    }
    assert.deepEqual(state.hidden, hidden, 'no preference migration is needed');
    assert.ok(calls.every(({ sql }) => !sql.includes('home_panels_hidden')));
  }
});

test('GET /api/home-panels: ?demo=1 is a no-op outside staging', async () => {
  assert.notEqual(process.env.USERNODE_ENV, 'staging', 'test env sanity');
  const { app } = makeApp({ season: SEASON, rows: [row({ goal: 'Real goal' })] }, { user: USER });
  const { body } = await get(app, '/api/home-panels?demo=1');
  assert.equal(body.panels[0].challenges[0].goal, 'Real goal');
  assert.equal(body.panels[0].demo, undefined);
});

// The demo payload is what the before/after screenshots and the dapp.json
// check actually render (/?demo=1), so the states a reviewer is meant to
// compare have to survive the four-slot budget — not merely exist in the
// fixture and fall off the bottom.
test('GET ?demo=1 in staging spends its four slots on both kinds of DONE', async () => {
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  let body;
  try {
    const { app } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
    ({ body } = await get(app, '/api/home-panels?demo=1'));
  } finally {
    process.env.USERNODE_ENV = prev;
  }
  const p = body.panels[0];
  assert.equal(p.demo, true);
  assert.equal(p.challenges.length, 4, 'the collapsed block draws four rows');

  // Not-done first (the client mirrors this order), then the two finished
  // ones ADJACENT: a ✓ with no bar, and a ✓ over a bar filled end to end.
  // Seeing the two kinds of "done" side by side is the point.
  const done = p.challenges.filter((c) => c.progress.done);
  assert.equal(done.length, 2);
  assert.deepEqual(p.challenges.map((c) => !!c.progress.done),
    [false, false, true, true], 'the done pair sits at the bottom, together');
  const binaryDone = done.find((c) => !c.metric);
  const numericDone = done.find((c) => c.metric);
  assert.ok(binaryDone, 'a finished BINARY challenge (✓, no bar)');
  assert.ok(numericDone, 'a finished NUMERIC challenge (✓ over a full bar)');
  assert.equal(numericDone.progress.current, numericDone.progress.target,
    'full target, or the bar is not full and the state is not the one being shown');

  // And a part-filled numeric is still up top, so "in progress" and
  // "finished" are both readable in one shot.
  const partial = p.challenges.find((c) => c.metric && !c.progress.done
    && c.progress.current > 0);
  assert.ok(partial, 'the part-filled bar keeps its slot');
  assert.equal(p.done, 2, 'the header counter agrees with the glyphs');
});

// Old clients cannot save a preference that the current UI cannot restore.
test('POST visibility is retired and never mutates saved preferences', async () => {
  const hidden = ['challenges', 'create'];
  const { app, calls, state } = makeApp({ season: SEASON, rows: [], hidden }, { user: USER });
  for (const key of ['challenges', 'create', 'discover', 'nope']) {
    for (const hide of [true, false]) {
      const { status } = await post(app, `/api/home-panels/${key}/visibility`, { hidden: hide });
      assert.equal(status, 404);
    }
  }
  assert.deepEqual(state.hidden, hidden);
  assert.equal(calls.length, 0);
});

// ─── Expand mode ──────────────────────────────────────────────────────

test('GET ?expand=challenges drops the not-completed/in-window filters', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  await get(app, '/api/home-panels?expand=challenges');
  const queries = calls.filter((c) => c.sql.includes('FROM challenges c'));
  for (const q of queries) {
    // Still scoped to the season's PUBLIC events and organiser-enabled…
    assert.match(q.sql, /se\.internal = FALSE/);
    assert.match(q.sql, /c\.enabled = TRUE/);
  }
  // …but the two filters that define "open" are gone, which is how the
  // expanded list can show finished challenges and their ✓ marks. The row
  // query is judged on its WHERE clause (its SELECT list carries the open
  // predicate as `is_open`); the totals query, whose FILTERs would otherwise
  // narrow `total` and `done` back to open rows, is judged whole.
  const rowQuery = queries.find((c) => c.sql.includes('LIMIT $3'));
  const totalsQuery = queries.find((c) => c !== rowQuery);
  for (const sql of [rowQuery.sql.slice(rowQuery.sql.lastIndexOf('WHERE se.season_id')), totalsQuery.sql]) {
    assert.doesNotMatch(sql, /c\.completed = FALSE/);
    assert.doesNotMatch(sql, /COALESCE\(c\.schedule_start/);
  }
  // And the row cap lifts.
  assert.equal(rowQuery.params[2], 40);
  // Each row still says whether it is open, so a closed one shows no countdown.
  assert.match(rowQuery.sql, /\) AS is_open/);
});

// Where each collapsed-mode query NARROWS by the open predicate: the row
// query's WHERE clause and the totals query's FILTERs. Matching a query's
// whole text would pass on the row query's `is_open` column alone.
const openNarrowing = (calls) => {
  const queries = calls.filter((c) => c.sql.includes('FROM challenges c'));
  const rowQuery = queries.find((c) => c.sql.includes('LIMIT $3'));
  const totalsQuery = queries.find((c) => c !== rowQuery);
  return [
    rowQuery.sql.slice(rowQuery.sql.lastIndexOf('WHERE se.season_id')),
    totalsQuery.sql.slice(0, totalsQuery.sql.lastIndexOf('WHERE se.season_id')),
  ];
};

test('GET without expand keeps the strict open filter and the 4-row cap', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  for (const sql of openNarrowing(calls)) assert.match(sql, /c\.completed = FALSE/);
  assert.equal(calls.find((c) => c.sql.includes('LIMIT $3')).params[2], 4);
  assert.equal(body.panels[0].expanded, false);
});

test('GET ?expand names ONE panel — an unknown name expands nothing', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  const { body } = await get(app, '/api/home-panels?expand=not-a-panel');
  assert.equal(body.panels[0].expanded, false);
  for (const sql of openNarrowing(calls)) assert.match(sql, /c\.completed = FALSE/);
});

// ─── Drag position ────────────────────────────────────────────────────

// The registry is what says a block EXISTS at all — it is how the two marker
// blocks, which build no payload, render. All are fixed sections.
test('the registry describes every fixed block for current and cached clients', async () => {
  const { app } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const byKey = Object.fromEntries(body.registry.map((r) => [r.key, r]));
  assert.deepEqual(Object.keys(byKey), ['challenges', 'discover', 'create']);
  // Discover is the shell's only door to the app directory.
  assert.equal(byKey.discover.removable, false);
  assert.equal(byKey.challenges.removable, false);
  assert.equal(byKey.create.removable, false);

  // FOOTPRINTS ARE GONE. Each entry used to carry a per-column-count `sizes`
  // table — asymmetric for two of the three, so a phone got a full-width row
  // where a desktop got a 2x2 tile — and the layout route's overlap check ran
  // on the same numbers, so a patched client could not persist a
  // self-overlapping arrangement. THE UI OVERHAUL made all three fixed
  // sections of the home screen, so nothing is placed and there is no
  // footprint to agree on.
  for (const entry of body.registry) {
    assert.equal(entry.sizes, undefined, `${entry.key} carries no footprint`);
  }
  // Placement was already not this route's business.
  assert.equal(body.positions, undefined);
});

test('fixed sections are independent of app creation quota', () => {
  const route = read('src/routes/home-panels.js');
  assert.doesNotMatch(route.replace(/^\s*\/\/.*$/gm, ''), /canCreateApps|app_quota/);
});

// The placement endpoint is gone: a widget's home is a real (column, row)
// cell now, written for the whole grid at once by PUT /api/home-layout.
test('the card-count position endpoint is retired', async () => {
  const { app } = makeApp({ season: SEASON, rows: [] }, { user: USER });
  const res = await post(app, '/api/home-panels/challenges/position', { index: 4 });
  assert.equal(res.status, 404);
  const route = read('src/routes/home-panels.js');
  assert.doesNotMatch(route, /router\.post\('\/api\/home-panels\/:key\/position'/);
  assert.doesNotMatch(route, /MAX_PANEL_POSITION =/);
  // The separate legacy placement column survives, but nothing reads
  // it — a stale reader would silently resurrect the old placement model.
  const schema = read('src/db/schema.sql');
  assert.match(schema, /home_panel_positions JSONB NOT NULL DEFAULT '\{\}'/);
  assert.match(schema, /RETIRED — superseded by the `user_home_layout` table/);
  // Matched against code, not comments — the one remaining mention is the
  // historical notes explaining why it is gone.
  assert.doesNotMatch(route.replace(/^\s*\/\/.*$/gm, ''), /home_panel_positions/);
});

// ─── Source pins ──────────────────────────────────────────────────────

test('schema removes the retired visibility column on existing and fresh databases', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE users DROP COLUMN IF EXISTS home_panels_hidden;/);
  assert.doesNotMatch(schema, /ADD COLUMN[^;]*home_panels_hidden/);
});

test('the route is mounted in server.js', () => {
  const server = read('server.js');
  assert.match(server, /require\('\.\/src\/routes\/home-panels'\)/);
  assert.match(server, /app\.use\(homePanelRoutes\(config\)\)/);
});

test('staging seeds open challenges covering every card state', () => {
  const migrate = read('src/db/migrate.js');
  // Four open (enabled, not completed, in-window) challenges…
  for (const id of [900510, 900511, 900512, 900513]) {
    assert.ok(migrate.includes(`(${id}, $1,`), `challenge ${id} seeded`);
  }
  // …two numeric templates behind them…
  assert.match(migrate, /\(900505, 'onchain'[\s\S]*?'count', 8, 'Apps tested'/);
  assert.match(migrate, /\(900506, 'social'[\s\S]*?'count', 5, 'Kudos'/);
  // …and viewer progress: one binary completion + three numeric units.
  assert.match(migrate, /\$\{base \+ 2\}, \$1, \$2, 'challenge_completion', 50/);
  assert.match(migrate, /\$\{base \+ 5\}[\s\S]*?900512/);
});

// ── THE LEADERBOARD FILL IS REMOVED ──────────────────────────────────
//
// The challenges panel used to carry a `leaderboard` block: the head of the
// Topochain standings plus the viewer's own row, falling back to the kudos
// board on a deployment with no public standings, memoised for 30s because
// both boards are identical for every viewer. Twenty tests covered it, and
// they are gone with it — the two board queries are not made any more, so
// there is nothing left here to assert.
//
// It went because of what it did to the CARD, not to the server: two labelled
// lists with two different tap destinations inside one area called Challenges
// made the reader work out which one they were looking at before they could
// read either. The standings are a screen, and the section's heading links to
// it in every branch. `buildTopochainFill`, `buildLeaderboardFill`,
// `rankedUsersCached`, `standingsBoardCached`, `_resetFillCache`,
// `FILL_TOP_ROWS` and both service imports went with them; the services
// themselves are untouched and still serve the Leaderboard screen.

// ── Staging demo variants (#947) ──────────────────────────────────────
//
// ?demo=1&challenges=few|none reach the SHORT-LIST states, which a staging
// clone can't otherwise show while its seeded season is live. Both are what
// the dapp.json checks and the before/after screenshots navigate to.

test('demoChallengesPanel: the few / none variants, and no standings preview', () => {
  const { demoChallengesPanel } = require('../src/routes/home-panels');

  const few = demoChallengesPanel({ variant: 'few', username: 'tester' });
  assert.equal(few.challenges.length, 2, 'two rows: the shrink state');
  assert.equal(few.total, 2, 'nothing past the cap to "see all" of');
  // …and nothing behind an expansion either, which makes this route THE
  // no-expand-toggle state of #1824. It stays that way when asked for the
  // expanded scope: there is no finished row to reveal here on purpose.
  assert.equal(few.all_total, 2, 'so the footer draws no expand toggle');
  const fewExpanded = demoChallengesPanel({ variant: 'few', expanded: true, username: 'tester' });
  assert.equal(fewExpanded.challenges.length, 2, 'expanding reveals nothing more');
  assert.equal(fewExpanded.all_total, 2);
  // One metered and one binary, so the progress-bar lane is still exercised.
  assert.ok(few.challenges.some((c) => c.metric), 'a metered row');
  assert.ok(few.challenges.some((c) => !c.metric), 'a binary row');
  // NO `leaderboard` ON ANY DEMO PAYLOAD. The standings preview is removed, so
  // the demo variants carry challenges and nothing else — and `?board=kudos`,
  // which existed only to reach that preview's fallback board, is gone with it.
  assert.equal(few.leaderboard, undefined, 'no standings preview to demo');

  const none = demoChallengesPanel({ variant: 'none', username: 'tester' });
  assert.equal(none.total, 0);
  assert.deepEqual(none.challenges, []);
  assert.equal(none.season, null);
  assert.equal(none.leaderboard, undefined);

  // No variant → the four-row default.
  const base = demoChallengesPanel({ username: 'tester' });
  assert.equal(base.challenges.length, 4);
  assert.equal(base.total, 7);
  // Four drawn of seven, so the default demo route KEEPS the toggle — the
  // other half of the #1824 pair the checks navigate to.
  assert.equal(base.all_total, 7);
  assert.equal(demoChallengesPanel({ expanded: true, username: 'tester' }).all_total, 7);
  assert.equal(base.leaderboard, undefined);

  // An unknown value falls through to that default rather than erroring.
  assert.equal(demoChallengesPanel({ variant: 'wat' }).challenges.length, 4);
});

// /?demo=1 is where the card artwork is reviewed (and dapp.json's check looks
// for it), so the demo rows carry slugs the client registry actually draws —
// and one of the four collapsed rows carries none, so the kind-icon fallback
// is on the same screen.
test('demoChallengesPanel: registry artwork on the rows, with one fallback in the collapsed four', () => {
  const { demoChallengesPanel } = require('../src/routes/home-panels');
  const registry = read('frontend/src/lib/challenge-illustrations.ts');
  const members = new Set([...registry.matchAll(/^\s*'([a-z0-9-]+)': \{ label:/gm)].map((m) => m[1]));
  assert.ok(members.size >= 9, 'the registry keys parse out of the source');

  const all = demoChallengesPanel({ expanded: true, username: 'tester' }).challenges;
  for (const c of all) {
    assert.ok('illustration' in c, `demo row ${c.id} carries the key, like buildChallengeRow`);
    if (c.illustration !== null) {
      assert.ok(members.has(c.illustration), `demo row ${c.id}: ${c.illustration} is a registry slug`);
    }
  }
  const collapsed = demoChallengesPanel({ username: 'tester' }).challenges;
  assert.ok(collapsed.some((c) => c.illustration), 'the collapsed route draws artwork');
  assert.ok(collapsed.some((c) => c.illustration === null), 'and keeps one fallback in view');
});

test('the demo variants are staging-only, like ?demo=1 itself', async () => {
  // USERNODE_ENV is not 'staging' in the test process, so the query param
  // must be inert: the real builder runs and the season fixture wins.
  const { app } = makeApp({ season: null, rows: [] }, { user: USER });
  const { body } = await get(app, '/api/home-panels?demo=1&challenges=few');
  const panel = body.panels.find((p) => p.key === 'challenges');
  assert.equal(panel.demo, undefined, 'no demo payload outside staging');
  assert.deepEqual(panel.challenges, []);
  // The demo payload's obviously-fake names must never reach a real response.
  assert.doesNotMatch(JSON.stringify(panel), /staging-demo-/);
});

// Declared checks used to be a capped resource — the reader kept only the
// first MAX_TESTS entries, so position decided whether a check ever ran and
// each new one cost an older one its slot. #1019 runs every declared check,
// so the assertion here is the one that still bites: the reader KEEPS this
// entry (malformed ones are dropped silently) and the manifest hasn't grown
// past MAX_DECLARED_TESTS and started shedding its tail again.
test('dapp.json checks the new state, and the reader keeps it', () => {
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'))
  );
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'checks past the ceiling never run');
  const kept = meta.tests;
  const none = kept.find((t) => t.path === '/?demo=1&challenges=none');
  assert.ok(none, 'the no-challenges check must survive the manifest reader');
  // ONE LIST, and between seasons one line of it. The check used to assert the
  // standings preview underneath (`data-fill="3"`, `home-panel-lb-row`); that
  // preview is removed, so what is left to assert is that the block says why
  // it is quiet and shows nothing else.
  assert.match(none.expectSelector, /data-rows="0"/);
  assert.doesNotMatch(none.expectSelector, /data-fill|home-panel-lb-row/);
  assert.equal(none.expectText, 'No challenges are running right now');

  // The #911 check must keep running unchanged: four challenges leave no room
  // to fill, so that payload's markup is untouched by this change.
  assert.ok(kept.some((t) => t.path === '/?demo=1' && /home-challenge-card \[role=progressbar\]/.test(t.expectSelector)),
    'the existing challenges-widget check still runs');

  // #1824, both directions. The `few` route shows every challenge it has, so
  // its footer must carry the way out and NO expand toggle; the default route
  // is truncated, so it must still carry one. A check on only the first would
  // pass just as well if the toggle were deleted outright.
  const allShown = kept.find((t) => t.path === '/?demo=1&challenges=few');
  assert.ok(allShown, 'the all-shown check must survive the manifest reader');
  assert.match(allShown.expectSelector, /home-panel-footer/);
  assert.match(allShown.expectSelector, /:not\(:has\(\.home-panel-expand\)\)/,
    'it asserts the ABSENCE of the toggle, which is the whole fix');
  assert.ok(kept.some((t) => t.path === '/?demo=1'
    && /home-panel-expand/.test(t.expectSelector)),
    'and a truncated list still declares the toggle it keeps');
});
