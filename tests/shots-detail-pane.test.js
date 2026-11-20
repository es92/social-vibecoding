'use strict';

// #6381: a change's before and after opened in the detail column had no way
// out of it — Expand opened the column and nothing closed it.
//
// The pane now heads the viewer with a close, as the design preview beside it
// does: an × at the right where the column is a column, a back arrow at the
// left where it is the whole screen. This RUNS the component — a hand-stepped
// React whose useMemo just goes through, the i18n hook stubbed to the id —
// then presses the control it drew and checks the detail store closed. The
// before and after's own markup is still drawn beneath the head.
//
// Run with: node --test tests/shots-detail-pane.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadTsx, ROOT, fs } = require('./lib/render-tsx');

const ENTRY = 'frontend/src/features/detail/shots.tsx';

function load() {
  // The store lives on globalThis (../ai/detail.ts), so the copy this bundle
  // carries and the one opened here are the same store.
  const detail = loadTsx('frontend/src/features/ai/detail.ts');
  const shots = loadTsx(ENTRY, {
    stubs: {
      react: { useMemo: (factory) => factory() },
      '../../lib/i18n/react': { useMessages: () => (id) => id },
      // 20 Nov 2026: beside a thread on the bot tab the head card draws its
      // title and close (./detail-card.tsx); elsewhere it draws its own.
      './detail-card': { useDetailCard: () => false, useDetailLabel: () => {} },
    },
  });
  return { detail, shots };
}

/** The first element in the tree carrying `data-shots-close` as `which`. */
function control(node, which) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = control(child, which);
      if (found) return found;
    }
    return null;
  }
  if (node.props && node.props['data-shots-close'] === which) return node;
  return control(node.props && node.props.children, which);
}

function classed(node, className) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((child) => classed(child, className));
  if (String(node.props?.className || '').split(/\s+/).includes(className)) return true;
  return classed(node.props?.children, className);
}

function open(detail) {
  detail.openDetail({
    kind: 'shots',
    ref: { changeId: 9 },
    version: null,
    payload: { html: '<div class="shots-viewer" id="shots-9-viewer"></div>' },
  });
  return detail.detailEntry();
}

test('a column draws a close over the viewer, and pressing it closes the detail', () => {
  const { detail, shots } = load();
  const entry = open(detail);
  assert.equal(detail.isDetailOpen(), true);
  const tree = shots.DetailPaneShots({ entry, layout: 'three' });

  const close = control(tree, 'close');
  assert.ok(close, 'the pane draws a close');
  assert.equal(control(tree, 'back'), null, 'no back arrow where the column is a column');
  assert.equal(close.props['aria-label'], 'changes:shots.pane.close');
  // The before and after still scroll under the head, unchanged.
  assert.ok(classed(tree, 'gc-detail-shots'), 'the viewer is still drawn');

  close.props.onClick();
  assert.equal(detail.isDetailOpen(), false, 'pressing it closes the column');
});

test('a phone, where the column is the whole screen, gets a back arrow', () => {
  const { detail, shots } = load();
  const entry = open(detail);
  const tree = shots.DetailPaneShots({ entry, layout: 'full' });

  const back = control(tree, 'back');
  assert.ok(back, 'the pane draws a back arrow');
  assert.equal(control(tree, 'close'), null, 'the × is not drawn as well');
  assert.equal(back.props['aria-label'], 'changes:shots.pane.back');

  back.props.onClick();
  assert.equal(detail.isDetailOpen(), false, 'pressing it closes the column');
});

test('an entry whose viewer has not filled in yet can still be closed', () => {
  const { detail, shots } = load();
  detail.openDetail({ kind: 'shots', ref: { changeId: 10 }, version: null, payload: {} });
  const tree = shots.DetailPaneShots({ entry: detail.detailEntry(), layout: 'three' });

  assert.ok(control(tree, 'close'), 'the close is drawn over the loading line too');
  assert.ok(classed(tree, 'gc-spec-panel-error'), 'the loading line is still drawn');
});

test('the close is worded as the design preview beside it is', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/changes.json'), 'utf8'));
  assert.equal(catalog['shots.pane.close'].text, 'Close the before and after');
  assert.equal(catalog['shots.pane.back'].text, 'Back to the thread');
});
