// `:shortcode` emoji autocomplete — the pure half, shared by both composers.
//
// features/message-actions/emoji-shortcodes.ts decides what `:th` means: which
// `:` opens a token, which characters continue it, which emoji it offers in
// what order, and which complete `:code:` becomes its emoji. The Messages
// composer calls it directly and the app chat's EmojiAutocomplete
// (public/js/group-chat.js) through window.UsernodeReact.groupChat, so these
// rules hold for both at once.
//
// Run with: node --test tests/emoji-shortcodes.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const DIR = 'frontend/src/features/message-actions';
const codes = loadTsx(`${DIR}/emoji-shortcodes.ts`);
const { ALL_EMOJI } = loadTsx(`${DIR}/emoji-data.ts`);
const {
  matchShortcodes, emojiForShortcode, shortcodesFor, slugifyEmojiName,
  findShortcodeToken, completedShortcodeAt, replaceShortcodeToken, SHORTCODE_MIN_QUERY,
} = codes;

const glyphs = (query, limit) => matchShortcodes(query, limit).map((row) => row.emoji);

test('every emoji answers to its name, slugified with underscores', () => {
  assert.equal(slugifyEmojiName('thumbs up'), 'thumbs_up');
  assert.equal(slugifyEmojiName('see-no-evil monkey'), 'see_no_evil_monkey');
  assert.equal(emojiForShortcode('thumbs_up'), '👍');
  assert.equal(emojiForShortcode('red_heart'), '❤️');
  assert.equal(emojiForShortcode('party_popper'), '🎉');
  // Every emoji in the picker is reachable by at least one code, and the code
  // the menu shows for it round-trips — a shown code that converted to a
  // different emoji (or none) would be worse than no menu.
  for (const entry of ALL_EMOJI) {
    const list = shortcodesFor(entry.emoji);
    assert.ok(list.length, `${entry.emoji} (${entry.name}) has a shortcode`);
    for (const code of list) {
      assert.match(code, /^[a-z0-9_+-]+$/, `${code} is made of name characters`);
      assert.equal(emojiForShortcode(code), entry.emoji, `:${code}: is ${entry.emoji}`);
    }
  }
});

test('the aliases people type are there, and only for emoji the set has', () => {
  const expected = {
    thumbsup: '👍', thumbsdown: '👎', '+1': '👍', '-1': '👎', heart: '❤️', smile: '😊',
    joy: '😂', wink: '😉', blush: '😊', heart_eyes: '😍', thinking: '🤔', cry: '😢',
    sob: '😭', rage: '😡', fire: '🔥', tada: '🎉', clap: '👏', pray: '🙏', ok_hand: '👌',
    wave: '👋', eyes: '👀', rocket: '🚀', 100: '💯', sparkles: '✨', star: '⭐',
    white_check_mark: '✅', check: '✅', x: '❌', warning: '⚠️', coffee: '☕', beer: '🍺',
    pizza: '🍕', raised_hands: '🙌', muscle: '💪', see_no_evil: '🙈', shrug: '🤷',
  };
  for (const [code, emoji] of Object.entries(expected)) {
    assert.equal(emojiForShortcode(code), emoji, `:${code}:`);
  }
  // Case-insensitive, like the token detector.
  assert.equal(emojiForShortcode('TADA'), '🎉');
  assert.equal(emojiForShortcode('not_an_emoji'), null);

  // The alias table is written against the picker's exact strings, variation
  // selectors included. A row for an emoji the set does not have is dead.
  const source = read(`${DIR}/emoji-shortcodes.ts`);
  const table = source.slice(source.indexOf('const ALIASES'), source.indexOf('];', source.indexOf('const ALIASES')));
  const rows = [...table.matchAll(/\['([^']+)', '([^']+)'\]/g)];
  assert.ok(rows.length > 100, 'found the alias table');
  const known = new Set(ALL_EMOJI.map((entry) => entry.emoji));
  const seen = new Set();
  for (const [, emoji, list] of rows) {
    assert.ok(known.has(emoji), `alias row ${emoji} (${list}) names an emoji the picker has`);
    for (const alias of list.split(' ')) {
      assert.ok(!seen.has(alias), `:${alias}: is claimed once`);
      seen.add(alias);
    }
  }
});

test('ranking: an exact code first, then prefixes, then substrings, then name words', () => {
  // `:thu` — 👍 leads.
  assert.deepEqual(matchShortcodes('thu'), [
    { emoji: '👍', shortcode: 'thumbsup' },
    { emoji: '👎', shortcode: 'thumbsdown' },
  ]);
  // Two characters is enough to open, and the common one still leads.
  assert.equal(glyphs('th')[0], '👍');
  // An exact code outranks every prefix match, whatever its length.
  assert.equal(matchShortcodes('thumbsup')[0].emoji, '👍');
  assert.equal(matchShortcodes('thumbsup')[0].shortcode, 'thumbsup');
  assert.deepEqual(matchShortcodes('heart')[0], { emoji: '❤️', shortcode: 'heart' });
  assert.deepEqual(matchShortcodes('+1'), [{ emoji: '👍', shortcode: '+1' }]);
  assert.deepEqual(matchShortcodes('-1'), [{ emoji: '👎', shortcode: '-1' }]);
  // Exact, then prefix, then substring: `:check`.
  assert.deepEqual(glyphs('check'), ['✅', '🏁', '☑️']);
  // Shorter codes before longer within a tier: ❤️ `heart` before 💓 `heartbeat`.
  const hea = glyphs('hea');
  assert.ok(hea.indexOf('❤️') < hea.indexOf('💓'));
  // The last tier reaches the picker's search words: `:lol` finds 😂 (and the
  // row shows the code it answers to, not the word that found it).
  assert.equal(glyphs('hmm')[0], '🤔');
  assert.deepEqual(matchShortcodes('hooray')[0], { emoji: '🙌', shortcode: 'hooray' });
  assert.deepEqual(matchShortcodes('happy')[0], { emoji: '😊', shortcode: 'blush' });
});

test('the row shows the code that matched, aliases first', () => {
  assert.equal(matchShortcodes('thu')[0].shortcode, 'thumbsup');
  // Typing the slug shows the slug.
  assert.equal(matchShortcodes('thumbs_')[0].shortcode, 'thumbs_up');
  assert.equal(matchShortcodes('party_p')[0].shortcode, 'party_popper');
});

test('at most `limit` rows, each emoji once, and nothing for an empty query', () => {
  assert.equal(matchShortcodes('a').length, 8);
  assert.equal(matchShortcodes('a', 3).length, 3);
  const rows = glyphs('s', 50);
  assert.equal(new Set(rows).size, rows.length);
  assert.deepEqual(matchShortcodes(''), []);
  assert.deepEqual(matchShortcodes('zzzzzzzz'), []);
});

test('a `:` starts a token only at a boundary, with two name characters after it', () => {
  const at = (text, caret = text.length) => findShortcodeToken(text, caret);
  assert.equal(SHORTCODE_MIN_QUERY, 2);
  assert.deepEqual(at(':th'), { start: 0, query: 'th' });
  assert.deepEqual(at('nice :tha'), { start: 5, query: 'tha' });
  assert.deepEqual(at('(:th'), { start: 1, query: 'th' });
  assert.deepEqual(at('line\n:Th'), { start: 5, query: 'th' });
  assert.deepEqual(at(':+1'), { start: 0, query: '+1' });
  // One character is not enough yet.
  assert.equal(at(':t'), null);
  assert.equal(at('hi :'), null);
  // Times, URLs and a word's own colon never open it.
  assert.equal(at('meet at 10:30'), null);
  assert.equal(at('see https://example.com'), null);
  assert.equal(at('https:'), null);
  assert.equal(at('Note:th'), null);
  // Anything that is not a name character closes it.
  assert.equal(at(':th '), null);
  assert.equal(at(':th.'), null);
  assert.equal(at(':thumbsup:'), null);
  // The caret decides, not the end of the text; a selection never opens it.
  assert.deepEqual(findShortcodeToken(':th and more', 3), { start: 0, query: 'th' });
  assert.equal(findShortcodeToken(':thu', 3, 4), null);
});

test('a complete, known `:code:` converts as its closing colon is typed', () => {
  assert.deepEqual(completedShortcodeAt('yay :tada:', 10), { start: 4, end: 10, emoji: '🎉' });
  assert.deepEqual(completedShortcodeAt(':+1:', 4), { start: 0, end: 4, emoji: '👍' });
  // A one-letter code converts even though it could never open the menu.
  assert.deepEqual(completedShortcodeAt(':x:', 3), { start: 0, end: 3, emoji: '❌' });
  assert.deepEqual(completedShortcodeAt(':TADA: rest', 6), { start: 0, end: 6, emoji: '🎉' });
  // Unknown, unbounded or not at the caret: left as typed.
  assert.equal(completedShortcodeAt(':nope:', 6), null);
  assert.equal(completedShortcodeAt('at 10:30:', 9), null);
  assert.equal(completedShortcodeAt('word:tada:', 10), null);
  assert.equal(completedShortcodeAt(':tada:', 5), null);
});

test('inserting replaces the `:query` token and places the caret after it', () => {
  const text = 'great :thu work';
  const token = findShortcodeToken(text, 10);
  assert.deepEqual(token, { start: 6, query: 'thu' });
  const next = replaceShortcodeToken(text, token.start, 10, '👍');
  assert.equal(next.value, 'great 👍  work');
  assert.equal(next.caret, 'great 👍 '.length);
  // The conversion passes no suffix: the closing colon was the last key.
  const done = completedShortcodeAt('go :tada:', 9);
  assert.deepEqual(replaceShortcodeToken('go :tada:', done.start, done.end, done.emoji, ''),
    { value: 'go 🎉', caret: 'go 🎉'.length });
});

test('the one message box uses this module, and nothing re-derives the rules', () => {
  // One message box (27 Nov 2026): the group chat's box is Messages' own, so
  // its `:th` menu is this one; the classic script's copy is gone.
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /from '\.\.\/message-actions\/emoji-shortcodes'/);
  assert.match(read('frontend/src/features/group-chat/composer.tsx'), /<MessageBox place=\{place\}/);
  const mount = read('frontend/src/features/group-chat/mount.ts');
  assert.doesNotMatch(mount, /emojiShortcodeToken|matchEmojiShortcodes|completedEmojiShortcode|mountEmojiMenu|publishEmojiMenu/);
  assert.doesNotMatch(read('public/js/group-chat.js'), /EmojiAutocomplete|emojiShortcodeToken/);
});

test('the Messages composer: its own listbox, and its keys run before the send chord', () => {
  const composer = read('frontend/src/features/messages/composer.tsx');
  // The menu is the mention menu's box, headed with the query, over a listbox
  // named for screen readers.
  assert.match(composer, /className="messages-mention-menu messages-emoji-menu"/);
  assert.equal(message('messages:composer.emojiMatching', { query: 'smi' }), 'Emoji matching <0>:smi</0>');
  assert.match(composer, /<RichMessage id="messages:composer\.emojiMatching" values=\{\{ query: emoji\.query \}\} components=\{\[<span className="messages-emoji-menu-query" \/>\]\} \/>/);
  assert.equal(message('messages:composer.emojiMenu'), 'Emoji');
  assert.match(composer, /role="listbox" aria-label=\{t\('messages:composer\.emojiMenu'\)\}/);
  assert.match(composer, /role="option" aria-selected=\{i === emojiActive\}/);
  // A press keeps the textarea focused, like the mention rows.
  assert.match(composer, /data-emoji-option=\{item\.shortcode\} onMouseDown=\{\(event\) => event\.preventDefault\(\)\} onClick=\{\(\) => insertEmoji\(item\.emoji\)\}/);
  // The menu's keys come first: with it open, Enter inserts and never sends.
  // The @ and # list's keys (QA 2026-09-24 Q13) come next, and never meet
  // these: the emoji menu opens only while neither of those lists shows.
  // Only then is Enter a send (lib/enter-sends.ts: where there is a
  // keyboard, and never with Shift held or a composition being committed).
  assert.match(composer, /onKeyDown=\{\(event\) => \{ if \(onEmojiKeyDown\(event\)\) return; if \(suggestionKeys\(event\)\) return; if \(enterSends\(event\.nativeEvent\)\) \{ event\.preventDefault\(\); submit\(\); \}/);
  const handler = composer.slice(composer.indexOf('function onEmojiKeyDown('), composer.indexOf('function onComposerChange('));
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']) {
    assert.ok(handler.includes(`'${key}'`), `${key} is the menu's while it is open`);
  }
  assert.match(handler, /\(emojiActive \+ step \+ count\) % count/, 'the arrows wrap');
  assert.match(handler, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*return true;/);
  // Only a typed colon converts a complete code.
  assert.match(composer, /\(event\.nativeEvent as InputEvent\)\.data === ':' \? completedShortcodeAt\(/);
  // One menu at a time: the `@` and `#` menus win a tie.
  assert.match(composer, /const emojiOpen = !!emoji && emoji\.key !== emojiDismissed && !mention\?\.length && !channelMatches\?\.length;/);
});
