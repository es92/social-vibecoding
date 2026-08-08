// Live session working-state store (#1038).
//
// One place that knows "is a turn in flight for session N right now", shared
// by every surface that shows it: the header cog + its drawer
// (work-drawer.js), the Dev board's In-progress session cards and its issue
// cards' auto-run state (app-view.js), and the per-app session list
// (dev-chat.js).
//
// Before this store, each of those re-fetched a full payload on its own
// timer — 15s for the drawer (and only while it ALREADY thought work was in
// flight, which is why the cog never started spinning), 15s for the board,
// 8s for the auto-run cards. Now the server pushes a `session_state` event
// on every real transition (services/session-state.js) and the surfaces
// repaint from here.
//
// Two channels out, deliberately:
//   subscribe(cb) — coalesced to one call per frame. For repaints: a burst
//                   of events must not cause a burst of innerHTML rewrites.
//   onEvent(cb)   — raw and immediate. For patching cached data that isn't
//                   keyed by session id (the issue cards' `headless` field),
//                   which has to happen BEFORE the repaint reads it.
//
// The correctness rule that makes the phantom spinner go away: a live entry
// is never dropped merely because the session went idle, and it is never
// overwritten by an OLDER fetch. `seed()` folds in the `busy` flags the
// ordinary list endpoints already return, but only where the request was
// issued after the last thing we were told live — otherwise a slow
// /api/me/active-sessions response would resurrect the spinner for a turn
// that finished while it was in flight. Entries persist until reconcile()
// replaces them (MAX_ENTRIES is only a leak backstop).

const SessionState = {
  // sessionId -> { busy, phase, stopping, status, headless, at }
  entries: new Map(),

  // The platform process the live entries describe. Busy state is in-process
  // memory server-side, so a restart or a blue-green cutover invalidates
  // everything we hold — a changed bootId clears the store rather than
  // leaving a spinner running for a turn that died with the old process.
  bootId: null,

  lastSyncAt: 0,
  _syncing: null,
  _subs: [],
  _eventSubs: [],
  _notifyQueued: false,
  _tickTimer: null,

  // Hard cap on retained entries, purely as a leak backstop. Idle overrides
  // are deliberately NOT aged out: this change removed the polls that used
  // to keep the fetched rows fresh, so falling back to a row's own `busy`
  // flag after dropping its override would mean falling back to something
  // arbitrarily stale — the exact phantom spinner the feature exists to
  // kill. In practice the map holds one entry per session in the viewer's
  // lists (tens), and reconcile() replaces the non-idle set wholesale, so
  // this ceiling is never reached; when it is, the oldest IDLE entries go
  // first and anything in flight is never evicted.
  MAX_ENTRIES: 500,
  // Safety reconcile cadence. This is the ONLY remaining timer for session
  // state and replaces three faster ones, so it is a net reduction even
  // before counting the pushed events.
  TICK_BUSY_MS: 60 * 1000,
  TICK_IDLE_MS: 5 * 60 * 1000,
  // How stale the last reconcile may be before a foregrounding tab forces
  // one. Short enough that returning to a tab feels instant, long enough
  // that alt-tabbing repeatedly doesn't spam the endpoint.
  FOREGROUND_STALE_MS: 30 * 1000,

  // ----- reads -----

  // The one accessor every renderer uses. `fallback` is the `busy` flag from
  // whatever list payload the row came from; a live entry always wins.
  isBusy(sessionId, fallback) {
    const e = SessionState.entries.get(Number(sessionId));
    return e ? !!e.busy : !!fallback;
  },

  // Live entry for a session, or null. Callers that need phase/stopping.
  get(sessionId) {
    return SessionState.entries.get(Number(sessionId)) || null;
  },

  // Is anything at all in flight right now (per the live overrides)? Drives
  // the adaptive tick cadence.
  anyActive() {
    for (const e of SessionState.entries.values()) {
      if (e.busy || e.stopping) return true;
      if (e.headless && e.headless.status === 'generating') return true;
    }
    return false;
  },

  // ----- writes -----

  _put(sessionId, next) {
    const id = Number(sessionId);
    if (!Number.isFinite(id)) return false;
    const prev = SessionState.entries.get(id);
    // `at` is bookkeeping, not state — comparing it would make every event a
    // change and repaint the board on each heartbeat.
    if (prev
      && !!prev.busy === !!next.busy
      && !!prev.stopping === !!next.stopping
      && (prev.phase || null) === (next.phase || null)
      && (prev.status || null) === (next.status || null)
      && SessionState._sameHeadless(prev.headless, next.headless)) {
      prev.at = next.at;
      return false;
    }
    SessionState.entries.set(id, next);
    return true;
  },

  _sameHeadless(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (a.status || null) === (b.status || null)
      && (a.outcome || null) === (b.outcome || null)
      && (a.issueNumber || null) === (b.issueNumber || null);
  },

  _isIdleEntry(e) {
    if (!e) return true;
    if (e.busy || e.stopping) return false;
    if (e.headless && e.headless.status === 'generating') return false;
    return true;
  },

  // Leak backstop only — see MAX_ENTRIES. Evicts the oldest IDLE entries;
  // an entry describing work in flight is never dropped, however old (a
  // long-running turn must keep its spinner).
  _prune() {
    const over = SessionState.entries.size - SessionState.MAX_ENTRIES;
    if (over <= 0) return;
    const idle = [...SessionState.entries]
      .filter(([, e]) => SessionState._isIdleEntry(e))
      .sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < over && i < idle.length; i++) {
      SessionState.entries.delete(idle[i][0]);
    }
  },

  // A pushed `session_state` message from /ws/events.
  applyEvent(payload) {
    if (!payload || payload.sessionId == null) return;
    const at = Date.now();
    const changed = SessionState._put(payload.sessionId, {
      busy: !!payload.busy,
      phase: payload.phase || null,
      stopping: !!payload.stopping,
      status: payload.status || null,
      headless: payload.headless || null,
      at,
    });
    SessionState._prune();
    // Raw subscribers run even when the derived state matched, because they
    // may key off fields the store doesn't model (an auto-run's outcome
    // landing on an issue card).
    for (const cb of SessionState._eventSubs) {
      try { cb(payload); } catch (err) { console.warn('[session-state] event handler failed', err); }
    }
    if (changed) SessionState.notify();
    SessionState._syncTick();
  },

  // Fold the `busy` flags an ordinary list payload already carries into the
  // store, so the first paint after a navigation is correct without waiting
  // for a reconcile.
  //
  // `issuedAt` MUST be when the request went OUT, not when the response
  // landed — that is what the payload is a snapshot of. Stamping it with
  // the arrival time inverts the precedence rule below: a response that was
  // in flight while the turn finished would be "newer" than the idle event
  // that overtook it, and would put the spinner straight back. Call sites
  // capture `Date.now()` before their fetch and pass it here.
  seed(rows, issuedAt) {
    if (!Array.isArray(rows) || !rows.length) return;
    const at = issuedAt || Date.now();
    let changed = false;
    for (const row of rows) {
      if (!row || row.id == null) continue;
      const existing = SessionState.entries.get(Number(row.id));
      if (existing && existing.at > at) continue;
      if (SessionState._put(row.id, {
        busy: !!row.busy,
        phase: existing ? existing.phase : null,
        stopping: existing ? !!existing.stopping : false,
        status: row.status || (existing ? existing.status : null) || null,
        headless: existing ? existing.headless : null,
        at,
      })) changed = true;
    }
    SessionState._prune();
    if (changed) SessionState.notify();
  },

  // Replace the whole override set from GET /api/me/session-state. The
  // response carries NON-IDLE rows only, so anything we hold that isn't in it
  // is now idle — recorded as an explicit idle override (not a deletion) so a
  // stale list response can't bring its spinner back.
  reconcile(snapshot) {
    if (!snapshot) return;
    const at = Date.now();
    let changed = false;

    if (snapshot.bootId && SessionState.bootId && snapshot.bootId !== SessionState.bootId) {
      // The platform restarted (or a blue-green cutover swapped colors).
      // Every live entry described the old process's memory.
      changed = SessionState.entries.size > 0;
      SessionState.entries.clear();
    }
    if (snapshot.bootId) SessionState.bootId = snapshot.bootId;

    const seen = new Set();
    for (const row of (snapshot.sessions || [])) {
      if (!row || row.id == null) continue;
      seen.add(Number(row.id));
      if (SessionState._put(row.id, {
        busy: !!row.busy,
        phase: row.phase || null,
        stopping: !!row.stopping,
        status: row.status || null,
        headless: row.headless || null,
        at,
      })) changed = true;
    }
    for (const [id, e] of SessionState.entries) {
      if (seen.has(id)) continue;
      if (SessionState._isIdleEntry(e)) continue;
      if (SessionState._put(id, {
        busy: false, phase: null, stopping: false,
        status: e.status || null,
        // Keep a terminal auto-run outcome if we have one; only the
        // "generating" liveness is being cleared here.
        headless: e.headless && e.headless.status === 'generating'
          ? { ...e.headless, status: null } : (e.headless || null),
        at,
      })) changed = true;
    }

    SessionState.lastSyncAt = at;
    SessionState._prune();
    if (changed) SessionState.notify();
    SessionState._syncTick();
  },

  // ----- subscriptions -----

  subscribe(cb) {
    if (typeof cb !== 'function') return () => {};
    SessionState._subs.push(cb);
    return () => {
      const i = SessionState._subs.indexOf(cb);
      if (i >= 0) SessionState._subs.splice(i, 1);
    };
  },

  onEvent(cb) {
    if (typeof cb !== 'function') return () => {};
    SessionState._eventSubs.push(cb);
    return () => {
      const i = SessionState._eventSubs.indexOf(cb);
      if (i >= 0) SessionState._eventSubs.splice(i, 1);
    };
  },

  // Coalesced to one flush per frame (or per macrotask where rAF is absent —
  // a hidden tab, or the vm sandbox the tests run in).
  notify() {
    if (SessionState._notifyQueued) return;
    SessionState._notifyQueued = true;
    const flush = () => {
      SessionState._notifyQueued = false;
      for (const cb of SessionState._subs.slice()) {
        try { cb(); } catch (err) { console.warn('[session-state] subscriber failed', err); }
      }
    };
    if (typeof requestAnimationFrame === 'function' && !(typeof document !== 'undefined' && document.hidden)) {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 0);
    }
  },

  // ----- reconcile fetch -----

  // ?demo=1 forwarding, same convention as AppView._demoQS / WorkDrawer._demoQS:
  // the staging demo rows must survive a reconcile or the first tick would
  // wipe every mock spinner off the board.
  _params() {
    const p = new URLSearchParams();
    try {
      // window.App, not the bareword: this file loads BEFORE app.js, so a
      // bare `App` would be a temporal-dead-zone ReferenceError if anything
      // ever called sync() during boot.
      const slug = (typeof window !== 'undefined' && window.App && window.App.currentApp)
        ? window.App.currentApp : null;
      if (slug) p.set('app', slug);
      if (new URLSearchParams(location.search).get('demo') === '1') p.set('demo', '1');
    } catch { /* non-browser context */ }
    const qs = p.toString();
    return qs ? `?${qs}` : '';
  },

  // Single-flight: concurrent callers (a reconnect and a foreground arriving
  // together) share one request.
  async sync() {
    if (SessionState._syncing) return SessionState._syncing;
    SessionState._syncing = (async () => {
      try {
        const res = await fetch(`/api/me/session-state${SessionState._params()}`);
        if (!res.ok) return null;
        const data = await res.json();
        SessionState.reconcile(data);
        return data;
      } catch {
        // A failed reconcile leaves the previous snapshot in place; the next
        // tick (or the next pushed event) recovers.
        return null;
      } finally {
        SessionState._syncing = null;
      }
    })();
    return SessionState._syncing;
  },

  // Adaptive safety tick: faster while something is in flight, slow when
  // idle, and never while the tab is hidden (the foreground handler in
  // app.js covers the return).
  _syncTick() {
    if (typeof setTimeout !== 'function') return;
    const delay = SessionState.anyActive()
      ? SessionState.TICK_BUSY_MS : SessionState.TICK_IDLE_MS;
    if (SessionState._tickTimer) clearTimeout(SessionState._tickTimer);
    SessionState._tickTimer = setTimeout(() => {
      SessionState._tickTimer = null;
      if (typeof document !== 'undefined' && document.hidden) {
        SessionState._syncTick();
        return;
      }
      SessionState.sync().finally(() => SessionState._syncTick());
    }, delay);
  },

  // Called once from app.js's boot path.
  start() {
    SessionState.sync().finally(() => SessionState._syncTick());
  },

  // Foreground / reconnect entry point: only reconcile when what we hold
  // could plausibly have gone stale.
  syncIfStale(maxAgeMs) {
    const max = maxAgeMs == null ? SessionState.FOREGROUND_STALE_MS : maxAgeMs;
    if (Date.now() - SessionState.lastSyncAt < max) return Promise.resolve(null);
    return SessionState.sync();
  },

  // Test helper.
  _reset() {
    SessionState.entries.clear();
    SessionState.bootId = null;
    SessionState.lastSyncAt = 0;
    SessionState._subs = [];
    SessionState._eventSubs = [];
    SessionState._notifyQueued = false;
    if (SessionState._tickTimer) clearTimeout(SessionState._tickTimer);
    SessionState._tickTimer = null;
  },
};

if (typeof window !== 'undefined') window.SessionState = SessionState;
