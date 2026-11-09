'use strict';

// GET /api/me/weekly-digest (#6371): the This week page's data.
//
//   1. a caller with no session is refused (the read is me-scoped);
//   2. the answer is the shape the page draws: projects newest first, each
//      with its changes that went live and its open votes, and totals;
//   3. staging `?demo=1` answers a fixed, obviously fake week.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { weeklyDigestRoutes, demoWeek } = require('../src/routes/weekly-digest');

const NOW = new Date('2026-11-06T16:00:00.000Z');

function makePool() {
  const query = async (sql, params) => {
    const s = String(sql);
    if (/JOIN community_members/.test(s)) {
      return {
        rows: [
          { id: 3, slug: 'tiers', name: 'Tier Lists' },
          { id: 7, slug: 'garden', name: 'Garden' },
        ],
      };
    }
    if (/cs\.status = 'merged'/.test(s)) {
      return {
        rows: params[0] === 3
          ? [{ id: 41, pr_number: 41, pr_title: 'Custom tier colors', merged_at: '2026-11-05T10:00:00Z' }]
          : [{ id: 51, pr_number: 51, pr_title: 'Watering reminders', merged_at: '2026-11-06T10:00:00Z' }],
      };
    }
    if (/cs\.status = 'promoted'/.test(s)) {
      return { rows: params[0] === 3 ? [{ id: 44, pr_number: 44, pr_title: 'Dark mode', my_vote: false }] : [] };
    }
    return { rows: [] };
  };
  return { query, connect: async () => ({ query, release() {} }) };
}

async function withServer(fn) {
  const app = express();
  app.use((req, res, next) => {
    if (req.headers['x-anon'] !== '1') req.user = { id: 1, username: 'tester' };
    next();
  });
  app.use(weeklyDigestRoutes({}, { pool: makePool() }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the route refuses a caller with no session', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/me/weekly-digest`, { headers: { 'x-anon': '1' } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });
});

test('the answer is the week grouped by project, newest first', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/me/weekly-digest`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const week = await res.json();
    assert.deepEqual(week.projects.map((p) => p.slug), ['garden', 'tiers'], 'the newest merge leads');
    assert.equal(week.projects[1].merged[0].title, 'Custom tier colors');
    assert.equal(week.projects[1].open[0].myVote, false);
    assert.equal(week.mergedTotal, 2);
    assert.equal(week.projectCount, 2);
    assert.ok(week.since < week.until);
  });
});

test('staging demo=1 is a fixed, obviously fake week', () => {
  const week = demoWeek(NOW);
  assert.equal(week.projectCount, 3);
  assert.equal(week.projects.length, 3);
  for (const project of week.projects) {
    for (const item of [...project.merged, ...project.open]) {
      assert.match(item.title, /^Staging demo: /, 'every demo row says it is a demo');
      assert.ok(item.sessionId < 0, 'and carries an id no real change has');
    }
  }
  // A busy project lists a few and counts the rest, which is what draws its
  // "more in the Workshop" line.
  assert.ok(week.projects[0].mergedTotal > week.projects[0].merged.length);
});
