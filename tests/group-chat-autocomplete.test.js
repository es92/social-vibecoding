// The group chat's autocomplete menus — `@name`, `#123` / `PR#123` and the
// `:shortcode` emoji menu.
//
// ── One message box, one set of menus (27 Nov 2026) ───────────────────
//
// They were three controllers in public/js/group-chat.js (MentionAutocomplete,
// RefAutocomplete, EmojiAutocomplete), each with a body-level host
// (`#gc-mention-menu`, `#gc-ref-menu`, `#gc-emoji-menu`) whose rows were
// features/group-chat/autocomplete.tsx's. A project chat's box is Messages'
// own now (features/group-chat/composer.tsx renders
// features/messages/composer.tsx MessageBox), and its menus are that box's:
// rows a person's name or an issue title reach as React text, never markup,
// the highlighted row driven through `aria-activedescendant`. What a
// project's chat offers them is features/group-chat/chat-sources.ts
// (tests/feed-reply-mentions.test.js and tests/feed-reply-refs.test.js).
//
// Run with: node --test tests/group-chat-autocomplete.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const gcJs = read('public/js/group-chat.js');
const BOX = read('frontend/src/features/messages/composer.tsx');

test('the chat has no menus of its own: its box is Messages\' box', () => {
  assert.doesNotMatch(gcJs, /const (Mention|Ref|Emoji)Autocomplete = \{/, 'the three controllers are gone');
  assert.doesNotMatch(gcJs, /gc-(mention|ref|emoji)-menu/, 'and their body-level hosts');
  assert.equal(fs.existsSync(path.join(root, 'frontend/src/features/group-chat/autocomplete.tsx')), false);
  const mount = read('frontend/src/features/group-chat/mount.ts');
  assert.doesNotMatch(mount, /mount(Mention|Ref|Emoji)Menu|publish(Mention|Ref|Emoji)Menu/);
  assert.match(read('frontend/src/features/group-chat/composer.tsx'), /return <MessageBox place=\{place\} scroller=\{scroller\} \/>;/);
});

test('the box\'s menus draw what a person typed as text, and drive the field by aria-activedescendant', () => {
  // A ref row: its label, then its name (a request's title) in a span, both
  // as React children.
  assert.match(BOX, /onClick=\{\(\) => insertChannel\(item\)\}>\{item\.label\}\{item\.name \? <span className="messages-channel-option-name"> \{item\.name\}<\/span> : null\}<\/button>/);
  // A person's row: `@` and what a pick inserts.
  assert.match(BOX, /onClick=\{\(\) => insertMention\(member\.insert \|\| member\.username\)\}>@\{member\.insert \|\| member\.username\}<\/button>/);
  assert.doesNotMatch(BOX, /dangerouslySetInnerHTML/);
  assert.match(BOX, /aria-activedescendant=\{activeOption >= 0 \? optionId\(activeOption\) : undefined\}/);
});

// ── #4629: the panel opens its page where React allows the flushSync ────
//
// The side panel's mount effect used to call `openTopicInPanel` directly in
// its body. That mount publishes through `flushSync`
// (frontend/src/lib/legacy-portals.tsx), and React drops a flushSync raised
// while it is still committing — an effect body is inside the commit. So
// GroupChat.mountThread read its container before the thread shell was in
// the DOM, found no `#gc-thread-input`, and skipped the whole composer
// wiring: submit, the draft, Enter, attachments, and the
// MentionAutocomplete / RefAutocomplete / EmojiAutocomplete attaches whose
// retargets the #4571 tests above pin. Typing @, # or : in the panel's
// Reply box opened nothing, while the full change page was fine (its
// `_renderTopicSubView` mounts outside any effect). The open now waits for
// the next microtask, where React allows the flushSync, as
// actions-row.tsx already does for the kanban filter bar.

const SIDE_PANEL = read('frontend/src/features/dev-board/workshop/side-panel.tsx');
const PANEL_EFFECT = SIDE_PANEL.slice(
  SIDE_PANEL.indexOf('useEffect(() => {') + 'useEffect(() => {'.length,
  SIDE_PANEL.indexOf('}, [item.kind, item.id]);'),
);

test('the panel reaches openTopicInPanel only through queueMicrotask (#4629)', () => {
  assert.match(PANEL_EFFECT,
    /queueMicrotask\(\(\) => \{ if \(live\) void callAppView\('openTopicInPanel', item\.kind, item\.id\); \}\);/,
    'the open waits for the microtask, where the flushSync is allowed');
  assert.doesNotMatch(
    PANEL_EFFECT.replace(/queueMicrotask\(\(\) => \{[^}]*\}\);/, ''),
    /callAppView\('openTopicInPanel'/,
    'nothing calls it directly in the effect body',
  );
});

test('the panel effect defers the open, and a cleanup before it skips it (#4629)', () => {
  // The effect body as written, run against stubs: what it queues and what
  // it calls. The composer wiring depends on the open NOT running
  // synchronously — that is the flushSync-in-a-commit the module comment
  // describes — and on a panel gone before the microtask never opening.
  const runEffect = new Function('item', 'callAppView', 'queueMicrotask', PANEL_EFFECT);
  const calls = [];
  const queued = [];
  const cleanup = runEffect(
    { kind: 'proposal', id: 51 },
    (name, kind, id) => calls.push([name, kind, id]),
    (fn) => queued.push(fn),
  );
  assert.deepEqual(calls, [], 'nothing is called synchronously (the commit is still running)');
  assert.equal(queued.length, 1, 'the open is queued for the microtask');
  for (const fn of queued.splice(0)) fn();
  assert.deepEqual(calls, [['openTopicInPanel', 'proposal', 51]],
    'flushing the microtask opens the page');

  // Switching rows or closing the panel before the microtask runs: the
  // cleanup closes its own item, and the queued open is a no-op.
  const calls2 = [];
  const queued2 = [];
  const cleanup2 = runEffect(
    { kind: 'proposal', id: 51 },
    (name, kind, id) => calls2.push([name, kind, id]),
    (fn) => queued2.push(fn),
  );
  cleanup2();
  assert.deepEqual(calls2, [['closeTopicPanel', 'proposal', 51]],
    'the cleanup closes the panel’s item');
  for (const fn of queued2) fn();
  assert.deepEqual(calls2, [['closeTopicPanel', 'proposal', 51]],
    'the skipped open never calls openTopicInPanel');
});
