'use strict';

// Per-turn agent context resolution + ledger (plan.md §11, §6). Given a
// session, this resolves which backend runs the turn and, for
// codex_openrouter, records each physical Codex invocation as one
// `agent_turns` attempt row (plan §6: one row per physical invocation,
// per-attempt independent start/finish, cumulative provider totals with
// transactional deltas). Claude turns return null context (unchanged
// path); the raw OpenRouter key is returned ONLY for the codex_openrouter
// turn and is injected per-exec, never into the warm container.

const crypto = require('crypto');
const platformJwt = require('./platform-jwt');
const credentialStore = require('./credential-store');
const registry = require('../agents/registry');
const agentModels = require('./agent-models');
const log = require('./logger');
const turnLifecycle = require('./turn-lifecycle');
const llmTelemetry = require('./llm-telemetry');

// Resolve the backend for a turn from the session row (pinned at session
// creation). Falls back to claude_code for legacy sessions.
function backendForSession(session) {
  return registry.resolveBackend(session?.agent_backend || 'claude_code');
}

// Normalize a nonnegative integer, returning null for missing/invalid — a
// missing usage total must remain null, never a false zero (plan 5.6, 6.6).
function normalizeNonNegativeInteger(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0; // provider totals are nonnegative
  return Math.round(n);
}

// Build the immutable pricing snapshot from the sanitized catalog model.
function pricingSnapshotForModel(model) {
  if (!model) return null;
  const inP = model.inputPricePerMillion;
  const outP = model.outputPricePerMillion;
  const okIn = inP != null && Number.isFinite(inP);
  const okOut = outP != null && Number.isFinite(outP);
  if (!okIn || !okOut || inP < 0 || outP < 0) return { available: false };
  return {
    available: true,
    model: model.id || null,
    inputPricePerMillion: inP,
    outputPricePerMillion: outP,
    capturedAt: new Date().toISOString(),
    pricingAssumption: 'cached input priced at ordinary prompt rate',
  };
}

// Runtime metadata for Codex's per-turn custom model catalog. OpenRouter is
// the source of truth; keep the full executable id while bounding only the
// human-readable name and normalizing numeric/capability fields. A null
// capability means the catalog fetch was unavailable, not that the model
// definitely lacks it.
function runtimeModelMetadataForModel(model, requestedModelId) {
  const positiveInteger = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  };
  const efforts = Array.isArray(model?.reasoningEfforts)
    ? [...new Set(model.reasoningEfforts
      .map((effort) => String(effort || '').trim())
      .filter((effort) => ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)))]
    : null;
  return {
    name: String(model?.name || requestedModelId || '').trim().slice(0, 300)
      || String(requestedModelId || ''),
    contextWindow: positiveInteger(model?.contextLength),
    maxOutputTokens: positiveInteger(model?.maxOutputTokens),
    supportsReasoning: model ? model.supportsReasoning === true : null,
    reasoningEfforts: efforts,
    supportsTools: model ? model.supportsTools === true : null,
  };
}

// ── Phase 1: resolve runtime context (no DB writes) ───────────────────
// Called once per logical coding-tool invocation. Checks the feature flag
// + allowlist, loads credential metadata, decrypts the key, resolves the
// model, and fetches the current pricing snapshot. Does NOT insert a
// ledger row (plan 6.1) — that is startCodexAttempt's job, immediately
// before the dispatch, so a later failure to start the attempt does not
// consume a paid provider request.
async function resolveCodexRuntimeContext({ pool, session, userId, model, reasoningEffort, resumeThreadId, config = {} }) {
  if (registry.resolveBackend(session?.agent_backend) !== 'codex_openrouter') return null;

  if (!config.codexOpenrouterEnabled) return { error: 'backend_disabled' };
  if (config.openrouterBetaUserIds?.length
      && !config.openrouterBetaUserIds.includes(String(userId))) {
    return { error: 'backend_not_available' };
  }

  const meta = await credentialStore.readMetadata({
    pool, userId, provider: 'openrouter', purpose: 'coding_agent',
  });
  if (!meta || meta.status !== 'valid') {
    return { error: 'credential_required' };
  }

  const resolvedModel = session.agent_model || config.openrouterDefaultCodexModel || null;
  if (!resolvedModel) {
    return { error: 'model_required' };
  }

  const configuredBase = String(config.openrouterApiBase || 'https://openrouter.ai/api/v1')
    .replace(/\/+$/, '');
  let openrouterApiBase = configuredBase;
  if (!/^https:\/\//.test(configuredBase) && !config.openrouterAllowInsecureBase) {
    return { error: 'invalid_base_url' };
  }

  let openrouterApiKey = null;
  try {
    openrouterApiKey = await credentialStore.readSecret({
      pool, userId, provider: 'openrouter', purpose: 'coding_agent',
      dataKey: config.dataEncryptionKey, expectedRevision: meta.revision,
    });
  } catch (err) {
    log.error('agent-turn', 'openrouter key decrypt failed; refusing to start turn', { sessionId: session.id, err: err.message });
    return { error: 'credential_required' };
  }
  if (!openrouterApiKey) {
    return { error: 'credential_required' };
  }

  // Immutable pricing snapshot (plan 6.4): snapshot at attempt start so a
  // later price change cannot rewrite the estimate of already-consumed use.
  // If the catalog fetch fails, continue with no pricing → cost_source
  // 'unavailable' (never a guessed price). A fetch failure is NOT a
  // credential/model failure.
  let pricingSnapshot = null;
  let catalogModel = null;
  try {
    catalogModel = await agentModels.resolveModelPricing({
      pool, userId, credentialRevision: meta.revision,
      apiKey: openrouterApiKey, modelId: resolvedModel, config,
    });
    pricingSnapshot = pricingSnapshotForModel(catalogModel);
    if (catalogModel && pricingSnapshot && !pricingSnapshot.available) {
      pricingSnapshot = { available: false, model: resolvedModel };
    }
  } catch (err) {
    log.warn('agent-turn', 'pricing snapshot fetch failed; cost will be unavailable', { sessionId: session.id, err: err.message });
    pricingSnapshot = { available: false };
  }

  const requestedReasoningEffort = reasoningEffort || session.agent_reasoning_effort || null;
  return {
    agentBackend: 'codex_openrouter',
    agentModel: resolvedModel,
    // Do not send a reasoning parameter to a model OpenRouter explicitly says
    // does not support one. If the catalog was temporarily unavailable, keep
    // the user's existing preference instead of guessing about capability.
    agentReasoningEffort: catalogModel?.supportsReasoning === false
      ? null
      : requestedReasoningEffort,
    agentModelMetadata: runtimeModelMetadataForModel(catalogModel, resolvedModel),
    openrouterApiKey,
    openrouterApiBase,
    resumeThreadId: resumeThreadId || session.agent_thread_id || null,
    credentialId: meta.id,
    credentialRevision: meta.revision,
    agentConfigVersion: session.agent_config_version || 1,
    pricingSnapshot: pricingSnapshot || { available: false },
  };
}

// ── Phase 2: start one physical attempt ───────────────────────────────
// Insert one `agent_turns` row (status 'running'), return { turnUuid }.
// Called immediately before every worker.execInWorker(). Records the
// logical turn id, attempt number, credential id/revision, pricing
// snapshot, agent config version, model and reasoning effort.
async function startCodexAttempt({
  pool, session, userId, logicalTurnId, attemptNumber, model,
  reasoningEffort, resumeThreadId, runtimeContext, mode = 'build',
  telemetryComponent = null,
  // A missing-thread retry deliberately keeps attempt one's active_turn
  // until attempt two is durably registered. Only that exact transition
  // may replace an existing record; every ordinary dispatch still fails
  // closed on any active_turn.
  allowRetryPending = false,
}) {
  const ctx = runtimeContext || {};
  const turnId = crypto.randomUUID();
  const durableTurnId = logicalTurnId || crypto.randomUUID();
  const journal = turnLifecycle.journalPathForAttempt(turnId);
  const measuredComponent = llmTelemetry.collectionComponent(
    telemetryComponent,
    mode === 'scout' ? 'coding_agent_scout' : 'coding_agent_build',
  );
  const expectedConfigVersion = ctx.agentConfigVersion || session.agent_config_version || 1;
  // plan 8.5 (Commit 6): dispatch-side config-version validation. Lock the
  // session row and verify the backend is still Codex and the config
  // version still matches the context that resolved credentials/model. If
  // a reset happened after runtime context was resolved, refuse to dispatch
  // with stale credentials/model instead of paying for a wrong-thread turn.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, agent_backend, agent_config_version, active_turn
         FROM chat_sessions
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [session.id, userId],
    );
    const sessRow = rows[0];
    if (!sessRow) {
      const err = new Error('session not found for dispatch');
      err.code = 'agent_context_changed';
      throw err;
    }
    if (sessRow.agent_backend !== 'codex_openrouter') {
      const err = new Error('backend changed since context was resolved');
      err.code = 'agent_context_changed';
      throw err;
    }
    if (sessRow.agent_config_version !== expectedConfigVersion) {
      const err = new Error('agent config changed since context was resolved');
      err.code = 'agent_context_changed';
      throw err;
    }
    let activeTurn = sessRow.active_turn || null;
    if (typeof activeTurn === 'string') {
      try { activeTurn = JSON.parse(activeTurn); } catch { activeTurn = null; }
    }
    const replacingPreparedRetry = !!(
      allowRetryPending
      && activeTurn
      && activeTurn.backend === 'codex_openrouter'
      && ['tail_pending', 'tail', 'retry_pending'].includes(activeTurn.phase)
      && activeTurn.retryFresh === true
      && activeTurn.logicalTurnId === durableTurnId
      && Number(activeTurn.attemptNumber || 1) === Number(attemptNumber) - 1
    );
    if (sessRow.active_turn && !replacingPreparedRetry) {
      const err = new Error('session is busy');
      err.code = 'session_busy';
      throw err;
    }

    await client.query(
      `INSERT INTO agent_turns
         (id, session_id, user_id, backend, provider, requested_model,
          reasoning_effort, credential_id, credential_revision,
          agent_thread_id, agent_config_version, status,
          logical_turn_id, attempt_number, metadata)
       VALUES ($1, $2, $3, 'codex_openrouter', 'openrouter', $4,
               $5, $6, $7, $8, $9, 'running',
               $10, $11, $12::jsonb)`,
      [turnId, session.id, userId, model,
       reasoningEffort || null,
       ctx.credentialId || null, ctx.credentialRevision || null,
       resumeThreadId || null,
       expectedConfigVersion,
       durableTurnId, attemptNumber || 1,
       JSON.stringify({ pricing: ctx.pricingSnapshot || null })],
    );

    const activeRecord = turnLifecycle.withLifecycle({
      turnId: durableTurnId,
      phase: turnLifecycle.PHASE_DISPATCH_PENDING,
      mode,
      journal,
      backend: 'codex_openrouter',
      turnUuid: turnId,
      logicalTurnId: durableTurnId,
      attemptNumber: attemptNumber || 1,
      ...(measuredComponent ? { telemetryComponent: measuredComponent } : {}),
      model: model || '',
      startedAt: new Date().toISOString(),
      byok: false,
    }, { turnId: durableTurnId, phase: turnLifecycle.PHASE_DISPATCH_PENDING });
    const registered = await client.query(
      `UPDATE chat_sessions
          SET active_turn = $2::jsonb
        WHERE id = $1
          AND ${replacingPreparedRetry
            ? `active_turn IS NOT NULL
               AND active_turn->>'backend' = 'codex_openrouter'
               AND active_turn->>'logicalTurnId' = $3
               AND active_turn->>'turnUuid' = $4
               AND COALESCE(active_turn->>'phase', 'executing') = ANY($5::text[])`
            : 'active_turn IS NULL'}
        RETURNING active_turn`,
      replacingPreparedRetry
        ? [
            session.id,
            JSON.stringify(activeRecord),
            durableTurnId,
            activeTurn.turnUuid,
            ['tail_pending', 'tail', 'retry_pending'],
          ]
        : [session.id, JSON.stringify(activeRecord)],
    );
    if ((registered.rowCount ?? registered.rows?.length ?? 0) !== 1) {
      const err = new Error('turn state changed before attempt registration');
      err.code = 'session_busy';
      throw err;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === 'agent_context_changed' || err.code === 'session_busy') {
      // Structured, non-log-spam surface error for a stale-version race.
      throw err;
    }
    log.error('agent-turn', 'startCodexAttempt insert failed; refusing to start turn', { sessionId: session.id, err: err.message });
    throw err;
  } finally {
    client.release();
  }
  return {
    turnUuid: turnId,
    turnId: durableTurnId,
    logicalTurnId: durableTurnId,
    journal,
  };
}

// Lock the attempt row for transactional completion/reconciliation. Returns
// the row in any state, or null only when the identity is genuinely missing.
async function lockAttempt(client, turnUuid) {
  const { rows } = await client.query(
    `SELECT id, session_id, user_id, backend, requested_model, reasoning_effort,
            agent_thread_id, status, metadata, logical_turn_id, attempt_number,
            input_tokens, cached_input_tokens, cache_write_input_tokens,
            output_tokens, reasoning_output_tokens,
            provider_input_tokens_total,
            provider_cached_input_tokens_total,
            provider_cache_write_input_tokens_total,
            provider_output_tokens_total,
            provider_reasoning_output_tokens_total
       FROM agent_turns
      WHERE id = $1
      FOR UPDATE`,
    [turnUuid]
  );
  return rows[0] || null;
}

// ── Phase 3: complete one attempt idempotently ────────────────────────
// Lock the attempt, compute cumulative provider totals (delta vs the latest
// terminal row for the same thread), estimate cost from the immutable pricing
// snapshot, then terminalize. A force-stop may terminalize before the journal
// owner finishes parsing its final usage event; that exact null-usage shape is
// reconcilable once so the later owner can enrich the cancelled row without
// changing its status or double-counting.
// One physical invocation = one attempt; a retry writes a NEW attempt row
// and never overwrites the prior attempt's usage (plan 6.1, 6.5).
async function completeCodexAttempt({
  pool, turnUuid, status = 'completed', threadId = null, usageTotal = null,
  errorCode = null, errorDetail = null, telemetryComponent = null,
  telemetryMetrics = null,
}) {
  if (!turnUuid) return { updated: false, alreadyTerminal: true };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const row = await lockAttempt(client, turnUuid);
    if (!row) {
      await client.query('COMMIT');
      const err = new Error('agent attempt not found');
      // A durable recovery pointer to a deleted ledger row cannot heal via
      // backoff. Give the recovery scheduler a stable permanent-state code
      // while keeping the generic completion helper useful outside recovery.
      err.code = 'agent_attempt_not_found';
      throw err;
    }
    const current = normalizeCumulativeUsage(usageTotal);
    const providerUsageAlreadyRecorded = [
      row.provider_input_tokens_total,
      row.provider_cached_input_tokens_total,
      row.provider_cache_write_input_tokens_total,
      row.provider_output_tokens_total,
      row.provider_reasoning_output_tokens_total,
    ].some((value) => value != null);
    const tokenDeltaAlreadyRecorded = [
      row.input_tokens,
      row.cached_input_tokens,
      row.cache_write_input_tokens,
      row.output_tokens,
      row.reasoning_output_tokens,
    ].some((value) => Number(value || 0) !== 0);
    const reconcileTerminalUsage = row.status !== 'running'
      && !!current
      && !providerUsageAlreadyRecorded
      && !tokenDeltaAlreadyRecorded;
    const measuredComponent = llmTelemetry.collectionComponent(telemetryComponent);
    if (row.status !== 'running' && !reconcileTerminalUsage) {
      await client.query('COMMIT');
      return { updated: false, alreadyTerminal: true };
    }

    const previous = current && threadId
      ? await findPreviousProviderTotal(client, row.session_id, threadId, turnUuid)
      : null;
    const { delta, resetDetected } = computeProviderUsageDelta(current, previous);
    // No provider totals means cost is unknown, not a genuine zero-dollar
    // request. Preserve that distinction even when a pricing snapshot exists.
    const cost = current
      ? estimateRequestedModelCost(delta, row.metadata?.pricing)
      : { costSource: 'unavailable', estimatedCostUsd: null };
    const metadata = row.metadata || {};
    if (measuredComponent) {
      metadata.telemetry_component = measuredComponent;
      const errorClassByCode = {
        user_cancelled: 'cancelled',
        rate_limited: 'rate_limited',
        timeout: 'timeout',
        credential_failure: 'authentication',
        insufficient_credits: 'billing',
        dispatch_failed: 'worker',
        agent_context_changed: 'worker',
        recovery_abandoned: 'worker',
      };
      const normalizedMetrics = llmTelemetry.normalizeDiagnostics({
        ...(telemetryMetrics || {}),
        requestMode: telemetryMetrics?.requestMode
          || (row.agent_thread_id ? 'agent_resume' : 'agent_new'),
        reasoningEffort: row.reasoning_effort || null,
        usageResetDetected: resetDetected,
        errorClass: errorClassByCode[errorCode]
          || (status === 'cancelled' ? 'cancelled'
            : status === 'failed' ? 'provider' : null),
      });
      if (Object.keys(normalizedMetrics).length) {
        metadata.telemetry_metrics = normalizedMetrics;
      }
    }
    if (previous && resetDetected) {
      metadata.usageReset = {
        previous: previous,
        current: current,
      };
    }

    // requested_model records the exact OpenRouter slug dispatched by the
    // runner. Codex's JSONL does not expose the model returned by OpenRouter,
    // so routed_model must remain unknown until that value is actually
    // observed rather than being copied from the request.

    await client.query(
      `UPDATE agent_turns SET
         status = CASE WHEN $20::boolean THEN status ELSE $2 END,
         completed_at = COALESCE(completed_at, NOW()),
         error_code = CASE WHEN $20::boolean THEN error_code ELSE COALESCE($3, error_code) END,
         error_detail = CASE WHEN $20::boolean THEN error_detail ELSE COALESCE($4, error_detail) END,
         agent_thread_id = COALESCE($5, agent_thread_id),
         input_tokens = input_tokens + $6,
         cached_input_tokens = cached_input_tokens + $7,
         cache_write_input_tokens = cache_write_input_tokens + $8,
         output_tokens = output_tokens + $9,
         reasoning_output_tokens = reasoning_output_tokens + $10,
         provider_input_tokens_total = $11,
         provider_cached_input_tokens_total = $12,
         provider_cache_write_input_tokens_total = $13,
         provider_output_tokens_total = $14,
         provider_reasoning_output_tokens_total = $15,
         estimated_cost_usd = $16,
         cost_source = $17,
         usage_reset_detected = $18,
         billed_by = 'user_openrouter',
         metadata = $19::jsonb
       WHERE id = $1
         AND (
           status = 'running'
           OR ($20::boolean
               AND status IN ('completed', 'failed', 'cancelled')
               AND provider_input_tokens_total IS NULL
               AND provider_cached_input_tokens_total IS NULL
               AND provider_cache_write_input_tokens_total IS NULL
               AND provider_output_tokens_total IS NULL
               AND provider_reasoning_output_tokens_total IS NULL
               AND input_tokens = 0
               AND cached_input_tokens = 0
               AND cache_write_input_tokens = 0
               AND output_tokens = 0
               AND reasoning_output_tokens = 0)
         )`,
      [turnUuid, status,
       errorCode || null, errorDetail || null,
       threadId || null,
       delta.inputTokens, delta.cachedInputTokens, delta.cacheWriteInputTokens,
       delta.outputTokens, delta.reasoningOutputTokens,
       current?.inputTokens ?? null,
       current?.cachedInputTokens ?? null,
       current?.cacheWriteInputTokens ?? null,
       current?.outputTokens ?? null,
       current?.reasoningOutputTokens ?? null,
       cost != null ? cost.estimatedCostUsd : null,
       cost != null ? cost.costSource : 'unavailable',
       resetDetected,
       JSON.stringify(metadata),
       reconcileTerminalUsage],
    );

    await client.query('COMMIT');
    return {
      updated: true,
      alreadyTerminal: reconcileTerminalUsage,
      reconciled: reconcileTerminalUsage,
      delta,
      estimatedCost: cost,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Find the latest non-null provider total for EACH usage dimension among
// terminal attempts with the same session/thread/backend. A provider may omit
// one dimension from an otherwise valid snapshot; taking every baseline from
// that single row would make the next observed value subtract from zero.
// Terminal rows include failed/cancelled attempts that may have consumed
// tokens. The filtered aggregates keep each dimension's last known total
// without treating an omitted value as an observed zero. Once a counter
// reset has been observed, older provider totals belong to a different
// cumulative epoch and must not supply a missing baseline.
async function findPreviousProviderTotal(client, sessionId, threadId, excludeTurnUuid) {
  const { rows } = await client.query(
    `WITH previous_attempts AS (
       SELECT provider_input_tokens_total,
              provider_cached_input_tokens_total,
              provider_cache_write_input_tokens_total,
              provider_output_tokens_total,
              provider_reasoning_output_tokens_total,
              usage_reset_detected,
              ROW_NUMBER() OVER (
                ORDER BY completed_at DESC NULLS LAST, id DESC
              ) AS recency
         FROM agent_turns
        WHERE session_id = $1
          AND agent_thread_id = $2
          AND backend = 'codex_openrouter'
          AND id <> $3
          AND status IN ('completed', 'failed', 'cancelled')
          AND (provider_input_tokens_total IS NOT NULL
               OR provider_output_tokens_total IS NOT NULL)
     ), current_epoch AS (
       SELECT *
         FROM previous_attempts
        WHERE recency <= COALESCE(
          (SELECT MIN(recency)
             FROM previous_attempts
            WHERE usage_reset_detected),
          recency
        )
     )
     SELECT
            (ARRAY_AGG(provider_input_tokens_total
                       ORDER BY recency ASC)
             FILTER (WHERE provider_input_tokens_total IS NOT NULL))[1]
              AS provider_input_tokens_total,
            (ARRAY_AGG(provider_cached_input_tokens_total
                       ORDER BY recency ASC)
             FILTER (WHERE provider_cached_input_tokens_total IS NOT NULL))[1]
              AS provider_cached_input_tokens_total,
            (ARRAY_AGG(provider_cache_write_input_tokens_total
                       ORDER BY recency ASC)
             FILTER (WHERE provider_cache_write_input_tokens_total IS NOT NULL))[1]
              AS provider_cache_write_input_tokens_total,
            (ARRAY_AGG(provider_output_tokens_total
                       ORDER BY recency ASC)
             FILTER (WHERE provider_output_tokens_total IS NOT NULL))[1]
              AS provider_output_tokens_total,
            (ARRAY_AGG(provider_reasoning_output_tokens_total
                       ORDER BY recency ASC)
             FILTER (WHERE provider_reasoning_output_tokens_total IS NOT NULL))[1]
              AS provider_reasoning_output_tokens_total
       FROM current_epoch`,
    [sessionId, threadId, excludeTurnUuid]
  );
  // pg returns snake_case database columns, while the delta calculator
  // consumes the normalized camelCase usage shape.
  return rows[0] ? normalizeCumulativeUsage(rows[0]) : null;
}

function normalizeCumulativeUsage(u) {
  if (!u) return null;
  const input = normalizeNonNegativeInteger(u.inputTokens ?? u.provider_input_tokens_total);
  const output = normalizeNonNegativeInteger(u.outputTokens ?? u.provider_output_tokens_total);
  if (input == null && output == null) return null;
  return {
    inputTokens: input,
    cachedInputTokens: normalizeNonNegativeInteger(u.cachedInputTokens ?? u.provider_cached_input_tokens_total),
    cacheWriteInputTokens: normalizeNonNegativeInteger(u.cacheWriteInputTokens ?? u.provider_cache_write_input_tokens_total),
    outputTokens: output,
    reasoningOutputTokens: normalizeNonNegativeInteger(u.reasoningOutputTokens ?? u.provider_reasoning_output_tokens_total),
  };
}

function zeroUsage() {
  return {
    inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0,
  };
}

// Compute per-attempt deltas from cumulative provider totals. A lower new
// total than the previous (new provider thread / provider reset / corrupt
// baseline) resets the baseline rather than producing a negative delta
// (plan 6.6).
function computeProviderUsageDelta(current, previous) {
  if (!current) return { delta: zeroUsage(), resetDetected: false };
  const keys = [
    'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
    'outputTokens', 'reasoningOutputTokens',
  ];
  let resetDetected = false;
  if (previous) {
    for (const k of keys) {
      // An omitted dimension is unknown, not zero. Only compare totals the
      // provider supplied in both snapshots when detecting a reset.
      if (current[k] != null && previous[k] != null && current[k] < previous[k]) {
        resetDetected = true;
        break;
      }
    }
  }
  const delta = zeroUsage();
  for (const k of keys) {
    if (current[k] == null) continue;
    const baseline = !resetDetected && previous?.[k] != null ? previous[k] : 0;
    delta[k] = current[k] - baseline;
  }
  return {
    delta,
    resetDetected,
  };
}

// Estimate cost from per-attempt deltas. Cached input is priced at the
// ordinary prompt rate (conservative, recorded as an assumption). Reasoning
// output tokens are already included in outputTokens and must not be added
// again (plan 6.7). Never label the estimate exact.
function estimateRequestedModelCost(delta, pricing) {
  const p = pricing;
  if (!p || !p.available) return { costSource: 'unavailable', estimatedCostUsd: null };
  const inP = p.inputPricePerMillion;
  const outP = p.outputPricePerMillion;
  if (!Number.isFinite(inP) || !Number.isFinite(outP)) {
    return { costSource: 'unavailable', estimatedCostUsd: null };
  }
  const estimatedCostUsd =
    ((delta.inputTokens ?? 0) / 1_000_000) * inP +
    ((delta.outputTokens ?? 0) / 1_000_000) * outP;
  return { costSource: 'requested_model_catalog_estimate', estimatedCostUsd: Math.round(estimatedCostUsd * 1e8) / 1e8 };
}

// Back-compat single-attempt path (used by the pre-Commit-5 call sites).
// Resolves the runtime context, immediately starts attempt 1, and returns
// the runtime context PLUS the attempt's turnUuid, mirroring the old
// combined resolveCodexTurn contract so sessions.js/server.js keep working.
// Commit 5 migrates these call sites to the explicit runtime/start/complete
// phases with per-attempt retries.
async function resolveCodexTurn(args) {
  const ctx = await resolveCodexRuntimeContext(args);
  if (!ctx) return null;
  if (ctx.error) return ctx;
  const attempt = await startCodexAttempt({
    pool: args.pool,
    session: args.session,
    userId: args.userId,
    logicalTurnId: null,
    attemptNumber: 1,
    model: ctx.agentModel,
    reasoningEffort: ctx.agentReasoningEffort,
    resumeThreadId: ctx.resumeThreadId,
    runtimeContext: ctx,
    mode: args.mode || 'build',
    telemetryComponent: args.telemetryComponent || null,
  });
  return { ...ctx, ...attempt };
}

// Back-compat terminalization (used by pre-Commit-5 call sites). Delegates
// to the idempotent completeCodexAttempt. No threadId is available on this
// bridge, so the delta baseline is a fresh thread — correct for a single
// physical dispatch per logical turn (the retry case is migrated in Commit
// 5 with explicit thread propagation).
async function completeCodexTurn({ pool, turnUuid, status = 'completed', errorDetail = null, errorCode = null, usage = null }) {
  if (!turnUuid) return { updated: false, alreadyTerminal: true };
  const u = usage || {};
  const hasUsage = (u.inputTokens != null && Number.isFinite(u.inputTokens))
    || (u.outputTokens != null && Number.isFinite(u.outputTokens));
  return completeCodexAttempt({
    pool, turnUuid, status, errorCode, errorDetail,
    threadId: null,
    usageTotal: hasUsage
      ? {
          inputTokens: u.inputTokens != null ? u.inputTokens : null,
          cachedInputTokens: u.cachedInputTokens != null ? u.cachedInputTokens : null,
          cacheWriteInputTokens: u.cacheWriteInputTokens != null ? u.cacheWriteInputTokens : null,
          outputTokens: u.outputTokens != null ? u.outputTokens : null,
          reasoningOutputTokens: u.reasoningOutputTokens != null ? u.reasoningOutputTokens : null,
        }
      : null,
  });
}


// ── Shared backend-aware recovery settlement (plan 7.5) ───────────────
// Used by BOTH interactive (server.js resumeDetachedTurnInner) and
// headless (sessions.js) recovery so the two paths cannot drift. For a
// Codex turn this terminalizes the persisted attempt; for Claude it
// settles Anthropic spend through `limits`. `settleClaude` is injected
// (the caller owns the `limits` module + user context) to avoid a
// circular import here.
async function settleRecoveredAgentAttempt({
  pool, activeTurn, result, settleClaude,
}) {
  if (activeTurn?.backend === 'codex_openrouter' && activeTurn.turnUuid) {
    const failed = !!(result?.fatalError || result?.ccIsError
      || (result?.agentExit != null && result?.agentExit !== 0)
      || (result?.exitCode != null && result?.exitCode !== 0));
    return completeCodexAttempt({
      pool,
      turnUuid: activeTurn.turnUuid,
      status: failed ? 'failed' : 'completed',
      threadId: result?.agentThreadId || activeTurn.threadId || null,
      usageTotal: {
        inputTokens: result?.inputTokens != null ? result.inputTokens : null,
        cachedInputTokens: result?.cachedInputTokens != null ? result.cachedInputTokens : null,
        cacheWriteInputTokens: result?.cacheWriteInputTokens != null ? result.cacheWriteInputTokens : null,
        outputTokens: result?.outputTokens != null ? result.outputTokens : null,
        reasoningOutputTokens: result?.reasoningOutputTokens != null ? result.reasoningOutputTokens : null,
      },
      telemetryComponent: result?.providerDispatched === true
        ? activeTurn.telemetryComponent || null
        : null,
      telemetryMetrics: result || null,
      errorCode: result?.agentRetryFresh === true ? 'resume_thread_missing' : null,
    });
  }
  if (typeof settleClaude === 'function') {
    return settleClaude(result);
  }
  return null;
}

// Persist a thread id discovered while replaying a detached Codex journal.
// Live dispatches already do this in sessions.js; recovery must do the same
// before the next turn chooses its resume id. Shared by interactive and
// headless recovery so the paths cannot drift again.
async function persistRecoveredAgentThread({ pool, session, result }) {
  const threadId = result?.agentThreadId || null;
  if (!threadId || threadId === session?.agent_thread_id) {
    return { updated: false, threadId };
  }
  await pool.query(
    'UPDATE chat_sessions SET agent_thread_id = $1 WHERE id = $2',
    [threadId, session.id],
  );
  session.agent_thread_id = threadId;
  return { updated: true, threadId };
}

// Read immutable attempt context for diagnostics and rolling-deploy recovery.
// Current restart handling never re-dispatches an ambiguous registered
// attempt: it fails closed and asks the user for an explicit retry. Older
// retry_dispatch_pending records remain readable so they can be terminalized
// safely during the compatibility window.
async function getCodexAttemptRecoveryState({ pool, turnUuid }) {
  if (!turnUuid) return null;
  const { rows } = await pool.query(
    `SELECT status, session_id, user_id, requested_model, reasoning_effort,
            credential_id, credential_revision, agent_thread_id,
            agent_config_version, logical_turn_id, attempt_number
       FROM agent_turns
      WHERE id = $1
        AND backend = 'codex_openrouter'
        AND provider = 'openrouter'`,
    [turnUuid],
  );
  return rows[0] || null;
}

// Extract a cumulative-provider-usage object from a terminal worker result
// (plan 7.3): the thread's CURRENT totals. If none observed, returns null.
function usageTotalFromResult(result) {
  const r = result || {};
  const input = r.inputTokens;
  const output = r.outputTokens;
  if ((input == null || !Number.isFinite(input)) && (output == null || !Number.isFinite(output))) return null;
  return {
    inputTokens: input != null && Number.isFinite(input) ? input : null,
    cachedInputTokens: r.cachedInputTokens != null && Number.isFinite(r.cachedInputTokens) ? r.cachedInputTokens : null,
    cacheWriteInputTokens: r.cacheWriteInputTokens != null && Number.isFinite(r.cacheWriteInputTokens) ? r.cacheWriteInputTokens : null,
    outputTokens: output != null && Number.isFinite(output) ? output : null,
    reasoningOutputTokens: r.reasoningOutputTokens != null && Number.isFinite(r.reasoningOutputTokens) ? r.reasoningOutputTokens : null,
  };
}

// Classify a thrown dispatch error into a terminal status + code (plan 7.2).
// Never leaks the raw error (secret values must not reach the ledger
// error_detail either — plan 1.6).
function classifyErrorCode(err) {
  if (!err) return 'dispatch_failed';
  const code = err.code || err.message || '';
  if (code === 'agent_context_changed') return 'agent_context_changed';
  const text = String(code).toLowerCase();
  if (/credential|api key|401|unauthorized/.test(text)) return 'credential_failure';
  if (/rate|429/.test(text)) return 'rate_limited';
  if (/timeout|etimedout/.test(text)) return 'timeout';
  return 'dispatch_failed';
}

function sanitizeError(err) {
  if (!err) return null;
  const msg = String(err.message || err.code || '');
  // Truncate; a message here may contain a model id but must never carry
  // a secret. We log only the (already-server-side-safe) message.
  return msg.slice(0, 300) || null;
}

module.exports = {
  backendForSession,
  resolveCodexRuntimeContext,
  startCodexAttempt,
  completeCodexAttempt,
  completeCodexTurn,
  resolveCodexTurn,
  settleRecoveredAgentAttempt,
  persistRecoveredAgentThread,
  getCodexAttemptRecoveryState,
  usageTotalFromResult,
  classifyErrorCode,
  sanitizeError,
  normalizeCumulativeUsage,
  computeProviderUsageDelta,
  estimateRequestedModelCost,
  pricingSnapshotForModel,
  runtimeModelMetadataForModel,
};
