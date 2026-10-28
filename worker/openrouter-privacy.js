'use strict';

// #5123 (compliance plan AI-02): no request the platform sends to OpenRouter
// may be served by a host that trains on or retains its prompts. OpenRouter's
// provider routing takes `provider.data_collection: "deny"` to limit a request
// to hosts that do neither, and it holds for every fallback the request may
// take (`allow_fallbacks`), so it has to ride on every request body.
//
// One helper, used by every call site that posts to OpenRouter: the platform's
// own transports (src/services/openrouter.js,
// src/services/openrouter-mayor.js, src/services/dictation.js) and the coding
// turns' request listeners (worker/codex-openrouter-request.js,
// worker/claude-openrouter-request.js). It lives in worker/ because the worker
// image copies its scripts one by one into /usr/local/bin and they can only
// reach a file copied beside them; the platform requires it from here as
// openrouter-mayor.js already requires the Claude listener.
//
// The deny is written last, so whatever the request already carried (order,
// only, ignore, sort, allow_fallbacks, a CLI's own preferences) is kept and an
// "allow" from anywhere upstream cannot survive. tests/openrouter-no-training
// .test.js walks the call sites.

const DATA_COLLECTION = 'deny';

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Pure: a provider-routing object with data collection denied. */
function noTrainingProvider(provider) {
  return { ...(isPlainObject(provider) ? provider : {}), data_collection: DATA_COLLECTION };
}

/** Pure: a request body whose provider routing denies data collection. */
function withNoTraining(body) {
  const own = isPlainObject(body) ? body : {};
  return { ...own, provider: noTrainingProvider(own.provider) };
}

module.exports = { DATA_COLLECTION, noTrainingProvider, withNoTraining };
