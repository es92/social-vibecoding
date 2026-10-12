'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const SETTINGS_SOURCE = fs.readFileSync(path.join(ROOT, 'frontend/src/features/settings/settings.js'), 'utf8');
// #1081 chunk D: the alerts pane's markup moved out of Shell.tsx into its own
// component. Same markup, same assertions — only the file changed.
const ALERTS_SOURCE = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/settings/sections/alerts.tsx'), 'utf8');

const CATEGORIES = [
  ['messages', 'Messages', true],
  ['direct_interactions', 'Direct interactions', true],
  ['invitations', 'Invitations', true],
  ['shared_work', 'Shared work', true],
  ['developer_sessions', 'Agent sessions', true],
  ['proposal_alerts', 'Change alerts', true],
  ['app_alerts', 'App alerts', true],
  ['lightweight_activity', 'Lightweight activity', false],
];

test('settings renders clear user-facing category labels and descriptions', () => {
  assert.match(SETTINGS_SOURCE,
    /\{ key: 'alerts', label: 'settings:nav\.part\.alerts', group: 'settings:nav\.group\.preferences' \}/,
    'the category controls are discoverable from the Settings navigation');
  assert.equal(message('settings:nav.part.alerts'), 'Notifications');
  assert.equal(message('settings:nav.group.preferences'), 'Preferences');
  const block = ALERTS_SOURCE.slice(
    ALERTS_SOURCE.indexOf('id="settings-mobile-push-preferences"')
  );
  assert.match(block, /title=\{t\('settings:alerts\.push\.title'\)\}/);
  assert.equal(message('settings:alerts.push.title'), 'Mobile push categories');
  assert.match(block, /\{t\('settings:alerts\.push\.intro'\)\}/);
  assert.match(message('settings:alerts.push.intro'), /Activity notifications switch remains the master control/);
  for (const [key, label] of CATEGORIES) {
    // The catalog key is the category's own, in camelCase.
    const id = `settings:alerts.push.${key.replace(/_(\w)/g, (_, c) => c.toUpperCase())}`;
    const row = block.slice(block.indexOf(`data-mobile-push-category="${key}"`));
    assert.match(block, new RegExp(`data-mobile-push-category="${key}"`));
    assert.ok(row.slice(0, 600).includes(`>{t('${id}.label')}<`), `${key}: its row shows its label`);
    assert.ok(row.slice(0, 600).includes(`>{t('${id}.description')}<`), `${key}: and its description`);
    assert.equal(message(`${id}.label`), label);
  }
  assert.match(message('settings:alerts.push.directInteractions.description'), /Mentions, replies to your messages, and friend requests/);
  assert.match(message('settings:alerts.push.messages.description'), /Conversation invitations, messages, mentions, replies, and reactions/);
  assert.match(message('settings:alerts.push.lightweightActivity.description'), /Reactions and kudos on your work/);
  assert.doesNotMatch(block, />\s*(mention|reply|stale_pr|check_failed|pr_proposed|spec_shared)\s*</,
    'internal notification identifiers never become visible labels');
});

function harness(saved) {
  const inputs = new Map();
  const rows = CATEGORIES.map(([key]) => {
    const input = { checked: false, disabled: true };
    inputs.set(key, input);
    return {
      dataset: { mobilePushCategory: key },
      querySelector: () => input,
    };
  });
  const status = { textContent: '', className: '' };
  const calls = [];
  const response = (preferences) => ({
    ok: true,
    status: 200,
    json: async () => ({
      preferences: CATEGORIES.map(([key, label, defaultEnabled]) => ({
        key,
        label,
        description: `${label} description`,
        defaultEnabled,
        enabled: preferences[key],
      })),
    }),
  });
  let serverState = { ...saved };
  const context = vm.createContext({
    PlatformI18n: englishPlatformI18n(),
    window: {},
    document: {
      addEventListener() {},
      querySelectorAll(selector) {
        return selector.includes('[data-mobile-push-category]') ? rows : [];
      },
      querySelector(selector) {
        return selector.includes('[data-mobile-push-status]') ? status : null;
      },
    },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === 'PATCH') {
        serverState = {
          ...serverState,
          ...JSON.parse(options.body).preferences,
        };
      }
      return response(serverState);
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  });
  context.window.window = context.window;
  context.window.document = context.document;
  vm.runInContext(SETTINGS_SOURCE, context);
  return { Settings: context.window.Settings, inputs, status, calls };
}

test('settings reflects saved state and persists a changed category', async () => {
  const saved = Object.fromEntries(CATEGORIES.map(([key, , defaultEnabled]) => (
    [key, defaultEnabled]
  )));
  saved.direct_interactions = false;
  saved.messages = false;
  saved.lightweight_activity = true;
  const { Settings, inputs, status, calls } = harness(saved);

  await Settings._loadMobilePushPreferences();
  assert.equal(inputs.get('direct_interactions').checked, false);
  assert.equal(inputs.get('messages').checked, false);
  assert.equal(inputs.get('lightweight_activity').checked, true);
  assert.ok([...inputs.values()].every((input) => input.disabled === false));
  assert.equal(status.textContent, 'Saved to your account.');

  await Settings._saveMobilePushPreference('direct_interactions', true);
  assert.equal(inputs.get('direct_interactions').checked, true);
  const patch = calls.find((call) => call.options.method === 'PATCH');
  assert.equal(patch.url, '/api/me/mobile-push-preferences');
  assert.deepEqual(JSON.parse(patch.options.body), {
    preferences: { direct_interactions: true },
  });
});

test('one story: Settings describes every push category in the server\'s own words', () => {
  const { CATEGORY_DEFINITIONS } = require('../src/services/mobile-push-preferences');
  for (const category of CATEGORY_DEFINITIONS) {
    const id = `settings:alerts.push.${category.key.replace(/_(\w)/g, (_, c) => c.toUpperCase())}`;
    assert.equal(message(`${id}.description`), category.description, `${category.key}: one description, server and screen`);
  }
  const builds = CATEGORY_DEFINITIONS.find((c) => c.key === 'builds').description;
  assert.match(builds, /needs you, is ready to try, stops, or goes live/);
  assert.doesNotMatch(CATEGORY_DEFINITIONS.find((c) => c.key === 'proposal_alerts').description, /proposal/i);
});
