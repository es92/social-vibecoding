// #1038: the client-side live session-state store (public/js/session-state.js).
//
// The store is what every working-state surface reads through, so its
// precedence rules are the whole feature:
//
//   - A pushed event always beats the `busy` flag on a row we fetched
//     EARLIER. That's the "cog starts spinning" half.
//   - A fetch never beats an event that arrived after the request went out.
//     That's the "cog stops spinning" half, and the subtle one: a slow
//     /api/me/active-sessions response carrying `busy: true` lands AFTER the
//     turn already finished, and must not resurrect the spinner.
//   - reconcile() replaces the set: the endpoint returns non-idle rows only,
//     so anything absent becomes an explicit idle override rather than a
//     deletion (a deletion would let the stale fetched row win again).
//   - A changed bootId means the platform restarted and every override
//     described a process that no longer exists.
//
// The real shipped source is loaded into a vm sandbox so the test can't
// drift from what runs, with minimal browser stubs.
//
// Run with: node --test tests/session-state-store.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'session-state.js'), 'utf8'
);

function load({ fetchImpl } = {}) {
  const timers = [];
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    document: { hidden: false, visibilityState: 'visible' },
    location: { search: '' },
    URLSearchParams,
    fetch: fetchImpl || (async () => ({ ok: false })),
    // Deterministic scheduling: notify() falls back to setTimeout when rAF
    // is absent, and the tick timer must not keep the runner alive.
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Date,
    Promise,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const S = sandbox.window.SessionState;
  // Drain queued microtask-ish callbacks (the coalesced notify flush).
  sandbox.flushTimers = () => {
    const due = timers.splice(0, timers.length).filter((t) => (t.ms || 0) === 0);
    due.forEach((t) => t.fn());
  };
  return { S, sandbox };
}

test('a pushed busy event beats a fetched row that said idle', () => {
  const { S } = load();
  S.seed([{ id: 1, busy: false }], Date.now() - 1000);
  assert.equal(S.isBusy(1, false), false);

  S.applyEvent({ sessionId: 1, busy: true, status: 'active' });
  assert.equal(S.isBusy(1, false), true);
  // Even if a renderer passes the stale row's own flag as the fallback.
  assert.equal(S.isBusy(1, false), true);
});

test('a pushed idle event beats a stale fetched busy row', () => {
  const { S } = load();
  const t0 = Date.now();
  S.applyEvent({ sessionId: 2, busy: true, status: 'active' });
  assert.equal(S.isBusy(2, true), true);

  S.applyEvent({ sessionId: 2, busy: false, status: 'active' });
  // This is the phantom-spinner case: the row we're rendering still carries
  // busy:true from a fetch that predates the event.
  assert.equal(S.isBusy(2, true), false);

  // And a LATER-issued fetch is allowed to take over again.
  S.seed([{ id: 2, busy: true }], t0 + 10_000);
  assert.equal(S.isBusy(2, false), true);
});

test('a fetch that landed after an event never resurrects the spinner', () => {
  const { S } = load();
  // The request went out at t0; the turn finished (event) while it was in
  // flight; the response lands last carrying the pre-turn-end truth.
  const requestSentAt = Date.now() - 5000;
  S.applyEvent({ sessionId: 3, busy: false, status: 'active' });
  S.seed([{ id: 3, busy: true }], requestSentAt);
  assert.equal(S.isBusy(3, true), false,
    'the older fetch must lose to the newer event');
});

test('isBusy falls back to the row for a session the store never saw', () => {
  const { S } = load();
  assert.equal(S.isBusy(99, true), true);
  assert.equal(S.isBusy(99, false), false);
});

test('reconcile makes absent sessions idle rather than deleting them', () => {
  const { S } = load();
  S.applyEvent({ sessionId: 4, busy: true, status: 'active' });
  assert.equal(S.isBusy(4, false), true);

  // The snapshot carries NON-IDLE rows only, so 4's absence means idle.
  S.reconcile({ bootId: 'boot-1', sessions: [] });
  assert.equal(S.isBusy(4, true), false,
    'an explicit idle override, so a stale busy row still loses');
  assert.ok(S.entries.has(4), 'kept as an override, not dropped');
});

test('reconcile adopts non-idle rows from the snapshot', () => {
  const { S } = load();
  S.reconcile({
    bootId: 'boot-1',
    sessions: [
      { id: 5, busy: true, phase: 'cc', stopping: false, status: 'active', headless: null },
      { id: 6, busy: false, status: 'active', headless: { status: 'generating', issueNumber: 900003 } },
    ],
  });
  assert.equal(S.isBusy(5, false), true);
  assert.equal(S.get(5).phase, 'cc');
  assert.equal(S.isBusy(6, false), false);
  assert.equal(S.get(6).headless.status, 'generating');
  assert.equal(S.anyActive(), true, 'a generating auto-run counts as active');
});

test('a changed bootId clears every override', () => {
  const { S } = load();
  S.reconcile({ bootId: 'boot-1', sessions: [{ id: 7, busy: true, status: 'active' }] });
  assert.equal(S.isBusy(7, false), true);

  // The platform restarted: its in-memory busy state is gone, so ours is
  // meaningless. Nothing about session 7 survives.
  S.reconcile({ bootId: 'boot-2', sessions: [] });
  assert.equal(S.entries.size, 0);
  assert.equal(S.isBusy(7, false), false);
  assert.equal(S.bootId, 'boot-2');
});

test('the same bootId does not clear overrides', () => {
  const { S } = load();
  S.reconcile({ bootId: 'boot-1', sessions: [{ id: 8, busy: true, status: 'active' }] });
  S.reconcile({ bootId: 'boot-1', sessions: [{ id: 8, busy: true, status: 'active' }] });
  assert.equal(S.isBusy(8, false), true);
});

test('subscribers coalesce a burst of events into one call', () => {
  const { S, sandbox } = load();
  let calls = 0;
  S.subscribe(() => { calls += 1; });

  S.applyEvent({ sessionId: 10, busy: true, status: 'active' });
  S.applyEvent({ sessionId: 11, busy: true, status: 'active' });
  S.applyEvent({ sessionId: 12, busy: true, status: 'active' });
  assert.equal(calls, 0, 'nothing runs synchronously');

  sandbox.flushTimers();
  assert.equal(calls, 1, 'three changes, one repaint');
});

test('an event that changes nothing does not repaint', () => {
  const { S, sandbox } = load();
  S.applyEvent({ sessionId: 13, busy: true, status: 'active' });
  sandbox.flushTimers();

  let calls = 0;
  S.subscribe(() => { calls += 1; });
  // Same derived state — only the timestamp moved.
  S.applyEvent({ sessionId: 13, busy: true, status: 'active' });
  sandbox.flushTimers();
  assert.equal(calls, 0);

  S.applyEvent({ sessionId: 13, busy: false, status: 'active' });
  sandbox.flushTimers();
  assert.equal(calls, 1);
});

test('onEvent runs immediately, even when the derived state is unchanged', () => {
  const { S } = load();
  const seen = [];
  S.onEvent((p) => seen.push(p.sessionId));

  S.applyEvent({ sessionId: 14, busy: true, status: 'active' });
  S.applyEvent({ sessionId: 14, busy: true, status: 'active' });
  // Two raw deliveries: the auto-run outcome that rides on an otherwise
  // unchanged payload must still reach the issue-card patcher.
  assert.deepEqual(seen, [14, 14]);
});

test('anyActive reflects busy, stopping and generating auto-runs', () => {
  const { S } = load();
  assert.equal(S.anyActive(), false);

  S.applyEvent({ sessionId: 15, busy: false, stopping: true, status: 'active' });
  assert.equal(S.anyActive(), true);

  S.applyEvent({ sessionId: 15, busy: false, stopping: false, status: 'active' });
  assert.equal(S.anyActive(), false);
});

test('sync reconciles from the endpoint and is single-flight', async () => {
  let calls = 0;
  let resolveFetch;
  const gate = new Promise((r) => { resolveFetch = r; });
  const { S } = load({
    fetchImpl: async (url) => {
      calls += 1;
      S._lastUrl = url;
      await gate;
      return { ok: true, json: async () => ({ bootId: 'b1', sessions: [{ id: 20, busy: true }] }) };
    },
  });

  const a = S.sync();
  const b = S.sync();
  assert.equal(calls, 1, 'concurrent callers share one request');
  resolveFetch();
  await Promise.all([a, b]);

  assert.equal(S.isBusy(20, false), true);
  assert.ok(S.lastSyncAt > 0);
  assert.equal(S._lastUrl, '/api/me/session-state');
});

test('sync forwards the open app and the staging demo flag', async () => {
  let url = null;
  const { S, sandbox } = load({
    fetchImpl: async (u) => {
      url = u;
      return { ok: true, json: async () => ({ bootId: 'b1', sessions: [] }) };
    },
  });
  sandbox.App = { currentApp: 'demo-app' };
  sandbox.location.search = '?demo=1';

  await S.sync();
  // Without ?demo=1 the reconcile would report the staging mock sessions
  // idle and wipe every demo spinner off the board.
  assert.equal(url, '/api/me/session-state?app=demo-app&demo=1');
});

test('a failed sync leaves the previous snapshot in place', async () => {
  const { S } = load({ fetchImpl: async () => { throw new Error('offline'); } });
  S.applyEvent({ sessionId: 21, busy: true, status: 'active' });
  await S.sync();
  assert.equal(S.isBusy(21, false), true, 'a network blip must not clear real state');
});

test('a non-ok sync response is ignored', async () => {
  const { S } = load({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  S.applyEvent({ sessionId: 22, busy: true, status: 'active' });
  await S.sync();
  assert.equal(S.isBusy(22, false), true);
});

test('syncIfStale only fetches once the last reconcile is old enough', async () => {
  let calls = 0;
  const { S } = load({
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ bootId: 'b1', sessions: [] }) };
    },
  });

  await S.sync();
  assert.equal(calls, 1);

  // A tab that just reconciled and is alt-tabbed twice must not refetch.
  await S.syncIfStale();
  assert.equal(calls, 1);

  // Pretend the last sync was long ago (the backgrounded-for-an-hour case).
  S.lastSyncAt = Date.now() - (S.FOREGROUND_STALE_MS + 1000);
  await S.syncIfStale();
  assert.equal(calls, 2);
});

test('an idle override is never aged out — the fetched row it would expose is stale', () => {
  // This change removed the 15s/8s polls that used to keep the list payloads
  // fresh, so dropping an idle override and falling back to a row's own
  // `busy` flag means falling back to something arbitrarily old. That is the
  // phantom spinner the feature exists to kill, so overrides persist.
  const { S } = load();
  S.applyEvent({ sessionId: 30, busy: true, status: 'active' });
  S.applyEvent({ sessionId: 30, busy: false, status: 'active' });

  S.entries.get(30).at = Date.now() - (24 * 60 * 60 * 1000);
  S.applyEvent({ sessionId: 31, busy: true, status: 'active' });

  assert.ok(S.entries.has(30), 'still an explicit idle override a day later');
  assert.equal(S.isBusy(30, true), false, 'so a long-stale busy row still loses');
});

test('the entry cap evicts oldest-idle-first and never evicts live work', () => {
  const { S } = load();
  S.MAX_ENTRIES = 3;

  // Three idle entries with increasing ages, oldest first.
  const now = Date.now();
  [40, 41, 42].forEach((id, i) => {
    S.applyEvent({ sessionId: id, busy: false, status: 'active' });
    S.entries.get(id).at = now - (1000 * (3 - i));
  });
  // A long-running turn, deliberately the oldest entry of all.
  S.applyEvent({ sessionId: 43, busy: true, status: 'active' });
  S.entries.get(43).at = now - 999999;

  // One more push takes us over the cap.
  S.applyEvent({ sessionId: 44, busy: true, status: 'active' });

  assert.equal(S.isBusy(43, false), true, 'in-flight work is never evicted');
  assert.equal(S.isBusy(44, false), true);
  assert.ok(!S.entries.has(40), 'the oldest IDLE entry went first');
  assert.ok(S.entries.size <= S.MAX_ENTRIES + 1);
});
