'use strict';

// The Homeroom bot's proposals for requests that closed some other way, against
// the FULL PostgreSQL schema (src/services/homeroom-bot-closed-requests.js).
//
// 15 October: three of the five proposals the platform project allows the bot
// were for closed requests. #4817 was shipped by a person's PR (#4822) while
// the bot's #4819 stayed up, #4389 was shipped by another change, and #4968
// was closed by a vote while the bot's #5026 stayed up and mergeable. Nothing
// withdrew them, and the bot never read a closed request again, so every
// other ready request on the project was held behind them.
//
// Pinned here:
//   - a proposal of the bot's up for a vote is withdrawn once every request it
//     is linked to is closed, with a line on each request; one linked to a
//     request still open stays;
//   - a person's proposal, one already approved and a headless one are never
//     touched;
//   - the refresh's sweep finds the ones closed on GitHub, trusting GitHub's
//     own answer and never the open list alone, and gives the freed slot to a
//     held request in the same refresh.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const closedRequests = require('../src/services/homeroom-bot-closed-requests');
const bot = require('../src/services/homeroom-bot');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SEEN = '2026-10-14T09:00:00Z';

test('the bot\'s proposals for closed requests are withdrawn, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_closed_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  );
  const { rows: [lee] } = await pool.query(`INSERT INTO users (username, password) VALUES ('lee', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('plant-pal', 'plant-pal', 'running', 'https://github.com/usernode-bot/plant-pal')
     RETURNING id, slug, name, repo_url`,
  );
  const proposal = async (linked, { status = 'promoted', user = botUser.id, headless = false, title = null } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, pr_title)
     VALUES ($1, $2, $3, $4, $5, $6::int[], $7) RETURNING id`,
    [app.id, user, `dev/homeroom_bot-${crypto.randomBytes(3).toString('hex')}`, status, headless, linked, title],
  )).rows[0].id;
  const statusOf = async (id) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0].status;

  // GitHub as the test scripts it: `closed` numbers read closed, `broken`
  // ones fail, `prs` are pull requests, and everything else reads open.
  const gh = ({ closed = [], broken = [], prs = [] } = {}) => {
    const asked = [];
    return {
      asked,
      async getIssue(owner, repo, n) {
        asked.push(n);
        assert.deepEqual([owner, repo], ['usernode-bot', 'plant-pal']);
        if (broken.includes(n)) throw new Error('rate limited');
        return { number: n, state: closed.includes(n) || prs.includes(n) ? 'closed' : 'open', ...(prs.includes(n) ? { pull_request: {} } : {}) };
      },
    };
  };
  // The system archive, as noteRequestMerged's test drives it: the row only.
  const harness = (github) => {
    const archived = [];
    const lines = [];
    const woken = [];
    return {
      archived, lines, woken,
      deps: {
        github,
        sessionLifecycle: {
          async archiveSession(args) {
            archived.push({ sessionId: args.sessionId, reason: args.reason });
            const { rowCount } = await pool.query(
              `UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1 AND status IN ('active', 'promoted', 'paused')`,
              [args.sessionId],
            );
            return { archived: rowCount === 1 };
          },
        },
        ws: { async sendSystemMessage(_pool, appId, content, msgType, metadata, thread) { lines.push({ appId, content, msgType, thread }); } },
        wake(args) { woken.push(args); },
      },
    };
  };

  await t.test('a close withdraws the bot\'s proposals whose requests are all closed, and only those', async () => {
    await pool.query('DELETE FROM chat_sessions');
    const alone = await proposal([10], { title: 'Watering reminders' });
    const pair = await proposal([11, 12]); // #12 is still open on GitHub
    const both = await proposal([13, 14], { title: 'Sunlight log' }); // #14 closed on GitHub already
    const persons = await proposal([10], { user: lee.id });
    const approved = await proposal([10], { status: 'merging' });
    const headless = await proposal([10], { headless: true });
    const elsewhere = await proposal([15]);
    const github = gh({ closed: [14] });
    const h = harness(github);

    const out = await closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [10, 11, 13], deps: h.deps });
    assert.deepEqual(out, { withdrawn: [alone, both] });
    assert.deepEqual(h.archived, [
      { sessionId: alone, reason: 'request-closed' },
      { sessionId: both, reason: 'request-closed' },
    ], 'the system archive, which closes the pull request and says so in its own thread');
    assert.deepEqual(github.asked.sort(), [12, 14], 'GitHub is asked only about the linked requests not just closed');
    assert.deepEqual(h.lines, [
      { appId: app.id, content: '“Watering reminders” was withdrawn: this request is closed.', msgType: 'system', thread: { type: 'issue', ref: 10 } },
      { appId: app.id, content: '“Sunlight log” was withdrawn: this request is closed.', msgType: 'system', thread: { type: 'issue', ref: 13 } },
      { appId: app.id, content: '“Sunlight log” was withdrawn: this request is closed.', msgType: 'system', thread: { type: 'issue', ref: 14 } },
    ], 'a line on each of its requests, in the request\'s own thread');
    assert.deepEqual(h.woken, [{ appId: app.id }], 'the bot is woken for the project, so a held request takes the slot');
    assert.equal(await statusOf(pair), 'promoted', 'one of its requests is still open');
    assert.equal(await statusOf(persons), 'promoted', 'a person\'s proposal is theirs');
    assert.equal(await statusOf(approved), 'merging', 'one already approved is past withdrawing');
    assert.equal(await statusOf(headless), 'promoted');
    assert.equal(await statusOf(elsewhere), 'promoted', 'another request\'s is untouched');

    // Once: a second close of the same requests (another Pod) finds nothing.
    const again = harness(gh({ closed: [14] }));
    assert.deepEqual(await closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [10, 11, 13], deps: again.deps }), { withdrawn: [] });
    assert.deepEqual(again.woken, [], 'nothing withdrawn, nobody woken');
    // And #12 closing later takes the pair down: GitHub reads #11 closed by then.
    const later = harness(gh({ closed: [11] }));
    assert.deepEqual(await closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [12], deps: later.deps }), { withdrawn: [pair] });
  });

  await t.test('a failed GitHub read keeps the proposal up; the helper never throws unless strict', async () => {
    await pool.query('DELETE FROM chat_sessions');
    const unsure = await proposal([20, 21]);
    const h = harness(gh({ broken: [21] }));
    assert.deepEqual(await closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [20], deps: h.deps }), { withdrawn: [] });
    assert.equal(await statusOf(unsure), 'promoted');
    assert.deepEqual(await closedRequests.noteRequestsClosed(pool, { appId: app.id, closed: [], deps: h.deps }), { withdrawn: [] });
    const down = { query: () => Promise.reject(new Error('connection lost')) };
    assert.equal(await closedRequests.noteRequestsClosed(down, { appId: app.id, closed: [20], deps: h.deps }), null);
    await assert.rejects(closedRequests.noteRequestsClosed(down, { appId: app.id, closed: [20], strict: true, deps: h.deps }), /connection lost/,
      'the merge-followups machine retries what it could not do');
  });

  await t.test('the sweep withdraws one whose requests GitHub confirms closed, never on the open list alone', async () => {
    await pool.query('DELETE FROM chat_sessions');
    const open = await proposal([30]);
    const shipped = await proposal([31]);
    const lagging = await proposal([32]); // hidden from the list, still open on GitHub
    const unread = await proposal([33]);
    const pr = await proposal([34]);
    const halfOpen = await proposal([30, 35]);
    const persons = await proposal([36], { user: lee.id });
    const github = gh({ closed: [31, 36], broken: [33], prs: [34] });
    const h = harness(github);

    const out = await closedRequests.sweepClosedRequests(pool, { appId: app.id, openNumbers: [30], deps: h.deps });
    assert.deepEqual(out, { withdrawn: [shipped] });
    assert.deepEqual(github.asked.sort(), [31, 32, 33, 34], 'one with a request on the open list is never looked up');
    for (const id of [open, lagging, unread, pr, halfOpen, persons]) assert.equal(await statusOf(id), 'promoted', String(id));
    assert.deepEqual(h.woken, [], 'the sweep runs inside the refresh, which is the wake');
    const down = { query: () => Promise.reject(new Error('connection lost')) };
    assert.deepEqual(await closedRequests.sweepClosedRequests(down, { appId: app.id, openNumbers: [30], deps: h.deps }), { withdrawn: [] });
  });

  await t.test('the refresh frees a slot held by a request closed on GitHub and gives it to a held request', async () => {
    bot._resetForTests();
    await pool.query('DELETE FROM chat_sessions');
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
    // Five proposals up for a vote, the cap: four for open requests, one for
    // #41, closed on GitHub since. #40 is ready and held behind them.
    const live = [];
    for (const n of [42, 43, 44, 45]) {
      const id = await proposal([n]);
      live.push(id);
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, proposal_session_id, thread_seen_at)
         VALUES ($1, $2, 'live', 'ready', TRUE, $3, $4)`, [app.id, n, id, SEEN],
      );
    }
    const stale = await proposal([41], { title: 'Repotting reminders' });
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cap_suppressed, thread_seen_at)
       VALUES ($1, 40, 'live', 'ready', 'proposals_per_app', $2)`, [app.id, SEEN],
    );
    const capRoom = await bot.capRoomFor(pool, botUser, app.id);
    assert.equal(capRoom.proposals_per_app, 0, 'the project is at its cap');

    const lifecyclePath = require.resolve('../src/services/session-lifecycle');
    const orig = require.cache[lifecyclePath];
    const archived = [];
    require.cache[lifecyclePath] = {
      id: lifecyclePath, filename: lifecyclePath, loaded: true, paths: [],
      exports: {
        async archiveSession(args) {
          archived.push(args.sessionId);
          await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [args.sessionId]);
          return { archived: true };
        },
      },
    };
    try {
      const openList = (over = {}) => {
        const github = gh({ closed: [41] });
        return {
          github,
          async fetchPublicIssues() {
            return { issues: [40, 42, 43, 44, 45].map((n) => ({ number: n, state: 'open', createdAt: SEEN, updatedAt: SEEN })), truncatedList: false, ...over };
          },
          getIssue: github.getIssue,
        };
      };

      // A partial or stale list, or an app the bot is not live on: no sweep.
      for (const [why, list, room] of [
        ['a truncated list', openList({ truncatedList: true }), capRoom],
        ['a stale list', openList({ note: 'rate limited', stale: true }), capRoom],
        ['a shadow app', openList(), null],
      ]) {
        await bot.refreshApp(pool, app, { github: list, bot: botUser, capRoom: room });
        assert.deepEqual(list.github.asked, [], why);
        assert.equal(await statusOf(stale), 'promoted', why);
      }

      const out = await bot.refreshApp(pool, app, { github: openList(), bot: botUser, capRoom });
      assert.deepEqual(archived, [stale], 'withdrawn, by the system archive');
      for (const id of live) assert.equal(await statusOf(id), 'promoted');
      const { rows: queue } = await pool.query('SELECT issue_number, reason FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
      assert.deepEqual(queue.map((q) => [q.issue_number, q.reason]), [[40, bot.CAP_FREED_REASON]],
        'the held request takes the freed slot in the same refresh');
      assert.equal(out.queued, 1);
      const { rows: [line] } = await pool.query(
        `SELECT content FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 41`, [app.id],
      );
      assert.equal(line.content, '“Repotting reminders” was withdrawn: this request is closed.');
    } finally {
      if (orig) require.cache[lifecyclePath] = orig; else delete require.cache[lifecyclePath];
    }
  });
});
