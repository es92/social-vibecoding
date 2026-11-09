'use strict';

// #6248: a request draft the bot offers to file can be previewed before it is
// filed. The card under the bot's reply opens the AI tab's own column, the
// place a design's preview opens, and the pane reads the saved row's whole
// description (the message clips it at 1200 characters).
//
// What this pins:
//   1. The store: one preview at a time, a design's or a draft's; which place
//      a preview stands beside (a design's thread, or Main for a draft said
//      there); invalid ids change nothing; each open counts (seq).
//   2. The pane as the column: the design pane's header, the message's copy
//      until the saved row comes, and nothing to press but its close.
//
// Run with: node --test tests/request-draft-preview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

// The store moved into ./detail.ts (#6230, 3 Nov 2026); ./preview.ts is the
// design card's and the pane's spelling of it. detailEntry() reads the entry
// the store keeps, without React.
const detail = loadTsx('frontend/src/features/ai/detail.ts');
const preview = loadTsx('frontend/src/features/ai/preview.ts');

test('a design keeps its thread; a draft is said in a thread or in Main', () => {
  preview.openPreview({ conversationId: 4, rootId: 9, version: 2 });
  let open = detail.detailEntry();
  assert.equal(open.kind, 'design');
  assert.equal(open.ref.conversationId, 4);
  assert.equal(open.ref.rootId, 9);

  preview.openDraftPreview({ conversationId: 4, rootId: 9, actionId: 42 });
  open = detail.detailEntry();
  assert.equal(open.kind, 'draft');
  assert.equal(open.ref.rootId, 9, 'a draft said in its own thread');

  preview.openDraftPreview({ conversationId: 4, rootId: null, actionId: 43 });
  open = detail.detailEntry();
  assert.equal(open.ref.rootId, undefined, 'a draft said in Main');
  assert.equal(open.ref.actionId, 43);
});

test('openPreview opens a design; openDraftPreview opens a draft, in a thread or in Main', () => {
  preview.openPreview({ conversationId: 4, rootId: 9, version: 2 });
  let open = detail.detailEntry();
  assert.deepEqual(
    { kind: open.kind, actionId: open.ref.actionId, rootId: open.ref.rootId, version: open.version, copy: open.payload?.draft ?? null },
    { kind: 'design', actionId: undefined, rootId: 9, version: 2, copy: null },
  );

  const copy = { title: 'Add a search box', project: 'Plant pal', details: 'Search notes by their text.', appSlug: 'plant-pal' };
  preview.openDraftPreview({ conversationId: 4, rootId: 9, actionId: 42, copy });
  open = detail.detailEntry();
  assert.deepEqual(
    { kind: open.kind, actionId: open.ref.actionId, rootId: open.ref.rootId, version: open.version, copy: open.payload?.draft ?? null },
    { kind: 'draft', actionId: 42, rootId: 9, version: null, copy },
  );

  preview.openDraftPreview({ conversationId: 4, rootId: null, actionId: 43, copy });
  open = detail.detailEntry();
  assert.equal(open.ref.rootId, undefined, 'a draft said in Main');
  assert.equal(open.ref.actionId, 43);
});

test('invalid ids change nothing; each open bumps seq', () => {
  preview.openDraftPreview({ conversationId: 4, rootId: null, actionId: 8 });
  const first = detail.detailEntry();
  preview.openDraftPreview({ conversationId: 4, rootId: null, actionId: 8 });
  assert.equal(detail.detailEntry().seq, first.seq + 1, 'the same draft opened again is drawn again');

  const before = detail.detailEntry();
  preview.openDraftPreview({ conversationId: 0, rootId: null, actionId: 9 });
  preview.openDraftPreview({ conversationId: 4, rootId: null, actionId: 0 });
  preview.openDraftPreview({ conversationId: 4, rootId: -1, actionId: 9 });
  assert.equal(detail.detailEntry(), before, 'nothing valid changed');

  preview.closePreview();
  assert.equal(detail.detailEntry(), null);
});

test('the pane draws the message’s copy read-only, with a close and nothing to press', () => {
  const api = { readRequestDraft: () => new Promise(() => {}) };
  const { RequestDraftPane } = loadTsx('frontend/src/features/messages/request-draft-pane.tsx', { stubs: { './api': api } });
  const copy = { title: 'Add a search box', project: 'Plant pal', details: 'Search notes by their text.', appSlug: 'plant-pal' };
  const html = renderToHtml(createElement(RequestDraftPane, { actionId: 42, copy, onClose: () => {} }));
  assert.match(html, /data-request-draft-pane="42"/);
  assert.match(html, new RegExp(`aria-label="${message('messages:draft.pane.label')}"`));
  assert.match(html, /Add a search box/);
  assert.match(html, new RegExp(message('messages:draft.pane.sub', { project: 'Plant pal' })));
  assert.match(html, /Search notes by their text\./);
  assert.match(html, /Nothing is filed until you press File it under the bot/);
  assert.match(html, /data-draft-close="close"/);
  assert.doesNotMatch(html, />File it<|>Not now</, 'the card keeps both; the preview adds nothing to press');

  const phone = renderToHtml(createElement(RequestDraftPane, { actionId: 42, copy, onClose: () => {}, closeAs: 'back' }));
  assert.match(phone, /data-draft-close="back"/);
  assert.doesNotMatch(phone, /data-draft-close="close"/);
});
