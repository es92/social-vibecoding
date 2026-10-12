'use strict';

// #4772: what Homeroom bot waits on one viewer for, on one project, for the
// Workshop tab's Waiting on you (services/workshop-waiting.js), and the
// request list that carries it to the board (routes/issues.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const waiting = require('../src/services/workshop-waiting');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function fakePool(answers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { rows: next || [] };
    },
  };
}

test('nothing is read without a project and a viewer', async () => {
  const pool = fakePool([]);
  assert.deepEqual(await waiting.waitingOnViewer(pool, { appId: 7, userId: null, botId: 3 }), { plans: [], questions: [], talks: [] });
  assert.deepEqual(await waiting.waitingOnViewer(pool, { appId: null, userId: 5, botId: 3 }), { plans: [], questions: [], talks: [] });
  assert.equal(pool.calls.length, 0);
});

test('plans, questions and talks, each the viewer\'s own, newest first', async () => {
  const at = new Date('2026-10-12T10:00:00Z');
  const pool = fakePool([
    [{ issue_number: 13, at }],
    [{ issue_number: '12', at }],
    [{ thread_type: 'session', thread_ref: 34, at, bot_last: true }, { thread_type: 'issue', thread_ref: 9, at, bot_last: false }],
  ]);
  const out = await waiting.waitingOnViewer(pool, { appId: 7, userId: 5, botId: 3 });
  assert.deepEqual(out, {
    plans: [{ number: 13, at: at.toISOString() }],
    questions: [{ number: 12, at: at.toISOString() }],
    talks: [
      { type: 'session', ref: 34, at: at.toISOString(), botLast: true },
      { type: 'issue', ref: 9, at: at.toISOString(), botLast: false },
    ],
  });
  assert.deepEqual(pool.calls.map((c) => c.params), [
    [7, 5, waiting.MAX_EACH],
    [7, 5, waiting.MAX_EACH],
    [7, 5, 3, waiting.TALK_DAYS, waiting.MAX_EACH],
  ]);
});

test('the plan is the request\'s NEWEST run waiting for Build it, on a request recorded as the viewer\'s', () => {
  const sql = waiting.PLANS_SQL;
  assert.match(sql, /FROM homeroom_bot_requesters q/);
  assert.match(sql, /WHERE q\.app_id = \$1 AND q\.user_id = \$2/);
  assert.match(sql, /ORDER BY id DESC LIMIT 1\s*\) run ON TRUE/, 'the newest run decides');
  assert.match(sql, /run\.awaiting_go_at IS NOT NULL AND run\.build_ok IS NULL/);
  assert.match(sql, /run\.build_session_id IS NULL AND run\.proposal_session_id IS NULL/);
});

test('a question is one asked of the viewer that is still open', () => {
  assert.match(waiting.QUESTIONS_SQL, /FROM homeroom_bot_dm_messages/);
  assert.match(waiting.QUESTIONS_SQL, /app_id = \$1 AND user_id = \$2 AND question_status = 'open'/);
});

test('a talk needs both sides, recently, with nothing deleted or hidden, on an open change', () => {
  const sql = waiting.TALKS_SQL;
  assert.match(sql, /m\.thread_type IN \('session', 'issue'\)/);
  assert.match(sql, /m\.deleted_at IS NULL AND m\.moderation_hidden_at IS NULL/);
  assert.match(sql, /m\.user_id IN \(\$2, \$3\)/);
  assert.match(sql, /m\.created_at > NOW\(\) - make_interval\(days => \$4\)/, 'the window is a parameter');
  assert.match(sql, /t\.mine_at IS NOT NULL AND t\.bot_at IS NOT NULL/);
  assert.match(sql, /cs\.status IN \('active', 'paused', 'promoted', 'merging'\)/);
  assert.match(sql, /LIMIT \$5/);
  assert.equal(waiting.TALK_DAYS, 3);
});

test('without the bot, or for the bot itself, there are no talks; a failed read is nothing waiting', async () => {
  const noBot = fakePool([[], []]);
  assert.deepEqual((await waiting.waitingOnViewer(noBot, { appId: 7, userId: 5, botId: null })).talks, []);
  assert.equal(noBot.calls.length, 2);
  const self = fakePool([[], []]);
  await waiting.waitingOnViewer(self, { appId: 7, userId: 3, botId: 3 });
  assert.equal(self.calls.length, 2);
  const broken = fakePool([new Error('boom')]);
  assert.deepEqual(await waiting.waitingOnViewer(broken, { appId: 7, userId: 5, botId: 3 }), { plans: [], questions: [], talks: [] });
});

test('the request list carries it, and the staging demo shows one of each', () => {
  const route = read('src/routes/issues.js');
  assert.match(route, /const waitingOnYou = IS_STAGING && req\.query\.demo === '1'\s*\? workshopWaiting\.demoWaiting\(\)\s*: await workshopWaiting\.waitingOnViewer\(pool, \{/);
  assert.match(route, /\.\.\.\(botDoor \? \{ homeroomBot: botDoor \} : \{\}\),\s*waitingOnYou,\s*\}\);/);
  const demo = waiting.demoWaiting(Date.parse('2026-10-12T12:00:00Z'));
  assert.deepEqual(demo.plans.map((p) => p.number), [900016]);
  assert.deepEqual(demo.questions.map((q) => q.number), [900015]);
  assert.deepEqual(demo.talks.map((t) => [t.type, t.ref, t.botLast]), [['issue', 900002, true]]);
  // The board keeps it with the list's other per-viewer facts.
  assert.match(read('public/js/app-view.js'), /waitingOnYou: \(ghData && ghData\.waitingOnYou && typeof ghData\.waitingOnYou === 'object'\) \? ghData\.waitingOnYou : null,/);
});

test('the ?demo=1 mocks give the viewer a change up for a vote and one that needs a fix', () => {
  const votes = read('src/routes/votes.js');
  assert.match(votes, /const OWN_DEMO_PROPOSALS = new Set\(\[9000493, 9000494\]\);/);
  assert.match(votes, /OWN_DEMO_PROPOSALS\.has\(row\.id\)\s*\? \{ \.\.\.row, user_id: user\.id, username: user\.username \} : row/);
  assert.match(votes, /rows\.push\(\.\.\.ownDemoProposals\(stagingMockProposals\(req\.user\?\.username\), req\.user\)/);
});
