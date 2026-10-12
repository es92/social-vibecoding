'use strict';

// #4564: the Homeroom bot's chat, one change at a time.
//
// Everything the bot says about one change is drawn as one outlined block
// that starts with that change's card: its status lines and its comments
// about the change sit inside the block, and the next change starts a new
// one. Pinned here:
//
//   1. The change a bot message is about (`changeKey`): the request its
//      metadata already names, never the words. The plan layout reads the
//      same key, so its step card and a block cannot disagree.
//   2. The blocks (`changeBlocks`): a run of adjacent bot messages about one
//      request is first / middle / last; a person's message, another
//      request, bot words about no request, a threaded row (a thread reply,
//      or the root a thread hangs off), a day divider and the unread line
//      each end a block; a skipped row (a card moved under its plan) does
//      not; and `repeat` is true only after a row that itself shows the
//      request. One request, one story retired the blocks for threaded rows:
//      a request's thread says which request its messages are about, so the
//      outline is left to the chat's history from before threads.
//   3. The drawing: a row drawn with its block wears the outline classes and
//      data, a row whose block repeats the request drops its request card
//      and speaks the card's label instead (its change's card stays), and a
//      row without a block draws as before. A ready card names its request
//      for a chip to find, and the stylesheet draws all four parts.
//
// Run with: node --test tests/messages-bot-change-blocks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BOT = { id: 2, username: 'homeroom_bot', bot: true, displayName: 'Homeroom bot' };
const ADA = { id: 7, username: 'ada' };
const SLUG = 'todo-list';
const MINUTE = 60 * 1000;

/** A message by `sender`, numbered in order, minutes apart so they group. */
function message(sender, n, over = {}) {
  return {
    id: n, conversationId: 42, sender,
    createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0) + n * MINUTE).toISOString(),
    reply: null, reactions: [], attachments: [], objects: [], deleted: false,
    ...over,
  };
}

/** The bot's message about request #n of the demo project. */
function botMessage(n, over = {}) {
  return message(BOT, n, {
    metadata: { homeroomBot: { kind: 'build_done', appSlug: SLUG, appName: 'Todo List', issueNumber: 7 } },
    content: '**Todo List** · request #7\n\nYour change is going live now.',
    ...over,
  });
}

// ── 1. The change a message is about ─────────────────────────────────────

test('a bot message names its request as app#number; anything else has none', () => {
  const { changeKey } = loadTsx('frontend/src/features/messages/bot-shared.ts');
  const bySlug = botMessage(1);
  assert.equal(changeKey(bySlug), 'todo-list#7');
  // No slug, the app's name says which project: an older message.
  assert.equal(changeKey(botMessage(2, { metadata: { homeroomBot: { kind: 'build_done', appName: 'Todo List', issueNumber: 7 } } })), 'Todo List#7');
  // A first version is request 1 under its own project, so it groups by project.
  assert.equal(changeKey(botMessage(3, { metadata: { homeroomBot: { kind: 'build_done', appSlug: SLUG, issueNumber: 1 } } })), 'todo-list#1');
  assert.equal(changeKey(message(ADA, 4)), null, 'a person’s message is about no change');
  assert.equal(changeKey(message(BOT, 5, { deleted: true })), null, 'a deleted one neither');
  assert.equal(changeKey(botMessage(6, { id: 0 })), null, 'nor one still sending');
  assert.equal(changeKey(botMessage(7, { metadata: { homeroomBot: { kind: 'hello', appSlug: SLUG } } })), null,
    'bot words about no request are about no change');
});

test('the plan layout reads the same change a block does', () => {
  const source = read('frontend/src/features/messages/bot-plan.tsx');
  assert.match(source, /import \{ changeKey \} from '\.\/bot-shared';/);
  assert.doesNotMatch(source, /function requestKey/, 'its own reading of the request is gone, so the two cannot disagree');
});

// ── 2. The blocks ─────────────────────────────────────────────────────────

const changeBlocksOf = (messages, over = {}) => {
  const { changeBlocks } = loadTsx('frontend/src/features/messages/bot-shared.ts');
  return changeBlocks(messages, {
    hidden: () => false,
    together: () => true,
    showsRequest: () => false,
    ...over,
  });
};

const parts = (blocks) => [...blocks.entries()].map(([id, block]) => [id, block.part, block.repeat]);

test('one message about one change is the whole block; three in a row are first, middle and last', () => {
  assert.deepEqual(parts(changeBlocksOf([botMessage(1)])), [[1, 'only', false]]);
  assert.deepEqual(parts(changeBlocksOf([botMessage(1), botMessage(2), botMessage(3)])), [
    [1, 'first', false], [2, 'middle', false], [3, 'last', false],
  ]);
});

test('a person’s message, another change, bot words about no request, a thread reply, a day and the unread line each end a block', () => {
  const { changeBlocks } = loadTsx('frontend/src/features/messages/bot-shared.ts');
  const opts = {
    hidden: () => false,
    together: () => true,
    showsRequest: () => false,
  };
  // A person between two bot messages: two blocks of one, theirs in neither.
  const withPerson = [botMessage(1), message(ADA, 2), botMessage(3)];
  assert.deepEqual(parts(changeBlocks(withPerson, opts)), [[1, 'only', false], [3, 'only', false]]);
  // Another request: the run restarts with the new one.
  const withOther = [botMessage(1), botMessage(2, { metadata: { homeroomBot: { kind: 'build_done', appSlug: SLUG, issueNumber: 8 } } })];
  assert.deepEqual(parts(changeBlocks(withOther, opts)), [[1, 'only', false], [2, 'only', false]]);
  // Bot words about no request: their own block never starts.
  const withKeyless = [botMessage(1), botMessage(2, { metadata: { homeroomBot: { kind: 'hello', appSlug: SLUG } } }), botMessage(3)];
  assert.deepEqual(parts(changeBlocks(withKeyless, opts)), [[1, 'only', false], [3, 'only', false]]);
  // A thread reply is drawn by its own row: not in a block, and it ends one.
  const withReply = [botMessage(1), botMessage(2, { threadRootId: 9 }), botMessage(3)];
  assert.deepEqual(parts(changeBlocks(withReply, opts)), [[1, 'only', false], [3, 'only', false]]);
  // One request, one story: a request's card with its thread under it is
  // that thread's root, which says which request it is; no block either.
  const thread = { replyCount: 3, lastReplyAt: null, participants: [], lastReply: null };
  const withRoot = [botMessage(1), botMessage(2, { thread }), botMessage(3), botMessage(4, { threadRootId: 2 })];
  assert.deepEqual(parts(changeBlocks(withRoot, opts)), [[1, 'only', false], [3, 'only', false]]);
  // A chat that is all threads draws no blocks at all.
  assert.deepEqual(parts(changeBlocks([botMessage(1, { thread }), botMessage(2, { threadRootId: 1 }), botMessage(3, { threadRootId: 1 })], opts)), []);
  // A day divider, or the unread line, between two: the loop says so through `together`.
  const acrossDays = [botMessage(1), botMessage(2, { createdAt: new Date(Date.UTC(2026, 9, 10, 12, 1)).toISOString() })];
  const apart = { ...opts, together: (a, b) => new Date(a.createdAt).toDateString() === new Date(b.createdAt).toDateString() };
  assert.deepEqual(parts(changeBlocks(acrossDays, apart)), [[1, 'only', false], [2, 'only', false]]);
  const acrossLine = { ...opts, together: (a, b) => !(a.id < 2 && b.id >= 2) };
  assert.deepEqual(parts(changeBlocks(acrossDays, acrossLine)), [[1, 'only', false], [2, 'only', false]]);
});

test('a skipped row (a card moved under its plan) does not break a block, and is in none', () => {
  const blocks = changeBlocksOf([botMessage(1), botMessage(2), botMessage(3)], {
    hidden: (m) => m.id === 2,
  });
  assert.deepEqual(parts(blocks), [[1, 'first', false], [3, 'last', false]]);
  assert.equal(blocks.get(2), undefined, 'the skipped row is drawn nowhere, so it holds no part');
});

test('repeat is true only from the row after the one that shows the request', () => {
  // The ready card shows the request; the merged news after it would repeat it.
  const shows = (m) => m.metadata.homeroomBot.shows === true;
  const ready = botMessage(1, { metadata: { homeroomBot: { kind: 'proposal', appSlug: SLUG, issueNumber: 7, shows: true } } });
  const merged = botMessage(2);
  const again = botMessage(3);
  assert.deepEqual(parts(changeBlocksOf([ready, merged, again], { showsRequest: shows })), [
    [1, 'first', false], [2, 'middle', true], [3, 'last', true],
  ]);
  // And a run that shows it nowhere repeats nowhere.
  assert.deepEqual(parts(changeBlocksOf([botMessage(1), botMessage(2)], { showsRequest: shows })), [
    [1, 'first', false], [2, 'last', false],
  ]);
});

// ── 3. The drawing ────────────────────────────────────────────────────────

// One window, the way the row's modules read it (./lib/render-tsx notes).
globalThis.window = {
  App: { user: ADA },
  location: { search: '', hash: '#messages/42' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

const MERGED_META = { kind: 'merged', appSlug: SLUG, appName: 'Todo List', issueNumber: 7, sessionId: 41 };
const REQUEST_LINE = `**Todo List** · request #7: Sort the list`;
const MERGED_WORDS = 'Your change is going live now and will be ready in a few minutes.';
const CHANGE_CARD = { type: 'proposal', available: true, appSlug: SLUG, sessionId: 41, title: 'Sort the list', state: 'live' };

function mergedRow(over = {}) {
  return message(BOT, 11, {
    metadata: { homeroomBot: MERGED_META },
    content: `${REQUEST_LINE}\n\n${MERGED_WORDS}`,
    objects: [CHANGE_CARD],
    ...over,
  });
}

test('a repeated row draws as the end of its block: no request card, the change’s card stays, the label spoken', () => {
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  const html = renderToHtml(createElement(MessageRow, {
    message: mergedRow(), conversationId: 42, grouped: true,
    block: { key: 'todo-list#7', part: 'last', repeat: true },
  }));
  // The outline, on the row and its content column.
  assert.match(html, /class="messages-message group messages-message-grouped messages-bot-block messages-bot-block-last /);
  assert.match(html, /data-bot-block="todo-list#7" data-bot-block-part="last"/);
  assert.match(html, /class="min-w-0 flex-1 messages-bot-block-body"/);
  // The request card is gone — the top of the block already shows it.
  assert.doesNotMatch(html, /data-bot-head-card/);
  // The change's own card is not a repeat: still drawn under the words.
  assert.match(html, /messages-object-list/);
  // And the words say which request they are about, spoken.
  assert.match(html, /<span class="sr-only">Request #7: Sort the list<\/span>/);
  assert.match(html, /going live now/);
});

test('the same row without a block draws as it always did', () => {
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  const html = renderToHtml(createElement(MessageRow, { message: mergedRow(), conversationId: 42, grouped: true }));
  assert.doesNotMatch(html, /messages-bot-block/);
  assert.doesNotMatch(html, /data-bot-block/);
  assert.match(html, /data-bot-head-card="request"/, 'the request’s card, where no block repeats it');
  assert.doesNotMatch(html, /sr-only">Request #7/);
});

test('a ready card names its request for a chip to find', () => {
  const { ReadyCardView } = loadTsx('frontend/src/features/messages/bot-ready.tsx');
  const meta = { kind: 'proposal', appSlug: SLUG, appName: 'Todo List', issueNumber: 7, ready: {} };
  const html = renderToHtml(createElement(ReadyCardView, {
    meta, state: 'open',
    actions: [{ id: 1, type: 'preview', label: 'Try it', sessionId: 41 }],
    now: new Date(Date.UTC(2026, 9, 9, 12, 0)),
  }));
  assert.match(html, /data-bot-ready-request="todo-list#7"/);
  assert.match(html, /data-bot-ready="open"/);
  // A card that names no request — a first version's — carries no key.
  const first = renderToHtml(createElement(ReadyCardView, {
    meta: { ...meta, issueNumber: 1, firstVersion: true }, state: 'open',
    actions: [{ id: 2, type: 'preview', label: 'Try it', sessionId: 41 }],
    now: new Date(Date.UTC(2026, 9, 9, 12, 0)),
  }));
  assert.doesNotMatch(first, /data-bot-ready-request/);
});

test('a chip finds the ready card leading its block, like an activity card', () => {
  globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
  const { findRequestCard } = loadTsx('frontend/src/features/messages/ref-cards.tsx');
  // A transcript in document order, just big enough for findRequestCard —
  // the same shim tests/messages-ref-chip-cards.test.js reads it with.
  const doc = {};
  const els = [];
  doc.querySelectorAll = () => els.filter((el) => el.card);
  for (const [i, spec] of [
    { id: 'ready', card: 'ready', attrs: { 'data-bot-ready-request': 'todo-list#7' } },
    { id: 'chip' },
  ].entries()) {
    els.push({
      ...spec,
      order: i,
      ownerDocument: doc,
      getAttribute: (name) => (spec.attrs || {})[name] ?? null,
      matches: (sel) => sel === 'a.messages-object-card' && spec.card === 'object',
      closest: (sel) => (sel === '.messages-thread-scroll' ? doc : null),
      compareDocumentPosition: (other) => (other.order > i ? 4 : 2),
    });
  }
  assert.equal(findRequestCard(els[1], SLUG, 7).id, 'ready');
  assert.equal(findRequestCard(els[1], SLUG, 8), null);
});

test('the transcript asks for the blocks in the bot’s DM alone, and passes each row its part', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /if \(!botDm\) return \{ plans: NO_PLAN_LAYOUT, blocks: null as ReadonlyMap<number, ChangeBlock> \| null \};/,
    'other kinds of chat get no blocks at all');
  assert.match(screen, /block=\{blocks\?\.get\(message\.id\) \?\? null\}/);
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /block = null,/);
  assert.match(row, /block\?\.repeat && head\?\.kind === 'request'/, 'only a repeated request card is dropped');
  assert.match(row, /!isReadyMessage\(message\)/, 'a card standing in place of the words keeps its head');
});

test('the stylesheet draws every part of the block from the one hairline', () => {
  const css = read('public/css/app.css');
  for (const part of ['first', 'middle', 'last', 'only']) {
    assert.match(css, new RegExp(`\\.messages-bot-block-${part}`), `the ${part} part is drawn`);
  }
  assert.match(css, /\.messages-bot-block-body \{[^}]*border-left: 1px solid var\(--app-sheet-line\);[^}]*border-right: 1px solid var\(--app-sheet-line\);/);
  assert.match(css, /\.messages-bot-block-first \.messages-bot-block-body,[\s\S]{0,200}?border-top: 1px solid var\(--app-sheet-line\);[\s\S]{0,200}?border-radius: 20px 20px 0 0;/);
  assert.match(css, /\.messages-bot-block-last \.messages-bot-block-body,[\s\S]{0,200}?border-bottom: 1px solid var\(--app-sheet-line\);[\s\S]{0,200}?border-radius: 0 0 20px 20px;/);
  assert.match(css, /\.messages-bot-block-first, \.messages-bot-block-middle \{ padding-bottom: 0; \}/);
  assert.match(css, /\.messages-bot-block-middle, \.messages-bot-block-last \{ padding-top: 0; \}/);
});
