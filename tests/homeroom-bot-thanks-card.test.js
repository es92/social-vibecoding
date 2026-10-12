'use strict';

// #4392: right after the maker answers Homeroom bot's plan for their new
// project's first version (Build it, tapped or typed), the bot thanks them
// in their chat with it, over a card for the app: its thumbnail row and the
// build line, which follows the build (building, testing, ready to try).
// The server side (one message, its words and metadata) is pinned in
// tests/homeroom-bot-activity.test.js and tests/homeroom-bot-plan.test.js.
//
// Run with: node --test tests/homeroom-bot-thanks-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// One story: what is next, not a thanks (homeroom-bot-activity.js thanksText).
const THANKS = 'Building it now. I\'ll tell you when it\'s ready to try.';
const meta = { kind: 'activity', appSlug: 'run-club', appName: 'Run Club', issueNumber: 1, firstVersion: true, lookAt: 'x', thanks: true, appEmoji: '🏃' };
const botMsg = (id, m, extra = {}) => ({
  id, conversationId: 3, content: THANKS, createdAt: '2026-10-08T10:00:00Z', reactions: [], attachments: [], objects: [],
  sender: { id: 2, username: 'homeroom_bot', bot: true }, metadata: { homeroomBot: m }, ...extra,
});
const working = (extra) => ({
  messageId: 50, state: 'working', startedAt: null, workedFrom: null, links: {}, step: null, of: null, stepName: null, doing: null,
  outcome: null, endedAt: null, ...extra,
});

test('#4392: the thanks follows the build in the build line\'s own words', () => {
  const { thanksLine, BUILD_TYPICAL_MINUTES } = loadTsx('frontend/src/features/messages/bot-thanks-card.tsx');
  const building = { line: 'building', note: 'usually 10 to 25 min', words: null };
  assert.deepEqual(thanksLine(null), building, 'just sent, not read yet: it is being built');
  assert.deepEqual(thanksLine(working({ stage: 'build_queued' })), building, 'after Build it, waiting its turn is building it');
  assert.deepEqual(thanksLine(working({ stage: 'building' })), building);
  assert.deepEqual(thanksLine(working({ stage: 'checks' })), { line: 'testing', note: null, words: null });
  assert.deepEqual(thanksLine(working({ stage: 'vote' })), { line: 'ready', note: null, words: null });
  assert.deepEqual(thanksLine({ ...working(), state: 'done', outcome: 'checking' }).line, 'testing', 'built, its checks not through yet');
  assert.deepEqual(thanksLine({ ...working(), state: 'done', outcome: 'proposed' }).line, 'ready');
  assert.deepEqual(thanksLine({ ...working(), state: 'done', outcome: 'live' }).line, 'live');
  assert.deepEqual(thanksLine({ ...working(), state: 'done', outcome: 'build_failed' }),
    { line: null, note: null, words: 'Couldn’t finish building it' }, 'an ending that is not a build line says how it ended');
  assert.deepEqual(thanksLine(null, false), { line: null, note: null, words: null }, 'a card the reads no longer answer for: no line');
  // The same range the progress module says building takes.
  const { TYPICAL_MINUTES } = require('../src/services/homeroom-bot-progress');
  assert.deepEqual([BUILD_TYPICAL_MINUTES.from, BUILD_TYPICAL_MINUTES.to], [...TYPICAL_MINUTES.building]);
});

test('#4392: the thanks is drawn: its words, then the app\'s thumbnail row with the build line and its spinner', () => {
  const { BotThanksCardView, thanksLine, isThanksMessage } = loadTsx('frontend/src/features/messages/bot-thanks-card.tsx');
  const html = renderToHtml(createElement(BotThanksCardView, {
    meta, line: thanksLine(null), words: createElement('p', null, THANKS),
  }));
  assert.match(html, /data-bot-thanks="building"/);
  assert.ok(html.indexOf(THANKS.replace(/'/g, '&#x27;')) > -1 && html.indexOf(THANKS.replace(/'/g, '&#x27;')) < html.indexOf('data-bot-thanks-card'),
    'the words come first, the card under them');
  assert.match(html, /data-thumb-row=""/);
  assert.match(html, />Run Club</);
  assert.match(html, /🏃/, 'the project\'s icon is its tile');
  assert.match(html, /data-build-line="building"/);
  assert.match(html, /Building it · usually 10 to 25 min/);
  assert.match(html, /animate-spin/, 'with the build line\'s spinner');

  const ready = renderToHtml(createElement(BotThanksCardView, { meta, line: thanksLine({ ...working(), state: 'done', outcome: 'proposed' }) }));
  assert.match(ready, /data-build-line="ready"[\s\S]*Ready to try/);
  assert.doesNotMatch(ready, /animate-spin/);
  const failed = renderToHtml(createElement(BotThanksCardView, { meta, line: thanksLine({ ...working(), state: 'done', outcome: 'build_failed' }) }));
  assert.match(failed, /data-bot-thanks="ended"/);
  assert.match(failed, /Couldn’t finish building it/);
  assert.doesNotMatch(failed, /data-build-line/);

  // Which messages are the thanks: the bot's, marked so, and not moved on.
  assert.equal(isThanksMessage(botMsg(50, meta)), true);
  assert.equal(isThanksMessage(botMsg(50, { ...meta, thanks: undefined })), false, 'a card moved before the thanks existed');
  assert.equal(isThanksMessage(botMsg(50, { ...meta, movedTo: 60 })), false);
  assert.equal(isThanksMessage(botMsg(50, meta, { sender: { id: 9, username: 'ada' } })), false);
  assert.equal(isThanksMessage(botMsg(50, meta, { deleted: true })), false);
});

test('#4392: the transcript draws the thanks under the plan; an older moved card still is not drawn', () => {
  const { planLayout } = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const fv = { appSlug: 'run-club', appName: 'Run Club', issueNumber: 1, firstVersion: true };
  const plan = botMsg(30, { kind: 'plan', ...fv, plan: { bullets: ['Miles'], questions: [] }, actionId: 4, status: 'answered' });
  const above = botMsg(20, { kind: 'activity', ...fv, movedTo: 50 });
  const thanks = planLayout([above, plan, botMsg(50, meta)]);
  assert.deepEqual([...thanks.hidden], [], 'the thanks is drawn');
  assert.equal(thanks.cardOf.get(30), 50, 'and the plan still reads its step from it');
  const older = planLayout([above, plan, botMsg(50, { kind: 'activity', ...fv, lookAt: 'x' })]);
  assert.deepEqual([...older.hidden], [50]);

  const row = read('frontend/src/features/messages/message-row.tsx');
  const thanksAt = row.indexOf('isThanksMessage(message) ? (');
  assert.ok(thanksAt > -1 && thanksAt < row.indexOf('isActivityMessage(message) ? ('), 'decided before the activity card');
  assert.match(row, /<BotThanksCard message=\{message\} words=\{words\} \/>/);
});
