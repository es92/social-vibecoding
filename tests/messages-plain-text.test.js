'use strict';

// A message shown in passing is one line of plain text, not its markdown.
//
// The quote above a reply, the composer's "Replying to" bar and an inbox
// row's preview printed a message's source as it was typed, so a Homeroom bot
// message, which opens with `**Project** · request #12: …`, showed its
// asterisks in all three. frontend/src/features/messages/plain-text.ts keeps
// the words and drops the markup; this pins what it does with each kind of
// markup, what it leaves alone, and that the three places use it.
//
// Run with: node --test tests/messages-plain-text.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { plainText } = loadTsx('frontend/src/features/messages/plain-text.ts');

test('a bot message loses its bold, and keeps its words', () => {
  assert.equal(plainText('**Seed swap** · request #12: Sort by date'), 'Seed swap · request #12: Sort by date');
  assert.equal(
    plainText("**Seed swap**, its first version\n\nI'm building the first version now."),
    "Seed swap, its first version I'm building the first version now.",
    'one line, whatever the paragraphs',
  );
});

test('emphasis, strike-through and inline code lose their markers', () => {
  assert.equal(plainText('__bold__ and *italic* and _also italic_'), 'bold and italic and also italic');
  assert.equal(plainText('***both at once***'), 'both at once');
  assert.equal(plainText('~~gone~~ kept'), 'gone kept');
  assert.equal(plainText('++underlined++ kept'), 'underlined kept');
  assert.equal(plainText('run `npm test` first'), 'run npm test first');
  assert.equal(plainText('``a `tick` inside``'), 'a `tick` inside');
});

test('links and images become their text', () => {
  assert.equal(plainText('See [the request](https://example.com/r/12) for more'), 'See the request for more');
  assert.equal(plainText('![a seed packet](/files/1.png) arrived'), 'a seed packet arrived');
  assert.equal(plainText('Mail <mailto:ada@example.com> or <https://example.com>'), 'Mail mailto:ada@example.com or https://example.com');
});

test('what opens a line goes: headings, quotes, bullets, numbers, checkboxes; rules and fences too', () => {
  assert.equal(plainText('# Plan\n## Steps'), 'Plan Steps');
  assert.equal(plainText('> quoted\n> > twice'), 'quoted twice');
  assert.equal(plainText('- one\n* two\n+ three'), 'one two three');
  assert.equal(plainText('1. first\n2) second'), 'first second');
  assert.equal(plainText('- [x] done\n- [ ] to do'), 'done to do');
  assert.equal(plainText('above\n\n---\n\nbelow'), 'above below');
  assert.equal(plainText('```js\nconst a = 1;\n```'), 'const a = 1;');
});

test('what is not markup is left as it was', () => {
  assert.equal(plainText('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(plainText('2 * 3 * 4 = 24'), '2 * 3 * 4 = 24');
  assert.equal(plainText('#general is the room'), '#general is the room', 'a channel is not a heading');
  assert.equal(plainText('Escaped \\*stars\\*'), 'Escaped *stars*');
  assert.equal(plainText('   lots   of\n\n  space  '), 'lots of space');
  assert.equal(plainText(''), '');
  assert.equal(plainText(null), '');
  assert.equal(plainText(undefined), '');
});

test('the quote, the reply bar and the inbox preview all use it', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.equal(message('messages:row.quote.attachment'), 'Attachment');
  assert.match(row, /className="messages-quote"[\s\S]{0,400}plainText\(message\.reply\.content\) \|\| t\('messages:row\.quote\.attachment'\)/);
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.equal(message('messages:composer.replyAttachment'), 'Attachment');
  // One message box (27 Nov 2026): MessageComposer words the chip's line,
  // and the box draws it in the reply bar.
  assert.match(composer, /snippet: plainText\(reply\.content\) \|\| t\('messages:composer\.replyAttachment'\),/);
  assert.match(composer, /className="messages-reply-draft"[\s\S]{0,200}<p className="truncate">\{reply\.snippet\}<\/p>/);
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /const summary = plainText\(text\(pick\(row, 'latestSummary', 'latest_summary', 'preview'\)\) \|\| latestMessage\?\.content \|\| ''\);/);
  assert.match(api, /latestSummary: homeroomBot \? botRowPreview\(summary\) : summary,/);
  for (const [file, src] of [['message-row.tsx', row], ['composer.tsx', composer]]) {
    assert.match(src, /import \{ plainText \} from '\.\/plain-text';/, file);
  }
  assert.match(api, /import \{ botRowPreview, plainText \} from '\.\/plain-text';/, 'api.ts');
});

test('the Homeroom bot\'s row names the request by its title, not its number', () => {
  // First-session run-through, 5 Oct 2026: the row read "Flat 4B Chores ·
  // request #7: Fix mark as done Filed. This card follows it from here."
  const { botRowPreview } = loadTsx('frontend/src/features/messages/plain-text.ts');
  const line = '**Flat 4B Chores** · request #7: Fix mark as done\n\nFiled. This card follows it from here.';
  assert.equal(botRowPreview(plainText(line)), 'Flat 4B Chores · Fix mark as done Filed. This card follows it from here.');
  assert.equal(botRowPreview(plainText('**Flat 4B Chores** · request #7\n\nFiled.')), 'Flat 4B Chores · request #7 Filed.',
    'with no title the number is all it is named by, so it stays');
  assert.equal(botRowPreview(plainText('**Seed swap**, its first version\n\nBuilding.')), 'Seed swap, its first version Building.');
  assert.equal(botRowPreview(plainText('Filed: **Note board** request #41: Add a search box.')), 'Filed: Note board request #41: Add a search box.',
    'only the request line\'s own shape');

  const { normalizeConversation } = loadTsx('frontend/src/features/messages/api.ts');
  const row = { id: 9, kind: 'direct', membershipStatus: 'member', latestSummary: line };
  assert.equal(normalizeConversation({ ...row, homeroomBot: true }).latestSummary,
    'Flat 4B Chores · Fix mark as done Filed. This card follows it from here.', 'the bot\'s row');
  assert.equal(normalizeConversation(row).latestSummary,
    'Flat 4B Chores · request #7: Fix mark as done Filed. This card follows it from here.', 'anyone else\'s row is as it was');
});
