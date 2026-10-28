'use strict';

// Backend-aware agent model catalog (plan.md §7). For codex_openrouter we
// surface the complete OpenRouter catalog with advisory compatibility
// metadata. A model being unverified or missing Codex-friendly capabilities
// must never hide it: every model OpenRouter lists stays selectable. For
// claude_code the legacy allowlist in services/models.js remains
// authoritative.
//
// ONE catalog for the whole platform, like the Anthropic list: OpenRouter's
// public GET /models, kept in memory and in openrouter_model_catalog, and
// refreshed in the background once it is REFRESH_MS old. A model menu is
// answered from it at once; nothing on the request path waits on OpenRouter
// except the very first read of a platform that has never stored one. It
// used to be each key's own filtered list (GET /models/user), read while the
// menu waited and kept for a minute per pod. A model a personal key's
// account policy excludes is now listed, and OpenRouter refuses it when the
// turn starts.

const log = require('./logger');
const openrouterClient = require('./openrouter-client');

// How old the shared catalog may be before a read refreshes it (in the
// background: the read still answers with what is held).
const REFRESH_MS = 15 * 60_000;
// A Refresh button waits for OpenRouter at most this often.
const FORCED_REFRESH_MIN_MS = 60_000;

// OpenRouter's own pricing sort uses the average prompt/completion price.
// These fixed bands make that same score easier to scan without pretending
// to predict a whole Codex turn (whose token use varies substantially).
const LOW_COST_MAX_PER_MILLION = 2;
const MEDIUM_COST_MAX_PER_MILLION = 10;

function supportedParameterList(m) {
  const params = m?.supported_parameters || m?.parameters || [];
  return Array.isArray(params) ? params : Object.keys(params);
}

function hasToolSupport(m) {
  const params = supportedParameterList(m);
  return params.includes('tools') || params.includes('tool_choice');
}

function hasStructuredOutputSupport(m) {
  const params = supportedParameterList(m);
  return params.includes('structured_outputs')
    || params.includes('response_format')
    || params.includes('json_schema');
}

function hasReasoningEffortSupport(m) {
  const params = supportedParameterList(m);
  // OpenRouter currently describes the request control as either the broad
  // `reasoning` parameter or the more specific `reasoning_effort` parameter,
  // depending on the upstream model metadata revision.
  return params.includes('reasoning_effort') || params.includes('reasoning');
}

function hasParallelToolCallSupport(m) {
  return supportedParameterList(m).includes('parallel_tool_calls');
}

function hasTemperatureSupport(m) {
  return supportedParameterList(m).includes('temperature');
}

// Static minimums a model must meet to even be "experimental" for Codex.
function meetsStaticMinimums(m) {
  if (!m) return false;
  // OpenRouter documents `supported_parameters` as an ARRAY of strings
  // (e.g. ["tools","tool_choice","reasoning"]), not an object. Handle
  // both shapes defensively (review P2).
  // Context length: Codex turns carry large repo context.
  const ctx = m.context_length || m.top_provider?.context_length || 0;
  return hasToolSupport(m) && ctx >= 32000;
}

function pricePerMillion(rawPrice) {
  if (rawPrice == null || rawPrice === '') return null;
  const parsed = Number.parseFloat(rawPrice);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : null;
}

function averageTokenPrice(inputPricePerMillion, outputPricePerMillion) {
  if (!Number.isFinite(inputPricePerMillion) || !Number.isFinite(outputPricePerMillion)) {
    return null;
  }
  return (inputPricePerMillion + outputPricePerMillion) / 2;
}

function costTier(averagePricePerMillion) {
  if (!Number.isFinite(averagePricePerMillion)) return 'unknown';
  if (averagePricePerMillion === 0) return 'free';
  if (averagePricePerMillion <= LOW_COST_MAX_PER_MILLION) return 'low';
  if (averagePricePerMillion <= MEDIUM_COST_MAX_PER_MILLION) return 'medium';
  return 'high';
}

function compareByCost(a, b) {
  const aPrice = Number.isFinite(a.averagePricePerMillion) ? a.averagePricePerMillion : Infinity;
  const bPrice = Number.isFinite(b.averagePricePerMillion) ? b.averagePricePerMillion : Infinity;
  if (aPrice !== bPrice) return aPrice - bPrice;
  return String(a.name || a.id).localeCompare(String(b.name || b.id));
}

// OpenRouter's own word on what a model takes in: architecture.input_modalities
// (e.g. ['text', 'image']). Absent means text only.
function acceptsImages(m) {
  const modalities = m?.architecture?.input_modalities;
  return Array.isArray(modalities) && modalities.includes('image');
}

// #3557: the same list's 'file' entry, which is how OpenRouter marks a model
// that reads a PDF itself.
function acceptsFiles(m) {
  const modalities = m?.architecture?.input_modalities;
  return Array.isArray(modalities) && modalities.includes('file');
}

// Sanitize a raw OpenRouter model into the UI-friendly shape.
function sanitizeModel(m, compatibility, { recommended = false } = {}) {
  const pricing = m.pricing || {};
  const params = m.supported_parameters || m.parameters || [];
  const reasoningMetadata = !Array.isArray(params) && params.reasoning;
  const supportsReasoning = Array.isArray(params)
    ? params.includes('reasoning')
    : !!reasoningMetadata;
  const reasoningEfforts = reasoningMetadata && typeof reasoningMetadata === 'object'
    ? (reasoningMetadata.efforts ?? null)
    : null;
  const promptPrice = pricePerMillion(pricing.prompt);
  const completionPrice = pricePerMillion(pricing.completion);
  const averagePricePerMillion = averageTokenPrice(promptPrice, completionPrice);
  const createdSeconds = Number(m.created);
  const createdDate = Number.isFinite(createdSeconds) && createdSeconds > 0
    ? new Date(createdSeconds * 1000)
    : null;
  const sanitized = {
    id: m.id,
    name: m.name || m.id,
    provider: String(m.id || '').split('/')[0] || null,
    canonicalSlug: typeof m.canonical_slug === 'string' ? m.canonical_slug : null,
    createdAt: createdDate && Number.isFinite(createdDate.getTime())
      ? createdDate.toISOString()
      : null,
    contextLength: m.context_length || null,
    maxOutputTokens: m.top_provider?.max_completion_tokens || null,
    inputPricePerMillion: promptPrice,
    outputPricePerMillion: completionPrice,
    averagePricePerMillion,
    costTier: costTier(averagePricePerMillion),
    supportsTools: hasToolSupport(m),
    supportsStructuredOutputs: hasStructuredOutputSupport(m),
    supportsReasoningEffort: hasReasoningEffortSupport(m),
    supportsParallelToolCalls: hasParallelToolCallSupport(m),
    supportsTemperature: hasTemperatureSupport(m),
    meetsCodexMinimums: meetsStaticMinimums(m),
    supportsReasoning,
    reasoningEfforts,
    isRecommended: recommended === true,
    compatibility: compatibility.status,
    compatibilityNote: compatibility.note || null,
  };
  // #3426: whether OpenRouter lists image input for the model, read by the
  // coding turn's runtime metadata (agent-turn.js) so a model that sees
  // images is declared able to. Non-enumerable, so the catalog JSON the
  // model picker reads keeps its shape.
  Object.defineProperty(sanitized, 'supportsImages', {
    value: acceptsImages(m),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  // #3557: whether it lists file (PDF) input, read by the OpenRouter Mayor
  // and the coding turn's runtime metadata. Non-enumerable likewise.
  Object.defineProperty(sanitized, 'supportsFiles', {
    value: acceptsFiles(m),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  // What a prompt-cache read and a cache write cost, per million tokens, from
  // OpenRouter's `input_cache_read` / `input_cache_write` (per token, like
  // `prompt`), or null where the catalog lists none. A coding turn's prompt
  // is mostly cache reads, which Anthropic models bill at a tenth of the
  // prompt rate, so the coding turn's pricing snapshot (agent-turn.js)
  // carries these. Non-enumerable likewise.
  Object.defineProperty(sanitized, 'cacheReadPricePerMillion', {
    value: pricePerMillion(pricing.input_cache_read),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(sanitized, 'cacheWritePricePerMillion', {
    value: pricePerMillion(pricing.input_cache_write),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return sanitized;
}

// Load the compatibility overlay from the DB (agent_model_compatibility).
async function loadCompatibilityOverlay(pool, backend) {
  try {
    const { rows } = await pool.query(
      `SELECT model_id, status, note FROM agent_model_compatibility WHERE backend = $1`,
      [backend]
    );
    const map = new Map();
    for (const r of rows) map.set(r.model_id, { status: r.status, note: r.note });
    return map;
  } catch (err) {
    log.warn('agent-models', 'compatibility overlay read failed', { backend, err: err.message });
    return new Map();
  }
}

// Default compatibility when no overlay row exists: experimental if it
// meets the static minimums, otherwise blocked. This is advisory catalog
// metadata only; every model returned by OpenRouter remains selectable.
// Operators promote models to "verified" by inserting an overlay row.
function defaultCompatibility(m) {
  return meetsStaticMinimums(m) ? { status: 'experimental', note: null } : { status: 'blocked', note: 'Model does not meet Codex requirements (tools / context).' };
}

// The shared catalog: OpenRouter's raw list (`raw`), when it was fetched,
// and the sanitized list built from it (`built`, on first use). `loading` is
// the one request to OpenRouter in flight, so a burst of menus asks once.
let shared = null;
let loading = null;

async function readStoredCatalog(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT models, fetched_at FROM openrouter_model_catalog WHERE id = TRUE'
    );
    const row = rows && rows[0];
    const fetchedAt = row ? new Date(row.fetched_at).getTime() : NaN;
    if (!row || !Array.isArray(row.models) || !row.models.length || !Number.isFinite(fetchedAt)) return null;
    return { raw: row.models, fetchedAt, built: null };
  } catch (err) {
    log.warn('agent-models', 'stored OpenRouter catalog read failed', { err: err.message });
    return null;
  }
}

async function fetchCatalog(pool, config) {
  const data = await openrouterClient.fetchModels({ baseUrl: config.openrouterApiBase, origin: config.openrouterOrigin });
  // Descriptions are long prose nothing here reads.
  const raw = data
    .filter((m) => m && typeof m.id === 'string' && m.id.trim())
    .map(({ description: _description, ...m }) => m);
  // An empty answer is OpenRouter having a bad moment, not a catalog.
  if (!raw.length) throw new Error('OpenRouter returned an empty model catalog.');
  const next = { raw, fetchedAt: Date.now(), built: null };
  try {
    await pool.query(
      `INSERT INTO openrouter_model_catalog (id, models, fetched_at)
       VALUES (TRUE, $1::jsonb, to_timestamp($2::double precision / 1000))
       ON CONFLICT (id) DO UPDATE SET models = EXCLUDED.models, fetched_at = EXCLUDED.fetched_at
        WHERE openrouter_model_catalog.fetched_at < EXCLUDED.fetched_at`,
      [JSON.stringify(raw), next.fetchedAt]
    );
  } catch (err) {
    log.warn('agent-models', 'storing the OpenRouter catalog failed', { err: err.message });
  }
  return next;
}

// Ask OpenRouter again, once however many readers want it. What is held
// stays in use until the new list is in.
function refreshCatalog(pool, config) {
  if (!loading) {
    loading = fetchCatalog(pool, config)
      .then((next) => { shared = next; return next; })
      .finally(() => { loading = null; });
  }
  return loading;
}

async function buildCatalog(pool, config, held) {
  const overlay = await loadCompatibilityOverlay(pool, 'codex_openrouter');
  const recommendedSet = new Set(Array.isArray(config.openrouterRecommendedModels) ? config.openrouterRecommendedModels : []);
  const models = held.raw
    .map((m) => sanitizeModel(m, overlay.get(m.id) || defaultCompatibility(m), { recommended: recommendedSet.has(m.id) }))
    .sort(compareByCost);
  // Prefer the operator-configured default. This does not filter or lock the
  // catalog: every OpenRouter model remains visible/selectable, and a
  // missing GLM release safely falls back to the compatibility/cost order.
  // The UI uses this only when the user has not already selected a model.
  const configuredDefault = String(config.openrouterDefaultCodexModel || '');
  const recommended = models.find((m) => m.id === configuredDefault)
    || models.find((m) => m.compatibility === 'verified')
    || models.find((m) => m.meetsCodexMinimums)
    || models[0]
    || null;
  return {
    refreshedAt: new Date(held.fetchedAt).toISOString(),
    recommendedModelId: recommended?.id || null,
    models,
  };
}

// The catalog's own reads and writes go through the app's pool, never the
// caller's: callers hand in a transaction client (routes/sessions.js), and a
// background refresh outlives the request it started in. A test's config
// names no database, and its fake pool serves instead.
function storage(pool, config) {
  return config && config.databaseUrl ? require('../db/pool').getPool(config) : pool;
}

async function sharedCatalog({ pool, config, forceRefresh = false }) {
  const db = storage(pool, config);
  if (!shared) {
    const stored = await readStoredCatalog(db);
    if (!shared && stored) shared = stored;
  }
  // Nothing stored anywhere yet: this one read waits for OpenRouter.
  if (!shared) await refreshCatalog(db, config);
  const age = Date.now() - shared.fetchedAt;
  const kept = (err) => {
    log.warn('agent-models', 'OpenRouter catalog refresh failed; keeping the held catalog', { err: err.message });
  };
  if (forceRefresh && age > FORCED_REFRESH_MIN_MS) {
    await refreshCatalog(db, config).catch(kept);
  } else if (age > REFRESH_MS) {
    refreshCatalog(db, config).catch(kept);
  }
  const held = shared;
  if (!held.built) {
    held.built = buildCatalog(db, config, held).catch((err) => {
      held.built = null;
      throw err;
    });
  }
  return held.built;
}

// The OpenRouter models a user with a key can pick from: the shared
// catalog. Without a key there is nothing to run them on, so none.
async function listOpenRouterModels({ pool, credentialRevision, apiKey, config, forceRefresh }) {
  if (!apiKey) {
    return {
      backend: 'codex_openrouter', credentialRevision, recommendedModelId: null, models: [],
    };
  }
  const built = await sharedCatalog({ pool, config, forceRefresh });
  // The platform default an admin picked (services/default-model.js) is
  // read here, not baked into the held catalog, so a change applies without
  // rebuilding it. One the catalog does not list leaves the built choice.
  const preferred = await require('./default-model').effective(pool, config);
  const recommendedModelId = preferred && built.models.some((m) => m.id === preferred)
    ? preferred
    : built.recommendedModelId;
  return {
    backend: 'codex_openrouter',
    credentialRevision,
    refreshedAt: built.refreshedAt,
    recommendedModelId,
    models: built.models,
  };
}

// Resolve the sanitized pricing for a single model id (Commit 4, plan 6.4).
// Uses the shared catalog; returns null when the model is not in the
// catalog or the catalog cannot be read (cost then becomes 'unavailable').
async function resolveModelPricing({ pool, userId, credentialRevision, apiKey, modelId, config }) {
  try {
    const catalog = await listOpenRouterModels({
      pool, userId, credentialRevision, apiKey, config, forceRefresh: false,
    });
    const matched = (catalog.models || []).find((m) => m.id === String(modelId));
    // listOpenRouterModels already returned the sanitized catalog shape.
    // Sanitizing it again treats its per-million prices as raw per-token
    // pricing and drops fields such as contextLength/compatibility.
    return matched || null;
  } catch (err) {
    log.warn('agent-models', 'single-model pricing resolution failed', { userId, err: err.message });
    return null;
  }
}

// Forget the held catalog, so the next read starts from the stored copy.
function invalidateAll() {
  shared = null;
  loading = null;
}

module.exports = {
  meetsStaticMinimums,
  hasToolSupport,
  hasStructuredOutputSupport,
  hasReasoningEffortSupport,
  hasParallelToolCallSupport,
  hasTemperatureSupport,
  pricePerMillion,
  averageTokenPrice,
  costTier,
  compareByCost,
  sanitizeModel,
  defaultCompatibility,
  loadCompatibilityOverlay,
  listOpenRouterModels,
  resolveModelPricing,
  invalidateAll,
};
