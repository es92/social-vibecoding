'use strict';

// "Find people to build with" counts a join the moment it happens (#3564).
//
// Against the REAL schema in a throwaway PostgreSQL database — schema.sql
// applied as the boot migration applies it — so what is tested is the SQL
// that ships: the COMMUNITY_JOINED measure, the ledger's unique indexes that
// make a second credit impossible, the membership triggers, and the doors a
// person joins through (services/topochain/challenge-scorer.js scoreOnJoin,
// called by the Join button, the join screen, an invite link and an accepted
// invite).
//
// The report this answers: a newcomer joined a community, opened Challenges
// and read "Not started" — the measure was right, but nothing counted it
// until the rule's next scheduled pass. Each door below is asserted to have
// written the credit BEFORE it answered, with no tick in between.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set — the same contract as tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const communities = require('../src/services/communities');
const scorer = require('../src/services/topochain/challenge-scorer');
const { loadOnboarding } = require('../src/services/topochain/challenge-onboarding');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('community challenges count a join at once, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'join_scoring_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  let seq = 0;
  async function user({ platform = true } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, needs_communities_choice)
       VALUES ($1, 'x', $2, TRUE) RETURNING id, username`,
      [`member_${n}`, platform]
    );
    return rows[0];
  }
  async function app({ createdBy, selfHosted = false, view = 'public', collab = 'public' }) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, view_visibility, collab_visibility, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'running') RETURNING id`,
      [`App ${n}`, `app-${n}`, createdBy, selfHosted, view, collab]
    );
    if (createdBy) {
      await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`,
        [rows[0].id, createdBy]);
    }
    return (await pool.query('SELECT * FROM apps WHERE id = $1', [rows[0].id])).rows[0];
  }

  // Season 2 as production has it: the three First challenges on the
  // season's own event, "Find people to build with" scored by a rule on its
  // template — the binding that keeps working when the event's rows change.
  const { rows: [season] } = await pool.query(
    `INSERT INTO seasons (name, starts_at, ends_at, is_active)
     VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE) RETURNING id`);
  const { rows: [event] } = await pool.query(
    `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
     VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE, '{}'::jsonb, $1, 'season')
     RETURNING id`, [season.id]);
  const { rows: templates } = await pool.query(
    `INSERT INTO challenge_templates (category, goal, task, reward) VALUES
       ('ONBOARDING', 'Try 3 apps', 'Open three apps', '500 pts'),
       ('ONBOARDING', 'Suggest an improvement', 'Send feedback', '250 pts'),
       ('ONBOARDING', 'Find people to build with', 'Join a community', '500 pts')
     RETURNING id, goal`);
  const findPeople = templates.find((r) => r.goal === 'Find people to build with');
  const { rows: challengeRows } = await pool.query(
    `INSERT INTO challenges (season_event_id, challenge_template_id, display_order)
     SELECT $1, id, id FROM challenge_templates ORDER BY id RETURNING id, challenge_template_id`, [event.id]);
  const challengeId = Number(challengeRows.find((r) => Number(r.challenge_template_id) === Number(findPeople.id)).id);
  const { rows: [rule] } = await pool.query(
    `INSERT INTO challenge_scoring_rules (name, measure, challenge_template_id)
     VALUES ('Find people to build with', 'COMMUNITY_JOINED', $1) RETURNING id`, [findPeople.id]);

  const credits = async (userId) => (await pool.query(
    `SELECT points, description, metadata, activity_at FROM user_activities
      WHERE user_id = $1 AND challenge_id = $2`, [userId, challengeId])).rows;
  const done = async (userId) => (await loadOnboarding(pool, userId, { eventId: event.id }))
    .progress.get(challengeId).done;
  const config = {
    databaseUrl: String(url), selfAppSlug: 'no-such-self-app', selfAppPublicVoting: true,
    challengeScorer: { intervalMinutes: 10, aggregateHours: 0 },
  };

  // The platform's own project: everyone with access is put in it.
  const homeroom = await app({ createdBy: null, selfHosted: true });
  const owner = await user();
  const arena = await app({ createdBy: owner.id });

  await t.test('a membership from before the rule ran is credited on the first pass, once, with its own date', async () => {
    const early = await user();
    await communities.join(pool, arena, early.id);
    const { rows: [m] } = await pool.query(
      'SELECT joined_at FROM community_members WHERE community_id = $1 AND user_id = $2',
      [arena.community_id, early.id]);

    const first = await scorer.score(pool, { only: new Set([Number(rule.id)]) });
    assert.ok(first.credits >= 2, 'the joiner and the public project\'s creator');
    const [row] = await credits(early.id);
    assert.equal(Number(row.points), 500);
    assert.equal(row.metadata.kind, 'challenge_completion');
    assert.equal(row.metadata.source_key, 'community');
    assert.equal(new Date(row.activity_at).getTime(), new Date(m.joined_at).getTime(),
      'state, not an action: the credit keeps the day they joined');
    assert.equal(await done(early.id), true, 'and First challenges reads it as done');

    const again = await scorer.score(pool, { only: new Set([Number(rule.id)]) });
    assert.equal(again.credits, 0, 'a second pass writes nothing');
    assert.equal((await credits(early.id)).length, 1);
  });

  await t.test('the platform\'s own project and a project only you are in do not count', async () => {
    const onlyHomeroom = await user();
    await communities.join(pool, homeroom, onlyHomeroom.id);
    const solo = await user();
    await app({ createdBy: solo.id, view: 'private', collab: 'private' });
    await scorer.scoreOnJoin(pool, config);
    assert.deepEqual(await credits(onlyHomeroom.id), [],
      'everyone is in Homeroom without choosing it, so ticking it is not finding anyone');
    assert.deepEqual(await credits(solo.id), [], '"Just you" is nobody else');
    assert.equal(await done(onlyHomeroom.id), false);
  });

  await t.test('every door a person joins through counts it before it answers', async () => {
    const express = require('express');
    const { getPool } = require('../src/db/pool');
    const { appRoutes } = require('../src/routes/apps');
    const { onboardingRoutes } = require('../src/routes/onboarding');
    const { collaboratorRoutes } = require('../src/routes/collaborators');
    const communityInviteRoutes = require('../src/routes/community-invites');
    const invites = require('../src/services/community-invites');

    const server = express();
    server.use(express.json());
    let as = null;
    server.use((req, _res, next) => {
      req.user = { id: as.id, username: as.username, isAdmin: false, hasPlatformAccess: true };
      next();
    });
    server.use(appRoutes(config));
    server.use(onboardingRoutes(config));
    server.use(collaboratorRoutes(config));
    server.use(communityInviteRoutes(config));
    const listener = await new Promise((resolve) => {
      const l = server.listen(0, '127.0.0.1', () => resolve(l));
    });
    try {
      const base = `http://127.0.0.1:${listener.address().port}`;
      const call = async (method, p, body) => {
        const res = await fetch(base + p, {
          method,
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
      };

      // The Join button (Discover, a project's page).
      as = await user();
      let got = await call('POST', `/api/apps/${arena.slug}/membership`, { joined: true });
      assert.equal(got.status, 200);
      assert.equal((await credits(as.id)).length, 1, 'Join: credited before the response, no tick between');
      assert.equal(await done(as.id), true);
      // Leaving and coming back is still one person who found people.
      await call('POST', `/api/apps/${arena.slug}/membership`, { joined: false });
      await call('POST', `/api/apps/${arena.slug}/membership`, { joined: true });
      assert.equal((await credits(as.id)).length, 1, 'never paid twice');

      // Home's featured list: its ⊕ is a pin, which joins by trigger
      // (#4600). The route counts the join before it answers, and says the
      // pin was the join; a second pin joins nothing and says so.
      as = await user();
      got = await call('POST', `/api/apps/${arena.slug}/favorite`, { favorited: true });
      assert.equal(got.status, 200);
      assert.equal(got.body.joined, true, 'the pin was the join');
      assert.equal((await credits(as.id)).length, 1, 'featured list: credited before the response');
      assert.equal(await done(as.id), true);
      await call('POST', `/api/apps/${arena.slug}/favorite`, { favorited: false });
      got = await call('POST', `/api/apps/${arena.slug}/favorite`, { favorited: true });
      assert.equal(got.body.joined, false, 'an unpin is not a leave, so pinning again joins nothing');
      assert.equal((await credits(as.id)).length, 1, 'never paid twice');

      // The join screen, Homeroom ticked beside an open community.
      as = await user();
      got = await call('POST', '/api/me/communities', { join: [homeroom.slug, arena.slug] });
      assert.equal(got.status, 200);
      assert.deepEqual(got.body.joined, [homeroom.slug, arena.slug]);
      assert.equal((await credits(as.id)).length, 1, 'join screen: credited before Home loads');

      // An invite link, followed by someone already signed in.
      const made = await invites.createInvite(pool, { app: arena, user: { id: owner.id, isAdmin: false } });
      assert.equal(made.ok, true);
      as = await user();
      got = await call('POST', `/api/invite-links/by-token/${made.link.token}/redeem`);
      assert.equal(got.status, 200);
      assert.equal(got.body.status, 'joined');
      assert.equal((await credits(as.id)).length, 1, 'invite link: credited on the spot');

      // An invite to a private project, accepted.
      const host = await user();
      const club = await app({ createdBy: host.id, view: 'private', collab: 'private' });
      as = await user();
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, invited_by) VALUES ($1, $2, 'invited', $3)`,
        [club.id, as.id, host.id]);
      got = await call('POST', `/api/invites/${club.id}/accept`);
      assert.equal(got.status, 200);
      assert.equal((await credits(as.id)).length, 1, 'accepted invite: credited on the spot');
      assert.equal((await credits(host.id)).length, 1,
        'and the host of what is now a Private community, on the same tap');

      // An invite LINK into a private group, followed from the shell's
      // confirm (App._followInvite): the door of the first-session
      // run-through (2026-10-04), where "Join a community" read Not started
      // just after the join. Building there is by invitation, so the link is
      // the maker's collaborator invite, accepted (apply_community_invite).
      // The project was "Just you" until this tap and a Private community
      // after it, so it counts for the joiner and, now, for its maker.
      const maker = await user();
      const den = await app({ createdBy: maker.id, view: 'private', collab: 'private' });
      await scorer.scoreOnJoin(pool, config);
      assert.deepEqual(await credits(maker.id), [], 'alone in it, the maker has found nobody yet');
      const link = await invites.createInvite(pool, { app: den, user: { id: maker.id, isAdmin: false } });
      assert.equal(link.ok, true);
      as = await user();
      got = await call('POST', `/api/invite-links/by-token/${link.link.token}/redeem`);
      assert.equal(got.status, 200);
      assert.equal(got.body.status, 'joined');
      const { rows: [seat] } = await pool.query(
        'SELECT source FROM community_members WHERE community_id = $1 AND user_id = $2',
        [den.community_id, as.id]);
      assert.equal(seat.source, 'collaborator', 'in by the collaborator invite the link stands for');
      assert.equal((await credits(as.id)).length, 1, 'invite link into a private group: credited on the spot');
      assert.equal(await done(as.id), true, 'so Home and Challenges read Join a community as done');
      assert.equal((await credits(maker.id)).length, 1, 'and its maker, whose project is a group now');
    } finally {
      listener.close();
      await getPool(config).end().catch(() => {});
    }
  });

  await t.test('switched off, or with no rule, a join scores nothing and never throws', async () => {
    const late = await user();
    await communities.join(pool, arena, late.id);
    assert.equal(await scorer.scoreOnJoin(pool, { challengeScorer: { intervalMinutes: 0 } }), null,
      'interval 0 is "only Run now scores"');
    assert.deepEqual(await credits(late.id), []);

    await pool.query('UPDATE challenge_scoring_rules SET enabled = FALSE WHERE id = $1', [rule.id]);
    assert.equal(await scorer.scoreOnJoin(pool, config), null, 'a switched-off rule is not run');
    assert.deepEqual(await credits(late.id), []);
    await pool.query('UPDATE challenge_scoring_rules SET enabled = TRUE WHERE id = $1', [rule.id]);

    const broken = { query: async () => { throw new Error('connection reset'); } };
    assert.equal(await scorer.scoreOnJoin(broken, config), null, 'a failure is logged, not thrown into the join');

    const summary = await scorer.scoreOnJoin(pool, config);
    assert.ok(summary && summary.credits >= 1, 'switched back on, the next join counts everyone it missed');
    assert.equal((await credits(late.id)).length, 1);
  });
});
