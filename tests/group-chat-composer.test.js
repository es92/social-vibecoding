// The group chat's two boxes — a channel's pane's and a thread's page's.
//
// ── One message box (27 Nov 2026) ─────────────────────────────────────
//
// After #1191 the two were one component (a form, a reply strip, an error
// line and an uploads strip, with the listeners, drafts and menus in
// public/js/group-chat.js). They are Messages' box now
// (features/messages/composer.tsx MessageBox), with the chat as its place
// (features/group-chat/composer.tsx ChatComposer). What this file pins:
//
//   1. Each scope renders the box under the ids the module, the request
//      page's plan card and the declared checks read back.
//   2. The staged reply: the module publishes it per scope, and the box's
//      chip words it as the chat always did.
//   3. A send goes over the chat's socket, to the thread the box is for.
//   4. The status line, which stays the chat's.
//
// Run with: node --test tests/group-chat-composer.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const COMPOSER = 'frontend/src/features/group-chat/composer.tsx';
const gcJs = read('public/js/group-chat.js');
const appView = read('public/js/app-view.js');
const stripped = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const box = (scope, extra = {}) => renderComponent(COMPOSER, 'ChatComposer', {
  scope,
  slug: 'demo',
  ...(scope === 'thread' ? { thread: { type: 'issue', ref: 7 } } : {}),
  placeholder: 'Type a message...',
  ...extra,
});

// ── The pair ──────────────────────────────────────────────────────────

test('both scopes render Messages\' box under their own ids', () => {
  const general = box('general');
  const thread = box('thread');
  for (const [g, t] of [
    ['gc-form', 'gc-thread-form'],
    ['gc-attach-btn', 'gc-thread-attach-btn'],
    ['gc-file-input', 'gc-thread-file-input'],
    ['gc-input', 'gc-thread-input'],
  ]) {
    assert.match(general, new RegExp(`id="${g}"`), `general has #${g}`);
    assert.match(thread, new RegExp(`id="${t}"`), `thread has #${t}`);
    assert.ok(!general.includes(`id="${t}"`), `general does not carry #${t}`);
  }
  // The card is Messages' card, the field Messages' field.
  assert.match(thread, /^<div class="messages-composer messages-composer-thread chat-composer-bar platform-safe-bar"><div class="messages-composer-card" id="gc-thread-form">/);
  assert.match(general, /^<div class="messages-composer chat-composer-bar platform-safe-bar"><div class="messages-composer-card" id="gc-form">/);
  assert.match(thread, /<textarea id="gc-thread-input"[^>]*placeholder="Type a message\.\.\."[^>]*class="messages-composer-input">/);
  // A topic's channel is a channel: it formats as Messages' channels do.
  assert.match(general, /class="messages-format-bar"/);
  assert.doesNotMatch(thread, /messages-format-bar/);
  // The old form, strips and error line are gone, with their ids.
  for (const gone of ['gc-reply-preview', 'gc-attach-error', 'gc-attachments', 'gc-composer-card', 'gc-send']) {
    assert.ok(!general.includes(gone) && !thread.includes(gone), `${gone} is gone`);
  }
});

test('the module reads back only what it focuses, and wires nothing', () => {
  const code = stripped(gcJs);
  // setQuote puts the caret in the box the quote was staged in.
  assert.match(code, /document\.getElementById\('gc-thread-input'\)/);
  assert.match(code, /document\.getElementById\('gc-input'\)/);
  // No listeners, drafts or uploads of its own any more.
  assert.doesNotMatch(code, /setupAttachments|getDraft|setDraft|_addFiles|addEventListener\('submit'/);
  assert.doesNotMatch(stripped(appView), /getElementById\('gc-form'\)|getElementById\('gc-input'\)/);
});

test('a send goes over the chat\'s socket, with the box\'s files, to the thread the box is for', () => {
  const src = read(COMPOSER);
  assert.match(src, /const posts = scope === 'thread' \? thread : null;/);
  assert.match(src, /send: \(input\) => \{ controller\(\)\?\.send\?\.\(input\.content, posts, input\.attachmentIds\); \},/);
  assert.match(src, /upload: \(file\) => uploadChatFile\(slug, file\),/);
  assert.match(src, /typing: \(on\) => \{ if \(on\) controller\(\)\?\.sendTyping\?\.\(posts\); \},/);
  const send = stripped(gcJs).match(/\n {2}send\(content, thread, attachmentIds\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(send, 'GroupChat.send takes the box\'s files');
  assert.match(send[1], /if \(ids\.length\) payload\.attachmentIds = ids;/);
});

// ── The staged reply ──────────────────────────────────────────────────

test('the staged reply is the box\'s chip, worded as the chat words it', () => {
  const { replyChip } = require('./lib/render-tsx').loadTsx(COMPOSER);
  const t = (id, values) => message(id, values);
  assert.deepEqual(
    (({ title, snippet }) => ({ title, snippet }))(replyChip(t, { label: '@alice', snippet: 'the original line' })),
    { title: '↩ Replying to @alice', snippet: 'the original line' },
  );
  assert.equal(replyChip(t, { label: '', unnamed: 'event', snippet: 'x' }).title, '↩ Replying to a platform message');
  assert.equal(replyChip(t, { label: '', unnamed: 'message', snippet: 'x' }).title, '↩ Replying to a message');
  assert.match(read(COMPOSER), /reply: slot\.quote \? replyChip\(t, slot\.quote\) : null,\s*cancelReply: \(\) => controller\(\)\?\.clearQuote\?\.\(\),/);
});

test('the module publishes the staged reply to both scopes, and no longer paints', () => {
  const code = stripped(gcJs);
  const fn = code.match(/_renderQuotePreview\(\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_renderQuotePreview() found');
  assert.doesNotMatch(fn[1], /innerHTML|classList|getElementById/);
  // #2387: to the scope the quote was staged in — both composers can be on
  // screen at once now — and to both only when no scope is known.
  assert.match(fn[1], /_publishComposer\('general', \{ quote: !scope \|\| scope === 'general' \? view : null \}\)/);
  assert.match(fn[1], /_publishComposer\('thread', \{ quote: !scope \|\| scope === 'thread' \? view : null \}\)/);
  // The label the sources produce: a PR number, an @author, or what an
  // authorless row is (#2391).
  assert.match(fn[1], /q\.prNumber \? PlatformI18n\.t\('chat:group\.quote\.pr', \{ number: q\.prNumber \}\) : PlatformI18n\.t\('chat:group\.quote\.prUnnumbered'\)/);
  assert.equal(message('chat:group.quote.pr', { number: 12 }), 'PR 12');
  assert.equal(message('chat:group.quote.prUnnumbered'), 'PR');
  assert.match(fn[1], /pr: q\.source === 'pr' \? String\(q\.prNumber \|\| ''\) : null,/, 'a pull request is not passed as a name');
  assert.match(fn[1], /q\.author \? `@\$\{q\.author\}` : ''/);
  // An authorless row has a sentence of its own: the module says which, and
  // the strip reads it from the catalog.
  assert.match(fn[1], /unnamed: q\.source === 'pr' \? null\s*: q\.authorMissing && q\.author \? q\.authorMissing\s*: q\.author \? null : \(q\.source === 'event' \? 'event' : 'message'\)/);
  assert.equal(message('chat:group.composer.replyingToPlatform'), '↩ Replying to a platform message');
  assert.equal(message('chat:group.composer.replyingToMessage'), '↩ Replying to a message');
});

test('the status line is one slot with two owners, and both publish', () => {
  // 1 November 2026: the chat foot's status line (ChatStatusLine), sized by
  // app.css's `.chat-status` rather than by each caller's Tailwind, and a
  // live region, as Messages' typing line is.
  const html = renderComponent(COMPOSER, 'StatusLineView', {
    scope: 'general', status: 'bob is typing...',
  });
  assert.equal(html, '<div id="gc-typing" class="chat-status" aria-live="polite">bob is typing...</div>');
  // Empty, it has no child at all, so `.chat-status:empty` takes its room.
  assert.equal(
    renderComponent(COMPOSER, 'StatusLineView', { scope: 'thread', status: '' }),
    '<div id="gc-thread-typing" class="chat-status" aria-live="polite"></div>',
  );

  const code = stripped(gcJs);
  const fn = code.match(/_renderStatusLine\(\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_renderStatusLine() found');
  assert.doesNotMatch(fn[1], /getElementById|textContent/);
  // Connection state still WINS over typing when the socket is down: it is
  // the actionable one, and a typing notice from a stale state misleads.
  assert.match(fn[1], /queued > 0 \? PlatformI18n\.t\('chat:group\.status\.reconnectingQueued', \{ count: queued \}\) : PlatformI18n\.t\('chat:group\.status\.reconnecting'\)/);
  assert.equal(message('chat:group.status.reconnectingQueued', { count: 2 }), 'Reconnecting… (2 queued)');
  assert.equal(message('chat:group.status.reconnecting'), 'Reconnecting…');
  assert.match(fn[1], /_publishComposer\('general'/);
  assert.match(code, /_publishComposer\('thread', \{ status: PlatformI18n\.t\('chat:group\.typing\.one', \{ name: username \}\) \}\)/);
  assert.equal(message('chat:group.typing.one', { name: 'bob' }), 'bob is typing...');
});

test('the general chat pane is mounted, not assigned', () => {
  const code = stripped(appView);
  const fn = code.match(/renderGroupChatTab\(ctx\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, 'renderGroupChatTab() found');
  assert.doesNotMatch(fn[1], /innerHTML/, 'the tab builds no markup');
  assert.match(fn[1], /mountGeneralChat\(content, \{/);
  // Rule 1: the transcript's portal points INTO #gc-messages, so it goes
  // before the shell re-renders — the read-only branch does not emit that
  // element at all.
  assert.match(fn[1], /unmountTranscript\(previousList\)/);
  assert.ok(fn[1].indexOf('unmountTranscript') < fn[1].indexOf('mountGeneralChat'));
  // No first-arrival banner any more (the owner, 6 October 2026): the
  // Discussion tab says what it is.
  assert.doesNotMatch(fn[1], /usernode_seen_gc_intro|introAppName/);
  assert.doesNotMatch(read('frontend/src/features/group-chat/general-chat.tsx'), /talks and votes on proposed changes|introAppName/);
});

// #6228 (3 Nov 2026): the status slot under a request's thread says what
// Homeroom bot is doing with the newest reply, in the bot chip's own style.
test('#6228: the bot\'s reply line, and typing takes the slot first', () => {
  const view = (extra) => renderComponent(COMPOSER, 'StatusLineView', { scope: 'thread', status: '', ...extra });
  const says = (html, id) => assert.ok(html.includes(message(id)), `${id} in ${html}`);
  const will = view({ bot: { state: 'will_read', mine: true } });
  says(will, 'chat:group.botStatus.willRead');
  assert.match(will, /data-bot-status="will_read"/);
  assert.match(will, /--brand-tint/, 'the bot chip\'s style');
  assert.match(will, /👀/);
  // The person who wrote it sees "your reply"; everybody else "the reply".
  says(view({ bot: { state: 'reading', mine: true } }), 'chat:group.botStatus.readingYours');
  says(view({ bot: { state: 'reading', mine: false } }), 'chat:group.botStatus.reading');
  const quiet = view({ bot: { state: 'quiet', mine: true } });
  says(quiet, 'chat:group.botStatus.quiet');
  assert.doesNotMatch(quiet, /👀/, 'nothing to add carries no glyph');
  // Someone typing takes the line; the bot's comes back when they stop.
  assert.equal(view({ status: 'bob is typing...', bot: { state: 'reading', mine: true } }),
    '<div id="gc-thread-typing" class="chat-status" aria-live="polite">bob is typing...</div>');
  // Neither: the slot is empty.
  assert.equal(view({}), '<div id="gc-thread-typing" class="chat-status" aria-live="polite"></div>');
});
