'use strict';

// #6228 (3 Nov 2026): the `bot_status` frame group-chat.js receives, and
// how it reaches the thread's status slot. A frame for another thread is
// kept out of the one on screen, "nothing to add" clears itself, the bot's
// own answer clears the line, and a request's page re-reads its track.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function setup() {
  const published = [];
  const refreshed = [];
  const timers = new Map();
  let nextTimer = 1;
  const sandbox = {
    window: {},
    URLSearchParams,
    location: { search: '' },
    document: { getElementById: () => null },
    App: { user: { id: 7, username: 'evan' } },
    AppView: { refreshDevData: (kind) => refreshed.push(kind) },
    PlatformI18n: { t: (id) => id },
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc._react = () => ({ publishComposer: (scope, patch) => published.push([scope, patch]) });
  gc.activeThread = { type: 'issue', ref: 5, language: 'request' };
  const flush = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  return { gc, published, refreshed, flush };
}

test('#6228: a frame for the open request publishes the bot line, and re-reads its track', () => {
  const h = setup();
  h.gc._applyBotStatus({ type: 'bot_status', thread: { type: 'issue', ref: 5 }, status: 'will_read', authorId: 7, replyId: 10 });
  const last = h.published.at(-1);
  assert.equal(last[0], 'thread');
  assert.equal(last[1].bot.state, 'will_read');
  assert.equal(last[1].bot.mine, true);
  assert.equal(h.refreshed[0], 'homeroom-bot', 'the card re-reads on the same frame');
  // Someone else's reply: "the reply", not "your reply".
  h.gc._applyBotStatus({ type: 'bot_status', thread: { type: 'issue', ref: 5 }, status: 'reading', authorId: 8, replyId: 10 });
  assert.equal(h.published.at(-1)[1].bot.mine, false);
});

test('#6228: another thread\'s frame does not show in the open one', () => {
  const h = setup();
  h.gc._applyBotStatus({ type: 'bot_status', thread: { type: 'issue', ref: 6 }, status: 'reading', authorId: 8, replyId: 1 });
  assert.equal(h.published.at(-1)[1].bot, null);
  assert.deepEqual(h.refreshed, []);
  // Switching to it shows its kept line; switching back shows the other's.
  h.gc.activeThread = { type: 'issue', ref: 6, language: 'flat' };
  h.gc._syncBotStatus();
  assert.equal(h.published.at(-1)[1].bot.state, 'reading');
  h.gc.activeThread = { type: 'issue', ref: 5, language: 'request' };
  h.gc._syncBotStatus();
  assert.equal(h.published.at(-1)[1].bot, null);
});

test('#6228: "nothing to add" fades after eight seconds', () => {
  const h = setup();
  h.gc._applyBotStatus({ type: 'bot_status', thread: { type: 'issue', ref: 5 }, status: 'quiet', authorId: 7, replyId: 1 });
  assert.equal(h.published.at(-1)[1].bot.state, 'quiet');
  h.flush();
  assert.equal(h.published.at(-1)[1].bot, null);
});

test('#6228: the bot\'s own answer is the end of its line', () => {
  const h = setup();
  h.gc._applyBotStatus({ type: 'bot_status', thread: { type: 'issue', ref: 5 }, status: 'reading', authorId: 7, replyId: 1 });
  h.gc._handleThreadIncoming({ id: 99, username: 'homeroom_bot', msgType: 'message', thread: { type: 'issue', ref: 5 } });
  assert.equal(h.published.at(-1)[1].bot, null);
});

// ── #6538: the line in a change, a channel and a reply thread ───────────

const slotOf = (published, scope) => published.filter(([s]) => s === scope).at(-1)[1];

test('#6538: a change\'s frame shows in the thread slot when that change is open', () => {
  const h = setup();
  h.gc.activeThread = { type: 'session', ref: 9, language: 'flat' };
  h.gc._applyBotStatus({ type: 'bot_status', thread: { type: 'session', ref: 9 }, status: 'reading', authorId: 7, replyId: 500 });
  assert.equal(slotOf(h.published, 'thread').bot.state, 'reading');
  assert.equal(slotOf(h.published, 'thread').bot.mine, true);
  assert.deepEqual(h.refreshed, [], 'only a request\'s page re-reads its track');
  // Another change's frame stays out of this one: this one keeps its own.
  h.gc._applyBotStatus({ type: 'bot_status', thread: { type: 'session', ref: 10 }, status: 'will_read', authorId: 7, replyId: 1 });
  assert.equal(slotOf(h.published, 'thread').bot.state, 'reading');
});

test('#6538: a channel\'s frame shows in the general slot while that channel is open', () => {
  const h = setup();
  h.gc._channel = { type: 'category', ref: 12 };
  h.gc._applyBotStatus({ type: 'bot_status', thread: { type: 'category', ref: 12 }, status: 'will_read', authorId: 7, replyId: 500 });
  assert.equal(slotOf(h.published, 'general').bot.state, 'will_read');
  // Another topic is on screen: its line is not this one's.
  h.gc._channel = { type: 'category', ref: 13 };
  h.gc._syncBotStatus();
  assert.equal(slotOf(h.published, 'general').bot, null);
  // Back to it: its line is still kept.
  h.gc._channel = { type: 'category', ref: 12 };
  h.gc._syncBotStatus();
  assert.equal(slotOf(h.published, 'general').bot.state, 'will_read');
  assert.deepEqual(h.refreshed, []);
});

test('#6538: the main channel\'s line shows when no channel is set', () => {
  const h = setup();
  h.gc._applyBotStatus({ type: 'bot_status', thread: { type: 'chat', ref: null }, status: 'reading', authorId: 8, replyId: 700 });
  assert.equal(slotOf(h.published, 'general').bot.state, 'reading');
  assert.equal(slotOf(h.published, 'general').bot.mine, false);
  assert.deepEqual(h.refreshed, []);
});

test('#6538: the bot\'s answer in the reply thread clears the channel\'s line', () => {
  const h = setup();
  h.gc._applyBotStatus({ type: 'bot_status', thread: { type: 'chat', ref: null }, status: 'reading', authorId: 7, replyId: 42 });
  assert.equal(slotOf(h.published, 'general').bot.state, 'reading');
  // A channel answers in the reply thread under the person's message.
  h.gc._handleThreadIncoming({ id: 99, username: 'homeroom_bot', msgType: 'message', thread: { type: 'message', ref: 42 } });
  assert.equal(slotOf(h.published, 'general').bot, null);
});

test('#6538: the bot\'s answer in a change\'s discussion clears its line', () => {
  const h = setup();
  h.gc.activeThread = { type: 'session', ref: 9, language: 'flat' };
  h.gc._applyBotStatus({ type: 'bot_status', thread: { type: 'session', ref: 9 }, status: 'reading', authorId: 7, replyId: 500 });
  assert.equal(slotOf(h.published, 'thread').bot.state, 'reading');
  h.gc._handleThreadIncoming({ id: 99, username: 'homeroom_bot', msgType: 'message', thread: { type: 'session', ref: 9 } });
  assert.equal(slotOf(h.published, 'thread').bot, null);
});

