'use strict';

// #1899: a failed app-list load is one branded error state — plain-language
// title and detail, and a Retry that re-runs the same load — on Home's grid
// and on the directory screen, instead of a red "Failed to load apps" line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the error card: title, detail, and a Try again button', () => {
  const html = renderComponent('frontend/src/features/apps/load-error.tsx', 'AppsLoadError', {
    title: "Couldn't load your apps", onRetry: () => {},
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /data-apps-load-error=""/);
  assert.match(html, />Couldn(&#x27;|')t load your apps</);
  assert.match(html, /Check your connection and try again\./);
  assert.match(html, /<button[^>]*type="button"[^>]*>\s*Try again\s*<\/button>/);
  assert.match(html, /<svg/, 'with the warning glyph');
});

test('#4813: a detail prop overrides the line, and the default is unchanged', () => {
  const html = renderComponent('frontend/src/features/apps/load-error.tsx', 'AppsLoadError', {
    title: "Couldn't open this app",
    detail: "It didn't finish loading. Check your connection and try again.",
    onRetry: () => {},
  });
  assert.match(html, />It didn&#x27;t finish loading\. Check your connection and try again\.</,
    'the override is rendered');
  assert.doesNotMatch(html, /app directory/, 'the directory\'s own line is not');
});

test('Home\'s grid draws the card for an error notice and retries through Home.load', () => {
  const grid = read('frontend/src/features/home/app-grid.tsx');
  assert.match(grid, /state\.notice && state\.notice\.tone === 'error' \? \(/);
  assert.match(grid, /<AppsLoadError[\s\S]*?onRetry=\{\(\) => controller\(\)\?\.load\?\.\(\)\}/);
  assert.doesNotMatch(grid, /text-red-400/, 'no bare red line left');
  assert.match(read('frontend/src/features/home/home.js'), /notice: \{ text: message\('home:grid\.notice\.loadFailed'\), tone: 'error' \}/);
  assert.equal(message('home:grid.notice.loadFailed'), "Couldn't load your apps");
});
