'use strict';

// Live session-state notifier (#1038).
//
// "Is a turn in flight for session N" is in-process memory only — see
// services/active-workers.js (`activeWorkers`, `activeSessionOperations`,
// and worker.js's warm-registry `inFlight` flag). Nothing about a turn's
// start or end used to be broadcast, so every client surface that shows
// working state (the header cog, the Dev board's session cards, the
// kanban issue cards' auto-run state) had to guess on a timer.
//
// This module is the single choke point that turns those in-memory
// mutations into ONE scoped `session_state` WebSocket event per real
// transition:
//
//   activeWorkers.add(id)  ─┐
//   beginSessionOperation() ├─→ touch(id) ─→ coalesce ─→ recompute ─→
//   worker inFlight change  │                            publish-on-change
//   headless_status write  ─┘
//
// Why coalescing: a turn start fires `activeWorkers.add()` and then
// `_registryUpsert({inFlight:true})` back to back, and the two would
// otherwise produce two identical events. A short per-session timer plus
// a "did the observable state actually change" comparison collapses them.
//
// Why NOT a DB column: `chat_sessions.active_turn` is a durable turn
// record for restart recovery, not a live busy flag — production carries
// non-NULL values on archived rows months old. The in-memory registries
// are authoritative, and Caddy points at exactly one platform color at a
// time (scripts/platform-rollout.sh), so they are globally consistent for
// every connected client. A color cutover drops every socket, which takes
// the client's reconnect → reconcile path.

const log = require('./logger');

// How long to wait after the first touch before recomputing. Long enough
// to swallow the add()/inFlight pair at a turn's edges, short enough that
// the cog still reads as instant.
const COALESCE_MS = 150;

// sessionId -> stateKey last published. An absent entry means "idle" (see
// IDLE_KEY), so a never-seen session that computes idle publishes nothing.
const lastPublished = new Map();
// sessionId -> pending coalesce timer.
const pending = new Map();

// The observable state of a session nobody is working on. Sessions that
// settle here publish one final event and then drop out of the map, so it
// can never grow with the session table.
const IDLE_KEY = 'idle';

// Injected by routes/sessions.js at router construction (it owns the pool
// and the module-local stopRegistry). Left unset in unit tests, where the
// notifier degrades to publishing without row metadata rather than
// requiring a database.
let _pool = null;
let _phaseResolver = null;
// Test seam: swapped for a collector in tests/session-state-broadcast.test.js.
let _publish = null;

function setPool(pool) {
  _pool = pool || null;
}

// fn(sessionId) -> { phase, stopping } — the same values
// GET /api/sessions/:id/status reports. A route-owned Map can't be
// imported here without a require cycle, so sessions.js registers a
// reader instead.
function setPhaseResolver(fn) {
  _phaseResolver = typeof fn === 'function' ? fn : null;
}

// Override the fan-out sink. Defaults to ws.pushSessionState (lazily
// required so this module stays importable in isolation).
function setPublisher(fn) {
  _publish = typeof fn === 'function' ? fn : null;
}

function publish(payload) {
  if (_publish) {
    _publish(payload);
    return;
  }
  try {
    require('./ws').pushSessionState(payload);
  } catch (err) {
    log.warn('session-state', 'publish failed', { err: err.message });
  }
}

// Is this session's observable state "nothing is happening"? Drives both
// the IDLE_KEY collapse and the reconcile endpoint's non-idle-only filter.
function isIdleState(state) {
  if (!state) return true;
  if (state.busy || state.stopping) return false;
  if (state.headless && state.headless.status === 'generating') return false;
  return true;
}

function stateKey(state) {
  if (isIdleState(state)) return IDLE_KEY;
  const hl = state.headless
    ? `${state.headless.status || ''}:${state.headless.outcome || ''}`
    : '';
  return [
    state.busy ? '1' : '0',
    state.phase || '',
    state.stopping ? '1' : '0',
    state.status || '',
    hl,
  ].join('|');
}

// The live in-memory facts about a session, with no database involved.
// Exported so the reconcile route derives its rows from exactly the same
// predicate the broadcasts use.
function liveState(sessionId) {
  const id = Number(sessionId);
  const { isSessionBusy } = require('./active-workers');
  let busy = false;
  try { busy = !!isSessionBusy(id); } catch { busy = false; }
  let phase = null;
  let stopping = false;
  if (_phaseResolver) {
    try {
      const r = _phaseResolver(id) || {};
      phase = r.phase || null;
      stopping = !!r.stopping;
    } catch { /* a status read must never break a broadcast */ }
  }
  return { busy, phase, stopping };
}

async function loadRow(sessionId) {
  if (!_pool) return null;
  try {
    const { rows } = await _pool.query(
      `SELECT cs.id, cs.app_id, cs.user_id, cs.status,
              (cs.shared_at IS NOT NULL) AS shared,
              cs.is_headless, cs.headless_status, cs.headless_outcome,
              cs.headless_issue_number,
              a.slug AS app_slug
         FROM chat_sessions cs
         JOIN apps a ON a.id = cs.app_id
        WHERE cs.id = $1`,
      [Number(sessionId)]
    );
    return rows[0] || null;
  } catch (err) {
    log.warn('session-state', 'row lookup failed', {
      sessionId, err: err.message,
    });
    return null;
  }
}

// Build the wire payload for one session from live memory + its row.
function buildPayload(sessionId, row, live) {
  const headless = (row && row.is_headless)
    ? {
      status: row.headless_status || null,
      outcome: row.headless_outcome || null,
      issueNumber: row.headless_issue_number != null
        ? Number(row.headless_issue_number) : null,
    }
    : null;
  return {
    sessionId: Number(sessionId),
    appId: row ? row.app_id : null,
    appSlug: row ? row.app_slug : null,
    userId: row ? row.user_id : null,
    busy: !!live.busy,
    phase: live.phase || null,
    stopping: !!live.stopping,
    status: row ? row.status : null,
    headless,
    // A headless auto-run is group-visible by design (its card renders on
    // everyone's board), so it fans out app-scoped like a shared session.
    shared: !!(row && (row.shared || row.is_headless)),
    at: Date.now(),
  };
}

// sessionId -> the recompute currently awaiting its row lookup. Recomputes
// for one session MUST NOT overlap: each reads `lastPublished`, and two
// interleaved ones can publish out of order under a slow database, leaving
// a client showing `busy` for a turn that already ended (until the next
// reconcile tick). Serializing per session is enough — different sessions
// are independent.
const inFlight = new Map();

function recompute(sessionId) {
  const id = Number(sessionId);
  const prior = inFlight.get(id) || Promise.resolve();
  const next = prior.catch(() => {}).then(() => recomputeOnce(id));
  inFlight.set(id, next);
  // Only clear when we're still the tail, so a queued successor isn't lost.
  next.catch(() => {}).finally(() => {
    if (inFlight.get(id) === next) inFlight.delete(id);
  });
  return next;
}

async function recomputeOnce(id) {
  // Read the live registries AFTER the queue clears, not before it — a
  // recompute queued behind another must reflect the state as of its turn.
  const live = liveState(id);
  const row = await loadRow(id);
  const payload = buildPayload(id, row, live);
  const key = stateKey(payload);
  const prev = lastPublished.get(id) || IDLE_KEY;
  if (key === prev) return null;
  if (key === IDLE_KEY) lastPublished.delete(id);
  else lastPublished.set(id, key);
  publish(payload);
  return payload;
}

// Coalescing entry point. Every in-memory mutation that could change a
// session's observable state funnels through here; at most one recompute
// runs per session per COALESCE_MS window.
function touch(sessionId) {
  const id = Number(sessionId);
  if (!Number.isFinite(id) || id <= 0) return;
  if (pending.has(id)) return;
  const t = setTimeout(() => {
    pending.delete(id);
    recompute(id).catch((err) => {
      log.warn('session-state', 'recompute failed', { sessionId: id, err: err.message });
    });
  }, COALESCE_MS);
  // A coalesce timer must never hold the process open (it also kept the
  // node:test runner alive past the last assertion).
  t.unref?.();
  pending.set(id, t);
}

// Test helper — drop all memory of what was published.
function _reset() {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  inFlight.clear();
  lastPublished.clear();
}

module.exports = {
  touch,
  liveState,
  isIdleState,
  buildPayload,
  setPool,
  setPhaseResolver,
  setPublisher,
  COALESCE_MS,
  _reset,
};
