'use strict';

// Reply chips over a project's group chat composer
// (frontend/src/features/group-chat/reply-starters.tsx), for somebody who has
// not said anything there yet: the first-session plan's "say something about
// the idea" for an invited newcomer, whose group chat already holds the
// maker's invite note. Pinned here: when they show, what they say, that a tap
// fills the composer rather than sending, and where they are drawn.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = 'frontend/src/features/group-chat/reply-starters.tsx';

const msg = (over = {}) => ({ id: 1, kind: 'message', mine: false, deleted: false, ...over });
const view = (messages, quiet = { exhausted: true, canPost: true, appName: 'Plant Pal' }) => ({
  messages,
  lead: { earlier: false, placeholder: null, quiet },
});

test('the chips show once someone else has spoken and the viewer has not', () => {
  const { startersDue } = loadTsx(SRC);
  // The maker's invite note, and nothing of the viewer's.
  assert.equal(startersDue(view([msg({ id: 1 })])), true);
  // Activity rows and proposal events are not somebody speaking.
  assert.equal(startersDue(view([msg({ kind: 'system' }), msg({ kind: 'vote' })])), false);
  // Nobody has spoken: that is the quiet card's moment, not the chips'.
  assert.equal(startersDue(view([])), false);
  // The viewer's first message hides them, whoever spoke first.
  assert.equal(startersDue(view([msg({ id: 1 }), msg({ id: 2, mine: true })])), false);
  // Even one they later deleted: they have posted here.
  assert.equal(startersDue(view([msg({ id: 1 }), msg({ id: 2, mine: true, deleted: true })])), false);
  // A deleted message is nobody speaking.
  assert.equal(startersDue(view([msg({ id: 1, deleted: true })])), false);
});

test('they ask only when "never posted" is knowable, and only someone who can post', () => {
  const { startersDue } = loadTsx(SRC);
  const rows = [msg({ id: 1 })];
  // Older pages unread: the viewer may have posted in one of them.
  assert.equal(startersDue(view(rows, { exhausted: false, canPost: true, appName: 'X' })), false);
  // A read-only viewer is not asked to say hi.
  assert.equal(startersDue(view(rows, { exhausted: true, canPost: false, appName: 'X' })), false);
  // A failed history load publishes no quiet facts.
  assert.equal(startersDue(view(rows, null)), false);
  assert.equal(startersDue(undefined), false);
});

test('three chips, in the words the plan chose', () => {
  const { REPLY_STARTERS } = loadTsx(SRC);
  // The table holds message ids; the catalog holds the words.
  assert.deepEqual(REPLY_STARTERS.map((s) => message(s.label)), ['\u{1F44B} Hi!', 'Love it!', 'Could it also…']);
  // "Could it also…" is a start: the caret waits after the space.
  assert.deepEqual(REPLY_STARTERS.map((s) => (s.open ? `${message(s.text)} ` : message(s.text))), ['\u{1F44B} Hi!', 'Love it!', 'Could it also ']);
  const html = renderComponent(SRC, 'ReplyStartersView', { onPick: () => {} });
  assert.match(html, /^<div role="group" aria-label="Start a reply" class="[^"]*" data-gc-reply-starters="">/);
  assert.equal((html.match(/<button type="button"/g) || []).length, 3, 'buttons, so a tap cannot submit the form');
  assert.ok(html.includes('>Could it also…</button>'));
});

test('a tap fills the composer and focuses it, caret at the end; it never sends', () => {
  // One message box (27 Nov 2026): the channel's box is Messages' own, so
  // the words go in through it (`putInComposer`), which saves the draft and
  // grows the field as anything typed does, and puts the caret after them.
  const src = read(SRC);
  assert.match(src, /export function startReply\(text: string\): void \{\n\s+const scope = shownChatScope\('general'\);\n\s+if \(scope != null\) putInComposer\(scope, text\);\n\}/);
  const box = read('frontend/src/features/messages/composer.tsx');
  assert.match(box, /emojiCaret\.current = Math\.min\(text\.length, 8000\);\n\s+updateValue\(text\);/);
  assert.match(box, /input\?\.focus\(\{ preventScroll: true \}\);/);
  // No box on the page: nothing to do, and nothing thrown.
  const { startReply } = loadTsx(SRC);
  assert.doesNotThrow(() => startReply('Hi'));
  assert.doesNotMatch(src, /\.send\(|requestSubmit|dispatchEvent\(new Event\('submit'/);
});

test('drawn in the general chat composer bar, above the reply chip and the form', () => {
  const src = read('frontend/src/features/group-chat/general-chat.tsx');
  assert.match(src, /import \{ ReplyStarters \} from '\.\/reply-starters';/);
  // Over the box's card, inside its bar (one message box, 27 Nov 2026).
  assert.match(src, /above=\{<ReplyStarters \/>\}/);
  // Inside the branch that has a composer: a read-only view has neither.
  const readOnly = src.indexOf('data-gc-readonly-notice');
  assert.ok(readOnly > 0 && readOnly < src.indexOf('<ReplyStarters />'));
  // Nothing in it on a cold render: the store is empty until the module publishes.
  const html = renderComponent('frontend/src/features/group-chat/general-chat.tsx', 'GeneralChat', {
    slug: 'demo', readOnly: false, notice: null,
  });
  assert.doesNotMatch(html, /data-gc-reply-starters/);
  assert.match(html, /id="gc-form"/);
});

test('only a view published since the pane mounted counts, so another channel\'s rows never ask', () => {
  const src = read(SRC);
  assert.match(src, /const \[atMount\] = useState\(view\);\s+if \(view === atMount \|\| !startersDue\(view\)\) return null;/);
  // The module publishes on every mount of the pane: render() for a channel
  // already open, and after the first history page for a new one.
  const gc = read('public/js/group-chat.js');
  assert.match(gc, /if \(GroupChat\.appSlug === appSlug && liveWs\) \{\s+GroupChat\.render\(\);/);
  assert.match(gc, /exhausted: !GroupChat\.hasMore,\s+canPost: !GroupChat\._readOnly\(\),/);
});
