'use strict';

// B16 (overnight audit, 1 Nov 2026): in the chat with Homeroom bot, every
// answer to one request (its draft, its plan, its build) carried the same
// quote of it, so the whole request was repeated over each reply. The server
// keeps quoting what each answer answers (#3707, #3767: its news quotes
// where the request started, and a bell names it); the transcript draws the
// quote once per exchange: a bot answer quoting the message the bot's last
// drawn answer already quoted, with nobody else speaking between them and
// the same day, leaves it off.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the row leaves off a quote its exchange already showed', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /\{message\.reply && !quoteAgain \? <button type="button" className="messages-quote"/);
  assert.match(row, /quoteAgain = false,\n\}: \{/, 'off by default: every other chat draws its quotes as before');
});

test('the transcript decides it, in the chat with Homeroom bot alone', () => {
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /const quoteAgain = botDm && !!message\.sender\.bot && !!message\.reply && message\.reply\.id === quoted;/);
  assert.match(index, /if \(botDm && message\.sender\.bot && message\.reply\) quoted = message\.reply\.id;/);
  assert.match(index, /if \(!message\.sender\.bot\) quoted = null;/, 'somebody else speaking starts a new exchange');
  assert.match(index, /if \(day && day !== previousDay\) quoted = null;/, 'and so does a new day');
});
