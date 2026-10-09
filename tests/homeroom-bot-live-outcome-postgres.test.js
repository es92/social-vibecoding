'use strict';

// A live build always records what became of it, against the FULL
// PostgreSQL schema.
//
// Run 613 (recipebot #48, 2026-10-01): a live build had its session
// (build_session_id 5658), the session ended archived with no commits, and
// the run had no build_ok and no build_error, with nothing said on the
// issue. What happened: a redeploy interrupted the build before it had
// committed anything, and restart recovery (#3471) did what it does for a
// spec turn or a lost turn: archived the session and sent the issue back to
// be triaged again (requeueForRestart). It recorded nothing on the run, and
// the wake it sent started a refresh that read the issue as unchanged since
// that same run and deleted the restart's queue row before any pass took
// it. So the issue was never looked at again, and the run stayed a build
// with a session and no outcome.
//
// Pinned here, through the real planner:
//   - the restart row survives the refresh while its issue is open and
//     nobody else's, and recovery records the interruption on the run;
//   - the backstop: a live build nothing finished (no recovery ever saw it)
//     is recorded failed and said on the issue once, unless the issue moved
//     on or the outcome was already said.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// What the issue looked like when run 613 read it: nothing on it since.
const SEEN = '2026-09-30T16:43:12Z';

test('a live build always records its outcome, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_live_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const real = {
    post: live.post, advanceSeen: live.advanceSeen, mentionTargets: live.mentionTargets,
    buildAndPropose: live.buildAndPropose, botUsernameOf: live.botUsernameOf,
  };
  t.after(async () => {
    Object.assign(live, real);
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, checks_head_sha and the new indexes included

  const setting = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value],
  );
  // The bot acts on every app but a paused one: the quiet app is paused.
  await setting('homeroom_bot_mode', 'shadow');
  await setting('homeroom_bot_paused_apps', JSON.stringify(['quiet-app']));
  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  );
  const app = async (slug) => (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ($1, $1, 'running', $2) RETURNING id, slug, name, repo_url`,
    [slug, `https://github.com/usernode-bot/${slug}`],
  )).rows[0];
  const recipebot = await app('recipebot');
  const quiet = await app('quiet-app'); // paused, so not live

  const session = async (appRow, { status = 'active', activeTurn = null } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, active_turn)
     VALUES ($1, $2, $3, $4, FALSE, '{}', $5) RETURNING id`,
    [appRow.id, botUser.id, `dev/homeroom_bot-${crypto.randomBytes(3).toString('hex')}`, status,
      activeTurn ? JSON.stringify(activeTurn) : null],
  )).rows[0].id;
  const liveRun = async (appRow, issue, sessionId, { ago = 3 * 3600 } = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, thread_seen_at,
                                    build_session_id, created_at)
     VALUES ($1, $2, 'live', 'ready', 'build it', $3, $4, NOW() - make_interval(secs => $5))
     RETURNING id`,
    [appRow.id, issue, SEEN, sessionId, ago],
  )).rows[0].id;
  const runRow = async (id) => (await pool.query(
    'SELECT build_ok, build_error, proposal_session_id FROM homeroom_bot_runs WHERE id = $1', [id],
  )).rows[0];
  const statusOf = async (id) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0].status;
  const queueRows = async () => (await pool.query(
    'SELECT issue_number, reason FROM homeroom_bot_queue WHERE app_id = $1 ORDER BY issue_number', [recipebot.id],
  )).rows;

  const issues = (numbers) => ({
    async fetchPublicIssues() {
      return { issues: numbers.map((n) => ({ number: n, state: 'open', createdAt: SEEN, updatedAt: SEEN })) };
    },
  });
  const noSpend = { managedOpenRouter: { async usesIncludedKey() { return false; } }, limits: {} };

  await t.test('run 613: a restart interrupts the build; recovery records it, and the issue is triaged again', async () => {
    bot._resetForTests();
    const sessionId = await session(recipebot);
    const runId = await liveRun(recipebot, 48, sessionId, { ago: 600 });

    // The worker went with the restart: recovery notes the live build ...
    assert.equal(await bot.abandonRecoveredTurn({ pool, session: { id: sessionId }, why: 'the worker is gone' }), 'live_pending');
    // ... and, once the session is free, sends the issue round again.
    assert.equal(await bot.completeRecoveredLive({ pool, config: {}, sessionId, deps: noSpend }), 'requeued');
    assert.equal(await statusOf(sessionId), 'archived');
    const recorded = await runRow(runId);
    assert.equal(recorded.build_ok, false, 'the run says what became of its build');
    assert.match(recorded.build_error, /^interrupted: the worker is gone by a restart; the issue was sent back to be triaged again$/);
    assert.deepEqual(await queueRows(), [{ issue_number: 48, reason: bot.RESTART_REASON }]);

    // The wake's refresh reads #48 as unchanged since run 613. Before, it
    // deleted the restart's row here, and the issue was never looked at.
    // A refresh's own row for an unchanged issue (#49) still goes.
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 49, 2, 'changed')`, [recipebot.id],
    );
    await liveRun(recipebot, 49, null, { ago: 600 });
    const out = await bot.refreshApp(pool, recipebot, {
      github: issues([48, 49]), bot: botUser, capRoom: { proposals_per_app: 5, proposals_total: 5, question_tripwire: 10 },
    });
    assert.equal(out.removed, 1);
    assert.deepEqual(await queueRows(), [{ issue_number: 48, reason: bot.RESTART_REASON }],
      'the restart row is kept, reason and all, so the retriage does not say "looking" twice');

    // Activity on the issue keeps the reason too.
    await pool.query('UPDATE homeroom_bot_runs SET thread_seen_at = $2 WHERE id = $1', [runId, '2026-09-01T00:00:00Z']);
    await bot.refreshApp(pool, recipebot, { github: issues([48]), bot: botUser, capRoom: { proposals_per_app: 5 } });
    assert.deepEqual(await queueRows(), [{ issue_number: 48, reason: bot.RESTART_REASON }]);

    // Somebody else's (a person claimed it) or closed: it goes.
    const { rows: [ada] } = await pool.query(`INSERT INTO users (username, password) VALUES ('ada', 'x') RETURNING id`);
    await pool.query(
      'INSERT INTO issue_claims (app_id, github_issue_number, user_id) VALUES ($1, 48, $2)', [recipebot.id, ada.id],
    );
    await bot.refreshApp(pool, recipebot, { github: issues([48]), bot: botUser });
    assert.deepEqual(await queueRows(), [], 'the bot never competes with a person who started');
    await pool.query('DELETE FROM issue_claims');
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 48, 1, $2)`,
      [recipebot.id, bot.RESTART_REASON],
    );
    await bot.refreshApp(pool, recipebot, { github: issues([]), bot: botUser });
    assert.deepEqual(await queueRows(), [], 'a closed issue is not triaged again');
    await pool.query('DELETE FROM homeroom_bot_runs');
  });

  await t.test('the backstop: a live build nothing finished is recorded, and said once', async () => {
    bot._resetForTests();
    const posts = [];
    live.post = async (args) => { posts.push(args); return { postId: posts.length, githubCreatedAt: '2026-10-02T09:00:00Z' }; };
    live.advanceSeen = async () => ({ advanced: true });
    live.mentionTargets = async () => ['cyrcle_0'];
    const deps = {
      github: {
        isEnabled: () => true,
        getBotUsername: async () => 'usernode-bot',
        async fetchPublicIssue(_o, _r, n) { return { issue: { number: n, title: `Issue ${n}`, state: n === 60 ? 'closed' : 'open' } }; },
        async fetchIssueComments() { return { comments: [] }; },
      },
      ws: {}, sessionLifecycle: {}, domain: 'app.onhomeroom.com', threadContext: { async loadIssueThread() { return { messages: [] }; } },
    };
    const settings = await bot.readSettings(pool);

    // The 613 shape, with nothing ever recovered: archived, no outcome.
    const lost = await liveRun(recipebot, 48, await session(recipebot, { status: 'archived' }));
    // Its session left active, as a restart that took the worker leaves it.
    const leftActiveSession = await session(recipebot);
    const leftActive = await liveRun(recipebot, 51, leftActiveSession);
    // A newer run on its issue speaks for it.
    const superseded = await liveRun(recipebot, 52, await session(recipebot, { status: 'archived' }));
    await liveRun(recipebot, 52, null, { ago: 60 });
    // Its outcome was said before #3509 recorded outcomes.
    const said = await liveRun(recipebot, 53, await session(recipebot, { status: 'archived' }));
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind) VALUES ($1, 53, $2, 'build_failed')`, [recipebot.id, said],
    );
    // A proposal after all: the process died between the promote and its post.
    const proposedSession = await session(recipebot, { status: 'promoted' });
    const proposed = await liveRun(recipebot, 54, proposedSession);
    // An app the bot is no longer live on, and a closed issue: recorded only.
    const notLive = await liveRun(quiet, 55, await session(quiet, { status: 'archived' }));
    const closed = await liveRun(recipebot, 60, await session(recipebot, { status: 'archived' }));
    // Left alone: a build that may still be running, one recovery still
    // follows, and one recovery has noted.
    const recent = await liveRun(recipebot, 56, await session(recipebot), { ago: 600 });
    const following = await liveRun(recipebot, 57, await session(recipebot, { activeTurn: { mode: 'build' } }));
    const notedSession = await session(recipebot);
    const noted = await liveRun(recipebot, 58, notedSession);
    await bot.abandonRecoveredTurn({ pool, session: { id: notedSession }, why: 'the worker is gone' });

    assert.equal(await bot.settleAbandonedLiveBuilds(pool, settings, deps), 7);
    for (const id of [lost, leftActive, superseded, notLive, closed]) {
      assert.deepEqual(await runRow(id), { build_ok: false, build_error: bot.ABANDONED_LIVE_ERROR, proposal_session_id: null }, `run ${id}`);
    }
    assert.match((await runRow(said)).build_error, /^not recorded when it ended; the issue was told: build_failed$/);
    assert.deepEqual(await runRow(proposed), { build_ok: true, build_error: null, proposal_session_id: proposedSession });
    for (const id of [recent, following, noted]) assert.equal((await runRow(id)).build_ok, null, `run ${id} is left alone`);
    assert.equal(await statusOf(leftActiveSession), 'archived', 'its session is put away');
    assert.equal(await statusOf(proposedSession), 'promoted', 'a proposal is never archived by this');

    assert.deepEqual(posts.map((p) => p.issueNumber).sort(), [48, 51], 'said once each, only where nothing else speaks');
    for (const p of posts) {
      assert.equal(p.kind, 'build_failed');
      assert.equal(p.sender.id, botUser.id);
      assert.equal(p.text, 'Homeroom bot couldn\'t finish building this: Homeroom restarted in the middle of the build. '
        + 'Reply here (or on the GitHub issue) and it will try again.', 'what happened in plain words, and how to start it again');
      assert.deepEqual(p.dm, { reason: bot.ABANDONED_LIVE_REASON }, 'in the requester\'s DM too');
      assert.deepEqual(p.mentions, ['cyrcle_0'], 'whoever filed it is told');
    }

    // Once: a second sweep (another Pod, the next pass) records and says nothing.
    posts.length = 0;
    assert.equal(await bot.settleAbandonedLiveBuilds(pool, settings, deps), 0);
    assert.equal(posts.length, 0);
  });

  await t.test('the sweep waits out the longest a build can take', () => {
    const seconds = bot.abandonedLiveAfterSeconds({ turnSeconds: 1200 });
    assert.equal(seconds, bot.PLATFORM_BUILD_TIME_FACTOR * (1200 + live.SPEC_TURN_MAX_MS / 1000) + 600);
    assert.ok(seconds < 3 * 3600, 'the fixtures above are past it');
  });

  await t.test('a ready verdict waits on its run for a build slot on its project, and a newer verdict replaces it', async () => {
    const waiting = async (issue) => (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, thread_seen_at)
       VALUES ($1, $2, 'live', 'ready', 'build it', $3) RETURNING id`,
      [recipebot.id, issue, SEEN],
    )).rows[0].id;
    const first = await waiting(80);
    await bot.queueLiveBuild(pool, { runId: first, appId: recipebot.id });
    const second = await waiting(81);
    await bot.queueLiveBuild(pool, { runId: second, appId: recipebot.id });
    const quietRun = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, live_build_waiting_at)
       VALUES ($1, 82, 'live', 'ready', 'x', NOW()) RETURNING id`, [quiet.id],
    )).rows[0].id;
    const candidates = await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'] });
    assert.deepEqual(candidates.map((c) => Number(c.id)), [first, second], 'oldest first, only where the bot acts');
    assert.ok(!candidates.some((c) => Number(c.id) === quietRun));
    assert.deepEqual(bot.pickLiveBuilds(candidates, { slots: 6, perPerson: 2 }).map((p) => Number(p.id)), [first, second],
      'two builds on one project at once, under its BUILDS_PER_PROJECT');
    assert.deepEqual(bot.pickLiveBuilds(candidates, { slots: 6, perPerson: 2, buildingAppIds: [recipebot.id, recipebot.id] })
      .map((p) => Number(p.id)), [first], 'and only up to it, counting the builds already under way');
    assert.deepEqual(await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'], pausedApps: ['recipebot'] }), []);

    // A newer verdict on #81 (someone replied while it waited): the old wait is not built.
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note) VALUES ($1, 81, 'live', 'question', 'x')`,
      [recipebot.id],
    );
    assert.deepEqual((await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'] })).map((c) => Number(c.id)), [first]);
    // Its session exists: restart recovery owns it, and it no longer waits.
    const sessionId = await session(recipebot);
    await pool.query('UPDATE homeroom_bot_runs SET build_session_id = $2, live_build_waiting_at = NULL WHERE id = $1', [first, sessionId]);
    assert.deepEqual(await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'] }), []);
  });

  // Plant Pal #1 and #3 (2026-10-03): while a request's build ran, its spec
  // comment moved the issue's updated_at past what the run had recorded as
  // seen. The refresh queued it, the read lane read it again and found it
  // ready, and that second verdict was built and proposed too.
  await t.test('a request is not read again while its build waits or runs, and is never built twice', async () => {
    bot._resetForTests();
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
    // The spec comment, after the run's seen marker (SEEN).
    const spec = (numbers) => ({
      async fetchPublicIssues() {
        return { issues: numbers.map((n) => ({ number: n, state: 'open', createdAt: SEEN, updatedAt: '2026-10-03T16:46:40Z' })) };
      },
    });
    const capRoom = { proposals_per_app: 5, proposals_total: 5, question_tripwire: 10 };
    const readable = async () => (await bot.liveCandidates(pool, {
      liveSlugs: ['recipebot'], excludeAppIds: [], pausedApps: [], botId: botUser.id,
    })).map((c) => Number(c.issue_number));

    // Waiting its turn.
    const run = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, thread_seen_at, live_build_waiting_at)
       VALUES ($1, 90, 'live', 'ready', 'build it', $2, NOW()) RETURNING id, created_at`,
      [recipebot.id, SEEN],
    )).rows[0];
    let out = await bot.refreshApp(pool, recipebot, { github: spec([90]), bot: botUser, capRoom });
    assert.equal(out.queued, 0, 'its own build is the bot\'s work in progress');
    // Whatever else queues it (Run now, an answer in the DM) waits for the build.
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 90, 0, 'dm_answer')`, [recipebot.id],
    );
    assert.deepEqual(await readable(), []);

    // Under way: its session linked, the wait cleared in the same update.
    const building = await session(recipebot);
    await pool.query('UPDATE homeroom_bot_runs SET build_session_id = $2, live_build_waiting_at = NULL WHERE id = $1', [run.id, building]);
    out = await bot.refreshApp(pool, recipebot, { github: spec([90]), bot: botUser, capRoom });
    assert.equal(out.queued, 0);
    assert.deepEqual(await readable(), []);
    assert.deepEqual(await queueRows(), [{ issue_number: 90, reason: 'dm_answer' }], 'the answer waits for the build');

    // A second verdict that waited anyway (one recorded before this fix) is
    // not built once the first is up for a vote ...
    const second = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, live_build_waiting_at)
       VALUES ($1, 90, 'live', 'ready', 'build it', NOW()) RETURNING id, issue_number, build_note, created_at`,
      [recipebot.id],
    )).rows[0];
    await pool.query(
      `UPDATE chat_sessions SET status = 'promoted', promoted_at = NOW(), linked_issues = '{90}' WHERE id = $1`, [building],
    );
    await pool.query('UPDATE homeroom_bot_runs SET build_ok = TRUE, proposal_session_id = $2 WHERE id = $1', [run.id, building]);
    const github = { isEnabled: () => true, async fetchPublicIssue() { return { issue: { number: 90, state: 'open' } }; } };
    const skipped = await bot.buildOne(pool, {}, { bot: botUser, app: recipebot, run: second, settings: {}, deps: { github } });
    assert.deepEqual(skipped, { ran: false, reason: 'has_proposal' });
    const recorded = await runRow(second.id);
    assert.equal(recorded.build_ok, false);
    assert.equal(recorded.build_error, `skipped: the request already has a proposal (${building})`);

    // ... nor once that proposal merged after it.
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [building]);
    const third = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, live_build_waiting_at, created_at)
       VALUES ($1, 90, 'live', 'ready', 'build it', NOW(), NOW() - INTERVAL '5 minutes') RETURNING id`,
      [recipebot.id],
    )).rows[0];
    // As the lane hands it over: with when its verdict was recorded.
    const [pick] = await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'] });
    assert.equal(Number(pick.id), third.id);
    assert.ok(pick.created_at instanceof Date);
    assert.deepEqual(await bot.buildOne(pool, {}, { bot: botUser, app: recipebot, run: pick, settings: {}, deps: { github } }),
      { ran: false, reason: 'has_proposal' });

    // Once nothing of it is waiting or building, it is read again as usual.
    await pool.query('DELETE FROM homeroom_bot_runs WHERE id = ANY($1::int[])', [[second.id, third.id]]);
    out = await bot.refreshApp(pool, recipebot, { github: spec([90]), bot: botUser, capRoom });
    assert.equal(out.queued, 1);
    assert.deepEqual(await readable(), [90]);

    // A build nothing finished, past the window the abandoned-build sweep
    // reads, holds nothing.
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
    await liveRun(recipebot, 91, await session(recipebot), { ago: 8 * 24 * 3600 });
    out = await bot.refreshApp(pool, recipebot, { github: spec([91]), bot: botUser, capRoom });
    assert.equal(out.queued, 1);
    assert.deepEqual(await readable(), [91]);
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
  });

  // WP1 (#2): both of Plant Pal's duplicates were built while the first
  // proposal went up for a vote (3 s and 28 s after it), and proposed after
  // the request's issue had closed. A build is checked again once its plan
  // is written and just before it is proposed (whyNotBuild).
  const proposalOn = async (issue, status, { user = botUser.id, mergedAgo = null } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, promoted_at, merged_at)
     VALUES ($1, $2, $3, $4, FALSE, $5, NOW(),
             CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() - make_interval(secs => $6::int) END)
     RETURNING id`,
    [recipebot.id, user, `dev/homeroom_bot-${crypto.randomBytes(3).toString('hex')}`, status, [issue], mergedAgo],
  )).rows[0].id;
  const repo = { owner: 'usernode-bot', repo: 'recipebot' };
  const state = (s) => ({ async fetchPublicIssue(_o, _r, n) { return { issue: { number: n, state: s } }; } });

  await t.test('WP1 (#2): a build is not proposed once its request has another proposal of the bot\'s, or its issue closed', async () => {
    bot._resetForTests();
    await pool.query('DELETE FROM homeroom_bot_runs');
    const building = await session(recipebot);
    const runB = await liveRun(recipebot, 95, building, { ago: 600 });
    const why = (github = state('open')) => bot.whyNotBuild(pool, {
      runId: runB, botId: botUser.id, appId: recipebot.id, issueNumber: 95, github, repo,
    });
    assert.equal(await why(), null, 'nothing answers the request yet: the build goes on');

    // Run A's proposal goes up for a vote while B builds.
    const first = await proposalOn(95, 'active');
    assert.equal(await why(), null, 'a session still being built is no answer');
    await pool.query(`UPDATE chat_sessions SET status = 'promoted' WHERE id = $1`, [first]);
    assert.equal(await why(), `skipped: the request already has a proposal (${first})`);
    await pool.query(`UPDATE chat_sessions SET status = 'merging' WHERE id = $1`, [first]);
    assert.equal(await why(), `skipped: the request already has a proposal (${first})`);
    // Merged before this verdict: an earlier change on the same issue.
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [first]);
    assert.equal(await why(), null);
    // Merged since it: the request is answered.
    await pool.query(`UPDATE chat_sessions SET merged_at = NOW() WHERE id = $1`, [first]);
    assert.equal(await why(), `skipped: the request already has a proposal (${first})`);
    // A person's proposal is not the bot's to answer for.
    await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW(), merged_at = NULL WHERE id = $1`, [first]);
    const { rows: [ada] } = await pool.query(`INSERT INTO users (username, password) VALUES ('ada95', 'x') RETURNING id`);
    await proposalOn(95, 'promoted', { user: ada.id });
    assert.equal(await why(), null);

    // The request's issue closed while it was built.
    assert.equal(await why(state('closed')), bot.CLOSED_WHILE_BUILDING);
    assert.equal(bot.CLOSED_WHILE_BUILDING, 'skipped: the request was closed before it was proposed');
    // What cannot be read never stops a build.
    assert.equal(await why({ async fetchPublicIssue() { throw new Error('rate limited'); } }), null);
    const broken = { query: () => Promise.reject(new Error('connection lost')) };
    assert.equal(await bot.whyNotBuild(broken, { runId: runB, botId: botUser.id, appId: recipebot.id, issueNumber: 95 }), null);
    // A run stopped by its request's merge says so (noteRequestMerged).
    await pool.query(`UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = 'skipped: the request already has a proposal (1)' WHERE id = $1`, [runB]);
    assert.equal(await why(), 'skipped: the request already has a proposal (1)');
    await pool.query('DELETE FROM homeroom_bot_runs');
  });

  // WP1 (#2): the safety net. Once the bot's proposal for a request merges,
  // nothing else of the bot's on that request goes on.
  await t.test('WP1 (#2): a merge stops the request\'s other builds, withdraws a duplicate proposal and empties its queue', async () => {
    bot._resetForTests();
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
    // Run A's proposal, merged; it answered #96 and #98 (and #99).
    const merged = await proposalOn(96, 'merged', { mergedAgo: 0 });
    await pool.query(`UPDATE chat_sessions SET linked_issues = '{96,98,99}' WHERE id = $1`, [merged]);
    const ranA = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, proposal_session_id, build_session_id)
       VALUES ($1, 96, 'live', 'ready', TRUE, $2, $2) RETURNING id`, [recipebot.id, merged],
    )).rows[0].id;
    // A second build waiting its turn, and a third under way.
    const waiting = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, live_build_waiting_at)
       VALUES ($1, 96, 'live', 'ready', 'x', NOW()) RETURNING id`, [recipebot.id],
    )).rows[0].id;
    const runningSession = await session(recipebot);
    const running = await liveRun(recipebot, 96, runningSession, { ago: 60 });
    // A duplicate already up for a vote, a person's proposal on the same
    // request, and the bot's proposal on another request.
    const duplicate = await proposalOn(96, 'promoted');
    const { rows: [lee] } = await pool.query(`INSERT INTO users (username, password) VALUES ('lee96', 'x') RETURNING id`);
    const persons = await proposalOn(96, 'promoted', { user: lee.id });
    const elsewhere = await proposalOn(97, 'promoted');
    // Its queue: a refresh's row goes; a person waiting on the bot (Run now,
    // an answer) and a row being worked on stay; another request's stays.
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at) VALUES
         ($1, 96, 2, 'changed', NULL), ($1, 98, 0, 'dm_answer', NULL), ($1, 99, 1, 'new', NOW()), ($1, 97, 2, 'changed', NULL)`,
      [recipebot.id],
    );

    const stopped = [];
    const archived = [];
    const deps = {
      worker: { async stopTurn(id) { stopped.push(Number(id)); } },
      sessionLifecycle: {
        async archiveSession(args) {
          archived.push(args);
          await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [args.sessionId]);
          return { archived: true };
        },
      },
    };
    const out = await bot.noteRequestMerged(pool, { id: merged }, deps);
    assert.deepEqual(out, { skipped: 1, stopped: 1, withdrawn: 1, dequeued: 1 });
    const skip = `skipped: the request already has a proposal (${merged})`;
    const w = await runRow(waiting);
    assert.deepEqual([w.build_ok, w.build_error], [false, skip], 'the waiting build is never started');
    const { rows: [waitRow] } = await pool.query('SELECT live_build_waiting_at FROM homeroom_bot_runs WHERE id = $1', [waiting]);
    assert.equal(waitRow.live_build_waiting_at, null);
    const r = await runRow(running);
    assert.deepEqual([r.build_ok, r.build_error], [false, skip], 'the build under way is recorded stopped first ...');
    assert.deepEqual(stopped, [runningSession], '... then its turn is ended, which frees its build slot');
    assert.equal(await bot.whyNotBuild(pool, { runId: running, botId: botUser.id, appId: recipebot.id, issueNumber: 96 }), skip,
      'and whatever that turn comes to reads as the skip, never a failure');
    assert.deepEqual(archived, [{ pool, sessionId: duplicate, reason: 'superseded' }],
      'the duplicate is withdrawn as the platform withdraws one: no person did it');
    assert.equal(await statusOf(persons), 'promoted', 'a person\'s proposal is theirs');
    assert.equal(await statusOf(elsewhere), 'promoted', 'another request\'s is untouched');
    assert.deepEqual((await runRow(ranA)).build_ok, true, 'the merged proposal\'s own run is as it was');
    const { rows: queue } = await pool.query(
      'SELECT issue_number, reason FROM homeroom_bot_queue WHERE app_id = $1 ORDER BY issue_number', [recipebot.id],
    );
    assert.deepEqual(queue.map((q) => [q.issue_number, q.reason]), [[97, 'changed'], [98, 'dm_answer'], [99, 'new']]);

    // Once: a second call (another Pod) finds nothing left to do.
    assert.deepEqual(await bot.noteRequestMerged(pool, { id: merged }, deps), { skipped: 0, stopped: 0, withdrawn: 0, dequeued: 0 });
    // Only the bot's own merged proposals.
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [persons]);
    assert.equal(await bot.noteRequestMerged(pool, { id: persons }, deps), null);
    assert.equal(await bot.noteRequestMerged(pool, { id: elsewhere }, deps), null, 'nor one not merged');
    assert.equal(await bot.noteRequestMerged({ query: () => Promise.reject(new Error('down')) }, { id: merged }, deps), null, 'never throws');
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
  });

  // The merge-followups workflow machine can run this long after the merge
  // (a crash, a retry): only what started before the merge was made
  // unneeded by it. Plans, waiting builds, duplicate proposals and queue rows
  // made since are new work, and stay.
  await t.test('a late run, bounded by the merge time, leaves work started after the merge alone', async () => {
    bot._resetForTests();
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
    const merged = await proposalOn(96, 'merged', { mergedAgo: 0 });
    await pool.query(`UPDATE chat_sessions SET linked_issues = '{96}' WHERE id = $1`, [merged]);
    const before = new Date(Date.now() - 60 * 60 * 1000);
    const old = `NOW() - interval '2 hours'`;
    const plan = async (when) => (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at, created_at)
       VALUES ($1, 96, 'live', 'ready', NOW(), ${when}) RETURNING id`, [recipebot.id])).rows[0].id;
    const waitingBuild = async (when) => (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, live_build_waiting_at, created_at)
       VALUES ($1, 96, 'live', 'ready', 'x', NOW(), ${when}) RETURNING id`, [recipebot.id])).rows[0].id;
    const oldPlan = await plan(old);
    const newPlan = await plan('NOW()');
    const oldBuild = await waitingBuild(old);
    const newBuild = await waitingBuild('NOW()');
    const oldDuplicate = await proposalOn(96, 'promoted');
    await pool.query(`UPDATE chat_sessions SET created_at = ${old} WHERE id = $1`, [oldDuplicate]);
    const newDuplicate = await proposalOn(96, 'promoted');
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, enqueued_at)
       VALUES ($1, 96, 2, 'changed', ${old})`, [recipebot.id]);

    const archived = [];
    const deps = {
      before,
      dm: { async closePlanCards() {} },
      worker: { async stopTurn() {} },
      sessionLifecycle: {
        async archiveSession(args) {
          archived.push(args.sessionId);
          await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [args.sessionId]);
          return { archived: true };
        },
      },
    };
    const out = await bot.noteRequestMerged(pool, { id: merged }, deps);
    assert.deepEqual(out, { skipped: 2, stopped: 0, withdrawn: 1, dequeued: 1 }, 'the old plan and the old waiting build');
    assert.equal((await runRow(oldPlan)).build_ok, false);
    assert.equal((await runRow(newPlan)).build_ok, null, 'a plan made after the merge still waits for Build it');
    assert.equal((await runRow(oldBuild)).build_ok, false);
    assert.equal((await runRow(newBuild)).build_ok, null, 'a build queued after the merge still runs');
    assert.deepEqual(archived, [oldDuplicate]);
    assert.equal(await statusOf(newDuplicate), 'promoted', 'a proposal made after the merge is not a duplicate of it');
    // A queue row put there after the merge stays (the old one went).
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 96, 2, 'changed')`, [recipebot.id]);
    assert.equal((await bot.noteRequestMerged(pool, { id: merged }, deps)).dequeued, 0);
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
  });

  // WP1 (#9): a build a restart sent back to be built again is said, once;
  // one that carries on from its plan is not (#4210).
  await t.test('a plan a restart interrupted is kept: the build goes on from it, and the request is not planned again', async () => {
    bot._resetForTests();
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
    const PLAN = '# Undo a deleted recipe\n\n## User-facing changes\n\nAn Undo button.\n\n## Technical implementation\n\nKeep it a minute.';
    const sessionId = await session(recipebot);
    const runId = await liveRun(recipebot, 48, sessionId, { ago: 600 });
    const told = [];
    const dm = {
      async noteBuildRestarted(_pool, args) { told.push(args.runId); },
      async requesterOf() { return null; },
    };
    // The spec turn ran on in its worker through the restart, and recovery
    // followed it to its end: a plan.
    assert.equal(await bot.finishRecoveredTurn({
      pool, session: { id: sessionId }, activeTurn: { mode: 'scout' }, result: { lastResultText: PLAN },
    }), 'live_pending');
    assert.equal(await bot.completeRecoveredLive({ pool, config: {}, sessionId, deps: { ...noSpend, dm } }), 'resumed');
    assert.equal(await statusOf(sessionId), 'archived', 'the interrupted session is put away');
    const { rows: [kept] } = await pool.query(
      `SELECT build_ok, build_error, build_session_id, build_spec_md, live_build_waiting_at IS NOT NULL AS waiting
         FROM homeroom_bot_runs WHERE id = $1`, [runId],
    );
    assert.deepEqual(kept, { build_ok: null, build_error: null, build_session_id: null, build_spec_md: PLAN, waiting: true },
      'the same run waits for its build again, with its plan');
    assert.deepEqual(await queueRows(), [], 'not sent back to be triaged and planned again');
    // #4210: it is still building, so its requester is told nothing; the
    // interruption is kept for admins instead.
    assert.deepEqual(told, [], 'its requester is not told: it carries on');
    const { rows: incidents } = await pool.query(
      `SELECT app_id, session_id, metadata FROM events
        WHERE event_type = 'platform_incident' AND metadata->>'runId' = $1`, [String(runId)],
    );
    assert.equal(incidents.length, 1, 'recorded for admins');
    assert.equal(Number(incidents[0].session_id), Number(sessionId));
    assert.deepEqual([incidents[0].metadata.kind, Number(incidents[0].metadata.runId), incidents[0].metadata.outcome],
      ['build_interrupted', Number(runId), 'resumed']);
    const { recent } = require('../src/services/platform-incidents');
    const listed = await recent(pool);
    assert.equal(listed.items.find((i) => i.runId === Number(runId))?.outcome, 'resumed', 'and listed in the console');

    // The lane hands it over with its plan, and the build is made from it.
    // What the plan cost, as recovery would have recorded it from the
    // session's usage (none in this database).
    await pool.query('UPDATE homeroom_bot_runs SET build_cost_usd = 0.42 WHERE id = $1', [runId]);
    const [pick] = await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'] });
    assert.equal(Number(pick.id), runId);
    assert.equal(pick.build_spec_md, PLAN);
    let passed;
    live.botUsernameOf = async () => 'usernode-bot';
    live.advanceSeen = async () => {};
    live.buildAndPropose = async (args) => {
      passed = args;
      await args.onSession({ id: sessionId });
      return { ok: false, skipped: 'skipped: stopped by the test', sessionId, costUsd: 0.05 };
    };
    const github = {
      isEnabled: () => true,
      async fetchPublicIssue() { return { issue: { number: 48, title: 'Undo', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    };
    const out = await bot.buildOne(pool, {}, {
      bot: botUser, app: recipebot, run: pick, settings: {},
      deps: {
        github, dm, ...noSpend, sessions: { buildHeadlessSeed: () => 'seed' },
        threadContext: { async loadIssueThread() { return { messages: [] }; } },
        worker: {}, agentTurn: {}, activeWorkers: new Set(), sessionLifecycle: {}, ws: {}, domain: 'app.test',
      },
    });
    assert.equal(out.ran, true);
    assert.equal(passed.presetSpec, PLAN, 'built from the kept plan, with no second spec turn');
    const { rows: [cost] } = await pool.query('SELECT build_cost_usd::float8 AS c FROM homeroom_bot_runs WHERE id = $1', [runId]);
    assert.ok(Math.abs(cost.c - 0.47) < 1e-9, 'the build records the plan\'s cost beside its own');
    Object.assign(live, real);
    await pool.query('DELETE FROM homeroom_bot_runs');
  });

  await t.test('WP1 (#9): restart recovery that starts a build again tells its requester', async () => {
    bot._resetForTests();
    const sessionId = await session(recipebot);
    const runId = await liveRun(recipebot, 48, sessionId, { ago: 600 });
    const told = [];
    const dm = { async noteBuildRestarted(_pool, args) { told.push({ appId: args.app.id, issueNumber: args.issueNumber, runId: args.runId }); } };
    assert.equal(await bot.abandonRecoveredTurn({ pool, session: { id: sessionId }, why: 'the worker is gone' }), 'live_pending');
    assert.equal(await bot.completeRecoveredLive({ pool, config: {}, sessionId, deps: { ...noSpend, dm } }), 'requeued');
    assert.deepEqual(told, [{ appId: recipebot.id, issueNumber: 48, runId }]);
    // A failure to say it never fails recovery.
    const again = await session(recipebot);
    await liveRun(recipebot, 49, again, { ago: 600 });
    await bot.abandonRecoveredTurn({ pool, session: { id: again }, why: 'the worker is gone' });
    assert.equal(await bot.completeRecoveredLive({
      pool, config: {}, sessionId: again, deps: { ...noSpend, dm: { async noteBuildRestarted() { throw new Error('dm down'); } } },
    }), 'requeued');
    // Not a retry once its request no longer needs it (its merge stopped it,
    // or another proposal of the bot's answers it): a skip, and not a word.
    told.length = 0;
    await pool.query('DELETE FROM homeroom_bot_queue');
    const answered = await session(recipebot);
    const answeredRun = await liveRun(recipebot, 50, answered, { ago: 600 });
    const proposal = await proposalOn(50, 'promoted');
    await bot.abandonRecoveredTurn({ pool, session: { id: answered }, why: 'the worker is gone' });
    assert.equal(await bot.completeRecoveredLive({ pool, config: {}, sessionId: answered, deps: { ...noSpend, dm } }), 'skipped');
    assert.deepEqual(await runRow(answeredRun), {
      build_ok: false, build_error: `skipped: the request already has a proposal (${proposal})`, proposal_session_id: null,
    });
    assert.deepEqual(told, [], 'nothing said');
    assert.deepEqual(await queueRows(), [], 'and not sent round again');
    assert.equal(await statusOf(answered), 'archived');
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
  });

  // One ready run is built once. Since #4544 two or three builds started
  // from one run (homestead #31 and #32, ~300 ms apart; kasirku #7), and the
  // loser paid for a plan and a build before it stopped. Linking a build's
  // session to its run is its claim on the run: the first build to link has
  // it, and any other stops before its plan, with nothing recorded.
  await t.test('one ready run, two builds at once: the first to link its session builds it, the other stops before its plan', async () => {
    bot._resetForTests();
    await pool.query('DELETE FROM homeroom_bot_runs');
    const runId = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, thread_seen_at, live_build_waiting_at)
       VALUES ($1, 31, 'live', 'ready', 'build it', $2, NOW()) RETURNING id`, [recipebot.id, SEEN],
    )).rows[0].id;
    const [pick] = await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'] });
    assert.equal(Number(pick.id), runId);
    let release;
    const gate = new Promise((r) => { release = r; });
    const planned = [];
    const refused = [];
    live.botUsernameOf = async () => 'usernode-bot';
    live.advanceSeen = async () => {};
    // As buildAndPropose does: open a session, link it (the claim), and on
    // a refusal stop there (homeroom-bot-live.test.js pins that half).
    live.buildAndPropose = async (args) => {
      const sessionId = await session(recipebot);
      const why = await args.onSession({ id: sessionId });
      if (why) {
        refused.push(why);
        return { ok: false, sessionId, branchName: null, error: why, skipped: why, lostClaim: true, costUsd: null };
      }
      planned.push(sessionId);
      await gate;
      const stopped = 'skipped: stopped by the test';
      return { ok: false, skipped: stopped, error: stopped, sessionId, branchName: 'dev/homeroom_bot-first', costUsd: 0.3 };
    };
    const github = {
      isEnabled: () => true,
      async fetchPublicIssue() { return { issue: { number: 31, title: 'Chores', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    };
    const deps = {
      github, dm: { async requesterOf() { return null; } }, ...noSpend, sessions: { buildHeadlessSeed: () => 'seed' },
      threadContext: { async loadIssueThread() { return { messages: [] }; } },
      worker: {}, agentTurn: {}, activeWorkers: new Set(), sessionLifecycle: {}, ws: {}, domain: 'app.test',
    };
    // Two passes took the same run.
    const builds = [0, 1].map(() => bot.buildOne(pool, {}, { bot: botUser, app: recipebot, run: pick, settings: {}, deps }));
    for (let i = 0; i < 200 && planned.length + refused.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(planned.length, 1, 'one plan and one build');
    assert.deepEqual(refused, [bot.LOST_CLAIM], 'the other build stopped at its link');
    release();
    const outs = await Promise.all(builds);
    assert.deepEqual(outs.map((o) => o.acted).sort(), ['lost_claim', 'skipped']);
    const { rows: [run] } = await pool.query(
      `SELECT build_session_id, build_ok, build_error, build_branch, build_cost_usd::float8 AS cost
         FROM homeroom_bot_runs WHERE id = $1`, [runId],
    );
    assert.equal(Number(run.build_session_id), planned[0], 'the run is the first build\'s');
    assert.deepEqual([run.build_ok, run.build_error, run.build_branch, run.cost],
      [false, 'skipped: stopped by the test', 'dev/homeroom_bot-first', 0.3], 'with its record, and nothing of the other\'s');
    assert.deepEqual(await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'] }), [], 'and it waits for no other');
    Object.assign(live, real);
    await pool.query('DELETE FROM homeroom_bot_runs');
  });

  // Run 1267: a second build of a run, which stopped once the first's
  // proposal was up for a vote, wrote "failed" and its own branch over it.
  await t.test('a build that ends after its run has another build\'s proposal leaves the run\'s record alone', async () => {
    await pool.query('DELETE FROM homeroom_bot_runs');
    const first = await proposalOn(67, 'promoted');
    const runId = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, build_branch, build_session_id, proposal_session_id)
       VALUES ($1, 67, 'live', 'ready', TRUE, 'dev/first', $2, $2) RETURNING id`, [recipebot.id, first],
    )).rows[0].id;
    const record = async () => (await pool.query(
      `SELECT build_ok, build_error, build_branch, build_session_id, proposal_session_id, build_sha
         FROM homeroom_bot_runs WHERE id = $1`, [runId],
    )).rows[0];
    const before = await record();
    const second = await session(recipebot);
    await bot.recordLiveBuild(pool, runId, {
      ok: false, sessionId: second, branchName: 'dev/second', error: bot.hasProposalSkip(first), costUsd: 0.9,
    });
    assert.deepEqual(await record(), before, 'not "failed", not its branch');
    // Nor does a second proposal take the run's place.
    await bot.announceBuilt({
      pool, ws: {}, app: recipebot, bot: botUser, issueNumber: 67, runId, domain: 'app.test', say: async () => ({}),
      built: { ok: true, sessionId: second, prNumber: 9, branchName: 'dev/second' },
    });
    assert.deepEqual(await record(), before, 'its proposal is still the first');
    // The build the proposal is still records on it (restart recovery does).
    await bot.recordLiveBuild(pool, runId, { ok: true, sessionId: first, sha: 'b'.repeat(40) });
    assert.equal((await record()).build_sha, 'b'.repeat(40));
    await pool.query('DELETE FROM homeroom_bot_runs');
  });

  // A build under way is no proposal, but two of them are two proposals of
  // one request: of two builds of one request (two runs of it), the first
  // goes on and the second stops; never both.
  await t.test('of two builds of one request under way, the first goes on and the second stops', async () => {
    await pool.query('DELETE FROM homeroom_bot_runs');
    const first = await session(recipebot);
    const runA = await liveRun(recipebot, 32, first, { ago: 120 });
    const second = await session(recipebot, { status: 'paused' });
    const runB = await liveRun(recipebot, 32, second, { ago: 60 });
    const why = (runId) => bot.whyNotBuild(pool, { runId, botId: botUser.id, appId: recipebot.id, issueNumber: 32 });
    assert.equal(await why(runA), null, 'the first goes on');
    assert.equal(await why(runB), `skipped: the request is already being built (${first})`, 'the second stops');
    // A plan links no session of its own: it gives way to a build under way.
    const plan = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, live_build_waiting_at)
       VALUES ($1, 32, 'live', 'ready', NOW()) RETURNING id`, [recipebot.id],
    )).rows[0].id;
    assert.equal(await why(plan), bot.beingBuiltSkip(first));
    // Paused between its turns, it is still under way.
    await pool.query(`UPDATE chat_sessions SET status = 'paused' WHERE id = $1`, [first]);
    assert.equal(await why(runB), bot.beingBuiltSkip(first));
    // Not once it ended: put away, its outcome recorded, or older than any
    // build (the abandoned-build sweep's, not a build under way).
    await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [first]);
    assert.equal(await why(runB), null);
    await pool.query(`UPDATE chat_sessions SET status = 'active' WHERE id = $1`, [first]);
    await pool.query(`UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = 'x' WHERE id = $1`, [runA]);
    assert.equal(await why(runB), null);
    await pool.query('UPDATE homeroom_bot_runs SET build_ok = NULL, build_error = NULL WHERE id = $1', [runA]);
    await pool.query(`UPDATE chat_sessions SET created_at = NOW() - INTERVAL '5 hours' WHERE id = $1`, [first]);
    assert.equal(await why(runB), null);
    // Another request's build is no business of this one's.
    assert.equal(await bot.requestBuilding(pool, { appId: recipebot.id, issueNumber: 33, runId: runB }), null);
    await pool.query('DELETE FROM homeroom_bot_runs');
  });
});
