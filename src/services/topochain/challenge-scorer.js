// Automatic challenge scoring — the DB half.
//
// Season challenges are read from the points ledger: a person's progress on
// "Try 3 apps" is the number of `user_activities` rows crediting them for it.
// Until this module, only two challenges ever produced those rows without an
// admin typing them in — the ZKPassport endpoint writes its own, and block
// production is computed by the snapshot builder. Everything else was scored
// by hand.
//
// This is the thing that writes the rest. It reads the rules an admin
// configured (`challenge_scoring_rules`), takes the measure each one names
// over the platform's OWN tables, and inserts the credits that are missing.
// Each rule runs on its own interval; one timer beats once a minute and runs
// whichever rules are due (./challenge-rules.js, "Cadence").
//
// ── Why it can run this often and never double-pay ─────────────────────
//
// Every credit names the thing it was paid for in `metadata.source_key`
// ("app:12", "merged:88104", "provider:github"), and
// `user_activities_source_key_unique` makes that name unique per (challenge,
// user). Inserts are ON CONFLICT DO NOTHING against it. So the scorer keeps
// no cursor, no "already processed" table and no memory between runs: it
// re-derives the whole picture each tick and the database throws away what it
// already has. An interrupted run, two instances briefly overlapping, or an
// operator hitting Run now during a scheduled tick are all safe by
// construction rather than by timing.
//
// ── Where the numbers come from ────────────────────────────────────────
//
// The rule's Target and Points, falling back to the challenge's own
// `metric_target` and `reward` — so by default the numbers a participant
// reads on the card are exactly the numbers they are paid by. The split
// between measures (a share per unit, everything on the last one, or a
// graded amount) is in ./challenge-rules.js, which is pure and tested
// without a database.
'use strict';

const log = require('../logger');
const { CHALLENGE_SCORER_LOCK } = require('../advisory-locks');
const rules = require('./challenge-rules');
const grader = require('./challenge-grader');
const { ONBOARDING_LIMIT } = require('./challenge-onboarding');

const { MEASURES, TRY_APPS_MIN_SECONDS } = rules;

// Ceilings for one run. The first run of a season is the big one — every
// account that already has GitHub linked is a credit waiting to be written —
// and a tick that tried to do all of it in one transaction would hold locks
// on `user_activities` for as long as it took. Spreading it over consecutive
// ticks costs minutes and keeps every run boring.
const MAX_CREDITS_PER_RUN = 500;
const MAX_GRADES_PER_RUN = 20;
// Candidate rows read per rule per tick. Well above any real week's activity;
// it exists so a mis-bound rule cannot pull the whole table into memory.
const CANDIDATE_LIMIT = 5000;

const DEFAULT_INTERVAL_MINUTES = 10;
const DEFAULT_AGGREGATE_HOURS = 6;

let timer = null;
let inFlight = null;

// ── The challenges each rule covers ────────────────────────────────────
//
// A rule binds to a TEMPLATE (every challenge stamped from it, so a weekly
// challenge keeps being scored when next week's row is created) or to one
// CHALLENGE. Both resolve here to the same shape: one row per challenge, with
// the template's fields under `t_` and the event's dates for the window
// fallback.
//
// Scoped to live events: an active, non-internal event on an active season,
// so a staff dry-run season can never start paying people.
//
// NOT scoped by event `type`, which is the shape this borrowed from the
// snapshot builder's sweep and had to lose. The builder sweeps `regular`
// events because those are the scoring sprints it computes standings for;
// challenges are attached wherever the organiser put them, and in production
// all nine of Pre Season 2's challenges hang off the SEASON-type event. With
// the type filter in place the scorer matched none of them and every rule
// reported "No live challenge" — the whole service silently doing nothing,
// which is exactly the failure this screen's status column exists to expose.
//
// One consequence worth naming: a template-bound rule pays into EVERY live
// challenge stamped from that template, so a template instantiated on two
// events that are active at once is credited on both. That is the same
// property that makes a weekly rule keep working when next week's row is
// created; an operator who wants one instance only binds to the challenge.
//
// `first_challenge` (#4602, #4603): whether the challenge is one of its
// season's First challenges, the one-time list Getting started draws (the
// first ONBOARDING_LIMIT ONBOARDING templates in display order, the rule
// ./challenge-onboarding.js buildOnboarding applies; $1 is that limit). On
// those, and only those, time in an app you made counts for "Try an app"
// and feedback on your own project counts for "Send feedback": a newcomer's
// first app is usually their own, and the list is paid once in a life. Every
// repeatable and weekly challenge keeps leaving your own apps out, so points
// cannot be farmed from them (loadCandidates' `ownApps`).
const RULE_CHALLENGES_SQL = `
  SELECT r.id AS rule_id, r.name AS rule_name, r.measure, r.target AS rule_target,
         r.points AS rule_points, r.enabled AS rule_enabled,
         r.interval_minutes AS rule_interval_minutes, r.last_scored_at AS rule_last_scored_at,
         c.id AS challenge_id, c.season_event_id, c.enabled, c.completed,
         c.schedule_start, c.schedule_end, c.metric_target, c.reward,
         ct.id AS template_id, ct.category AS t_category, ct.goal AS t_goal,
         ct.schedule_start AS t_schedule_start, ct.schedule_end AS t_schedule_end,
         ct.metric_target AS t_metric_target, ct.reward AS t_reward,
         se.starts_at AS event_starts_at, se.ends_at AS event_ends_at,
         (UPPER(TRIM(ct.category)) = 'ONBOARDING'
          AND c.challenge_template_id IN (
            SELECT ff.challenge_template_id FROM (
              SELECT DISTINCT ON (f.challenge_template_id) f.challenge_template_id, f.display_order, f.id
                FROM challenges f
                JOIN season_events fe ON fe.id = f.season_event_id
                JOIN challenge_templates ft ON ft.id = f.challenge_template_id
               WHERE fe.season_id = se.season_id AND fe.internal = FALSE
                 AND UPPER(TRIM(ft.category)) = 'ONBOARDING'
               ORDER BY f.challenge_template_id, f.display_order ASC, f.id ASC
            ) ff
             ORDER BY ff.display_order ASC, ff.id ASC
             LIMIT $1)) AS first_challenge
    FROM challenge_scoring_rules r
    JOIN challenges c
      ON (r.challenge_id IS NOT NULL AND c.id = r.challenge_id)
      OR (r.challenge_template_id IS NOT NULL AND c.challenge_template_id = r.challenge_template_id)
    JOIN challenge_templates ct ON ct.id = c.challenge_template_id
    JOIN season_events se ON se.id = c.season_event_id
    LEFT JOIN seasons s ON s.id = se.season_id
   WHERE se.internal = FALSE
     AND se.is_active = TRUE AND COALESCE(s.is_active, FALSE) = TRUE
   ORDER BY r.id ASC, c.id ASC
`;

// What the ledger already holds for one challenge: the source keys already
// paid for, and how many credits each person has, in all and per week (from
// each credit's activity_at). Two questions, one query, because the second is
// what enforces the cap, and on a WEEKLY challenge the cap is per week.
const CREDITED_SQL = `
  SELECT user_id, metadata->>'source_key' AS source_key, activity_at
    FROM user_activities
   WHERE challenge_id = $1 AND metadata->>'source_key' IS NOT NULL
`;

// ── The measures ───────────────────────────────────────────────────────
//
// One query each, all returning the same candidate shape. They read the
// platform's own tables directly rather than anything challenge-shaped: what
// makes somebody eligible for "Try 3 apps" is that they used three apps, and
// the app heartbeat already records that.
//
// Every windowed query takes ($1 start, $2 end) as timestamps; the four state
// measures take none. `date`-grained sources are compared as dates, which is
// the granularity `app_activity` has — a window that opens mid-day therefore
// counts that whole day. Weekly windows open at midnight, so this is exact
// for the case it is used in, and generous by at most a day otherwise.

// Apps the person did not make, with at least TRY_APPS_MIN_SECONDS (10, since
// #3570) in them. On a First challenge ($5, RULE_CHALLENGES_SQL's
// `first_challenge`) an app they made counts too (#4602).
const TRY_APPS_SQL = `
  SELECT aa.user_id, aa.app_id, a.name AS app_name,
         MAX(aa.date) AS last_date, SUM(aa.seconds_spent) AS seconds
    FROM app_activity aa
    JOIN apps a ON a.id = aa.app_id
   WHERE aa.date >= $1::date AND aa.date <= $2::date
     AND aa.user_id IS NOT NULL
     AND ($5::boolean OR a.created_by IS DISTINCT FROM aa.user_id)
   GROUP BY aa.user_id, aa.app_id, a.name
  HAVING SUM(aa.seconds_spent) >= $3
   ORDER BY aa.user_id ASC, MAX(aa.date) ASC, aa.app_id ASC
   LIMIT $4
`;

// Total active seconds across apps the person did not make.
const USE_APPS_MINUTES_SQL = `
  SELECT aa.user_id, MAX(aa.date) AS last_date, SUM(aa.seconds_spent) AS seconds
    FROM app_activity aa
    JOIN apps a ON a.id = aa.app_id
   WHERE aa.date >= $1::date AND aa.date <= $2::date
     AND aa.user_id IS NOT NULL
     AND a.created_by IS DISTINCT FROM aa.user_id
   GROUP BY aa.user_id
  HAVING SUM(aa.seconds_spent) >= $3
   ORDER BY aa.user_id ASC
   LIMIT $4
`;

// `promoted_at` is written by the human promote route only, so the rename and
// fleet-maintenance robots' own proposals are not somebody's first proposal.
const PROPOSAL_SENT_SQL = `
  SELECT cs.user_id, cs.id AS session_id, cs.promoted_at, cs.pr_title, a.name AS app_name
    FROM chat_sessions cs
    LEFT JOIN apps a ON a.id = cs.app_id
   WHERE cs.user_id IS NOT NULL
     AND cs.promoted_at >= $1 AND cs.promoted_at <= $2
   ORDER BY cs.user_id ASC, cs.promoted_at ASC, cs.id ASC
   LIMIT $3
`;

// The merge EVENT rather than the session, because it is the only record of
// whether an admin forced the merge — a forced merge is not a change the
// group accepted. The event is attributed to the PR's author, which is who
// the challenge is about.
const PROPOSAL_ACCEPTED_SQL = `
  SELECT e.id AS event_id, e.user_id, e.created_at, e.session_id,
         cs.pr_title, cs.spec_md, a.name AS app_name
    FROM events e
    JOIN chat_sessions cs ON cs.id = e.session_id
    LEFT JOIN apps a ON a.id = e.app_id
   WHERE e.event_type = 'pr_merged'
     AND e.user_id IS NOT NULL
     AND e.created_at >= $1 AND e.created_at <= $2
     AND COALESCE((e.metadata->>'forced')::boolean, FALSE) = FALSE
   ORDER BY e.user_id ASC, e.created_at ASC, e.id ASC
   LIMIT $3
`;

// Only reports that reached GitHub: a report whose issue call failed helped
// nobody, and the scorer must never pay for one.
//
// And only reports about somebody else's project, or about the platform
// itself (no app). A report on a project they made is a note to themselves,
// and a project only they are in ("Just you", by the audience test
// COMMUNITY_JOINED_SQL spells out below) has nobody else to tell. A
// newcomer's first session was paid twice for asking the bot to change their
// own solo app, by the First challenge and by the weekly one.
//
// Except on a First challenge ($4, RULE_CHALLENGES_SQL's `first_challenge`;
// #4603): "Send feedback" is there to show a newcomer how feedback works,
// and the project they made in their first session is the one they have
// something to say about. It is paid once in a life, so it is never paid
// twice; the weekly and repeatable challenges still leave it out.
const USEFUL_FEEDBACK_SQL = `
  SELECT fr.id, fr.user_id, fr.created_at, fr.title, fr.description, a.name AS app_name
    FROM feedback_reports fr
    LEFT JOIN apps a ON a.id = fr.app_id
   WHERE fr.created_at >= $1 AND fr.created_at <= $2
     AND fr.issue_number IS NOT NULL
     AND (fr.app_id IS NULL
          OR $4::boolean
          OR (a.created_by IS DISTINCT FROM fr.user_id
              AND (a.view_visibility = 'public'
                   OR (SELECT COUNT(*) FROM community_members o WHERE o.community_id = a.community_id) > 1
                   OR EXISTS (SELECT 1 FROM app_collaborators ic
                               WHERE ic.app_id = a.id AND ic.status = 'invited'))))
   ORDER BY fr.user_id ASC, fr.created_at ASC, fr.id ASC
   LIMIT $3
`;

// State, not an action: accounts linked before the season count.
const CONNECT_ACCOUNTS_SQL = `
  SELECT usi.user_id, usi.provider, usi.linked_at
    FROM user_social_identities usi
   ORDER BY usi.user_id ASC, usi.linked_at ASC, usi.id ASC
   LIMIT $1
`;

// Also state: asked for access, been released, or already produced.
const BLOCK_PRODUCTION_SQL = `
  SELECT u.id AS user_id,
         COALESCE(u.bp_requested_at, u.bp_released_at) AS at
    FROM users u
   WHERE u.bp_requested_at IS NOT NULL
      OR u.bp_released_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM epoch_stats es
                  WHERE es.user_id = u.id AND es.epoch_won_slots > 0)
   ORDER BY u.id ASC
   LIMIT $1
`;

// State: in a public or private community. The audience test is
// services/communities.js audienceSql written out, because a scorer query is
// a plain constant (scripts/check-sql.js reads it statically): view-public,
// or more than one member, or a pending invite. 'auto' rows and the
// platform's own project are left out — every account is put there without
// choosing it — and so is a project that never got built (or was deleted),
// the same status filter as the next measure.
const COMMUNITY_JOINED_SQL = `
  SELECT m.user_id, MIN(m.joined_at) AS joined_at
    FROM community_members m
    JOIN apps a ON a.community_id = m.community_id
   WHERE m.source <> 'auto'
     AND a.self_hosted = FALSE
     AND a.status NOT IN ('creating', 'failed', 'deleted')
     AND (a.view_visibility = 'public'
          OR (SELECT COUNT(*) FROM community_members o WHERE o.community_id = m.community_id) > 1
          OR EXISTS (SELECT 1 FROM app_collaborators ic
                      WHERE ic.app_id = a.id AND ic.status = 'invited'))
   GROUP BY m.user_id
   ORDER BY m.user_id ASC
   LIMIT $1
`;

// State: a project they made whose community is public or private, by the
// same audience test. One credit however many they made.
const COMMUNITY_APP_CREATED_SQL = `
  SELECT a.created_by AS user_id, MIN(a.created_at) AS created_at
    FROM apps a
   WHERE a.created_by IS NOT NULL
     AND a.self_hosted = FALSE
     AND a.status NOT IN ('creating', 'failed', 'deleted')
     AND (a.view_visibility = 'public'
          OR (SELECT COUNT(*) FROM community_members o WHERE o.community_id = a.community_id) > 1
          OR EXISTS (SELECT 1 FROM app_collaborators ic
                      WHERE ic.app_id = a.id AND ic.status = 'invited'))
   GROUP BY a.created_by
   ORDER BY a.created_by ASC
   LIMIT $1
`;

// People who came in by somebody's invite, credited to the inviter. Two
// records of an invite taken: a link followed and applied (a queued one
// counts on the day its person is let in), and a collaborator invite — by
// username, or by email once claimed — accepted. A link on an invite-only
// project writes both, which is why each person is taken once: the FIRST
// invite they took, across all time, names their one inviter. Without that,
// a handful of accounts joining each other's communities would pay every
// one of them.
const INVITES_JOINED_SQL = `
  SELECT f.inviter_id AS user_id, f.invitee_id, f.at, u.username AS invitee_username
    FROM (
      SELECT DISTINCT ON (t.invitee_id) t.inviter_id, t.invitee_id, t.at
        FROM (
          SELECT i.created_by AS inviter_id, x.user_id AS invitee_id, x.applied_at AS at
            FROM community_invite_redemptions x
            JOIN community_invites i ON i.id = x.invite_id
           WHERE x.status = 'joined' AND x.applied_at IS NOT NULL AND i.created_by IS NOT NULL
          UNION ALL
          SELECT c.invited_by, c.user_id, c.accepted_at
            FROM app_collaborators c
           WHERE c.status = 'member' AND c.invited_by IS NOT NULL AND c.accepted_at IS NOT NULL
        ) t
       WHERE t.inviter_id <> t.invitee_id
       ORDER BY t.invitee_id ASC, t.at ASC, t.inviter_id ASC
    ) f
    LEFT JOIN users u ON u.id = f.invitee_id
   WHERE f.at >= $1 AND f.at <= $2
   ORDER BY f.inviter_id ASC, f.at ASC, f.invitee_id ASC
   LIMIT $3
`;

// Somebody's earliest vote inside the window, on a proposal (pr_votes) or a
// request (issue_votes) that is not their own (#3569; why not, in
// ./challenge-rules.js VOTE_CAST). One row a person: it is a single
// completion, and DISTINCT ON keeps the rest of their votes out of the
// candidate limit.
//
// `created_at` on both tables is when the vote was LAST cast — a re-cast or
// a flip rewrites it — so "inside the window" reads "cast, or cast again,
// inside the window". That is the right reading for an action: a vote from
// last season re-cast this week is a vote this week.
//
// OR A LOOK AT THE WORKSHOP WHEN NOTHING WAS UP FOR A VOTE (evan,
// 2026-10-01). A newcomer whose communities have nothing waiting cannot do
// "Vote on an app" by voting, so the Getting started card sends them to the
// Workshop instead, and the server records that visit only when nothing was
// waiting for their vote (services/onboarding.js markWorkshopVisit, as
// `users.getting_started_seen.vote_workshop`, the last such visit). It is the
// third kind of row here, keyed `vote:workshop:<user id>`, with the same
// window and the same one credit a person: whichever came first inside the
// window, the vote or the look, is the credit. The CASE guards the cast, so
// a value that is not a timestamp is no row rather than a failed pass.
//
// TWO MORE VOTES THAT ARE NOT ON SOMEBODY ELSE'S CHANGE (Getting started,
// first-session test, 2026-10-03). The Homeroom bot writes the proposal for
// a request it builds, so the session's author is the bot, and "not their
// own" let a person's vote on the build of THEIR OWN request through: the
// tester asked the bot for an app, voted on its first version, and was paid
// for judging somebody else's change. So a vote on a bot build of a request
// they made (homeroom_bot_requesters) is left out, and so is any vote in a
// project only they are in ("Just you", by the audience test
// COMMUNITY_JOINED_SQL spells out above): nobody else's change can be up for
// a vote there. The look has no project, and is not affected. The filters
// run before DISTINCT ON, so the credit is their earliest vote that counts.
// routes/workshop-overview.js OWED_BY_COMMUNITY_SQL (`paying`) is the same
// test, so the card's Vote step only points at a vote that pays.
const VOTE_CAST_SQL = `
  SELECT DISTINCT ON (v.user_id) v.user_id, v.kind, v.ref_id, v.created_at, a.name AS app_name
    FROM (
      SELECT pv.user_id, 'pr' AS kind, pv.session_id AS ref_id, pv.created_at, cs.app_id
        FROM pr_votes pv
        JOIN chat_sessions cs ON cs.id = pv.session_id
       WHERE pv.created_at >= $1 AND pv.created_at <= $2
         AND cs.user_id IS DISTINCT FROM pv.user_id
         AND NOT EXISTS (SELECT 1 FROM homeroom_bot_requesters r
                          WHERE r.app_id = cs.app_id
                            AND r.issue_number = cs.created_from_issue_number
                            AND r.user_id = pv.user_id)
      UNION ALL
      SELECT iv.user_id, 'issue' AS kind, iv.issue_id AS ref_id, iv.created_at, i.app_id
        FROM issue_votes iv
        JOIN issues i ON i.id = iv.issue_id
       WHERE iv.created_at >= $1 AND iv.created_at <= $2
         AND i.created_by IS DISTINCT FROM iv.user_id
      UNION ALL
      SELECT w.user_id, 'workshop' AS kind, w.user_id AS ref_id, w.created_at, NULL AS app_id
        FROM (
          SELECT u.id AS user_id,
                 CASE WHEN (u.getting_started_seen->>'vote_workshop') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'
                      THEN (u.getting_started_seen->>'vote_workshop')::timestamptz END AS created_at
            FROM users u
           WHERE (u.getting_started_seen->>'vote_workshop') IS NOT NULL
        ) w
       WHERE w.created_at >= $1 AND w.created_at <= $2
    ) v
    LEFT JOIN apps a ON a.id = v.app_id
   WHERE v.user_id IS NOT NULL
     AND (v.app_id IS NULL
          OR a.view_visibility = 'public'
          OR (SELECT COUNT(*) FROM community_members o WHERE o.community_id = a.community_id) > 1
          OR EXISTS (SELECT 1 FROM app_collaborators ic
                      WHERE ic.app_id = a.id AND ic.status = 'invited'))
   ORDER BY v.user_id ASC, v.created_at ASC, v.kind ASC, v.ref_id ASC
   LIMIT $3
`;

// FEEDBACK_SENT reads exactly the reports USEFUL_FEEDBACK reads — sent inside
// the window, and reached GitHub — so it runs that same statement rather than
// a copy of it. What differs is what the plan does with them: one credit,
// ungraded (#3568).

// The query each measure runs, by measure. loadCandidates below names the
// constants directly — that is what keeps them statically checkable
// (scripts/check-sql.js) — and this map is for the one reader that needs them
// as DATA: the admin's "How it scores" panel (./challenge-anatomy.js), which
// prints the statement a rule actually executes. A test runs every measure
// against a recording pool and holds the two to the same text.
const MEASURE_SQL = Object.freeze({
  TRY_APPS: TRY_APPS_SQL,
  USE_APPS_MINUTES: USE_APPS_MINUTES_SQL,
  PROPOSAL_SENT: PROPOSAL_SENT_SQL,
  PROPOSAL_ACCEPTED: PROPOSAL_ACCEPTED_SQL,
  USEFUL_FEEDBACK: USEFUL_FEEDBACK_SQL,
  CONNECT_ACCOUNTS: CONNECT_ACCOUNTS_SQL,
  BLOCK_PRODUCTION_ON: BLOCK_PRODUCTION_SQL,
  COMMUNITY_JOINED: COMMUNITY_JOINED_SQL,
  COMMUNITY_APP_CREATED: COMMUNITY_APP_CREATED_SQL,
  INVITES_JOINED: INVITES_JOINED_SQL,
  VOTE_CAST: VOTE_CAST_SQL,
  FEEDBACK_SENT: USEFUL_FEEDBACK_SQL,
});

const isoOf = (v) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));
// A `date` column has no time, and node-postgres hands it back as a Date at
// LOCAL midnight. Taking that Date as-is stamps the credit a day early on any
// server east of UTC — which is not merely cosmetic: activity on the FIRST
// day of a window would then fall before the window opened, and the window
// guard in challenge-rules.planCredits would drop the credit entirely.
// Caught by the first end-to-end run, on a machine two hours ahead of UTC.
//
// So take the calendar date the column actually holds and pin it to noon UTC,
// which keeps the credit inside its own day in every timezone it is read in.
const dateToIso = (v) => {
  if (v == null) return null;
  const ymd = v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    : String(v).slice(0, 10);
  const d = new Date(`${ymd}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// Load the candidate units for one rule over one challenge.
// `ownApps`: the challenge is a First challenge (RULE_CHALLENGES_SQL's
// `first_challenge`), on which the person's own apps count for TRY_APPS and
// the feedback measures. False everywhere else.
async function loadCandidates(pool, measure, window, { target, ownApps = false }) {
  const own = ownApps === true;
  const spec = MEASURES[measure];
  if (!spec) return [];
  const startIso = window.startMs != null ? new Date(window.startMs).toISOString() : '1970-01-01T00:00:00.000Z';
  const endIso = window.endMs != null ? new Date(window.endMs).toISOString() : new Date(Date.now() + 86400000).toISOString();

  switch (measure) {
    case 'TRY_APPS': {
      const { rows } = await pool.query(TRY_APPS_SQL,
        [startIso, endIso, TRY_APPS_MIN_SECONDS, CANDIDATE_LIMIT, own]);
      return rows.map((r) => ({
        userId: r.user_id,
        sourceKey: `app:${r.app_id}`,
        activityAt: dateToIso(r.last_date),
        description: `Tried ${r.app_name || `app #${r.app_id}`}`,
      }));
    }
    case 'USE_APPS_MINUTES': {
      const seconds = Math.round(Number(target) * 60);
      const { rows } = await pool.query(USE_APPS_MINUTES_SQL,
        [startIso, endIso, seconds, CANDIDATE_LIMIT]);
      return rows.map((r) => ({
        userId: r.user_id,
        // One credit for the whole window, so the key names the window by
        // the day it starts: a weekly challenge's windows are its weeks.
        sourceKey: `window:${startIso.slice(0, 10)}`,
        activityAt: dateToIso(r.last_date),
        description: `${Math.floor(Number(r.seconds) / 60)} minutes in apps`,
      }));
    }
    case 'PROPOSAL_SENT': {
      const { rows } = await pool.query(PROPOSAL_SENT_SQL, [startIso, endIso, CANDIDATE_LIMIT]);
      return rows.map((r) => ({
        userId: r.user_id,
        sourceKey: `session:${r.session_id}`,
        activityAt: isoOf(r.promoted_at),
        description: r.app_name ? `Proposed a change to ${r.app_name}` : 'Sent a proposal',
      }));
    }
    case 'PROPOSAL_ACCEPTED': {
      const { rows } = await pool.query(PROPOSAL_ACCEPTED_SQL, [startIso, endIso, CANDIDATE_LIMIT]);
      return rows.map((r) => ({
        userId: r.user_id,
        sourceKey: `merged:${r.event_id}`,
        activityAt: isoOf(r.created_at),
        description: r.app_name ? `Accepted proposal on ${r.app_name}` : 'Accepted proposal',
        gradeInput: { appName: r.app_name, title: r.pr_title, text: r.spec_md },
      }));
    }
    case 'USEFUL_FEEDBACK': {
      const { rows } = await pool.query(USEFUL_FEEDBACK_SQL, [startIso, endIso, CANDIDATE_LIMIT, own]);
      return rows.map((r) => ({
        userId: r.user_id,
        sourceKey: `feedback:${r.id}`,
        activityAt: isoOf(r.created_at),
        description: r.app_name ? `Feedback on ${r.app_name}` : 'Feedback on Homeroom',
        gradeInput: { appName: r.app_name, title: r.title, text: r.description },
      }));
    }
    case 'CONNECT_ACCOUNTS': {
      const { rows } = await pool.query(CONNECT_ACCOUNTS_SQL, [CANDIDATE_LIMIT]);
      return rows.map((r) => ({
        userId: r.user_id,
        sourceKey: `provider:${r.provider}`,
        activityAt: isoOf(r.linked_at),
        description: `Connected ${r.provider === 'x' ? 'X' : 'GitHub'}`,
      }));
    }
    case 'BLOCK_PRODUCTION_ON': {
      const { rows } = await pool.query(BLOCK_PRODUCTION_SQL, [CANDIDATE_LIMIT]);
      return rows.map((r) => ({
        userId: r.user_id,
        sourceKey: 'block-production',
        activityAt: isoOf(r.at) || new Date().toISOString(),
        description: 'Block production is on',
      }));
    }
    case 'COMMUNITY_JOINED': {
      const { rows } = await pool.query(COMMUNITY_JOINED_SQL, [CANDIDATE_LIMIT]);
      return rows.map((r) => ({
        userId: r.user_id,
        sourceKey: 'community',
        activityAt: isoOf(r.joined_at) || new Date().toISOString(),
        description: 'Joined a community',
      }));
    }
    case 'COMMUNITY_APP_CREATED': {
      const { rows } = await pool.query(COMMUNITY_APP_CREATED_SQL, [CANDIDATE_LIMIT]);
      return rows.map((r) => ({
        userId: r.user_id,
        sourceKey: 'community-app',
        activityAt: isoOf(r.created_at) || new Date().toISOString(),
        description: 'Created an app for a community',
      }));
    }
    case 'INVITES_JOINED': {
      const { rows } = await pool.query(INVITES_JOINED_SQL, [startIso, endIso, CANDIDATE_LIMIT]);
      return rows.map((r) => ({
        userId: r.user_id,
        sourceKey: `invitee:${r.invitee_id}`,
        activityAt: isoOf(r.at),
        description: r.invitee_username ? `@${r.invitee_username} joined by your invite` : 'Somebody joined by your invite',
      }));
    }
    case 'VOTE_CAST': {
      const { rows } = await pool.query(VOTE_CAST_SQL, [startIso, endIso, CANDIDATE_LIMIT]);
      return rows.map((r) => ({
        userId: r.user_id,
        // Names the proposal or request the paid vote was on, or the
        // person whose Workshop visit stood in for one.
        sourceKey: `vote:${r.kind}:${r.ref_id}`,
        activityAt: isoOf(r.created_at),
        description: r.kind === 'workshop'
          ? 'Looked at the Workshop when nothing was up for a vote'
          : (r.app_name ? `Voted on a change to ${r.app_name}` : 'Voted on a change'),
      }));
    }
    case 'FEEDBACK_SENT': {
      const { rows } = await pool.query(USEFUL_FEEDBACK_SQL, [startIso, endIso, CANDIDATE_LIMIT, own]);
      return rows.map((r) => ({
        userId: r.user_id,
        sourceKey: `feedback:${r.id}`,
        activityAt: isoOf(r.created_at),
        description: r.app_name ? `Sent feedback on ${r.app_name}` : 'Sent feedback on Homeroom',
        // Not graded: the text is here for the junk filter alone.
        gradeInput: { appName: r.app_name, title: r.title, text: r.description },
      }));
    }
    default:
      return [];
  }
}

async function loadCredited(pool, challengeId) {
  const { rows } = await pool.query(CREDITED_SQL, [challengeId]);
  const map = new Map();
  for (const r of rows) {
    const userId = Number(r.user_id);
    const state = map.get(userId) || { keys: new Set(), count: 0, weeks: new Map() };
    state.keys.add(r.source_key);
    state.count += 1;
    const at = r.activity_at instanceof Date ? r.activity_at.getTime() : Date.parse(r.activity_at);
    if (Number.isFinite(at)) {
      const week = rules.weekStartMs(at);
      state.weeks.set(week, (state.weeks.get(week) || 0) + 1);
    }
    map.set(userId, state);
  }
  return map;
}

// One credit → one ledger row, in the shape the ZKPassport route established.
//
// `metadata.kind = 'challenge_completion'` is load-bearing rather than
// decorative: `user_activities_completion_unique` keys on it, and the home
// panel's "done" rule reads it. Counted measures must NOT carry it — three
// tried apps are three rows, and the completion index would reject the second
// one.
const INSERT_SQL = `
  INSERT INTO user_activities
    (user_id, season_event_id, activity_type, points, description, metadata,
     activity_at, source, challenge_id, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'challenge_scorer', $8, NOW(), NOW())
  ON CONFLICT DO NOTHING
  RETURNING id
`;

async function writeCredits(pool, { challenge, activityType, credits }) {
  let written = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const credit of credits) {
      const metadata = {
        source_key: credit.sourceKey,
        rule_id: credit.ruleId,
        measure: credit.measure,
        ...(credit.completion ? { kind: 'challenge_completion' } : {}),
        ...(credit.grade ? { grade: credit.grade } : {}),
      };
      const { rows } = await client.query(INSERT_SQL, [
        credit.userId,
        challenge.season_event_id,
        activityType,
        credit.points,
        credit.description,
        JSON.stringify(metadata),
        credit.activityAt || new Date().toISOString(),
        challenge.challenge_id,
      ]);
      if (rows.length) written += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return written;
}

// ── One run ────────────────────────────────────────────────────────────
//
// Returns a summary rather than logging one, because the same shape is what a
// DRY RUN shows the operator and what `challenge_scorer_runs.summary` stores.
// A dry run does every read, every plan and no grading (grading costs money
// and a preview should not), and writes nothing.
//
// `only` is the set of rule ids this run covers — what the schedule passes,
// having worked out which rules are due. Left out, the run covers every rule:
// that is Run now and Dry run, where an operator pressing the button means
// all of it, whatever the intervals say.

// One challenge under one rule. `run` is the state the whole run shares — the
// two budgets, above all. Returns the summary entry, and whether the pass got
// to the end of what it had to do: false only when one of the RUN's budgets
// cut it short, which is the one case where the rest is waiting on this
// service rather than on the world.
async function scoreChallenge(pool, row, rule, run) {
  const entry = {
    rule_id: Number(rule.id),
    rule: rule.name,
    measure: rule.measure,
    challenge_id: Number(row.challenge_id),
    goal: row.t_goal,
    credits: 0,
    points: 0,
  };

  const skip = rules.skipReason(rule, row, { now: run.now });
  if (skip) {
    entry.skipped = skip;
    run.summary.skipped += 1;
    return { entry, complete: true };
  }

  const window = rules.resolveWindow(row, { now: run.now });
  const target = rules.effectiveTarget(rule, row);
  // A WEEKLY challenge is scored a week at a time (rules.weeklyWindows): this
  // week, plus last week while its grace lasts. The measure's own query runs
  // once per week, so "10 minutes" means 10 minutes in that week and each
  // week's unit has a key of its own.
  const windows = rules.isWeekly(row) ? rules.weeklyWindows(window, { now: run.now }) : [window];
  let candidates;
  try {
    candidates = [];
    for (const w of windows) {
      candidates = candidates.concat(await loadCandidates(pool, rule.measure, w, {
        target, ownApps: row.first_challenge === true,
      }));
    }
  } catch (err) {
    entry.error = err.message;
    log.warn('challenge-scorer', 'Measure query failed', { measure: rule.measure, err: err.message });
    // Complete, on purpose: a query that fails now will fail in a minute
    // too, and a broken rule should retry on its interval, not on every beat.
    return { entry, complete: true };
  }
  entry.candidates = candidates.length;

  // The deterministic pre-filter runs BEFORE the plan, over everything the
  // person sent in the window, in the order they sent it. Two things depend
  // on that order, and the first end-to-end run caught both:
  //
  //   - Junk must never hold a weekly slot. Planning first handed the four
  //     slots to somebody's four "test" reports, the filter then dropped
  //     them, nothing was written — and the next tick planned the same four
  //     again. Their real reports, queued behind, were never paid at all.
  //   - A duplicate is a duplicate of what was already PAID, too. The bag
  //     used to start empty each run and see only the uncredited batch, so
  //     the same sentence sent again after the next tick earned a second
  //     credit. Walking the credited units as well puts their text in the
  //     bag first; the plan drops them afterwards by source key, as before.
  //
  // Keyed on `screened`, not `graded` (#3568): FEEDBACK_SENT is never graded
  // but is filtered all the same, so "Suggest an improvement" is not done by
  // a report that says "test". PROPOSAL_ACCEPTED is graded and not screened
  // — an accepted proposal passed a group vote — which the filter already
  // answered by passing everything.
  if (MEASURES[rule.measure].screened) {
    const seen = new Map();
    candidates = candidates.filter((candidate) => {
      const bag = seen.get(candidate.userId) || new Set();
      seen.set(candidate.userId, bag);
      if (!grader.preFilter(rule.measure, candidate.gradeInput, bag)) return true;
      entry.rejected = (entry.rejected || 0) + 1;
      return false;
    });
  }

  const credited = await loadCredited(pool, row.challenge_id);
  let planned = rules.planCredits(rule, row, { candidates, credited, now: run.now });
  let complete = true;

  if (planned.length > run.budget) {
    planned = planned.slice(0, run.budget);
    complete = false;
  }

  if (MEASURES[rule.measure].graded && !run.dryRun) {
    if (planned.length > run.grades) complete = false;
    const toGrade = planned.slice(0, run.grades)
      .map((c) => ({ ...c, measure: rule.measure }));
    // A grader that stops (no key, an outage) leaves `complete` alone: the
    // rest is waiting on the model, and retrying it every beat instead of
    // every interval would turn one outage into sixty failed calls an hour.
    const gradedCredits = await grader.gradeAll(toGrade, {
      apiKey: run.apiKey,
      llm: run.llm,
      onError: (err) => { run.summary.grading = err.message; },
    });
    run.grades -= gradedCredits.length;
    run.summary.graded += gradedCredits.length;
    entry.graded = gradedCredits.length;
    planned = gradedCredits;
  } else if (MEASURES[rule.measure].graded && run.dryRun) {
    // A preview says what it WOULD grade; it does not spend the call.
    entry.to_grade = planned.length;
    planned = [];
  }

  entry.credits = planned.length;
  entry.points = planned.reduce((sum, c) => sum + (Number(c.points) || 0), 0);

  if (planned.length && !run.dryRun) {
    const written = await writeCredits(pool, {
      challenge: row,
      activityType: rules.activityTypeFor(row),
      credits: planned.map((c) => ({ ...c, ruleId: Number(rule.id), measure: rule.measure })),
    });
    entry.credits = written;
    run.budget -= written;
  } else if (planned.length) {
    run.budget -= planned.length;
  }

  run.summary.credits += entry.credits;
  return { entry, complete };
}

// What a rule's last pass cost, kept ON the rule. The run history holds the
// newest ten runs, and on a deployment where one rule runs every minute those
// ten are all that rule's — so an hourly rule's last pass would never be in
// them. The admin's rule detail reads this instead, and the numbers it shows
// for "how much does this rule cost" are measured rather than argued.
const STAMP_SCORED_SQL = `
  UPDATE challenge_scoring_rules SET last_scored_at = $2, last_pass = $3 WHERE id = $1
`;
const STAMP_CUT_SHORT_SQL = `
  UPDATE challenge_scoring_rules SET last_pass = $2 WHERE id = $1
`;

async function score(pool, {
  dryRun = false, now = Date.now(), apiKey = null, llm = null, only = null,
} = {}) {
  const summary = { challenges: [], credits: 0, graded: 0, skipped: 0, grading: null };
  const { rows } = await pool.query(RULE_CHALLENGES_SQL, [ONBOARDING_LIMIT]);
  const run = {
    summary, dryRun, now, apiKey, llm,
    budget: MAX_CREDITS_PER_RUN,
    grades: MAX_GRADES_PER_RUN,
  };

  // One group per rule, its challenges under it, in the order the run takes
  // them (rules.runOrder: cheap before graded, longest-waiting first).
  const groups = new Map();
  for (const row of rows) {
    const id = Number(row.rule_id);
    if (only && !only.has(id)) continue;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        measure: row.measure,
        lastScoredAt: row.rule_last_scored_at,
        rule: {
          id: row.rule_id,
          name: row.rule_name,
          measure: row.measure,
          target: row.rule_target,
          points: row.rule_points,
          enabled: row.rule_enabled,
        },
        rows: [],
      });
    }
    groups.get(id).rows.push(row);
  }

  const passes = [];
  for (const group of [...groups.values()].sort(rules.runOrder)) {
    // A rule the budget never reached is left unstamped, so it is still due
    // on the next beat — and, having waited longest, first in line for it.
    if (run.budget <= 0) break;
    const started = Date.now();
    const pass = { id: group.id, complete: true, candidates: 0, credits: 0, points: 0, graded: 0, rejected: 0 };
    for (const row of group.rows) {
      if (run.budget <= 0) { pass.complete = false; break; }
      const { entry, complete } = await scoreChallenge(pool, row, group.rule, run);
      summary.challenges.push(entry);
      if (!complete) pass.complete = false;
      pass.candidates += entry.candidates || 0;
      pass.credits += entry.credits || 0;
      pass.points += entry.points || 0;
      pass.graded += entry.graded || 0;
      pass.rejected += entry.rejected || 0;
      if (entry.error) pass.error = entry.error;
    }
    pass.ms = Date.now() - started;
    // The run summary carries the cost per rule as well, on the rule's first
    // entry: a dry run stamps nothing, and its preview is where an operator
    // looks to see what a rule would cost before switching it on.
    const first = summary.challenges.find((e) => e.rule_id === group.id);
    if (first) first.ms = pass.ms;
    passes.push(pass);
  }

  if (!dryRun) {
    const at = new Date(now).toISOString();
    const reached = new Set(passes.map((p) => p.id));
    for (const pass of passes) {
      const { id, complete, ...facts } = pass;
      const lastPass = JSON.stringify({ at, ...facts, ...(complete ? {} : { cut_short: true }) });
      if (complete) await pool.query(STAMP_SCORED_SQL, [id, at, lastPass]);
      else await pool.query(STAMP_CUT_SHORT_SQL, [id, lastPass]);
    }
    // A due rule with no live challenge at all has nothing to score, and has
    // to be stamped all the same — or it is due again on every beat, and
    // every beat becomes a run.
    if (only) {
      for (const id of only) {
        if (reached.has(id) || groups.has(id)) continue;
        await pool.query(STAMP_SCORED_SQL, [id, at, JSON.stringify({ at, ms: 0, candidates: 0, credits: 0, idle: 'no live challenge' })]);
      }
    }
  }

  return summary;
}

// ── The tick ───────────────────────────────────────────────────────────

const RUN_START_SQL = `
  INSERT INTO challenge_scorer_runs (trigger, dry_run) VALUES ($1, $2) RETURNING id
`;
const RUN_END_SQL = `
  UPDATE challenge_scorer_runs
     SET finished_at = NOW(), credits = $2, summary = $3, error = $4
   WHERE id = $1
`;
// The newest snapshot generation: when it was taken (`at`, its snapshot_at)
// and when it was last written (`fresh`), which a refresh in place moves on
// while `at` stays put.
const LAST_AGGREGATE_SQL = `
  SELECT ls.snapshot_at AS at, MAX(COALESCE(ls.updated_at, ls.created_at, ls.snapshot_at)) AS fresh
    FROM leaderboard_snapshots ls
   WHERE ls.snapshot_at = (SELECT MAX(snapshot_at) FROM leaderboard_snapshots)
   GROUP BY ls.snapshot_at
`;

// Whether the ledger holds anything written after the standings were: a
// scorer credit, an admin's manual one, a passport proof, an edit.
const LEDGER_NEWER_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM user_activities
     WHERE COALESCE(updated_at, created_at) > $1
  ) AS newer
`;

// The scorer writes the ledger; the snapshot builder turns the ledger into
// standings. Progress rails read the ledger directly, so a credit shows up
// on the card within a tick, and the standings have to keep up with it.
//
// Two rhythms, because the snapshots are two things. They are the CURRENT
// totals the leaderboard prints, and they are the HISTORY the standings chart
// draws: each new snapshot_at is a point, and an event keeps only the ten
// newest. So a new point is taken every `hours` (6 by default), and in
// between, whenever the ledger has anything newer than the latest snapshot,
// that snapshot is REWRITTEN in place (the builder upserts on its
// snapshot_at). Totals catch up within one check, about ten minutes, and the
// chart keeps hours of history rather than the last hour and a half.
//
// Before this, totals waited for the next new point: a member saw "750 pts
// earned" on the challenge and 500 fewer on the leaderboard for up to six
// hours, and read it as lost points (#3650).
async function maybeAggregate(pool, { hours, now = Date.now() }) {
  if (!(hours > 0)) return null;
  const { rows } = await pool.query(LAST_AGGREGATE_SQL);
  const last = rows[0] && rows[0].at ? new Date(rows[0].at) : null;
  const { buildSnapshots } = require('./snapshot-builder');
  if (last == null || now - last.getTime() >= hours * 3600000) {
    const result = await buildSnapshots(pool);
    return { events: result.events.length };
  }
  const fresh = rows[0].fresh ? new Date(rows[0].fresh) : last;
  const { rows: newer } = await pool.query(LEDGER_NEWER_SQL, [fresh]);
  if (!newer[0] || newer[0].newer !== true) return null;
  const result = await buildSnapshots(pool, { now: last });
  return { events: result.events.length, refreshed: true };
}

// One complete run, recorded. Exported so the admin's Run now and Dry run
// buttons and the tests take exactly the path the schedule takes. The
// schedule narrows it with `only` (the rules that are due) and decides
// `aggregate` itself; an operator's run covers every rule and always checks
// the standings.
async function runOnce(pool, {
  trigger = 'schedule', dryRun = false, config = null, now = Date.now(), only = null, aggregate = true,
} = {}) {
  const { rows } = await pool.query(RUN_START_SQL, [trigger, dryRun]);
  const runId = rows[0] && rows[0].id;
  const apiKey = (config && config.anthropicApiKey) || null;
  try {
    const summary = await score(pool, { dryRun, now, apiKey, only });
    if (!dryRun && aggregate) {
      const hours = aggregateHours(config);
      try {
        const aggregated = await maybeAggregate(pool, { hours, now });
        if (aggregated) summary.aggregated = aggregated;
      } catch (err) {
        summary.aggregate_error = err.message;
        log.warn('challenge-scorer', 'Aggregate after scoring failed', { err: err.message });
      }
    }
    await pool.query(RUN_END_SQL, [runId, summary.credits, JSON.stringify(summary), null]);
    return { runId, ...summary };
  } catch (err) {
    await pool.query(RUN_END_SQL, [runId, 0, null, err.message]).catch(() => {});
    throw err;
  }
}

function intervalMinutes(config) {
  const raw = config && config.challengeScorer ? config.challengeScorer.intervalMinutes : undefined;
  const n = Number(raw ?? DEFAULT_INTERVAL_MINUTES);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_MINUTES;
}

function aggregateHours(config) {
  const raw = config && config.challengeScorer ? config.challengeScorer.aggregateHours : undefined;
  const n = Number(raw ?? DEFAULT_AGGREGATE_HOURS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AGGREGATE_HOURS;
}

// Which rules are due on this beat. Enabled rules only: one that is switched
// off has nothing to run, and leaving it out keeps it from making a run out
// of a beat that had no other reason to be one.
const DUE_RULES_SQL = `
  SELECT id, measure, interval_minutes, last_scored_at
    FROM challenge_scoring_rules
   WHERE enabled = TRUE
`;
const LAST_SCHEDULED_RUN_SQL = `
  SELECT MAX(started_at) AS at FROM challenge_scorer_runs
   WHERE trigger = 'schedule' AND dry_run = FALSE
`;

async function dueRuleIds(pool, { now = Date.now(), defaultMinutes } = {}) {
  const { rows } = await pool.query(DUE_RULES_SQL);
  const due = new Set();
  for (const row of rows) {
    const rule = { id: row.id, intervalMinutes: row.interval_minutes, lastScoredAt: row.last_scored_at };
    if (rules.isDue(rule, { now, defaultMinutes })) due.add(Number(row.id));
  }
  return due;
}

// ── What the challenge list says about the schedule ────────────────────
//
// The public challenge list tells a participant, under each card's rail, how
// often the challenge is counted and when it last was (#3185;
// rules.cadenceOf). One read for the whole list: the enabled rules bound to
// any of its challenges or their templates, beside the event's dates, which a
// challenge with none of its own takes its window from. Scoped the way
// RULE_CHALLENGES_SQL is, so an event the scorer never looks at returns no
// rules and its cards promise nothing.
const CADENCE_RULES_SQL = `
  /* challenge scoring cadence */
  SELECT r.id, r.measure, r.target, r.points, r.challenge_id, r.challenge_template_id,
         r.interval_minutes, r.last_scored_at,
         se.starts_at AS event_starts_at, se.ends_at AS event_ends_at
    FROM challenge_scoring_rules r
    JOIN season_events se ON se.id = $1
    LEFT JOIN seasons s ON s.id = se.season_id
   WHERE r.enabled = TRUE
     AND (r.challenge_id = ANY($2::bigint[]) OR r.challenge_template_id = ANY($3::bigint[]))
     AND se.internal = FALSE
     AND se.is_active = TRUE AND COALESCE(s.is_active, FALSE) = TRUE
   ORDER BY r.id ASC
`;

// `rows` are the list's own joined challenge rows (challenge columns bare,
// template columns `t_`), which carry every field skipReason reads. Returns
// two Maps keyed by challenge id, each holding only the challenges something
// counts: `cadence` -> { intervalMinutes, lastScoredAt } (rules.cadenceOf),
// and `countedBy` -> { measure, target } (rules.countedByOf). Asks Postgres
// nothing when the schedule is off (a default of 0 runs no rule at all) or
// the list is empty.
async function loadRuleFacts(pool, eventId, rows, { defaultMinutes, now = Date.now() } = {}) {
  const cadence = new Map();
  const countedBy = new Map();
  const out = { cadence, countedBy };
  if (!(Number(defaultMinutes) > 0) || !rows || !rows.length) return out;
  const templateIds = [...new Set(rows.map((r) => r.challenge_template_id)
    .filter((v) => v != null).map(Number))];
  const { rows: ruleRows } = await pool.query(CADENCE_RULES_SQL, [
    eventId, rows.map((r) => Number(r.id)), templateIds,
  ]);
  if (!ruleRows.length) return out;
  const { event_starts_at, event_ends_at } = ruleRows[0];
  for (const row of rows) {
    const bound = ruleRows
      .filter((r) => (r.challenge_id != null && Number(r.challenge_id) === Number(row.id))
        || (r.challenge_template_id != null && Number(r.challenge_template_id) === Number(row.challenge_template_id)))
      .map((r) => ({
        id: r.id,
        measure: r.measure,
        target: r.target,
        points: r.points,
        enabled: true,
        intervalMinutes: r.interval_minutes,
        lastScoredAt: r.last_scored_at,
      }));
    const at = { ...row, event_starts_at, event_ends_at };
    const c = rules.cadenceOf(bound, at, { now, defaultMinutes });
    if (c) cadence.set(Number(row.id), c);
    const by = rules.countedByOf(bound, at, { now, defaultMinutes });
    if (by) countedBy.set(Number(row.id), by);
  }
  return out;
}

// The cadence half alone: Map of challenge id -> { intervalMinutes, lastScoredAt }.
async function loadCadence(pool, eventId, rows, opts = {}) {
  return (await loadRuleFacts(pool, eventId, rows, opts)).cadence;
}

// When this process last looked at the standings. In memory, and per process,
// because all it guards is a rebuild that produces nothing: a deployment with
// no event to score has no snapshot, `maybeAggregate` finds none and tries
// again — once per run, which used to mean every ten minutes and would now
// mean every beat.
let lastAggregateCheckAt = 0;

// One beat of the schedule. Advisory-locked and `pg_try_advisory_lock`, not
// the waiting kind: every platform instance runs this timer, and a beat that
// cannot take the lock has nothing useful to do — the instance holding it is
// already writing the same credits.
//
// A beat with nothing due is not a run and records nothing, with one
// exception. The service has to be seen to be alive, and the standings have
// to keep being rebuilt on a deployment with no rules at all — so a quiet
// stretch still gets one run per default interval, which is exactly how often
// every run happened before rules carried intervals of their own. That clock
// is read from the run history rather than kept in memory, so two instances
// share one heartbeat and a deploy does not start with an empty run.
async function tick(pool, config, { now = Date.now() } = {}) {
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired', [CHALLENGE_SCORER_LOCK, 0]
    );
    if (lock.rows[0]?.acquired !== true) return { busy: true };
    locked = true;

    const defaultMinutes = intervalMinutes(config);
    const defaultMs = defaultMinutes * 60_000;
    const due = await dueRuleIds(pool, { now, defaultMinutes });
    if (!due.size) {
      const { rows } = await pool.query(LAST_SCHEDULED_RUN_SQL);
      const last = rows[0] && rows[0].at ? new Date(rows[0].at).getTime() : null;
      if (last != null && now - last < defaultMs - rules.DUE_SLACK_MS) return { idle: true };
    }
    const aggregate = now - lastAggregateCheckAt >= defaultMs - rules.DUE_SLACK_MS;
    if (aggregate) lastAggregateCheckAt = now;
    return await runOnce(pool, { trigger: 'schedule', config, now, only: due, aggregate });
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [CHALLENGE_SCORER_LOCK, 0]).catch(() => {});
    }
    client.release();
  }
}

// ── On the moment it happens (#3564, #3568, #3569, #3570) ──────────────
//
// "Find people to build with" is COMMUNITY_JOINED, a STATE measure, and the
// schedule finds a state on that rule's next pass: up to ten minutes after
// the join by default, an hour for a rule set to hourly. For this challenge
// that gap is the whole experience. Somebody taps Join, opens Challenges to
// see it tick, reads "Not started · next count 12:58" — and, reasonably,
// reports it broken, which is what #3564 was. The card cannot tell "not yet
// counted" from "does not count", so the honest fix is to count at once.
//
// So every door a person joins a community through — the Join button, the
// join screen, an invite link, an accepted invite — calls this after the
// join, and the rules on the two community STATE measures run there and
// then, through score(): the same reads, the same plan, the same ledger
// writes and the same stamp as a scheduled pass of those rules, so a join
// cannot pay differently from the schedule. Both measures, because a join
// can start either state: the joiner is now in a community, and the project
// they came into may have stopped being "Just you" at that moment (an
// invite link into a private one does exactly that), which is its
// creator's "Build for your community", and their "Find people to build
// with", on the same tap.
//
// The schedule stays the source of truth and the backstop. A membership
// that arrives by trigger (a queued invite applied when its person is let
// in, the dapp.json reconcile) has no door to call this from,
// and is counted on the rule's next pass as before; so is any future door
// that forgets to. A Home pin joins by trigger as well, but it has a door:
// POST /api/apps/:slug/favorite calls this when its pin was the join (#4600,
// Home's featured list). Nothing here is required for correctness, only for
// speed.
//
// The same gap, at the other First challenges. "Suggested an improvement,
// but the challenge still says not started" (#3568) was the report, about
// steps whose whole point is to get a newcomer to the rest of the season
// quickly (#3569). So the join's pass became one instance of
// scoreOn(pool, config, measures), and each action calls it at its own door
// with the measures that action can complete:
//
//   a join              COMMUNITY_JOINED, COMMUNITY_APP_CREATED  scoreOnJoin
//   a vote              VOTE_CAST       routes/votes.js, routes/issues.js,
//                                       and the Vote step's Workshop visit
//                                       (routes/onboarding.js)
//   a report            FEEDBACK_SENT   routes/feedback.js
//   an app's heartbeat  TRY_APPS, on the crossing only (scoreOnAppTime)
//
// The same guarantees at every door. A no-op when the deployment has
// switched automatic scoring off (interval 0) — "off" means the admin's Run
// now is the only thing that scores — and when no enabled rule uses any of
// the measures, which costs one small read. Never throws: an action that
// worked must not answer 500 because a challenge could not be counted, and
// the schedule will count it anyway. Never a model call: a graded measure is
// dropped from the list, because nobody's tap should wait on one.
//
// Paying twice is impossible in one of two ways, by the kind of measure:
//
//   A SINGLE COMPLETION (every one of them but TRY_APPS) runs outside the
//   tick's advisory lock, on purpose and safely: a pass racing a tick, or
//   another action, collides on `user_activities_completion_unique` (one
//   completion a person a challenge) and the loser's insert does nothing.
//
//   A COUNTED measure's cap is enforced by the plan, not by an index, and
//   two plans at once could each pay a different "last unit" — the whole
//   reward, twice. That is why INVITES_JOINED is not run on the spot at all,
//   and why TRY_APPS (counted: "Try an app" is a count of one) is run only
//   under the lock the tick plans under. Taken with pg_try_advisory_lock,
//   not the waiting kind: when the tick, or another heartbeat's pass,
//   already holds it, this pass is skipped and answers { busy: true }, and
//   the crossing is counted on the rule's next pass — a few minutes late,
//   never twice.
const JOIN_MEASURES = Object.freeze(['COMMUNITY_JOINED', 'COMMUNITY_APP_CREATED']);
const VOTE_MEASURES = Object.freeze(['VOTE_CAST']);
const FEEDBACK_MEASURES = Object.freeze(['FEEDBACK_SENT']);
const APP_TIME_MEASURES = Object.freeze(['TRY_APPS']);
// Every door and what it runs, as data for the one reader that needs the
// whole map: the admin's "How it scores" panel (./challenge-anatomy.js),
// which tells an operator choosing a rule's interval that it is the backstop.
const ON_THE_SPOT = Object.freeze({
  join: JOIN_MEASURES,
  vote: VOTE_MEASURES,
  feedback: FEEDBACK_MEASURES,
  appTime: APP_TIME_MEASURES,
});
const ON_THE_SPOT_RULES_SQL = `
  SELECT id, measure FROM challenge_scoring_rules
   WHERE enabled = TRUE AND measure = ANY($1::text[])
`;

async function scoreOn(pool, config, measures, { now = Date.now() } = {}) {
  if (!(intervalMinutes(config) > 0)) return null;
  const wanted = [...new Set(measures || [])].filter((m) => MEASURES[m] && !MEASURES[m].graded);
  if (!wanted.length) return null;
  let client = null;
  let locked = false;
  try {
    const { rows } = await pool.query(ON_THE_SPOT_RULES_SQL, [wanted]);
    if (!rows.length) return null;
    if (rows.some((r) => MEASURES[r.measure] && MEASURES[r.measure].counted)) {
      client = await pool.connect();
      const lock = await client.query(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired', [CHALLENGE_SCORER_LOCK, 0]
      );
      if (lock.rows[0]?.acquired !== true) return { busy: true };
      locked = true;
    }
    return await score(pool, { now, only: new Set(rows.map((r) => Number(r.id))) });
  } catch (err) {
    log.warn('challenge-scorer', 'Scoring on the spot failed; the schedule will count it', {
      measures: wanted, err: err.message,
    });
    return null;
  } finally {
    if (client) {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [CHALLENGE_SCORER_LOCK, 0]).catch(() => {});
      }
      client.release();
    }
  }
}

// The doors that need nothing but the call. Named, rather than each route
// spelling out its measure list, so the lists live beside ON_THE_SPOT and a
// test can hold every door to them.
const scoreOnJoin = (pool, config, opts) => scoreOn(pool, config, JOIN_MEASURES, opts);
const scoreOnVote = (pool, config, opts) => scoreOn(pool, config, VOTE_MEASURES, opts);
const scoreOnFeedback = (pool, config, opts) => scoreOn(pool, config, FEEDBACK_MEASURES, opts);

// ── The heartbeat's crossing (#3570) ───────────────────────────────────
//
// The app heartbeat (routes/apps.js, POST /api/apps/:slug/activity) reports
// somebody's seconds in an app as they use it and when they leave it. A pass
// on each would be a TRY_APPS read for every heartbeat on the platform, and
// the only heartbeat that can change TRY_APPS is the one that takes that
// person's time in that app across TRY_APPS_MIN_SECONDS. So:
//
//   1. an app they made is read like any other since #4602: it counts for
//      the First challenge's "Try an app" (RULE_CHALLENGES_SQL's
//      `first_challenge`), and the pass's own TRY_APPS query leaves it out
//      of every other challenge;
//   2. if today's row was already at the floor before this heartbeat, so was
//      the total — no read, which is every heartbeat after a day's first;
//   3. otherwise one indexed SUM of their time in that app, every day, and a
//      pass only when this heartbeat took it from below the floor to at or
//      past it: once in a person's life per app.
//
// Every day rather than the challenge's window, because the route knows no
// window and there may be several. The two differ in one case only: time in
// an app from before the window, topped up inside it. That crossing happened
// before the window, so the pass it ran then found nothing, and the in-window
// top-up is counted by the schedule, as everything was before this. Never
// throws, like scoreOn.
const APP_TIME_SQL = `
  SELECT COALESCE(SUM(seconds_spent), 0)::bigint AS total
    FROM app_activity
   WHERE app_id = $1 AND user_id = $2
`;

async function scoreOnAppTime(pool, config, {
  appId, userId, seconds, daySeconds, now = Date.now(),
} = {}) {
  if (!(intervalMinutes(config) > 0)) return null;
  if (appId == null || userId == null) return null;
  const added = Number(seconds);
  if (!(Number(daySeconds) - added < TRY_APPS_MIN_SECONDS)) return null;
  try {
    const { rows } = await pool.query(APP_TIME_SQL, [appId, userId]);
    const after = Number(rows[0] && rows[0].total) || 0;
    if (!rules.crossedTryAppsFloor({ before: after - added, after })) return null;
  } catch (err) {
    log.warn('challenge-scorer', 'Reading app time failed; the schedule will count it', { err: err.message });
    return null;
  }
  return scoreOn(pool, config, APP_TIME_MEASURES, { now });
}

function start(config) {
  if (timer) return;
  const minutes = intervalMinutes(config);
  if (!minutes) {
    log.info('challenge-scorer', 'Automatic challenge scoring is off (interval 0)');
    return;
  }
  const { getPool } = require('../../db/pool');
  const run = () => {
    if (inFlight) return inFlight;
    inFlight = tick(getPool(config), config)
      .then((result) => {
        if (result && result.credits) {
          log.info('challenge-scorer', 'Credits written', {
            credits: result.credits, graded: result.graded,
          });
        }
      })
      .catch((err) => log.error('challenge-scorer', 'Run failed', { err: err.message }))
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  // The beat, not the interval: `minutes` is now how often a rule runs when
  // it does not say otherwise, and which rules a beat runs is tick()'s call.
  timer = setInterval(run, rules.FLOOR_MINUTES * 60_000);
  if (typeof timer.unref === 'function') timer.unref();
  // Deploys frequently replace the leader before its first tick, so a season
  // could otherwise go a whole cadence unscored after every release.
  setTimeout(run, 30_000).unref?.();
}

async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}

module.exports = {
  score,
  runOnce,
  tick,
  scoreOn,
  scoreOnJoin,
  scoreOnVote,
  scoreOnFeedback,
  scoreOnAppTime,
  start,
  stop,
  maybeAggregate,
  loadCandidates,
  loadCredited,
  dueRuleIds,
  loadCadence,
  loadRuleFacts,
  intervalMinutes,
  aggregateHours,
  LAST_AGGREGATE_SQL,
  LEDGER_NEWER_SQL,
  MAX_CREDITS_PER_RUN,
  MAX_GRADES_PER_RUN,
  CANDIDATE_LIMIT,
  RULE_CHALLENGES_SQL,
  ONBOARDING_LIMIT,
  CADENCE_RULES_SQL,
  CREDITED_SQL,
  MEASURE_SQL,
  JOIN_MEASURES,
  ON_THE_SPOT,
  ON_THE_SPOT_RULES_SQL,
  APP_TIME_SQL,
  dateToIso,
};
