'use strict';

// One request, one story: threads in the chat with Homeroom bot (client).
//
// Every request the bot works on for someone has one story: its activity
// card in their chat with the bot is the root of that request's reply
// thread, where its steps, questions, plan, answers and ending are posted.
// The four moments that ring (needs you, ready to try, stopped, live) are
// also listed in the main chat (`alsoInChat`). Pinned here:
//
//   1. Where threads are: rooms, and the chat with Homeroom bot alone among
//      direct chats (`threadsAllowed`, the one place the client says so).
//   2. What a moment in the main stream is: a position in it for the read
//      cursor and the unread count (`inMainStream`, unread-anchor messageRow).
//   3. The names: the thread pane's title, the "↳ in …" label over a moment
//      and the composer's "Reply about …" placeholder.
//   4. The drawing: a moment in the main chat is the whole message under
//      its label (never the rooms' thread line); a request's card says
//      "N updates in its thread ›"; a step line reads quietly; a plan in a
//      thread hides no card and reads the card it hangs off.
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
  assert.match(screen, /botChat=\{botDm\}/);
  assert.match(read('frontend/src/features/messages/composer.tsx'), /inThread && active\.kind === 'direct' && threadsAllowed\(active\)/);
  assert.match(read('frontend/src/features/messages/store.ts'), /!threadsAllowed\(state\.active\)/);
});

// ── 2. The main stream ────────────────────────────────────────────────────

test('a moment the bot also lists in the main chat is a position in it; another thread reply is not', () => {
  const { alsoInChat, inMainStream } = loadTsx(SHARED);
  const moment = { threadRootId: 9, metadata: { homeroomBot: { kind: 'question', alsoInChat: true } } };
  const quiet = { threadRootId: 9, metadata: { homeroomBot: { kind: 'step' } } };
  assert.equal(alsoInChat(moment), true);
  assert.equal(alsoInChat(quiet), false);
  assert.equal(alsoInChat({ threadRootId: null, metadata: { homeroomBot: { alsoInChat: true } } }), false, 'only a reply is also shown');
  assert.equal(inMainStream({ threadRootId: null }), true);
  assert.equal(inMainStream(moment), true);
  assert.equal(inMainStream(quiet), false);

  const { messageRow } = loadTsx('frontend/src/features/messages/unread-anchor.ts');
  assert.equal(messageRow({ id: 5, sender: BOT, ...moment }, 7).countable, true, 'counted as the server counts it');
  assert.equal(messageRow({ id: 6, sender: BOT, ...quiet }, 7).countable, false);
  // The read cursor moves to the newest main-stream position, a moment included.
  assert.match(read('frontend/src/features/messages/store.ts'), /if \(item\.id > 0 && inMainStream\(item\)\) return item\.id;/);
});

test('the client keeps the thread and moment fields of a bot message', () => {
  const { normalizeBotMeta } = loadTsx('frontend/src/features/messages/api.ts');
  const meta = normalizeBotMeta({ homeroomBot: {
    kind: 'question', threadRootId: 31, moment: 'needs_you', said: 'question', requestTitle: 'Dark mode',
    waiting: 'you and @ada', count: 2, alsoInChat: true, appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 4,
  } }).homeroomBot;
  assert.deepEqual(
    [meta.threadRootId, meta.moment, meta.said, meta.requestTitle, meta.waiting, meta.count, meta.alsoInChat],
    [31, 'needs_you', 'question', 'Dark mode', 'you and @ada', 2, true],
  );
  const bare = normalizeBotMeta({ homeroomBot: { kind: 'step', alsoInChat: 'yes', threadRootId: -1 } }).homeroomBot;
  assert.equal('alsoInChat' in bare, false, 'only a real true');
  assert.equal('threadRootId' in bare, false);
});

// ── 3. The names ──────────────────────────────────────────────────────────

test('a request\'s thread is named by the request, and a moment\'s label says which', () => {
  const { botRequestNames, botThreadTitle, botThreadLabel } = loadTsx(SHARED);
  const titled = botRequestNames({ appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 4, requestTitle: 'Dark mode' });
  assert.equal(botThreadTitle(titled), 'Dark mode');
  assert.equal(botThreadLabel(titled), '↳ in Dark mode · Plant Pal');
  // An activity card names its request by `issueTitle`.
  assert.equal(botThreadTitle(botRequestNames({ appName: 'Plant Pal', issueNumber: 4, issueTitle: 'Water reminders' })), 'Water reminders');
  const first = botRequestNames({ appName: 'Plant Pal', issueNumber: 1, firstVersion: true, requestTitle: null });
  assert.equal(botThreadTitle(first), 'Plant Pal first version');
  assert.equal(botThreadLabel(first), '↳ in Plant Pal first version · Plant Pal');
  const untitled = botRequestNames({ appName: 'Plant Pal', issueNumber: 9 });
  assert.equal(botThreadTitle(untitled), 'Request #9');
  assert.equal(botThreadLabel(untitled), '↳ in request #9 · Plant Pal');
});

test('the composer inside a request\'s thread says what a reply is about', () => {
  assert.equal(catalog('messages:composer.placeholderBotThread', { request: 'Dark mode' }), 'Reply about Dark mode…');
  assert.equal(catalog('messages:composer.placeholderBotThreadFirstVersion', { project: 'Plant Pal' }), 'Reply about Plant Pal’s first version…');
  assert.equal(catalog('messages:composer.placeholderBotThreadNumbered', { number: '9' }), 'Reply about request #9…');
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /placeholder=\{inThread \? threadPlaceholder : \(prompt \|\| t\('messages:composer\.placeholder'\)\)\}/);
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

test('a moment in the main chat is the whole message under its label, which opens the thread', () => {
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  const moment = message(BOT, 40, {
    threadRootId: 31,
    content: 'I have a question before I build it.',
    metadata: { homeroomBot: { kind: 'question', appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 4, requestTitle: 'Dark mode', alsoInChat: true, threadRootId: 31 } },
  });
  const html = renderToHtml(createElement(MessageRow, { message: moment, conversationId: 42, kind: 'direct', botChat: true }));
  assert.match(html, /<button type="button" class="[^"]*" data-bot-thread-label="31">↳ in Dark mode · Plant Pal<\/button>/);
  assert.match(html, /I have a question before I build it\./, 'the message itself, not a line about the thread');
  // In its thread it is a reply like any other, with no label.
  const inThread = renderToHtml(createElement(MessageRow, { message: moment, conversationId: 42, kind: 'direct', botChat: true, inThread: true }));
  assert.doesNotMatch(inThread, /data-bot-thread-label/);
});

test('a request\'s card says how many updates its thread holds, in words; rooms keep their chip', () => {
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  const card = message(BOT, 31, { content: 'Dark mode', metadata: { homeroomBot: META }, thread: THREAD });
  const html = renderToHtml(createElement(MessageRow, { message: card, conversationId: 42, kind: 'direct', botChat: true }));
  assert.match(html, /data-bot-thread-link="31">3 updates in its thread ›<\/button>/);
  assert.doesNotMatch(html, /msgx-thread-summary|msgx-thread-face/);
  const one = renderToHtml(createElement(MessageRow, { message: { ...card, thread: { ...THREAD, replyCount: 1 } }, conversationId: 42, kind: 'direct', botChat: true }));
  assert.match(one, />1 update in its thread ›</);
  // A room's message with a thread keeps the rooms' summary.
  const room = message(ADA, 50, { content: 'lunch?', thread: { ...THREAD, participants: [ADA] } });
  const roomHtml = renderToHtml(createElement(MessageRow, { message: room, conversationId: 42, kind: 'group' }));
  assert.doesNotMatch(roomHtml, /data-bot-thread-link/);
});

test('a step line in a request\'s thread reads quietly', () => {
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  const step = message(BOT, 41, { threadRootId: 31, content: 'Reading it.', metadata: { homeroomBot: { kind: 'step', appSlug: 'plant-pal', issueNumber: 4 } } });
  const html = renderToHtml(createElement(MessageRow, { message: step, conversationId: 42, kind: 'direct', botChat: true, inThread: true }));
  assert.match(html, /<div class="messages-bot-step [^"]*text-zinc-500[^"]*" data-bot-step="">/);
  assert.match(html, /Reading it\./);
});

test('the transcript draws a moment whole in the bot\'s chat, and keeps the rooms\' thread line elsewhere', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const moment = botDm && alsoInChat\(message\);\s*if \(message\.threadRootId && !moment\) \{/);
  assert.match(screen, /rows\.push\(<ThreadActivityRow key=/, 'rooms keep ThreadActivityRow');
  assert.match(screen, /const grouped = !moment && !!previous/, 'a moment carries its own name');
  // The thread pane names a request's thread by the request, over its project.
  assert.match(screen, /\{request \? botThreadTitle\(request\) : t\('messages:replies\.title'\)\}/);
  assert.match(screen, /const where = request \? request\.project :/);
});

test('a plan in its request\'s thread hides no card and reads the card it hangs off', () => {
  const { planLayout } = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const card = message(BOT, 31, { content: 'Dark mode', metadata: { homeroomBot: META }, thread: THREAD });
  const plan = message(BOT, 33, {
    threadRootId: 31, content: 'My plan',
    metadata: { homeroomBot: { kind: 'plan', appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 4, status: 'open', actionId: 5, plan: { bullets: ['Add a dark theme'], questions: [] }, alsoInChat: true } },
  });
  const layout = planLayout([card, plan]);
  assert.equal(layout.hidden.has(31), false, 'the card is the way into the thread');
  assert.equal(layout.cardOf.get(33), 31);
  assert.equal(layout.answersOpen, true);
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
