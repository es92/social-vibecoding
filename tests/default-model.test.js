'use strict';

// The platform default OpenRouter model as an admin setting
// (services/default-model.js), edited from Admin → Homeroom bot → Settings
// → Models and applied with no deploy.
//
// What this pins:
//   1. The resolver: the admin's setting wins, blank or unreadable is the
//      deploy's OPENROUTER_DEFAULT_CODEX_MODEL, and a save is seen at once.
//   2. The bot's settings carry it: the patch accepts an id or blank, the
//      save refuses a model the stored catalog does not list or that cannot
//      call tools, and a stage left on the default follows it.
//   3. A coding-agent preference with no model follows it
//      (routes/sessions.js resolveDefaultAgentPreference).
//   4. The one-time migration moves only untouched GLM preferences, once.
//   5. The console's form sends it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const defaultModel = require('../src/services/default-model');
const bot = require('../src/services/homeroom-bot');

const DEPLOY = { openrouterDefaultCodexModel: 'deepseek/deepseek-v4.1-flash-1017' };

function settingsPool({ value = null, fail = false, catalog = null } = {}) {
  const calls = [];
  const state = { value };
  return {
    calls,
    state,
    async query(sql, params) {
      const s = String(sql);
      calls.push({ s, params });
      if (fail) throw new Error('relation "platform_settings" does not exist');
      if (/FROM openrouter_model_catalog/.test(s)) return { rows: catalog ? [{ models: catalog }] : [] };
      if (/INSERT INTO platform_settings/.test(s)) {
        if (params[0] === defaultModel.KEY) state.value = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/FROM platform_settings/.test(s)) return { rows: state.value == null ? [] : [{ value: state.value }] };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('the admin setting wins; blank, malformed or unreadable is the deploy default', async () => {
  assert.equal(await defaultModel.effective(settingsPool({ value: 'z-ai/glm-5.3-flash' }), DEPLOY), 'z-ai/glm-5.3-flash');
  assert.equal(await defaultModel.effective(settingsPool(), DEPLOY), DEPLOY.openrouterDefaultCodexModel);
  assert.equal(await defaultModel.effective(settingsPool({ value: '' }), DEPLOY), DEPLOY.openrouterDefaultCodexModel);
  assert.equal(await defaultModel.effective(settingsPool({ value: 'not a model' }), DEPLOY), DEPLOY.openrouterDefaultCodexModel);
  assert.equal(await defaultModel.effective(settingsPool({ fail: true }), DEPLOY), DEPLOY.openrouterDefaultCodexModel,
    'a read failure keeps a model rather than none');
  assert.equal(await defaultModel.effective(null, DEPLOY), DEPLOY.openrouterDefaultCodexModel);
  assert.equal(await defaultModel.effective(settingsPool(), {}), null);
  assert.equal(defaultModel.fromSettings({ defaultModel: 'z-ai/glm-5.3-flash' }, DEPLOY), 'z-ai/glm-5.3-flash');
  assert.equal(defaultModel.fromSettings({ defaultModel: '' }, DEPLOY), DEPLOY.openrouterDefaultCodexModel);
});

test('the setting is read once per cache window, and invalidate makes a save seen at once', async () => {
  const pool = settingsPool({ value: 'z-ai/glm-5.3-flash' });
  await defaultModel.effective(pool, DEPLOY);
  await defaultModel.effective(pool, DEPLOY);
  assert.equal(pool.calls.length, 1, 'cached for CACHE_TTL_MS');
  pool.state.value = 'vendor/other';
  assert.equal(await defaultModel.effective(pool, DEPLOY), 'z-ai/glm-5.3-flash', 'still the cached answer');
  defaultModel.invalidate(pool);
  assert.equal(await defaultModel.effective(pool, DEPLOY), 'vendor/other');
});

test('the bot settings carry the default: parsed, patched, and what a stage on the default runs on', () => {
  const s = bot.parseSettings([
    { key: bot.KEY_DEFAULT_MODEL, value: 'z-ai/glm-5.3-flash' },
    { key: bot.KEY_MODELS.build, value: 'anthropic/claude-opus-5.5' },
  ]);
  assert.equal(s.defaultModel, 'z-ai/glm-5.3-flash');
  assert.equal(bot.stageModel(s, DEPLOY, 'triage'), 'z-ai/glm-5.3-flash', 'a stage on the default follows the admin\'s');
  assert.equal(bot.stageModel(s, DEPLOY, 'build'), 'anthropic/claude-opus-5.5', 'a stage\'s own model stays its own');
  assert.equal(bot.stageModel(bot.parseSettings([]), DEPLOY, 'triage'), DEPLOY.openrouterDefaultCodexModel);
  assert.equal(bot.parseSettings([{ key: bot.KEY_DEFAULT_MODEL, value: 'oops' }]).defaultModel, '');

  assert.deepEqual(bot.validateSettingsPatch({ defaultModel: 'z-ai/glm-5.3-flash' }).updates, [[bot.KEY_DEFAULT_MODEL, 'z-ai/glm-5.3-flash']]);
  assert.deepEqual(bot.validateSettingsPatch({ defaultModel: '' }).updates, [[bot.KEY_DEFAULT_MODEL, '']], 'blank is the deploy default');
  assert.deepEqual(bot.validateSettingsPatch({ defaultModel: null }).updates, [[bot.KEY_DEFAULT_MODEL, '']]);
  assert.match(bot.validateSettingsPatch({ defaultModel: 'gpt; rm -rf' }).error, /OpenRouter model id/);
});

test('readSettings reads the default with the bot\'s other settings', async () => {
  let keys = null;
  const settings = await bot.readSettings({
    async query(sql, params) {
      keys = params[0];
      return { rows: [{ key: bot.KEY_DEFAULT_MODEL, value: 'z-ai/glm-5.3-flash' }] };
    },
  });
  assert.ok(keys.includes(bot.KEY_DEFAULT_MODEL));
  assert.equal(settings.defaultModel, 'z-ai/glm-5.3-flash');
  assert.equal(bot.platformDefaultModel(settings, DEPLOY), 'z-ai/glm-5.3-flash');
});

test('a save is checked against the stored catalog, and every reader sees it at once', async () => {
  const catalog = [
    { id: 'z-ai/glm-5.3-flash', supported_parameters: ['tools', 'reasoning'] },
    { id: 'vendor/no-tools', supported_parameters: ['temperature'] },
  ];
  const pool = settingsPool({ catalog });
  assert.equal(await defaultModel.effective(pool, DEPLOY), DEPLOY.openrouterDefaultCodexModel);

  const missing = await bot.writeSettings(pool, { defaultModel: 'vendor/not-listed' }, 1, DEPLOY);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Not in the OpenRouter catalog: vendor\/not-listed/);
  const noTools = await bot.writeSettings(pool, { defaultModel: 'vendor/no-tools' }, 1, DEPLOY);
  assert.match(noTools.error, /cannot call tools/);
  const noCatalog = await bot.writeSettings(settingsPool(), { defaultModel: 'z-ai/glm-5.3-flash' }, 1, DEPLOY);
  assert.match(noCatalog.error, /catalog is not available/);
  assert.equal(pool.calls.filter((c) => /INSERT INTO platform_settings/.test(c.s)).length, 0, 'a refused save writes nothing');

  assert.deepEqual(await bot.writeSettings(pool, { defaultModel: 'z-ai/glm-5.3-flash' }, 1, DEPLOY), { ok: true });
  assert.equal(await defaultModel.effective(pool, DEPLOY), 'z-ai/glm-5.3-flash', 'this server follows the save at once');
  assert.deepEqual(await bot.writeSettings(pool, { defaultModel: '' }, 1, DEPLOY), { ok: true }, 'blank needs no catalog');
  assert.equal(await defaultModel.effective(pool, DEPLOY), DEPLOY.openrouterDefaultCodexModel);
});

test('the bot\'s other readers of the default go through the resolver', () => {
  const root = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  // Each of these read config.openrouterDefaultCodexModel directly, which
  // an admin's choice never reached.
  for (const file of [
    'src/services/homeroom-bot-voice.js', 'src/services/homeroom-bot-mayor.js', 'src/services/agent-turn.js',
    'src/services/openrouter-mayor.js', 'src/routes/credentials.js',
    'src/services/openrouter-managed-keys.js', 'src/services/agent-models.js',
  ]) {
    assert.match(read(file), /default-model/, `${file} reads the platform default through services/default-model.js`);
  }
  const botSrc = read('src/services/homeroom-bot.js');
  assert.doesNotMatch(botSrc.replace(/\/\/.*$/gm, ''), /config\.openrouterDefaultCodexModel/,
    'the bot reads the default through platformDefaultModel or the resolver');
});

// ── A preference with no model follows the default ──────────────────────

function sessionsHarness({ pref, setting = null }) {
  const credentialStore = require('../src/services/credential-store');
  const agentModels = require('../src/services/agent-models');
  const managed = require('../src/services/openrouter-managed-keys');
  const saved = {
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    listOpenRouterModels: agentModels.listOpenRouterModels,
    provision: managed.provision,
  };
  const asked = [];
  credentialStore.readMetadata = async () => ({ status: 'valid', revision: 3 });
  credentialStore.readSecret = async () => 'sk-or-v1-test';
  agentModels.listOpenRouterModels = async (args) => { asked.push(args); return { recommendedModelId: 'z-ai/glm-5.3-flash' }; };
  managed.provision = async () => { throw new Error('must not provision'); };
  const client = {
    async query(sql) {
      const s = String(sql);
      if (/FROM user_agent_preferences/.test(s)) return { rows: pref ? [pref] : [] };
      if (/FROM platform_settings/.test(s)) return { rows: setting ? [{ value: setting }] : [] };
      return { rows: [] };
    },
  };
  return {
    client,
    asked,
    restore() {
      credentialStore.readMetadata = saved.readMetadata;
      credentialStore.readSecret = saved.readSecret;
      agentModels.listOpenRouterModels = saved.listOpenRouterModels;
      managed.provision = saved.provision;
    },
  };
}

test('a preference with no model runs on the platform default, the admin\'s when one is stored', async (t) => {
  const { resolveDefaultAgentPreference: resolve } = require('../src/routes/sessions');
  const config = { ...DEPLOY, codexOpenrouterEnabled: true, dataEncryptionKey: 'k' };

  const follows = sessionsHarness({ pref: { backend: 'codex_openrouter', model_id: null, reasoning_effort: null }, setting: 'z-ai/glm-5.3-flash' });
  t.after(() => follows.restore());
  const chosen = await resolve(follows.client, 7, config);
  follows.restore();
  assert.equal(chosen.backend, 'codex_openrouter');
  assert.equal(chosen.model, 'z-ai/glm-5.3-flash', 'the admin\'s default, already checked against the catalog when saved');
  assert.equal(follows.asked.length, 0);

  const unset = sessionsHarness({ pref: { backend: 'codex_openrouter', model_id: null, reasoning_effort: null } });
  t.after(() => unset.restore());
  assert.equal((await resolve(unset.client, 7, config)).model, DEPLOY.openrouterDefaultCodexModel, 'else the deploy\'s');
  unset.restore();

  const picked = sessionsHarness({ pref: { backend: 'codex_openrouter', model_id: 'vendor/picked', reasoning_effort: 'low' }, setting: 'z-ai/glm-5.3-flash' });
  t.after(() => picked.restore());
  const own = await resolve(picked.client, 7, config);
  picked.restore();
  assert.equal(own.model, 'vendor/picked', 'a model the person picked stays theirs');
});

// ── The one-time migration ──────────────────────────────────────────────

function migrationPool({ markerRows = [], rowCount = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/SELECT 1 FROM platform_settings/.test(String(sql))) return { rows: markerRows };
      return { rows: [], rowCount };
    },
  };
}

test('the migration moves untouched GLM preferences to the default once, and records that it ran', async () => {
  const { followPlatformDefaultModel } = require('../src/db/migrate');
  const pool = migrationPool({ rowCount: 4 });
  await followPlatformDefaultModel(pool);
  const update = pool.calls.find((c) => /^\s*UPDATE user_agent_preferences/.test(c.sql));
  assert.ok(update, 'it updates the preferences');
  assert.match(update.sql, /SET model_id = NULL/);
  assert.match(update.sql, /backend = 'codex_openrouter'/);
  assert.match(update.sql, /updated_at <= created_at \+ INTERVAL '1 minute'/, 'only rows nobody saved since');
  assert.deepEqual(update.params, ['z-ai/glm-5.3-flash'], 'only the former default');
  assert.ok(pool.calls.some((c) => /INSERT INTO platform_settings/.test(c.sql)
    && /agent_preferences_follow_default_migrated/.test(c.sql)), 'the marker is written');

  const again = migrationPool({ markerRows: [{}] });
  await followPlatformDefaultModel(again);
  assert.equal(again.calls.length, 1, 'with the marker present it only reads the marker');
});

// ── The console ─────────────────────────────────────────────────────────

test('the Models card has a platform default picker, and Save sends it', () => {
  const tsx = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/admin/admin-homeroom-bot.tsx'), 'utf8');
  assert.match(tsx, /stage="default" label="Platform default"/);
  assert.match(tsx, /blankLabel="Deployment default"/);
  assert.match(tsx, /defaultModel=\{payload\?\.deploymentDefaultModel \|\| null\}/);
  assert.match(tsx, /onChange=\{\(id\) => setField\('defaultModel', id\)\}/);
  assert.match(tsx, /else if \(key === 'defaultModel'\) \{/);
  assert.match(tsx, /patch\.defaultModel = id;/);
  // A stage of a scope with no configuration current falls back to its
  // per-stage setting, else the platform default (Settings' read of the stages).
  assert.match(tsx, /fallback=\{\(stage\) => saved\.models\[stage\] \|\| payload\?\.defaultModel \|\| null\}/);
});

// ── What a current configuration runs ───────────────────────────────────

test('the admin payload names the current configurations\' models, which builds run on over the stage settings', async () => {
  const configs = require('../src/services/bot-configs');
  const saved = { currentVersion: configs.currentVersion, laterVersion: configs.laterVersion };
  configs.currentVersion = async () => ({
    id: 15, key: 'fv', label: 'FV', version: 1,
    recipe: { models: { triage: 'z-ai/glm-5.3-flash', spec: 'anthropic/claude-opus-5.5', build: 'deepseek/deepseek-v4.1-flash-1017' } },
  });
  configs.laterVersion = async () => ({
    id: 5, key: 'later', label: 'Later', version: 1,
    recipe: {
      models: { triage: 'deepseek/deepseek-v4.1-flash-1017', spec: 'anthropic/claude-opus-5.5', build: 'z-ai/glm-5.3-flash', followup: 'deepseek/deepseek-v4.1-flash-1017' },
      reviewer: null, pack: null, effort: { build: 'max' }, clocks: { build: 30 },
    },
  });
  const none = { triage: null, spec: null, build: null };
  try {
    assert.deepEqual(await bot.currentConfigurations({}), {
      firstVersion: {
        id: 15, key: 'fv', label: 'FV', version: 1,
        models: { triage: 'z-ai/glm-5.3-flash', spec: 'anthropic/claude-opus-5.5', build: 'deepseek/deepseek-v4.1-flash-1017' },
        effort: none, clocks: none,
      },
      // A later change's triage and follow-ups are its configuration's too.
      later: {
        id: 5, key: 'later', label: 'Later', version: 1,
        models: { triage: 'deepseek/deepseek-v4.1-flash-1017', spec: 'anthropic/claude-opus-5.5', build: 'z-ai/glm-5.3-flash', followup: 'deepseek/deepseek-v4.1-flash-1017' },
        effort: { ...none, build: 'max', followup: null }, clocks: { ...none, build: 30, followup: null },
      },
    });
    configs.currentVersion = async () => null;
    configs.laterVersion = async () => { throw new Error('boom'); };
    assert.deepEqual(await bot.currentConfigurations({}), { firstVersion: null, later: null }, 'none, or unreadable: the stage settings decide');
  } finally {
    configs.currentVersion = saved.currentVersion;
    configs.laterVersion = saved.laterVersion;
  }
  const connector = fs.readFileSync(path.join(__dirname, '..', 'src/services/bench/connector-data.js'), 'utf8');
  assert.match(connector, /configurations: p\.configurations \|\| null/, 'get_homeroom_bot carries them too');
});
