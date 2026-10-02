'use strict';

// #3654: a benchmark run's results, per stage and model, and its trials as
// a CSV. Everything is computed from the trials and their grades
// (services/bench/stats.js), never stored, so a late grade or a person's
// override changes the report the next time it is read.
//
// What is kept apart, because folding it in would mislead:
//   * platform faults (infra_fail) are not the model's: excluded from
//     accuracy, reported as their own rate;
//   * a timeout IS the model's (it ran out the clock the bot gives it):
//     counted as a fail, and reported as its own rate too;
//   * not applicable (the model cannot take the task) and skipped at the cap
//     are counted, never graded;
//   * cost includes every attempt, failed ones too, so "$ per successful
//     build" is what a passing build really cost.

const graders = require('./graders');
const stats = require('./stats');

const SLICE_KEYS = Object.freeze(['verdict', 'repo_size', 'request_type', 'difficulty', 'app_slug', 'known_outcome']);
const REPEATED_STAGES = Object.freeze(['triage', 'dm', 'followup', 'checks_fix']);

async function runTrials(pool, runId) {
  const { rows } = await pool.query(
    `SELECT tr.id, tr.task_id, tr.model, tr.attempt, tr.status, tr.cost_usd::float8 AS cost_usd,
            tr.input_tokens, tr.output_tokens, tr.duration_ms, tr.deterministic, tr.error,
            tr.build_branch, tr.build_sha, tr.build_commits, tr.created_at, tr.finished_at,
            tk.stage, tk.tags, tk.issue_number, a.slug AS app_slug
       FROM bench_trials tr
       JOIN bench_tasks tk ON tk.id = tr.task_id
       LEFT JOIN apps a ON a.id = tk.app_id
      WHERE tr.run_id = $1
      ORDER BY tr.id`,
    [Number(runId)],
  );
  const { rows: grades } = await pool.query(
    `SELECT g.id, g.trial_id, g.grader, g.verdict, g.created_at
       FROM bench_grades g JOIN bench_trials tr ON tr.id = g.trial_id
      WHERE tr.run_id = $1`,
    [Number(runId)],
  );
  const byTrial = new Map();
  for (const g of grades) {
    if (!byTrial.has(g.trial_id)) byTrial.set(g.trial_id, []);
    byTrial.get(g.trial_id).push(g);
  }
  return rows.map((t) => {
    const gs = byTrial.get(t.id) || [];
    const latest = (kind) => gs.filter((g) => g.grader === kind)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id)[0];
    return {
      ...t,
      appSlug: t.app_slug || '?',
      tags: t.tags || {},
      final: graders.finalVerdict({ status: t.status, deterministic: t.deterministic, grades: gs }),
      opus: latest('opus')?.verdict || null,
      human: latest('human')?.verdict || null,
    };
  });
}

/** One cell of the results table: a stage on a model. */
function summarize(trials, { stage, k }) {
  const by = (s) => trials.filter((t) => t.status === s).length;
  const pass = trials.filter((t) => t.final === 'pass').length;
  const fail = trials.filter((t) => t.final === 'fail').length;
  const attempted = by('ok') + by('model_fail') + by('timeout') + by('infra_fail');
  const costed = trials.filter((t) => Number.isFinite(t.cost_usd));
  const cost = costed.reduce((s, t) => s + t.cost_usd, 0);
  const tasks = new Set(trials.filter((t) => ['ok', 'model_fail', 'timeout', 'infra_fail'].includes(t.status)).map((t) => t.task_id));
  const attempts = new Map();
  for (const t of trials) {
    if (!attempts.has(t.task_id)) attempts.set(t.task_id, []);
    attempts.get(t.task_id).push(t.final);
  }
  const durations = trials.filter((t) => ['ok', 'model_fail', 'timeout'].includes(t.status)).map((t) => Number(t.duration_ms));
  return {
    trials: trials.length,
    graded: pass + fail,
    pass,
    fail,
    pending: trials.filter((t) => t.final === 'pending').length,
    unlabelled: trials.filter((t) => t.final === 'unlabelled').length,
    notApplicable: by('not_applicable'),
    skippedCap: by('skipped_cap'),
    accuracy: pass + fail ? pass / (pass + fail) : null,
    passK: stats.passHatK(attempts, k),
    costUsd: cost,
    // Per task counts all k of a task's attempts; per attempt is the unit a
    // success is counted in, so the two read side by side: a success costs
    // at least an attempt, failed attempts included.
    costPerTask: tasks.size ? cost / tasks.size : null,
    costPerAttempt: attempted ? cost / attempted : null,
    costPerSuccess: pass ? cost / pass : null,
    p50Ms: stats.percentile(durations, 50),
    p95Ms: stats.percentile(durations, 95),
    timeoutRate: attempted ? by('timeout') / attempted : null,
    infraRate: attempted ? by('infra_fail') / attempted : null,
    inputTokens: trials.reduce((s, t) => s + (Number(t.input_tokens) || 0), 0),
    outputTokens: trials.reduce((s, t) => s + (Number(t.output_tokens) || 0), 0),
    stage,
  };
}

/** Each task's score for one model: the mean of its graded attempts. */
function taskScores(trials) {
  const out = new Map();
  for (const t of trials) {
    if (t.final !== 'pass' && t.final !== 'fail') continue;
    if (!out.has(t.task_id)) out.set(t.task_id, { app: t.appSlug, n: 0, pass: 0 });
    const s = out.get(t.task_id);
    s.n += 1;
    if (t.final === 'pass') s.pass += 1;
  }
  return new Map([...out].map(([task, s]) => [task, { app: s.app, score: s.pass / s.n }]));
}

/**
 * The whole report for a run: rows per stage and model, each model's
 * paired difference against the baseline per stage, slices by a tag, and
 * the cost-vs-quality points with their Pareto frontier.
 */
async function runReport(pool, runId, { slice = 'verdict' } = {}) {
  const { rows: [run] } = await pool.query(
    `SELECT r.id, r.suite_id, r.models, r.baseline_model, r.stages, r.repeats, r.status, r.created_at, r.started_at,
            r.finished_at, r.cap_usd::float8 AS cap_usd, r.spent_usd::float8 AS spent_usd, s.name AS suite_name, s.version AS suite_version,
            s.frozen_at AS suite_frozen_at
       FROM bench_runs r JOIN bench_suites s ON s.id = r.suite_id WHERE r.id = $1`,
    [Number(runId)],
  );
  if (!run) return null;
  const trials = await runTrials(pool, runId);
  const rows = [];
  const paired = [];
  const points = [];
  for (const stage of run.stages) {
    const k = REPEATED_STAGES.includes(stage) ? run.repeats : 1;
    const ofStage = trials.filter((t) => t.stage === stage);
    if (!ofStage.length) continue;
    const baseline = taskScores(ofStage.filter((t) => t.model === run.baseline_model));
    for (const model of run.models) {
      const mine = ofStage.filter((t) => t.model === model);
      if (!mine.length) continue;
      const row = { stage, model, baseline: model === run.baseline_model, ...summarize(mine, { stage, k }) };
      rows.push(row);
      points.push({ key: `${stage}|${model}`, stage, model, cost: row.costPerAttempt, accuracy: row.accuracy });
      if (model !== run.baseline_model) {
        const scores = taskScores(mine);
        const pairs = [...scores].filter(([task]) => baseline.has(task))
          .map(([task, s]) => ({ task, app: s.app, a: s.score, b: baseline.get(task).score }));
        paired.push({ stage, model, baselineModel: run.baseline_model, ...stats.pairedDiff(pairs, { seed: 3654 + Number(runId) }) });
      }
    }
  }
  const frontier = new Set();
  for (const stage of run.stages) {
    for (const key of stats.paretoFrontier(points.filter((p) => p.stage === stage))) frontier.add(key);
  }
  const key = SLICE_KEYS.includes(slice) ? slice : 'verdict';
  const slices = [];
  const groups = new Map();
  for (const t of trials) {
    const value = key === 'app_slug' ? t.appSlug : (t.tags?.[key] ?? 'none');
    const id = `${t.stage}|${t.model}|${value}`;
    if (!groups.has(id)) groups.set(id, { stage: t.stage, model: t.model, value: String(value), pass: 0, fail: 0 });
    const g = groups.get(id);
    if (t.final === 'pass') g.pass += 1;
    if (t.final === 'fail') g.fail += 1;
  }
  for (const g of groups.values()) {
    slices.push({ ...g, n: g.pass + g.fail, accuracy: g.pass + g.fail ? g.pass / (g.pass + g.fail) : null });
  }
  slices.sort((a, b) => a.stage.localeCompare(b.stage) || a.value.localeCompare(b.value) || a.model.localeCompare(b.model));
  return {
    run: {
      id: run.id, suiteId: run.suite_id, suiteName: run.suite_name, suiteVersion: run.suite_version,
      suiteFrozen: !!run.suite_frozen_at, models: run.models, baseline: run.baseline_model, stages: run.stages,
      repeats: run.repeats, capUsd: run.cap_usd, spentUsd: run.spent_usd, status: run.status,
      createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at,
    },
    rows,
    paired,
    slice: { key, keys: SLICE_KEYS, groups: slices },
    pareto: points.map((p) => ({ ...p, frontier: frontier.has(p.key) })),
  };
}

const CSV_COLUMNS = Object.freeze([
  'trial_id', 'run_id', 'task_id', 'stage', 'app_slug', 'issue_number', 'model', 'attempt', 'status', 'final_verdict',
  'deterministic_pass', 'opus_verdict', 'human_verdict', 'cost_usd', 'input_tokens', 'output_tokens', 'duration_ms',
  'build_branch', 'build_sha', 'build_commits', 'tag_verdict', 'tag_repo_size', 'tag_request_type', 'tag_difficulty',
  'error', 'created_at', 'finished_at',
]);

/** A run's trials as CSV rows, in CSV_COLUMNS order. */
async function csvRows(pool, runId) {
  const trials = await runTrials(pool, runId);
  return trials.map((t) => {
    const flat = {
      trial_id: t.id, run_id: Number(runId), task_id: t.task_id, stage: t.stage, app_slug: t.appSlug,
      issue_number: t.issue_number, model: t.model, attempt: t.attempt, status: t.status, final_verdict: t.final,
      deterministic_pass: t.deterministic ? t.deterministic.pass : null, opus_verdict: t.opus, human_verdict: t.human,
      cost_usd: t.cost_usd, input_tokens: t.input_tokens, output_tokens: t.output_tokens, duration_ms: t.duration_ms,
      build_branch: t.build_branch, build_sha: t.build_sha, build_commits: t.build_commits,
      tag_verdict: t.tags.verdict, tag_repo_size: t.tags.repo_size, tag_request_type: t.tags.request_type,
      tag_difficulty: t.tags.difficulty, error: t.error, created_at: t.created_at, finished_at: t.finished_at,
    };
    return CSV_COLUMNS.map((c) => {
      const v = flat[c];
      if (v == null) return '';
      if (v instanceof Date) return v.toISOString();
      return v;
    });
  });
}

module.exports = {
  SLICE_KEYS,
  CSV_COLUMNS,
  runTrials,
  summarize,
  taskScores,
  runReport,
  csvRows,
};
