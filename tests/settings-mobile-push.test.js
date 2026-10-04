'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
    /\{ key: 'alerts', label: 'Notifications', group: 'Preferences' \}/,
    'the category controls are discoverable from the Settings navigation');
  const block = ALERTS_SOURCE.slice(
    ALERTS_SOURCE.indexOf('id="settings-mobile-push-preferences"')
  );
  assert.match(block, /Mobile push categories/);
  assert.match(block, /Activity notifications switch remains the master control/);
  for (const [key, label] of CATEGORIES) {
    assert.match(block, new RegExp(`data-mobile-push-category="${key}"`));
    assert.match(block, new RegExp(`>${label}<`));
  }
  assert.match(block, /Mentions and replies to your messages/);
  assert.match(block, /Conversation invitations, messages, mentions, replies, and reactions/);
  assert.match(block, /Reactions and kudos on your work/);
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
