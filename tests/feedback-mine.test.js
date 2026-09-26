// GET /api/feedback/mine (#3186): the caller's own feedback, for "Your
// feedback" on the Me screen.
//
// Pinned here: the read is scoped to the session's user and to nothing a
// caller can pass; a report is "received" until a challenge credit names it
// (`feedback:<id>`, the key the USEFUL_FEEDBACK scorer writes) and "counted"
// after; platform feedback links to the self-hosted app only when that app's
// repo is the one the report went to; the totals survive the list's cap; and
// the staging ?demo=1 overlay fills an empty list without ever hiding real
// rows. The last test runs the real SQL against PostgreSQL.
//
// Run with: node --test tests/feedback-mine.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

let user;
let queries;
let rowsFor;
let selfRows;
let databaseClient = null;

require('../src/db/pool').getPool = () => ({
  async query(sql, params = []) {
    if (databaseClient) return databaseClient.query(sql, params);
    queries.push({ sql, params });
    if (/FROM feedback_reports fr/.test(sql)) return { rows: rowsFor(params[0]) };
    if (/WHERE self_hosted = TRUE/.test(sql)) return { rows: selfRows };
    return { rows: [] };
  },
});

const feedback = require('../src/routes/feedback');

let server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(feedback.feedbackRoutes({ platformRepoUrl: 'https://github.com/platform/repo' }));
  server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
});
test.after(() => server.close());
test.beforeEach(() => {
  user = { id: 7, username: 'reporter' };
  queries = [];
  rowsFor = () => [];
  selfRows = [{ slug: 'homeroom', name: 'Homeroom', repo_url: 'https://github.com/Platform/Repo.git' }];
});

async function mine(query = '') {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/feedback/mine${query}`);
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
}

const ROW = {
  id: 12, target: 'app', title: 'Board jumps', issue_owner: 'owner', issue_repo: 'demo',
  issue_number: 41, created_at: new Date('2026-09-20T12:00:00Z'), app_slug: 'demo-app',
  app_name: 'Demo', credited_points: null, total_sent: 1, total_counted: 0,
};

test('a caller with no session is refused before any query runs', async () => {
  user = null;
  const { status } = await mine();
  assert.equal(status, 401);
  assert.equal(queries.length, 0);
});

test('the read is scoped to the session user, whatever the query string says', async () => {
  rowsFor = (id) => (id === 7 ? [ROW] : []);
  const { status, body, cache } = await mine('?user_id=8&userId=8');
  assert.equal(status, 200);
  assert.equal(cache, 'no-store');
  const read = queries.find((q) => /FROM feedback_reports fr/.test(q.sql));
  assert.deepEqual(read.params, [7, feedback.MY_FEEDBACK_LIMIT]);
  assert.match(read.sql, /WHERE fr\.user_id = \$1/);
  // The credit join is scoped to the same user, so another person's credit
  // can never mark this person's report as counted.
  assert.match(read.sql, /WHERE ua\.user_id = \$1/);
  assert.equal(body.sent, 1);
  assert.equal(body.reports[0].id, 12);
});

test('received until a credit names the report, then counted with its points', () => {
  const body = feedback.shapeMyFeedback([
    { ...ROW, id: 13, credited_points: '180.00', total_sent: 2, total_counted: 1 },
    { ...ROW, total_sent: 2, total_counted: 1 },
  ], null);
  assert.deepEqual(body.reports.map((r) => [r.id, r.status, r.points]), [[13, 'counted', 180], [12, 'received', null]]);
  assert.equal(body.sent, 2);
  assert.equal(body.counted, 1);
  assert.equal(body.truncated, undefined);
  assert.deepEqual(body.reports[1], {
    id: 12, title: 'Board jumps', target: 'app', appSlug: 'demo-app', appName: 'Demo',
    issueNumber: 41, createdAt: '2026-09-20T12:00:00.000Z', status: 'received', points: null,
  });
});

test('platform feedback links to the self-hosted app only when the repo is its own', () => {
  const platform = { ...ROW, target: 'platform', app_slug: null, app_name: null, issue_owner: 'platform', issue_repo: 'repo' };
  const self = { slug: 'homeroom', repo_url: 'https://github.com/Platform/Repo.git' };
  const [linked] = feedback.shapeMyFeedback([platform], self).reports;
  assert.equal(linked.appSlug, 'homeroom');
  assert.equal(linked.appName, 'Homeroom');
  const [elsewhere] = feedback.shapeMyFeedback([{ ...platform, issue_repo: 'other' }], self).reports;
  assert.equal(elsewhere.appSlug, null, 'a request in another repo is not on this board');
  assert.equal(feedback.shapeMyFeedback([platform], null).reports[0].appSlug, null);
  assert.equal(feedback.repoMatches('https://github.com/a/b', 'A', 'B.git'), true);
  assert.equal(feedback.repoMatches('', 'a', 'b'), false);
});

test('a report without a usable issue number carries no request link', () => {
  const [r] = feedback.shapeMyFeedback([{ ...ROW, issue_number: null }], null).reports;
  assert.equal(r.issueNumber, null);
});

test('the totals are over every report, so a capped list says so', () => {
  const body = feedback.shapeMyFeedback([{ ...ROW, total_sent: 120, total_counted: 9 }], null);
  assert.equal(body.sent, 120);
  assert.equal(body.counted, 9);
  assert.equal(body.truncated, true);
  assert.deepEqual(feedback.shapeMyFeedback([], null), { sent: 0, counted: 0, reports: [] });
});

test('the ?demo=1 overlay fills an empty list, and never replaces real rows', () => {
  const self = { slug: 'homeroom' };
  const now = Date.parse('2026-09-26T12:00:00Z');
  const demo = feedback.withDemoFeedback({ sent: 0, counted: 0, reports: [] }, self, now);
  assert.equal(demo.demo, true);
  assert.equal(demo.sent, feedback.DEMO_FEEDBACK.length);
  assert.equal(demo.counted, 1);
  assert.deepEqual(demo.reports.map((r) => r.status), ['received', 'counted', 'received', 'received']);
  assert.ok(demo.reports.every((r) => r.appSlug === 'homeroom' && r.issueNumber >= 900001));
  const real = feedback.shapeMyFeedback([ROW], null);
  assert.equal(feedback.withDemoFeedback(real, self, now), real, 'real data wins');
  const none = { sent: 0, counted: 0, reports: [] };
  assert.equal(feedback.withDemoFeedback(none, null, now), none, 'no platform app, no mock links');
});

test('the demo rows are the staging mock requests they link to', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/issues.js'), 'utf8');
  for (const d of feedback.DEMO_FEEDBACK) {
    assert.ok(src.includes(`mk(${d.issueNumber}, '${d.title}'`), `#${d.issueNumber} is "${d.title}" in stagingMockIssues`);
  }
});

test('the SQL returns only the caller\'s rows and their own credits (PostgreSQL)', async (t) => {
  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    connectionTimeoutMillis: 1500,
  });
  try { await client.connect(); } catch {
    await client.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not reachable');
    return t.skip('No local PostgreSQL; set TEST_DATABASE_URL to run the database test.');
  }
  const namespace = `feedback_mine_test_${process.pid}`;
  try {
    await client.query(`CREATE SCHEMA ${namespace}`);
    await client.query(`SET search_path TO ${namespace}`);
    await client.query('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    await client.query(`CREATE TABLE apps (id SERIAL PRIMARY KEY, slug TEXT, name TEXT,
      repo_url TEXT, self_hosted BOOLEAN NOT NULL DEFAULT FALSE)`);
    await client.query(`CREATE TABLE user_activities (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL,
      points NUMERIC(10,2) NOT NULL DEFAULT 0, metadata JSONB)`);
    // The real table, as schema.sql declares it.
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    await client.query(schema.match(/CREATE TABLE IF NOT EXISTS feedback_reports \([\s\S]*?\n\);/)[0]);
    await client.query('INSERT INTO users VALUES (7), (8)');
    await client.query(`INSERT INTO apps (id, slug, name, repo_url, self_hosted) VALUES
      (1, 'homeroom', 'Homeroom', 'https://github.com/platform/repo', TRUE),
      (3, 'demo-app', 'Demo', 'https://github.com/owner/demo', FALSE)`);
    const insert = (userId, target, appId, repo, n, title, at) => client.query(
      `INSERT INTO feedback_reports (user_id, target, app_id, issue_owner, issue_repo, issue_number, title, description, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'text', $8) RETURNING id`,
      [userId, target, appId, repo.split('/')[0], repo.split('/')[1], n, title, at]
    ).then((r) => Number(r.rows[0].id));
    const a = await insert(7, 'app', 3, 'owner/demo', 41, 'Board jumps', '2026-09-20T12:00:00Z');
    const b = await insert(7, 'platform', null, 'platform/repo', 3001, 'Me tab is slow', '2026-09-21T12:00:00Z');
    const other = await insert(8, 'app', 3, 'owner/demo', 42, 'Someone else', '2026-09-22T12:00:00Z');
    await client.query(`INSERT INTO user_activities (user_id, points, metadata) VALUES
      (7, 200, $1), (7, 30, $2), (8, 250, $3), (7, 99, $4)`, [
      JSON.stringify({ source_key: `feedback:${b}`, measure: 'USEFUL_FEEDBACK' }),
      JSON.stringify({ source_key: 'app:3' }),
      // Somebody else's credit, keyed to this person's report: not theirs.
      JSON.stringify({ source_key: `feedback:${a}`, measure: 'USEFUL_FEEDBACK' }),
      // This person's credit keyed to somebody else's report: joins nothing.
      JSON.stringify({ source_key: `feedback:${other}` }),
    ]);
    databaseClient = client;

    const { status, body } = await mine();
    assert.equal(status, 200);
    assert.deepEqual(body.reports.map((r) => [r.id, r.status, r.points, r.appSlug, r.issueNumber]), [
      [b, 'counted', 200, 'homeroom', 3001],
      [a, 'received', null, 'demo-app', 41],
    ]);
    assert.equal(body.sent, 2);
    assert.equal(body.counted, 1);

    user = { id: 8, username: 'another' };
    const theirs = (await mine()).body;
    assert.deepEqual(theirs.reports.map((r) => [r.id, r.status]), [[other, 'received']],
      'a credit for another person\'s report id never counts it');

    // Past the cap: the list stops at the limit and the totals do not.
    await client.query(`INSERT INTO feedback_reports (user_id, target, app_id, title, description, created_at)
      SELECT 8, 'app', 3, 'Bulk ' || g, 'text', NOW() FROM generate_series(1, $1) g`, [feedback.MY_FEEDBACK_LIMIT]);
    const capped = (await mine()).body;
    assert.equal(capped.reports.length, feedback.MY_FEEDBACK_LIMIT);
    assert.equal(capped.sent, feedback.MY_FEEDBACK_LIMIT + 1);
    assert.equal(capped.truncated, true);

    user = { id: 9, username: 'nobody' };
    assert.deepEqual((await mine()).body, { sent: 0, counted: 0, reports: [] });
  } finally {
    databaseClient = null;
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA ${namespace} CASCADE`);
    await client.end();
  }
});
