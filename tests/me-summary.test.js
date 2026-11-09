// GET /api/me/summary — the Me page's three stat cards and "Your
// contributions", in one me-scoped read (src/routes/profile.js).
//
// The navigation prototype's Me leads with merged / kudos / challenges and
// closes with the viewer's recent merged proposals. #2740 deferred both
// because the numbers live in three subsystems and nothing added them up.
// This pins what each number MEANS, that the route is one round of reads
// the database can index, and that ?demo=1 fills a staging preview (whose
// chat_sessions are staging:private) without ever covering real data.
//
// Run with: node --test tests/me-summary.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

const profile = require('../src/routes/profile');

// ─── What each number means ─────────────────────────────────────────────

test('kudos is what the product calls kudos RECEIVED: direct PR kudos plus awarded bounties', () => {
  const summary = profile.shapeSummary({
    counts: { merged: 9, apps: 3, direct_kudos: 2, bounty_kudos: 1, member_since: '2026-03-04T10:00:00Z' },
    contributions: [],
    challenges: { done: 2, total: 7, season: { id: '3', name: 'Season 3' } },
  });
  assert.equal(summary.merged, 9);
  assert.equal(summary.apps, 3);
  assert.equal(summary.kudos, 3, 'the same two arms the Top users board adds up');
  assert.equal(summary.memberSince, '2026-03-04T10:00:00.000Z');
  assert.deepEqual(summary.challenges, { done: 2, total: 7, season: { id: 3, name: 'Season 3' } });
});

test('an account with nothing yet is zeros, not a failure', () => {
  const summary = profile.shapeSummary({ counts: undefined, contributions: undefined, challenges: null });
  assert.deepEqual(summary, {
    merged: 0, apps: 0, proposalsTotal: 0, inProgress: 0, kudos: 0, memberSince: null,
    challenges: { done: 0, total: 0, season: null },
    contributions: [],
  });
});

test('a contribution carries what its row needs to open it, and a title it can always show', () => {
  const base = {
    session_id: 41, pr_number: 213, pr_title: 'Messages as a tab', session_title: 'chat title',
    merged_at: '2026-09-20T10:00:00Z', created_at: '2026-09-01T10:00:00Z',
    app_slug: 'usernode-2d5619', app_name: 'Homeroom', icon_emoji: null, icon_image_id: null,
    self_hosted: true, kudos: '4',
  };
  assert.deepEqual(profile.shapeContribution(base), {
    sessionId: 41, prNumber: 213, title: 'Messages as a tab',
    appSlug: 'usernode-2d5619', appName: 'Homeroom', appIconEmoji: null, appIconUrl: null,
    platform: true, mergedAt: '2026-09-20T10:00:00.000Z', kudos: 4,
  });
  // The fallbacks, in order: the session's title, then the PR number.
  assert.equal(profile.shapeContribution({ ...base, pr_title: '  ' }).title, 'chat title');
  assert.equal(profile.shapeContribution({ ...base, pr_title: null, session_title: null }).title, 'Proposal #213');
  // A legacy merge with no merged_at is dated by when it started.
  assert.equal(profile.shapeContribution({ ...base, merged_at: null }).mergedAt, '2026-09-01T10:00:00.000Z');
  // The icon is only ever the platform's own /app-icons/<id> path.
  assert.equal(profile.shapeContribution({ ...base, icon_image_id: 'abc123' }).appIconUrl, '/app-icons/abc123');
  assert.equal(profile.shapeContribution({ ...base, icon_image_id: '../x' }).appIconUrl, null);
});

test('the SQL counts the viewer\'s own, authored, non-headless proposals and bounded rows', () => {
  const route = read('src/routes/profile.js');
  const counts = collapse(route.slice(route.indexOf('const SUMMARY_COUNTS_SQL'), route.indexOf('const SUMMARY_CONTRIBUTIONS_SQL')));
  // Counted once live (live_at): a merge still going live is in progress.
  assert.match(counts, /COUNT\(\*\) FILTER \(WHERE cs\.status = 'merged' AND cs\.live_at IS NOT NULL\)::int AS merged/);
  assert.match(counts, /WHERE cs\.user_id = \$1 AND cs\.is_headless = FALSE/,
    'auto sessions are not proposals anybody authored');
  assert.match(counts, /FROM pr_kudos pk JOIN chat_sessions ks ON ks\.id = pk\.session_id WHERE ks\.user_id = \$1/);
  assert.match(counts, /ib\.awarded_user_id = \$1 AND ib\.status = 'awarded'/);
  const list = collapse(route.slice(route.indexOf('const SUMMARY_CONTRIBUTIONS_SQL'), route.indexOf('const SELF_APP_SQL')));
  assert.match(list, /cs\.status = 'merged' AND cs\.live_at IS NOT NULL/);
  assert.match(list, /ORDER BY cs\.merged_at DESC NULLS LAST, cs\.id DESC LIMIT \$2/);
  assert.equal(profile.SUMMARY_CONTRIBUTIONS_LIMIT, 5);
});

// ─── The demo overlay ───────────────────────────────────────────────────

const SELF_APP = { slug: 'usernode-2d5619', name: 'Homeroom', icon_emoji: null, icon_image_id: null };
const EMPTY = profile.shapeSummary({ counts: {}, contributions: [], challenges: { done: 1, total: 9, season: { id: 1, name: 'S1' } } });

test('?demo=1 fills an EMPTY lower half, and never covers real data', () => {
  const demo = profile.withDemoSummary(EMPTY, SELF_APP, Date.parse('2026-09-23T00:00:00Z'));
  assert.equal(demo.demo, true);
  assert.equal(demo.merged, profile.DEMO_CONTRIBUTIONS.length);
  assert.equal(demo.contributions.length, profile.DEMO_CONTRIBUTIONS.length);
  assert.ok(demo.contributions.every((c) => c.appSlug === 'usernode-2d5619' && c.platform));
  assert.deepEqual(demo.challenges, EMPTY.challenges, 'challenge totals survive the clone and are never mocked');
  const real = { ...EMPTY, merged: 1, contributions: [{ sessionId: 5 }] };
  assert.equal(profile.withDemoSummary(real, SELF_APP), real, 'REAL DATA WINS');
  assert.equal(profile.withDemoSummary(EMPTY, null), EMPTY, 'no platform app, nothing to point the rows at');
});

test('each demo row opens the very merged mock it names', () => {
  // stagingMockMerged (src/routes/votes.js) serves these ids under the same
  // flag, so a demo row's link lands on a real proposal page in a preview.
  const votes = read('src/routes/votes.js');
  const mocks = votes.slice(votes.indexOf('function stagingMockMerged('));
  for (const row of profile.DEMO_CONTRIBUTIONS) {
    assert.ok(mocks.includes(String(row.sessionId)), `${row.sessionId} is a merged mock`);
    const title = row.title.replace(/^\[Mock\] /, '');
    assert.ok(mocks.includes(title.slice(0, 30)) || mocks.includes(row.title.slice(0, 40)),
      `"${row.title}" is that mock's title`);
  }
});

// ─── The route ──────────────────────────────────────────────────────────

function mockPool(state) {
  const calls = [];
  return {
    calls,
    async query(raw, params = []) {
      const sql = collapse(raw);
      calls.push({ sql, params });
      if (sql.includes('AS direct_kudos')) return { rows: [state.counts || {}] };
      if (sql.includes('AS apps_opened')) return { rows: [{ apps_opened: state.appsOpened || 0 }] };
      if (sql.includes('FROM chat_sessions cs, since')) return { rows: [{ merged: state.weekMerged || 0 }] };
      if (sql.includes('JOIN apps a ON a.id = cs.app_id, since')) return { rows: state.weekApps || [] };
      if (sql.includes('LEFT JOIN app_activity')) return { rows: state.activityDays || WEEK };
      if (sql.includes("cs.status = 'merged' AND cs.live_at IS NOT NULL ORDER BY cs.merged_at")) return { rows: state.contributions || [] };
      if (sql.includes('FROM apps WHERE self_hosted = TRUE')) return { rows: state.selfApp ? [state.selfApp] : [] };
      if (sql.includes('FROM seasons')) return { rows: state.season ? [state.season] : [] };
      if (sql.includes('COUNT(*)::int AS done')) return { rows: [{ done: state.challengesDoneSince || 0 }] };
      if (sql.includes('COUNT(*)::int AS total')) return { rows: [state.totals || { total: 0, done: 0 }] };
      // The season's First challenges, read so a First challenge done counts
      // the way Home counts it (profile.js viewerDoneRule, 2026-10-01). None
      // here: the totals are DONE_EXPR's alone.
      if (sql.startsWith('/* challenge onboarding */')) return { rows: state.onboardingRows || [] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

const WEEK = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
  .map((day) => ({ day, seconds: '0' }));

function makeApp(state, { user, env } = {}) {
  const pool = mockPool(state);
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  const originalEnv = process.env.USERNODE_ENV;
  poolModule.getPool = () => pool;
  if (env) process.env.USERNODE_ENV = env;
  let routes;
  try {
    delete require.cache[require.resolve('../src/routes/profile')];
    routes = require('../src/routes/profile').profileRoutes();
  } finally {
    poolModule.getPool = originalGetPool;
    if (env) {
      if (originalEnv === undefined) delete process.env.USERNODE_ENV;
      else process.env.USERNODE_ENV = originalEnv;
    }
    delete require.cache[require.resolve('../src/routes/profile')];
  }
  const app = express();
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use(routes);
  return { app, pool };
}

async function get(app, url) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const USER = { id: 7, username: 'viewer' };

test('signed out is a 401, like every /api/me/* read', async () => {
  const { app } = makeApp({});
  assert.equal((await get(app, '/api/me/summary')).status, 401);
});

test('one round: the counts, the list and the season go out together, scoped to the session user', async () => {
  const { app, pool } = makeApp({
    counts: { merged: 2, apps: 1, direct_kudos: 3, bounty_kudos: 0, member_since: '2026-01-01T00:00:00Z' },
    contributions: [{ session_id: 9, pr_number: 1, pr_title: 'A', merged_at: '2026-09-01T00:00:00Z', app_slug: 'a', app_name: 'A', self_hosted: false, kudos: 1 }],
    season: { id: 1, name: 'Season 1' },
    totals: { total: 9, done: 4 },
  }, { user: USER });
  const { status, body } = await get(app, '/api/me/summary');
  assert.equal(status, 200);
  assert.equal(body.merged, 2);
  assert.equal(body.kudos, 3);
  assert.deepEqual(body.challenges, { done: 4, total: 9, season: { id: 1, name: 'Season 1' } });
  assert.equal(body.contributions[0].sessionId, 9);
  assert.ok(!('demo' in body), 'not a demo payload');
  const scoped = pool.calls.filter((c) => /AS direct_kudos|ORDER BY cs\.merged_at/.test(c.sql));
  assert.equal(scoped.length, 2);
  for (const c of scoped) assert.equal(c.params[0], 7, 'the SESSION user, never a query param');
});

test('?demo=1 is inert outside staging', async () => {
  const { app } = makeApp({ counts: {}, selfApp: SELF_APP }, { user: USER, env: 'production' });
  const { body } = await get(app, '/api/me/summary?demo=1');
  assert.equal(body.contributions.length, 0);
  assert.ok(!body.demo);
});

test('?demo=1 in staging fills an empty Me from the merged mocks', async () => {
  const { app } = makeApp({ counts: {}, selfApp: SELF_APP }, { user: USER, env: 'staging' });
  const { body } = await get(app, '/api/me/summary?demo=1');
  assert.equal(body.demo, true);
  assert.equal(body.contributions.length, profile.DEMO_CONTRIBUTIONS.length);
});

// ─── The "This week" card's numbers (#5626) ─────────────────────────────

test('the week is shaped oldest first, its total added up, and pg\'s bigint read as a number', () => {
  const rows = WEEK.map((row, i) => ({ day: row.day, seconds: String(i * 60) }));
  const activity = profile.shapeActivity(rows, { apps_opened: 2 });
  assert.equal(activity.days.length, 7);
  assert.deepEqual(activity.days[0], { date: '2026-10-30', seconds: 0 });
  assert.deepEqual(activity.days[6], { date: '2026-11-05', seconds: 360 });
  assert.equal(activity.totalSeconds, 1260);
  assert.equal(activity.appsOpened, 2);
});

test('the summary carries the session user\'s week, and nothing can name another person', async () => {
  const { app, pool } = makeApp({
    counts: {}, appsOpened: 3,
    activityDays: WEEK.map((row, i) => ({ ...row, seconds: i === 6 ? '90' : '0' })),
  }, { user: USER });
  const { body } = await get(app, '/api/me/summary?user_id=99&username=someone');
  assert.equal(body.activity.totalSeconds, 90);
  assert.equal(body.activity.appsOpened, 3);
  assert.ok(!body.activity.demo);
  const reads = pool.calls.filter((c) => /app_activity/.test(c.sql));
  assert.equal(reads.length, 2);
  for (const c of reads) assert.deepEqual(c.params, [7], 'the SESSION user alone');
});

test('both reads lead with the user and count UTC days', () => {
  for (const sql of [profile.SUMMARY_ACTIVITY_DAYS_SQL, profile.SUMMARY_ACTIVITY_APPS_SQL]) {
    assert.match(sql, /user_id = \$1/);
    assert.match(sql, /CURRENT_TIMESTAMP AT TIME ZONE 'UTC'/);
  }
  assert.match(collapse(profile.SUMMARY_ACTIVITY_APPS_SQL), /e\.event_type = 'dapp_opened'/);
  const manifest = JSON.parse(read('src/db/migrations/manifest.json'));
  assert.ok(manifest.migrations.some((m) => m.id === 'app-activity-user-date-index'), 'a tracked migration');
  assert.match(collapse(read('src/db/migrations/app-activity-user-date-index.sql')),
    /CREATE INDEX IF NOT EXISTS idx_app_activity_user_date ON app_activity\(user_id, date\)/);
});

test('?demo=1 fills an empty week on the read\'s own dates, and never covers real time or apps', () => {
  const empty = profile.shapeActivity(WEEK, { apps_opened: 0 });
  const demo = profile.withDemoActivity(empty);
  assert.equal(demo.demo, true);
  assert.deepEqual(demo.days.map((d) => d.date), WEEK.map((row) => row.day));
  assert.deepEqual(demo.days.map((d) => d.seconds / 60), profile.DEMO_ACTIVITY_MINUTES);
  assert.equal(demo.totalSeconds, 220 * 60);
  assert.equal(demo.appsOpened, 6);
  const timed = { ...empty, totalSeconds: 5 };
  assert.equal(profile.withDemoActivity(timed), timed, 'REAL DATA WINS');
  const opened = { ...empty, appsOpened: 1 };
  assert.equal(profile.withDemoActivity(opened), opened, 'REAL DATA WINS');
});

test('the week\'s overlay is staging\'s alone, and independent of the merged mocks', async () => {
  const production = makeApp({ counts: {}, selfApp: SELF_APP }, { user: USER, env: 'production' });
  assert.equal((await get(production.app, '/api/me/summary?demo=1')).body.activity.totalSeconds, 0);
  // Real merged work makes withDemoSummary stand aside; the week still fills.
  const staging = makeApp({
    counts: { merged: 2 }, selfApp: SELF_APP,
    contributions: [{ session_id: 9, pr_title: 'A', merged_at: '2026-09-01T00:00:00Z', app_slug: 'a', app_name: 'A', kudos: 0 }],
  }, { user: USER, env: 'staging' });
  const { body } = await get(staging.app, '/api/me/summary?demo=1');
  assert.ok(!body.demo, 'the real merged work stands');
  assert.equal(body.activity.demo, true);
});

// ─── The week's accomplishments (#6464) ─────────────────────────────────

test('the week is its live changes, the apps they were in, and challenges done', () => {
  const week = profile.shapeWeek(
    { merged: '2' },
    [{ slug: 'notes', name: 'Notes' }, { slug: 'homeroom', name: null }],
    1,
  );
  assert.deepEqual(week, {
    merged: 2,
    apps: [{ slug: 'notes', name: 'Notes' }, { slug: 'homeroom', name: 'homeroom' }],
    challengesDone: 1,
  });
  assert.deepEqual(profile.shapeWeek(undefined, undefined, undefined),
    { merged: 0, apps: [], challengesDone: 0 }, 'an account with nothing yet is zeros');
  assert.equal(profile.shapeWeek({ merged: 1 }, new Array(12).fill({ slug: 'a', name: 'A' }), 0).apps.length, 10,
    'the app list is capped like the contributions list');
});

test('the summary carries the week when the route read it, and no week when it did not', () => {
  const without = profile.shapeSummary({ counts: {}, contributions: [], challenges: null });
  assert.ok(!('week' in without), 'an older cached summary has no week');
  const summary = profile.shapeSummary({
    counts: {}, contributions: [], challenges: null,
    week: { merged: 1, apps: [{ slug: 'a', name: 'A' }], challengesDone: 2 },
  });
  assert.deepEqual(summary.week, { merged: 1, apps: [{ slug: 'a', name: 'A' }], challengesDone: 2 });
});

test('the week reads the viewer\'s own authored changes that went live in the seven UTC days', () => {
  const merged = collapse(profile.SUMMARY_WEEK_MERGED_SQL);
  assert.match(merged, /cs\.user_id = \$1 AND cs\.is_headless = FALSE/);
  assert.match(merged, /cs\.status = 'merged' AND cs\.live_at IS NOT NULL/);
  assert.match(merged, /cs\.merged_at >= \(since\.day::timestamp AT TIME ZONE 'UTC'\)/);
  assert.match(merged, /\(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)::date - 6 AS day/);
  const apps = collapse(profile.SUMMARY_WEEK_APPS_SQL);
  assert.match(apps, /SELECT a\.slug, a\.name/);
  assert.match(apps, /JOIN apps a ON a\.id = cs\.app_id/);
  assert.match(apps, /GROUP BY a\.slug, a\.name/);
  assert.match(apps, /ORDER BY MAX\(cs\.merged_at\) DESC/);
  assert.match(apps, /LIMIT 10/);
  assert.match(apps, /cs\.user_id = \$1 AND cs\.is_headless = FALSE/);
});

test('the route reads the week and gives both challenge reads one done rule', async () => {
  const { app, pool } = makeApp({
    counts: {}, season: { id: 3, name: 'Season 3' },
    weekMerged: 2, weekApps: [{ slug: 'notes', name: 'Notes' }], challengesDoneSince: 1,
    totals: { total: 7, done: 3 }, onboardingRows: [],
  }, { user: USER });
  const { status, body } = await get(app, '/api/me/summary');
  assert.equal(status, 200);
  assert.deepEqual(body.week, { merged: 2, apps: [{ slug: 'notes', name: 'Notes' }], challengesDone: 1 });
  assert.equal(body.challenges.done, 3);
  const rules = pool.calls.filter((c) => /AS done|AS total/.test(c.sql));
  assert.ok(rules.length >= 2);
  for (const call of rules) {
    assert.equal(call.params[0], 7, 'the SESSION user alone');
    assert.equal(call.params[1], 3, 'the profile season');
  }
});

test('?demo=1 fills an empty week with the demo row merged today, and never covers real data', () => {
  const empty = profile.shapeSummary({
    counts: {}, contributions: [], challenges: { done: 0, total: 3, season: { id: 1, name: 'S1' } },
    week: { merged: 0, apps: [], challengesDone: 2 },
  });
  const demo = profile.withDemoSummary(empty, SELF_APP);
  assert.deepEqual(demo.week, {
    merged: 1,
    apps: [{ slug: 'usernode-2d5619', name: 'Homeroom' }],
    challengesDone: 2,
  }, 'the challenges stay real');
  const real = { ...empty, merged: 1, contributions: [{ sessionId: 5 }] };
  assert.equal(profile.withDemoSummary(real, SELF_APP).week, empty.week, 'REAL DATA WINS');
});

