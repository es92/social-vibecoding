'use strict';

// Before & after shots whose change's worker cannot start: the platform's
// fault, said in words, taken again once, and never charged to the agent.
//
// 18 Nov 2026: Saved Places change 13913's shots spent their whole budget in
// the worker's setup (its disk volume, on a node whose storage pool was
// full, never mounted). The trace stopped at worker_prepare_start with the
// agent never started, 607 s in, and the run was reported as "The shots
// agent ran out of time.", the agent's fault, so nothing took it again.
//
// The agent's turn without a database: its control plane and session row
// are stubbed; the same turn against PostgreSQL is
// tests/shots-run-steps-postgres.test.js. The machine's transitions are the
// real ones.
//
// Run with: node --test tests/shots-worker-start.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const orchestrator = require('../src/services/shots-orchestrator');
const shotsControl = require('../src/services/shots-control');
const { VOLUME_FAILURE_TEXT } = require('../src/services/kubernetes-worker-bootstrap');
const { shots, WORK } = require('../src/workflow/shots/machine.ts');

const MOUNT_TEXT = 'This change’s worker couldn’t start: its disk volume failed to mount.';

function volumeError() {
  const err = new Error(VOLUME_FAILURE_TEXT.mount);
  Object.defineProperty(err, 'bootstrapFailed', { value: true });
  Object.defineProperty(err, 'bootstrapReason', { value: 'volume_mount_failed' });
  Object.defineProperty(err, 'volumeFailure', { value: { kind: 'mount', node: 'talos-ap6-6cz', claim: 'sv-worker-s13913-state' } });
  return err;
}

// ── How the error reads ─────────────────────────────────────────────────

test('a worker that cannot start is the platform\'s fault, of every kind', () => {
  const fault = (error) => orchestrator.platformFault(error);
  const typed = (reason) => Object.defineProperty(new Error('worker could not start (x)'), 'bootstrapReason', { value: reason });
  assert.deepEqual(fault(volumeError()), { kind: 'worker_bootstrap' });
  for (const reason of ['volume_provision_failed', 'volume_format_failed', 'image_unavailable', 'unschedulable', 'config_error']) {
    assert.deepEqual(fault(typed(reason)), { kind: 'worker_bootstrap' }, reason);
  }
  assert.deepEqual(fault({ code: 'worker_start_timeout', message: 'The worker did not finish starting in time.' }), { kind: 'worker_bootstrap' });
  assert.deepEqual(fault(new Error('warm-ready timeout for sv-worker-s13913')), { kind: 'worker_bootstrap' });
  assert.equal(fault(new Error('checkout failed: branch dev/x is missing')), null, 'a branch git refused is not a worker that did not start');
});

test('it says the worker did not start, in words, never that the agent ran out of time', () => {
  assert.deepEqual(orchestrator.agentErrorOf(volumeError()), {
    code: 'shots_worker_failed',
    message: MOUNT_TEXT,
    workerStart: true,
    busy: false,
    died: false,
    timedOut: false,
    platformFault: { kind: 'worker_bootstrap' },
  });
  const slow = orchestrator.agentErrorOf(new Error('warm-ready timeout for sv-worker-s13913'));
  assert.equal(slow.message, 'This change’s worker didn’t finish starting in time.');
  assert.equal(slow.code, 'shots_worker_failed');
  // The agent's own failures keep their words.
  const agent = orchestrator.agentErrorOf({ code: 'shots_agent_failed', message: 'The shots agent stopped with an error before it finished.' });
  assert.equal(agent.code, 'shots_agent_failed');
  assert.equal(agent.workerStart, undefined);
});

// ── The agent's turn ────────────────────────────────────────────────────

const RUN = 'a'.repeat(32);
const SESSION = { id: 13913, app_id: 7, app_slug: 'saved-places', app_name: 'Saved Places', repo_url: 'https://github.com/o/r',
  branch_name: 'dev/13913', status: 'promoted', source: null };

function harness(t) {
  const extended = [];
  for (const [name, fn] of Object.entries({
    read: async () => ({ agent: { origins: { before: 'http://b.test', after: 'http://h.test' }, browserPersonas: [] },
      intent: { version: 1, stories: [] } }),
    extend: async (_pool, runId, at) => { extended.push(at); },
    noteProgress: async () => {},
    summaryFor: async () => ({
      summary: { stories: [], verdict: { passed: false, stories: [] }, readyCount: 0, failedCount: 0, manifestHash: null, files: [] },
      skippedAny: false, counts: {}, lastToolFailure: null,
    }),
  })) t.mock.method(shotsControl, name, fn);
  const pool = { query: async (sql) => {
    if (/FROM chat_sessions cs/.test(sql)) return { rows: [SESSION] };
    throw new Error(`unexpected query ${sql.slice(0, 40)}`);
  } };
  const dispatched = [];
  const deps = (prepareWorker) => ({
    identities: { shotsGuestIdentity: async () => ({}), mintShotsAuthTokens: async () => ({ member: 'm.jwt' }) },
    worker: { stopTurn: async () => {}, stopOwnedTurn: async () => {} },
    shotsAgent: {
      ...require('../src/services/shots-agent'),
      prepareWorker,
      dispatch: async (_config, options) => { dispatched.push(options); return { backend: 'claude_code', model: 'm', result: { exitCode: 0 } }; },
    },
  });
  const agent = (prepareWorker, { budgetMs = 20, ...extra } = {}) => orchestrator.dispatchAgent({}, pool,
    { runId: RUN, sessionId: SESSION.id, budgetMs }, { ...deps(prepareWorker), ...extra });
  return { agent, dispatched, extended };
}

const later = (ms, fn) => new Promise((resolve, reject) => {
  setTimeout(() => { try { resolve(fn()); } catch (err) { reject(err); } }, ms);
});

test('a worker that never starts ends the turn before the agent, said as the worker\'s fault', async (t) => {
  const h = harness(t);
  // The setup takes three times the agent's whole clock, then fails.
  const out = await h.agent(() => later(60, () => { throw volumeError(); }), { budgetMs: 20 });
  assert.equal(h.dispatched.length, 0, 'the agent never started');
  assert.equal(out.agent.outcome, 'failed');
  assert.equal(out.agent.code, 'shots_worker_failed');
  assert.equal(out.agent.message, MOUNT_TEXT);
  assert.deepEqual(out.agent.platformFault, { kind: 'worker_bootstrap' });
  assert.notEqual(out.agent.code, 'shots_agent_timeout', 'its clock had not started');
  assert.equal(h.extended.length, 1, 'the control plane is not extended for an agent that never runs');
  assert.ok(out.trace.agentDispatches[0].workerPrepareMs >= 50, 'how long the setup took is kept in the trace');
});

test('a worker that is slow to start leaves the agent its whole clock', async (t) => {
  const h = harness(t);
  const out = await h.agent(() => later(60, () => {}), { budgetMs: 20 });
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.dispatched[0].timeoutMs, 20, 'the agent is given all of its budget, after the setup');
  assert.deepEqual(out.agent, { outcome: 'completed' }, 'not stopped by a clock the setup used up');
  assert.equal(h.extended.length, 2, 'the control plane is extended again once the agent\'s clock starts');
});

test('a setup that never finishes is given its own limit and said as such', async (t) => {
  const h = harness(t);
  const out = await h.agent(() => new Promise(() => {}), { budgetMs: 20, workerPrepareMaxMs: 15 });
  assert.equal(h.dispatched.length, 0);
  assert.equal(out.agent.code, 'shots_worker_failed');
  assert.equal(out.agent.message, 'This change’s worker didn’t finish starting in time.');
  assert.deepEqual(out.agent.platformFault, { kind: 'worker_bootstrap' });
});

// ── What the machine does with it ───────────────────────────────────────

const SHA = (c) => c.repeat(40);
const machine = shots({ execute: true, agentBudgetMs: 480000, runBudgetMs: 1440000 });
const ctx = { now: new Date('2026-11-18T09:40:00Z'), key: 'session:13913' };
const takingShots = () => ({ name: 'taking_shots', data: {
  sessionId: 13913, appId: 7, appSlug: 'saved-places', declared: { intent: { version: 1 }, required: true },
  head: SHA('a'), n: 1, cleaning: [], last: null,
  run: { id: 'run-1', n: 1, head: SHA('a'), base: SHA('0'), trigger: 'preview-ready', startedAt: '2026-11-18T09:28:00Z',
    busy: 0, died: 0, dispatches: 1, copiesAt: '2026-11-18T09:30:00Z', agentStartedAt: '2026-11-18T09:30:00Z',
    agentWaitUntil: null, platformRetry: false, afterOnly: false },
} });
const facts = { session: { id: 13913, appId: 7, appSlug: 'saved-places', status: 'promoted', source: null, head: SHA('a'),
  pins: { imported: null, reviewed: SHA('a'), handoff: null }, readyHeads: [SHA('a')], agentBusy: false,
  slot: { state: null, runId: null, detail: null, run: null }, temporaryWorker: false } };

test('the run fails saying the worker did not start, and is taken again once', async (t) => {
  const h = harness(t);
  const out = await h.agent(async () => { throw volumeError(); });
  const done = { id: 9, type: 'WorkSucceeded', payload: { sessionId: 13913, kind: WORK.agent, workKey: 'agent:1:1', result: out },
    source: { kind: 'service', workId: 'w1' } };
  const next = machine.entryFor('taking_shots', 'WorkSucceeded').to(takingShots(), done, facts, ctx);
  assert.equal(next.next.name, 'failed');
  const moved = next.writes.find((w) => w.type === 'runMoved');
  assert.equal(moved.patch.failureCode, 'shots_worker_failed');
  assert.equal(moved.patch.failureReason, MOUNT_TEXT);
  assert.equal(next.timer.event.type, 'RetryDue', 'a worker that could not start is the platform\'s fault');
  assert.equal(next.next.data.last.fault, 'worker_bootstrap');
});
