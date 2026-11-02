'use strict';

// The /ws/events socket on a quiet network (offline test, 2 Nov 2026): a
// network that passes nothing never closes a socket, so a handshake hung in
// CONNECTING and an open socket gone silent were never noticed, nothing
// nudged the connectivity probe, and the fixed 3 s retry only ran after a
// close that never came. public/js/app.js now gives a socket up when it does
// not open in time or stops answering its `ping`, retries with backoff, and
// follows the probe both ways.
//
// Driven through the real App.connectEvents in a vm sandbox with a fake
// WebSocket and a hand-turned clock. The server half (`ping` answered with
// `pong`) is tests/ws-session-event-routing.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

function clockwork() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, Number(ms) || 0), fn });
      return seq;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (!next || timer.at < next[1].at)) next = [id, timer];
        }
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

function makeApp() {
  const clock = clockwork();
  const sockets = [];
  function FakeWebSocket(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    sockets.push(this);
  }
  FakeWebSocket.prototype.send = function send(data) { this.sent.push(JSON.parse(data)); };
  FakeWebSocket.prototype.close = function close() { this.closed = true; this.readyState = 3; };
  class FakeDate extends Date {
    static now() { return clock.now(); }
  }
  const nudges = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    Date: FakeDate,
    URLSearchParams,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    location: { search: '', protocol: 'https:', host: 'app.example' },
    document: { visibilityState: 'visible', addEventListener() {}, querySelectorAll() { return []; } },
    WebSocket: FakeWebSocket,
    Offline: { nudge() { nudges.push(clock.now()); }, isOffline: () => false },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const App = sandbox.window.App;
  let resyncs = 0;
  const realResync = App.resyncCurrentView;
  App._syncViewer = () => {};
  App.loadVersion = () => {};
  App.resyncCurrentView = function resync() { resyncs += 1; return realResync.call(App); };
  const open = (socket = sockets.at(-1)) => { socket.readyState = 1; socket.onopen(); };
  const frame = (data, socket = sockets.at(-1)) => socket.onmessage({ data: JSON.stringify(data) });
  return { App, clock, sockets, nudges, sandbox, open, frame, get resyncs() { return resyncs; } };
}

test('a handshake that never completes is given up, and retried with backoff', () => {
  const h = makeApp();
  h.App.connectEvents();
  assert.equal(h.sockets.length, 1);
  h.clock.advance(9_999);
  assert.equal(h.sockets[0].closed, false, 'not before the connect limit');
  h.clock.advance(1);
  assert.equal(h.sockets[0].closed, true, 'given up at the connect limit');
  assert.equal(h.sockets[0].onclose, null, 'and detached: a late close cannot start a second retry');
  assert.equal(h.nudges.length, 1, 'the probe is nudged, as a close does');

  // Delays double from 3 s and stop at 30 s (Math.random is fixed at the
  // middle of the jitter, so each delay is its step).
  const delays = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const before = h.sockets.length;
    let waited = 0;
    while (h.sockets.length === before) { h.clock.advance(100); waited += 100; }
    delays.push(waited);
    h.clock.advance(10_000); // the new handshake hangs too
  }
  assert.deepEqual(delays, [3000, 6000, 12000, 24000, 30000, 30000]);
});

test('an open socket that goes silent is given up after its ping goes unanswered', () => {
  const h = makeApp();
  h.App.connectEvents();
  h.open();
  const socket = h.sockets[0];
  assert.deepEqual(socket.sent, [{ type: 'ping' }], 'it asks at once whether the server answers');
  h.frame({ type: 'pong' });
  h.clock.advance(20_000);
  h.frame({ type: 'notifications_changed' });
  h.clock.advance(24_999);
  assert.equal(socket.sent.length, 1, 'any frame counts as alive: no ping before 25 s of quiet');
  h.clock.advance(1);
  assert.deepEqual(socket.sent.at(-1), { type: 'ping' });
  h.frame({ type: 'pong' });
  h.clock.advance(25_000);
  assert.equal(socket.sent.length, 3, 'answered, so asked again after the next quiet spell');
  h.clock.advance(9_999);
  assert.equal(socket.closed, false);
  h.clock.advance(1);
  assert.equal(socket.closed, true, 'nothing at all for 10 s after a ping: given up');
  assert.equal(h.nudges.length, 2, 'the open nudge, then the loss');
  h.clock.advance(3_000);
  assert.equal(h.sockets.length, 2, 'and tried again');
  h.open();
  assert.equal(h.resyncs, 1, 'the new socket re-reads the screen');
  assert.equal(h.App._eventsFailures, 0, 'an open starts the backoff again from 3 s');
});

test('a server that never answered a ping is not held to one', () => {
  const h = makeApp();
  h.App.connectEvents();
  h.open();
  h.clock.advance(5 * 60_000);
  assert.equal(h.sockets[0].closed, false, 'a build from before pings, mid-rollout, keeps its socket');
  assert.ok(h.sockets[0].sent.length > 1, 'it is still asked now and then');
  assert.equal(h.sockets.length, 1);
});

test('a hidden tab is not asked', () => {
  const h = makeApp();
  h.App.connectEvents();
  h.open();
  h.frame({ type: 'pong' });
  h.sandbox.document.visibilityState = 'hidden';
  h.clock.advance(2 * 60_000);
  assert.equal(h.sockets[0].sent.length, 1, 'only the ping it sent when it opened');
  assert.equal(h.sockets[0].closed, false);
  h.sandbox.document.visibilityState = 'visible';
  h.clock.advance(25_000);
  assert.equal(h.sockets[0].sent.length, 2, 'asked again once it is seen');
});

test('a closed socket retries with the same backoff', () => {
  const h = makeApp();
  h.App.connectEvents();
  h.open();
  const first = h.sockets[0];
  first.readyState = 3;
  first.onclose();
  assert.equal(h.nudges.length, 2, 'the open nudge, then the close');
  h.clock.advance(2_999);
  assert.equal(h.sockets.length, 1);
  h.clock.advance(1);
  assert.equal(h.sockets.length, 2, 'one retry, after 3 s');
  // That retry hangs: given up at 10 s, the next waits 6 s, then 12 s.
  h.clock.advance(10_000 + 6_000);
  assert.equal(h.sockets.length, 3);
  h.clock.advance(10_000 + 11_999);
  assert.equal(h.sockets.length, 3, 'backing off, not piling up');
  h.clock.advance(1);
  assert.equal(h.sockets.length, 4);
  assert.equal(first.onclose, null, 'a replaced socket is detached: it starts nothing more');
});

test('the probe saying the network is back starts a waiting socket over at once', () => {
  const h = makeApp();
  h.App.connectEvents();
  h.open();
  h.frame({ type: 'pong' });
  h.sockets[0].readyState = 3;
  h.sockets[0].onclose();
  h.clock.advance(3_000);
  h.clock.advance(10_000); // that retry hangs, and the next one waits 6 s
  assert.equal(h.sockets.length, 2);
  h.App._eventsNetworkChanged(false);
  assert.equal(h.sockets.length, 3, 'no waiting out the delay');
  h.open();
  assert.equal(h.resyncs, 1, 'its open re-reads the screen');
  h.App._eventsNetworkChanged(false);
  assert.equal(h.resyncs, 1, 'and the same return, heard again, re-reads nothing more');
});

test('a socket that never opened before the return still re-reads the screen when it does', () => {
  const h = makeApp();
  h.App.connectEvents();
  h.App._eventsNetworkChanged(false);
  assert.equal(h.sockets.length, 2, 'the handshake begun on the dead network starts over');
  assert.equal(h.sockets[0].closed, true);
  h.open();
  assert.equal(h.resyncs, 1);
});

test('back online with the socket still open re-reads the screen, once', () => {
  const h = makeApp();
  h.App.connectEvents();
  h.open();
  h.frame({ type: 'pong' });
  h.clock.advance(20_000);
  h.App._eventsNetworkChanged(false);
  assert.equal(h.resyncs, 1, 'reads made while the network was gone are made again');
  h.clock.advance(1_000);
  h.App._eventsNetworkChanged(false);
  assert.equal(h.resyncs, 1, 'within the settle window, not twice');
  assert.equal(h.sockets.length, 1, 'an open socket is kept');
});

test('the probe going offline asks an open socket at once', () => {
  const h = makeApp();
  h.App.connectEvents();
  h.open();
  h.frame({ type: 'pong' });
  h.clock.advance(5_000);
  h.App._eventsNetworkChanged(true);
  assert.equal(h.sockets[0].sent.length, 2);
  h.clock.advance(10_000);
  assert.equal(h.sockets[0].closed, true, 'a dead socket is found in 10 s, not 35');
});

test('the offline-change listener feeds the socket both ways', () => {
  const listener = SRC.slice(SRC.indexOf("window.addEventListener('usernode:offline-change', (e) => {"));
  const body = listener.slice(0, listener.indexOf('});'));
  assert.match(body, /if \(e\.detail && e\.detail\.offline === false\) App\._reconcileSession\(\);/);
  assert.match(body, /if \(e\.detail\) App\._eventsNetworkChanged\(e\.detail\.offline === true\);/);
});
