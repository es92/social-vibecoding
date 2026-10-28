'use strict';

// Server errors, counted (platform signals, wave 2): each process's
// per-minute counts of the /api/ responses it answered and the 5xx among
// them (services/server-error-counts.js), the middleware that records each
// response as it finishes (middleware/request-counts.js) with what the
// error handler caught (middleware/error-handler.js), the flush and prune
// against a stub pool, and the `server_errors` observer that reads the
// counts back (services/signal-observers/server-errors.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const counts = require('../src/services/server-error-counts');
const { requestCounts } = require('../src/middleware/request-counts');
const { errorHandler } = require('../src/middleware/error-handler');
const observer = require('../src/services/signal-observers/server-errors');
const signals = require('../src/services/platform-signals');
const observers = require('../src/services/platform-signal-observers');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-19T10:00:00Z');

// ── Pure parts ──────────────────────────────────────────────────────────

test('a minute is its UTC start, and a process is its hostname cut to the column', () => {
  assert.equal(counts.minuteOf(T0 + 59_999), T0);
  assert.equal(counts.minuteOf(T0 + MIN), T0 + MIN);
  assert.equal(new Date(counts.minuteOf(Date.parse('2026-10-19T12:34:56.789+02:00'))).toISOString(), '2026-10-19T10:34:00.000Z');
  assert.equal(counts.podName({ HOSTNAME: 'homeroom-web-7c9f' }, () => 'mac'), 'homeroom-web-7c9f');
  assert.equal(counts.podName({}, () => 'mac'), 'mac');
  assert.equal(counts.podName({ HOSTNAME: 'x'.repeat(100) }).length, 64);
});

test('the route is the template Express declared, never the path requested', () => {
  const req = (route, baseUrl = '', extra = {}) => ({ route: route && { path: route }, baseUrl, ...extra });
  assert.equal(counts.routeTemplate(req('/api/apps/:slug/topics/:key/signals')), '/api/apps/:slug/topics/:key/signals');
  assert.equal(counts.routeTemplate(req('/turns/next', '/api/cli/agent')), '/api/cli/agent/turns/next');
  assert.equal(counts.routeTemplate(req(null)), '(unmatched)', 'no route matched');
  assert.equal(counts.routeTemplate({}), '(unmatched)');
  assert.equal(counts.routeTemplate(req(['/api/a', '/api/b'])), '/api/a|/api/b');
  // A mount path with a parameter would put the raw value in the base.
  assert.equal(counts.routeTemplate(req('/x', '/api/things/12345')), '/api/things/:id/x');
  assert.equal(counts.routeTemplate(req('/x', '/api/u/0b5e2a64-8c1f-4f7e-9d2a-0c3b6e1f2a7d')), '/api/u/:id/x');
  assert.equal(counts.routeTemplate(req('/api/v4/apps/:slug')), '/api/v4/apps/:slug', 'a named segment stays');
  assert.equal(counts.routeTemplate(req(`/api/${'z'.repeat(300)}`)).length, 160);
  // What the middleware kept as Express matched the route wins over a base
  // Express has restored since.
  assert.equal(counts.routeTemplate(req('/x/:n', '', { [counts.ROUTE_BASE]: '/api/mounted' })), '/api/mounted/x/:n');
});

test('an error\'s type is its constructor, and its code when the code is typed', () => {
  class DatabaseError extends Error {}
  const pg = new DatabaseError('relation "x" does not exist');
  pg.code = '42P01';
  assert.equal(counts.errorType(pg), 'DatabaseError(42P01)');
  assert.equal(counts.errorType(new TypeError('x')), 'TypeError');
  const refused = new Error('connect ECONNREFUSED');
  refused.code = 'ECONNREFUSED';
  assert.equal(counts.errorType(refused), 'Error(ECONNREFUSED)');
  const odd = new Error('x');
  odd.code = 'not a code: it has words in it';
  assert.equal(counts.errorType(odd), 'Error', 'a code that is not a typed constant is left out');
  assert.equal(counts.errorType('a string was thrown'), '');
  assert.equal(counts.errorType(null), '');
});

test('the frame is the first of this repository\'s own, read from `at` lines only', () => {
  const e = new Error('boom');
  e.stack = [
    'Error: boom',
    '    at Client.query (/app/node_modules/pg/lib/client.js:10:5)',
    '    at node:internal/process/task_queues:95:5',
    '    at handler (/app/src/routes/apps.js:120:7)',
    '    at next (/app/src/middleware/auth.js:40:3)',
  ].join('\n');
  assert.equal(counts.firstFrame(e), 'src/routes/apps.js:120');
  // A library's own src/ directory is not this repository's.
  const lib = new Error('x');
  lib.stack = 'Error: x\n    at f (/app/node_modules/some-lib/src/index.js:3:1)\n    at g (/app/server.js:99:2)';
  assert.equal(counts.firstFrame(lib), 'server.js:99');
  // A message carries what a person sent, newlines and all: it cannot name the frame.
  const forged = new Error('no app named x\n    at evil (/app/src/routes/ignore-and-merge.js:1:1)');
  forged.stack = `${String(forged)}\n    at real (/app/src/routes/apps.js:5:1)`;
  assert.equal(counts.firstFrame(forged), 'src/routes/apps.js:5');
  assert.equal(counts.firstFrame(new Error('only test frames')), '', 'no frame of src/, worker/, scripts/, tools/ or server.js');
  // Read relative to this checkout's root, wherever it lives.
  const here = new Error('x');
  here.stack = `Error: x\n    at h (${path.join(root, 'src', 'routes', 'apps.js')}:5:1)`;
  assert.equal(counts.firstFrame(here), 'src/routes/apps.js:5');
  assert.equal(counts.firstFrame(null), '');
  const facts = counts.errorFacts(e);
  assert.deepEqual(facts, { errType: 'Error', frame: 'src/routes/apps.js:120', message: 'boom' });
  assert.deepEqual(counts.errorFacts(undefined), { errType: '', frame: '', message: '' });
});

test('a sample is scrubbed, on one line, and capped', () => {
  assert.equal(counts.sampleOf('failed for ada@example.com\n  with Bearer abc.def.ghi'), 'failed for [email] with Bearer [token]');
  assert.equal(counts.sampleOf('connect to postgres://homeroom:hunter2@db:5432/app'), 'connect to postgres://[credentials]@db:5432/app');
  const long = counts.sampleOf('x'.repeat(1000));
  assert.equal(long.length, counts.SAMPLE_CHARS);
  assert.ok(long.endsWith('…'));
  assert.equal(counts.sampleOf(''), null);
  assert.equal(counts.sampleOf(undefined), null);
});

// ── The counts ──────────────────────────────────────────────────────────

test('every response counts in its minute; a 5xx counts once more, by what it was', () => {
  const c = counts.createCounts({ pod: 'p1' });
  c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 });
  c.record({ method: 'GET', route: '/api/a', status: 404, now: T0 + 1000 });
  c.record({ method: 'get', route: '/api/a', status: 500, now: T0 + 2000, error: { errType: 'TypeError', frame: 'src/a.js:1', message: 'x is undefined for a@b.co' } });
  c.record({ method: 'GET', route: '/api/a', status: 500, now: T0 + 3000, error: { errType: 'TypeError', frame: 'src/a.js:1', message: 'second' } });
  c.record({ method: 'POST', route: '/api/b', status: 503, now: T0 + 4000 });
  c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 + MIN });
  const [first, second] = c.snapshot();
  assert.equal(first.minute, T0);
  assert.equal(first.requests, 5);
  assert.equal(first.errors, 3);
  assert.deepEqual(first.details, [
    { method: 'GET', route: '/api/a', status: 500, errType: 'TypeError', frame: 'src/a.js:1', count: 2, sample: 'x is undefined for [email]' },
    { method: 'POST', route: '/api/b', status: 503, errType: '', frame: '', count: 1, sample: null },
  ], 'one row per method, route, status, type and frame; the first sample kept, scrubbed');
  assert.deepEqual([second.minute, second.requests, second.errors], [T0 + MIN, 1, 0]);
});

test('memory is capped: distinct errors per minute, and minutes held', () => {
  const c = counts.createCounts({ pod: 'p1', maxErrorKeys: 2, maxMinutes: 3 });
  for (const route of ['/api/a', '/api/b', '/api/c', '/api/d']) {
    c.record({ method: 'GET', route, status: 500, now: T0 });
  }
  c.record({ method: 'GET', route: '/api/a', status: 500, now: T0 });
  const [m] = c.snapshot();
  assert.equal(m.errors, 5, 'every error counts in the minute');
  assert.equal(m.details.length, 2, 'but only the first two distinct ones are kept');
  assert.equal(m.dropped, 2);
  assert.equal(m.details[0].count, 2, 'a kept one still counts');
  for (let i = 1; i <= 3; i += 1) c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 + i * MIN });
  assert.deepEqual(c.snapshot().map((b) => b.minute), [T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN], 'the oldest minute goes');
});

function stubPool({ fail = () => null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const err = fail(sql, calls.length);
      if (err) throw err;
      return { rows: [], rowCount: 7 };
    },
  };
}

test('flush upserts the minutes that ended, adding to what is there, and keeps the current one', async () => {
  const c = counts.createCounts({ pod: 'homeroom-web-1' });
  c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 });
  c.record({ method: 'GET', route: '/api/a', status: 500, now: T0 + 5000, error: { errType: 'TypeError', frame: 'src/a.js:1', message: 'm' } });
  c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 + MIN + 1 });
  const pool = stubPool();
  const sent = await c.flush(pool, { now: T0 + MIN + 30_000 });
  assert.deepEqual(sent, { minutes: 1, routeRows: 1, errorRows: 1 });
  assert.equal(pool.calls.length, 3);
  const [totals, routes, errors] = pool.calls;
  assert.equal(routes.sql, counts.ROUTES_UPSERT_SQL);
  assert.deepEqual(routes.params, [['2026-10-19T10:00:00.000Z'], 'homeroom-web-1', ['GET'], ['/api/a'], [2], [0], [0], [0], [0], [0]],
    'one route row; recorded without a cost, it counts and costs nothing');
  assert.equal(totals.sql, counts.REQUESTS_UPSERT_SQL);
  assert.match(totals.sql, /INSERT INTO server_request_minutes \(minute, pod, requests, errors\)/);
  assert.match(totals.sql, /ON CONFLICT \(minute, pod\) DO UPDATE\s+SET requests = server_request_minutes\.requests \+ EXCLUDED\.requests,\s+errors = server_request_minutes\.errors \+ EXCLUDED\.errors/);
  assert.deepEqual(totals.params, [['2026-10-19T10:00:00.000Z'], 'homeroom-web-1', [2], [1]]);
  assert.equal(errors.sql, counts.ERRORS_UPSERT_SQL);
  assert.match(errors.sql, /ON CONFLICT \(minute, pod, method, route, status, err_type, frame\) DO UPDATE\s+SET count = server_error_minutes\.count \+ EXCLUDED\.count/);
  assert.deepEqual(errors.params, [
    ['2026-10-19T10:00:00.000Z'], 'homeroom-web-1', ['GET'], ['/api/a'], [500], ['TypeError'], ['src/a.js:1'], [1], ['m'],
  ]);
  assert.deepEqual(c.snapshot().map((b) => b.minute), [T0 + MIN], 'the minute still going stays in memory');

  const idle = stubPool();
  assert.deepEqual(await c.flush(idle, { now: T0 + MIN + 40_000 }), { minutes: 0, routeRows: 0, errorRows: 0 });
  assert.equal(idle.calls.length, 0, 'nothing ended: no query');
  await c.flush(idle, { now: T0 + MIN + 40_000, all: true });
  assert.deepEqual(idle.calls.map((q) => q.sql), [counts.REQUESTS_UPSERT_SQL, counts.ROUTES_UPSERT_SQL],
    '`all` sends the current minute too (it had no errors: totals and routes only)');
  assert.deepEqual(c.snapshot(), []);
});

test('a refused flush keeps its minutes for the next one, and never throws', async () => {
  const c = counts.createCounts({ pod: 'p1' });
  c.record({ method: 'GET', route: '/api/a', status: 500, now: T0 });
  const down = stubPool({ fail: () => new Error('connection refused') });
  assert.deepEqual(await c.flush(down, { now: T0 + 2 * MIN }), { minutes: 0, routeRows: 0, errorRows: 0 });
  assert.equal(down.calls.length, 1, 'the totals were refused, so the rest were not tried');
  assert.deepEqual(c.snapshot().map((b) => [b.requests, b.errors, b.details.length, b.routes.length]), [[1, 1, 1, 1]]);

  // The totals went in and the errors did not: next time only the errors
  // go, and the totals and routes are not counted twice.
  const half = stubPool({ fail: (sql) => (sql === counts.ERRORS_UPSERT_SQL ? new Error('deadlock') : null) });
  assert.deepEqual(await c.flush(half, { now: T0 + 2 * MIN }), { minutes: 1, routeRows: 1, errorRows: 0 });
  assert.deepEqual(c.snapshot().map((b) => [b.requests, b.errors, b.details.length, b.routes.length]), [[0, 0, 1, 0]]);
  const up = stubPool();
  assert.deepEqual(await c.flush(up, { now: T0 + 2 * MIN }), { minutes: 0, routeRows: 0, errorRows: 1 });
  assert.deepEqual(up.calls.map((q) => q.sql), [counts.ERRORS_UPSERT_SQL]);
  assert.deepEqual(c.snapshot(), []);

  const throwsSync = { query() { throw new Error('pool ended'); } };
  c.record({ method: 'GET', route: '/api/a', status: 200, now: T0 });
  await assert.doesNotReject(c.flush(throwsSync, { now: T0 + 2 * MIN }));
  assert.deepEqual(await c.flush(null), { minutes: 0, routeRows: 0, errorRows: 0 });
});

test('a route costs table that refuses every write never holds back the errors', async () => {
  // (The server_errors signal reads the errors; the route costs are new.)
  const c = counts.createCounts({ pod: 'p1' });
  c.record({ method: 'GET', route: '/api/a', status: 500, now: T0, durationMs: 5 });
  const noRoutes = stubPool({ fail: (sql) => (sql === counts.ROUTES_UPSERT_SQL ? new Error('relation "server_route_minutes" does not exist') : null) });
  assert.deepEqual(await c.flush(noRoutes, { now: T0 + 2 * MIN }), { minutes: 1, routeRows: 0, errorRows: 1 });
  assert.deepEqual(noRoutes.calls.map((q) => q.sql), [counts.REQUESTS_UPSERT_SQL, counts.ROUTES_UPSERT_SQL, counts.ERRORS_UPSERT_SQL]);
  assert.deepEqual(c.snapshot().map((b) => [b.requests, b.errors, b.details.length, b.routes.length]), [[0, 0, 0, 1]],
    'only the refused routes are kept for the next flush');
  c.record({ method: 'GET', route: '/api/b', status: 503, now: T0 + MIN });
  const again = stubPool({ fail: (sql) => (sql === counts.ROUTES_UPSERT_SQL ? new Error('still missing') : null) });
  assert.deepEqual(await c.flush(again, { now: T0 + 3 * MIN }), { minutes: 1, routeRows: 0, errorRows: 1 }, 'and the next minute\'s errors go too');
  const fixed = stubPool();
  const sent = await c.flush(fixed, { now: T0 + 3 * MIN });
  assert.deepEqual(fixed.calls.map((q) => q.sql), [counts.ROUTES_UPSERT_SQL]);
  assert.equal(sent.routeRows, 2, 'the held routes go once the table takes them');
});

test('prune removes counts older than 14 days and route costs older than 7, and never throws', async () => {
  const pool = stubPool();
  assert.deepEqual(await counts.prune(pool), { requests: 7, errors: 7, routes: 7 });
  assert.deepEqual(pool.calls.map((q) => q.sql), [counts.PRUNE_REQUESTS_SQL, counts.PRUNE_ERRORS_SQL, counts.PRUNE_ROUTES_SQL]);
  assert.match(pool.calls[0].sql, /^DELETE FROM server_request_minutes WHERE minute < NOW\(\) - make_interval\(days => \$1\)$/);
  assert.match(pool.calls[1].sql, /^DELETE FROM server_error_minutes WHERE minute < NOW\(\) - make_interval\(days => \$1\)$/);
  assert.match(pool.calls[2].sql, /^DELETE FROM server_route_minutes WHERE minute < NOW\(\) - make_interval\(days => \$1\)$/);
  assert.deepEqual(pool.calls.map((q) => q.params), [[14], [14], [7]]);
  assert.equal(await counts.prune(stubPool({ fail: () => new Error('x') })), null);
});

// ── What each route cost ────────────────────────────────────────────────

test('a response costs its time (one held open by design left out) and its bytes', () => {
  assert.deepEqual(counts.costOf({ durationMs: 12.5, bytes: 2048 }), { requests: 1, streams: 0, aborted: 0, totalMs: 12.5, maxMs: 12.5, bytes: 2048 });
  assert.deepEqual(counts.costOf({ durationMs: 90_000, bytes: 10, stream: true }), { requests: 1, streams: 1, aborted: 0, totalMs: 0, maxMs: 0, bytes: 10 });
  assert.deepEqual(counts.costOf({ durationMs: 300, aborted: true }), { requests: 1, streams: 0, aborted: 1, totalMs: 300, maxMs: 300, bytes: 0 });
  assert.deepEqual(counts.costOf({ durationMs: -1, bytes: Number.NaN }), { requests: 1, streams: 0, aborted: 0, totalMs: 0, maxMs: 0, bytes: 0 });
  assert.deepEqual(counts.costOf(), { requests: 1, streams: 0, aborted: 0, totalMs: 0, maxMs: 0, bytes: 0 });
});

test('every response counts in its route\'s cost; outside /api/ only there, unnamed as (non-api)', () => {
  const c = counts.createCounts({ pod: 'p1' });
  c.record({ method: 'GET', route: '/api/apps', status: 200, now: T0, durationMs: 40, bytes: 5000 });
  c.record({ method: 'GET', route: '/api/apps', status: 200, now: T0 + 1, durationMs: 400, bytes: 15000 });
  c.record({ method: 'GET', route: '/api/events', status: 200, now: T0 + 2, durationMs: 60_000, bytes: 300, stream: true });
  c.record({ method: 'GET', route: counts.UNMATCHED, status: 200, now: T0 + 3, durationMs: 2, bytes: 900, api: false });
  c.record({ method: 'GET', route: '/mcp', status: 200, now: T0 + 4, durationMs: 30, bytes: 100, api: false });
  c.record({ method: 'GET', route: '/api/apps', status: 200, now: T0 + 5, durationMs: 9000, aborted: true });
  const [m] = c.snapshot();
  assert.equal(m.requests, 3, 'the /api/ total is unchanged by what is outside it, or by a request whose client gave up');
  const byRoute = new Map(m.routes.map((r) => [`${r.method} ${r.route}`, r]));
  assert.deepEqual(byRoute.get('GET /api/apps'), { method: 'GET', route: '/api/apps', requests: 3, streams: 0, aborted: 1, totalMs: 9440, maxMs: 9000, bytes: 20000 },
    'an aborted request still costs what it took');
  assert.deepEqual(byRoute.get('GET /api/events'), { method: 'GET', route: '/api/events', requests: 1, streams: 1, aborted: 0, totalMs: 0, maxMs: 0, bytes: 300 });
  assert.equal(byRoute.get(`GET ${counts.NON_API}`).bytes, 900, 'a static file or page is one row, never its path');
  assert.equal(byRoute.get('GET /mcp').requests, 1, 'a route declared outside /api/ keeps its template');
});

test('a minute writes its costliest routes by name and folds the rest into (other)', () => {
  const routes = new Map();
  const add = (method, route, totalMs, bytes = 0) => routes.set(`${method} ${route}`, { method, route, requests: 1, streams: 0, totalMs, maxMs: totalMs, bytes });
  add('GET', '/api/a', 5);
  add('GET', '/api/b', 500);
  add('GET', '/api/c', 50);
  add('POST', '/api/d', 1, 9);
  add('POST', '/api/e', 1, 1);
  const rows = counts.costliestRoutes(routes, 2);
  assert.deepEqual(rows.map((r) => `${r.method} ${r.route}`), ['GET /api/b', 'GET /api/c', 'GET (other)', 'POST (other)']);
  assert.deepEqual(rows.find((r) => r.method === 'POST'), { method: 'POST', route: counts.OTHER, requests: 2, streams: 0, aborted: 0, totalMs: 2, maxMs: 1, bytes: 10 });

  const capped = counts.createCounts({ pod: 'p1', maxRouteKeys: 2 });
  for (const route of ['/api/a', '/api/b', '/api/c', '/api/d']) capped.record({ method: 'GET', route, status: 200, now: T0, durationMs: 1 });
  assert.deepEqual(capped.snapshot()[0].routes.map((r) => [r.route, r.requests]), [['/api/a', 1], ['/api/b', 1], [counts.OTHER, 2]],
    'past the distinct routes kept in memory, a route counts in (other)');
});

test('the route costs\' upsert adds counts, times and bytes, and keeps the longest', () => {
  assert.match(counts.ROUTES_UPSERT_SQL, /INSERT INTO server_route_minutes \(minute, pod, method, route, requests, streams, aborted, total_ms, max_ms, bytes\)/);
  assert.match(counts.ROUTES_UPSERT_SQL, /ON CONFLICT \(minute, pod, method, route\) DO UPDATE/);
  assert.match(counts.ROUTES_UPSERT_SQL, /aborted = server_route_minutes\.aborted \+ EXCLUDED\.aborted/);
  assert.match(counts.ROUTES_UPSERT_SQL, /total_ms = server_route_minutes\.total_ms \+ EXCLUDED\.total_ms/);
  assert.match(counts.ROUTES_UPSERT_SQL, /max_ms = GREATEST\(server_route_minutes\.max_ms, EXCLUDED\.max_ms\)/);
  assert.match(counts.ROUTES_UPSERT_SQL, /bytes = server_route_minutes\.bytes \+ EXCLUDED\.bytes/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS server_route_minutes \([\s\S]*?PRIMARY KEY \(minute, pod, method, route\)\n\);/);
  // The primary key leads with `minute`: a second index on it would only add
  // writes to a table that takes tens of rows per Pod per minute.
  assert.doesNotMatch(schema, /CREATE INDEX[^;]*ON server_route_minutes\s*\(\s*minute\b[^,)]*\)/);
});

// ── The middleware, in a real Express app ───────────────────────────────

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function buildApp(c) {
  const app = express();
  app.use(requestCounts({ counts: c }));
  app.use(express.json());
  app.get('/api/fine/:id', (_req, res) => res.json({ ok: true }));
  app.get('/api/apps/:slug/boom', () => {
    throw new TypeError('Cannot read properties of undefined (reading \'id\') for ada@example.com');
  });
  app.post('/api/answers-500', (_req, res) => res.status(500).json({ error: 'Could not save' }));
  const mounted = express.Router();
  mounted.get('/turns/:n', () => { throw new RangeError('no such turn'); });
  app.use('/api/mounted', mounted);
  app.use('/api/broken-middleware', () => { throw new Error('before any route'); });
  app.get('/page', (_req, res) => res.send('<p>not counted</p>'));
  app.use(errorHandler);
  return app;
}

async function settled(c, n) {
  // `finish` fires as the response is handed to the socket, which is before
  // the client has read it on most runs, but not by contract.
  for (let i = 0; i < 50; i += 1) {
    const total = c.snapshot().reduce((s, b) => s + b.requests, 0);
    if (total >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('the middleware counts /api/ responses by route template, and each 5xx by what was thrown', async () => {
  const c = counts.createCounts({ pod: 'p1' });
  const server = await listen(buildApp(c));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const fine = await fetch(`${base}/api/fine/42`);
    assert.equal(fine.status, 200);
    const boom = await fetch(`${base}/api/apps/my-app/boom`);
    assert.equal(boom.status, 500);
    assert.deepEqual(await boom.json(), { error: 'Internal server error' }, 'the answer is unchanged');
    const own = await fetch(`${base}/api/answers-500`, { method: 'POST' });
    assert.deepEqual(await own.json(), { error: 'Could not save' }, 'a route\'s own 500 is unchanged');
    assert.equal((await fetch(`${base}/api/mounted/turns/7`)).status, 500);
    assert.equal((await fetch(`${base}/api/broken-middleware/x`)).status, 500);
    assert.equal((await fetch(`${base}/api/nothing-here`)).status, 404);
    assert.equal((await fetch(`${base}/page`)).status, 200);
    await settled(c, 6);
  } finally {
    server.close();
  }
  const [m] = c.snapshot();
  assert.equal(m.requests, 6, 'every /api/ response, and nothing else');
  assert.equal(m.errors, 4);
  const byRoute = Object.fromEntries(m.details.map((d) => [`${d.method} ${d.route}`, d]));
  assert.deepEqual(Object.keys(byRoute).sort(), [
    'GET (unmatched)',
    'GET /api/apps/:slug/boom',
    'GET /api/mounted/turns/:n',
    'POST /api/answers-500',
  ]);
  const boom = byRoute['GET /api/apps/:slug/boom'];
  assert.equal(boom.errType, 'TypeError');
  assert.equal(boom.status, 500);
  assert.equal(boom.sample, 'Cannot read properties of undefined (reading \'id\') for [email]');
  assert.ok(!JSON.stringify(m.details).includes('my-app'), 'the raw path is never kept');
  assert.equal(byRoute['GET /api/mounted/turns/:n'].errType, 'RangeError',
    'an error thrown out of a mounted router keeps its route\'s prefix');
  assert.deepEqual(
    [byRoute['POST /api/answers-500'].errType, byRoute['POST /api/answers-500'].frame, byRoute['POST /api/answers-500'].sample],
    ['', '', null], 'a route that answers its own 500 is counted with no type or frame');
  assert.equal(byRoute['GET (unmatched)'].errType, 'Error', 'a middleware\'s throw is counted, unmatched');
});

test('the middleware records what every response cost, and hands a slow one to the stall watcher', async () => {
  const c = counts.createCounts({ pod: 'p1' });
  const finished = [];
  const health = { noteFinished: (e) => finished.push(e) };
  const app = express();
  app.use(requestCounts({ counts: c, health }));
  app.get('/api/big/:id', (_req, res) => res.json({ blob: 'x'.repeat(20_000) }));
  app.get('/api/stream', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: hi\n\n');
  });
  app.get('/page', (_req, res) => res.send('<p>page</p>'));
  app.use((_req, res) => res.status(404).send('no'));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ['/api/big/7', '/api/stream', '/page', '/assets/app.js?token=secret']) {
      const r = await fetch(`${base}${p}`);
      await r.arrayBuffer();
    }
    for (let i = 0; i < 50 && c.snapshot().reduce((n, b) => n + b.routes.reduce((s, r) => s + r.requests, 0), 0) < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    server.close();
  }
  const [m] = c.snapshot();
  assert.equal(m.requests, 2, 'the /api/ totals still count /api/ only');
  const byRoute = new Map(m.routes.map((r) => [`${r.method} ${r.route}`, r]));
  assert.deepEqual([...byRoute.keys()].sort(), ['GET (non-api)', 'GET /api/big/:id', 'GET /api/stream', 'GET /page']);
  const big = byRoute.get('GET /api/big/:id');
  assert.ok(big.bytes > 20_000, `the socket's bytes for the response (${big.bytes})`);
  assert.ok(big.totalMs > 0 && big.maxMs === big.totalMs, 'its time');
  assert.equal(byRoute.get('GET /api/stream').streams, 1);
  assert.equal(byRoute.get('GET /api/stream').totalMs, 0, 'an event stream\'s time is left out');
  assert.ok(!JSON.stringify(m.routes).includes('secret') && !JSON.stringify(m.routes).includes('app.js'),
    'a path no route declared is never kept');
  assert.deepEqual(finished.map((e) => e.route).sort(), ['(unmatched)', '/api/big/:id', '/page'],
    'each finished response but an event stream goes to the stall watcher, which keeps the slow ones');
  assert.ok(finished.every((e) => Number.isFinite(e.startedAt) && Number.isFinite(e.durationMs)));
});

test('a request whose client gave up first still costs what it took, counted as aborted', async () => {
  const c = counts.createCounts({ pod: 'p1' });
  const finished = [];
  const app = express();
  app.use(requestCounts({ counts: c, health: { noteFinished: (e) => finished.push(e) } }));
  app.get('/api/slow', (_req, res) => { setTimeout(() => { if (!res.writableEnded) res.json({ late: true }); }, 600); });
  app.get('/api/events', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: 1\n\n'); });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ['/api/slow', '/api/events']) {
      const ac = new AbortController();
      const r = fetch(`${base}${p}`, { signal: ac.signal }).then((res) => res.body?.getReader().read()).catch(() => null);
      await new Promise((t) => setTimeout(t, 250));
      ac.abort();
      await r;
    }
    for (let i = 0; i < 50 && c.snapshot().reduce((n, b) => n + b.routes.length, 0) < 2; i += 1) {
      await new Promise((t) => setTimeout(t, 10));
    }
  } finally {
    server.close();
  }
  const [m] = c.snapshot();
  assert.equal(m.requests, 0, 'the /api/ totals still count only responses that finished');
  const byRoute = new Map(m.routes.map((r) => [r.route, r]));
  const slow = byRoute.get('/api/slow');
  assert.equal(slow.aborted, 1);
  assert.ok(slow.totalMs >= 200 && slow.totalMs < 600, `its time until the client went (${slow.totalMs})`);
  const events = byRoute.get('/api/events');
  assert.deepEqual([events.requests, events.streams, events.totalMs], [1, 1, 0],
    'an event stream ended by its client counts as a stream, its time left out');
  assert.deepEqual(finished.map((e) => [e.route, e.aborted]), [['/api/slow', true]], 'the stall watcher hears of it');
});

test('a long poll marked open-ended counts as held: no time, and no suspect in a stall', async () => {
  const { openEnded } = require('../src/middleware/inflight-requests');
  const c = counts.createCounts({ pod: 'p1' });
  const finished = [];
  const app = express();
  app.use(requestCounts({ counts: c, health: { noteFinished: (e) => finished.push(e) } }));
  app.get('/api/turns/next', (_req, res) => { openEnded(res); setTimeout(() => res.json({ turn: null }), 300); });
  const server = await listen(app);
  try {
    await (await fetch(`http://127.0.0.1:${server.address().port}/api/turns/next`)).json();
    for (let i = 0; i < 50 && !c.snapshot().length; i += 1) await new Promise((t) => setTimeout(t, 10));
  } finally {
    server.close();
  }
  const [r] = c.snapshot()[0].routes;
  assert.deepEqual([r.route, r.requests, r.streams, r.totalMs], ['/api/turns/next', 1, 1, 0]);
  assert.equal(c.snapshot()[0].requests, 1, 'it still counts in the /api/ totals');
  assert.deepEqual(finished, []);
});

test('pipelined requests each count their own bytes', async () => {
  const net = require('node:net');
  const c = counts.createCounts({ pod: 'p1' });
  const app = express();
  app.use(requestCounts({ counts: c, health: { noteFinished() {} } }));
  app.get('/api/big', (_req, res) => setTimeout(() => res.send('x'.repeat(100_000)), 50));
  app.get('/api/tiny', (_req, res) => res.send('y'));
  const server = await listen(app);
  try {
    await new Promise((resolve, reject) => {
      const s = net.connect(server.address().port, '127.0.0.1', () => {
        s.write('GET /api/big HTTP/1.1\r\nHost: x\r\n\r\nGET /api/tiny HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      });
      s.on('data', () => {});
      s.on('end', resolve);
      s.on('error', reject);
    });
    for (let i = 0; i < 50 && c.snapshot()[0]?.routes.length < 2; i += 1) await new Promise((t) => setTimeout(t, 10));
  } finally {
    server.close();
  }
  const byRoute = new Map(c.snapshot()[0].routes.map((r) => [r.route, r]));
  assert.ok(byRoute.get('/api/big').bytes > 100_000, `the big one (${byRoute.get('/api/big').bytes})`);
  assert.ok(byRoute.get('/api/tiny').bytes < 2_000, `the tiny one counts its own response only (${byRoute.get('/api/tiny').bytes})`);
});

test('the error handler leaves what it caught for a 5xx only', () => {
  const run = (err) => {
    const res = {
      headersSent: false, locals: {}, statusCode: 200,
      status(s) { this.statusCode = s; return this; },
      json() { return this; },
    };
    errorHandler(err, { method: 'GET', path: '/api/x' }, res, () => {});
    return res;
  };
  const fivexx = run(new TypeError('x'));
  assert.equal(fivexx.statusCode, 500);
  assert.equal(fivexx.locals.serverError.errType, 'TypeError');
  assert.equal(fivexx.locals.serverError.message, 'x');
  const parse = Object.assign(new SyntaxError('Unexpected token'), { status: 400 });
  assert.equal(run(parse).locals.serverError, undefined, 'a client\'s 4xx is not a server error');
});

// ── The observer ────────────────────────────────────────────────────────

const row = (over) => ({
  method: 'GET', route: '/api/apps/:slug/topics/:key/figures', status: 500, err_type: 'TypeError',
  frame: 'src/services/server-error-counts.js:10', last_hour: 2, last_day: 9,
  first_minute: '2026-10-19T08:00:00Z', last_minute: '2026-10-19T09:58:00Z',
  pods: ['web-a'], samples: ['x is undefined'], ...over,
});

test('the observer folds statuses into a class and files a route with at least 3 in the hour', async () => {
  const pool = stubPool();
  pool.query = async (sql) => {
    pool.calls.push({ sql });
    return { rows: [
      row({}),
      row({ status: 503, last_hour: 1, last_day: 1, first_minute: '2026-10-19T07:00:00Z', pods: ['web-b'], samples: ['other'] }),
      row({ route: '/api/sessions/:id/vote', method: 'POST', err_type: '', frame: '', last_hour: 2 }),
      row({ route: '/api/auth/phone/verify', method: 'POST', err_type: 'Error(ECONNREFUSED)', frame: 'src/nope/never.js:1', last_hour: 12, samples: null }),
    ] };
  };
  const items = await observer.run(pool);
  assert.match(pool.calls[0].sql, /FROM server_error_minutes/);
  assert.match(pool.calls[0].sql, /minute >= NOW\(\) - interval '24 hours'/);
  assert.match(pool.calls[0].sql, /FILTER \(WHERE minute >= NOW\(\) - interval '1 hour'\)/);
  assert.equal(items.length, 2, 'the vote route had 2 in the hour: a blip');
  const [auth, figures] = items;
  assert.equal(auth.occurrences, 12, 'the busiest first');
  assert.equal(auth.topic, 'onboarding');
  assert.deepEqual(auth.evidence.where, ['src/routes/phone-auth.js'],
    'a frame this checkout does not have is not sent; the route\'s own file is');
  assert.equal(auth.evidencePrivate, null);

  assert.equal(figures.kind, 'server_errors');
  assert.equal(figures.key, 'GET /api/apps/:slug/topics/:key/figures:TypeError:src/services/server-error-counts.js',
    'the frame\'s file, not its line: an edit above the throw is the same problem');
  assert.equal(figures.title, 'Server errors on GET /api/apps/:slug/topics/:key/figures: TypeError');
  assert.equal(figures.topic, 'infra');
  assert.equal(figures.occurrences, 3, '500 and 503 are one problem');
  assert.deepEqual(figures.evidence.where, ['src/services/server-error-counts.js:10', 'src/routes/topic-figures.js']);
  assert.deepEqual(figures.evidencePrivate, { samples: ['x is undefined', 'other'] });
  const lines = figures.evidence.lines.join('\n');
  assert.match(lines, /3 server errors in the last hour, 10 in the last 24 hours\./);
  assert.match(lines, /Statuses: 500, 503\./);
  assert.match(lines, /First in the last 24 hours at 2026-10-19T07:00Z, the last at 2026-10-19T09:58Z/);
  assert.match(lines, /From 2 processes in the last hour\./);
  assert.match(lines, /Error type: TypeError, thrown at src\/services\/server-error-counts\.js:10\./);

  // As the sweep takes it: whole, and nothing private in the public tier.
  const it = signals.normalizeItem(figures);
  assert.equal(it.fingerprint, `server_errors:${figures.key}`);
  assert.equal(it.fixer, 'bot');
  assert.ok(!JSON.stringify(it.evidence).includes('x is undefined'), 'the samples stay private');
});

test('a frame\'s line moving (a release between) is still one problem; a middleware\'s throw says so', () => {
  const groups = observer.groupRows([
    row({ frame: 'src/services/server-error-counts.js:10', last_hour: 1 }),
    row({ frame: 'src/services/server-error-counts.js:14', last_hour: 3 }),
    row({ frame: 'src/routes/apps.js:10', last_hour: 3 }),
  ]);
  assert.equal(groups.length, 2);
  const [moved] = groups.filter((g) => g.file === 'src/services/server-error-counts.js');
  assert.equal(moved.lastHour, 4);
  assert.deepEqual(moved.frames, ['src/services/server-error-counts.js:14', 'src/services/server-error-counts.js:10'],
    'the line most of the hour threw at first');
  assert.match(observer.itemOf(moved).evidence.lines.join('\n'),
    /thrown at src\/services\/server-error-counts\.js:14, src\/services\/server-error-counts\.js:10\./);

  const [mw] = observer.groupRows([row({ route: '(unmatched)', method: 'POST', err_type: 'Error', frame: '', last_hour: 3 })]);
  const item = observer.itemOf(mw);
  assert.equal(item.title, 'Server errors on POST before any route answered: Error');
  assert.match(item.evidence.lines.join('\n'), /No route matched: a middleware threw before one could\./);
  assert.equal(item.topic, 'infra');
});

test('a route that answers its own 500 says so, and its group is still one problem', () => {
  const [g] = observer.groupRows([row({ err_type: '', frame: '', last_hour: 4, samples: null })]);
  const item = observer.itemOf(g);
  assert.equal(item.title, 'Server errors on GET /api/apps/:slug/topics/:key/figures: 500');
  assert.match(item.evidence.lines.join('\n'), /answered the error itself \(a catch block\)/);
  assert.deepEqual(item.evidence.where, ['src/routes/topic-figures.js']);
  assert.deepEqual(observer.groupRows([row({ last_hour: 2 })]), [], 'under the threshold');
  assert.equal(observer.groupRows([row({ last_hour: 2 })], { min: 2 }).length, 1);
});

test('a route\'s errors go to the topic its prefix names, by whole segments', () => {
  assert.equal(observer.topicOf('/api/auth/phone/verify'), 'onboarding');
  assert.equal(observer.topicOf('/api/authors'), 'infra', 'a prefix is whole segments');
  assert.equal(observer.topicOf('/api/apps/:slug/first-version/live'), 'onboarding');
  assert.equal(observer.topicOf('/api/sessions/:id/vote'), 'proposal-pipeline');
  assert.equal(observer.topicOf('/api/apps/:slug/proposals'), 'proposal-pipeline');
  assert.equal(observer.topicOf('/api/admin/homeroom-bot/bench/runs'), 'homeroom-bot');
  assert.equal(observer.topicOf('/api/apps/:slug/topics/:key/figures'), 'infra');
  assert.equal(observer.topicOf('(unmatched)'), 'infra');
  for (const [prefix, topic] of observer.TOPIC_PREFIXES) {
    assert.ok(signals.TOPICS.includes(topic), `${prefix}: a real topic`);
  }
});

test('a frame names a real file of this checkout or nothing', () => {
  assert.equal(observer.realFrame('src/services/server-error-counts.js:12'), 'src/services/server-error-counts.js:12');
  assert.equal(observer.realFrame('server.js:1'), 'server.js:1');
  assert.equal(observer.realFrame('src/services/not-a-file.js:1'), null);
  assert.equal(observer.realFrame('src/../package.json:1'), null);
  assert.equal(observer.realFrame('src/services'), null);
  assert.equal(observer.realFrame(''), null);
});

test('a route\'s file is read from the literal paths the route files and server.js declare', () => {
  assert.equal(observer.routeFileOf('POST', '/api/auth/phone/verify'), 'src/routes/phone-auth.js',
    'auth.js only lists this path among its session-minting ones; phone-auth.js declares the route');
  assert.equal(observer.routeFileOf('GET', '/api/apps/:slug/topics/:key/figures'), 'src/routes/topic-figures.js');
  assert.equal(observer.routeFileOf('GET', '/health'), 'server.js');
  assert.equal(observer.routeFileOf('get', '/health'), null, 'the method as Express records it: upper case');
  assert.equal(observer.routeFileOf('GET', '/api/no-such-route'), null);
  const src = fs.readFileSync(path.join(root, 'src/services/signal-observers/server-errors.js'), 'utf8');
  assert.doesNotMatch(src, /inventory\.generated|require\([^)]*\.json/, 'no generated inventory is read');
});

test('the sweep runs this observer for its kind', async () => {
  const entry = observers.OBSERVERS.find((o) => o.kinds.includes('server_errors'));
  const pool = { query: async () => ({ rows: [row({ last_hour: 5 })] }) };
  const { items, ok } = await observers.observeAll(pool, { observers: [entry] });
  assert.ok(ok.has('server_errors'));
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'server_errors');
});

// ── Where the platform runs it ──────────────────────────────────────────

test('server.js counts every request and flushes on every process; the prune is a daily clock', () => {
  const src = read('server.js');
  const mount = src.indexOf("app.use(require('./src/middleware/request-counts').requestCounts());");
  assert.ok(mount > 0, 'the middleware is mounted');
  assert.ok(src.indexOf('app.use(inflightRequests.inflightRequests());') < mount, 'after the in-flight count');
  for (const later of ['app.use(responseCompression());', 'app.use(authMiddleware(config));', 'app.use(appRoutes(config));', 'app.use(errorHandler);']) {
    assert.ok(mount < src.indexOf(later), `ahead of ${later}`);
  }
  const startBody = src.slice(src.indexOf('async function start()'), src.indexOf('// Boot only when run as the entry point'));
  assert.match(startBody, /require\('\.\/src\/services\/server-error-counts'\)\.start\(\{ pool: getPool\(config\) \}\);/,
    'every process flushes its own counts');
  // A scheduled job of the workflow (src/workflow/clock/services.ts).
  assert.match(read('src/workflow/clock/services.ts'),
    /name: 'server-error-prune', everyMs: 24 \* HOUR,/, 'pruned daily');
  assert.ok(!src.includes("'server-error-prune'"), 'no process prunes them on its own');
  const handler = read('src/middleware/error-handler.js');
  assert.match(handler, /if \(status >= 500 && res\.locals\) res\.locals\.serverError = errorFacts\(err\);/);
});

test('the flush runs just after each minute ends, re-armed from the clock, unref\'d, started once', async () => {
  // An interval re-arms from when its callback ran, so one late run would
  // shift every flush after it off the minute; this timer is set again
  // from the clock after each run.
  assert.equal(counts.msToNextMinute(T0 + 59_000, 100), 1100);
  assert.equal(counts.msToNextMinute(T0, 100), MIN + 100);
  const real = global.setTimeout;
  const made = [];
  global.setTimeout = (fn, ms) => {
    const h = { fn, ms, unrefed: false, unref() { this.unrefed = true; return this; } };
    made.push(h);
    return h;
  };
  const pool = stubPool();
  try {
    counts.start({ pool });
    counts.start({ pool: stubPool() });
    assert.equal(made.length, 1, 'started once');
    assert.ok(made[0].ms > counts.FLUSH_SLACK_MS && made[0].ms <= MIN + counts.FLUSH_SLACK_MS);
    counts.record({ method: 'GET', route: '/api/a', status: 200, now: Date.now() - MIN });
    made[0].fn();
    assert.equal(made.length, 2, 'it re-arms itself after each run');
    assert.ok(made[1].ms <= MIN + counts.FLUSH_SLACK_MS);
    await new Promise((r) => real(r, 0));
    assert.equal(pool.calls[0]?.sql, counts.REQUESTS_UPSERT_SQL, 'the run flushed the minute that ended');
  } finally {
    global.setTimeout = real;
    counts.stop();
  }
  made[1].fn();
  assert.equal(made.length, 2, 'stopped, a run already scheduled does nothing and arms nothing');
  assert.ok(made.every((h) => h.unrefed));
});
