'use strict';

// In-memory per-session event bus with a bounded replay buffer.
//
// Purpose: the chat handler streams progress/status events to the client
// over its POST SSE response. If that response dies mid-run (client
// navigation, proxy idle-kill, network blip), the client loses live
// visibility and the send button stays spinning until it falls back to
// /status polling.
//
// This bus gives us a second, resumable channel:
//   - The chat handler publishes every event it `send()`s into the bus.
//   - A separate GET /api/sessions/:id/events SSE endpoint subscribes.
//   - EventSource auto-reconnects on drop and sends Last-Event-Id, which
//     the endpoint uses to replay anything the client missed out of the
//     ring buffer.
//
// Scope: purely in-process. If the Node server restarts, the buffer is
// lost — that's fine because the on-disk progress log + /status polling
// already cover the server-restart case.

const MAX_EVENTS_PER_SESSION = 500;
// How long to keep a session's buffer around after its last event when
// no subscribers are attached. Long-lived enough that a client coming
// back after a brief network blip can replay, short enough that we
// don't leak memory on abandoned sessions.
const IDLE_TTL_MS = 5 * 60 * 1000;

// sessionId -> { events: [{_seq, ...}], subs: Set<cb>, idleTimer }
const buffers = new Map();

function getBuf(sessionId) {
  let b = buffers.get(sessionId);
  if (!b) {
    b = { events: [], subs: new Set(), idleTimer: null };
    buffers.set(sessionId, b);
  }
  if (b.idleTimer) { clearTimeout(b.idleTimer); b.idleTimer = null; }
  return b;
}

function scheduleCleanup(sessionId) {
  const b = buffers.get(sessionId);
  if (!b) return;
  if (b.subs.size > 0) return;
  if (b.idleTimer) clearTimeout(b.idleTimer);
  b.idleTimer = setTimeout(() => {
    const cur = buffers.get(sessionId);
    if (cur && cur.subs.size === 0) buffers.delete(sessionId);
  }, IDLE_TTL_MS);
  // A buffer-GC timer must not hold the process open (it also kept the
  // node:test runner alive for the full TTL after headless-run tests).
  b.idleTimer.unref();
}

// Publish an event to the session's bus. `event` MUST contain `_seq`
// (the same monotonic id the client uses to dedup across channels) so
// replay-after-reconnect works.
function publish(sessionId, event) {
  if (!event || !event._seq) return;
  const b = getBuf(sessionId);
  b.events.push(event);
  if (b.events.length > MAX_EVENTS_PER_SESSION) {
    b.events.splice(0, b.events.length - MAX_EVENTS_PER_SESSION);
  }
  for (const cb of b.subs) {
    try { cb(event); } catch {}
  }
  scheduleCleanup(sessionId);
}

// Subscribe to future events. If `sinceSeq` is provided, first replay
// every buffered event *after* that seq synchronously — mirroring the
// standard SSE Last-Event-Id contract.
//
// Returns an unsubscribe function.
function subscribe(sessionId, cb, sinceSeq) {
  const b = getBuf(sessionId);

  if (sinceSeq) {
    const idx = b.events.findIndex((e) => e._seq === sinceSeq);
    const replay = idx >= 0 ? b.events.slice(idx + 1) : b.events.slice();
    for (const e of replay) {
      try { cb(e); } catch {}
    }
  }

  b.subs.add(cb);
  return () => {
    b.subs.delete(cb);
    scheduleCleanup(sessionId);
  };
}

// The newest buffered event matching `predicate`, or null. Read-only: an
// unknown session gets no buffer. #3177 uses it to find a stored message's
// `accepted` event, whose `_seq` is where that turn's replay starts.
function findLast(sessionId, predicate) {
  const b = buffers.get(sessionId);
  if (!b) return null;
  for (let i = b.events.length - 1; i >= 0; i -= 1) {
    if (predicate(b.events[i])) return b.events[i];
  }
  return null;
}

// Chat handler calls this at the end of a run so we can drop the ring
// buffer promptly rather than waiting for the idle TTL.
function clearSession(sessionId) {
  const b = buffers.get(sessionId);
  if (!b) return;
  b.events = [];
  if (b.subs.size === 0) {
    if (b.idleTimer) clearTimeout(b.idleTimer);
    buffers.delete(sessionId);
  }
}

// How many listeners are following a session's bus right now (an open
// conversation screen follows its agent session's). Zero for an unknown key.
function subscriberCount(sessionId) {
  const b = buffers.get(sessionId);
  return b ? b.subs.size : 0;
}

module.exports = { publish, subscribe, findLast, clearSession, subscriberCount };
