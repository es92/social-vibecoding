'use strict';

// Browser contract for the session-pinned Claude/Codex selector. The dialog
// itself is DOM-heavy, so these tests exercise the two consequential seams:
// createSession must send the user's explicit choice, and an existing-session
// change must go through reset-agent-context and update the pinned row.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8',
);
const { SW_VERSION } = require('../public/sw.js');

function makeHarness() {
  const requests = [];
  const toasts = [];
  const improveCreates = [];
  let responder = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: {},
    hidden: false,
    visibilityState: 'visible',
  };
  const sandbox = {
    console,
    document,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { sendBeacon: () => true },
    EventSource: class { close() {} },
    URL,
    Blob: class {},
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    fetch: async (url, options = {}) => {
      // Ignore the fire-and-forget model-catalog read at module load.
      if (url === '/api/models') return { ok: false, json: async () => ({}) };
      requests.push({ url, options });
      return responder(url, options);
    },
    escapeHtml: (value) => String(value ?? ''),
    PlatformUI: { toast: (message) => toasts.push(message) },
    Improve: {
      onSessionCreated: (session, appSlug) => improveCreates.push({ session, appSlug }),
    },
    App: {
      currentTab: 'dev',
      currentSubTab: 'sessions',
      user: { openrouterAvailable: false },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  return {
    DevChat: sandbox.__DevChat,
    requests,
    toasts,
    improveCreates,
    app: sandbox.App,
    respondWith(fn) { responder = fn; },
  };
}

test('OpenRouter model labels show exact rates, cost tier, and advisory compatibility', () => {
  const h = makeHarness();
  const label = h.DevChat._openRouterModelOptionLabel({
    id: 'vendor/model',
    name: 'Model',
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 4,
    costTier: 'medium',
    compatibility: 'experimental',
  });
  assert.equal(label, 'Model: Medium cost · $0.25 /M input · $4 /M output · unverified');

  const limited = h.DevChat._openRouterModelOptionLabel({
    id: 'vendor/limited',
    inputPricePerMillion: 100,
    outputPricePerMillion: null,
    costTier: 'unknown',
    compatibility: 'blocked',
  });
  assert.equal(limited, 'vendor/limited: Price unavailable · $100 /M input · ? /M output · limited');
});

test('OpenRouter picker labels and ordering surface favorites, recommendations, and new models', () => {
  const h = makeHarness();
  const models = [
    { id: 'vendor/ordinary', name: 'Ordinary', isFavorite: false, isRecommended: false },
    { id: 'openai/recommended', name: 'Recommended GPT', provider: 'openai', isRecommended: true },
    { id: 'deepseek/favorite', name: 'Favorite DeepSeek', provider: 'deepseek', isFavorite: true },
  ];
  assert.deepEqual(
    h.DevChat._openRouterModelsForPicker(models).map((model) => model.id),
    ['deepseek/favorite', 'openai/recommended', 'vendor/ordinary'],
  );
  assert.deepEqual(
    h.DevChat._openRouterModelsForPicker(models, { query: 'deepseek' }).map((model) => model.id),
    ['deepseek/favorite'],
  );
  assert.deepEqual(
    h.DevChat._openRouterModelsForPicker(models, { favoritesOnly: true }).map((model) => model.id),
    ['deepseek/favorite'],
  );
  const label = h.DevChat._openRouterModelOptionLabel({
    ...models[1], createdAt: new Date().toISOString(), costTier: 'low', compatibility: 'experimental',
  });
  assert.match(label, /Recommended GPT · Recommended · New:/);
});

test('an OpenRouter task opens on favorites without replacing an uncommon current model', () => {
  const h = makeHarness();
  const models = [
    { id: 'deepseek/default', isFavorite: true },
    { id: 'openai/default', isFavorite: true },
    { id: 'vendor/uncommon', isFavorite: false },
  ];
  assert.equal(
    h.DevChat._openRouterFavoritesOnlyByDefault(models, 'deepseek/default'),
    true,
    'a recommended/default favorite gets the short task list',
  );
  assert.equal(
    h.DevChat._openRouterFavoritesOnlyByDefault(models, 'vendor/uncommon'),
    false,
    'opening the picker preserves a current non-favorite selection',
  );
  assert.equal(h.DevChat._openRouterFavoritesOnlyByDefault(models, 'missing'), false);
  assert.match(SRC, /id="dc-agent-choice-model-search"/);
  assert.match(SRC, /id="dc-agent-choice-favorites-only"/);
  assert.match(SRC, /Platform recommendations start in Favorites/);
});

test('the task-time picker ships through a fresh shell cache', () => {
  const version = Number(String(SW_VERSION).replace(/^v/, ''));
  assert.ok(version >= 11, `expected a post-v10 shell cache, got ${SW_VERSION}`);
});

test('forced catalog refresh and favorite writes bypass browser caches', async () => {
  const h = makeHarness();
  h.respondWith(async (url) => {
    if (url === '/api/me/coding-agent') {
      return { ok: true, json: async () => ({ defaultBackend: 'codex_openrouter', backends: {}, codexAvailable: true }) };
    }
    if (url === '/api/me/credentials/openrouter') {
      return { ok: true, json: async () => ({ configured: true, status: 'valid' }) };
    }
    return {
      ok: true,
      json: async () => ({
        models: [{ id: 'deepseek/deepseek-v4.1-flash' }],
        recommendedModelId: 'deepseek/deepseek-v4.1-flash',
        refreshedAt: '2026-09-10T12:00:00.000Z',
        totalModels: 1,
      }),
    };
  });

  const catalog = await h.DevChat._loadCodingAgentChoiceData({ forceRefresh: true });
  assert.equal(catalog.catalogLoaded, true);
  assert.equal(catalog.models.length, 1);
  const catalogRequest = h.requests.find((request) => request.url.includes('/models?'));
  assert.match(catalogRequest.url, /refresh=1/);
  assert.equal(catalogRequest.options.cache, 'no-store');

  await h.DevChat._setOpenRouterModelFavorite('deepseek/deepseek-v4.1-flash', true);
  const favoriteRequest = h.requests.at(-1);
  assert.equal(favoriteRequest.url, '/api/me/coding-agent/models/favorite');
  assert.equal(favoriteRequest.options.method, 'PATCH');
  assert.equal(favoriteRequest.options.cache, 'no-store');
  assert.deepEqual(JSON.parse(favoriteRequest.options.body), {
    modelId: 'deepseek/deepseek-v4.1-flash', favorite: true,
  });
});

test('the first real build action provisions OpenRouter and reloads the saved default', async () => {
  const h = makeHarness();
  let preferenceReads = 0;
  h.respondWith(async (url, options) => {
    if (url === '/api/me/coding-agent') {
      preferenceReads += 1;
      return {
        ok: true,
        json: async () => preferenceReads === 1
          ? { defaultBackend: 'claude_code', backends: {}, codexAvailable: true }
          : {
            defaultBackend: 'codex_openrouter',
            backends: {
              codex_openrouter: {
                model: 'z-ai/glm-5.3-flash', reasoningEffort: null, isDefault: true,
              },
            },
            codexAvailable: true,
          },
      };
    }
    if (url === '/api/me/credentials/openrouter') {
      return {
        ok: true,
        json: async () => ({ configured: false, status: null }),
      };
    }
    if (url === '/api/me/credentials/openrouter/managed') {
      assert.equal(options.method, 'POST');
      assert.equal(options.cache, 'no-store');
      assert.deepEqual(JSON.parse(options.body), {});
      return {
        ok: true,
        status: 201,
        json: async () => ({ ok: true, defaultModel: 'z-ai/glm-5.3-flash' }),
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const prefs = await h.DevChat._prepareDefaultCodingAgentForBuild();
  assert.equal(prefs.defaultBackend, 'codex_openrouter');
  assert.equal(preferenceReads, 2, 'the post-provision default is read back');
  assert.equal(h.app.user.openrouterAvailable, true,
    'venue availability updates without a page reload');
  assert.deepEqual(h.requests.map((request) => request.url), [
    '/api/me/coding-agent',
    '/api/me/credentials/openrouter',
    '/api/me/credentials/openrouter/managed',
    '/api/me/coding-agent',
  ]);
});

test('an explicit Claude default never provisions an OpenRouter key', async () => {
  const h = makeHarness();
  h.respondWith(async (url) => {
    assert.equal(url, '/api/me/coding-agent');
    return {
      ok: true,
      json: async () => ({
        defaultBackend: 'claude_code',
        backends: { claude_code: { model: null, reasoningEffort: null, isDefault: true } },
        codexAvailable: true,
      }),
    };
  });

  const prefs = await h.DevChat._prepareDefaultCodingAgentForBuild();
  assert.equal(prefs.defaultBackend, 'claude_code');
  assert.deepEqual(h.requests.map((request) => request.url), ['/api/me/coding-agent']);
});

test('managed provisioning errors stay actionable instead of falling back to Claude', async () => {
  const h = makeHarness();
  h.respondWith(async (url) => {
    if (url === '/api/me/coding-agent') {
      return {
        ok: true,
        json: async () => ({ defaultBackend: 'claude_code', backends: {}, codexAvailable: true }),
      };
    }
    if (url === '/api/me/credentials/openrouter') {
      return { ok: true, json: async () => ({ configured: false, status: null }) };
    }
    if (url === '/api/me/credentials/openrouter/managed') {
      return {
        ok: false,
        status: 503,
        json: async () => ({
          code: 'not_configured',
          error: 'Company OpenRouter keys are not configured yet. Ask an administrator to check USERNODE_OPENROUTER_MANAGEMENT_API_KEY.',
        }),
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  await assert.rejects(
    () => h.DevChat._prepareDefaultCodingAgentForBuild(),
    (err) => err.code === 'not_configured'
      && /USERNODE_OPENROUTER_MANAGEMENT_API_KEY/.test(err.message),
  );
  assert.equal(h.app.user.openrouterAvailable, false);
});

test('a concurrent first-use claim accepts the valid key created by the other request', async () => {
  const h = makeHarness();
  let preferenceReads = 0;
  let statusReads = 0;
  h.respondWith(async (url) => {
    if (url === '/api/me/coding-agent') {
      preferenceReads += 1;
      return {
        ok: true,
        json: async () => preferenceReads === 1
          ? { defaultBackend: 'claude_code', backends: {}, codexAvailable: true }
          : { defaultBackend: 'codex_openrouter', backends: {}, codexAvailable: true },
      };
    }
    if (url === '/api/me/credentials/openrouter') {
      statusReads += 1;
      return {
        ok: true,
        json: async () => statusReads === 1
          ? { configured: false, status: null }
          : { configured: true, status: 'valid' },
      };
    }
    if (url === '/api/me/credentials/openrouter/managed') {
      return {
        ok: false,
        status: 409,
        json: async () => ({ code: 'byok_configured', error: 'A key now exists.' }),
      };
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const prefs = await h.DevChat._prepareDefaultCodingAgentForBuild();
  assert.equal(prefs.defaultBackend, 'codex_openrouter');
  assert.equal(statusReads, 2);
  assert.equal(h.app.user.openrouterAvailable, true);
});

test('new session creation sends the explicit Claude choice', async () => {
  const h = makeHarness();
  h.respondWith(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ session: { id: 41, agent_backend: 'claude_code' } }),
  }));

  const session = await h.DevChat.createSession('demo', undefined, {
    backend: 'claude_code', model: null, reasoningEffort: null,
  });

  assert.equal(session.id, 41);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/apps/demo/sessions');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), {
    backend: 'claude_code', model: null, reasoningEffort: null,
  });
});

test('new session creation sends the exact Codex model and effort with the issue link', async () => {
  const h = makeHarness();
  h.respondWith(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ session: { id: 42, agent_backend: 'codex_openrouter' } }),
  }));

  await h.DevChat.createSession('demo', 287, {
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  });

  assert.deepEqual(JSON.parse(h.requests[0].options.body), {
    issueNumber: 287,
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  });
});

test('creation asks nothing and sends no backend key', async () => {
  // Creating a session used to open the agent chooser first, so a modal
  // stood between "Propose a change" and a chat — and cancelling it left
  // nothing behind. It asks nothing now: the session is created with the
  // server's own default and the venue line above the composer says which
  // one that was.
  //
  // The three keys must be ABSENT rather than null. A `backend: null` is
  // still an explicit choice in the request body, and the server would
  // have to decide what a null choice means; omitting them leaves the
  // default exactly where it already lives.
  const h = makeHarness();
  let chooserOpened = false;
  h.DevChat._chooseCodingAgent = async () => { chooserOpened = true; return null; };
  h.respondWith(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ session: { id: 43, agent_backend: 'claude_code' } }),
  }));

  const session = await h.DevChat.createSession('demo');

  assert.equal(chooserOpened, false, 'no chooser is opened at creation time');
  assert.equal(session.id, 43);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.requests[0].options.body), {});
});

test('successful creation publishes the new row to Improve immediately', async () => {
  const h = makeHarness();
  const created = {
    id: 44,
    status: 'active',
    created_at: '2026-09-04T10:00:00.000Z',
  };
  h.respondWith(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ session: created }),
  }));

  await h.DevChat.createSession('demo');

  assert.equal(h.improveCreates.length, 1);
  assert.equal(h.improveCreates[0].session, created,
    'the successful server row, not a guessed client copy, is published');
  assert.equal(h.improveCreates[0].appSlug, 'demo',
    'the app slug fills the field RETURNING * does not carry');
});

test('switching an idle session uses reset-agent-context and updates its pinned backend', async () => {
  const h = makeHarness();
  const current = {
    id: 51,
    agent_backend: 'claude_code',
    agent_model: null,
    agent_reasoning_effort: null,
  };
  h.DevChat.currentSession = current;
  h.DevChat.sessions = [current];
  h.DevChat.messages = [];
  h.DevChat.renderChatView = () => {};
  h.DevChat._chooseCodingAgent = async () => ({
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'medium',
  });
  h.respondWith(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      session: {
        id: 51,
        agent_backend: 'codex_openrouter',
        agent_model: 'openai/gpt-5.3-codex',
        agent_reasoning_effort: 'medium',
      },
      message: { id: 99, role: 'system', content: 'Coding agent switched.' },
    }),
  }));

  await h.DevChat._switchCurrentCodingAgent();

  assert.equal(h.requests[0].url, '/api/sessions/51/reset-agent-context');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), {
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'medium',
  });
  assert.equal(h.DevChat.currentSession.agent_backend, 'codex_openrouter');
  assert.equal(h.DevChat.messages.at(-1).content, 'Coding agent switched.');
});

test('changing an OpenRouter model asks for an OpenRouter-only choice', async () => {
  const h = makeHarness();
  h.DevChat.currentSession = {
    id: 52,
    agent_backend: 'codex_openrouter',
    agent_model: 'deepseek/deepseek-v4-flash',
    agent_reasoning_effort: null,
  };
  let chooserArgs = null;
  h.DevChat._chooseCodingAgent = async (args) => {
    chooserArgs = args;
    return null;
  };

  await h.DevChat._switchCurrentCodingAgent(null, {
    fixedBackend: 'codex_openrouter',
  });

  assert.ok(chooserArgs, 'the model chooser did not open');
  assert.equal(chooserArgs.mode, 'switch');
  assert.equal(chooserArgs.fixedBackend, 'codex_openrouter');
  assert.equal(chooserArgs.current.backend, 'codex_openrouter');
  assert.equal(chooserArgs.current.model, 'deepseek/deepseek-v4-flash');
  assert.equal(h.requests.length, 0, 'cancelling the chooser must not reset the session');
});

test('live progress keeps the exact runtime provider identity', () => {
  const h = makeHarness();
  h.DevChat.messages = [];
  h.DevChat._appendProgressLine('Reading the repository', {
    agentBackend: 'codex_openrouter',
    agentModel: 'openai/gpt-5.3-codex',
  });

  const progress = h.DevChat.messages.at(-1);
  assert.equal(progress.agentBackend, 'codex_openrouter');
  assert.equal(progress.agentModel, 'openai/gpt-5.3-codex');
  assert.equal(h.DevChat._activityAgentName(progress), 'OpenRouter');
  assert.equal(h.DevChat._activityAgentName({}), 'Claude Code');
});
