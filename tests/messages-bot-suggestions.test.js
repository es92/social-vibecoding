'use strict';

// #4097 follow-up: suggested replies in the Homeroom bot's DM, so there is
// always an obvious next thing to tap.
//
//   1. Its chat replies offer up to three short things to say next (the
//      reply tool's `suggestions`), drawn as the prompt buttons the hellos
//      already use; one too long for a button, or a repeat, is left out.
//   2. Where its work is stuck, it says what to tap: Try again under a build
//      that did not finish and Go ahead under one a person must decide, both
//      sent quoting the message; Add detail under one it cannot build as
//      written or found nothing in, which quotes it in the composer. A tap
//      posted on the request's public discussion says so before it is made.
//   3. Only the newest message's suggestions stay live: the bot's next
//      message retires them (homeroom-bot-dm.js retireSuggestions), and a
//      retired suggestion is drawn as nothing, never "No longer needed.",
//      which stays for a decision that was overtaken.
//
// The database half (the news carrying its buttons, retiring them, a model's
// reply) is in tests/homeroom-bot-dm-postgres.test.js and
// tests/homeroom-bot-mayor-postgres.test.js.
//
// Run with: node --test tests/messages-bot-suggestions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const dm = require('../src/services/homeroom-bot-dm');
const mayor = require('../src/services/homeroom-bot-mayor');

// ── 1. A reply's suggestions ────────────────────────────────────────────

test('the model is asked for what they might say next, and its suggestions become prompt buttons', () => {
  const reply = mayor.TOOLS.find((tool) => tool.function.name === 'reply').function.parameters;
  assert.equal(reply.properties.suggestions.type, 'array');
  assert.equal(reply.properties.suggestions.maxItems, 3);
  assert.deepEqual(reply.required, ['text'], 'never required: a reply can stand without them');
  const source = read('src/services/homeroom-bot-mayor.js');
  assert.match(source, /up to 3 suggestions: short things they might say next, in their own/);
  assert.match(source, /Offer at least one',\s*'unless the conversation has plainly ended\.'/);
  assert.deepEqual(mayor.suggestionLabels([
    '  How long will   it take? ', 'how long will it take?', 'x'.repeat(61), '', null, 42, 'Start it now', 'Show my requests', 'One more',
  ]), ['How long will it take?', 'Start it now', 'Show my requests'], 'plain, each once, at most three, none cut mid-word');
  assert.deepEqual(mayor.suggestionLabels(undefined), []);
  assert.match(source, /\.\.\.\(next\.length \? \{ actions: require\('\.\/homeroom-bot-dm'\)\.promptActions\(next\), status: 'open' \} : \{\}\)/);
});

// ── 2. Where it is stuck ────────────────────────────────────────────────

test('a stuck build, one it cannot build, one with nothing in it and one a person decides each say what to tap', () => {
  assert.deepEqual(dm.STUCK_ACTIONS, {
    build_failed: [{ id: 'try_again', label: 'Try again', style: 'primary', type: 'prompt', quote: true }],
    blocked: [{ id: 'add_detail', label: 'Add detail', style: 'primary', type: 'reply' }],
    empty: [{ id: 'add_detail', label: 'Add detail', style: 'primary', type: 'reply' }],
    person: [{ id: 'go_ahead', label: 'Go ahead', style: 'primary', type: 'prompt', quote: true }],
  });
  // Each matches what its words ask for (dmText).
  const context = { appName: 'Todo List', issueNumber: 93, issueTitle: 'Print view' };
  assert.match(dm.dmText('build_failed', { reason: 'x' }, context), /Reply here and I'll try again\.$/);
  assert.match(dm.dmText('blocked', { reason: 'x' }, context), /Reply to this message with more detail/);
  assert.match(dm.dmText('empty', {}, context), /Reply to this message with what you'd like/);
  assert.match(dm.dmText('person', { reason: 'x' }, context), /reply to this message and say so/);
  assert.match(read('src/services/homeroom-bot-dm.js'), /\.\.\.\(STUCK_ACTIONS\[kind\] && !\(kind === 'person' && \(dm\.platform \|\| personDeciders\(dm\)\.length\)\)\n\s+\? \{ actions: STUCK_ACTIONS\[kind\], status: 'open' \} : \{\}\),/,
    '#4239: every stuck kind but a request about Homeroom itself, whose move offer follows, and one somebody else decides');
  assert.equal(dm.suggestsOnly({ actions: dm.STUCK_ACTIONS.build_failed }), true);
  assert.equal(dm.suggestsOnly({ actions: dm.promptActions(['a', 'b']) }), true);
  assert.equal(dm.suggestsOnly({ actions: [{ type: 'server' }, { type: 'prompt' }] }), false, 'an offer is a decision');
  assert.equal(dm.suggestsOnly({ actions: [{ type: 'preview' }, { type: 'vote' }, { type: 'reply' }] }), false, 'so is a ready card');
  assert.equal(dm.suggestsOnly({}), false);
});

// ── The buttons, drawn ──────────────────────────────────────────────────

const taps = [];
const replies = [];
const { BotQuestion } = loadTsx('frontend/src/features/messages/bot-question.tsx', {
  stubs: {
    './store': {
      answerBotQuestion() {},
      scopeKey: () => 'k',
      setReply: (scope, message) => replies.push(message ? message.id : null),
      async tapBotAction(message, action) { taps.push(action.id); },
    },
  },
});
const message = (meta) => ({
  id: 7, conversationId: 3, content: 'x', createdAt: 'now', reactions: [], attachments: [], objects: [],
  sender: { id: 2, username: 'homeroom_bot', bot: true }, metadata: { homeroomBot: meta },
});
const draw = (meta) => renderToHtml(createElement(BotQuestion, { message: message(meta), conversationId: 3 }));
const NEWS = { appName: 'Todo List', appSlug: 'todo-list', issueNumber: 93, status: 'open' };

test('a step to take on the message is a filled button; a suggestion keeps the pill', () => {
  const tryAgain = draw({ ...NEWS, kind: 'build_failed', actions: dm.STUCK_ACTIONS.build_failed });
  assert.match(tryAgain, /aria-label="What you can do next"><button type="button" class="messages-bot-primary" data-bot-answer="default" data-bot-prompt=""><span>Try again<\/span><\/button>/);
  assert.doesNotMatch(tryAgain, /public discussion/, 'a build that did not finish is not mirrored: Try again reaches the bot alone');
  const asks = draw({ kind: 'chat', status: 'open', actions: dm.promptActions(['How long will it take?']) });
  assert.match(asks, /aria-label="Questions you can ask"><button type="button" data-bot-answer="default" data-bot-prompt=""><span>How long will it take\?<\/span>/);
});

test('a tap posted where the group reads it says so first', () => {
  const html = draw({ ...NEWS, kind: 'person', mirrors: true, actions: dm.STUCK_ACTIONS.person });
  assert.match(html, /<span>Go ahead<\/span>/);
  assert.match(html, /Your answer is posted on Todo List request #93’s public discussion, where the group can see it\./);
  const detail = draw({ ...NEWS, kind: 'blocked', mirrors: true, actions: dm.STUCK_ACTIONS.blocked });
  assert.match(detail, /class="messages-bot-primary" data-bot-answer="default"><span>Add detail<\/span>/);
  assert.doesNotMatch(detail, /public discussion/, 'Add detail only opens the reply bar, which says it itself');
});

test('a retired suggestion is drawn as nothing; a decision overtaken still says so', () => {
  assert.equal(draw({ kind: 'chat', status: 'closed', actions: dm.promptActions(['How long will it take?']) }), '');
  assert.equal(draw({ ...NEWS, kind: 'build_failed', status: 'closed', actions: dm.STUCK_ACTIONS.build_failed }), '');
  assert.match(draw({ kind: 'confirm', status: 'closed', actionId: 1, actions: [{ id: 'yes', label: 'File it', style: 'primary', type: 'server' }] }),
    /No longer needed\./);
  assert.match(draw({ ...NEWS, kind: 'build_failed', status: 'answered', answer: 'Try again', chosen: 'try_again', actions: dm.STUCK_ACTIONS.build_failed }),
    /You chose Try again/, 'a step taken reads as chosen');
  assert.match(draw({ kind: 'chat', status: 'answered', answer: 'How long will it take?', chosen: 'ask-1', actions: dm.promptActions(['How long will it take?']) }),
    /You asked: How long will it take\?/, 'a question asked, as asked');
});

test('Try again replies to its message; Add detail quotes it in the composer and stays', () => {
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /if \(action\.quote\) setReply\(scope, message\);\s*else if \(staged\) setReply\(scope, null\);\s*const sending = send\(\{ content: action\.label \}\);\s*if \(action\.quote \|\| staged\) setReply\(scope, staged \|\| null\);/);
  const question = read('frontend/src/features/messages/bot-question.tsx');
  assert.match(question, /if \(action\.type === 'reply'\) \{\s*quoteInComposer\(message, conversationId\);\s*return;\s*\}/);
  const api = loadTsx('frontend/src/features/messages/api.ts');
  const meta = api.normalizeBotMeta({ homeroomBot: { kind: 'build_failed', status: 'open', actions: [
    { id: 'try_again', label: 'Try again', style: 'primary', type: 'prompt', quote: true },
    { id: 'x', label: 'X', style: 'secondary', type: 'server', quote: true },
  ] } }).homeroomBot;
  assert.deepEqual(meta.actions, [
    { id: 'try_again', label: 'Try again', style: 'primary', type: 'prompt', quote: true },
    { id: 'x', label: 'X', style: 'secondary', type: 'server' },
  ], 'only a prompt quotes');
});

test('the staging preview’s declared check finds Try again in the demo DM', () => {
  const check = JSON.parse(read('dapp.json')).tests.find((t) => /^#4097:/.test(t.name));
  assert.match(check.expectSelector, /^#messages-screen:not\(\.hidden\):has\(\.messages-message button\.messages-bot-primary\[data-bot-prompt\]\) /);
  assert.ok(check.expectSelector.length <= 256, 'within what the runner reads');
  const fixture = read('src/services/staging-messages.js');
  assert.match(fixture, /homeroomBot: \{ kind: 'build_failed', \.\.\.stuck, actions: dm\.STUCK_ACTIONS\.build_failed, status: 'open' \}/);
});
