// #4318: a session's live events are routed by session, not sent to every
// /ws/events socket on the platform.
//
//   * a `session_event` reaches the session owner's sockets and the sockets
//     that WATCH the session (a `watch_session` frame, answered with
//     `session_watch`), and nobody else;
//   * a watch succeeds only for a session the socket's user may open — its
//     owner or an admin, the rule GET /api/sessions/:id/events applies;
//   * the few events lists and boards draw (checks, previews) still reach
//     everyone who may VIEW the app, and nobody who may not;
//   * a socket whose send buffer is over the limit is skipped, then told to
//     re-read once it drains;
//   * the bus carries a run's stream in batches, not one NOTIFY per event.
//
// Real sockets against ws.attach, pool stubbed via require.cache — the same
// harness as tests/platform-version-push.test.js.
//
// Run with: node --test tests/ws-session-event-routing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocket } = require('ws');

const USERS = {
  owner: { user_id: 1, username: 'olive', is_admin: false },
  admin: { user_id: 2, username: 'ada', is_admin: true },
  stranger: { user_id: 3, username: 'sam', is_admin: false },
  member: { user_id: 4, username: 'mo', is_admin: false },
};
// session id -> owner and app. App 10 is public; app 20 is view-private with
// its owner and `member` as members.
const SESSIONS = {
  100: { user_id: 1, app_id: 10, app_slug: 'public-app' },
  200: { user_id: 1, app_id: 20, app_slug: 'private-app' },
};
const APPS = {
  10: { view_visibility: 'public', moderation_suspended_at: null },
  20: { view_visibility: 'private', moderation_suspended_at: null },
};

const notifies = [];
const fakePool = {
  async query(sql, params = []) {
    // Routing fixture only; real authorization SQL and revocation are
    // exercised against the full schema in ws-current-access-postgres.
    if (/FROM jsonb_to_recordset/.test(sql)) return { rows: JSON.parse(params[0]).map(d => {
      const user = USERS[d.token], session = SESSIONS[d.session_id];
      const appId = session?.app_id ?? d.app_id;
      const view = appId !== 20 || [1, 2, 4].includes(d.user_id);
      const own = session?.user_id === d.user_id;
      return { n: d.n, authenticated: !!user, username: user?.username, is_admin: !!user?.is_admin,
        session_owner: own, allowed: view && (d.session_id == null || !!session
          && (own || d.watching && user?.is_admin || d.fanout)) };
    }) };
    if (/SELECT id FROM users WHERE id = \$1/.test(sql)) return { rows: [{ id: params[0] }] };
    if (/pg_notify/.test(sql)) { notifies.push(params); return { rows: [] }; }
    if (/FROM sessions s JOIN users u/.test(sql)) {
      const user = USERS[params[0]];
      if (!user) return { rows: [] };
      return { rows: [{ ...user, expires_at: new Date(Date.now() + 3600e3).toISOString() }] };
    }
    if (/FROM chat_sessions cs LEFT JOIN apps/.test(sql)) {
      const row = SESSIONS[params[0]];
      return { rows: row ? [row] : [] };
    }
    if (/SELECT user_id FROM chat_sessions WHERE id = \$1/.test(sql)) {
      const row = SESSIONS[params[0]];
      return { rows: row ? [{ user_id: row.user_id }] : [] };
    }
    if (/SELECT view_visibility, moderation_suspended_at FROM apps WHERE id/.test(sql)) {
      const row = APPS[params[0]];
      return { rows: row ? [row] : [] };
    }
    if (/FROM app_collaborators/.test(sql)) {
      return { rows: Number(params[0]) === 20 ? [{ user_id: 1 }, { user_id: 4 }] : [] };
    }
    return { rows: [] };
  },
};

const poolPath = require.resolve('../src/db/pool');
require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: { getPool: () => fakePool },
};
delete require.cache[require.resolve('../src/services/ws')];

const ws = require('../src/services/ws');
const bus = require('../src/services/ws-bus');

let server;
let port;

test.before(async () => {
  const app = express();
  app.use(cookieParser());
  server = http.createServer(app);
  ws.attach(server, { jwtSecret: 'test-secret' });
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function openEvents(who) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, {
    headers: { cookie: `session=${who}` },
  });
  sock.received = [];
  sock.on('message', (raw) => { sock.received.push(JSON.parse(String(raw))); });
  return new Promise((resolve, reject) => {
    sock.on('open', () => resolve(sock));
    sock.on('error', reject);
  });
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

function sessionEvents(sock, sessionId) {
  return sock.received.filter((m) => m.type === 'session_event' && m.sessionId === sessionId);
}

async function watch(sock, sessionId, type = 'watch_session') {
  sock.send(JSON.stringify({ type, sessionId }));
  await settle();
  return sock.received.filter((m) => m.type === 'session_watch' && m.sessionId === sessionId).pop();
}

function progress(sessionId, text) {
  return { type: 'session_event', sessionId, event: 'cc_progress', text };
}

test('a run\'s progress reaches its owner and nobody else', async () => {
  const owner = await openEvents('owner');
  const stranger = await openEvents('stranger');
  const admin = await openEvents('admin');
  await settle();

  ws.broadcastGlobal(progress(100, 'npm test'));
  await settle();

  assert.equal(sessionEvents(owner, 100).length, 1, 'the owner sees their own run');
  assert.equal(sessionEvents(stranger, 100).length, 0, 'an unrelated socket hears nothing');
  assert.equal(sessionEvents(admin, 100).length, 0, 'not even an admin, until they watch it');
  for (const s of [owner, stranger, admin]) s.terminate();
});

test('a watch adds a socket to the audience, an unwatch takes it out', async () => {
  const admin = await openEvents('admin');
  await settle();

  const ack = await watch(admin, 100);
  assert.deepEqual(ack, { type: 'session_watch', sessionId: 100, watching: true });
  ws.broadcastGlobal(progress(100, 'line one'));
  await settle();
  assert.deepEqual(sessionEvents(admin, 100).map((m) => m.text), ['line one']);

  const off = await watch(admin, 100, 'unwatch_session');
  assert.equal(off.watching, false);
  ws.broadcastGlobal(progress(100, 'line two'));
  await settle();
  assert.deepEqual(sessionEvents(admin, 100).map((m) => m.text), ['line one'],
    'nothing after the screen left the session');
  admin.terminate();
});

test('a watch on a session the user may not open is refused, and hears nothing', async () => {
  const stranger = await openEvents('stranger');
  await settle();
  const ack = await watch(stranger, 100);
  assert.deepEqual(ack, { type: 'session_watch', sessionId: 100, watching: false, code: 'not_found' },
    'refused with the same answer as a session that does not exist');
  const missing = await watch(stranger, 999);
  assert.equal(missing.watching, false);

  ws.broadcastGlobal(progress(100, 'secret log line'));
  await settle();
  assert.equal(sessionEvents(stranger, 100).length, 0);
  stranger.terminate();
});

test('a ping is answered with a pong, on that socket alone', async () => {
  // The tab's check that an open socket still carries anything
  // (public/js/app.js _checkEvents): on a quiet network nothing closes it.
  const asker = await openEvents('stranger');
  const other = await openEvents('stranger');
  await settle();
  asker.send(JSON.stringify({ type: 'ping' }));
  await settle();
  assert.deepEqual(asker.received.filter((m) => m.type === 'pong'), [{ type: 'pong' }]);
  assert.equal(other.received.filter((m) => m.type === 'pong').length, 0);
  for (const s of [asker, other]) s.terminate();
});

test('the watch rule is the live stream\'s: owner or admin', () => {
  const row = { user_id: 1 };
  assert.equal(ws.canWatchSessionRow(row, { id: 1, isAdmin: false }), true);
  assert.equal(ws.canWatchSessionRow(row, { id: 2, isAdmin: true }), true);
  assert.equal(ws.canWatchSessionRow(row, { id: 3, isAdmin: false }), false);
  assert.equal(ws.canWatchSessionRow(null, { id: 1, isAdmin: true }), false);
  assert.equal(ws.canWatchSessionRow({ user_id: null }, { id: 3, isAdmin: false }), false);
});

test('frames per event do not grow with the number of connected users', async () => {
  const owner = await openEvents('owner');
  const crowd = await Promise.all(Array.from({ length: 12 }, () => openEvents('stranger')));
  await settle();
  for (let i = 0; i < 5; i++) ws.broadcastGlobal(progress(100, `step ${i}`));
  await settle();
  assert.equal(sessionEvents(owner, 100).length, 5);
  assert.equal(crowd.reduce((n, s) => n + sessionEvents(s, 100).length, 0), 0,
    'twelve more tabs open cost nothing per event');
  owner.terminate();
  for (const s of crowd) s.terminate();
});

test('checks and previews still reach everyone who may view the app', async () => {
  const stranger = await openEvents('stranger');
  await settle();
  ws.broadcastGlobal({ type: 'session_event', sessionId: 100, event: 'checks_ready', checkState: 'passed' });
  ws.broadcastGlobal({ type: 'session_event', sessionId: 100, event: 'staging_ready', url: 'https://x' });
  await settle();
  assert.deepEqual(sessionEvents(stranger, 100).map((m) => m.event), ['checks_ready', 'staging_ready'],
    'a board or proposal page on a public app still patches its row');
  stranger.terminate();
});

test('on a view-private app they reach members and the owner, not outsiders', async () => {
  const stranger = await openEvents('stranger');
  const member = await openEvents('member');
  const owner = await openEvents('owner');
  await settle();
  ws.broadcastGlobal({ type: 'session_event', sessionId: 200, event: 'checks_ready', checkState: 'failed' });
  await settle();
  assert.equal(sessionEvents(member, 200).length, 1);
  assert.equal(sessionEvents(owner, 200).length, 1, 'once, though the owner is in both audiences');
  assert.equal(sessionEvents(stranger, 200).length, 0);
  for (const s of [stranger, member, owner]) s.terminate();
});

test('the audience decision is per event type', () => {
  assert.equal(ws.sessionEventAudience({ event: 'cc_progress' }), 'session');
  assert.equal(ws.sessionEventAudience({ event: 'mayor_reasoning' }), 'session');
  assert.equal(ws.sessionEventAudience({ event: 'status' }), 'session');
  for (const e of ['checks_ready', 'staging_ready', 'staging_failed']) {
    assert.equal(ws.sessionEventAudience({ event: e }), 'app', e);
  }
});

test('a bus message replays the same routing against this pod\'s sockets', async () => {
  const owner = await openEvents('owner');
  const stranger = await openEvents('stranger');
  await settle();
  ws._onBusMessage({
    kind: 'session',
    routing: { sessionId: 100, userId: 1, appId: 10, appSlug: 'public-app', fanout: false },
    data: progress(100, 'from another pod'),
    oversize: false,
  });
  await settle();
  assert.equal(sessionEvents(owner, 100).length, 1);
  assert.equal(sessionEvents(stranger, 100).length, 0);
  owner.terminate();
  stranger.terminate();
});

test('a run\'s stream crosses the bus in batches, in order, not one NOTIFY each', async () => {
  // Let any earlier window close, so this run starts from a quiet spell.
  await settle(bus.BATCH_WINDOW_MS + 50);
  notifies.length = 0;
  for (let i = 0; i < 20; i++) ws.broadcastGlobal(progress(100, `burst ${i}`));
  await settle(bus.BATCH_WINDOW_MS + 100);
  const envelopes = notifies.map((p) => JSON.parse(p[1]));
  assert.ok(envelopes.length <= 2, `20 events cost ${envelopes.length} NOTIFYs`);
  const texts = envelopes.flatMap((env) => (env.k === 'batch' ? env.b.map((item) => item.d) : [env.d]))
    .map((d) => d.text);
  assert.deepEqual(texts, Array.from({ length: 20 }, (_, i) => `burst ${i}`), 'nothing dropped, order kept');
  for (const env of envelopes) {
    const items = env.k === 'batch' ? env.b : [{ k: env.k, r: env.r }];
    for (const item of items) {
      assert.equal(item.k, 'session');
      assert.equal(item.r.sessionId, 100);
      assert.equal(item.r.userId, 1, 'the resolved routing rides along');
    }
  }
});

test('a socket over the buffer limit is skipped, then told to re-read once', async () => {
  const sock = await openEvents('owner');
  await settle();
  const proto = Object.getPrototypeOf(sock);
  const original = Object.getOwnPropertyDescriptor(proto, 'bufferedAmount');
  let stuck = true;
  Object.defineProperty(proto, 'bufferedAmount', {
    configurable: true,
    get() {
      // Only the SERVER half of a socket is stuck.
      if (this._isServer && stuck) return ws.SLOW_CLIENT_MAX_BUFFERED + 1;
      return original.get.call(this);
    },
  });
  try {
    ws.broadcastGlobal({ type: 'app_status', slug: 'x' });
    ws.broadcastGlobal(progress(100, 'while stuck'));
    await settle();
    assert.equal(sock.received.filter((m) => m.type === 'app_status' || m.type === 'session_event').length, 0,
      'nothing more is piled into a buffer that is not draining');

    // Still stuck: no hint yet.
    ws._checkLaggingClients();
    await settle();
    assert.equal(sock.received.filter((m) => m.type === 'resync_hint').length, 0);

    stuck = false;
    ws._checkLaggingClients();
    ws._checkLaggingClients();
    await settle();
    assert.equal(sock.received.filter((m) => m.type === 'resync_hint').length, 1,
      'exactly one nudge once it drains — the reconnect path re-reads the screen');

    ws.broadcastGlobal(progress(100, 'after'));
    await settle();
    assert.deepEqual(sessionEvents(sock, 100).map((m) => m.text), ['after'], 'and delivery resumes');
  } finally {
    Object.defineProperty(proto, 'bufferedAmount', original);
    sock.terminate();
  }
});

// ── The client half ────────────────────────────────────────────────────

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const DEV_CHAT = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'), 'utf8');

test('the events socket re-sends every watch when it (re)opens', () => {
  const at = APP_JS.indexOf('App.eventsWs.onopen');
  const body = APP_JS.slice(at, APP_JS.indexOf('};', at));
  assert.match(body, /for \(const id of App\._watchedSessions\.keys\(\)\) App\._sendSessionWatch\('watch_session', id\)/);
});

test('DevChat\'s open session is what the tab watches', () => {
  assert.match(DEV_CHAT, /set currentSession\(session\) \{[\s\S]{0,200}window\.App\?\.setDevChatSession\?\.\(/,
    'every assignment — open, close, a test — reaches the socket');
  assert.match(APP_JS, /setDevChatSession\(sessionId\) \{[\s\S]{0,300}unwatchSession\(App\._devChatWatchedId, 'devchat'\)[\s\S]{0,200}watchSession\(id, 'devchat'\)/);
});
