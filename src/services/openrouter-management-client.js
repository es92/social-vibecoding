'use strict';

// OpenRouter Management API client. This credential is organization-scoped
// and must never be passed to a worker or browser. Creation is intentionally
// attempted exactly once: OpenRouter does not document an idempotency key for
// POST /keys, so retrying an ambiguous timeout could mint a duplicate key.

const TIMEOUT_MS = 15_000;

class OpenRouterManagementError extends Error {
  constructor(message, { status = 0, code = 'management_api_error', ambiguous = false } = {}) {
    super(message);
    this.name = 'OpenRouterManagementError';
    this.status = status;
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

function headers(apiKey, origin) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': origin || 'https://usernode.dev',
    'X-OpenRouter-Title': 'Homeroom',
  };
}

async function request(path, { apiKey, baseUrl, origin, method, body }) {
  if (!apiKey) throw new OpenRouterManagementError('OpenRouter management is not configured.', { code: 'not_configured' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: headers(apiKey, origin),
        body: body == null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new OpenRouterManagementError(`OpenRouter management request failed: ${err.message}`, {
        code: 'network_error', ambiguous: method === 'POST',
      });
    }
    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok) {
      const providerMessage = parsed?.error?.message || parsed?.message || `HTTP ${response.status}`;
      throw new OpenRouterManagementError(`OpenRouter management request failed (${providerMessage}).`, {
        status: response.status,
        code: response.status === 401 || response.status === 403 ? 'management_key_rejected' : 'provider_error',
        ambiguous: method === 'POST' && response.status >= 500,
      });
    }
    return parsed || {};
  } finally {
    clearTimeout(timer);
  }
}

async function createKey({ apiKey, baseUrl, origin, name, limit, workspaceId }) {
  const body = { name, limit, limit_reset: 'daily' };
  if (workspaceId) body.workspace_id = workspaceId;
  const result = await request('/keys', {
    apiKey, baseUrl, origin, method: 'POST', body,
  });
  const data = result.data || {};
  const key = result.key || data.key;
  const hash = data.hash || result.hash;
  if (typeof key !== 'string' || !key.startsWith('sk-or-')
      || typeof hash !== 'string' || hash.length < 16) {
    throw new OpenRouterManagementError('OpenRouter returned an incomplete key response.', {
      code: 'invalid_provider_response', ambiguous: true,
    });
  }
  return {
    key,
    hash,
    label: data.label || data.name || name,
    limit: typeof data.limit === 'number' ? data.limit : limit,
    limitRemaining: typeof data.limit_remaining === 'number' ? data.limit_remaining : limit,
    limitReset: data.limit_reset || 'daily',
  };
}

async function setDisabled({ apiKey, baseUrl, origin, hash, disabled }) {
  return request(`/keys/${encodeURIComponent(hash)}`, {
    apiKey, baseUrl, origin, method: 'PATCH', body: { disabled: !!disabled },
  });
}

async function deleteKey({ apiKey, baseUrl, origin, hash }) {
  try {
    return await request(`/keys/${encodeURIComponent(hash)}`, {
      apiKey, baseUrl, origin, method: 'DELETE', body: null,
    });
  } catch (err) {
    // A missing remote key already satisfies the requested end state.
    if (err instanceof OpenRouterManagementError && err.status === 404) return {};
    throw err;
  }
}

module.exports = {
  OpenRouterManagementError,
  createKey,
  setDisabled,
  deleteKey,
};
