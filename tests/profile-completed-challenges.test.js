// GET /api/me/challenges/completed (issue #982) — the Profile screen's
// "Completed challenges" section.
//
// THE BUG THIS PINS. The section used to filter the season's challenge
// grid client-side on `c.completed`, which is an ORGANISER flag about the
// CHALLENGE ("this one is over"), not a per-user signal. On production
// that meant 28 of Season 1's 34 enabled challenges rendered as every
// signed-in person's own completions — including the 165 of 299 accounts
// with no challenge activity at all.
//
// Contracts guarded here:
//
//   1. Done-ness is the SHARED rule (home-panels' DONE_EXPR /
//      resolveProgress), not a third copy: binary from "any activity
//      row", numeric from the ledger row count vs the target,
//      'blocks_produced' from the newest snapshot, and target <= 1 with
//      any credit at all counts as done.
//   2. A challenge the viewer never touched is EXCLUDED, whatever the
//      organiser flag says; an organiser-finished challenge the viewer
//      DID complete is INCLUDED (a finished challenge you completed is
//      exactly what belongs in this list).
//   3. The season resolver is the FORGIVING one. home-panels'
//      fetchCurrentSeason additionally demands the window contain NOW(),
//      and production's only season closed on 2026-06-30 — using it here
//      would empty every profile.
//   4. Me-scoped, and the per-user aggregates are keyed on the SESSION
//      user id, never on anything client-supplied.
//
// Mock pool + throwaway express app, no live DB.
//
// Run with: node --test tests/profile-completed-challenges.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

const { resolveProgress } = require('../src/routes/home-panels');
const { fetchProfileSeason, COMPLETED_LIMIT } = require('../src/routes/profile');

// A joined challenges⋈challenge_templates row with the per-user
// aggregates, as the route's own SELECT produces it.
function row(over = {}) {
  return {
    id: 1,
    season_event_id: 100,
    event_name: 'Regular event',
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
    t_schedule_start: null, t_schedule_end: null,
    my_activity_count: 0, my_points: 0, my_blocks: null,
    my_last_activity_at: null, my_done: false,
    ...over,
  };
}

// The mock stands in for DONE_EXPR: `rows` are ALL the season's in-scope
// challenges, and the route's own `AND (DONE_EXPR)` is modelled by
// filtering on the row's `my_done`. That keeps the fixture honest about
// which rows the SQL would actually return.
function makeMockPool(state) {
  const calls = [];
  const pool = {
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      calls.push({ sql, params });

      // Season queries, most-specific first — matched in the same order
      // the resolver asks them: an explicit preferred id, then "active AND
      // stocked" (the EXISTS discriminator), then plain "active", then any.
      if (sql.includes('FROM seasons') && sql.includes('WHERE id = $1')) {
        return { rows: state.preferredSeason ? [state.preferredSeason] : [] };
      }
      if (sql.includes('FROM seasons') && sql.includes('FROM season_events')) {
        return { rows: state.stockedSeason ? [state.stockedSeason] : [] };
      }
      if (sql.includes('FROM seasons') && sql.includes('is_active = TRUE')) {
        return { rows: state.activeSeason ? [state.activeSeason] : [] };
      }
      if (sql.includes('FROM seasons')) {
        return { rows: state.anySeason ? [state.anySeason] : [] };
      }
      // The season's First challenges (profile.js viewerDoneRule,
      // 2026-10-01): loadOnboarding's rows, none unless a test brings them.
      if (sql.startsWith('/* challenge onboarding */')) {
        return { rows: state.onboardingRows || [] };
      }
      if (sql.includes('COUNT(*)::int AS total')) {
        const all = state.rows || [];
        return {
          rows: [{ total: all.length, done: all.filter((r) => r.my_done).length }],
        };
      }
      if (sql.includes('FROM challenges c')) {
        const limit = Number(params[2]) || (state.rows || []).length;
        return { rows: (state.rows || []).filter((r) => r.my_done).slice(0, limit) };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 90)}`);
    },
  };
  return { pool, calls };
}

function makeApp(state, { user } = {}) {
  const { pool, calls } = makeMockPool(state);
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  let routes;
  try {
    delete require.cache[require.resolve('../src/routes/profile')];
    routes = require('../src/routes/profile').profileRoutes();
  } finally {
    poolModule.getPool = originalGetPool;
  }
  const app = express();
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

const fetchCompleted = (app) => get(app, '/api/me/challenges/completed');

// ─── The done rule itself ─────────────────────────────────────────────
//
// Asserted against the SHARED resolveProgress, so if the rule ever moves
// these cases move with it rather than silently describing a stale copy.

test('binary challenge: any activity row at all is done', () => {
  const p = resolveProgress({ metricKind: null, metricTarget: null, activityCount: 1 });
  assert.equal(p.done, true);
  assert.equal(resolveProgress({
    metricKind: null, metricTarget: null, activityCount: 0,
  }).done, false);
});

test('numeric challenge at 3 of 8 is NOT done', () => {
  // The trap the old `c.completed` filter hid: "has any ledger row" is not
  // done-ness. Three of eight dApps tested is emphatically unfinished.
  const p = resolveProgress({ metricKind: 'count', metricTarget: 8, activityCount: 3 });
  assert.equal(p.done, false);
  assert.equal(p.current, 3);
  assert.equal(p.target, 8);
});

test('numeric challenge at 8 of 8 is done', () => {
  const p = resolveProgress({ metricKind: 'count', metricTarget: 8, activityCount: 8 });
  assert.equal(p.done, true);
  assert.equal(p.current, 8);
});

test('a target of 1 with any credit is done', () => {
  // "Produce your first block" must not read as 0/1 once the ledger row
  // credited it.
  const p = resolveProgress({ metricKind: 'count', metricTarget: 1, activityCount: 1 });
  assert.equal(p.done, true);
});

test('blocks_produced reads the snapshot, not the ledger row count', () => {
  const p = resolveProgress({
    metricKind: 'blocks_produced', metricTarget: 5, activityCount: 1, blocks: 5,
  });
  assert.equal(p.done, true);
  const short = resolveProgress({
    metricKind: 'blocks_produced', metricTarget: 5, activityCount: 9, blocks: 2,
  });
  assert.equal(short.done, false, 'nine ledger rows do not make five blocks');
});

// ─── Season resolution ────────────────────────────────────────────────

test('season resolver picks an is_active season whose window has CLOSED', async () => {
  // This is production's state today: Season 1 is_active = TRUE, ended
  // 2026-06-30. home-panels' fetchCurrentSeason returns null here, which
  // is why this route must not use it.
  const { pool, calls } = makeMockPool({ activeSeason: SEASON });
  const season = await fetchProfileSeason(pool);
  assert.deepEqual(season, SEASON);
  for (const { sql } of calls.filter((c) => c.sql.includes('FROM seasons'))) {
    const q = collapse(sql);
    assert.ok(!/starts_at <= NOW\(\)/.test(q) && !/ends_at >= NOW\(\)/.test(q),
      'the window must NOT be part of the predicate — a closed season still '
      + 'has completions worth showing');
    assert.match(q, /internal = FALSE/, 'internal seasons stay private');
  }
});

test('season resolver prefers an active season that HAS challenges', async () => {
  // The #982 sequel, and the reason the resolver got a step: production
  // runs Season 1 (58 challenges, ended, still is_active) alongside "Pre
  // Season 2" (is_active, starts later, zero challenges). Ordering by
  // starts_at DESC picks the empty one, and every profile's completions
  // vanish the moment an organiser opens the NEXT season. The stocked
  // season wins even though the plain active query would answer.
  const STOCKED = { id: 1, name: 'Season 1' };
  const { pool, calls } = makeMockPool({
    stockedSeason: STOCKED,
    activeSeason: { id: 2, name: 'Pre Season 2' },
  });
  assert.deepEqual(await fetchProfileSeason(pool), STOCKED);
  assert.equal(calls.length, 1, 'the stocked answer short-circuits the rest');
  // "In scope" has to mean the same thing the row list means, or the
  // resolver can pick a season whose only challenges the list then hides.
  const q = collapse(calls[0].sql);
  assert.match(q, /se\.internal = FALSE/);
  assert.match(q, /c\.enabled = TRUE/);
});

test('season resolver still answers when NO active season has challenges', async () => {
  // Strictly more forgiving at each step: an entirely challenge-less
  // deployment must not regress to "no season", or a brand-new install
  // shows an empty profile with no season name on it either.
  const { pool } = makeMockPool({ stockedSeason: null, activeSeason: SEASON });
  assert.deepEqual(await fetchProfileSeason(pool), SEASON);
});

test('season resolver falls back to the newest season when none is active', async () => {
  const { pool } = makeMockPool({
    stockedSeason: null, activeSeason: null, anySeason: { id: 2, name: 'Season 2' },
  });
  assert.deepEqual(await fetchProfileSeason(pool), { id: 2, name: 'Season 2' });
});

test('season resolver honors an explicit staging fixture before a newer clone season', async () => {
  const fixture = { id: 900500, name: 'Staging Demo Season' };
  const { pool, calls } = makeMockPool({
    preferredSeason: fixture,
    activeSeason: { id: 42, name: 'Newer cloned season' },
  });
  assert.deepEqual(await fetchProfileSeason(pool, 900500), fixture);
  assert.equal(calls.length, 1, 'the preferred fixture resolves without consulting the clone ordering');
  assert.deepEqual(calls[0].params, [900500]);
});

test('no season at all is an empty payload, not an error', async () => {
  const { app } = makeApp({ activeSeason: null, anySeason: null }, { user: USER });
  const res = await fetchCompleted(app);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { season: null, total: 0, done: 0, completed: [] });
});

test('the route does not call fetchCurrentSeason', () => {
  const route = read('src/routes/profile.js');
  const code = route.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /fetchCurrentSeason/,
    'the strict "running right now" resolver would empty every profile between seasons');
});

// ─── The endpoint ─────────────────────────────────────────────────────

test('only the viewer’s own completions come back', async () => {
  const { app } = makeApp({
    activeSeason: SEASON,
    rows: [
      row({ id: 1, my_done: true, my_activity_count: 1, my_points: 250, t_goal: 'Report a bug' }),
      // 3 of 8: has ledger rows, is NOT finished.
      row({ id: 2, my_done: false, my_activity_count: 3, my_points: 600,
        metric_type: 'count', metric_target: 8, t_goal: 'Test the dApps' }),
      // Never touched.
      row({ id: 3, my_done: false, my_activity_count: 0, t_goal: 'Untouched' }),
    ],
  }, { user: USER });

  const res = await fetchCompleted(app);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.completed.map((c) => c.id), [1]);
  assert.equal(res.body.total, 3, 'the totals span the whole in-scope set');
  assert.equal(res.body.done, 1);
  assert.deepEqual(res.body.season, { id: 1, name: 'Season 1' });
});

test('an ORGANISER-finished challenge the viewer completed is included', async () => {
  // 28 of production's 34 enabled Season 1 challenges carry completed =
  // TRUE. The scope predicate must keep them (they are real completions),
  // while the done filter is what decides whose list they land in.
  const { app } = makeApp({
    activeSeason: SEASON,
    rows: [row({ id: 9, completed: true, my_done: true, my_activity_count: 2, my_points: 300 })],
  }, { user: USER });
  const res = await fetchCompleted(app);
  assert.deepEqual(res.body.completed.map((c) => c.id), [9]);
});

test('an organiser-finished challenge the viewer NEVER touched is excluded', async () => {
  const { app } = makeApp({
    activeSeason: SEASON,
    rows: [row({ id: 9, completed: true, my_done: false, my_activity_count: 0 })],
  }, { user: USER });
  const res = await fetchCompleted(app);
  assert.deepEqual(res.body.completed, [],
    'this is the exact row the old client-side c.completed filter showed to everyone');
  assert.equal(res.body.total, 1);
  assert.equal(res.body.done, 0);
});

test('rows carry what the section renders: points, event, and the link target', async () => {
  const when = '2026-07-02T10:00:00.000Z';
  const { app } = makeApp({
    activeSeason: SEASON,
    rows: [row({
      id: 42, season_event_id: 77, event_name: 'June event',
      my_done: true, my_activity_count: 2, my_points: 450,
      my_last_activity_at: when, t_category: 'community', t_goal: 'Help other members',
    })],
  }, { user: USER });

  const c = (await fetchCompleted(app)).body.completed[0];
  assert.equal(c.id, 42);
  // season_event_id + id are the two segments of the row's href.
  assert.equal(c.season_event_id, 77);
  assert.equal(c.event_name, 'June event');
  assert.equal(c.earned_points, 450);
  assert.equal(c.activity_count, 2);
  assert.equal(c.last_activity_at, when);
  assert.equal(c.label, 'COMMUNITY');
  assert.equal(c.goal, 'Help other members');
  assert.equal(c.progress.done, true);
});

test('a challenge whose template row vanished is skipped, not a 500', async () => {
  const { app } = makeApp({
    activeSeason: SEASON,
    rows: [
      row({ id: 1, my_done: true, my_activity_count: 1 }),
      row({ id: 2, my_done: true, my_activity_count: 1, t_id: null }),
    ],
  }, { user: USER });
  const res = await fetchCompleted(app);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.completed.map((c) => c.id), [1]);
});

test('the row list is capped, and a truncated list SAYS so', async () => {
  const rows = [];
  for (let i = 0; i < COMPLETED_LIMIT + 5; i++) {
    rows.push(row({ id: i + 1, my_done: true, my_activity_count: 1 }));
  }
  const { app } = makeApp({ activeSeason: SEASON, rows }, { user: USER });
  const res = await fetchCompleted(app);
  assert.equal(res.body.completed.length, COMPLETED_LIMIT);
  assert.equal(res.body.truncated, true,
    'a capped list that reads as complete is worse than a short one that admits it');
  // The honest total still counts everything.
  assert.equal(res.body.total, COMPLETED_LIMIT + 5);
});

test('an uncapped list carries no `truncated` key at all', async () => {
  const { app } = makeApp({
    activeSeason: SEASON,
    rows: [row({ my_done: true, my_activity_count: 1 })],
  }, { user: USER });
  const res = await fetchCompleted(app);
  assert.equal('truncated' in res.body, false);
});

test('the per-user aggregates key on the SESSION user id', async () => {
  const { app, calls } = makeApp({
    activeSeason: SEASON,
    rows: [row({ my_done: true, my_activity_count: 1 })],
  }, { user: USER });
  await fetchCompleted(app);
  const rowQuery = calls.find((c) => c.sql.includes('FROM challenges c')
    && !c.sql.includes('COUNT(*)::int AS total')
    && !c.sql.startsWith('/* challenge onboarding */'));
  assert.equal(rowQuery.params[0], USER.id);
  assert.match(rowQuery.sql, /ua\.user_id = \$1/);
  // Nothing client-supplied may reach the query — the season comes from
  // the resolver, not from a query param.
  assert.equal(rowQuery.params[1], SEASON.id);
});

// ─── Source pins ──────────────────────────────────────────────────────

test('the done rule is REUSED from home-panels, not re-derived', () => {
  const route = read('src/routes/profile.js');
  assert.match(route, /require\('\.\/home-panels'\)/);
  for (const name of ['DONE_EXPR', 'MY_COUNT_SQL', 'MY_BLOCKS_SQL', 'ALL_CHALLENGE_WHERE']) {
    assert.ok(route.includes(name), `${name} must come from the shared module`);
  }
  // Those names have to actually be exported, or the require yields
  // undefined and the SQL silently interpolates "undefined".
  const panels = require('../src/routes/home-panels');
  for (const name of ['DONE_EXPR', 'MY_COUNT_SQL', 'MY_BLOCKS_SQL', 'ALL_CHALLENGE_WHERE']) {
    assert.equal(typeof panels[name], 'string', `${name} must be exported`);
  }
  // And no second copy of the CASE expression may live in this route.
  assert.doesNotMatch(route, /WHEN COALESCE\(c\.metric_type/);
});

test('the profile screen no longer filters on the organiser flag', () => {
  const client = read('frontend/src/features/profile/profile.js');
  assert.doesNotMatch(client, /challenges\.filter\(\(c\) => c\.completed\)/,
    'that filter is the bug: c.completed is an organiser flag, not a per-user signal');
  assert.match(client, /\/api\/me\/challenges\/completed/);
});

test('Me counts the SAME completions, through the one totals query', () => {
  // The prototype's Me shows a "challenges" stat card rather than a list:
  // GET /api/me/summary returns the count, and it must be this route's own
  // done-count — the one readChallengeTotals query, not a second copy of the
  // rule — so the card, Home and the Challenges tab agree.
  const route = read('src/routes/profile.js');
  const summary = route.slice(route.indexOf("router.get('/api/me/summary'"));
  assert.match(summary, /readChallengeTotals\(pool, req\.user\.id, season\.id\)/);
  const completed = route.slice(route.indexOf("router.get('/api/me/challenges/completed'"),
    route.indexOf("router.get('/api/me/summary'"));
  // The completed list reads the viewer's done rule once and hands it to the
  // totals (2026-10-01), so the list and its "N of M done" are one answer.
  assert.match(completed, /readChallengeTotals\(pool, req\.user\.id, season\.id, rule\)/,
    'and the completed list\'s "N of M done" reads the same helper');
  // The rule is DONE_EXPR with the First challenges' lifetime answer over it
  // (home-panels.js onboardingDoneExpr), the one Home counts with.
  assert.equal((route.match(/COUNT\(\*\) FILTER \(WHERE \$\{done\.sql\(3\)\}\)/g) || []).length, 1,
    'one copy of the totals SQL');
  assert.match(route, /sql: \(n\) => onboardingDoneExpr\(`\$\$\{n\}`, `\$\$\{n \+ 1\}`\),/);
  assert.match(route, /if \(!onboarding\) return \{ sql: \(\) => DONE_EXPR, params: \[\] \};/);
  const client = read('frontend/src/features/profile/profile.js');
  assert.match(client, /\/api\/me\/summary/);
});

// 2026-10-01: a First challenge counts done on Me the way it does on Home and
// on the Getting started card: from every credit on its TEMPLATE, an earlier
// season's included (loadOnboarding's lifetime answer), not only from credits
// on this season's row. Both statements splice the same rule, with the gate's
// ids and the done ones as their last two parameters.
test('a First challenge done from an earlier season counts on Me as it does on Home', async () => {
  const first = (id, activityCount) => ({
    id, season_event_id: 100, challenge_template_id: id + 100, display_order: id,
    enabled: true, completed: false, schedule_start: null, schedule_end: null,
    metric_type: null, metric_target: null, activity_count: activityCount,
    completion_recorded: false, blocks: null, gate: false, tour_done: false, unlocked: false,
  });
  const { app, calls } = makeApp({
    activeSeason: SEASON,
    rows: [row({ id: 1, my_done: true })],
    onboardingRows: [first(1, 1), first(2, 0)],
  }, { user: USER });
  const res = await fetchCompleted(app);
  assert.equal(res.status, 200);
  const totals = calls.find((c) => c.sql.includes('COUNT(*)::int AS total'));
  assert.deepEqual(totals.params, [USER.id, SEASON.id, [1, 2], [1]]);
  assert.match(totals.sql, /COUNT\(\*\) FILTER \(WHERE CASE WHEN c\.id = ANY\(\$3::bigint\[\]\) THEN c\.id = ANY\(\$4::bigint\[\]\) ELSE/);
  const list = calls.find((c) => c.sql.includes('AS my_last_activity_at'));
  assert.deepEqual(list.params.slice(3), [[1, 2], [1]], 'the list after its own three parameters');
  assert.match(list.sql, /CASE WHEN c\.id = ANY\(\$4::bigint\[\]\) THEN c\.id = ANY\(\$5::bigint\[\]\) ELSE/);
});
