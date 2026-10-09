'use strict';

/**
 * The first session for somebody who arrives on their own, rather than by
 * an invite link (that path is services/community-invites.js and
 * frontend/src/features/first-session): the signed-out landing tells the
 * story ("On Homeroom, communities make apps together.") and asks them to
 * get started, instead of pitching the waitlist.
 *
 * THE STORY LANDING IS A SWITCH, ON unless an admin turns it off (Admin →
 * Waitlist), stored as the `first_session_story` platform setting and read
 * through a short cache like the invite tree's. It belongs with the
 * waitlist: "Get started" makes an account here, and while the waitlist is
 * the valve that account waits in the queue; turning the story off points
 * the landing back at the waitlist. No row, or a read that fails, is the
 * default: on. The setting's value reaches the landing through
 * GET /api/public/waitlist/options (`story_landing`).
 */

const log = require('./logger');

const STORY_KEY = 'first_session_story';
const CACHE_MS = 10 * 1000;
const STORY_DESCRIPTION = 'Whether the signed-out landing tells the first-session story and asks '
  + 'people to get started, instead of pointing at the waitlist (services/first-session.js). '
  + 'Switched from Admin → Waitlist.';
const caches = new WeakMap();

/** The stored switch: { enabled, updatedAt, updatedBy }. Cached per pool; on when unset or unreadable. */
async function readStorySetting(pool) {
  const cached = caches.get(pool);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.setting;
  try {
    const { rows } = await pool.query(
      `SELECT s.value, s.updated_at, u.username AS updated_by
         FROM platform_settings s
         LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.key = $1`,
      [STORY_KEY]
    );
    const row = rows[0];
    const setting = {
      enabled: row ? row.value !== 'false' : true,
      updatedAt: row ? row.updated_at || null : null,
      updatedBy: row ? row.updated_by || null : null,
    };
    caches.set(pool, { at: Date.now(), setting });
    return setting;
  } catch (err) {
    log.warn('first-session', 'Story landing setting read failed; showing the story', { err: err.message });
    return { enabled: true, updatedAt: null, updatedBy: null };
  }
}

async function storyLandingEnabled(pool) {
  return (await readStorySetting(pool)).enabled;
}

/** Switch the story landing on or off as admin `actorId`. */
async function setStoryLanding(pool, { enabled, actorId = null }) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, description, updated_at, updated_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [STORY_KEY, enabled ? 'true' : 'false', STORY_DESCRIPTION, actorId]
  );
  caches.delete(pool);
}

/**
 * While the story landing is on, a new account is not asked the join screen
 * ("What communities do you want to join?", services/onboarding.js): it is
 * asked "What do you want to make?" in that screen's place, however it
 * signed in. That question is OWED until it is answered, the way the join
 * screen is: `users.needs_communities_choice` stays TRUE while it is, so
 * every boot of the signed-in shell for that account (a reload, a new tab,
 * the phone app reopened, a sign-out and back in) asks it again
 * (frontend/src/features/auth/communities-first-run.js).
 *
 * Being SHOWN it answers nothing. Until 5 Oct 2026 it did: the screen's
 * start was recorded as the join screen's answer, so a new account that
 * reloaded before it answered landed on an empty Home and was never asked
 * again. Two moments now, kept apart:
 *
 *   recordStart        the question was put to them, from the story's own
 *                      sheet ('story') or from any other sign-in
 *                      ('sign_in'). Kept once, the first time, as
 *                      `getting_started_seen.first_session`, for the admin
 *                      Journey page; asking again on a later boot changes
 *                      nothing.
 *   answerJoinScreen   they answered it: Make it made a project ('made',
 *                      routes/apps.js) or they chose "Look around first"
 *                      ('looked_around', routes/onboarding.js). This is what
 *                      ends it.
 *
 * Journey's join step keeps its meaning: `join_answer` is still how the
 * first session reached them ('story' or 'sign_in'), and what they said is
 * `first_session_answer` beside it. A project made with no start recorded
 * is 'made', as it always was. communities_onboarded_at stays unset either
 * way (it records the join screen itself being answered); the Getting started
 * card and the First-challenges gate do not wait on it, since #4601 they
 * follow `getting_started_gate` alone, so a new account that came this way
 * gets both like any other. Each is a no-op for anyone who already answered.
 */
async function recordStart(pool, userId, via) {
  await pool.query(
    `UPDATE users
        SET getting_started_seen = COALESCE(getting_started_seen, '{}'::jsonb)
                                   || jsonb_build_object('first_session', $2::text)
      WHERE id = $1 AND needs_communities_choice = TRUE
        AND getting_started_seen->>'first_session' IS NULL`,
    [userId, via]
  );
}

// "Look around first" is also written to `events` as its own outcome
// (first_session_looked_around, #4039), in the same statement, so it is
// recorded exactly when the answer is, once, with its time: the admin
// Journey counts it beside the projects made from the question
// (services/journey.js firstSession). Make it needs no row here: POST
// /api/apps records app_created with from 'first-session'.
async function answerJoinScreen(pool, userId, answer) {
  await pool.query(
    `WITH answered AS (
       UPDATE users
          SET needs_communities_choice = FALSE,
              getting_started_seen = COALESCE(getting_started_seen, '{}'::jsonb)
                                     || jsonb_build_object(
                                          'join_answer', COALESCE(getting_started_seen->>'first_session', $2::text),
                                          'first_session_answer', $2::text)
        WHERE id = $1 AND needs_communities_choice = TRUE
        RETURNING id, getting_started_seen->>'first_session' AS via
     )
     INSERT INTO events (user_id, event_type, metadata)
     SELECT a.id, 'first_session_looked_around', jsonb_build_object('via', a.via)
       FROM answered a
      WHERE $2::text = 'looked_around'`,
    [userId, answer]
  );
}
const answerJoinScreenByMaking = (pool, userId) => answerJoinScreen(pool, userId, 'made');
const answerJoinScreenByLookingAround = (pool, userId) => answerJoinScreen(pool, userId, 'looked_around');

/**
 * Is an account that is still due the join screen asked "What do you want
 * to make?" in its place? While the story landing is on, yes, unless it is
 * already somewhere: a project of its own, or a community besides the
 * platform's own (which every account with access is in from the start).
 * The question stays owed for longer now (until it is answered, above), so
 * this is what keeps it from being put to somebody who has found their way
 * in by then: a group they were let into, a project made some other way.
 * They get the join screen instead, which lists what they are in, ticked.
 *
 * A link or an accepted invite answers the join screen itself
 * (services/community-invites.js), so an invitee is not due it at all;
 * this is the guard for whatever else gets there first. A read that fails
 * leaves the story's answer as it was, and never throws: GET /api/auth/me
 * reads this in the middle of its own profile lookup.
 */
async function asksWhatToMake(pool, userId) {
  if (!(await storyLandingEnabled(pool))) return false;
  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM apps WHERE created_by = $1)
              OR EXISTS (SELECT 1
                           FROM community_members m
                           JOIN apps a ON a.community_id = m.community_id
                          WHERE m.user_id = $1 AND NOT a.self_hosted) AS somewhere`,
      [userId]
    );
    return rows[0]?.somewhere !== true;
  } catch (err) {
    log.warn('first-session', 'Could not read whether the account is already somewhere', { userId, err: err.message });
    return true;
  }
}

/**
 * What the account told us on the waitlist that its group would build:
 * answers.group.need (services/waitlist-questions.js, `group_need`). People
 * write it on the website's optional second waitlist step (/waitlist-success,
 * "What would you build together?", saved through the stage-2 route
 * POST /api/public/waitlist/more/:token); the in-app survey's own wording of
 * the question is "What would its own app do that those tools can't?". The
 * make screen ("What do you want to make?") opens with it in "What should
 * it do?" and "Your own idea" picked (#4040).
 *
 * So only somebody who filled in that optional step, and then signed up with
 * the same email, gets it. A sign-up from the story's "Make an account"
 * creates no waitlist row, and gets the plain screen.
 *
 * Only the waitlist row linked to the account (waitlist.linkUserByEmail,
 * when an email-code or provider sign-up uses the row's address): the
 * waitlist is keyed by email, and a link is the platform's own word that
 * the two are the same person. An email-code sign-up with no waitlist row
 * has none. Null for no row, an empty answer, or a read that fails, and the
 * screen is then the plain one. Never throws: GET /api/auth/me reads it.
 */
async function waitlistIdea(pool, userId) {
  try {
    const { rows } = await pool.query(
      `SELECT NULLIF(BTRIM(answers->'group'->>'need'), '') AS idea
         FROM waitlist_signups
        WHERE linked_user_id = $1
        ORDER BY submitted_at DESC
        LIMIT 1`,
      [userId]
    );
    const idea = rows[0]?.idea;
    return typeof idea === 'string' && idea ? idea : null;
  } catch (err) {
    log.warn('first-session', 'Could not read the waitlist answer', { userId, err: err.message });
    return null;
  }
}

module.exports = {
  STORY_KEY,
  readStorySetting,
  storyLandingEnabled,
  setStoryLanding,
  recordStart,
  answerJoinScreen,
  answerJoinScreenByMaking,
  answerJoinScreenByLookingAround,
  asksWhatToMake,
  waitlistIdea,
};
