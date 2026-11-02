'use strict';

// B09 (overnight audit, 1 Nov 2026): the Homeroom bot's plan, "live" and
// hello messages lost their cards on private projects ("Cards refused;
// sending the message without them"), because each card was checked as the
// bot, which is no member there. The project's visibility is asked of the
// person the message is for; the object itself is still the sender's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sharedObjects = require('../src/services/shared-objects');

const ROOT = path.join(__dirname, '..');
const BOT = 900;
const MAKER = 5;

function privateAppPool({ sessionOwner = BOT } = {}) {
  return {
    query: async (sql, params) => {
      if (/FROM user_app_blocks/.test(sql)) return { rows: [] };
      if (sql.includes('FROM apps WHERE id = $1')) {
        return { rows: [{
          id: 7, slug: 'rota', name: 'Rota', repo_url: 'https://github.com/example/rota.git',
          view_visibility: 'private', collab_visibility: 'private',
        }] };
      }
      if (/FROM app_collaborators/.test(sql)) {
        return { rows: Number(params[1]) === MAKER ? [{ '?column?': 1 }] : [] };
      }
      if (/FROM chat_sessions/.test(sql)) {
        // The row check keeps the sender's own id ($3).
        return { rows: Number(params[2]) === sessionOwner ? [{ id: params[0], app_id: 7, user_id: sessionOwner }] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('a card about a private project is refused when judged as the bot alone', async () => {
  const pool = privateAppPool();
  assert.equal(await sharedObjects.validateForShare(pool, { id: BOT }, { type: 'app', appId: 7 }), null);
});

test('the bot\'s card is checked against the person it is for', async () => {
  const pool = privateAppPool();
  const app = await sharedObjects.validateForShare(pool, { id: BOT }, { type: 'app', appId: 7 }, { viewer: { id: MAKER } });
  assert.equal(app?.objectType, 'app');
  const change = await sharedObjects.validateForShare(pool, { id: BOT }, { type: 'proposal', appId: 7, sessionId: 12 },
    { viewer: { id: MAKER } });
  assert.equal(change?.objectType, 'code_proposal');
});

test('a viewer who cannot see the project still gets no card', async () => {
  const pool = privateAppPool();
  assert.equal(await sharedObjects.validateForShare(pool, { id: BOT }, { type: 'app', appId: 7 }, { viewer: { id: 6 } }), null);
});

test('the object itself is still the sender\'s: a viewer does not widen the row check', async () => {
  const pool = privateAppPool({ sessionOwner: 77 });
  assert.equal(await sharedObjects.validateForShare(pool, { id: BOT }, { type: 'proposal', appId: 7, sessionId: 12 },
    { viewer: { id: MAKER } }), null);
});

test('only the bot\'s DM names a viewer, and the route never does', () => {
  const dm = fs.readFileSync(path.join(ROOT, 'src/services/homeroom-bot-dm.js'), 'utf8');
  const conv = fs.readFileSync(path.join(ROOT, 'src/services/conversations.js'), 'utf8');
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/conversations.js'), 'utf8');
  assert.match(dm, /cardsViewer: \{ id: Number\(userId\) \}/);
  assert.match(conv, /validateForShare\(db, user, raw, \{ conversationId, viewer: cardsViewer \}\)/);
  assert.doesNotMatch(route, /cardsViewer/);
});
