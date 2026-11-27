'use strict';

// #3361 — `@` in a channel offered nobody. The Messages composer built its
// list from `active.members`, and the server leaves a channel's roster empty
// (serializeConversation counts it: a channel is everybody). The hub's
// channel card had no `@` list at all.
//
// The server side — who may ask, who is offered, what is returned — is pinned
// against the real schema in tests/conversation-mention-candidates-postgres.
// This file pins the two composers' wiring. The suite has no DOM and the
// Messages composer needs the live store, so the wiring is pinned as source,
// in the style of tests/feed-reply-mentions.test.js; the one pure helper the
// hub adds is driven directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const API = read('frontend/src/features/messages/api.ts');
const HUB = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
const SOURCES = read('frontend/src/features/group-chat/chat-sources.ts');
const SERVICE = read('src/services/conversations.js');
const ROUTES = read('src/routes/conversations.js');
const CHAT_ROUTES = read('src/routes/chat.js');

const between = (src, from, to) => {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `missing ${from}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `missing ${to}`);
  return src.slice(start, end);
};

// One message box (27 Nov 2026): the box asks its PLACE for people. A
// channel's place (MessageComposer) is a lookup by prefix; a group's and a
// DM's a roster; a project's chat's ../group-chat/chat-sources.ts.
test('a channel asks the server for the people matching the typed prefix', () => {
  const place = between(COMPOSER, 'const isChannel = ', 'refs: (before) =>');
  assert.match(place, /active\.kind === 'channel'/);
  assert.match(place, /\{ kind: 'lookup', key: `c\$\{conversationId\}`, ask: \(query\) => api\.getMentionCandidates\(conversationId, query, CHANNEL_MENTION_LIMIT\)\.then\(\(users\) => users\.map\(personOf\)\) \}/);
  // Groups and DMs keep their loaded roster, accepted members only.
  assert.match(place, /\{ kind: 'roster', people: active\.members\.filter\(\(member\) => member\.status === 'member'\)\.map\(personOf\) \}/);
  // The box: one lookup per place, which orders, shares and remembers
  // requests; a different place (its key) starts a fresh one.
  const effect = between(COMPOSER, 'const people = place.people;', 'const roster =');
  assert.match(effect, /prefixLookup\(\(query\) => \(askPeople\.current \? askPeople\.current\(query\) : Promise\.resolve\(\[\]\)\)\)/);
  assert.match(effect, /\[lookupKey\]\)/, 'a different place starts a fresh lookup');
  // After a pause in typing unless already answered; a superseded answer
  // (null) or one for an effect since torn down never lands.
  assert.match(effect, /window\.setTimeout\(ask, 120\)/);
  assert.match(effect, /window\.clearTimeout\(timer\)/);
  assert.match(effect, /if \(live && users\) setChannelPeople\(\{ lookup: channelLookup, key, users \}\)/);
  assert.doesNotMatch(effect, /setError\(/, 'the send\'s error state is the send\'s');
});

test('the list shows only the answer for what is typed now', () => {
  const memo = between(COMPOSER, 'const mention = useMemo', 'const refMatch');
  assert.match(memo, /channelPeople\.lookup === channelLookup/, 'never another place\'s people');
  assert.match(memo, /channelPeople\.key === prefix/);
  assert.match(memo, /prefix\.startsWith\(channelPeople\.key\) && channelPeople\.users\.length < CHANNEL_MENTION_LIMIT/,
    'a shorter prefix\'s answer only while it was complete');
  assert.match(memo, /orderFriendsFirst\(found\.filter\(matches\), friendIds\)\.slice\(0, 6\)/);
  assert.match(memo, /orderFriendsFirst\(\(roster \|\| \[\]\)\.filter\(matches\), friendIds\)\.slice\(0, 6\)/);
});

test('the client calls the read-gated endpoint with a bounded prefix and limit', () => {
  const fn = between(API, 'export async function getMentionCandidates', '\n}\n');
  assert.match(fn, /\/api\/conversations\/\$\{id\}\/mention-candidates\?q=\$\{q\}&limit=\$\{limit\}/);
  assert.match(fn, /prefix\.slice\(0, 64\)/);
  assert.match(fn, /encodeURIComponent/);
  assert.match(fn, /\.map\(normalizeUser\)\.filter\(\(user\) => user\.id\)/);
});

// ── lib/prefix-lookup.ts, driven with deferred answers ───────────────

function deferredFetcher() {
  const calls = [];
  const fetcher = (query) => new Promise((resolve, reject) => { calls.push({ query, resolve, reject }); });
  return { calls, fetcher };
}

test('an answer that lands after a later prefix was asked is dropped', async () => {
  const { prefixLookup } = loadTsx('frontend/src/lib/prefix-lookup.ts');
  const { calls, fetcher } = deferredFetcher();
  const lookup = prefixLookup(fetcher);
  const short = lookup.ask('a');
  const long = lookup.ask('alex');
  // Reverse order: the long prefix answers first, then the slow short one.
  calls[1].resolve(['alex']);
  calls[0].resolve(['amy', 'alex', 'ann']);
  assert.deepEqual(await long, ['alex']);
  assert.equal(await short, null, '`@a` no longer decides the list');
  // Both answers are remembered for their own prefix.
  assert.deepEqual(lookup.cached('A'), ['amy', 'alex', 'ann']);
  // Going back to `@a` answers from memory, with no new request.
  assert.deepEqual(await lookup.ask('a'), ['amy', 'alex', 'ann']);
  assert.equal(calls.length, 2);
});

test('the same prefix asked twice shares one request, and a failure is not remembered', async () => {
  const { prefixLookup } = loadTsx('frontend/src/lib/prefix-lookup.ts');
  const { calls, fetcher } = deferredFetcher();
  const lookup = prefixLookup(fetcher);
  const first = lookup.ask('bo');
  const again = lookup.ask('BO');
  assert.equal(calls.length, 1, 'in flight is shared, case-insensitively');
  calls[0].resolve(['bob']);
  assert.deepEqual(await first, ['bob'], 'the same prefix is still the one being typed');
  assert.deepEqual(await again, ['bob']);

  const failed = lookup.ask('zz');
  calls[1].reject(new Error('offline'));
  assert.deepEqual(await failed, [], 'the latest prefix failing closes the list');
  assert.equal(lookup.cached('zz'), null);
  const retry = lookup.ask('zz');
  assert.equal(calls.length, 3, 'and the next ask tries again');
  calls[2].resolve(['zz_1']);
  assert.deepEqual(await retry, ['zz_1']);
});

test('every box reads one @ token: a run of anything but a space or another @', () => {
  // A conversation's mention parser (services/conversations.js
  // mentionsUsername) takes legacy punctuation, and the box's one grammar
  // does too, in every place; a project chat's server reads its own names
  // out of what is sent.
  assert.match(COMPOSER, /return value\.slice\(0, cursor\)\.match\(\/\(\?:\^\|\\s\)@\(\[\^\\s@\]\*\)\$\/\)\?\.\[1\];/);
});

test('the server reuses the message-read gate and the directory rate limit', () => {
  const fn = between(SERVICE, 'async function mentionCandidates', '\nasync function conversationRow');
  // Exactly listMessages' gate, not a new one.
  const list = between(SERVICE, 'async function listMessages', 'const safeLimit');
  const gate = "const membership = await loadMembership(pool, conversationId, user.id, { allowDeletedPeer: true });\n"
    + '  if (!membership || !(await canReadConversation(pool, membership, user.id))) return null;';
  assert.ok(list.includes(gate), 'listMessages reads through this gate');
  assert.ok(fn.includes(gate), 'and so do the mention candidates');
  // Parameterised, escaped, capped, and one statement.
  assert.match(fn, /ESCAPE '\\\\'/);
  assert.match(fn, /LIMIT \$4/);
  assert.equal((fn.match(/pool\.query\(/g) || []).length, 1, 'one query, no per-person lookups');
  assert.doesNotMatch(fn, /email|display_name|password|is_admin/, 'public identity only');
  const route = between(ROUTES, "'/api/conversations/:id/mention-candidates'", '\n  });');
  assert.match(ROUTES, /router\.get\('\/api\/conversations\/:id\/mention-candidates', userDirectoryLimiter,/);
  assert.match(route, /users \? res\.json\(\{ users \}\) : sendNotFound\(res\)/);
});

test('the app list behind @ is rate-limited like the other people searches', () => {
  // Since #3361 it takes ?q= per keystroke, so it spends the same per-user
  // bucket as /mention-candidates and /api/users/search.
  assert.match(CHAT_ROUTES, /\{[^}]*\buserDirectoryLimiter,[^}]*\} = require\('\.\.\/middleware\/rate-limits'\)/);
  assert.match(CHAT_ROUTES, /router\.get\('\/api\/apps\/:slug\/mention-suggestions', userDirectoryLimiter, async/);
  // A 429 is a failure, not an answer: the whole-list cache does not keep
  // it. (The hub's own composer, which asked per prefix, went with its
  // channel card: the hub's Discussion row opens the room itself.)
  assert.doesNotMatch(HUB, /function HubComposer/);
  assert.match(SOURCES, /if \(res\.status === 429\) return \{ users: \[\], bot: false, fetchedAt: 0 \};/);
});

test('a project chat\'s box asks by prefix through the box\'s ordered lookup', () => {
  // The hub's composer, which asked #general's conversation or the app's
  // list by prefix, went with its channel card.
  assert.equal(loadTsx('frontend/src/features/dev-board/workshop/hub-cards.tsx').conversationIdFromPostUrl, undefined);
  // A project's chat is a lookup place too; the box's ordered lookup
  // (lib/prefix-lookup.ts) applies only a live answer.
  assert.match(SOURCES, /kind: 'lookup',\s*key: `app:\$\{slug\}`,/);
});
