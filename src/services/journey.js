'use strict';

// The admin Journey page's definitions (#3369, slice 1: the backend).
//
// One file holds every rule the page reads: who counts as a real person,
// what a week and a cohort are, when a group is active, how a visit is cut
// and when one looks lost. The queries live here too, as static SQL built
// only from the constants in this file, so `npm run lint:sql` checks every
// one of them against the real schema.
//
// Two conventions hold throughout:
//
//   * A fact that is not recorded is returned as `notRecorded(reason)`, never
//     as 0. The page prints "not recorded yet"; a zero would claim something.
//   * People are names and counts. Cohorts are one to four people, so no
//     endpoint returns a percentage.

const { NAV_SCREENS } = require('./ui-telemetry');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// A visit ends after this long with no telemetry of any kind from the person
// (a screen, an action or "hidden"). Same 30 minutes PostHog, Snowplow and
// Plausible use, and the telemetry client's own "returned" threshold.
const VISIT_GAP_MS = 30 * 60 * 1000;

// A newcomer is in their first 28 days with access.
const NEWCOMER_DAYS = 28;

// An active group: 2 to 6 real people in one project in one week.
const GROUP_MIN = 2;
const GROUP_MAX = 6;

// "Possibly lost": a visit that is fast, circling and ends with nothing.
// Named once, returned with every flag, tuned on the first cohorts. No
// published threshold exists for this combination; these are a start.
const LOST_CUTOFFS = Object.freeze({
  minSteps: 8,              // at least this many screens in the visit
  maxSecondsPerStep: 6,     // fast: on average no longer than this per screen
  minRepeatShare: 0.4,      // circling: 1 - (different screens / all screens)
  landingSeconds: 30,       // a landing: staying this long on one screen
});

// A next-step row with fewer moves than this is marked "few".
const FEW_MOVES = 10;

// Real people (#3369 rulings): not an admin (view-only admins included), not
// a bot, not restricted by moderation, not deleted, not a platform service
// account (the reserved name prefixes nobody else may take), and not on the
// admin-edited left-out list. Every query that names people uses this, with
// $3 = the reserved prefixes as LIKE patterns and $4 = the left-out ids.
const RESERVED_PATTERNS = Object.freeze(['usernode%', 'staging%', 'homeroom%']);
const REAL_PERSON_SQL = `u.is_admin IS NOT TRUE
  AND u.is_synthetic IS NOT TRUE
  AND u.participation_restricted_at IS NULL
  AND u.anonymised_at IS NULL
  AND NOT (LOWER(u.username) LIKE ANY($3::text[]))
  AND NOT (u.id = ANY($4::int[]))`;

function notRecorded(reason) {
  return { recorded: false, reason };
}

// ── Weeks ──────────────────────────────────────────────────────────────

/** Monday 00:00 UTC of the week holding `date`. */
function weekStart(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * The week a request asks for, as `{ start, end, label, finished }`. `raw` is
 * a YYYY-MM-DD Monday; anything else is refused (null). With no `raw`, the
 * last finished week: comparisons always use finished weeks, and the current
 * one is only ever shown as "so far".
 */
function parseWeek(raw, now = new Date()) {
  const current = weekStart(now);
  let start;
  if (raw == null || raw === '') {
    start = new Date(current.getTime() - WEEK_MS);
  } else {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    start = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || isoDay(start) !== raw) return null;
    if (start.getUTCDay() !== 1) return null;
    if (start.getTime() > current.getTime()) return null;
  }
  const end = new Date(start.getTime() + WEEK_MS);
  return {
    start,
    end,
    label: isoDay(start),
    finished: end.getTime() <= new Date(now).getTime(),
  };
}

// "All time": from before the platform's first record to now. Shaped like a
// week so the window readings take it unchanged; `all` tells the two that
// differ (Stay, and the trend) that it is not one.
const ALL_TIME_START = new Date('2020-01-01T00:00:00Z');

function allTime(now = new Date()) {
  return { start: ALL_TIME_START, end: new Date(now), label: 'all', finished: false, all: true };
}

/** The week before `week`. */
function previousWeek(week) {
  const start = new Date(week.start.getTime() - WEEK_MS);
  return { start, end: week.start, label: isoDay(start), finished: true };
}

/** An admit date as sent in a request: a real YYYY-MM-DD, or null. */
function parseDay(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || isoDay(d) !== raw ? null : raw;
}

// ── Groups ─────────────────────────────────────────────────────────────

/** Is a project's week an active group? `crossYes`: some change had a yes
 * from a real person other than its author. */
function isActiveGroup(memberCount, crossYes) {
  return crossYes === true && memberCount >= GROUP_MIN && memberCount <= GROUP_MAX;
}

/**
 * A group's place in the standard lifecycle, from three facts about the
 * project: active in the week, in the week before, and in any week before
 * that. Null when it is none of them (never active, or quiet two weeks).
 */
function groupLifecycle({ thisWeek, lastWeek, earlier }) {
  if (thisWeek && lastWeek) return 'still_active';
  if (thisWeek && earlier) return 'back';
  if (thisWeek) return 'new';
  if (lastWeek) return 'went_quiet';
  return null;
}

// ── Visits and paths ───────────────────────────────────────────────────

/**
 * Cut one person's telemetry rows into visits. `rows` are
 * `{ at: Date|string, kind, screen, via, appSlug }` in any order; they are
 * ordered by time, and a gap of VISIT_GAP_MS or more, or a screen reported
 * as "returned", starts a new visit. Each visit keeps only its navigation
 * steps (`steps`, with the time spent on each where known) plus its start and
 * end. Repeats of the same screen in a row are already dropped by the client.
 */
function splitVisits(rows, { gapMs = VISIT_GAP_MS } = {}) {
  const sorted = rows
    .map((r) => ({ ...r, t: new Date(r.at).getTime() }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t || (a.sequence || 0) - (b.sequence || 0));
  const visits = [];
  let current = null;
  let lastAt = null;
  const close = () => {
    if (!current) return;
    const steps = current.steps;
    for (let i = 0; i < steps.length; i += 1) {
      const next = i + 1 < steps.length ? steps[i + 1].t : current.hiddenAt || current.lastAt;
      steps[i].seconds = next != null && next >= steps[i].t ? Math.round((next - steps[i].t) / 1000) : null;
    }
    current.end = current.hiddenAt || current.lastAt;
    if (steps.length) visits.push(current);
    current = null;
  };
  for (const r of sorted) {
    const isStep = r.kind === 'screen_visit' && NAV_SCREENS.has(r.screen);
    const returned = isStep && r.via === 'returned';
    if (!current || (lastAt != null && r.t - lastAt >= gapMs) || returned) {
      close();
      current = { start: r.t, steps: [], hiddenAt: null, lastAt: r.t, acted: false };
    }
    if (isStep) {
      current.steps.push({ screen: r.screen, appSlug: r.appSlug || null, via: r.via || null, t: r.t });
      current.hiddenAt = null;
    } else if (r.kind === 'screen_hidden') {
      current.hiddenAt = r.t;
    } else if (r.kind === 'action_outcome' && r.outcome === 'success') {
      // Something worked: a landing. A failed or abandoned attempt is not.
      current.acted = true;
    }
    current.lastAt = r.t;
    lastAt = r.t;
  }
  close();
  return visits;
}

/**
 * Flag a visit that is fast, circling and ends with nothing. Returns the
 * readings and the cut-offs used, so the page can say why. `acted` comes from
 * the visit (an action in the telemetry) or from the caller, who knows about
 * acts the telemetry does not see (a message, a vote).
 */
function lostReading(visit, { acted = false, cutoffs = LOST_CUTOFFS } = {}) {
  const steps = visit.steps || [];
  const n = steps.length;
  const distinct = new Set(steps.map((s) => `${s.screen}:${s.appSlug || ''}`)).size;
  const span = n ? Math.max(0, ((visit.end || steps[n - 1].t) - steps[0].t) / 1000) : 0;
  const secondsPerStep = n ? span / n : null;
  const repeatShare = n ? 1 - distinct / n : 0;
  const landed = steps.some((s) => s.seconds != null && s.seconds >= cutoffs.landingSeconds)
    || visit.acted === true || acted === true;
  const fast = n >= cutoffs.minSteps && secondsPerStep != null && secondsPerStep <= cutoffs.maxSecondsPerStep;
  const circling = n >= cutoffs.minSteps && repeatShare >= cutoffs.minRepeatShare;
  return {
    possiblyLost: fast && circling && !landed,
    steps: n,
    distinct,
    seconds: Math.round(span),
    secondsPerStep: secondsPerStep == null ? null : Math.round(secondsPerStep * 10) / 10,
    repeatShare: Math.round(repeatShare * 100) / 100,
    landed,
    cutoffs,
  };
}

/**
 * Next-step counts over a set of visits: for each screen, the moves away from
 * it, how many people made them, the top three next screens, "Other" for the
 * rest, and "Left" (the visit ended there) always. `visitsByPerson` is a Map
 * of person id → visits. Rows are flagged when Left or Back is the most
 * common next step, and marked "few" under FEW_MOVES.
 */
function nextSteps(visitsByPerson, { top = 3 } = {}) {
  const rows = new Map();
  const entries = new Map();
  const bump = (map, key, person) => {
    const row = map.get(key) || { moves: 0, people: new Set() };
    row.moves += 1;
    row.people.add(person);
    map.set(key, row);
  };
  for (const [person, visits] of visitsByPerson) {
    for (const visit of visits) {
      const steps = visit.steps || [];
      if (!steps.length) continue;
      bump(entries, steps[0].screen, person);
      for (let i = 0; i < steps.length; i += 1) {
        const from = steps[i].screen;
        const nextStep = steps[i + 1];
        const to = !nextStep ? 'left' : (nextStep.via === 'back' ? 'back' : nextStep.screen);
        const row = rows.get(from) || { moves: 0, people: new Set(), next: new Map() };
        row.moves += 1;
        row.people.add(person);
        bump(row.next, to, person);
        rows.set(from, row);
      }
    }
  }
  const out = [];
  for (const [screen, row] of rows) {
    const ranked = [...row.next.entries()]
      .filter(([to]) => to !== 'left')
      .sort((a, b) => b[1].moves - a[1].moves || a[0].localeCompare(b[0]));
    const shown = ranked.slice(0, top).map(([to, v]) => ({ to, moves: v.moves, people: v.people.size }));
    const rest = ranked.slice(top).reduce((sum, [, v]) => sum + v.moves, 0);
    const left = row.next.get('left');
    const leftMoves = left ? left.moves : 0;
    const mostCommon = [...row.next.entries()].sort((a, b) => b[1].moves - a[1].moves)[0];
    out.push({
      screen,
      moves: row.moves,
      people: row.people.size,
      next: shown,
      other: rest,
      left: { moves: leftMoves, people: left ? left.people.size : 0 },
      deadEnd: !!mostCommon && (mostCommon[0] === 'left' || mostCommon[0] === 'back'),
      few: row.moves < FEW_MOVES,
    });
  }
  out.sort((a, b) => b.moves - a.moves || a.screen.localeCompare(b.screen));
  const starts = [...entries.entries()]
    .map(([screen, v]) => ({ screen, visits: v.moves, people: v.people.size }))
    .sort((a, b) => b.visits - a.visits || a.screen.localeCompare(b.screen));
  return { rows: out, starts };
}

// ── First mile ─────────────────────────────────────────────────────────
//
// Every admit date is a cohort, however small. A person is counted once, at
// their earliest admit; a member who already had access before that admit is
// not a newcomer and stays in Earlier members. Admitted addresses with no
// account yet are rows too: the waitlist row is all there is of them.
//
// Parameters, fixed for every first-mile query: $1 the admit day or the
// newcomer window, $2 now, $3 the reserved name patterns, $4 the left-out ids.

const ADMITTED_CTE = `admitted AS (
    SELECT DISTINCT ON (COALESCE('u' || w.linked_user_id::text, 'w' || w.id::text))
           w.id AS signup_id, w.email, w.released_at, w.linked_user_id
      FROM waitlist_signups w
     WHERE w.released_at IS NOT NULL
     ORDER BY COALESCE('u' || w.linked_user_id::text, 'w' || w.id::text), w.released_at, w.id
  )`;

const NEWCOMER_OR_NO_ACCOUNT = `(u.id IS NULL OR (
      (u.platform_access_granted_at IS NULL OR u.platform_access_granted_at >= a.released_at)
      AND ${REAL_PERSON_SQL}))`;

const COHORTS_SQL = `WITH ${ADMITTED_CTE}
  SELECT to_char((a.released_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
         COUNT(*)::int AS admitted,
         COUNT(u.id)::int AS with_account
    FROM admitted a
    LEFT JOIN users u ON u.id = a.linked_user_id
   WHERE a.released_at <= $2::timestamptz
     AND ($1::text IS NULL OR to_char((a.released_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') = $1::text)
     AND ${NEWCOMER_OR_NO_ACCOUNT}
   GROUP BY 1
   ORDER BY 1 DESC`;

// The facts of one person's first mile, read from the records that already
// exist (#3369 first-mile survey): the admit mail and the first login code in
// the mail log (kept 30 days), the account's own columns, the first time the
// shell was opened (the #general membership row or the first boot in UI
// telemetry), the first-run sheets as they were shown (telemetry), the
// welcome message's queue row, the earliest act of any kind, and the failed
// attempts the telemetry saw.
const PERSON_FACTS = `
    m.status AS mail_status, m.error AS mail_error, m.created_at AS mail_at,
    (SELECT MIN(d.created_at) FROM mail_deliveries d
      WHERE d.recipient = a.email AND d.kind = 'otp' AND d.created_at >= a.released_at) AS code_asked_at,
    u.id AS user_id, u.username, u.created_at AS account_at, u.password_set,
    u.has_platform_access, u.platform_access_granted_at AS access_at,
    u.needs_username_choice, u.needs_communities_choice, u.communities_onboarded_at,
    u.tour_done_at, u.getting_started_seen,
    LEAST(
      (SELECT MIN(cm.joined_at) FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id
        WHERE c.kind = 'channel' AND cm.user_id = u.id),
      (SELECT MIN(e.created_at) FROM events e
        WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
          AND e.metadata->>'kind' = 'screen_visit')
    ) AS opened_at,
    (SELECT MIN(e.created_at) FROM events e WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
        AND e.metadata->>'kind' = 'screen_visit' AND e.metadata->>'screen' = 'username_sheet') AS username_shown_at,
    (SELECT MIN(e.created_at) FROM events e WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
        AND e.metadata->>'kind' = 'screen_visit' AND e.metadata->>'screen' = 'join_sheet') AS join_shown_at,
    (SELECT MIN(e.created_at) FROM events e WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
        AND e.metadata->>'kind' = 'screen_visit') AS first_screen_at,
    q.status AS welcome_status, q.processed_at AS welcome_at,
    (SELECT MIN(cmsg.created_at) FROM conversation_messages cmsg
      WHERE q.conversation_id IS NOT NULL AND cmsg.conversation_id = q.conversation_id
        AND cmsg.sender_id = u.id AND cmsg.deleted_at IS NULL) AS welcome_reply_at,
    fa.at AS first_act_at, fa.kind AS first_act_kind,
    (SELECT COUNT(*)::int FROM events e WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
        AND (e.metadata->>'kind' IN ('loading_timeout', 'navigation_abandonment', 'boot_failure', 'server_failure')
          OR (e.metadata->>'kind' = 'action_outcome' AND e.metadata->>'outcome' = 'failure'))) AS failed_attempts,
    (SELECT COUNT(*)::int FROM events e WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
        AND e.metadata->>'kind' = 'repeated_action') AS repeated_taps`;

const PERSON_JOINS = `
    LEFT JOIN LATERAL (
      SELECT d.status, d.error, d.created_at FROM mail_deliveries d
       WHERE a.email IS NOT NULL AND d.recipient = a.email AND d.kind = 'waitlist_released'
       ORDER BY d.created_at DESC, d.id DESC LIMIT 1
    ) m ON TRUE
    LEFT JOIN welcome_dm_queue q ON q.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT x.at, x.kind FROM (
        SELECT MIN(cmx.created_at) AS at, 'message' AS kind FROM chat_messages cmx
         WHERE cmx.user_id = u.id AND cmx.msg_type = 'message' AND cmx.deleted_at IS NULL
        UNION ALL SELECT MIN(cvx.created_at), 'message' FROM conversation_messages cvx
         WHERE cvx.sender_id = u.id AND cvx.deleted_at IS NULL
        UNION ALL SELECT MIN(pv.created_at), 'vote' FROM pr_votes pv WHERE pv.user_id = u.id
        UNION ALL SELECT MIN(iv.created_at), 'vote' FROM issue_votes iv WHERE iv.user_id = u.id
        UNION ALL SELECT MIN(fr.created_at), 'feedback' FROM feedback_reports fr WHERE fr.user_id = u.id
        UNION ALL SELECT MIN(i.created_at), 'request' FROM issues i WHERE i.created_by = u.id
        UNION ALL SELECT MIN(cs.created_at), 'change' FROM chat_sessions cs WHERE cs.user_id = u.id
        UNION ALL SELECT MIN(aa.date)::timestamptz, 'app' FROM app_activity aa WHERE aa.user_id = u.id
        UNION ALL SELECT MIN(cmb.joined_at), 'joined' FROM community_members cmb
         WHERE cmb.user_id = u.id AND cmb.source = 'joined'
      ) x WHERE x.at IS NOT NULL ORDER BY x.at LIMIT 1
    ) fa ON TRUE`;

const FIRST_MILE_ADMITTED_SQL = `WITH ${ADMITTED_CTE}
  SELECT a.signup_id, a.email, a.released_at, ${PERSON_FACTS}
    FROM admitted a
    LEFT JOIN users u ON u.id = a.linked_user_id
    ${PERSON_JOINS}
   WHERE to_char((a.released_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') = $1::text
     AND a.released_at <= $2::timestamptz
     AND ${NEWCOMER_OR_NO_ACCOUNT}
   ORDER BY a.released_at, a.signup_id`;

// People who got access in the newcomer window ($1 days before $2) with no
// admit of their own: a member's invite link, an activation code, a wallet,
// a direct grant. Their first mile starts at the account.
const FIRST_MILE_OTHER_WAY_SQL = `WITH ${ADMITTED_CTE}
  SELECT NULL::bigint AS signup_id, NULL::text AS email, NULL::timestamptz AS released_at,
         CASE WHEN u.admitted_by IS NOT NULL THEN 'invite_link' ELSE 'code_wallet_or_grant' END AS door,
         ${PERSON_FACTS}
    FROM users u
    LEFT JOIN admitted a ON FALSE
    ${PERSON_JOINS}
   WHERE u.has_platform_access
     AND u.platform_access_granted_at >= $2::timestamptz - make_interval(days => $1::int)
     AND u.platform_access_granted_at <= $2::timestamptz
     AND NOT EXISTS (
       SELECT 1 FROM waitlist_signups w
        WHERE w.linked_user_id = u.id AND w.released_at IS NOT NULL
          AND w.released_at <= u.platform_access_granted_at)
     AND ${REAL_PERSON_SQL}
   ORDER BY u.platform_access_granted_at, u.id`;

const MAIL_PROOF_DAYS = 30;

const FIRST_MILE_STEPS = Object.freeze([
  'admitted', 'mail_sent', 'code_asked', 'account', 'access', 'opened', 'username', 'join', 'first_act',
]);

/**
 * One person's first mile, step by step, from the facts row. Each step is
 * done (with its time where one exists), or, when a later step is done,
 * skipped (no record of it; the person is past it anyway) or unknown (its
 * proof has expired). The person sits at their furthest step; the first step
 * after it that is not done is where they are stuck, with the reason.
 */
function firstMileSteps(row, now = new Date()) {
  const t = (v) => (v ? new Date(v) : null);
  const nowMs = new Date(now).getTime();
  const admitted = t(row.released_at);
  const mailExpired = admitted && nowMs - admitted.getTime() > MAIL_PROOF_DAYS * DAY_MS;
  const hasAccount = row.user_id != null;
  const seen = row.getting_started_seen && typeof row.getting_started_seen === 'object' ? row.getting_started_seen : {};
  const facts = {
    admitted: admitted ? { done: true, at: admitted } : null,
    mail_sent: row.mail_status === 'sent'
      ? { done: true, at: t(row.mail_at) }
      : { done: false, stuck: row.mail_status ? `Mail not sent: ${row.mail_status}` : 'No admit mail on record',
        expired: mailExpired && !row.mail_status },
    code_asked: row.code_asked_at
      ? { done: true, at: t(row.code_asked_at) }
      : { done: false, stuck: 'Admitted, never asked for a login code', expired: mailExpired },
    account: hasAccount && row.password_set !== false
      ? { done: true, at: t(row.account_at) }
      : { done: false, stuck: hasAccount ? 'Account started, not finished' : 'Code mailed, no account' },
    access: row.has_platform_access ? { done: true, at: t(row.access_at) }
      : { done: false, stuck: 'In the waiting room' },
    opened: row.opened_at ? { done: true, at: t(row.opened_at) }
      : { done: false, stuck: 'Has access, never opened Homeroom' },
    // A flag with no time can be set before the person was ever inside (the
    // password step chooses one too), so it is done but never moves the
    // furthest step: `weak`.
    username: hasAccount && row.needs_username_choice === false
      ? { done: true, at: null, weak: true }
      : { done: false, stuck: row.username_shown_at ? 'Username sheet shown, not answered' : 'Username not chosen' },
    join: row.communities_onboarded_at
      ? { done: true, at: t(row.communities_onboarded_at), note: seen.join_answer || null }
      : (hasAccount && row.needs_communities_choice === false
        ? { done: true, at: null, note: 'not asked', weak: true }
        : { done: false, stuck: row.join_shown_at ? 'Join screen shown, not answered' : 'Join screen not answered' }),
    first_act: row.first_act_at ? { done: true, at: t(row.first_act_at), note: row.first_act_kind }
      : { done: false, stuck: 'Inside, no act yet' },
  };
  // Nobody is inside without a finished account: a started one has never
  // signed in, so the defaults on its row (no username to choose, no join
  // screen owed) say nothing about the steps after it.
  if (!facts.account.done) {
    for (const key of ['access', 'opened', 'username', 'join', 'first_act']) {
      if (facts[key].done) facts[key] = { done: false, stuck: facts[key].stuck || null };
    }
  }
  const order = admitted ? FIRST_MILE_STEPS : FIRST_MILE_STEPS.slice(FIRST_MILE_STEPS.indexOf('account'));
  let furthest = -1;
  order.forEach((key, i) => { if (facts[key] && facts[key].done && !facts[key].weak) furthest = i; });
  let stuckAt = null;
  const steps = order.map((key, i) => {
    const f = facts[key];
    if (f.done) return { key, state: 'done', at: f.at || null, note: f.note || null };
    // (A weak "done" above can sit after the stuck step: shown as done, it
    // does not hide where the person stopped.)
    if (i < furthest) return { key, state: f.expired ? 'unknown' : 'skipped', at: null, note: null };
    if (stuckAt == null) {
      stuckAt = key;
      return { key, state: 'stuck', at: null, note: f.expired ? 'Proof older than 30 days' : f.stuck };
    }
    return { key, state: 'not_yet', at: null, note: null };
  });
  const since = admitted || t(row.access_at);
  return {
    steps,
    furthest: furthest >= 0 ? order[furthest] : null,
    stuckAt,
    stuckReason: stuckAt ? steps.find((s) => s.key === stuckAt).note : null,
    daysSince: since ? Math.floor((nowMs - since.getTime()) / DAY_MS) : null,
    failedAttempts: row.failed_attempts || 0,
    repeatedTaps: row.repeated_taps || 0,
    tour: row.tour_done_at ? { ended: seen.tour_ended || null, step: seen.tour_step ?? null, at: t(row.tour_done_at) } : null,
    welcome: row.welcome_status ? { status: row.welcome_status, at: t(row.welcome_at), replied: !!row.welcome_reply_at } : null,
  };
}

function firstMilePerson(row, now) {
  const mile = firstMileSteps(row, now);
  return {
    signupId: row.signup_id != null ? Number(row.signup_id) : null,
    userId: row.user_id != null ? Number(row.user_id) : null,
    // A person with no account is known only by the address they joined
    // with, which Admin › Waitlist already shows to admins.
    name: row.username || row.email || null,
    hasAccount: row.user_id != null,
    door: row.door || (row.released_at ? 'admitted' : null),
    ...mile,
  };
}

/** Counts per step: how many of the cohort are past it (done or skipped). */
function firstMileCounts(people) {
  const keys = people.length && people[0].steps ? people[0].steps.map((s) => s.key) : [];
  return keys.map((key) => ({
    key,
    passed: people.filter((p) => {
      const step = p.steps.find((s) => s.key === key);
      return step && (step.state === 'done' || step.state === 'skipped' || step.state === 'unknown');
    }).length,
    stuck: people.filter((p) => p.stuckAt === key).map((p) => ({
      userId: p.userId, signupId: p.signupId, name: p.name, days: p.daysSince, reason: p.stuckReason,
      failedAttempts: p.failedAttempts,
    })),
  }));
}

function realPersonParams(leftOutIds) {
  return [[...RESERVED_PATTERNS], (leftOutIds || []).map(Number)];
}

/** The admit-date cohorts, newest first, with "Came in another way". */
async function cohorts(pool, { now = new Date(), leftOutIds = [] } = {}) {
  const { rows } = await pool.query(COHORTS_SQL, [null, now, ...realPersonParams(leftOutIds)]);
  const other = await pool.query(FIRST_MILE_OTHER_WAY_SQL, [NEWCOMER_DAYS, now, ...realPersonParams(leftOutIds)]);
  return {
    cohorts: rows.map((r) => ({ day: r.day, admitted: r.admitted, withAccount: r.with_account })),
    otherWay: { people: other.rows.length },
  };
}

/** One cohort's first mile: `day` is an admit day, or 'other_way'. */
async function firstMile(pool, { day, now = new Date(), leftOutIds = [] } = {}) {
  const params = realPersonParams(leftOutIds);
  const result = day === 'other_way'
    ? await pool.query(FIRST_MILE_OTHER_WAY_SQL, [NEWCOMER_DAYS, now, ...params])
    : await pool.query(FIRST_MILE_ADMITTED_SQL, [day, now, ...params]);
  const people = result.rows.map((row) => firstMilePerson(row, now));
  return {
    cohort: day,
    people,
    steps: firstMileCounts(people),
    notRecorded: {
      followedLink: notRecorded('Nothing records the admit mail being opened or its link followed.'),
    },
  };
}

// ── Stages, per week ───────────────────────────────────────────────────
//
// One yes or no per real person for the week [$1, $2); Stay also reads the
// week after, [$2, $5). $3 and $4 are the real-person parameters. Every
// source is bounded by the week, so the scan is a fortnight at most, except
// "came back to", which looks for an earlier day with the same app.

// Did anything we record in [from, to). Written out twice (this week and the
// next) so both stay static SQL.
const ARRIVE_THIS_WEEK = `
    SELECT aa.user_id FROM app_activity aa
     WHERE aa.date >= ($1::timestamptz AT TIME ZONE 'UTC')::date AND aa.date < ($2::timestamptz AT TIME ZONE 'UTC')::date
    UNION SELECT cmx.user_id FROM chat_messages cmx
     WHERE cmx.created_at >= $1::timestamptz AND cmx.created_at < $2::timestamptz AND cmx.user_id IS NOT NULL
    UNION SELECT cvx.sender_id FROM conversation_messages cvx
     WHERE cvx.created_at >= $1::timestamptz AND cvx.created_at < $2::timestamptz
    UNION SELECT csx.user_id FROM chat_session_messages smx JOIN chat_sessions csx ON csx.id = smx.session_id
     WHERE smx.role = 'user' AND smx.created_at >= $1::timestamptz AND smx.created_at < $2::timestamptz
    UNION SELECT pvx.user_id FROM pr_votes pvx WHERE pvx.created_at >= $1::timestamptz AND pvx.created_at < $2::timestamptz
    UNION SELECT ivx.user_id FROM issue_votes ivx WHERE ivx.created_at >= $1::timestamptz AND ivx.created_at < $2::timestamptz
    UNION SELECT frx.user_id FROM feedback_reports frx WHERE frx.created_at >= $1::timestamptz AND frx.created_at < $2::timestamptz
    UNION SELECT ex.user_id FROM events ex
     WHERE ex.event_type = 'ui_experience' AND ex.created_at >= $1::timestamptz AND ex.created_at < $2::timestamptz`;

const ARRIVE_NEXT_WEEK = `
    SELECT aa.user_id FROM app_activity aa
     WHERE aa.date >= ($2::timestamptz AT TIME ZONE 'UTC')::date AND aa.date < ($5::timestamptz AT TIME ZONE 'UTC')::date
    UNION SELECT cmx.user_id FROM chat_messages cmx
     WHERE cmx.created_at >= $2::timestamptz AND cmx.created_at < $5::timestamptz AND cmx.user_id IS NOT NULL
    UNION SELECT cvx.sender_id FROM conversation_messages cvx
     WHERE cvx.created_at >= $2::timestamptz AND cvx.created_at < $5::timestamptz
    UNION SELECT csx.user_id FROM chat_session_messages smx JOIN chat_sessions csx ON csx.id = smx.session_id
     WHERE smx.role = 'user' AND smx.created_at >= $2::timestamptz AND smx.created_at < $5::timestamptz
    UNION SELECT pvx.user_id FROM pr_votes pvx WHERE pvx.created_at >= $2::timestamptz AND pvx.created_at < $5::timestamptz
    UNION SELECT ivx.user_id FROM issue_votes ivx WHERE ivx.created_at >= $2::timestamptz AND ivx.created_at < $5::timestamptz
    UNION SELECT frx.user_id FROM feedback_reports frx WHERE frx.created_at >= $2::timestamptz AND frx.created_at < $5::timestamptz
    UNION SELECT ex.user_id FROM events ex
     WHERE ex.event_type = 'ui_experience' AND ex.created_at >= $2::timestamptz AND ex.created_at < $5::timestamptz`;

// A change that counts as "made a change": the person's own, with a pull
// request, and not one of the one-click or automatic kinds (maintenance,
// a clone, a rename proposal).
const OWN_CHANGE = `cs.pr_number IS NOT NULL
      AND cs.source IS DISTINCT FROM 'maintenance'
      AND cs.cloned_from_session_id IS NULL
      AND COALESCE(cs.branch_name, '') NOT LIKE 'rename/%'`;

const STAGES_SQL = `WITH real AS (
    SELECT u.id, u.username FROM users u WHERE ${REAL_PERSON_SQL}
  ), arrive AS (${ARRIVE_THIS_WEEK}
  ), arrive_next AS (${ARRIVE_NEXT_WEEK}
  ), found AS (
    SELECT f.user_id FROM (
      SELECT aa.user_id, aa.app_id, MIN(aa.date) AS first_day FROM app_activity aa GROUP BY aa.user_id, aa.app_id
    ) f JOIN apps ap ON ap.id = f.app_id
     WHERE f.first_day >= ($1::timestamptz AT TIME ZONE 'UTC')::date
       AND f.first_day < ($2::timestamptz AT TIME ZONE 'UTC')::date
       AND ap.created_by IS DISTINCT FROM f.user_id
       AND EXISTS (SELECT 1 FROM app_activity a2 WHERE a2.user_id = f.user_id AND a2.app_id = f.app_id
                     AND a2.date = f.first_day AND a2.seconds_spent >= 30)
  ), came_back AS (
    SELECT aa.user_id FROM app_activity aa
     WHERE aa.date >= ($1::timestamptz AT TIME ZONE 'UTC')::date AND aa.date < ($2::timestamptz AT TIME ZONE 'UTC')::date
       AND EXISTS (SELECT 1 FROM app_activity a2 WHERE a2.user_id = aa.user_id AND a2.app_id = aa.app_id AND a2.date < aa.date)
    UNION SELECT cmx.user_id FROM chat_messages cmx
     WHERE cmx.created_at >= $1::timestamptz AND cmx.created_at < $2::timestamptz AND cmx.msg_type = 'message'
       AND EXISTS (SELECT 1 FROM chat_messages c2 WHERE c2.user_id = cmx.user_id AND c2.app_id = cmx.app_id
                     AND c2.msg_type = 'message'
                     AND (c2.created_at AT TIME ZONE 'UTC')::date < (cmx.created_at AT TIME ZONE 'UTC')::date)
  ), activate AS (
    SELECT frx.user_id, 'feedback' AS kind FROM feedback_reports frx
     WHERE frx.created_at >= $1::timestamptz AND frx.created_at < $2::timestamptz
    UNION SELECT i.created_by, 'feedback' FROM issues i
     WHERE i.created_at >= $1::timestamptz AND i.created_at < $2::timestamptz AND i.created_by IS NOT NULL
    UNION SELECT pvx.user_id, 'vote' FROM pr_votes pvx WHERE pvx.created_at >= $1::timestamptz AND pvx.created_at < $2::timestamptz
    UNION SELECT ivx.user_id, 'vote' FROM issue_votes ivx WHERE ivx.created_at >= $1::timestamptz AND ivx.created_at < $2::timestamptz
    UNION SELECT cs.user_id, 'change' FROM chat_sessions cs
     WHERE cs.created_at >= $1::timestamptz AND cs.created_at < $2::timestamptz AND ${OWN_CHANGE}
  ), belong AS (
    SELECT pvx.user_id FROM pr_votes pvx JOIN chat_sessions cs ON cs.id = pvx.session_id JOIN real ra ON ra.id = cs.user_id
     WHERE pvx.created_at >= $1::timestamptz AND pvx.created_at < $2::timestamptz AND pvx.user_id <> cs.user_id
       AND COALESCE(cs.branch_name, '') NOT LIKE 'rename/%'
    UNION SELECT k.giver_user_id FROM pr_kudos k JOIN chat_sessions cs ON cs.id = k.session_id JOIN real ra ON ra.id = cs.user_id
     WHERE k.created_at >= $1::timestamptz AND k.created_at < $2::timestamptz AND k.giver_user_id <> cs.user_id
    UNION SELECT cmx.user_id FROM chat_messages cmx JOIN chat_sessions cs ON cmx.thread_type = 'session' AND cmx.thread_ref = cs.id
      JOIN real ra ON ra.id = cs.user_id
     WHERE cmx.created_at >= $1::timestamptz AND cmx.created_at < $2::timestamptz AND cmx.msg_type = 'message'
       AND cmx.user_id <> cs.user_id
  ), used AS (
    SELECT cs.user_id FROM chat_sessions cs
     WHERE cs.status = 'merged' AND cs.merged_at >= $1::timestamptz AND cs.merged_at < $2::timestamptz
       AND EXISTS (SELECT 1 FROM pr_votes pvx JOIN real ry ON ry.id = pvx.user_id
                    WHERE pvx.session_id = cs.id AND pvx.vote = 'yes' AND pvx.user_id <> cs.user_id
                      AND pvx.approval_epoch = cs.approval_epoch)
  ), invited AS (
    SELECT inv.admitted_by AS user_id FROM users inv JOIN real ri ON ri.id = inv.id
     WHERE inv.admitted_by IS NOT NULL AND inv.id IN (SELECT user_id FROM arrive)
  )
  SELECT r.id AS user_id, r.username,
         r.id IN (SELECT user_id FROM arrive) AS arrive,
         (r.id IN (SELECT user_id FROM found) OR r.id IN (SELECT user_id FROM came_back)) AS explore,
         r.id IN (SELECT user_id FROM activate) AS activate,
         ARRAY(SELECT DISTINCT ak.kind FROM activate ak WHERE ak.user_id = r.id ORDER BY ak.kind) AS activate_kinds,
         r.id IN (SELECT user_id FROM belong) AS belong,
         r.id IN (SELECT user_id FROM used) AS use,
         r.id IN (SELECT user_id FROM arrive_next) AS arrive_next,
         r.id IN (SELECT user_id FROM invited) AS invite
    FROM real r
   WHERE r.id IN (SELECT user_id FROM arrive)
      OR r.id IN (SELECT user_id FROM activate)
      OR r.id IN (SELECT user_id FROM used)
      OR r.id IN (SELECT user_id FROM invited)
   ORDER BY r.username`;

const STAGES = Object.freeze(['arrive', 'explore', 'activate', 'belong', 'use', 'stay', 'invite']);

// Stay over all time: the people in $1 who arrived in two weeks in a row at
// any point, from the same records as ARRIVE_THIS_WEEK.
const STAY_EVER_SQL = `WITH a AS (
    SELECT aa.user_id, date_trunc('week', aa.date::timestamp) AS wk FROM app_activity aa WHERE aa.user_id = ANY($1::int[])
    UNION SELECT cmx.user_id, date_trunc('week', cmx.created_at AT TIME ZONE 'UTC') FROM chat_messages cmx
     WHERE cmx.user_id = ANY($1::int[])
    UNION SELECT cvx.sender_id, date_trunc('week', cvx.created_at AT TIME ZONE 'UTC') FROM conversation_messages cvx
     WHERE cvx.sender_id = ANY($1::int[])
    UNION SELECT csx.user_id, date_trunc('week', smx.created_at AT TIME ZONE 'UTC')
      FROM chat_session_messages smx JOIN chat_sessions csx ON csx.id = smx.session_id
     WHERE smx.role = 'user' AND csx.user_id = ANY($1::int[])
    UNION SELECT pvx.user_id, date_trunc('week', pvx.created_at AT TIME ZONE 'UTC') FROM pr_votes pvx WHERE pvx.user_id = ANY($1::int[])
    UNION SELECT ivx.user_id, date_trunc('week', ivx.created_at AT TIME ZONE 'UTC') FROM issue_votes ivx WHERE ivx.user_id = ANY($1::int[])
    UNION SELECT frx.user_id, date_trunc('week', frx.created_at AT TIME ZONE 'UTC') FROM feedback_reports frx
     WHERE frx.user_id = ANY($1::int[])
    UNION SELECT ex.user_id, date_trunc('week', ex.created_at AT TIME ZONE 'UTC') FROM events ex
     WHERE ex.event_type = 'ui_experience' AND ex.user_id = ANY($1::int[])
  )
  SELECT DISTINCT a1.user_id FROM a a1 JOIN a a2 ON a2.user_id = a1.user_id AND a2.wk = a1.wk + INTERVAL '7 days'`;

/**
 * The week's stages. Stay needs the following week to have ended: until it
 * has, it is notRecorded ("known next Monday"), never a count.
 */
async function stages(pool, { week, now = new Date(), leftOutIds = [], memberIds = null } = {}) {
  // All time: each stage is "ever", and Stay is "arrived two weeks in a row,
  // at any time", read from STAY_EVER_SQL.
  const nextEnd = week.all ? new Date(week.end) : new Date(week.end.getTime() + WEEK_MS);
  const stayKnown = week.all || nextEnd.getTime() <= new Date(now).getTime();
  const { rows: all } = await pool.query(STAGES_SQL,
    [week.start, week.end, ...realPersonParams(leftOutIds), nextEnd]);
  const rows = memberIds ? all.filter((r) => memberIds.has(Number(r.user_id))) : all;
  const stayedEver = week.all && rows.length
    ? new Set((await pool.query(STAY_EVER_SQL, [rows.map((r) => Number(r.user_id))])).rows.map((r) => Number(r.user_id)))
    : null;
  const people = rows.map((r) => {
    const stay = stayedEver ? stayedEver.has(Number(r.user_id)) : (r.arrive && r.arrive_next);
    const flags = {
      arrive: r.arrive, explore: r.explore, activate: r.activate, belong: r.belong,
      use: r.use, stay: stayKnown ? stay : null, invite: r.invite,
    };
    // Where they stopped: the furthest stage reached this week, in order.
    let furthest = null;
    for (const key of STAGES) if (flags[key]) furthest = key;
    return { userId: Number(r.user_id), name: r.username, ...flags, activateKinds: r.activate_kinds || [], stoppedAt: furthest };
  });
  const counts = {};
  for (const key of STAGES) {
    counts[key] = key === 'stay' && !stayKnown
      ? notRecorded('Known once the following week has ended.')
      : people.filter((p) => p[key]).length;
  }
  const stoppedAt = {};
  for (const key of STAGES) {
    stoppedAt[key] = people.filter((p) => p.stoppedAt === key).map((p) => ({ userId: p.userId, name: p.name }));
  }
  return { week: week.label, finished: week.finished, counts, stoppedAt, people };
}

// ── Active groups ──────────────────────────────────────────────────────
//
// Every change that went live, with its project, its real author and the
// real people other than the author who said yes to the revision that
// merged. Merged changes number in the low thousands in total, so the weeks
// are bucketed here rather than in SQL. $1 is unused padding kept for the
// shared parameter layout: the end of the window, $2 now, $3/$4 real people.
const LIVE_CHANGES_SQL = `SELECT cs.id, cs.app_id, ap.slug, ap.name, ap.self_hosted,
         cs.merged_at, cs.user_id AS author_id, u.username AS author,
         ARRAY(SELECT pvx.user_id FROM pr_votes pvx JOIN users uy ON uy.id = pvx.user_id
                WHERE pvx.session_id = cs.id AND pvx.vote = 'yes' AND pvx.user_id <> cs.user_id
                  AND pvx.approval_epoch = cs.approval_epoch
                  AND uy.is_admin IS NOT TRUE AND uy.is_synthetic IS NOT TRUE
                  AND uy.participation_restricted_at IS NULL AND uy.anonymised_at IS NULL
                  AND NOT (LOWER(uy.username) LIKE ANY($3::text[]))
                  AND NOT (uy.id = ANY($4::int[]))
                ORDER BY pvx.user_id) AS yes_ids,
         ARRAY(SELECT uy.username FROM pr_votes pvx JOIN users uy ON uy.id = pvx.user_id
                WHERE pvx.session_id = cs.id AND pvx.vote = 'yes' AND pvx.user_id <> cs.user_id
                  AND pvx.approval_epoch = cs.approval_epoch
                  AND uy.is_admin IS NOT TRUE AND uy.is_synthetic IS NOT TRUE
                  AND uy.participation_restricted_at IS NULL AND uy.anonymised_at IS NULL
                  AND NOT (LOWER(uy.username) LIKE ANY($3::text[]))
                  AND NOT (uy.id = ANY($4::int[]))
                ORDER BY pvx.user_id) AS yes_names
    FROM chat_sessions cs
    JOIN apps ap ON ap.id = cs.app_id
    JOIN users u ON u.id = cs.user_id
   WHERE cs.status = 'merged' AND cs.merged_at IS NOT NULL
     AND cs.merged_at < $1::timestamptz AND cs.merged_at <= $2::timestamptz
     AND ${REAL_PERSON_SQL}`;

// Changes put to the group and still waiting, with no yes yet from another
// real person: the other half of "groups one short".
const WAITING_SQL = `SELECT cs.id, ap.slug, ap.name, cs.user_id AS author_id, u.username AS author, cs.promoted_at
    FROM chat_sessions cs
    JOIN apps ap ON ap.id = cs.app_id
    JOIN users u ON u.id = cs.user_id
   WHERE cs.status IN ('promoted', 'merging') AND COALESCE(ap.self_hosted, FALSE) = FALSE
     AND cs.promoted_at IS NOT NULL AND cs.promoted_at < $1::timestamptz AND cs.promoted_at <= $2::timestamptz
     AND ${REAL_PERSON_SQL}
     AND NOT EXISTS (SELECT 1 FROM pr_votes pvx JOIN users uy ON uy.id = pvx.user_id
                      WHERE pvx.session_id = cs.id AND pvx.vote = 'yes' AND pvx.user_id <> cs.user_id
                        AND pvx.approval_epoch = cs.approval_epoch
                        AND uy.is_admin IS NOT TRUE AND uy.is_synthetic IS NOT TRUE
                        AND uy.participation_restricted_at IS NULL AND uy.anonymised_at IS NULL
                        AND NOT (LOWER(uy.username) LIKE ANY($3::text[]))
                        AND NOT (uy.id = ANY($4::int[])))
   ORDER BY cs.promoted_at`;

// How many weeks of active-group counts come back with each week, oldest
// first and ending with that week: the trend beside the North Star. "All
// time" goes back to the first live change, two years at most.
const TREND_WEEKS = 8;
const TREND_WEEKS_MAX = 104;

/** Group the live changes of one week by project. */
function groupsForWeek(changes, week) {
  const byProject = new Map();
  for (const c of changes) {
    const at = new Date(c.merged_at).getTime();
    if (at < week.start.getTime() || at >= week.end.getTime()) continue;
    const g = byProject.get(c.slug) || {
      slug: c.slug, name: c.name, selfHosted: !!c.self_hosted, changes: 0, crossYes: false, members: new Map(),
    };
    g.changes += 1;
    g.members.set(Number(c.author_id), c.author);
    (c.yes_ids || []).forEach((id, i) => g.members.set(Number(id), (c.yes_names || [])[i]));
    if ((c.yes_ids || []).length) g.crossYes = true;
    byProject.set(c.slug, g);
  }
  return [...byProject.values()].map((g) => ({
    slug: g.slug,
    name: g.name,
    selfHosted: g.selfHosted,
    changes: g.changes,
    people: [...g.members.entries()].map(([userId, name]) => ({ userId, name })),
    active: !g.selfHosted && isActiveGroup(g.members.size, g.crossYes),
  }));
}

/**
 * Active groups for `week` with the standard lifecycle against the week
 * before and every earlier week; Homeroom's own project on a line of its own,
 * never counted; and the groups one short.
 */
async function activeGroups(pool, { week, now = new Date(), leftOutIds = [], memberIds = null, trendAll = false } = {}) {
  const params = [week.end, now, ...realPersonParams(leftOutIds)];
  const { rows: changes } = await pool.query(LIVE_CHANGES_SQL, params);
  // Narrowed to a cohort: only the groups one of its members was part of.
  const keep = (g) => !memberIds || g.people.some((p) => memberIds.has(Number(p.userId)));
  const weekGroups = (span) => groupsForWeek(changes, span).filter(keep);
  const before = previousWeek(week);
  const thisWeek = weekGroups(week);
  const lastWeek = new Set(weekGroups(before).filter((g) => g.active).map((g) => g.slug));
  // Every week before the one before: was the project an active group then?
  const earlierWeeks = new Map();
  for (const c of changes) {
    if (new Date(c.merged_at).getTime() >= before.start.getTime()) continue;
    const key = weekStart(c.merged_at).getTime();
    if (!earlierWeeks.has(key)) earlierWeeks.set(key, []);
    earlierWeeks.get(key).push(c);
  }
  const earlier = new Set();
  for (const [key, list] of earlierWeeks) {
    groupsForWeek(list, { start: new Date(key), end: new Date(key + WEEK_MS) })
      .filter((g) => g.active && keep(g)).forEach((g) => earlier.add(g.slug));
  }
  const active = thisWeek.filter((g) => g.active).map((g) => ({
    ...g, lifecycle: groupLifecycle({ thisWeek: true, lastWeek: lastWeek.has(g.slug), earlier: earlier.has(g.slug) }),
  }));
  const wentQuiet = [...lastWeek].filter((slug) => !active.some((g) => g.slug === slug))
    .map((slug) => {
      const g = weekGroups(before).find((x) => x.slug === slug);
      return { slug, name: g ? g.name : slug, people: g ? g.people : [], lifecycle: 'went_quiet' };
    });
  const homeroom = thisWeek.find((g) => g.selfHosted) || null;
  // The North Star over the weeks before, from the same rows: every live
  // change up to the end of `week` is already loaded, so this costs no query.
  // With `trendAll`, every week back to the first live change (at most
  // TREND_WEEKS_MAX), for the page's "all time".
  let weeksBack = TREND_WEEKS;
  if (trendAll && changes.length) {
    const first = weekStart(changes.reduce((m, c) => (new Date(c.merged_at) < m ? new Date(c.merged_at) : m), new Date(now)));
    weeksBack = Math.min(TREND_WEEKS_MAX, Math.max(1, Math.round((week.start.getTime() - first.getTime()) / WEEK_MS) + 1));
  }
  const trend = [];
  for (let k = weeksBack - 1; k >= 0; k -= 1) {
    const start = new Date(week.start.getTime() - k * WEEK_MS);
    const span = { start, end: new Date(start.getTime() + WEEK_MS) };
    trend.push({ week: isoDay(start), count: weekGroups(span).filter((g) => g.active).length });
  }
  const { rows: waiting } = await pool.query(WAITING_SQL, params);
  const oneShort = [
    ...thisWeek.filter((g) => !g.selfHosted && !g.active && g.people.length === 1)
      .map((g) => ({ slug: g.slug, name: g.name, people: g.people, why: 'one person had a change go live alone' })),
    ...waiting.map((w) => ({ slug: w.slug, name: w.name, people: [{ userId: Number(w.author_id), name: w.author }],
      why: 'a change is waiting for a yes from someone else', since: w.promoted_at })),
  ].filter(keep);
  return {
    week: week.label,
    finished: week.finished,
    count: active.length,
    trend,
    groups: active,
    wentQuiet,
    homeroom: homeroom ? { changes: homeroom.changes, people: homeroom.people.length } : null,
    oneShort,
  };
}

// ── Coverage ───────────────────────────────────────────────────────────
//
// Is navigation actually arriving? Real people active this week by the
// server's own records, against those with navigation recorded; and rows per
// day per build, so a broken hook or an old cached shell shows as a gap in
// the data, not as people who stopped exploring. $5 is the navigation codes.
const COVERAGE_SQL = `WITH real AS (
    SELECT u.id FROM users u WHERE ${REAL_PERSON_SQL}
  ), active AS (${ARRIVE_THIS_WEEK}
  ), nav AS (
    SELECT e.user_id, (e.created_at AT TIME ZONE 'UTC')::date AS day, e.metadata->>'build' AS build
      FROM events e
     WHERE e.event_type = 'ui_experience' AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
       AND e.metadata->>'kind' = 'screen_visit' AND e.metadata->>'screen' = ANY($5::text[])
  )
  SELECT
    (SELECT COUNT(*)::int FROM real r WHERE r.id IN (SELECT user_id FROM active)) AS active_people,
    (SELECT COUNT(DISTINCT n.user_id)::int FROM nav n JOIN real r ON r.id = n.user_id) AS with_navigation,
    COALESCE((SELECT json_agg(json_build_object('day', to_char(d.day, 'YYYY-MM-DD'), 'build', d.build, 'rows', d.rows)
                ORDER BY d.day, d.build)
       FROM (SELECT n.day, COALESCE(n.build, 'unknown') AS build, COUNT(*)::int AS rows
               FROM nav n GROUP BY n.day, COALESCE(n.build, 'unknown')) d), '[]'::json) AS by_day`;

async function coverage(pool, { week, leftOutIds = [] } = {}) {
  const { NAV_SCREENS: nav } = require('./ui-telemetry');
  const { rows } = await pool.query(COVERAGE_SQL,
    [week.start, week.end, ...realPersonParams(leftOutIds), [...nav]]);
  const r = rows[0] || {};
  return {
    week: week.label,
    activePeople: r.active_people || 0,
    withNavigation: r.with_navigation || 0,
    byDay: r.by_day || [],
  };
}

// ── Loops ──────────────────────────────────────────────────────────────
//
// The change loop is counted in turns, not people: one turn is one request
// or one piece of feedback (a GitHub issue in a project), filed by a real
// person, going round
//
//   Notice → Make sense → Sketch → Decide → Go live → Hear back
//
// Notice: filed. Make sense: somebody other than the reporter commented in
// its thread or backed it. Sketch: a change linked to it was started.
// Decide: that change was put to a vote. Go live: it merged. Hear back:
// telling the reporter is not built yet, so the step is returned as
// "coming", never as a number.
//
// $1 week start, $2 week end, $3/$4 real people.
const CHANGE_LOOP_SQL = `WITH reported AS (
    SELECT i.app_id, i.github_issue_number AS number, i.created_by AS reporter, i.created_at AS noticed_at,
           i.title, i.status
      FROM issues i
     WHERE i.kind = 'general' AND i.github_issue_number IS NOT NULL AND i.created_by IS NOT NULL
    UNION ALL
    SELECT COALESCE(fr.app_id, (SELECT a.id FROM apps a WHERE a.self_hosted ORDER BY a.id LIMIT 1)),
           fr.issue_number, fr.user_id, fr.created_at, fr.title, 'open'
      FROM feedback_reports fr
     WHERE fr.issue_number IS NOT NULL
  ), turns AS (
    SELECT DISTINCT ON (t.app_id, t.number) t.*
      FROM reported t
      JOIN users u ON u.id = t.reporter
     WHERE t.app_id IS NOT NULL AND t.noticed_at < $2::timestamptz
       -- A year back: older requests are history, not open turns.
       AND t.noticed_at >= $1::timestamptz - make_interval(days => 365)
       AND ${REAL_PERSON_SQL}
     ORDER BY t.app_id, t.number, t.noticed_at
  )
  SELECT t.app_id, ap.slug, ap.name AS project, t.number, t.title, t.status, t.noticed_at,
         t.reporter AS reporter_id, ru.username AS reporter,
         (SELECT MIN(x.at) FROM (
            SELECT MIN(cmx.created_at) AS at FROM chat_messages cmx
             WHERE cmx.app_id = t.app_id AND cmx.thread_type = 'issue' AND cmx.thread_ref = t.number
               AND cmx.msg_type = 'message' AND cmx.user_id IS DISTINCT FROM t.reporter
            UNION ALL
            SELECT MIN(ivx.created_at) FROM issue_votes ivx JOIN issues ix ON ix.id = ivx.issue_id
             WHERE ix.app_id = t.app_id AND ix.github_issue_number = t.number AND ivx.user_id IS DISTINCT FROM t.reporter
          ) x) AS made_sense_at,
         lc.sketch_at, lc.decide_at, lc.live_at, lc.holder
    FROM turns t
    JOIN apps ap ON ap.id = t.app_id
    LEFT JOIN users ru ON ru.id = t.reporter
    LEFT JOIN LATERAL (
      SELECT MIN(cs.created_at) AS sketch_at, MIN(cs.promoted_at) AS decide_at,
             MIN(cs.merged_at) FILTER (WHERE cs.status = 'merged') AS live_at,
             (SELECT hu.username FROM chat_sessions h JOIN users hu ON hu.id = h.user_id
               WHERE h.app_id = t.app_id
                 AND (t.number = ANY(h.linked_issues) OR h.created_from_issue_number = t.number)
               ORDER BY h.created_at DESC LIMIT 1) AS holder
        FROM chat_sessions cs
       WHERE cs.app_id = t.app_id
         AND (t.number = ANY(cs.linked_issues) OR cs.created_from_issue_number = t.number)
    ) lc ON TRUE
   ORDER BY t.noticed_at`;

const LOOP_STEPS = Object.freeze(['notice', 'make_sense', 'sketch', 'decide', 'go_live', 'hear_back']);

function turnStep(row) {
  if (row.live_at) return 'go_live';
  if (row.decide_at) return 'decide';
  if (row.sketch_at) return 'sketch';
  if (row.made_sense_at) return 'make_sense';
  return 'notice';
}

async function changeLoop(pool, { week, now = new Date(), leftOutIds = [], memberIds = null } = {}) {
  const { rows: all } = await pool.query(CHANGE_LOOP_SQL, [week.start, week.end, ...realPersonParams(leftOutIds)]);
  // Narrowed to a cohort: the turns its members raised.
  const rows = memberIds ? all.filter((r) => memberIds.has(Number(r.reporter_id))) : all;
  const nowMs = new Date(now).getTime();
  const turns = rows.map((r) => {
    const step = turnStep(r);
    const since = { notice: r.noticed_at, make_sense: r.made_sense_at, sketch: r.sketch_at, decide: r.decide_at, go_live: r.live_at }[step];
    return {
      project: r.project, slug: r.slug, number: r.number, title: r.title,
      reporter: r.reporter ? { userId: Number(r.reporter_id), name: r.reporter } : null,
      step,
      since,
      days: since ? Math.floor((nowMs - new Date(since).getTime()) / DAY_MS) : null,
      holder: step === 'notice' ? null : r.holder || null,
      noticedAt: r.noticed_at,
      liveAt: r.live_at,
      closed: r.status !== 'open' && !r.live_at,
    };
  });
  // Open turns: not live and not closed without a change, oldest first.
  const open = turns.filter((x) => x.step !== 'go_live' && !x.closed)
    .sort((a, b) => new Date(a.since) - new Date(b.since));
  const inWeek = (at, w) => at && new Date(at) >= w.start && new Date(at) < w.end;
  const live = turns.filter((x) => inWeek(x.liveAt, week)).map((x) => ({
    ...x, daysFromNotice: Math.round((new Date(x.liveAt) - new Date(x.noticedAt)) / DAY_MS),
  }));
  const before = previousWeek(week);
  const projects = new Map();
  for (const x of turns) {
    if (!inWeek(x.liveAt, week) && !inWeek(x.liveAt, before)) continue;
    const p = projects.get(x.slug) || { slug: x.slug, project: x.project, thisWeek: 0, lastWeek: 0 };
    if (inWeek(x.liveAt, week)) p.thisWeek += 1; else p.lastWeek += 1;
    projects.set(x.slug, p);
  }
  const atStep = {};
  for (const key of LOOP_STEPS) {
    atStep[key] = key === 'hear_back' ? { status: 'coming' }
      : key === 'go_live' ? live.length
        : open.filter((x) => x.step === key).length;
  }
  return {
    week: week.label,
    steps: LOOP_STEPS,
    atStep,
    turnsClosed: { status: 'coming' },
    live,
    perProject: [...projects.values()].filter((p) => p.thisWeek > 0)
      .map((p) => ({ ...p, alsoLastWeek: p.lastWeek > 0 })),
    open,
  };
}

// The invite loop: who brought whom through an invite link, and whether the
// person arrived, did something, and brought someone in turn.
const INVITE_LOOP_SQL = `SELECT inv.id AS invitee_id, inv.username AS invitee, host.id AS host_id, host.username AS host,
         inv.platform_access_granted_at AS let_in_at,
         LEAST(
           (SELECT MIN(cm.joined_at) FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
             WHERE c.kind = 'channel' AND cm.user_id = inv.id),
           (SELECT MIN(e.created_at) FROM events e WHERE e.user_id = inv.id AND e.event_type = 'ui_experience')
         ) AS arrived_at,
         (SELECT MIN(x.at) FROM (
            SELECT MIN(cmx.created_at) AS at FROM chat_messages cmx WHERE cmx.user_id = inv.id AND cmx.msg_type = 'message'
            UNION ALL SELECT MIN(pvx.created_at) FROM pr_votes pvx WHERE pvx.user_id = inv.id
            UNION ALL SELECT MIN(frx.created_at) FROM feedback_reports frx WHERE frx.user_id = inv.id
            UNION ALL SELECT MIN(csx.created_at) FROM chat_sessions csx WHERE csx.user_id = inv.id
          ) x) AS did_something_at,
         EXISTS (SELECT 1 FROM users nxt WHERE nxt.admitted_by = inv.id) AS invited_someone
    FROM users inv
    JOIN users host ON host.id = inv.admitted_by
    JOIN users u ON u.id = inv.id
   WHERE inv.admitted_by IS NOT NULL AND inv.platform_access_granted_at < $2::timestamptz
     AND inv.platform_access_granted_at >= $1::timestamptz - make_interval(days => 365)
     AND ${REAL_PERSON_SQL}
   ORDER BY inv.platform_access_granted_at`;

async function inviteLoop(pool, { week, leftOutIds = [], memberIds = null } = {}) {
  const { rows: all } = await pool.query(INVITE_LOOP_SQL, [week.start, week.end, ...realPersonParams(leftOutIds)]);
  // Narrowed to a cohort: pairs where its member brought someone or was brought.
  const rows = memberIds
    ? all.filter((r) => memberIds.has(Number(r.host_id)) || memberIds.has(Number(r.invitee_id))) : all;
  const pairs = rows.map((r) => ({
    host: { userId: Number(r.host_id), name: r.host },
    invitee: { userId: Number(r.invitee_id), name: r.invitee },
    letInAt: r.let_in_at,
    arrived: !!r.arrived_at,
    didSomething: !!r.did_something_at,
    invitedSomeone: r.invited_someone === true,
  }));
  return {
    steps: ['invited', 'arrived', 'did_something', 'invited_someone'],
    counts: {
      invited: pairs.length,
      arrived: pairs.filter((p) => p.arrived).length,
      did_something: pairs.filter((p) => p.didSomething).length,
      invited_someone: pairs.filter((p) => p.invitedSomeone).length,
    },
    pairs,
  };
}

// ── Navigation readings ────────────────────────────────────────────────
//
// The raw rows behind paths, next steps and "possibly lost", for a set of
// people over a window: their UI telemetry in time order, and whether any of
// their delivery receipts in the window reported dropped events (a gap in the
// data must never read as a move). $1 from, $2 to, $3 the people.
const NAV_ROWS_SQL = `SELECT e.user_id, e.created_at AS at, e.metadata->>'kind' AS kind,
         e.metadata->>'screen' AS screen, e.metadata->>'via' AS via, e.metadata->>'outcome' AS outcome,
         a.slug AS app_slug,
         (e.metadata->>'sequence')::int AS sequence
    FROM events e
    LEFT JOIN apps a ON a.id = e.app_id
   WHERE e.event_type = 'ui_experience' AND e.user_id = ANY($3::int[])
     AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
   ORDER BY e.user_id, e.created_at, e.id`;

const DROPPED_SQL = `SELECT DISTINCT e.user_id FROM events e
   WHERE e.event_type = 'ui_telemetry_delivery' AND e.user_id = ANY($3::int[])
     AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
     AND COALESCE((e.metadata->>'droppedEvents')::int, 0) > 0`;

/** Visits per person for a window, leaving out people with lost telemetry. */
async function visitsFor(pool, { userIds, from, to }) {
  const ids = (userIds || []).map(Number);
  if (!ids.length) return { byPerson: new Map(), leftOut: { droppedEvents: [], noNavigation: [] } };
  const [{ rows }, { rows: dropped }] = await Promise.all([
    pool.query(NAV_ROWS_SQL, [from, to, ids]),
    pool.query(DROPPED_SQL, [from, to, ids]),
  ]);
  const droppedIds = new Set(dropped.map((r) => Number(r.user_id)));
  const grouped = new Map();
  for (const r of rows) {
    const id = Number(r.user_id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push({
      at: r.at, kind: r.kind, screen: r.screen, via: r.via, outcome: r.outcome, appSlug: r.app_slug, sequence: r.sequence,
    });
  }
  const byPerson = new Map();
  const noNavigation = [];
  for (const id of ids) {
    if (droppedIds.has(id)) continue;
    const visits = splitVisits(grouped.get(id) || []);
    if (!visits.length) { noNavigation.push(id); continue; }
    byPerson.set(id, visits);
  }
  return { byPerson, leftOut: { droppedEvents: [...droppedIds], noNavigation } };
}

// The people a next-step table is about: one cohort, or every newcomer.
const NEWCOMER_IDS_SQL = `SELECT u.id FROM users u
   WHERE u.has_platform_access
     AND u.platform_access_granted_at >= $2::timestamptz - make_interval(days => $1::int)
     AND u.platform_access_granted_at <= $2::timestamptz
     AND ${REAL_PERSON_SQL}`;

async function nextStepCounts(pool, { from, to, userIds }) {
  const { byPerson, leftOut } = await visitsFor(pool, { userIds, from, to });
  return { ...nextSteps(byPerson), people: byPerson.size, leftOut };
}

/** Next steps for every newcomer (first 28 days) over their window. */
async function newcomerNextSteps(pool, { now = new Date(), leftOutIds = [] } = {}) {
  const { rows } = await pool.query(NEWCOMER_IDS_SQL, [NEWCOMER_DAYS, now, ...realPersonParams(leftOutIds)]);
  const to = new Date(now);
  const from = new Date(to.getTime() - NEWCOMER_DAYS * DAY_MS);
  return nextStepCounts(pool, { from, to, userIds: rows.map((r) => r.id) });
}

// ── One person ─────────────────────────────────────────────────────────
//
// Everything about one person, for the dialog the page opens from a name:
// their first mile, the first-run marks, and from navigation what they found
// and came back to, possibly lost visits, failed attempts, whether they opened
// Challenges, and their First challenges with the time each was done.

const PERSON_SQL = `WITH ${ADMITTED_CTE}
  SELECT a.signup_id, a.email, a.released_at, ${PERSON_FACTS}
    FROM users u
    LEFT JOIN admitted a ON a.linked_user_id = u.id
      AND (u.platform_access_granted_at IS NULL OR u.platform_access_granted_at >= a.released_at)
    ${PERSON_JOINS}
   WHERE u.id = $1::int AND u.created_at <= $2::timestamptz`;

// Apps the person used in the window [$2, $3): first day ever, days used for
// 30 seconds or more in the window, seconds on the first day, whether they
// made it, and whether it is on their Home (a project they belong to and did
// not hide, or one they pinned), the same rule Home itself uses.
const PERSON_APPS_SQL = `SELECT ap.id, ap.slug, ap.name, ap.created_by = $1::int AS own,
         MIN(aa.date) AS first_day,
         (SELECT MIN(a0.date) FROM app_activity a0 WHERE a0.user_id = $1::int AND a0.app_id = ap.id) AS first_ever,
         (SELECT a1.seconds_spent FROM app_activity a1 WHERE a1.user_id = $1::int AND a1.app_id = ap.id
           ORDER BY a1.date LIMIT 1) AS first_day_seconds,
         COUNT(*) FILTER (WHERE aa.seconds_spent >= 30)::int AS days_used,
         (EXISTS (SELECT 1 FROM app_favorites f WHERE f.user_id = $1::int AND f.app_id = ap.id AND f.hidden IS NOT TRUE)
          OR (ap.created_by = $1::int)
          OR EXISTS (SELECT 1 FROM app_collaborators c WHERE c.user_id = $1::int AND c.app_id = ap.id
                       AND c.accepted_at IS NOT NULL)) AS on_home
    FROM app_activity aa JOIN apps ap ON ap.id = aa.app_id
   WHERE aa.user_id = $1::int
     AND aa.date >= ($2::timestamptz AT TIME ZONE 'UTC')::date AND aa.date < ($3::timestamptz AT TIME ZONE 'UTC')::date
   GROUP BY ap.id, ap.slug, ap.name, ap.created_by
   ORDER BY days_used DESC, ap.slug`;

// The person's challenge credits since $2, with whether each is one of the
// First challenges (the ONBOARDING category, which the Getting started card
// is built from), from the ledger the scorer writes the moment an act counts.
const PERSON_CHALLENGES_SQL = `SELECT ua.challenge_id, COALESCE(c.goal, ct.goal) AS title, ua.points, ua.activity_at, ua.source,
         UPPER(TRIM(COALESCE(ct.category, ''))) = 'ONBOARDING' AS first_challenge
    FROM user_activities ua
    LEFT JOIN challenges c ON c.id = ua.challenge_id
    LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
   WHERE ua.user_id = $1::int AND ua.activity_at >= $2::timestamptz AND ua.activity_at < $3::timestamptz
     AND ua.challenge_id IS NOT NULL
   ORDER BY ua.activity_at`;

async function person(pool, { userId, now = new Date() } = {}) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const { rows } = await pool.query(PERSON_SQL, [id, now]);
  const row = rows[0];
  if (!row) return null;
  const mile = firstMileSteps(row, now);
  const since = row.released_at || row.access_at || row.account_at;
  const to = new Date(now);
  const from = since ? new Date(Math.min(new Date(since).getTime(), to.getTime() - NEWCOMER_DAYS * DAY_MS))
    : new Date(to.getTime() - NEWCOMER_DAYS * DAY_MS);
  const [{ byPerson, leftOut }, apps, challenges] = await Promise.all([
    visitsFor(pool, { userIds: [id], from, to }),
    pool.query(PERSON_APPS_SQL, [id, from, to]),
    pool.query(PERSON_CHALLENGES_SQL, [id, from, to]),
  ]);
  const visits = byPerson.get(id) || [];
  const steps = visits.flatMap((v) => v.steps);
  const viaFor = (slug) => (steps.find((st) => st.appSlug === slug && (st.screen === 'app' || st.screen === 'project')) || {}).via || null;
  const firstWindowDay = new Date(from).toISOString().slice(0, 10);
  const appRows = apps.rows.map((a) => ({
    slug: a.slug,
    name: a.name,
    own: a.own === true,
    firstEver: a.first_ever ? new Date(a.first_ever).toISOString().slice(0, 10) : null,
    daysUsed: a.days_used,
    onHome: a.on_home === true,
    firstDaySeconds: a.first_day_seconds,
    via: viaFor(a.slug),
  }));
  const found = appRows.filter((a) => !a.own && a.firstEver && a.firstEver >= firstWindowDay).map((a) => ({
    slug: a.slug, name: a.name,
    how: a.via === 'handed' ? 'handed' : (a.via ? 'own' : null),
    stayed: a.firstDaySeconds == null ? null : a.firstDaySeconds >= LOST_CUTOFFS.landingSeconds,
    seconds: a.firstDaySeconds,
  }));
  const cameBackTo = appRows.filter((a) => a.daysUsed >= 2).map((a) => ({ slug: a.slug, name: a.name, days: a.daysUsed }));
  const ways = new Map();
  for (const v of visits) {
    const first = v.steps[0];
    if (first && first.via) ways.set(first.via, (ways.get(first.via) || 0) + 1);
  }
  const lostVisits = visits.map((v) => ({ v, reading: lostReading(v) })).filter((x) => x.reading.possiblyLost)
    .map(({ v, reading }) => ({
      at: new Date(v.start).toISOString(),
      path: v.steps.map((st) => (st.appSlug ? `${st.screen}:${st.appSlug}` : st.screen)),
      ...reading,
    }));
  const challengesOpenedAt = (steps.find((st) => st.screen === 'challenges') || {}).t || null;
  return {
    userId: id,
    name: row.username,
    cohort: row.released_at ? isoDay(row.released_at) : null,
    firstMile: mile,
    found,
    cameBackTo,
    usedOftenNotOnHome: appRows.filter((a) => a.daysUsed >= 3 && !a.onHome).map((a) => ({ slug: a.slug, name: a.name, days: a.daysUsed })),
    waysIn: Object.fromEntries(ways),
    visits: visits.length,
    possiblyLost: lostVisits,
    failedAttempts: mile.failedAttempts,
    repeatedTaps: mile.repeatedTaps,
    challenges: {
      openedAt: challengesOpenedAt ? new Date(challengesOpenedAt).toISOString() : null,
      credits: challenges.rows.map((c) => ({
        challengeId: c.challenge_id, title: c.title, points: c.points, at: c.activity_at, firstChallenge: c.first_challenge === true,
      })),
    },
    navigation: leftOut.droppedEvents.includes(id) ? notRecorded('Some of this person\'s telemetry was lost in this window.')
      : (visits.length ? { recorded: true } : notRecorded('No navigation recorded for this person yet.')),
  };
}

// ── Trust checks ───────────────────────────────────────────────────────
//
// Shown beside the North Star so it cannot be fooled quietly.
//
// Lockstep: accounts whose yes votes keep landing within seconds of another
// account's yes on the same change. Calibrated on production on 2026-10-02
// against the nine-account ring found in Season 2: in the ring's week (21
// Sep) these cut-offs flag exactly its nine accounts and nobody else; in the
// June hackathon weeks they also flagged one other account a week, which is
// why it is a warning beside the numbers and never removes anyone from them.
const LOCKSTEP_CUTOFFS = Object.freeze({
  withinSeconds: 5,
  minYesVotes: 5,
  minShare: 0.3,
});

// $1 week start, $2 week end, $3/$4 real people, $5 lockstep seconds,
// $6 lockstep minimum votes, $7 lockstep minimum share.
const TRUST_SQL = `WITH live AS (
    SELECT cs.id, cs.user_id, ap.slug, ap.name AS project, au.username AS author, au.is_admin AS author_is_admin,
           EXISTS (SELECT 1 FROM pr_votes pvx JOIN users uy ON uy.id = pvx.user_id
                    WHERE pvx.session_id = cs.id AND pvx.vote = 'yes' AND pvx.user_id <> cs.user_id
                      AND pvx.approval_epoch = cs.approval_epoch
                      AND uy.is_admin IS NOT TRUE AND uy.is_synthetic IS NOT TRUE
                      AND uy.participation_restricted_at IS NULL AND uy.anonymised_at IS NULL
                      AND NOT (LOWER(uy.username) LIKE ANY($3::text[]))
                      AND NOT (uy.id = ANY($4::int[]))) AS group_yes,
           EXISTS (SELECT 1 FROM events e WHERE e.event_type = 'pr_merged' AND e.session_id = cs.id
                     AND e.created_at >= $1::timestamptz - INTERVAL '1 day'
                     AND COALESCE((e.metadata->>'forced')::boolean, FALSE)) AS forced
      FROM chat_sessions cs
      JOIN apps ap ON ap.id = cs.app_id
      JOIN users au ON au.id = cs.user_id
     WHERE cs.status = 'merged' AND cs.merged_at >= $1::timestamptz AND cs.merged_at < $2::timestamptz
       AND au.is_synthetic IS NOT TRUE AND NOT (LOWER(au.username) LIKE ANY($3::text[]))
  ), yes AS (
    SELECT pvx.user_id, pvx.session_id, pvx.created_at FROM pr_votes pvx JOIN users u ON u.id = pvx.user_id
     WHERE pvx.vote = 'yes' AND pvx.created_at >= $1::timestamptz AND pvx.created_at < $2::timestamptz
       AND ${REAL_PERSON_SQL}
  ), close_yes AS (
    SELECT DISTINCT y.user_id, y.session_id FROM yes y
      JOIN yes o ON o.session_id = y.session_id AND o.user_id <> y.user_id
     WHERE ABS(EXTRACT(EPOCH FROM (o.created_at - y.created_at))) <= $5::int
  ), lockstep AS (
    SELECT y.user_id, COUNT(DISTINCT y.session_id)::int AS votes, COUNT(DISTINCT c.session_id)::int AS close_votes
      FROM yes y LEFT JOIN close_yes c ON c.user_id = y.user_id AND c.session_id = y.session_id
     GROUP BY y.user_id
  )
  SELECT
    COALESCE((SELECT json_agg(json_build_object('slug', l.slug, 'project', l.project, 'author', l.author,
                'forced', l.forced) ORDER BY l.slug)
       FROM live l WHERE NOT l.group_yes AND NOT l.author_is_admin), '[]'::json) AS without_group_vote,
    (SELECT COUNT(*)::int FROM live l WHERE NOT l.author_is_admin) AS live_by_people,
    (SELECT COUNT(*)::int FROM live) AS live_total,
    (SELECT COUNT(*)::int FROM live l WHERE l.author_is_admin) AS live_by_team,
    (SELECT COUNT(*)::int FROM live l WHERE l.forced) AS forced,
    COALESCE((SELECT json_agg(json_build_object('userId', k.user_id, 'name', u.username, 'yesVotes', k.votes,
                'withinSeconds', k.close_votes) ORDER BY k.close_votes DESC, u.username)
       FROM lockstep k JOIN users u ON u.id = k.user_id
      WHERE k.votes >= $6::int AND k.close_votes::numeric / k.votes >= $7::numeric), '[]'::json) AS lockstep`;

async function trustChecks(pool, { week, leftOutIds = [] } = {}) {
  const { rows } = await pool.query(TRUST_SQL, [week.start, week.end, ...realPersonParams(leftOutIds),
    LOCKSTEP_CUTOFFS.withinSeconds, LOCKSTEP_CUTOFFS.minYesVotes, LOCKSTEP_CUTOFFS.minShare]);
  const r = rows[0] || {};
  return {
    week: week.label,
    // A change by a real person that went live with no yes from another real
    // person: the exact complement of Use. Forced merges are a sub-line, and
    // only "at least": older merges carry no forced flag.
    withoutGroupVote: {
      count: (r.without_group_vote || []).length,
      of: r.live_by_people || 0,
      atLeastForced: r.forced || 0,
      changes: r.without_group_vote || [],
    },
    // The team's share of the week's live changes. It will not equal
    // Analytics, which counts a rolling seven days and leaves out admins only.
    teamShare: { team: r.live_by_team || 0, of: r.live_total || 0 },
    lockstep: { possible: r.lockstep || [], cutoffs: LOCKSTEP_CUTOFFS },
  };
}

// ── Summary ────────────────────────────────────────────────────────────
//
// What the page leads with, in one request: active groups for the last
// finished week (with this week so far as a count only), one stuck list for
// newcomers across their cohorts, the open turns, the trust checks and the
// coverage line.
async function summary(pool, { week, now = new Date(), leftOutIds = [], memberIds = null, trendAll = false } = {}) {
  const current = parseWeek(isoDay(weekStart(now)), now);
  const nowMs = new Date(now).getTime();
  const [groups, soFar, list, loop, trust, cover] = await Promise.all([
    activeGroups(pool, { week, now, leftOutIds, memberIds, trendAll }),
    activeGroups(pool, { week: current, now, leftOutIds, memberIds }),
    cohorts(pool, { now, leftOutIds }),
    changeLoop(pool, { week, now, leftOutIds }),
    trustChecks(pool, { week, leftOutIds }),
    coverage(pool, { week, leftOutIds }),
  ]);
  const recentDays = list.cohorts
    .filter((c) => nowMs - new Date(`${c.day}T00:00:00Z`).getTime() <= NEWCOMER_DAYS * DAY_MS)
    .map((c) => c.day);
  const miles = await Promise.all([
    ...recentDays.map((day) => firstMile(pool, { day, now, leftOutIds })),
    firstMile(pool, { day: 'other_way', now, leftOutIds }),
  ]);
  const stuck = miles.flatMap((m) => m.people.filter((p) => p.stuckAt && (!memberIds || memberIds.has(Number(p.userId)))).map((p) => ({
    userId: p.userId, name: p.name, cohort: m.cohort, stuckAt: p.stuckAt, reason: p.stuckReason,
    days: p.daysSince, failedAttempts: p.failedAttempts,
  }))).sort((a, b) => (b.days || 0) - (a.days || 0));
  return {
    week: week.label,
    allTime: trendAll,
    thisWeekSoFar: { week: current.label, count: soFar.count },
    groups,
    stuck,
    openTurns: loop.open,
    trust,
    coverage: cover,
  };
}

module.exports = {
  COHORTS_SQL,
  CHANGE_LOOP_SQL,
  COVERAGE_SQL,
  DROPPED_SQL,
  INVITE_LOOP_SQL,
  LOOP_STEPS,
  NAV_ROWS_SQL,
  NEWCOMER_IDS_SQL,
  PERSON_APPS_SQL,
  PERSON_CHALLENGES_SQL,
  PERSON_SQL,
  LIVE_CHANGES_SQL,
  LOCKSTEP_CUTOFFS,
  WAITING_SQL,
  DAY_MS,
  FIRST_MILE_ADMITTED_SQL,
  FIRST_MILE_OTHER_WAY_SQL,
  FIRST_MILE_STEPS,
  STAGES,
  STAGES_SQL,
  STAY_EVER_SQL,
  TRUST_SQL,
  FEW_MOVES,
  GROUP_MAX,
  GROUP_MIN,
  TREND_WEEKS,
  TREND_WEEKS_MAX,
  LOST_CUTOFFS,
  NEWCOMER_DAYS,
  REAL_PERSON_SQL,
  RESERVED_PATTERNS,
  VISIT_GAP_MS,
  WEEK_MS,
  activeGroups,
  allTime,
  changeLoop,
  cohorts,
  coverage,
  groupsForWeek,
  inviteLoop,
  newcomerNextSteps,
  nextStepCounts,
  firstMile,
  firstMileCounts,
  firstMileSteps,
  groupLifecycle,
  isActiveGroup,
  isoDay,
  lostReading,
  nextSteps,
  notRecorded,
  parseDay,
  parseWeek,
  person,
  previousWeek,
  splitVisits,
  stages,
  summary,
  trustChecks,
  visitsFor,
  weekStart,
};
