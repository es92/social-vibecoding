'use strict';

// The phone smoothness audit's React islands (#3104 follow-up). Each of these
// re-rendered, or rebuilt DOM, for a change it does not draw:
//
//   1. App chat: no row was memoized, and a whole publish from
//      public/js/group-chat.js (`GroupChat.render()`, after a delete, a
//      history page, a membership change) rebuilt every row object, so every
//      row rendered again; the thread head was a fresh copy each render.
//   2. Messages inbox: every keystroke in the search box re-ran buildInbox and
//      re-rendered every row, and so did every publish of the agent
//      sessions' store (and of Global Chat's, before it was removed).
//   3. Topic head: nine blocks of another renderer's markup took an inline
//      `{ __html }` object, and the head republishes on the 20s checks poll
//      and on websocket events, so each block's innerHTML (the before/after
//      tiles' images included) was rebuilt each time.
//   4. Workshop Needs-you deck: typing in Ask, and each token of its answer,
//      re-rendered every item of the deck.
//   5. Global chat store: a patch that changed nothing still notified. Its
//      pin left with Global Chat.
//   6. Auto-growing text boxes: two layouts per keystroke.
//   7. lib/browser-scroll.ts (see tests/browser-scroll.test.js).
//
// Run with: node --test tests/react-islands-render-cost.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement, renderComponent } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const MEMO = Symbol.for('react.memo');

// ── 1. App chat ─────────────────────────────────────────────────────────

const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const TRANSCRIPT_API = 'tests/fixtures/group-chat-transcript-api.ts';

/** A row as `GroupChat._messageView` builds it: a fresh object, nested arrays and all. */
const row = (id, over = {}) => ({
  id, kind: 'message', username: 'evan', time: '09:05 AM', timeTitle: 'Sep 16, 2026, 09:05 AM',
  at: '2026-09-16T09:05:00Z', bodyHtml: `<p>message ${id}</p>`, systemText: '', mine: false,
  editedTitle: null, unread: false, bookmarked: false, canEdit: false, flash: false,
  showEdit: false, showBookmark: true, showReact: true, quote: null,
  reactions: [{ emoji: '👍', count: 1, users: ['ana'], mine: false }],
  attachments: [], voteRowClass: '', voteRef: null, specShare: null, event: null, eventHref: null,
  thread: null, canThread: true, threadRoot: false, replyOf: null, text: `message ${id}`,
  ...over,
});

test('app chat rows are memo()\'d', () => {
  const mod = loadTsx(TRANSCRIPT);
  for (const name of ['MessageRow', 'SystemRow', 'SpecShareRow']) {
    assert.equal(mod[name].$$typeof, MEMO, `${name} skips a render when its row is unchanged`);
  }
  assert.equal(loadTsx('frontend/src/features/group-chat/proposal-event.tsx').EventRow.$$typeof, MEMO);
});

test('a whole publish keeps every row that says nothing new, so its memo()\'d row skips', () => {
  const api = loadTsx(TRANSCRIPT_API);
  const rows = () => api.transcriptStore.get().byKey.main.messages;
  api.publishTranscript([row(1), row(2), row(3)]);
  const first = rows();

  // group-chat.js rebuilds every row object on a whole publish.
  api.publishTranscript([row(1), row(2), row(3)]);
  assert.equal(rows(), first, 'nothing changed: the same list, so not even the fold runs again');

  api.publishTranscript([row(1), row(2, { reactions: [{ emoji: '👍', count: 2, users: ['ana', 'bo'], mine: false }] }), row(3), row(4)]);
  const next = rows();
  assert.notEqual(next, first);
  assert.equal(next[0], first[0], 'an unchanged row is the object already on screen');
  assert.equal(next[2], first[2]);
  assert.notEqual(next[1], first[1], 'the changed row is new');
  assert.equal(next[1].reactions[0].count, 2);
  assert.equal(next[3].id, 4, 'and a new row is added');

  // A row that differs only deep inside (an attachment) is still a change.
  api.publishTranscript([row(1, { attachments: [{ id: 'a', kind: 'file', name: 'x', url: '/x', size: '1 KB', badge: null }] }), row(2), row(3)]);
  assert.notEqual(rows()[0], next[0]);
});

test('the open reply thread lights its chip through a prop, read on every render of the rows', () => {
  // MessageRow is memo()'d, so it must not read the controller for anything
  // it draws: the answer would stay what it was at its last render.
  const src = read(TRANSCRIPT);
  const messageRow = src.slice(src.indexOf('export const MessageRow = memo('), src.indexOf('export function Transcript('));
  assert.doesNotMatch(messageRow, /isReplyThreadOpen/, 'the row takes it as `threadOpen`');
  assert.match(src, /const threadOpen = main && !!msg\.thread && msg\.id != null && !!controller\(\)\?\.isReplyThreadOpen\?\.\(msg\.id\);/);
  assert.match(src, /msg=\{threadHead\(msg\)\}/, 'the thread head is one copy per message, not one per render');

  const summary = { replyCount: 2, lastReplyAt: null, participants: ['ana'] };
  const view = { messages: [row(5, { thread: summary }), row(6, { thread: summary })], lead: { earlier: false, placeholder: null } };
  // addEventListener because the bundle now reaches lib/back-stack.ts (the
  // image viewer, #3286), which listens for popstate when it loads.
  globalThis.window = { GroupChat: { isReplyThreadOpen: (id) => Number(id) === 5, _readOnly: () => false }, addEventListener() {} };
  try {
    const html = renderComponent(TRANSCRIPT, 'TranscriptRows', { view, source: 'main' });
    const chips = html.match(/msgx-thread-chip[^"]*/g) || [];
    assert.equal(chips.length, 2, 'both rows carry their thread chip');
    assert.equal(chips.filter((c) => c.includes('msgx-thread-chip-active')).length, 1, 'only the open one is lit');
    assert.ok(html.indexOf('msgx-thread-chip-active') < html.indexOf('message 6'), 'and it is row 5\'s');
  } finally {
    delete globalThis.window;
  }
});

// ── 2. Messages inbox ───────────────────────────────────────────────────

test('the inbox rows are memo()\'d and the list filters on the deferred query', () => {
  const src = read('frontend/src/features/messages/index.tsx');
  for (const name of ['ConversationRow', 'GeneralChannelRow', 'AppChannelRow', 'AgentSessionRow', 'MayorSessionRow']) {
    assert.match(src, new RegExp(`^const ${name} = memo\\(function ${name}\\(`, 'm'), `${name} is memo()'d`);
  }
  const list = src.slice(src.indexOf('function ConversationList('));
  const body = list.slice(0, list.indexOf('\n}\n'));
  assert.match(body, /const deferredQuery = useDeferredValue\(query\);/);
  assert.match(body, /const q = deferredQuery\.trim\(\)\.toLowerCase\(\);/, 'rows are matched against the deferred query');
  assert.match(body, /value=\{query\}/, 'while the field shows every keystroke at once');
  assert.match(body, /const inbox = useMemo\(\(\) => buildInbox\(/, 'the inbox is built once per change to its inputs');
  // Other stores are read through the fields the list draws.
  assert.match(body, /const mayorSessions = useAgentSessions\(\);/);
  assert.doesNotMatch(body, /useAgentSessionState\(/);
});

// ── 3. Topic head ───────────────────────────────────────────────────────

test('the topic head draws its markup blocks through Html, which keeps the { __html } object', () => {
  const src = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.doesNotMatch(src, /dangerouslySetInnerHTML=\{\{/, 'no inline wrapper left');
  // #4455: the change page's summary and its picture moved to change-head.tsx
  // (the root post), and Details gained the shots' details.
  assert.equal((src.match(/<Html /g) || []).length, 9, 'the nine blocks: summaries, the summary’s folded rest, bodies, details, shot details, testing and the tile host');
  const change = read('frontend/src/features/dev-board/topic/change-head.tsx');
  assert.doesNotMatch(change, /dangerouslySetInnerHTML=\{\{/, 'nor in the change page’s root post');
  assert.equal((change.match(/<Html /g) || []).length, 2, 'the verified shots and the capture tiles');
  assert.match(src, /<Html className="usn-visuals-body" html=\{tiles\.tilesHtml\} \/>/);

  const lib = read('frontend/src/lib/html.tsx');
  assert.match(lib, /return useMemo\(\(\) => \(\{ __html: html \}\), \[html\]\);/);
  const { Html } = loadTsx('frontend/src/lib/html.tsx');
  assert.equal(Html.$$typeof, MEMO, 'and skips a parent\'s re-render with the same props');
  // Like-for-like with the div it replaced.
  assert.equal(
    renderToHtml(createElement(Html, { className: 'dev-topic-hero-summary dev-topic-about-body', 'data-topic-part': 'summary', html: '<p>Hi <b>there</b></p>' })),
    '<div class="dev-topic-hero-summary dev-topic-about-body" data-topic-part="summary"><p>Hi <b>there</b></p></div>',
  );
});

// ── 4. Workshop Needs-you deck ──────────────────────────────────────────

test('a Needs-you item does not re-render for the Ask sheet\'s keystrokes or streamed answer', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(src, /^const FeedItem = memo\(function FeedItem\(/m);
  const feed = src.slice(src.indexOf('function NeedsFeed('), src.indexOf('function GroupStrip('));
  assert.match(feed, /const openFull = useCallback\(\(el: HTMLElement\) => callAppView\(/, 'the one callback an item takes is stable');
  assert.match(feed, /onFull=\{openFull\}/);
});

// ── 6. Auto-growing text boxes ──────────────────────────────────────────

/**
 * A textarea that lays itself out only when read after a change, and counts
 * those layouts. Its content is `perLine` characters a line; `height: auto`
 * is one line tall (rows=1), and a set height is border-box.
 */
function textarea({ line = 20, pad = 16, perLine = 30, border = 1 } = {}) {
  let dirty = true;
  let layouts = 0;
  let height = '';
  const lines = (v) => v.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  const content = () => lines(el.value) * line + pad;
  const box = () => (height === 'auto' || height === '' ? line + pad : parseFloat(height) - 2 * border);
  const layout = () => { if (dirty) { layouts += 1; dirty = false; } };
  const el = {
    value: '',
    style: {
      get height() { return height; },
      set height(v) { if (v !== height) { height = v; dirty = true; } },
    },
    get scrollHeight() { layout(); return Math.max(content(), box()); },
    get clientHeight() { layout(); return box(); },
  };
  return {
    el,
    set(v) { el.value = v; dirty = true; },
    /** The layout the browser does before painting, if one is owed. */
    paint: layout,
    get layouts() { return layouts; },
    drag(px) { height = `${px}px`; dirty = true; },
    content,
  };
}

test('typing costs one layout a keystroke, and the box still fits its text', () => {
  const { fitToContent } = loadTsx('frontend/src/lib/use-auto-grow.ts');
  const box = textarea();
  const text = 'the quick brown fox jumps over the lazy dog, again and again';
  fitToContent(box.el, '');
  box.paint();
  const start = box.layouts;
  for (let i = 1; i <= text.length; i += 1) {
    box.set(text.slice(0, i));
    fitToContent(box.el, box.el.value);
    box.paint();
  }
  const perKey = (box.layouts - start) / text.length;
  assert.ok(perKey < 1.1, `${perKey.toFixed(2)} layouts a keystroke; the collapse cost two`);
  assert.equal(box.el.style.height, `${box.content()}px`, 'grown to the content, as the collapse measured it');

  // Deleting collapses and measures, so the box shrinks back.
  box.set(text.slice(0, 10));
  fitToContent(box.el, box.el.value);
  assert.equal(box.el.style.height, `${box.content()}px`, 'a deletion shrinks the box');
  // A paste over a selection is not an insertion either.
  box.set(`${'x'.repeat(70)}`);
  fitToContent(box.el, box.el.value);
  box.set('short');
  fitToContent(box.el, box.el.value);
  assert.equal(box.el.style.height, `${box.content()}px`);
  // Cleared after a send.
  box.set('');
  fitToContent(box.el, '');
  assert.equal(box.el.style.height, `${box.content()}px`, 'the reset after send is unchanged');
});

test('a box dragged taller keeps its height while text is typed into it', () => {
  const { fitToContent } = loadTsx('frontend/src/lib/use-auto-grow.ts');
  const box = textarea();
  box.set('hello');
  fitToContent(box.el, 'hello');
  box.drag(200);
  box.set('hello there');
  fitToContent(box.el, 'hello there');
  assert.equal(box.el.style.height, '200px');
});

test('only an insertion skips the collapse', () => {
  const { onlyInserted } = loadTsx('frontend/src/lib/use-auto-grow.ts');
  assert.equal(onlyInserted('helo', 'hello'), true, 'typed in the middle');
  assert.equal(onlyInserted('hello', 'hello world'), true, 'typed at the end');
  assert.equal(onlyInserted('world', 'hello world'), true, 'pasted at the start');
  assert.equal(onlyInserted('hello', 'hello'), true, 'unchanged');
  assert.equal(onlyInserted('hello', 'hell'), false, 'deleted');
  assert.equal(onlyInserted('hello', 'jelly'), false, 'replaced, same length');
  assert.equal(onlyInserted('ab\ncd', 'abXYZ'), false, 'pasted over a selection');
});
