'use strict';

// The Journey page's first mile (#3369), against the real schema in a
// throwaway database: required when TEST_DATABASE_URL is set, skipped when no
// server is reachable. The step rules themselves are pure and also pinned in
// tests/journey-definitions.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const journey = require('../src/services/journey');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a cohort by admit date: one row per person, the furthest step, and where each is stuck',
  { timeout: 120000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = 'journey_mile_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

    const D = '2026-09-24';
    const admitAt = `${D}T09:00:00Z`;
    const now = new Date('2026-09-27T12:00:00Z');
    const user = async (username, cols = {}) => {
      const base = { has_platform_access: true, platform_access_granted_at: admitAt, password_set: true,
        needs_username_choice: false, needs_communities_choice: false, ...cols };
      const keys = Object.keys(base);
      const { rows } = await pool.query(
        `INSERT INTO users (username, password, ${keys.join(', ')})
         VALUES ($1, 'x', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [username, ...keys.map((k) => base[k])]
      );
      return rows[0].id;
    };
    const signup = (email, userId, releasedAt = admitAt) => pool.query(
      'INSERT INTO waitlist_signups (email, released_at, linked_user_id) VALUES ($1, $2, $3)',
      [email, releasedAt, userId]
    );
    const mail = (kind, recipient, status, at) => pool.query(
      'INSERT INTO mail_deliveries (kind, recipient, status, created_at) VALUES ($1, $2, $3, $4)',
      [kind, recipient, status, at]
    );
    const boot = (userId, at, screen = 'shell_boot') => pool.query(
      `INSERT INTO events (user_id, event_type, metadata, created_at)
       VALUES ($1, 'ui_experience', jsonb_build_object('kind', 'screen_visit', 'screen', $2::text), $3)`,
      [userId, screen, at]
    );

    // ana: every step, then a first act (feedback).
    const ana = await user('ana', { communities_onboarded_at: `${D}T10:05:00Z`,
      getting_started_seen: JSON.stringify({ join_answer: 'joined' }),
      getting_started_gate: true, tour_done_at: `${D}T10:10:00Z` });
    await signup('ana@example.test', ana);
    await mail('waitlist_released', 'ana@example.test', 'sent', `${D}T09:00:05Z`);
    await mail('otp', 'ana@example.test', 'sent', `${D}T10:00:00Z`);
    await boot(ana, `${D}T10:02:00Z`);
    await pool.query(
      "INSERT INTO feedback_reports (user_id, target, description, created_at) VALUES ($1, 'platform', 'hi', $2)",
      [ana, `${D}T10:20:00Z`]
    );
    // ben: admitted, mail sent, never asked for a code, no account.
    await signup('ben@example.test', null);
    await mail('waitlist_released', 'ben@example.test', 'sent', `${D}T09:00:06Z`);
    // cy: asked for a code, the account exists, the password was never set.
    const cy = await user('cy', { password_set: false, has_platform_access: true });
    await signup('cy@example.test', cy);
    await mail('waitlist_released', 'cy@example.test', 'failed', `${D}T09:00:07Z`);
    await mail('otp', 'cy@example.test', 'sent', `${D}T11:00:00Z`);
    // dee: inside, the join screen was shown and not answered.
    const dee = await user('dee', { needs_communities_choice: true, getting_started_gate: true });
    await signup('dee@example.test', dee);
    await mail('waitlist_released', 'dee@example.test', 'sent', `${D}T09:00:08Z`);
    await mail('otp', 'dee@example.test', 'sent', `${D}T12:00:00Z`);
    await boot(dee, `${D}T12:03:00Z`);
    await boot(dee, `${D}T12:03:05Z`, 'join_sheet');
    await pool.query(
      `INSERT INTO events (user_id, event_type, metadata, created_at) VALUES
       ($1, 'ui_experience', '{"kind":"action_outcome","outcome":"failure","errorCode":"network"}', $2),
       ($1, 'ui_experience', '{"kind":"repeated_action"}', $2)`,
      [dee, `${D}T12:04:00Z`]
    );
    // Left out of the cohort: an old member admitted again, an admin, a test
    // account on the left-out list.
    const old = await user('old_hand', { platform_access_granted_at: '2026-03-01T00:00:00Z' });
    await signup('old@example.test', old);
    const boss = await user('boss', { is_admin: true, email: 'boss@example.test' });
    await signup('boss@example.test', boss);
    const qa = await user('qa_phone', { email: 'qa@example.test' });
    await signup('qa@example.test', qa);
    // Team addresses, with no left-out entry: admitted waitlist test signups
    // that never made an account (a team domain, and +tag variants of an
    // admin's and a left-out account's address), and an account at a team
    // domain. ben@example.test shares the admin's domain and still counts.
    await signup('salah+te123@onhomeroom.com', null);
    await signup('Boss+wl0929@example.test', null);
    await signup('qa+2@example.test', null);
    const teammate = await user('teammate', { email: 'andrea@usernodelabs.org' });
    await signup('andrea+waitlist@gmail.example', teammate);
    // Test accounts (services/test-accounts.js) are left out by their own
    // flag, with no left-out entry: one admitted in the cohort, and one let
    // in another way.
    const tester = await user('tester_1', { test_account_created_at: admitAt });
    await signup('tester@example.test', tester);
    await user('tester_2', { test_account_created_at: '2026-09-25T09:00:00Z', platform_access_granted_at: '2026-09-25T09:00:00Z' });
    // Another cohort, and someone who came in by a member's invite link.
    await signup('later@example.test', null, '2026-09-26T08:00:00Z');
    const host = await user('host', { platform_access_granted_at: '2026-06-01T00:00:00Z' });
    const guest = await user('guest', { admitted_by: host, platform_access_granted_at: '2026-09-25T08:00:00Z' });

    // Getting started for the onboard column: a running season with two First
    // challenges, and ana credited on both after finishing the tour.
    const { rows: [season] } = await pool.query(
      `INSERT INTO seasons (name, starts_at, ends_at, is_active)
       VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE) RETURNING id`);
    const { rows: [event] } = await pool.query(
      `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
       VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE, '{}'::jsonb, $1, 'season')
       RETURNING id`, [season.id]);
    await pool.query(
      `INSERT INTO challenge_templates (category, goal, task, reward) VALUES
         ('ONBOARDING', 'Join a community', 'Find people to build with.', '500 pts'),
         ('ONBOARDING', 'Try an app', 'Open an app and try it.', '500 pts')`);
    const { rows: firsts } = await pool.query(
      `INSERT INTO challenges (season_event_id, challenge_template_id, display_order)
       SELECT $1, id, id FROM challenge_templates ORDER BY id RETURNING id`, [event.id]);
    const credit = (userId, challengeId) => pool.query(
      `INSERT INTO user_activities (user_id, season_event_id, activity_type, points, activity_at, challenge_id)
       VALUES ($1, $2, 'challenge', 500, NOW(), $3)`, [userId, event.id, challengeId]);
    await credit(ana, firsts[0].id);

    // The admit mail's tracking (services/mail): ana clicked the link (no
    // open seen: images blocked), dee's mail was opened through an image
    // proxy, cy's only "click" was a link scanner's, and ben's mail went out
    // before tracking began.
    const track = async (recipient, events) => {
      const { rows: [d] } = await pool.query(
        `UPDATE mail_deliveries SET engagement_tracked = TRUE
          WHERE recipient = $1 AND kind = 'waitlist_released' RETURNING id`, [recipient]);
      for (const [type, uaClass, at] of events) {
        await pool.query(
          'INSERT INTO mail_events (delivery_id, type, user_agent_class, created_at) VALUES ($1, $2, $3, $4)',
          [d.id, type, uaClass, at]);
      }
    };
    await track('ana@example.test', [['clicked', 'unknown_client', `${D}T09:58:00Z`]]);
    await track('dee@example.test', [['opened', 'image_proxy', `${D}T11:50:00Z`]]);
    await track('cy@example.test', [['clicked', 'scanner_or_prefetch', `${D}T09:00:09Z`]]);

    const leftOutIds = [qa];
    const list = await journey.cohorts(pool, { now, leftOutIds });
    assert.deepEqual(list.cohorts, [
      { day: '2026-09-26', admitted: 1, withAccount: 0 },
      { day: D, admitted: 4, withAccount: 3 },
    ], 'old members, admins, test accounts, left-out accounts and team addresses are not newcomers');
    assert.deepEqual(list.otherWay, { people: 1 });

    const mile = await journey.firstMile(pool, { day: D, now, leftOutIds });
    const by = Object.fromEntries(mile.people.map((p) => [p.name, p]));
    assert.deepEqual(Object.keys(by).sort(), ['ana', 'ben@example.test', 'cy', 'dee']);
    assert.equal(by.ana.stuckAt, null);
    assert.equal(by.ana.furthest, 'first_act');
    assert.equal(by.ana.steps.find((s) => s.key === 'first_act').note, 'feedback');
    assert.equal(by.ana.steps.find((s) => s.key === 'join').note, 'joined');
    assert.equal(by['ben@example.test'].hasAccount, false);
    assert.equal(by['ben@example.test'].stuckAt, 'code_asked');
    assert.equal(by['ben@example.test'].daysSince, 3);
    assert.equal(by.cy.stuckAt, 'account');
    assert.equal(by.cy.stuckReason, 'Account started, not finished');
    assert.equal(by.cy.steps.find((s) => s.key === 'mail_sent').state, 'skipped',
      'a failed mail before a code that did arrive is behind them, not where they are stuck');
    assert.equal(by.dee.stuckAt, 'join');
    assert.equal(by.dee.stuckReason, 'Join screen shown, not answered');
    assert.equal(by.dee.failedAttempts, 1);
    assert.equal(by.dee.repeatedTaps, 1);

    // The onboard column: the tour plus the season's First challenges, x of n.
    assert.deepEqual(by.ana.onboard, { shown: true, done: 2, total: 3, complete: false },
      'the tour and one of two First challenges');
    assert.deepEqual(by.dee.onboard, { shown: true, done: 0, total: 3, complete: false },
      'the card is drawn for every new account, join screen answered or not (#4601)');
    assert.equal(by['ben@example.test'].onboard, null, 'no account, no card');
    await credit(ana, firsts[1].id);
    const again = (await journey.firstMile(pool, { day: D, now, leftOutIds })).people.find((p) => p.name === 'ana');
    assert.deepEqual(again.onboard, { shown: true, done: 3, total: 3, complete: true });
    assert.equal((await pool.query('SELECT getting_started_unlocked_at FROM users WHERE id = $1', [ana])).rows[0]
      .getting_started_unlocked_at, null, 'an admin reading the first mile never opens the gate');

    const passed = Object.fromEntries(mile.steps.map((s) => [s.key, s.passed]));
    assert.deepEqual(passed, {
      admitted: 4, mail_sent: 4, code_asked: 3, account: 2, access: 2, opened: 2, username: 2, join: 1, first_act: 1,
    });
    const stuckOn = Object.fromEntries(mile.steps.map((s) => [s.key, s.stuck.map((p) => p.name)]));
    assert.deepEqual(stuckOn.code_asked, ['ben@example.test']);
    assert.deepEqual(stuckOn.join, ['dee']);
    const mailNote = (name) => by[name].steps.find((s) => s.key === 'mail_sent').note;
    assert.equal(mailNote('ana'), 'clicked the link');
    assert.equal(mailNote('dee'), 'opened');
    assert.equal(mailNote('cy'), null, 'cy\'s admit mail failed, so it has no engagement note');
    assert.equal(mailNote('ben@example.test'), 'not tracked', 'a mail sent before tracking is a gap, not "no open"');
    assert.deepEqual(by.ana.mail, { opened: true, clicked: true }, 'a followed link counts as an open');
    assert.deepEqual(by.cy.mail, { opened: false, clicked: false }, 'a link scanner is not the person');
    assert.equal(by['ben@example.test'].mail, null);
    assert.deepEqual(mile.mail, { tracked: 3, opened: 2, clicked: 1 });
    const later = await journey.firstMile(pool, { day: '2026-09-26', now, leftOutIds });
    assert.equal(later.mail.recorded, false, 'a cohort with no tracked mail says so, never 0 of 0');

    const other = await journey.firstMile(pool, { day: 'other_way', now, leftOutIds });
    assert.deepEqual(other.people.map((p) => [p.name, p.door]), [['guest', 'invite_link']]);
    assert.equal(other.people[0].steps[0].key, 'account', 'their first mile starts at the account');
  });
