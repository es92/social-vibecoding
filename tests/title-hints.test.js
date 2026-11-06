'use strict';
// #6118: a title the layout cuts short (one line with "…", two lines with
// line-clamp) ended in dots with no way to read the rest without opening it.
// Every such title now carries the same string as its native `title` hint, so
// hovering shows it whole. A shared row takes the hint from a caller that
// passes `tooltip`; the hand-drawn titles below pass it themselves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const LIST_ROW = 'frontend/@/components/ui/grouped-list.tsx';

test('ListRow writes the hint a caller passes, and nothing when it passes none', () => {
  const explicit = renderComponent(LIST_ROW, 'ListRow', { title: 'Row label', tooltip: 'The hint' });
  assert.match(explicit, /title="The hint"/);
  assert.doesNotMatch(explicit, /title="Row label"/);

  // A plain title is not a hint by itself: the labels this primitive carries
  // ("Your work") are short, and a hint on them is noise. The callers whose
  // titles ellipsise pass `tooltip` (bot-slots, thread-items).
  const plain = renderComponent(LIST_ROW, 'ListRow', { title: 'A title too long for its row' });
  assert.doesNotMatch(plain, /title=/);

  const jsx = renderComponent(LIST_ROW, 'ListRow', {
    title: createElement('span', { className: 'truncate' }, 'Row label'),
  });
  assert.doesNotMatch(jsx, /title=/);
});

test('the hand-drawn truncated titles carry their text as the hint', () => {
  const workRow = read('frontend/src/features/dev-board/workshop/work-row.tsx');
  // list, board, line and act rows: the anchor and the inert span of each.
  assert.equal(workRow.match(/title=\{card\.title\.text\}/g).length, 6);

  assert.match(read('frontend/src/features/home/widget-strip.tsx'),
    /className="[^"]*truncate[^"]*" title=\{tile\.name\}>/);
  assert.match(read('frontend/src/features/dev-board/workshop/bot-slots.tsx'),
    /tooltip=\{title \|\| undefined\}/);
  // A request's thread lists its items through the shared rows; both the
  // title and the hint are that row's name.
  assert.match(read('frontend/src/features/dev-board/topic/thread-items.tsx'),
    /title=\{say\(row\.title\)\}\s*tooltip=\{say\(row\.title\)\}/);
  assert.match(read('frontend/src/features/dev-board/topic/topic-head.tsx'),
    /className="min-w-0 flex-1 truncate[^"]*" title=\{title\}>/);
  assert.match(read('frontend/src/features/dev-board/topic/thread-changes.tsx'),
    /className="min-w-0 truncate" title=\{fromPlan\}>/);

  const messages = read('frontend/src/features/messages/index.tsx');
  assert.match(messages, /className="messages-row-name" title=\{rowName \|\| undefined\}/);
  assert.match(messages, /className="messages-thread-name" title=\{threadName \|\| undefined\}/);
  // Main Chat's column hints the whole head block, so the name's own markup
  // stays as it was.
  assert.match(messages, /className="min-w-0 flex-1" title=\{mainTitle \|\| undefined\}>\s*<div className="messages-thread-name min-w-0 truncate" data-reply-title="">/);
  assert.match(messages, /className="min-w-0 truncate" title=\{replyTitle\}>/);

  const header = read('frontend/src/features/header/header-title.tsx');
  // The heading carries the community's name as its hint, and never the
  // logotype: on Homeroom's own pages the drawing already says the word.
  assert.match(header,
    /id="header-title"[\s\S]*?title=\{communityPage && !selfHosted \? \(name \|\| text\) \|\| undefined : undefined\}/);
  assert.doesNotMatch(header, /id="header-title-name"[^>]*title=/);
});
