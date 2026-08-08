// Surviving a platform restart with a machine attached (#907).
//
// Deploys happen mid-turn. The design answer is that the durable state of a
// local run lives entirely in Postgres — the lease row, the turn row and its
// progress — and the only in-process state is an EventEmitter used to wake a
// waiter early. So a restart must cost latency and an in-flight turn, never
// correctness: no phantom lease that blocks the session forever, no turn
// stuck in 'running' with nobody watching, and no client that has to be
// restarted by hand.
//
// Run with: node --test tests/local-agent-restart.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const localAgent = require('../src/services/local-agent');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const agentSource = fs.readFileSync(path.join(root, 'src/cli/agent-command.js'), 'utf8');
const localAgentSource = fs.readFileSync(path.join(root, 'src/services/local-agent.js'), 'utf8');
const sessionsSource = fs.readFileSync(path.join(root, 'src/routes/sessions.js'), 'utf8');

function makePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) {
        if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      return { rows: [] };
    },
  };
}

// ── Nothing that matters is held in memory ─────────────────────────────────

test('the service keeps no lease or turn state of its own across a restart', () => {
  // A module-level Map of leases would survive nothing and would disagree
  // with the database the moment a second web dyno existed.
  const declarations = localAgentSource
    .split('\n')
    .filter((line) => /^(const|let)\s+\w+\s*=\s*new (Map|Set|WeakMap)\(/.test(line));
  assert.deepEqual(declarations, [], 'no module-level caches');
  // The one piece of process state is the wakeup bus, and it is documented
  // as an optimization.
  assert.ok(localAgent._bus, 'the notification bus is the only in-process state');
  assert.match(localAgentSource, /EventEmitter/);
});

test('a waiter re-reads the row every pass, so a lost notification only costs time', async () => {
  // After a restart the bus is empty and the CLI's POSTs land on a process
  // that never registered a listener for this turn. awaitTurnResult must
  // still see the terminal row on its next poll.
  let reads = 0;
  const pool = makePool([[/FROM local_agent_turns WHERE id/, () => {
    reads += 1;
    return reads < 3
      ? [{ id: '11', session_id: 42, status: 'running', updated_at: `t${reads}` }]
      : [{ id: '11', session_id: 42, status: 'completed', head_sha: 'a'.repeat(40) }];
  }]]);
  const { outcome } = await localAgent.awaitTurnResult(pool, '11');
  assert.equal(outcome, 'completed');
  assert.ok(reads >= 3, 'polled rather than waiting on a notification that never came');
});

test('every wait is bounded, so no waiter can hang on a silent bus', () => {
  const waits = localAgentSource
    .split('\n')
    .filter((line) => line.includes('await waitForSignal('));
  assert.ok(waits.length >= 2, 'found the wait sites');
  for (const call of waits) {
    // Every call site passes a literal or computed millisecond bound as its
    // second argument — never `undefined`, never Infinity.
    assert.match(call, /,\s*(\d+|Math\.min\([^;]*\d)/, `unbounded wait: ${call.trim()}`);
  }
  assert.match(localAgentSource, /setTimeout/, 'waitForSignal resolves on a timer too');
});

test('a claim that hears nothing returns empty at its deadline instead of hanging', async () => {
  const pool = makePool([[/UPDATE local_agent_turns/, []]]);
  const lease = { id: '7', session_id: 42, user_id: 5 };
  const started = Date.now();
  const turn = await localAgent.claimNextTurn(pool, { lease, timeoutMs: 60 });
  assert.equal(turn, null);
  assert.ok(Date.now() - started < 5000, 'respected the caller\'s deadline');
});

// ── A turn orphaned by the restart gets reaped ─────────────────────────────

test('the lease sweeper is what reaps a turn whose waiter died with the process', async () => {
  // The turn timeout lives inside awaitTurnResult, which the restart killed.
  // The backstop is the lease: the CLI on the other side either reconnects
  // and finishes the turn, or stops heartbeating and the sweeper abandons it.
  const pool = makePool([
    [/UPDATE session_agent_leases/, [{ id: '7', session_id: 42 }]],
    [/UPDATE local_agent_turns/, [{ session_id: 42 }]],
  ]);
  const reaped = await localAgent.sweepExpiredLeases(pool);
  assert.equal(reaped, 1);
  const turnUpdate = pool.calls.find((c) => /UPDATE local_agent_turns/.test(c.sql));
  assert.match(turnUpdate.sql, /status = 'abandoned'/);
  assert.deepEqual(turnUpdate.params[1], localAgent.LIVE_TURN_STATUSES);
  // 'abandoned', not 'failed': nothing went wrong with the user's request,
  // and the next turn should route straight back to a platform worker.
  assert.equal(localAgent.TERMINAL_TURN_STATUSES.includes('abandoned'), true);
});

test('the sweeper is armed at boot, on an interval shorter than the lease TTL', () => {
  assert.match(serverSource, /startLocalAgentLeaseSweeper\(config\)/);
  const declared = serverSource.match(/LOCAL_AGENT_SWEEP_MS\s*=\s*([^;]+);/);
  assert.ok(declared, 'the sweep interval is a named constant');
  // eslint-disable-next-line no-eval
  const sweepMs = eval(declared[1]);
  assert.ok(sweepMs <= localAgent.LEASE_TTL_MS,
    'a lease must not outlive its reaper by more than one sweep');
  assert.match(serverSource, /sweepExpiredLeases/);
});

test('the sweeper never takes the process down with it', () => {
  const block = serverSource.slice(
    serverSource.indexOf('function startLocalAgentLeaseSweeper'),
    serverSource.indexOf('function startLocalAgentLeaseSweeper') + 900
  );
  assert.ok(/catch/.test(block), 'a failed sweep is logged, not thrown into the event loop');
  assert.match(block, /unref\(\)|setInterval/);
});

// ── The client rides out the outage ────────────────────────────────────────

test('a restart-length outage backs the poll off instead of exiting the CLI', () => {
  const runBlock = agentSource.slice(
    agentSource.indexOf('async function agentRun'),
    agentSource.indexOf('async function agentStatus')
  );
  // A deploy is a handful of seconds of ECONNREFUSED. Exiting on the first
  // one would mean every deploy silently detaches every attached machine.
  assert.match(runBlock, /failures \+= 1/);
  assert.match(runBlock, /Math\.min\(15000, failures \* 1000\)/);
  assert.match(runBlock, /failures > 20/, 'but it does give up eventually');
});

test('a lease the platform no longer recognises stops the loop rather than looping forever', () => {
  const runBlock = agentSource.slice(
    agentSource.indexOf('async function agentRun'),
    agentSource.indexOf('async function agentStatus')
  );
  const heartbeat = runBlock.slice(runBlock.indexOf('setInterval'));
  assert.match(heartbeat, /lease_lost|409/);
  assert.match(heartbeat, /running = false/);
});

test('heartbeat and TTL leave room for a restart to finish', () => {
  // Three missed heartbeats before a lease lapses. A rolling deploy that
  // takes longer than that is supposed to lose the attachment.
  assert.ok(localAgent.LEASE_TTL_MS >= localAgent.HEARTBEAT_MS * 3);
  assert.ok(localAgent.HEARTBEAT_MS <= 60 * 1000);
});

// ── What the user sees afterwards ──────────────────────────────────────────

test('the dev chat rebuilds the chip from /status, not from anything it remembered', () => {
  const devChat = fs.readFileSync(path.join(root, 'public/js/dev-chat.js'), 'utf8');
  assert.match(devChat, /_applyRunnerState/);
  // A reload (or a restart-induced reconnect) re-reads the session status and
  // repaints; the chip has no client-side source of truth.
  assert.match(sessionsSource, /localAgent\.publicLease\(await localAgent\.activeLease/);
  assert.match(sessionsSource, /last_turn_runner/);
});

test('a session whose local turn died across a restart can still be force-stopped', () => {
  // force_orphan is the "my turn is wedged" escape hatch. Before #907 it only
  // cleaned platform bookkeeping; a local turn row left at 'running' would
  // otherwise keep the session looking busy until the lease lapsed.
  const orphan = sessionsSource.slice(
    sessionsSource.indexOf("if (action === 'force_orphan')"),
    sessionsSource.indexOf("if (action === 'force_orphan')") + 800
  );
  assert.match(orphan, /localAgent\.requestStop/);
  assert.match(orphan, /userId: null/, 'the operator path is not scoped to one user');
});

test('a turn that finished while the platform was down is read back, not re-run', async () => {
  // The CLI posts its result to the restarted process. finishTurn succeeded
  // with nobody listening; a fresh awaitTurnResult (or the status route) must
  // see the terminal row immediately rather than waiting out a timeout.
  const pool = makePool([[/FROM local_agent_turns WHERE id/, [{
    id: '11', session_id: 42, status: 'completed', head_sha: 'b'.repeat(40),
    summary: 'Added the thing', updated_at: 't1',
  }]]]);
  const started = Date.now();
  const { outcome, turn } = await localAgent.awaitTurnResult(pool, '11');
  assert.equal(outcome, 'completed');
  assert.equal(turn.head_sha, 'b'.repeat(40));
  assert.ok(Date.now() - started < 1000, 'returned on the first read');
  assert.equal(pool.calls.length, 1);
});

test('commits uploaded before the restart are still on the branch', () => {
  // Each commit is reconstructed and recorded as it goes, so a turn that
  // uploaded two of three commits and then lost the platform leaves the
  // branch — and the turn row — pointing at the second one.
  assert.match(localAgentSource, /async function recordTurnHead/);
  const fn = localAgentSource.slice(localAgentSource.indexOf('async function recordTurnHead'));
  assert.match(fn.slice(0, 700), /SET head_sha = \$3/);
  assert.match(agentSource, /rev-list', '--reverse/, 'uploaded oldest-first');
});
