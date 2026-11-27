// The pending-upload strip above a composer — the chips and thumbnails for
// files staged but not yet sent (frontend/src/features/attachments/
// pending-strip.tsx).
//
// It used to be drawn in two places, the dev chat's composer and the group
// chat's, as the same markup written out twice. #1191 made them one
// component; the group chat's composer is the one that draws it now. What
// this pins:
//
//   * WHICH badge a kind gets. The composer computes the label and hands it
//     over, so the chip does not know one kind from another.
//   * HOW a row is removed. The composer holds the pending list — with the
//     File and the object URL it has to revoke — so the row reports an INDEX.
//
// Run with: node --test tests/attachments-pending-strip.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const STRIP = 'frontend/src/features/attachments/pending-strip.tsx';
const item = (over) => ({
  key: 'p1', name: 'notes.md', kind: 'markdown', badge: 'MD', size: '2 KB',
  thumbUrl: null, uploading: false, ...over,
});
const rows = (items) => renderComponent(STRIP, 'PendingStripRows', { items, onRemove: () => {} });

test('a file that is not a picture is a card: icon, name and badge (#6862)', () => {
  const html = rows([item()]);
  assert.match(html, /^<div class="dc-attach-item dc-attach-file" title="notes\.md">/);
  assert.match(html, /<span class="dc-attach-file-icon" aria-hidden="true"><svg/);
  assert.match(html, /<span class="dc-attach-file-text"><span class="dc-attach-name">notes\.md<\/span><span class="dc-attach-kind">MD<\/span><\/span>/);
  assert.match(html, /<button type="button" class="dc-attach-remove" title="Remove" aria-label="Remove notes\.md">×<\/button>/);
  // A kind with no tag draws no empty span.
  assert.ok(!rows([item({ kind: 'text', badge: null })]).includes('dc-attach-kind'));
});

test('an image with a local preview is its picture, not a name (#6862)', () => {
  const html = rows([item({ kind: 'image', badge: null, thumbUrl: 'blob:x', name: 'shot.png', size: '10 KB' })]);
  // The square thumbnail, cropped by CSS, is both the picture and the link
  // to the viewer; its × names the file.
  assert.match(html, /<div class="dc-attach-item dc-attach-image">/);
  assert.match(html, /<a class="dc-attach-thumb-link" href="blob:x" data-image-open="" title="shot.png" aria-label="Preview shot.png"><img class="dc-attach-thumb" src="blob:x" alt="shot.png"\/><\/a>/);
  assert.match(html, /aria-label="Remove shot.png"/);
  assert.ok(!html.includes('dc-attach-file'));
  // The tap opens the app's own viewer, with the file's size beside its name.
  const src = read(STRIP);
  assert.match(src, /<ImageViewer src=\{src\} alt=\{item\.name\} detail=\{item\.size\}/);
  // …and an image whose preview has not been made yet falls back to a file
  // card, rather than rendering an <img> with no source.
  assert.match(rows([item({ kind: 'image', badge: null, thumbUrl: null })]), /dc-attach-file/);
});

test('an upload in flight offers no remove control, and says it is working', () => {
  // Cancelling mid-PUT would leave a half-written row for the 24h orphan
  // sweep to find anyway, and a control that sometimes works is worse than
  // a dimmed picture under a ring. Both chats behave this way, once.
  const image = rows([item({ kind: 'image', badge: null, thumbUrl: 'blob:x', uploading: true })]);
  assert.match(image, /dc-attach-image-uploading/);
  assert.match(image, /<span class="dc-attach-progress"><svg[^>]*data-progress-ring-spinning=""/);
  assert.match(image, /aria-label="Uploading notes\.md"/);
  assert.ok(!image.includes('dc-attach-remove'));
  // A file waits with the same ellipsis it always did.
  const file = rows([item({ uploading: true })]);
  assert.match(file, /<span class="dc-attach-uploading">…<\/span>/);
  assert.ok(!file.includes('dc-attach-remove'));
});

test('a filename reaches the DOM as text, in all three slots it appears in', () => {
  // `title`, `alt` and `aria-label` all carry one, and a filename is fully
  // user-controlled. This is the property `escapeHtml` / `_escAttr` used to
  // give by hand in each module.
  const hostile = 'x" onmouseover="alert(1)"><img src=y>.png';
  const html = rows([
    item({ key: 'a', name: hostile }),
    item({ key: 'b', name: hostile, kind: 'image', badge: null, thumbUrl: 'blob:z' }),
  ]);
  assert.ok(!html.includes('<img src=y>'), 'the tag never lands as markup');
  assert.ok(!/" onmouseover="/.test(html), 'the quote cannot close an attribute');
  assert.match(html, /&quot; onmouseover=/);
});

test('removal reports an index, and the composer resolves it', () => {
  const { PendingStripRows } = loadTsx(STRIP);
  const removed = [];
  const element = PendingStripRows({
    items: [item({ key: 'a' }), item({ key: 'b' }), item({ key: 'c', uploading: true })],
    onRemove: (i) => removed.push(i),
  });
  const list = element.props.children;
  assert.equal(list.length, 3);
  // Each row's own position, not the key and not the filename — the live
  // entry (File, object URL) never leaves the module.
  list[0].props.onRemove(list[0].props.index);
  list[1].props.onRemove(list[1].props.index);
  assert.deepEqual(removed, [0, 1]);

  // The box resolves it against its own list (one message box, 27 Nov
  // 2026: the group chat's box is Messages' own).
  assert.match(read('frontend/src/features/messages/composer.tsx'),
    /<PendingStripRows items=\{staged\} onRemove=\{removeStaged\} \/>/);
});

test('the box owns its strip element, and the class comes with it', () => {
  // The group chat's own strip element (`PendingStrip`, `#gc-attachments`)
  // went with its box; every box draws the rows inside its own active strip.
  assert.match(read('frontend/src/features/messages/composer.tsx'),
    /\{staged\.length \? <div className="dc-attach-strip dc-attach-strip-active"><PendingStripRows/);
  assert.doesNotMatch(read(STRIP), /export function PendingStrip\(/);
  // …and the rows-only export emits no wrapper at all, which is what keeps
  // a caller that already has a host from nesting a second one.
  assert.ok(!rows([item()]).includes('dc-attach-strip'));
});

test('a message box stages an image as its picture and a PDF as a file card (#6862)', () => {
  // The rule both Messages boxes follow (frontend/src/features/messages/
  // attachment-views.ts): a sent image is drawn from the server's copy, a
  // file keeps a card, and an upload in flight is its local preview.
  const { attachmentView, pendingUploadView } = loadTsx('frontend/src/features/messages/attachment-views.ts');
  const image = attachmentView({
    id: 'a1', name: 'shot.png', size: 10240, contentType: 'image/png', url: '/attachments/a1', viewUrl: '/attachments/a1/view',
  });
  assert.equal(image.kind, 'image');
  assert.equal(image.thumbUrl, '/attachments/a1/view', 'a sent image is drawn from the server, not a blob');
  assert.match(rows([image]), /<img class="dc-attach-thumb" src="\/attachments\/a1\/view" alt="shot.png"\/>/);

  const file = attachmentView({
    id: 'a2', name: 'brief.pdf', size: 2048, contentType: 'application/pdf', url: '/attachments/a2',
  });
  assert.equal(file.kind, 'file');
  assert.equal(file.badge, 'PDF');
  assert.match(rows([file]), /dc-attach-file[\s\S]*brief\.pdf[\s\S]*dc-attach-kind">PDF/);

  const pending = pendingUploadView({
    key: 'p1', file: new File(['x'], 'draft.png', { type: 'image/png' }), thumbUrl: 'blob:preview',
  });
  assert.equal(pending.uploading, true);
  assert.equal(pending.thumbUrl, 'blob:preview');
  assert.match(rows([pending]), /<img class="dc-attach-thumb" src="blob:preview" alt="draft.png"\/>/);

  // Both boxes show the file that is still uploading, and revoke its local
  // preview when the row goes.
  for (const source of ['frontend/src/features/messages/composer.tsx', 'frontend/src/features/messages/new-thread.tsx']) {
    const src = read(source);
    assert.match(src, /URL\.createObjectURL\(file\)/, `${source} makes a preview before the upload answers`);
    assert.match(src, /URL\.revokeObjectURL\(/, `${source} revokes it when the row goes`);
    assert.match(src, /<PendingStripRows items=\{staged\} onRemove=\{removeStaged\}/, `${source} draws its rows with the one strip`);
  }
});
