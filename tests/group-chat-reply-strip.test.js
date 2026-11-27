// #2391: the general Discussion's "Replying to …" strip, reworked.
//
// It shared the sent-quote block's rules — an 11/12px chip, 4px corners,
// capped at 560px — under a 22px-radius composer card, and a reply to a
// platform message (#2390) read "Replying to message". It now follows the
// Messages screen's reply draft, and its label names what it replies to.
//
// One message box (27 Nov 2026): the chat's box is Messages' own, so the
// strip IS the Messages reply draft (`.messages-reply-draft`), drawn by the
// box from the chip the chat words (features/group-chat/composer.tsx
// replyChip); the chat's own strip and its rules are gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderComponent } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
const rule = (sel) => {
  const m = css.match(new RegExp(`\\n${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`));
  assert.ok(m, sel);
  return m[1];
};

test('the strip is the Messages reply draft: full width, accent tint, open rounded edge', () => {
  assert.match(css, /\.messages-reply-draft \{[^}]*border-start-start-radius: 0; border-start-end-radius: 12px; border-end-end-radius: 12px; border-end-start-radius: 0;[^}]*background: var\(--accent-tint\);/,
    'the Messages screen draws its draft the same way');
  assert.doesNotMatch(css, /\.gc-reply-preview/, 'the chat\'s own strip is gone');
  const box = fs.readFileSync(path.join(root, 'frontend/src/features/messages/composer.tsx'), 'utf8');
  assert.match(box, /\{reply \? <div className="messages-reply-draft"><div className="min-w-0"><span className="font-semibold">\{reply\.title\}<\/span><p className="truncate">\{reply\.snippet\}<\/p>/);
});

test('the sent quote keeps its compact in-transcript form', () => {
  const quoted = rule('.gc-quoted');
  assert.match(quoted, /border-radius: 4px;/);
  assert.match(quoted, /max-width: min\(560px, 100%\);/);
  assert.doesNotMatch(css, /\.gc-quoted,\s*\n\.gc-reply-preview-inner \{/, 'no longer one shared rule');
});

// A tapped row, as the transcript draws it: its data attributes and classes.
function quoteFromRow({ dataset, classes = [], text = 'hello' }) {
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' },
    document: { getElementById: () => null },
    App: { user: { id: 1 } },
    PlatformI18n: englishPlatformI18n(),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/group-chat.js'), 'utf8'), sandbox);
  return sandbox.window.GroupChat._quoteFromRow({
    dataset: { msgId: '7', ...dataset },
    classList: { contains: (name) => classes.includes(name) },
    querySelector: (selector) => (selector === '.gc-msg-content' ? { textContent: text } : null),
    textContent: text,
  });
}

function labelFor(replyDraft) {
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' },
    document: { getElementById: () => null },
    App: { user: { id: 1 } },
    PlatformI18n: englishPlatformI18n(),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/group-chat.js'), 'utf8'), sandbox);
  const gc = sandbox.window.GroupChat;
  const published = [];
  gc._publishComposer = (scope, patch) => published.push(patch);
  gc.replyDraft = replyDraft;
  gc._renderQuotePreview();
  return published[0].quote;
}

// What the strip says for a staged reply: the chip the box draws.
const { replyChip } = require('./lib/render-tsx').loadTsx('frontend/src/features/group-chat/composer.tsx');
function lineFor(replyDraft) {
  const i18n = englishPlatformI18n();
  return replyChip((id, values) => i18n.t(id, values), labelFor(replyDraft)).title;
}

test('the label names what the reply is to', () => {
  assert.equal(labelFor({ source: 'message', author: 'alice', snippet: 'hi' }).label, '@alice');
  assert.equal(labelFor({ source: 'pr', prNumber: 12, snippet: 'x' }).label, 'PR 12');
  assert.equal(lineFor({ source: 'message', author: 'alice', snippet: 'hi' }), '↩ Replying to @alice');
  assert.equal(lineFor({ source: 'pr', prNumber: 12, snippet: 'x' }), '↩ Replying to PR 12');
  // A pull request is told apart from a person: the strip has a sentence for it.
  assert.equal(labelFor({ source: 'pr', prNumber: 12, snippet: 'x' }).pr, '12');
  assert.equal(labelFor({ source: 'message', author: 'alice', snippet: 'hi' }).pr, null);
  assert.equal(labelFor({ source: 'pr', snippet: 'x' }).label, 'PR');
  assert.equal(lineFor({ source: 'pr', snippet: 'x' }), '↩ Replying to PR');
  // A row with nobody to name has a whole sentence of its own in the catalog.
  assert.equal(labelFor({ source: 'event', author: null, snippet: 'Proposed PR #12' }).unnamed, 'event');
  assert.equal(labelFor({ source: 'message', author: null, snippet: 'gone' }).unnamed, 'message');
  assert.equal(lineFor({ source: 'event', author: null, snippet: 'Proposed PR #12' }), '↩ Replying to a platform message');
  assert.equal(lineFor({ source: 'message', author: null, snippet: 'gone' }), '↩ Replying to a message');
});

test('tapping a row that names nobody keeps that through the row, the quote and the strip', () => {
  // A message that came with no author shows "System"; a spec card with no sharer shows "Someone".
  const nameless = quoteFromRow({ dataset: { username: 'System', usernameMissing: '' } });
  assert.equal(nameless.author, 'System', 'what is sent with the reply is unchanged');
  assert.equal(nameless.authorMissing, 'system');
  assert.equal(labelFor(nameless).unnamed, 'system');
  assert.equal(lineFor(nameless), '↩ Replying to @System', 'English reads as before');
  const card = quoteFromRow({ dataset: { sharedBy: 'Someone', sharedByUnknown: '', specTitle: 'Plan' }, classes: ['gc-spec-card'] });
  assert.equal(card.authorMissing, 'someone');
  assert.equal(labelFor(card).unnamed, 'someone');
  assert.equal(lineFor(card), '↩ Replying to @Someone');
  // Accounts really called "System" and "Someone" are named.
  const real = quoteFromRow({ dataset: { username: 'System' } });
  assert.equal(real.authorMissing, null);
  assert.equal(labelFor(real).unnamed, null);
  assert.equal(labelFor(real).label, '@System');
  const realSharer = quoteFromRow({ dataset: { sharedBy: 'Someone', specTitle: 'Plan' }, classes: ['gc-spec-card'] });
  assert.equal(labelFor(realSharer).unnamed, null);
  // The transcript writes the attribute the quote reads.
  const transcript = fs.readFileSync(path.join(root, 'frontend/src/features/group-chat/transcript.tsx'), 'utf8');
  assert.equal((transcript.match(/data-username-missing=\{msg\.usernameMissing \? '' : undefined\}/g) || []).length, 2);
  assert.match(transcript, /data-shared-by-unknown=\{spec\.sharedByUnknown \? '' : undefined\}/);
});
