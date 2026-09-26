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
const RULE_CHALLENGES_SQL = `
  SELECT r.id AS rule_id, r.name AS rule_name, r.measure, r.target AS rule_target,
         r.points AS rule_points, r.enabled AS rule_enabled,
         r.interval_minutes AS rule_interval_minutes, r.last_scored_at AS rule_last_scored_at,
         c.id AS challenge_id, c.season_event_id, c.enabled, c.completed,
         c.schedule_start, c.schedule_end, c.metric_target, c.reward,
         ct.id AS template_id, ct.category AS t_category, ct.goal AS t_goal,
         ct.schedule_start AS t_schedule_start, ct.schedule_end AS t_schedule_end,
         ct.metric_target AS t_metric_target, ct.reward AS t_reward,
         se.starts_at AS event_starts_at, se.ends_at AS event_ends_at
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
// paid for, and how many credits each person has. Two questions, one query,
// because the second is what enforces the weekly cap.
const CREDITED_SQL = `
  SELECT user_id, metadata->>'source_key' AS source_key
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
// Every windowed query takes ($1 start, $2 end) as timestamps; the two state
// measures take none. `date`-grained sources are compared as dates, which is
// the granularity `app_activity` has — a window that opens mid-day therefore
// counts that whole day. Weekly windows open at midnight, so this is exact
// for the case it is used in, and generous by at most a day otherwise.

// Apps the person did not make, with at least half a minute in them.
const TRY_APPS_SQL = `
  SELECT aa.user_id, aa.app_id, a.name AS app_name,
         MAX(aa.date) AS last_date, SUM(aa.seconds_spent) AS seconds
    FROM app_activity aa
    JOIN apps a ON a.id = aa.app_id
   WHERE aa.date >= $1::date AND aa.date <= $2::date
     AND aa.user_id IS NOT NULL
     AND a.created_by IS DISTINCT FROM aa.user_id
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
const USEFUL_FEEDBACK_SQL = `
  SELECT fr.id, fr.user_id, fr.created_at, fr.title, fr.description, a.name AS app_name
    FROM feedback_reports fr
    LEFT JOIN apps a ON a.id = fr.app_id
   WHERE fr.created_at >= $1 AND fr.created_at <= $2
     AND fr.issue_number IS NOT NULL
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
async function loadCandidates(pool, measure, window, { target }) {
  const spec = MEASURES[measure];
  if (!spec) return [];
  const startIso = window.startMs != null ? new Date(window.startMs).toISOString() : '1970-01-01T00:00:00.000Z';
  const endIso = window.endMs != null ? new Date(window.endMs).toISOString() : new Date(Date.now() + 86400000).toISOString();

  switch (measure) {
    case 'TRY_APPS': {
      const { rows } = await pool.query(TRY_APPS_SQL,
        [startIso, endIso, TRY_APPS_MIN_SECONDS, CANDIDATE_LIMIT]);
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
        // One credit for the whole window, so the key names the window.
        sourceKey: 'window',
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
      const { rows } = await pool.query(USEFUL_FEEDBACK_SQL, [startIso, endIso, CANDIDATE_LIMIT]);
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
    default:
      return [];
  }
}

async function loadCredited(pool, challengeId) {
  const { rows } = await pool.query(CREDITED_SQL, [challengeId]);
  const map = new Map();
  for (const r of rows) {
    const userId = Number(r.user_id);
    const state = map.get(userId) || { keys: new Set(), count: 0 };
    state.keys.add(r.source_key);
    state.count += 1;
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
  let candidates;
  try {
    candidates = await loadCandidates(pool, rule.measure, window, { target });
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
  if (MEASURES[rule.measure].graded) {
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
  const { rows } = await pool.query(RULE_CHALLENGES_SQL);
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
const LAST_AGGREGATE_SQL = `
  SELECT MAX(snapshot_at) AS at FROM leaderboard_snapshots
`;

// The scorer writes the ledger; the snapshot builder turns the ledger into
// standings. Progress rails read the ledger directly, so a credit shows up
// on the card within a tick — but the leaderboard would sit still until
// somebody pressed the admin's Aggregate button, which is exactly the manual
// step this service exists to remove. Cadence is hours rather than minutes
// because each run writes a new snapshot timestamp and the event keeps only
// the ten newest, so aggregating too eagerly would shred the history the
// standings chart draws.
async function maybeAggregate(pool, { hours, now = Date.now() }) {
  if (!(hours > 0)) return null;
  const { rows } = await pool.query(LAST_AGGREGATE_SQL);
  const last = rows[0] && rows[0].at ? new Date(rows[0].at).getTime() : null;
  if (last != null && now - last < hours * 3600000) return null;
  const { buildSnapshots } = require('./snapshot-builder');
  const result = await buildSnapshots(pool);
  return { events: result.events.length };
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
// template columns `t_`), which carry every field skipReason reads. Returns a
// Map of challenge id -> { intervalMinutes, lastScoredAt }, holding only the
// challenges something counts. Asks Postgres nothing when the schedule is off
// (a default of 0 runs no rule at all) or the list is empty.
async function loadCadence(pool, eventId, rows, { defaultMinutes, now = Date.now() } = {}) {
  const out = new Map();
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
    const cadence = rules.cadenceOf(bound, { ...row, event_starts_at, event_ends_at }, { now, defaultMinutes });
    if (cadence) out.set(Number(row.id), cadence);
  }
  return out;
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
  start,
  stop,
  maybeAggregate,
  loadCandidates,
  loadCredited,
  dueRuleIds,
  loadCadence,
  intervalMinutes,
  aggregateHours,
  MAX_CREDITS_PER_RUN,
  MAX_GRADES_PER_RUN,
  CANDIDATE_LIMIT,
  RULE_CHALLENGES_SQL,
  CADENCE_RULES_SQL,
  CREDITED_SQL,
  MEASURE_SQL,
  dateToIso,
};
