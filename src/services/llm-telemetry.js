'use strict';

// Provider-neutral, content-free LLM invocation telemetry.
//
// Anthropic Mayor/helper calls and Claude/local coding-agent runs did not
// previously have a durable per-invocation record, so they are appended to
// the existing private `events` ledger. OpenRouter attempts already have an
// authoritative row in `agent_turns`; aggregateReport() normalizes those rows
// at read time rather than copying them into a second ledger.

const crypto = require('crypto');
const { getPool } = require('../db/pool');
const log = require('./logger');

const EVENT_TYPE = 'llm_invocation';
const MAX_REPORT_DAYS = 90;

const PROVIDERS = new Set(['anthropic', 'openrouter', 'local', 'unknown']);
const BACKENDS = new Set(['mayor', 'coding_agent', 'helper']);
const COMPONENTS = new Set([
  'mayor_phase_1',
  'mayor_data_iteration',
  'mayor_phase_2',
  'headless_decision',
  'headless_wrapup',
  'quick_replies',
  'session_title',
  'pr_metadata',
  'progress_estimate',
  'issue_title',
  'report_summary',
  'fleet_maintenance',
  'coding_agent_scout',
  'coding_agent_build',
  'coding_agent_headless',
  'other_helper',
]);
const BILLING_PATHS = new Set([
  'platform', 'anthropic_byok', 'anthropic_mixed', 'openrouter_byok',
  'local_subscription', 'unknown',
]);
const COST_SOURCES = new Set([
  'provider_reported', 'platform_estimate', 'catalog_estimate', 'unavailable',
]);
const OUTCOMES = new Set(['success', 'error', 'cancelled', 'refusal', 'unknown']);
const REQUEST_MODES = new Set(['single', 'stream', 'agent_new', 'agent_resume']);
const TOOL_CHOICE_MODES = new Set(['unset', 'auto', 'any', 'tool', 'none']);
const OUTPUT_FORMATS = new Set(['text', 'json_schema', 'json_object', 'tool', 'unknown']);
const THINKING_MODES = new Set(['unset', 'disabled', 'enabled', 'adaptive']);
const SERVICE_TIERS = new Set([
  'auto', 'standard_only', 'standard', 'priority', 'batch', 'unknown',
]);
const REASONING_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'unknown',
]);
const ERROR_CLASSES = new Set([
  'cancelled', 'timeout', 'rate_limited', 'authentication', 'permission',
  'billing', 'invalid_request', 'not_found', 'overloaded', 'network',
  'provider', 'worker', 'unknown',
]);

let configuredPoolSource = null;
// Stay inert until application initialization. Unit tests that import llm.js
// without booting the server therefore never attempt an accidental DB write.
let enabled = false;
let testSink = null;
let lastWarningAt = 0;
let suppressedWarnings = 0;

function init(config = {}) {
  configuredPoolSource = config;
  enabled = config.llmTelemetryEnabled !== false;
}

function finiteNonnegative(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function tokenCount(value) {
  const n = finiteNonnegative(value);
  return n == null ? null : Math.round(n);
}

function safeId(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function safeString(value, max = 255) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function safeReason(value) {
  const text = safeString(value, 64);
  return text && /^[a-zA-Z0-9_.:-]+$/.test(text) ? text : null;
}

function safeOpaqueId(value, max = 180) {
  const text = safeString(value, max);
  return text && /^[a-zA-Z0-9_.:-]+$/.test(text) ? text : null;
}

function safeModel(value) {
  const text = safeString(value, 255);
  // Provider model identifiers are slugs, not free text. Keeping this field
  // syntactically constrained prevents an accidental caller from putting
  // prompt/output content into an otherwise allowlisted string slot.
  return text && /^[a-zA-Z0-9_./:-]+$/.test(text) ? text : null;
}

function enumValue(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function enumOrNull(value, allowed) {
  return allowed.has(value) ? value : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function addOptional(target, values) {
  for (const [key, value] of Object.entries(values)) {
    // Optional fields are absent, rather than serialized as null, to keep the
    // append-only event compact. The aggregate treats an absent key exactly
    // like JSON null and reports availability explicitly.
    if (value != null) target[key] = value;
  }
  return target;
}

function normalizeEvent(event = {}) {
  const costSource = enumValue(event.costSource, COST_SOURCES, 'unavailable');
  const costUsd = costSource === 'unavailable' ? null : finiteNonnegative(event.costUsd);
  const timestamp = event.timestamp instanceof Date
    ? event.timestamp
    : new Date(event.timestamp || Date.now());
  const validTimestamp = Number.isFinite(timestamp.getTime()) ? timestamp : new Date();
  const attempt = tokenCount(event.attemptNumber);

  // This is an explicit allowlist. No caller-provided object is spread into
  // metadata, which structurally prevents prompts, outputs, errors, paths or
  // credentials from entering the telemetry ledger.
  const normalized = {
    invocation_key: safeOpaqueId(event.invocationKey) || crypto.randomUUID(),
    timestamp: validTimestamp.toISOString(),
    provider: enumValue(event.provider, PROVIDERS, 'unknown'),
    backend: enumValue(event.backend, BACKENDS, 'helper'),
    component: enumValue(event.component, COMPONENTS, 'other_helper'),
    requested_model: safeModel(event.requestedModel),
    served_model: safeModel(event.servedModel),
    billing_path: enumValue(event.billingPath, BILLING_PATHS, 'unknown'),
    input_tokens: tokenCount(event.inputTokens),
    cache_read_input_tokens: tokenCount(event.cacheReadInputTokens),
    cache_write_input_tokens: tokenCount(event.cacheWriteInputTokens),
    output_tokens: tokenCount(event.outputTokens),
    reasoning_output_tokens: tokenCount(event.reasoningOutputTokens),
    cost_usd: costUsd,
    cost_source: costUsd == null ? 'unavailable' : costSource,
    duration_ms: finiteNonnegative(event.durationMs),
    outcome: enumValue(event.outcome, OUTCOMES, 'unknown'),
    stop_reason: safeReason(event.stopReason),
    attempt_number: attempt && attempt > 0 ? attempt : null,
    correlation_id: safeOpaqueId(event.correlationId),
  };

  return Object.assign(normalized, normalizeDiagnostics(event));
}

// Complete content-free diagnostic contract. Every value below is either a
// bounded number, a strict enum, a model/region slug, or a boolean. Free-form
// request/response/error data is never accepted, and unknown optional values
// are omitted so old/new provider shapes remain distinguishable from zero.
// Exported for agent_turns, whose OpenRouter rows are the authoritative ledger
// and therefore store these same fields under metadata.telemetry_metrics.
function normalizeDiagnostics(event = {}) {
  return addOptional({}, {
    request_mode: enumOrNull(event.requestMode, REQUEST_MODES),
    tool_choice_mode: enumOrNull(event.toolChoiceMode, TOOL_CHOICE_MODES),
    output_format: enumOrNull(event.outputFormat, OUTPUT_FORMATS),
    thinking_mode: enumOrNull(event.thinkingMode, THINKING_MODES),
    requested_service_tier: enumOrNull(event.requestedServiceTier, SERVICE_TIERS),
    service_tier: enumOrNull(event.serviceTier, SERVICE_TIERS),
    requested_inference_region: safeReason(event.requestedInferenceRegion),
    inference_region: safeReason(event.inferenceRegion),
    reasoning_effort: enumOrNull(event.reasoningEffort, REASONING_EFFORTS),
    error_class: enumOrNull(event.errorClass, ERROR_CLASSES),

    request_message_count: tokenCount(event.requestMessageCount),
    request_user_message_count: tokenCount(event.requestUserMessageCount),
    request_assistant_message_count: tokenCount(event.requestAssistantMessageCount),
    request_content_block_count: tokenCount(event.requestContentBlockCount),
    request_text_characters: tokenCount(event.requestTextCharacters),
    request_user_text_characters: tokenCount(event.requestUserTextCharacters),
    request_assistant_text_characters: tokenCount(event.requestAssistantTextCharacters),
    request_tool_result_text_characters: tokenCount(event.requestToolResultTextCharacters),
    request_thinking_characters: tokenCount(event.requestThinkingCharacters),
    request_payload_characters: tokenCount(event.requestPayloadCharacters),
    request_system_characters: tokenCount(event.requestSystemCharacters),
    request_tool_definition_count: tokenCount(event.requestToolDefinitionCount),
    request_tool_schema_characters: tokenCount(event.requestToolSchemaCharacters),
    request_mcp_server_count: tokenCount(event.requestMcpServerCount),
    request_agent_definition_count: tokenCount(event.requestAgentDefinitionCount),
    request_skill_count: tokenCount(event.requestSkillCount),
    request_plugin_count: tokenCount(event.requestPluginCount),
    request_tool_call_count: tokenCount(event.requestToolCallCount),
    request_tool_result_count: tokenCount(event.requestToolResultCount),
    request_image_count: tokenCount(event.requestImageCount),
    request_document_count: tokenCount(event.requestDocumentCount),
    request_cache_breakpoint_count: tokenCount(event.requestCacheBreakpointCount),
    request_cache_5m_breakpoint_count: tokenCount(event.requestCache5mBreakpointCount),
    request_cache_1h_breakpoint_count: tokenCount(event.requestCache1hBreakpointCount),
    max_output_tokens: tokenCount(event.maxOutputTokens),
    temperature: finiteNonnegative(event.temperature),
    top_p: finiteNonnegative(event.topP),
    top_k: tokenCount(event.topK),
    stop_sequence_count: tokenCount(event.stopSequenceCount),
    fallback_model_count: tokenCount(event.fallbackModelCount),
    thinking_budget_tokens: tokenCount(event.thinkingBudgetTokens),

    cache_write_5m_input_tokens: tokenCount(event.cacheWrite5mInputTokens),
    cache_write_1h_input_tokens: tokenCount(event.cacheWrite1hInputTokens),
    server_web_search_count: tokenCount(event.serverWebSearchCount),
    server_web_fetch_count: tokenCount(event.serverWebFetchCount),

    response_content_block_count: tokenCount(event.responseContentBlockCount),
    response_text_block_count: tokenCount(event.responseTextBlockCount),
    response_text_characters: tokenCount(event.responseTextCharacters),
    response_tool_call_count: tokenCount(event.responseToolCallCount),
    response_server_tool_call_count: tokenCount(event.responseServerToolCallCount),
    response_thinking_block_count: tokenCount(event.responseThinkingBlockCount),
    response_thinking_characters: tokenCount(event.responseThinkingCharacters),
    response_redacted_thinking_block_count: tokenCount(event.responseRedactedThinkingBlockCount),

    provider_duration_ms: finiteNonnegative(event.providerDurationMs),
    agent_reported_duration_ms: finiteNonnegative(event.agentReportedDurationMs),
    queue_duration_ms: finiteNonnegative(event.queueDurationMs),
    dispatch_setup_duration_ms: finiteNonnegative(event.dispatchSetupDurationMs),
    time_to_first_output_ms: finiteNonnegative(event.timeToFirstOutputMs),
    model_context_window_tokens: tokenCount(event.modelContextWindowTokens),
    model_max_output_tokens: tokenCount(event.modelMaxOutputTokens),
    provider_turn_count: tokenCount(event.providerTurnCount),
    provider_model_count: tokenCount(event.providerModelCount),
    provider_retry_count: tokenCount(event.providerRetryCount),
    provider_rate_limit_event_count: tokenCount(event.providerRateLimitEventCount),
    context_compaction_count: tokenCount(event.contextCompactionCount),
    context_compaction_pre_tokens_max: tokenCount(event.contextCompactionPreTokensMax),
    tool_call_count: tokenCount(event.toolCallCount),
    tool_result_count: tokenCount(event.toolResultCount),
    tool_error_count: tokenCount(event.toolErrorCount),
    distinct_tool_count: tokenCount(event.distinctToolCount
      ?? (event.telemetryToolNames instanceof Set ? event.telemetryToolNames.size : null)),
    permission_denial_count: tokenCount(event.permissionDenialCount),
    command_count: tokenCount(event.commandCount),
    file_read_count: tokenCount(event.fileReadCount),
    distinct_file_read_count: tokenCount(event.distinctFileReadCount
      ?? (event.telemetryFileReads instanceof Set ? event.telemetryFileReads.size : null)),
    file_search_count: tokenCount(event.fileSearchCount),
    file_change_count: tokenCount(event.fileChangeCount),
    distinct_file_change_count: tokenCount(event.distinctFileChangeCount
      ?? (event.telemetryFileChanges instanceof Set ? event.telemetryFileChanges.size : null)),
    mcp_call_count: tokenCount(event.mcpCallCount),
    subagent_call_count: tokenCount(event.subagentCallCount),
    web_tool_call_count: tokenCount(event.webToolCallCount),
    tool_search_count: tokenCount(event.toolSearchCount),
    usage_reset_detected: booleanOrNull(event.usageResetDetected),
  });
}

function resolvePool(poolOrConfig) {
  if (poolOrConfig && typeof poolOrConfig.query === 'function') return poolOrConfig;
  return getPool(poolOrConfig || configuredPoolSource);
}

function warnOnce(error) {
  try {
    const now = Date.now();
    if (now - lastWarningAt < 60_000) {
      suppressedWarnings += 1;
      return;
    }
    log.warn('llm-telemetry', 'Invocation telemetry write failed (turn unaffected)', {
      code: safeReason(error && error.code) || 'write_failed',
      suppressed: suppressedWarnings,
    });
    lastWarningAt = now;
    suppressedWarnings = 0;
  } catch {
    // Even malformed error objects or a logging failure stay observational.
  }
}

// Fire-and-forget by contract. The returned promise always resolves, and the
// sink is invoked synchronously so deterministic unit tests can inspect the
// normalized event without timing races.
function record(poolOrConfig, event = {}) {
  if (!enabled) return Promise.resolve(false);
  try {
    const normalized = normalizeEvent(event);
    const appId = safeId(event.appId);
    const sessionId = safeId(event.sessionId);
    const result = testSink
      ? testSink({ appId, sessionId, ...normalized })
      : resolvePool(poolOrConfig).query(
        `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
         VALUES (
           NULL,
           COALESCE($1::INTEGER, (SELECT app_id FROM chat_sessions WHERE id = $2)),
           $2,
           $3,
           $4::jsonb
         )
         ON CONFLICT DO NOTHING`,
        [appId, sessionId, EVENT_TYPE, JSON.stringify(normalized)],
      );
    return Promise.resolve(result).then(() => true).catch((error) => {
      warnOnce(error);
      return false;
    });
  } catch (error) {
    warnOnce(error);
    return Promise.resolve(false);
  }
}

function nullableNumber(value) {
  return value == null ? null : Number(value);
}

function count(value) {
  return Number(value || 0);
}

function countMap(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { source = null; }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const result = {};
  for (const [key, valueCount] of Object.entries(source)) {
    const safeKey = safeReason(key);
    if (safeKey) result[safeKey] = count(valueCount);
  }
  return result;
}

function addCountMap(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = count(target[key]) + count(value);
  }
}

const DIAGNOSTIC_METRIC_NAMES = Object.freeze([
  'request_message_count', 'request_user_message_count', 'request_assistant_message_count',
  'request_content_block_count', 'request_text_characters', 'request_payload_characters',
  'request_user_text_characters', 'request_assistant_text_characters',
  'request_tool_result_text_characters', 'request_thinking_characters',
  'request_system_characters', 'request_tool_definition_count',
  'request_tool_schema_characters', 'request_mcp_server_count',
  'request_agent_definition_count', 'request_skill_count', 'request_plugin_count',
  'request_tool_call_count', 'request_tool_result_count', 'request_image_count',
  'request_document_count', 'request_cache_breakpoint_count',
  'request_cache_5m_breakpoint_count', 'request_cache_1h_breakpoint_count',
  'max_output_tokens', 'temperature', 'top_p', 'top_k', 'stop_sequence_count',
  'fallback_model_count', 'thinking_budget_tokens', 'cache_write_5m_input_tokens',
  'cache_write_1h_input_tokens', 'server_web_search_count', 'server_web_fetch_count',
  'response_content_block_count', 'response_text_block_count',
  'response_text_characters', 'response_tool_call_count',
  'response_server_tool_call_count', 'response_thinking_block_count',
  'response_thinking_characters', 'response_redacted_thinking_block_count',
  'provider_duration_ms', 'agent_reported_duration_ms', 'time_to_first_output_ms',
  'queue_duration_ms', 'dispatch_setup_duration_ms', 'model_context_window_tokens',
  'model_max_output_tokens',
  'provider_turn_count', 'provider_model_count', 'provider_retry_count',
  'provider_rate_limit_event_count', 'context_compaction_count',
  'context_compaction_pre_tokens_max', 'tool_call_count', 'tool_result_count',
  'tool_error_count', 'distinct_tool_count', 'permission_denial_count', 'command_count',
  'file_read_count', 'distinct_file_read_count', 'file_search_count',
  'file_change_count', 'distinct_file_change_count', 'mcp_call_count',
  'subagent_call_count', 'web_tool_call_count', 'tool_search_count',
]);

const CATEGORY_NAMES = Object.freeze([
  'request_mode', 'tool_choice_mode', 'output_format', 'thinking_mode',
  'requested_service_tier', 'service_tier', 'inference_region',
  'requested_inference_region',
  'reasoning_effort', 'error_class', 'usage_reset_detected',
]);

function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function jsonObject(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { source = null; }
  }
  return source && typeof source === 'object' && !Array.isArray(source) ? source : {};
}

function diagnosticMap(value) {
  const result = {};
  for (const [name, raw] of Object.entries(jsonObject(value))) {
    if (!DIAGNOSTIC_METRIC_NAMES.includes(name)) continue;
    const stat = jsonObject(raw);
    result[snakeToCamel(name)] = {
      availableCount: count(stat.availableCount ?? stat.available_count),
      total: nullableNumber(stat.total),
      average: nullableNumber(stat.average),
      median: nullableNumber(stat.median),
      p95: nullableNumber(stat.p95),
    };
  }
  return result;
}

function categoryMap(value) {
  const result = {};
  for (const [name, rawCounts] of Object.entries(jsonObject(value))) {
    if (!CATEGORY_NAMES.includes(name)) continue;
    result[snakeToCamel(name)] = countMap(rawCounts);
  }
  return result;
}

function mergeDiagnostics(target, source) {
  for (const [name, stat] of Object.entries(source || {})) {
    if (!target[name]) target[name] = { availableCount: 0, total: 0, average: null };
    target[name].availableCount += count(stat.availableCount);
    target[name].total += Number(stat.total || 0);
  }
}

function finalizeDiagnostics(diagnostics) {
  for (const stat of Object.values(diagnostics)) {
    if (stat.availableCount > 0) stat.average = stat.total / stat.availableCount;
    else stat.total = null;
  }
  return diagnostics;
}

function mergeCategories(target, source) {
  for (const [name, counts] of Object.entries(source || {})) {
    if (!target[name]) target[name] = {};
    addCountMap(target[name], counts);
  }
}

function summarizeGroups(groups, overallLogicalRunCount = null) {
  const availabilityCounts = {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    knownCost: 0,
    duration: 0,
    billingPathAttributed: 0,
  };
  const tokenTotals = {
    input: 0,
    cacheReadInput: 0,
    cacheWriteInput: 0,
    output: 0,
    reasoningOutput: 0,
  };
  const summary = {
    invocationCount: 0,
    successCount: 0,
    errorCount: 0,
    cancelledCount: 0,
    refusalCount: 0,
    totalKnownCostUsd: 0,
    unavailableCostCount: 0,
    cacheReadHitCount: 0,
    retryInvocationCount: 0,
    fallbackServedCount: 0,
    costSourceCounts: {
      providerReported: 0,
      platformEstimate: 0,
      catalogEstimate: 0,
      unavailable: 0,
    },
    billingPathCounts: {},
    terminalReasonCounts: {},
    diagnostics: {},
    categoryCounts: {},
  };
  const tokenFields = [
    ['input', 'inputTokens'],
    ['cacheReadInput', 'cacheReadInputTokens'],
    ['cacheWriteInput', 'cacheWriteInputTokens'],
    ['output', 'outputTokens'],
    ['reasoningOutput', 'reasoningOutputTokens'],
  ];
  for (const group of groups) {
    for (const key of ['invocationCount', 'successCount', 'errorCount', 'cancelledCount', 'refusalCount']) {
      summary[key] += count(group[key]);
    }
    summary.totalKnownCostUsd += Number(group.totalKnownCostUsd || 0);
    summary.unavailableCostCount += count(group.unavailableCostCount);
    summary.cacheReadHitCount += count(group.cacheReadHitCount);
    summary.retryInvocationCount += count(group.retryInvocationCount);
    summary.fallbackServedCount += count(group.fallbackServedCount);
    for (const key of Object.keys(availabilityCounts)) {
      availabilityCounts[key] += count(group.availabilityCounts[key]);
    }
    for (const [tokenKey] of tokenFields) {
      tokenTotals[tokenKey] += Number(group.tokens[tokenKey] || 0);
    }
    addCountMap(summary.costSourceCounts, group.costSourceCounts);
    summary.billingPathCounts[group.billingPath || 'unknown'] =
      count(summary.billingPathCounts[group.billingPath || 'unknown']) + group.invocationCount;
    addCountMap(summary.terminalReasonCounts, group.terminalReasonCounts);
    mergeDiagnostics(summary.diagnostics, group.diagnostics);
    mergeCategories(summary.categoryCounts, group.categoryCounts);
  }
  summary.tokens = Object.fromEntries(tokenFields.map(([tokenKey, availabilityKey]) => [
    tokenKey,
    availabilityCounts[availabilityKey] > 0 ? tokenTotals[tokenKey] : null,
  ]));
  summary.totalKnownCostUsd = availabilityCounts.knownCost > 0
    ? summary.totalKnownCostUsd
    : null;
  summary.cacheHitRate = availabilityCounts.cacheReadInputTokens > 0
    ? summary.cacheReadHitCount / availabilityCounts.cacheReadInputTokens
    : null;
  summary.availabilityCounts = availabilityCounts;
  summary.logicalRunCount = overallLogicalRunCount == null
    ? Math.max(0, summary.invocationCount - summary.retryInvocationCount)
    : count(overallLogicalRunCount);
  summary.retryRate = summary.logicalRunCount > 0
    ? summary.retryInvocationCount / summary.logicalRunCount
    : null;
  summary.errorRate = summary.invocationCount > 0
    ? (summary.errorCount + summary.refusalCount) / summary.invocationCount
    : null;
  summary.knownCostPerSuccessUsd = summary.successCount > 0 && summary.totalKnownCostUsd != null
    ? summary.totalKnownCostUsd / summary.successCount
    : null;
  summary.diagnostics = finalizeDiagnostics(summary.diagnostics);
  summary.metricCoverage = Object.fromEntries(Object.entries(summary.diagnostics)
    .map(([name, stat]) => [name, summary.invocationCount > 0
      ? stat.availableCount / summary.invocationCount
      : null]));
  return summary;
}

function normalizedCteSql() {
  return `normalized AS (
    SELECT COALESCE(
             CASE WHEN e.metadata->>'timestamp' ~ '^\\d{4}-\\d{2}-\\d{2}T'
                  THEN (e.metadata->>'timestamp')::timestamptz END,
             e.created_at
           ) AS occurred_at,
           e.app_id AS app_id,
           e.session_id AS session_id,
           e.metadata->>'invocation_key' AS invocation_key,
           NULLIF(e.metadata->>'correlation_id', '') AS correlation_id,
           CASE WHEN e.metadata->>'attempt_number' ~ '^\\d+$'
                THEN (e.metadata->>'attempt_number')::integer END AS attempt_number,
           e.metadata->>'provider' AS provider,
           e.metadata->>'backend' AS backend,
           e.metadata->>'component' AS component,
           NULLIF(e.metadata->>'requested_model', '') AS requested_model,
           NULLIF(e.metadata->>'served_model', '') AS served_model,
           e.metadata->>'billing_path' AS billing_path,
           CASE WHEN e.metadata->>'input_tokens' ~ '^\\d+$'
                THEN (e.metadata->>'input_tokens')::bigint END AS input_tokens,
           CASE WHEN e.metadata->>'cache_read_input_tokens' ~ '^\\d+$'
                THEN (e.metadata->>'cache_read_input_tokens')::bigint END AS cache_read_input_tokens,
           CASE WHEN e.metadata->>'cache_write_input_tokens' ~ '^\\d+$'
                THEN (e.metadata->>'cache_write_input_tokens')::bigint END AS cache_write_input_tokens,
           CASE WHEN e.metadata->>'output_tokens' ~ '^\\d+$'
                THEN (e.metadata->>'output_tokens')::bigint END AS output_tokens,
           CASE WHEN e.metadata->>'reasoning_output_tokens' ~ '^\\d+$'
                THEN (e.metadata->>'reasoning_output_tokens')::bigint END AS reasoning_output_tokens,
           CASE WHEN jsonb_typeof(e.metadata->'cost_usd') = 'number'
                THEN (e.metadata->>'cost_usd')::numeric END AS cost_usd,
           COALESCE(e.metadata->>'cost_source', 'unavailable') AS cost_source,
           CASE WHEN jsonb_typeof(e.metadata->'duration_ms') = 'number'
                THEN (e.metadata->>'duration_ms')::double precision END AS duration_ms,
           COALESCE(e.metadata->>'outcome', 'unknown') AS outcome,
           NULLIF(e.metadata->>'stop_reason', '') AS stop_reason,
           e.metadata AS telemetry_metadata
      FROM events e
     WHERE e.event_type = $1
       AND e.created_at >= NOW() - ($2::text || ' days')::interval

    UNION ALL

    SELECT a.started_at AS occurred_at,
           s.app_id AS app_id,
           a.session_id AS session_id,
           a.id::text AS invocation_key,
           a.logical_turn_id::text AS correlation_id,
           a.attempt_number,
           'openrouter' AS provider,
           'coding_agent' AS backend,
           a.metadata->>'telemetry_component' AS component,
           a.requested_model,
           a.routed_model AS served_model,
           'openrouter_byok' AS billing_path,
           CASE WHEN a.provider_input_tokens_total IS NULL THEN NULL ELSE a.input_tokens END,
           CASE WHEN a.provider_cached_input_tokens_total IS NULL THEN NULL ELSE a.cached_input_tokens END,
           CASE WHEN a.provider_cache_write_input_tokens_total IS NULL THEN NULL ELSE a.cache_write_input_tokens END,
           CASE WHEN a.provider_output_tokens_total IS NULL THEN NULL ELSE a.output_tokens END,
           CASE WHEN a.provider_reasoning_output_tokens_total IS NULL THEN NULL ELSE a.reasoning_output_tokens END,
           a.estimated_cost_usd AS cost_usd,
           CASE WHEN a.estimated_cost_usd IS NULL THEN 'unavailable' ELSE 'catalog_estimate' END AS cost_source,
           EXTRACT(EPOCH FROM (a.completed_at - a.started_at)) * 1000 AS duration_ms,
           CASE a.status
             WHEN 'completed' THEN 'success'
             WHEN 'failed' THEN 'error'
             WHEN 'cancelled' THEN 'cancelled'
             ELSE 'unknown'
           END AS outcome,
           COALESCE(
             NULLIF(a.error_code, ''),
             CASE a.status
               WHEN 'completed' THEN 'end_turn'
               WHEN 'cancelled' THEN 'cancelled'
               ELSE 'agent_error'
             END
           ) AS stop_reason,
           COALESCE(a.metadata->'telemetry_metrics', '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
                  'reasoning_effort', a.reasoning_effort,
                  'usage_reset_detected', a.usage_reset_detected
                )) AS telemetry_metadata
      FROM agent_turns a
      JOIN chat_sessions s ON s.id = a.session_id
     WHERE a.provider = 'openrouter'
       AND a.status IN ('completed', 'failed', 'cancelled')
       AND a.started_at >= NOW() - ($2::text || ' days')::interval
       -- Only rows with evidence of a physical post-baseline dispatch enter
       -- the report; prepared intents cancelled during spin-up are excluded.
       AND a.metadata ? 'telemetry_component'
  )`;
}

const GROUP_DIMENSIONS = 'provider, backend, component, requested_model, served_model, billing_path';

function groupJoinSql(leftAlias, rightAlias) {
  return `${rightAlias}.provider = ${leftAlias}.provider
      AND ${rightAlias}.backend = ${leftAlias}.backend
      AND ${rightAlias}.component = ${leftAlias}.component
      AND ${rightAlias}.requested_model IS NOT DISTINCT FROM ${leftAlias}.requested_model
      AND ${rightAlias}.served_model IS NOT DISTINCT FROM ${leftAlias}.served_model
      AND ${rightAlias}.billing_path = ${leftAlias}.billing_path`;
}

function metricCtesSql({ dimensions = GROUP_DIMENSIONS, prefix = '', source = 'normalized' } = {}) {
  const selectDimensions = dimensions ? `${dimensions},` : '';
  const groupDimensions = dimensions ? `, ${dimensions}` : '';
  const names = prefix ? `${prefix}_` : '';
  return `${names}metric_rows AS (
      SELECT ${selectDimensions} metric.key AS metric_name,
             metric.value::numeric AS metric_value
        FROM ${source} n
        CROSS JOIN LATERAL jsonb_each_text(COALESCE(n.telemetry_metadata, '{}'::jsonb)) metric
       WHERE n.occurred_at >= NOW() - ($2::text || ' days')::interval
         AND metric.key = ANY($3::text[])
         AND metric.value ~ '^[0-9]+([.][0-9]+)?$'
    ), ${names}metric_stats AS (
      SELECT ${selectDimensions} metric_name,
             COUNT(*) AS available_count,
             SUM(metric_value) AS total,
             AVG(metric_value) AS average,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY metric_value) AS median,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value) AS p95
        FROM ${names}metric_rows
       GROUP BY metric_name${groupDimensions}
    ), ${names}metric_maps AS (
      SELECT ${dimensions ? `${dimensions},` : ''}
             jsonb_object_agg(metric_name, jsonb_build_object(
               'availableCount', available_count,
               'total', total,
               'average', average,
               'median', median,
               'p95', p95
             )) AS diagnostic_metrics
        FROM ${names}metric_stats
       ${dimensions ? `GROUP BY ${dimensions}` : ''}
    ), ${names}category_rows AS (
      SELECT ${selectDimensions} category.key AS category_name,
             category.value AS category_value
        FROM ${source} n
        CROSS JOIN LATERAL jsonb_each_text(COALESCE(n.telemetry_metadata, '{}'::jsonb)) category
       WHERE n.occurred_at >= NOW() - ($2::text || ' days')::interval
         AND category.key = ANY($4::text[])
         AND category.value ~ '^[a-zA-Z0-9_.:-]+$'
    ), ${names}category_value_counts AS (
      SELECT ${selectDimensions} category_name, category_value, COUNT(*) AS value_count
        FROM ${names}category_rows
       GROUP BY category_name, category_value${groupDimensions}
    ), ${names}category_value_maps AS (
      SELECT ${selectDimensions} category_name,
             jsonb_object_agg(category_value, value_count) AS value_counts
        FROM ${names}category_value_counts
       GROUP BY category_name${groupDimensions}
    ), ${names}category_maps AS (
      SELECT ${dimensions ? `${dimensions},` : ''}
             jsonb_object_agg(category_name, value_counts) AS category_counts
        FROM ${names}category_value_maps
       ${dimensions ? `GROUP BY ${dimensions}` : ''}
    )`;
}

// Admin-only callers enforce authorization at the route layer. Both queries
// return aggregates only; no prompt/output/error/path field is projected.
async function aggregateReport(poolOrConfig, { days = 14 } = {}) {
  const boundedDays = Number(days);
  if (!Number.isInteger(boundedDays) || boundedDays < 1 || boundedDays > MAX_REPORT_DAYS) {
    const err = new Error(`days must be an integer between 1 and ${MAX_REPORT_DAYS}`);
    err.code = 'invalid_timeframe';
    throw err;
  }
  const pool = resolvePool(poolOrConfig);
  const params = [
    EVENT_TYPE,
    String(boundedDays),
    DIAGNOSTIC_METRIC_NAMES,
    CATEGORY_NAMES,
  ];
  const groupSql = `WITH ${normalizedCteSql()},
    grouped AS (
      SELECT ${GROUP_DIMENSIONS},
             COUNT(*) AS invocation_count,
             COUNT(DISTINCT COALESCE(correlation_id, invocation_key)) AS logical_run_count,
             COUNT(*) FILTER (WHERE attempt_number > 1) AS retry_invocation_count,
             COUNT(*) FILTER (WHERE requested_model IS DISTINCT FROM served_model
                               AND served_model IS NOT NULL) AS fallback_served_count,
             COUNT(*) FILTER (WHERE outcome = 'success') AS success_count,
             COUNT(*) FILTER (WHERE outcome = 'error') AS error_count,
             COUNT(*) FILTER (WHERE outcome = 'cancelled') AS cancelled_count,
             COUNT(*) FILTER (WHERE outcome = 'refusal') AS refusal_count,
             CASE WHEN COUNT(input_tokens) = 0 THEN NULL ELSE SUM(input_tokens) END AS input_tokens,
             CASE WHEN COUNT(cache_read_input_tokens) = 0 THEN NULL ELSE SUM(cache_read_input_tokens) END AS cache_read_input_tokens,
             CASE WHEN COUNT(cache_write_input_tokens) = 0 THEN NULL ELSE SUM(cache_write_input_tokens) END AS cache_write_input_tokens,
             CASE WHEN COUNT(output_tokens) = 0 THEN NULL ELSE SUM(output_tokens) END AS output_tokens,
             CASE WHEN COUNT(reasoning_output_tokens) = 0 THEN NULL ELSE SUM(reasoning_output_tokens) END AS reasoning_output_tokens,
             CASE WHEN COUNT(cost_usd) = 0 THEN NULL ELSE SUM(cost_usd) END AS total_known_cost_usd,
             AVG(cost_usd) AS average_cost_usd,
             COUNT(*) FILTER (WHERE cost_usd IS NULL) AS unavailable_cost_count,
             COUNT(input_tokens) AS input_tokens_available_count,
             COUNT(cache_read_input_tokens) AS cache_read_input_tokens_available_count,
             COUNT(cache_write_input_tokens) AS cache_write_input_tokens_available_count,
             COUNT(output_tokens) AS output_tokens_available_count,
             COUNT(reasoning_output_tokens) AS reasoning_output_tokens_available_count,
             COUNT(cost_usd) AS known_cost_available_count,
             COUNT(duration_ms) AS duration_available_count,
             COUNT(*) FILTER (WHERE billing_path <> 'unknown') AS billing_path_attributed_count,
             COUNT(*) FILTER (WHERE cache_read_input_tokens > 0) AS cache_read_hit_count,
             CASE WHEN COUNT(cache_read_input_tokens) = 0 THEN NULL
                  ELSE COUNT(*) FILTER (WHERE cache_read_input_tokens > 0)::double precision
                       / COUNT(cache_read_input_tokens) END AS cache_hit_rate,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
               FILTER (WHERE duration_ms IS NOT NULL) AS median_duration_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
               FILTER (WHERE duration_ms IS NOT NULL) AS p95_duration_ms,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)
               FILTER (WHERE cost_usd IS NOT NULL) AS median_cost_usd,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY cost_usd)
               FILTER (WHERE cost_usd IS NOT NULL) AS p95_cost_usd,
             COUNT(*) FILTER (WHERE cost_source = 'provider_reported') AS provider_reported_cost_count,
             COUNT(*) FILTER (WHERE cost_source = 'platform_estimate') AS platform_estimate_cost_count,
             COUNT(*) FILTER (WHERE cost_source = 'catalog_estimate') AS catalog_estimate_cost_count
        FROM normalized
       WHERE occurred_at >= NOW() - ($2::text || ' days')::interval
       GROUP BY ${GROUP_DIMENSIONS}
    ), overall AS (
      SELECT COUNT(DISTINCT COALESCE(correlation_id, invocation_key)) AS logical_run_count
        FROM normalized
       WHERE occurred_at >= NOW() - ($2::text || ' days')::interval
    ), reason_counts AS (
      SELECT ${GROUP_DIMENSIONS}, COALESCE(stop_reason, 'unavailable') AS terminal_reason,
             COUNT(*) AS reason_count
        FROM normalized
       WHERE occurred_at >= NOW() - ($2::text || ' days')::interval
       GROUP BY ${GROUP_DIMENSIONS}, COALESCE(stop_reason, 'unavailable')
    ), reason_maps AS (
      SELECT ${GROUP_DIMENSIONS},
             jsonb_object_agg(terminal_reason, reason_count) AS terminal_reason_counts
        FROM reason_counts
       GROUP BY ${GROUP_DIMENSIONS}
    ), ${metricCtesSql()}
    SELECT g.*, o.logical_run_count AS overall_logical_run_count,
           r.terminal_reason_counts, m.diagnostic_metrics, c.category_counts
      FROM grouped g
      CROSS JOIN overall o
      JOIN reason_maps r ON ${groupJoinSql('g', 'r')}
      LEFT JOIN metric_maps m ON ${groupJoinSql('g', 'm')}
      LEFT JOIN category_maps c ON ${groupJoinSql('g', 'c')}
     ORDER BY g.provider, g.backend, g.component, g.requested_model NULLS LAST,
              g.served_model NULLS LAST, g.billing_path`;

  const dayDimension = "TO_CHAR(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')";
  const dailySql = `WITH ${normalizedCteSql()},
    daily_normalized AS (
      SELECT *, ${dayDimension} AS day
        FROM normalized
       WHERE occurred_at >= NOW() - ($2::text || ' days')::interval
    ),
    daily_base AS (
      SELECT day,
             COUNT(*) AS invocation_count,
             COUNT(DISTINCT COALESCE(correlation_id, invocation_key)) AS logical_run_count,
             COUNT(*) FILTER (WHERE attempt_number > 1) AS retry_invocation_count,
             COUNT(*) FILTER (WHERE requested_model IS DISTINCT FROM served_model
                               AND served_model IS NOT NULL) AS fallback_served_count,
             COUNT(*) FILTER (WHERE outcome = 'success') AS success_count,
             COUNT(*) FILTER (WHERE outcome = 'error') AS error_count,
             COUNT(*) FILTER (WHERE outcome = 'cancelled') AS cancelled_count,
             COUNT(*) FILTER (WHERE outcome = 'refusal') AS refusal_count,
             CASE WHEN COUNT(input_tokens) = 0 THEN NULL ELSE SUM(input_tokens) END AS input_tokens,
             CASE WHEN COUNT(cache_read_input_tokens) = 0 THEN NULL ELSE SUM(cache_read_input_tokens) END AS cache_read_input_tokens,
             CASE WHEN COUNT(cache_write_input_tokens) = 0 THEN NULL ELSE SUM(cache_write_input_tokens) END AS cache_write_input_tokens,
             CASE WHEN COUNT(output_tokens) = 0 THEN NULL ELSE SUM(output_tokens) END AS output_tokens,
             CASE WHEN COUNT(reasoning_output_tokens) = 0 THEN NULL ELSE SUM(reasoning_output_tokens) END AS reasoning_output_tokens,
             CASE WHEN COUNT(cost_usd) = 0 THEN NULL ELSE SUM(cost_usd) END AS total_known_cost_usd,
             COUNT(cost_usd) AS known_cost_available_count,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
               FILTER (WHERE duration_ms IS NOT NULL) AS median_duration_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
               FILTER (WHERE duration_ms IS NOT NULL) AS p95_duration_ms
        FROM daily_normalized
       GROUP BY day
    ), ${metricCtesSql({ dimensions: 'day', prefix: 'daily', source: 'daily_normalized' })}
    SELECT d.*, m.diagnostic_metrics, c.category_counts
      FROM daily_base d
      LEFT JOIN daily_metric_maps m ON m.day = d.day
      LEFT JOIN daily_category_maps c ON c.day = d.day
     ORDER BY d.day`;

  const [groupResult, dailyResult] = await Promise.all([
    pool.query(groupSql, params),
    pool.query(dailySql, params),
  ]);

  const groups = groupResult.rows.map((row) => ({
    provider: row.provider,
    backend: row.backend,
    component: row.component,
    requestedModel: row.requested_model,
    servedModel: row.served_model,
    billingPath: row.billing_path,
    invocationCount: count(row.invocation_count),
    logicalRunCount: count(row.logical_run_count),
    retryInvocationCount: count(row.retry_invocation_count),
    fallbackServedCount: count(row.fallback_served_count),
    successCount: count(row.success_count),
    errorCount: count(row.error_count),
    cancelledCount: count(row.cancelled_count),
    refusalCount: count(row.refusal_count),
    tokens: {
      input: nullableNumber(row.input_tokens),
      cacheReadInput: nullableNumber(row.cache_read_input_tokens),
      cacheWriteInput: nullableNumber(row.cache_write_input_tokens),
      output: nullableNumber(row.output_tokens),
      reasoningOutput: nullableNumber(row.reasoning_output_tokens),
    },
    totalKnownCostUsd: nullableNumber(row.total_known_cost_usd),
    unavailableCostCount: count(row.unavailable_cost_count),
    cacheHitRate: nullableNumber(row.cache_hit_rate),
    cacheReadHitCount: count(row.cache_read_hit_count),
    availabilityCounts: {
      inputTokens: count(row.input_tokens_available_count),
      cacheReadInputTokens: count(row.cache_read_input_tokens_available_count),
      cacheWriteInputTokens: count(row.cache_write_input_tokens_available_count),
      outputTokens: count(row.output_tokens_available_count),
      reasoningOutputTokens: count(row.reasoning_output_tokens_available_count),
      knownCost: count(row.known_cost_available_count),
      duration: count(row.duration_available_count),
      billingPathAttributed: count(row.billing_path_attributed_count),
    },
    durationMs: {
      median: nullableNumber(row.median_duration_ms),
      p95: nullableNumber(row.p95_duration_ms),
    },
    knownCostUsd: {
      average: nullableNumber(row.average_cost_usd),
      median: nullableNumber(row.median_cost_usd),
      p95: nullableNumber(row.p95_cost_usd),
    },
    costSourceCounts: {
      providerReported: count(row.provider_reported_cost_count),
      platformEstimate: count(row.platform_estimate_cost_count),
      catalogEstimate: count(row.catalog_estimate_cost_count),
      unavailable: count(row.unavailable_cost_count),
    },
    terminalReasonCounts: countMap(row.terminal_reason_counts),
    diagnostics: diagnosticMap(row.diagnostic_metrics),
    categoryCounts: categoryMap(row.category_counts),
  }));
  const daily = dailyResult.rows.map((row) => ({
    day: row.day,
    invocationCount: count(row.invocation_count),
    logicalRunCount: count(row.logical_run_count),
    retryInvocationCount: count(row.retry_invocation_count),
    fallbackServedCount: count(row.fallback_served_count),
    successCount: count(row.success_count),
    errorCount: count(row.error_count),
    cancelledCount: count(row.cancelled_count),
    refusalCount: count(row.refusal_count),
    tokens: {
      input: nullableNumber(row.input_tokens),
      cacheReadInput: nullableNumber(row.cache_read_input_tokens),
      cacheWriteInput: nullableNumber(row.cache_write_input_tokens),
      output: nullableNumber(row.output_tokens),
      reasoningOutput: nullableNumber(row.reasoning_output_tokens),
    },
    totalKnownCostUsd: nullableNumber(row.total_known_cost_usd),
    knownCostAvailableCount: count(row.known_cost_available_count),
    durationMs: {
      median: nullableNumber(row.median_duration_ms),
      p95: nullableNumber(row.p95_duration_ms),
    },
    diagnostics: diagnosticMap(row.diagnostic_metrics),
    categoryCounts: categoryMap(row.category_counts),
  }));
  const generatedAt = new Date();
  return {
    timeframe: {
      days: boundedDays,
      from: new Date(generatedAt.getTime() - boundedDays * 86_400_000).toISOString(),
      to: generatedAt.toISOString(),
      timezone: 'UTC',
    },
    definitions: {
      privacy: 'content-free numeric counts, strict enums, model identifiers, and opaque correlation IDs only; no prompts, outputs, tool payloads, paths, raw errors, or credentials',
      invocation: 'one direct model request, server-side fallback model hop, or coding-agent provider run; providerTurnCount exposes API turns inside an agent run when available',
      logicalRun: 'correlated physical attempts counted once; retryInvocationCount counts attempts numbered above one',
      cacheHitRate: 'invocations with cache-read tokens > 0 divided by invocations where cache-read usage is available',
      knownCost: 'provider-reported or explicitly labelled platform/catalog estimate; see costSourceCounts',
      openrouterCost: 'catalog estimate from the pinned model-pricing snapshot; never provider-exact',
      availabilityCounts: 'invocations where each nullable metric was reported; zero is available and distinct from unavailable',
      diagnostics: 'per-metric availability, total, average, median, and p95; summary medians/p95 are intentionally omitted because percentiles cannot be combined across groups',
      requestCharacters: 'character counts only, computed by walking the in-memory request without creating a second prompt-sized serialization; request content is never copied into telemetry',
      providerDuration: 'time reported as provider/API work; durationMs is end-to-end wall time and agentReportedDurationMs is the runtime-reported run time',
      queueAndSetupDuration: 'queueDurationMs is pre-acceptance local-run wait; dispatchSetupDurationMs is platform setup between worker dispatch entry and provider process launch',
      modelLimits: 'catalog/runtime context and maximum-output limits observed at dispatch; not inferred when the provider does not expose them',
      anthropicMixed: 'a Claude coding run that used both platform allowance and Anthropic BYOK after a mid-run payer switch',
    },
    summary: summarizeGroups(groups, groupResult.rows[0]?.overall_logical_run_count ?? 0),
    daily,
    groups,
  };
}

function _setEnabledForTests(value) {
  const previous = enabled;
  enabled = !!value;
  return previous;
}

function _setSinkForTests(sink) {
  const previous = testSink;
  testSink = sink;
  return previous;
}

function isCollectionEnabled() {
  return enabled;
}

// Callers that must persist recovery context can use the same strict
// component vocabulary and collection switch as event writes. A disabled
// collector returns null so no new telemetry-only metadata is attached to
// otherwise-required billing/recovery rows.
function collectionComponent(value, fallback = null) {
  if (!enabled) return null;
  if (COMPONENTS.has(value)) return value;
  return COMPONENTS.has(fallback) ? fallback : null;
}

module.exports = {
  EVENT_TYPE,
  MAX_REPORT_DAYS,
  init,
  record,
  aggregateReport,
  normalizeEvent,
  normalizeDiagnostics,
  collectionComponent,
  isCollectionEnabled,
  _setEnabledForTests,
  _setSinkForTests,
};
