// #1617's first mobile-density slice (its Dev-chat Details sheet reverted by
// #1940). Render contracts run in npm test;
// scripts/capture-mobile-density.mjs exercises the actual browser interactions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { tokenize } = require('./helpers/html-tokens');
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

test('#1940: the session header no longer carries a dialog of its own', () => {
  const src = read('frontend/src/features/dev-chat/session-header.tsx');
  assert.doesNotMatch(src, /useDialog\(|createPortal|DialogRoot/);
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /dc-venue-details-select/, 'the Details-only provider styles went with it');
  // The provider still caps its own width, which is what lets it sit in a
  // 360px strip beside the title, the PR link and the mode switch.
  assert.match(css, /\n\.dc-venue-select \{[^}]*max-width: min\(45%, 14rem\);/);
});
