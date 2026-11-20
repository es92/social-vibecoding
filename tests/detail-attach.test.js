'use strict';

// The detail column belongs to its thread (20 Nov 2026,
// frontend/src/features/ai/detail.ts): what opens beside the thread on screen
// is that thread's, leaving the thread holds it, coming back shows it again,
// and the person's own close forgets it. Everything a thread opened is
// remembered for the head card's picker (frontend/src/features/detail/
// detail-card.tsx), one row per thing whatever its version.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, ROOT, fs } = require('./lib/render-tsx');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function fresh() {
  // The store lives on the global object; a fresh one per test.
  delete globalThis.__usernodeDetail;
  return loadTsx('frontend/src/features/ai/detail.ts');
}

test('what opens is the thread on screen\'s; a design or a draft is always its own thread\'s', () => {
  const d = fresh();
  d.setDetailOwner('private:7');
  d.openDetail({ kind: 'shots', ref: { changeId: 41 }, payload: { html: '<p>x</p>' } });
  assert.equal(d.detailEntry().owner, 'private:7');
  d.openDetail({ kind: 'design', ref: { conversationId: 3, rootId: 9 } });
  assert.equal(d.detailEntry().owner, 'private:9', 'a design belongs to the thread it is the design of');
  d.openDetail({ kind: 'shots', ref: { changeId: 41 }, from: 'page:app/plant/dev/issues/4' });
  assert.equal(d.detailEntry().owner, 'page:app/plant/dev/issues/4', 'an opener that names its column wins');
  d.setDetailOwner(null);
  d.openDetail({ kind: 'shots', ref: { changeId: 42 } });
  assert.equal(d.detailEntry().owner, null, 'no column on screen, no owner: the old rules');
});

test('leaving a thread holds what it shows; coming back takes it once; another thread\'s is left alone', () => {
  const d = fresh();
  d.setDetailOwner('private:7');
  d.openDetail({ kind: 'shots', ref: { changeId: 41 } });
  const entry = d.detailEntry();
  d.holdDetail('private:8');
  assert.equal(d.detailEntry(), entry, 'another thread leaving holds nothing of this one');
  d.holdDetail('private:7');
  assert.equal(d.detailEntry(), null, 'the column empties');
  assert.equal(d.takeHeldDetail('private:8'), null);
  assert.equal(d.takeHeldDetail('private:7'), entry, 'the thread come back to gets it back');
  assert.equal(d.takeHeldDetail('private:7'), null, 'once');
});

test('the person\'s own close forgets it: the thread does not show it again', () => {
  const d = fresh();
  d.setDetailOwner('private:7');
  d.openDetail({ kind: 'shots', ref: { changeId: 41 } });
  d.holdDetail('private:7');
  d.reopenDetail(d.takeHeldDetail('private:7'));
  assert.equal(d.detailEntry().kind, 'shots', 'reopened as it was');
  assert.equal(d.detailEntry().owner, 'private:7');
  d.closeDetail();
  assert.equal(d.takeHeldDetail('private:7'), null);
});

test('a thread remembers each thing it opened once, at its newest version, for the picker', () => {
  const d = fresh();
  d.setDetailOwner('private:9');
  d.openDetail({ kind: 'design', ref: { conversationId: 3, rootId: 9 }, version: 1 });
  d.openDetail({ kind: 'shots', ref: { changeId: 41 } });
  d.openDetail({ kind: 'design', ref: { conversationId: 3, rootId: 9 }, version: 2 });
  const seen = d.seenDetails('private:9');
  assert.deepEqual(seen.map((e) => d.detailIdentity(e)), ['design:9', 'shots:41']);
  assert.equal(seen[0].version, 2);
  assert.deepEqual(d.seenDetails('private:10'), []);
  d.noteDetailLabel(seen[1], { title: 'Before and after', line: 'Plant Pal' });
  assert.deepEqual(d.detailLabel('private:9', 'shots:41'), { title: 'Before and after', line: 'Plant Pal' });
});

test('a running preview keeps what it was opened with, so its thread can ask for it again', () => {
  const placement = read('frontend/src/features/staging/placement.ts');
  assert.match(placement, /payload: \{ staging: \{ slug: input\.slug \|\| null, readOnly: input\.readOnly !== false \} \},/);
  assert.match(read('public/js/app-view.js'), /staging\.place\(\{ sessionId, wide: false, settle: !!\(opts && opts\.settle\), slug: slug \|\| null, readOnly \}\);/);
  const detail = read('frontend/src/features/ai/detail.ts');
  assert.match(detail, /if \(entry\.kind === 'preview'\) \{[\s\S]*?void view\.ensureStaging\(sessionId, null, null, \{/, 'reopened through the staging overlay, which owns its frame');
});

test('beside a thread on the bot tab the column is cards: a head card with the picker, the thing in a card under it', () => {
  const card = read('frontend/src/features/detail/detail-card.tsx');
  assert.match(card, /aria-haspopup="menu"/);
  assert.match(card, /data-detail-picker=""/);
  assert.match(card, /role="menu" aria-label=\{t\('messages:detail\.picker\.section'\)\} data-detail-menu=""/);
  assert.match(card, /<div className="detail-card-body" data-detail-body=\{entry\.kind\}>/);
  // The preview's own bar keeps its × (tests/staging-preview-has-an-exit.test.js).
  assert.match(card, /const closeHere = entry\.kind !== 'preview';/);
  assert.match(read('frontend/src/features/ai/index.tsx'), /<DetailPane layout=\{layout\} card \/>/);
  // The column's Escape gives way to the open menu's.
  assert.match(read('frontend/src/features/ai/detail.ts'), /if \(document\.querySelector\('\[data-detail-menu\]'\)\) return;/);
  const css = read('public/css/app.css');
  assert.match(css, /html:is\(:not\(\[data-skin\]\), \[data-skin="brand"\]\) #ai-screen \.ai-preview-pane:has\(> \.detail-card\) \{\n  background: none;\n  border: 0;/);
  assert.match(css, /html:is\(:not\(\[data-skin\]\), \[data-skin="brand"\]\) #ai-screen \.ai-preview-pane :is\(\.detail-card-head, \.detail-card-body\) \{\n  border-radius: 20px;/);
});
