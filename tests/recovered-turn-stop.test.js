'use strict';

// #1378 — a turn ADOPTED after a platform restart must be stoppable, and a
// stop that lands on one must end it as a stop.
//
// The reported failure: Homeroom version-swaps mid-turn, the new process
// picks the running agent back up through resumeDetachedTurn, and the user
// still sees a red Stop square. Pressing it did nothing, because the stop
// handle POST /stop looks up is only ever created by POST /chat — the
// recovery path registered none. Two halves are covered here:
//
//   1. Recovery REGISTERS a handle (phase 'cc', so the in-container kill is
//      armed) for the duration of the tail, and clears it after.
//   2. When that handle is stopped — by a click during the tail, or by a
//      durable stamp written before the cutover — the turn terminalizes as
//      a stop: the "Stopped by @user." row with stopped pills, active_turn
//      cleared, `stopped` + `done` on BOTH event channels, and none of the
//      interrupted-turn narration or the retry paths.
//
// server.js only boots under the require.main guard, so requiring it here
// exposes resumeDetachedTurnInner without starting servers. worker, ws and
// the pool are stubbed via require.cache BEFORE the require so server.js
// binds the stubs.
//
// Run with: node --test tests/recovered-turn-stop.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

const recoveryPills = require('../src/services/recovery-pills');

// ── worker stub ─────────────────────────────────────────────────────────
// resumeTurnFromJournal is the seam the tests drive: it stands in for the
// live journal tail, and `onJournalTail` lets a test act (press Stop) while
// the tail is notionally still running.
let journalTail = null;      // async (sessionId, opts) => result | throws
const finishTurnCalls = [];
const stopTurnCalls = [];
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  resumeTurnFromJournal: async (sessionId, opts) => journalTail(sessionId, opts),
  stopTurn: async (sessionId) => { stopTurnCalls.push(sessionId); return true; },
  finishTurn: async (sessionId, args) => { finishTurnCalls.push({ sessionId, args }); return true; },
  markTurnTail: async () => true,
  noteTailMilestone: async () => true,
  clearActiveTurn: async () => true,
  adoptWarmWorker: () => {},
  destroyWorker: async () => {},
  isWorkerExecuting: async () => false,
  getTurnByokCents: () => 0,
  workerContainerName: (id) => `usernode-worker-${id}`,
};

// ── ws stub — one of the two channels the recovery `send` fans out over ──
const broadcasts = [];
const wsPath = require.resolve('../src/services/ws');
const realWs = require(wsPath);
require.cache[wsPath].exports = {
  ...realWs,
  broadcastGlobal: (msg) => { broadcasts.push(msg); },
  pushNotificationToUser: () => 0,
};

const poolPath = require.resolve('../src/db/pool');
const realPool = require(poolPath);
require.cache[poolPath].exports = { ...realPool, getPool: () => null };

const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...a) => { const t = origSetInterval(...a); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...a) => { const t = origSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
let resumeDetachedTurnInner;
let buildRecoveryStopHandle;
try {
  ({ resumeDetachedTurnInner, buildRecoveryStopHandle } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

const stopRegistry = require('../src/services/stop-registry');
const sessionBus = require('../src/services/session-bus');
const sessionsRoutes = require('../src/routes/sessions');

// ── fixtures ────────────────────────────────────────────────────────────

const SESSION = {
  id: 3539, status: 'active', is_headless: false, user_id: 1, app_id: 1,
  username: 'alice', app_slug: 'workquest', app_name: 'WorkQuest',
  repo_url: 'https://github.com/owner/workquest',
  branch_name: 'dev/alice-1',
  cc_session_id: 'cc-1',
};

function activeTurn(extra = {}) {
  return {
    turnId: 'turn-abc',
    journal: '/journals/turn-abc.jsonl',
    phase: 'executing',
    mode: 'build',
    backend: 'claude_code',
    model: 'claude-opus-5',
    startedAt: new Date().toISOString(),
    attemptNumber: 1,
    ...extra,
  };
}

function makePool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      return { rows: [], rowCount: 0 };
    },
  };
}

function insertedSystemRows(pool) {
  return pool.calls
    .filter((c) => /INSERT INTO chat_session_messages/i.test(c.sql))
    .map((c) => ({
      content: c.params[1],
      metadata: JSON.parse(c.params[2] || '{}'),
    }));
}

function emitted(kind) {
  return broadcasts.filter((b) => b.event === kind);
}

// Build + register the handle with the REAL factory, so these tests exercise
// the production `send` (both channels, `_seq` and all) rather than a
// stand-in that could drift from it.
function makeHandle(turn) {
  const handle = buildRecoveryStopHandle({
    sessionId: SESSION.id,
    containerName: `usernode-worker-${SESSION.id}`,
    activeTurn: turn,
    broadcastGlobal: (msg) => broadcasts.push(msg),
  });
  stopRegistry.set(SESSION.id, handle);
  return handle;
}

// A tail result shaped like worker.resumeTurnFromJournal's, for a turn that
// was killed: no completion marker, a 143 exit.
function killedResult(extra = {}) {
  return {
    exitCode: 143, ahead: 0, behind: 0, sha: null, pushOk: false,
    output: '', rawStderr: '', costUsd: 0, resultSeen: false,
    completedMarkerSeen: false, execExitSeen: true,
    ...extra,
  };
}

function baseArgs(pool, turn) {
  return {
    config: { platformBaseUrl: 'https://example.test' },
    pool,
    staging: { ensure: async () => ({}) },
    broadcastGlobal: (msg) => { broadcasts.push(msg); },
    session: SESSION,
    sessionId: SESSION.id,
    containerName: `usernode-worker-${SESSION.id}`,
    activeTurn: turn,
  };
}

test.beforeEach(() => {
  broadcasts.length = 0;
  finishTurnCalls.length = 0;
  stopTurnCalls.length = 0;
  stopRegistry._reset();
  journalTail = async () => killedResult();
});

// ── 1. a handle exists for the adopted turn, in the killable phase ──────

test('recovery registers a stop handle for the adopted turn, in phase cc', async () => {
  const pool = makePool();
  const turn = activeTurn();
  let seen = null;

  journalTail = async () => {
    // Snapshot what POST /stop would find mid-tail. This is the whole bug:
    // before #1378 the registry was empty here, so classifyStopRequest
    // answered 'no_active_turn' for a turn that was very much alive.
    const handle = stopRegistry.get(SESSION.id);
    seen = handle && {
      phase: handle.phase,
      workerName: handle.workerName,
      stopped: handle.stopped,
      hasAbort: !!handle.abort?.signal,
      hasSend: typeof handle.send === 'function',
    };
    // Stop right here so the tail terminalizes without running finalize.
    handle.stopped = true;
    handle.stoppedBy = 'alice';
    return killedResult();
  };

  // resumeDetachedTurn (the wrapper) is what registers + clears; register the
  // handle it would build so the inner sees exactly what production hands it.
  const handle = makeHandle(turn);

  await resumeDetachedTurnInner({ ...baseArgs(pool, turn), stopHandle: handle });

  assert.ok(seen, 'a stop handle was registered while the tail ran');
  assert.equal(seen.phase, 'cc',
    "phase must be 'cc' — stopPolicy.killsWorkerInPhase gates the in-container kill on it");
  assert.equal(seen.workerName, `usernode-worker-${SESSION.id}`);
  assert.equal(seen.stopped, false);
  assert.ok(seen.hasAbort, 'an AbortController is present for the wrap-up stream');
  assert.ok(seen.hasSend, 'the handle can announce to the session');
});

test('buildRecoveryStopHandle seeds a durable stop stamp so a pre-cutover click is honoured', () => {
  // The narrow window Change 4 exists for: the click landed, the process
  // died before it could act, and the stamp is all that is left.
  const turn = activeTurn({
    stopRequestedAt: new Date(Date.now() - 5000).toISOString(),
    stopRequestedBy: 'evan',
  });
  const handle = makeHandle(turn);
  assert.equal(handle.stopped, true, 'the handle starts stopped');
  assert.equal(handle.stoppedBy, 'evan', 'attributed to whoever clicked before the cutover');
  assert.ok(handle.stopRequestedAt > 0, 'the click time survived the restart');

  // A turn with no stamp is an ordinary adoption: stoppable, not stopped.
  assert.equal(makeHandle(activeTurn()).stopped, false);
});

// ── 2. a stop during the tail terminalizes the turn as a stop ───────────

test('a stop landing during the tail persists "Stopped by @user." with stopped pills', async () => {
  const pool = makePool();
  const turn = activeTurn();
  const handle = makeHandle(turn);

  journalTail = async () => {
    handle.stopped = true;
    handle.stoppedBy = 'alice';
    return killedResult();
  };

  await resumeDetachedTurnInner({ ...baseArgs(pool, turn), stopHandle: handle });

  const rows = insertedSystemRows(pool);
  const stopRow = rows.find((r) => /^Stopped/.test(String(r.content || '')));
  assert.ok(stopRow, `a stop row was persisted (got: ${rows.map((r) => r.content).join(' | ')})`);
  assert.match(stopRow.content, /Stopped by @alice\./);
  assert.equal(stopRow.metadata.stopped, true);
  assert.deepEqual(
    stopRow.metadata.quickReplies,
    recoveryPills.turnFallbackQuickReplies({ outcome: 'stopped' }),
    'the stopped pills match the live stop path exactly',
  );
});

test('a stopped recovery clears active_turn and emits stopped + done', async () => {
  const pool = makePool();
  const turn = activeTurn();
  const busEvents = [];
  const unsub = sessionBus.subscribe(SESSION.id, (e) => busEvents.push(e));

  const handle = makeHandle(turn);
  journalTail = async () => { handle.stopped = true; handle.stoppedBy = 'alice'; return killedResult(); };

  await resumeDetachedTurnInner({ ...baseArgs(pool, turn), stopHandle: handle });
  if (typeof unsub === 'function') unsub();

  assert.equal(finishTurnCalls.length, 1, 'the durable turn record was released');
  assert.equal(finishTurnCalls[0].sessionId, SESSION.id);

  assert.equal(emitted('stopped').length, 1, 'stopped went out on the global broadcast');
  assert.equal(emitted('done').length, 1, 'done went out on the global broadcast');
  assert.equal(emitted('stopped')[0].by, 'alice');

  // Both channels: a tab reconnected over GET /events replays from the bus,
  // and the escalation ladder is driven by exactly these two events.
  const busTypes = busEvents.map((e) => e.type);
  assert.ok(busTypes.includes('stopped'), `sessionBus saw stopped (got ${busTypes.join(',')})`);
  assert.ok(busTypes.includes('done'), `sessionBus saw done (got ${busTypes.join(',')})`);
});

test('a stopped recovery does NOT narrate an interruption or take the retry paths', async () => {
  const pool = makePool();
  const turn = activeTurn();
  const handle = makeHandle(turn);

  // A Codex turn: the fresh-retry path (resumeRecoveredCodexFreshRetry) is
  // exactly the thing that must not run for a turn the user ended — it
  // would dispatch MORE work after an explicit stop.
  let freshRetryCalled = false;
  const realFreshRetry = sessionsRoutes.resumeRecoveredCodexFreshRetry;
  sessionsRoutes.resumeRecoveredCodexFreshRetry = async () => { freshRetryCalled = true; return null; };

  journalTail = async () => { handle.stopped = true; handle.stoppedBy = 'alice'; return killedResult(); };

  try {
    await resumeDetachedTurnInner({ ...baseArgs(pool, turn), stopHandle: handle });
  } finally {
    sessionsRoutes.resumeRecoveredCodexFreshRetry = realFreshRetry;
  }

  assert.equal(freshRetryCalled, false, 'the Codex fresh-retry was skipped for a stopped turn');

  const rows = insertedSystemRows(pool);
  const narrated = rows.map((r) => String(r.content || '')).join(' | ');
  assert.ok(
    !/recovered after a platform restart|could not be recovered|unfinished/i.test(narrated),
    `no interrupted-turn breadcrumb was written (got: ${narrated})`,
  );
  // Exactly one terminal row — the stop — not a stop AND a failure story.
  const terminal = rows.filter((r) => r.metadata && r.metadata.quickReplies);
  assert.equal(terminal.length, 1, `one terminal row, got ${terminal.length}: ${narrated}`);
});

test('a resume that THROWS under a landed stop still closes as a stop', async () => {
  const pool = makePool();
  const turn = activeTurn();
  const handle = makeHandle(turn);
  handle.stopped = true;
  handle.stoppedBy = 'alice';
  journalTail = async () => { throw new Error('journal transport died'); };

  await resumeDetachedTurnInner({ ...baseArgs(pool, turn), stopHandle: handle });

  const rows = insertedSystemRows(pool);
  assert.ok(
    rows.some((r) => /Stopped by @alice/.test(String(r.content || ''))),
    'the throw was reported as the stop the user asked for, not as a failure',
  );
  assert.equal(emitted('done').length, 1);
});

// ── 3. the durable stamp alone terminalizes without resuming ────────────

test('an active_turn carrying a durable stopRequestedAt terminalizes without resuming', async () => {
  const pool = makePool();
  const turn = activeTurn({
    stopRequestedAt: new Date(Date.now() - 3000).toISOString(),
    stopRequestedBy: 'evan',
  });

  // No test-side seeding: the factory reads the stamp off the turn record
  // itself, which is the behaviour under test.
  const handle = makeHandle(turn);
  assert.equal(handle.stopped, true, 'the durable stamp arrives as an already-stopped handle');

  let tailRan = false;
  journalTail = async () => { tailRan = true; return killedResult(); };

  await resumeDetachedTurnInner({ ...baseArgs(pool, turn), stopHandle: handle });

  // The tail still replays (it is how the journal's own exit marker is
  // consumed), but the turn must END as a stop attributed to the clicker,
  // never run on into finalize.
  assert.equal(tailRan, true, 'the journal is still drained');
  const rows = insertedSystemRows(pool);
  assert.ok(
    rows.some((r) => /Stopped by @evan\./.test(String(r.content || ''))),
    'the pre-cutover clicker is credited',
  );
  assert.equal(finishTurnCalls.length, 1, 'active_turn was cleared rather than left for another resume');
});

// ── 4. the "what landed" wording is shared with the live stop path ──────

test('a stopped recovery reports the commit that had already landed', async () => {
  const pool = makePool();
  const turn = activeTurn();
  const handle = makeHandle(turn);
  journalTail = async () => {
    handle.stopped = true;
    handle.stoppedBy = 'alice';
    return killedResult({ ahead: 2, sha: 'abcdef1234567890', pushOk: true });
  };

  await resumeDetachedTurnInner({ ...baseArgs(pool, turn), stopHandle: handle });

  const stopRow = insertedSystemRows(pool)
    .find((r) => /^Stopped/.test(String(r.content || '')));
  assert.ok(stopRow);
  assert.match(stopRow.content, /already committed 2 changes/,
    'stopping a recovered turn says what it had already committed');
  assert.match(stopRow.content, /abcdef12, pushed/);
});

test('describeStoppedLanding is silent when nothing landed, and countless off tail milestones', () => {
  const { describeStoppedLanding } = sessionsRoutes;
  assert.equal(describeStoppedLanding({ sha: null, ahead: 0 }), '');
  // A numeric 0 is authoritative even with a sha — the live path's rule.
  assert.equal(describeStoppedLanding({ sha: 'deadbeefcafe', ahead: 0 }), '');
  // The recovery fallback: a sha with no count still reports the landing.
  const noCount = describeStoppedLanding({ sha: 'deadbeefcafe', ahead: null, pushOk: false });
  assert.match(noCount, /already committed changes to the branch \(deadbeef, not pushed\)/);
  const one = describeStoppedLanding({ sha: 'deadbeefcafe', ahead: 1, pushOk: true });
  assert.match(one, /1 change /, 'singular, not "1 changes"');
});
