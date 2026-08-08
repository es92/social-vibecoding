'use strict';

// Shared in-flight worker registry.
//
// This Set tracks sessions whose Claude Code worker is mid-exec right
// now. It used to live as a module-local `const activeWorkers = new Set()`
// inside routes/sessions.js, but the sync-main flow (now extracted into
// services/sync-main.js so the conflict-resolver can drive it without a
// route-requires-route cycle) also needs to add/remove from the same
// registry. Hoisting it into this tiny shared module keeps a single
// process-wide instance that both the route handlers and the service
// share — server.js's graceful-shutdown drain (getActiveWorkerCount)
// reads the same Set the chat handler and sync turns write to.
// #1038: every mutation of this Set is a turn-boundary that some client
// surface wants to know about (the header cog, the Dev board's session
// cards). There are ~15 direct `.add()` / `.delete()` call sites across
// routes/sessions.js and services/sync-main.js, so rather than sprinkle a
// broadcast at each one — and miss the next one somebody adds — the Set
// itself notifies. `session-state` coalesces and only publishes when the
// derived state actually changed, so the add()/inFlight pair at a turn's
// start is still one event. Lazy require: session-state pulls this module
// back in for isSessionBusy.
function notifySessionState(sessionId) {
  try {
    require('./session-state').touch(sessionId);
  } catch { /* notifier is best-effort; never break turn bookkeeping */ }
}

class ActiveWorkerSet extends Set {
  add(sessionId) {
    const had = this.has(sessionId);
    const out = super.add(sessionId);
    if (!had) notifySessionState(sessionId);
    return out;
  }

  delete(sessionId) {
    const out = super.delete(sessionId);
    if (out) notifySessionState(sessionId);
    return out;
  }
}

const activeWorkers = new ActiveWorkerSet();
const activeSessionOperations = new Map();

// Register non-worker operations that must not overlap a coding turn (for
// example, adopting and checking an exact commit submitted by a local agent).
// Reference counts make independent callers safe, and the returned release
// closure is idempotent so every owner can clean up in a finally block.
function beginSessionOperation(sessionId) {
  const key = Number(sessionId);
  const prior = activeSessionOperations.get(key) || 0;
  activeSessionOperations.set(key, prior + 1);
  // Only the 0→1 edge changes the session's observable busy state; nested
  // operations on an already-busy session are invisible to clients.
  if (prior === 0) notifySessionState(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeSessionOperations.get(key) || 1) - 1;
    if (remaining > 0) activeSessionOperations.set(key, remaining);
    else {
      activeSessionOperations.delete(key);
      notifySessionState(key);
    }
  };
}

function hasSessionOperation(sessionId) {
  return activeSessionOperations.has(Number(sessionId));
}

function getActiveWorkerCount() {
  return new Set([...activeWorkers, ...activeSessionOperations.keys()]).size;
}

// Shared "any part of a turn is running" predicate — the same one the
// /api/sessions/:id/status endpoint and the session-list routes use.
// `activeWorkers` covers the chat handler's full window (added before
// ensureWorker, deleted in run(Scout|ClaudeCode)Tool's finally — i.e.
// including the post-exec PR/staging tail) plus the restart-recovery
// flows; `worker.isInFlight` covers the inner docker-exec window. The
// auto-pause / staging-GC sweepers in server.js MUST use this instead
// of the bare isInFlight, or they can tear a session down mid-wrap-up
// (the sessions 2391/2386 incident).
function isSessionBusy(sessionId) {
  if (hasSessionOperation(sessionId)) return true;
  // Lazy require: worker.js is pulled in by the route layer that also
  // requires this module — a top-level require here would be a cycle.
  const worker = require('./worker');
  return activeWorkers.has(sessionId) || worker.isInFlight(sessionId);
}

module.exports = {
  activeWorkers,
  beginSessionOperation,
  hasSessionOperation,
  getActiveWorkerCount,
  isSessionBusy,
  notifySessionState,
};
