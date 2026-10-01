'use strict';

// THE GATE: a new account's season waits on its Getting started list.
//
// The first ONBOARDING_LIMIT ONBOARDING challenges of the season, in the
// organiser's display order, are the First challenges, and since 2026-10-01
// (evan's "one list" decision) they ARE the Getting started card on Home: the
// tour, then these, each ticking from a credit the moment it is earned
// (src/services/onboarding.js draws the card from `steps` below). Four, up
// from three, because the list grew a step: Join a community, Try an app,
// Vote on a change, Suggest an improvement. The NAMES are the admin's data,
// never this file's: whatever four come first is the list.
//
// WHO IS GATED. Until the tour is done (finished or skipped) and every one of
// those challenges is, the rest of the season is hidden from the viewer, but
// only from an account that started on that list: `users.getting_started_gate`
// (set at sign-up since the list shipped, FALSE for every account before it;
// the note beside the column in src/db/schema.sql) on an account that came
// through the join screen, whose card therefore shows. Everyone else, and
// every signed-out visitor, sees the whole season, and the lists send them no
// gate summary at all: the same payload as a season with no ONBOARDING
// challenges, which every client already draws.
//
// ONCE OPEN, OPEN FOR GOOD. The first read that finds a gated account's list
// done records it (`users.getting_started_unlocked_at`), and from then on the
// account is not gated: an ONBOARDING challenge an admin adds to the season
// later is one more thing to do, not a wall that comes back down.
const ONBOARDING_LIMIT = 4;

// THE VIEWER'S BLOCK COUNT, AND THE ONLY PLACE IT LIVES. Block scores are
// written to leaderboard snapshots and never to the points ledger
// (services/topochain/snapshot-builder.js), so a `blocks_produced` challenge
// cannot be counted from `user_activities` the way every other metric is.
// This correlated subquery reads the viewer's newest snapshot for the event
// the challenge belongs to, and it is the ONE copy of that SQL: a query that
// already has a `c` row to correlate against embeds it (home-panels.js
// re-exports it as MY_BLOCKS_SQL for its own row query and profile.js's, and
// loadOnboarding below selects it as `blocks`), and the challenge lists,
// whose query carries no user parameter, run it through loadEventBlocks.
// $1 is the viewer's id.
const NEWEST_EVENT_BLOCKS_SQL = `(SELECT ls.event_total_produced_blocks FROM leaderboard_snapshots ls
              WHERE ls.user_id = $1 AND ls.season_event_id = c.season_event_id
              ORDER BY ls.snapshot_at DESC, ls.id DESC LIMIT 1)`;

// Match the home panel's existing ledger-based progress rule. Numeric
// challenges require the target number of credits, not merely some points.
function resolveProgress({ metricKind, metricTarget, activityCount, blocks, completionRecorded = false }) {
  const count = Number(activityCount) || 0;
  const target = Number(metricTarget);
  const hasTarget = metricKind != null && Number.isFinite(target) && target > 0;
  if (!hasTarget) return { done: completionRecorded || count > 0, current: null, target: null };
  const raw = metricKind === 'blocks_produced' ? (Number(blocks) || 0) : count;
  return {
    done: completionRecorded || raw >= target || (target <= 1 && count > 0),
    current: completionRecorded ? target : Math.max(0, Math.min(raw, target)),
    target,
  };
}

// The first ONBOARDING_LIMIT ONBOARDING definitions in organiser display
// order are the introduction. The remaining definitions become persistent
// challenges. Select before considering progress or availability: finishing,
// disabling, or retiring a step must never promote an identity challenge into
// its place.
//
// Every row carries the viewer's three facts (`gate`, `tour_done`,
// `unlocked`, from loadOnboarding's join on `users`), so the gate is decided
// from the same read as the progress it waits on. `gated` is whether the gate
// applies to this viewer at all; `summary.unlocked` stays the one answer every
// list reads, and is TRUE for a viewer the gate does not apply to. `opened` is
// the read on which a gated viewer's list is first done, which loadOnboarding
// records so it stays open.
function buildOnboarding(rows, now = Date.now()) {
  if (!rows.length) return null;
  const viewer = rows[0];
  const gated = viewer.gate === true && viewer.unlocked !== true;
  const tourDone = viewer.tour_done === true;
  const ordered = [...rows].sort((a, b) =>
    Number(a.display_order) - Number(b.display_order) || Number(a.id) - Number(b.id));
  const templates = new Set();
  const steps = ordered.filter((r) => {
    const key = Number(r.challenge_template_id);
    if (templates.has(key)) return false;
    templates.add(key);
    return true;
  }).slice(0, ONBOARDING_LIMIT);
  const required = steps.filter((r) => r.enabled && !r.completed
    && (!r.schedule_start || Date.parse(r.schedule_start) <= now)
    && (!r.schedule_end || Date.parse(r.schedule_end) >= now));
  const progress = new Map(steps.map((r) => [Number(r.id), resolveProgress({
    metricKind: r.metric_type,
    metricTarget: r.metric_target,
    activityCount: r.activity_count,
    blocks: r.blocks,
    completionRecorded: r.completion_recorded === true,
  })]));
  const completed = required.filter((r) => progress.get(Number(r.id)).done).length;
  // The list is done when the tour is and every available step is. The tour
  // counts here and not in `total`/`completed`, which stay the challenges'
  // own numbers: the native and web lists draw them as "N of M First
  // challenges", where a tour has no card.
  const finished = tourDone && completed === required.length;
  return {
    ids: steps.map((r) => Number(r.id)),
    progress,
    // The available steps in the list's order, with what the Getting started
    // card draws for each (title, task, reward, earned points, the measure
    // that scores it). Additive: no list reads it.
    steps: required,
    gated,
    tourDone,
    // Done now, or let through on an earlier read: the card's "You're all
    // set" state, which a challenge added since does not take away.
    finished: finished || viewer.unlocked === true,
    opened: gated && finished,
    summary: {
      total: required.length, completed, unlocked: !gated || finished,
      event_id: Number((required.find((r) => !progress.get(Number(r.id)).done) || steps[0]).season_event_id),
    },
  };
}

// Whether the gate is CLOSED for this viewer: what the lists hide behind.
function isLocked(onboarding) {
  return !!onboarding && !onboarding.summary.unlocked;
}

// The summary a list sends this viewer, or null. Only to a viewer the gate
// applies to (the read that opens it included): an existing member and a
// signed-out visitor get no summary, which is exactly what a season with no
// ONBOARDING challenges sends, so every client draws them the whole season
// with no gate to explain.
function gateSummary(onboarding) {
  return onboarding && onboarding.gated ? onboarding.summary : null;
}

// Keep the gate open once it has opened (ONCE OPEN, OPEN FOR GOOD, at the
// top). One idempotent write per account, ever, on the read that first finds
// the list done. It never fails the read it rides on: a write that did not
// land leaves the account where it was, and the next read tries again.
async function recordUnlocked(pool, userId) {
  try {
    await pool.query(
      `UPDATE users SET getting_started_unlocked_at = NOW()
        WHERE id = $1 AND getting_started_gate AND getting_started_unlocked_at IS NULL`,
      [userId]
    );
  } catch { /* the next read records it */ }
}

// Always resolve the entire season, even when the caller is viewing one
// weekly event or has filtered completed challenges out of its own query.
// Credits on earlier instances of the same template count too: onboarding
// is a one-time introduction, not something to repeat at a season boundary.
//
// The same read carries what the Getting started card draws for each step
// (the challenge's own text over its template's, the points the viewer has
// been paid on it, and the measure of the scoring rule bound to it, which is
// how the card knows where a step's action is) and the viewer's gate facts,
// so the card, the gate and every list are one query and one answer.
async function loadOnboarding(pool, userId, { seasonId, eventId } = {}) {
  const scope = seasonId != null ? 'se.season_id = $2'
    : 'se.season_id = (SELECT season_id FROM season_events WHERE id = $2)';
  const { rows } = await pool.query(
    `/* challenge onboarding */
     SELECT c.id, c.season_event_id, c.challenge_template_id, c.display_order, c.enabled, c.completed,
            COALESCE(c.schedule_start, ct.schedule_start) AS schedule_start,
            COALESCE(c.schedule_end, ct.schedule_end) AS schedule_end,
            COALESCE(c.metric_type, ct.metric_type) AS metric_type,
            COALESCE(c.metric_target, ct.metric_target) AS metric_target,
            COALESCE(c.goal, ct.goal) AS goal,
            COALESCE(c.task, ct.task) AS task,
            COALESCE(c.reward, ct.reward) AS reward,
            COALESCE(c.cta_link, ct.cta_link) AS cta_link,
            credit.activity_count, credit.earned_points,
            EXISTS (SELECT 1 FROM user_activities ua
               JOIN challenges credited ON credited.id = ua.challenge_id
              WHERE ua.user_id = $1
                AND credited.challenge_template_id = c.challenge_template_id
                AND ua.metadata->>'kind' = 'challenge_completion') AS completion_recorded,
            ${NEWEST_EVENT_BLOCKS_SQL} AS blocks,
            (SELECT r.measure FROM challenge_scoring_rules r
              WHERE r.enabled
                AND (r.challenge_id = c.id OR r.challenge_template_id = c.challenge_template_id)
              ORDER BY (r.challenge_id IS NOT NULL) DESC, r.id ASC LIMIT 1) AS measure,
            viewer.gate, viewer.tour_done, viewer.unlocked
       FROM challenges c
       JOIN season_events se ON se.id = c.season_event_id
       JOIN challenge_templates ct ON ct.id = c.challenge_template_id
       -- Every credit on the template, this season's row or an earlier one:
       -- how many (the progress) and how many points (the card's "+500 pts").
       CROSS JOIN LATERAL (
         SELECT COUNT(*) AS activity_count, COALESCE(SUM(ua.points), 0) AS earned_points
           FROM user_activities ua
           JOIN challenges credited ON credited.id = ua.challenge_id
          WHERE ua.user_id = $1
            AND credited.challenge_template_id = c.challenge_template_id
       ) credit
       -- The viewer's gate, in the same read. No row for a signed-out viewer,
       -- so all three are NULL and nobody is gated. The gate needs the join
       -- screen answered as well as the flag: the card shows only after it
       -- (onboarding.js gettingStarted), and a gate with no card would hide
       -- the season behind a list nobody can see.
       LEFT JOIN (
         SELECT (u.getting_started_gate AND u.communities_onboarded_at IS NOT NULL) AS gate,
                (u.tour_done_at IS NOT NULL) AS tour_done,
                (u.getting_started_unlocked_at IS NOT NULL) AS unlocked
           FROM users u WHERE u.id = $1
       ) viewer ON TRUE
      WHERE ${scope} AND se.internal = FALSE
        AND UPPER(TRIM(ct.category)) = 'ONBOARDING'
      ORDER BY c.display_order ASC, c.id ASC`,
    [userId ?? null, seasonId ?? eventId]
  );
  const state = buildOnboarding(rows);
  if (state && state.opened && userId != null) await recordUnlocked(pool, userId);
  return state;
}

// The same value, for the callers that cannot correlate it: the challenge
// LISTS (routes/topochain/public.js and mobile.js) select their rows without
// a user parameter, and mobile's list can span a whole season, so the answer
// is per season event rather than per row. UNNEST gives the shared subquery
// exactly the one-column `c` it expects, so there is still one copy of it.
// Returns a Map of season_event_id -> blocks (null where the viewer has no
// snapshot on that event), and asks Postgres nothing for a signed-out viewer
// or a list with no block-production card on it.
async function loadEventBlocks(pool, userId, eventIds) {
  const ids = [...new Set((eventIds || []).map(Number).filter(Number.isFinite))];
  if (userId == null || !ids.length) return new Map();
  const { rows } = await pool.query(
    `/* challenge event blocks */
     SELECT c.season_event_id, ${NEWEST_EVENT_BLOCKS_SQL} AS blocks
       FROM UNNEST($2::bigint[]) AS c(season_event_id)`,
    [userId, ids]
  );
  return new Map(rows.map((r) => [Number(r.season_event_id),
    r.blocks == null ? null : Number(r.blocks)]));
}

function visibleChallenges(items, onboarding, idKey = 'id') {
  if (!isLocked(onboarding)) return items;
  const ids = new Set(onboarding.ids);
  return items.filter((c) => ids.has(Number(c[idKey])));
}

function challengeCategory(id, category, onboarding) {
  if (onboarding && String(category).trim().toUpperCase() === 'ONBOARDING') {
    return onboarding.ids.includes(Number(id)) ? 'ONBOARDING' : 'PERSISTENT';
  }
  return category;
}

module.exports = {
  ONBOARDING_LIMIT, NEWEST_EVENT_BLOCKS_SQL, resolveProgress, buildOnboarding,
  loadOnboarding, loadEventBlocks, visibleChallenges, challengeCategory,
  isLocked, gateSummary,
};
