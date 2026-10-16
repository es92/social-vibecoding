// The admin connector's doors to the programme's challenges
// (src/routes/challenge-admin.js). Each one hands the request to the
// console's own /api/v4/admin handler after its gates, so these tests check
// the hand-off, not the console's behaviour (tests/topochain-admin-api2.test.js
// has that): a full admin reaches the console's handler with the path, query
// and body intact; anybody else, and a write from another origin, is refused
// before the console runs; and a path that is not one of the listed doors is
// never opened by the prefix alone.
//
// Run with: node --test tests/challenge-admin-routes.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// The console's route modules take `getPool` from src/db/pool when they are
// required, so the indirection goes in first (tests/topochain-admin-api.test.js
// explains the pitfall).
const poolMod = require('../src/db/pool');
let queries = [];
poolMod.getPool = () => ({
  async query(sql, params) { return answer(sql, params); },
  async connect() { return { async query(sql, params) { return answer(sql, params); }, release() {} }; },
});

const { challengeAdminRoutes } = require('../src/routes/challenge-admin');

const TEMPLATE = {
  id: 12, category: 'onboarding', goal: 'Join a project', task: 'Join one', reward: '10 points',
  description: null, requirements: null, schedule_start: null, schedule_end: null, reward_logic: null,
  cta_button: null, cta_label: null, cta_link: null, created_at: null, updated_at: null, kind: null,
  cta_type: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null,
  metric_type: null, metric_target: null, metric_label: null, illustration: null, illustration_tone: null,
};

function joinedChallenge(overrides = {}) {
  const t = Object.fromEntries(Object.entries(TEMPLATE).map(([k, v]) => [`t_${k}`, v]));
  return {
    ...t,
    id: 41, season_event_id: 7, challenge_template_id: 12,
    goal: 'Join two projects', task: null, reward: null, description: null, requirements: null,
    schedule_start: null, schedule_end: null, reward_logic: null, cta_button: null, cta_label: null, cta_link: null,
    created_at: null, updated_at: null, enabled: true, display_order: 3, completed: false, kind: null,
    cta_type: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null,
    metric_type: null, metric_target: null, metric_label: null, featured: true, featured_order: 1,
    ...overrides,
  };
}

let goal = 'Join two projects';
function answer(sql, params) {
  const q = sql.replace(/\s+/g, ' ').trim();
  queries.push({ sql: q, params });
  if (q.startsWith('SELECT DISTINCT category FROM challenge_templates')) {
    return { rows: [{ category: 'onboarding' }, { category: 'weekly' }] };
  }
  if (q.startsWith('SELECT COUNT(*)::int AS c FROM challenge_templates')) return { rows: [{ c: 21 }] };
  if (q.startsWith('SELECT *, (SELECT ci.tone FROM challenge_illustrations ci')) return { rows: [TEMPLATE] };
  if (q.startsWith('SELECT id, season_id FROM season_events WHERE id = $1')) {
    return { rows: params[0] === 7 ? [{ id: 7, season_id: 2 }] : [] };
  }
  if (q.startsWith('SELECT c.*,') && q.endsWith('WHERE c.season_event_id = $1 ORDER BY c.display_order ASC, c.id ASC')) {
    return { rows: [joinedChallenge({ goal })] };
  }
  if (q.startsWith('SELECT c.*,') && q.endsWith('WHERE c.id = $1')) return { rows: [joinedChallenge({ goal })] };
  if (q.startsWith('UPDATE challenges SET goal = $2')) { [, goal] = params; return { rows: [] }; }
  throw new Error(`unexpected query: ${q}`);
}

function app(user) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { if (user) req.user = user; next(); });
  a.use(challengeAdminRoutes({}));
  // Whatever the doors do not answer lands here, with the address it came in on.
  a.use((req, res) => res.status(404).json({ fellThrough: req.url }));
  return a;
}

const ADMIN = { id: 1, username: 'evan', isAdmin: true, canAdminWrite: true };
const VIEWER = { id: 2, username: 'viewer', isAdmin: true, canAdminWrite: false };
const PLAIN = { id: 3, username: 'ann', isAdmin: false, canAdminWrite: false };

async function serve(t, user) {
  const server = app(user).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, path, { body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
}

test.beforeEach(() => { queries = []; goal = 'Join two projects'; });

test('a full admin reaches the console\'s own handler, with the path and the query string as sent', async (t) => {
  const call = await serve(t, ADMIN);
  const categories = await call('GET', '/api/challenge-admin/challenge-templates/categories');
  assert.equal(categories.status, 200);
  assert.deepEqual(categories.body, { success: true, data: ['onboarding', 'weekly'] });

  const list = await call('GET', '/api/challenge-admin/challenge-templates?search=join&category=onboarding&page=2&per_page=10');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.meta, { page: 2, per_page: 10, total: 21, total_pages: 3 });
  assert.equal(list.body.data[0].goal, 'Join a project');
  const page = queries.find((q) => q.sql.includes('LIMIT $3 OFFSET $4'));
  assert.deepEqual(page.params, ['%join%', 'onboarding', 10, 10], 'the console read the query string');

  // Express matches paths case-insensitively, and so does the hand-off.
  const shouted = await call('GET', '/API/Challenge-Admin/challenge-templates/categories');
  assert.equal(shouted.status, 200);
});

test('an event\'s challenges come back in the console\'s shape, with their order and featured slot', async (t) => {
  const call = await serve(t, ADMIN);
  const res = await call('GET', '/api/challenge-admin/season-events/7/challenges');
  assert.equal(res.status, 200);
  const [c] = res.body.data;
  assert.equal(c.id, 41);
  assert.equal(c.effective.goal, 'Join two projects');
  assert.equal(c.overrides.goal, 'Join two projects');
  assert.equal(c.activity_type.goal, 'Join a project');
  assert.equal(c.display_order, 3, 'the stored order, which the console form used to read as 0');
  assert.equal(c.featured, true);
  assert.equal(c.featured_order, 1);
  // The console's own 404 is the answer for an event that does not exist.
  const missing = await call('GET', '/api/challenge-admin/season-events/8/challenges');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { success: false, error: 'Event not found.' });
});

test('a write reaches the console\'s handler with its body, and the console\'s validation answers', async (t) => {
  const call = await serve(t, ADMIN);
  const saved = await call('PUT', '/api/challenge-admin/season-events/7/challenges/41', { body: { goal: 'Join three projects' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.goal, 'Join three projects');
  assert.equal(saved.body.data.activity_type.id, 12);
  assert.ok(queries.some((q) => q.sql.startsWith('UPDATE challenges SET goal = $2')));

  const refused = await call('POST', '/api/challenge-admin/challenge-templates', { body: { goal: 'No category' } });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, 'The given data was invalid.');
  assert.ok(refused.body.details.category, 'the console\'s validator named the missing field');
});

test('a view-only admin and a member are refused before the console runs, reads included', async (t) => {
  for (const user of [VIEWER, PLAIN, null]) {
    // eslint-disable-next-line no-await-in-loop
    const call = await serve(t, user);
    for (const [method, path, body] of [
      ['GET', '/api/challenge-admin/season-events'],
      ['GET', '/api/challenge-admin/challenge-scoring'],
      ['POST', '/api/challenge-admin/challenge-templates', { category: 'x', goal: 'g', task: 't', reward: 'r' }],
      ['PUT', '/api/challenge-admin/season-events/7/challenges/41', { goal: 'g' }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(method, path, { body });
      assert.equal(res.status, 403, `${method} ${path} as ${user ? user.username : 'nobody'}`);
      assert.deepEqual(res.body, { error: 'Full admin access required' });
    }
  }
  assert.equal(queries.length, 0, 'nothing was read or written');
});

test('a write from a page on another origin is refused before the console runs', async (t) => {
  const call = await serve(t, ADMIN);
  for (const site of ['cross-site', 'same-site']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call('PUT', '/api/challenge-admin/season-events/7/challenges/41', {
      body: { goal: 'g' }, headers: { 'sec-fetch-site': site },
    });
    assert.equal(res.status, 403, site);
  }
  assert.equal(queries.length, 0);
  const same = await call('PUT', '/api/challenge-admin/season-events/7/challenges/41', {
    body: { goal: 'g' }, headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(same.status, 200);
});

test('a path that is not one of the doors is never handed on, and keeps its own address', async (t) => {
  const call = await serve(t, ADMIN);
  for (const [method, path] of [
    // Deleting or replacing a whole event stays in the console.
    ['DELETE', '/api/challenge-admin/season-events/7'],
    ['PUT', '/api/challenge-admin/season-events/7'],
    // The console has these; the doors do not.
    ['PATCH', '/api/challenge-admin/season-events/7/challenges/41/toggle-enabled'],
    ['GET', '/api/challenge-admin/challenge-scoring/anatomy?measure=x'],
    ['PUT', '/api/challenge-admin/challenge-templates/12'],
    ['GET', '/api/challenge-admin/users'],
    ['POST', '/api/challenge-admin/sql-query/execute'],
    ['GET', '/api/challenge-admin/programme/export.csv'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call(method, path);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.fellThrough, path, `${method} ${path} kept its address`);
  }
  assert.equal(queries.length, 0);
});
