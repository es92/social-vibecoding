// #1038: the server-side session-state notifier
// (src/services/session-state.js) and its scoped WS fan-out.
//
// What's load-bearing here:
//   1. COALESCING — a turn start fires `activeWorkers.add()` and then the
//      warm registry's `inFlight` flip back to back. Two events for one
//      user-visible transition would repaint every board twice, so the
//      notifier must collapse them.
//   2. PUBLISH-ON-CHANGE — a touch that doesn't move the derived state
//      publishes nothing. Without this, every lastUsedMs bump on the warm
//      registry would be a broadcast.
//   3. IDLE COLLAPSE — a session settling back to idle publishes exactly
//      one final `busy:false` (that's what stops a client's spinner) and
//      then drops out of the notifier's memory, so the map can't grow with
//      the session table.
//   4. SCOPING — a private session's state goes to its OWNER ONLY; a shared
//      session (or a headless auto-run, which renders on everyone's board)
//      fans out app-scoped. This is a privacy boundary, not a nicety: an
//      unscoped broadcast would tell every connected client that a private
//      app has activity.
//
// Run with: node --test tests/session-state-broadcast.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const sessionState = require('../src/services/session-state');
const { activeWorkers, beginSessionOperation } = require('../src/services/active-workers');
const worker = require('../src/services/worker');

// Rows the notifier's own lookup resolves. Keyed by session id.
const ROWS = new Map();
function row(id, over = {}) {
  return {
    id,
    app_id: 7,
    user_id: 42,
    status: 'active',
    shared: false,
    is_headless: false,
    headless_status: null,
    headless_outcome: null,
    headless_issue_number: null,
    app_slug: 'demo-app',
    ...over,
  };
}

const fakePool = {
  query: async (_sql, params) => {
    const r = ROWS.get(Number(params[0]));
    return { rows: r ? [r] : [] };
  },
};

let published = [];

test.beforeEach(() => {
  published = [];
  ROWS.clear();
  sessionState._reset();
  sessionState.setPool(fakePool);
  sessionState.setPhaseResolver(null);
  sessionState.setPublisher((p) => published.push(p));
});

// Long enough for the coalesce window plus the async row lookup.
const settle = () => new Promise((r) => setTimeout(r, sessionState.COALESCE_MS + 80));

test('a turn start publishes exactly one busy event despite two touches', async () => {
  ROWS.set(1, row(1));

  // Exactly what a real dispatch does: register in the shared set, then the
  // warm registry flips inFlight when the docker exec starts — which calls
  // the same notifier entry point a moment later.
  activeWorkers.add(1);
  sessionState.touch(1);

  await settle();

  assert.equal(published.length, 1, 'one event for one transition');
  assert.equal(published[0].sessionId, 1);
  assert.equal(published[0].busy, true);
  assert.equal(published[0].userId, 42);
  assert.equal(published[0].appSlug, 'demo-app');

  activeWorkers.delete(1);
});

test('settling back to idle publishes one final busy:false and forgets the session', async () => {
  ROWS.set(2, row(2));

  activeWorkers.add(2);
  await settle();
  assert.equal(published.length, 1);
  assert.equal(published[0].busy, true);

  activeWorkers.delete(2);
  await settle();
  assert.equal(published.length, 2, 'the idle transition is never swallowed');
  assert.equal(published[1].busy, false);

  // Already idle: a further touch is a no-op, which is what proves the
  // notifier dropped its entry rather than re-publishing idle forever.
  sessionState.touch(2);
  await settle();
  assert.equal(published.length, 2);
});

test('a touch that does not change derived state publishes nothing', async () => {
  ROWS.set(3, row(3));
  activeWorkers.add(3);
  await settle();
  assert.equal(published.length, 1);

  // Still busy — nothing observable moved.
  sessionState.touch(3);
  sessionState.touch(3);
  await settle();
  assert.equal(published.length, 1);

  activeWorkers.delete(3);
});

test('a never-seen idle session publishes nothing', async () => {
  ROWS.set(4, row(4));
  sessionState.touch(4);
  await settle();
  assert.equal(published.length, 0);
});

test('nested session operations only publish on the outer edges', async () => {
  ROWS.set(5, row(5));

  const releaseA = beginSessionOperation(5);
  const releaseB = beginSessionOperation(5);
  await settle();
  assert.equal(published.length, 1, '0→1 publishes; the nested claim does not');
  assert.equal(published[0].busy, true);

  releaseA();
  await settle();
  assert.equal(published.length, 1, 'still held by B — nothing changed');

  releaseB();
  await settle();
  assert.equal(published.length, 2);
  assert.equal(published[1].busy, false);
});

test('overlapping recomputes for one session publish in order', async () => {
  // Each recompute reads `lastPublished`, so two interleaved ones under a
  // slow row lookup could publish busy AFTER idle and strand a spinner
  // until the next reconcile tick. They must serialize per session.
  ROWS.set(10, row(10));
  let gate;
  const held = new Promise((r) => { gate = r; });
  let first = true;
  sessionState.setPool({
    query: async (_sql, params) => {
      if (first) { first = false; await held; }
      const r = ROWS.get(Number(params[0]));
      return { rows: r ? [r] : [] };
    },
  });

  activeWorkers.add(10);
  await new Promise((r) => setTimeout(r, sessionState.COALESCE_MS + 20));
  // The first recompute is now parked mid-lookup. The turn ends and a
  // second recompute is queued behind it.
  activeWorkers.delete(10);
  await new Promise((r) => setTimeout(r, sessionState.COALESCE_MS + 20));
  gate();
  await new Promise((r) => setTimeout(r, 120));

  assert.deepEqual(published.map((p) => p.busy), [true, false],
    'busy then idle — never the reverse');
  sessionState.setPool(fakePool);
});

test('phase and stopping ride along from the registered resolver', async () => {
  ROWS.set(6, row(6));
  sessionState.setPhaseResolver(() => ({ phase: 'cc', stopping: true }));

  activeWorkers.add(6);
  await settle();

  assert.equal(published.length, 1);
  assert.equal(published[0].phase, 'cc');
  assert.equal(published[0].stopping, true);

  activeWorkers.delete(6);
});

test('a headless row carries its auto-run block and fans out app-scoped', async () => {
  ROWS.set(7, row(7, {
    is_headless: true,
    headless_status: 'generating',
    headless_issue_number: 901,
  }));

  sessionState.touch(7);
  await settle();

  assert.equal(published.length, 1);
  assert.deepEqual(published[0].headless, {
    status: 'generating', outcome: null, issueNumber: 901,
  });
  // A headless auto-run's card renders on everyone's board, so it is shared
  // even though shared_at is NULL.
  assert.equal(published[0].shared, true);

  // Terminal transition: the row flips to ready and the notifier reports it
  // (this is what flips the issue card without the retired 8s poll).
  ROWS.set(7, row(7, {
    is_headless: true,
    headless_status: 'ready',
    headless_outcome: 'spec',
    headless_issue_number: 901,
  }));
  sessionState.touch(7);
  await settle();

  assert.equal(published.length, 2);
  assert.equal(published[1].headless.status, 'ready');
  assert.equal(published[1].headless.outcome, 'spec');
});

test('an explicitly shared session fans out app-scoped', async () => {
  ROWS.set(8, row(8, { shared: true }));
  activeWorkers.add(8);
  await settle();

  assert.equal(published.length, 1);
  assert.equal(published[0].shared, true);
  assert.equal(published[0].appId, 7);

  activeWorkers.delete(8);
});

test('a private session is owner-scoped, not app-scoped', async () => {
  ROWS.set(9, row(9, { shared: false }));
  activeWorkers.add(9);
  await settle();

  assert.equal(published.length, 1);
  assert.equal(published[0].shared, false, 'private sessions must not fan out to the app');
  assert.equal(published[0].userId, 42);

  activeWorkers.delete(9);
});

// The fan-out decision itself lives in ws.js. It's a pure function so the
// privacy boundary can be asserted rather than assumed — an unscoped
// broadcast here would tell every connected client that a private app has
// activity, which is the exact mistake the dedicated helper exists to avoid.
test('ws.sessionStateAudience keeps private sessions off the app-wide channel', () => {
  const { sessionStateAudience } = require('../src/services/ws');
  const base = { sessionId: 8, appId: 7, appSlug: 'demo-app', userId: 42 };

  assert.equal(sessionStateAudience({ ...base, shared: true }), 'app',
    'a shared session reaches everyone who may view the app');
  assert.equal(sessionStateAudience({ ...base, shared: false }), 'user',
    'a private session reaches only its owner');
  // Row lookup failed: no owner and no app resolved. Fail closed rather than
  // guessing at an audience, matching broadcastGlobalScoped's own stance.
  assert.equal(sessionStateAudience({ sessionId: 8, shared: false }), 'none');
  assert.equal(sessionStateAudience({ sessionId: 8, shared: true }), 'none',
    'shared with no app to scope to is still not a global broadcast');
  assert.equal(sessionStateAudience(null), 'none');
});

test('the notifier publishes through ws.pushSessionState by default', () => {
  // The default sink is resolved lazily so session-state stays importable in
  // isolation; assert the wiring exists rather than leaving it to production.
  const ws = require('../src/services/ws');
  assert.equal(typeof ws.pushSessionState, 'function');
  assert.equal(typeof worker.isInFlight, 'function',
    'isSessionBusy ORs the warm registry, so the notifier depends on this');
});
