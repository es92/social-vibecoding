// Route test for POST /api/sessions/:id/chat (src/routes/sessions.js) —
// #1949, auto-naming OpenRouter dev sessions. The Haiku titler
// (services/session-title maybeTitleFirstMessage) is skipped for
// OpenRouter sessions on purpose, which left them showing their branch
// name ("dev/evan-17890406…") for life. The contract pinned here: the
// direct OpenRouter branch names an untitled session from its first
// prompt with the deterministic, payer-free trim — the guarded UPDATE is
// issued and `session_titled` is broadcast, while no Claude billing path
// and no Haiku call is touched — and PR sessions, already-named sessions
// and a failing UPDATE all leave the row alone without disturbing the turn.
//
// Same property-override harness as tests/chat-repo-less-turn.test.js:
// override getPool BEFORE requiring the route module, capture every
// query, mount on a real express app and read the SSE body. The turn is
// steered into the direct branch's "already running" exit (a session
// operation is held for the id) so no coding agent is dispatched; the
// title hook fires ahead of that gate by design.
//
// Run with: node --test tests/openrouter-session-title.test.js

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

// OpenRouter turns never resolve a Claude payer — count to prove it.
const limits = require('../src/services/limits');
let billingCalls = 0;
limits.resolveBillingPath = async () => {
  billingCalls += 1;
  return { apiKey: null };
};

// The Haiku titler must stay untouched for OpenRouter sessions.
const llm = require('../src/services/llm');
let haikuCalls = 0;
llm.generateSessionTitle = async () => {
  haikuCalls += 1;
  throw new Error('generateSessionTitle must not run for an OpenRouter session');
};

// send() broadcasts non-SSE-only events on the global WS. Capture them:
// the title hook is fire-and-forget, so its event may land after the
// turn's own stream has ended.
const ws = require('../src/services/ws');
let broadcasts = [];
ws.broadcastGlobal = (event) => { broadcasts.push(event); };

const activeWorkers = require('../src/services/active-workers');

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };
const SESSION_ID = 2585;
const FIRST_PROMPT = 'Make the leaderboard paginate 20 rows at a time';

function sessionRow(overrides = {}) {
  return {
    id: SESSION_ID,
    app_id: 494,
    user_id: 7,
    branch_name: 'dev/tester-17890406',
    status: 'active',
    is_headless: false,
    session_title: null,
    pr_number: null,
    cc_session_id: null,
    app_slug: 'mypage-777ed2',
    app_name: 'MyPage',
    repo_url: 'https://github.com/bot/mypage',
    app_self_hosted: false,
    collab_visibility: 'public',
    view_visibility: 'public',
    agent_backend: 'codex_openrouter',
    agent_provider: 'openrouter',
    agent_model: 'z-ai/glm-5.3-flash',
    ...overrides,
  };
}

function installHandlers({ row, updateThrows = false }) {
  capturedQueries = [];
  billingCalls = 0;
  haikuCalls = 0;
  broadcasts = [];
  poolQueryHandler = async (sql) => {
    const s = String(sql);
    if (/FROM chat_sessions cs/.test(s)) return { rows: [{ ...row }] };
    if (/INSERT INTO chat_session_messages/.test(s) && /'user'/.test(s)) {
      return { rows: [{ id: 1001 }] };
    }
    if (/SELECT content FROM chat_session_messages/.test(s)) {
      return { rows: [{ content: FIRST_PROMPT }] };
    }
    if (/UPDATE chat_sessions SET session_title/.test(s)) {
      if (updateThrows) throw new Error('db down');
      return { rowCount: 1, rows: [] };
    }
    if (/SELECT spec_md FROM chat_sessions/.test(s)) return { rows: [{ spec_md: '' }] };
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

// The title hook is fire-and-forget: give its awaits a few turns of the
// event loop after the response has ended (setImmediate, since the
// tests mock setTimeout for the route's own cleanup timers).
async function settle(done, turns = 50) {
  for (let i = 0; i < turns && !done(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const titleUpdate = () => capturedQueries.find((q) => /UPDATE chat_sessions SET session_title/.test(q.sql));
const titledBroadcast = () => broadcasts.find((b) => b.event === 'session_titled');

async function postTurn(server, message) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${SESSION_ID}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  assert.equal(res.status, 200);
  return parseSse(await res.text());
}

async function runTurn(t, { row, updateThrows = false }, message = FIRST_PROMPT) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installHandlers({ row, updateThrows });
  // Hold a session operation so the direct branch stops at its
  // "already running" gate instead of dispatching a coding agent.
  const release = activeWorkers.beginSessionOperation(SESSION_ID);
  const server = await startServer();
  try {
    const events = await postTurn(server, message);
    assert.ok(events.some((e) => e.type === 'done'), 'the turn ends with done');
    assert.ok(capturedQueries.some((q) =>
      /INSERT INTO chat_session_messages/.test(q.sql) && /'user'/.test(q.sql)),
    'the prompt was stored before the branch ran');
    return events;
  } finally {
    release();
    t.mock.timers.runAll();
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
}

test('an untitled OpenRouter session is named from its first prompt, with no Claude call', async (t) => {
  await runTurn(t, { row: sessionRow() });
  await settle(() => titleUpdate() && titledBroadcast());

  const upd = titleUpdate();
  assert.ok(upd, 'the session title UPDATE was issued');
  assert.match(upd.sql, /pr_number IS NULL/, 'guarded so a PR-mirrored title cannot be clobbered');
  assert.deepEqual(upd.params, [FIRST_PROMPT, SESSION_ID]);

  const titled = titledBroadcast();
  assert.ok(titled, 'session_titled reached the global WS for open session lists');
  assert.equal(titled.sessionTitle, FIRST_PROMPT);
  assert.equal(titled.sessionId, SESSION_ID);

  assert.equal(billingCalls, 0, 'OpenRouter must not inspect or gate on Claude credits');
  assert.equal(haikuCalls, 0, 'the Haiku titler never ran');
});

test('a PR session keeps the name applyPrMetadata mirrored in', async (t) => {
  await runTurn(t, { row: sessionRow({ pr_number: 42, session_title: 'Mirrored PR title' }) });
  await settle(() => false, 10);
  assert.equal(titleUpdate(), undefined, 'no title UPDATE');
  assert.equal(titledBroadcast(), undefined, 'no session_titled');
  assert.equal(haikuCalls, 0);
});

test('an already-named session is left alone', async (t) => {
  await runTurn(t, { row: sessionRow({ session_title: 'Leaderboard pagination' }) }, 'and sort by score');
  await settle(() => false, 10);
  assert.equal(titleUpdate(), undefined, 'no title UPDATE');
  assert.equal(titledBroadcast(), undefined, 'no session_titled');
});

test('a failing title write leaves the name unset and the turn intact', async (t) => {
  const events = await runTurn(t, { row: sessionRow(), updateThrows: true });
  await settle(() => titleUpdate());
  assert.ok(titleUpdate(), 'the UPDATE was attempted');
  await settle(() => false, 10);
  assert.equal(titledBroadcast(), undefined, 'no session_titled after a failed write');
  assert.ok(!events.some((e) => e.type === 'error'), 'the turn saw no error event');
});
