// Regression test for issue #2938: tapping Send in a chat composer while an
// attachment is still uploading showed "Still uploading, one moment…" above
// the composer — and nothing ever took it down. The upload finished, the
// message went out with its image, and the red line stayed.
//
// One message box (27 Nov 2026): a project chat's box is Messages' own
// (features/messages/composer.tsx MessageBox), which has no wait notice to
// leave behind. While a file is on its way up, Send is held (disabled, and
// Enter does nothing), the strip says the file is uploading, and the moment
// it lands Send is a send again, carrying it. The notice, its module state
// and its catalog line went with the old box.
//
// Run with: node --test tests/group-chat-upload-wait-notice.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const BOX = read('frontend/src/features/messages/composer.tsx');
const GC_JS = read('public/js/group-chat.js');
const GC = read('frontend/src/features/group-chat/composer.tsx');

test('a send while a file uploads waits: Send is held and Enter does nothing', () => {
  assert.match(BOX, /function submit\(\) \{\n\s+if \(dictating \|\| uploading \|\| \(!value\.trim\(\) && !attachments\.length && !object\)\) return;/);
  assert.match(BOX, /onClick=\{submit\} disabled=\{dictating \|\| !!uploading \|\| \(!value\.trim\(\) && !attachments\.length && !object\)\} className="messages-send"/);
});

test('the strip says a file is uploading, and a landed file goes with the next send', () => {
  assert.match(BOX, /\{uploading \? <span className="dc-attach-uploading">\{t\('messages:composer\.uploading', \{ count: uploading \}\)\}<\/span> : null\}/);
  // The box hands its landed files to the chat's send, which puts their ids
  // on the message.
  assert.match(GC, /controller\(\)\?\.send\?\.\(input\.content, posts, input\.attachmentIds\)/);
});

test('no wait notice is left to take down', () => {
  assert.doesNotMatch(GC_JS, /UPLOAD_WAIT_NOTICE|_attachWaiting|_setAttachError|attachmentsUploading/);
  assert.doesNotMatch(read('public/js/app-view.js'), /UPLOAD_WAIT_NOTICE|attachmentsUploading/);
});
