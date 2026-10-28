'use strict';

// The turn machine (src/workflow/turn/) against the full PostgreSQL schema:
// a person's turn asked for with its conversation's claim, run as one work
// item, its claim released when the item ends however it ends, the turns
// asked for meanwhile run after it in order, a person's Stop, the six-hour
// limit. Then the item's handler (services/turns.js) with the Mayor and the
// coding run's recovery standing in: what a run is handed, and how a turn
// whose process went is carried on or ended.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-turn-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { turnMachine, agentKey, MACHINE, WORK, INTERRUPTED_TEXT, MAX_TURN_MS } = require('../src/workflow/turn/machine.ts');
const { TURN_STOP } = require('../src/workflow/rules/turn-stop.ts');
const { asTransition } = require('./lib/as-transition');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('turn machine against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_turn_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 10 });
  pool.on('error', () => {});
  const runtimes = [];
  const sessionBus = require('../src/services/session-bus');
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    sessionBus.init({ memory: true });
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1') ON CONFLICT DO NOTHING`);
  sessionBus.init({ pool });

  const agentSessions = require('../src/services/agent-sessions');
  const platform = require('../src/workflow/platform.ts');

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function conversation() {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`tu_${++seq}`]);
    const s = await agentSessions.createAgentSession(pool, { user: { id: u.id } });
    return { id: s.id, user: u, key: agentKey(s.id) };
  }
  // A coding run's record on a change, owned by the conversation's item.
  async function ownedChange(c, workId) {
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by) VALUES ($1::text, $1::text, $2) RETURNING id`, [`tu-app-${++seq}`, c.user.id]);
    const { rows: [ch] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, agent_session_id, active_turn) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [a.id, c.user.id, c.id, JSON.stringify({ turnId: `job-${seq}`, mode: 'build',
        owner: { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:x', workId } })]);
    return ch.id;
  }
  const claim = async (c) => (await pool.query('SELECT active_turn, last_done_at FROM agent_sessions WHERE id = $1', [c.id])).rows[0];
  const instance = async (c) => (await pool.query('SELECT state, data FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, c.key])).rows[0];
  const items = async (c, kind) => (await pool.query(
    `SELECT id, kind, work_key, input, status FROM wf_work WHERE machine = $1 AND key = $2 AND ($3::text IS NULL OR kind = $3)
      ORDER BY created_at, work_key`, [MACHINE, c.key, kind || null])).rows;
  const notes = async (c) => (await pool.query(
    `SELECT content, metadata FROM chat_session_messages WHERE agent_session_id = $1 AND role = 'system' ORDER BY id`, [c.id])).rows;
  // What the route does: the claim and the turn's Asked, one transaction.
  const ask = (c, turnId, input = {}) => agentSessions.acquireTurnLease(pool, {
    agentSessionId: c.id, userId: c.user.id, turnId,
    ask: (db) => platform.askTurn(db, { key: c.key, turnId, kind: 'agent', input: { agentSessionId: c.id, userId: c.user.id, ...input } }),
  });

  // ── 1. The machine, with its work standing in ───────────────────────
  const work = { calls: [], answer: null };
  const fake = (kind) => ({
    maxAttempts: 1, backoffMs: () => 0, leaseMs: 600,
    async run(ctx) {
      work.calls.push({ kind, key: ctx.key, input: ctx.input, workId: ctx.workId });
      if (kind === WORK.run && work.answer) return work.answer(ctx);
      return { ok: true };
    },
  });
  const machine = turnMachine();
  const pushed = [];
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async (_q, list) => { pushed.push(...list); },
    services: { [WORK.run]: fake(WORK.run), [WORK.stalled]: fake(WORK.stalled), [WORK.name]: fake(WORK.name), [WORK.repair]: fake(WORK.repair), [TURN_STOP]: fake(TURN_STOP) },
  });
  runtimes.push(rt);
  let rk = 0;
  const send = (c, type, payload = {}, source = { kind: 'route' }) => rt.append(machine, c.key,
    { type, payload }, { requestKey: `t-${++rk}`, source });
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const runs = (c) => work.calls.filter((w) => w.kind === WORK.run && w.input.instanceKey === c.key);

  await t.test('T1 asked with its claim: one work item runs the turn, and its claim is released as the item ends', async () => {
    work.answer = null;
    const c = await conversation();
    assert.equal(await ask(c, 'turn-1', { messageText: 'Make it blue' }), true);
    assert.equal((await claim(c)).active_turn.id, 'turn-1');
    await rt.drain();
    assert.equal((await instance(c)).state, 'running');
    const [item] = await items(c, WORK.run);
    assert.equal(item.work_key, 'run:turn-1');
    assert.deepEqual(item.input, {
      agentSessionId: c.id, userId: c.user.id, messageText: 'Make it blue', turnId: 'turn-1', kind: 'agent', instanceKey: c.key,
    }, 'what the run needs: never a key or a secret');
    await settle();
    assert.equal(runs(c).length, 1);
    assert.equal((await instance(c)).state, 'idle');
    const after = await claim(c);
    assert.equal(after.active_turn, null, 'released');
    assert.ok(after.last_done_at, 'the green dot');
    assert.deepEqual(await notes(c), [], 'a turn that finished says nothing more');
    const { rows: ends } = await pool.query(`SELECT event FROM stream_events WHERE stream_key = $1 AND seq = 'end-turn-1'`, [c.key]);
    assert.deepEqual(ends.map((r) => r.event.turnId), ['turn-1'],
      'its end on its stream, written in the transaction that settles its item, however the run published');

    // Without its claim, no turn: a busy conversation asks for nothing.
    assert.equal(await ask(c, 'turn-2'), true);
    assert.equal(await ask(c, 'turn-3'), false);
    await settle();
    assert.deepEqual(runs(c).map((r) => r.input.turnId), ['turn-1', 'turn-2']);
  });

  // A turn that failed on a change owes "Session stopped before finishing"
  // as its machine's work (#4729), once: belled after the turn's catch
  // instead, a restart lost it.
  await t.test('T1b a turn that failed on a change owes its stalled notice as work, once; a finished one owes none', async () => {
    const c = await conversation();
    work.answer = (ctx) => (ctx.input.turnId === 'turn-s1' ? { ended: 'done', stalled: 77 } : { ended: 'done' });
    await ask(c, 'turn-s1');
    await settle();
    await ask(c, 'turn-s2');
    await settle();
    work.answer = null;
    const owed = work.calls.filter((w) => w.kind === WORK.stalled && w.input.agentSessionId === c.id);
    assert.deepEqual(owed.map((w) => [w.key, w.input.sessionId, w.input.agentSessionId]), [['stalled:turn-s1', 77, c.id]]);
    assert.ok(Math.abs(Date.parse(owed[0].input.owedAt) - Date.now()) < 60 * 1000, 'when it was owed (a late one is not said)');
    assert.equal((await instance(c)).state, 'idle');
  });

  // A conversation opened on a request is named after it by work beside the
  // turn that asked (#3752): a call after the route's commit before, which a
  // restart lost.
  await t.test('T1c a turn asked to name its conversation after its request has that work beside its run, once', async () => {
    const c = await conversation();
    await ask(c, 'turn-n1', { nameFromRequest: true });
    await ask(c, 'turn-n2');
    await settle();
    assert.deepEqual(work.calls.filter((w) => w.kind === WORK.name && w.input.agentSessionId === c.id).map((w) => [w.key, w.input]),
      [['name:turn-n1', { agentSessionId: c.id, userId: c.user.id }]]);
  });

  // A change's own turn starting and ending is its working state, told by
  // the transition from whichever process runs it (pushes.ts sessionState):
  // it was left to the memory of the process that last published it.
  await t.test('T1d a change\'s turn says the change is busy as it starts and idle as it ends, to its owner', async () => {
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`tu_${++seq}`]);
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by) VALUES ($1::text, $1::text, $2) RETURNING id, slug`, [`tu-app-${++seq}`, u.id]);
    const { rows: [ch] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`, [a.id, u.id]);
    pushed.length = 0;
    work.answer = null;
    await send({ key: `session:${ch.id}` }, 'Asked', { turnId: 'turn-c1', kind: 'classic', input: { sessionId: ch.id } });
    await rt.drain();
    await settle();
    const states = pushed.filter((p) => p.data.type === 'session_state').map((p) => [p.kind, p.routing.userId, p.data.sessionId, p.data.busy, p.data.appSlug]);
    assert.deepEqual(states, [['user', u.id, ch.id, true, a.slug], ['user', u.id, ch.id, false, a.slug]]);
  });

  // A dev chat turn that did not end its own way owes its change the dev
  // chat's repair as work: once, a once-per-release sweep caught it.
  await t.test('T1e a change\'s dev chat turn that failed owes its repair as work, once; one that finished, or a conversation\'s, owes none', async () => {
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`tu_${++seq}`]);
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by) VALUES ($1::text, $1::text, $2) RETURNING id`, [`tu-app-${++seq}`, u.id]);
    const { rows: [ch] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`, [a.id, u.id]);
    const key = `session:${ch.id}`;
    work.answer = (ctx) => { if (ctx.input.turnId === 'turn-r1') throw new Error('the database blinked'); return { ended: 'done' }; };
    await send({ key }, 'Asked', { turnId: 'turn-r1', kind: 'classic', input: { sessionId: ch.id } });
    await send({ key }, 'Asked', { turnId: 'turn-r2', kind: 'classic', input: { sessionId: ch.id } });
    await settle();
    const c = await conversation();
    work.answer = () => { throw new Error('the model did not answer'); };
    await ask(c, 'turn-r3');
    await settle();
    work.answer = null;
    const owed = work.calls.filter((w) => w.kind === WORK.repair);
    assert.deepEqual(owed.map((w) => [w.key, w.input.sessionId]), [['repair:turn-r1', ch.id]]);
    assert.ok(Math.abs(Date.parse(owed[0].input.owedAt) - Date.now()) < 60 * 1000, 'when it was owed (a late one is not run)');
    work.calls.length = 0;
  });

  // A Pod of the release before turn.repair (its machine version 2) ending
  // a turn this release started would owe no repair: it leaves the
  // instance's events to this release, whose version is newer.
  await t.test('T1f a turn this release started is never ended by an older Pod: it owes its repair here', async () => {
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`tu_${++seq}`]);
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by) VALUES ($1::text, $1::text, $2) RETURNING id`, [`tu-app-${++seq}`, u.id]);
    const { rows: [ch] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`, [a.id, u.id]);
    const key = `session:${ch.id}`;
    await send({ key }, 'Asked', { turnId: 'turn-v1', kind: 'classic', input: { sessionId: ch.id } });
    await rt.drain();
    const { rows: [i] } = await pool.query('SELECT state, machine_version FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, key]);
    assert.deepEqual([i.state, Number(i.machine_version)], ['running', machine.version]);
    assert.equal(machine.version, 3);
    const older = createRuntime({ pool, machines: [{ ...machine, version: 2 }], pollMs: 50, publish: async () => {}, services: {} });
    runtimes.push(older);
    const tick = await send({ key }, 'Tick', {}, { kind: 'system' });
    await older.drain();
    const status = async () => (await pool.query('SELECT status FROM wf_events WHERE id = $1', [tick])).rows[0].status;
    assert.equal(await status(), 'pending', 'the older Pod leaves it');
    await rt.drain();
    assert.equal(await status(), 'processed');
    const { rows: owed } = await pool.query(
      `SELECT work_key FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3`, [MACHINE, key, WORK.repair]);
    assert.deepEqual(owed.map((w) => w.work_key), ['repair:turn-v1']);
    await settle();
    work.calls.length = 0;
  });

  await t.test('T2 a turn asked for while one runs waits its turn, in order; the same turn twice is one', async () => {
    const c = await conversation();
    await send(c, 'Asked', { turnId: 'a', kind: 'agent', input: {} });
    await send(c, 'Asked', { turnId: 'b', kind: 'agent', input: {} });
    await send(c, 'Asked', { turnId: 'b', kind: 'agent', input: {} });
    await send(c, 'Asked', { turnId: 'a', kind: 'agent', input: {} });
    await send(c, 'Asked', { turnId: 'c', kind: 'agent', input: {} });
    await rt.drain();
    const i = await instance(c);
    assert.equal(i.data.running.turnId, 'a');
    assert.deepEqual(i.data.waiting.map((w) => w.turnId), ['b', 'c']);
    await settle();
    assert.deepEqual(runs(c).map((r) => r.input.turnId), ['a', 'b', 'c']);
    assert.equal((await instance(c)).state, 'idle');
  });

  await t.test('T3 a run that fails for good: its claim released and the turn ended as interrupted, with Retry; only its own claim', async () => {
    const c = await conversation();
    work.answer = () => { throw new Error('the Mayor fell over'); };
    try {
      assert.equal(await ask(c, 'turn-f'), true);
      await settle();
    } finally { work.answer = null; }
    assert.equal((await claim(c)).active_turn, null);
    assert.deepEqual((await notes(c)).map((n) => [n.content, n.metadata.agentSessionEvent, n.metadata.retryable, n.metadata.agentTurnId]),
      [[INTERRUPTED_TEXT, 'turn_interrupted', true, 'turn-f']]);
    const { rows: ends } = await pool.query(`SELECT event FROM stream_events WHERE stream_key = $1 AND seq = 'end-turn-f'`, [c.key]);
    assert.deepEqual(ends.map((r) => [r.event.type, r.event.turnId, r.event.agentSessionId]), [['done', 'turn-f', c.id]],
      'its end on its stream, which the request that asked for it waits for, in the transaction that ends it');

    // The run released its claim early and the next turn has taken one: the
    // item's end leaves the new claim alone.
    const d = await conversation();
    work.answer = async (ctx) => {
      await agentSessions.releaseTurnLease(pool, { agentSessionId: d.id, turnId: ctx.input.turnId });
      await agentSessions.acquireTurnLease(pool, { agentSessionId: d.id, userId: d.user.id, turnId: 'someone-else' });
      throw new Error('late failure');
    };
    try {
      await ask(d, 'turn-g');
      await settle();
    } finally { work.answer = null; }
    assert.equal((await claim(d)).active_turn.id, 'someone-else', 'not that turn\'s claim');
    assert.deepEqual(await notes(d), [], 'and no note: that turn is not the one ended');
  });

  await t.test('T4 a person\'s Stop: recorded on the turn, and its coding run stopped by its journal when it has one', async () => {
    const c = await conversation();
    let release;
    const gate = new Promise((r) => { release = r; });
    work.answer = async () => { await gate; return { ok: true }; };
    try {
      await ask(c, 'turn-s');
      await rt.drain();
      const running = rt.runServices();
      await new Promise((r) => setTimeout(r, 50));
      await send(c, 'StopRequested', { by: 'ada' });
      await rt.drain();
      assert.equal((await instance(c)).data.running.stoppedBy, 'ada');
      assert.deepEqual(await items(c, TURN_STOP), [], 'no coding run: nothing to stop by a journal');
      const [item] = await items(c, WORK.run);
      const change = await ownedChange(c, item.id);
      await send(c, 'StopRequested', { by: 'ada' });
      await rt.drain();
      const [stop] = await items(c, TURN_STOP);
      assert.deepEqual(stop.input, {
        sessionId: change, machine: MACHINE, key: c.key, kinds: [WORK.run], workKey: 'run:turn-s', by: 'ada', release: false,
      }, 'its record kept, for the run to end it as stopped');
      release();
      await running;
      await settle();
      await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [change]);
    } finally { work.answer = null; release(); }
    assert.equal((await instance(c)).state, 'idle');
    assert.equal((await claim(c)).active_turn, null);
    await send(c, 'StopRequested', { by: 'ada' });
    await rt.drain();
    assert.equal((await instance(c)).state, 'idle', 'a Stop with nothing running changes nothing');
  });

  await t.test('T5 past six hours: the run cancelled, its coding run stopped and released, the claim released as interrupted', async () => {
    assert.equal(MAX_TURN_MS, 6 * 60 * 60 * 1000);
    const c = await conversation();
    let release;
    const gate = new Promise((r) => { release = r; });
    work.answer = async () => { await gate; return { ok: true }; };
    try {
      await ask(c, 'turn-t');
      await ask(c, 'never');
      await send(c, 'Asked', { turnId: 'next', kind: 'agent', input: {} });
      await rt.drain();
      const running = rt.runServices();
      await new Promise((r) => setTimeout(r, 50));
      const [item] = await items(c, WORK.run);
      const change = await ownedChange(c, item.id);
      const c2 = await pool.connect();
      try {
        await c2.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await c2.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, c.key]);
        await c2.query('COMMIT');
      } finally { c2.release(); }
      await rt.fireTimers();
      await rt.drain();
      const [stop] = await items(c, TURN_STOP);
      assert.deepEqual([stop.input.sessionId, stop.input.release, stop.input.by], [change, true, null]);
      assert.equal((await claim(c)).active_turn, null);
      assert.deepEqual((await notes(c)).map((n) => n.metadata.agentTurnId), ['turn-t'], 'ended as interrupted, with Retry');
      assert.equal((await instance(c)).data.running.turnId, 'next', 'the next one starts');
      release();
      await running;
      await settle();
    } finally { work.answer = null; release(); }
    assert.equal((await items(c, WORK.run)).find((w) => w.work_key === 'run:turn-t').status, 'settled');
  });

  await t.test('T6 only a conversation or a change is a turn\'s stream, and only the platform asks', async () => {
    const asked = { type: 'Asked', payload: { turnId: 'x', kind: 'agent', input: {} } };
    const outcome = async (id) => {
      await rt.drain();
      const { rows: [e] } = await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id]);
      return [e.result, e.reason];
    };
    const bad = await rt.append(machine, 'agent:abc', asked, { requestKey: `t-${++rk}`, source: { kind: 'route' } });
    assert.deepEqual(await outcome(bad), ['rejected', 'bad_key']);
    const c = await conversation();
    const o = await rt.append(machine, c.key, asked,
      { requestKey: `t-${++rk}`, source: { kind: 'message', from: { machine: 'x', key: 'y', eventId: 1 } } });
    assert.deepEqual(await outcome(o), ['rejected', 'not_the_platform']);
    await assert.rejects(send(c, 'Asked', { turnId: 'x', kind: 'nope', input: {} }), /Asked needs a kind/);
    assert.equal(await instance(c), undefined, 'nothing started');
  });

  // ── 2. The item's handler (services/turns.js) ───────────────────────
  const turns = require('../src/services/turns');
  const agentTurn = require('../src/services/mayor/agent-turn');
  const recovery = require('../src/services/turn-recovery');
  const localRecovery = require('../src/services/local-agent-recovery');
  const saved = {
    runAgentTurn: agentTurn.runAgentTurn, resolveAgentMayor: agentTurn.resolveAgentMayor,
    recoverOwnedTurn: recovery.recoverOwnedTurn, releaseLeftRecord: recovery.releaseLeftRecord,
    finishAdoptedTurn: localRecovery.finishAdoptedTurn,
  };
  const seen = { runs: [], recovered: [], released: [], local: [] };
  t.after(() => { Object.assign(agentTurn, { runAgentTurn: saved.runAgentTurn, resolveAgentMayor: saved.resolveAgentMayor }); Object.assign(recovery, { recoverOwnedTurn: saved.recoverOwnedTurn, releaseLeftRecord: saved.releaseLeftRecord }); });
  let mayorRun = async () => {};
  agentTurn.resolveAgentMayor = async () => ({ ok: true, provider: 'anthropic', model: 'm' });
  agentTurn.runAgentTurn = async (args) => { seen.runs.push(args); await mayorRun(args); };
  recovery.recoverOwnedTurn = async (args) => { seen.recovered.push(args.sessionId); };
  recovery.releaseLeftRecord = async (args) => { seen.released.push(args.workId); return null; };
  localRecovery.finishAdoptedTurn = async (args) => { seen.local.push(args); return { outcome: 'completed' }; };
  t.after(() => { localRecovery.finishAdoptedTurn = saved.finishAdoptedTurn; });
  // The turn's context, its claim written as the route writes it with the
  // turn's Asked (a turn runs only while its claim names it).
  const ctxFor = async (c, turnId, { lost = 0, aborted = false, input = {}, claim = true } = {}) => {
    if (claim) {
      await pool.query(
        `UPDATE agent_sessions SET active_turn = jsonb_build_object('id', $2::text, 'startedAt', NOW(), 'phase', 'mayor') WHERE id = $1`,
        [c.id, turnId]);
    }
    const abort = new AbortController();
    if (aborted) abort.abort();
    return {
      workId: crypto.randomUUID(), kind: WORK.run, key: `run:${turnId}`, resumeFrom: null, lostAttempts: lost, signal: abort.signal,
      input: { agentSessionId: c.id, userId: c.user.id, turnId, kind: 'agent', instanceKey: c.key, ...input },
    };
  };
  const streamTypes = async (c) => (await sessionBus.snapshot(agentTurn.busKey(c.id))).map((e) => e.event?.type ?? e.type);
  const reset = () => {
    for (const list of Object.values(seen)) list.length = 0;
    mayorRun = async () => {};
  };

  await t.test('H1 a run hands the Mayor what was asked, and its coding run\'s owner is this item', async () => {
    reset();
    const c = await conversation();
    const ctx = await ctxFor(c, 'h1', { input: { messageText: 'hi', attachments: [{ id: 'f' }], recorded: { id: 9, clientMessageId: null }, model: 'claude-x' } });
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'done' });
    const [r] = seen.runs;
    assert.deepEqual([r.agentSessionId, r.user.id, r.turnId, r.messageText, r.attachments, r.recorded, r.retry, r.followUp, r.res],
      [c.id, c.user.id, 'h1', 'hi', [{ id: 'f' }], { id: 9, clientMessageId: null }, false, null, null]);
    assert.deepEqual(r.owner, { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:h1', workId: ctx.workId },
      'a person\'s Stop and the next claim find the coding run by it');
    assert.deepEqual(seen.recovered, []);
    assert.deepEqual(seen.released, [ctx.workId], 'a record it still holds as it ends is released');
    await sessionBus.flush();
    const { rows: ends } = await pool.query(`SELECT event FROM stream_events WHERE stream_key = $1 AND seq = 'end-h1'`, [c.key]);
    assert.deepEqual(ends, [], 'its end is the machine\'s to write as it settles the item (T1), not a publish that may be lost');
  });

  await t.test('H2 a coding run still owned when the Mayor returned is carried to its end here', async () => {
    reset();
    const c = await conversation();
    const ctx = await ctxFor(c, 'h2');
    let change = null;
    mayorRun = async () => { change = await ownedChange(c, ctx.workId); };
    await turns.run(ctx, { config: {}, pool });
    assert.deepEqual(seen.recovered, [change]);
  });

  await t.test('H3 a turn that cannot start says so on its stream, which settles', async () => {
    reset();
    const c = await conversation();
    agentTurn.resolveAgentMayor = async () => ({ ok: false, error: 'Weekly limit reached.' });
    try {
      assert.deepEqual(await turns.run(await ctxFor(c, 'h3'), { config: {}, pool }), { ended: 'no_payer' });
    } finally { agentTurn.resolveAgentMayor = async () => ({ ok: true }); }
    assert.deepEqual(await streamTypes(c), ['error', 'done']);
    assert.deepEqual(seen.runs, []);
    const ctx = await ctxFor(await conversation(), 'h3b');
    ctx.input.userId = 2147483000;
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'no_user' }, 'the account that asked is gone');
  });

  await t.test('H4 resumed after its process went: its coding run carried on from its record', async () => {
    reset();
    const c = await conversation();
    const ctx = await ctxFor(c, 'h4', { lost: 1 });
    const change = await ownedChange(c, ctx.workId);
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'recovered' });
    assert.deepEqual(seen.recovered, [change]);
    assert.deepEqual(seen.runs, [], 'the Mayor is not asked again');
  });

  await t.test('H4b resumed: a local agent\'s turn it dispatched is taken over and finished here, the coding run\'s retries bounded', async () => {
    reset();
    const c = await conversation();
    const ctx = await ctxFor(c, 'h4b', { lost: 1 });
    const change = await ownedChange(c, ctx.workId);
    const { rows: [lease] } = await pool.query(
      `INSERT INTO session_agent_leases (session_id, user_id, label, expires_at) VALUES ($1, $2, 'laptop', NOW() + interval '2 minutes') RETURNING id`,
      [change, c.user.id]);
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [change]);
    const queued = await require('../src/services/local-agent').enqueueTurn(pool, {
      sessionId: change, userId: c.user.id, prompt: 'p', owner: { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:h4b', workId: ctx.workId },
    });
    assert.ok(queued && lease);
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'recovered' });
    assert.equal(seen.local.length, 1);
    assert.equal(String(seen.local[0].turn.id), String(queued.turn.id));
    assert.notEqual(seen.local[0].turn.waiter_id, queued.waiterId, 'waited for under the item\'s new claim');
    assert.equal(typeof seen.local[0].deps.finalizeRecoveredTurn, 'function');
    assert.deepEqual(seen.recovered, []);

    // A coding run whose recovery cannot read the worker yet: tried again.
    reset();
    const d = await conversation();
    const ctx2 = await ctxFor(d, 'h4c', { lost: 1 });
    await ownedChange(d, ctx2.workId);
    let fails = 2;
    recovery.recoverOwnedTurn = async (args) => {
      seen.recovered.push(args.sessionId);
      if (fails-- > 0) throw Object.assign(new Error('runtime unavailable'), { retryWorkerRecovery: true });
    };
    const was = { ...turns.RECOVERY_RETRY };
    Object.assign(turns.RECOVERY_RETRY, { ms: 1, tries: 3 });
    try {
      assert.deepEqual(await turns.run(ctx2, { config: {}, pool }), { ended: 'recovered' });
      assert.equal(seen.recovered.length, 3);
      fails = 5;
      const ctx3 = await ctxFor(d, 'h4e', { lost: 1 });
      await ownedChange(d, ctx3.workId);
      seen.recovered.length = 0;
      await assert.rejects(turns.run(ctx3, { config: {}, pool }), /runtime unavailable/);
      assert.equal(seen.recovered.length, 3, 'given up after its tries');
    } finally {
      Object.assign(turns.RECOVERY_RETRY, was);
      recovery.recoverOwnedTurn = async (args) => { seen.recovered.push(args.sessionId); };
    }
  });

  await t.test('H5 resumed: an answer already written is over; one cut before it ends as interrupted, once', async () => {
    reset();
    const c = await conversation();
    await agentSessions.acquireTurnLease(pool, { agentSessionId: c.id, userId: c.user.id, turnId: 'h5' });
    await pool.query(
      `INSERT INTO chat_session_messages (agent_session_id, role, content, metadata) VALUES ($1, 'assistant', 'Done.', $2::jsonb)`,
      [c.id, JSON.stringify({ agentTurnId: 'h5' })]);
    assert.deepEqual(await turns.run(await ctxFor(c, 'h5', { lost: 1 }), { config: {}, pool }), { ended: 'done' });
    assert.deepEqual(await notes(c), []);
    assert.deepEqual(await streamTypes(c), ['done']);

    const d = await conversation();
    await agentSessions.acquireTurnLease(pool, { agentSessionId: d.id, userId: d.user.id, turnId: 'h5b' });
    await pool.query(
      `INSERT INTO chat_session_messages (agent_session_id, role, content, metadata) VALUES ($1, 'assistant', 'On it.', $2::jsonb)`,
      [d.id, JSON.stringify({ agentTurnId: 'h5b', dispatch: { tool: 'start_build' } })]);
    assert.deepEqual(await turns.run(await ctxFor(d, 'h5b', { lost: 1 }), { config: {}, pool }), { ended: 'interrupted' },
      'a dispatch whose coding run never started is not an answer');
    assert.deepEqual((await notes(d)).map((n) => [n.content, n.metadata.retryable]), [[INTERRUPTED_TEXT, true]]);
    assert.equal((await claim(d)).active_turn, null);
    assert.deepEqual(await streamTypes(d), ['done']);
  });

  await t.test('H6 a process that lost the item leaves its record to the next claim', async () => {
    reset();
    const c = await conversation();
    await turns.run(await ctxFor(c, 'h6', { aborted: true }), { config: {}, pool });
    assert.deepEqual(seen.released, [], 'released only by the attempt that ends the item');
  });

  await t.test('H8 a running turn\'s claim is written once, with its Asked: nothing renews it while its item runs', async () => {
    // A claim lasts exactly as long as its turn (agent-sessions.js), so no
    // process reads it as abandoned however old it is; only a release from
    // before the turn machine did, and none runs beside this one.
    reset();
    const c = await conversation();
    await pool.query(
      `UPDATE agent_sessions SET active_turn = jsonb_build_object('id', 'h8', 'startedAt', NOW() - interval '5 minutes') WHERE id = $1`, [c.id]);
    const claimOf = async () => (await pool.query('SELECT active_turn FROM agent_sessions WHERE id = $1', [c.id])).rows[0].active_turn;
    const during = [];
    mayorRun = async () => {
      during.push(await claimOf());
      await new Promise((r) => setTimeout(r, 100));
      during.push(await claimOf());
    };
    await turns.run(await ctxFor(c, 'h8', { claim: false }), { config: {}, pool });
    assert.equal(during.length, 2, 'the turn ran');
    assert.deepEqual(during.map((a) => a.renewedAt), [undefined, undefined], 'never renewed');
    assert.equal(turns.CLAIM_RENEW, undefined);
    await pool.query('UPDATE agent_sessions SET active_turn = NULL WHERE id = $1', [c.id]);
  });

  await t.test('H9 a turn whose claim was ended while it waited runs nothing, and its stream settles', async () => {
    reset();
    const c = await conversation();
    const ctx = await ctxFor(c, 'h9', { claim: false });
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'claim_gone' }, 'no claim');
    await pool.query(`UPDATE agent_sessions SET active_turn = jsonb_build_object('id', 'theirs', 'startedAt', NOW()) WHERE id = $1`, [c.id]);
    assert.deepEqual(await turns.run(await ctxFor(c, 'h9b', { claim: false }), { config: {}, pool }), { ended: 'claim_gone' }, 'another turn\'s claim');
    assert.deepEqual(seen.runs, [], 'the Mayor never ran');
    assert.equal((await streamTypes(c)).at(-1), 'done');
    assert.equal((await pool.query('SELECT active_turn->>\'id\' AS id FROM agent_sessions WHERE id = $1', [c.id])).rows[0].id, 'theirs', 'nor touched the claim');
    await pool.query('UPDATE agent_sessions SET active_turn = NULL WHERE id = $1', [c.id]);
  });

  await t.test('H10 a turn whose item loses its lease while it runs on ends its process, unless the item was settled or the process is stopping', async () => {
    const { LeaseLost } = require('../src/workflow/kernel/services.ts');
    const exits = [];
    const was = turns.LOST_LEASE.exit;
    turns.LOST_LEASE.exit = (code) => { exits.push(code); };
    const withItem = async (status) => {
      const c = await conversation();
      const ctx = await ctxFor(c, `h10-${status}`);
      const abort = new AbortController();
      const db = await pool.connect();
      try {
        await db.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await db.query(
          `INSERT INTO wf_work (id, machine, key, kind, work_key, input, status, claim_id, lease_until)
           VALUES ($1, 'turn', $2, 'turn.run', $3, '{}', $4, CASE WHEN $4 = 'running' THEN gen_random_uuid() END,
                   CASE WHEN $4 = 'running' THEN NOW() + interval '1 minute' END)`,
          [ctx.workId, c.key, ctx.key, status]);
        await db.query('COMMIT');
      } finally { db.release(); }
      return { ctx: { ...ctx, signal: abort.signal }, abort };
    };
    const runAborting = async ({ ctx, abort }, reason) => {
      reset();
      mayorRun = async () => { abort.abort(reason); await new Promise((r) => setTimeout(r, 150)); };
      await turns.run(ctx, { config: {}, pool });
    };
    try {
      await runAborting(await withItem('running'), new LeaseLost());
      assert.deepEqual(exits, [1], 'its lease lost, its item still outstanding: the process ends');
      exits.length = 0;
      await runAborting(await withItem('settled'), new LeaseLost());
      assert.deepEqual(exits, [], 'a cancelled item runs nowhere again');
      await runAborting(await withItem('running'), new LeaseLost({ stopping: true }));
      assert.deepEqual(exits, [], 'a process stopping ends by itself');
    } finally {
      turns.LOST_LEASE.exit = was;
    }
  });

  await t.test('H11 a record its item still holds as it ends is released only once its worker is known not to run it', async () => {
    const worker = require('../src/services/worker');
    const was = { isWorkerExecuting: worker.isWorkerExecuting, clearActiveTurn: worker.clearActiveTurn };
    const cleared = [];
    worker.clearActiveTurn = async (id) => { cleared.push(id); await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [id]); return true; };
    try {
      for (const executing of [true, null]) {
        const c = await conversation();
        const workId = crypto.randomUUID();
        const change = await ownedChange(c, workId);
        worker.isWorkerExecuting = async () => executing;
        assert.equal(await saved.releaseLeftRecord({ pool, workId }), null, `kept while its worker reads ${executing}`);
        assert.ok((await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [change])).rows[0].active_turn,
          'the pointer its recovery follows');
        worker.isWorkerExecuting = async () => { throw new Error('the cluster did not answer'); };
        assert.equal(await saved.releaseLeftRecord({ pool, workId }), null, 'nor when the probe itself fails');
        await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [change]);
      }
      assert.deepEqual(cleared, []);
      const c = await conversation();
      const workId = crypto.randomUUID();
      const change = await ownedChange(c, workId);
      worker.isWorkerExecuting = async () => false;
      assert.equal(await saved.releaseLeftRecord({ pool, workId }), change, 'released once nothing runs it');
      assert.deepEqual(cleared, [change]);
    } finally {
      Object.assign(worker, was);
    }
  });

  await t.test('H7 the item runs the real handler through the workflow', async () => {
    reset();
    const c = await conversation();
    const { turnServices } = require('../src/workflow/turn/services.ts');
    const rt2 = createRuntime({
      pool, machines: [turnMachine()], pollMs: 50, publish: async () => {},
      services: { ...turnServices({ config: {}, pool }), [TURN_STOP]: fake(TURN_STOP) },
    });
    runtimes.push(rt2);
    mayorRun = async (args) => {
      await pool.query(
        `INSERT INTO chat_session_messages (agent_session_id, role, content, metadata) VALUES ($1, 'assistant', 'Hello.', $2::jsonb)`,
        [args.agentSessionId, JSON.stringify({ agentTurnId: args.turnId })]);
    };
    await ask(c, 'h7', { messageText: 'hello' });
    for (let i = 0; i < 30; i++) {
      await rt2.drain();
      if (!(await rt2.runServices())) { await rt2.drain(); break; }
    }
    assert.deepEqual(seen.runs.map((r) => [r.turnId, r.messageText]), [['h7', 'hello']]);
    assert.equal((await claim(c)).active_turn, null);
    assert.equal((await instance(c)).state, 'idle');
  });

  // ── 3. A change's own dev chat turn (the classic kind) ──────────────
  const mayorTurn = require('../src/services/mayor/turn');
  const sessionsRoutes = require('../src/routes/sessions');
  const limits = require('../src/services/limits');
  const savedClassic = {
    runMayorTurn: mayorTurn.runMayorTurn, requestSessionStop: sessionsRoutes.requestSessionStop,
    notifySessionStalled: sessionsRoutes.notifySessionStalled, resolveBillingPath: limits.resolveBillingPath,
  };
  t.after(() => {
    mayorTurn.runMayorTurn = savedClassic.runMayorTurn;
    sessionsRoutes.requestSessionStop = savedClassic.requestSessionStop;
    sessionsRoutes.notifySessionStalled = savedClassic.notifySessionStalled;
    limits.resolveBillingPath = savedClassic.resolveBillingPath;
  });
  const classic = { turns: [], stops: [], stalled: [] };
  let classicRun = async () => {};
  mayorTurn.runMayorTurn = async (args, deps) => { classic.turns.push({ args, deps }); await classicRun(args); };
  sessionsRoutes.requestSessionStop = async (args) => { classic.stops.push(args); return { status: 202, body: {} }; };
  sessionsRoutes.notifySessionStalled = async (_pool, id) => { classic.stalled.push(id); };
  limits.resolveBillingPath = async () => ({ apiKey: 'their-own-key' });
  async function change() {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`tc_${++seq}`]);
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ($1::text, $1::text, $2, 'https://github.com/acme/x') RETURNING id`,
      [`tc-app-${++seq}`, u.id]);
    const { rows: [cs] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, source) VALUES ($1, $2, 'active', 'dev/x', 'cli_handoff') RETURNING id`,
      [a.id, u.id]);
    return { id: cs.id, user: u, key: `session:${cs.id}` };
  }
  const classicCtx = (c, turnId, { lost = 0, input = {} } = {}) => ({
    workId: crypto.randomUUID(), kind: WORK.run, key: `run:${turnId}`, resumeFrom: null, lostAttempts: lost,
    signal: new AbortController().signal,
    input: { sessionId: c.id, userId: c.user.id, messageText: 'Add a toggle', selectedModel: 'claude-x', isOpenRouterSession: false,
      turnAttachments: [{ id: 'f1' }], userMessageId: 77, clientMessageId: 'c-1', turnId, kind: 'classic', instanceKey: c.key, ...input },
  });

  await t.test('C1 a dev chat turn runs the Mayor with what was asked, its payer read as it runs, its owner this item', async () => {
    classic.turns.length = 0;
    const c = await change();
    const ctx = classicCtx(c, 'c1');
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'done' });
    const [{ args, deps }] = classic.turns;
    assert.equal(args.session.id, c.id);
    assert.deepEqual([args.req.user.id, args.messageText, args.selectedModel, args.turnAttachments, args.userMessageId, args.clientMessageId],
      [c.user.id, 'Add a toggle', 'claude-x', [{ id: 'f1' }], 77, 'c-1']);
    assert.equal(args.userApiKey, 'their-own-key', 'the key is read when the turn runs, never carried in what it was asked');
    assert.deepEqual(args.owner, { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:c1', workId: ctx.workId });
    assert.equal(args.res, turns.NO_RESPONSE, 'its events reach the request through its stream');
    assert.equal(await args.scheduleInteractiveRecovery(c.id), true, 'a retained record is the item\'s own to carry on');
    assert.equal(deps, sessionsRoutes.MAYOR_TURN_DEPS);

    // A change that can no longer take a message here: said on its stream.
    classic.turns.length = 0;
    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [c.id]);
    assert.deepEqual(await turns.run(classicCtx(c, 'c1b'), { config: {}, pool }), { ended: 'gone' });
    assert.deepEqual(classic.turns, []);
    assert.deepEqual((await sessionBus.snapshot(c.id)).map((e) => (e.event || e).type).slice(-2), ['error', 'done']);
  });

  await t.test('C2 a person\'s Stop reaches the running turn from its instance, wherever it runs, once', async () => {
    classic.turns.length = 0; classic.stops.length = 0;
    const c = await change();
    const was = turns.STOP_POLL.ms;
    turns.STOP_POLL.ms = 20;
    let release;
    const gate = new Promise((r) => { release = r; });
    classicRun = () => gate;
    work.answer = () => new Promise(() => {});
    try {
      await send(c, 'Asked', { turnId: 'c2', kind: 'classic', input: {} });
      await rt.drain();
      const running = turns.run(classicCtx(c, 'c2'), { config: {}, pool });
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(classic.stops, [], 'nothing until a person stops it');
      // The Stop route, from any process: the turn's instance is where it lands.
      const { rows: [owner] } = await pool.query(require('../src/workflow/session-work.ts').TURN_OWNER_SQL, [c.id]);
      assert.deepEqual({ ...owner }, { machine: 'turn', key: c.key }, 'a Mayor turn with no record yet is found by its instance');
      await send(c, 'StopRequested', { by: 'ada' });
      await rt.drain();
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(classic.stops.length, 1, 'applied once');
      assert.deepEqual([classic.stops[0].sessionId, classic.stops[0].forwarded, classic.stops[0].user.username, classic.stops[0].user.id],
        [c.id, true, 'ada', c.user.id], 'through the turn\'s own handle, past the routing it already went through');
      release();
      await running;
    } finally {
      turns.STOP_POLL.ms = was; classicRun = async () => {}; work.answer = null; release();
    }
  });

  await t.test('C4 a dev chat turn is work on its change for every process; the turn itself reads past its own instance', async () => {
    // No process mirrors what it runs (services/processes.js holds are its
    // own drain's): another process reads the turn's instance
    // (session-work.ts workedOnSql), and the Mayor turn's own busy gates
    // read everything but it (exceptTurn), or it would refuse itself.
    const { isSessionBusyAnywhere, busySessionsAnywhere } = require('../src/services/active-workers');
    const c = await change();
    const idle = await change();
    assert.equal(await isSessionBusyAnywhere(c.id, { pool }), false, 'nothing works on it yet');
    await send(c, 'Asked', { turnId: 'c4', kind: 'classic', input: {} });
    await rt.drain();
    assert.equal((await instance(c)).state, 'running');
    assert.equal(await isSessionBusyAnywhere(c.id, { pool }), true, 'its running turn is work on it');
    assert.deepEqual([...await busySessionsAnywhere([c.id, idle.id], { pool })], [c.id], 'read for many at once, only the one worked on');
    assert.equal(await isSessionBusyAnywhere(c.id, { pool, exceptTurn: true }), false, 'the turn does not count itself');
    await settle();
    assert.equal(await isSessionBusyAnywhere(c.id, { pool }), false, 'and once it ended, nothing works on it');
  });

  await t.test('C2b a Stop that lands before the turn\'s handle exists is applied once it does', async () => {
    classic.turns.length = 0; classic.stops.length = 0;
    const c = await change();
    const was = { ms: turns.STOP_POLL.ms, stop: sessionsRoutes.requestSessionStop };
    turns.STOP_POLL.ms = 20;
    let handle = false;
    sessionsRoutes.requestSessionStop = async (args) => {
      classic.stops.push(args);
      return handle ? { status: 202, body: { ok: true, stopped: true } } : { status: 200, body: { ok: true, stopped: false, reason: 'no active turn' } };
    };
    let release;
    const gate = new Promise((r) => { release = r; });
    classicRun = () => gate;
    work.answer = () => new Promise(() => {});
    try {
      await send(c, 'Asked', { turnId: 'c2b', kind: 'classic', input: {} });
      await rt.drain();
      const running = turns.run(classicCtx(c, 'c2b'), { config: {}, pool });
      await send(c, 'StopRequested', { by: 'ada' });
      await rt.drain();
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(classic.stops.length >= 2, 'asked again while there is no handle');
      handle = true;
      await new Promise((r) => setTimeout(r, 100));
      const applied = classic.stops.length;
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(classic.stops.length, applied, 'and not again once it landed');
      release();
      await running;
    } finally {
      turns.STOP_POLL.ms = was.ms; sessionsRoutes.requestSessionStop = was.stop;
      classicRun = async () => {}; work.answer = null; release();
    }
  });

  await t.test('C3 resumed: what it dispatched is carried on; a turn cut before its reply gets the dev chat\'s note, once', async () => {
    reset(); classic.turns.length = 0; classic.stalled.length = 0;
    const c = await change();
    const ctx = classicCtx(c, 'c3', { lost: 1 });
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [c.id, JSON.stringify({
      turnId: 'job', mode: 'build', owner: { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:c3', workId: ctx.workId } })]);
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'recovered' });
    assert.deepEqual(seen.recovered, [c.id]);
    assert.deepEqual(classic.turns, [], 'the Mayor is not asked again');

    const d = await change();
    await pool.query(`INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'user', 'Add a toggle', '{}')`, [d.id]);
    assert.deepEqual(await turns.run(classicCtx(d, 'c3b', { lost: 1 }), { config: {}, pool }), { ended: 'interrupted' });
    assert.deepEqual(await turns.run(classicCtx(d, 'c3b', { lost: 2 }), { config: {}, pool }), { ended: 'interrupted' });
    const { rows: crumbs } = await pool.query(
      `SELECT content, metadata FROM chat_session_messages WHERE session_id = $1 AND role = 'system'`, [d.id]);
    assert.equal(crumbs.length, 1, 'once');
    assert.equal(crumbs[0].metadata.recoveredReason, 'unanswered');
    assert.ok(Array.isArray(crumbs[0].metadata.quickReplies), 'with its pills');
    assert.deepEqual(classic.stalled, [d.id], 'and the bell says it stopped before finishing');
    assert.equal((await sessionBus.snapshot(d.id)).map((e) => (e.event || e).type).pop(), 'done');
  });

  await t.test('C4 the repair a failed dev chat turn owes: the "didn\'t answer" note, once, never while another turn runs on the change', async () => {
    classic.stalled.length = 0;
    const d = await change();
    await pool.query(`INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'user', 'Add a toggle', '{}')`, [d.id]);
    const crumbs = async () => (await pool.query(
      `SELECT metadata FROM chat_session_messages WHERE session_id = $1 AND role = 'system'`, [d.id])).rows;
    // Another turn runs on it: that one answers.
    const db = await pool.connect();
    try {
      await db.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await db.query(`INSERT INTO wf_instances (machine, key, state, data, machine_version) VALUES ('turn', $1, 'running', '{}', 2)`, [d.key]);
      await db.query('COMMIT');
    } finally { db.release(); }
    assert.deepEqual(await turns.repairCut({ pool }, { sessionId: d.id }), { skipped: 'running' });
    assert.deepEqual(await crumbs(), []);
    const idle = await pool.connect();
    try {
      await idle.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await idle.query(`UPDATE wf_instances SET state = 'idle' WHERE machine = 'turn' AND key = $1`, [d.key]);
      await idle.query('COMMIT');
    } finally { idle.release(); }
    assert.deepEqual(await turns.repairCut({ pool }, { sessionId: d.id }), { repaired: 'breadcrumb' });
    await turns.repairCut({ pool }, { sessionId: d.id });
    assert.deepEqual((await crumbs()).map((c) => c.metadata.recoveredReason), ['unanswered'], 'once');
    assert.deepEqual(classic.stalled, [d.id], 'and the bell says it stopped before finishing');
  });

  // ── 4. A headless run (an auto session on a request) ────────────────
  const github = require('../src/services/github');
  const savedHeadless = {
    runHeadlessSessionInner: sessionsRoutes.runHeadlessSessionInner, resumeOneHeadlessRun: sessionsRoutes.resumeOneHeadlessRun,
    failHeadlessRun: sessionsRoutes.failHeadlessRun, fetchPublicIssue: github.fetchPublicIssue,
    fetchIssueComments: github.fetchIssueComments, getBotUsername: github.getBotUsername,
  };
  t.after(() => { Object.assign(sessionsRoutes, {
    runHeadlessSessionInner: savedHeadless.runHeadlessSessionInner, resumeOneHeadlessRun: savedHeadless.resumeOneHeadlessRun,
    failHeadlessRun: savedHeadless.failHeadlessRun });
  Object.assign(github, { fetchPublicIssue: savedHeadless.fetchPublicIssue, fetchIssueComments: savedHeadless.fetchIssueComments,
    getBotUsername: savedHeadless.getBotUsername }); });
  const headless = { runs: [], resumes: [], failed: [] };
  let headlessRun = async () => {};
  let headlessResume = async () => {};
  sessionsRoutes.runHeadlessSessionInner = async (args) => { headless.runs.push(args); await headlessRun(args); };
  sessionsRoutes.resumeOneHeadlessRun = async (args) => { headless.resumes.push(args); await headlessResume(args); };
  sessionsRoutes.failHeadlessRun = async (_pool, session, message) => { headless.failed.push([session.id, message]); };
  github.fetchPublicIssue = async (_o, _r, n) => ({ issue: { number: n, title: 'Make it better' } });
  github.fetchIssueComments = async () => ({ comments: [{ body: 'yes please' }] });
  github.getBotUsername = async () => 'usernode-bot';
  const resetHeadless = () => { for (const l of Object.values(headless)) l.length = 0; headlessRun = async () => {}; headlessResume = async () => {}; };
  async function autoRun({ status = 'generating' } = {}) {
    const c = await change();
    await pool.query(
      `UPDATE chat_sessions SET is_headless = TRUE, headless_status = $2, headless_step = 'planning', headless_issue_number = 5 WHERE id = $1`,
      [c.id, status]);
    return c;
  }
  const headlessCtx = (c, turnId, { lost = 0 } = {}) => ({
    workId: crypto.randomUUID(), kind: WORK.run, key: `run:${turnId}`, resumeFrom: null, lostAttempts: lost,
    signal: new AbortController().signal,
    input: { sessionId: c.id, userId: c.user.id, selectedModel: 'claude-x', turnId, kind: 'headless', instanceKey: c.key },
  });

  await t.test('A1 a headless run reads its request and payer as it runs, its coding runs owned by its item', async () => {
    resetHeadless();
    const c = await autoRun();
    // Its input's old `resume` flag (what a pass asked of a run an older
    // release left) starts nothing as a resumed run: only a lost attempt does.
    const ctx = { ...headlessCtx(c, 'a1'), input: { ...headlessCtx(c, 'a1').input, resume: true } };
    // No process hold: the running item is what a drain waits for.
    const processes = require('../src/services/processes');
    let heldWhileRunning = null;
    headlessRun = async () => { heldWhileRunning = processes.heldHere('session', c.id); };
    assert.deepEqual(await turns.run(ctx, { config: { dataEncryptionKey: 'k' }, pool }), { ended: 'done' });
    assert.equal(heldWhileRunning, false);
    assert.equal(headless.resumes.length, 0, 'run, not resumed');
    const [r] = headless.runs;
    assert.equal(r.session.id, c.id);
    assert.deepEqual([r.user.id, r.user.username, r.selectedModel, r.repoOwner, r.repoName, r.issueNumber],
      [c.user.id, c.user.username, 'claude-x', 'acme', 'x', 5]);
    assert.deepEqual([r.issue.title, r.comments, r.botUsername], ['Make it better', [{ body: 'yes please' }], 'usernode-bot'],
      'read here, never carried in what the turn was asked');
    assert.equal(r.userApiKey, 'their-own-key');
    assert.deepEqual(r.owner, { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:a1', workId: ctx.workId });
    assert.deepEqual(headless.resumes, []);

    resetHeadless();
    const done = await autoRun({ status: 'ready' });
    assert.deepEqual(await turns.run(headlessCtx(done, 'a1b'), { config: {}, pool }), { ended: 'gone' }, 'over before it ran');
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"t","phase":"cleanup_pending"}'::jsonb WHERE id = $1`, [done.id]);
    assert.deepEqual(await turns.run(headlessCtx(done, 'a1c'), { config: {}, pool }), { ended: 'gone' },
      'a finished run whose record still awaits its cleanup is not run again');
    assert.deepEqual(headless.runs, []);
  });

  await t.test('A2 a run whose durable state is retained is carried on from its row by its own item, then failed if it never settles', async () => {
    resetHeadless();
    const c = await autoRun();
    const was = { ...turns.RECOVERY_RETRY };
    Object.assign(turns.RECOVERY_RETRY, { ms: 1, tries: 3 });
    try {
      headlessRun = async (args) => { args.onRetained(new Error('worker unreachable')); };
      let retainedTimes = 1;
      headlessResume = async (args) => { if (retainedTimes-- > 0) args.onRetained(new Error('still')); };
      const ctx = headlessCtx(c, 'a2');
      assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'done' });
      assert.equal(headless.resumes.length, 2, 'carried on until it settles');
      assert.deepEqual(headless.resumes[0].owner, { machine: MACHINE, key: c.key, kind: WORK.run, workKey: 'run:a2', workId: ctx.workId });
      assert.deepEqual(headless.failed, []);

      resetHeadless();
      headlessRun = async (args) => { args.onRetained(new Error('worker unreachable')); };
      headlessResume = async (args) => { args.onRetained(new Error('never')); };
      await turns.run(headlessCtx(c, 'a2b'), { config: {}, pool });
      assert.equal(headless.resumes.length, 3, 'its tries, no more');
      assert.equal(headless.failed.length, 1);
      assert.equal(headless.failed[0][0], c.id);

      resetHeadless();
      headlessResume = async () => { throw Object.assign(new Error('worker state unreadable'), { retainActiveTurn: true, retryWorkerRecovery: true }); };
      await turns.run(headlessCtx(c, 'a2c', { lost: 1 }), { config: {}, pool });
      assert.equal(headless.resumes.length, 3, 'a retained error is tried again too');
      assert.equal(headless.failed.length, 1);
      resetHeadless();
      headlessResume = async () => { throw new Error('a bug'); };
      await turns.run(headlessCtx(c, 'a2d', { lost: 1 }), { config: {}, pool });
      assert.deepEqual([headless.resumes.length, headless.failed.length], [1, 1], 'anything else fails the run at once');

      // Stopped while it waits between tries: nothing reported (a normal
      // return would settle the item as done, its run still 'generating').
      resetHeadless();
      turns.RECOVERY_RETRY.ms = 500;
      headlessRun = async (args) => { args.onRetained(new Error('worker unreachable')); };
      headlessResume = async (args) => { args.onRetained(new Error('still')); };
      const abort = new AbortController();
      const stopped = turns.run({ ...headlessCtx(c, 'a2e'), signal: abort.signal }, { config: {}, pool });
      const { LeaseLost } = require('../src/workflow/kernel/services.ts');
      setTimeout(() => abort.abort(new LeaseLost({ stopping: true })), 50);
      await assert.rejects(stopped, /work stopped with its process/);
      assert.equal(headless.failed.length, 0, 'nor failed: the next claim carries it on');
    } finally {
      Object.assign(turns.RECOVERY_RETRY, was);
    }
  });

  await t.test('A3 resumed after its process went: carried on from its row; a run already over is left', async () => {
    resetHeadless();
    const c = await autoRun();
    const ctx = headlessCtx(c, 'a3', { lost: 1 });
    assert.deepEqual(await turns.run(ctx, { config: {}, pool }), { ended: 'recovered' });
    assert.deepEqual(headless.runs, [], 'not started again');
    assert.equal(headless.resumes.length, 1);
    assert.equal(headless.resumes[0].session.id, c.id);
    resetHeadless();
    await pool.query(`UPDATE chat_sessions SET headless_status = 'ready' WHERE id = $1`, [c.id]);
    await turns.run(headlessCtx(c, 'a3b', { lost: 1 }), { config: {}, pool });
    assert.deepEqual(headless.resumes, []);
  });

  await t.test('A4 a headless run between its steps is no Stop\'s target: only a dev chat turn hears one from its instance', async () => {
    const c = await autoRun();
    work.answer = () => new Promise(() => {});
    try {
      await send(c, 'Asked', { turnId: 'a4', kind: 'headless', input: {} });
      await rt.drain();
      assert.equal((await instance(c)).state, 'running');
      const { rows } = await pool.query(require('../src/workflow/session-work.ts').TURN_OWNER_SQL, [c.id]);
      assert.deepEqual(rows, [], 'its Stop takes the person\'s own path, as before the turn machine');
    } finally {
      work.answer = null;
      await pool.query(`UPDATE chat_sessions SET headless_status = 'failed' WHERE id = $1`, [c.id]);
    }
  });

  // ── 5. A coding record no work item holds (turn-leftovers.js) ──────
  const leftovers = require('../src/services/turn-leftovers');
  const leftoverPass = () => leftovers.sweep(pool);
  const askedOn = async (key) => (await pool.query(
    `SELECT payload FROM wf_events WHERE machine = 'turn' AND key = $1 AND type = 'Asked' ORDER BY id`, [key])).rows.map((r) => r.payload);

  await t.test('L2 a coding record no work item holds: a recover turn asked once, never while its item holds it, whatever other release serves', async () => {
    const quiet = (turnId, extra = {}) => JSON.stringify({ turnId, mode: 'build', startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), ...extra });
    const c = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [c.id, quiet('old-job')]);
    const fresh = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [fresh.id,
      JSON.stringify({ turnId: 'fresh-job', mode: 'build', startedAt: new Date().toISOString() })]);
    // An item that settled without releasing its record (its release failed).
    const { rows: [doneItem] } = await pool.query(`SELECT id FROM wf_work WHERE kind = $1 AND status = 'settled' LIMIT 1`, [WORK.run]);
    const settledOwner = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [settledOwner.id,
      quiet('settled-job', { owner: { machine: MACHINE, key: settledOwner.key, kind: WORK.run, workKey: 'run:s', workId: doneItem.id } })]);
    // A process of another release, serving: no leader of an older release
    // recovers anything any more, so the pass does not wait for it.
    await pool.query(`INSERT INTO platform_processes (id, release, state) VALUES ('old-pod', 'old', 'serving')`);
    // Being stopped (its time ran out): its stop work releases the record.
    const stopping = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [stopping.id, quiet('stopping-job')]);
    await asTransition(pool, `INSERT INTO wf_work (machine, key, kind, work_key, input, status) VALUES ('turn', $1, 'turn.stop', $2, '{}', 'queued')`,
      [stopping.key, `stop:${stopping.id}:timeout-x`]);
    const { rows: [liveItem] } = await pool.query(`SELECT id FROM wf_work WHERE kind = $1 AND status IN ('queued', 'running') LIMIT 1`, [WORK.run]);
    const owned = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [owned.id,
      quiet('owned-job', { owner: { machine: MACHINE, key: owned.key, kind: WORK.run, workKey: 'run:o', workId: liveItem.id } })]);
    const before = (await leftoverPass()).records;
    assert.ok(before >= 1);
    assert.deepEqual((await askedOn(c.key)).map((p) => [p.kind, p.turnId, p.input.sessionId]), [['recover', 'leftover-old-job', c.id]]);
    assert.deepEqual(await askedOn(owned.key), [], 'a record its outstanding item owns is that item\'s');
    assert.deepEqual(await askedOn(stopping.key), [], 'nor one whose stop is under way');
    assert.deepEqual(await askedOn(fresh.key), [], 'one that just moved may still be its process\'s');
    assert.deepEqual((await askedOn(settledOwner.key)).map((p) => p.kind), ['recover'], 'one its settled item left is nobody\'s');
    await leftoverPass();
    assert.equal((await askedOn(c.key)).length, 1, 'asked once');
    await pool.query(`DELETE FROM platform_processes WHERE id = 'old-pod'`);
    await asTransition(pool, `UPDATE wf_work SET status = 'settled', settled_at = NOW() WHERE work_key = $1`, [`stop:${stopping.id}:timeout-x`]);
    for (const x of [c, owned, fresh, settledOwner, stopping]) await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [x.id]);
    // A recover turn runs the leader's adoption, as an unowned one.
    reset();
    const was = recovery.recoverOwnedTurn;
    const args = [];
    recovery.recoverOwnedTurn = async (a) => { args.push(a); };
    try {
      assert.deepEqual(await turns.run({ ...classicCtx(c, 'leftover-old-job'), input: { sessionId: c.id, kind: 'recover', turnId: 'x', instanceKey: c.key } },
        { config: {}, pool }), { ended: 'recovered' });
    } finally { recovery.recoverOwnedTurn = was; }
    assert.deepEqual(args.map((a) => [a.sessionId, a.owned]), [[c.id, false]]);
  });

  await t.test('L6 a record a recover turn left is asked for again after a while, a bounded number of times, and the last ask ends it', async () => {
    const quiet = (turnId) => JSON.stringify({ turnId, mode: 'build', startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    const c = await change();
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [c.id, quiet('stuck-job')]);
    const backdate = async () => {
      const db = await pool.connect();
      try {
        await db.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await db.query(
          `UPDATE wf_events SET created_at = created_at - make_interval(mins => $2) WHERE machine = 'turn' AND key = $1 AND type = 'Asked'`,
          [c.key, leftovers.RECORD_RETRY.minutes + 1]);
        await db.query('COMMIT');
      } finally { db.release(); }
    };
    await leftoverPass();
    await leftoverPass();
    assert.equal((await askedOn(c.key)).length, 1, 'not again at once');
    for (let i = 1; i < leftovers.RECORD_RETRY.asks + 2; i += 1) { await backdate(); await leftoverPass(); }
    const asked = await askedOn(c.key);
    assert.equal(asked.length, leftovers.RECORD_RETRY.asks, 'a bounded number of times');
    assert.deepEqual(asked.map((p) => [p.turnId, p.input.last]), [
      ['leftover-stuck-job', false], ['leftover-stuck-job-2', false], ['leftover-stuck-job-3', false], ['leftover-stuck-job-4', true]]);
    // The last ask: recovery leaves the record, so it is ended; a record
    // that moved on (another turn's) is not.
    const wasRecover = recovery.recoverOwnedTurn;
    const forceStop = require('../src/services/worker-force-stop');
    const wasForce = forceStop.run;
    const forced = [];
    recovery.recoverOwnedTurn = async () => {};
    forceStop.run = async (_pool, target) => {
      assert.equal(target.userId, null, 'system recovery runs on the conductor');
      assert.equal(target.turnId, 'stuck-job');
      forced.push([target.sessionId, 'homeroom']);
    };
    const lastCtx = (identity) => ({ ...classicCtx(c, 'leftover-x'), input: { sessionId: c.id, kind: 'recover', turnId: 'x', instanceKey: c.key, identity, last: true } });
    try {
      assert.deepEqual(await turns.run(lastCtx('stuck-job'), { config: {}, pool }), { ended: 'ended' });
      assert.deepEqual(forced, [[c.id, 'homeroom']]);
      assert.deepEqual(await turns.run(lastCtx('some-other-job'), { config: {}, pool }), { ended: 'recovered' });
      assert.equal(forced.length, 1, 'only the record it was asked for');
      recovery.recoverOwnedTurn = async () => { throw new Error('the cluster did not answer'); };
      assert.deepEqual(await turns.run(lastCtx('stuck-job'), { config: {}, pool }), { ended: 'ended' }, 'a recovery that fails on the last ask ends it too');
      assert.deepEqual(await turns.run({ ...lastCtx('stuck-job'), input: { ...lastCtx('stuck-job').input, last: false } }, { config: {}, pool })
        .then(() => 'returned', (err) => err.message), 'the cluster did not answer', 'an earlier ask fails as its item, to be asked again');
    } finally {
      recovery.recoverOwnedTurn = wasRecover;
      forceStop.run = wasForce;
      await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [c.id]);
    }
  });
});
