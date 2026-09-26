'use strict';

// #1378: the process-wide registry of per-session stop handles.
//
// This used to be a `const stopRegistry = new Map()` living inside
// src/routes/sessions.js, populated only by POST /chat. That worked for the
// happy path — the same module that started a turn also served POST /stop —
// but it made the handle unreachable from anywhere else in the process.
//
// The failure it caused (production session 3539, adopted at a blue-green
// cutover and then unstoppable for 36 minutes): a turn that is ADOPTED after
// a restart is resumed by server.js's resumeDetachedTurn, not by the chat
// route, so no handle was ever registered for it. POST /stop looked the
// session up, found nothing, classified the request 'no_active_turn' and
// answered `{ ok: true, stopped: false }` — while GET /status still reported
// `busy: true`, so the client painted a live red Stop button that did
// nothing. server.js cannot require the routes module to register a handle
// (routes → server is a require cycle), so the registry moves here: a leaf
// service both sides can depend on.
//
// Handle shape:
//   {
//     abort: AbortController,       // aborts the in-flight Mayor stream
//     workerName: string|null,      // container to kill, when known
//     phase: 'mayor1'|'cc'|'mayor2',
//     stopped: boolean,             // the user has asked for this to end
//     stoppedBy: string|null,
//     stopRequestedAt: number|null, // ms epoch, for the client's ladder
//     confirming: boolean,          // a confirmStopLanded loop is running
//     send: (type, data) => void,   // fan-out to this session's listeners
//     userMessageId: number|null,   // #3177: the stored message a chat turn
//                                   // answers (absent on an adopted turn)
//   }
//
// Phase 'mayor2' is intentionally stop-proof — by then the coding agent has
// already pushed a commit and opened a PR, and we just want the summary of
// those real changes to finish.

const sessionState = require('./session-state');

const registry = new Map();

function get(sessionId) {
  return registry.get(Number(sessionId));
}

function set(sessionId, handle) {
  registry.set(Number(sessionId), handle);
  return handle;
}

// Identity-guarded delete. Every caller that clears a handle does so from a
// `finally` that may run long after a NEWER turn has registered its own
// handle for the same session; deleting unconditionally there would strand
// the new turn exactly as the bug above did. Returns whether it deleted.
function deleteIf(sessionId, handle) {
  const id = Number(sessionId);
  if (handle && registry.get(id) === handle) {
    registry.delete(id);
    return true;
  }
  return false;
}

// Build a handle with the default field set filled in, so the two call sites
// (POST /chat and the detached-turn recovery path) cannot drift apart on
// which fields exist.
function createHandle({ sessionId, phase = 'mayor1', workerName = null, send = null, abort = null } = {}) {
  return {
    sessionId: sessionId == null ? null : Number(sessionId),
    abort: abort || new AbortController(),
    workerName,
    phase,
    stopped: false,
    stoppedBy: null,
    stopRequestedAt: null,
    confirming: false,
    send: send || (() => {}),
  };
}

// Test seam.
function _reset() {
  registry.clear();
}

// #1038: the live session-state notifier reports `phase` / `stopping`
// alongside `busy`. It reads them through this resolver rather than
// importing the registry, which keeps the dependency pointing one way.
sessionState.setPhaseResolver((sessionId) => {
  const handle = get(sessionId);
  if (!handle) return { phase: null, stopping: false };
  return { phase: handle.phase || null, stopping: !!handle.stopped };
});

module.exports = {
  get,
  set,
  deleteIf,
  createHandle,
  _reset,
  _registry: registry,
};
