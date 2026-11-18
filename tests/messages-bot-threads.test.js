'use strict';

// One request, one story: threads in the chat with Homeroom bot (client).
//
// Every request the bot works on for someone has one story: its activity
// card in their chat with the bot is the root of that request's reply
// thread, where its steps, questions, plan, answers and ending are posted.
// 14 Nov 2026: the four moments that ring (needs you, ready to try, stopped,
// live) were also listed in Main Chat, under a "↳ in …" label, by an
// `alsoInChat` stamp. Main Chat is gone: nothing writes the stamp and the
// client reads it nowhere. Pinned here:
//
//   1. Where threads are: rooms, and the chat with Homeroom bot alone among
//      direct chats (`threadsAllowed`, the one place the client says so).
//   2. What the main stream is: a conversation's own messages, never a
//      reply in a thread, for the read cursor and the unread count
//      (`inMainStream`, unread-anchor messageRow).
//   3. The names: the thread pane's title and the composer's "Reply about …"
//      placeholder.
//   4. The drawing: a thread's reply in a transcript is the rooms' thread
//      line; a request's card says "N updates in its thread ›"; a step line
//      reads quietly; a plan in a thread hides no card and reads the card it
//      hangs off.
//   5. The words of spec 2.3: Send answers, Write my own.
//
// Run with: node --test tests/messages-bot-threads.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message: catalog } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SHARED = 'frontend/src/features/messages/bot-shared.ts';

const BOT = { id: 2, username: 'homeroom_bot', bot: true, displayName: 'Homeroom bot' };
const ADA = { id: 7, username: 'ada' };
const MINUTE = 60 * 1000;

function message(sender, n, over = {}) {
  return {
    id: n, conversationId: 42, sender,
    createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0) + n * MINUTE).toISOString(),
    content: '', reply: null, reactions: [], attachments: [], objects: [], deleted: false,
    ...over,
  };
}

// ── 1. Where threads are ──────────────────────────────────────────────────

test('threads are kept in rooms and in the chat with Homeroom bot, never in a chat between people', () => {
  const { threadsAllowed } = loadTsx(SHARED);
  assert.equal(threadsAllowed({ kind: 'group' }), true);
  assert.equal(threadsAllowed({ kind: 'channel' }), true);
  assert.equal(threadsAllowed({ kind: 'direct' }), false, 'a DM between people keeps no threads (#2387)');
  assert.equal(threadsAllowed({ kind: 'direct', homeroomBot: false }), false);
  assert.equal(threadsAllowed({ kind: 'direct', homeroomBot: true }), true, 'the chat with the bot does');
  assert.equal(threadsAllowed(null), false);
});

test('the row, the transcript, the thread pane, the composer and the store all ask the one helper', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /const threads = threadsAllowed\(\{ kind, homeroomBot: botChat \}\);/);
  assert.doesNotMatch(row, /kind !== 'direct';/, 'no second reading of who has threads');
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const botChat = kind === 'direct' && threadsAllowed\(active\);/);
  // Only a thread's pane draws a row the bot's way: the chat is its threads alone.
  assert.equal((screen.match(/botChat=\{/g) || []).length, 2);
  assert.equal((screen.match(/ inThread botChat=\{botChat\}/g) || []).length, 2, 'the thread\'s first message and its replies');
  assert.match(read('frontend/src/features/messages/composer.tsx'), /inThread && active\.kind === 'direct' && threadsAllowed\(active\)/);
  assert.match(read('frontend/src/features/messages/store.ts'), /!threadsAllowed\(state\.active\)/);
});

// ── 2. The main stream ────────────────────────────────────────────────────

test('a reply in a thread is no position in the main stream, whatever stamp it carries', () => {
  const shared = loadTsx(SHARED);
  const { inMainStream } = shared;
  // A message from before 14 Nov 2026 can still carry the stamp that listed
  // it in Main Chat too. There is no Main Chat, and the stamp is not read.
  const stamped = { threadRootId: 9, metadata: { homeroomBot: { kind: 'question', alsoInChat: true } } };
  const quiet = { threadRootId: 9, metadata: { homeroomBot: { kind: 'step' } } };
  assert.equal(inMainStream({ threadRootId: null }), true);
  assert.equal(inMainStream(stamped), false);
  assert.equal(inMainStream(quiet), false);
  assert.equal(shared.alsoInChat, undefined, 'the reader of the stamp is gone');
  assert.equal(shared.botThreadLabel, undefined, 'and the label it drew');

  const { messageRow } = loadTsx('frontend/src/features/messages/unread-anchor.ts');
  assert.equal(messageRow({ id: 5, sender: BOT, threadRootId: null }, 7).countable, true);
  assert.equal(messageRow({ id: 5, sender: BOT, ...stamped }, 7).countable, false, 'a thread\'s reply is read in its thread');
  assert.equal(messageRow({ id: 6, sender: BOT, ...quiet }, 7).countable, false);
  // The read cursor moves to the newest main-stream position.
  assert.match(read('frontend/src/features/messages/store.ts'), /if \(item\.id > 0 && inMainStream\(item\)\) return item\.id;/);
  // Nothing in the client reads the stamp any more.
  for (const rel of ['api.ts', 'types.ts', 'store.ts', 'unread-anchor.ts', 'message-row.tsx', 'index.tsx']) {
    assert.doesNotMatch(read(`frontend/src/features/messages/${rel}`), /alsoInChat/, rel);
  }
  assert.doesNotMatch(read('frontend/locales/en/messages.json'), /"row\.botThread\.in/, 'the label\'s words went with it');
});

test('the client keeps the thread and moment fields of a bot message', () => {
  const { normalizeBotMeta } = loadTsx('frontend/src/features/messages/api.ts');
  const meta = normalizeBotMeta({ homeroomBot: {
    kind: 'question', threadRootId: 31, moment: 'needs_you', said: 'question', requestTitle: 'Dark mode',
    waiting: 'you and @ada', count: 2, alsoInChat: true, appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 4,
  } }).homeroomBot;
  assert.deepEqual(
    [meta.threadRootId, meta.moment, meta.said, meta.requestTitle, meta.waiting, meta.count],
    [31, 'needs_you', 'question', 'Dark mode', 'you and @ada', 2],
  );
  assert.equal('alsoInChat' in meta, false, 'an old message\'s stamp is dropped: nothing reads it');
  const bare = normalizeBotMeta({ homeroomBot: { kind: 'step', threadRootId: -1 } }).homeroomBot;
  assert.equal('threadRootId' in bare, false);
});

// ── 3. The names ──────────────────────────────────────────────────────────

test('a request\'s thread is named by the request', () => {
  const { botRequestNames, botThreadTitle } = loadTsx(SHARED);
  const titled = botRequestNames({ appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 4, requestTitle: 'Dark mode' });
  assert.equal(botThreadTitle(titled), 'Dark mode');
  // An activity card names its request by `issueTitle`.
  assert.equal(botThreadTitle(botRequestNames({ appName: 'Plant Pal', issueNumber: 4, issueTitle: 'Water reminders' })), 'Water reminders');
  const first = botRequestNames({ appName: 'Plant Pal', issueNumber: 1, firstVersion: true, requestTitle: null });
  assert.equal(botThreadTitle(first), 'Plant Pal first version');
  const untitled = botRequestNames({ appName: 'Plant Pal', issueNumber: 9 });
  assert.equal(botThreadTitle(untitled), 'Request #9');
});

test('the composer inside a request\'s thread says what a reply is about', () => {
  // Polish N16: one line on a phone. The thread's header names the
  // request, so the box does not repeat its title.
  assert.equal(catalog('messages:composer.placeholderBotThread'), 'Reply about this request…');
  assert.equal(catalog('messages:composer.placeholderBotThreadFirstVersion'), 'Reply about this first version…');
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /placeholder=\{inThread \? threadPlaceholder : t\('messages:composer\.placeholder'\)\}/);
  assert.match(composer, /botRequest\.firstVersion \? t\('messages:composer\.placeholderBotThreadFirstVersion'/);
  // Rooms keep their own.
  assert.match(composer, /!botRequest \? t\('messages:composer\.placeholderThread'\)/);
});

// ── 4. The drawing ────────────────────────────────────────────────────────

globalThis.window = {
  App: { user: ADA },
  location: { search: '', hash: '#messages/42' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

const META = { kind: 'activity', appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 4, issueTitle: 'Dark mode' };
const THREAD = { replyCount: 3, lastReplyAt: '2026-10-09T12:10:00.000Z', participants: [BOT], lastReply: null };

test('a message the old stamp listed in Main Chat is a reply like any other, with no label over it', () => {
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  const moment = message(BOT, 40, {
    threadRootId: 31,
    content: 'I have a question before I build it.',
    metadata: { homeroomBot: { kind: 'question', appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 4, requestTitle: 'Dark mode', alsoInChat: true, threadRootId: 31 } },
  });
  for (const inThread of [true, false]) {
    const html = renderToHtml(createElement(MessageRow, { message: moment, conversationId: 42, kind: 'direct', botChat: true, inThread }));
    assert.match(html, /I have a question before I build it\./);
    assert.doesNotMatch(html, /data-bot-thread-label|↳ in/);
  }
});

test('a room\'s message with a thread keeps the rooms\' chip; a card in a thread of the bot\'s chat says nothing of updates', () => {
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  // The bot chat's own stream drew a request's card with "N updates in its
  // thread" under it. No screen draws that stream since 14 Nov 2026: a card
  // is a row of its thread, where there is nothing under it to count.
  const card = message(BOT, 31, { content: 'Dark mode', metadata: { homeroomBot: META }, thread: null, threadRootId: 31 });
  const html = renderToHtml(createElement(MessageRow, { message: card, conversationId: 42, kind: 'direct', botChat: true, inThread: true }));
  assert.doesNotMatch(html, /data-bot-thread-link|msgx-thread-chip|updates? in its thread/);
  assert.doesNotMatch(read('frontend/src/features/messages/message-row.tsx'), /data-bot-thread-link|row\.botThread/);
  assert.equal(JSON.parse(read('frontend/locales/en/messages.json'))['row.botThread.updates_one'], undefined);
  // A room's message with a thread keeps the rooms' summary.
  const room = message(ADA, 50, { content: 'lunch?', thread: { ...THREAD, participants: [ADA] } });
  const roomHtml = renderToHtml(createElement(MessageRow, { message: room, conversationId: 42, kind: 'group' }));
  assert.match(roomHtml, /class="msgx-thread-chip /);
  assert.doesNotMatch(roomHtml, /data-bot-thread-link/);
});

test('a step line in a request\'s thread reads quietly', () => {
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  const step = message(BOT, 41, { threadRootId: 31, content: 'Reading it.', metadata: { homeroomBot: { kind: 'step', appSlug: 'plant-pal', issueNumber: 4 } } });
  const html = renderToHtml(createElement(MessageRow, { message: step, conversationId: 42, kind: 'direct', botChat: true, inThread: true }));
  assert.match(html, /<div class="messages-bot-step [^"]*text-zinc-500[^"]*" data-bot-step="">/);
  assert.match(html, /Reading it\./);
});

test('a transcript draws a thread\'s reply as the rooms\' thread line, in every chat', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /if \(message\.threadRootId\) \{\s+const run = \[message\];/, 'no moment is drawn whole in a main stream');
  assert.match(screen, /rows\.push\(<ThreadActivityRow key=/, 'rooms keep ThreadActivityRow');
  assert.match(screen, /const grouped = !!previous && !previous\.failed && !message\.failed/);
  // The thread pane names a request's thread by the request, over its project;
  // a thread from the bot's "+" (#6071 follow-up) by what it is for.
  assert.match(screen, /\{started \? startedThreadTitle\(t, started\.changeKind\) : request \? botThreadTitle\(request\) : t\('messages:replies\.title'\)\}/);
  assert.match(screen, /: request \? request\.project : active \?/);
});

test('a plan in its request\'s thread hides no card and reads the card it hangs off', () => {
  const { planLayout } = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const card = message(BOT, 31, { content: 'Dark mode', metadata: { homeroomBot: META }, thread: THREAD });
  const plan = message(BOT, 33, {
    threadRootId: 31, content: 'My plan',
    metadata: { homeroomBot: { kind: 'plan', appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 4, status: 'open', actionId: 5, plan: { bullets: ['Add a dark theme'], questions: [] } } },
  });
  const layout = planLayout([card, plan]);
  assert.equal(layout.hidden.has(31), false, 'the card is the way into the thread');
  assert.equal(layout.cardOf.get(33), 31);
  assert.equal(layout.answersOpen, true);
});

// 14 Nov 2026: with no Main Chat, a project's first version is one thread:
// its opening line, then the activity card, the plan and the card Build it
// moves under the plan, each a reply. They were messages of the main stream,
// read together; a thread that hangs off no card reads its replies the same
// way, so the plan still carries its request's step and the card above it
// is not drawn a second time.
test('a first version\'s thread reads its replies as the stream they were: the plan carries the card\'s step', () => {
  const { planLayout } = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const fv = { appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 1, firstVersion: true };
  const reply = (id, meta) => message(BOT, id, { threadRootId: 60, content: 'x', metadata: { homeroomBot: meta } });
  const card = reply(61, { kind: 'activity', ...fv });
  const plan = reply(62, { kind: 'plan', ...fv, status: 'open', actionId: 5, plan: { bullets: ['A list of plants'], questions: [] } });
  const live = reply(63, { kind: 'merged', ...fv, live: true });
  // As the pane hands them over: its own replies, with no thread above them.
  const flat = (rows) => planLayout(rows.map((row) => ({ ...row, threadRootId: null })));
  const waiting = flat([card, plan, live]);
  assert.deepEqual([...waiting.hidden], [61], 'the card above its plan is not drawn');
  assert.equal(waiting.cardOf.get(62), 61, 'the plan reads its step');
  // Read as replies of a request's thread, nothing is hidden and the plan hangs off the root.
  const threaded = planLayout([card, plan, live]);
  assert.deepEqual([...threaded.hidden], []);
  assert.equal(threaded.cardOf.get(62), 60);
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const flatPlans = botChat && !cardId\s+\? planLayout\(replies\.map\(\(message\) => \(message\.threadRootId \? \{ \.\.\.message, threadRootId: null \} : message\)\)\)\s+: NO_PLAN_LAYOUT;/);
  assert.match(screen, /const carried = \(message: ConversationMessage\) => botChat && !cardId\s+&& \(flatPlans\.hidden\.has\(message\.id\) \|\| isMovedActivity\(message\)\);/);
  assert.match(screen, /\.\.\.replies\.filter\(\(message\) => !carried\(message\)\)\.map\(\(message\) => \(\{ kind: 'reply' as const, message \}\)\),/);
  assert.match(screen, /planCardId=\{isPlanMessage\(message\) \? cardId \|\| flatPlans\.cardOf\.get\(message\.id\) \|\| null : null\}/);
  // The New line stands above the first reply drawn from the first unread on.
  assert.match(screen, /const line = firstUnread && !newLineDrawn && message\.id >= firstUnread/);
});

test('an answer to a message in a request\'s thread goes in that thread, from either place', () => {
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /const rootId = botThreadOf\(question\);\s*const scope = scopeKey\(conversationId, rootId\);/);
  assert.match(store, /send\(\{ content: answer, threadRootId: rootId, anyThread: true \}\)/);
  // Write my own and Change something quote it in that thread's composer.
  assert.match(store, /export function quoteInComposer\(message: ConversationMessage, conversationId: number\): void \{/);
  assert.match(store, /if \(rootId && state\.route\.threadRootId !== rootId\) openThread\(rootId\);/);
  for (const file of ['bot-question.tsx', 'bot-plan.tsx', 'bot-ready.tsx']) {
    const source = read(`frontend/src/features/messages/${file}`);
    assert.match(source, /quoteInComposer\(message, conversationId\)/, `${file} quotes through the store`);
    assert.doesNotMatch(source, /setReply\(scopeKey\(conversationId, null\), message\)/, `${file} never quotes past the thread`);
  }
});

// ── 5. The words ──────────────────────────────────────────────────────────

test('two questions are sent with Send answers, and an answer of one\'s own is Write my own', () => {
  assert.equal(catalog('messages:bot.questions.send'), 'Send answers');
  assert.equal(catalog('messages:bot.questions.writeOwn'), 'Write my own');
  assert.equal(catalog('messages:bot.question.writeOwn'), 'Write my own');
  assert.equal(catalog('messages:bot.plan.build'), 'Build it', 'the plan card\'s own Build it stays');
  const en = JSON.parse(read('frontend/locales/en/messages.json'));
  for (const gone of ['bot.questions.build', 'bot.questions.somethingElse', 'bot.question.somethingElse']) {
    assert.equal(en[gone], undefined, `${gone} is retired`);
  }
  const plan = read('frontend/src/features/messages/bot-plan.tsx');
  assert.match(plan, /data-bot-answer="build" onClick=\{build\}>\{t\('messages:bot\.questions\.send'\)\}<\/button>/);
});

// ── 6. What a card says when it stopped, waits or is on hold ─────────────

const CARD_FILE = 'frontend/src/features/messages/bot-activity.tsx';
const NOW = new Date('2026-10-09T12:00:00Z');
const ago = (m) => new Date(NOW.getTime() - m * MINUTE).toISOString();
const doneCard = (outcome, extra = {}) => ({
  messageId: 31, state: 'done', startedAt: ago(90), workedFrom: null, links: { request: null, proposal: null },
  step: null, of: null, stepName: null, doing: null, outcome, endedAt: null, ...extra,
});
const drawCard = (card) => {
  const { BotActivityCardView } = loadTsx(CARD_FILE);
  return renderToHtml(createElement(BotActivityCardView, { meta: META, card, loaded: true, now: NOW }));
};

test('a build that stopped says why, in the bot\'s words', () => {
  const words = {
    time: 'It took longer than I’m allowed',
    restart: 'Homeroom restarted while I was building',
    restarts: 'Homeroom restarted while I was building',
    no_change: 'I ended up with no changes to show',
    unproposed: 'I couldn’t put it up for a vote',
    no_start: 'I couldn’t get started',
    other: 'Something went wrong while I was building',
  };
  for (const [stopCause, line] of Object.entries(words)) {
    const html = drawCard(doneCard('build_failed', { stopCause }));
    assert.match(html, /data-bot-activity-eyebrow="">Stopped</);
    assert.match(html, new RegExp(`<span role="status">${line}</span>`), stopCause);
  }
  assert.match(drawCard(doneCard('build_failed')), /<span role="status">Couldn’t finish building it<\/span>/, 'no cause: the ending\'s own words');
});

test('a request held back by the bot\'s limits says what it waits for', () => {
  const perApp = drawCard(doneCard('held', { heldBy: 'proposals_per_app' }));
  assert.match(perApp, /data-bot-activity-eyebrow="">Waiting</);
  assert.match(perApp, /<span role="status">I’ll start when one of my changes on Plant Pal is voted in or closed<\/span>/);
  assert.match(drawCard(doneCard('held', { heldBy: 'proposals_total' })), /I’ll start when one of my changes across Homeroom is voted in or closed/);
  // #6156: held because the project's builds are all under way, it waits for
  // the bot's turn, never for a vote.
  const turn = drawCard(doneCard('held', { heldBy: 'builds_per_app' }));
  assert.match(turn, /data-bot-activity-eyebrow="">Waiting</);
  assert.match(turn, /<span role="status">I’ll start when one of the changes I’m building on Plant Pal is done<\/span>/);
  assert.doesNotMatch(turn, /vote/);
  const daily = drawCard(doneCard('held', { heldBy: 'questions_per_day' }));
  assert.match(daily, /data-bot-activity-eyebrow="">Waiting</);
  assert.doesNotMatch(daily, /role="status"|held back/, 'a limit it does not name: "Waiting" says it');
});

test('work on hold until Monday says so, with no step moving', () => {
  const html = drawCard({
    messageId: 31, state: 'working', startedAt: ago(30), workedFrom: null, links: { request: null, proposal: null },
    step: 3, of: 6, stepName: 'Building', doing: null, outcome: null, endedAt: null, stage: 'on_hold', waitingOn: 'time',
  });
  assert.match(html, /data-bot-activity-eyebrow="">On hold until Monday</);
  assert.match(html, /<span role="status">Your building time for this week is used up<\/span>/);
  assert.doesNotMatch(html, /data-progress-ring-spinning|>3\/6</, 'no ring moving');
});

test('the client keeps a stop cause, a hold and an on-hold stage, and only known words', () => {
  const { normalizeBotActivity, normalizeBotMeta } = loadTsx('frontend/src/features/messages/api.ts');
  const [stopped, held, onHold, odd] = normalizeBotActivity({ cards: [
    { messageId: 1, state: 'done', outcome: 'build_failed', stopCause: 'time', links: {} },
    { messageId: 2, state: 'done', outcome: 'held', heldBy: 'proposals_per_app', links: {} },
    { messageId: 3, state: 'working', stage: 'on_hold', waitingOn: 'time', links: {} },
    { messageId: 4, state: 'done', outcome: 'build_failed', stopCause: 'gremlins', heldBy: 'proposals_total', links: {} },
  ] });
  // #6156: a hold for the bot's turn is one the client knows.
  assert.equal(normalizeBotActivity({ cards: [{ messageId: 5, state: 'done', outcome: 'held', heldBy: 'builds_per_app', links: {} }] })[0].heldBy, 'builds_per_app');
  assert.equal('heldBy' in normalizeBotActivity({ cards: [{ messageId: 6, state: 'done', outcome: 'held', heldBy: 'nonsense', links: {} }] })[0], false);
  assert.equal(stopped.stopCause, 'time');
  assert.equal(held.heldBy, 'proposals_per_app');
  assert.deepEqual([onHold.stage, onHold.waitingOn], ['on_hold', 'time']);
  assert.equal('stopCause' in odd, false);
  assert.equal('heldBy' in odd, false, 'a hold only on a held card');
  assert.equal(normalizeBotMeta({ homeroomBot: { kind: 'build_failed', status: 'closed', closedWhy: 'No longer needed' } }).homeroomBot.closedWhy, 'No longer needed');
});

// ── 7. Buttons that stay, and why they went ──────────────────────────────

test('a request\'s own step closed by newer news says why in its place', () => {
  const { BotQuestion } = loadTsx('frontend/src/features/messages/bot-question.tsx');
  const tryAgain = [{ id: 'try_again', label: 'Try again', style: 'primary', type: 'prompt', quote: true }];
  const draw = (meta) => renderToHtml(createElement(BotQuestion, {
    message: message(BOT, 60, { content: 'Stopped.', metadata: { homeroomBot: { kind: 'build_failed', appSlug: 'plant-pal', issueNumber: 4, actionId: 9, actions: tryAgain, ...meta } } }),
    conversationId: 42,
  }));
  assert.match(draw({ status: 'open' }), /<span>Try again<\/span>/);
  const replaced = draw({ status: 'closed', closedWhy: 'A newer plan replaced this' });
  assert.doesNotMatch(replaced, /Try again/);
  assert.match(replaced, /<p class="messages-bot-answered" data-bot-closed-why="">A newer plan replaced this<\/p>/);
  assert.equal(draw({ status: 'closed' }), '', 'closed with no reason: suggestions still go quietly');
});

// Step 3 (11 Nov 2026): an offer whose buttons went because what it was
// about moved on (services/bot-cards.js retireFor) says why in their place,
// and a press the server refused says why in a line after the buttons,
// never inside `.messages-bot-answers` (a declared check selects its last
// button).
test('step 3: a retired or expired offer says why in its place, and a refused press says why after the buttons', () => {
  const { BotQuestion, OfferRefused, refusalOf, refusalLine, retiredLine } = loadTsx('frontend/src/features/messages/bot-question.tsx');
  const { MessagesApiError, normalizeBotMeta } = loadTsx('frontend/src/features/messages/api.ts');
  const close = [
    { id: 'yes', label: 'Propose to close', style: 'primary', type: 'server' },
    { id: 'no', label: 'Keep it open', style: 'secondary', type: 'server' },
  ];
  const draw = (meta) => renderToHtml(createElement(BotQuestion, {
    message: message(BOT, 62, { content: 'Want me to open a vote on closing request #4?', metadata: { homeroomBot: {
      kind: 'confirm', appSlug: 'plant-pal', issueNumber: 4, actionId: 13, actions: close, ...meta,
    } } }),
    conversationId: 42,
  }));
  const retired = draw({ status: 'closed', retired: 'close_vote' });
  assert.doesNotMatch(retired, /Propose to close/);
  assert.match(retired, /data-bot-retired="close_vote"/);
  assert.ok(retired.includes(catalog('messages:bot.offer.retired.closeVote')));
  assert.ok(draw({ status: 'closed', retired: 'nonsense' }).includes(catalog('messages:bot.offer.retired.other')));
  assert.ok(draw({ status: 'closed', expired: true }).includes(catalog('messages:bot.offer.expired')));
  assert.ok(draw({ status: 'closed' }).includes(catalog('messages:bot.actions.closed')), 'a plain close keeps its line');
  // The client keeps them.
  const kept = normalizeBotMeta({ homeroomBot: { kind: 'confirm', status: 'closed', retired: 'building', expired: true } }).homeroomBot;
  assert.deepEqual([kept.retired, kept.expired], ['building', true]);
  // A refused press: its code, as the server answered it, and its line.
  assert.deepEqual(refusalOf(new MessagesApiError(410, 'retired', 'retired', 'close_vote')), { code: 'retired', reason: 'close_vote' });
  assert.deepEqual(refusalOf(new Error('offline')), { code: 'failed', reason: null });
  assert.equal(refusalLine({ code: 'retired', reason: 'close_vote' }), retiredLine('close_vote'));
  assert.equal(refusalLine({ code: 'expired', reason: null }), 'messages:bot.offer.expired');
  assert.equal(refusalLine({ code: 'already_decided', reason: null }), 'messages:bot.offer.refused.alreadyDecided');
  assert.equal(refusalLine({ code: 'no_such_offer', reason: null }), 'messages:bot.offer.refused.gone');
  assert.equal(refusalLine({ code: 'something_else', reason: null }), 'messages:bot.offer.refused.failed');
  const line = renderToHtml(createElement(OfferRefused, { refusal: { code: 'already_decided', reason: null } }));
  assert.equal(line, `<p class="messages-bot-answered" role="status" data-bot-refused="already_decided">${catalog('messages:bot.offer.refused.alreadyDecided')}</p>`);
  assert.equal(renderToHtml(createElement(OfferRefused, { refusal: null })), '');
  // After the buttons' group, in both the question and the plan.
  const src = read('frontend/src/features/messages/bot-question.tsx');
  const body = src.slice(src.indexOf('function BotActions('));
  assert.ok(body.indexOf('<OfferRefused refusal={refused} />') > body.indexOf('className="messages-bot-answers"'));
  assert.ok(body.indexOf('<OfferRefused refusal={refused} />') > body.indexOf('</div>\n      ) : null}'), 'outside the group');
  assert.match(read('frontend/src/features/messages/bot-plan.tsx'), /state === 'open' && refused \? <OfferRefused refusal=\{refused\} \/> : null/);
});

test('"done already" is one message: Propose to close is decided, Tell me what\'s missing is written', () => {
  const { BotQuestion } = loadTsx('frontend/src/features/messages/bot-question.tsx');
  const html = renderToHtml(createElement(BotQuestion, {
    message: message(BOT, 61, { content: 'This looks done already: the list sorts by date.', metadata: { homeroomBot: {
      kind: 'done', appSlug: 'plant-pal', issueNumber: 4, status: 'open', actionId: 12,
      actions: [{ id: 'yes', label: 'Propose to close', type: 'server' }, { id: 'missing', label: 'Tell me what’s missing', type: 'reply' }],
    } } }),
    conversationId: 42,
  }));
  assert.match(html, /<button type="button" class="messages-bot-secondary" data-bot-answer="default"><span>Propose to close<\/span><\/button>/);
  assert.match(html, /<button type="button" class="messages-bot-secondary" data-bot-answer="other"><span>Tell me what’s missing<\/span><\/button>/);
  assert.match(html, /aria-label="Choices"/, 'a choice, not suggestions: both drawn, neither hidden by a plan');
  // A server button is decided once; a reply button quotes the message and stays.
  const source = read('frontend/src/features/messages/bot-question.tsx');
  assert.match(source, /if \(action\.type === 'reply'\) \{\s*quoteInComposer\(message, conversationId\);\s*return;\s*\}/);
});

// ── 7. The request's discussion rides along (#5219) ───────────────────────

test('a discussion message is drawn as a row that opens the request, with no actions', () => {
  const { DiscussionRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  const discussion = {
    id: 11, source: 'discussion', sender: ADA, content: 'Could the reminder go out the evening before too?',
    createdAt: '2026-10-09T11:40:00.000Z', editedAt: null,
  };
  const html = renderToHtml(createElement(DiscussionRow, { message: discussion, appSlug: 'plant-pal', issueNumber: 4 }));
  assert.match(html, /id="messages-discussion-11"/);
  assert.match(html, /data-discussion-message-id="11"/);
  assert.match(html, /href="#app\/plant-pal\/dev\/issues\/4">In the request&#x27;s discussion</,
    'the line under the name is the way to the request page');
  assert.match(html, /Could the reminder go out the evening before too\?/);
  assert.doesNotMatch(html, /<button|data-msgx|messages-actions/, 'no actions: taking part happens on the request page');
  const empty = renderToHtml(createElement(DiscussionRow, { message: { ...discussion, content: '' }, appSlug: 'plant-pal', issueNumber: 4 }));
  assert.doesNotMatch(empty, /messages-markdown/, 'no empty text block');
});

test('the thread pane reads the two lists as one transcript, counted together, and the composer stays', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const merged: MergedRow\[\] = \[/, 'the two lists become one');
  assert.match(screen, /merged\.sort\(\(a, b\) => \(a\.message\.createdAt < b\.message\.createdAt \? -1/);
  assert.match(screen, /row\.kind === 'reply' && row\.message\.id < 0/, 'a reply still in flight stays last');
  assert.match(screen, /t\('messages:replies\.count', \{ count: merged\.length \}\)/, 'the count is of both');
  assert.match(screen, /discussion\?\.more \? <a className="messages-load-older" href=\{issueRefHref\(discussion\.appSlug/);
  assert.match(screen, /<MessageComposer threadRootId=\{rootId\} scroller=\{scroller\} \/>/,
    'the composer is untouched: replies still go in the private thread');
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /discussion: null/, 'a loading thread carries no discussion');
  assert.match(store, /discussion: page\.discussion/, 'a loaded one carries it');
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /discussion: DiscussionState \| null/, 'the client reads the field off the response');
});

test('the discussion\'s words are in the catalog, in English', () => {
  assert.equal(catalog('messages:replies.discussion.from'), 'In the request\'s discussion');
  assert.equal(catalog('messages:replies.discussion.more'), 'Earlier messages are on the request\'s discussion');
});
