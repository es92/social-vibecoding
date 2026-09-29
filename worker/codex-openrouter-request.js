#!/usr/bin/env node
'use strict';

// Codex 0.146.0 ignores max_output_tokens in its model catalog. Enforce it
// at the HTTP boundary until the CLI can serialize it itself. This listener
// lives only inside the worker, for one invocation, and talks to the configured
// provider using that turn's key, without a central platform relay.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { StringDecoder } = require('node:string_decoder');
const { constants: { signals } } = require('node:os');
const { performance } = require('node:perf_hooks');

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_KEY_RESPONSE_BYTES = 32 * 1024;
const MAX_ERROR_DIAGNOSTIC_BYTES = 64 * 1024;
// A request's usage arrives on its terminal event, which carries the whole
// response object — every output item of that request — so it can be far
// larger than an error envelope. Retained up to this size so usage survives
// a long answer; a larger terminal event is forwarded untouched and its
// usage goes unreported, which only ever makes the turn's figure lower.
const MAX_USAGE_EVENT_BYTES = 4 * 1024 * 1024;
const TERMINAL_RESPONSE_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed']);
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function incrementType(counts, type) {
  const key = type === 'function' || type === 'namespace' || type === 'custom'
    ? type : 'other';
  counts[key] += 1;
}

function flatMcpToolName(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null;
  const separator = name.indexOf('__', 'mcp__'.length);
  if (separator <= 'mcp__'.length || separator + 2 >= name.length) return null;
  return { server: name.slice('mcp__'.length, separator), name: name.slice(separator + 2) };
}

// Codex 0.146 sends local MCP tools as namespace definitions:
// {type:"namespace",name:"mcp__shots",tools:[{type:"function",name:"..."}]}.
// Older clients flattened them into top-level mcp__server__tool functions.
// Keep one parser for both shapes so diagnostics describe the actual wire
// request whichever CLI version sent it.
function inspectToolDefinitions(tools) {
  const definitions = Array.isArray(tools) ? tools : [];
  const topLevelTypes = { function: 0, namespace: 0, custom: 0, other: 0 };
  const nestedTypes = { function: 0, namespace: 0, custom: 0, other: 0 };
  const logicalTools = [];
  const mcpServers = new Set();
  for (const definition of definitions) {
    incrementType(topLevelTypes, definition?.type);
    if (definition?.type === 'namespace' && typeof definition.name === 'string') {
      const server = definition.name.startsWith('mcp__')
        ? definition.name.slice('mcp__'.length) : null;
      if (server) mcpServers.add(server);
      const children = Array.isArray(definition.tools) ? definition.tools : [];
      for (const child of children) {
        incrementType(nestedTypes, child?.type);
        if (typeof child?.name === 'string') {
          logicalTools.push({ server, name: child.name, type: child.type });
        }
      }
      continue;
    }
    if (typeof definition?.name !== 'string') continue;
    const mcp = flatMcpToolName(definition.name);
    if (mcp) mcpServers.add(mcp.server);
    logicalTools.push({ server: mcp?.server || null, name: mcp?.name || definition.name,
      type: definition.type });
  }
  return { definitions, topLevelTypes, nestedTypes, logicalTools, mcpServers };
}

function evidenceToolInventory(tools) {
  const inspected = inspectToolDefinitions(tools);
  const countFor = server => inspected.logicalTools.filter(tool => tool.server === server).length;
  const available = name => inspected.logicalTools.some(tool => tool.name === name
    && (tool.server === 'shots' || tool.server == null));
  const knownMcpServers = new Set(['shots', 'browser_member', 'browser_admin',
    'browser_full_admin']);
  return {
    mcpServerCount: inspected.mcpServers.size,
    toolDefinitionCount: inspected.definitions.length,
    topLevelFunctionToolCount: inspected.topLevelTypes.function,
    topLevelNamespaceToolCount: inspected.topLevelTypes.namespace,
    topLevelCustomToolCount: inspected.topLevelTypes.custom,
    topLevelOtherToolCount: inspected.topLevelTypes.other,
    nestedToolDefinitionCount: Object.values(inspected.nestedTypes).reduce((sum, count) => sum + count, 0),
    nestedFunctionToolCount: inspected.nestedTypes.function,
    nestedCustomToolCount: inspected.nestedTypes.custom,
    nestedOtherToolCount: inspected.nestedTypes.namespace + inspected.nestedTypes.other,
    shotsToolDefinitionCount: countFor('shots'),
    otherMcpServerCount: [...inspected.mcpServers].filter(server => !knownMcpServers.has(server)).length,
    briefToolAvailable: available('get_brief'),
    saveShotToolAvailable: available('save_shot'),
    skipChangeToolAvailable: available('skip_change'),
    browserMemberToolCount: countFor('browser_member'),
    browserAdminToolCount: countFor('browser_admin'),
    browserFullAdminToolCount: countFor('browser_full_admin'),
  };
}

async function readBounded(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error('body_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function replyError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, code: status } }));
}

function safeRequestId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : null;
}

// Observe only small HTTP error envelopes while forwarding their bytes
// unchanged. Large/non-JSON bodies still reach Codex; diagnostics must never
// replace the refusal.
async function* observeErrorBody(body, recordError) {
  let chunks = [];
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes <= MAX_ERROR_DIAGNOSTIC_BYTES) chunks.push(Buffer.from(chunk));
    else chunks = [];
    yield chunk;
  }
  if (bytes > MAX_ERROR_DIAGNOSTIC_BYTES) return;
  try {
    const { error } = JSON.parse(Buffer.concat(chunks).toString());
    await recordError(error);
  } catch { /* Malformed provider diagnostics do not alter the response. */ }
}

/**
 * One request's token usage, from a terminal Responses event (#3038).
 * Counts only: nothing from the model's input or output leaves the worker.
 * `input_tokens` includes cached reads, as the agent's own totals do.
 */
function usageFromResponse(usage) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  if (inputTokens == null && outputTokens == null) return null;
  return {
    inputTokens,
    cachedInputTokens: count(usage?.input_tokens_details?.cached_tokens),
    outputTokens,
    reasoningOutputTokens: count(usage?.output_tokens_details?.reasoning_tokens),
  };
}

async function inspectEvent(event, recordError, recordUsage) {
  const small = event.length <= MAX_ERROR_DIAGNOSTIC_BYTES;
  // A cheap substring test first: only a terminal event is worth parsing at
  // a size no error envelope reaches.
  const mayCarryUsage = !!recordUsage && event.includes('"usage"');
  if (!small && !mayCarryUsage) return;
  const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart()).join('\n');
  let parsed;
  try { parsed = JSON.parse(data); } catch { return; /* Non-JSON events, including [DONE], pass through. */ }
  if (small) {
    try {
      await recordError(parsed?.error || parsed?.response?.error || (parsed?.type === 'error' ? parsed : null));
    } catch { /* Diagnostics never alter the response. */ }
  }
  if (mayCarryUsage && TERMINAL_RESPONSE_EVENTS.has(parsed?.type)) {
    const usage = usageFromResponse(parsed.response?.usage);
    if (usage) {
      try { recordUsage(usage); } catch { /* Telemetry cannot affect the provider request. */ }
    }
  }
}

async function* observeEventStream(body, recordError, recordUsage = null) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let oversized = false;
  // Where the next boundary search starts. Rescanning the whole retained
  // event on every chunk is quadratic once events may be megabytes long.
  let scanFrom = 0;
  const boundaryRe = /\r?\n\r?\n/g;
  for await (const chunk of body) {
    pending += decoder.write(Buffer.from(chunk));
    boundaryRe.lastIndex = scanFrom;
    let boundary;
    while ((boundary = boundaryRe.exec(pending))) {
      const event = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      boundaryRe.lastIndex = 0;
      if (!oversized) await inspectEvent(event, recordError, recordUsage);
      oversized = false;
    }
    // Events past the usage cap need no inspection. Retain only enough bytes
    // to recognize a split separator, then resume at the next event.
    if (pending.length > MAX_USAGE_EVENT_BYTES) {
      pending = pending.slice(-3);
      oversized = true;
    }
    scanFrom = Math.max(0, pending.length - 3);
    yield chunk;
  }
}

async function readKeyAllowance(base, apiKey, fetchImpl, signal) {
  // /key describes this exact key. Account-wide /credits needs a management
  // key and is deliberately not called. An unlimited key is reported as null,
  // which says nothing about the account's remaining credit.
  try {
    const response = await fetchImpl(`${base}/key`, {
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { keyLookupStatus: response.status };
    }
    const { data } = JSON.parse((await readBounded(response.body, MAX_KEY_RESPONSE_BYTES)).toString());
    const money = (n) => typeof n === 'number' && Number.isFinite(n) ? n : null;
    return {
      keyLookupStatus: response.status,
      keyLimitUsd: money(data?.limit),
      keyRemainingUsd: money(data?.limit_remaining),
      keyLimitReset: ['daily', 'weekly', 'monthly'].includes(data?.limit_reset) ? data.limit_reset : null,
    };
  } catch {
    // Diagnostic failure must not replace the original provider rejection.
    return { keyLookupStatus: null };
  }
}

async function startRequestAdapter({ baseUrl, apiKey, model, maxOutputTokens,
  onRequest = () => {}, onTiming = null, onUsage = null, timingIntervalMs = 15_000,
  reportEvidenceToolConfig = false, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('invalid_provider_url');
  }
  if (!apiKey || !model || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error('invalid_request_adapter_config');
  }
  const upstreamBase = base.href.replace(/\/+$/, '');
  const active = new Set();
  let requestOrdinal = 0;
  let toolConfigReported = false;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/responses') {
      replyError(res, 404, 'Unsupported OpenRouter adapter route');
      return;
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      replyError(res, 401, 'OpenRouter adapter authentication failed');
      return;
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      replyError(res, 415, 'Unsupported OpenRouter request encoding');
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    res.on('close', () => controller.abort());
    let timing = null;
    const emitTiming = (event) => {
      if (!onTiming) return;
      try { onTiming(event); } catch { /* Telemetry cannot affect the provider request. */ }
    };
    try {
      let body;
      try {
        body = JSON.parse((await readBounded(req, MAX_REQUEST_BYTES)).toString());
      } catch {
        replyError(res, 400, 'Invalid OpenRouter request body');
        return;
      }
      if (!body || Array.isArray(body) || body.model !== model) {
        replyError(res, 400, 'OpenRouter request model does not match the selected model');
        return;
      }
      const incomingToolInventory = evidenceToolInventory(body.tools);
      const incomingCap = body.max_output_tokens;
      if (incomingCap != null && (!Number.isSafeInteger(incomingCap) || incomingCap < 1)) {
        replyError(res, 400, 'Invalid OpenRouter output limit');
        return;
      }
      body.max_output_tokens = Math.min(maxOutputTokens, incomingCap ?? maxOutputTokens);
      const serializedBody = JSON.stringify(body);
      const payloadBytes = Buffer.byteLength(serializedBody);
      const inputBytes = body.input == null ? 0 : Buffer.byteLength(JSON.stringify(body.input));
      if (onTiming) {
        const ordinal = ++requestOrdinal;
        const startedAt = performance.now();
        // Request content never enters the timing stream. These counts let
        // the owner see whether a long coding turn is carrying its prior
        // context, linking an earlier response, or suddenly sending a much
        // smaller request after compaction. They are taken from the actual
        // wire request rather than inferred from the initial prompt.
        const instructionBytes = body.instructions == null
          ? 0 : Buffer.byteLength(JSON.stringify(body.instructions));
        const inputItems = Array.isArray(body.input) ? body.input.length : null;
        const previousResponseLinked = typeof body.previous_response_id === 'string'
          && body.previous_response_id.length > 0;
        timing = { ordinal, startedAt, stage: 'await_headers', status: null,
          responseBytes: 0, chunks: 0, outcome: 'ok' };
        if (reportEvidenceToolConfig && !toolConfigReported
            && Array.isArray(body.tools) && body.tools.length > 0) {
          toolConfigReported = true;
          emitTiming({
            kind: 'provider_tool_config',
            ...incomingToolInventory,
            forwardedToolDefinitionCount: body.tools.length,
          });
        }
        emitTiming({ kind: 'provider_request_start', requestOrdinal: ordinal,
          payloadBytes, inputBytes, instructionBytes, inputItems, previousResponseLinked,
          maxOutputTokens: body.max_output_tokens });
        timing.interval = setInterval(() => emitTiming({
          kind: 'provider_request_pending', requestOrdinal: ordinal,
          stage: timing.stage,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          responseBytes: Math.min(timing.responseBytes, 10_000_000),
          chunkCount: Math.min(timing.chunks, 1000),
        }), timingIntervalMs);
        timing.interval.unref?.();
      }
      const headers = {};
      const connectionHeaders = new Set(String(req.headers.connection || '').toLowerCase().split(',').map(s => s.trim()));
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_HEADERS.has(name) && !connectionHeaders.has(name)) headers[name] = value;
      }
      headers['content-type'] = 'application/json';
      headers['accept-encoding'] = 'identity';
      const response = await fetchImpl(`${upstreamBase}/responses`, {
        method: 'POST', headers, body: serializedBody, redirect: 'error', signal: controller.signal,
      });
      if (timing) {
        timing.status = response.status;
        timing.stage = 'await_first_byte';
        timing.outcome = response.status >= 400 ? 'http_error' : 'ok';
        emitTiming({ kind: 'provider_response_headers', requestOrdinal: timing.ordinal,
          httpStatus: response.status,
          durationMs: Math.max(0, Math.round(performance.now() - timing.startedAt)) });
      }
      const diagnostic = {
        model, maxOutputTokens: body.max_output_tokens,
        inputBytes,
        inputItems: Array.isArray(body.input) ? body.input.length : null,
        httpStatus: response.status,
        requestId: safeRequestId(response.headers.get('x-request-id') || response.headers.get('x-openrouter-request-id')),
      };
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter && /^\d+$/.test(retryAfter) && Number.isSafeInteger(Number(retryAfter))) {
        diagnostic.retryAfterSeconds = Number(retryAfter);
      }
      let keyAllowance;
      const getKeyAllowance = () => keyAllowance ||= readKeyAllowance(upstreamBase, apiKey, fetchImpl, controller.signal);
      const recordError = async error => {
        if (!error || typeof error !== 'object') return;
        const metadata = error.metadata;
        // https://openrouter.ai/docs/api_reference/limits documents these values.
        const limitSource = ['openrouter_credits', 'openrouter_key_limit', 'openrouter_in_flight_budget']
          .includes(metadata?.limit_source) ? metadata.limit_source : null;
        const paymentError = response.status === 402 || Number(error.code) === 402 || limitSource;
        if (!paymentError) return;
        diagnostic.providerErrorStatus = 402;
        if (limitSource) diagnostic.limitSource = limitSource;
        if (['in_flight_budget_exhausted', 'weight_exceeds_budget'].includes(metadata?.reason)) {
          diagnostic.limitReason = metadata.reason;
        }
        if (typeof metadata?.provider_name === 'string' && /^[a-zA-Z0-9 ._:/()-]{1,80}$/.test(metadata.provider_name)) {
          diagnostic.providerName = metadata.provider_name;
        }
        Object.assign(diagnostic, await getKeyAllowance());
        onRequest({ ...diagnostic });
      };
      if (response.status === 402) Object.assign(diagnostic, await getKeyAllowance());
      onRequest(diagnostic);
      const responseHeaders = {};
      const responseConnectionHeaders = new Set(String(response.headers.get('connection') || '').toLowerCase().split(',').map(s => s.trim()));
      for (const [name, value] of response.headers) {
        // fetch decodes compressed bodies; do not forward their old length or
        // encoding. Everything else, including provider request ids, survives.
        if (!HOP_HEADERS.has(name) && !responseConnectionHeaders.has(name) && name !== 'content-encoding') responseHeaders[name] = value;
      }
      res.writeHead(response.status, responseHeaders);
      if (response.body) {
        const isEventStream = response.headers.get('content-type')?.includes('text/event-stream');
        const bodyStream = isEventStream
          ? Readable.from(observeEventStream(response.body, recordError, onUsage))
          : response.status === 402
            ? Readable.from(observeErrorBody(response.body, recordError))
            : Readable.fromWeb(response.body);
        if (timing) {
          async function* observeTransfer() {
            for await (const chunk of bodyStream) {
              timing.responseBytes += chunk.length;
              timing.chunks += 1;
              if (timing.stage === 'await_first_byte') {
                timing.stage = 'streaming';
                emitTiming({ kind: 'provider_response_first_byte', requestOrdinal: timing.ordinal,
                  durationMs: Math.max(0, Math.round(performance.now() - timing.startedAt)) });
              }
              yield chunk;
            }
          }
          await pipeline(Readable.from(observeTransfer()), res);
        } else await pipeline(bodyStream, res);
      } else res.end();
    } catch {
      if (timing) timing.outcome = controller.signal.aborted ? 'cancelled'
        : timing.stage === 'await_headers' ? 'network_error' : 'stream_error';
      if (!res.headersSent && !res.destroyed) replyError(res, 502, 'OpenRouter request transport failed');
      else res.destroy();
    } finally {
      if (timing) {
        clearInterval(timing.interval);
        emitTiming({ kind: 'provider_request_end', requestOrdinal: timing.ordinal,
          outcome: timing.outcome, stage: timing.stage,
          ...(timing.status != null ? { httpStatus: timing.status } : {}),
          durationMs: Math.max(0, Math.round(performance.now() - timing.startedAt)),
          responseBytes: Math.min(timing.responseBytes, 10_000_000),
          chunkCount: Math.min(timing.chunks, 1000),
        });
      }
      active.delete(controller);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    activeRequestCount() { return active.size; },
    async close() {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function runCodex(args, env = process.env) {
  const catalog = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME, 'openrouter-model-catalog.json'), 'utf8'));
  const selected = catalog.models?.find(m => m.slug === env.AGENT_MODEL);
  const adapter = await startRequestAdapter({
    baseUrl: env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1',
    apiKey: env.OPENROUTER_API_KEY,
    model: env.AGENT_MODEL,
    maxOutputTokens: selected?.max_output_tokens,
    onRequest: diagnostic => process.stdout.write(`${JSON.stringify({ type: 'usernode.openrouter.request', diagnostic })}\n`),
    // #3038: each request's usage the moment it finishes, not once at the
    // end of the turn. Codex reports usage only at turn.completed, so a turn
    // stopped mid-flight used to leave no record of what it had spent; these
    // lines reach the journal as they happen and survive the kill.
    onUsage: usage => process.stdout.write(`${JSON.stringify({ type: 'usernode.openrouter.usage', usage })}\n`),
    // Evidence retains its structured run diagnostics. Ordinary coding turns
    // need the same content-free request timing so a quiet model call can be
    // distinguished from a runner that never sent a request.
    onTiming: diagnostic => process.stdout.write(
      `${env.MODE === 'evidence' ? '__USERNODE_EVIDENCE_PROVIDER__' : '__USERNODE_CODING_PROVIDER__'} ${JSON.stringify(diagnostic)}\n`),
    reportEvidenceToolConfig: env.MODE === 'evidence',
  });
  // The override is process-local. Neither the key nor the ephemeral listener
  // is written to the persistent Codex configuration.
  const child = spawn('codex', [
    '-c', `model_providers.usernode_openrouter.base_url=${JSON.stringify(adapter.baseUrl)}`,
    ...args,
  ], { env, stdio: ['inherit', 'pipe', 'pipe'] });
  let lastCodexOutputAt = performance.now();
  let lastIdleReportAt = null;
  // Serialize complete lines from both child streams and our diagnostics so
  // a diagnostic cannot land halfway through a large Codex JSONL event.
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
      lastCodexOutputAt = performance.now();
      lastIdleReportAt = null;
      process.stdout.write(`${line}\n`);
    });
  }
  // A quiet Codex process with zero provider requests is a different failure
  // boundary from an in-flight provider request. Record that fact at most once
  // a minute, without inspecting the model's input or output.
  const idleHeartbeat = env.MODE === 'evidence' ? null : setInterval(() => {
    const idleMs = Math.max(0, Math.round(performance.now() - lastCodexOutputAt));
    if (idleMs < 60_000 || (lastIdleReportAt != null && idleMs - lastIdleReportAt < 60_000)) return;
    lastIdleReportAt = idleMs;
    process.stdout.write(`__USERNODE_CODING_PROVIDER__ ${JSON.stringify({
      kind: 'codex_output_idle', durationMs: idleMs, activeRequests: adapter.activeRequestCount(),
    })}\n`);
  }, 15_000);
  idleHeartbeat?.unref();
  let killTimer;
  const stop = signal => {
    child.kill(signal);
    killTimer ||= setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signals[signal] ? 128 + signals[signal] : 1)));
    });
  } finally {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
    clearTimeout(killTimer);
    if (idleHeartbeat) clearInterval(idleHeartbeat);
    await adapter.close();
  }
}

if (require.main === module) {
  runCodex(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stdout.write(`${JSON.stringify({ type: 'error', message: 'Could not start the OpenRouter request adapter' })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { startRequestAdapter, runCodex };
