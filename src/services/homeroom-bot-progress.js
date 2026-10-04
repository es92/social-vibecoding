'use strict';

// #3685: how far along the Homeroom bot is with one person's work, read from
// the platform's own records, so its DM (homeroom-bot-mayor.js) can answer
// "how far along are you?" with what is true and nothing more.
//
// Every request the bot works on for somebody moves through the same steps,
// and each step leaves a record behind:
//
//   set up the project   a first version only: the project's row is still
//                        'creating' and homeroom_bot_first_versions waits for
//                        it. app-creation-phase says which of the four parts
//                        of the setup runs, when it runs in this process.
//   read the request     homeroom_bot_queue: waiting (enqueued_at) or being
//                        read now (started_at). A question the bot asked
//                        waits in homeroom_bot_dm_messages.
//   write a plan         a live 'ready' run whose build session exists and
//                        whose spec is not posted yet.
//   build it             the spec is posted (homeroom_bot_posts 'spec') and
//                        the build session is still active.
//   run its checks       the proposal's check_state, check_phase and
//                        checks_progress.
//   group vote           the proposal is up and its checks passed: votes for
//                        and against, and how many it needs.
//   live                 merged.
//
// The queue row of a request is deleted as soon as it has been read, BEFORE
// its plan and build (homeroom-bot.js runTriage), so a build in progress is
// found from its run and its build session, never from the queue.
//
// Nothing here guesses. A step has a time limit when the platform enforces
// one (a reading turn, a plan, a build), which is the most it can take, not
// an estimate, and a record the bot cannot read is left out, not filled in.
// How long a step usually takes is a fixed range per step (typicalMinutes,
// #19), said as that and nothing finer.
//
// #3734: the DM's activity tray (homeroom-bot-tray.js) lists under Now what
// this module says is in flight (inFlight below), so the tray and the bot's
// own answer never disagree. They used to read it separately: the tray from
// claimed queue rows alone, so a build (whose queue row is gone) and a
// follow-up waiting its turn showed as nothing while the bot said otherwise.

// Lazy: the live module is large, and only the queue readers below need it.
function live() { return require('./homeroom-bot-live'); }

/**
 * #3734: the projects a queue row is the bot's own work on (live.appsScope),
 * whether or not it is switched on: that is said apart (botIsOn). Null when
 * there are no settings to read them from.
 */
function actsScope(settings) {
  return settings ? live().appsScope(settings) : null;
}

const MINUTE_MS = 60 * 1000;
// A ready verdict with no build session yet is a build starting. Past this,
// nothing about it is recorded, and that is what is said.
const START_GRACE_MS = 15 * MINUTE_MS;
// What finished lately, for "is it ready yet?".
const FINISHED_WITHIN_DAYS = 14;
const MAX_FINISHED = 3;
const MAX_REQUESTS = 25;
// #3771: the bot's account, whose follow-ups run beside a project's other work.
const BOT_USERNAME = 'homeroom_bot';
// A live build older than this is not holding its project up any more (the
// longest one, a platform build's plan and build turn, is under two hours).
const BUSY_BUILD_HOURS = 4;

const FIRST_VERSION_STEPS = Object.freeze([
  'Set up the project', 'Read the description', 'Write a plan', 'Build it', 'Run its checks', 'Group vote', 'Live',
]);
const REQUEST_STEPS = Object.freeze([
  'Read the request', 'Write a plan', 'Build it', 'Run its checks', 'Group vote', 'Live',
]);

// Which step each stage is part of. A request's first step is "Read".
const STEP_OF_STAGE = Object.freeze({
  setting_up: 'setup',
  queued: 'read',
  reading: 'read',
  question: 'read',
  build_queued: 'plan',
  held: 'plan',
  starting: 'plan',
  planning: 'plan',
  stalled: 'plan',
  building: 'build',
  proposing: 'build',
  checks: 'checks',
  checks_failed: 'checks',
  fix_queued: 'checks',
  fixing: 'checks',
  followup_queued: 'vote',
  revising: 'vote',
  vote: 'vote',
  merging: 'vote',
});

// The stages in which the bot itself (or the setup it started) is doing
// something this minute, rather than waiting on the person, the group, the
// checks or its queue: what "working on now" means.
const BUSY_STAGES = new Set([
  'setting_up', 'reading', 'revising', 'fixing', 'starting', 'planning', 'building', 'proposing', 'merging',
]);

// #3734: what the bot has in hand for the person: doing this minute, or in
// its queue to be done (a request to read, a follow-up on its proposal).
// Not what waits on them or the group, a proposal's checks running, or a
// build held back or stalled. The activity tray's Now is exactly this.
const IN_FLIGHT_STAGES = new Set([...BUSY_STAGES, 'queued', 'build_queued', 'followup_queued', 'fix_queued']);

// app-creation-phase.js PHASES, in words.
const SETUP_PARTS = Object.freeze({
  database: 'making its database',
  repository: 'making its code repository',
  build: 'building it for the first time',
  deploy: 'starting it up',
});

function stepNumber(stage, firstVersion) {
  const key = STEP_OF_STAGE[stage];
  if (!key) return null;
  const order = ['setup', 'read', 'plan', 'build', 'checks', 'vote', 'live'];
  const at = order.indexOf(key);
  return firstVersion ? at + 1 : at;
}

function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function minutesSince(value, now) {
  if (!value) return null;
  const ms = now.getTime() - new Date(value).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / MINUTE_MS)) : null;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Pure: a proposal's checks, in plain words, from its columns. */
function checksWords({ check_state: state, check_phase: phase, checks_progress: progress, failed_checks: failedChecks }) {
  if (state === 'passing') return 'passed';
  if (state === 'skipped') return 'not needed for this change';
  if (state === 'failing') {
    const n = Number(failedChecks);
    return Number.isInteger(n) && n > 0 ? `failed (${plural(n, 'check')} did not pass)` : 'failed';
  }
  if (state === 'error' || state === 'unknown') return 'could not run (the preview or the test run broke)';
  if (state === 'pending' || state === 'running') {
    if (phase === 'building') return 'running: building the preview first';
    const p = progress && typeof progress === 'object' ? progress : {};
    const ran = Number(p.ran);
    const expected = Number(p.expected);
    const failed = Number(p.failed) || 0;
    if (Number.isInteger(ran) && Number.isInteger(expected) && expected > 0) {
      return `running: ${ran} of ${expected} done, ${failed} failed so far`;
    }
    return 'running';
  }
  return 'not run yet';
}

/** Pure: how many checks did not pass, from a proposal's test_results. */
function failedCount(results) {
  if (!Array.isArray(results)) return null;
  return results.filter((t) => t && t.status && t.status !== 'pass').length;
}

function links(domain, { slug, number = null, proposal = null }) {
  if (!domain || !slug) return {};
  const base = `https://${domain}/#app/${encodeURIComponent(slug)}`;
  return {
    project: base,
    ...(number ? { request: `${base}/dev/issues/${Number(number)}` } : {}),
    ...(proposal ? { proposal: `${base}/dev/proposals/${Number(proposal)}` } : {}),
  };
}

/**
 * Pure (#8, WP3): whether a request's queue row is left over from before its
 * proposal merged: put there before the merge (a reply, a look again), and
 * moot once it went live. It read as "waiting in the queue" in the DM's
 * header long after. A row put there after the merge is new work.
 */
function leftOverQueue(row) {
  if (row.proposal_status !== 'merged' || !row.queue_id || !row.merged_at) return false;
  const ms = (value) => (value instanceof Date ? value.getTime() : Date.parse(value || ''));
  const queued = ms(row.enqueued_at || row.started_at);
  const merged = ms(row.merged_at);
  return Number.isFinite(queued) && Number.isFinite(merged) && queued <= merged;
}

/**
 * Pure: the stage of one of the person's requests, from one row of
 * requestRows below, or null when nothing about it is in progress.
 * `{ stage, since, doing, waitingOn?, limit? }`, where `limit` names which
 * clock applies ('reading', 'plan' or 'build').
 */
function stageOf(input, { now = new Date() } = {}) {
  const row = leftOverQueue(input) ? { ...input, queue_id: null, started_at: null, enqueued_at: null, queue_reason: null } : input;
  const proposalOpen = row.proposal_status === 'promoted' || row.proposal_status === 'merging';
  const it = row.first_version ? 'the description' : 'the request';
  if (proposalOpen) {
    if (row.started_at) {
      return row.queue_reason === 'checks_failing'
        ? { stage: 'fixing', since: row.started_at, doing: 'fixing its failing checks' }
        : { stage: 'revising', since: row.started_at, doing: 'reading the newest replies on its proposal' };
    }
    // #3734: a follow-up waiting its turn (a reply on the proposal, a change
    // asked for in the DM, its own failing checks). Only while it is up for
    // a vote: the loop does not follow up on a proposal being merged.
    if (row.queue_id && row.proposal_status === 'promoted') {
      return row.queue_reason === 'checks_failing'
        ? { stage: 'fix_queued', since: row.enqueued_at, doing: 'waiting for a free builder to fix its failing checks' }
        : { stage: 'followup_queued', since: row.enqueued_at, doing: 'waiting for a free builder to follow up on the newest replies on its proposal' };
    }
    if (row.question_at) {
      return { stage: 'question', since: row.question_at, doing: 'waiting for an answer to the question asked', waitingOn: 'them' };
    }
    if (row.proposal_status === 'merging') {
      return { stage: 'merging', since: null, doing: 'approved; merging it now' };
    }
    const checks = checksWords({ ...row, failed_checks: row.failed_checks ?? failedCount(row.test_results) });
    if (row.check_state === 'passing' || row.check_state === 'skipped') {
      return { stage: 'vote', since: row.proposal_at, doing: 'its proposal is up for the group\'s vote', waitingOn: 'the group' };
    }
    if (row.check_state === 'failing' || row.check_state === 'error' || row.check_state === 'unknown') {
      return { stage: 'checks_failed', since: row.checks_at || row.proposal_at, doing: `its proposal is up, and its checks ${checks}` };
    }
    return { stage: 'checks', since: row.checks_at || row.proposal_at, doing: `its proposal is up, and its checks are ${checks}` };
  }
  if (row.started_at) {
    return { stage: 'reading', since: row.started_at, doing: `reading ${it} to decide whether to ask a question or build it`, limit: 'reading' };
  }
  if (row.question_at) {
    return { stage: 'question', since: row.question_at, doing: 'waiting for an answer to the question asked', waitingOn: 'them' };
  }
  // The newest look decided to build it, and nothing has finished it yet.
  if (row.mode === 'live' && row.verdict === 'ready' && row.build_ok == null && !row.run_proposal) {
    if (row.cap_suppressed) {
      return {
        stage: 'held',
        since: row.run_at,
        doing: row.cap_suppressed === 'proposals_per_app' || row.cap_suppressed === 'proposals_total'
          ? 'ready to build, but held back until one of the open proposals is merged or closed (only so many may be open at once)'
          : 'ready to build, but held back by the daily limit on questions and notes on this project',
      };
    }
    // Built after the turn that read it, one build per project at a time
    // (homeroom-bot.js buildLive): waiting its turn until its build starts.
    if (row.build_waiting_at && !row.build_session_id) {
      return { stage: 'build_queued', since: row.build_waiting_at, doing: 'ready to build; waiting its turn to be built' };
    }
    if (!row.build_session_id) {
      if (now.getTime() - new Date(row.run_at).getTime() <= START_GRACE_MS) {
        return { stage: 'starting', since: row.run_at, doing: 'starting a workspace to build it in' };
      }
      return { stage: 'stalled', since: row.run_at, doing: 'it was found ready to build, but nothing about the build has been recorded since' };
    }
    if (row.build_status === 'archived') return null;
    if (row.build_status === 'paused' || row.build_status === 'promoted') {
      return { stage: 'proposing', since: row.build_last_activity || null, doing: 'the build finished; opening its proposal now' };
    }
    // Building once its plan is posted, or once the build turn itself runs
    // (a plan that failed is not posted, and the build goes ahead without).
    if (row.spec_at || row.build_turn_mode === 'build') {
      return { stage: 'building', since: row.spec_at || row.build_turn_at || row.build_started_at, doing: 'building it', limit: 'build' };
    }
    return { stage: 'planning', since: row.build_started_at || row.run_at, doing: 'writing the plan for the build', limit: 'plan' };
  }
  if (row.queue_id) {
    // Not its number in the queue: that counts every project's requests, and
    // the per-project and per-person limits decide more (queuedWait).
    return { stage: 'queued', since: row.enqueued_at, doing: 'waiting for a free builder' };
  }
  return null;
}

/** Pure: what a request that is not in progress came to, or null. */
function outcomeOf(row) {
  if (row.proposal_status === 'merged') return 'approved and live';
  if (row.proposal_status === 'closed') return 'its proposal was closed without merging';
  if (row.mode !== 'live') return null;
  if (row.build_ok === false && /^skipped:/.test(String(row.build_error || ''))) {
    return `not built: ${String(row.build_error).replace(/^skipped:\s*/, '').slice(0, 200)}`;
  }
  if (row.build_ok === false) return `the build did not succeed${row.build_error ? `: ${String(row.build_error).slice(0, 200)}` : ''}`;
  switch (row.verdict) {
    case 'person': return 'left for the group to decide';
    case 'empty': return 'nothing to build was found in it';
    case 'failed': return 'the last look at it failed';
    default: return null;
  }
}

/** The time limits of the steps that have one, in minutes, for this request. */
function limitsFor(row, { settings, config, botSvc }) {
  try {
    const turnSeconds = Number(settings?.turnSeconds) || botSvc.DEFAULTS.turnSeconds;
    const budgets = botSvc.buildBudgets({ repo_url: row.repo_url }, config || {}, turnSeconds * 1000, {
      firstVersion: !!row.first_version,
    });
    return {
      reading: Math.round(turnSeconds / 60),
      plan: Math.round(budgets.specBudgetMs / MINUTE_MS),
      build: Math.round(budgets.turnBudgetMs / MINUTE_MS),
    };
  } catch {
    return {};
  }
}

// #19 (WP3, D5): how long each step usually takes, in minutes, by stage: a
// fixed range for now, to be read from recent runs later. "How long will it
// take?" is answered with this. A step's time limit is the most it can take
// before it is stopped, and a reply that quoted it as the wait ("about 40
// minutes") was answering a different question.
const TYPICAL_MINUTES = Object.freeze({
  setting_up: Object.freeze([2, 6]),
  reading: Object.freeze([1, 3]),
  starting: Object.freeze([1, 5]),
  planning: Object.freeze([3, 8]),
  building: Object.freeze([10, 25]),
  proposing: Object.freeze([1, 3]),
  checks: Object.freeze([5, 20]),
  revising: Object.freeze([5, 20]),
  fixing: Object.freeze([5, 20]),
});

/**
 * Pure: how long a stage's step usually takes, `{ from, to }` in minutes, or
 * null for a stage that waits on somebody (a queue, a question, the vote)
 * rather than takes a while. Never past the step's time limit.
 */
function typicalMinutes(stage, limit = null) {
  const range = TYPICAL_MINUTES[stage];
  if (!range) return null;
  const to = Number.isFinite(limit) && limit > 0 ? Math.min(range[1], limit) : range[1];
  return { from: Math.min(range[0], to), to };
}

/**
 * Every request recorded as the person's (homeroom_bot_requesters), and
 * anything of theirs waiting in the bot's queue, with each record the steps
 * above read. Newest first.
 */
async function requestRows(pool, userId) {
  const { rows } = await pool.query(
    `WITH mine AS (
       SELECT r.app_id, r.issue_number, r.issue_title, r.first_version
         FROM homeroom_bot_requesters r WHERE r.user_id = $1
       UNION
       SELECT q.app_id, q.issue_number, i.title, FALSE
         FROM homeroom_bot_queue q
         JOIN issues i ON i.app_id = q.app_id AND i.github_issue_number = q.issue_number
        WHERE i.created_by = $1
          AND NOT EXISTS (SELECT 1 FROM homeroom_bot_requesters r2
                           WHERE r2.app_id = q.app_id AND r2.issue_number = q.issue_number)
     )
     SELECT m.app_id, a.slug, a.name, a.repo_url, m.issue_number, m.issue_title, m.first_version,
            q.id AS queue_id, q.started_at, q.enqueued_at, q.reason AS queue_reason,
            run.id AS run_id, run.mode, run.verdict, run.created_at AS run_at, run.duration_ms AS run_duration_ms,
            run.cap_suppressed,
            run.build_ok, run.build_error, run.build_session_id, run.proposal_session_id AS run_proposal,
            run.live_build_waiting_at AS build_waiting_at,
            bs.status AS build_status, bs.created_at AS build_started_at, bs.last_activity_at AS build_last_activity,
            bs.active_turn->>'mode' AS build_turn_mode, bs.active_turn->>'startedAt' AS build_turn_at,
            spec.created_at AS spec_at,
            prop.proposal_session_id, cs.status AS proposal_status, cs.check_state, cs.check_phase,
            cs.checks_progress, cs.checks_checked_at AS checks_at, cs.test_results,
            COALESCE(cs.promoted_at, cs.created_at) AS proposal_at, cs.merged_at,
            oq.created_at AS question_at
       FROM mine m
       JOIN apps a ON a.id = m.app_id
       LEFT JOIN homeroom_bot_queue q ON q.app_id = m.app_id AND q.issue_number = m.issue_number
       LEFT JOIN LATERAL (
         SELECT id, mode, verdict, created_at, duration_ms, cap_suppressed, build_ok, build_error, build_session_id,
                proposal_session_id, live_build_waiting_at
           FROM homeroom_bot_runs
          WHERE app_id = m.app_id AND issue_number = m.issue_number
          ORDER BY id DESC LIMIT 1
       ) run ON TRUE
       LEFT JOIN chat_sessions bs ON bs.id = run.build_session_id
       LEFT JOIN LATERAL (
         SELECT created_at FROM homeroom_bot_posts
          WHERE run_id = run.id AND kind = 'spec'
          ORDER BY id DESC LIMIT 1
       ) spec ON TRUE
       LEFT JOIN LATERAL (
         SELECT proposal_session_id FROM homeroom_bot_runs
          WHERE app_id = m.app_id AND issue_number = m.issue_number AND proposal_session_id IS NOT NULL
          ORDER BY id DESC LIMIT 1
       ) prop ON TRUE
       LEFT JOIN chat_sessions cs ON cs.id = prop.proposal_session_id
       LEFT JOIN LATERAL (
         SELECT created_at FROM homeroom_bot_dm_messages
          WHERE user_id = $1 AND app_id = m.app_id AND issue_number = m.issue_number AND question_status = 'open'
          ORDER BY created_at DESC LIMIT 1
       ) oq ON TRUE
      ORDER BY GREATEST(COALESCE(run.created_at, 'epoch'::timestamptz), COALESCE(q.enqueued_at, 'epoch'::timestamptz),
                        COALESCE(q.started_at, 'epoch'::timestamptz)) DESC
      LIMIT ${MAX_REQUESTS}`,
    [userId],
  );
  return rows;
}

/** Pure (WP1): a live ready run whose build waits its turn or runs. */
function buildUnderWay(run) {
  return run.build_ok == null && !run.proposal_session_id && !run.cap_suppressed
    && ((!!run.live_build_waiting_at && !run.build_session_id) || run.build_status === 'active' || run.build_status === 'paused');
}

/** Pure (WP1): what one earlier build of a request came to, in words. */
function attemptOutcome(run) {
  const why = (prefix) => String(run.build_error || '').replace(prefix, '').slice(0, 200);
  if (run.proposal_session_id) {
    if (run.proposal_status === 'merged') return 'built; approved and live';
    if (run.proposal_status === 'promoted') return 'built; its proposal is up for a vote';
    if (run.proposal_status === 'merging') return 'built; its proposal is being merged';
    return 'built; its proposal was closed';
  }
  if (run.build_ok === true) return 'built';
  if (run.build_ok === false) {
    if (/^skipped:/.test(String(run.build_error || ''))) return `stopped before it was built: ${why(/^skipped:\s*/)}`;
    if (/^blocked:/.test(String(run.build_error || ''))) return `found it cannot be built as written: ${why(/^blocked:\s*/)}`;
    return `the build did not succeed${run.build_error ? `: ${why('')}` : ''}`;
  }
  if (run.cap_suppressed) return 'held back by a limit, never built';
  if (run.build_error) return `never built: ${why(/^superseded:\s*/)}`;
  return 'nothing recorded about how it ended';
}

/**
 * WP1 (#10): the request's other live builds beside the one its stage
 * describes (its open proposal's, else its newest look's), set on each row
 * in place: `also_building`, another build of the same request that waits
 * or runs, and `earlier_attempt`, the build before the described one and
 * what it came to. The stage reads the newest look and the newest proposal
 * only, so a second build of one request was invisible to the bot's answers
 * ("Nothing broke", Plant Pal, 3 October). Never throws.
 */
async function attachAttempts(pool, rows) {
  const keyed = rows.filter((r) => r.app_id && r.issue_number);
  if (!keyed.length) return;
  let runs;
  try {
    ({ rows: runs } = await pool.query(
      `SELECT r.id, r.app_id, r.issue_number, r.created_at, r.build_ok, r.build_error, r.cap_suppressed,
              r.live_build_waiting_at, r.build_session_id, r.proposal_session_id,
              bs.status AS build_status, bs.created_at AS build_started_at, ps.status AS proposal_status
         FROM homeroom_bot_runs r
         LEFT JOIN chat_sessions bs ON bs.id = r.build_session_id
         LEFT JOIN chat_sessions ps ON ps.id = r.proposal_session_id
        WHERE r.mode = 'live' AND r.verdict = 'ready'
          AND (r.app_id, r.issue_number) IN (SELECT * FROM UNNEST($1::int[], $2::int[]))
          AND r.created_at > NOW() - make_interval(days => $3)
        ORDER BY r.id DESC`,
      [keyed.map((r) => Number(r.app_id)), keyed.map((r) => Number(r.issue_number)), FINISHED_WITHIN_DAYS],
    ));
  } catch {
    return;
  }
  const byRequest = new Map();
  for (const run of runs || []) {
    const key = `${Number(run.app_id)}#${Number(run.issue_number)}`;
    if (!byRequest.has(key)) byRequest.set(key, []);
    byRequest.get(key).push(run);
  }
  for (const row of keyed) {
    const list = byRequest.get(`${Number(row.app_id)}#${Number(row.issue_number)}`) || [];
    if (!list.length) continue;
    const open = row.proposal_status === 'promoted' || row.proposal_status === 'merging';
    const proposalRun = open ? list.find((r) => Number(r.proposal_session_id) === Number(row.proposal_session_id)) : null;
    const described = Number(proposalRun?.id ?? row.run_id) || null;
    const other = list.find((r) => Number(r.id) !== described && buildUnderWay(r));
    if (other) {
      const waiting = !other.build_session_id;
      row.also_building = {
        doing: waiting
          ? 'another build of this same request is waiting its turn'
          : 'another build of this same request is under way',
        since: iso(other.build_started_at || other.live_build_waiting_at || other.created_at),
      };
    }
    const earlier = described ? list.find((r) => Number(r.id) < described && !buildUnderWay(r)) : null;
    if (earlier) {
      row.earlier_attempt = {
        outcome: attemptOutcome(earlier),
        when: iso(earlier.created_at),
        ...(earlier.proposal_session_id ? { proposal: Number(earlier.proposal_session_id) } : {}),
      };
    }
  }
}

/** Where each of `rows`' waiting requests is in the live queue, by queue id. */
async function queuePositions(pool, rows, settings) {
  const position = new Map();
  const scope = actsScope(settings);
  if (!scope || live().scopeIsEmpty(scope) || !rows.some((r) => r.queue_id && !r.started_at)) return position;
  const { rows: queue } = await pool.query(
    `SELECT q.id FROM homeroom_bot_queue q JOIN apps a ON a.id = q.app_id
      WHERE q.started_at IS NULL
        AND (CASE WHEN $2::boolean THEN NOT (a.slug = ANY($3::text[])) ELSE a.slug = ANY($1::text[]) END)
      ORDER BY q.priority, q.enqueued_at LIMIT 500`,
    [scope.slugs, scope.all, scope.except],
  );
  queue.forEach((q, i) => position.set(Number(q.id), i + 1));
  return position;
}

/**
 * #3771: what the bot is busy with on each project where a request of the
 * person's waits: a request it is reading now (a claimed queue row, other
 * than a follow-up on its own proposal, which runs beside it), or one it is
 * building (a live ready run with no proposal yet, whose queue row is gone).
 * The bot starts one request per project at a time, so either holds the
 * rest. By app id: [{ issueNumber, since, what }], newest first.
 */
async function projectsBusy(pool, rows) {
  const appIds = [...new Set(rows.filter((r) => (r.queue_id && !r.started_at) || (r.build_waiting_at && !r.build_session_id))
    .map((r) => Number(r.app_id)))];
  if (!appIds.length) return new Map();
  const { rows: found } = await pool.query(
    `(SELECT q.app_id, q.issue_number, q.started_at AS since, 'reading' AS what
        FROM homeroom_bot_queue q
       WHERE q.app_id = ANY($1::int[]) AND q.started_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
            WHERE cs.app_id = q.app_id AND q.issue_number = ANY(cs.linked_issues)
              AND cs.status = 'promoted' AND u.username = $2 AND u.is_synthetic = TRUE))
     UNION ALL
     (SELECT DISTINCT ON (r.app_id, r.issue_number) r.app_id, r.issue_number,
             COALESCE(bs.created_at, r.created_at) AS since, 'building' AS what
        FROM homeroom_bot_runs r
        LEFT JOIN chat_sessions bs ON bs.id = r.build_session_id
       WHERE r.app_id = ANY($1::int[]) AND r.mode = 'live' AND r.verdict = 'ready' AND r.build_ok IS NULL
         AND r.cap_suppressed IS NULL AND r.proposal_session_id IS NULL AND r.live_build_waiting_at IS NULL
         AND r.created_at > NOW() - make_interval(hours => $3)
         AND (bs.id IS NULL OR bs.status = 'active')
       ORDER BY r.app_id, r.issue_number, r.id DESC)`,
    [appIds, BOT_USERNAME, BUSY_BUILD_HOURS],
  );
  const out = new Map();
  for (const b of found) {
    const list = out.get(Number(b.app_id)) || [];
    list.push({ issueNumber: Number(b.issue_number), since: b.since, what: b.what });
    out.set(Number(b.app_id), list);
  }
  for (const list of out.values()) list.sort((a, b) => new Date(b.since) - new Date(a.since));
  return out;
}

/**
 * What the bot is doing on one project's requests right now, for the
 * request page (routes/issues.js): reading a request, or building one. By
 * issue number: Map(n → { what: 'reading' | 'building', since }).
 *
 * The bot's own sessions are never a request's `in_progress` (the issue
 * routes leave synthetic authors out on purpose), so without this a request
 * it was building read "Unassigned" and offered Claim and Start work, and a
 * claim then told the bot to leave the request alone.
 *
 * Read twice over. First the same two reads as projectsBusy, which takes
 * the projects of the rows it is handed that wait: one waiting row names
 * this project. Then the bot's own "live build waiting its turn or under
 * way" (homeroom-bot.js, the run classifyIssue and liveCandidates hold a
 * request for): a build waiting for the project's build slot can wait a
 * whole other build's length, and projectsBusy does not count it, since it
 * is not yet holding the project up. To the request it is the bot's work
 * all the same, so it reads as building, since it began to wait. A request
 * both read and built at once is called building, the longer of the two.
 */
async function botWorkByIssue(pool, appId) {
  const id = Number(appId);
  const out = new Map();
  if (!Number.isInteger(id) || id <= 0) return out;
  const busy = await projectsBusy(pool, [{ app_id: id, queue_id: -1, started_at: null }]);
  for (const b of busy.get(id) || []) {
    const had = out.get(b.issueNumber);
    if (had && had.what === 'building') continue;
    out.set(b.issueNumber, { what: b.what, since: b.since });
  }
  const { ABANDONED_LIVE_WINDOW_DAYS } = require('./homeroom-bot');
  const { rows: builds } = await pool.query(
    `SELECT DISTINCT ON (r.issue_number) r.issue_number,
            COALESCE(r.live_build_waiting_at, bs.created_at, r.created_at) AS since
       FROM homeroom_bot_runs r
       LEFT JOIN chat_sessions bs ON bs.id = r.build_session_id
      WHERE r.app_id = $1
        AND r.mode = 'live' AND r.verdict = 'ready' AND r.build_ok IS NULL AND r.proposal_session_id IS NULL
        AND (r.live_build_waiting_at IS NOT NULL OR r.build_session_id IS NOT NULL)
        AND r.created_at > NOW() - make_interval(days => $2)
      ORDER BY r.issue_number, r.created_at DESC`,
    [id, ABANDONED_LIVE_WINDOW_DAYS],
  );
  for (const b of builds) {
    const n = Number(b.issue_number);
    if (out.get(n)?.what === 'building') continue;
    out.set(n, { what: 'building', since: b.since });
  }
  // B8: somebody asked the bot to build it (its page, their chat, Ask for a
  // change) and it waits for a free builder: it is the bot's already, and
  // nobody starts it a second time.
  const { rows: asked } = await pool.query(
    `SELECT issue_number, enqueued_at FROM homeroom_bot_queue
      WHERE app_id = $1 AND priority = 0 AND started_at IS NULL
        AND (held_until IS NULL OR held_until <= NOW())`,
    [id],
  );
  for (const q of asked) {
    const n = Number(q.issue_number);
    if (!out.has(n)) out.set(n, { what: 'queued', since: q.enqueued_at });
  }
  return out;
}

/**
 * Pure (#3771): what a request in the queue waits for, as the `queued`
 * stage's words and `waitingFor`. Its project busy with another request;
 * the most the bot does for one person at once already under way; or, with
 * nothing in the way, its place in the queue. "Waiting in the queue
 * (number 4)" said none of that, and "when will you pick it up?" had no
 * answer.
 */
function queuedWait(row, { busy = new Map(), working = 0, perPerson = 2, queuePosition = null, now = new Date() } = {}) {
  const ahead = (busy.get(Number(row.app_id)) || []).find((b) => b.issueNumber !== Number(row.issue_number));
  if (ahead) {
    // How long the other one has run is its own; the entry's time so far is
    // this request's wait.
    const minutes = minutesSince(ahead.since, now);
    const doing = ahead.what === 'building' ? 'building' : 'reading';
    return {
      doing: `waiting its turn: ${row.name || row.slug} is ${doing} request #${ahead.issueNumber} first (one request per project at a time)`,
      waitingFor: {
        reason: 'project_busy', number: ahead.issueNumber, doing, ...(Number.isInteger(minutes) ? { minutesSoFar: minutes } : {}),
      },
    };
  }
  if (working >= perPerson) {
    return {
      doing: `waiting its turn: ${plural(working, 'thing')} of theirs ${working === 1 ? 'is' : 'are'} in progress, the most at once for one person`,
      waitingFor: { reason: 'person_limit', inProgress: working, most: perPerson },
    };
  }
  if (queuePosition === 1) return { doing: 'next in line for a free builder', waitingFor: { reason: 'queue', ahead: 0 } };
  if (Number.isInteger(queuePosition) && queuePosition > 1) {
    // How many are ahead stays in `waitingFor`, for the model to answer
    // "how long?" with; the words say what it waits for.
    return {
      doing: 'waiting for a free builder',
      waitingFor: { reason: 'queue', ahead: queuePosition - 1 },
    };
  }
  return {};
}

/**
 * Pure: what a build waiting its turn waits for, as the `build_queued`
 * stage's words and `waitingFor`: another build on its project (one at a
 * time), the most the bot does for one person at once, or nothing: it
 * starts next.
 */
function buildWait(row, { busy = new Map(), working = 0, perPerson = 2, now = new Date() } = {}) {
  const ahead = (busy.get(Number(row.app_id)) || [])
    .find((b) => b.what === 'building' && b.issueNumber !== Number(row.issue_number));
  if (ahead) {
    const minutes = minutesSince(ahead.since, now);
    return {
      doing: `ready to build; ${row.name || row.slug} is building request #${ahead.issueNumber} first (one build per project at a time)`,
      waitingFor: {
        reason: 'project_building', number: ahead.issueNumber, ...(Number.isInteger(minutes) ? { minutesSoFar: minutes } : {}),
      },
    };
  }
  if (working >= perPerson) {
    return {
      doing: `ready to build; ${plural(working, 'thing')} of theirs ${working === 1 ? 'is' : 'are'} in progress, the most at once for one person`,
      waitingFor: { reason: 'person_limit', inProgress: working, most: perPerson },
    };
  }
  return { doing: 'ready to build; its build starts next', waitingFor: { reason: 'next' } };
}

/**
 * A proposal's facts as the DM reads them: its title, where it stands, its
 * checks in words, the votes for and against and how many it needs, and its
 * link. Null when there is no such proposal.
 */
async function proposalFacts(pool, sessionId, { domain = null } = {}) {
  if (!sessionId) return null;
  const revision = require('./pr-vote-revision');
  const { rows } = await pool.query(
    `SELECT cs.id, cs.app_id, a.slug, cs.status, cs.check_state, cs.check_phase, cs.checks_progress,
            cs.test_results, cs.session_title, cs.pr_title, cs.promoted_at, cs.created_at,
            (SELECT COUNT(*)::int FROM pr_votes pv WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                AND ${revision.countedVotePredicateSql('pv', 'cs')}) AS yes,
            (SELECT COUNT(*)::int FROM pr_votes pv WHERE pv.session_id = cs.id AND pv.vote = 'no'
                AND ${revision.countedVotePredicateSql('pv', 'cs')}) AS no
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
    [sessionId],
  );
  const s = rows[0];
  if (!s) return null;
  let needed = null;
  if (s.status === 'promoted') {
    try {
      const governance = require('./governance');
      const gov = await governance.getGovernance(pool, s.app_id);
      const electorate = await governance.getElectorate(pool, s.app_id, gov);
      needed = governance.computeGate(gov, electorate.active, s.yes, s.no, s.promoted_at || s.created_at).required;
    } catch { needed = null; }
  }
  const link = links(domain, { slug: s.slug, proposal: s.id }).proposal;
  return {
    proposal: Number(s.id),
    title: s.session_title || s.pr_title || null,
    status: { promoted: 'up for a vote', merging: 'being merged', merged: 'merged and live', closed: 'closed' }[s.status] || s.status,
    checks: checksWords({ ...s, failed_checks: failedCount(s.test_results) }),
    yesVotes: s.yes,
    noVotes: s.no,
    votesNeeded: Number.isFinite(needed) ? needed : null,
    ...(link ? { link } : {}),
  };
}

/**
 * The first versions the bot is to build for this person whose request is
 * not filed yet: the project is still being set up, or could not be.
 */
async function firstVersionRows(pool, userId) {
  const { rows } = await pool.query(
    `SELECT a.id AS app_id, a.slug, a.name, a.status AS app_status, a.created_at AS app_created_at,
            f.status, f.created_at, f.error
       FROM homeroom_bot_first_versions f JOIN apps a ON a.id = f.app_id
      WHERE f.user_id = $1 AND f.bot_builds = TRUE AND f.status IN ('waiting', 'filing', 'failed')
      ORDER BY f.created_at DESC LIMIT 10`,
    [userId],
  );
  return rows;
}

/** Pure: a first version's setup, as a stage, or a stopped outcome. */
function setupOf(row, { phase = null } = {}) {
  if (row.status === 'failed') return { outcome: 'its first version could not be started' };
  if (row.app_status === 'error') return { outcome: 'setting up the project failed, so its first version could not be started' };
  if (row.app_status === 'awaiting_secrets') {
    return {
      stage: 'setting_up', since: row.app_created_at || row.created_at, waitingOn: 'them',
      doing: 'the project is waiting for its secrets to be set on its page before it can start',
    };
  }
  if (row.app_status === 'running') {
    return { stage: 'setting_up', since: row.created_at, doing: 'the project is set up; its first request is being filed to start on it' };
  }
  const parts = Object.keys(SETUP_PARTS);
  const part = phase && SETUP_PARTS[phase.phase]
    ? `: part ${parts.indexOf(phase.phase) + 1} of ${parts.length}, ${SETUP_PARTS[phase.phase]}`
    : '';
  return { stage: 'setting_up', since: row.app_created_at || row.created_at, doing: `setting up the project${part}` };
}

/** Pure: whether a `progressFor` entry is in the bot's hands now (IN_FLIGHT_STAGES). */
function inFlight(item) {
  return !!item && IN_FLIGHT_STAGES.has(item.stage) && !item.waitingOn;
}

function entry({ row, number = null, title = null, firstVersion, state, proposal = null, limits = {}, domain, now }) {
  const steps = firstVersion ? FIRST_VERSION_STEPS : REQUEST_STEPS;
  const step = stepNumber(state.stage, firstVersion);
  const minutes = minutesSince(state.since, now);
  const limit = state.limit && Number.isFinite(limits[state.limit]) ? limits[state.limit] : null;
  const typical = state.waitingOn ? null : typicalMinutes(state.stage, limit);
  return {
    project: row.slug,
    projectName: row.name || row.slug,
    ...(number ? { number: Number(number) } : {}),
    title: firstVersion ? 'First version' : (title || null),
    ...(firstVersion ? { firstVersion: true } : {}),
    stage: state.stage,
    step,
    of: steps.length,
    stepName: step ? steps[step - 1] : null,
    doing: state.doing,
    busyNow: BUSY_STAGES.has(state.stage) && !state.waitingOn,
    ...(state.since ? { since: iso(state.since), minutesSoFar: minutes } : {}),
    ...(limit ? { stepTimeLimitMinutes: limit } : {}),
    ...(typical ? { typicalMinutes: typical } : {}),
    ...(state.waitingOn ? { waitingOn: state.waitingOn } : {}),
    ...(state.waitingFor ? { waitingFor: state.waitingFor } : {}),
    ...(proposal ? { proposal } : {}),
    // WP1 (#10): the request's other builds, beside the one described.
    ...(row.also_building ? { alsoBuilding: row.also_building } : {}),
    ...(row.earlier_attempt ? { earlierAttempt: row.earlier_attempt } : {}),
    links: links(domain, { slug: row.slug, number, proposal: proposal?.proposal }),
  };
}

/**
 * Each of the person's requests (requestRows), newest first, beside the
 * stage it is at (stageOf; null when nothing about it is in progress):
 * `{ row, state }`. What progressFor below says of each, and what the
 * activity cards read (homeroom-bot-activity.js catchUpCards) to find the
 * work under way that has no card yet, so the two cannot disagree on what
 * that work is.
 */
async function requestStates(pool, { userId, settings = null, now = new Date(), working = 0 }) {
  // #3734: a queue row is the bot's work only on a project it acts on for
  // real. On any other the queue is its background triage, which says
  // nothing to anybody, so it is neither "waiting in the queue" nor "reading
  // it" for them. Whether the bot is switched on is said apart (botIsOn).
  const acts = actsScope(settings);
  const rows = (await requestRows(pool, userId)).map((row) => (!acts || live().inScope(acts, row.slug) ? row : {
    ...row, queue_id: null, started_at: null, enqueued_at: null, queue_reason: null,
  }));
  await attachAttempts(pool, rows);
  const position = await queuePositions(pool, rows, settings);
  const staged = rows.map((row) => {
    const queuePosition = row.queue_id ? position.get(Number(row.queue_id)) || null : null;
    return { row, state: stageOf({ ...row, queue_position: queuePosition }, { now }), queuePosition };
  });
  // #3771: what a request still in the queue waits for, in words. `working`
  // is the work already under way that does not come from these requests.
  const busyCount = working
    + staged.filter((s) => s.state && BUSY_STAGES.has(s.state.stage) && !s.state.waitingOn).length;
  const busy = staged.some((s) => s.state?.stage === 'queued' || s.state?.stage === 'build_queued')
    ? await projectsBusy(pool, rows) : new Map();
  const perPerson = Number(settings?.perPerson) || 2;
  return staged.map((s) => {
    if (s.state?.stage === 'queued') {
      return {
        row: s.row,
        state: { ...s.state, ...queuedWait(s.row, { busy, working: busyCount, perPerson, queuePosition: s.queuePosition, now }) },
      };
    }
    if (s.state?.stage === 'build_queued') {
      return { row: s.row, state: { ...s.state, ...buildWait(s.row, { busy, working: busyCount, perPerson, now }) } };
    }
    return { row: s.row, state: s.state };
  });
}

/**
 * How far along the bot is with everything it does for `userId`, newest
 * first: `rightNow` (in progress, each with its step of the steps above,
 * what it is doing, since when, the step's time limit and links) and
 * `finishedLately` (the last few that came to something). `facts: false`
 * leaves a proposal as its id alone, without its checks and votes (the
 * activity tray draws no more than that, and reads this on every change).
 */
async function progressFor(pool, { userId, settings = null, config = null, deps = {}, now = new Date(), facts = true }) {
  const botSvc = deps.botSvc || require('./homeroom-bot');
  const phases = deps.creationPhase || require('./app-creation-phase');
  const domain = deps.domain !== undefined ? deps.domain : require('./caddy').USERNODE_DOMAIN;
  const rightNow = [];
  const finished = [];

  for (const row of await firstVersionRows(pool, userId)) {
    const state = setupOf(row, { phase: row.app_status === 'creating' ? phases.read(row.slug) : null });
    if (state.outcome) {
      finished.push({ project: row.slug, projectName: row.name || row.slug, title: 'First version', outcome: state.outcome, links: links(domain, { slug: row.slug }) });
    } else {
      rightNow.push(entry({ row, firstVersion: true, state, domain, now }));
    }
  }

  const cutoff = now.getTime() - FINISHED_WITHIN_DAYS * 24 * 60 * MINUTE_MS;
  for (const { row, state } of await requestStates(pool, {
    userId, settings, now, working: rightNow.filter((e) => e.busyNow).length,
  })) {
    if (state) {
      const open = row.proposal_session_id && row.proposal_status && row.proposal_status !== 'closed';
      let proposal = null;
      if (open) {
        proposal = facts
          ? await proposalFacts(pool, Number(row.proposal_session_id), { domain })
          : { proposal: Number(row.proposal_session_id) };
      }
      rightNow.push(entry({
        row, number: row.issue_number, title: row.issue_title, firstVersion: !!row.first_version, state, proposal,
        limits: state.limit ? limitsFor(row, { settings, config, botSvc }) : {}, domain, now,
      }));
      continue;
    }
    const outcome = outcomeOf(row);
    const when = row.merged_at || row.run_at;
    if (outcome && when && new Date(when).getTime() >= cutoff && finished.length < MAX_FINISHED) {
      finished.push({
        project: row.slug,
        projectName: row.name || row.slug,
        number: Number(row.issue_number),
        title: row.first_version ? 'First version' : (row.issue_title || null),
        outcome,
        when: iso(when),
        links: links(domain, { slug: row.slug, number: row.issue_number, proposal: row.proposal_session_id }),
      });
    }
  }
  return {
    botIsOn: settings?.mode !== 'off',
    rightNow,
    finishedLately: finished.slice(0, MAX_FINISHED),
  };
}

/**
 * Pure: `progressFor`'s answer as a short message in plain words, for the
 * DM to send from the records alone when its model could not answer.
 */
function progressText(progress) {
  const lines = [];
  for (const item of (progress?.rightNow || []).slice(0, 5)) {
    const what = item.number
      ? `${item.projectName} request #${item.number}${item.title ? ` (${item.title})` : ''}`
      : `${item.projectName}, its ${String(item.title || 'first version').toLowerCase()}`;
    const step = item.step ? `step ${item.step} of ${item.of}, ` : '';
    const time = Number.isInteger(item.minutesSoFar)
      ? `, for ${item.minutesSoFar < 1 ? 'under a minute' : plural(item.minutesSoFar, 'minute')} so far`
      : '';
    lines.push(`- ${what}: ${step}${item.doing}${time}.`);
  }
  if (!lines.length) {
    const done = (progress?.finishedLately || [])[0];
    return done
      ? `I'm not working on anything for you right now. Most recently, ${done.projectName}${done.number ? ` request #${done.number}` : ''}: ${done.outcome}.`
      : 'I\'m not working on anything for you right now.';
  }
  const off = progress.botIsOn === false ? '\n\nI\'m switched off right now, so this waits until I\'m back on.' : '';
  return `Here is where things stand, from my records:\n\n${lines.join('\n')}${off}`;
}

module.exports = {
  FIRST_VERSION_STEPS,
  REQUEST_STEPS,
  SETUP_PARTS,
  BUSY_STAGES,
  IN_FLIGHT_STAGES,
  START_GRACE_MS,
  inFlight,
  stageOf,
  buildUnderWay,
  attemptOutcome,
  attachAttempts,
  queuedWait,
  buildWait,
  projectsBusy,
  botWorkByIssue,
  outcomeOf,
  setupOf,
  stepNumber,
  checksWords,
  failedCount,
  links,
  proposalFacts,
  requestStates,
  progressFor,
  progressText,
  // #8, #19 (WP3)
  TYPICAL_MINUTES,
  leftOverQueue,
  typicalMinutes,
};
