'use strict';

// #5928, item 3: an app's status chips are 12px, whichever renderer draws them.
// Discover's rows and the app's page go through <AppPills>, the Home menu's
// header through renderAppPillsHtml; both read the same two class strings.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

globalThis.window = globalThis.window || globalThis;
globalThis.PlatformI18n = englishPlatformI18n();
globalThis.document = globalThis.document || {
  createElement: () => {
    const node = {
      set textContent(v) { node.innerHTML = String(v); },
    };
    return node;
  },
};

const APP = {
  name: 'Chips', slug: 'chips', open_prs: 2, active_sessions: 1, open_issues: 3,
  missingSecrets: ['K'], view_visibility: 'private',
};

// The class attribute of each chip.
const chipClasses = (html) => Array.from(html.matchAll(/<span class="([^"]*rounded-full[^"]*)"/g), (m) => m[1]);

function assertTwelvePixels(html) {
  const chips = chipClasses(html);
  assert.equal(chips.length, 5, 'four activity chips and the visibility chip');
  for (const cls of chips) {
    assert.match(cls, /(^| )text-xs( |$)/, cls);
    assert.doesNotMatch(cls, /text-\[/, cls);
  }
}

test('<AppPills> draws every chip at text-xs', () => {
  const { AppPills } = loadTsx('frontend/src/features/apps/app-card-view.tsx');
  assertTwelvePixels(renderToHtml(createElement(AppPills, { app: APP })));
});

test('the Home menu\'s string renderer draws every chip at text-xs', () => {
  const { renderAppPillsHtml } = loadTsx('frontend/src/features/apps/app-card.js');
  assertTwelvePixels(renderAppPillsHtml(APP));
});
