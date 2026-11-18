'use strict';

// #6793: the list form of a proposal's check results, made by Postgres
// (src/services/list-test-results.js listedResultsSql), is the list form the
// JavaScript filter made: what did not pass, without its excerpts, in the
// stored order; a count of what passed; the noted passes; and the unit
// suite's own row for the server.
//
// Run with: node --test tests/list-test-results-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const lists = require('../src/services/list-test-results');
const { passedIn } = require('../src/services/unit-suite');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const UNIT = { index: -3, name: 'Repo unit suite (npm test) passes', path: 'package.json' };
const FIXTURES = {
  allPass: Array.from({ length: 5 }, (_, i) => ({ name: `c${i}`, status: 'pass' })),
  nonePass: [{ name: 'a', status: 'fail' }, { name: 'b', status: 'error' }],
  mixed: [{ name: 'a', status: 'pass' }, { name: 'b', status: 'fail', failureReason: 'x' }, null, 3, 'text', [1],
    { name: 'c', status: 'pass', passedOnRetry: true },
    { name: 'd', status: 'pass', cohortFallback: true, authored: true },
    { name: 'e', status: 'pass', cohortFallback: true, authored: false }, { name: 'f' }],
  unitFail: [{ ...UNIT, status: 'fail', failureDetails: [{ test: 't', excerpt: 'boom' }], failureDetailsTruncated: true },
    { name: 'p', status: 'pass' }],
  unitPass: [{ ...UNIT, status: 'pass' }, { name: 'q', status: 'fail' }],
  manyNoted: Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, status: 'pass', passedOnRetry: 'run' })),
  empty: [],
  notArray: { odd: true },
};

test('the list form made in SQL equals the one the JavaScript filter made', async (t) => {
  const pool = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000, max: 1 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT cs.id, ${lists.listedResultsSql('cs')}
         FROM jsonb_each($1::jsonb) AS cs(id, test_results) ORDER BY cs.id`,
      [JSON.stringify(FIXTURES)]);
    assert.equal(rows.length, Object.keys(FIXTURES).length);
    lists.unpackListed(rows);
    const plain = (value) => JSON.parse(JSON.stringify(value));
    for (const row of rows) {
      const unit = row.test_results_unit_row;
      delete row.test_results_unit_row;
      const want = lists.withoutFailureDetails(lists.failingResultsOnly({ id: row.id, test_results: FIXTURES[row.id] }));
      assert.deepEqual(plain(row), plain(want), row.id);
      if (row.id === 'unitPass') {
        assert.equal(passedIn(row.test_results), false);
        assert.equal(passedIn(lists.listedRowForServer({ ...row, test_results_unit_row: unit }).test_results), true,
          'a passing suite is handed back to the server alone');
      }
      if (row.id === 'unitFail') assert.equal(unit.failureDetails, undefined, 'and carries no excerpts either');
      if (row.id === 'manyNoted') assert.equal(row.test_results_noted.length, lists.MAX_NOTED_PASSES);
      if (row.id === 'mixed') assert.deepEqual(row.test_results_noted.map((r) => r.name), ['c', 'd']);
    }
  } finally {
    await pool.end();
  }
});

// The two list routes themselves, on the real schema: asked for the list
// form, each answers what the JavaScript filter made of its full answer, and
// the merge requirements read the same either way.
test('/promoted and /merged answer the same list form from the database', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `list_results_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4, connectionTimeoutMillis: 10000 });
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [ada] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('ada_list_results', 'x', TRUE) RETURNING id, username`);
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
     VALUES ('list-results', 'list-results', 'running', $1, 'private', 'private', 'https://github.com/example/list-results') RETURNING id`,
    [ada.id]);
  const app = (await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, ada.id]);
  await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`, [app.id, ada.id]);

  const results = [
    { ...UNIT, status: 'pass' },
    ...Array.from({ length: 40 }, (_, i) => ({ index: i, name: `check ${i}`, path: `/#r${i}`, status: 'pass' })),
    { index: 40, name: 'Feed renders', path: '/feed', status: 'fail', failureReason: 'timed out',
      failureDetails: [{ test: 'feed', excerpt: 'boom' }] },
    { index: 41, name: 'Retried', path: '/retry', status: 'pass', passedOnRetry: true },
  ];
  const shots = { headSha: 'a'.repeat(40), intent: { version: 1, impact: 'none', rationale: 'Nothing on screen changes.', stories: [] } };
  const session = async (status, pr) => {
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, created_at, promoted_at, merged_at, live_at, branch_name,
                                  pr_number, pr_title, pr_body, check_state, test_results, shots_detail)
       VALUES ($1, $2, $3::text, NOW(), NOW(), CASE WHEN $3::text = 'merged' THEN NOW() END,
               CASE WHEN $3::text = 'merged' THEN NOW() END,
               $4, $5, 'List results', 'The technical half.', 'failing', $6::jsonb, $7::jsonb)`,
      [app.id, ada.id, status, `test/${crypto.randomBytes(4).toString('hex')}`, pr, JSON.stringify(results), JSON.stringify(shots)]);
  };
  await session('promoted', 501);
  await session('merged', 502);

  const express = require('express');
  const { getPool } = require('../src/db/pool');
  const config = { databaseUrl: String(url) };
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.user = { id: ada.id, username: ada.username, isAdmin: false, hasPlatformAccess: true };
    next();
  });
  server.use(require('../src/routes/votes').voteRoutes(config));
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  cleanup.push(async () => {
    await new Promise((r) => listener.close(r));
    await getPool(config).end().catch(() => {});
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const read = async (list, query = '') => {
    const res = await fetch(`${base}/api/apps/${app.slug}/${list}${query}`, { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(res.status, 200, `${list}${query}`);
    return (await res.json())[list];
  };

  for (const list of ['promoted', 'merged']) {
    const [full] = await read(list);
    const [listed] = await read(list, '?results=failing');
    assert.equal(full.test_results.length, results.length, `${list}: without the flag, the whole stored list as before`);
    assert.deepEqual(full.shots_detail, shots, `${list}: and the whole shots record`);
    const want = lists.forListing({ query: { results: 'failing' } }, [full])[0];
    assert.deepEqual(listed.test_results, want.test_results, `${list}: the rows that did not pass, without excerpts`);
    assert.equal(listed.test_results.length, 1);
    assert.equal(listed.test_results[0].failureDetails, undefined);
    assert.equal(listed.test_results_omitted, want.test_results_omitted);
    assert.equal(listed.test_results_omitted, 42);
    assert.deepEqual(listed.test_results_noted, want.test_results_noted);
    assert.equal('test_results_unit_row' in listed, false, `${list}: the unit suite's row is the server's alone`);
    assert.equal('test_results_listed' in listed, false);
    assert.deepEqual(listed.shots_detail, { intent: { impact: 'none' } }, `${list}: the one shots fact a card reads`);
    assert.equal('integration_merged_tree' in listed, false);
    assert.equal('merge_requirements' in listed, false);
    assert.equal(listed.pr_body, 'The technical half.', `${list}: search and the description panel still read the body`);
    assert.deepEqual(listed.mergeRequirements, full.mergeRequirements, `${list}: the requirements read the same either way`);
    assert.deepEqual(listed.integration, full.integration);
  }
});
