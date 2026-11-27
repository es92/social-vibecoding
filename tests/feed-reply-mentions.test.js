// #2145 — the Activity feed's reply box sends from the keyboard and suggests
// people on `@`.
//
// ── One message box, one @ menu (27 Nov 2026) ─────────────────────────
//
// The feed's reply box, a topic's channel and a request's, a change's or a
// decision's thread were three boxes with two `@` lists of their own (the
// classic script's MentionAutocomplete and the feed's mention-typeahead.tsx).
// Every one of them is Messages' box now (features/messages/composer.tsx
// MessageBox), whose `@` list is the only one, and a project's chat answers
// it from features/group-chat/chat-sources.ts: the same endpoint, the same
// two-minute list per app, Homeroom bot first, and a prefix lookup when the
// whole list is full. That module is what this suite drives.
//
// Run with: node --test tests/feed-reply-mentions.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const ROOT = path.join(__dirname, '..');
const FEED = read('frontend/src/features/dev-board/card/feed-thread.tsx');
const BOX = read('frontend/src/features/messages/composer.tsx');
const GC = read('frontend/src/features/group-chat/composer.tsx');
const GC_JS = read('public/js/group-chat.js');
const APP_VIEW = read('public/js/app-view.js');
const WS = read('src/services/ws.js');
const SOURCES = 'frontend/src/features/group-chat/chat-sources.ts';

const composer = () => FEED.slice(
  FEED.indexOf('export function FeedReplyComposer'),
  FEED.indexOf('\nexport function FeedThread'),
);

/** A fresh copy of the sources module with `fetch` answering from `answer`. */
function sources(answer) {
  const calls = [];
  const saved = global.fetch;
  global.fetch = async (url) => {
    calls.push(url);
    const out = await answer(url);
    return { ok: out.status === undefined || out.status < 400, status: out.status || 200, json: async () => out.body || {} };
  };
  const mod = loadTsx(SOURCES);
  return { mod, calls, restore: () => { global.fetch = saved; } };
}

// ── The send keys ───────────────────────────────────────────────────

test('every box sends by the rule every message box keeps', () => {
  // The box's own keys: an open list first, then lib/enter-sends.ts.
  assert.match(BOX, /if \(onEmojiKeyDown\(event\)\) return; if \(suggestionKeys\(event\)\) return; if \(enterSends\(event\.nativeEvent\)\) \{ event\.preventDefault\(\); submit\(\); \}/);
  // The feed's and the chat's boxes are that box, with no keys of their own.
  assert.match(composer(), /<MessageBox place=\{place\} \/>/);
  assert.match(GC, /<MessageBox place=\{place\} scroller=\{scroller\} \/>/);
  assert.doesNotMatch(composer(), /enterSends|onKeyDown/);
  assert.doesNotMatch(GC, /enterSends|onKeyDown/);
  // The old boxes' wiring is gone: nothing binds Enter to a chat field now.
  assert.doesNotMatch(GC_JS, /submitThread|setupAttachments|MentionAutocomplete|RefAutocomplete|EmojiAutocomplete/);
  assert.doesNotMatch(APP_VIEW, /submitGeneral|MentionAutocomplete|RefAutocomplete|EmojiAutocomplete/);
  // The inline editor keeps the same rule for saving an edit.
  assert.match(GC_JS,
    /if \(GroupChat\._enterSends\(e\)\) \{\s*e\.preventDefault\(\);\s*GroupChat\._saveEdit/,
    'the inline editor saves on the same keys');
});

test('the comments, a channel and a thread all ask the one source', () => {
  assert.match(composer(), /people: chatPeople\(slug\),/);
  assert.match(GC, /people: chatPeople\(slug\),/);
  for (const gone of [
    'frontend/src/features/dev-board/card/mention-typeahead.tsx',
    'frontend/src/features/dev-board/card/ref-typeahead.tsx',
    'frontend/src/features/group-chat/autocomplete.tsx',
    'frontend/src/features/group-chat/autocomplete-store.ts',
  ]) assert.equal(fs.existsSync(path.join(ROOT, gone)), false, `${gone} went with the old boxes`);
});

// ── The `@` list ────────────────────────────────────────────────────

test('typing @ev finds the project\'s people whose names start with it, bot first when it matches', async () => {
  const { mod, calls, restore } = sources(() => ({
    body: { users: [{ username: 'evan' }, { username: 'Eve' }, { username: 'zoe' }, { username: 'homeroom_bot' }], bot: { username: 'homeroom_bot' } },
  }));
  try {
    const people = mod.chatPeople('slug-a');
    assert.equal(people.kind, 'lookup');
    assert.equal(people.key, 'app:slug-a', 'one lookup per project');
    const ev = await people.ask('ev');
    assert.deepEqual(ev.map((p) => p.username), ['evan', 'Eve'], 'prefix, any case, the server\'s order kept');
    const bare = await people.ask('');
    assert.equal(bare[0].username, 'homeroom_bot', 'a bare @ offers Homeroom bot first');
    assert.equal(bare[0].insert, 'Homeroom bot', 'and picks it as its name, which the server reads as it');
    assert.equal(bare.filter((p) => p.username === 'homeroom_bot').length, 1, 'once');
    assert.deepEqual((await people.ask('home')).map((p) => p.username), ['homeroom_bot']);
    assert.deepEqual(calls, ['/api/apps/slug-a/mention-suggestions'], 'one fetch for every prefix within the TTL');
  } finally { restore(); }
});

test('a full list that cannot fill a prefix is widened by a prefix lookup', async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ username: `member${i}` }));
  const { mod, calls, restore } = sources((url) => (url.includes('?q=')
    ? { body: { users: [{ username: 'quiet-quinn' }] } }
    : { body: { users: many } }));
  try {
    const found = await mod.chatPeople('big').ask('qui');
    assert.deepEqual(found.map((p) => p.username), ['quiet-quinn']);
    assert.ok(calls.includes('/api/apps/big/mention-suggestions?q=qui'));
  } finally { restore(); }
});

test('a refused list is kept empty; a 429 is not kept, so the next @ asks again', async () => {
  let status = 429;
  const { mod, calls, restore } = sources(() => ({ status, body: {} }));
  try {
    assert.deepEqual(await mod.chatPeople('busy').ask(''), []);
    status = 200;
    await mod.chatPeople('busy').ask('');
    assert.equal(calls.length, 2, 'the 429 was not remembered');
  } finally { restore(); }
});

test('a picked mention notifies as mentions already do — no new kind, no new route', () => {
  // The comments box POSTs to the thread as before; the server fans out
  // mention notifications after every chat insert, threaded or not.
  const submit = FEED.slice(FEED.indexOf('const submit = useCallback'), FEED.indexOf('const hidden'));
  assert.match(submit, /body: JSON\.stringify\(\{ content, thread_type: type, thread_ref: refId, client_key: clientKey \}\)/);
  const insert = WS.indexOf('INSERT INTO chat_messages');
  const fanout = WS.indexOf('notifications.createMentionNotifications(pool, {', insert);
  assert.ok(insert > 0 && fanout > insert, 'mentions fan out after the insert, for thread posts too');
  assert.doesNotMatch(read(SOURCES), /method: 'POST'[\s\S]*mention/, 'the people lookup only reads');
});
