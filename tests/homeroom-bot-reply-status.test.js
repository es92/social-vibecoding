'use strict';

// #6228 (3 Nov 2026): what a request's thread says the bot is doing with a
// person's reply, and how that is published to the room.

const test = require('node:test');
const assert = require('node:assert/strict');

const replyStatus = require('../src/services/homeroom-bot-reply-status');

const NOW = new Date('2026-11-03T17:00:00Z');
const ago = (seconds) => new Date(NOW.getTime() - seconds * 1000).toISOString();
const status = (extra) => replyStatus.statusOf({ replyId: 500, now: NOW, ...extra });

test('#6228: the thread\'s three states, and when there is nothing to say', () => {
  // Queued or about to be: will read.
  assert.equal(status({ stage: { stage: 'reading', reply: true, waiting: true } }), 'will_read');
  assert.equal(status({ voiceOwed: true }), 'will_read');
  // Reading now: the turn began after the reply, or the read started.
  assert.equal(status({ voice: [{ started_at: ago(5), finished_at: null, outcome: null }], replyAt: ago(30) }), 'reading');
  assert.equal(status({ stage: { stage: 'reading', reply: true } }), 'reading');
  // Nothing to add: the bot was spoken to, read the reply, and stopped.
  assert.equal(status({
    voice: [{ started_at: ago(20), finished_at: ago(10), outcome: 'quiet', speaker_id: 9, through_message_id: 500 }],
  }), 'quiet');
  // The bot's answer is there: nothing to say.
  assert.equal(status({ botAfter: true, stage: { stage: 'reading', reply: true } }), null);
  // It read a message nobody addressed to it: never "nothing to add".
  assert.equal(status({
    voice: [{ started_at: ago(20), finished_at: ago(10), outcome: 'quiet', speaker_id: null, through_message_id: 500 }],
  }), null);
  // An old quiet turn no longer shows.
  assert.equal(status({
    voice: [{ started_at: ago(120), finished_at: ago(90), outcome: 'quiet', speaker_id: 9, through_message_id: 500 }],
  }), null);
  // No reply at all.
  assert.equal(replyStatus.statusOf({ replyId: null, now: NOW }), null);
});

test('#6228: a status is broadcast to the project and the bot page re-reads for both people', async () => {
  const frames = [];
  const changed = [];
  const pool = {
    query: async (sql) => {
      if (/FROM UNNEST\(\$2::int\[\]\) AS w\(n\)/.test(sql)) {
        return { rows: [{
          app_id: 1, slug: 'homeroom', issue_number: 2, mode: 'live', verdict: 'person',
          run_at: ago(600), reply_id: 500, reply_at: ago(30), reply_user_id: 8, queue_id: 3, enqueued_at: ago(20),
        }] };
      }
      return { rows: [] };
    },
  };
  const deps = {
    ws: { broadcast: (appId, data) => frames.push([appId, data]) },
    workChanged: { noteWorkChanged: (userId) => changed.push(userId) },
    dm: { requesterOf: async () => ({ userId: 7 }) },
  };
  const out = await replyStatus.publish(pool, { appId: 1, issueNumber: 2, deps });
  // #6538: publish resolves the status it broadcast.
  assert.equal(out, 'will_read');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], [1, {
    type: 'bot_status', thread: { type: 'issue', ref: 2 }, status: 'will_read', authorId: 8, replyId: 500,
  }]);
  assert.deepEqual(changed.sort(), [7, 8], 'the requester and the person who replied');
});

test('#6228: publishing never throws, even with a broken read', async () => {
  const pool = { query: async () => { throw new Error('database down'); } };
  await replyStatus.publish(pool, { appId: 1, issueNumber: 2, deps: { ws: { broadcast() {} } } });
});

// ── #6538: every place the voice answers in, not only a request ──────────

test('#6538: a running turn is "reading" only when the bot is answering', () => {
  const running = [{ started_at: ago(5), finished_at: null, outcome: null }];
  assert.equal(status({ voice: running, replyAt: ago(30), answerable: false }), null,
    'a turn reading an ordinary channel message does not light the line');
  assert.equal(status({ voice: running, replyAt: ago(30) }), 'reading');
});

/** A pool for a non-request place: the newest message, its turns, its answer. */
function placePool({ message = null, turns = [], answered = false, seen = [] } = {}) {
  return {
    query: async (sql, params) => {
      if (/FROM homeroom_bot_voice_turns/.test(sql)) return { rows: turns };
      if (/ORDER BY m.id DESC LIMIT 1/.test(sql)) return { rows: message ? [message] : [] };
      if (/SELECT 1 FROM chat_messages/.test(sql)) {
        seen.push({ sql, params });
        return { rows: answered ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

test('#6538: a change\'s discussion broadcasts its own place, with no request nudges', async () => {
  const frames = [];
  let nudged = 0;
  const deps = {
    ws: { broadcast: (appId, data) => frames.push([appId, data]) },
    workChanged: { noteWorkChanged: () => { nudged += 1; } },
    dm: { requesterOf: async () => { nudged += 1; return null; } },
  };
  const pool = placePool({ message: { id: 500, user_id: 8, created_at: ago(30) } });
  const out = await replyStatus.publish(pool, {
    appId: 1, place: { type: 'session', ref: 9 }, voiceOwed: true, answerable: true, deps,
  });
  assert.equal(out, 'will_read');
  assert.deepEqual(frames, [[1, {
    type: 'bot_status', thread: { type: 'session', ref: 9 }, status: 'will_read', authorId: 8, replyId: 500,
  }]]);
  assert.equal(nudged, 0, 'only a request nudges its requester and the work tray');
});

test('#6538: a channel\'s place is null-ref, and its answer is the bot\'s message under the reply', async () => {
  const frames = [];
  const seen = [];
  const deps = { ws: { broadcast: (appId, data) => frames.push([appId, data]) } };
  const running = [{ started_at: ago(5), finished_at: null, outcome: null }];
  // The bot answered in the reply thread under message 700: nothing to say,
  // even with a turn still running.
  const pool = placePool({
    message: { id: 700, user_id: 8, created_at: ago(30) }, turns: running, answered: true, seen,
  });
  const out = await replyStatus.publish(pool, {
    appId: 1, place: { type: 'chat', ref: null }, answerable: true, deps,
  });
  assert.equal(out, null);
  assert.deepEqual(frames, [[1, {
    type: 'bot_status', thread: { type: 'chat', ref: null }, status: null, authorId: 8, replyId: 700,
  }]]);
  const answered = seen.find((q) => /thread_type = 'message'/.test(q.sql));
  assert.ok(answered, 'the channel reads the answer from the reply thread under the message');
  assert.deepEqual(answered.params, [1, 700]);
});

test('#6538: skipEmpty keeps a status-less read off the wire', async () => {
  const frames = [];
  const deps = { ws: { broadcast: (appId, data) => frames.push([appId, data]) } };
  const out = await replyStatus.publish(placePool(), {
    appId: 1, place: { type: 'session', ref: 9 }, answerable: true, skipEmpty: true, deps,
  });
  assert.equal(out, null);
  assert.deepEqual(frames, []);
});
