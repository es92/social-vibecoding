// #1204 — "Often getting spec result of 'API Error: Connection lost
// mid-response. The response above may be incomplete.'"
//
// A scout turn's product is the agent's FINAL message: the host stores it
// verbatim as the session's spec doc. When the Anthropic stream drops
// mid-answer, Claude Code exhausts its own retries and closes the turn with
// that notice as its last words — while still exiting 0 and writing its
// __USERNODE_RESULT__ line, so nothing downstream of the exit code notices.
// The notice was then persisted AS the spec: it overwrote the previous
// draft and froze as an immutable version in chat_session_specs.
//
// Two halves are covered here:
//   1. agentApiFailure / describeAgentApiFailure (src/services/
//      agent-result-text.js) — the anchored detector, including the
//      false-positive cases it must NOT fire on.
//   2. The route path — one automatic re-dispatch, then a spec that is
//      stored on recovery and refused when the retry fails too.
//
// The route half follows the headless-cc-retry.test.js harness: an
// in-memory pool that pattern-matches SQL plus require.cache stubs for
// github/llm/worker/staging/app-access/limits/events, driven over HTTP.
//
// Run with: node --test tests/scout-api-error.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  agentApiFailure,
  describeAgentApiFailure,
} = require('../src/services/agent-result-text');

// ── 1. The detector ─────────────────────────────────────────────────────

const CONNECTION_LOST =
  'API Error: Connection lost mid-response. The response above may be incomplete.';

const REAL_SPEC = [
  '# Cache the app manifest',
  '',
  '## User-facing changes',
  '',
  'Apps open faster on a warm cache.',
  '',
  '## Technical implementation',
  '',
  '`src/services/app-manifest.js` grows a 60s memo.',
].join('\n');

test('the reported message is caught as a whole-message API failure', () => {
  const failure = agentApiFailure(CONNECTION_LOST);
  assert.equal(failure.kind, 'api_error');
  assert.match(failure.line, /Connection lost mid-response/);
  assert.match(describeAgentApiFailure(failure), /API connection failed/);
});

test('other API Error shapes are caught too', () => {
  for (const text of [
    'API Error: 500 {"type":"error","error":{"type":"api_error"}}',
    'API Error (Request timed out.)',
    '  ⎿  API Error: Connection error.',
    'api error: overloaded_error',
  ]) {
    assert.ok(agentApiFailure(text), `expected a failure for: ${text}`);
  }
});

test('bare one-line transport notices are caught', () => {
  assert.equal(agentApiFailure('Connection error.').kind, 'api_error');
  assert.equal(agentApiFailure('Request timed out').kind, 'api_error');
});

test('partial content followed by the truncation notice is "truncated"', () => {
  const partial = `${REAL_SPEC}\n\n${CONNECTION_LOST}`;
  const failure = agentApiFailure(partial);
  assert.equal(failure.kind, 'truncated');
  assert.match(describeAgentApiFailure(failure), /cut off/);
});

test('a real spec is never flagged', () => {
  assert.equal(agentApiFailure(REAL_SPEC), null);
  assert.equal(agentApiFailure(''), null);
  assert.equal(agentApiFailure(null), null);
  assert.equal(agentApiFailure(undefined), null);
});

test('a spec that DISCUSSES API errors is never flagged', () => {
  // The whole point of anchoring to the first/last line: a spec about error
  // handling quotes these strings legitimately, and eating it would be a
  // worse bug than the one this detector fixes.
  const spec = [
    '# Surface API failures in the dev chat',
    '',
    '## User-facing changes',
    '',
    'Instead of a blank card, the chat says what broke.',
    '',
    '## Technical implementation',
    '',
    'The runtime emits `API Error: Connection lost mid-response. The response',
    'above may be incomplete.` as its final assistant message; detect it and',
    'render the failure state.',
    '',
    '### Considerations',
    '',
    'Connection error. handling stays in one place.',
  ].join('\n');
  assert.equal(agentApiFailure(spec), null);
});

test('a bare trailing "API Error" line without transport wording is left alone', () => {
  // The trailing-line rule needs the runtime's own incomplete/lost/aborted
  // wording — a document that simply ends on a sentence about API errors is
  // still a document.
  const spec = `${REAL_SPEC}\n\nAPI Error handling is out of scope for this change.`;
  assert.equal(agentApiFailure(spec), null);
});

test('long notices are clipped rather than pasted whole into the chat', () => {
  const failure = agentApiFailure(`API Error: ${'x'.repeat(500)}`);
  assert.ok(failure.line.length <= 200);
  assert.ok(failure.line.endsWith('…'));
});

// ── 2. The route path ───────────────────────────────────────────────────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = {
    id, filename: id, loaded: true, exports,
    paths: original ? original.paths : [],
  };
  return original;
}

class PrivateSecretMissingStagingDefaultError extends Error {}
class MissingSecretsError extends Error {}

function loadSessions(mockPool, overrides = {}) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    llm: require.resolve('../src/services/llm'),
    worker: require.resolve('../src/services/worker'),
    staging: require.resolve('../src/services/staging'),
    appAccess: require.resolve('../src/services/app-access'),
    limits: require.resolve('../src/services/limits'),
    events: require.resolve('../src/services/events'),
    sessions: require.resolve('../src/routes/sessions'),
    notifications: require.resolve('../src/services/notifications'),
  };

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => mockPool })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: () => {},
      pushNotificationToUser: () => 0,
      pushSessionUpdate: () => {},
    })],
    [paths.github, stubModule(paths.github, {
      isEnabled: () => true,
      fetchPublicIssue: async () => ({ issue: { number: 5, title: 'Make it better', body: 'please' } }),
      fetchIssueComments: async () => ({ comments: [], truncated: false }),
      getBotUsername: async () => 'usernode-bot',
      createBranch: async () => {},
      createIssueComment: async () => {},
      safeMention: (s) => s,
    })],
    [paths.llm, stubModule(paths.llm, {
      isEnabled: () => true,
      streamChat: async () => ({ text: 'ok', toolUses: [], usage: { input_tokens: 1, output_tokens: 1 }, rawContent: [] }),
      estimateCostCents: () => 0,
      ...(overrides.llm || {}),
    })],
    [paths.worker, stubModule(paths.worker, {
      ensureWorkerImage: async () => {},
      ensureWorker: async () => 'stub-worker',
      execInWorker: async () => ({ lastResultText: '' }),
      resumeTurnFromJournal: async () => ({}),
      clearActiveTurn: async () => {},
      finishTurn: async () => {},
      markTurnTail: async () => {},
      noteTailMilestone: async () => {},
      stopTurn: async () => {},
      isWorkerExecuting: async () => false,
      workerContainerName: (id) => `usernode-worker-${id}`,
      ...(overrides.worker || {}),
    })],
    [paths.staging, stubModule(paths.staging, {
      PrivateSecretMissingStagingDefaultError,
      MissingSecretsError,
      buildAndDeployStaging: async () => { throw new Error('staging disabled in tests'); },
      verifyStagingEdge: async () => {},
    })],
    [paths.appAccess, stubModule(paths.appAccess, {
      ...require('../src/services/app-access'),
      getAppForUser: async () => ({
        id: 1, slug: 'my-app', name: 'My App',
        repo_url: 'https://github.com/owner/repo', self_hosted: false,
      }),
    })],
    [paths.limits, stubModule(paths.limits, {
      checkBudget: async () => ({}),
      resolveBillingPath: async () => ({ apiKey: null, byok: false }),
      recordSpend: async () => {},
    })],
    [paths.events, stubModule(paths.events, {
      record: () => {},
      EVENT_TYPES: { DEV_SESSION_STARTED: 'dev_session_started', PR_OPENED: 'pr_opened' },
    })],
  ];
  delete require.cache[paths.sessions];
  delete require.cache[paths.notifications];

  const subject = require('../src/routes/sessions');

  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.sessions];
    delete require.cache[paths.notifications];
  };
  return { subject, restore };
}

function makeMockPool() {
  const state = {
    messages: [],
    terminal: null,
    specMd: '',
    // Every frozen chat_session_specs row this run wrote. A refused spec
    // must add nothing here — a one-line error notice in the viewer's
    // version history is permanent.
    specVersions: [],
    nextId: 1000,
  };

  async function query(sql, params = []) {
    const s = String(sql);

    if (/SELECT id, headless_status FROM chat_sessions/i.test(s)
        && /headless_issue_number/i.test(s)) {
      return { rows: [] };
    }
    if (/SELECT COUNT\(\*\) as cnt FROM chat_sessions/i.test(s)) {
      return { rows: [{ cnt: '0' }] };
    }
    if (/SELECT anthropic_key_enc FROM users/i.test(s)) {
      return { rows: [] };
    }
    if (/INSERT INTO chat_sessions/i.test(s)) {
      return {
        rows: [{
          id: state.nextId++, app_id: params[0], user_id: params[1],
          branch_name: params[2], status: 'active', is_headless: true,
          headless_status: 'generating', headless_issue_number: params[3],
        }],
      };
    }
    if (/INSERT INTO chat_session_specs/i.test(s)) {
      state.specVersions.push(params[1]);
      return { rows: [{ version: state.specVersions.length }] };
    }
    if (/INSERT INTO chat_session_messages/i.test(s)) {
      state.messages.push({
        role: /'user'/.test(s) ? 'user' : (/'system'/.test(s) ? 'system' : 'assistant'),
        content: params[1],
      });
      return { rows: [{ id: state.nextId++ }] };
    }
    if (/UPDATE chat_sessions SET spec_md/i.test(s)) {
      state.specMd = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT spec_md FROM chat_sessions/i.test(s)) {
      return { rows: [{ spec_md: state.specMd }] };
    }
    if (/UPDATE chat_sessions SET headless_status = 'ready'/i.test(s)) {
      state.terminal = { status: 'ready', outcome: params[0] };
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE chat_sessions SET headless_status = 'failed'/i.test(s)) {
      state.terminal = { status: 'failed' };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { query, state };
}

async function startTestServer(loaded, user = { id: 1, username: 'alice' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(loaded.subject.sessionRoutes({ jwtSecret: 'test' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

async function startHeadlessRun(srv) {
  const res = await fetch(`${srv.baseUrl}/api/apps/my-app/issues/5/headless-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 201);
}

const USAGE = { input_tokens: 10, output_tokens: 5 };
const SCOUT_CALL_TURN = {
  text: 'Investigating first.',
  toolUses: [{ id: 'tu-scout', name: 'dispatch_scout', input: { prompt: 'Look around.' } }],
  usage: USAGE,
  rawContent: [],
};
const WRAP_TURN = { text: 'Wrapped up.', toolUses: [], usage: USAGE, rawContent: [] };

function sequencedLlm(responses) {
  let i = 0;
  return { streamChat: async () => responses[Math.min(i++, responses.length - 1)] };
}

// The shape of a dropped stream: exit 0, __USERNODE_RESULT__ written, and
// the failure delivered as the agent's closing words.
const API_ERROR_RUN = {
  lastResultText: CONNECTION_LOST,
  exitCode: 0, resultSeen: true, ahead: 0, behind: 0,
  sha: null, pushOk: false, rawStderr: '', sessionId: 'cc-1', markerlessCause: null,
};
const GOOD_SCOUT_RUN = {
  lastResultText: REAL_SPEC,
  exitCode: 0, resultSeen: true, sessionId: 'cc-1', markerlessCause: null,
};

test('scout: a dropped stream re-dispatches once and the retry\'s spec is stored', async () => {
  const execCalls = [];
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([SCOUT_CALL_TURN, WRAP_TURN]),
    worker: {
      execInWorker: async (sessionId, opts) => {
        execCalls.push(opts.mode);
        return execCalls.length === 1 ? { ...API_ERROR_RUN } : { ...GOOD_SCOUT_RUN };
      },
      stopTurn: async () => {},
      isWorkerExecuting: async () => false,
    },
  });
  const srv = await startTestServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => pool.state.terminal !== null);

    assert.deepEqual(execCalls, ['scout', 'scout']);
    assert.equal(pool.state.specMd, REAL_SPEC);
    assert.deepEqual(pool.state.specVersions, [REAL_SPEC]);
    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'spec' });
    assert.ok(pool.state.messages.some(
      (m) => /lost its connection to the API — retrying once/.test(m.content || '')
    ));
    // The notice never reaches the user as a spec.
    assert.ok(!pool.state.messages.some(
      (m) => /Scout drafted a 1-line spec/.test(m.content || '')
    ));
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('scout: when the retry drops too, the notice is never stored as a spec', async () => {
  const execCalls = [];
  const pool = makeMockPool();
  // A reviewed draft from an earlier turn — it has to survive.
  pool.state.specMd = REAL_SPEC;
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([SCOUT_CALL_TURN, WRAP_TURN]),
    worker: {
      execInWorker: async (sessionId, opts) => {
        execCalls.push(opts.mode);
        return { ...API_ERROR_RUN };
      },
      stopTurn: async () => {},
      isWorkerExecuting: async () => false,
    },
  });
  const srv = await startTestServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => pool.state.terminal !== null);

    // One retry, never a third attempt.
    assert.deepEqual(execCalls, ['scout', 'scout']);
    // The previous draft is untouched and no version was frozen.
    assert.equal(pool.state.specMd, REAL_SPEC);
    assert.deepEqual(pool.state.specVersions, []);
    // The chat says what actually happened, in plain terms.
    assert.ok(pool.state.messages.some(
      (m) => /API connection failed/.test(m.content || '')
        && /spec doc was not updated/.test(m.content || '')
    ));
    // A produced-nothing scout finalizes as 'question' — a human picks it up.
    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'question' });
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('scout: a healthy run is untouched — one dispatch, spec stored', async () => {
  const execCalls = [];
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([SCOUT_CALL_TURN, WRAP_TURN]),
    worker: {
      execInWorker: async (sessionId, opts) => {
        execCalls.push(opts.mode);
        return { ...GOOD_SCOUT_RUN };
      },
      stopTurn: async () => {},
      isWorkerExecuting: async () => false,
    },
  });
  const srv = await startTestServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => pool.state.terminal !== null);

    assert.deepEqual(execCalls, ['scout']);
    assert.equal(pool.state.specMd, REAL_SPEC);
    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'spec' });
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('shouldRetryApiErrorTurn: only unstopped transport failures qualify', () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  try {
    const should = loaded.subject.shouldRetryApiErrorTurn;
    assert.equal(should({ lastResultText: CONNECTION_LOST }, null), true);
    // A stop is a deliberate end, not a failure to retry.
    assert.equal(should({ lastResultText: CONNECTION_LOST }, { stopped: true }), false);
    // Real output, and empty output (the markerless path owns that), don't.
    assert.equal(should({ lastResultText: REAL_SPEC }, null), false);
    assert.equal(should({ lastResultText: '' }, null), false);
    assert.equal(should(null, null), false);
  } finally {
    loaded.restore();
  }
});
