'use strict';

/**
 * The Friday card (#1688): once a week, per app, one card saying what went
 * live and what is waiting on votes. It was a message in the app's general
 * chat; it is shown on the project's Workshop now.
 *
 * ── Why a card, and why every week ─────────────────────────────────────
 *
 * A merge announces itself the moment it lands, to whoever is looking. The
 * request behind this asked for a RHYTHM rather than a moment: the ritual
 * literature it cites finds that a repeated, plain, low-effort marker builds
 * cohesion where a one-off celebration does nothing. So the card is
 * deliberately repetitive — the same shape every Friday — and deliberately
 * quiet: a week with nothing merged and nothing open gets no card at all,
 * because an empty ritual is worse than none.
 *
 * ── Shape ──────────────────────────────────────────────────────────────
 *
 * The sweep runs HOURLY (services/vote-digest.js's shape: one interval on
 * every instance, an advisory lock so only one of them posts) and does
 * nothing until Friday at POST_HOUR_UTC. The platform stores no timezone
 * for an app or a person, so a fixed UTC hour is chosen to be daytime in
 * the most places: mid-afternoon in Europe, morning in the Americas.
 *
 * An app is due when its last card is more than six days old. The claim is
 * the UPDATE of apps.weekly_digest_at itself, guarded on that age, so two
 * instances that both find an app due can only stamp it once.
 *
 * The card is one `weekly_digest` event carrying its data as metadata, and
 * contentLine is its plain-text sentence. There is ONE notification per
 * person each week, not one per project (#6371): after the app loop the sweep
 * adds up what every due project did for each recipient and writes one row
 * ("Your weekly digest is ready", detail `w:<projects>:<merged>:<open>`),
 * which opens the This week page (`#week`, frontend/src/features/weekly-digest/)
 * built by forUser() below.
 *
 * The card names CHANGES, never people (#3678). It used to credit each
 * change's author and everyone whose Yes carried it, which on a busy
 * project made one sentence a roll of usernames, and a card about the
 * project is not the place to say who voted. Neither is gathered now.
 *
 * A channel carries no activity now (ws.sendSystemMessage writes no line
 * without a thread), so the card is recorded as a `weekly_digest` event
 * instead, and a project's Workshop shows it for a few days after it is
 * made (services/app-notices.js), beside the notification.
 */

const log = require('./logger');

const INTERVAL_MS = 60 * 60 * 1000;      // swept hourly (the weekly-digest clock)
const POST_DAY_UTC = 5;                  // Friday
const POST_HOUR_UTC = 15;                // from 15:00 UTC
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 7 * DAY_MS;            // "this week" is the last seven days
const MIN_GAP_DAYS = 6;                  // never two cards in one week
// The card lists a handful and counts the rest: a busy platform app merges
// hundreds of changes a week, and the card is one sentence on the Workshop,
// not a changelog. Three of each (#3678): the newest that went live, the
// longest waiting. It was eight, each with its people, and read as a wall.
const MAX_LISTED = 3;

/** Friday at or after the posting hour, in UTC. */
function isPostingTime(now) {
  return now.getUTCDay() === POST_DAY_UTC && now.getUTCHours() >= POST_HOUR_UTC;
}

/**
 * The two reads behind a week, for one app: the changes that merged in the
 * window (newest first) and the proposals still open (oldest first — the
 * ones waiting longest lead). `viewerId` adds `my_vote` to each open row, so
 * the This week page can keep the Vote pill off a change the reader has
 * already voted on; a null viewer asks that question of nobody and gets
 * false, which is what the Workshop card's call passes.
 */
async function readWeek(pool, appId, since, viewerId = null) {
  const { rows: merged } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.pr_title, cs.merged_at
       FROM chat_sessions cs
      WHERE cs.app_id = $1
        AND cs.status = 'merged' AND cs.live_at IS NOT NULL
        AND cs.merged_at >= $2
      ORDER BY cs.merged_at DESC, cs.id DESC`,
    [appId, since]
  );
  const { rows: open } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.pr_title,
            EXISTS (SELECT 1 FROM pr_votes v
                     WHERE v.session_id = cs.id AND v.user_id = $2::int) AS my_vote
       FROM chat_sessions cs
      WHERE cs.app_id = $1
        AND cs.status = 'promoted'
      ORDER BY cs.promoted_at ASC NULLS LAST, cs.created_at ASC, cs.id ASC`,
    [appId, viewerId]
  );
  return { merged, open };
}

/**
 * What the card says, for one app: the changes that merged in the window
 * (newest first) and the proposals still open (oldest first — the ones
 * waiting longest lead). Titles and numbers only: the card names nobody.
 */
async function gather(pool, app, now) {
  const since = new Date(now.getTime() - WINDOW_MS);
  const { merged, open } = await readWeek(pool, app.id, since.toISOString());
  const entry = (r) => ({
    id: r.id,
    prNumber: r.pr_number == null ? null : Number(r.pr_number),
    title: r.pr_title || `PR #${r.pr_number || r.id}`,
  });
  return {
    app: app.name,
    slug: app.slug,
    since: since.toISOString(),
    merged: merged.slice(0, MAX_LISTED).map(entry),
    mergedTotal: merged.length,
    open: open.slice(0, MAX_LISTED).map(entry),
    openTotal: open.length,
  };
}

/**
 * "<a>; <b>; <c>; and N more": at most MAX_LISTED of `items`, counting the
 * rest of `total`. The card is drawn from the record (app-notices.js), and a
 * card stored before #3678 carries eight, so they are cut to the same few
 * here rather than only where a new card is gathered.
 */
function listLine(items, total, label) {
  const shown = (Array.isArray(items) ? items : []).slice(0, MAX_LISTED).map(label);
  const more = total - shown.length;
  return `${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}

/**
 * The card as one plain sentence. Titles only: never who made a change or
 * who voted for it, even from a card stored while it still carried them.
 */
function contentLine(digest) {
  const bits = [];
  if (digest.mergedTotal) {
    const listed = listLine(digest.merged, digest.mergedTotal, (m) => m.title);
    bits.push(`${digest.mergedTotal} ${digest.mergedTotal === 1 ? 'change' : 'changes'} went live: ${listed}.`);
  } else {
    bits.push('Nothing landed this week.');
  }
  if (digest.openTotal) {
    const listed = listLine(digest.open, digest.openTotal, (o) => (o.prNumber ? `${o.title} (PR #${o.prNumber})` : o.title));
    bits.push(`${digest.openTotal === 1 ? 'One proposal is' : `${digest.openTotal} proposals are`} waiting for eyes: ${listed}.`);
  }
  return `This week on ${digest.app}: ${bits.join(' ')}`;
}

/**
 * Post one app's card, if it is still due. Returns what happened, so a test
 * can drive it directly: `posted`, `claimed` (false when another instance
 * stamped the app first), and the people the app's week is owed to — the
 * sweep adds those up into one notification per person (notifyPeople).
 */
async function post(pool, app, digest, now) {
  const { rows: claimed } = await pool.query(
    `UPDATE apps
        SET weekly_digest_at = $2
      WHERE id = $1
        AND (weekly_digest_at IS NULL OR weekly_digest_at < $2::timestamptz - ($3 || ' days')::interval)
      RETURNING id`,
    [app.id, now.toISOString(), String(MIN_GAP_DAYS)]
  );
  if (!claimed.length) return { posted: false, claimed: false, recipients: [] };

  // The card itself: a project's Workshop shows it for a few days
  // (services/app-notices.js), since a channel carries no activity.
  const events = require('./events');
  await events.record(pool, { type: events.EVENT_TYPES.WEEKLY_DIGEST, appId: app.id, metadata: digest });

  let recipients = [];
  try {
    const activeUsers = require('./active-users');
    const notificationPreferences = require('./notification-preferences');
    const memberIds = await activeUsers.listActiveUserIds(pool, app.id);
    recipients = await notificationPreferences.filterUsersByCategory(pool, {
      userIds: memberIds, appId: app.id, categoryKey: 'weekly_digest',
    });
  } catch (err) {
    // The card is in the Workshop; a notification that fails to send is not
    // a reason to take it down or to try the whole app again next hour.
    log.warn('weekly-digest', 'Recipients failed (card posted)', { appId: app.id, err: err.message });
  }
  return { posted: true, claimed: true, recipients };
}

/**
 * The one row a person gets each week (#6371): what every due project of
 * theirs did, added up. `detail` is `w:<projects>:<merged>:<open>`; a
 * `NOT EXISTS` guard on any `weekly_digest` row for that person newer than
 * MIN_GAP_DAYS keeps a second hourly pass — or an app that only becomes due
 * later — from sending a second one. One person's failure is logged and
 * skipped, so the rest of the week still goes out.
 */
async function notifyPeople(pool, tally, now) {
  const notifications = require('./notifications');
  let notified = 0;
  for (const [userId, week] of tally) {
    try {
      const detail = `w:${week.projects}:${week.merged}:${week.open}`;
      const { rows: created } = await pool.query(
        `INSERT INTO notifications (user_id, app_id, source_user_id, kind, detail)
         SELECT $1, NULL, NULL, 'weekly_digest', $2
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.user_id = $1 AND n.kind = 'weekly_digest'
               AND n.created_at > $3::timestamptz - ($4 || ' days')::interval
          )
         RETURNING id, user_id, app_id, source_user_id, kind, detail, created_at`,
        [userId, detail, now.toISOString(), String(MIN_GAP_DAYS)]
      );
      if (created[0]) {
        notified += 1;
        await notifications.hydrateAndPush(pool, created[0]);
      }
    } catch (err) {
      log.warn('weekly-digest', 'Weekly row failed', { userId, err: err.message });
    }
  }
  return notified;
}

/** How many items a project's card lists on the This week page. */
const PAGE_LISTED = 20;

/**
 * The This week page's answer (GET /api/me/weekly-digest): every project the
 * person is in that had something this week, its changes that went live
 * (newest first) and its open votes, each capped at PAGE_LISTED with a total.
 * A project with nothing in either list is left out, and the rest lead with
 * the one that merged most recently. Worked out when the page opens, so it
 * always covers the last seven days and can show a change that went live
 * after Friday's notification.
 */
async function forUser(pool, userId, now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_MS);
  const notificationPreferences = require('./notification-preferences');
  const { rows: apps } = await pool.query(
    `SELECT a.id, a.slug, a.name
       FROM apps a
       JOIN community_members m ON m.community_id = a.community_id
      WHERE m.user_id = $1
      ORDER BY a.name ASC, a.id ASC`,
    [userId]
  );
  const projects = [];
  for (const app of apps) {
    let allowed = [];
    try {
      allowed = await notificationPreferences.filterUsersByCategory(pool, {
        userIds: [userId], appId: app.id, categoryKey: 'weekly_digest',
      });
    } catch (err) {
      log.warn('weekly-digest', 'Preference read failed', { appId: app.id, err: err.message });
    }
    if (!allowed.map(Number).includes(Number(userId))) continue;
    const { merged, open } = await readWeek(pool, app.id, since.toISOString(), userId);
    if (!merged.length && !open.length) continue;
    const item = (r) => ({
      sessionId: r.id,
      prNumber: r.pr_number == null ? null : Number(r.pr_number),
      title: r.pr_title || `PR #${r.pr_number || r.id}`,
    });
    projects.push({
      slug: app.slug,
      name: app.name,
      merged: merged.slice(0, PAGE_LISTED).map((r) => ({ ...item(r), mergedAt: r.merged_at })),
      mergedTotal: merged.length,
      open: open.slice(0, PAGE_LISTED).map((r) => ({ ...item(r), myVote: r.my_vote === true })),
      openTotal: open.length,
      newestMergedAt: merged.length ? new Date(merged[0].merged_at).getTime() : 0,
    });
  }
  projects.sort((a, b) => (b.newestMergedAt - a.newestMergedAt) || a.name.localeCompare(b.name));
  for (const project of projects) delete project.newestMergedAt;
  return {
    since: since.toISOString(),
    until: now.toISOString(),
    projects,
    mergedTotal: projects.reduce((sum, p) => sum + p.mergedTotal, 0),
    projectCount: projects.length,
  };
}

/**
 * One sweep. `now` is injectable so a test can make it Friday.
 */
// One pass of the `weekly-digest` clock (src/workflow/clock/services.ts), on
// whichever process runs the workflow. post()'s conditional stamp of
// apps.weekly_digest_at is what keeps two passes at once from posting one
// app's card twice.
async function sweep(pool, now = new Date()) {
  const result = { due: 0, posted: 0, quiet: 0, notified: 0, skipped: false };
  if (!isPostingTime(now)) {
    result.skipped = true;
    return result;
  }
  const { rows: apps } = await pool.query(
    `SELECT id, slug, name
       FROM apps
      WHERE weekly_digest_at IS NULL
         OR weekly_digest_at < $1::timestamptz - ($2 || ' days')::interval
      ORDER BY id ASC`,
    [now.toISOString(), String(MIN_GAP_DAYS)]
  );
  result.due = apps.length;
  // userId → { projects, merged, open }: one row per person at the end, not
  // one per project (#6371).
  const tally = new Map();
  for (const app of apps) {
    try {
      const digest = await gather(pool, app, now);
      if (!digest.mergedTotal && !digest.openTotal) {
        result.quiet += 1;
        continue;
      }
      const outcome = await post(pool, app, digest, now);
      if (outcome.posted) {
        result.posted += 1;
        for (const userId of outcome.recipients) {
          const week = tally.get(userId) || { projects: 0, merged: 0, open: 0 };
          week.projects += 1;
          week.merged += digest.mergedTotal;
          week.open += digest.openTotal;
          tally.set(userId, week);
        }
      }
    } catch (err) {
      // One app's card failing must not end the sweep for the apps
      // behind it in the list.
      log.warn('weekly-digest', 'Card failed', { appId: app.id, err: err.message });
    }
  }
  if (tally.size) {
    try {
      result.notified = await notifyPeople(pool, tally, now);
    } catch (err) {
      log.warn('weekly-digest', 'Weekly rows failed', { err: err.message });
    }
  }
  if (result.posted) log.info('weekly-digest', 'Cards posted', result);
  return result;
}

module.exports = {
  sweep,
  gather,
  post,
  notifyPeople,
  forUser,
  readWeek,
  contentLine,
  isPostingTime,
  INTERVAL_MS,
  POST_DAY_UTC,
  POST_HOUR_UTC,
  WINDOW_MS,
  MIN_GAP_DAYS,
  MAX_LISTED,
  PAGE_LISTED,
};
