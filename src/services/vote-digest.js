'use strict';

/**
 * The once-a-day "what needs your vote" digest (#1374).
 *
 * ── Why this exists ────────────────────────────────────────────────────
 *
 * #1374 made `new_proposals` default OFF. Before that, every promoted
 * proposal pinged everyone with the app in "Your apps", everyone active in
 * it and the creator, with no way to turn it off — which was the complaint.
 * But that ping is also how the group LEARNS there is something to vote on,
 * and voting is the mechanism the whole platform runs on, so switching it
 * off by default without a replacement would have quietly traded a noise
 * problem for a turnout problem.
 *
 * This is the replacement: one notification a day saying how many proposals
 * are waiting on you, across every app you have a stake in. It is on by
 * default, and it is the reason muting the per-proposal ping is safe.
 *
 * ── Shape ──────────────────────────────────────────────────────────────
 *
 * The sweep runs HOURLY and sends to each user at most once per
 * MIN_GAP_HOURS. That is deliberately not "once a day at 09:00": the
 * platform stores no timezone for a user, so a fixed hour would be
 * breakfast for some people and the middle of the night for others.
 * Sweeping hourly and gating on "has this person had one recently" means
 * everybody gets one a day, near the time of day they first became
 * eligible, with no timezone anywhere in the code.
 *
 * The count is the open proposals waiting on a person: promoted proposals
 * in apps they have pinned or created, that they did not write, have not
 * already voted on, and are not in an app they blocked. Somebody with
 * nothing to do gets nothing, which is what keeps a daily notification
 * from becoming the noise it was meant to avoid. Who counts as having a
 * stake is spelled out on PENDING_SQL below, including what it does not
 * check.
 */

const log = require('./logger');
const { VOTE_DIGEST_LOCK } = require('./advisory-locks');

const INTERVAL_MS = 60 * 60 * 1000;      // sweep hourly
const FIRST_SWEEP_DELAY_MS = 5 * 60_000; // let boot settle first
// 20 rather than 24: the sweep is hourly and a strict 24 would drift a
// person's digest an hour later every day until it lapped, skipping one.
const MIN_GAP_HOURS = 20;
// Nobody reads "47 proposals need you" as a to-do list, and a runaway count
// usually means something is wrong rather than that somebody is very busy.
const MAX_COUNT = 99;

let timer = null;

/**
 * Users who owe at least one vote, with the count.
 *
 * A stakeholder is one of exactly two things: someone with an
 * app_favorites row for the app, or the app's creator. Nothing else is
 * read. In particular:
 *
 *   - Active users are NOT included. The per-proposal notification
 *     (services/notifications.js) also asks the members active on the app
 *     lately; this query does not, so a member who never pinned the app
 *     gets no digest for it. That is why Join (communities.join), an
 *     invite link (apply_community_invite in src/db/schema.sql) and an
 *     accepted invite (collab-invites.acceptInvite) all write the pin.
 *   - There is NO collaborator or visibility filter. A favoriter of a
 *     collab-private app they cannot vote on is still counted.
 *   - `hidden` is not read, so a hidden opt-out row counts like a pin.
 *
 * Excluded: the proposal's own author, apps the person blocked, proposals
 * they already voted on, a change Homeroom bot built for a request they
 * asked for, a change they were told is ready to try in the last 24 hours,
 * and anyone who had a digest in the last MIN_GAP_HOURS.
 *
 * Deliberately ONE query rather than a loop: this runs over every user on
 * the platform, and per-user round trips would make an hourly sweep a
 * measurable load.
 */
const PENDING_SQL = `
  WITH stakeholders AS (
    SELECT a.id AS app_id, f.user_id
      FROM apps a
      JOIN app_favorites f ON f.app_id = a.id
    UNION
    SELECT a.id AS app_id, a.created_by AS user_id
      FROM apps a WHERE a.created_by IS NOT NULL
  ),
  open_proposals AS (
    SELECT cs.id, cs.app_id, cs.user_id AS author_id
      FROM chat_sessions cs
     WHERE cs.status = 'promoted'
  )
  SELECT s.user_id, COUNT(DISTINCT p.id) AS pending,
         -- The one change, when there is exactly one: the row names it, so a
         -- tap opens it rather than a list of one.
         CASE WHEN COUNT(DISTINCT p.id) = 1 THEN MIN(p.id) END AS only_session_id,
         CASE WHEN COUNT(DISTINCT p.id) = 1 THEN MIN(p.app_id) END AS only_app_id
    FROM open_proposals p
    JOIN stakeholders s ON s.app_id = p.app_id
   WHERE s.user_id IS DISTINCT FROM p.author_id
     AND NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.user_id = s.user_id AND b.app_id = p.app_id)
     AND NOT EXISTS (
       SELECT 1 FROM pr_votes v
        WHERE v.session_id = p.id AND v.user_id = s.user_id
     )
     -- "One story": not a change Homeroom bot built for a request this
     -- person asked for. The bot is its author, so they would otherwise
     -- "owe" a vote on their own change; the bot's own message asks them.
     AND NOT EXISTS (
       SELECT 1 FROM homeroom_bot_runs r
         JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
        WHERE r.proposal_session_id = p.id AND q.user_id = s.user_id
     )
     -- Nor one they were told is ready to try in the last day: that ping
     -- already asked them.
     AND NOT EXISTS (
       SELECT 1 FROM notifications n
        WHERE n.user_id = s.user_id AND n.session_id = p.id
          AND n.kind IN ('change_ready', 'build_ready')
          AND n.created_at > NOW() - INTERVAL '24 hours'
     )
     AND NOT EXISTS (
       SELECT 1 FROM notifications n
        WHERE n.user_id = s.user_id
          AND n.kind = 'vote_digest'
          AND n.created_at > NOW() - ($1 || ' hours')::interval
     )
   GROUP BY s.user_id
   HAVING COUNT(DISTINCT p.id) > 0`;

/**
 * One sweep. Returns what it did, so a test can drive it directly without
 * waiting on the interval.
 */
async function sweep(pool) {
  const result = { candidates: 0, sent: 0, busy: false };
  const client = await pool.connect();
  let locked = false;
  try {
    // Every platform instance runs this interval. A digest sent twice is
    // worse than one sent late, so a instance that cannot take the lock
    // simply skips this hour rather than waiting for it.
    const lock = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [VOTE_DIGEST_LOCK, 0]
    );
    if (lock.rows[0]?.acquired !== true) {
      result.busy = true;
      return result;
    }
    locked = true;

    const { rows } = await client.query(PENDING_SQL, [String(MIN_GAP_HOURS)]);
    result.candidates = rows.length;
    if (!rows.length) return result;

    // Required lazily: this module is otherwise pure SQL and a top-level
    // require would drag the notification stack into every context that
    // merely wants its constants.
    const notificationPreferences = require('./notification-preferences');
    const notifications = require('./notifications');

    // The digest is account-wide, so it resolves against the account layer
    // only — there is no app to override it with.
    const allowed = await notificationPreferences.filterUsersByCategory(pool, {
      userIds: rows.map((row) => Number(row.user_id)),
      appId: null,
      categoryKey: 'vote_digest',
    });
    const allowedSet = new Set(allowed);

    for (const row of rows) {
      const userId = Number(row.user_id);
      if (!allowedSet.has(userId)) continue;
      const pending = Math.min(Number(row.pending) || 0, MAX_COUNT);
      if (!pending) continue;
      // One change waiting: the row carries its app and session, and opens
      // it (notifications.js). Several: no app, and a tap opens the
      // Communities screen's Needs you, which lists them all.
      const one = pending === 1 && row.only_session_id && row.only_app_id;
      try {
        const { rows: created } = await pool.query(
          `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
           VALUES ($1, $3, $4, NULL, 'vote_digest', $2)
           RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
          [userId, String(pending), one ? Number(row.only_app_id) : null, one ? Number(row.only_session_id) : null]
        );
        if (created[0]) {
          result.sent += 1;
          await notifications.hydrateAndPush(pool, created[0]);
        }
      } catch (err) {
        // One user's digest failing must not end the sweep for everybody
        // behind them in the list.
        log.warn('vote-digest', 'Digest insert failed', { userId, err: err.message });
      }
    }
    return result;
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [VOTE_DIGEST_LOCK, 0])
        .catch(() => {});
    }
    client.release();
  }
}

function start(config) {
  if (timer) return;
  const { getPool } = require('../db/pool');
  const run = async () => {
    try {
      const result = await sweep(getPool(config));
      if (result.sent) log.info('vote-digest', 'Digests sent', result);
    } catch (err) {
      log.error('vote-digest', 'Sweep failed', { err: err.message });
    }
  };
  setTimeout(run, FIRST_SWEEP_DELAY_MS);
  timer = setInterval(run, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  sweep,
  PENDING_SQL,
  INTERVAL_MS,
  MIN_GAP_HOURS,
  MAX_COUNT,
};
