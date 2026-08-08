// Tests for the sync-with-main progress plumbing (#252).
//
// Covers the three backend guarantees the dev-chat sync banner depends
// on:
//   1. runSyncMain() coalesces concurrent calls per session — a click
//      that races the resume-triggered background sync joins the
//      running turn instead of tripping execInWorker's "a turn is
//      already in flight" guard.
//   2. The run broadcasts sync_status lifecycle events (starting →
//      phase changes → done/failed) over pushSessionUpdate, and
//      getSyncState() tracks the live phase for reload recovery.
//   3. The routes: POST /sync-main 409s (friendly, structured) when a
//      chat turn holds the worker, and GET /status exposes the `sync`
//      field.
//
// Like the other suites we stub collaborators via require.cache so
// nothing real (worker, docker, ws) spins up.
//
// Run with: node --test tests/sync-progress.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Route harness setup (must run before requiring routes/sessions) ──
// Same pattern as tests/me-active-sessions.test.js: override getPool
// BEFORE the route module destructures it, mount on a real express
// app, inject req.user. sessions.js binds the ORIGINAL sync-main
// module object (syncMainSvc), so route tests monkey-patch its
// properties; the unit tests below load their own fresh copies via
// require.cache stubbing and never touch the original.
const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: (sql, params) => poolQueryHandler(sql, params),
});

const worker = require('../src/services/worker');
const { activeWorkers } = require('../src/services/active-workers');
const syncMainSvc = require('../src/services/sync-main');
const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 3, username: 'tester' };

function startServer() {
  const app = express();
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Mock pool (sync-main unit tests) ────────────────────────────────
function makePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) {
        if (re.test(sql)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
  };
}

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Load a fresh sync-main with worker + ws stubbed. execImpl receives
// the execInWorker opts (so tests can drive opts.onProgress with the
// worker's "[sync_*]" phase lines) and returns/throws the turn result.
function loadSyncMain({ execImpl }) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    worker: require.resolve('../src/services/worker'),
    ws: require.resolve('../src/services/ws'),
    sessionBus: require.resolve('../src/services/session-bus'),
    subject: require.resolve('../src/services/sync-main'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const execCalls = [];
  const updates = [];   // pushSessionUpdate (banner channel)
  const globals = [];   // broadcastGlobal (session_event channel)
  const busEvents = []; // sessionBus.publish (per-session ring buffer)
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.worker, {
    ensureWorkerImage: async () => {},
    ensureWorker: async () => {},
    // #937: runSyncMain retires any pending stop before its own dispatch
    // — a sync turn is a new turn, and it is not in stopRegistry, so
    // nothing else would ever clear a flag left by an earlier chat stop.
    clearPendingStop: () => {},
    execInWorker: async (sessionId, opts) => {
      execCalls.push({ sessionId, opts });
      return execImpl(opts);
    },
  });
  stub(ids.ws, {
    pushSessionUpdate(data) { updates.push(data); },
    broadcastGlobal(data) { globals.push(data); },
  });
  stub(ids.sessionBus, { publish(sessionId, event) { busEvents.push({ sessionId, event }); } });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, execCalls, updates, globals, busEvents, restore };
}

function syncPool() {
  return makePool([
    [/SELECT anthropic_key_enc/, []],
    [/UPDATE chat_sessions SET behind_main/, []],
    [/INSERT INTO chat_session_messages/, []],
  ]);
}

function sessionRow(overrides = {}) {
  return {
    id: 7, user_id: 3, app_slug: 'widget', branch_name: 'dev/x-1',
    repo_url: 'https://github.com/acme/widget',
    ...overrides,
  };
}

const syncEvents = (updates) => updates.filter((u) => u.action === 'sync_status');

// ── runSyncMain coalescing ──────────────────────────────────────────

test('runSyncMain: concurrent calls for one session share a single worker turn', async () => {
  const { subject, execCalls, restore } = loadSyncMain({
    execImpl: async () => {
      await sleep(20); // hold it in-flight so the second call overlaps
      return { syncResult: 'clean', behind: 0, sha: 'abc1234', pushOk: true, exitCode: 0 };
    },
  });
  try {
    const pool = syncPool();
    const row = sessionRow();
    const p1 = subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: row });
    const p2 = subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: row });
    assert.ok(subject.getSyncState(7), 'registry reports in-flight while pending');
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(execCalls.length, 1, 'the second concurrent call must coalesce, not spin a second worker');
    assert.deepEqual(r1, r2, 'both callers receive the same result');
    assert.equal(r1.syncResult, 'clean');
    assert.equal(subject.getSyncState(7), null, 'registry empties once the sync settles');
  } finally {
    restore();
  }
});

test('runSyncMain: a later, non-overlapping call runs a fresh worker turn', async () => {
  const { subject, execCalls, restore } = loadSyncMain({
    execImpl: async () => ({ syncResult: 'clean', behind: 0, sha: 'abc1234', pushOk: true, exitCode: 0 }),
  });
  try {
    const pool = syncPool();
    const row = sessionRow();
    await subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: row });
    await subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: row });
    assert.equal(execCalls.length, 2, 'sequential syncs are independent once the prior one settles');
  } finally {
    restore();
  }
});

test('runSyncMain: coalescing is per-session, not global', async () => {
  const { subject, execCalls, restore } = loadSyncMain({
    execImpl: async () => {
      await sleep(20);
      return { syncResult: 'clean', behind: 0, sha: 'abc1234', pushOk: true, exitCode: 0 };
    },
  });
  try {
    const pool = syncPool();
    const p1 = subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: sessionRow({ id: 7 }) });
    const p2 = subject.runSyncMain({ jwtSecret: 's' }, pool, 8, { sessionRow: sessionRow({ id: 8, branch_name: 'dev/y-2' }) });
    await Promise.all([p1, p2]);
    assert.equal(execCalls.length, 2, 'different sessions never coalesce');
  } finally {
    restore();
  }
});

// ── sync_status lifecycle broadcasts + phase tracking ───────────────

test('lifecycle: phase lines map to merging→resolving→pushing and the terminal done carries syncResult/message', async () => {
  let midFlightPhase = null;
  const { subject, updates, restore } = loadSyncMain({
    execImpl: async (opts) => {
      // Replay the worker's MODE=sync phase markers as parseLine
      // forwards them ("[<phase>]" progress lines).
      opts.onProgress('[sync_fetch_main]');
      opts.onProgress('[sync_merge]');
      opts.onProgress('[sync_conflict_cc]');
      midFlightPhase = subject.getSyncState(7)?.phase;
      opts.onProgress('[sync_push]');
      return { syncResult: 'resolved', behind: 0, sha: 'abc1234', pushOk: true, exitCode: 0 };
    },
  });
  try {
    const res = await subject.runSyncMain({ jwtSecret: 's' }, syncPool(), 7, { sessionRow: sessionRow() });
    assert.equal(res.ok, true);

    const events = syncEvents(updates);
    assert.deepEqual(
      events.map((e) => e.state),
      ['starting', 'merging', 'resolving', 'pushing', 'done'],
      'one broadcast per phase change (fetch+merge dedupe to a single merging), then the terminal'
    );
    for (const e of events) {
      assert.equal(e.sessionId, 7);
      assert.equal(e.appSlug, 'widget');
    }
    const terminal = events[events.length - 1];
    assert.equal(terminal.syncResult, 'resolved');
    assert.match(terminal.message, /resolved merge conflicts/i);
    assert.equal(midFlightPhase, 'resolving', 'getSyncState tracks the live phase for reload recovery');
  } finally {
    restore();
  }
});

test('lifecycle: unresolved conflict emits a terminal failed with syncResult/message', async () => {
  const { subject, updates, restore } = loadSyncMain({
    execImpl: async (opts) => {
      opts.onProgress('[sync_merge]');
      opts.onProgress('[sync_conflict_cc]');
      return { syncResult: 'conflict', behind: 2, sha: '', pushOk: false, exitCode: 0 };
    },
  });
  try {
    const res = await subject.runSyncMain({ jwtSecret: 's' }, syncPool(), 7, { sessionRow: sessionRow() });
    assert.equal(res.ok, false);

    const events = syncEvents(updates);
    assert.equal(events[0].state, 'starting');
    const terminal = events[events.length - 1];
    assert.equal(terminal.state, 'failed');
    assert.equal(terminal.syncResult, 'conflict');
    assert.match(terminal.message, /couldn't resolve the conflicts/i);
    assert.equal(subject.getSyncState(7), null);
  } finally {
    restore();
  }
});

test('lifecycle: a thrown worker error emits failed (with the error message) and still rethrows', async () => {
  const { subject, updates, restore } = loadSyncMain({
    execImpl: async () => { throw new Error('docker exploded'); },
  });
  try {
    await assert.rejects(
      () => subject.runSyncMain({ jwtSecret: 's' }, syncPool(), 7, { sessionRow: sessionRow() }),
      /docker exploded/
    );
    const events = syncEvents(updates);
    const terminal = events[events.length - 1];
    assert.equal(terminal.state, 'failed');
    assert.equal(terminal.message, 'docker exploded');
    assert.equal(subject.getSyncState(7), null, 'registry must clear on the throw path too');
  } finally {
    restore();
  }
});

test('lifecycle: already_synced short-circuit still emits starting → done so a click always gets feedback', async () => {
  const { subject, updates, restore } = loadSyncMain({
    execImpl: async () => ({ syncResult: 'already_synced', behind: 0, sha: 'abc1234', pushOk: true, exitCode: 0 }),
  });
  try {
    await subject.runSyncMain({ jwtSecret: 's' }, syncPool(), 7, { sessionRow: sessionRow() });
    const events = syncEvents(updates);
    assert.deepEqual(events.map((e) => e.state), ['starting', 'done']);
    assert.match(events[1].message, /already up to date/i);
  } finally {
    restore();
  }
});

// ── Session-native activity emission ────────────────────────────────
// The core of the "make sync emit session activity" change: a real
// merge drives the SAME primitives a build turn does — an opening
// status row, a lazily-created "Claude Code progress" row whose
// progressLog streams human lines, a terminal status row, and a
// SYNC_MAIN analytics event — while STILL broadcasting the banner.

function ownerRow(overrides = {}) {
  return {
    id: 7, user_id: 3, app_id: 5, app_slug: 'widget', branch_name: 'dev/x-1',
    repo_url: 'https://github.com/acme/widget', behind_main: 2,
    ...overrides,
  };
}

// Pool that returns a fixed id for the progress-row INSERT (matched by
// its 'Claude Code progress' literal) so the lazy-create path captures
// an id; everything else returns no rows.
function activityPool() {
  return makePool([
    [/SELECT anthropic_key_enc/, []],
    [/UPDATE chat_sessions SET behind_main/, []],
    [/Claude Code progress/, [{ id: 4242 }]],
    [/INSERT INTO chat_session_messages/, []],
    [/UPDATE chat_session_messages SET metadata/, []],
    [/INSERT INTO events/, []],
  ]);
}

// Status rows share the INSERT shape but are NOT the progress row; their
// content is param $2.
const statusContents = (pool) => pool.calls
  .filter((c) => /INSERT INTO chat_session_messages/.test(c.sql) && !/Claude Code progress/.test(c.sql))
  .map((c) => c.params[1]);
const progressAppends = (pool) => pool.calls
  .filter((c) => /UPDATE chat_session_messages SET metadata/.test(c.sql))
  .map((c) => JSON.parse(c.params[0])[0]);
const eventInserts = (pool) => pool.calls
  .filter((c) => /INSERT INTO events/.test(c.sql));

test('activity: a clean merge emits opening status, progress log, terminal status, SYNC_MAIN event, and still broadcasts the banner', async () => {
  const { subject, updates, globals, restore } = loadSyncMain({
    execImpl: async (opts) => {
      opts.onProgress('[sync_fetch_main]');
      opts.onProgress('[sync_merge]');
      opts.onProgress('[sync_push]');
      return { syncResult: 'clean', behind: 0, sha: 'abc1234ff', pushOk: true, exitCode: 0 };
    },
  });
  try {
    const pool = activityPool();
    const res = await subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: ownerRow(), trigger: 'manual' });
    assert.equal(res.ok, true);

    // (a) opening status row
    const contents = statusContents(pool);
    assert.equal(contents[0], 'Syncing with main…', 'opening status row inserted first');

    // (b) progress row created lazily + appended with human-readable lines
    assert.ok(pool.calls.some((c) => /Claude Code progress/.test(c.sql)), 'progress row created');
    assert.deepEqual(progressAppends(pool), ['Fetching main…', 'Merging origin/main…', 'Pushing…']);

    // (c) terminal status row (persisted) carries the syncMain summary
    assert.ok(contents.some((c) => /Merged main cleanly\. Pushed abc1234/.test(c)), 'terminal status persisted');

    // live broadcasts: opening + cc_progress + terminal all went out as session_events
    const evTypes = globals.map((g) => g.event);
    assert.ok(evTypes.includes('status'), 'status broadcast live');
    assert.ok(evTypes.filter((e) => e === 'cc_progress').length === 3, 'each progress line broadcast live');

    // (d) SYNC_MAIN event recorded, attributed to the owner
    const ev = eventInserts(pool);
    assert.equal(ev.length, 1, 'one analytics row on the terminal path');
    // INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
    assert.equal(ev[0].params[0], 3, 'attributed to session.user_id (owner)');
    assert.equal(ev[0].params[3], 'sync_main');
    const meta = JSON.parse(ev[0].params[4]);
    assert.equal(meta.syncResult, 'clean');
    assert.equal(meta.pushOk, true);
    assert.equal(meta.trigger, 'manual');

    // (e) banner still broadcasts done
    const banner = syncEvents(updates);
    assert.equal(banner[banner.length - 1].state, 'done');
  } finally {
    restore();
  }
});

test('activity: each syncResult outcome produces the right terminal row', async () => {
  const cases = [
    { syncResult: 'already_synced', pushOk: true, re: /already up to date/i, ok: true },
    { syncResult: 'clean', pushOk: true, re: /Merged main cleanly/i, ok: true },
    { syncResult: 'resolved', pushOk: true, re: /Claude resolved merge conflicts/i, ok: true },
  ];
  for (const tc of cases) {
    const { subject, restore } = loadSyncMain({
      execImpl: async () => ({ syncResult: tc.syncResult, behind: 0, sha: 'deadbee', pushOk: tc.pushOk, exitCode: 0 }),
    });
    try {
      const pool = activityPool();
      const res = await subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: ownerRow() });
      assert.equal(res.ok, tc.ok, `${tc.syncResult}: ok flag`);
      const contents = statusContents(pool);
      assert.ok(contents.some((c) => tc.re.test(c)), `${tc.syncResult}: terminal text`);
      assert.equal(eventInserts(pool).length, 1, `${tc.syncResult}: one SYNC_MAIN event`);
    } finally {
      restore();
    }
  }
});

test('activity: an unresolved conflict closes as a failure, claims no push, and records the event', async () => {
  const { subject, updates, restore } = loadSyncMain({
    execImpl: async (opts) => {
      opts.onProgress('[sync_merge]');
      opts.onProgress('[sync_conflict_cc]');
      return { syncResult: 'conflict', behind: 2, sha: '', pushOk: false, exitCode: 0 };
    },
  });
  try {
    const pool = activityPool();
    const res = await subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: ownerRow() });
    assert.equal(res.ok, false, 'conflict is not ok');
    assert.equal(res.pushOk, false, 'no push claimed');

    const contents = statusContents(pool);
    assert.ok(contents.some((c) => /couldn't resolve the conflicts/i.test(c)), 'terminal text marks the failure');
    // the terminal row must not falsely claim a push
    assert.ok(!contents.some((c) => /Pushed/.test(c)), 'failure row claims no push');

    const ev = eventInserts(pool);
    assert.equal(ev.length, 1);
    assert.equal(JSON.parse(ev[0].params[4]).syncResult, 'conflict');

    // banner shows failed
    const banner = syncEvents(updates);
    assert.equal(banner[banner.length - 1].state, 'failed');
  } finally {
    restore();
  }
});

test('activity: a behind==0 pre-check stays silent — no activity rows, no event — but the banner still fires', async () => {
  const { subject, updates, globals, restore } = loadSyncMain({
    execImpl: async () => ({ syncResult: 'already_synced', behind: 0, sha: 'abc1234', pushOk: true, exitCode: 0 }),
  });
  try {
    const pool = activityPool();
    // behind_main: 0 → emitActivity gate is closed (auto/silent sync).
    await subject.runSyncMain({ jwtSecret: 's' }, pool, 7, { sessionRow: ownerRow({ behind_main: 0 }), trigger: 'resume_autosync' });

    assert.equal(statusContents(pool).length, 0, 'no status rows persisted');
    assert.ok(!pool.calls.some((c) => /Claude Code progress/.test(c.sql)), 'no progress row');
    assert.equal(eventInserts(pool).length, 0, 'no analytics row for a silent self-resolving sync');
    assert.ok(!globals.some((g) => g.event === 'status'), 'no live status broadcast');

    // banner channel is unaffected — starting → done still go out.
    assert.deepEqual(syncEvents(updates).map((e) => e.state), ['starting', 'done']);
  } finally {
    restore();
  }
});

// ── Routes: 409 busy guard + /status sync field ─────────────────────

function activeSessionRow(id) {
  return {
    id, user_id: VIEWER.id, status: 'active', app_id: 5,
    app_slug: 'widget', app_name: 'Widget',
    repo_url: 'https://github.com/acme/widget',
    branch_name: 'dev/tester-1', behind_main: 3,
    // appAccess.sessionCollabGuard selects a.collab_visibility +
    // a.view_visibility alongside the session; checkAppAccess THROWS when
    // handed a row without them. Model what the real SQL returns rather than
    // relying on the old default-to-public branch (which meant this stub was
    // never actually exercising the privacy gate).
    collab_visibility: 'public',
    view_visibility: 'public',
  };
}

test('POST /sync-main: 409 with a friendly error when a chat turn is in flight and no sync is running', async () => {
  poolQueryHandler = async (sql) => {
    if (/FROM chat_sessions cs JOIN apps a/.test(sql)) return { rows: [activeSessionRow(41)] };
    return { rows: [] };
  };
  activeWorkers.clear();
  activeWorkers.add(41); // a chat turn holds the worker
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = () => false;
  const realGetSyncState = syncMainSvc.getSyncState;
  syncMainSvc.getSyncState = () => null;
  const realRunSyncMain = syncMainSvc.runSyncMain;
  let runCalls = 0;
  syncMainSvc.runSyncMain = async () => { runCalls += 1; return { ok: true }; };

  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/41/sync-main`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.equal(body.busy, true);
    assert.match(body.error, /still working in this session/i);
    assert.equal(runCalls, 0, 'the guard must fire before any worker dispatch');
  } finally {
    syncMainSvc.getSyncState = realGetSyncState;
    syncMainSvc.runSyncMain = realRunSyncMain;
    worker.isInFlight = realIsInFlight;
    activeWorkers.clear();
    server.close();
  }
});

test('POST /sync-main: falls through to the coalesced run when the in-flight turn IS a sync', async () => {
  poolQueryHandler = async (sql) => {
    if (/FROM chat_sessions cs JOIN apps a/.test(sql)) return { rows: [activeSessionRow(42)] };
    return { rows: [] };
  };
  activeWorkers.clear();
  activeWorkers.add(42); // the sync turn holds the worker too
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = () => false;
  const realGetSyncState = syncMainSvc.getSyncState;
  syncMainSvc.getSyncState = () => ({ phase: 'resolving', startedAt: 123 });
  const realRunSyncMain = syncMainSvc.runSyncMain;
  syncMainSvc.runSyncMain = async () => ({
    ok: true, syncResult: 'resolved', behind: 0, sha: 'abc1234', pushOk: true,
    message: 'Claude resolved merge conflicts with main and pushed abc1234.',
  });

  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/42/sync-main`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.syncResult, 'resolved');
    assert.match(body.message, /resolved merge conflicts/i);
  } finally {
    syncMainSvc.getSyncState = realGetSyncState;
    syncMainSvc.runSyncMain = realRunSyncMain;
    worker.isInFlight = realIsInFlight;
    activeWorkers.clear();
    server.close();
  }
});

test('GET /status: exposes the in-flight sync state, and null when idle', async () => {
  poolQueryHandler = async (sql) => {
    if (/FROM chat_sessions WHERE id/.test(sql)) return { rows: [{ id: 43 }] };
    return { rows: [] };
  };
  activeWorkers.clear();
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = () => false;
  const realGetSyncState = syncMainSvc.getSyncState;
  syncMainSvc.getSyncState = (id) => (Number(id) === 43 ? { phase: 'pushing', startedAt: 456 } : null);

  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/43/status`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.sync, { phase: 'pushing', startedAt: 456 });

    // Idle session → sync: null (the client's poll fallback keys on this).
    syncMainSvc.getSyncState = () => null;
    const res2 = await fetch(`http://127.0.0.1:${port}/api/sessions/44/status`);
    const body2 = await res2.json();
    assert.equal(body2.sync, null);
  } finally {
    syncMainSvc.getSyncState = realGetSyncState;
    worker.isInFlight = realIsInFlight;
    server.close();
  }
});

test('GET /status: exposes the merge lifecycle status of the session', async () => {
  // Added for the self-app "Platform updating…" banner, whose restore
  // path verified against this field that the merge behind a restored
  // banner was still in flight. That banner was removed in #1015, so no
  // client reads this today — it stays, like the neighbouring
  // `resolving` field, as a cheap honest fact for admin/debug tooling,
  // and the poll must keep serving it.
  poolQueryHandler = async (sql) => {
    // #907 widened this read to fetch last_turn_runner/local_agent_label in
    // the same round-trip (it is a 3s poll), so match the column list loosely
    // — what this test is about is the `status` field reaching the payload.
    if (/SELECT status[\s\S]*?FROM chat_sessions/.test(sql)) {
      return { rows: [{ status: 'promoted' }] };
    }
    return { rows: [] };
  };
  activeWorkers.clear();
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = () => false;
  const realGetSyncState = syncMainSvc.getSyncState;
  syncMainSvc.getSyncState = () => null;

  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/45/status`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'promoted');

    // Missing row → null (fail-safe: the client keeps its banner up).
    poolQueryHandler = async () => ({ rows: [] });
    const res2 = await fetch(`http://127.0.0.1:${port}/api/sessions/46/status`);
    assert.equal((await res2.json()).status, null);
  } finally {
    syncMainSvc.getSyncState = realGetSyncState;
    worker.isInFlight = realIsInFlight;
    server.close();
  }
});
