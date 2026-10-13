'use strict';

// #4046: Homeroom bot shows one set of suggestions, and its plan card carries
// the build's step (onboarding PR 6, canvas boards C8 and C8b).
//
// While a plan or a question offers its own answers, the hello's questions
// to tap give way. A first version's plan is the one place its request's
// step shows: the activity card above the plan is not drawn, the plan reads
// its state for the line at its top, and the card Build it moves under the
// plan is not drawn either: Notify me is inside the plan while it builds.
// The card itself is pinned in tests/homeroom-bot-plan.test.js.
//
// Run with: node --test tests/homeroom-bot-plan-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const botMsg = (id, meta, extra = {}) => ({
  id, conversationId: 3, content: 'words', createdAt: '2026-10-06T10:00:00Z', reactions: [], attachments: [], objects: [],
  sender: { id: 2, username: 'homeroom_bot', bot: true }, metadata: { homeroomBot: meta }, ...extra,
});
const fvMeta = { appSlug: 'run-club', appName: 'Run Club', issueNumber: 1, firstVersion: true };
const RUN_PLAN = { bullets: ['Everyone\'s miles this week'], questions: [{ question: 'What counts?', answers: ['Own goal', 'Club goal'] }] };

test('#4046: while a plan or a question offers its own answers, the bot\'s questions to tap give way', () => {
  const { planLayout, offersAnswers } = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const hello = botMsg(10, {
    kind: 'first_version_started', appName: 'Run Club', status: 'open',
    actions: [{ id: 'ask-1', label: 'How long will this take?', style: 'secondary', type: 'prompt' }],
  });
  const plan = (status, extra = {}) => botMsg(30, { kind: 'plan', ...fvMeta, plan: RUN_PLAN, actionId: 4, status, ...extra });
  assert.equal(planLayout([hello]).answersOpen, false, 'nothing else asks: the hello keeps its questions');
  assert.equal(planLayout([hello, plan('open')]).answersOpen, true, 'the plan waits for Build it');
  assert.equal(planLayout([hello, plan('answered')]).answersOpen, false,
    'built: nothing holds them back (in production #4108 closed the hello\'s questions when the plan was sent)');
  assert.equal(planLayout([hello, plan('closed', { replaced: true })]).answersOpen, false);
  const question = botMsg(40, { kind: 'question', appName: 'Run Club', issueNumber: 2, question: 'Newest first?', answers: ['Yes', 'No'], status: 'open' });
  assert.equal(planLayout([hello, question]).answersOpen, true, 'an open question offers its own answers too');
  assert.equal(offersAnswers({ ...question, metadata: { homeroomBot: { ...question.metadata.homeroomBot, status: 'answered' } } }), false);
  assert.equal(offersAnswers(botMsg(41, { kind: 'confirm', status: 'open', question: 'File this?' })), false, 'an offer is a choice, not suggestions');
  assert.equal(offersAnswers({ ...question, sender: { id: 4, username: 'ada' } }), false, 'only the bot\'s own');

  const taps = [];
  const { BotQuestion } = loadTsx('frontend/src/features/messages/bot-question.tsx', {
    stubs: { './store': { answerBotQuestion() {}, scopeKey: () => 'k', setReply() {}, async tapBotAction(m, a) { taps.push(a.id); } } },
  });
  assert.match(renderToHtml(createElement(BotQuestion, { message: hello, conversationId: 3 })), /data-bot-prompt=""/);
  assert.equal(renderToHtml(createElement(BotQuestion, { message: hello, conversationId: 3, hidePrompts: true })), '', 'given way');
  const asked = botMsg(10, { ...hello.metadata.homeroomBot, status: 'answered', answer: 'How long will this take?', chosen: 'ask-1' });
  assert.match(renderToHtml(createElement(BotQuestion, { message: asked, conversationId: 3, hidePrompts: true })), /You asked: How long will this take\?/,
    'a question already asked still says so');
  assert.match(renderToHtml(createElement(BotQuestion, { message: question, conversationId: 3, hidePrompts: true })), /Newest first\?|data-bot-answer="default"/,
    'a question\'s own answers are never hidden');

  const screen = read('frontend/src/features/messages/index.tsx');
  // #4564: plans and the change blocks are read by one memo, for the bot's DM alone.
  assert.match(screen, /if \(!botDm\) return \{ plans: NO_PLAN_LAYOUT, blocks: null as ReadonlyMap<number, ChangeBlock> \| null \};/);
  assert.match(screen, /hidePrompts=\{plans\.answersOpen && !!message\.sender\.bot\}/);
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /<BotQuestion message=\{message\} conversationId=\{conversationId\} hidePrompts=\{hidePrompts\} \/>/);
});

test('#4046: the plan is the one place its request\'s step shows: the cards above and under it go', () => {
  const { planLayout, planProgress, planTime } = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const card = (id, extra = {}) => botMsg(id, { kind: 'activity', ...fvMeta, ...extra });
  const plan = (id, status, extra = {}) => botMsg(id, { kind: 'plan', ...fvMeta, plan: RUN_PLAN, actionId: 4, status, ...extra });
  const other = botMsg(25, { kind: 'activity', appSlug: 'run-club', appName: 'Run Club', issueNumber: 2 });

  // The plan waits: its request's card (sent when it was queued) is above it.
  const waiting = planLayout([card(20), other, plan(30, 'open')]);
  assert.deepEqual([...waiting.hidden], [20], 'the card above its plan is not drawn; another request\'s is');
  assert.equal(waiting.cardOf.get(30), 20, 'the plan reads its state');

  // Build it: the card is moved under the plan (cardUnderPlan) and the one above says where it went.
  const built = planLayout([card(20, { movedTo: 50 }), plan(30, 'answered', { choices: ['Own goal'] }), card(50, { lookAt: 'x' })]);
  assert.deepEqual([...built.hidden], [50], 'the card that follows the build is not drawn: the plan says it all');
  assert.equal(built.cardOf.get(30), 50, 'and the plan reads its state');

  // A newer plan replaced the first: only the newest reads the card.
  const again = planLayout([card(20), plan(30, 'closed', { replaced: true }), plan(40, 'open')]);
  assert.deepEqual([...again.hidden], [20]);
  assert.equal(again.cardOf.has(30), false);
  assert.equal(again.cardOf.get(40), 20);
  // A plan that stopped waiting reads nothing; its card stays out of the way.
  const stopped = planLayout([card(20), plan(30, 'closed', { stopped: true })]);
  assert.equal(stopped.cardOf.size, 0);
  assert.deepEqual([...stopped.hidden], [20]);
  // No plan, no change: every card is drawn as it was.
  const none = planLayout([card(20), other]);
  assert.deepEqual([none.hidden.size, none.cardOf.size, none.answersOpen], [0, 0, false]);

  // What the line at the plan's top says.
  const working = (extra) => ({ messageId: 20, state: 'working', startedAt: null, workedFrom: null, links: {}, step: null, of: null, stepName: null, doing: null, outcome: null, endedAt: null, ...extra });
  assert.deepEqual(planProgress(working({ step: 3, of: 7, stepName: 'Write a plan' }), 'open'), { line: 'Step 3 of 7', step: 3, of: 7 },
    'while it waits: the step, and nothing else');
  // One request, one story: the step leads by its name, as the chat says
  // it everywhere ("Building · step 4 of 7 · 10 to 25 min").
  assert.deepEqual(planProgress(working({ step: 4, of: 7, stepName: 'Building', typicalMinutes: { from: 10, to: 25 } }), 'built'),
    { line: 'Building · step 4 of 7 · 10 to 25 min', step: 4, of: 7 }, 'the step, its name, the time: short enough for one line');
  // The time is a kind and its numbers; the line that holds it is one whole message.
  assert.deepEqual(planTime({ from: 10, to: 25 }), { kind: 'range', from: 10, count: 25 });
  assert.deepEqual(planTime({ from: 3, to: 3 }), { kind: 'about', from: 3, count: 3 });
  assert.deepEqual(planProgress(working({ step: 4, of: 7, typicalMinutes: { from: 3, to: 3 } }), 'built'),
    { line: 'Step 4 of 7 · about 3 min', step: 4, of: 7 });
  assert.deepEqual(planProgress(working({ doing: 'building it', typicalMinutes: { from: 10, to: 25 } }), 'built'),
    { line: 'Building it · 10 to 25 min', step: null, of: null });
  assert.deepEqual(planProgress(working({ typicalMinutes: { from: 3, to: 3 } }), 'built'),
    { line: 'Working on it · about 3 min', step: null, of: null });
  assert.equal(planTime(null), null);
  assert.deepEqual(planProgress(working({ doing: 'ready to build; waiting its turn to be built' }), 'built'),
    { line: 'Ready to build; waiting its turn to be built', step: null, of: null }, 'a step it cannot count is said in words, with no bar');
  assert.deepEqual(planProgress({ ...working(), state: 'done', outcome: 'build_failed' }, 'built'),
    { line: 'Couldn’t finish building it', step: null, of: null });
  assert.equal(planProgress({ ...working(), state: 'done', outcome: 'proposed' }, 'open'), null);
  assert.equal(planProgress(working({ step: 3, of: 7 }), 'changing'), null, 'a plan that is not waiting or built says its own line');
  assert.equal(planProgress(null, 'open'), null);

  // Drawn: nothing in the bot's voice under the plan (the hello said it).
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.doesNotMatch(row, /underPlan|BotPlanFollowUp/);
  assert.match(row, /<BotPlanCard message=\{message\} conversationId=\{conversationId\} cardId=\{planCardId\} \/>/);
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /if \(plans\.hidden\.has\(message\.id\)\) continue;\s*\/\/[^\n]*\n\s*if \(newsFold\?\.hidden\.has\(message\.id\)\) continue;\s*const day = dayKey\(message\);/,
    'skipped before its day and its name are counted, as a moved card is');
  assert.match(screen, /planCardId=\{plans\.cardOf\.get\(message\.id\) \?\? null\}\s*hidePrompts=/);
  const host = read('frontend/src/features/messages/bot-plan.tsx');
  assert.match(host, /const state = planState\(meta, pressed\);\s*const card = cardId \? activity\.cards\.get\(cardId\) : null;/);
  assert.match(host, /progress=\{planProgress\(card, state\)\}/);
  for (const s of ['Step 3 of 7', 'My plan for', 'Change something']) assert.doesNotMatch(s, /—|!/);
});
