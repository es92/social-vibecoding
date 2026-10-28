'use strict';

// Kudos is parked (#5249), server side: what members could still see of it
// after the client hid its surfaces, each pinned here.
//
//   1. The switch: one constant (src/services/kudos-parked.js), the client's
//      twin, read by the push policy as well.
//   2. Notifications: the feed, its Saved section, one row by id and the
//      unread count all skip a parked kind, so the bell, its badge and the
//      phone's icon agree. (tests/kudos-parked-postgres.test.js runs the same
//      readers against the real schema.)
//   3. Pledging a bounty on a request answers 410 Gone.
//   4. A bounty pledged before parking is still paid on merge, with its
//      event, and no line in the proposal's thread.
//   5. The bounty lines already written are not served in a thread.
//
// Giving and retracting kudos answering 410 is pinned in tests/kudos.test.js,
// a feedback submit filing without its bounty in tests/feedback-bounty.test.js,
// and the comment box sending none in tests/comment-pin.test.js.
//
// Run with: node --test tests/kudos-parked-server.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const parked = require('../src/services/kudos-parked');

// ── 1. The switch ──────────────────────────────────────────────────────

test('the server switch is on, matches the client, and the push policy reads it', () => {
  assert.equal(parked.KUDOS_PARKED, true);
  assert.match(read('frontend/src/features/leaderboard/kudos-parked.ts'), /export const KUDOS_PARKED = true;/,
    'the two switches move together');
  assert.deepEqual([...parked.PARKED_NOTIFICATION_KINDS], ['kudos']);
  const { PARKED_PUSH_KINDS } = require('../src/services/mobile-push-policy');
  assert.deepEqual([...PARKED_PUSH_KINDS], ['kudos'], 'no phone is woken for one either');
  assert.equal(parked.kudosParked({}), true, 'a route parks by default');
  assert.equal(parked.kudosParked({ kudosParked: false }), false, 'a test may turn it off for its route');
});

// ── 2. Notifications ───────────────────────────────────────────────────

function capturingPool(rows = [{ c: 0 }]) {
  const sql = [];
  return { sql, query: async (text) => { sql.push(String(text)); return { rows }; } };
}

test('countUnread, the feed, its Saved section and one row by id all skip a kudos row', async () => {
  const notifications = require('../src/services/notifications');
  assert.equal(notifications.PARKED_KINDS_SQL, "n.kind NOT IN ('kudos')");

  const count = capturingPool();
  await notifications.countUnread(count, 7);
  assert.ok(count.sql[0].includes("n.kind NOT IN ('kudos')"), 'the badge does not count it');

  const feed = capturingPool([]);
  await notifications.listForUser(feed, 7, {});
  assert.ok(feed.sql[0].includes("n.kind NOT IN ('kudos')"), 'the bell does not list it');

  const saved = capturingPool([]);
  await notifications.listSavedForUser(saved, 7);
  assert.ok(saved.sql[0].includes("n.kind NOT IN ('kudos')"), 'nor does its Saved section');

  const one = capturingPool([]);
  await notifications.getForUser(one, 7, 1);
  assert.ok(one.sql[0].includes("n.kind NOT IN ('kudos')"), 'nor a push opened by its id');

  // The phone's badge is the same count.
  assert.match(read('src/services/mobile-push-badge.js'), /const \{ countUnread \} = require\('\.\/notifications'\);/);
});

test('the staging demo feed carries no kudos row, and its check looks for any kudos row at all', () => {
  const route = read('src/routes/notifications.js');
  assert.doesNotMatch(route, /kind: 'kudos'/);
  const dapp = JSON.parse(read('dapp.json'));
  const check = dapp.tests.find((t) => /notifications sheet shows no kudos row/.test(t.name));
  assert.ok(check, 'the declared check is still there');
  assert.match(check.expectSelector, /:not\(:has\(\[data-notif-action="kudos_board"\]\)\)/,
    'a kudos row is the only one with the Leaderboard action');
  assert.match(read('frontend/src/features/notifications/notifications.js'),
    /data\.savedNotifications\.filter\(Notifications\._shown\)/, 'and the client filters saved rows too');
});

// ── 3. Pledging a bounty ───────────────────────────────────────────────

test('POST /api/apps/:slug/issues/:number/bounty answers 410 and reads nothing', async () => {
  const poolMod = require('../src/db/pool');
  const queries = [];
  const original = poolMod.getPool;
  poolMod.getPool = () => ({ query: async (sql) => { queries.push(sql); return { rows: [] }; } });
  delete require.cache[require.resolve('../src/routes/issues')];
  try {
    const { issueRoutes } = require('../src/routes/issues');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 5, username: 'alice' }; next(); });
    app.use(issueRoutes({}));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/issues/12/bounty`, { method: 'POST' });
      assert.equal(res.status, 410);
      assert.deepEqual(await res.json(), { error: 'kudos_parked', message: 'Kudos are paused.' });
      assert.ok(!queries.some((q) => /issue_bounties/.test(String(q))), 'no pledge is written');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    poolMod.getPool = original;
    delete require.cache[require.resolve('../src/routes/issues')];
  }
});

// ── 4. Paying a bounty pledged before parking ──────────────────────────

test('writeBounties pays an open bounty and records its event, but writes no chat line', async () => {
  const { mergeFollowups } = require('../src/workflow/merge-followups/machine.ts');
  const machine = mergeFollowups({ dataKey: 'k', notifiers: { boardChange() {}, badgeSync() {} } });
  const write = machine.writes.get('bounties');
  const queries = [];
  const tx = {
    query: async (sql, params) => {
      const s = String(sql);
      queries.push({ sql: s, params });
      if (/SET status = 'awarded'/.test(s)) return { rows: [{ id: 41 }] };
      return { rows: [] };
    },
  };
  const pushed = [];
  await write(tx, { numbers: [7], appId: 3, sessionId: 90, userId: 12, prNumber: 55, eventId: 1 }, { push: (p) => pushed.push(p) });
  assert.ok(queries.some((q) => /SET status = 'awarded'/.test(q.sql)), 'the bounty is paid');
  const event = queries.find((q) => /'bounty_awarded'/.test(q.sql));
  assert.ok(event, 'its event is recorded');
  assert.deepEqual(JSON.parse(event.params[3]), { issueNumber: 7, prNumber: 55, count: 1 });
  assert.ok(!queries.some((q) => /INSERT INTO chat_messages/.test(q.sql)), 'no line in the thread');
  assert.equal(pushed.length, 0, 'and nothing pushed to the room');
});

// ── 5. Bounty lines already written ────────────────────────────────────

test('the two bounty system lines are matched, and nothing a person wrote is', () => {
  const sys = (content) => ({ msg_type: 'system', content });
  assert.equal(parked.isParkedSystemLine(sys('ada_9 placed a bounty (kudos) on issue #12')), true);
  assert.equal(parked.isParkedSystemLine(sys('Bounty on issue #12 (3 kudos) awarded to <@44> for PR #301')), true);
  assert.equal(parked.isParkedSystemLine(sys('Bounty on issue #12 (1 kudos) awarded to the author for PR #301')), true);
  assert.equal(parked.isParkedSystemLine({ msg_type: 'message', content: 'ada_9 placed a bounty (kudos) on issue #12' }), false,
    'a person who typed the sentence keeps it');
  assert.equal(parked.isParkedSystemLine(sys('ada_9 proposed closing issue #12')), false);
  assert.equal(parked.isParkedSystemLine(sys('Bounty on issue #12 was discussed at length')), false);
  const sql = parked.parkedSystemLineSql('m');
  assert.match(sql, /^NOT \(m\.msg_type = 'system' AND \(/);
  for (const p of parked.BOUNTY_LINE_PATTERNS) assert.ok(sql.includes(`m.content ~ '${p}'`));
});

test('a request\'s and a proposal\'s thread are read without the bounty lines', () => {
  const chat = read('src/routes/chat.js');
  assert.match(chat, /const \{ parkedSystemLineSql \} = require\('\.\.\/services\/kudos-parked'\);/);
  assert.match(chat, /if \(thread\.type === 'issue' \|\| thread\.type === 'session'\) \{\s*where \+= ` AND \$\{parkedSystemLineSql\('m'\)\}`;/);
});

// ── Homeroom bot's move reply ──────────────────────────────────────────

test('the move reply never says kudos; an open bounty still keeps the original for a vote', () => {
  const move = read('src/services/homeroom-bot-move.js');
  assert.match(move, /if \(counts\.kudos\) reasons\.push\(KUDOS_PARKED \? 'others are involved in it' : 'somebody put kudos on it'\);/);
});
