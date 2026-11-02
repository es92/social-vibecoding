'use strict';

// A request's story is its own page (31 Oct 2026, from the review of how
// threads show). In the chat with Homeroom bot, news about a request opened
// a thread of the chat's own: the request's card again, "No replies yet",
// "Reply about this request…". That was a second view of the request's
// public thread that neither Main Chat nor the bot page's list of threads
// led to. Now a thread in that chat is only one the person started (or a
// draft the bot opened for them), and everything about a request opens the
// request's page. Pinned here:
//
//   1. Which page a bot message stands for (request-page.ts), and that the
//      bot's own private threads (a draft, a design) are not one of them.
//   2. Every way in goes there: a news line, a moment's "↳ in …" label, the
//      activity drawer, a thread opened by id, a link to an old thread, and
//      "See progress" opens Main Chat, never a thread.
//   3. A request's message offers no thread of its own.
//   4. What still asks something in the chat is drawn whole in Main Chat,
//      for as long as its request waits, so nothing is left in a thread.
//
// Run with: node --test tests/bot-request-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PAGE = 'frontend/src/features/messages/request-page.ts';
const NEWS = 'frontend/src/features/messages/bot-news-line.tsx';
const STORE = 'frontend/src/features/messages/store.ts';

const BOT = { id: 2, username: 'homeroom_bot', bot: true };
const ADA = { id: 7, username: 'ada' };
const msg = (sender, homeroomBot, extra = {}) => ({ id: 40, sender, content: 'x', metadata: { homeroomBot }, ...extra });
const plain = (v) => JSON.parse(JSON.stringify(v));

test('a bot message about a request stands for the request\'s page; a first version for its project\'s hub', () => {
  const { requestPageOf } = loadTsx(PAGE);
  assert.deepEqual(plain(requestPageOf(msg(BOT, { kind: 'activity', appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 18, requestTitle: 'Dark mode' }))), {
    route: 'app/plant-pal/dev/issues/18', label: 'Dark mode', place: { slug: 'plant-pal', name: 'Plant Pal' }, issueNumber: 18,
  });
  assert.equal(requestPageOf(msg(BOT, { kind: 'question', appSlug: 'plant-pal', issueNumber: 7 })).label, 'Request #7');
  assert.deepEqual(plain(requestPageOf(msg(BOT, { kind: 'activity', appSlug: 'plant-pal', appName: 'Plant Pal', firstVersion: true }))), {
    route: 'app/plant-pal/dev', label: 'Plant Pal', place: { slug: 'plant-pal', name: 'Plant Pal' }, issueNumber: null,
  });
});

test('the bot\'s own private threads, a person\'s message and a message about no request are none', () => {
  const { requestPageOf } = loadTsx(PAGE);
  assert.equal(requestPageOf(msg(BOT, { kind: 'opened_draft', appSlug: 'plant-pal', draft: 'post_reply', issueNumber: 18 })), null);
  assert.equal(requestPageOf(msg(BOT, { kind: 'opened_design', appSlug: 'plant-pal' })), null);
  assert.equal(requestPageOf(msg(ADA, { kind: 'activity', appSlug: 'plant-pal', issueNumber: 18 })), null);
  assert.equal(requestPageOf(msg(BOT, { kind: 'chat', appSlug: 'plant-pal' })), null);
  assert.equal(requestPageOf(msg(BOT, null)), null);
  assert.equal(requestPageOf(null), null);
});

test('it opens beside the bot page in Main Chat\'s place when the panel takes it, else the page, which goes back', () => {
  const source = read(PAGE);
  assert.match(source, /sidePanel\?\.take\?\.\(page\.route, \{ place: page\.place, label: page\.label \}\)/);
  assert.match(source, /'usernode:messages-object-selected'/, 'Main Chat\'s composer carries the request, as the list\'s rows do');
  assert.match(source, /Improve\?\.enterTopicFrom\?\.\(window\.location\.hash/);
  assert.match(source, /AppView\?\._landOnHub\?\.\(page\.place\.slug\)/, 'a door to a project\'s hub lands on the hub');
  assert.match(source, /window\.location\.hash = page\.route;/);
});

test('every way into a request\'s story goes to its page', () => {
  const news = read(NEWS);
  assert.match(news, /function tap\(\) \{\n {4}if \(page\) openRequestPage\(page, message\.conversationId\);/);
  assert.match(news, /else openThreadAt\(rootId, /, 'only news that names no page (sent before it named its project) opens where it is told');
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /onClick=\{\(\) => \(story \? openRequestPage\(story, conversationId\) : openThread\(/, 'the "↳ in …" label');
  const strip = read('frontend/src/features/messages/bot-strip.tsx');
  assert.match(strip, /if \(page\) \{ openRequestPage\(page, /, 'the activity drawer');
  const store = read(STORE);
  const open = store.slice(store.indexOf('export function openThread(rootId: number)'));
  assert.match(open.slice(0, 600), /const page = requestPageFor\(findRow\(rootId\)\);\n {2}if \(page\) \{ openRequestPage\(page, conversationId\); return; \}/, 'a thread opened by id');
  const load = store.slice(store.indexOf('export async function loadReplyThread('));
  assert.match(load.slice(0, 2400), /const story = requestPageFor\(page\.root \|\| findRow\(rootId\)\);\n {4}if \(story\) \{\n {6}closeThread\(\);\n {6}openRequestPage\(story, conversationId\);/, 'a link to an old thread');
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.match(pane, /if \(botChat && kind === 'direct' && requestPageOf\(root\)\) return null;/, 'and the pane never draws one');
});

test('the store asks only in the chat with the bot', () => {
  const store = read(STORE);
  const fn = store.slice(store.indexOf('function requestPageFor('), store.indexOf('/** Open the thread that hangs off'));
  assert.match(fn, /state\.active\?\.kind !== 'direct' \|\| !threadsAllowed\(state\.active\)\) return null;/);
});

test('"See progress" opens Main Chat at the request, never inside a thread of its own', () => {
  const store = read(STORE);
  const fn = store.slice(store.indexOf('export async function openBotRequest('), store.indexOf('/** What the composer\'s box asks'));
  assert.match(fn, /const ask = track\?\.askId && !known\?\.threadRootId \? track\.askId : null;/);
  // 1 Nov 2026: on the Homeroom bot tab, Main Chat at that message.
  assert.match(fn, /if \(at\) openBotTab\(\{ threadRootId: null, focusMessageId: at \}\);/);
  assert.doesNotMatch(fn, /openThreadAt\(track\.rootId/);
  // A plan said in the private thread its request started in opens there, at the plan.
  assert.match(fn, /if \(track\?\.askId && track\.askThreadId\) \{\s*openBotTab\(\{ threadRootId: track\.askThreadId, focusMessageId: track\.askId \}\);\s*return;\s*\}/);
});

test('the Hub\'s Review the plan follows a first version\'s plan into its maker\'s private thread', () => {
  const hub = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  assert.match(hub, /if \(action === 'review' && fv\.plan_at\?\.threadRootId\) \{[\s\S]{0,120}openBotTab\(\{ threadRootId: fv\.plan_at\.threadRootId, focusMessageId: fv\.plan_at\.messageId \?\? null \}\);/);
  const apps = read('src/routes/apps.js');
  assert.match(apps, /\.\.\.\(mine && state\.plan && Number\(state\.plan\.threadRootId\) > 0 \? \{\s*plan_at: \{/);
});

test('an answer to a moment from an old story thread is said in Main Chat; a thread of one\'s own keeps its answers', () => {
  const store = read(STORE);
  const fn = store.slice(store.indexOf('function botThreadOf('), store.indexOf('/**', store.indexOf('function botThreadOf(')));
  assert.match(fn, /if \(!root \|\| state\.route\.threadRootId === root\) return root;/);
  assert.match(fn, /if \(rootRow\) return requestPageFor\(rootRow\) \? null : root;/);
});

test('a request\'s message offers no thread: no Reply in thread, no "N updates in its thread"', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /const story = botChat && kind === 'direct' && !inThread \? requestPageOf\(message\) : null;/);
  assert.match(row, /const threadRoot = !live \|\| inThread \|\| !threads \|\| story \? null/);
  assert.match(row, /message\.thread && !inThread && kind === 'direct' && threads && !story \?/);
  assert.match(row, /\) : message\.thread && !inThread && !story \? \(/);
});

test('what still asks something here is drawn whole in Main Chat while its request waits', () => {
  const { asksInChat } = loadTsx(NEWS);
  const ask = (meta, extra) => asksInChat(msg(BOT, { appSlug: 'plant-pal', issueNumber: 18, ...meta }, extra));
  assert.equal(ask({ kind: 'question', question: 'Which colour?', answers: ['Blue'], status: 'open' }), true);
  assert.equal(ask({ kind: 'question', questions: [{ question: 'a' }, { question: 'b' }], status: 'open' }), true);
  assert.equal(ask({ kind: 'plan', plan: { bullets: ['x'] }, status: 'open' }), true);
  assert.equal(ask({ kind: 'build_failed', actions: [{ id: 'retry', label: 'Try again' }], status: 'open' }), true);
  assert.equal(ask({ kind: 'question', question: 'Which colour?', status: 'answered' }), false, 'answered');
  assert.equal(ask({ kind: 'plan', plan: { bullets: ['x'] }, status: 'open', replaced: true }), false, 'replaced by a newer plan');
  assert.equal(ask({ kind: 'activity', status: 'open' }), false, 'a card asks nothing');
  assert.equal(ask({ kind: 'question', question: 'Which colour?', status: 'open' }, { deleted: true }), false);
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const asking = \(message: ConversationMessage\) => botDm && asksInChat\(message\) && !newsStatusOf\(message, botWork\)\?\.settled;/,
    'what the tray no longer holds has moved on, and is a line again');
  assert.match(screen, /foldBotNews\(snap\.messages, \(message\) => isMovedActivity\(message\) \|\| plans\.hidden\.has\(message\.id\) \|\| asking\(message\)\)/, 'never folded into a line');
  assert.match(screen, /if \(botDm && isBotNews\(message\) && !asks\) \{/, 'and never drawn as one');
});
