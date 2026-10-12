'use strict';

// #3692: the activity tray in the Homeroom bot's DM, against the full
// PostgreSQL schema and through the real route. What it pins first is WHOSE
// work it reads: the signed-in person's, and nobody else's, whatever the
// request asks for. Then what it reads:
//
//   - NOW is what the bot's own progress answer (homeroom-bot-progress.js)
//     calls in flight on a request of theirs (recorded for them, or an issue
//     they filed that the loop has not recorded yet), on an app the bot acts
//     on for real: reading it, building it (its queue row long gone), a
//     follow-up on its proposal waiting its turn (#3734), a request waiting
//     in the queue; and a project of theirs still being set up for its
//     first version. An app the bot is paused on is not work for anybody.
//   - NEEDS YOU and HISTORY are the bot's live runs on their requests, one
//     entry per request with its other runs folded in, newest news first,
//     each with what came of it and where it opens (the proposal once people
//     can open it, else the request): a question it asked waits on them,
//     anything else is history. Shadow runs are not shown.
//   - each request appears once, in the first of the three that fits.
//   - an app they can no longer view is left out of all three.
//
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const pushes = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser(userId, payload) { pushes.push([userId, payload]); return 1; },
    pushNotificationToUser() { return 1; },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

let routePool = null;
const poolMod = require('../src/db/pool');
poolMod.getPool = () => routePool;

const tray = require('../src/services/homeroom-bot-tray');
const homeroomBot = require('../src/services/homeroom-bot');
const { conversationRoutes } = require('../src/routes/conversations');

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `hrbot_tray_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

test('the Homeroom bot DM\'s activity tray reads one person\'s work, through the real route', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  routePool = pool;

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  async function setting(key, value) {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
  async function project(slug, owner, { visibility = 'public' } = {}) {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, $5, $5) RETURNING id`,
      [slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), slug, owner.id,
        `https://github.com/usernode-bot/${slug}`, visibility],
    );
    const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
    return app;
  }

  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  const seeds = await project('seed-swap', ada);
  const notes = await project('note-board', ada);
  const samsApp = await project('sam-shop', sam);
  // Private, and ada is not (or no longer) a collaborator there.
  const hidden = await project('hidden-lab', sam, { visibility: 'private' });
  // Paused: the bot leaves it alone. Every other app is live (liveScope).
  const shadowApp = await project('shadow-app', ada);
  const ear = await project('ear-trainer', ada);
  await setting('homeroom_bot_mode', 'shadow');
  await setting('homeroom_bot_paused_apps', JSON.stringify(['shadow-app']));

  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES
       ($1, 3, $4, 'Sort by date'), ($1, 4, $4, 'Dark mode'), ($2, 5, $4, 'Pin notes'),
       ($3, 9, $5, 'Sam''s secret'), ($6, 2, $4, 'Hidden thing')`,
    [seeds.id, notes.id, samsApp.id, ada.id, sam.id, hidden.id],
  );
  // An issue ada filed on Homeroom that the loop has not recorded yet, and
  // one on the app the bot is paused on.
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, created_by) VALUES
       ($1, 7, 'Export as CSV', $3), ($2, 1, 'Shadow request', $3)`,
    [notes.id, shadowApp.id, ada.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at) VALUES
       ($1, 3, 1, 'new', NOW() - INTERVAL '5 minutes'),
       ($2, 6, 2, 'changed', NULL),
       ($2, 7, 1, 'new', NOW() - INTERVAL '2 minutes'),
       ($3, 9, 1, 'new', NOW()),
       ($4, 1, 1, 'new', NOW()),
       ($5, 2, 1, 'new', NOW())`,
    [seeds.id, notes.id, samsApp.id, shadowApp.id, hidden.id],
  );
  const { rows: [proposal] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at)
     VALUES ($1, $2, 'b', 'promoted', 'Pin notes', NOW()) RETURNING id`,
    [notes.id, bot.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, created_at) VALUES
       ($1, 4, 'live', 'question', NULL, NOW() - INTERVAL '3 hours'),
       ($2, 5, 'live', 'ready', $5, NOW() - INTERVAL '1 hour'),
       ($1, 3, 'shadow', 'question', NULL, NOW() - INTERVAL '2 days'),
       ($3, 9, 'live', 'ready', NULL, NOW() - INTERVAL '10 minutes'),
       ($4, 2, 'live', 'empty', NULL, NOW() - INTERVAL '20 minutes')`,
    [seeds.id, notes.id, samsApp.id, hidden.id, proposal.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status) VALUES ($1, $2, 'An ear trainer', 'waiting')`,
    [ear.id, ada.id],
  );

  const asAda = { id: ada.id, username: ada.username, isAdmin: false };
  const asSam = { id: sam.id, username: sam.username, isAdmin: false };
  const key = (job) => `${job.appSlug}#${job.issueNumber ?? 'first'}`;

  await t.test('now: what the bot is doing for them on apps it acts on, and their project being set up', async () => {
    const work = await tray.workFor(pool, { user: asAda });
    assert.deepEqual(work.now.map(key).sort(), ['ear-trainer#first', 'note-board#7', 'seed-swap#3']);
    const by = new Map(work.now.map((job) => [key(job), job]));
    const sort = by.get('seed-swap#3');
    assert.equal(sort.phase, 'looking');
    assert.deepEqual([sort.step, sort.of, sort.stepName], [1, 6, 'Reading'], 'the step its activity card draws');
    assert.equal(sort.title, 'Sort by date');
    assert.equal(sort.href, '#app/seed-swap/dev/issues/3');
    assert.ok(sort.since, 'and since when');
    assert.equal(by.get('note-board#7').title, 'Export as CSV', 'an issue they filed, read off the issue before the loop records it');
    const first = by.get('ear-trainer#first');
    assert.equal(first.phase, 'setting_up');
    assert.equal(first.firstVersion, true);
    assert.equal(first.href, '#app/ear-trainer/app');
  });

  await t.test('#3734: now agrees with the bot\'s own progress answer, for a build and for a follow-up waiting its turn', async () => {
    const progressSvc = require('../src/services/homeroom-bot-progress');
    const settings = await homeroomBot.readSettings(pool);
    const both = async () => {
      const [work, progress] = await Promise.all([
        tray.workFor(pool, { user: asAda }),
        progressSvc.progressFor(pool, { userId: ada.id, settings, deps: { domain: null } }),
      ]);
      const said = progress.rightNow.filter(progressSvc.inFlight)
        .map((item) => `${item.project}#${item.number ?? 'first'}`)
        .filter((k) => !k.startsWith('hidden-lab#'));
      assert.deepEqual(work.now.map(key).sort(), said.sort(), 'the tray lists what the bot says it is doing');
      return { work, progress, job: (k) => work.now.find((job) => key(job) === k) };
    };
    // The real pipeline: a request leaves the queue once it has been read,
    // and is planned and built with no queue row. The tray used to drop it
    // here, for the whole build, while the bot said it was building.
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 3', [seeds.id]);
    const { rows: [build] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, session_title) VALUES ($1, $2, 'active', 'Homeroom bot: #3') RETURNING id`,
      [seeds.id, bot.id],
    );
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id) VALUES ($1, 3, 'live', 'ready', $2) RETURNING id`,
      [seeds.id, build.id],
    );
    assert.equal((await both()).job('seed-swap#3').phase, 'building', 'writing its plan is building it');
    await pool.query(`INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind) VALUES ($1, 3, $2, 'spec')`, [seeds.id, run.id]);
    const building = (await both()).job('seed-swap#3');
    assert.equal(building.phase, 'building');
    assert.equal(building.href, '#app/seed-swap/dev/issues/3');

    // A change asked for on its proposal, waiting its turn: in flight in both,
    // and it opens the proposal. Then it runs.
    await pool.query('UPDATE chat_sessions SET linked_issues = ARRAY[5] WHERE id = $1', [proposal.id]);
    await homeroomBot.enqueueFront(pool, { appId: notes.id, issueNumber: 5, userId: ada.id, reason: 'dm_revise' });
    const queued = await both();
    const followUp = queued.job('note-board#5');
    assert.equal(followUp.phase, 'follow_up_queued');
    assert.equal(followUp.href, `#app/note-board/dev/proposals/${proposal.id}`);
    assert.match(queued.progress.rightNow.find((item) => item.project === 'note-board' && item.number === 5).doing,
      /^waiting for a free builder to follow up on the newest replies on the change$/);
    assert.equal(queued.work.now[0].phase !== 'follow_up_queued', true, 'what it is doing this minute comes first');
    await pool.query('UPDATE homeroom_bot_queue SET started_at = NOW() WHERE app_id = $1 AND issue_number = 5', [notes.id]);
    assert.equal((await both()).job('note-board#5').phase, 'following_up');
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 5', [notes.id]);
    assert.equal((await both()).job('note-board#5'), undefined, 'done: up for the vote again, which is the group\'s');

    // A request of theirs waiting in the queue is in flight too, in both.
    await pool.query(`INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 4, 1, 'changed')`, [seeds.id]);
    assert.equal((await both()).job('seed-swap#4').phase, 'queued');
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 4', [seeds.id]);

    // Put back as it was for the tests below.
    await pool.query('DELETE FROM homeroom_bot_posts WHERE run_id = $1', [run.id]);
    await pool.query('DELETE FROM homeroom_bot_runs WHERE id = $1', [run.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at) VALUES ($1, 3, 1, 'new', NOW() - INTERVAL '5 minutes')`,
      [seeds.id],
    );
  });

  await t.test('needs you and history: one entry per request, each with what came of it and where it opens', async () => {
    const work = await tray.workFor(pool, { user: asAda });
    assert.deepEqual(work.needsYou.map(key), ['seed-swap#4'], 'a question it asked waits on her');
    const [dark] = work.needsYou;
    assert.equal(dark.outcome, 'question');
    assert.equal(dark.href, '#app/seed-swap/dev/issues/4', 'anything without a proposal opens its request');
    assert.deepEqual(work.history.map(key), ['note-board#5'], 'no shadow run, nobody else\'s');
    const [pin] = work.history;
    assert.equal(pin.outcome, 'proposed');
    assert.equal(pin.proposalId, proposal.id);
    assert.equal(pin.href, `#app/note-board/dev/proposals/${proposal.id}`, 'a proposal up for a vote opens itself');
    assert.equal(pin.links.proposal, pin.href);
    assert.equal(pin.links.request, '#app/note-board/dev/issues/5');
    assert.ok(Date.parse(pin.at) > Date.parse(dark.at));

    // The bot came back to it: still one entry, its build folded in as an earlier run.
    const { rows: [answer] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, created_at)
       VALUES ($1, 5, 'live', 'answer', NOW() + INTERVAL '1 minute') RETURNING id`,
      [notes.id],
    );
    const again = await tray.workFor(pool, { user: asAda });
    assert.deepEqual(again.history.map(key), ['note-board#5']);
    assert.equal(again.history[0].outcome, 'answer');
    assert.deepEqual(again.history[0].earlier.map((r) => r.outcome), ['proposed']);

    // Merged since: that is the news, not the answer before it.
    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [proposal.id]);
    const merged = await tray.workFor(pool, { user: asAda });
    assert.equal(merged.history[0].outcome, 'live');
    assert.deepEqual(merged.history[0].earlier.map((r) => r.outcome), ['answer']);
    await pool.query(`UPDATE chat_sessions SET status = 'closed' WHERE id = $1`, [proposal.id]);
    const closed = await tray.workFor(pool, { user: asAda });
    assert.equal(closed.history[0].outcome, 'closed');
    assert.equal(closed.history[0].href, '#app/note-board/dev/issues/5', 'a closed proposal opens its request instead');
    assert.equal(closed.history[0].proposalId, undefined);
    assert.equal(closed.history[0].links.proposal, null);
    await pool.query(`UPDATE chat_sessions SET status = 'promoted' WHERE id = $1`, [proposal.id]);
    await pool.query('DELETE FROM homeroom_bot_runs WHERE id = $1', [answer.id]);
  });

  // #4539: a request closed while its plan still waited for its person's
  // Build it leaves Needs you and reads stopped in History. The plan is not
  // retired, so the same read open says Needs you: it is the request's own
  // closed state both queries (progress and past runs) now carry.
  await t.test('#4539: a request closed while its plan waited for Build it stops, and does not wait any more', async () => {
    const progressSvc = require('../src/services/homeroom-bot-progress');
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 6, $2, 'Sticky filters')`,
      [notes.id, ada.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at, created_at)
       VALUES ($1, 6, 'live', 'ready', NOW() - INTERVAL '49 minutes', NOW() - INTERVAL '50 minutes')`,
      [notes.id],
    );
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, created_by) VALUES ($1, 6, 'Sticky filters', $2)`,
      [notes.id, ada.id],
    );
    const waiting = await tray.workFor(pool, { user: asAda });
    assert.deepEqual(waiting.needsYou.map(key), ['note-board#6', 'seed-swap#4'],
      'open, its plan waits on her, newest first');
    assert.ok(!waiting.history.some((job) => key(job) === 'note-board#6'), 'and it is nowhere else');

    await pool.query(`UPDATE issues SET status = 'closed' WHERE app_id = $1 AND github_issue_number = 6`, [notes.id]);
    const stopped = await tray.workFor(pool, { user: asAda });
    assert.ok(!stopped.needsYou.some((job) => key(job) === 'note-board#6'), 'a closed request needs nobody');
    const tile = stopped.history.find((job) => key(job) === 'note-board#6');
    assert.equal(tile.outcome, 'stopped', 'and History says the work stopped');
    assert.equal(tile.doing, null);
    assert.equal(tile.href, '#app/note-board/dev/issues/6');

    // The bot's own progress answer says the same: nothing in progress, and
    // what came of it names the closure.
    const settings = await homeroomBot.readSettings(pool);
    const progress = await progressSvc.progressFor(pool, { userId: ada.id, settings, deps: { domain: null } });
    assert.ok(!progress.rightNow.some((item) => item.project === 'note-board' && item.number === 6),
      'not in progress any more');
    assert.ok(progress.finishedLately.some((item) => item.number === 6 && item.outcome === 'not built: the request was closed'),
      'and the outcome names the closure');

    // Leaving it as the later tests find it.
    await pool.query('DELETE FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = 6', [notes.id]);
    await pool.query('DELETE FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = 6', [notes.id]);
    await pool.query('DELETE FROM issues WHERE app_id = $1 AND github_issue_number = 6', [notes.id]);
  });

  await t.test('never anybody else\'s, and never an app they cannot view', async () => {
    const ours = await tray.workFor(pool, { user: asAda });
    const all = [...ours.now, ...ours.needsYou, ...ours.history].map((job) => job.appSlug);
    assert.ok(!all.includes('sam-shop'), 'sam\'s work is not ada\'s');
    assert.ok(!all.includes('hidden-lab'), 'a private app she cannot view is left out');
    assert.ok(!all.includes('shadow-app'), 'an app the bot is paused on is not work for her');

    const sams = await tray.workFor(pool, { user: asSam });
    assert.deepEqual(sams.now.map(key), ['sam-shop#9'],
      'sam\'s own claimed request: hidden-lab#2 is ada\'s, even on sam\'s app');
    assert.deepEqual([...sams.needsYou, ...sams.history], [], 'his one request is in hand, so it is nowhere else');
    assert.deepEqual(sams.now[0].earlier, [], 'a build nothing has finished is not an earlier run');
    assert.ok(![...sams.now, ...sams.needsYou, ...sams.history].some((job) => ['seed-swap', 'note-board', 'ear-trainer'].includes(job.appSlug)));

    // Once she can view it, her request there shows.
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`,
      [hidden.id, ada.id],
    );
    const member = await tray.workFor(pool, { user: asAda });
    const lab = member.now.find((job) => key(job) === 'hidden-lab#2');
    assert.ok(lab, 'in hand again');
    assert.deepEqual(lab.earlier.map((r) => r.outcome), ['empty'], 'with what its last look found');
    assert.ok(![...member.needsYou, ...member.history].some((job) => key(job) === 'hidden-lab#2'), 'and only there');
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [hidden.id, ada.id]);

    assert.deepEqual(await tray.workFor(pool, { user: null }), { now: [], needsYou: [], history: [] });
  });

  await t.test('the bot switched off is working on nothing; its history stays', async () => {
    await setting('homeroom_bot_mode', 'off');
    const off = await tray.workFor(pool, { user: asAda });
    assert.deepEqual(off.now, []);
    assert.deepEqual([...off.needsYou, ...off.history].map(key), ['seed-swap#4', 'note-board#5']);
    await setting('homeroom_bot_mode', 'shadow');
  });

  await t.test('the route answers for the signed-in person only, whatever it is asked', async () => {
    const app = express();
    app.use(express.json());
    let actor = asAda;
    app.use((req, _res, next) => { req.user = actor; next(); });
    app.use(conversationRoutes({}, { pool }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => server.close());
    const call = async (as, url) => {
      actor = as;
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const own = await call(asAda, '/api/conversations/homeroom-bot/work');
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(own.body, JSON.parse(JSON.stringify(await tray.workFor(pool, { user: asAda }))));
    // Asking for somebody else changes nothing: there is no such parameter.
    for (const query of [`?user_id=${sam.id}`, `?userId=${sam.id}`, `?username=${sam.username}`]) {
      const asked = await call(asAda, `/api/conversations/homeroom-bot/work${query}`);
      assert.deepEqual(asked.body, own.body, query);
    }
    const his = await call(asSam, '/api/conversations/homeroom-bot/work');
    assert.deepEqual(his.body.now.map(key), ['sam-shop#9']);
    // Off staging, `?demo=1` is the real answer too.
    const demo = await call(asAda, '/api/conversations/homeroom-bot/work?demo=1');
    assert.deepEqual(demo.body, own.body);

    // The conversation with the bot says it is one, so the tray is drawn
    // there; a DM with a person, or with another synthetic account, does not.
    const conversations = require('../src/services/conversations');
    const other = await user('demo_partner', { synthetic: true });
    const withBot = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const withOther = await conversations.ensureAdmittedDirect(pool, other.id, ada.id);
    const withSam = await conversations.createDirect(pool, sam, ada.id);
    await conversations.respond(pool, asAda, withSam.conversationId, 'accept');
    const list = await call(asAda, '/api/conversations');
    const flag = (id) => list.body.conversations.find((c) => c.id === id)?.homeroomBot;
    assert.equal(flag(withBot.conversationId), true);
    assert.equal(flag(withOther.conversationId), undefined);
    assert.equal(flag(withSam.conversationId), undefined);
    const one = await call(asAda, `/api/conversations/${withBot.conversationId}`);
    assert.equal(one.body.conversation.homeroomBot, true);
  });

  await t.test('the live loop says when work for a person starts and ends', async () => {
    pushes.length = 0;
    assert.equal(tray.noteWorkChanged(ada.id), 1);
    assert.deepEqual(pushes, [[ada.id, { type: 'homeroom_bot_work_changed' }]]);
    assert.equal(tray.noteWorkChanged(null), 0, 'an issue nobody on Homeroom filed tells nobody');
    assert.equal(tray.noteWorkChanged('x'), 0);
    const settings = await homeroomBot.readSettings(pool);
    const live = require('../src/services/homeroom-bot-live');
    assert.ok(live.isLiveFor(settings, { slug: 'seed-swap' }), 'every app is live');
    assert.equal(live.isLiveFor(settings, { slug: 'shadow-app' }), false, 'but a paused one');
  });
});
