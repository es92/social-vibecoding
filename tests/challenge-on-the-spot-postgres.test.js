'use strict';

// The First challenges count the moment they are done (#3568, #3569, #3570).
//
// Against the REAL schema in a throwaway PostgreSQL database — schema.sql
// applied as the boot migration applies it — and through the real routes, so
// what is tested is what ships: the TRY_APPS, VOTE_CAST and FEEDBACK_SENT
// statements, the ledger's unique indexes, the scorer's advisory lock, and
// the doors that call services/topochain/challenge-scorer.js scoreOn: the app
// heartbeat, a vote on a proposal, a vote on a request, and a report.
//
// The reports this answers: "Suggested an improvement, but the challenge
// still says not started", and the First challenges as a whole being slow to
// tick for a newcomer trying to reach the rest of the season. Each door below
// is asserted to have written the credit BEFORE it answered, with no tick in
// between — and the heartbeat to have run a pass on the crossing and on no
// other heartbeat.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set — the same contract as tests/challenge-join-scoring-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const communities = require('../src/services/communities');
const scorer = require('../src/services/topochain/challenge-scorer');
const { CHALLENGE_SCORER_LOCK } = require('../src/services/advisory-locks');
const { loadOnboarding } = require('../src/services/topochain/challenge-onboarding');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the First challenges count on the spot, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'on_the_spot_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  // One teardown, in order: the routes and the work they settle after
  // answering first, then the pools, then the database.
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  let seq = 0;
  async function user() {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
      [`spot_${n}`]
    );
    return rows[0];
  }
  async function app({ createdBy }) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, view_visibility, collab_visibility, status, repo_url)
       VALUES ($1, $2, $3, FALSE, 'public', 'public', 'running', $4) RETURNING id`,
      [`App ${n}`, `app-${n}`, createdBy, `https://github.com/spot-owner/app-${n}`]
    );
    if (createdBy) {
      await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`,
        [rows[0].id, createdBy]);
    }
    return (await pool.query('SELECT * FROM apps WHERE id = $1', [rows[0].id])).rows[0];
  }

  // The First challenges as the agreed design has them: on the season's own
  // event, each scored by a rule on its template. "Try an app" is TRY_APPS at
  // a target of one.
  const { rows: [season] } = await pool.query(
    `INSERT INTO seasons (name, starts_at, ends_at, is_active)
     VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE) RETURNING id`);
  const { rows: [event] } = await pool.query(
    `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
     VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE, '{}'::jsonb, $1, 'season')
     RETURNING id`, [season.id]);
  const { rows: templates } = await pool.query(
    `INSERT INTO challenge_templates (category, goal, task, reward, metric_type, metric_target) VALUES
       ('ONBOARDING', 'Try an app', 'Open an app and try it', '500 pts', 'apps_tried', 1),
       ('ONBOARDING', 'Vote on a change', 'Vote on a proposal', '300 pts', NULL, NULL),
       ('ONBOARDING', 'Suggest an improvement', 'Send feedback', '250 pts', NULL, NULL)
     RETURNING id, goal`);
  const templateOf = (goal) => templates.find((r) => r.goal === goal);
  const { rows: challengeRows } = await pool.query(
    `INSERT INTO challenges (season_event_id, challenge_template_id, display_order)
     SELECT $1, id, id FROM challenge_templates ORDER BY id RETURNING id, challenge_template_id`, [event.id]);
  const challengeOf = (goal) => Number(challengeRows
    .find((r) => Number(r.challenge_template_id) === Number(templateOf(goal).id)).id);
  async function rule(goal, measure) {
    const { rows } = await pool.query(
      `INSERT INTO challenge_scoring_rules (name, measure, challenge_template_id)
       VALUES ($1, $2, $3) RETURNING id`, [goal, measure, templateOf(goal).id]);
    return Number(rows[0].id);
  }
  const tryRule = await rule('Try an app', 'TRY_APPS');
  const voteRule = await rule('Vote on a change', 'VOTE_CAST');
  const feedbackRule = await rule('Suggest an improvement', 'FEEDBACK_SENT');
  const TRY = challengeOf('Try an app');
  const VOTE = challengeOf('Vote on a change');
  const SUGGEST = challengeOf('Suggest an improvement');

  const credits = async (userId, challengeId) => (await pool.query(
    `SELECT points, description, metadata FROM user_activities
      WHERE user_id = $1 AND challenge_id = $2 ORDER BY id`, [userId, challengeId])).rows;
  const done = async (userId, challengeId) => (await loadOnboarding(pool, userId, { eventId: event.id }))
    .progress.get(challengeId).done;
  const lastScored = async (ruleId) => (await pool.query(
    'SELECT last_scored_at FROM challenge_scoring_rules WHERE id = $1', [ruleId])).rows[0].last_scored_at;
  const config = {
    databaseUrl: String(url), selfAppSlug: 'no-such-self-app', selfAppPublicVoting: true,
    platformRepoUrl: 'https://github.com/spot-owner/platform',
    challengeScorer: { intervalMinutes: 10, aggregateHours: 0 },
  };

  // The routes, as the server mounts them, with the signed-in person swapped
  // per call.
  const express = require('express');
  const { getPool } = require('../src/db/pool');

  const server = express();
  server.use(express.json());
  let as = null;
  server.use((req, _res, next) => {
    req.user = { id: as.id, username: as.username, isAdmin: false, hasPlatformAccess: true };
    next();
  });
  server.use(require('../src/routes/apps').appRoutes(config));
  server.use(require('../src/routes/votes').voteRoutes(config));
  server.use(require('../src/routes/issues').issueRoutes(config));
  server.use(require('../src/routes/feedback').feedbackRoutes(config));
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  cleanup.push(async () => {
    await new Promise((r) => listener.close(r));
    // A proposal vote settles its merge check after it answers; give it the
    // moment it needs before the pool it reads from goes away.
    await new Promise((r) => setTimeout(r, 300));
    await getPool(config).end().catch(() => {});
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const owner = await user();
  const arena = await app({ createdBy: owner.id });
  const second = await app({ createdBy: owner.id });
  const third = await app({ createdBy: owner.id });
  const beat = (slug, seconds) => call('POST', `/api/apps/${slug}/activity`, { seconds });

  await t.test('"Try an app": the heartbeat that crosses 10 seconds pays, and no other heartbeat runs a pass', async () => {
    as = await user();
    assert.equal((await beat(arena.slug, 6)).status, 200);
    assert.deepEqual(await credits(as.id, TRY), [], 'six seconds is not trying it');
    assert.equal(await lastScored(tryRule), null, 'and no pass ran for it');

    assert.equal((await beat(arena.slug, 6)).status, 200);
    const [credit] = await credits(as.id, TRY);
    assert.ok(credit, 'twelve seconds crossed the floor: credited before the heartbeat answered');
    assert.equal(Number(credit.points), 500, 'a count of one pays the whole reward on the first app');
    assert.equal(credit.metadata.source_key, `app:${arena.id}`);
    assert.equal(credit.metadata.measure, 'TRY_APPS');
    assert.equal(await done(as.id, TRY), true, 'and First challenges reads it as done');

    const stamped = await lastScored(tryRule);
    assert.ok(stamped);
    assert.equal((await beat(arena.slug, 30)).status, 200);
    assert.equal((await beat(arena.slug, 30)).status, 200);
    assert.equal((await lastScored(tryRule)).getTime(), stamped.getTime(),
      'heartbeats past the floor run no pass at all');

    // A second app crosses too, and runs its pass; the cap is one.
    await beat(second.slug, 12);
    assert.equal((await credits(as.id, TRY)).length, 1, 'never paid twice');

    // An app they made never counts, and never runs a pass.
    const own = await app({ createdBy: as.id });
    const before = await lastScored(tryRule);
    await beat(own.slug, 30);
    assert.equal((await lastScored(tryRule)).getTime(), before.getTime());
  });

  await t.test('time added up over days crosses too', async () => {
    as = await user();
    await pool.query(
      `INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES ($1, $2, 6, CURRENT_DATE - 1)`,
      [arena.id, as.id]);
    await beat(arena.slug, 6);
    assert.equal((await credits(as.id, TRY)).length, 1, 'six yesterday and six today is twelve');
  });

  await t.test('receipt-backed usage scores a multi-day crossing before answering and skips retries', async () => {
    as = await user();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const batch = (entries) => ({ version: 1, batchId: crypto.randomUUID(), entries });
    const send = (body, slug = arena.slug) => call('POST', `/api/apps/${slug}/activity`, body);
    const before = await lastScored(tryRule);
    assert.equal((await send(batch([{ date: today, seconds: 6 }]))).status, 200);
    assert.deepEqual(await credits(as.id, TRY), []);
    assert.equal((await lastScored(tryRule)).getTime(), before.getTime(), 'below the floor runs no pass');

    const crossing = batch([{ date: yesterday, seconds: 4 }, { date: today, seconds: 2 }]);
    assert.equal((await send(crossing)).status, 200);
    const paid = await credits(as.id, TRY);
    assert.equal(paid.length, 1, 'the combined batch crosses ten seconds, not either day increment alone');
    assert.equal(Number(paid[0].points), 500);
    assert.equal(await done(as.id, TRY), true, 'reward is visible before the response returns');
    const stamped = await lastScored(tryRule);
    const repeated = await send(crossing);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.duplicate, true);
    assert.equal((await lastScored(tryRule)).getTime(), stamped.getTime(), 'a receipt retry does not score again');
    assert.equal(Number((await pool.query(
      'SELECT SUM(seconds_spent) AS n FROM app_activity WHERE app_id = $1 AND user_id = $2',
      [arena.id, as.id])).rows[0].n), 12, 'the retry also leaves usage unchanged');
    await send(batch([{ date: today, seconds: 30 }]));
    assert.equal((await lastScored(tryRule)).getTime(), stamped.getTime(), 'later batches do not score again');
    const own = await app({ createdBy: as.id });
    await send(batch([{ date: today, seconds: 12 }]), own.slug);
    assert.equal((await lastScored(tryRule)).getTime(), stamped.getTime(), 'using your own app does not run scoring');
  });

  await t.test('while the scorer\'s lock is held the crossing waits for the schedule, and is paid once', async () => {
    as = await user();
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1, $2)', [CHALLENGE_SCORER_LOCK, 0]);
      assert.equal((await beat(arena.slug, 15)).status, 200, 'the heartbeat still answers');
      assert.deepEqual(await credits(as.id, TRY), [], 'a counted measure is never planned outside the lock');
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, $2)', [CHALLENGE_SCORER_LOCK, 0]);
      holder.release();
    }
    await beat(arena.slug, 15);
    assert.deepEqual(await credits(as.id, TRY), [], 'the crossing has passed; nothing re-runs it');
    await scorer.score(pool, { only: new Set([tryRule]) });
    assert.equal((await credits(as.id, TRY)).length, 1, 'the rule\'s next pass pays it');
    await scorer.score(pool, { only: new Set([tryRule]) });
    assert.equal((await credits(as.id, TRY)).length, 1);
  });

  await t.test('two crossings at once, on two apps, pay one credit', async () => {
    as = await user();
    const answers = await Promise.all([beat(second.slug, 12), beat(third.slug, 12)]);
    assert.deepEqual(answers.map((a) => a.status), [200, 200]);
    await scorer.score(pool, { only: new Set([tryRule]) });
    const paid = await credits(as.id, TRY);
    assert.equal(paid.length, 1, 'whichever pass got the lock planned it; the other waited');
    assert.equal(Number(paid[0].points), 500);
  });

  // A proposal and a request, each put up by the owner.
  const proposal = async () => {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_title, promoted_at, requires_explicit_approval)
       VALUES ($1, $2, 'promoted', 'Make it better', NOW(), TRUE) RETURNING id`, [arena.id, owner.id]);
    return Number(rows[0].id);
  };
  const request = async () => {
    const { rows } = await pool.query(
      `INSERT INTO issues (app_id, title, description, created_by) VALUES ($1, 'Rename it', 'Please', $2) RETURNING id`,
      [arena.id, owner.id]);
    return Number(rows[0].id);
  };

  await t.test('"Vote on a change": a vote on a proposal or a request counts before it answers', async () => {
    const sessionId = await proposal();
    as = await user();
    await communities.join(pool, arena, as.id);
    let got = await call('POST', `/api/sessions/${sessionId}/vote`, { vote: 'yes' });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const [credit] = await credits(as.id, VOTE);
    assert.ok(credit, 'a proposal vote: credited before the voter was answered');
    assert.equal(Number(credit.points), 300);
    assert.equal(credit.metadata.kind, 'challenge_completion');
    assert.equal(credit.metadata.source_key, `vote:pr:${sessionId}`);
    assert.equal(await done(as.id, VOTE), true);
    got = await call('POST', `/api/sessions/${sessionId}/vote`, { vote: 'no', reason: 'Not yet' });
    assert.equal(got.status, 200);
    assert.equal((await credits(as.id, VOTE)).length, 1, 'a flip is not a second first vote');

    const issueId = await request();
    as = await user();
    await communities.join(pool, arena, as.id);
    got = await call('POST', `/api/issues/${issueId}/vote`, { vote: 'up' });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const [onRequest] = await credits(as.id, VOTE);
    assert.ok(onRequest, 'a request vote: credited before it answered');
    assert.equal(onRequest.metadata.source_key, `vote:issue:${issueId}`);
  });

  await t.test('a vote on your own proposal or request does not count', async () => {
    const sessionId = await proposal();
    const issueId = await request();
    as = owner;
    assert.equal((await call('POST', `/api/sessions/${sessionId}/vote`, { vote: 'yes' })).status, 200);
    assert.equal((await call('POST', `/api/issues/${issueId}/vote`, { vote: 'up' })).status, 200);
    assert.deepEqual(await credits(owner.id, VOTE), [], 'the author voting for what they put up');
    await scorer.score(pool, { only: new Set([voteRule]) });
    assert.deepEqual(await credits(owner.id, VOTE), [], 'and the schedule agrees');
  });

  await t.test('a vote from before the window does not count until it is cast again', async () => {
    const sessionId = await proposal();
    const early = await user();
    await communities.join(pool, arena, early.id);
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, created_at) VALUES ($1, $2, 'yes', NOW() - INTERVAL '10 days')`,
      [sessionId, early.id]);
    await scorer.score(pool, { only: new Set([voteRule]) });
    assert.deepEqual(await credits(early.id, VOTE), [],
      'an action from before the season: the first pass does not hand out the reward for it');
    as = early;
    assert.equal((await call('POST', `/api/sessions/${sessionId}/vote`, { vote: 'no', reason: 'Changed my mind' })).status, 200);
    assert.equal((await credits(early.id, VOTE)).length, 1, 'cast again inside the window: counted');
  });

  await t.test('"Suggest an improvement": a report counts when it is sent, and junk does not', async (st) => {
    // GitHub stubbed for this door only, which files an issue before it
    // records the report the measure reads. Nothing here reaches GitHub.
    const github = require('../src/services/github');
    const real = { isEnabled: github.isEnabled, createIssue: github.createIssue, noteIssueCreated: github.noteIssueCreated };
    const priorToken = process.env.GITHUB_BOT_TOKEN;
    let issueNumber = 100;
    github.isEnabled = () => true;
    github.createIssue = async (o, r) => {
      issueNumber += 1;
      return { number: issueNumber, html_url: `https://github.com/${o}/${r}/issues/${issueNumber}` };
    };
    github.noteIssueCreated = () => {};
    process.env.GITHUB_BOT_TOKEN = 'test-token';
    st.after(() => {
      Object.assign(github, real);
      if (priorToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
      else process.env.GITHUB_BOT_TOKEN = priorToken;
    });
    // Let the proposal votes above finish settling first: their merge check
    // asks GitHub only when it is switched on.
    await new Promise((r) => setTimeout(r, 300));
    as = await user();
    // B8: a request on a project is filed by its members.
    await pool.query(
      `INSERT INTO community_members (community_id, user_id)
       SELECT community_id, $2 FROM apps WHERE id = $1 ON CONFLICT DO NOTHING`,
      [arena.id, as.id],
    );
    const send = (description) => call('POST', '/api/feedback', {
      description, title: 'A report', target: 'app', appSlug: arena.slug,
    });
    let got = await send('test');
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.deepEqual(await credits(as.id, SUGGEST), [], 'too short to act on: filed, not credited');
    got = await send('The vote button on the Workshop does nothing the first time I press it.');
    assert.equal(got.status, 200);
    const [credit] = await credits(as.id, SUGGEST);
    assert.ok(credit, 'credited before the reporter was answered');
    assert.equal(Number(credit.points), 250);
    assert.equal(credit.metadata.kind, 'challenge_completion');
    assert.equal(credit.metadata.grade, undefined, 'never graded');
    assert.match(credit.metadata.source_key, /^feedback:\d+$/);
    await send('The search box on Discover forgets what I typed when I go back to it.');
    assert.equal((await credits(as.id, SUGGEST)).length, 1, 'one is enough');
    assert.equal(await done(as.id, SUGGEST), true);
  });

  await t.test('switched off, or with the rule off, nothing is scored on the spot and nothing throws', async () => {
    const off = { ...config, challengeScorer: { intervalMinutes: 0 } };
    const quiet = await user();
    const sessionId = await proposal();
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [sessionId, quiet.id]);
    assert.equal(await scorer.scoreOnVote(pool, off), null, 'interval 0 is "only Run now scores"');
    await pool.query(`INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES ($1, $2, 12, CURRENT_DATE)`,
      [arena.id, quiet.id]);
    assert.equal(await scorer.scoreOnAppTime(pool, off, { appId: arena.id, ownerId: owner.id, userId: quiet.id, seconds: 12, daySeconds: 12 }), null);
    assert.deepEqual(await credits(quiet.id, VOTE), []);
    assert.deepEqual(await credits(quiet.id, TRY), []);

    await pool.query('UPDATE challenge_scoring_rules SET enabled = FALSE WHERE id = ANY($1::bigint[])', [[voteRule, feedbackRule]]);
    assert.equal(await scorer.scoreOnVote(pool, config), null, 'a switched-off rule is not run');
    assert.deepEqual(await credits(quiet.id, VOTE), []);
    await pool.query('UPDATE challenge_scoring_rules SET enabled = TRUE WHERE id = ANY($1::bigint[])', [[voteRule, feedbackRule]]);

    const broken = { query: async () => { throw new Error('connection reset'); } };
    assert.equal(await scorer.scoreOnVote(broken, config), null, 'a failure is logged, not thrown into the vote');
    assert.equal(await scorer.scoreOnAppTime(broken, config, { appId: 1, userId: 2, seconds: 12, daySeconds: 12 }), null);

    const summary = await scorer.scoreOnVote(pool, config);
    assert.ok(summary && summary.credits >= 1, 'switched back on, the next vote counts everyone it missed');
    assert.equal((await credits(quiet.id, VOTE)).length, 1);
  });
});
