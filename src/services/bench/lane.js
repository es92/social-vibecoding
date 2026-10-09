'use strict';

// #3654: the benchmark's lane: runs launched by an admin, their trials
// scheduled a few at a time, within each run's dollar cap.
//
// Shape, like the bot's own build lane (homeroom-bot.js "The build lane"):
//
//   * Leader only, on a timer of its own, woken when a run is launched or a
//     trial ends. In-flight trials live in this process; the claim is a
//     conditional UPDATE, so a second drainer could never take the same one.
//   * A run's `concurrency` (1 to 8) trials at once, the oldest run first;
//     of them at most three heavy ones (a build, a checks fix or a spec,
//     each a container turn of many minutes): when the run's next trial is
//     heavy and three of its heavy trials are under way, the lane takes its
//     next light one (triage, DM, follow-up) instead of holding the run.
//     And at most eight trials in flight across every run, counting the ones
//     restart recovery is finishing.
//   * Never while the live bot's live work (the requests a person is waiting
//     for, read or built) fills every live slot it has, `liveAtOnce`
//     (homeroom-bot isLiveLaneSaturated): the benchmark waits for it, not
//     the other way round. Shadow builds do not hold it back; they are
//     experiments too. A later change's side builds (services/bot-configs.js,
//     kind `bot_config_later`) take only the live slots live work leaves
//     free: those in flight count beside the live work against `liveAtOnce`.
//     It was the bot's build concurrency (2) until 9 Oct 2026, from when live
//     builds had only that many slots; once they had `liveAtOnce` (12), any
//     two live builds held every side build back, and none started for hours
//     with twenty queued.
//   * The cap. Before a trial is claimed, what the run has spent, plus the
//     estimate of every trial still under way, plus this trial's estimate
//     (catalog.estimateTrialCost, deliberately pessimistic), must stay inside
//     the run's cap; the first trial that would cross it ends the run's
//     scheduling, and every trial not yet run is marked `skipped_cap` (a
//     side build's result with it, skipped: capRun). A trial that goes on
//     from what it kept after a restart is counted at what is still to come
//     of its estimate, less what its kept work cost (keptSpend), which its
//     run was charged already. The
//     bench user's own weekly allowance is checked too, as a backstop. What
//     a trial already under way spends cannot be stopped mid-turn (usage is
//     only known when the turn ends), so the cap can be overrun by at most
//     the overrun of the trials in flight at that moment.
//   * Resumable. Trials are rows, and a trial's session is on its row from
//     the moment it opens. A restart that interrupts a trial does one of
//     three things (server.js adoptOrphanWorker):
//       - its turn is the last one the trial needs (a triage, a follow-up,
//         a checks fix, or a build's build turn) and its worker is still
//         running it: recovery follows the turn's journal to its end and
//         the trial is finished here (finishRecoveredTrial), through the
//         same finisher a trial run start to end uses (recordTrial), held
//         in this lane's slots while it runs;
//       - a first version's or a configuration's side build's turn, any of
//         them, with its worker still running it: followed to its end too,
//         what it produced kept on the trial's checkpoint, and the trial
//         handed back to go on from there (handBackTrial), costing it no
//         claim;
//       - anything else (a build's spec turn, a DM conversation, a worker
//         that is gone): the turn is abandoned and the trial goes back to
//         `pending` at once (releaseTrial), what the interrupted attempt
//         spent charged to the run, or, after a second interruption, it is
//         `infra_fail`.
//     A trial nothing in this process holds and whose session has no turn
//     left is released on the lane's next pass (releaseOrphaned), and one
//     older than the longest a trial can take on the pass after that
//     (releaseStale), whatever else happened.
//   * Cancellable. A cancelled run claims nothing more, its pending trials
//     are `cancelled`, and its trials under way are stopped.
//
// Branches: a trial's `bench/` branch is deleted when it ends unless it
// holds commits (a build, a revision), which are kept BRANCH_KEEP_DAYS for
// a person to look at; the diff the judge reads is stored on the trial. A
// later change's side build's is kept while its pair waits for a pick, up
// to BRANCH_KEEP_WAITING_DAYS.

const crypto = require('crypto');
const log = require('../logger');
const catalog = require('./catalog');
const runner = require('./runner');
const dmSim = require('./dm-sim');
const taste = require('./taste');
const progress = require('./progress');
const snapshots = require('../homeroom-bot-snapshots');

const MAX_CONCURRENCY = 8;
// Heavy stages: at most this many of one run's at once.
// A taste trial (#3737) is a container of many minutes too: a first
// version's triage, spec and build, or a capture's install, boot and
// screenshots.
const HEAVY_STAGES = Object.freeze(['build', 'checks_fix', 'spec', 'first_version', 'capture']);
const MAX_HEAVY_PER_RUN = 3;
// Every trial in flight in this process, across runs.
const MAX_IN_FLIGHT = 8;
const MAX_MODELS = 10;
const MAX_REPEATS = 5;
const MIN_CAP_USD = 0.5;
const MAX_CAP_USD = 1000;
const DEFAULT_CAP_USD = 50;
const DEFAULT_REPEATS = 3;
// Builds and specs run once per model whatever `repeats` says: they are the
// expensive stages, and pass^k is a triage measure here.
// A capture (#3737) runs no model, so another attempt would take the same
// screenshots again.
const SINGLE_ATTEMPT_STAGES = Object.freeze(['build', 'spec', 'capture']);
const MAX_CLAIMS = 2;
const BRANCH_KEEP_DAYS = 7;
// A side build's branch whose pair still waits for a pick is kept past
// BRANCH_KEEP_DAYS, so the pair's compare link opens, but not for good: it
// sits on the live project's own repository. After this, the pair shows the
// diff stored on its trial (bot-configs.js diffSummary).
const BRANCH_KEEP_WAITING_DAYS = 30;
const IDLE_MS = 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
// How long a claimed trial may go without this process holding it before
// the lane counts it an earlier process's. Only the leader runs trials, and
// a new leader is elected only once the old one has exited, so any trial it
// does not hold is orphaned; the grace is a margin, not the mechanism.
const ORPHAN_GRACE_SECONDS = 120;
const TWICE_INTERRUPTED = 'interrupted: the platform restarted during it twice';
// A later change's side builds' runs (services/bot-configs.js LATER_SIDE_RUN_KIND).
const LATER_SIDE_RUN_KIND = 'bot_config_later';

const inFlight = new Map(); // trialId -> { runId, est, sessionId, promise, heavy, recovered? }
let laneOn = false;
let laneConfig = null;
let timer = null;
let ticking = false;
let tickAgain = false;
let lastTick = null;
let lastSweepAt = 0;

function token() {
  return crypto.randomBytes(12).toString('base64url');
}

function httpError(status, error) {
  return { ok: false, status, error };
}

// ── Launching ────────────────────────────────────────────────────────────

function validateLaunch(body) {
  const bot = require('../homeroom-bot');
  const suites = require('./suites');
  const suiteId = Number(body.suiteId);
  if (!Number.isInteger(suiteId) || suiteId <= 0) return httpError(400, 'Pick a suite');
  const models = [...new Set((Array.isArray(body.models) ? body.models : []).map((m) => String(m || '').trim()).filter(Boolean))];
  if (!models.length) return httpError(400, 'Pick at least one model');
  if (models.length > MAX_MODELS) return httpError(400, `At most ${MAX_MODELS} models in one run`);
  const bad = models.find((m) => !bot.MODEL_ID_RE.test(m));
  if (bad) return httpError(400, `${bad} is not an OpenRouter model id`);
  const stages = [...new Set(Array.isArray(body.stages) ? body.stages : [])];
  if (!stages.length || stages.some((s) => !suites.TASK_STAGES.includes(s))) {
    return httpError(400, `stages must be some of ${suites.TASK_STAGES.join(', ')}`);
  }
  const repeats = body.repeats == null ? DEFAULT_REPEATS : Number(body.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) return httpError(400, `repeats must be 1 to ${MAX_REPEATS}`);
  const capUsd = body.capUsd == null ? DEFAULT_CAP_USD : Number(body.capUsd);
  if (!Number.isFinite(capUsd) || capUsd < MIN_CAP_USD || capUsd > MAX_CAP_USD) {
    return httpError(400, `The cap must be from $${MIN_CAP_USD} to $${MAX_CAP_USD}`);
  }
  const concurrency = body.concurrency == null ? 1 : Number(body.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    return httpError(400, `concurrency must be 1 to ${MAX_CONCURRENCY}`);
  }
  // Core v1's launcher: which stages take `repeats` (the rest run once).
  // Left out, every stage but a build or a spec repeats, as before.
  let repeatStages = null;
  if (body.repeatStages != null) {
    if (!Array.isArray(body.repeatStages) || body.repeatStages.some((s) => !suites.TASK_STAGES.includes(s))) {
      return httpError(400, `repeatStages must be some of ${suites.TASK_STAGES.join(', ')}`);
    }
    repeatStages = [...new Set(body.repeatStages)].filter((s) => !SINGLE_ATTEMPT_STAGES.includes(s));
  }
  const baseline = models.includes(catalog.BASELINE) ? catalog.BASELINE : models[0];
  return {
    ok: true, suiteId, models, stages, repeats, capUsd: Math.round(capUsd * 100) / 100, concurrency, baseline, repeatStages,
    note: body.note ? String(body.note).slice(0, 500) : null,
  };
}

/** How many attempts a task at `stage` gets in a run. Pure. */
function attemptsFor(stage, { repeats, repeatStages = null }) {
  if (SINGLE_ATTEMPT_STAGES.includes(stage)) return 1;
  if (Array.isArray(repeatStages) && !repeatStages.includes(stage)) return 1;
  return repeats;
}

/**
 * The launcher's defaults (#3654 Core v1). Pure. The Core suite when it
 * exists (else the first frozen suite, else the newest), every catalog
 * candidate (the baseline first; a model entered for some stages only is
 * not applicable to the rest, which the run says per trial), every stage the
 * suite has tasks at, three repeats for triage and one for everything else,
 * and the $50 cap.
 */
const DEFAULT_STAGES = Object.freeze(['triage', 'dm']);

function launcherDefaults({ suites: all = [], coreSuiteId = null } = {}) {
  // The App bench studio's suite is launched from the studio, never as the
  // launcher's default (services/bench/studio.js).
  const list = all.filter((s) => s.name !== require('./studio').SUITE_NAME);
  const pick = list.find((s) => s.id === coreSuiteId) || list.find((s) => s.frozen_at) || list[0] || null;
  // Ticked by default: the cheap stages (triage, and DM, which is triage
  // turns), so a first Run of every model finishes under the $50 cap. Builds,
  // checks fixes and follow-ups cost one to two orders more per trial, and
  // eight models of them would stop at the cap part-way through; they are a
  // deliberate run of their own, ticked by hand.
  const stages = pick ? Object.keys(pick.counts || {})
    .filter((st) => DEFAULT_STAGES.includes(st) && (pick.counts[st] || 0) > 0) : [];
  const models = [catalog.BASELINE, ...catalog.CANDIDATES.map((c) => c.id).filter((id) => id !== catalog.BASELINE)];
  return {
    suiteId: pick ? pick.id : null,
    models,
    stages: stages.length ? stages : ['triage'],
    repeats: DEFAULT_REPEATS,
    repeatStages: ['triage'],
    capUsd: DEFAULT_CAP_USD,
  };
}

/** What each (model, stage) already cost per trial, for the estimates. */
async function costHistory(pool) {
  const { rows } = await pool.query(
    `SELECT tr.model, t.stage, tr.cost_usd::float8 AS cost
       FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id
      WHERE tr.cost_usd IS NOT NULL AND tr.status IN ('ok', 'model_fail', 'timeout')
      ORDER BY tr.id DESC LIMIT 5000`,
  );
  const map = new Map();
  for (const r of rows) {
    const key = `${r.model}|${r.stage}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(Number(r.cost));
  }
  return map;
}

/**
 * The trials a launch makes, decided up front, and what each is estimated to
 * cost, without writing anything. launchRun inserts this plan and
 * estimateRun shows it before anything is spent, so the figure the launcher
 * previews is the figure the launch records.
 */
async function planRun(pool, body = {}) {
  const v = validateLaunch(body);
  if (!v.ok) return v;
  const { rows: [suite] } = await pool.query('SELECT id, frozen_at FROM bench_suites WHERE id = $1', [v.suiteId]);
  if (!suite) return httpError(404, 'Suite not found');
  const { rows: tasks } = await pool.query(
    'SELECT id, stage, tags, reference FROM bench_tasks WHERE suite_id = $1 AND stage = ANY($2::text[]) ORDER BY id',
    [v.suiteId, v.stages],
  );
  if (!tasks.length) return httpError(409, 'The suite has no tasks at those stages');
  const models = await catalog.listModels(pool, v.models);
  const history = await costHistory(pool);
  const calibration = catalog.costCalibration(v.models.map((id) => catalog.modelInfo(models, id)), history);

  // `est` is the pessimistic figure the cap is scheduled against; `likely`
  // is what the trial will probably cost, for the preview (#3710); `range`
  // is what the launcher shows: a low and a high, and what they rest on.
  const plan = { task: [], stage: [], model: [], attempt: [], status: [], error: [], est: [], likely: [], range: [], token: [] };
  let estimate = 0;
  let likely = 0;
  for (const task of tasks) {
    const attempts = attemptsFor(task.stage, v);
    // A capture task (#3737) runs no model: once a run, under its baseline,
    // whatever models the run compares.
    const runsOn = task.stage === 'capture' ? [v.baseline] : v.models;
    for (const id of runsOn) {
      const info = catalog.modelInfo(models, id);
      const reason = dmSim.noAnswerReason(task) || taste.notRunnableReason(task)
        || (task.stage === 'capture' ? null : catalog.notApplicableReason(info, task.stage, task.tags?.prompt_chars));
      const past = history.get(`${id}|${task.stage}`) || [];
      const est = catalog.estimateTrialCost(info, task.stage, past);
      const probable = catalog.likelyTrialCost(info, task.stage, past, calibration);
      const range = catalog.costRange(info, task.stage, history, calibration);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        plan.task.push(task.id);
        plan.stage.push(task.stage);
        plan.model.push(id);
        plan.attempt.push(attempt);
        plan.status.push(reason ? 'not_applicable' : 'pending');
        plan.error.push(reason);
        plan.est.push(Math.round(est * 10000) / 10000);
        plan.likely.push(probable);
        plan.range.push(range);
        plan.token.push(token());
        if (!reason) { estimate += est; likely += probable; }
      }
    }
  }
  return { ok: true, v, suite, plan, estimate, likely, calibration };
}

/**
 * Room above the likely cost for the trials the lane holds at once: while
 * they run, the cap check counts each at its pessimistic estimate, so a cap
 * with no room above the likely cost stops the last trials early. The
 * dearest heavy trials the run can hold at once (MAX_HEAVY_PER_RUN), plus
 * its dearest light ones in the slots left. Pure.
 */
function capHeadroom(items, concurrency) {
  const slots = Math.max(1, Math.min(Number(concurrency) || 1, MAX_IN_FLIGHT));
  const heavySlots = Math.min(slots, MAX_HEAVY_PER_RUN);
  const heavy = items.filter((it) => HEAVY_STAGES.includes(it.stage)).map((it) => it.est).sort((a, b) => b - a);
  const light = items.filter((it) => !HEAVY_STAGES.includes(it.stage)).map((it) => it.est).sort((a, b) => b - a);
  const top = heavy.slice(0, heavySlots);
  // The slots left take light trials only: a run never holds more heavy ones.
  const rest = light.slice(0, slots - top.length);
  return [...top, ...rest].reduce((sum, n) => sum + n, 0);
}

/**
 * The cap a launch should get when nobody sets one (#3710): the likely cost
 * plus 15%, or plus the headroom the trials in flight need if that is more;
 * never more than the pessimistic total plus that headroom (the run fits
 * even if every trial costs what the dearest tenth have), whole dollars,
 * inside the lane's range. Pure.
 */
function suggestCap({ likelyUsd, pessimisticUsd, headroomUsd }) {
  const want = Math.max(likelyUsd * 1.15, likelyUsd + headroomUsd);
  const ceiling = pessimisticUsd + headroomUsd;
  return Math.min(MAX_CAP_USD, Math.max(1, Math.ceil(Math.min(want, ceiling))));
}

// How long a trial at each stage takes when a model has no history yet, in
// milliseconds: roughly the medians of the first production runs (#3654),
// rounded up.
const TRIAL_MS_FALLBACK = Object.freeze({
  triage: 60_000, dm: 60_000, spec: 300_000, build: 900_000, followup: 180_000, checks_fix: 240_000,
  // #3737, unmeasured: a first version's triage and doubled build clocks,
  // and a capture's install, boot and screenshots.
  first_version: 1_800_000, capture: 420_000,
});

/** The median duration of finished trials per (model, stage), for the time estimate. */
async function durationHistory(pool) {
  const { rows } = await pool.query(
    `SELECT tr.model, t.stage,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tr.duration_ms)::float8 AS ms
       FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id
      WHERE tr.duration_ms IS NOT NULL AND tr.status IN ('ok', 'model_fail', 'timeout')
      GROUP BY tr.model, t.stage`,
  );
  return new Map(rows.map((r) => [`${r.model}|${r.stage}`, Number(r.ms)]));
}

/**
 * About how long a run takes, from the time each of its trials should take.
 * Pure. The lane holds `concurrency` trials of a run at once, at most
 * MAX_HEAVY_PER_RUN of them heavy and at most MAX_IN_FLIGHT across runs, so
 * the run lasts at least as long as its heavy trials take spread over the
 * heavy slots, and as all its trials take spread over every slot. It is a
 * floor: live builds a person is waiting for go first.
 */
function estimateWallMs(items, concurrency) {
  const slots = Math.max(1, Math.min(Number(concurrency) || 1, MAX_IN_FLIGHT));
  const heavySlots = Math.max(1, Math.min(slots, MAX_HEAVY_PER_RUN));
  let heavyMs = 0;
  let allMs = 0;
  for (const it of items) {
    allMs += it.ms;
    if (HEAVY_STAGES.includes(it.stage)) heavyMs += it.ms;
  }
  return Math.round(Math.max(heavyMs / heavySlots, allMs / slots));
}

// What a stage's cost range rests on, strongest first (catalog.costRange).
const BASIS_ORDER = Object.freeze([null, 'none', 'own', 'stage', 'comparable', 'price', 'fixed']);

/**
 * What a launch with this body would do, without launching it: trials,
 * the ones not applicable, the estimate in dollars (per stage too), about
 * how long it takes, and the suite's state. The launcher calls it as the
 * settings change, so the price is on screen before anything is spent.
 */
async function estimateRun(pool, body = {}) {
  const planned = await planRun(pool, body);
  if (!planned.ok) return planned;
  const { v, suite, plan, estimate, likely, calibration } = planned;
  const durations = await durationHistory(pool);
  const byStage = {};
  const items = [];
  let low = 0;
  let high = 0;
  for (let i = 0; i < plan.task.length; i += 1) {
    const stage = plan.stage[i];
    if (!byStage[stage]) {
      byStage[stage] = { trials: 0, notApplicable: 0, estimateUsd: 0, likelyUsd: 0, lowUsd: 0, highUsd: 0, basis: null, from: null };
    }
    if (plan.status[i] === 'not_applicable') {
      byStage[stage].notApplicable += 1;
      continue;
    }
    const s = byStage[stage];
    const range = plan.range[i];
    s.trials += 1;
    s.estimateUsd += plan.est[i];
    s.likelyUsd += plan.likely[i];
    s.lowUsd += range.low;
    s.highUsd += range.high;
    low += range.low;
    high += range.high;
    // A stage's range rests on the weakest of its trials' (a model with no
    // history makes the whole stage a guess).
    if (BASIS_ORDER.indexOf(range.basis) > BASIS_ORDER.indexOf(s.basis)) { s.basis = range.basis; s.from = range.from; }
    items.push({ stage, est: plan.est[i], ms: durations.get(`${plan.model[i]}|${stage}`) ?? TRIAL_MS_FALLBACK[stage] ?? 120_000 });
  }
  const cents = (n) => Math.round(n * 100) / 100;
  for (const s of Object.values(byStage)) {
    s.estimateUsd = cents(s.estimateUsd); s.likelyUsd = cents(s.likelyUsd); s.lowUsd = cents(s.lowUsd); s.highUsd = cents(s.highUsd);
  }
  const headroomUsd = capHeadroom(items, v.concurrency);
  return {
    ok: true,
    trials: items.length,
    notApplicable: plan.task.length - items.length,
    // What it will probably cost, and at most: the pessimistic figure the
    // cap is scheduled against, the one a launch records.
    likelyUsd: cents(likely),
    estimateUsd: cents(estimate),
    // The range the launcher shows, each stage's resting on what it says in
    // byStage[stage].basis (catalog.costRange).
    lowUsd: cents(low),
    highUsd: cents(high),
    byStage,
    calibratedFrom: calibration.any ? calibration.any.from : 0,
    // Suggested from the range where it is above the single figure: a stage
    // priced from the stage it is most like would otherwise get a cap that
    // stops it after a trial or two.
    suggestedCapUsd: suggestCap({ likelyUsd: Math.max(likely, low), pessimisticUsd: Math.max(estimate, high), headroomUsd }),
    estimatedMs: estimateWallMs(items, v.concurrency),
    capUsd: v.capUsd,
    maxCapUsd: MAX_CAP_USD,
    suiteFrozen: !!suite.frozen_at,
  };
}

/**
 * Launch a run: one trial per task, model and attempt, decided up front. A
 * trial a model cannot take is recorded `not_applicable` with its reason at
 * once; the rest wait as `pending` for the lane.
 */
async function launchRun(pool, body = {}, { actorId = null } = {}) {
  const planned = await planRun(pool, body);
  if (!planned.ok) return planned;
  const { v, suite, plan, estimate } = planned;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [run] } = await client.query(
      `INSERT INTO bench_runs (suite_id, models, baseline_model, stages, repeats, cap_usd, concurrency, note, started_by)
       VALUES ($1, $2::text[], $3, $4::text[], $5, $6, $7, $8, $9)
       RETURNING *`,
      [v.suiteId, v.models, v.baseline, v.stages, v.repeats, v.capUsd, v.concurrency, v.note, actorId],
    );
    await client.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, error, est_cost_usd, item_token, finished_at)
       SELECT $1, t, m, a, s, e, est, tok, CASE WHEN s = 'not_applicable' THEN NOW() ELSE NULL END
         FROM UNNEST($2::int[], $3::text[], $4::int[], $5::text[], $6::text[], $7::numeric[], $8::text[])
              AS p(t, m, a, s, e, est, tok)`,
      [run.id, plan.task, plan.model, plan.attempt, plan.status, plan.error, plan.est, plan.token],
    );
    await client.query('COMMIT');
    wake();
    return {
      ok: true,
      run,
      trials: plan.task.length,
      notApplicable: plan.status.filter((s) => s === 'not_applicable').length,
      estimateUsd: Math.round(estimate * 100) / 100,
      suiteFrozen: !!suite.frozen_at,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function cancelRun(pool, runId, deps = {}) {
  const { rows } = await pool.query(
    `UPDATE bench_runs SET status = 'cancelled', finished_at = NOW()
      WHERE id = $1 AND status IN ('queued', 'running') RETURNING id`,
    [Number(runId)],
  );
  if (!rows.length) return httpError(409, 'The run is not running');
  await pool.query(
    "UPDATE bench_trials SET status = 'cancelled', finished_at = NOW() WHERE run_id = $1 AND status = 'pending'",
    [Number(runId)],
  );
  const worker = deps.worker || require('../worker');
  for (const [trialId, f] of inFlight) {
    if (f.runId !== Number(runId) || !f.sessionId) continue;
    Promise.resolve(worker.stopTurn(f.sessionId)).catch(() => {});
    log.info('bench', 'Stopping a trial of a cancelled run', { trialId });
  }
  return { ok: true };
}

/**
 * Cancel one trial (the studio's cancel): a pending one is marked cancelled
 * at once; a running one has its turn stopped and starts nothing more
 * (executeTrial's skipCheck), and is recorded cancelled when it ends.
 * Resolves { ok, status } or a refusal.
 */
async function cancelTrial(pool, trialId, deps = {}) {
  const id = Number(trialId);
  const { rows: [pending] } = await pool.query(
    `UPDATE bench_trials SET status = 'cancelled', finished_at = NOW(), error = 'cancelled by an admin'
      WHERE id = $1 AND status IN ('pending', 'awaiting') RETURNING id`,
    [id],
  );
  if (pending) { wake(); return { ok: true, status: 'cancelled' }; }
  const f = inFlight.get(id);
  if (!f) {
    const { rows: [t] } = await pool.query('SELECT status FROM bench_trials WHERE id = $1', [id]);
    if (!t) return httpError(404, 'No such trial');
    return httpError(409, t.status === 'running' ? 'That trial is running on another process' : `That trial is already ${t.status}`);
  }
  f.cancelled = true;
  if (f.sessionId) {
    const worker = deps.worker || require('../worker');
    Promise.resolve(worker.stopTurn(f.sessionId)).catch(() => {});
  }
  log.info('bench', 'Stopping one trial', { trialId: id });
  return { ok: true, status: 'stopping' };
}

/**
 * A run with work added to it after it ended (a re-run trial, a reference
 * build handed in): back to `running`, so the lane picks the new trials up.
 * A cancelled run stays cancelled. Resolves whether the run is open.
 */
async function reopenRun(pool, runId) {
  await pool.query(
    `UPDATE bench_runs SET status = 'running', finished_at = NULL
      WHERE id = $1 AND status IN ('done', 'capped')`,
    [Number(runId)],
  );
  const { rows: [open] } = await pool.query('SELECT status FROM bench_runs WHERE id = $1', [Number(runId)]);
  if (open && ['queued', 'running'].includes(open.status)) { wake(); return true; }
  return false;
}

// ── Running a trial ──────────────────────────────────────────────────────

function liveDeps(deps = {}) {
  const github = deps.github || require('../github');
  return {
    worker: deps.worker || require('../worker'),
    sessions: deps.sessions || require('../../routes/sessions'),
    agentTurn: deps.agentTurn || require('../agent-turn'),
    activeWorkers: deps.activeWorkers || require('../active-workers').activeWorkers,
    limits: deps.limits || require('../limits'),
    managedOpenRouter: deps.managedOpenRouter || require('../openrouter-managed-keys'),
    // The only GitHub a trial is ever handed.
    github: runner.guardedGithub(github),
    runHiddenChecks: deps.runHiddenChecks || null,
    afterTrial: deps.afterTrial || null,
  };
}

async function loadTrialContext(pool, trialId) {
  const { rows: [row] } = await pool.query(
    `SELECT tr.*, t.stage, t.snapshot_id, t.reference, t.tags, t.issue_number AS task_issue,
            a.id AS app_id, a.slug AS app_slug, a.name AS app_name, a.repo_url, a.self_hosted,
            r.baseline_model AS run_baseline, r.kind AS run_kind
       FROM bench_trials tr
       JOIN bench_tasks t ON t.id = tr.task_id
       JOIN bench_runs r ON r.id = tr.run_id
       LEFT JOIN apps a ON a.id = t.app_id
      WHERE tr.id = $1`,
    [Number(trialId)],
  );
  return row || null;
}

// The studio's `today` preset (services/bench/studio.js): the live bot's own
// model for each stage, read when the trial runs.
const TODAY = 'today';

/**
 * What a studio trial is given beyond its task: its context pack's guidance
 * per stage, the model of each turn of a first version, and, for a
 * reference build, the model its session is stamped with (it runs none).
 * Empty for every other trial.
 */
async function studioContext(pool, config, row, settings) {
  const bot = require('../homeroom-bot');
  const botConfigs = require('../bot-configs');
  const out = {};
  if (row.context_pack_id) {
    const packs = require('./packs');
    const pack = await packs.packRow(pool, row.context_pack_id);
    if (!pack) throw new Error('the trial\'s context pack is gone');
    out.pack = pack;
    out.guidance = Object.fromEntries(packs.STAGES.map((st) => [st, packs.guidanceFor(pack, st) || null]));
  }
  // A configuration version (services/bot-configs.js) the trial builds by:
  // a side build of a live first version names it on the trial, a studio
  // arm as its model (`config:<id>`). `today` is not one: it is the live
  // bot's per-stage models, as it always was (below); the current
  // configuration is an arm of its own, `config:<its id>`.
  const namedId = row.bot_config_version_id || botConfigs.configIdOfModel(row.model);
  const version = namedId ? await botConfigs.versionById(pool, namedId) : null;
  const recipe = version ? botConfigs.recipeOf(version.recipe) : null;
  if (namedId && !recipe) throw new Error('the trial\'s configuration version is gone');
  if (recipe) {
    out.stageModels = { ...recipe.models };
    out.harnessOf = require('../homeroom-bot-live').recipeHarness;
    out.configVersionId = version.id;
    if (botConfigs.reviews(recipe)) out.reviewer = recipe.reviewer;
    if (recipe.pack && !row.context_pack_id) {
      const packs = require('./packs');
      const pack = await packs.packRow(pool, recipe.pack);
      if (pack) {
        out.pack = pack;
        out.guidance = Object.fromEntries(packs.STAGES.map((st) => [st, packs.guidanceFor(pack, st) || null]));
      }
    }
    if (row.bot_config_version_id) out.sideBuild = { botRunId: row.bot_run_id || null, versionId: version.id };
  } else if (row.model === TODAY) {
    out.stageModels = {
      triage: bot.stageModel(settings, config, 'triage'),
      spec: bot.stageModel(settings, config, 'spec'),
      build: bot.stageModel(settings, config, 'build'),
    };
    if (!out.stageModels.build) throw new Error('no model is set for the bot\'s stages');
  }
  if (row.reference_label) out.sessionModel = row.run_baseline || catalog.BASELINE;
  return out;
}

/** The trial's session (and branch and base), on its row as soon as they exist. */
async function noteSession(pool, trialId, sessionId, { baseSha = null, branch = null } = {}) {
  try {
    await pool.query(
      `UPDATE bench_trials
          SET session_id = $2, base_sha = COALESCE($3, base_sha), build_branch = COALESCE($4, build_branch)
        WHERE id = $1 AND status = 'running'`,
      [Number(trialId), Number(sessionId), baseSha || null, branch || null],
    );
  } catch (err) {
    log.warn('bench', 'Could not record a trial\'s session', { trialId, sessionId, err: err.message });
  }
}

/**
 * A trial that keeps a checkpoint and goes on from it after a restart: a
 * first version, and a configuration's side build (services/bot-configs.js),
 * of a first version or of a later change (runner.sideBuildStage,
 * laterSideBuildStage). A reference build has no turns to keep. Pure.
 *
 * Side builds were run again from the start until 7 Oct 2026, when restarts
 * every 3 to 15 minutes left almost none of them able to finish.
 */
function goesOnAfterRestart(row) {
  if (!row || row.reference_label) return false;
  if (row.bot_config_version_id) return row.stage === 'first_version' || row.stage === 'build';
  return row.stage === 'first_version';
}

/**
 * Part of a running trial's checkpoint, merged in at its top level
 * (runner.firstVersionStage keeps each sub-step as it finishes). Throws on a
 * failed write; the stage carries on without it.
 */
async function saveCheckpoint(pool, trialId, part) {
  await pool.query(
    `UPDATE bench_trials SET checkpoint = COALESCE(checkpoint, '{}'::jsonb) || $2::jsonb
      WHERE id = $1 AND status = 'running'`,
    [Number(trialId), JSON.stringify(part)],
  );
}

/**
 * How many of a trial's sub-steps its checkpoint holds: each is progress a
 * restart did not lose. A side build's review counts once it has begun: a
 * restart in it is recorded cut short, never run again
 * (runner.settleCutShortReview). Pure.
 */
function stepsKept(checkpoint) {
  const cp = checkpoint || {};
  return ['triage', 'spec', 'build', 'review'].filter((k) => cp[k]).length;
}

/** The sessions whose work a trial's checkpoint keeps: its triage, spec, build and review. Pure. */
function keptSessions(checkpoint) {
  const cp = checkpoint || {};
  return new Set([cp.triage?.session_id, cp.spec?.sessionId, cp.build?.sessionId, cp.reviewSessionId].filter(Boolean).map(Number));
}

/**
 * What a trial that goes on from its checkpoint has already spent on the
 * work it keeps (keptSessions), as its run was charged for it (`charged`,
 * releaseTrial): the part of its estimate it will not spend again. What an
 * interrupted attempt threw away is not in it; that work is still to come.
 * Zero for a trial with no checkpoint. Pure.
 */
function keptSpend(checkpoint) {
  const cp = checkpoint || {};
  const charged = cp.charged && typeof cp.charged === 'object' ? cp.charged : {};
  let sum = 0;
  for (const id of keptSessions(cp)) sum += Math.max(Number(charged[String(id)]) || 0, 0);
  return sum;
}

/**
 * What a trial's sessions spent that no release has charged to its run yet:
 * those in `sessionIds` and, for a trial with a checkpoint, every session it
 * opened in any claim, but for those in `skip`, which the caller accounts
 * for itself. `interrupted` is the part whose work the checkpoint does not
 * keep, and `charged` each session's share, to add to the checkpoint's
 * record of what was charged.
 */
async function unchargedSpend(pool, checkpoint, { sessionIds = [], skip = [] } = {}) {
  const cp = checkpoint || {};
  const already = cp.charged && typeof cp.charged === 'object' ? cp.charged : {};
  const kept = keptSessions(cp);
  const skipped = new Set(skip.map(Number));
  const ids = [...new Set([...(Array.isArray(cp.sessions) ? cp.sessions : []), ...sessionIds]
    .filter((x) => x != null).map(Number))].filter((id) => !skipped.has(id));
  const out = { cost: 0, interrupted: 0, charged: {} };
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(already, String(id))) continue;
    // eslint-disable-next-line no-await-in-loop
    const usage = await runner.sessionUsage(pool, id).catch(() => null);
    const cost = usage && Number(usage.priced) > 0 ? Math.max(Number(usage.cost) || 0, 0) : 0;
    out.charged[id] = cost;
    out.cost += cost;
    if (!kept.has(id)) out.interrupted += cost;
  }
  return out;
}

/**
 * Run one claimed trial and record it. Resolves its final status. Never
 * throws: whatever goes wrong is recorded on the trial.
 */
async function executeTrial(pool, config, trialRow, deps = {}) {
  const d = liveDeps(deps);
  const bot = require('../homeroom-bot');
  const row = await loadTrialContext(pool, trialRow.id);
  let patch;
  let user = null;
  let watch = null;
  let writes = Promise.resolve();
  try {
    if (!row) throw new Error('the trial is gone');
    if (!row.app_id) throw new Error('the task\'s app is gone');
    const repo = bot.parseRepo(row.repo_url);
    if (!repo) throw new Error('the app has no GitHub repository');
    const snapshot = await snapshots.readSnapshot(pool, row.snapshot_id);
    if (!snapshot) throw new Error('the task\'s snapshot is gone');
    user = deps.user || await runner.ensureBenchUser(pool, config);
    const settings = await bot.readSettings(pool);
    const app = { id: row.app_id, slug: row.app_slug, name: row.app_name, repo_url: row.repo_url, self_hosted: row.self_hosted };
    const task = { id: row.task_id, stage: row.stage, reference: row.reference || {}, tags: row.tags || {} };
    const studio = await studioContext(pool, config, row, settings);
    const model = studio.stageModels ? studio.stageModels.build : row.model;
    // A first version or a side build goes on after a restart from what it
    // kept ("After a restart", below), the skills it already reached for
    // included.
    const resumes = goesOnAfterRestart(row);
    // Every write to its checkpoint, one after another, each with the skills
    // and looks seen by the time it is written: a later write never lands
    // under an earlier one's counts. The watch keeps them there as they
    // change too, so a restart mid-turn loses only the last few seconds.
    const keepOnTrial = (part) => {
      const write = writes.then(() => saveCheckpoint(pool, row.id, { ...part, skills: watch.skills(), looks: watch.looks() }));
      writes = write.catch(() => {});
      return write;
    };
    watch = progress.tracker(pool, row.id, {
      log, skills: resumes ? row.checkpoint?.skills : null, looks: resumes ? row.checkpoint?.looks : null,
      ...(resumes ? { keep: keepOnTrial } : {}),
    });
    const cancelled = () => !!inFlight.get(row.id)?.cancelled;
    patch = await runner.runStage({
      pool, config, stage: row.stage, task, snapshot, model, user, app, repo,
      trial: {
        id: row.id, run_id: row.run_id, attempt: row.attempt,
        reference_label: row.reference_label || null, capture_sha: row.capture_sha || null,
        base_sha: row.base_sha || null, build_commits: row.build_commits ?? null,
      },
      deps: d, budgets: runner.budgetsFor(settings, app, config, row.stage),
      title: `Homeroom benchmark: run ${row.run_id}, trial ${row.id}`,
      ...studio,
      onStep: (name) => watch.step(name),
      onActivity: (line) => watch.note(line),
      // An admin's cancel of this one trial (cancelTrial): its turn is
      // stopped there, and nothing after it starts.
      skipCheck: async () => (cancelled() ? 'cancelled by an admin' : null),
      // Written before the turn runs: restart recovery finds the trial
      // through its session.
      onSession: async (sessionId, where) => {
        const f = inFlight.get(row.id);
        if (f) f.sessionId = sessionId;
        await noteSession(pool, row.id, sessionId, where);
      },
      ...(resumes ? { checkpoint: row.checkpoint || null, onCheckpoint: keepOnTrial } : {}),
    });
    const skills = watch.skills();
    if (skills.invoked.length || skills.read.length || row.context_pack_id) {
      patch.parsed = { ...(patch.parsed || {}), skills };
    }
    // The looks its turns took in the in-loop browser, beside what its build
    // was told it could see and what its model was handed (runner.buildStage).
    const looks = watch.looks();
    if (patch.parsed?.sight || looks.screenshots || looks.snapshots || looks.navigations) {
      patch.parsed = { ...(patch.parsed || {}), sight: { told: null, passed: null, ...(patch.parsed?.sight || {}), ...looks } };
    }
    if (cancelled()) patch = { ...patch, status: 'cancelled', error: 'cancelled by an admin' };
  } catch (err) {
    patch = { status: 'infra_fail', error: `setup: ${err.message}` };
  } finally {
    if (watch) await watch.close();
    await writes;
  }
  return recordTrial(pool, { trialRow, row, patch, user, d });
}

/**
 * A trial's turns are over: record what they did. Shared by a trial run
 * start to end (executeTrial) and one whose last turn restart recovery
 * followed (finishRecoveredTrial), so the two cannot drift: the ledger cost,
 * the trial's row, the run's spend and the allowance debit, the sessions put
 * away, an empty branch deleted, and the deterministic grade.
 *
 * `recovered` also requires the trial to still be on `sessionId`, charges
 * the run only when this recorded the trial (a release may already have
 * charged it), stamps recovered_at, and leaves the worker to recovery, which
 * still has the turn record to clear in it.
 */
async function recordTrial(pool, { trialRow, row, patch, user, d, recovered = false, sessionId = null }) {
  // What the trial's own session spent, from the ledger: exact, and it
  // counts every attempt the turn made, failed ones included.
  const sessionIds = [...new Set([patch.session_id, ...(patch.session_ids || [])].filter(Boolean))];
  let cost = Number.isFinite(patch.cost_usd) ? patch.cost_usd : null;
  // What the trial spent beside its agent turns, which the ledger below
  // does not hold: a first version's reviewer calls (services/bot-review.js).
  const besideLedger = Number.isFinite(Number(patch.review_cost_usd)) ? Math.max(Number(patch.review_cost_usd), 0) : 0;
  let inputTokens = patch.input_tokens ?? null;
  let outputTokens = patch.output_tokens ?? null;
  const routedModels = new Set();
  const ledger = { cost: 0, priced: 0, input: 0, output: 0 };
  for (const id of sessionIds) {
    // eslint-disable-next-line no-await-in-loop
    const usage = await runner.sessionUsage(pool, id).catch(() => null);
    if (!usage) continue;
    ledger.cost += Number(usage.cost) || 0;
    ledger.priced += Number(usage.priced) || 0;
    ledger.input += Number(usage.input_tokens) || 0;
    ledger.output += Number(usage.output_tokens) || 0;
    for (const m of usage.routed_models || []) routedModels.add(m);
  }
  if (ledger.priced > 0) cost = ledger.cost + besideLedger;
  if (ledger.input > 0) inputTokens = ledger.input;
  if (ledger.output > 0) outputTokens = ledger.output;
  // A first version that went on after a restart: a release already charged
  // its run what the sessions it opened before then spent. Its own cost is
  // still every session its result is built from; the run is charged only
  // what no release has, and a session whose work was thrown away (spent,
  // never charged) is its interrupted cost, not its own.
  let charge = cost;
  let interruptedAdd = 0;
  const { rows: [held] = [] } = await pool.query('SELECT checkpoint FROM bench_trials WHERE id = $1', [trialRow.id]);
  if (held?.checkpoint) {
    const charged = held.checkpoint.charged || {};
    const before = sessionIds.reduce((sum, id) => sum + (Number(charged[String(id)]) || 0), 0);
    const rest = await unchargedSpend(pool, held.checkpoint, { skip: sessionIds });
    charge = Math.max((Number(cost) || 0) - before, 0) + rest.cost;
    interruptedAdd = rest.cost;
  }
  // Which model OpenRouter actually served: a check that the trial ran what
  // it was meant to. Kept on the trial, never shown to a judge.
  const parsed = patch.parsed || routedModels.size
    ? { ...(patch.parsed || {}), ...(routedModels.size ? { routedModels: [...routedModels] } : {}) }
    : null;

  const { rows: [after] } = await pool.query(
    `UPDATE bench_trials tr
        SET status = CASE WHEN r.status = 'cancelled' THEN 'cancelled' ELSE $2 END,
            raw_output = $3, parsed = $4::jsonb, cost_usd = $5, input_tokens = $6, output_tokens = $7,
            -- With the time its earlier claims ran, when a restart split it.
            duration_ms = CASE WHEN $8::int IS NULL THEN NULL ELSE LEAST($8::bigint + tr.prior_ms, 2147483647)::int END,
            session_id = $9, base_sha = $10, build_branch = $11, build_sha = $12,
            build_commits = $13, diff = $14, changed_files = $15::jsonb, checks = $16::jsonb, error = $17,
            recovered_at = CASE WHEN $18::boolean THEN NOW() ELSE tr.recovered_at END,
            capture = $20::jsonb,
            interrupted_cost_usd = tr.interrupted_cost_usd + $21::numeric,
            finished_at = NOW()
       FROM bench_runs r
      WHERE tr.id = $1 AND r.id = tr.run_id AND tr.status = 'running'
        AND ($19::int IS NULL OR tr.session_id = $19)
      RETURNING tr.status, tr.run_id`,
    [trialRow.id, patch.status, patch.raw_output ?? null, parsed ? JSON.stringify(parsed) : null,
      cost, inputTokens, outputTokens, patch.duration_ms ?? null, sessionIds[0] || null,
      patch.base_sha || null, patch.build_branch || null, patch.build_sha || null,
      Number.isFinite(patch.build_commits) ? patch.build_commits : null,
      patch.diff ?? null, patch.changed_files ? JSON.stringify(patch.changed_files) : null,
      patch.checks ? JSON.stringify(patch.checks) : null,
      patch.error ? String(patch.error).slice(0, 1000) : null,
      !!recovered, recovered && sessionId ? Number(sessionId) : null,
      patch.capture ? JSON.stringify(patch.capture) : null, interruptedAdd],
  );
  if (charge > 0 && (!recovered || after)) {
    await pool.query('UPDATE bench_runs SET spent_usd = spent_usd + $2 WHERE id = $1', [trialRow.run_id, charge]);
    try {
      if (user && await d.managedOpenRouter.usesIncludedKey(pool, user.id)) {
        await d.limits.recordSpend(pool, user.id, Math.round(charge * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('bench', 'Benchmark spend debit failed', { err: err.message });
    }
  }
  // Put the trial's sessions away; nobody opens them.
  if (sessionIds.length && user) {
    await pool.query(
      `UPDATE chat_sessions SET status = 'archived', archived_at = NOW()
        WHERE id = ANY($1::int[]) AND user_id = $2 AND status IN ('active', 'paused')`,
      [sessionIds, user.id],
    ).catch(() => {});
    if (!recovered) for (const id of sessionIds) Promise.resolve(d.worker.evictWorker?.(id)).catch(() => {});
  }
  // A branch with nothing on it is not kept. Nor is a first version's side
  // build's (services/bot-configs.js): it sits on the live project's own
  // repository, and its diff and screenshots are on the trial already. A
  // later change's side build keeps its commits for the sweep, as any build
  // trial does, so its pair's compare link opens while the pair waits.
  if (patch.build_branch && (!(patch.build_commits > 0) || (row?.bot_config_version_id && row?.run_kind !== LATER_SIDE_RUN_KIND)) && row?.repo_url) {
    await deleteBranch(pool, d.github, row.repo_url, patch.build_branch, trialRow.id);
  }
  // The deterministic grade, at once: a build's diff-scope rule reads the
  // branch while it is still there.
  const grade = d.afterTrial || ((p, id) => require('./graders').gradeTrial(p, id, { github: d.github }));
  await Promise.resolve(grade(pool, trialRow.id)).catch((err) => {
    log.warn('bench', 'After-trial grading failed', { trialId: trialRow.id, err: err.message });
  });
  // A side build's result, and the pairs it completes (services/bot-configs.js).
  if (row?.bot_config_version_id && after) await require('../bot-configs').finishSideTrial(pool, trialRow.id);
  log.info('bench', recovered ? 'Trial finished after a restart' : 'Trial finished', {
    trialId: trialRow.id, runId: trialRow.run_id, stage: row?.stage, status: after?.status || patch.status, costUsd: cost,
  });
  return after?.status || patch.status;
}

async function deleteBranch(pool, github, repoUrl, branch, trialId) {
  const bot = require('../homeroom-bot');
  const repo = bot.parseRepo(repoUrl);
  if (!repo) return false;
  try {
    await github.deleteBenchBranch(repo.owner, repo.repo, branch);
    await pool.query('UPDATE bench_trials SET branch_deleted_at = NOW() WHERE id = $1', [trialId]);
    return true;
  } catch (err) {
    log.warn('bench', 'Could not delete a benchmark branch', { branch, err: err.message });
    return false;
  }
}

/**
 * Kept branches past their time, deleted. A side build's whose pair still
 * waits for a pick is kept on, as recordTrial says it is, until the pair is
 * picked (or left out) or BRANCH_KEEP_WAITING_DAYS pass: before, the sweep
 * took it at seven days like any other, and the pair's compare link stopped
 * opening while the pair still waited. Throttled; never throws.
 */
async function sweepBranches(pool, deps = {}, now = Date.now()) {
  if (now - lastSweepAt < SWEEP_EVERY_MS && !deps.force) return 0;
  lastSweepAt = now;
  const github = runner.guardedGithub(deps.github || require('../github'));
  const { rows } = await pool.query(
    `SELECT tr.id, tr.build_branch, a.repo_url
       FROM bench_trials tr
       JOIN bench_tasks t ON t.id = tr.task_id
       JOIN apps a ON a.id = t.app_id
      WHERE tr.build_branch IS NOT NULL AND tr.branch_deleted_at IS NULL
        AND tr.kept_at IS NULL
        AND tr.finished_at < NOW() - make_interval(days => $1)
        AND (tr.finished_at < NOW() - make_interval(days => $2)
             OR NOT EXISTS (
               SELECT 1 FROM bot_config_results cr
                 JOIN bot_config_pairs p ON p.side_result_id = cr.id
                WHERE cr.trial_id = tr.id AND p.status = 'waiting'))
      ORDER BY tr.id LIMIT 50`,
    [BRANCH_KEEP_DAYS, BRANCH_KEEP_WAITING_DAYS],
  );
  let n = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await deleteBranch(pool, github, r.repo_url, r.build_branch, r.id)) n += 1;
  }
  // A run's shared first commits (services/bench/scaffold.js), once the run
  // is over and they are as old as a build's branch may be: a reference
  // built later would have nothing to start from, and its order says so.
  const { rows: firsts } = await pool.query(
    `SELECT sc.id, sc.branch, a.repo_url
       FROM bench_scaffolds sc
       JOIN bench_runs r ON r.id = sc.run_id
       JOIN bench_tasks t ON t.id = sc.task_id
       JOIN apps a ON a.id = t.app_id
      WHERE sc.branch IS NOT NULL AND sc.branch_deleted_at IS NULL
        AND r.status NOT IN ('queued', 'running')
        AND sc.claimed_at < NOW() - make_interval(days => $1)
      ORDER BY sc.id LIMIT 50`,
    [BRANCH_KEEP_DAYS],
  );
  const bot = require('../homeroom-bot');
  for (const r of firsts) {
    const repo = bot.parseRepo(r.repo_url);
    if (!repo) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await github.deleteBenchBranch(repo.owner, repo.repo, r.branch);
      // eslint-disable-next-line no-await-in-loop
      await pool.query('UPDATE bench_scaffolds SET branch_deleted_at = NOW() WHERE id = $1', [r.id]);
      n += 1;
    } catch (err) {
      log.warn('bench', 'Could not delete a first commit\'s branch', { branch: r.branch, err: err.message });
    }
  }
  return n;
}

// ── The lane ─────────────────────────────────────────────────────────────

/**
 * Trials a process that is gone left running. Back to pending once they are
 * older than the longest a trial can take, or failed after a second
 * interruption. Their sessions were abandoned by restart recovery.
 */
async function releaseStale(pool, settings) {
  const turnSeconds = Number(settings?.turnSeconds) || 1200;
  const bot = require('../homeroom-bot');
  const live = require('../homeroom-bot-live');
  const seconds = bot.PLATFORM_BUILD_TIME_FACTOR * (turnSeconds + live.SPEC_TURN_MAX_MS / 1000) + 600;
  const { rows } = await pool.query(
    `UPDATE bench_trials
        SET status = CASE WHEN claims < $3 THEN 'pending' ELSE 'infra_fail' END,
            error = CASE WHEN claims < $3 THEN NULL ELSE $4::text END,
            started_at = CASE WHEN claims < $3 THEN NULL ELSE started_at END,
            finished_at = CASE WHEN claims < $3 THEN NULL ELSE NOW() END
      WHERE status = 'running' AND started_at < NOW() - make_interval(secs => $1)
        AND NOT (id = ANY($2::int[]))
      RETURNING id, status`,
    [seconds, [...inFlight.keys()], MAX_CLAIMS, TWICE_INTERRUPTED],
  );
  if (rows.length) log.info('bench', 'Released trials an earlier process never finished', { trials: rows.length });
  return rows.length;
}

/**
 * A trial a restart interrupted, put back: `pending` for the lane to run
 * again, or `infra_fail` after a second interruption (or `cancelled` /
 * `skipped_cap` when its run has stopped meanwhile). What the interrupted
 * attempt spent, as its session's ledger has it, is charged to the run
 * (spent_usd, so the cap stays honest) and to the bench allowance, and kept
 * on the trial in interrupted_cost_usd: the attempt that finishes the trial
 * records only its own session's cost, so nothing is counted twice.
 * Conditional on the trial still being `running` on `sessionId`, so a
 * second caller for the same interruption changes and charges nothing.
 * Resolves the trial's new status, or null when it was not released.
 *
 * A first version or a side build with a checkpoint goes on from it rather
 * than starting again, as the bot's own builds do (homeroom-bot.js
 * handBackRun): every session it opened is charged once, the part whose work
 * it keeps counted as its own and the rest as interrupted; the time this
 * claim ran is added to prior_ms; and a restart that cost it no kept work
 * (the checkpoint holds more sub-steps than at its last hand-back) does not
 * spend a claim, so only an interruption that loses work counts toward the
 * second that fails it.
 */
async function releaseTrial(pool, { trialId, sessionId = null, why = 'interrupted', deps = {} }) {
  const { rows: [held] } = await pool.query(
    `SELECT checkpoint FROM bench_trials
      WHERE id = $1 AND status = 'running' AND session_id IS NOT DISTINCT FROM $2::int`,
    [Number(trialId), sessionId == null ? null : Number(sessionId)],
  );
  if (!held) return null;
  const cp = held.checkpoint || null;
  let cost = 0;
  let interrupted = 0;
  let update = null;
  let free = false;
  if (cp) {
    const spend = await unchargedSpend(pool, cp, { sessionIds: [sessionId] });
    ({ cost, interrupted } = spend);
    const kept = stepsKept(cp);
    free = kept > (Number(cp.handedBackAt) || 0);
    update = {
      charged: { ...(cp.charged || {}), ...spend.charged },
      ...(free ? { handedBackAt: kept, handBacks: (Number(cp.handBacks) || 0) + 1 } : {}),
    };
  } else {
    const usage = sessionId ? await runner.sessionUsage(pool, sessionId).catch(() => null) : null;
    cost = usage && Number(usage.priced) > 0 ? Math.max(Number(usage.cost) || 0, 0) : 0;
    interrupted = cost;
  }
  const { rows: [out] } = await pool.query(
    `WITH released AS (
       UPDATE bench_trials tr
          SET status = CASE WHEN r.status = 'cancelled' THEN 'cancelled'
                            WHEN r.status = 'capped' THEN 'skipped_cap'
                            WHEN $6::boolean OR tr.claims < $3 THEN 'pending'
                            ELSE 'infra_fail' END,
              error = CASE WHEN r.status IN ('cancelled', 'capped') OR $6::boolean OR tr.claims < $3 THEN NULL ELSE $5::text END,
              started_at = CASE WHEN r.status NOT IN ('cancelled', 'capped') AND ($6::boolean OR tr.claims < $3) THEN NULL ELSE tr.started_at END,
              finished_at = CASE WHEN r.status NOT IN ('cancelled', 'capped') AND ($6::boolean OR tr.claims < $3) THEN NULL ELSE NOW() END,
              session_id = CASE WHEN r.status NOT IN ('cancelled', 'capped') AND ($6::boolean OR tr.claims < $3) THEN NULL ELSE tr.session_id END,
              claims = CASE WHEN r.status NOT IN ('cancelled', 'capped') AND $6::boolean THEN GREATEST(tr.claims - 1, 0) ELSE tr.claims END,
              prior_ms = CASE WHEN $8::jsonb IS NOT NULL AND tr.started_at IS NOT NULL
                                   AND r.status NOT IN ('cancelled', 'capped') AND ($6::boolean OR tr.claims < $3)
                              THEN tr.prior_ms + GREATEST((EXTRACT(EPOCH FROM NOW() - tr.started_at) * 1000)::bigint, 0)
                              ELSE tr.prior_ms END,
              checkpoint = CASE WHEN $8::jsonb IS NULL THEN tr.checkpoint ELSE COALESCE(tr.checkpoint, '{}'::jsonb) || $8::jsonb END,
              interrupted_cost_usd = tr.interrupted_cost_usd + $7::numeric
         FROM bench_runs r
        WHERE tr.id = $1 AND r.id = tr.run_id AND tr.status = 'running'
          AND tr.session_id IS NOT DISTINCT FROM $2::int
        RETURNING tr.id, tr.run_id, tr.status
     ), charged AS (
       UPDATE bench_runs SET spent_usd = spent_usd + $4::numeric
        WHERE $4::numeric > 0 AND id IN (SELECT run_id FROM released)
        RETURNING id
     )
     SELECT released.id, released.run_id, released.status, (SELECT COUNT(*)::int FROM charged) AS charged
       FROM released`,
    [Number(trialId), sessionId == null ? null : Number(sessionId), MAX_CLAIMS, cost, TWICE_INTERRUPTED,
      free, interrupted, update ? JSON.stringify(update) : null],
  );
  if (!out) return null;
  if (cost > 0) {
    try {
      const limits = deps.limits || require('../limits');
      const managedOpenRouter = deps.managedOpenRouter || require('../openrouter-managed-keys');
      const payer = sessionId ?? (Array.isArray(cp?.sessions) ? cp.sessions[0] : null);
      const { rows: [s] } = await pool.query('SELECT user_id FROM chat_sessions WHERE id = $1', [Number(payer)]);
      if (s?.user_id && await managedOpenRouter.usesIncludedKey(pool, s.user_id)) {
        await limits.recordSpend(pool, s.user_id, Math.round(cost * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('bench', 'Benchmark spend debit failed', { trialId, err: err.message });
    }
  }
  log.info('bench', 'Released a trial a restart interrupted', {
    trialId: out.id, runId: out.run_id, status: out.status, costUsd: cost, why,
    ...(cp ? { stepsKept: stepsKept(cp), claimSpent: !free } : {}),
  });
  wake();
  return out.status;
}

/** The running trial on a session, released (releaseTrial). Never throws. */
async function releaseTrialOfSession(pool, sessionId, { why = 'interrupted', deps = {} } = {}) {
  try {
    const { rows: [t] } = await pool.query(
      "SELECT id FROM bench_trials WHERE session_id = $1 AND status = 'running' ORDER BY id DESC LIMIT 1",
      [Number(sessionId)],
    );
    if (!t) return null;
    return await releaseTrial(pool, { trialId: t.id, sessionId, why, deps });
  } catch (err) {
    log.warn('bench', 'Could not release a trial a restart interrupted', { sessionId, err: err.message });
    return null;
  }
}

/**
 * Trials an earlier process left running whose session has nothing left to
 * follow: never opened, gone, archived, or with no turn on record (its
 * worker was gone at the restart, or the turn was cleared). Restart recovery
 * owns a session while it has a turn record, and a trial recovery is
 * finishing is held in `inFlight`, so neither is touched. Released at once
 * rather than after the hour and a half releaseStale waits.
 */
async function releaseOrphaned(pool, deps = {}) {
  const { rows } = await pool.query(
    `SELECT tr.id, tr.session_id
       FROM bench_trials tr
       LEFT JOIN chat_sessions cs ON cs.id = tr.session_id
      WHERE tr.status = 'running'
        AND NOT (tr.id = ANY($1::int[]))
        AND tr.started_at < NOW() - make_interval(secs => $2)
        AND (cs.id IS NULL OR cs.active_turn IS NULL OR cs.status = 'archived')
      ORDER BY tr.id
      LIMIT 50`,
    [[...inFlight.keys()], ORPHAN_GRACE_SECONDS],
  );
  let n = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await releaseTrial(pool, { trialId: r.id, sessionId: r.session_id, why: 'no process or turn holds it', deps })) n += 1;
  }
  return n;
}

// ── After a restart ──────────────────────────────────────────────────────
//
// server.js adoptOrphanWorker hands a benchmark session's surviving worker
// here (recoveryPlan): a turn that is the trial's last is followed to its
// end by resumeDetachedTurn and finished by finishRecoveredTrial; any other
// is abandoned and its trial released. A first version's every turn is
// followed: what it produced is kept on the trial's checkpoint, and the
// trial handed back to the lane, whose next claim goes on from there
// (runner.firstVersionStage), as the bot's own builds do after a restart.
// A configuration's side build is followed the same way through its spec
// turn, its build turn and a review's fix turn (runner.sideTurnOf), and its
// next claim goes on from what was kept (runner.sideBuildStage,
// laterSideBuildStage). One whose worker is gone is released as before.

/** The running trial a session belongs to, and whether its turn can be finished. */
async function recoveryPlan(pool, session, activeTurn) {
  const { rows: [t] } = await pool.query(
    `SELECT tr.id, r.status AS run_status
       FROM bench_trials tr JOIN bench_runs r ON r.id = tr.run_id
      WHERE tr.session_id = $1 AND tr.status = 'running'
      ORDER BY tr.id DESC LIMIT 1`,
    [Number(session.id)],
  );
  if (!t) return null;
  const trial = await loadTrialContext(pool, t.id);
  if (!trial) return null;
  // A cancelled run's turn is stopped, not followed.
  const resumable = t.run_status !== 'cancelled'
    && runner.resumableTurn(trial.stage, activeTurn, { reference: !!trial.reference_label, side: !!trial.bot_config_version_id });
  return { trial, resumable };
}

/**
 * Hold a lane slot for a trial recovery is finishing, the bot's
 * holdSlotDuringRecovery for the benchmark: the run's concurrency counts
 * it, the cap counts its estimate, releaseStale and releaseOrphaned skip it,
 * and a cancel stops it. Resolves (or rejects) with the recovery.
 */
function holdRecoveredTrial(trial, sessionId, recovery) {
  if (!trial || inFlight.has(trial.id)) return Promise.resolve(recovery);
  const entry = {
    runId: trial.run_id, est: Number(trial.est_cost_usd) || 0, sessionId, promise: null,
    heavy: HEAVY_STAGES.includes(trial.stage), recovered: true,
  };
  const promise = Promise.resolve(recovery).finally(() => {
    if (inFlight.get(trial.id) === entry) inFlight.delete(trial.id);
    wake();
  });
  entry.promise = promise.catch(() => null);
  inFlight.set(trial.id, entry);
  return promise;
}

/**
 * When the trial's own clock ends a recovered turn: the turn's start plus
 * the budget the live path gave it (a build turn's for a build, a turn's
 * otherwise), or null to leave it unbounded.
 */
async function recoveryDeadline(pool, config, session, activeTurn) {
  const startedMs = Date.parse(activeTurn?.startedAt || '');
  if (!Number.isFinite(startedMs)) return null;
  const plan = await recoveryPlan(pool, session, activeTurn);
  if (!plan) return null;
  const bot = require('../homeroom-bot');
  const settings = await bot.readSettings(pool);
  const app = { repo_url: plan.trial.repo_url, self_hosted: plan.trial.self_hosted };
  const budgets = runner.budgetsFor(settings, app, config, plan.trial.stage);
  if (plan.trial.bot_config_version_id) return sideTurnDeadline(plan.trial, budgets, activeTurn, startedMs);
  if (plan.trial.stage === 'first_version') {
    // Each of its turns on the clock the live stage gave it: the triage a
    // turn's, the spec and the build a first version's (draftSpec takes
    // the shorter of the build's and the spec's).
    const first = budgets.firstVersion || budgets;
    const which = runner.firstVersionTurnOf(plan.trial.checkpoint, session.id, activeTurn);
    const ms = which === 'build' ? first.buildMs
      : which === 'spec' ? Math.min(first.buildMs, first.specMs) : first.turnMs;
    return startedMs + ms;
  }
  return startedMs + (plan.trial.stage === 'build' ? budgets.buildMs : budgets.turnMs);
}

/**
 * When a side build's recovered turn ends, on the clock its stage gave it
 * (runner.buildSideNow, through buildAndPropose): a first version's side
 * build on a first version's clocks, a later change's on a build's. Its spec
 * turn has the shorter of the build's and the spec's (draftSpec); its build
 * turn the build's; a review's fix turn the build's too, and never past the
 * end of the review's own minutes, which it was started with what was left
 * of (live.reviewLanded). Pure.
 */
function sideTurnDeadline(trial, budgets, activeTurn, startedMs) {
  const clocks = trial.stage === 'first_version' ? (budgets.firstVersion || budgets) : budgets;
  const which = runner.sideTurnOf(trial.checkpoint, activeTurn);
  if (which === 'spec') return startedMs + Math.min(clocks.buildMs, clocks.specMs);
  const turnEnd = startedMs + clocks.buildMs;
  const review = trial.checkpoint?.review;
  const reviewStarted = Date.parse(review?.startedAt || '');
  const minutes = Number(review?.reviewer?.budgetMinutes);
  if (which !== 'fix' || !Number.isFinite(reviewStarted) || !(minutes > 0)) return turnEnd;
  // A fix is given at least a second (reviewLanded's Math.max(1000, ...)).
  return Math.max(startedMs + 1000, Math.min(turnEnd, reviewStarted + minutes * 60 * 1000));
}

/**
 * A trial's last turn, followed to its end by restart recovery: read the
 * way the live stage reads it (runner.recoverStage) and recorded through
 * the same finisher (recordTrial). `result` is what the journal replay
 * returned; `timedOut` says the trial's clock, re-armed by recovery, ended
 * it; `progress` is every progress line the replay showed, from the turn's
 * start. A first version's or a side build's turn, whichever it is, is kept
 * and its trial handed back to go on instead (handBackTrial). Never throws:
 * whatever goes wrong puts the trial back in the queue (releaseTrial), as
 * though recovery had abandoned it.
 */
async function finishRecoveredTrial({
  pool, config, session, activeTurn, result = {}, timedOut = false, progress: lines = null, deps = {},
}) {
  try {
    const plan = await recoveryPlan(pool, session, activeTurn);
    if (!plan) {
      log.info('bench', 'A recovered benchmark turn has no running trial; nothing to record', { sessionId: session.id });
      return 'gone';
    }
    const row = plan.trial;
    if (!plan.resumable) throw new Error(`a ${row.stage} trial's ${activeTurn?.mode || 'unknown'} turn is not its last`);
    if (goesOnAfterRestart(row)) return await handBackTrial({ pool, row, session, activeTurn, result, timedOut, lines, deps });
    const d = liveDeps(deps);
    const bot = require('../homeroom-bot');
    const repo = bot.parseRepo(row.repo_url);
    if (!repo) throw new Error('the app has no GitHub repository');
    const snapshot = await snapshots.readSnapshot(pool, row.snapshot_id);
    if (!snapshot) throw new Error('the task\'s snapshot is gone');
    const task = { id: row.task_id, stage: row.stage, reference: row.reference || {}, tags: row.tags || {} };
    const patch = await runner.recoverStage({
      stage: row.stage, snapshot, task, session, activeTurn, result, timedOut, repo, deps: d,
      trial: { id: row.id, run_id: row.run_id, attempt: row.attempt },
      baseSha: row.base_sha || null, branch: row.build_branch || null,
    });
    if (!patch) throw new Error('nothing to finish');
    const startedMs = row.started_at ? new Date(row.started_at).getTime() : NaN;
    patch.duration_ms = Number.isFinite(startedMs) ? Math.max(Date.now() - startedMs, 0) : null;
    return await recordTrial(pool, {
      trialRow: { id: row.id, run_id: row.run_id }, row, patch, user: { id: session.user_id }, d,
      recovered: true, sessionId: session.id,
    });
  } catch (err) {
    log.warn('bench', 'Could not finish a recovered trial; putting it back in the queue', {
      sessionId: session?.id, err: err.message,
    });
    await releaseTrialOfSession(pool, session.id, { why: `recovery: ${err.message}`, deps });
    return 'released';
  }
}

/**
 * The looks a first version has taken once restart recovery followed one of
 * its turns, or null to leave its checkpoint's as they are. The replay shows
 * the turn's lines from its start, so its looks are added to the counts its
 * step began with (`stepLooks`, kept by the watch before the turn ran), never
 * to the checkpoint's own, which may hold some of them already; and the
 * result is never below what the checkpoint holds. Pure.
 */
function recoveredLooks(checkpoint, step, lines) {
  const cp = checkpoint || {};
  if (!step || cp.stepLooks?.step !== step || !Array.isArray(lines) || !lines.length) return null;
  const base = progress.lookCounts(cp.stepLooks);
  const turn = progress.looksIn(lines);
  const held = progress.lookCounts(cp.looks);
  return Object.fromEntries(Object.keys(held).map((k) => [k, Math.max(held[k], base[k] + turn[k])]));
}

/**
 * A first version's or a side build's turn, followed to its end: what it
 * produced kept on the trial's checkpoint (runner.recoverFirstVersionTurn)
 * with the looks it took (recoveredLooks), its session put away as a
 * finished one is, and the trial handed back to the lane (releaseTrial),
 * whose next claim goes on from there. Kept work costs it no claim. A side
 * build's review fix keeps nothing of its own, but its review is kept
 * already, so it costs no claim either. Resolves 'handed_back', or 'gone'
 * when the trial was no longer on this session.
 */
async function handBackTrial({ pool, row, session, activeTurn, result, timedOut, lines = null, deps }) {
  const side = !!row.bot_config_version_id;
  const step = side
    ? runner.sideTurnOf(row.checkpoint, activeTurn)
    : runner.firstVersionTurnOf(row.checkpoint, session.id, activeTurn);
  const kept = runner.recoverFirstVersionTurn({ checkpoint: row.checkpoint, session, activeTurn, result, timedOut, side });
  // A fix turn's step began before the build turn did, so its looks cannot
  // be told from the build's: the checkpoint's are left as they are.
  const looks = recoveredLooks(row.checkpoint, step === 'fix' ? null : step, lines);
  if (kept || looks) {
    await pool.query(
      `UPDATE bench_trials SET checkpoint = COALESCE(checkpoint, '{}'::jsonb) || $3::jsonb,
              recovered_at = CASE WHEN $4::boolean THEN NOW() ELSE recovered_at END
        WHERE id = $1 AND status = 'running' AND session_id = $2`,
      [row.id, Number(session.id), JSON.stringify({ ...(kept ? kept.keep : {}), ...(looks ? { looks } : {}) }), !!kept],
    );
  }
  await pool.query(
    "UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1 AND status IN ('active', 'paused')",
    [Number(session.id)],
  ).catch(() => {});
  const status = await releaseTrial(pool, {
    trialId: row.id, sessionId: session.id, deps,
    why: kept ? `its ${kept.step} finished after a restart and is kept`
      : step === 'fix' ? 'its review\'s fix finished after a restart; the review is recorded cut short'
        : 'its turn left nothing to keep',
  });
  log.info('bench', side
    ? 'A side build\'s turn finished after a restart; it goes on from there'
    : 'A first version\'s turn finished after a restart; it goes on from there', {
    trialId: row.id, sessionId: session.id, step: step || null, kept: !!kept, status,
  });
  return status ? 'handed_back' : 'gone';
}

/**
 * End a run's scheduling at its cap: what is left is skipped. A
 * configuration's side build skipped here is finished as one the lane
 * recorded (bot-configs.js finishSideTrial): its result skipped, with why.
 * Left pending, it was never paired nor counted, and nothing came back to
 * it (9 of 50 side builds, 9 Oct 2026).
 */
async function capRun(pool, runId) {
  const { rows: skipped } = await pool.query(
    `UPDATE bench_trials SET status = 'skipped_cap', finished_at = NOW() WHERE run_id = $1 AND status = 'pending'
     RETURNING id, bot_config_version_id`,
    [runId],
  );
  await pool.query(
    "UPDATE bench_runs SET status = 'capped', finished_at = NOW() WHERE id = $1 AND status IN ('queued', 'running')",
    [runId],
  );
  log.info('bench', 'Run reached its cap', { runId });
  for (const t of skipped) {
    // eslint-disable-next-line no-await-in-loop
    if (t.bot_config_version_id) await require('../bot-configs').finishSideTrial(pool, t.id);
  }
}

/**
 * Side builds' results still pending whose trial has ended: capped before
 * capRun finished them, released into a run capped meanwhile (releaseTrial),
 * or cancelled by an admin. Each is finished as capRun finishes one, so none
 * waits for good. A trial this process still holds is left to its own
 * finisher. Resolves how many it settled; never throws.
 */
async function settleSideResults(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT tr.id FROM bot_config_results cr
         JOIN bench_trials tr ON tr.id = cr.trial_id
        WHERE cr.status = 'pending' AND cr.source = 'trial'
          AND tr.status NOT IN ('pending', 'running', 'awaiting')
          AND NOT (tr.id = ANY($1::int[]))
        ORDER BY tr.id LIMIT 50`,
      [[...inFlight.keys()]],
    );
    let n = 0;
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      if (await require('../bot-configs').finishSideTrial(pool, r.id)) n += 1;
    }
    if (n) log.info('bench', 'Settled side builds whose trial ended without a result', { results: n });
    return n;
  } catch (err) {
    log.warn('bench', 'Could not settle side builds\' results', { err: err.message });
    return 0;
  }
}

/**
 * Whether the next trial fits the cap: what was spent, plus every trial
 * under way at its estimate, plus this one's. Pure.
 */
function fitsCap({ spentUsd, capUsd, inFlightEst = 0, nextEst = 0 }) {
  return Number(spentUsd) + Number(inFlightEst) + Number(nextEst) <= Number(capUsd) + 1e-9;
}

/**
 * One pass: fill each open run's free slots, oldest run first. Returns what
 * it did. Never throws.
 */
async function tick(pool, config, deps = {}) {
  const out = { started: 0, paused: null, finished: [] };
  if (ticking) { tickAgain = true; return { ...out, busy: true }; }
  ticking = true;
  try {
    const bot = require('../homeroom-bot');
    const settings = await bot.readSettings(pool);
    await releaseStale(pool, settings);
    await releaseOrphaned(pool, deps).catch((err) => log.warn('bench', 'Orphaned-trial sweep failed', { err: err.message }));
    await sweepBranches(pool, deps).catch(() => {});
    await settleSideResults(pool);
    // The studio's previews: kept up for their day, then taken down.
    await require('./studio').sweepPreviews(pool, deps).catch(() => {});
    const { rows: runs } = await pool.query(
      "SELECT * FROM bench_runs WHERE status IN ('queued', 'running') ORDER BY id",
    );
    const limits = deps.limits || require('../limits');
    let user = null;
    for (const run of runs) {
      const mine = [...inFlight.values()].filter((f) => f.runId === run.id);
      const { rows: [left] } = await pool.query(
        "SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending, COUNT(*) FILTER (WHERE status = 'running')::int AS running FROM bench_trials WHERE run_id = $1",
        [run.id],
      );
      if (!left.pending && !left.running && !mine.length) {
        await pool.query(
          "UPDATE bench_runs SET status = 'done', finished_at = NOW() WHERE id = $1 AND status IN ('queued', 'running')",
          [run.id],
        );
        out.finished.push(run.id);
        continue;
      }
      let free = Math.min(run.concurrency, MAX_CONCURRENCY) - mine.length;
      while (free > 0) {
        if (inFlight.size >= MAX_IN_FLIGHT) { out.paused = out.paused || 'lane_full'; break; }
        if ((deps.isLiveLaneSaturated || bot.isLiveLaneSaturated)(settings)) { out.paused = 'live_bot_busy'; break; }
        if (run.kind === LATER_SIDE_RUN_KIND) {
          const besides = [...inFlight.values()].filter((f) => f.laterSide).length;
          if ((deps.isLiveLaneSaturated || bot.isLiveLaneSaturated)(settings, { besides })) { out.paused = 'live_bot_busy'; break; }
        }
        // eslint-disable-next-line no-await-in-loop
        user = user || deps.user || await runner.ensureBenchUser(pool, config);
        // eslint-disable-next-line no-await-in-loop
        const budget = await limits.checkBudget(pool, user.id);
        if (budget.error) { out.paused = 'bench_allowance'; break; }
        // eslint-disable-next-line no-await-in-loop
        // Its next trial in order, passing over heavy ones while three of
        // its heavy trials are under way.
        const heavyNow = [...inFlight.values()].filter((f) => f.runId === run.id && f.heavy).length;
        // A studio run builds its briefs side by side, as its launch asked
        // (concurrency, at most the studio's own limit); any other run takes
        // three heavy trials at a time.
        const heavyCap = run.kind === 'studio' ? Math.min(Number(run.concurrency) || 1, MAX_IN_FLIGHT) : MAX_HEAVY_PER_RUN;
        const { rows: [next] } = await pool.query(
          `SELECT tr.id, tr.est_cost_usd::float8 AS est, t.stage, tr.checkpoint
             FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id
            WHERE tr.run_id = $1 AND tr.status = 'pending'
              AND ($2::boolean OR NOT (t.stage = ANY($3::text[])))
            ORDER BY tr.attempt, tr.id LIMIT 1`,
          [run.id, heavyNow < heavyCap, HEAVY_STAGES],
        );
        if (!next) break;
        const { rows: [money] } = await pool.query(
          'SELECT spent_usd::float8 AS spent, cap_usd::float8 AS cap FROM bench_runs WHERE id = $1', [run.id],
        );
        const running = [...inFlight.values()].filter((f) => f.runId === run.id);
        const inFlightEst = running.reduce((sum, f) => sum + (f.est || 0), 0);
        // What is still to come of its estimate. A trial going on from what
        // it kept after a restart (a side build, a first version) already
        // spent part of it, and its run was charged for that when it was
        // handed back: counted again at its whole estimate, a side build
        // that had used most of its run's cap (three times its estimate) was
        // capped for spend it already had, its work thrown away.
        const toCome = Math.max((Number(next.est) || 0) - keptSpend(next.checkpoint), 0);
        // A trial that spends nothing on a model (a capture, a reference
        // build's screenshots) cannot take the run past its cap.
        if (Number(next.est) > 0 && !fitsCap({ spentUsd: money.spent, capUsd: money.cap, inFlightEst, nextEst: toCome })) {
          // Wait for what is under way, then stop the run there.
          if (!running.length) await capRun(pool, run.id);
          out.paused = out.paused || 'cap';
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        const { rows: [claim] } = await pool.query(
          `UPDATE bench_trials SET status = 'running', claims = claims + 1, started_at = NOW(),
                  first_started_at = COALESCE(first_started_at, NOW())
            WHERE id = $1 AND status = 'pending'
            RETURNING id, run_id, est_cost_usd::float8 AS est`,
          [next.id],
        );
        if (!claim) continue;
        await pool.query(
          "UPDATE bench_runs SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1 AND status = 'queued'",
          [run.id],
        );
        const entry = {
          runId: run.id, est: toCome, sessionId: null, promise: null, heavy: HEAVY_STAGES.includes(next.stage),
          laterSide: run.kind === LATER_SIDE_RUN_KIND,
        };
        inFlight.set(claim.id, entry);
        entry.promise = executeTrial(pool, config, claim, { ...deps, user })
          .catch(async (err) => {
            log.error('bench', 'Trial threw', { trialId: claim.id, err: err.message });
            await pool.query(
              "UPDATE bench_trials SET status = 'infra_fail', error = $2, finished_at = NOW() WHERE id = $1 AND status = 'running'",
              [claim.id, `threw: ${String(err.message).slice(0, 500)}`],
            ).catch(() => {});
          })
          .finally(() => {
            inFlight.delete(claim.id);
            wake();
          });
        out.started += 1;
        free -= 1;
      }
    }
    return out;
  } catch (err) {
    log.error('bench', 'Lane pass failed', { err: err.message });
    return out;
  } finally {
    ticking = false;
    lastTick = { at: new Date().toISOString(), ...out, inFlight: inFlight.size };
  }
}

function schedule(delayMs) {
  if (!laneOn) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    try {
      const { getPool } = require('../../db/pool');
      await tick(getPool(laneConfig), laneConfig);
    } catch (err) {
      log.error('bench', 'Lane tick failed', { err: err.message });
    } finally {
      if (tickAgain) { tickAgain = false; schedule(0); } else schedule(IDLE_MS);
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Start the lane on the leader. Inert until a run is launched. */
function start(config) {
  if (laneOn) return;
  laneOn = true;
  laneConfig = config;
  schedule(IDLE_MS);
}

function stop() {
  laneOn = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** A pass now; a no-op on a Pod that is not running the lane. */
function wake() {
  if (!laneOn) return false;
  schedule(0);
  return true;
}

/** Every run, newest first, with its progress. */
async function listRuns(pool, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT r.id, r.suite_id, s.name AS suite_name, s.version AS suite_version, r.models, r.baseline_model,
            r.stages, r.repeats, r.cap_usd::float8 AS cap_usd, r.concurrency, r.status,
            r.spent_usd::float8 AS spent_usd, r.note, r.created_at, r.started_at, r.finished_at,
            u.username AS started_by, COALESCE(c.counts, '{}'::jsonb) AS counts
       FROM bench_runs r
       JOIN bench_suites s ON s.id = r.suite_id
       LEFT JOIN users u ON u.id = r.started_by
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(status, n) AS counts
           FROM (SELECT status, COUNT(*)::int AS n FROM bench_trials WHERE run_id = r.id GROUP BY status) x
       ) c ON TRUE
      ORDER BY r.id DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 100)],
  );
  return rows;
}

function laneStatus() {
  return { on: laneOn, inFlight: inFlight.size, lastTick };
}

module.exports = {
  MAX_CONCURRENCY,
  HEAVY_STAGES,
  MAX_HEAVY_PER_RUN,
  MAX_IN_FLIGHT,
  MAX_MODELS,
  MAX_REPEATS,
  DEFAULT_CAP_USD,
  DEFAULT_REPEATS,
  SINGLE_ATTEMPT_STAGES,
  MAX_CLAIMS,
  BRANCH_KEEP_DAYS,
  BRANCH_KEEP_WAITING_DAYS,
  validateLaunch,
  attemptsFor,
  launcherDefaults,
  planRun,
  estimateRun,
  estimateWallMs,
  capHeadroom,
  suggestCap,
  TRIAL_MS_FALLBACK,
  MAX_CAP_USD,
  launchRun,
  cancelRun,
  cancelTrial,
  reopenRun,
  TODAY,
  studioContext,
  loadTrialContext,
  ORPHAN_GRACE_SECONDS,
  executeTrial,
  recordTrial,
  noteSession,
  goesOnAfterRestart,
  saveCheckpoint,
  stepsKept,
  keptSpend,
  recoveredLooks,
  sweepBranches,
  releaseStale,
  releaseTrial,
  releaseTrialOfSession,
  releaseOrphaned,
  recoveryPlan,
  holdRecoveredTrial,
  recoveryDeadline,
  finishRecoveredTrial,
  capRun,
  settleSideResults,
  fitsCap,
  tick,
  start,
  stop,
  wake,
  listRuns,
  laneStatus,
  _inFlightForTests: () => inFlight,
  async _awaitTrialsForTests() {
    while (inFlight.size) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([...inFlight.values()].map((f) => f.promise));
    }
  },
  _resetForTests() {
    inFlight.clear(); laneOn = false; laneConfig = null; ticking = false; tickAgain = false; lastTick = null; lastSweepAt = 0;
    if (timer) clearTimeout(timer);
    timer = null;
  },
};
