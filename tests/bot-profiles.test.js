'use strict';

// 5 Nov 2026 (docs/plans/bot-one-model.md, step 5): threads as the unit.
// Each thread kind has one profile (src/services/bot-profiles.js): the
// surface that runs its turn, its tool scope and tools, its limits, its
// prompt section and, on a project's thread, when it speaks. One entry
// (src/services/thread-bot.js) runs a message by its kind.
//
// What this pins:
//   1. Every kind has a profile; every project-thread place type has a kind;
//      a message in a person's chat is Main, private or design.
//   2. No surface offers a tool its kinds' profiles do not list, and every
//      rule a profile names is one the voice's gate runs.
//   3. The surfaces' limits are their profiles' (nothing changed in value).
//   4. The entry runs each kind on its surface, and the callers use it.
//
// Run with: node --test tests/bot-profiles.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const profiles = require('../src/services/bot-profiles');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('every thread kind has its profile, and every place its kind', () => {
  assert.deepEqual(profiles.KINDS, ['main', 'private', 'design', 'request', 'change', 'channel', 'reply']);
  for (const kind of profiles.KINDS) {
    const p = profiles.profileOf(kind);
    assert.equal(p.kind, kind);
    assert.ok(['chat', 'design', 'thread'].includes(p.surface), kind);
    assert.ok(['main', 'design', 'thread'].includes(p.scope), kind);
    assert.ok(p.tools.length && p.limits && p.prompt, kind);
  }
  for (const [type, kind] of Object.entries({ issue: 'request', session: 'change', chat: 'channel', category: 'channel', message: 'reply' })) {
    assert.equal(profiles.kindOfPlace({ type, ref: 1 }), kind, type);
    assert.ok(profiles.profileOf(kind).places.includes(type));
  }
  assert.equal(profiles.kindOfPlace({ type: 'nowhere' }), null);
  assert.equal(profiles.kindInChat({}), 'main');
  assert.equal(profiles.kindInChat({ threadRootId: 9 }), 'private');
  assert.equal(profiles.kindInChat({ threadRequest: { appId: 1, issueNumber: 2 } }), 'private', 'a request card\'s thread from before');
  assert.equal(profiles.kindInChat({ design: { rootId: 9 } }), 'design');
  assert.throws(() => profiles.profileOf('elsewhere'), /no thread kind elsewhere/);
});

test('no surface offers a tool its profile does not list, and every rule named is run', () => {
  const voice = require('../src/services/homeroom-bot-voice');
  const flags = [{}, { ownChange: true, requestChange: true, openChangeCount: 2, platform: true, planWaiting: true }, { otherChange: true }];
  for (const type of ['issue', 'session', 'chat', 'category', 'message']) {
    const listed = profiles.profileOfPlace({ type }).tools;
    for (const f of flags) {
      for (const t of voice.toolsFor({ type, ref: 1 }, f)) assert.ok(listed.includes(t.function.name), `${type}: ${t.function.name}`);
    }
  }
  const main = profiles.profileOf('main').tools;
  for (const t of require('../src/services/homeroom-bot-mayor').TOOLS) assert.ok(main.includes(t.function.name), `main: ${t.function.name}`);
  const design = profiles.profileOf('design').tools;
  for (const t of require('../src/services/design-bot').TOOLS) assert.ok(design.includes(t.function.name), `design: ${t.function.name}`);
  for (const kind of ['request', 'change', 'channel', 'reply']) {
    const speaks = profiles.profileOf(kind).speaks;
    assert.deepEqual(speaks.slice(0, profiles.THREAD_CHECKS.length), profiles.THREAD_CHECKS, `${kind}: the common checks first`);
    for (const rule of speaks) assert.equal(typeof voice.SPEAK_RULES[rule], 'function', `${kind}: ${rule}`);
  }
});

test('#6389: the change thread may make its own version of somebody else\'s change', () => {
  assert.ok(profiles.profileOf('change').tools.includes('make_own_version'));
  const voice = require('../src/services/homeroom-bot-voice');
  const names = (f) => voice.toolsFor({ type: 'session', ref: 1 }, f).map((t) => t.function.name);
  assert.ok(names({ otherChange: true }).includes('make_own_version'));
  assert.ok(!names({ ownChange: true }).includes('make_own_version'), 'never on the bot\'s own change');
});

test('#6384: a plan is read in the chat, on a request and on a change, and nowhere else', () => {
  for (const kind of ['main', 'private', 'request', 'change']) {
    assert.ok(profiles.profileOf(kind).tools.includes('get_spec'), kind);
  }
  for (const kind of ['channel', 'reply', 'design']) {
    assert.ok(!profiles.profileOf(kind).tools.includes('get_spec'), `${kind} posts no plans`);
  }
  const voice = require('../src/services/homeroom-bot-voice');
  const names = (place) => voice.toolsFor(place, { platform: true }).map((t) => t.function.name);
  for (const type of ['issue', 'session']) assert.ok(names({ type, ref: 1 }).includes('get_spec'), type);
  for (const type of ['chat', 'category', 'message']) assert.ok(!names({ type, ref: 1 }).includes('get_spec'), type);
});

// 6 Nov 2026 (#6395): a plain "Go ahead" on a request is heard after the
// rules that already answer a person, and before the silence.
test('the request profile hears a plain Go ahead right after a followed post', () => {
  const speaks = profiles.profileOf('request').speaks;
  assert.equal(speaks[speaks.indexOf('followed_a_post') + 1], 'go_ahead_reply');
  assert.ok(speaks.indexOf('go_ahead_reply') < speaks.indexOf('addressed_or_stop'));
});

// #6539: a change's thread hears the follow-up straight after the bot's post,
// after the words already passed on as an ask and the bot's own change, and
// before the silence that needs an @.
test('the change profile hears a follow-up after the bot\'s post, before the silence', () => {
  const speaks = profiles.profileOf('change').speaks;
  assert.equal(speaks[speaks.indexOf('followed_change_post') - 1], 'own_change');
  assert.equal(speaks[speaks.indexOf('followed_change_post') + 1], 'addressed');
  assert.ok(speaks.indexOf('not_queued_as_ask') < speaks.indexOf('followed_change_post'));
  assert.ok(!profiles.profileOf('request').speaks.includes('followed_change_post'), 'a request keeps its own rule');
});

test('the surfaces\' limits are their profiles\'', () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const voice = require('../src/services/homeroom-bot-voice');
  assert.deepEqual([mayor.MAX_ROUNDS, mayor.MAX_OFFERS], [16, 3]);
  assert.equal(mayor.MAX_ROUNDS, profiles.CHAT_LIMITS.rounds);
  assert.deepEqual([voice.MAX_ROUNDS, voice.MAX_READS_PER_TURN], [8, 4]);
  assert.equal(voice.MAX_ROUNDS, profiles.THREAD_LIMITS.rounds);
  for (const [file, name] of [
    ['src/services/homeroom-bot-mayor.js', 'CHAT_LIMITS'], ['src/services/homeroom-bot-voice.js', 'THREAD_LIMITS'],
    ['src/services/design-bot.js', 'DESIGN_LIMITS'],
  ]) {
    assert.match(read(file), new RegExp(`const MAX_ROUNDS = ${name}\\.rounds;`), file);
  }
});

// #6358: a design turn gets four times the room and twice the retry, and three
// minutes a step, so a long page is drawn to the end. Chat is unchanged.
test('#6358: a design turn draws a whole screen within its budget', () => {
  assert.deepEqual(
    [profiles.DESIGN_LIMITS.rounds, profiles.DESIGN_LIMITS.outputTokens, profiles.DESIGN_LIMITS.retryOutputTokens,
      profiles.DESIGN_LIMITS.requestTimeoutMs],
    [12, 16000, 32000, 180_000],
  );
  assert.deepEqual(
    [profiles.CHAT_LIMITS.outputTokens, profiles.CHAT_LIMITS.retryOutputTokens, profiles.CHAT_LIMITS.requestTimeoutMs],
    [8000, 16000, 90_000],
  );
  const design = require('../src/services/design-bot');
  assert.equal(design.DESIGN_OUTPUT_TOKENS, 16000);
  assert.equal(design.DESIGN_RETRY_OUTPUT_TOKENS, 32000);
  assert.equal(design.DESIGN_REQUEST_TIMEOUT_MS, 180_000);
  const src = read('src/services/design-bot.js');
  assert.match(src, /retryOutputTokens: DESIGN_RETRY_OUTPUT_TOKENS,/);
  assert.match(src, /timeoutMs: DESIGN_REQUEST_TIMEOUT_MS,/);
});

test('the one entry runs each kind on its surface, and the callers use it', async () => {
  const threadBot = require('../src/services/thread-bot');
  const ran = [];
  const deps = {
    mayor: { runDmTurn: async (_p, _c, args) => { ran.push(['chat', args.conversationId]); return 'chat'; } },
    designBot: { answer: async (_p, _c, args) => { ran.push(['design', args.design.rootId]); return 'design'; } },
    voice: { runTurn: async (_p, _c, args) => { ran.push(['thread', args.place.type]); return 'thread'; } },
  };
  assert.equal(await threadBot.answer({}, {}, { kind: 'main', conversationId: 5, deps }), 'chat');
  assert.equal(await threadBot.answer({}, {}, { kind: 'private', conversationId: 6, deps }), 'chat');
  assert.equal(await threadBot.answer({}, {}, { kind: 'design', design: { rootId: 9 }, deps }), 'design');
  assert.equal(await threadBot.answer({}, {}, { kind: 'request', place: { type: 'issue', ref: 4 }, deps }), 'thread');
  assert.deepEqual(ran, [['chat', 5], ['chat', 6], ['design', 9], ['thread', 'issue']]);
  await assert.rejects(threadBot.answer({}, {}, { kind: 'nowhere', deps }), /no thread kind/);
  const dm = read('src/services/homeroom-bot-dm.js');
  assert.match(dm, /require\('\.\/thread-bot'\)\.answer\(pool, config, \{ kind: 'design',/);
  assert.match(dm, /kind: require\('\.\/bot-profiles'\)\.kindInChat\(turnDeps\)/);
  assert.match(read('src/workflow/bot-voice/services.ts'), /legacy\('services\/thread-bot'\)\.answer\(pool, config, \{\s+kind: legacy\('services\/bot-profiles'\)\.kindOfPlace\(input\.place\)/);
});
