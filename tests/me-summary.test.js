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
  assert.match(counts, /COUNT\(\*\) FILTER \(WHERE cs\.status = 'merged'\)::int AS merged/);
  assert.match(counts, /WHERE cs\.user_id = \$1 AND cs\.is_headless = FALSE/,
    'auto sessions are not proposals anybody authored');
  assert.match(counts, /FROM pr_kudos pk JOIN chat_sessions ks ON ks\.id = pk\.session_id WHERE ks\.user_id = \$1/);
  assert.match(counts, /ib\.awarded_user_id = \$1 AND ib\.status = 'awarded'/);
  const list = collapse(route.slice(route.indexOf('const SUMMARY_CONTRIBUTIONS_SQL'), route.indexOf('const SELF_APP_SQL')));
  assert.match(list, /cs\.status = 'merged'/);
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
  const mocks = votes.slice(votes.indexOf('function stagingMockMerged()'));
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
      if (sql.includes("cs.status = 'merged' ORDER BY cs.merged_at")) return { rows: state.contributions || [] };
      if (sql.includes('FROM apps WHERE self_hosted = TRUE')) return { rows: state.selfApp ? [state.selfApp] : [] };
      if (sql.includes('FROM seasons')) return { rows: state.season ? [state.season] : [] };
      if (sql.includes('COUNT(*)::int AS total')) return { rows: [state.totals || { total: 0, done: 0 }] };
      // The season's First challenges, read so a First challenge done counts
      // the way Home counts it (profile.js viewerDoneRule, 2026-10-01). None
      // here: the totals are DONE_EXPR's alone.
      if (sql.startsWith('/* challenge onboarding */')) return { rows: state.onboardingRows || [] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

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
