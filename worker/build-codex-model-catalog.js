#!/usr/bin/env node
'use strict';

// Codex ships with metadata only for OpenAI's own model slugs. OpenRouter
// exposes many more slugs (including aliases such as ~vendor/model-latest),
// so each turn installs a one-model catalog for the session-pinned model.
// This keeps Codex's tool/runtime behavior while avoiding its unknown-model
// fallback metadata and the misleading diagnostic that fallback produces.
// The entry reuses Codex's own bundled instructions with the bundled GPT
// identity sentence replaced by one naming the selected model (#2120).

const fs = require('node:fs');

const DEFAULT_CONTEXT_WINDOW = 128_000;
const MAX_CONTEXT_WINDOW = 10_000_000;
const NEUTRAL_IDENTITY_INSTRUCTION = "You are Homeroom's repository coding agent.";
const DEFAULT_BASE_INSTRUCTIONS = [
  NEUTRAL_IDENTITY_INSTRUCTION,
  'Work directly in the current workspace and follow the developer and user instructions.',
  'Inspect the relevant code before editing, use the available tools, run proportionate tests,',
  'and do not claim success without verification. Never expose credentials or other secrets.',
].join(' ');
const REASONING_DESCRIPTIONS = {
  minimal: 'Minimal reasoning',
  low: 'Faster responses with lighter reasoning',
  medium: 'Balanced reasoning for everyday tasks',
  high: 'Greater reasoning depth for complex tasks',
  xhigh: 'Extra-high reasoning depth for the hardest tasks',
};
const REASONING_EFFORTS = Object.keys(REASONING_DESCRIPTIONS);
// Codex's bundled prompts open with an identity sentence written for
// OpenAI's own models. At CLI 0.146.0 every entry leads with one of three
// phrasings: "You are Codex, an agent based on GPT-5." (5.6), "You are Codex,
// a coding agent based on GPT-5." (5.4/5.5) or "You are GPT-5.2 running in
// the Codex CLI, a terminal-based coding assistant." (5.2). The builder
// copies the first entry, so all three are matched: a Codex upgrade that
// reorders its catalog must not bring GPT back (#2120). Group 1 keeps any
// leading markdown (a heading marker, bold) in front of the replacement and
// the lookahead lets a dotted version such as "GPT-5.6." end the sentence
// without swallowing the text after it.
const IDENTITY_LEAD = '^([\\s#>*_-]*)';
const IDENTITY_END = '(?=[\\s*_]|$)';
const BUNDLED_IDENTITY_ALTERNATIVES = '(?:You are Codex,\\s+an?(?:\\s+[\\w-]+)?\\s+agent based on [^\\n]*?\\.'
  + '|You are [^\\n]*? running in the Codex CLI,[^\\n]*?\\.)';
const BUNDLED_IDENTITY_SENTENCE = new RegExp(
  IDENTITY_LEAD + BUNDLED_IDENTITY_ALTERNATIVES + IDENTITY_END, 'i',
);
// The sentence nameSelectedModel() replaces: the neutral one neutralize()
// leaves in front, or a bundled GPT one that reached it unneutralized.
const LEADING_IDENTITY_SENTENCE = new RegExp(
  `${IDENTITY_LEAD}(?:${BUNDLED_IDENTITY_ALTERNATIVES}|${
    NEUTRAL_IDENTITY_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  })${IDENTITY_END}`,
  'i',
);
const MAX_MODEL_NAME_LENGTH = 120;

function optionalPositiveInteger(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.round(parsed), MAX_CONTEXT_WINDOW);
}

function parseOptionalBoolean(value) {
  if (value === true || value === '1' || value === 'true') return true;
  if (value === false || value === '0' || value === 'false') return false;
  return null;
}

function safeReasoningEfforts(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map((effort) => String(effort).trim())
    .filter((effort) => REASONING_EFFORTS.includes(effort)))];
}

function neutralizeBundledBaseInstructions(value) {
  const instructions = String(value || '').trim();
  if (!instructions) return DEFAULT_BASE_INSTRUCTIONS;

  // The bundled Codex prompt starts with an OpenAI-model identity. Reusing
  // that sentence for an OpenRouter model makes models such as GLM report
  // that they are GPT even though the request is routed to the selected GLM
  // slug. Preserve every operational/tool instruction after that sentence.
  if (!BUNDLED_IDENTITY_SENTENCE.test(instructions)) return instructions;
  return instructions.replace(BUNDLED_IDENTITY_SENTENCE,
    (_match, lead) => `${lead}${NEUTRAL_IDENTITY_INSTRUCTION}`);
}

// The neutral sentence with the selected model named in it: "You are
// Homeroom's repository coding agent, running on <display name> (<slug>)
// through OpenRouter." — the slug alone when the display name is missing or
// is the slug. The display name comes from OpenRouter's catalog, so it is
// collapsed to one line and capped before it enters the prompt.
function selectedModelIdentity(modelId, displayName) {
  const slug = String(modelId || '').trim();
  const name = String(displayName || '').replace(/\s+/g, ' ').trim()
    .slice(0, MAX_MODEL_NAME_LENGTH);
  const label = name && name.toLowerCase() !== slug.toLowerCase()
    ? `${name} (${slug})`
    : slug;
  return `${NEUTRAL_IDENTITY_INSTRUCTION.replace(/\.$/, '')}, running on ${label} through OpenRouter.`;
}

// Name the selected model in `instructions` (#2120): the leading identity
// sentence becomes the model-naming form, and when no identity sentence leads
// the text the line is prepended, so the model is never left without one.
// GLM-5.3-Flash sessions used to answer "GPT-5" because the bundled sentence
// said so; the neutral sentence alone leaves the model guessing.
function nameSelectedModel(instructions, { modelId, displayName } = {}) {
  const text = String(instructions || '');
  const identity = selectedModelIdentity(modelId, displayName);
  if (LEADING_IDENTITY_SENTENCE.test(text)) {
    return text.replace(LEADING_IDENTITY_SENTENCE, (_match, lead) => `${lead}${identity}`);
  }
  return text.trim() ? `${identity}\n\n${text}` : identity;
}

function loadBundledBaseInstructions(catalogPath) {
  if (!catalogPath) return DEFAULT_BASE_INSTRUCTIONS;
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const source = Array.isArray(parsed?.models)
      ? parsed.models.find((model) => typeof model?.base_instructions === 'string'
        && model.base_instructions.trim())
      : null;
    return neutralizeBundledBaseInstructions(source?.base_instructions);
  } catch {
    return DEFAULT_BASE_INSTRUCTIONS;
  }
}

function buildCodexModelCatalog({
  modelId,
  displayName,
  contextWindow,
  supportsReasoning,
  reasoningEfforts,
  selectedReasoningEffort,
  baseInstructions,
}) {
  const slug = String(modelId || '').trim();
  if (!slug) throw new Error('modelId is required');

  const reasoningSupport = parseOptionalBoolean(supportsReasoning);
  const selectedEffort = REASONING_EFFORTS.includes(selectedReasoningEffort)
    ? selectedReasoningEffort
    : null;
  let supportedEfforts = safeReasoningEfforts(reasoningEfforts);
  if (reasoningSupport === false) {
    supportedEfforts = [];
  } else if (!supportedEfforts.length) {
    // OpenRouter normally exposes reasoning as a boolean capability rather
    // than an effort list. Its normalized effort API accepts this standard
    // set, which is also exactly the set the Homeroom UI permits.
    supportedEfforts = [...REASONING_EFFORTS];
  }
  if (reasoningSupport !== false && selectedEffort && !supportedEfforts.includes(selectedEffort)) {
    supportedEfforts.push(selectedEffort);
  }

  const resolvedContextWindow = optionalPositiveInteger(contextWindow)
    || DEFAULT_CONTEXT_WINDOW;
  const resolvedName = String(displayName || slug).trim().slice(0, 300) || slug;
  const instructions = nameSelectedModel(
    neutralizeBundledBaseInstructions(baseInstructions),
    { modelId: slug, displayName: resolvedName },
  );
  const defaultReasoningLevel = supportedEfforts.length
    ? (selectedEffort || (supportedEfforts.includes('medium') ? 'medium' : supportedEfforts[0]))
    : null;

  return {
    models: [{
      slug,
      display_name: resolvedName,
      description: 'OpenRouter model selected for this Homeroom session.',
      default_reasoning_level: defaultReasoningLevel,
      supported_reasoning_levels: supportedEfforts.map((effort) => ({
        effort,
        description: REASONING_DESCRIPTIONS[effort],
      })),
      shell_type: 'shell_command',
      visibility: 'hide',
      supported_in_api: true,
      priority: 1,
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      availability_nux: null,
      upgrade: null,
      base_instructions: instructions,
      model_messages: null,
      include_skills_usage_instructions: false,
      supports_reasoning_summary_parameter: false,
      default_reasoning_summary: 'none',
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: 'text',
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      supports_parallel_tool_calls: false,
      supports_image_detail_original: false,
      context_window: resolvedContextWindow,
      max_context_window: resolvedContextWindow,
      auto_compact_token_limit: null,
      comp_hash: null,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ['text'],
      supports_search_tool: false,
      use_responses_lite: false,
      auto_review_model_override: null,
      tool_mode: null,
      multi_agent_version: null,
    }],
  };
}

function buildCatalogFromEnvironment(env = process.env) {
  const bundledCatalogPath = env.CODEX_BUNDLED_MODELS_PATH
    || '/usr/local/share/usernode-codex-bundled-models.json';
  return buildCodexModelCatalog({
    modelId: env.AGENT_MODEL,
    displayName: env.AGENT_MODEL_NAME,
    contextWindow: env.AGENT_MODEL_CONTEXT_WINDOW,
    supportsReasoning: env.AGENT_MODEL_SUPPORTS_REASONING,
    reasoningEfforts: env.AGENT_MODEL_REASONING_EFFORTS,
    selectedReasoningEffort: env.AGENT_REASONING_EFFORT,
    baseInstructions: loadBundledBaseInstructions(bundledCatalogPath),
  });
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(buildCatalogFromEnvironment())}\n`);
  } catch (err) {
    process.stderr.write(`Could not build OpenRouter model metadata: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_BASE_INSTRUCTIONS,
  DEFAULT_CONTEXT_WINDOW,
  NEUTRAL_IDENTITY_INSTRUCTION,
  buildCodexModelCatalog,
  buildCatalogFromEnvironment,
  loadBundledBaseInstructions,
  nameSelectedModel,
  neutralizeBundledBaseInstructions,
};
