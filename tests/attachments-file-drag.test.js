// #4065: drag-and-drop attachments in the discussion, chat and improvement
// windows. Every composer already took a dropped file; what this pins is the
// part people could not see or were not told:
//
//   * the drop zone (features/attachments/file-drag.tsx): a depth count that
//     stays lit while the pointer crosses the card's own controls, lights only
//     for a FILE drag and never where a drop would be refused;
//   * each composer drawing it (group chat, "Suggest an improvement",
//     Messages);
//   * one error line for every file a drop left out — the first reason and
//     how many more — in the group chat and Messages;
//   * the window guard (lib/file-drop-guard.ts): a file dropped where nothing
//     takes it does not open in place of the app.
//
// Run with: node --test tests/attachments-file-drag.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const drag = () => loadTsx('frontend/src/features/attachments/file-drag.tsx');

function dragEvent(types = ['Files'], files = [], type = 'drop') {
  const event = {
    type,
    prevented: 0,
    dataTransfer: { types, files, dropEffect: 'none' },
    preventDefault() { event.prevented += 1; event.defaultPrevented = true; },
    defaultPrevented: false,
  };
  return event;
}

// ── The tracker ───────────────────────────────────────────────────────

test('crossing the card’s own controls keeps the zone lit; leaving it clears it', () => {
  const { createFileDragTracker } = drag();
  const changes = [];
  const t = createFileDragTracker({ onChange: (v) => changes.push(v) });
  t.enter(dragEvent()); // the card
  t.enter(dragEvent()); // the textarea inside it
  t.leave(dragEvent()); // …out of the card's own edge as seen by the card
  assert.deepEqual(changes, [true], 'a leave from a child does not clear it');
  t.leave(dragEvent());
  assert.deepEqual(changes, [true, false]);
  t.dispose();
});

test('only a drag carrying files lights it, and a refused zone never does', () => {
  const { createFileDragTracker, isFileDrag } = drag();
  assert.equal(isFileDrag(dragEvent(['text/plain'])), false);
  assert.equal(isFileDrag(dragEvent(['Files'])), true);
  const changes = [];
  const t = createFileDragTracker({ onChange: (v) => changes.push(v) });
  const text = dragEvent(['text/plain', 'text/uri-list']);
  t.enter(text); t.over(text);
  assert.equal(text.prevented, 0, 'a text drag keeps the browser’s own drop into the field');
  assert.deepEqual(changes, []);

  let off = true;
  const r = createFileDragTracker({ isDisabled: () => off, onChange: (v) => changes.push(v) });
  const file = dragEvent();
  r.enter(file); r.over(file);
  assert.deepEqual(changes, [], 'read-only, archived or busy: no outline');
  assert.equal(file.dataTransfer.dropEffect, 'none');
  off = false;
  const ok = dragEvent();
  r.enter(ok); r.over(ok);
  assert.equal(ok.dataTransfer.dropEffect, 'copy');
  assert.deepEqual(changes, [true]);
  r.reset();
  assert.deepEqual(changes, [true, false], 'a drop clears it outright');
  t.dispose(); r.dispose();
});

test('the summary names the first reason and counts the rest', () => {
  const { refusalSummary } = drag();
  assert.equal(refusalSummary('"a.png" is too big. Images max 4 MB.', 0), '"a.png" is too big. Images max 4 MB.');
  assert.equal(refusalSummary('Up to 4 files per message.', 1), 'Up to 4 files per message. 1 more file wasn’t attached.');
  assert.equal(refusalSummary('Up to 4 files per message.', 3), 'Up to 4 files per message. 3 more files weren’t attached.');
});

test('the outline is the Messages one, and lies over the card', () => {
  const { DropOverlay } = drag();
  const html = renderToHtml(createElement(DropOverlay, {}));
  assert.match(html, /class="attach-drop-overlay"/);
  assert.match(html, />Drop files to attach</);
  assert.match(html, /aria-hidden="true"/);
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-drop-overlay,\s*\.attach-drop-overlay \{\s*position: absolute;/, 'one style for both');
  assert.match(css, /\n#feedback-form \{ position: relative; \}/);
});

// ── Each composer draws it ────────────────────────────────────────────

// One message box (27 Nov 2026): a project chat's box is Messages' own, so
// its pane takes a drop as Messages' panes do (../messages/pane-drop.ts):
// the channel's pane and a thread's page frame the outline and hand the
// files to the box, which uploads them.
test('the group chat’s panes take the drop as Messages’ do, and hand it to the box', () => {
  for (const file of ['frontend/src/features/group-chat/general-chat.tsx', 'frontend/src/features/group-chat/thread-shell.tsx']) {
    const src = read(file);
    assert.match(src, /usePaneDrop\(chatScopeKey\(/, `${file} asks the box for its scope's drop`);
    assert.match(src, /\{drop\.dragging \? <DropOverlay className="messages-drop-overlay" \/> : null\}/);
  }
  assert.match(read('frontend/src/features/group-chat/general-chat.tsx'), /className="gc-chat-pane platform-kb-column relative flex-1 flex flex-col min-h-0" \{\.\.\.drop\.handlers\}>/);
  assert.match(read('frontend/src/features/group-chat/thread-shell.tsx'), /sheetProps=\{drop\.handlers\}/);
  const css = read('public/css/app.css');
  assert.match(css, /\.gc-chat-pane > \.messages-drop-overlay,\s*\.dev-request-sheet > \.messages-drop-overlay \{ inset: 8px; \}/);
  // The module tracks no drag of its own any more.
  assert.doesNotMatch(read('public/js/group-chat.js'), /_wireDropZone|createFileDragTracker/);
});

test('the improvement form and Messages each wire the shared zone', () => {
  const feedback = read('frontend/src/features/dialogs/feedback.tsx');
  assert.match(feedback, /<HostDropOverlay host=\{feedbackForm\} label=\{t\('dialogs:feedback\.dropLabel'\)\} isDisabled=\{feedbackLocked\} \/>/);
  assert.equal(message('dialogs:feedback.dropLabel'), 'Drop images or a clip to attach');
  assert.match(read('frontend/src/features/dialogs/feedback-controller.js'),
    /feedbackForm\.addEventListener\('drop'/, 'the controller still does the attaching');

  // #6254: the pane takes the drop and frames the whole thread; the box it
  // forwards to no longer has a zone of its own.
  const messages = read('frontend/src/features/messages/index.tsx');
  // The pane's half lives beside the box's (../messages/pane-drop.ts), where
  // the group chat's panes take it from too.
  assert.match(read('frontend/src/features/messages/pane-drop.ts'), /useFileDrag\(\{ disabled: !ready, onFiles:/);
  assert.match(messages, /aria-label=\{snap\.active\?\.title \|\| t\('messages:thread\.paneName'\)\} \{\.\.\.drop\.handlers\}>/, 'the conversation pane takes the drop');
  assert.match(messages, /<DropOverlay className="messages-drop-overlay" \/>/);
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.doesNotMatch(composer, /useFileDrag/, 'the box no longer owns the drop');
  assert.match(composer, /<ComposerDropTarget scope=\{scope\} onFiles=/);
});

test('the thread outline frames the whole pane', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-thread-pane \{[^}]*position: relative;/);
  assert.match(css, /\.messages-thread-pane > \.messages-drop-overlay,\s*\.messages-reply-pane > \.messages-drop-overlay \{ inset: 8px; \}/);
  assert.doesNotMatch(css, /messages-composer-dragging/, 'the box no longer draws an outline of its own');
});

// ── One line for every file left out ─────────────────────────────────

// One message box (27 Nov 2026): a project chat's box stages files with the
// box's own rule (../attachments/limits.ts stageFiles), with the ceilings
// its server takes for one file.
test('group chat: the box stages with the chat\'s own ceilings and says what it left out once', () => {
  const { stageFiles, chatAttachmentLimit } = loadTsx('frontend/src/features/attachments/limits.ts');
  const t = (id, values) => message(id, values);
  const f = (name, size, type = '') => ({ name, size, type });
  const { upload, refused } = stageFiles(
    [f('a.png', 1024, 'image/png'), f('huge.png', 5 * 1024 * 1024, 'image/png'), f('notes.md', 300 * 1024), f('c.png', 10, 'image/png'), f('d.png', 10, 'image/png')],
    0, t, chatAttachmentLimit,
  );
  assert.deepEqual(upload.map((file) => file.name), ['a.png', 'notes.md', 'c.png'], 'a Markdown page takes its 512 KB here');
  assert.match(refused, /huge\.png/);
  assert.match(refused, /1 more file/, 'the first reason, and the file past the fourth counted');
  assert.equal(chatAttachmentLimit(f('page.html', 0)), 2 * 1024 * 1024);
  assert.equal(chatAttachmentLimit(f('data.bin', 0)), 10 * 1024 * 1024);
  assert.match(read('frontend/src/features/group-chat/composer.tsx'), /fileLimit: chatAttachmentLimit,/);
});

test('Messages: files past the room are counted, not dropped without a word', () => {
  // #6256: the cut and the summary are shared with the blank thread's
  // composer now, so they are pinned where they live.
  const src = read('frontend/src/features/attachments/limits.ts');
  assert.match(src, /const cut = files\.length - selected\.length;/);
  assert.match(src, /refusalSummary\(firstReason, tooLarge\.length \+ cut - 1\)/);
});

// ── The floor under every zone ────────────────────────────────────────

test('a file dropped where nothing takes it does not open in place of the app', () => {
  const guard = loadTsx('frontend/src/lib/file-drop-guard.ts');
  const unclaimed = dragEvent();
  guard.onUnclaimedFileDrag(unclaimed);
  assert.equal(unclaimed.prevented, 1);
  const over = dragEvent(['Files'], [], 'dragover');
  guard.onUnclaimedFileDrag(over);
  assert.equal(over.dataTransfer.dropEffect, 'none', 'the cursor says nothing will happen');

  const text = dragEvent(['text/plain']);
  guard.onUnclaimedFileDrag(text);
  assert.equal(text.prevented, 0, 'a text drag is left alone');

  const claimed = dragEvent();
  claimed.defaultPrevented = true;
  guard.onUnclaimedFileDrag(claimed);
  assert.equal(claimed.prevented, 0, 'a drop a composer took is left alone');
  assert.equal(claimed.dataTransfer.dropEffect, 'none');

  assert.match(read('frontend/src/main.tsx'), /import '\.\/lib\/file-drop-guard';/);
});
