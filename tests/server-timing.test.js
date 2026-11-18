'use strict';

// #6792: a successful /api/ response says what it cost, in Server-Timing:
// its database time and query count, and its total. Counted per request
// through src/middleware/server-timing.js.
//
// Run with: node --test tests/server-timing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { serverTiming, resumeServerTiming, instrumentPool, carriesTiming } = require('../src/middleware/server-timing');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A stand-in with pg-pool's shape: query() by promise or callback, connect()
// by promise or callback, and a client whose release() the pool sets anew on
// every checkout. `gate` holds a checkout until the test lets it go.
function fakePool() {
  const client = {};
  Object.setPrototypeOf(client, { query: async () => { await wait(2); return { rows: [] }; } });
  const pool = {
    gate: null,
    released: 0,
    query(text, values, cb) {
      const done = typeof values === 'function' ? values : cb;
      if (done) { this.connect((err, c) => c.query(text).then((r) => { c.release(); done(null, r); })); return undefined; }
      return wait(2).then(() => ({ rows: [] }));
    },
    connect(cb) {
      const hand = () => { client.release = () => { pool.released += 1; }; return client; };
      if (cb) { cb(null, hand()); return undefined; }
      return (pool.gate || Promise.resolve()).then(hand);
    },
  };
  return { pool: instrumentPool(pool), client };
}

async function serve(mount) {
  const app = express();
  app.use(serverTiming());
  app.use(express.json());
  app.use(resumeServerTiming);
  mount(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function parse(header) {
  const m = /^db;dur=([\d.]+);desc="n=(\d+)", total;dur=([\d.]+)$/.exec(header || '');
  return m ? { dbMs: Number(m[1]), queries: Number(m[2]), totalMs: Number(m[3]) } : null;
}

test('an API read says its query count, its database time and its total', async () => {
  const { pool } = fakePool();
  const s = await serve((app) => {
    app.get('/api/things', async (req, res) => {
      await pool.query('SELECT 1');
      await Promise.all([pool.query('SELECT 2'), pool.query('SELECT 3')]);
      res.json({ ok: true });
    });
  });
  try {
    const res = await fetch(`${s.base}/api/things`);
    const t = parse(res.headers.get('server-timing'));
    assert.ok(t, `a well-formed header, got ${res.headers.get('server-timing')}`);
    assert.equal(t.queries, 3);
    assert.ok(t.dbMs > 0 && t.totalMs > 0);
  } finally { await s.close(); }
});

test('a client taken from the pool counts for the request that took it, until it is given back', async () => {
  const { pool, client } = fakePool();
  const s = await serve((app) => {
    app.get('/api/tx', async (req, res) => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); await c.query('SELECT 1'); await c.query('COMMIT'); } finally { c.release(); }
      res.json({ ok: true });
    });
  });
  try {
    const res = await fetch(`${s.base}/api/tx`);
    assert.equal(parse(res.headers.get('server-timing')).queries, 3);
    assert.equal(pool.released, 1, 'the pool\'s own release still ran');
    assert.equal(Object.prototype.hasOwnProperty.call(client, 'query'), false, 'the client is handed back as it was');
  } finally { await s.close(); }
});

test('the pool\'s own callback checkout is not counted twice', async () => {
  const { pool } = fakePool();
  const s = await serve((app) => {
    app.get('/api/cb', (req, res) => { pool.query('SELECT 1', [], () => res.json({ ok: true })); });
  });
  try {
    const res = await fetch(`${s.base}/api/cb`);
    assert.equal(parse(res.headers.get('server-timing')).queries, 1);
  } finally { await s.close(); }
});

test('a request with a body keeps its count past the body parser', async () => {
  const { pool } = fakePool();
  const s = await serve((app) => {
    app.post('/api/write', async (req, res) => { await pool.query('INSERT'); res.json({ got: req.body.a }); });
  });
  try {
    const res = await fetch(`${s.base}/api/write`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) });
    assert.deepEqual(await res.json(), { got: 1 });
    assert.equal(parse(res.headers.get('server-timing')).queries, 1);
  } finally { await s.close(); }
});

test('two requests at once never count each other\'s queries', async () => {
  const { pool } = fakePool();
  const s = await serve((app) => {
    app.get('/api/n/:n', async (req, res) => {
      for (let i = 0; i < Number(req.params.n); i += 1) await pool.query('SELECT 1');
      res.json({ ok: true });
    });
  });
  try {
    const [a, b] = await Promise.all([fetch(`${s.base}/api/n/5`), fetch(`${s.base}/api/n/2`)]);
    assert.equal(parse(a.headers.get('server-timing')).queries, 5);
    assert.equal(parse(b.headers.get('server-timing')).queries, 2);
  } finally { await s.close(); }
});

test('a refusal, a sign-in route and a page carry no timing', async () => {
  const { pool } = fakePool();
  const s = await serve((app) => {
    app.get('/api/private', async (req, res) => { await pool.query('SELECT 1'); res.status(404).json({ error: 'not found' }); });
    app.get('/api/auth/me', async (req, res) => { await pool.query('SELECT 1'); res.json({ user: null }); });
    app.get('/page', async (req, res) => { await pool.query('SELECT 1'); res.send('<p>hi</p>'); });
  });
  try {
    for (const p of ['/api/private', '/api/auth/me', '/page']) {
      const res = await fetch(`${s.base}${p}`);
      assert.equal(res.headers.get('server-timing'), null, `${p}: a query count would tell two refusals apart`);
    }
    assert.equal(carriesTiming({ path: '/api/apps' }, 304), true, 'a 304 is a success');
    assert.equal(carriesTiming({ path: '/api/apps' }, 500), false);
  } finally { await s.close(); }
});

test('outside a request nothing is counted and nothing is changed', async () => {
  const { pool } = fakePool();
  assert.deepEqual(await pool.query('SELECT 1'), { rows: [] });
  const c = await pool.connect();
  assert.deepEqual(await c.query('SELECT 1'), { rows: [] });
  c.release();
  assert.equal(instrumentPool(pool), pool, 'instrumenting twice is once');
});

test('the server mounts it ahead of every route, and the main pool is counted', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const timing = server.indexOf("require('./src/middleware/server-timing').serverTiming()");
  const resume = server.indexOf("require('./src/middleware/server-timing').resumeServerTiming");
  assert.ok(timing > 0 && resume > timing);
  assert.ok(timing > server.indexOf("require('./src/middleware/same-site-browser').sameOriginCookieWrites"),
    'after the cookie-write guard, which stays first (tests/same-site-browser.test.js)');
  assert.ok(timing < server.indexOf('app.use(mobileAppLinkRoutes())'), 'and ahead of every router');
  assert.ok(resume > server.indexOf('app.use(cookieParser())'), 'entered again after the body parsers');
  assert.match(fs.readFileSync(path.join(root, 'src/db/pool.js'), 'utf8'), /server-timing'\)\.instrumentPool\(pool\)/);
});
