// Tests for the recovery push-heal fix (chat 510 / issue #295).
//
// When a coding turn commits locally but its worker's usernode-push
// callback never lands the branch on GitHub (push_ok=0 — e.g. the
// platform was mid-restart when the worker POSTed
// /api/internal/sessions/:id/push), finalizeRecoveredTurn must re-push
// the branch (while the worker container still exists) BEFORE
// applyPrMetadata's createPR. Otherwise createPR 422s ("No commits
// between main and <branch>") and, once the worker is evicted, the only
// copy of the commit is lost.
//
// server.js only boots under the require.main guard, so requiring it here
// exposes finalizeRecoveredTurn without starting servers. worker and
// pr-metadata are stubbed via require.cache BEFORE the require so
// server.js (and its inline require of pr-metadata) bind the stubs.
//
// Run with: node --test tests/recovered-turn-push-heal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
// config.load() requires the four separated platform keys (REQUIRED_PROD).
require('./platform-keys').setPlatformKeys();

// ── worker stub ─────────────────────────────────────────────────────────
// pushBehavior is mutated per-test to drive success vs failure.
const workerCalls = [];
let pushBehavior = { mode: 'ok', sha: 'newpushedsha0001' };
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  destroyWorker: async (name) => { workerCalls.push(['destroyWorker', name]); },
  execPushFromWorker: async (sessionId, branch) => {
    workerCalls.push(['execPushFromWorker', sessionId, branch]);
    if (pushBehavior.mode === 'throw') {
      if (pushBehavior.permanent) {
        // #1376: mirrors execPushFromWorker's bad_branch rejection.
        const err = new Error(`Invalid branch name: ${branch}`);
        err.code = 'bad_branch';
        err.permanent = true;
        err.userMessage = `This session's branch name (${branch}) isn't a valid git branch, `
          + 'so the push can never succeed. Start a new session on this app.';
        throw err;
      }
      throw new Error('push proxy failed: container gone');
    }
    return { sha: pushBehavior.sha };
  },
  noteTailMilestone: async (sessionId, milestone) => {
    workerCalls.push(['noteTailMilestone', sessionId, milestone]);
    return true;
  },
};

// ── pr-metadata stub (inline-required by finalizeRecoveredTurn) ──────────
const prMetadataCalls = [];
const prMetadataPath = require.resolve('../src/services/pr-metadata');
const realPrMetadata = require(prMetadataPath);
require.cache[prMetadataPath].exports = {
  ...realPrMetadata,
  applyPrMetadata: async (args) => {
    prMetadataCalls.push(args);
    return { prNumber: 7, prUrl: 'https://example/pr/7', prTitle: 'Recovered change' };
  },
};

// Auto-unref any housekeeping timers scheduled during the require.
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...a) => { const t = origSetInterval(...a); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...a) => { const t = origSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
let finalizeRecoveredTurn;
try {
  ({ finalizeRecoveredTurn } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

function makePool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      // The recovered-user-message lookup feeds the PR title helper.
      if (/SELECT content FROM chat_session_messages/i.test(String(sql)) && /role = 'user'/i.test(String(sql))) {
        return { rows: [{ content: 'okay do it' }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function makeDurablePool(activeTurn) {
  const calls = [];
  const effects = new Map();
  const state = {
    stagingUrl: null,
    stagingContainerId: null,
  };
  const query = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text.trim())) return { rows: [], rowCount: 0 };
    if (/INSERT INTO turn_effects/i.test(text)) {
      const key = `${params[0]}:${params[1]}`;
      if (effects.has(key)) return { rows: [], rowCount: 0 };
      effects.set(key, { state: 'pending', result: null });
      return { rows: [{ state: 'pending' }], rowCount: 1 };
    }
    if (/SELECT state, result FROM turn_effects/i.test(text)) {
      const row = effects.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (/UPDATE turn_effects/i.test(text)) {
      const row = effects.get(`${params[0]}:${params[1]}`);
      if (!row || row.state !== 'pending') return { rows: [], rowCount: 0 };
      row.state = 'completed';
      row.result = JSON.parse(params[2]);
      return { rows: [{ result: row.result }], rowCount: 1 };
    }
    if (/SET active_turn = jsonb_set/i.test(text) && /'\{tail\}'/i.test(text)) {
      const milestone = JSON.parse(params[1]);
      activeTurn.tail = { ...(activeTurn.tail || {}), ...milestone };
      return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
    }
    if (/SELECT active_turn FROM chat_sessions/i.test(text)) {
      return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
    }
    if (/UPDATE chat_sessions SET staging_container_id/i.test(text)) {
      state.stagingContainerId = params[0];
      state.stagingUrl = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT staging_url, staging_container_id FROM chat_sessions/i.test(text)) {
      return { rows: [{
        staging_url: state.stagingUrl,
        staging_container_id: state.stagingContainerId,
      }], rowCount: 1 };
    }
    if (/SELECT content FROM chat_session_messages/i.test(text) && /role = 'user'/i.test(text)) {
      return { rows: [{ content: 'okay do it' }] };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    calls,
    effects,
    state,
    query,
    async connect() { return { query, release() {} }; },
  };
}

const certCalls = [];

function makeStaging() {
  const calls = [];
  return {
    calls,
    buildAndDeployStaging: async (...args) => {
      calls.push(args);
      return { containerId: 'c', stagingUrl: 'https://x.example', hostname: 'x.example' };
    },
    // #896: live-path parity — the recovered tail pre-warms the preview's
    // TLS cert before revealing the button, same as runClaudeCodeTool.
    verifyStagingEdge: async (...args) => { certCalls.push(args); },
  };
}

function makeFailingStaging(err) {
  const calls = [];
  return {
    calls,
    buildAndDeployStaging: async (...args) => { calls.push(args); throw err; },
    verifyStagingEdge: async (...args) => { certCalls.push(args); },
  };
}

const SESSION = {
  id: 510, status: 'active', is_headless: false, user_id: 1, app_id: 1,
  username: 'evan', app_slug: 'usernode-2d5619', app_name: 'Homeroom',
  repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
  branch_name: 'dev/evan-1781527910307',
  cc_session_id: 'cc-1',
};

const sysMsgInserted = (pool) =>
  pool.calls.some((c) => /INSERT INTO chat_session_messages/i.test(c.sql) &&
    /not on GitHub/i.test(String(c.params[1] || '')));

// Rows the tail persisted, as { content, metadata } pairs.
const insertedRows = (pool) => pool.calls
  .filter((c) => /INSERT INTO chat_session_messages/i.test(c.sql))
  .map((c) => ({
    content: String(c.params[1] || ''),
    metadata: JSON.parse(String(c.params[2] || '{}')),
  }));

test.beforeEach(() => {
  workerCalls.length = 0;
  prMetadataCalls.length = 0;
  pushBehavior = { mode: 'ok', sha: 'newpushedsha0001' };
  certCalls.length = 0;
});

test('a recovered OpenRouter chat reply stays a normal reply, not a Claude completion card', async () => {
  const pool = makePool();
  const emits = [];
  const ret = await finalizeRecoveredTurn({
    config: {},
    pool,
    staging: makeStaging(),
    session: {
      ...SESSION,
      agent_backend: 'codex_openrouter',
      agent_model: 'anthropic/claude-sonnet-4.5',
    },
    sessionId: 510,
    result: {
      ahead: 0,
      sha: null,
      pushOk: true,
      exitCode: 0,
      ccIsError: false,
      lastResultText: 'The current session uses OpenRouter for every turn.',
    },
    repoOwner: 'Usernode-Labs',
    repoName: 'social-vibecoding',
    emit: (event, data) => emits.push({ event, data }),
    containerName: 'usernode-worker-510',
    keepWorker: true,
    activeTurn: {
      turnId: '00000000-0000-4000-8000-000000000510',
      backend: 'codex_openrouter',
      model: 'anthropic/claude-sonnet-4.5',
    },
  });

  assert.equal(ret.outcome, 'done');
  assert.equal(ret.summary, 'The current session uses OpenRouter for every turn.');
  assert.equal(insertedRows(pool).length, 0, 'the direct reply is persisted by the wrap-up owner');
  assert.equal(emits.length, 0, 'recovery does not paint a duplicate completion card');
  assert.ok(!JSON.stringify(pool.calls).includes('Claude Code'));
});

test('re-pushes an un-pushed recovered branch before creating the PR', async () => {
  const pool = makePool();
  const staging = makeStaging();
  const emits = [];

  const ret = await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...SESSION },
    sessionId: 510,
    result: { ahead: 1, sha: 'localonlysha12345', pushOk: false, lastResultText: 'done', sessionId: 'cc-2' },
    repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
    emit: (event, data) => emits.push({ event, data }),
    containerName: 'usernode-worker-510',
    keepWorker: true,
  });

  // The branch is re-pushed first, with the session's canonical branch.
  assert.deepEqual(
    workerCalls.find((c) => c[0] === 'execPushFromWorker'),
    ['execPushFromWorker', 510, 'dev/evan-1781527910307']
  );
  // Then the normal PR + staging tail runs.
  assert.equal(prMetadataCalls.length, 1);
  assert.equal(staging.calls.length, 1);
  // No "couldn't push" warning when the re-push succeeds.
  assert.ok(!sysMsgInserted(pool));

  // #896: the tail hands the Mayor wrap-up a narrative of what happened,
  // the same shape runClaudeCodeTool feeds back as its tool_result.
  assert.equal(ret.outcome, 'done');
  assert.match(ret.summary, /Commit localonl pushed to dev\/evan-1781527910307\./);
  assert.match(ret.summary, /Opened PR #7: https:\/\/example\/pr\/7/);
  assert.match(ret.summary, /Staging redeployed: https:\/\/x\.example/);
});

// #896: a recovered turn must leave the same transcript a normal turn
// leaves — no "(recovered after restart)" labels, and the completion +
// PR + staging rows the live path writes.
test('the recovered tail writes the same rows a normal turn does', async () => {
  const pool = makePool();
  const staging = makeStaging();

  await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...SESSION },
    sessionId: 510,
    result: {
      ahead: 1, sha: 'pushedsha000123', pushOk: true, sessionId: 'cc-2',
      lastResultText: 'Sorted the leaderboard by score.',
    },
    repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
    emit: () => {},
    containerName: 'usernode-worker-510',
    keepWorker: true,
    startedAtMs: Date.now() - 60000,
  });

  const rows = insertedRows(pool);
  const contents = rows.map((r) => r.content);
  assert.deepEqual(contents, ['Claude Code finished', 'PR #7 created', 'Staging deployed!'],
    'the transcript reads exactly like a live turn, in the same order');

  const finished = rows[0];
  assert.equal(finished.metadata.ccOutput, 'Sorted the leaderboard by score.',
    "the agent's own summary rides the completion card (and the Mayor's context)");
  assert.equal(finished.metadata.ccOutcome, 'success');
  assert.ok(finished.metadata.durationMs > 0, 'duration comes from active_turn.startedAt');

  const stagingRow = rows[2];
  assert.equal(stagingRow.metadata.changesReady, true,
    'changesReady — not the incidental stagingUrl — drives the Changes-ready card');
  assert.equal(stagingRow.metadata.stagingUrl, 'https://x.example');

  // The restart is recorded in metadata for operators, never in the text.
  for (const row of rows) {
    assert.equal(row.metadata.recovered, true, `${row.content} is tagged for SQL audit`);
    assert.doesNotMatch(row.content, /recover|restart/i);
  }

  // Live-path parity bits that used to be missing entirely.
  assert.equal(certCalls.length, 1, 'the preview cert is pre-warmed before the button appears');
});

test('skips PR creation and warns the user when the re-push fails', async () => {
  pushBehavior = { mode: 'throw' };
  const pool = makePool();
  const staging = makeStaging();
  const emits = [];

  await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...SESSION },
    sessionId: 510,
    result: { ahead: 1, sha: 'localonlysha12345', pushOk: false, lastResultText: 'done', sessionId: 'cc-2' },
    repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
    emit: (event, data) => emits.push({ event, data }),
    containerName: 'usernode-worker-510',
    keepWorker: false,
  });

  // Push was attempted, but the doomed createPR is NOT.
  assert.ok(workerCalls.some((c) => c[0] === 'execPushFromWorker'));
  assert.equal(prMetadataCalls.length, 0);
  assert.equal(staging.calls.length, 0);
  // The user is told the truth, and the worker is reaped (keepWorker:false).
  assert.ok(sysMsgInserted(pool));
  assert.ok(emits.some((e) => e.event === 'status' && /not on GitHub/i.test(e.data.text)));
  assert.ok(workerCalls.some((c) => c[0] === 'destroyWorker'));

  // #896: the message states the situation and the action, without
  // naming the restart — that lives in metadata.recovered instead.
  const pushRow = insertedRows(pool).find((r) => /not on GitHub/.test(r.content));
  assert.doesNotMatch(pushRow.content, /restart|recover/i);
  assert.equal(pushRow.metadata.recovered, true);
  assert.match(pushRow.content, /Retry your request/);
  // #1376: a transient failure keeps its retry advice AND now names the
  // actual git/platform error, which used to exist only in a WARN line.
  assert.match(pushRow.content, /container gone/);
  assert.equal(pushRow.metadata.pushFailurePermanent, false);
  assert.equal(pushRow.metadata.pushFailureCode, 'push_failed');
});

test('a permanently unpushable branch says so instead of advising a retry', async () => {
  // #1376: the production shape — a branch minted from an email-address
  // username, rejected by the push proxy's charset. Retrying re-pushes the
  // same rejected name forever, so the copy must not suggest it.
  pushBehavior = { mode: 'throw', permanent: true };
  const pool = makePool();
  const staging = makeStaging();
  const emits = [];

  await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...SESSION },
    sessionId: 510,
    result: { ahead: 1, sha: 'localonlysha12345', pushOk: false, lastResultText: 'done', sessionId: 'cc-3' },
    repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
    emit: (event, data) => emits.push({ event, data }),
    containerName: 'usernode-worker-510',
    keepWorker: false,
  });

  assert.equal(prMetadataCalls.length, 0);
  const pushRow = insertedRows(pool).find((r) => /not on GitHub/.test(r.content));
  assert.ok(pushRow, 'the failure must reach the chat transcript');
  assert.match(pushRow.content, /never succeed/i);
  assert.equal(/retry|send your request again/i.test(pushRow.content), false);
  assert.equal(pushRow.metadata.pushFailurePermanent, true);
  assert.equal(pushRow.metadata.pushFailureCode, 'bad_branch');
});

test('does not re-push when the turn already pushed (pushOk:true)', async () => {
  const pool = makePool();
  const staging = makeStaging();

  await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...SESSION },
    sessionId: 510,
    result: { ahead: 1, sha: 'pushedsha000123', pushOk: true, lastResultText: 'done', sessionId: 'cc-2' },
    repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
    emit: () => {},
    containerName: 'usernode-worker-510',
    keepWorker: true,
  });

  assert.ok(!workerCalls.some((c) => c[0] === 'execPushFromWorker'));
  assert.equal(prMetadataCalls.length, 1);
  assert.equal(staging.calls.length, 1);
});

// #896: staging is a recoverable failure point — the commit, push and PR
// already landed. Before this, a failed preview build threw straight out
// of the recovery task: no staging row, no wrap-up, no pills, and a
// progress card frozen on [interrupted].
test('a staging build that fails still leaves a proposable Changes-ready card', async () => {
  const pool = makePool();
  const staging = makeFailingStaging(new Error('container refused to boot'));
  const emits = [];

  const ret = await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...SESSION },
    sessionId: 510,
    result: { ahead: 1, sha: 'pushedsha000123', pushOk: true, lastResultText: 'Did the thing.', sessionId: 'cc-2' },
    repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
    emit: (event, data) => emits.push({ event, data }),
    containerName: 'usernode-worker-510',
    keepWorker: true,
  });

  // The recovery completes rather than throwing, so the wrap-up still runs.
  assert.equal(ret.outcome, 'done');
  assert.match(ret.summary, /Staging build failed/);

  const failRow = insertedRows(pool).find((r) => r.content === 'Staging build failed');
  assert.ok(failRow, 'the failure is persisted, not just logged');
  assert.equal(failRow.metadata.changesReady, true,
    'the commit is still proposable — promote rebuilds staging itself');
  assert.equal(failRow.metadata.stagingFailed, true);
  assert.equal(failRow.metadata.recovered, true);
  assert.ok(emits.some((e) => e.event === 'staging_failed'));
  // And the preview-bearing success row is NOT written.
  assert.ok(!insertedRows(pool).some((r) => r.content === 'Staging deployed!'));
});

test('a retained recovered tail publishes a successful staging card once without rebuilding', async () => {
  const activeTurn = {
    turnId: '44444444-4444-4444-8444-444444444444',
    phase: 'tail_pending',
    journal: '/home/node/.claude/turn-4444.log',
    tail: {},
  };
  const done = {
    completionRowPosted: true,
    prNumber: 7,
    prOpenedEventRecorded: true,
  };
  const pool = makeDurablePool(activeTurn);
  const staging = makeStaging();
  const stagingRecovery = require('../src/services/staging-recovery');
  const originalNeedsRebuild = stagingRecovery.stagingNeedsRebuild;
  stagingRecovery.stagingNeedsRebuild = async () => false;
  try {
    const args = {
      config: {}, pool, staging,
      session: { ...SESSION, pr_number: 7, pr_url: 'https://example/pr/7' },
      sessionId: 510,
      result: {
        ahead: 1, sha: 'pushedsha000123', pushOk: true, sessionId: 'cc-2',
        lastResultText: 'Sorted the leaderboard by score.',
      },
      repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
      emit: () => {},
      containerName: 'usernode-worker-510',
      keepWorker: true,
      alreadyDone: done,
      activeTurn,
    };

    await finalizeRecoveredTurn(args);
    await finalizeRecoveredTurn(args);

    assert.ok(prMetadataCalls.every((call) =>
      call.effectTurnId === activeTurn.turnId
      && call.effectSessionId === 510
      && call.effectBillingByok === false),
    'recovery threads one stable metadata receipt and payer identity into every retry');
    assert.equal(staging.calls.length, 1, 'the committed stagingUrl is reused on tail retry');
    assert.equal(insertedRows(pool).filter((row) => row.content === 'Staging deployed!').length, 1,
      'the receipt suppresses the duplicate Changes-ready card');
    assert.equal(done.stagingPublished, true);
    const receipt = pool.effects.get(`${activeTurn.turnId}:recovered_staging_publication`);
    assert.equal(receipt?.state, 'completed');
    assert.deepEqual(receipt?.result?.checkpoint, { stagingPublished: true },
      'replays restore the checkpoint committed with the success card');
  } finally {
    stagingRecovery.stagingNeedsRebuild = originalNeedsRebuild;
  }
});

test('a retained staging failure is published once and later tail retries skip the build', async () => {
  const activeTurn = {
    turnId: '55555555-5555-4555-8555-555555555555',
    phase: 'tail_pending',
    journal: '/home/node/.claude/turn-5555.log',
    tail: {},
  };
  const done = {
    completionRowPosted: true,
    prNumber: 7,
    prOpenedEventRecorded: true,
  };
  const pool = makeDurablePool(activeTurn);
  const staging = makeFailingStaging(new Error('container refused to boot'));
  const args = {
    config: {}, pool, staging,
    session: { ...SESSION, pr_number: 7, pr_url: 'https://example/pr/7' },
    sessionId: 510,
    result: {
      ahead: 1, sha: 'pushedsha000123', pushOk: true, sessionId: 'cc-2',
      lastResultText: 'Changed the score card.',
    },
    repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
    emit: () => {},
    containerName: 'usernode-worker-510',
    keepWorker: true,
    alreadyDone: done,
    activeTurn,
  };

  await finalizeRecoveredTurn(args);
  await finalizeRecoveredTurn(args);

  assert.equal(staging.calls.length, 1, 'a later wrap-up retry does not repeat a known failed build');
  assert.equal(insertedRows(pool).filter((row) => row.content === 'Staging build failed').length, 1);
  assert.equal(done.stagingPublished, true);
  assert.equal(typeof done.stagingFailed, 'object');
  assert.equal(
    typeof pool.effects.get(`${activeTurn.turnId}:recovered_staging_publication`)?.result?.checkpoint?.stagingFailed,
    'object',
    'replays restore the failure checkpoint committed with the failure card',
  );
});
