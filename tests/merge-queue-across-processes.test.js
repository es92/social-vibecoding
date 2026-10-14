'use strict';

// An app's merge queue pass is single-flight across processes
// (services/merge-queue.js, docs/plans/web-and-conductor.md): a vote lands on
// a web process while the eligible-merge sweep and the drift poller run on
// the conductor. A pass holds the app's advisory lock (MERGE_QUEUE_PASS_LOCK)
// for its length; a trigger that cannot take it asks the process running the
// pass, over the bus, to run again; a process shutting down hands its re-run
// to anyone serving. The other process is played by the registry's copy of
// its holds (a fake database answers the mirror's read), the lock by a fake
// client, and the bus by a stub of its publish; the last test takes the real
// lock in PostgreSQL when one is reachable.
//
// Run with: node --test tests/merge-queue-across-processes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const processes = require('../src/services/processes');
const wsBus = require('../src/services/ws-bus');
const { MERGE_QUEUE_PASS_LOCK } = require('../src/services/advisory-locks');

// The database every pass talks to: a pass is seen by its first query
// (retireStaleIntegrating), and the lock by its client.
const db = { lockFree: true, connectFails: false, lockFails: false, calls: [], lockCalls: [], released: [], gate: null };
const pool = {
  async query(sql, params) {
    db.calls.push(sql);
    if (db.gate && /integration_block_reasons @>/.test(sql)) await db.gate;
    // The registry's mirror: the other process and what it holds.
    if (/FROM process_holds h\s+JOIN platform_processes p/.test(sql)) {
      return { rows: (db.elsewhere || []).map(([kind, ref]) => ({ kind, ref: String(ref), process_id: 'pod-conductor' })) };
    }
    return { rows: [], rowCount: 0 };
  },
  async connect() {
    if (db.connectFails) throw new Error('pool exhausted');
    return {
      async query(sql, params) {
        db.lockCalls.push([sql, params]);
        if (db.lockFails) throw new Error('connection reset');
        if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: db.lockFree }] };
        return { rows: [{ pg_advisory_unlock: true }] };
      },
      release(err) { db.released.push(err ? 'destroyed' : 'released'); },
    };
  },
};
const poolPath = require.resolve(path.join(__dirname, '..', 'src/db/pool'));
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => pool } };
const queue = require('../src/services/merge-queue');

const passes = () => db.calls.filter((sql) => /integration_block_reasons @>/.test(sql)).length;

function capture(t) {
  const sent = [];
  const real = wsBus.publish;
  wsBus.publish = (kind, routing, data) => { sent.push({ kind, routing, data }); };
  t.after(() => { wsBus.publish = real; });
  return sent;
}

function reset() {
  Object.assign(db, { lockFree: true, connectFails: false, lockFails: false, calls: [], lockCalls: [], released: [], gate: null, elsewhere: [] });
}

async function registryWith(held) {
  processes._reset();
  db.elsewhere = held;
  await processes.start({ pool, role: 'web' });
}

test('a pass takes the app\'s lock for its length, and gives it back', async (t) => {
  reset();
  t.after(() => processes._reset());
  await queue.enqueue({}, 7);
  assert.equal(passes(), 1);
  assert.deepEqual(db.lockCalls.map(([sql, params]) => [/try_advisory_lock/.test(sql) ? 'lock' : 'unlock', params]),
    [['lock', [MERGE_QUEUE_PASS_LOCK, 7]], ['unlock', [MERGE_QUEUE_PASS_LOCK, 7]]]);
  assert.deepEqual(db.released, ['released']);
  assert.equal(processes.heldHere('merge_pass', 7), false, 'held only while it runs');
});

test('a pass held elsewhere is not run here: the process running it is asked to run again', async (t) => {
  reset();
  await registryWith([['merge_pass', 7]]);
  t.after(() => processes._reset());
  const sent = capture(t);
  db.lockFree = false;
  assert.equal(queue.isIntegrating(7), true, 'any process sees the pass');
  await queue.enqueue({}, 7);
  assert.equal(passes(), 0, 'no second pass');
  assert.deepEqual(db.released, ['released'], 'the client goes back');
  assert.deepEqual(sent, [{ kind: 'merge_kick', routing: null, data: { appId: 7, to: ['pod-conductor'] } }]);
  assert.equal(processes.heldHere('merge_pass', 7), false);
});

test('a kick runs a pass here only where it names this process or anyone; never one naming nobody', async (t) => {
  reset();
  await registryWith([]);
  t.after(() => processes._reset());
  const sent = capture(t);
  await queue.enqueue({}, 9); // remembers the config a kick runs with
  db.calls.length = 0;
  queue.receiveKick({ appId: 9, to: [] });
  queue.receiveKick({ appId: 9, to: ['pod-other'] });
  queue.receiveKick({ appId: 'x', to: ['*'] });
  await new Promise((r) => setImmediate(r));
  assert.equal(passes(), 0, 'every process unsure who holds it would otherwise ask the others in turn');
  queue.receiveKick({ appId: 9, to: [processes.ID] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(passes(), 1, 'named: its pass ended between the two, so it runs now');
  queue.receiveKick({ appId: 9, to: ['*'] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(passes(), 2, 'anyone serving');
  assert.deepEqual(sent, []);
});

test('a kick while the pass runs here runs it once more after it', async (t) => {
  reset();
  await registryWith([]);
  t.after(() => processes._reset());
  let open;
  db.gate = new Promise((r) => { open = r; });
  const first = queue.enqueue({}, 11);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(processes.heldHere('merge_pass', 11), true);
  queue.receiveKick({ appId: 11, to: ['pod-elsewhere'] }); // the holder is this one, whoever was named
  db.gate = null;
  open();
  await first;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(passes(), 2);
});

test('a lock the database will not give runs the pass anyway: two passes is what happened before', async (t) => {
  reset();
  t.after(() => processes._reset());
  db.connectFails = true;
  await queue.enqueue({}, 13);
  assert.equal(passes(), 1);
  reset();
  db.lockFails = true;
  await queue.enqueue({}, 13);
  assert.equal(passes(), 1);
  assert.deepEqual(db.released, ['released']);
});

test('a resolution in another process\'s pass is seen here', async (t) => {
  reset();
  await registryWith([['merge_resolve', 4242]]);
  t.after(() => processes._reset());
  assert.equal(queue.isIntegratingSession(4242), true);
  assert.equal(queue.isIntegratingSession(4243), false);
});

test('the real lock: a second claim waits for the first to give it back', async (t) => {
  const { Pool } = require('pg');
  const DSN = process.env.TEST_DATABASE_URL;
  if (!DSN) { t.skip('set TEST_DATABASE_URL to take the real lock'); return; }
  const real = new Pool({ connectionString: DSN, max: 3 });
  real.on('error', () => {});
  t.after(() => real.end());
  const a = await real.connect();
  const b = await real.connect();
  try {
    const app = 900000 + Math.floor(Math.random() * 1000);
    const take = (c) => c.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [MERGE_QUEUE_PASS_LOCK, app]).then((r) => r.rows[0].ok);
    assert.equal(await take(a), true);
    assert.equal(await take(b), false, 'held by the other connection');
    await a.query('SELECT pg_advisory_unlock($1, $2)', [MERGE_QUEUE_PASS_LOCK, app]);
    assert.equal(await take(b), true);
    await b.query('SELECT pg_advisory_unlock($1, $2)', [MERGE_QUEUE_PASS_LOCK, app]);
  } finally {
    a.release(); b.release();
  }
});

// Last: shutdown cannot be undone in this process.
test('a process shutting down hands its re-run to anyone serving', async (t) => {
  reset();
  await registryWith([]);
  t.after(() => processes._reset());
  const sent = capture(t);
  let open;
  db.gate = new Promise((r) => { open = r; });
  const first = queue.enqueue({}, 15);
  await new Promise((r) => setTimeout(r, 10));
  queue.enqueue({}, 15); // a trigger mid-pass: it shares the pass's promise
  require('../src/services/lifecycle').setShuttingDown();
  db.gate = null;
  open();
  await first;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(passes(), 1, 'nothing new here');
  assert.deepEqual(sent, [{ kind: 'merge_kick', routing: null, data: { appId: 15, to: ['*'] } }]);
});
