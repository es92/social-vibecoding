'use strict';

// OpenRouter API client (plan.md §6, §7). Server-side only.
//
// Two responsibilities:
//   1. Key validation + key-limit info via GET /api/v1/key.
//   2. The user-filtered model catalog via GET /api/v1/models/user.
//
// The raw OpenRouter key is never persisted in the worker container; this
// module runs on the platform. For Codex turns the key is injected only
// into the per-turn docker exec as OPENROUTER_API_KEY (direct transport),
// never into the worker's warm persistent env/filesystem.

const log = require('./logger');

const KEY_TIMEOUT_MS = 12000;
const MODELS_TIMEOUT_MS = 20000;

// Attribution headers OpenRouter recommends (and uses for rankings).
function platformHeaders(origin) {
  return {
    'HTTP-Referer': origin || 'https://usernode.dev',
    'X-OpenRouter-Title': 'Homeroom',
  };
}

async function fetchJson(url, { headers, timeoutMs, signal }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers,
      signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Validate an OpenRouter key and return the sanitized key-info the UI
// needs (label, limit, remaining, reset). Never returns the raw key.
// Throws on network/parse/401 so the caller can surface an actionable
// error and NOT destroy a working key on a transient failure.
async function validateKey(apiKey, { baseUrl, origin } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('openrouter-client: apiKey required');
  }
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new Error('openrouter-client: baseUrl required (callers pass the canonical config value)');
  }
  const { ok, status, body, error } = await fetchJson(
    `${baseUrl.replace(/\/$/, '')}/key`,
    { headers: { Authorization: `Bearer ${apiKey.trim()}`, ...platformHeaders(origin) }, timeoutMs: KEY_TIMEOUT_MS }
  );
  if (error) throw new Error(`OpenRouter key check failed: ${error}`);
  if (status === 401 || status === 403) {
    const e = new Error('OpenRouter rejected the key.');
    e.code = 'invalid_key';
    throw e;
  }
  if (!ok || !body || !body.data) {
    throw new Error(`OpenRouter key check failed (HTTP ${status}).`);
  }
  const d = body.data;
  return {
    label: d.label || null,
    limit: typeof d.limit === 'number' ? d.limit : null,
    limitRemaining: typeof d.limit_remaining === 'number' ? d.limit_remaining : null,
    limitReset: d.limit_reset || null,
    usage: typeof d.usage === 'number' ? d.usage : null,
  };
}

// Fetch the user-filtered model catalog (GET /api/v1/models/user).
// Returns the raw models array; compatibility annotation and cost ordering
// happen in agent-models.js. Never throws on a single bad model — surfaces a
// structured error only when the whole call fails.
async function fetchUserModels(apiKey, { baseUrl, origin } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('openrouter-client: apiKey required');
  }
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new Error('openrouter-client: baseUrl required (callers pass the canonical config value)');
  }
  const { ok, status, body, error } = await fetchJson(
    `${baseUrl.replace(/\/$/, '')}/models/user`,
    { headers: { Authorization: `Bearer ${apiKey.trim()}`, ...platformHeaders(origin) }, timeoutMs: MODELS_TIMEOUT_MS }
  );
  if (error) throw new Error(`OpenRouter catalog fetch failed: ${error}`);
  if (status === 401 || status === 403) {
    const e = new Error('OpenRouter rejected the key.');
    e.code = 'invalid_key';
    throw e;
  }
  if (!ok || !body || !Array.isArray(body.data)) {
    throw new Error(`OpenRouter catalog fetch failed (HTTP ${status}).`);
  }
  return body.data;
}

module.exports = {
  validateKey,
  fetchUserModels,
  platformHeaders,
};
