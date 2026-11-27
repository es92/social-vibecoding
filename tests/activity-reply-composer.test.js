// #1584 — the Activity feed's inline reply is a real multiline composer.
//
// Run with: node --test tests/activity-reply-composer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SOURCE = read('frontend/src/features/dev-board/card/feed-thread.tsx');
const BOX = read('frontend/src/features/messages/composer.tsx');
const dapp = JSON.parse(read('dapp.json'));

let api = null;
const mod = () => (api || (api = loadTsx(
  'frontend/src/features/dev-board/card/feed-thread.tsx'
)));

function composerHtml() {
  return renderToHtml(createElement(mod().FeedReplyComposer, {
    slug: 'usernode-2d5619',
    type: 'issue',
    refId: 7,
    onSend: () => {},
  }));
}

// ONE MESSAGE BOX (27 Nov 2026): the comments under a change are written in
// Messages' own box (features/messages/composer.tsx MessageBox), with the
// change's thread as its place. The compact field and send disc this file
// pinned (#1584) were a third box of their own, and are gone with it.

test('the reply is Messages\' box: a one-row field that grows, and the round send', () => {
  const component = SOURCE.slice(
    SOURCE.indexOf('export function FeedReplyComposer'),
    SOURCE.indexOf('\nexport function FeedThread')
  );
  assert.match(component, /<MessageBox place=\{place\} \/>/, 'the one box, with this thread as its place');
  assert.match(component, /scope: chatScopeKey\(slug, \{ type, ref: refId \}\)/,
    'its draft is saved under the thread\'s own scope, which the thread\'s page writes too');
  assert.match(component, /bare: true/, 'inside a card: no chat foot\'s bar, no home-indicator inset');
  assert.doesNotMatch(component, /upload:|formatting:/, 'no files and no formatting: the comments above are plain text');
  // The box grows with its words and sends by the rule every box keeps.
  assert.match(BOX, /useAutoGrow\(inputRef, value, scroller\)/);
  assert.match(BOX, /if \(enterSends\(event\.nativeEvent\)\) \{ event\.preventDefault\(\); submit\(\); \}/);

  const html = composerHtml();
  assert.match(html, /^<div class="dev-feed-reply"><div class="messages-composer ">/,
    'a plain block round the card, not the chat foot\'s bar');
  assert.doesNotMatch(html, /platform-safe-bar/);
  assert.match(html, /<textarea[^>]*rows="1"[^>]*aria-label="Reply to this item"[^>]*class="messages-composer-input"/);
  assert.doesNotMatch(html, /messages-composer-add/, 'a box that takes nothing to add draws no "+"');
});

test('the send disc is always present and waits for words', () => {
  const empty = composerHtml();
  assert.match(empty, /<button(?=[^>]*type="button")(?=[^>]*disabled="")(?=[^>]*class="messages-send")[^>]*>\s*<svg/,
    'disabled while the box is empty');
});

test('submission and row-navigation behavior stay on their existing seams', () => {
  const submit = SOURCE.slice(SOURCE.indexOf('const submit = useCallback'), SOURCE.indexOf('const hidden'));
  assert.match(submit, /const content = words\.trim\(\)/);
  assert.match(submit, /method: 'POST'/);
  assert.match(submit, /thread_type: type, thread_ref: refId/);
  assert.match(SOURCE, /<FeedReplyComposer slug=\{slug\} type=\{type\} refId=\{refId\} onSend=\{submit\} \/>/);
  assert.match(SOURCE, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/,
    'using the composer does not open its Activity row');
});

test('a retried reply keeps its key, so the server stores it once (#6730)', () => {
  const submit = SOURCE.slice(SOURCE.indexOf('const submit = useCallback'), SOURCE.indexOf('const hidden'));
  assert.match(SOURCE, /function newClientKey\(\)/, 'each comment gets a key at the press');
  assert.match(submit, /client_key: clientKey/, 'the key rides on the POST');
  assert.match(submit, /const clientKey = failedKeys\.current\.get\(content\) \|\| newClientKey\(\);/,
    'the same words after a failure are the same comment; edited words are a new one');
  // A failure keeps the key and gives the words back to the box, which
  // emptied as the comment left.
  const failed = submit.slice(submit.indexOf('} catch {'));
  assert.match(failed, /failedKeys\.current\.set\(content, clientKey\);/);
  assert.match(failed, /putInComposer\(chatScopeKey\(slug, \{ type, ref: refId \}\), content, \{ onlyIfEmpty: true \}\);/);
  const checked = submit.indexOf('if (!res.ok) throw');
  assert.ok(checked !== -1 && checked < submit.indexOf('} catch {'), 'only an answered POST frees the key');
});

test('a successfully posted reply survives the inline-thread reload', () => {
  const preview = mod().feedThreadPreview([
    {
      id: 40,
      username: null,
      content: 'Build started',
      msg_type: 'system',
      created_at: '2026-09-04T09:00:00Z',
    },
    {
      id: 41,
      username: 'alice',
      content: 'Existing reply',
      msg_type: 'message',
      created_at: '2026-09-04T10:00:00Z',
    },
    {
      id: 42,
      username: 'bob',
      content: 'Newly posted reply',
      msg_type: 'message',
      created_at: '2026-09-04T11:00:00Z',
    },
  ]);

  assert.deepEqual(preview, {
    messages: [
      {
        id: 41,
        author: 'alice',
        userId: null,
        content: 'Existing reply',
        createdAt: '2026-09-04T10:00:00Z',
        // #2236: a person typing; only a connector-posted row says 'agent'.
        postedVia: null,
      },
      {
        id: 42,
        author: 'bob',
        userId: null,
        content: 'Newly posted reply',
        createdAt: '2026-09-04T11:00:00Z',
        postedVia: null,
      },
    ],
    total: 2,
  });
});

test('the inline reply preview preserves composer line breaks', () => {
  const html = renderToHtml(createElement(mod().MessageLine, {
    m: {
      id: 42,
      author: 'bob',
      content: 'First line\nSecond line',
      createdAt: '2026-09-04T11:00:00Z',
    },
  }));

  assert.match(html, /class="[^"]*whitespace-pre-wrap[^"]*"/,
    'the browser must preserve newlines instead of collapsing them to spaces');
  assert.match(html, /dev-feed-msg-text[^>]*>First line\nSecond line<\/div>/,
    'the reply remains plain escaped text with its original newline');
  // The bubble (round three): the author and the age on the first line,
  // the text under them, a swatch avatar outside.
  // #1808 made the age a `<time>` with the full instant on `title`, so the
  // element changed but the adjacency — author then age, one line — did not.
  // #1808 made the age a `<time>` carrying the full instant on `title`, so
  // the element changed but the adjacency — author then age, one line — did
  // not. The `datetime` match is case-insensitive because React 19 emits the
  // JSX spelling and HTML attribute names are case-insensitive anyway.
  assert.match(html, /<span class="dev-feed-msg-author">bob<\/span><time class="dev-feed-msg-time" datetime="2026-09-04T11:00:00Z" title="[^"]*2026[^"]*">/i);
  assert.match(html, /class="dev-feed-msg-avatar" aria-hidden="true" style="background-color:#[0-9a-f]{6}">B</);
});

test('a long reply in the panel shows four lines and a way to see the rest', () => {
  // #2556. The panel previews the last two replies under a card; one reply
  // pasted from somewhere else used to push the next card off the screen.
  const html = renderToHtml(createElement(mod().MessageLine, {
    m: {
      id: 43,
      author: 'bob',
      content: 'word '.repeat(400),
      createdAt: '2026-09-04T11:00:00Z',
    },
  }));
  assert.match(html, /class="dev-feed-msg-text whitespace-pre-wrap break-words line-clamp-4"/,
    'the clamp joins the classes the reply text already carried');
  // The control is measured into place by an effect — renderToStaticMarkup
  // runs none, and an island's first paint must match the prerendered shell.
  assert.doesNotMatch(html, /Show more|Show less/);
});

test('the Workshop staging route requires both the textarea and arrow', () => {
  const check = dapp.tests.find((entry) => entry.name.includes('#1584'));
  assert.ok(check, 'a declared check names this change');
  // The card has to be unfolded for the composer to exist.
  //
  // ?ws=all JOINED IT when the lander became three tabs, and #4486 moved it
  // onto the board with its cards open: By category's rows open the item's
  // page now rather than unfolding in place, and `?cards=open` is the state
  // that still draws every card unfolded, the composer under each. The
  // ?shot=feed-comments deep link fills and scrolls to the first slot.
  assert.equal(check.path, '/?demo=1&ws=all&group=stage&cards=open&shot=feed-comments#app/usernode-2d5619/workshop');
  // One message box (27 Nov 2026): Messages' field and its round send.
  assert.match(check.expectSelector, /\.dev-feed-reply textarea\[aria-label="Reply to this item"\]/);
  assert.match(check.expectSelector, /~ button\.messages-send:disabled/);
});
