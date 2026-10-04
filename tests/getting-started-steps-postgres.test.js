'use strict';

// The Getting started card's step buttons (evan, 2026-10-01), against the
// REAL schema in a throwaway PostgreSQL database and through the real route
// (src/routes/onboarding.js):
//
//   * the DEFAULT APP the Try, Vote and Suggest buttons are about: the first
//     community joined, past Homeroom, the person's own project and anything
//     they could not open (services/onboarding.js defaultApp);
//   * where VOTE goes: the default app's Needs you when something waits
//     there, else the first project joined that has something, else the
//     default app's Workshop, read from the Needs you feed's own population
//     (routes/workshop-overview.js owedByCommunity), and agreeing with that
//     feed;
//   * the Workshop VISIT that ticks Vote when nothing is up for a vote:
//     recorded only then, refused cross-origin and for an account without the
//     card, counted on the spot by the real scorer's VOTE_CAST as a vote is,
//     once, and never from the old card's "workshop" key;
//   * THE ONE GATE (first-session test, 2026-10-03, decision D1): a newcomer
//     who keeps only Homeroom and has the Homeroom bot build a project only
//     they can see has not joined a community, so Join stays to do and Try,
//     Vote and Suggest stay locked on the card's `needs_join`, read through
//     the client's own stepView; voting on the bot's build of their app, or
//     asking for a change to it, pays nothing; once Join is ticked nothing is
//     locked, and with no default app the card falls back to an app Discover
//     leads with.
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is
// set, like tests/onboarding-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the Getting started buttons: default app, where Vote goes, and the Workshop visit', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'gs_steps_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  require('../src/db/pool').getPool = () => pool;
  const ws = require('../src/services/ws');
  ws.pushNotificationToUser = () => {};
  ws.sendSystemMessage = async () => {};
  require('../src/services/events').record = async () => {};
  const onboarding = require('../src/services/onboarding');
  const communities = require('../src/services/communities');
  const scorer = require('../src/services/topochain/challenge-scorer');
  const { NEEDS_FEED_SQL, NEEDS_FEED_MAX, owedByCommunity } = require('../src/routes/workshop-overview');
  // The client's own row logic, run on what the server sends.
  const cardView = require('./lib/render-tsx').loadTsx('frontend/src/features/home/getting-started.tsx');
  const { onboardingRoutes } = require('../src/routes/onboarding');

  const app = async (n, fields = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, status, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, $4, $5, $6, 'public') RETURNING id`,
      [n, fields.slug, fields.createdBy ?? null, !!fields.selfHosted, fields.status || 'running', fields.view || 'public']);
    return (await pool.query('SELECT * FROM apps WHERE id = $1', [rows[0].id])).rows[0];
  };
  // Homeroom first, so the trigger puts every account with platform access in it.
  const homeroom = await app('Homeroom', { slug: 'homeroom', selfHosted: true });
  const { rows: people } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, needs_communities_choice, getting_started_gate,
                        communities_onboarded_at) VALUES
       ('newbie', 'x', TRUE, FALSE, TRUE, NOW()), ('maker', 'x', TRUE, FALSE, FALSE, NULL),
       ('old_hand', 'x', TRUE, FALSE, FALSE, NULL)
     RETURNING id, username`);
  const [newbie, maker, oldHand] = people;
  const mine = await app('My diary', { slug: 'my-diary', createdBy: newbie.id });
  const broken = await app('Broken', { slug: 'broken', createdBy: maker.id, status: 'error' });
  const garden = await app('City garden', { slug: 'city-garden', createdBy: maker.id });
  const owls = await app('Night owls', { slug: 'night-owls', createdBy: maker.id });
  // The newcomer's memberships, in the order they joined: Homeroom (by
  // default), their own project, a broken one, then the garden and the owls.
  const join = async (a, minutesAgo) => pool.query(
    `INSERT INTO community_members (community_id, user_id, source, joined_at)
     VALUES ($1, $2, 'joined', NOW() - make_interval(mins => $3))
     ON CONFLICT (community_id, user_id) DO UPDATE SET joined_at = EXCLUDED.joined_at`,
    [a.community_id, newbie.id, minutesAgo]);
  await join(homeroom, 60);
  await join(mine, 50);
  await join(broken, 40);
  await join(garden, 30);
  await join(owls, 20);

  // The First challenges, each bound to the measure that says what it is.
  const { rows: [season] } = await pool.query(
    `INSERT INTO seasons (name, starts_at, ends_at, is_active)
     VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE) RETURNING id`);
  const { rows: [event] } = await pool.query(
    `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
     VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE, '{}'::jsonb, $1, 'season')
     RETURNING id`, [season.id]);
  const { rows: templates } = await pool.query(
    `INSERT INTO challenge_templates (category, goal, task, reward) VALUES
       ('ONBOARDING', 'Join a community', 'Find people to build with.', '500 pts'),
       ('ONBOARDING', 'Try an app', 'Open an app and try it.', '500 pts'),
       ('ONBOARDING', 'Vote on an app', 'Help decide what ships next.', '250 pts'),
       ('ONBOARDING', 'Suggest an improvement', 'Tell a community what would make it better.', '250 pts')
     RETURNING id, goal`);
  const tplOf = (goal) => templates.find((r) => r.goal === goal).id;
  const { rows: challengeRows } = await pool.query(
    `INSERT INTO challenges (season_event_id, challenge_template_id, display_order)
     SELECT $1, id, id FROM challenge_templates ORDER BY id RETURNING id, challenge_template_id`, [event.id]);
  const challengeOf = (goal) => Number(challengeRows.find((r) => Number(r.challenge_template_id) === Number(tplOf(goal))).id);
  const VOTE = challengeOf('Vote on an app');
  await pool.query(
    `INSERT INTO challenge_scoring_rules (name, measure, challenge_template_id) VALUES
       ('Join', 'COMMUNITY_JOINED', $1), ('Try', 'TRY_APPS', $2), ('Vote', 'VOTE_CAST', $3),
       ('Suggest', 'FEEDBACK_SENT', $4)`,
    [tplOf('Join a community'), tplOf('Try an app'), tplOf('Vote on an app'), tplOf('Suggest an improvement')]);

  const config = { selfAppPublicVoting: true, challengeScorer: { intervalMinutes: 10, aggregateHours: 0 } };
  let viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.user = viewer; next(); });
  server.use(onboardingRoutes(config));
  const listener = await new Promise((resolve) => { const s = server.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const call = async (method, path, { site = 'same-origin' } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': site }, body: method === 'POST' ? '{}' : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const card = async () => (await call('GET', '/api/me/getting-started')).data;
  t.after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  // A proposal put up for a vote, by somebody else unless said otherwise.
  const propose = async (a, by = maker.id) => Number((await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, pr_title, promoted_at, requires_explicit_approval)
     VALUES ($1, $2, 'promoted', 'Make it better', NOW(), TRUE) RETURNING id`, [a.id, by])).rows[0].id);
  const settle = (id) => pool.query(`UPDATE chat_sessions SET status = 'closed' WHERE id = $1`, [id]);
  const voteCredits = async () => (await pool.query(
    `SELECT points, metadata FROM user_activities WHERE user_id = $1 AND challenge_id = $2`, [newbie.id, VOTE])).rows;
  const seen = async () => (await pool.query(
    'SELECT getting_started_seen FROM users WHERE id = $1', [newbie.id])).rows[0].getting_started_seen;
  // The Needs you feed itself, for the same viewer: what Vote must agree with.
  const feed = async (showSelfHosted) => (await pool.query(NEEDS_FEED_SQL,
    [newbie.id, showSelfHosted, false, NEEDS_FEED_MAX])).rows;

  await t.test('the buttons are about the first community joined: not Homeroom, not their own, not one that is down', async () => {
    const c = await card();
    assert.equal(c.show, true);
    assert.deepEqual(c.steps.map((s) => s.action), ['tour', 'join', 'try', 'vote', 'suggest'],
      'each step is what its rule\'s measure says');
    assert.deepEqual(c.app, { slug: 'city-garden', name: 'City garden' },
      'Homeroom, their own diary and the broken app are passed over');
    assert.equal(c.try_seconds, 10, 'the scorer\'s own floor');
    assert.equal(c.steps[1].href, '#apps');
    // Leave the garden: the next one joined is it.
    await pool.query('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [garden.community_id, newbie.id]);
    assert.deepEqual((await card()).app, { slug: 'night-owls', name: 'Night owls' });
    await join(garden, 30);
    // Nothing they can try: no app, so no Vote target either.
    const none = await onboarding.defaultApp(pool, maker.id);
    assert.equal(none, null, 'a maker in nothing but Homeroom and their own projects has no default app');
  });

  await t.test('nothing up for a vote anywhere: Vote is the default app\'s Workshop', async () => {
    const c = await card();
    assert.deepEqual(c.vote, { kind: 'workshop', app: { slug: 'city-garden', name: 'City garden' }, count: 0 });
    assert.equal((await feed(true)).length, 0, 'and the Needs you feed is empty too');
  });

  await t.test('Vote goes to the first project joined that has something waiting, as the Needs you feed lists it', async () => {
    const inOwls = await propose(owls);
    let c = await card();
    assert.deepEqual(c.vote, { kind: 'needs', app: { slug: 'night-owls', name: 'Night owls' }, count: 1 });
    // Homeroom was joined first: where it is listed, it is where Vote goes.
    const inHomeroom = await propose(homeroom);
    c = await card();
    assert.deepEqual([c.vote.kind, c.vote.app.slug, c.vote.count], ['needs', 'homeroom', 1]);
    assert.deepEqual((await feed(true)).map((r) => r.slug).sort(), ['homeroom', 'night-owls'],
      'the same two the Needs you feed lists');
    // Where Homeroom is not listed (admins only), neither the feed nor Vote sees it.
    const hidden = await onboarding.gettingStarted(pool, newbie.id, { showSelfHosted: false });
    assert.deepEqual([hidden.vote.kind, hidden.vote.app.slug], ['needs', 'night-owls']);
    assert.deepEqual((await feed(false)).map((r) => r.slug), ['night-owls']);
    await settle(inHomeroom);
    await settle(inOwls);
  });

  await t.test('something waiting in the default app wins, and their own proposal or one they voted on is not waiting', async () => {
    const own = await propose(garden, newbie.id);
    assert.equal((await card()).vote.kind, 'workshop', 'their own proposal is not one to vote on');
    const voted = await propose(garden);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [voted, newbie.id]);
    assert.equal((await card()).vote.kind, 'workshop', 'nor one they already voted on');
    const waiting = [await propose(garden), await propose(garden)];
    await propose(owls);
    const c = await card();
    assert.deepEqual(c.vote, { kind: 'needs', app: { slug: 'city-garden', name: 'City garden' }, count: 2 });
    for (const id of [own, voted, ...waiting]) await settle(id);
    await pool.query(`UPDATE chat_sessions SET status = 'closed' WHERE app_id = $1`, [owls.id]);
    // The vote cast above was on somebody else's proposal inside the window,
    // so it is a VOTE_CAST credit of its own; take it back, and the vote,
    // so the visit below is what this step is credited for.
    await pool.query('DELETE FROM pr_votes WHERE user_id = $1', [newbie.id]);
    await pool.query('DELETE FROM user_activities WHERE user_id = $1', [newbie.id]);
  });

  await t.test('the Workshop visit is refused while a vote is waiting, cross-origin, and without the card', async () => {
    const waiting = await propose(owls);
    const res = await call('POST', '/api/me/getting-started/workshop-visit');
    assert.equal(res.status, 409);
    assert.deepEqual(res.data, { error: 'Something is waiting for your vote.', waiting: 1 });
    assert.equal(await seen(), null, 'nothing recorded');
    await settle(waiting);

    for (const site of ['cross-site', 'same-site', 'none']) {
      assert.equal((await call('POST', '/api/me/getting-started/workshop-visit', { site })).status, 403, site);
    }
    assert.equal(await seen(), null);

    viewer = { id: oldHand.id, username: oldHand.username, isAdmin: false };
    try {
      const refused = await call('POST', '/api/me/getting-started/workshop-visit');
      assert.equal(refused.status, 409, 'an existing member has no card, and no step to tick');
      assert.equal((await pool.query('SELECT getting_started_seen FROM users WHERE id = $1', [oldHand.id])).rows[0].getting_started_seen, null);
    } finally {
      viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
    }
    assert.deepEqual(await voteCredits(), []);
  });

  await t.test('with nothing waiting, the visit is recorded and VOTE_CAST pays it on the spot, once', async () => {
    const res = await call('POST', '/api/me/getting-started/workshop-visit');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const at = (await seen()).vote_workshop;
    assert.ok(Date.parse(at) > Date.now() - 60000, 'the visit, as a timestamp');
    const [credit, extra] = await voteCredits();
    assert.ok(credit, 'credited before the route answered');
    assert.equal(extra, undefined);
    assert.equal(Number(credit.points), 250);
    assert.equal(credit.metadata.source_key, `vote:workshop:${newbie.id}`);
    assert.equal(credit.metadata.measure, 'VOTE_CAST');
    const c = await card();
    assert.equal(c.steps.find((s) => s.action === 'vote').done, true, 'the Vote step ticks');
    assert.equal(c.vote, null, 'and nothing is read for it any more');
    // Again: recorded again, never paid twice.
    assert.equal((await call('POST', '/api/me/getting-started/workshop-visit')).status, 200);
    assert.equal((await voteCredits()).length, 1);
  });

  await t.test('VOTE_CAST counts the visit only inside the window, and never the old card\'s key', async () => {
    const window = { startMs: Date.now() - 86400000, endMs: Date.now() + 86400000 };
    const ofNewbie = async () => (await scorer.loadCandidates(pool, 'VOTE_CAST', window, {}))
      .filter((c) => Number(c.userId) === Number(newbie.id));
    let [candidate] = await ofNewbie();
    assert.deepEqual([candidate.sourceKey, candidate.description],
      [`vote:workshop:${newbie.id}`, 'Looked at the Workshop when nothing was up for a vote']);
    // A visit from before the window is not one inside it.
    await pool.query(`UPDATE users SET getting_started_seen = jsonb_build_object('vote_workshop', NOW() - INTERVAL '3 days') WHERE id = $1`, [newbie.id]);
    assert.deepEqual(await ofNewbie(), []);
    // The retired card's "workshop" key was written on any visit, whether a
    // vote was waiting or not: it is not a credit.
    await pool.query(`UPDATE users SET getting_started_seen = jsonb_build_object('workshop', NOW()) WHERE id = $1`, [newbie.id]);
    assert.deepEqual(await ofNewbie(), []);
    // A value that is not a timestamp is no row, not a failed pass.
    await pool.query(`UPDATE users SET getting_started_seen = '{"vote_workshop": "soon"}'::jsonb WHERE id = $1`, [newbie.id]);
    assert.deepEqual(await ofNewbie(), []);
    // A real vote and a visit: one row a person, the earlier of the two.
    await pool.query(`UPDATE users SET getting_started_seen = jsonb_build_object('vote_workshop', NOW()) WHERE id = $1`, [newbie.id]);
    const p = await propose(owls);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, created_at) VALUES ($1, $2, 'yes', NOW() - INTERVAL '1 hour')`, [p, newbie.id]);
    const both = await ofNewbie();
    assert.equal(both.length, 1);
    [candidate] = both;
    assert.equal(candidate.sourceKey, `vote:pr:${p}`, 'the vote came first');
    await settle(p);
  });

  // ── The one gate (first-session test, 2026-10-03; D1) ───────────────────
  //
  // The tester signed up, kept only Homeroom on the join screen, asked the
  // Homeroom bot for a houseplant app made "Just me", voted on its first
  // version and asked for a change from inside it. The card never ticked
  // Join (by design: neither counts), drew no lock under it, and paid the
  // vote and the request as if they were about somebody else's app.
  const { rows: [bot] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('homeroom_bot', 'x') RETURNING id`);
  const { rows: [plant] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, needs_communities_choice, getting_started_gate)
     VALUES ('plant_lover', 'x', TRUE, TRUE, TRUE) RETURNING id, username`);
  const SUGGEST = challengeOf('Suggest an improvement');
  const JOIN = challengeOf('Join a community');
  const creditsOf = async (userId, challengeId) => (await pool.query(
    `SELECT points, metadata FROM user_activities WHERE user_id = $1 AND challenge_id = $2`,
    [userId, challengeId])).rows;
  const window = () => ({ startMs: Date.now() - 86400000, endMs: Date.now() + 86400000 });
  const candidatesOf = async (measure, userId) => (await scorer.loadCandidates(pool, measure, window(), {}))
    .filter((c) => Number(c.userId) === Number(userId));
  // A project made "Just me": private, its maker the only member.
  const solo = async (n, slug, by) => {
    const { rows: [made] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, status, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, FALSE, 'running', 'private', 'private') RETURNING *`, [n, slug, by]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [made.id, by]);
    return (await pool.query('SELECT * FROM apps WHERE id = $1', [made.id])).rows[0];
  };
  // The bot's build of a request somebody made: the session is the bot's,
  // the request is theirs (homeroom-bot-live.js buildAndPropose).
  const botBuild = async (a, issueNumber, requester) => {
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version)
       VALUES ($1, $2, $3, 'Track my plants', $4)`, [a.id, issueNumber, requester, issueNumber === 1]);
    return Number((await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_title, promoted_at, requires_explicit_approval,
                                  created_from_issue_number)
       VALUES ($1, $2, 'promoted', 'First version', NOW(), TRUE, $3) RETURNING id`,
      [a.id, bot.id, issueNumber])).rows[0].id);
  };
  const ask = async (a, by) => pool.query(
    `INSERT INTO feedback_reports (user_id, target, app_id, issue_owner, issue_repo, issue_number, title, description)
     VALUES ($1, 'app', $2, 'o', 'r', $3, 'Watering reminders',
             'Please add a reminder that tells me which plants need water today, with a snooze button.')`,
    [by, a.id, 1000 + Number(a.id)]);
  const LOCK = ['Join a community first.', null];
  const rows = (c) => c.steps.map((st) => {
    const v = cardView.stepView(st, c);
    return [st.action, v.detail, v.button ? v.button.short : null];
  });
  let plantPal = null;

  await t.test('keeping only Homeroom and a project only you can see: Join stays to do, and Try, Vote and Suggest lock', async () => {
    viewer = { id: plant.id, username: plant.username, isAdmin: false };
    try {
      const offered = (await call('GET', '/api/me/join-suggestions')).data.communities;
      assert.deepEqual(offered.filter((c) => c.checked).map((c) => c.slug), ['homeroom'], 'Homeroom arrives ticked');
      const answer = await fetch(`${base}/api/me/communities`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ join: ['homeroom'] }),
      });
      assert.equal(answer.status, 200);
      assert.deepEqual((await answer.json()).joined, ['homeroom'], 'the screen kept it, and scored the answer on the spot');
      plantPal = await solo('Plant Pal', 'plant-pal', plant.id);
      const firstVersion = await botBuild(plantPal, 1, plant.id);
      await scorer.scoreOnJoin(pool, config);
      assert.deepEqual(await creditsOf(plant.id, JOIN), [], 'neither Homeroom nor a "Just you" project is a community joined');

      const c = await card();
      assert.equal(c.show, true);
      assert.equal(c.steps.find((st) => st.action === 'join').done, false);
      assert.equal(c.needs_join, true, 'the one gate is the Join row\'s own tick');
      assert.equal(c.app, null, 'Homeroom and their own project are no default app, and nothing falls back before Join');
      assert.equal(c.vote, null);
      assert.deepEqual(rows(c), [
        ['tour', 'See how Homeroom works.', 'Start'],
        ['join', 'Find people to build with. Homeroom and projects only you can see don’t count.', 'Join'],
        ['try', ...LOCK], ['vote', ...LOCK], ['suggest', ...LOCK],
      ]);

      // The bot's first version waits in their Needs you like any proposal,
      // but a vote on it is not one the Vote step counts.
      const owed = await owedByCommunity(pool, plant.id, { showSelfHosted: true });
      assert.deepEqual(owed.map((w) => [w.slug, w.waiting, w.paying]), [['plant-pal', 1, 0]]);

      // They vote on it anyway, and ask for a change from inside it.
      await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [firstVersion, plant.id]);
      await scorer.scoreOnVote(pool, config);
      await ask(plantPal, plant.id);
      await scorer.scoreOnFeedback(pool, config);
      assert.deepEqual(await creditsOf(plant.id, VOTE), [], 'voting on the bot\'s build of their own app pays nothing');
      assert.deepEqual(await creditsOf(plant.id, SUGGEST), [], 'nor does asking for a change to it');
      assert.deepEqual(await candidatesOf('VOTE_CAST', plant.id), [], 'and the schedule agrees');
      assert.deepEqual(await candidatesOf('FEEDBACK_SENT', plant.id), []);
      assert.deepEqual(await candidatesOf('USEFUL_FEEDBACK', plant.id), [], 'nor does the weekly feedback challenge');
      assert.equal((await card()).needs_join, true, 'still locked');
    } finally {
      viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
    }
  });

  await t.test('a vote on the bot\'s build of your own request does not count in a public community either', async () => {
    // Somebody else's vote on the same build is a vote on somebody else's
    // change, and counts.
    const build = await botBuild(garden, 7, plant.id);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes'), ($1, $3, 'yes')`,
      [build, plant.id, oldHand.id]);
    assert.deepEqual(await candidatesOf('VOTE_CAST', plant.id), [], 'their own request, built by the bot');
    const [other] = await candidatesOf('VOTE_CAST', oldHand.id);
    assert.equal(other && other.sourceKey, `vote:pr:${build}`, 'not the bot build of somebody else\'s request');
    // Feedback on somebody else's public app counts; on their own public app it does not.
    await ask(garden, plant.id);
    const [sent] = await candidatesOf('FEEDBACK_SENT', plant.id);
    assert.match(sent.description, /^Sent feedback on City garden$/);
    await ask(garden, maker.id);
    assert.deepEqual(await candidatesOf('USEFUL_FEEDBACK', maker.id), [], 'the maker asking their own project');
    await pool.query('DELETE FROM pr_votes WHERE session_id = $1', [build]);
    await pool.query('DELETE FROM feedback_reports WHERE user_id = ANY($1::int[])', [[plant.id, maker.id]]);
    await settle(build);
  });

  await t.test('once Join ticks nothing is locked, and Vote never points at their own app\'s build', async () => {
    viewer = { id: plant.id, username: plant.username, isAdmin: false };
    try {
      await communities.join(pool, garden, plant.id);
      await scorer.scoreOnJoin(pool, config);
      assert.equal((await creditsOf(plant.id, JOIN)).length, 1, 'a public community joined');
      // A second build of their own app is waiting, and nothing that would
      // count is waiting anywhere.
      await botBuild(plantPal, 2, plant.id);
      const c = await card();
      assert.equal(c.needs_join, false);
      assert.deepEqual(c.app, { slug: 'city-garden', name: 'City garden' });
      assert.deepEqual(c.vote, { kind: 'workshop', app: { slug: 'city-garden', name: 'City garden' }, count: 0 },
        'not "1 change is waiting in Plant Pal"');
      assert.deepEqual(rows(c).slice(2), [
        ['try', 'Spend 10 seconds in City garden.', 'Try'],
        ['vote', 'Nothing is waiting for approval yet. See what people are building.', 'Look'],
        ['suggest', 'Tell City garden’s builders what would make it better.', 'Suggest'],
      ]);
      // So the Look is the step, and the waiting build does not refuse it.
      const res = await call('POST', '/api/me/getting-started/workshop-visit');
      assert.equal(res.status, 200, JSON.stringify(res.data));
      const [credit] = await creditsOf(plant.id, VOTE);
      assert.equal(credit && credit.metadata.source_key, `vote:workshop:${plant.id}`);
      // Something that pays, waiting in the garden: Vote goes there.
      await pool.query(`UPDATE users SET getting_started_seen = NULL WHERE id = $1`, [plant.id]);
      await pool.query('DELETE FROM user_activities WHERE user_id = $1 AND challenge_id = $2', [plant.id, VOTE]);
      const waiting = await propose(garden);
      assert.deepEqual((await card()).vote, { kind: 'needs', app: { slug: 'city-garden', name: 'City garden' }, count: 1 });
      assert.equal((await call('POST', '/api/me/getting-started/workshop-visit')).status, 409, 'a vote that counts is waiting');
      await settle(waiting);
    } finally {
      viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
    }
  });

  await t.test('joined with no default app: the card falls back to an app Discover leads with, never a lock', async () => {
    // Somebody who started a public community of their own has joined one,
    // and every app in it is theirs.
    const { rows: [founder] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, needs_communities_choice, getting_started_gate,
                          communities_onboarded_at)
       VALUES ('founder', 'x', TRUE, FALSE, TRUE, NOW()) RETURNING id, username`);
    const club = await app('Founders club', { slug: 'founders-club', createdBy: founder.id });
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [club.id, founder.id]);
    await scorer.scoreOnJoin(pool, config);
    assert.equal((await creditsOf(founder.id, JOIN)).length, 1, 'starting a public community is joining one');
    assert.equal(await onboarding.defaultApp(pool, founder.id), null, 'their own app is not the default');

    viewer = { id: founder.id, username: founder.username, isAdmin: false };
    try {
      // Nothing featured: the open community with the most members.
      let c = await card();
      assert.equal(c.needs_join, false);
      assert.deepEqual(c.app, { slug: 'city-garden', name: 'City garden' });
      assert.deepEqual(rows(c).slice(2).map(([action, , button]) => [action, button]),
        [['try', 'Try'], ['vote', 'Look'], ['suggest', 'Suggest']], 'every step has its button');
      // A featured app comes first, in the admin's order.
      await pool.query(`INSERT INTO featured_apps (app_id, sort_order) VALUES ($1, 2), ($2, 1), ($3, 0)`,
        [owls.id, garden.id, club.id]);
      c = await card();
      assert.deepEqual(c.app, { slug: 'city-garden', name: 'City garden' }, 'their own featured app is passed over');
      await pool.query('UPDATE featured_apps SET sort_order = 3 WHERE app_id = $1', [garden.id]);
      assert.deepEqual((await card()).app, { slug: 'night-owls', name: 'Night owls' });
      assert.deepEqual(await onboarding.fallbackApp(pool, founder.id), { slug: 'night-owls', name: 'Night owls' });
      await pool.query('DELETE FROM featured_apps');
    } finally {
      viewer = { id: newbie.id, username: newbie.username, isAdmin: false };
    }
  });
});
