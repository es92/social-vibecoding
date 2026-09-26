'use strict';

// #3177: confirming chat delivery when the stream drops early
// (src/services/chat-delivery.js, POST /api/sessions/:id/chat and
// GET /api/sessions/:id/status in src/routes/sessions.js).
//
// A client on a slow network lost the chat's SSE stream a few hundred bytes
// in and reported a failed send while the agent was already working on the
// message. Pinned here, against the real routes over a recording pool (the
// tests/chat-repo-less-turn.test.js harness; its repo-less session ends the
// turn at once, which keeps every request short):
//
//   1. the stream's first event is `accepted`, carrying the stored message id
//      and the client's id. It is published on the session bus, so
//      /events?since=<its _seq> replays the rest of the turn, and never on the
//      global WS;
//   2. a retry with the same client_message_id answers with that message's
//      `accepted` event (duplicate, with its state) and starts nothing: no
//      insert, no billing, no turn. Two retries racing past the lookup end
//      the same way through the insert's ON CONFLICT;
//   3. a malformed id is a 400 before anything is stored;
//   4. GET /status?client_message_id= answers `delivery`, and a poll that
//      does not ask gets the payload it always got.
//
// tests/chat-delivery-postgres.test.js runs the same flow against the real
// schema. Run with: node --test tests/chat-delivery-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql: String(sql), params });
    return poolQueryHandler(sql, params);
  },
});

const limits = require('../src/services/limits');
let billingCalls = 0;
limits.resolveBillingPath = async () => {
  billingCalls += 1;
  return { apiKey: null };
};

const sessionTitles = require('../src/services/session-title');
sessionTitles.maybeTitleFirstMessage = () => {};
sessionTitles.refreshFromHistory = () => {};

const ws = require('../src/services/ws');
let broadcasts = [];
ws.broadcastGlobal = (payload) => { broadcasts.push(payload); };

const sessionBus = require('../src/services/session-bus');
const stopRegistry = require('../src/services/stop-registry');
const chatDelivery = require('../src/services/chat-delivery');
const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };
const SESSION_ID = 3177;
const CLIENT_ID = 'c0ffee00-3177-4d1e-9f00-000000000001';

const SESSION_ROW = {
  id: SESSION_ID,
  app_id: 494,
  user_id: 7,
  branch_name: 'dev/tester-1',
  status: 'active',
  is_headless: false,
  session_title: 'Existing title',
  pr_number: null,
  cc_session_id: null,
  app_slug: 'mypage-777ed2',
  app_name: 'MyPage',
  repo_url: null, // the turn ends at once with a status row and `done`
  app_self_hosted: false,
  collab_visibility: 'public',
  view_visibility: 'public',
};

const isLookup = (sql) => /m\.client_message_id = \$2/.test(sql);
const isUserInsert = (sql) => /INSERT INTO chat_session_messages/.test(sql) && /'user'/.test(sql);

// `lookup` answers the delivery lookup (called with its 1-based call count);
// `insert` answers the user-message insert.
function installHandlers({ lookup = () => [], insert = () => [{ id: 1001 }] } = {}) {
  capturedQueries = [];
  billingCalls = 0;
  broadcasts = [];
  let lookups = 0;
  poolQueryHandler = async (sql) => {
    const s = String(sql);
    if (isLookup(s)) { lookups += 1; return { rows: lookup(lookups) }; }
    if (/FROM chat_sessions cs/.test(s)) return { rows: [{ ...SESSION_ROW }] };
    if (isUserInsert(s)) return { rows: insert() };
    return { rows: [] };
  };
}

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({ jwtSecret: 's' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function parseSse(body) {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)));
}

async function post(server, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${SESSION_ID}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

async function status(server, query = '') {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${SESSION_ID}/status${query}`);
  return { status: res.status, body: await res.json() };
}

// Every test mocks setTimeout (each turn exit schedules a 30s bus cleanup)
// and flushes it at the end, which also empties this session's bus.
async function withServer(t, fn) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = await startServer();
  try {
    await fn(server);
  } finally {
    t.mock.timers.runAll();
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
}

test('the stream opens with `accepted`, and the turn replays from its _seq', async (t) => {
  installHandlers();
  await withServer(t, async (server) => {
    const res = await post(server, { message: 'add a dark mode toggle', client_message_id: CLIENT_ID });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = parseSse(await res.text());

    const [first] = events;
    assert.equal(first.type, 'accepted', 'accepted is the first event on the wire');
    assert.equal(first.messageId, 1001, 'it names the stored message');
    assert.equal(first.clientMessageId, CLIENT_ID, 'and echoes the client id');
    assert.ok(first._seq, 'it carries a _seq to resume from');
    assert.ok(events.some((e) => e.type === 'done'), 'the turn itself still runs to done');

    const insert = capturedQueries.find((q) => isUserInsert(q.sql));
    assert.equal(insert.params[3], CLIENT_ID, 'the id is stored with the message');
    assert.ok(capturedQueries.findIndex((q) => isLookup(q.sql))
      < capturedQueries.findIndex((q) => isUserInsert(q.sql)), 'looked up before storing');

    // SSE-only: the global WS has no handler for it, so a copy there would
    // be swallowed and the SSE copy deduped away.
    assert.ok(!broadcasts.some((b) => b.event === 'accepted'), 'never broadcast on the global WS');

    // The resume contract: /events?since=<accepted _seq> replays the rest.
    const replayed = [];
    const unsubscribe = sessionBus.subscribe(SESSION_ID, (e) => replayed.push(e), first._seq);
    unsubscribe();
    assert.deepEqual(replayed.map((e) => e._seq), events.slice(1).map((e) => e._seq),
      'every later event of the turn, in order');
  });
});

test('a send without an id still opens with `accepted`, and looks nothing up', async (t) => {
  installHandlers();
  await withServer(t, async (server) => {
    const events = parseSse(await (await post(server, { message: 'hello' })).text());
    assert.equal(events[0].type, 'accepted');
    assert.equal(events[0].messageId, 1001);
    assert.equal(events[0].clientMessageId, null);
    assert.ok(!capturedQueries.some((q) => isLookup(q.sql)), 'no lookup without an id');
    assert.equal(capturedQueries.find((q) => isUserInsert(q.sql)).params[3], null);
  });
});

test('a retry with the same id answers with the stored message and starts no second turn', async (t) => {
  let stored = false;
  installHandlers({
    lookup: () => (stored ? [{ id: 1001, has_later: true, latest_user: true }] : []),
    insert: () => { stored = true; return [{ id: 1001 }]; },
  });
  await withServer(t, async (server) => {
    const original = parseSse(await (await post(server, { message: 'build it', client_message_id: CLIENT_ID })).text());
    const accepted = original[0];
    assert.equal(billingCalls, 1);

    capturedQueries = [];
    const res = await post(server, { message: 'build it', clientMessageId: CLIENT_ID });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/, 'same response shape as a send');
    const events = parseSse(await res.text());
    assert.equal(events.length, 1, 'one event, then the response ends');
    assert.deepEqual(events[0], {
      type: 'accepted',
      _seq: accepted._seq,
      messageId: 1001,
      clientMessageId: CLIENT_ID,
      duplicate: true,
      state: 'done',
    }, 'the original accepted _seq, so since= replays that same turn');

    assert.ok(!capturedQueries.some((q) => isUserInsert(q.sql)), 'nothing stored again');
    assert.equal(billingCalls, 1, 'the retry reaches no billing gate');
    assert.ok(!capturedQueries.some((q) => /INSERT INTO chat_session_messages/.test(q.sql)),
      'and no turn ran (it would have written a status row)');
  });
});

test('two retries racing past the lookup: the insert that loses answers as a duplicate', async (t) => {
  installHandlers({
    // The first lookup misses; the conflict's follow-up lookup finds the row.
    lookup: (n) => (n === 1 ? [] : [{ id: 1002, has_later: false, latest_user: true }]),
    insert: () => [], // ON CONFLICT DO NOTHING returned no row
  });
  await withServer(t, async (server) => {
    const events = parseSse(await (await post(server, { message: 'again', client_message_id: CLIENT_ID })).text());
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'accepted');
    assert.equal(events[0].duplicate, true);
    assert.equal(events[0].messageId, 1002);
    assert.equal(events[0].state, 'received', 'stored, and nothing after it yet');
    // Nothing buffered for 1002: a seq no turn emits, so since= replays what
    // the buffer holds and follows live.
    assert.match(events[0]._seq, /-0$/);
    const insert = capturedQueries.find((q) => isUserInsert(q.sql));
    assert.match(insert.sql, /ON CONFLICT \(session_id, client_message_id\) WHERE client_message_id IS NOT NULL DO NOTHING/);
  });
});

test('a malformed client_message_id is refused before anything is stored', async (t) => {
  installHandlers();
  await withServer(t, async (server) => {
    for (const bad of ['short', 'has spaces in it', '-leading-dash', 'x'.repeat(65), 12345678]) {
      capturedQueries = [];
      const res = await post(server, { message: 'hi', client_message_id: bad });
      assert.equal(res.status, 400, `refuses ${JSON.stringify(bad)}`);
      assert.match((await res.json()).error, /client_message_id/);
      assert.ok(!capturedQueries.some((q) => /chat_session_messages/.test(q.sql)),
        'before any message is looked up or stored');
      assert.equal(billingCalls, 0, 'and before billing');
    }
    const { status: code } = await status(server, '?client_message_id=short');
    assert.equal(code, 400, 'the status lookup applies the same rule');
  });
});

test('GET /status answers delivery only when asked', async (t) => {
  let row = null;
  installHandlers({ lookup: () => (row ? [row] : []) });
  await withServer(t, async (server) => {
    const plain = await status(server);
    assert.equal(plain.status, 200);
    assert.equal('delivery' in plain.body, false, 'the 3s poll gets the payload it always got');
    assert.ok(!capturedQueries.some((q) => isLookup(q.sql)));

    const unknown = await status(server, `?client_message_id=${CLIENT_ID}`);
    assert.deepEqual(unknown.body.delivery, { clientMessageId: CLIENT_ID, received: false });
    const lookup = capturedQueries.find((q) => isLookup(q.sql));
    assert.deepEqual(lookup.params, [SESSION_ID, CLIENT_ID, VIEWER.id, false],
      'scoped to the caller (owner, or an admin)');
    assert.match(lookup.sql, /cs\.user_id = \$3 OR \$4/);

    row = { id: 1003, has_later: false, latest_user: true };
    const received = await status(server, `?clientMessageId=${CLIENT_ID}`);
    assert.deepEqual(received.body.delivery, {
      clientMessageId: CLIENT_ID, received: true, messageId: 1003, state: 'received', since: null,
    });

    // The live turn is this message's: running, resumable from its accepted.
    const handle = { abort: new AbortController(), phase: 'cc', stopped: false, userMessageId: 1003, send() {} };
    stopRegistry.set(SESSION_ID, handle);
    sessionBus.publish(SESSION_ID, { type: 'accepted', _seq: 'test-1', messageId: 1003, clientMessageId: CLIENT_ID });
    try {
      const running = await status(server, `?client_message_id=${CLIENT_ID}`);
      assert.equal(running.body.delivery.state, 'running');
      assert.equal(running.body.delivery.since, 'test-1');

      // Another message's turn is live: this one's turn is over.
      handle.userMessageId = 2000;
      row = { id: 1003, has_later: true, latest_user: false };
      const done = await status(server, `?client_message_id=${CLIENT_ID}`);
      assert.equal(done.body.delivery.state, 'done');
    } finally {
      stopRegistry.deleteIf(SESSION_ID, handle);
      sessionBus.clearSession(SESSION_ID);
    }
  });
});

test('deliveryState: a live turn that names no message is the newest message\'s', () => {
  const base = { messageId: 5, liveMessageId: null, hasLaterRows: true };
  assert.equal(chatDelivery.deliveryState({ ...base, turnLive: true, isLatestUserMessage: true }), 'running',
    'a turn adopted after a restart registers a handle without a message id');
  assert.equal(chatDelivery.deliveryState({ ...base, turnLive: true, isLatestUserMessage: false }), 'done');
  assert.equal(chatDelivery.deliveryState({ ...base, turnLive: false, isLatestUserMessage: true }), 'done');
  assert.equal(chatDelivery.deliveryState({ ...base, hasLaterRows: false, turnLive: false, isLatestUserMessage: true }), 'received');
});
