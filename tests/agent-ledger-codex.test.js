'use strict';
// Commit 4 (plan §6): Codex attempt accounting — cumulative provider
// totals with transactional per-attempt deltas, estimated-only cost, and
// idempotent completion. The pure helpers are tested directly; the
// completeCodexAttempt path is exercised through a stubbed transaction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const recoveryRetry = require('../src/services/recovery-retry');
const llmTelemetry = require('../src/services/llm-telemetry');

const {
  computeProviderUsageDelta,
  estimateRequestedModelCost,
  pricingSnapshotForModel,
  runtimeModelMetadataForModel,
  normalizeCumulativeUsage,
  completeCodexAttempt,
  startCodexAttempt,
  usageTotalFromResult,
  persistRecoveredAgentThread,
  getCodexAttemptRecoveryState,
  resolveCodexRuntimeContext,
} = require('../src/services/agent-turn');

// ── Cumulative delta math (plan 6.5, 6.6) ──────────────────────────────
test('delta: second attempt on same thread subtracts the prior total', () => {
  const delta = computeProviderUsageDelta(
    { inputTokens: 180, outputTokens: 35, cachedInputTokens: 40, cacheWriteInputTokens: 5, reasoningOutputTokens: 2 },
    { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, cacheWriteInputTokens: 2, reasoningOutputTokens: 1 },
  );
  assert.equal(delta.delta.inputTokens, 80);
  assert.equal(delta.delta.outputTokens, 15);
  assert.equal(delta.delta.cachedInputTokens, 10);
  assert.equal(delta.delta.cacheWriteInputTokens, 3);
  assert.equal(delta.delta.reasoningOutputTokens, 1);
  assert.equal(delta.resetDetected, false);
});

test('delta: lower new total resets baseline instead of producing negatives', () => {
  const delta = computeProviderUsageDelta(
    { inputTokens: 50, outputTokens: 10 },
    { inputTokens: 100, outputTokens: 20 },
  );
  assert.equal(delta.resetDetected, true);
  assert.equal(delta.delta.inputTokens, 50);
  assert.equal(delta.delta.outputTokens, 10);
});

test('delta: first attempt (no previous) uses full totals as the delta', () => {
  const delta = computeProviderUsageDelta(
    { inputTokens: 100, outputTokens: 20 },
    null,
  );
  assert.equal(delta.delta.inputTokens, 100);
  assert.equal(delta.delta.outputTokens, 20);
  assert.equal(delta.resetDetected, false);
});

test('delta: null current usage yields zero delta', () => {
  assert.deepEqual(computeProviderUsageDelta(null, { inputTokens: 10 }), {
    delta: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    resetDetected: false,
  });
});

test('delta: a missing current dimension stays unknown and does not trigger a reset', () => {
  const out = computeProviderUsageDelta(
    { inputTokens: 180, cachedInputTokens: null, outputTokens: 35 },
    { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 },
  );
  assert.equal(out.resetDetected, false);
  assert.equal(out.delta.inputTokens, 80);
  assert.equal(out.delta.cachedInputTokens, 0);
  assert.equal(out.delta.outputTokens, 15);
});

test('delta: a missing prior dimension starts at zero without discarding known baselines', () => {
  const out = computeProviderUsageDelta(
    { inputTokens: 20, outputTokens: 5 },
    { inputTokens: 10, outputTokens: null },
  );
  assert.equal(out.resetDetected, false);
  assert.equal(out.delta.inputTokens, 10);
  assert.equal(out.delta.outputTokens, 5);
});

// ── Cost estimation (plan 6.7) ─────────────────────────────────────────
test('estimate: catalog pricing × prompt/completion deltas, not exact', () => {
  const pricing = { available: true, inputPricePerMillion: 1.25, outputPricePerMillion: 10 };
  const cost = estimateRequestedModelCost(
    { inputTokens: 1_000_000, outputTokens: 100_000, reasoningOutputTokens: 0 },
    pricing,
  );
  assert.equal(cost.estimatedCostUsd, 1.25 + 1.0);
  assert.equal(cost.costSource, 'requested_model_catalog_estimate');
  assert.ok(!/exact/i.test(cost.costSource), 'never called exact');
});

test('estimate: reasoning output is not double-counted (included in output)', () => {
  const pricing = { available: true, inputPricePerMillion: 1, outputPricePerMillion: 1 };
  const cost = estimateRequestedModelCost({ inputTokens: 0, outputTokens: 100_000, reasoningOutputTokens: 90_000 }, pricing);
  assert.equal(cost.estimatedCostUsd, 0.1);
});

test('estimate: missing/invalid pricing yields unavailable, no guessed cost', () => {
  assert.deepEqual(estimateRequestedModelCost({ inputTokens: 100 }, { available: false }), {
    costSource: 'unavailable', estimatedCostUsd: null,
  });
  assert.deepEqual(estimateRequestedModelCost({ inputTokens: 100 }, { available: true, inputPricePerMillion: null }), {
    costSource: 'unavailable', estimatedCostUsd: null,
  });
});

test('pricingSnapshotForModel: requires finite nonnegative prices', () => {
  const snap = pricingSnapshotForModel({ id: 'm', inputPricePerMillion: 1.25, outputPricePerMillion: 10 });
  assert.equal(snap.available, true);
  assert.equal(snap.model, 'm');
  assert.equal(snap.inputPricePerMillion, 1.25);
  assert.equal(snap.outputPricePerMillion, 10);
  assert.match(snap.pricingAssumption, /ordinary prompt rate/);
  assert.equal(pricingSnapshotForModel({ id: 'm', inputPricePerMillion: null, outputPricePerMillion: 10 }).available, false);
  assert.equal(pricingSnapshotForModel(null), null);
});

test('runtimeModelMetadataForModel preserves OpenRouter context and capabilities', () => {
  assert.deepEqual(runtimeModelMetadataForModel({
    name: 'DeepSeek V4 Flash Latest',
    contextLength: 1_048_576,
    maxOutputTokens: 131_072,
    supportsReasoning: true,
    reasoningEfforts: ['low', 'high', 'unsupported-value'],
    supportsTools: true,
  }, '~deepseek/deepseek-v4-flash-latest'), {
    name: 'DeepSeek V4 Flash Latest',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    supportsReasoning: true,
    reasoningEfforts: ['low', 'high'],
    supportsTools: true,
  });
  assert.deepEqual(runtimeModelMetadataForModel(null, 'vendor/model'), {
    name: 'vendor/model',
    contextWindow: null,
    maxOutputTokens: null,
    supportsReasoning: null,
    reasoningEfforts: null,
    supportsTools: null,
  });
});

test('resolveCodexRuntimeContext carries the selected OpenRouter model metadata to the worker', async (t) => {
  const credentialStore = require('../src/services/credential-store');
  const agentModels = require('../src/services/agent-models');
  const originals = {
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    resolveModelPricing: agentModels.resolveModelPricing,
  };
  credentialStore.readMetadata = async () => ({ id: 9, status: 'valid', revision: 3 });
  credentialStore.readSecret = async () => 'sk-or-test';
  agentModels.resolveModelPricing = async () => ({
    id: '~deepseek/deepseek-v4-flash-latest',
    name: 'DeepSeek V4 Flash Latest',
    contextLength: 1_048_576,
    maxOutputTokens: 131_072,
    supportsReasoning: true,
    reasoningEfforts: null,
    supportsTools: true,
    inputPricePerMillion: 0.2,
    outputPricePerMillion: 0.5,
  });
  t.after(() => {
    credentialStore.readMetadata = originals.readMetadata;
    credentialStore.readSecret = originals.readSecret;
    agentModels.resolveModelPricing = originals.resolveModelPricing;
  });

  const ctx = await resolveCodexRuntimeContext({
    pool: {},
    userId: 7,
    session: {
      id: 81,
      agent_backend: 'codex_openrouter',
      agent_model: '~deepseek/deepseek-v4-flash-latest',
      agent_reasoning_effort: 'medium',
      agent_config_version: 2,
    },
    config: {
      codexOpenrouterEnabled: true,
      openrouterBetaUserIds: [],
      openrouterApiBase: 'https://openrouter.ai/api/v1',
      dataEncryptionKey: 'test-key',
    },
  });
  assert.equal(ctx.agentModel, '~deepseek/deepseek-v4-flash-latest');
  assert.equal(ctx.agentReasoningEffort, 'medium');
  assert.deepEqual(ctx.agentModelMetadata, {
    name: 'DeepSeek V4 Flash Latest',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    supportsReasoning: true,
    reasoningEfforts: null,
    supportsTools: true,
  });
  assert.equal(ctx.pricingSnapshot.available, true);
});

// ── Cumulative usage normalization (plan 5.6) ──────────────────────────
test('normalizeCumulativeUsage: missing totals stay null, not zero', () => {
  assert.deepEqual(normalizeCumulativeUsage({ inputTokens: 5, outputTokens: null }), {
    inputTokens: 5, cachedInputTokens: null, cacheWriteInputTokens: null,
    outputTokens: null, reasoningOutputTokens: null,
  });
  assert.equal(normalizeCumulativeUsage(null), null);
});

test('usageTotalFromResult: a pristine watcher does not fabricate zero usage', () => {
  const worker = require('../src/services/worker');
  const state = worker.newWatchState();
  assert.equal(state.inputTokens, null);
  assert.equal(state.outputTokens, null);
  assert.equal(usageTotalFromResult(state), null);
});

// ── Start + idempotent completion over a stubbed transaction ──────────
function makeTransactionPool() {
  // A tiny in-memory stub that behaves like BEGIN/COMMIT + FOR UPDATE lock.
  const rowsById = new Map();
  let activeTurn = null;
  const query = async (sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (/FROM chat_sessions/.test(sql)) {
      return { rows: [{ id: params[0], agent_backend: 'codex_openrouter', agent_config_version: 1, active_turn: activeTurn }] };
    }
    if (/INSERT INTO agent_turns/.test(sql)) {
      const r = {
        id: params[0], session_id: params[1], user_id: params[2],
        requested_model: params[3], reasoning_effort: params[4],
        routed_model: null, status: 'running', metadata: JSON.parse(params[11] || '{}'),
      };
      rowsById.set(params[0], r);
      return { rows: [r] };
    }
    if (/FOR UPDATE/.test(sql)) {
      const row = rowsById.get(params[0]);
      if (!row) return { rows: [] };
      return { rows: [{ ...row, agent_config_version: 1 }] };
    }
    if (/UPDATE agent_turns SET/.test(sql)) {
      const r = rowsById.get(params[0]);
      const reconcileTerminalUsage = params[19] === true;
      if (r && (r.status === 'running' || reconcileTerminalUsage)) {
        if (!reconcileTerminalUsage) r.status = params[1];
        r.agent_thread_id = params[4] || r.agent_thread_id || null;
        r.input_tokens = Number(r.input_tokens || 0) + Number(params[5] || 0);
        r.cached_input_tokens = Number(r.cached_input_tokens || 0) + Number(params[6] || 0);
        r.cache_write_input_tokens = Number(r.cache_write_input_tokens || 0) + Number(params[7] || 0);
        r.output_tokens = Number(r.output_tokens || 0) + Number(params[8] || 0);
        r.reasoning_output_tokens = Number(r.reasoning_output_tokens || 0) + Number(params[9] || 0);
        r.provider_input_tokens_total = params[10];
        r.provider_cached_input_tokens_total = params[11];
        r.provider_cache_write_input_tokens_total = params[12];
        r.provider_output_tokens_total = params[13];
        r.provider_reasoning_output_tokens_total = params[14];
        r.metadata = JSON.parse(params[18] || '{}');
        r.updated = true;
      }
      return { rows: r && r.status ? [{ id: params[0] }] : [] };
    }
    if (/UPDATE chat_sessions/.test(sql)) {
      activeTurn = JSON.parse(params[1]);
      return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
    }
    if (/CREATE TABLE IF NOT EXISTS agent_turns/.test(sql)) {
      return { rows: [] };
    }
    if (/FROM chat_sessions/.test(sql)) {
      return { rows: [{ id: params[0], agent_backend: 'codex_openrouter', agent_config_version: 1, active_turn: null }] };
    }
    return { rows: [] };
  };
  let currentQuery = query;
  const pool = {
    query: (...a) => currentQuery(...a),
    async connect() { return { query: (...a) => currentQuery(...a), release() {} }; },
  };
  return { pool, rowsById, setQuery: (q) => { currentQuery = q; } };
}

test('completeCodexAttempt completes once and is idempotent on repeat', async () => {
  const { pool, rowsById } = makeTransactionPool();
  const started = await startCodexAttempt({
    pool, session: { id: 11, agent_config_version: 1 }, userId: 1,
    logicalTurnId: 'lt-1', attemptNumber: 1, model: 'openai/gpt-5.3-codex',
    resumeThreadId: null, runtimeContext: { credentialId: 5, credentialRevision: 2, agentConfigVersion: 1, pricingSnapshot: { available: true, inputPricePerMillion: 1, outputPricePerMillion: 2 } },
  });
  const first = await completeCodexAttempt({
    pool, turnUuid: started.turnUuid, status: 'completed', threadId: 'thr-1',
    usageTotal: { inputTokens: 100, outputTokens: 20 },
  });
  assert.equal(first.updated, true);
  assert.equal(first.delta.inputTokens, 100);
  assert.equal(first.estimatedCost.costSource, 'requested_model_catalog_estimate');
  assert.equal(rowsById.get(started.turnUuid).status, 'completed');
  assert.equal(rowsById.get(started.turnUuid).routed_model, null,
    'the provider-served model remains unknown when Codex does not report it');

  const second = await completeCodexAttempt({
    pool, turnUuid: started.turnUuid, status: 'completed', threadId: 'thr-1',
    usageTotal: { inputTokens: 200, outputTokens: 40 },
  });
  assert.equal(second.updated, false, 'repeat completion does not double-add');
  assert.equal(second.alreadyTerminal, true);
});

test('OpenRouter completion persists only allowlisted run diagnostics on its authoritative attempt', async () => {
  const previousEnabled = llmTelemetry._setEnabledForTests(true);
  try {
    const { pool, rowsById } = makeTransactionPool();
    const started = await startCodexAttempt({
      pool, session: { id: 111, agent_config_version: 1 }, userId: 1,
      logicalTurnId: 'lt-telemetry', attemptNumber: 1, model: 'openai/gpt-5.3-codex',
      reasoningEffort: 'high', resumeThreadId: 'thread-prior',
      telemetryComponent: 'coding_agent_build',
      runtimeContext: {
        agentConfigVersion: 1,
        pricingSnapshot: { available: true, inputPricePerMillion: 1, outputPricePerMillion: 2 },
      },
    });
    await completeCodexAttempt({
      pool, turnUuid: started.turnUuid, status: 'completed', threadId: 'thread-prior',
      usageTotal: { inputTokens: 100, outputTokens: 20 },
      telemetryComponent: 'coding_agent_build',
      telemetryMetrics: {
        requestMode: 'agent_resume', requestTextCharacters: 1234,
        toolCallCount: 4, providerRetryCount: 1,
        telemetryToolNames: new Set(['command', 'file_read']),
        prompt: 'private prompt', rawError: 'private error',
        toolInput: { secret: true }, filename: '/private/path',
      },
    });
    const metadata = rowsById.get(started.turnUuid).metadata;
    assert.equal(metadata.telemetry_component, 'coding_agent_build');
    assert.deepEqual(metadata.telemetry_metrics, {
      request_mode: 'agent_resume',
      reasoning_effort: 'high',
      request_text_characters: 1234,
      provider_retry_count: 1,
      tool_call_count: 4,
      distinct_tool_count: 2,
      usage_reset_detected: false,
    });
    const serialized = JSON.stringify(metadata);
    for (const secret of ['private prompt', 'private error', 'secret', '/private/path']) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally {
    llmTelemetry._setEnabledForTests(previousEnabled);
  }
});

test('completeCodexAttempt records unavailable cost when usage was not observed', async () => {
  const { pool } = makeTransactionPool();
  const started = await startCodexAttempt({
    pool, session: { id: 12, agent_config_version: 1 }, userId: 1,
    logicalTurnId: 'lt-no-usage', attemptNumber: 1, model: 'm',
    resumeThreadId: null,
    runtimeContext: {
      agentConfigVersion: 1,
      pricingSnapshot: { available: true, inputPricePerMillion: 1, outputPricePerMillion: 2 },
    },
  });
  const out = await completeCodexAttempt({
    pool, turnUuid: started.turnUuid, status: 'completed', usageTotal: null,
  });
  assert.deepEqual(out.estimatedCost, {
    costSource: 'unavailable', estimatedCostUsd: null,
  });
});

test('completeCodexAttempt reconciles late usage into a force-cancelled row exactly once', async () => {
  const { pool, rowsById } = makeTransactionPool();
  const started = await startCodexAttempt({
    pool, session: { id: 13, agent_config_version: 1 }, userId: 1,
    logicalTurnId: 'lt-force-race', attemptNumber: 1, model: 'm',
    resumeThreadId: null,
    runtimeContext: {
      agentConfigVersion: 1,
      pricingSnapshot: { available: true, inputPricePerMillion: 1, outputPricePerMillion: 2 },
    },
  });

  await completeCodexAttempt({
    pool,
    turnUuid: started.turnUuid,
    status: 'cancelled',
    errorCode: 'user_cancelled',
    usageTotal: null,
  });
  const cancelled = rowsById.get(started.turnUuid);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.provider_input_tokens_total, null);

  const late = await completeCodexAttempt({
    pool,
    turnUuid: started.turnUuid,
    status: 'completed',
    threadId: 'thr-force-race',
    usageTotal: { inputTokens: 120, outputTokens: 30 },
  });
  assert.equal(late.updated, true);
  assert.equal(late.reconciled, true);
  assert.equal(late.alreadyTerminal, true);
  assert.equal(cancelled.status, 'cancelled', 'late owner cannot reverse the force-stop outcome');
  assert.equal(cancelled.input_tokens, 120);
  assert.equal(cancelled.output_tokens, 30);
  assert.equal(cancelled.provider_input_tokens_total, 120);

  const repeat = await completeCodexAttempt({
    pool,
    turnUuid: started.turnUuid,
    status: 'completed',
    threadId: 'thr-force-race',
    usageTotal: { inputTokens: 120, outputTokens: 30 },
  });
  assert.equal(repeat.updated, false);
  assert.equal(cancelled.input_tokens, 120, 'reconciliation cannot double-add usage');
});

test('completeCodexAttempt throws for a genuinely missing turn', async () => {
  const { pool } = makeTransactionPool();
  await assert.rejects(
    () => completeCodexAttempt({ pool, turnUuid: 'missing', status: 'completed', usageTotal: { inputTokens: 10 } }),
    (err) => {
      assert.match(err?.message || '', /agent attempt not found/);
      assert.equal(err?.code, 'agent_attempt_not_found');
      assert.equal(recoveryRetry.shouldRetryRecoveryError(err), false,
        'a durable pointer to a deleted attempt cannot heal through backoff');
      return true;
    },
  );
});

test('completeCodexAttempt subtracts snake_case totals loaded from the database', async () => {
  const running = {
    id: 'current', session_id: 11, user_id: 1, backend: 'codex_openrouter',
    requested_model: 'm', agent_thread_id: 'thr-1', status: 'running',
    metadata: { pricing: { available: false } }, logical_turn_id: 'logical',
    attempt_number: 2,
  };
  const previous = {
    provider_input_tokens_total: 100,
    provider_cached_input_tokens_total: 30,
    provider_cache_write_input_tokens_total: 2,
    provider_output_tokens_total: 20,
    provider_reasoning_output_tokens_total: 1,
  };
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/WHERE id = \$1[\s\S]*FOR UPDATE/.test(sql)) return { rows: [running] };
      if (/FROM agent_turns[\s\S]*status IN \('completed', 'failed', 'cancelled'\)/.test(sql)) return { rows: [previous] };
      if (/UPDATE agent_turns SET/.test(sql)) return { rows: [{ id: running.id }] };
      return { rows: [] };
    },
    release() {},
  };
  const out = await completeCodexAttempt({
    pool: { connect: async () => client },
    turnUuid: running.id,
    threadId: 'thr-1',
    usageTotal: {
      inputTokens: 180, cachedInputTokens: 40, cacheWriteInputTokens: 5,
      outputTokens: 35, reasoningOutputTokens: 2,
    },
  });
  assert.deepEqual(out.delta, {
    inputTokens: 80, cachedInputTokens: 10, cacheWriteInputTokens: 3,
    outputTokens: 15, reasoningOutputTokens: 1,
  });
});

test('completeCodexAttempt preserves each baseline across an intervening partial report', async () => {
  const running = {
    id: 'attempt-3', session_id: 11, user_id: 1, backend: 'codex_openrouter',
    requested_model: 'm', agent_thread_id: 'thr-partial', status: 'running',
    metadata: { pricing: { available: false } }, logical_turn_id: 'logical-3',
    attempt_number: 3,
  };
  // Newest first: attempt two omitted several dimensions that attempt one
  // observed. The aggregate query must retain attempt one's last known totals
  // for only those missing dimensions.
  const previousAttempts = [
    {
      provider_input_tokens_total: 180,
      provider_cached_input_tokens_total: null,
      provider_cache_write_input_tokens_total: 9,
      provider_output_tokens_total: null,
      provider_reasoning_output_tokens_total: null,
    },
    {
      provider_input_tokens_total: 100,
      provider_cached_input_tokens_total: 40,
      provider_cache_write_input_tokens_total: 2,
      provider_output_tokens_total: 50,
      provider_reasoning_output_tokens_total: 10,
    },
  ];
  const dimensions = [
    'provider_input_tokens_total',
    'provider_cached_input_tokens_total',
    'provider_cache_write_input_tokens_total',
    'provider_output_tokens_total',
    'provider_reasoning_output_tokens_total',
  ];
  const previous = Object.fromEntries(dimensions.map((column) => [
    column,
    previousAttempts.find((attempt) => attempt[column] != null)?.[column] ?? null,
  ]));
  let baselineSql = '';
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/WHERE id = \$1[\s\S]*FOR UPDATE/.test(sql)) return { rows: [running] };
      if (/FROM agent_turns[\s\S]*status IN \('completed', 'failed', 'cancelled'\)/.test(sql)) {
        baselineSql = String(sql);
        return { rows: [previous] };
      }
      if (/UPDATE agent_turns SET/.test(sql)) return { rows: [{ id: running.id }] };
      return { rows: [] };
    },
    release() {},
  };

  const out = await completeCodexAttempt({
    pool: { connect: async () => client },
    turnUuid: running.id,
    threadId: 'thr-partial',
    usageTotal: {
      inputTokens: 250,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 12,
      outputTokens: 100,
      reasoningOutputTokens: 15,
    },
  });

  assert.deepEqual(out.delta, {
    inputTokens: 70,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 3,
    outputTokens: 50,
    reasoningOutputTokens: 5,
  });
  for (const column of dimensions) {
    assert.match(
      baselineSql,
      new RegExp(`ARRAY_AGG\\(${column}[\\s\\S]*?FILTER \\(WHERE ${column} IS NOT NULL\\)`),
      `${column} has its own latest non-null baseline`,
    );
  }
  assert.doesNotMatch(baselineSql, /LIMIT 1/,
    'an intervening partial row cannot hide an older per-dimension baseline');
  assert.match(baselineSql,
    /ROW_NUMBER\(\) OVER \([\s\S]*ORDER BY completed_at DESC NULLS LAST, id DESC/,
    'provider snapshots have one deterministic recency order');
  assert.match(baselineSql,
    /WHERE recency <= COALESCE\([\s\S]*WHERE usage_reset_detected/,
    'per-dimension lookback stops at the latest provider counter reset');
});

// ── Commit 5: retry/attempt-loop + shared recovery settlement ─────────
const {
  runCodexAttemptLoop,
  resumeRecoveredCodexFreshRetry,
} = require('../src/routes/sessions');
const { settleRecoveredAgentAttempt } = require('../src/services/agent-turn');

function makeLoopPool() {
  // Records start/complete attempts; behaves transactionally enough for
  // startCodexAttempt (pool.query) and completeCodexAttempt (connect).
  const attempts = [];
  const rowsById = new Map();
  let activeTurn = null;
  let attemptSeq = 0;
  const query = async (sql, params) => {
    if (/FROM chat_sessions/.test(sql)) {
      return { rows: [{ id: params[0], agent_backend: 'codex_openrouter', agent_config_version: 1, active_turn: activeTurn }] };
    }
    if (/INSERT INTO agent_turns/.test(sql)) {
      attemptSeq += 1;
      const r = {
        id: params[0], session_id: params[1], user_id: params[2],
        requested_model: params[3], status: 'running',
        agent_thread_id: params[7],
        attempt_number: params[10], logical_turn_id: params[9],
        agent_config_version: params[8], metadata: { pricing: { available: true, inputPricePerMillion: 1, outputPricePerMillion: 1 } },
      };
      rowsById.set(params[0], r);
      attempts.push(r);
      return { rows: [r] };
    }
    if (/FOR UPDATE/.test(sql)) return { rows: [rowsById.get(params[0])].filter(Boolean) };
    if (/UPDATE agent_turns SET/.test(sql)) {
      const r = rowsById.get(params[0]);
      if (r && r.status === 'running') {
        r.status = params[1];
        r.updated = true;
        r.input_tokens = params[5];
        r.output_tokens = params[8];
        r.provider_input_tokens_total = params[10];
        r.provider_output_tokens_total = params[13];
      }
      return { rows: r ? [{ id: params[0] }] : [] };
    }
    if (/UPDATE chat_sessions/.test(sql)) {
      activeTurn = JSON.parse(params[1]);
      return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
    }
    return { rows: [] };
  };
  let currentQuery = query;
  const pool = {
    query: (...a) => currentQuery(...a),
    async connect() { return { query: (...a) => currentQuery(...a), release() {} }; },
  };
  pool._clearActiveTurn = () => { activeTurn = null; };
  pool._prepareFreshRetry = () => {
    activeTurn = { ...activeTurn, phase: 'tail_pending', retryFresh: true };
  };
  return { pool, attempts, rowsById, baseQuery: query, setQuery: (q) => { currentQuery = q; } };
}

test('attempt loop: one logical turn, two attempts, both terminal, no lost usage', async () => {
  const { pool, attempts } = makeLoopPool();
  let dispatchCalls = 0;
  const result = await runCodexAttemptLoop({
    pool,
    session: { id: 1, agent_config_version: 1 },
    userId: 1, config: {},
    resolveRuntime: async () => ({
      agentBackend: 'codex_openrouter', agentModel: 'openai/gpt-5.3-codex',
      agentReasoningEffort: null, resumeThreadId: 'thr-1',
      credentialId: 1, credentialRevision: 1, agentConfigVersion: 1,
      pricingSnapshot: { available: true, inputPricePerMillion: 1, outputPricePerMillion: 1 },
    }),
    dispatchOnce: async (ctx) => {
      dispatchCalls += 1;
      if (dispatchCalls === 1) {
        // First physical invocation produced NO output (markerless) → retry.
        return { exitCode: -1, resultSeen: false, lastResultText: '' };
      }
      return { exitCode: 0, resultSeen: true, agentThreadId: 'thr-1' };
    },
    retryPredicate: (r) => r && r.exitCode === -1 && !r.resultSeen,
    prepareRetry: async () => { pool._clearActiveTurn(); return true; },
  });
  assert.equal(dispatchCalls, 2, 'retried exactly once');
  assert.equal(attempts.length, 2, 'two agent_turns rows (one per physical invocation)');
  assert.equal(attempts[0].logical_turn_id, attempts[1].logical_turn_id, 'same logical turn id');
  assert.equal(attempts[0].attempt_number, 1);
  assert.equal(attempts[1].attempt_number, 2);
  assert.equal(attempts[0].status, 'failed', 'first markerless attempt terminal as failed');
  assert.equal(attempts[1].status, 'completed', 'second attempt terminal as completed');
});

test('attempt loop: terminal after a single successful dispatch (no retry)', async () => {
  const { pool, attempts } = makeLoopPool();
  await runCodexAttemptLoop({
    pool, session: { id: 1, agent_config_version: 1 }, userId: 1, config: {},
    resolveRuntime: async () => ({ agentBackend: 'codex_openrouter', agentModel: 'm', pricingSnapshot: { available: false } }),
    dispatchOnce: async () => ({ exitCode: 0, resultSeen: true }), // honest terminal
    retryPredicate: () => false,
  });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'completed');
});

// #2118: the figure the dev-chat composer shows for an OpenRouter turn is the
// ledger's own estimate, summed over the turn's attempts — published on the
// session's progress entry for the /status poll and returned to the caller.
test('attempt loop: the turn\'s recorded cost is published for the live meter and returned', async () => {
  const workerProgress = require('../src/services/worker-progress');
  const { pool, attempts } = makeLoopPool();
  workerProgress.clear(1);
  let dispatchCalls = 0;
  const result = await runCodexAttemptLoop({
    pool,
    session: { id: 1, agent_config_version: 1 },
    userId: 1, config: {},
    resolveRuntime: async () => ({
      agentBackend: 'codex_openrouter', agentModel: 'openai/gpt-5.3-codex',
      pricingSnapshot: { available: true, inputPricePerMillion: 1, outputPricePerMillion: 1 },
    }),
    dispatchOnce: async () => {
      dispatchCalls += 1;
      if (dispatchCalls === 1) {
        // A markerless first attempt that still consumed tokens was paid
        // for, so it counts towards the turn.
        return { exitCode: -1, resultSeen: false, lastResultText: '', inputTokens: 1000, outputTokens: 500 };
      }
      return { exitCode: 0, resultSeen: true, agentThreadId: 'thr-1', inputTokens: 2000, outputTokens: 1000 };
    },
    retryPredicate: (r) => r && r.exitCode === -1 && !r.resultSeen,
    prepareRetry: async () => { pool._clearActiveTurn(); return true; },
  });
  assert.equal(attempts.length, 2);
  // 1,500 tokens at $1/M, then 3,000 at $1/M: $0.0015 + $0.003.
  assert.ok(Math.abs(result.estimatedCostUsd - 0.0045) < 1e-12, String(result.estimatedCostUsd));
  assert.deepEqual(workerProgress.get(1).spend, { costCents: 0.45, estimated: true });
  workerProgress.clear(1);
});

test('attempt loop: a turn whose usage was never observed reports no cost, not zero', async () => {
  const workerProgress = require('../src/services/worker-progress');
  const { pool } = makeLoopPool();
  workerProgress.clear(1);
  const result = await runCodexAttemptLoop({
    pool, session: { id: 1, agent_config_version: 1 }, userId: 1, config: {},
    resolveRuntime: async () => ({
      agentBackend: 'codex_openrouter', agentModel: 'm',
      pricingSnapshot: { available: true, inputPricePerMillion: 1, outputPricePerMillion: 1 },
    }),
    dispatchOnce: async () => ({ exitCode: 0, resultSeen: true }),
    retryPredicate: () => false,
  });
  assert.equal(result.estimatedCostUsd, null);
  assert.equal(workerProgress.get(1), null, 'nothing is published for the meter to show');
});

test('attempt loop: a requested stop terminalizes the observed attempt as cancelled', async () => {
  const { pool, attempts } = makeLoopPool();
  await runCodexAttemptLoop({
    pool, session: { id: 1, agent_config_version: 1 }, userId: 1, config: {},
    resolveRuntime: async () => ({
      agentBackend: 'codex_openrouter', agentModel: 'm',
      pricingSnapshot: { available: false },
    }),
    dispatchOnce: async () => ({
      exitCode: 143,
      resultSeen: true,
      inputTokens: 25,
      outputTokens: 5,
    }),
    retryPredicate: () => false,
    classifyAttemptStatus: () => 'cancelled',
  });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'cancelled');
  assert.equal(attempts[0].input_tokens, 25);
  assert.equal(attempts[0].output_tokens, 5);
  assert.equal(attempts[0].provider_input_tokens_total, 25);
  assert.equal(attempts[0].provider_output_tokens_total, 5,
    'cancellation retains the provider totals observed before the stop landed');
});

test('attempt loop: ledger completion failure is not retried without observed usage', async () => {
  const { pool, baseQuery, setQuery } = makeLoopPool();
  let completionUpdates = 0;
  setQuery(async (sql, params) => {
    if (/UPDATE agent_turns SET/.test(sql)) {
      completionUpdates += 1;
      throw new Error('ledger unavailable');
    }
    return baseQuery(sql, params);
  });

  await assert.rejects(
    runCodexAttemptLoop({
      pool, session: { id: 1, agent_config_version: 1 }, userId: 1, config: {},
      resolveRuntime: async () => ({
        agentBackend: 'codex_openrouter', agentModel: 'm',
        pricingSnapshot: { available: false },
      }),
      dispatchOnce: async () => ({
        exitCode: 0,
        resultSeen: true,
        inputTokens: 101,
        outputTokens: 19,
      }),
      retryPredicate: () => false,
    }),
    /ledger unavailable/,
  );
  assert.equal(completionUpdates, 1,
    'a failed required completion must not be followed by a null-usage terminalization');
});

test('attempt loop: stale resume becomes a fresh second physical attempt', async () => {
  const { pool, attempts } = makeLoopPool();
  const resumeIds = [];
  const persistenceRequirements = [];
  let prepared = 0;
  let waited = 0;
  const out = await runCodexAttemptLoop({
    pool,
    session: { id: 1, agent_config_version: 1 },
    userId: 1,
    resumeThreadId: 'stale-thread',
    resolveRuntime: async () => ({
      agentBackend: 'codex_openrouter', agentModel: 'm',
      resumeThreadId: 'stale-thread', agentConfigVersion: 1,
      pricingSnapshot: { available: false },
    }),
    dispatchOnce: async (ctx) => {
      resumeIds.push(ctx.resumeSessionId);
      persistenceRequirements.push(ctx.requireActiveTurnPersistence);
      if (resumeIds.length === 1) {
        return {
          resultSeen: true, exitCode: 1, agentExit: 1,
          agentRetryFresh: true,
        };
      }
      return {
        resultSeen: true, exitCode: 0, agentExit: 0,
        agentThreadId: 'new-thread',
      };
    },
    retryPredicate: () => false,
    waitForStopped: async () => { waited += 1; },
    prepareRetry: async () => {
      prepared += 1;
      pool._prepareFreshRetry();
    },
  });
  assert.deepEqual(resumeIds, ['stale-thread', null]);
  assert.deepEqual(persistenceRequirements, [false, true],
    'attempt two must persist its recovery journal before paid dispatch');
  assert.equal(attempts.length, 2, 'one ledger row per physical dispatch');
  assert.equal(attempts[0].status, 'failed');
  assert.equal(attempts[1].status, 'completed');
  assert.equal(attempts[0].agent_thread_id, 'stale-thread');
  assert.equal(attempts[1].agent_thread_id, null);
  assert.equal(prepared, 1, 'held turn state is cleared before attempt 2');
  assert.equal(waited, 0, 'a terminal runner does not need a zombie-process kill');
  assert.equal(out.result.agentThreadId, 'new-thread');
});

test('attempt loop: a stop reported by retry preparation prevents attempt two', async () => {
  const { pool, attempts } = makeLoopPool();
  let dispatchCalls = 0;
  let retryContext = null;
  const out = await runCodexAttemptLoop({
    pool,
    session: { id: 1, agent_config_version: 1 },
    userId: 1,
    resumeThreadId: 'stale-thread',
    resolveRuntime: async () => ({
      agentBackend: 'codex_openrouter', agentModel: 'm',
      resumeThreadId: 'stale-thread', agentConfigVersion: 1,
      pricingSnapshot: { available: false },
    }),
    dispatchOnce: async () => {
      dispatchCalls += 1;
      return {
        resultSeen: true, exitCode: 1, agentExit: 1,
        agentRetryFresh: true,
      };
    },
    retryPredicate: () => false,
    prepareRetry: async (ctx) => {
      retryContext = ctx;
      return false; // user stop landed while preparing the retry
    },
  });

  assert.equal(dispatchCalls, 1, 'no second paid dispatch');
  assert.equal(attempts.length, 1, 'no second ledger row is created');
  assert.equal(attempts[0].status, 'failed', 'attempt one still terminalizes');
  assert.equal(retryContext.retryFresh, true);
  assert.equal(retryContext.attemptNumber, 1);
  assert.equal(out.result.agentRetryFresh, true);
});

test('startCodexAttempt atomically replaces a prepared tail with attempt two dispatch intent', async () => {
  const activeTurn = {
    backend: 'codex_openrouter', phase: 'tail_pending', retryFresh: true,
    turnUuid: 'attempt-1', logicalTurnId: 'logical-1', attemptNumber: 1,
  };
  const seen = [];
  const client = {
    async query(sql, params = []) {
      seen.push({ sql: String(sql), params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/FROM chat_sessions/.test(sql)) {
        return {
          rows: [{
            id: 7, agent_backend: 'codex_openrouter',
            agent_config_version: 1, active_turn: activeTurn,
          }],
        };
      }
      if (/INSERT INTO agent_turns/.test(sql)) return { rows: [] };
      if (/UPDATE chat_sessions/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
    release() {},
  };
  const started = await startCodexAttempt({
    pool: { connect: async () => client },
    session: { id: 7, agent_config_version: 1 },
    userId: 9,
    logicalTurnId: 'logical-1',
    attemptNumber: 2,
    model: 'm',
    resumeThreadId: null,
    runtimeContext: { agentConfigVersion: 1, pricingSnapshot: { available: false } },
    allowRetryPending: true,
  });

  const advanced = seen.find((q) => /UPDATE chat_sessions/.test(q.sql));
  assert.ok(advanced, 'dispatch intent advances in the ledger insert transaction');
  const patch = JSON.parse(advanced.params[1]);
  assert.equal(patch.phase, 'dispatch_pending');
  assert.equal(patch.turnId, 'logical-1');
  assert.equal(patch.turnUuid, started.turnUuid);
  assert.equal(patch.logicalTurnId, 'logical-1');
  assert.equal(patch.attemptNumber, 2);
  assert.equal(patch.journal, started.journal);
  const insertIdx = seen.findIndex((q) => /INSERT INTO agent_turns/.test(q.sql));
  const updateIdx = seen.findIndex((q) => /UPDATE chat_sessions/.test(q.sql));
  const commitIdx = seen.findIndex((q) => q.sql === 'COMMIT');
  assert.ok(insertIdx < updateIdx && updateIdx < commitIdx);
});

test('attempt loop: surfaced backend errors pass through unresolved', async () => {
  const { pool, attempts } = makeLoopPool();
  const out = await runCodexAttemptLoop({
    pool, session: { id: 1, agent_config_version: 1 }, userId: 1, config: {},
    resolveRuntime: async () => ({ error: 'credential_required' }),
    dispatchOnce: async () => ({}),
    retryPredicate: () => false,
  });
  assert.equal(out.error, 'credential_required');
  assert.match(out.logicalTurnId, /^[0-9a-f-]{36}$/,
    'every error path retains the stable cleanup identity');
  assert.equal(attempts.length, 0, 'no ledger row before a successful start');
});

test('recovery settlement: codex terminalizes in agent ledger, never Claude limits', async () => {
  const { pool, rowsById } = makeLoopPool();
  // Insert a genuine running attempt row directly (as dispatch would).
  await runCodexAttemptLoop({
    pool, session: { id: 1, agent_config_version: 1 }, userId: 1, config: {},
    resolveRuntime: async () => ({ agentBackend: 'codex_openrouter', agentModel: 'm', pricingSnapshot: { available: false } }),
    dispatchOnce: async (ctx) => ({}),
    retryPredicate: () => false,
  });
  pool._clearActiveTurn();
  // Grab the running row BEFORE the loop completes it — instead, start a
  // fresh row that stays 'running' by never dispatching completion again.
  const { startCodexAttempt } = require('../src/services/agent-turn');
  const started = await startCodexAttempt({
    pool, session: { id: 1, agent_config_version: 1 }, userId: 1,
    logicalTurnId: 'lt-rec', attemptNumber: 1, model: 'm', resumeThreadId: null,
    runtimeContext: { pricingSnapshot: { available: false } },
  });
  let claudeSettled = 0;
  const out = await settleRecoveredAgentAttempt({
    pool,
    activeTurn: { backend: 'codex_openrouter', turnUuid: started.turnUuid },
    result: { exitCode: 0, resultSeen: true, inputTokens: 50, outputTokens: 10 },
    settleClaude: async () => { claudeSettled += 1; return null; },
  });
  assert.equal(out.updated, true, 'codex attempt terminalized');
  assert.equal(rowsById.get(started.turnUuid).status, 'completed');
  assert.equal(claudeSettled, 0, 'codex recovery never touches Claude limits');

  // Idempotent: settling the same terminal row again adds nothing.
  const again = await settleRecoveredAgentAttempt({
    pool,
    activeTurn: { backend: 'codex_openrouter', turnUuid: started.turnUuid },
    result: { exitCode: 0, resultSeen: true, inputTokens: 50, outputTokens: 10 },
    settleClaude: async () => { claudeSettled += 1; return null; },
  });
  assert.equal(again.updated, false);
  assert.equal(again.alreadyTerminal, true);
});

test('recovery settlement: Claude passes through to settleClaude', async () => {
  let claudeSettled = 0;
  await settleRecoveredAgentAttempt({
    pool: {}, activeTurn: { backend: 'claude_code' },
    result: { costUsd: 0.05 },
    settleClaude: async () => { claudeSettled += 1; return null; },
  });
  assert.equal(claudeSettled, 1);
});

test('recovery persists a newly discovered Codex thread id exactly once', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const session = { id: 91, agent_thread_id: null };
  const first = await persistRecoveredAgentThread({
    pool, session, result: { agentThreadId: 'recovered-thread' },
  });
  assert.deepEqual(first, { updated: true, threadId: 'recovered-thread' });
  assert.equal(session.agent_thread_id, 'recovered-thread');
  assert.deepEqual(calls[0].params, ['recovered-thread', 91]);

  const again = await persistRecoveredAgentThread({
    pool, session, result: { agentThreadId: 'recovered-thread' },
  });
  assert.equal(again.updated, false);
  assert.equal(calls.length, 1);
});

function makeRecoveredLifecyclePool(initialActiveTurn) {
  let activeTurn = initialActiveTurn;
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/SELECT active_turn/.test(text)) {
        return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
      }
      if (/SET active_turn = active_turn \|\| \$3::jsonb/.test(text)) {
        activeTurn = { ...activeTurn, ...JSON.parse(params[2]) };
        return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
      }
      throw new Error(`unexpected recovery SQL: ${text}`);
    },
  };
  return { pool, calls, getActiveTurn: () => activeTurn };
}

test('restart recovery fails closed instead of dispatching a fresh paid attempt', async () => {
  const durable = makeRecoveredLifecyclePool({
    turnId: 'logical-1',
    backend: 'codex_openrouter',
    mode: 'build',
    journal: '/turn-1.log',
    phase: 'tail_pending',
    retryFresh: true,
    turnUuid: 'attempt-1',
    logicalTurnId: 'logical-1',
    attemptNumber: 1,
    tail: {},
  });
  let dispatched = 0;
  const out = await resumeRecoveredCodexFreshRetry({
    pool: durable.pool,
    session: { id: 42, user_id: 8 },
    activeTurn: durable.getActiveTurn(),
    result: {
      agentRetryFresh: true,
      exitCode: 1,
      inputTokens: 900,
      outputTokens: 100,
    },
    // Deliberately supplied to prove recovery ignores the old injection seam.
    dispatchOnce: async () => { dispatched += 1; return {}; },
  });

  assert.equal(dispatched, 0, 'restart recovery never creates a provider request');
  assert.equal(out.activeTurn.phase, 'tail_pending');
  assert.equal(out.activeTurn.retryFresh, false);
  assert.equal(out.activeTurn.recoveryFailure, 'restart_retry_requires_user');
  assert.equal(out.result.agentRetryFresh, false);
  assert.equal(out.result.inputTokens, 900, 'attempt-one usage remains attached for settlement');
  assert.match(out.result.fatalError, /no automatic retry was dispatched/i);
  assert.equal(durable.calls.filter((c) => /UPDATE chat_sessions/.test(c.sql)).length, 1);
});

test('legacy registered-retry state is terminalized without redispatch', async () => {
  const durable = makeRecoveredLifecyclePool({
    backend: 'codex_openrouter',
    mode: 'scout',
    journal: '/turn-legacy.log',
    phase: 'retry_dispatch_pending',
    retryFresh: true,
    turnUuid: 'attempt-2',
    logicalTurnId: 'logical-1',
    attemptNumber: 2,
    tail: {},
  });
  const out = await resumeRecoveredCodexFreshRetry({
    pool: durable.pool,
    session: { id: 42, user_id: 8 },
    activeTurn: durable.getActiveTurn(),
    result: { exitCode: -1, resultSeen: false },
  });

  assert.equal(out.activeTurn.turnUuid, 'attempt-2');
  assert.equal(out.activeTurn.phase, 'tail_pending');
  assert.equal(out.result.resultSeen, true);
  assert.match(out.result.fatalError, /retry this turn to start fresh/i);
  const update = durable.calls.find((c) => /UPDATE chat_sessions/.test(c.sql));
  assert.match(update.sql, /active_turn->>'journal'/, 'legacy rows use their journal as CAS identity');
});

test('ordinary recovered Codex output bypasses the retry boundary', async () => {
  const durable = makeRecoveredLifecyclePool({
    turnId: 'logical-1',
    backend: 'codex_openrouter',
    phase: 'executing',
    turnUuid: 'attempt-1',
    journal: '/turn-1.log',
  });
  const out = await resumeRecoveredCodexFreshRetry({
    pool: durable.pool,
    session: { id: 42 },
    activeTurn: durable.getActiveTurn(),
    result: { resultSeen: true, exitCode: 0, agentRetryFresh: false },
  });
  assert.equal(out, null);
  assert.equal(durable.calls.length, 0);
});

function registeredRetryState(overrides = {}) {
  return {
    status: 'running',
    session_id: '42',
    user_id: '8',
    requested_model: 'm',
    reasoning_effort: null,
    credential_id: '71',
    credential_revision: 3,
    agent_thread_id: null,
    agent_config_version: 1,
    logical_turn_id: 'logical-1',
    attempt_number: 2,
    ...overrides,
  };
}
test('getCodexAttemptRecoveryState reads the registered attempt context', async () => {
  const calls = [];
  const expected = registeredRetryState();
  const state = await getCodexAttemptRecoveryState({
    pool: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [expected] };
      },
    },
    turnUuid: 'attempt-2',
  });

  assert.equal(state, expected);
  assert.deepEqual(calls[0].params, ['attempt-2']);
  assert.match(calls[0].sql, /backend = 'codex_openrouter'/);
  assert.match(calls[0].sql, /credential_revision/);
  assert.match(calls[0].sql, /agent_config_version/);
});

test('interactive detached-turn recovery invokes the shared thread persistence helper', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('async function resumeDetachedTurnInner');
  const end = source.indexOf('\nasync function ', start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);
  assert.match(body, /persistRecoveredAgentThread\(\{ pool, session, result \}\)/);
  assert.doesNotMatch(body, /persistRecoveredAgentThread\([^;]+\.catch/,
    'thread persistence is required before cleanup');
  assert.doesNotMatch(body, /completeCodexTurn\([\s\S]{0,180}?\.catch/,
    'recovered Codex terminalization is required before narration or cleanup');
  assert.match(body, /const cleanupArgs = turnCleanupArgs\(activeTurn\)/,
    'cleanup derives the strongest available durable identity');
  assert.match(body, /finishTurn\(sessionId, cleanupArgs\)/,
    'recovery cleanup uses the derived owner identity');
});

// ── Commit 6: dispatch rejects stale agent config version (plan 8.5) ──
test('attempt loop: refuses to dispatch when the config version changed', async () => {
  const { pool, baseQuery, setQuery } = makeLoopPool();
  // Stub the session-lock response to report a bumped config version
  // (a reset happened after runtime context was resolved).
  setQuery(async (sql, params) => {
    if (/FROM chat_sessions/.test(sql)) {
      return { rows: [{ id: params[0], agent_backend: 'codex_openrouter', agent_config_version: 99, active_turn: null }] };
    }
    return baseQuery(sql, params);
  });
  let dispatchCalls = 0;
  const out = await runCodexAttemptLoop({
    pool, session: { id: 1, agent_config_version: 1 }, userId: 1, config: {},
    resolveRuntime: async () => ({ agentBackend: 'codex_openrouter', agentModel: 'm', agentConfigVersion: 1, resumeThreadId: null, pricingSnapshot: { available: false } }),
    dispatchOnce: async () => { dispatchCalls += 1; return { exitCode: 0, resultSeen: true }; },
    retryPredicate: () => false,
  });
  assert.equal(out.error, 'agent_context_changed', 'stale version blocks dispatch');
  assert.equal(dispatchCalls, 0, 'no paid provider request with stale config');
});

test('attempt loop: refuses to dispatch when the backend changed', async () => {
  const { pool, baseQuery, setQuery } = makeLoopPool();
  setQuery(async (sql, params) => {
    if (/FROM chat_sessions/.test(sql)) {
      return { rows: [{ id: params[0], agent_backend: 'claude_code', agent_config_version: 1, active_turn: null }] };
    }
    return baseQuery(sql, params);
  });
  let dispatchCalls = 0;
  const out = await runCodexAttemptLoop({
    pool, session: { id: 1, agent_config_version: 1 }, userId: 1, config: {},
    resolveRuntime: async () => ({ agentBackend: 'codex_openrouter', agentModel: 'm', agentConfigVersion: 1, resumeThreadId: null, pricingSnapshot: { available: false } }),
    dispatchOnce: async () => { dispatchCalls += 1; return { exitCode: 0, resultSeen: true }; },
    retryPredicate: () => false,
  });
  assert.equal(out.error, 'agent_context_changed');
  assert.equal(dispatchCalls, 0);
});
