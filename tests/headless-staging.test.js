// Tests for #183 — intentional staging previews on headless auto-solve
// runs, and the propose-from-clone flow that creates the PR lazily.
//
// Three layers:
//   1. Runner tests: a headless run whose Mayor dispatches
//      dispatch_claude_code and whose worker pushes a commit now builds a
//      staging preview (persisted on the headless row, announced via a
//      stagingUrl-bearing system message, BEFORE the terminal
//      headless_status='ready' write) while still opening NO pull request.
//      A staging build failure is non-fatal: the run still finalizes
//      ready/code.
//   2. /promote route tests: headless rows are rejected outright; a
//      PR-less clone gets its PR created lazily on its own branch at
//      promote time (and the response carries the PR info); a failed PR
//      creation 502s without promoting; promote kicks off a staging build
//      for a clone that has none.
//   3. /deploy-staging guard: headless rows 404.
//
// Like headless-clarify.test.js, the pool is an in-memory mock that
// pattern-matches SQL and services are stubbed via require.cache. No real
// Postgres / GitHub / LLM / Docker.
//
// Run with: node --test tests/headless-staging.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// ── require.cache stubbing ──────────────────────────────────────────────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = {
    id, filename: id, loaded: true, exports,
    paths: original ? original.paths : [],
  };
  return original;
}

// Error classes sessions.js checks with `instanceof` when describing a
// staging failure — the stub must export real constructors.
class PrivateSecretMissingStagingDefaultError extends Error {}
class MissingSecretsError extends Error {}

// ── sessions.js loader (headless runner tests) ──────────────────────────

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
    prMetadata: require.resolve('../src/services/pr-metadata'),
    sessions: require.resolve('../src/routes/sessions'),
    notifications: require.resolve('../src/services/notifications'),
    syncMain: require.resolve('../src/services/sync-main'),
  };

  const githubStub = {
    isEnabled: () => true,
    fetchPublicIssue: async () => ({ issue: { number: 5, title: 'Fix it', body: 'please' } }),
    fetchIssueComments: async () => ({ comments: [], truncated: false }),
    getBotUsername: async () => 'usernode-bot',
    createBranch: async () => {},
    createIssueComment: async () => {},
    safeMention: (s) => s,
    ...(overrides.github || {}),
  };
  const llmStub = {
    isEnabled: () => true,
    streamChat: async () => ({
      text: 'Done.', toolUses: [], usage: { input_tokens: 10, output_tokens: 5 }, rawContent: [],
    }),
    estimateCostCents: () => 0,
    ...(overrides.llm || {}),
  };
  const workerStub = {
    ensureWorkerImage: async () => {},
    ensureWorker: async () => 'stub-worker',
    execInWorker: async () => ({ lastResultText: '' }),
    resumeTurnFromJournal: async () => ({}),
    clearActiveTurn: async () => {},
    // Tail lifecycle (the dispatch tools hold the durable turn record
    // across their post-agent tail and release it in a finally).
    finishTurn: async () => {},
    markTurnTail: async () => {},
    noteTailMilestone: async () => {},
    stopTurn: async () => false,
    ...(overrides.worker || {}),
  };
  const stagingCalls = [];
  const stagingStub = {
    PrivateSecretMissingStagingDefaultError,
    MissingSecretsError,
    buildAndDeployStaging: async (config, session, app, commitHash) => {
      stagingCalls.push({ sessionId: session.id, commitHash });
      return { containerId: 'stg-container-1', stagingUrl: 'https://stg-test.example', hostname: 'stg-test.example' };
    },
    verifyStagingEdge: async () => {},
    ...(overrides.staging || {}),
  };

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => mockPool })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: () => {},
      pushNotificationToUser: () => 0,
    })],
    [paths.github, stubModule(paths.github, githubStub)],
    [paths.llm, stubModule(paths.llm, llmStub)],
    [paths.worker, stubModule(paths.worker, workerStub)],
    [paths.staging, stubModule(paths.staging, stagingStub)],
    [paths.appAccess, stubModule(paths.appAccess, {
      ...require('../src/services/app-access'),
      getAppForUser: async () => ({
        id: 1, slug: 'my-app', name: 'My App',
        repo_url: 'https://github.com/owner/repo', self_hosted: false,
      }),
    })],
    [paths.limits, stubModule(paths.limits, {
      checkBudget: async () => ({}),
      // #212 limit-first: allowance always has headroom in these tests.
      resolveBillingPath: async () => ({ apiKey: null, byok: false }),
      recordSpend: async () => {},
    })],
    [paths.events, stubModule(paths.events, {
      record: () => {},
      EVENT_TYPES: { DEV_SESSION_STARTED: 'dev_session_started', PR_OPENED: 'pr_opened' },
    })],
  ];
  // Force fresh resolution against the stubs (pr-metadata + sync-main are
  // re-resolved too so they bind the stubbed github/pool, not a previous
  // test's).
  delete require.cache[paths.sessions];
  delete require.cache[paths.notifications];
  delete require.cache[paths.prMetadata];
  delete require.cache[paths.syncMain];

  const subject = require('../src/routes/sessions');

  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.sessions];
    delete require.cache[paths.notifications];
    delete require.cache[paths.prMetadata];
    delete require.cache[paths.syncMain];
  };
  return { subject, stagingCalls, restore };
}

// ── In-memory mock pool for the headless runner ─────────────────────────

function makeRunnerPool() {
  const state = {
    messages: [],     // { role, content, metadata }
    terminal: null,   // { status, outcome }
    specMd: '',
    nextId: 1000,
    effects: new Map(),
  };
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s.trim())) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO turn_effects/i.test(s)) {
      const key = `${params[0]}:${params[1]}`;
      if (state.effects.has(key)) return { rows: [], rowCount: 0 };
      const effect = { state: 'pending', result: null };
      state.effects.set(key, effect);
      return { rows: [{ state: effect.state }], rowCount: 1 };
    }
    if (/UPDATE turn_effects/i.test(s)) {
      const key = `${params[0]}:${params[1]}`;
      const effect = state.effects.get(key);
      if (!effect || effect.state !== 'pending') return { rows: [], rowCount: 0 };
      effect.state = 'completed';
      effect.result = params[2] == null ? null : JSON.parse(params[2]);
      return { rows: [{ result: effect.result }], rowCount: 1 };
    }
    if (/SELECT state(?:, result)? FROM turn_effects/i.test(s)) {
      const effect = state.effects.get(`${params[0]}:${params[1]}`);
      return { rows: effect ? [{ ...effect }] : [], rowCount: effect ? 1 : 0 };
    }

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
      const row = {
        id: state.nextId++, app_id: params[0], user_id: params[1],
        branch_name: params[2], status: 'active', is_headless: true,
        headless_status: 'generating', headless_issue_number: params[3],
      };
      return { rows: [row] };
    }
    if (/INSERT INTO chat_session_messages/i.test(s)) {
      let metadata = null;
      // System inserts carry (sessionId, content, metadataJson).
      if (/'system'/.test(s) && typeof params[2] === 'string') {
        try { metadata = JSON.parse(params[2]); } catch {}
      }
      state.messages.push({
        role: /'user'/.test(s) ? 'user' : (/'system'/.test(s) ? 'system' : 'assistant'),
        content: params[1],
        metadata,
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
    if (/UPDATE chat_sessions SET headless_step/i.test(s)) {
      return { rows: [], rowCount: 1 };
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

  return { query, state, calls };
}

async function startSessionsServer(loaded, user = { id: 1, username: 'alice' }) {
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

const USAGE = { input_tokens: 10, output_tokens: 5 };

// llm.streamChat stub replaying `responses` in order.
function sequencedLlm(responses) {
  let i = 0;
  return {
    streamChat: async () => responses[Math.min(i++, responses.length - 1)],
  };
}

const BUILD_CALL_TURN = {
  text: 'Small unambiguous fix — dispatching the coding agent.',
  toolUses: [{ id: 'tu-build', name: 'dispatch_claude_code', input: { prompt: 'Fix the typo.' } }],
  usage: USAGE,
  rawContent: [],
};
const WRAPUP_TURN = { text: 'All done — change pushed.', toolUses: [], usage: USAGE, rawContent: [] };

const PUSHED_RESULT = {
  lastResultText: 'Fixed the typo in index.html.',
  sha: 'abcdef1234567890',
  ahead: 1,
  behind: 0,
  pushOk: true,
  exitCode: 0,
  sessionId: 'cc-1',
};

async function startHeadlessRun(srv) {
  const res = await fetch(`${srv.baseUrl}/api/apps/my-app/issues/5/headless-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 201);
}

// ── 1. Headless runner: staging built, no PR ────────────────────────────

test('headless code outcome builds staging (no PR) and persists the stagingUrl card message', async () => {
  const pool = makeRunnerPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([BUILD_CALL_TURN, WRAPUP_TURN]),
    worker: { execInWorker: async () => PUSHED_RESULT },
  });
  const srv = await startSessionsServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => pool.state.terminal !== null);

    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'code' });

    // Staging was built from the pushed commit, exactly once.
    assert.equal(loaded.stagingCalls.length, 1);
    assert.equal(loaded.stagingCalls[0].commitHash, PUSHED_RESULT.sha);

    // The staging columns were persisted on the headless row…
    const stagingUpdateIdx = pool.calls.findIndex(
      (c) => /UPDATE chat_sessions SET staging_container_id/i.test(c.sql)
    );
    assert.ok(stagingUpdateIdx >= 0, 'staging columns persisted');
    assert.equal(pool.calls[stagingUpdateIdx].params[1], 'https://stg-test.example');

    // …BEFORE the terminal ready write, so the first issues-panel refresh
    // triggered by headless_update already sees the URL.
    const terminalIdx = pool.calls.findIndex(
      (c) => /UPDATE chat_sessions SET headless_status = 'ready'/i.test(c.sql)
    );
    assert.ok(terminalIdx > stagingUpdateIdx, 'staging persisted before the terminal write');

    // A system message carries the stagingUrl metadata — that's what makes
    // the "Changes ready" card render in every future clone of this run.
    const cardMsg = pool.state.messages.find(
      (m) => m.role === 'system' && m.metadata && m.metadata.stagingUrl
    );
    assert.ok(cardMsg, 'stagingUrl-bearing system message persisted');
    assert.equal(cardMsg.metadata.stagingUrl, 'https://stg-test.example');
    // #361: the explicit marker rides alongside the URL so the card is
    // driven by `changesReady`, not incidentally by `stagingUrl`.
    assert.equal(cardMsg.metadata.changesReady, true, 'success card carries changesReady');

    // No PR: nothing ever wrote pr_number.
    assert.ok(
      !pool.calls.some((c) => /SET pr_number/i.test(c.sql)),
      'no PR was opened on the auto branch'
    );
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('headless staging build failure is non-fatal — run still finalizes ready/code', async () => {
  const pool = makeRunnerPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([BUILD_CALL_TURN, WRAPUP_TURN]),
    worker: { execInWorker: async () => PUSHED_RESULT },
    staging: {
      buildAndDeployStaging: async () => { throw new Error('docker exploded'); },
    },
  });
  const srv = await startSessionsServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => pool.state.terminal !== null);

    // The outcome is unchanged — the pushed commit is the deliverable.
    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'code' });

    // The failure was surfaced as a status message, and no staging columns
    // (and no PR) were written.
    const failMsg = pool.state.messages.find(
      (m) => m.role === 'system' && /Staging build failed/.test(m.content || '')
    );
    assert.ok(failMsg, 'a staging-failed status message was persisted');
    // #361: the failure branch persists the staging-independent marker so a
    // clone still renders the "Changes ready" card (with a disabled Preview)
    // instead of a card-less line. The pushed commit is the deliverable.
    assert.equal(failMsg.metadata.changesReady, true, 'failure card carries changesReady');
    assert.equal(failMsg.metadata.stagingFailed, true, 'metadata flags the staging failure');
    assert.equal(failMsg.metadata.stagingErrorName, 'Error', 'error name persisted for the hint');
    assert.deepEqual(failMsg.metadata.stagingMissingKeys, [], 'missing keys persisted (empty here)');
    assert.ok(!pool.calls.some((c) => /SET staging_container_id/i.test(c.sql)));
    assert.ok(!pool.calls.some((c) => /SET pr_number/i.test(c.sql)));
  } finally {
    await srv.close();
    loaded.restore();
  }
});

// ── /deploy-staging guard ───────────────────────────────────────────────

test('POST /deploy-staging rejects headless sessions', async () => {
  const pool = makeRunnerPool();
  // Evaluate the route's own WHERE semantics: the session row IS headless,
  // so a query carrying the is_headless = FALSE clause must return nothing.
  const origQuery = pool.query;
  pool.query = async (sql, params) => {
    const s = String(sql);
    if (/FROM chat_sessions cs JOIN apps a/i.test(s) && /status IN \('active', 'promoted'\)/i.test(s)) {
      assert.ok(/is_headless = FALSE/i.test(s), 'deploy-staging query carries the headless guard');
      return { rows: [] }; // the row is headless → filtered out
    }
    return origQuery(sql, params);
  };
  const loaded = loadSessions(pool);
  const srv = await startSessionsServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/42/deploy-staging`, { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal(loaded.stagingCalls.length, 0);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

// ── 2. /promote: headless guard + lazy PR creation ──────────────────────

function loadVotes(mockPool, overrides = {}) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    docker: require.resolve('../src/services/docker'),
    conflictResolver: require.resolve('../src/services/conflict-resolver'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    prMetadata: require.resolve('../src/services/pr-metadata'),
    votes: require.resolve('../src/routes/votes'),
  };

  const stagingCalls = [];
  const stagingStub = {
    PrivateSecretMissingStagingDefaultError,
    MissingSecretsError,
    buildAndDeployStaging: async (config, session) => {
      stagingCalls.push({ sessionId: session.id });
      return { containerId: 'stg-c', stagingUrl: 'https://clone-stg.example', hostname: 'clone-stg.example' };
    },
    verifyStagingEdge: async () => {},
    ...(overrides.staging || {}),
  };
  const prMetadataStub = {
    applyPrMetadata: async () => null,
    ...(overrides.prMetadata || {}),
  };

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => mockPool })],
    [paths.ws, stubModule(paths.ws, {
      sendSystemMessage: async () => {},
      pushNotificationToUser: () => 0,
      pushSessionUpdate: () => {},
      pushVoteUpdate: () => {},
      broadcastGlobal: () => {},
    })],
    [paths.github, stubModule(paths.github, {
      isEnabled: () => false,
      safeMention: (s) => s,
      ...(overrides.github || {}),
    })],
    [paths.staging, stubModule(paths.staging, stagingStub)],
    [paths.docker, stubModule(paths.docker, {})],
    [paths.conflictResolver, stubModule(paths.conflictResolver, {
      checkAndResolveConflicts: async () => ({}),
      resolveAndMaybeRetry: async () => ({}),
    })],
    [paths.activeUsers, stubModule(paths.activeUsers, {
      getActiveUserStats: async () => ({ activeUsers: 1, majority: 1 }),
      isUserActive: () => true,
    })],
    [paths.notifications, stubModule(paths.notifications, {
      createPrProposedNotifications: async () => [],
      serialize: (x) => x,
      markReadForAction: async () => 0,
    })],
    [paths.adminApproval, stubModule(paths.adminApproval, {
      isAppLocked: async () => false,
      hasAdminYesVote: async () => false,
    })],
    [paths.events, stubModule(paths.events, {
      record: () => {},
      EVENT_TYPES: { PR_PROMOTED: 'pr_promoted' },
    })],
    [paths.appAccess, stubModule(paths.appAccess, {
      sessionCollabGuard: () => (_req, _res, next) => next(),
    })],
    [paths.prMetadata, stubModule(paths.prMetadata, prMetadataStub)],
  ];
  delete require.cache[paths.votes];

  const subject = require('../src/routes/votes');

  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.votes];
  };
  return { subject, stagingCalls, restore };
}

// Mock pool for /promote: holds one session row and answers the route's
// queries against it — evaluating the is_headless clause for real.
function makePromotePool(sessionRow) {
  const state = { promoted: false, stagingUpdate: null };
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    if (/FROM chat_sessions cs JOIN apps a/i.test(s) && /status IN \('active', 'paused'\)/i.test(s)) {
      let ok = ['active', 'paused'].includes(sessionRow.status) && sessionRow.user_id === params[1];
      if (/is_headless = FALSE/i.test(s) && sessionRow.is_headless) ok = false;
      return { rows: ok ? [{ ...sessionRow }] : [] };
    }
    if (/SELECT COUNT\(\*\) AS cnt FROM chat_sessions/i.test(s)) {
      return { rows: [{ cnt: '0' }] };
    }
    if (/SELECT content FROM chat_session_messages/i.test(s)) {
      return { rows: [{ content: 'please ship the bot change' }] };
    }
    if (/UPDATE chat_sessions[\s\S]*SET status = 'promoted'/i.test(s)) {
      state.promoted = true;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE chat_sessions SET staging_container_id/i.test(s)) {
      state.stagingUpdate = { containerId: params[0], url: params[1] };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { query, state, calls };
}

async function startVotesServer(loaded, user = { id: 1, username: 'alice' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(loaded.subject.voteRoutes({ jwtSecret: 'test' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const CLONE_ROW = {
  id: 99, app_id: 1, user_id: 1, status: 'active', is_headless: false,
  branch_name: 'dev/alice-1700000000000',
  app_slug: 'my-app', app_name: 'My App',
  repo_url: 'https://github.com/owner/repo',
  pr_number: null, pr_url: null, pr_title: null,
  staging_url: null, staging_container_id: null,
};

test('POST /promote rejects headless sessions with 404', async () => {
  const pool = makePromotePool({ ...CLONE_ROW, is_headless: true });
  const loaded = loadVotes(pool);
  const srv = await startVotesServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/99/promote`, { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal(pool.state.promoted, false);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('POST /promote on a PR-less clone creates the PR lazily on the clone branch and returns it', async () => {
  const prCalls = [];
  const pool = makePromotePool({ ...CLONE_ROW });
  const loaded = loadVotes(pool, {
    prMetadata: {
      applyPrMetadata: async ({ session, userMessage, username, userId }) => {
        prCalls.push({ branch: session.branch_name, userMessage, username, userId });
        session.pr_number = 77;
        session.pr_url = 'https://github.com/owner/repo/pull/77';
        session.pr_title = 'Ship the bot change';
        return { prNumber: 77, prUrl: session.pr_url, prTitle: session.pr_title };
      },
    },
  });
  const srv = await startVotesServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/99/promote`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 77);
    assert.equal(body.prUrl, 'https://github.com/owner/repo/pull/77');
    assert.equal(body.prTitle, 'Ship the bot change');

    // The PR was created on the CLONE's branch, attributed + debited to
    // the proposing user, with the latest user message as context.
    assert.equal(prCalls.length, 1);
    assert.equal(prCalls[0].branch, 'dev/alice-1700000000000');
    assert.equal(prCalls[0].username, 'alice');
    assert.equal(prCalls[0].userId, 1);
    assert.equal(prCalls[0].userMessage, 'please ship the bot change');

    assert.equal(pool.state.promoted, true);

    // The clone had no staging of its own — promote kicked off a build
    // (fire-and-forget) and persisted the result.
    await waitFor(() => pool.state.stagingUpdate !== null);
    assert.equal(pool.state.stagingUpdate.url, 'https://clone-stg.example');
    assert.deepEqual(loaded.stagingCalls, [{ sessionId: 99 }]);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('POST /promote 502s (and does not promote) when lazy PR creation fails', async () => {
  const pool = makePromotePool({ ...CLONE_ROW });
  const loaded = loadVotes(pool, {
    prMetadata: { applyPrMetadata: async () => null },
  });
  const srv = await startVotesServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/99/promote`, { method: 'POST' });
    assert.equal(res.status, 502);
    assert.equal(pool.state.promoted, false);
    assert.equal(loaded.stagingCalls.length, 0);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('POST /promote with an existing PR does not re-create it and skips the staging kick when staging exists', async () => {
  const prCalls = [];
  const pool = makePromotePool({
    ...CLONE_ROW,
    pr_number: 12, pr_url: 'https://github.com/owner/repo/pull/12', pr_title: 'Existing',
    staging_url: 'https://already.example', staging_container_id: 'c1',
  });
  const loaded = loadVotes(pool, {
    prMetadata: { applyPrMetadata: async (args) => { prCalls.push(args); return null; } },
  });
  const srv = await startVotesServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/99/promote`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.prNumber, 12);
    assert.equal(pool.state.promoted, true);
    assert.equal(prCalls.length, 0, 'no lazy PR creation when a PR exists');
    // Settle briefly — the (absent) staging kick would fire post-response.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(loaded.stagingCalls.length, 0);
  } finally {
    await srv.close();
    loaded.restore();
  }
});
