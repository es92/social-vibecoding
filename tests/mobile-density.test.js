// #1617's first mobile-density slice (its Dev-chat Details sheet reverted by
// #1940). Render contracts run in npm test;
// scripts/capture-mobile-density.mjs exercises the actual browser interactions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { tokenize } = require('./helpers/html-tokens');
const { BrowseRows } = loadTsx('frontend/src/features/apps/browse-list.tsx');
const header = loadTsx('tests/fixtures/dev-session-header-api.ts');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('#1940: the provider and PR link show directly at every width — no Details sheet', () => {
  header.sessionHeaderStore.set({
    sessionId: 12, title: 'A longer change name', branch: 'test/long-title', pr: 21,
    prTitle: 'This session’s PR', newChangeTitle: '', life: null, busy: false,
    venue: { id: 'usernode-openrouter', label: 'Homeroom · OpenRouter', title: 'Choose where to build', disabled: false },
  });
  header.improveStore.set({ previewSessionId: null, previewUrl: null, previewActive: false });
  const html = renderToHtml(createElement(header.SessionHeader));
  assert.match(html, /dc-session-title[^>]*>A longer change name</);
  assert.doesNotMatch(html, /dc-session-details-trigger|aria-haspopup="dialog"|dc-session-details/,
    'the Details button and its dialog are gone');
  assert.match(html, /id="dc-pr-header-link"/);
  assert.doesNotMatch(html, /id="dc-pr-header-link"[^>]*max-sm:hidden/, 'the PR link is not hidden on phones');
  assert.match(html, /id="dc-venue-select"/);
  assert.doesNotMatch(html, /id="dc-venue-select"[^>]*max-sm:hidden/, 'Built with is not hidden on phones');
  assert.equal(tokenize(html).filter(t => t.kind === 'open' && t.attrs.some(a => a.name === 'id' && a.value === 'dc-venue-select')).length, 1);
});

test('Discover keeps the full app name, metadata and explicit add/remove action in one row', () => {
  const row = { app: {}, slug: 'long-app', name: 'A very long community application name',
    meta: '11 users · Updated recently', status: 'Running', statusDot: 'bg-emerald-500',
    openable: true, demo: false, added: false, addTitle: 'Add to Your apps' };
  const render = added => renderToHtml(createElement(BrowseRows, { rows: [{ ...row, added }] }));
  const html = render(false);
  for (const hook of ['browse-row-content', 'browse-row-title', 'browse-row-meta', 'browse-row-name']) assert.ok(html.includes(hook));
  assert.ok(html.includes(row.name));
  assert.ok(html.includes(row.meta));
  assert.match(html, /data-added="false" aria-pressed="false"[^>]*>Add to Your apps</);
  assert.equal((html.match(/class="browse-add-btn/g) || []).length, 1, 'no duplicated responsive buttons');
  assert.match(render(true), /data-added="true" aria-pressed="true"/);
  assert.match(render(true), />Added</);
});

test('the title reflow is phone-only and scoped to Discover and the Dev session title', () => {
  const css = read('public/css/app.css');
  assert.match(css, /@media \(max-width: 639px\) \{\s*\.browse-row\.browse-row \{\s*display: grid;/);
  assert.match(css, /\.browse-row \.browse-row-title \{ grid-column: 2 \/ 4; grid-row: 1;/);
  assert.match(css, /\.browse-row > \.browse-add-btn \{ grid-column: 3; grid-row: 2; min-height: 44px;/);
  assert.match(css, /@media \(max-width: 639px\) \{\s*#dc-session-header > \.dc-session-title \{\s*white-space: normal;\s*overflow-wrap: anywhere;/);
  assert.match(css, /-webkit-line-clamp: 2;/, 'very long session names do not consume the chat');
});

test('#1940: the session header no longer carries a dialog of its own', () => {
  const src = read('frontend/src/features/dev-chat/session-header.tsx');
  assert.doesNotMatch(src, /useDialog\(|createPortal|DialogRoot/);
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /dc-venue-details-select/, 'the Details-only provider styles went with it');
  // The provider still caps its own width, which is what lets it sit in a
  // 360px strip beside the title, the PR link and the mode switch.
  assert.match(css, /\n\.dc-venue-select \{[^}]*max-width: min\(45%, 14rem\);/);
});
