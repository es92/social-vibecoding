'use strict';

// #6796: three places a request waited on round trips it did not need.
//   - the moderation guard reads the app and the viewer's block on it in one
//     query, on every /api/apps/:slug/* call;
//   - GET /api/apps runs its seven side reads in two groups, four at most
//     at once;
//   - GET /api/public/apps answers from the copy it has while one read
//     refreshes it, for a bounded time.
//
// Run with: node --test tests/server-reads-together.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

async function serve(t, mount) {
  const app = express();
  mount(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the moderation guard asks once for the app and the viewer\'s block on it', async (t) => {
  const { moderationGuard } = require('../src/middleware/moderation');
  const queries = [];
  let row = { id: 9, moderation_suspended_at: null, blocked: false };
  const pool = { query: async (sql, params) => { queries.push({ sql: String(sql), params }); return { rows: row ? [row] : [] }; } };
  let user = { id: 7 };
  const base = await serve(t, (app) => {
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use(moderationGuard({}, { pool }));
    app.get('/api/apps/:slug/promoted', (_req, res) => res.json({ ok: true }));
  });
  const get = () => fetch(`${base}/api/apps/my%20app/promoted`);

  assert.equal((await get()).status, 200);
  assert.equal(queries.length, 1, 'one round trip, not two');
  assert.match(queries[0].sql, /FROM apps a WHERE a\.slug = \$1/);
  assert.match(queries[0].sql, /FROM user_app_blocks b WHERE b\.user_id = \$2::int AND b\.app_id = a\.id/);
  assert.deepEqual(queries[0].params, ['my app', 7]);

  row = { id: 9, moderation_suspended_at: null, blocked: true };
  const blocked = await get();
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, 'app_blocked');

  row = { id: 9, moderation_suspended_at: new Date().toISOString(), blocked: false };
  assert.equal((await (await get()).json()).code, 'app_suspended');

  row = null;
  assert.equal((await get()).status, 200, 'an unknown slug is the route\'s to refuse');

  user = undefined;
  row = { id: 9, moderation_suspended_at: null, blocked: false };
  queries.length = 0;
  assert.equal((await get()).status, 200);
  assert.deepEqual(queries[0].params, ['my app', null], 'nobody signed in: no block to find');
});

test('GET /api/apps waits for its side reads in two groups, never more than four at once', () => {
  const src = read('src/routes/apps.js');
  const handler = src.slice(src.indexOf("router.get('/api/apps', async (req, res) => {")).slice(0, 20000);
  assert.match(handler, /const \[adminAppIds, contributorCounts, contributed, liveDomains\] = await Promise\.all\(\[\s*adminAppIdsRead, contributorCountsRead, contributedRead, liveDomainsRead,\s*\]\);/);
  assert.match(handler, /const \[firstVersionLines, linksOut, storedSecrets\] = await Promise\.all\(\[\s*readFirstVersionLines\(\), readLinksOut\(\), readStoredSecrets\(\),\s*\]\);/,
    'the second group starts only when the first has landed');
  assert.match(handler, /Could not read the invite links for the list[\s\S]{0,80}return new Map\(\);/,
    'a failed invite-links read still says nothing, and sinks nothing');
});

test('the public directory answers from its copy while one read refreshes it, for a bounded time', async (t) => {
  const poolMod = require('../src/db/pool');
  const realGetPool = poolMod.getPool;
  const realNow = Date.now;
  let now = 1_000_000;
  let reads = 0;
  let gate = null;
  let fail = false;
  poolMod.getPool = () => ({
    query: async (sql) => {
      // The directory's own list query, counted once per read.
      if (/view_visibility/.test(String(sql)) && /FROM apps/.test(String(sql)) && !/WHERE slug = \$1/.test(String(sql))) {
        reads += 1;
        if (gate) await gate;
        if (fail) throw new Error('database away');
      }
      return { rows: [] };
    },
  });
  delete require.cache[require.resolve('../src/routes/public-api')];
  const { publicApiRoutes } = require('../src/routes/public-api');
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
    poolMod.getPool = realGetPool;
    delete require.cache[require.resolve('../src/routes/public-api')];
  });
  const base = await serve(t, (app) => app.use(publicApiRoutes({})));
  const get = async () => { const res = await fetch(`${base}/api/public/apps`); return { status: res.status, body: await res.json() }; };

  assert.equal((await get()).status, 200);
  const first = reads;
  assert.ok(first >= 1, 'the first visitor reads the directory');
  assert.equal((await get()).status, 200);
  assert.equal(reads, first, 'inside the half minute, the copy answers');

  // Just expired: answered at once from the copy, with one refresh behind it.
  now += 31_000;
  let open;
  gate = new Promise((resolve) => { open = resolve; });
  const stale = await get();
  assert.equal(stale.status, 200, 'no wait on the slow query');
  await get();
  assert.equal(reads, first * 2, 'two visitors, one refresh');
  open(); gate = null;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await get()).status, 200);
  assert.equal(reads, first * 2, 'the refreshed copy is the one kept');

  // A refresh that fails leaves the copy answering.
  now += 31_000;
  fail = true;
  assert.equal((await get()).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  fail = false;

  // Too old to serve: this visitor waits for a real read.
  now += 3 * 60_000;
  const before = reads;
  assert.equal((await get()).status, 200);
  assert.ok(reads > before, 'a copy past its bound is never served');

  const src = read('src/routes/public-api.js');
  assert.match(src, /const DIRECTORY_STALE_MS = 2 \* 60 \* 1000;/);
});
