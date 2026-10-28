'use strict';

// #2600 — the default reasoning effort for an OpenRouter CODING turn.
//
// The platform now runs coding turns at 'xhigh', the top of its effort scale,
// for the models it recommends (GLM 5.3 Flash, DeepSeek v4.1 Flash) and for
// the OpenRouter coding default generally. These tests pin two things that
// are easy to break later:
//
//   1. the configured default itself, and that it is read from config rather
//      than hardcoded at the call site;
//   2. that a user's own choice in Settings still wins over it — raising a
//      default must never overwrite somebody's setting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const runtimeConfig = require('../src/config');
const agentTurn = require('../src/services/agent-turn');
const credentialStore = require('../src/services/credential-store');
const agentModels = require('../src/services/agent-models');

// ── The configured default ────────────────────────────────────────────

// Load src/config.js with the minimum required environment, the way
// tests/openrouter-managed-keys.test.js does.
function loadConfig(env = {}) {
  const keys = [
    'DATABASE_URL', 'SESSION_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD',
    'USERNODE_ENV', 'OPENROUTER_DEFAULT_CODEX_REASONING',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://localhost/test',
    SESSION_SECRET: 'test-session-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin-pass',
    USERNODE_ENV: 'staging',
  });
  delete process.env.OPENROUTER_DEFAULT_CODEX_REASONING;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const realLog = console.log;
  console.log = () => {};
  try {
    return runtimeConfig.load();
  } finally {
    console.log = realLog;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('the OpenRouter coding default is xhigh', () => {
  const config = loadConfig();
  assert.equal(config.openrouterDefaultCodexReasoning, 'xhigh');
});

test('an operator can configure the coding default', () => {
  const config = loadConfig({ OPENROUTER_DEFAULT_CODEX_REASONING: 'medium' });
  assert.equal(config.openrouterDefaultCodexReasoning, 'medium');
});

test('the coding default is validated against the platform effort scale', () => {
  const source = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
  // One scale for the platform, shared with the OpenRouter transport: a
  // second hardcoded list is how two vocabularies drift apart.
  assert.match(source, /REASONING_EFFORT_LEVELS\.has\(codexDefaultReasoningEffort\)/);
  assert.match(source, /require\('\.\/services\/reasoning-efforts'\)/);
  assert.match(fs.readFileSync(path.join(root, 'src/services/openrouter.js'), 'utf8'),
    /require\('\.\/reasoning-efforts'\)/);
});

// ── What a turn actually sends ────────────────────────────────────────

const BASE_CONFIG = Object.freeze({
  codexOpenrouterEnabled: true,
  openrouterApiBase: 'https://openrouter.ai/api/v1',
  dataEncryptionKey: 'test-key',
  openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash',
  openrouterDefaultCodexReasoning: 'xhigh',
});

// Stub the credential and pricing reads resolveCodexRuntimeContext performs,
// so the test is about effort resolution and nothing else.
function stubCatalog(t, catalogModel) {
  const originals = {
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    resolveModelPricing: agentModels.resolveModelPricing,
  };
  credentialStore.readMetadata = async () => ({ id: 4, status: 'valid', revision: 2 });
  credentialStore.readSecret = async () => 'sk-or-test';
  agentModels.resolveModelPricing = catalogModel instanceof Error
    ? async () => { throw catalogModel; }
    : async () => catalogModel;
  t.after(() => {
    credentialStore.readMetadata = originals.readMetadata;
    credentialStore.readSecret = originals.readSecret;
    agentModels.resolveModelPricing = originals.resolveModelPricing;
  });
}

function codingModel(overrides = {}) {
  return {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    contextLength: 200_000,
    maxOutputTokens: 64_000,
    supportsReasoning: true,
    reasoningEfforts: null,
    supportsTools: true,
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.3,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    id: 5,
    agent_backend: 'codex_openrouter',
    agent_model: 'z-ai/glm-5.3-flash',
    agent_reasoning_effort: null,
    agent_config_version: 1,
    ...overrides,
  };
}

const resolve = (args = {}) => agentTurn.resolveCodexRuntimeContext({
  pool: {}, userId: 3, config: BASE_CONFIG, session: session(), ...args,
});

for (const modelId of ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4.1-flash']) {
  test(`${modelId} runs at the platform default when the user has not chosen`, async (t) => {
    stubCatalog(t, codingModel({ id: modelId }));
    const ctx = await resolve({ session: session({ agent_model: modelId }) });
    assert.equal(ctx.agentModel, modelId);
    assert.equal(ctx.agentReasoningEffort, 'xhigh');
  });
}

test("a user's saved choice still wins over the platform default", async (t) => {
  stubCatalog(t, codingModel());
  const ctx = await resolve({ session: session({ agent_reasoning_effort: 'low' }) });
  assert.equal(ctx.agentReasoningEffort, 'low');
});

test("a turn's explicit effort wins over both the session and the default", async (t) => {
  stubCatalog(t, codingModel());
  const ctx = await resolve({
    session: session({ agent_reasoning_effort: 'low' }), reasoningEffort: 'medium',
  });
  assert.equal(ctx.agentReasoningEffort, 'medium');
});

test('a model that does not take a reasoning parameter is sent none', async (t) => {
  stubCatalog(t, codingModel({ supportsReasoning: false }));
  const ctx = await resolve();
  assert.equal(ctx.agentReasoningEffort, null,
    'raising the default must not start sending a parameter to a model that refuses it');
});

test('a model advertising its own efforts gets the strongest one it offers', async (t) => {
  stubCatalog(t, codingModel({ reasoningEfforts: ['low', 'high', 'medium'] }));
  const ctx = await resolve();
  assert.equal(ctx.agentReasoningEffort, 'high',
    'the platform default is clamped to a published list rather than sent unsupported');
  assert.deepEqual(ctx.agentModelMetadata.reasoningEfforts, ['low', 'high', 'medium']);
});

test('a model that does advertise xhigh gets xhigh', async (t) => {
  stubCatalog(t, codingModel({ reasoningEfforts: ['medium', 'high', 'xhigh'] }));
  assert.equal((await resolve()).agentReasoningEffort, 'xhigh');
});

test('an unavailable catalog still runs the turn at the platform default', async (t) => {
  stubCatalog(t, new Error('openrouter catalog unreachable'));
  const ctx = await resolve();
  assert.equal(ctx.agentReasoningEffort, 'xhigh');
  assert.equal(ctx.pricingSnapshot.available, false);
});

test('a deployment that configures no coding default sends no effort', async (t) => {
  stubCatalog(t, codingModel());
  const ctx = await agentTurn.resolveCodexRuntimeContext({
    pool: {}, userId: 3, session: session(),
    config: { ...BASE_CONFIG, openrouterDefaultCodexReasoning: null },
  });
  assert.equal(ctx.agentReasoningEffort, null);
});

// ── What Settings shows ───────────────────────────────────────────────

// The server is the only thing that knows the platform default, so the
// picker's first choice is labelled from /api/me/coding-agent.
function settingsHarness(codingAgentPayload) {
  const options = [
    { value: '', textContent: 'Default' },
    { value: 'xhigh', textContent: 'Extra high' },
  ];
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, {
        id, textContent: '', placeholder: '', value: '', disabled: false,
        options: id === 'settings-openrouter-reasoning' ? options : undefined,
        classList: {
          add: (...names) => names.forEach((name) => classes.add(name)),
          remove: (...names) => names.forEach((name) => classes.delete(name)),
          toggle: (name, force) => {
            const on = force === undefined ? !classes.has(name) : !!force;
            if (on) classes.add(name); else classes.delete(name);
            return on;
          },
          contains: (name) => classes.has(name),
        },
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    window: {},
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      // No model select, so _loadOpenRouterModels returns before it fetches.
      getElementById: (id) => (id === 'settings-openrouter-model' ? null : el(id)),
    },
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).startsWith('/api/me/coding-agent')
        ? codingAgentPayload
        : { configured: false, managedProvisioning: {} }),
    }),
    setTimeout, clearTimeout, setInterval, clearInterval, console,
    // settings.js reads its text through this global; the real English catalog.
    PlatformI18n: require('./lib/platform-i18n').englishPlatformI18n(),
  });
  context.window.window = context.window;
  context.window.document = context.document;
  vm.runInContext(
    fs.readFileSync(path.join(root, 'frontend/src/features/settings/settings.js'), 'utf8'),
    context,
  );
  return { Settings: context.window.Settings, options };
}

test('Settings names the level the platform runs at', async () => {
  const { Settings, options } = settingsHarness({
    codexAvailable: true, defaultReasoningEffort: 'xhigh', backends: {},
  });
  await Settings._refreshOpenRouter();
  assert.equal(options[0].textContent, 'Default (Extra high)');
});

test('Settings keeps the plain wording when the server names no default', async () => {
  const { Settings, options } = settingsHarness({
    codexAvailable: true, defaultReasoningEffort: null, backends: {},
  });
  await Settings._refreshOpenRouter();
  assert.equal(options[0].textContent, 'Default',
    'an unreadable default must not be invented in the picker');
});

// ── The cost note the admin screen owes an admin ──────────────────────

test('the admin Model costs paragraph says the estimates assume the default effort', () => {
  const source = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/admin-model-costs.tsx'), 'utf8',
  );
  assert.match(source, /assume a session running at the platform default reasoning effort/);
  // #2600 deliberately left the typical-change token constant alone: moving
  // it wants measured usage, not a guess made at the same time as this.
  const costs = fs.readFileSync(path.join(root, 'src/services/model-costs.js'), 'utf8');
  assert.match(costs, /inputTokens: 2_500_000/);
  assert.match(costs, /outputTokens: 120_000/);
});
