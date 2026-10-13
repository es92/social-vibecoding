'use strict';

// #3654: one benchmark TRIAL: a task's snapshot, through one stage of the
// Homeroom bot, on one candidate model, with nothing leaving the benchmark.
//
// What it reuses, so a trial measures the bot and not a copy of it:
//   * the real prompt builders and parsers: homeroom-bot triagePromptFor /
//     parseVerdict, homeroom-bot-live draftSpec / buildAndPropose /
//     buildPrompt, homeroom-bot-followup followUpPrompt / checksFixPrompt /
//     parseFollowUp / headMoved;
//   * the same worker and OpenRouter path (sessions.runCodexAttemptLoop with
//     agent-turn resolveCodexRuntimeContext), the same harness (the
//     platform's per-model choice of CLI, 'auto', as the bot's own turns
//     ask for it), the same reasoning effort and the same wall clocks the
//     bot's own turns get, whatever the model;
//   * a session per trial, stamped with the trial's model, so the model that
//     ran is the model the turn resolved (and agent_turns says so).
//
// What it may NOT do, and how that is made structural rather than polite:
//   * post, comment, DM, notify, open a pull request or a proposal. The
//     trial never calls live.post, live.postOnProposal, live.promoteAsBot or
//     anything in homeroom-bot-dm; buildAndPropose runs with propose:false,
//     no votes router, and no onSpec but a first version's, which keeps the
//     spec on its own trial and nothing more; and the GitHub client a trial
//     is handed is guardedGithub's: reads, plus branches under `bench/` and
//     nothing else. Any other call throws BenchSideEffectError
//     (tests/bench-runner.test.js spies on all of them).
//   * spend the bot's money. Trials run as their own synthetic user,
//     `homeroom_bench`, with its own included key and weekly allowance, so a
//     benchmark can never take the live bot's budget, and its spend is
//     debited there.
//   * read anything newer than the task. Every turn starts on a branch of
//     its own, `bench/r<run>-t<trial>`, cut at the snapshot's base commit;
//     nothing pushes anywhere but that branch, and the branch is deleted
//     once nothing needs it (services/bench/lane.js). The branch alone was
//     not enough: the worker cloned today's main beside it, so a model could
//     read the later fix in `git log origin/main`. Every worker a trial
//     starts is now SEALED at that base (sealedWorker): its checkout holds
//     the session branch alone, main and origin/main are the base, and
//     origin has no fetch URL (worker/session-branch.sh). Its turns get no
//     read-only Homeroom tools and an empty usernode-issues, which read the
//     platform and GitHub as they are now (worker.js mintHomeroomReadGrant,
//     routes/internal.js).
//
// A trial's session is the bench user's and is archived when the trial
// ends. A restart in the middle is never recovered into the dev-chat tail
// (server.js adoptOrphanWorker, isBenchSession): a trial whose interrupted
// turn is the last one it needs is followed to its end and finished here
// (recoverStage, then the lane's shared finisher). A first version, whose
// turns are several, is followed through any of them and goes on from what
// it left, as the bot's own builds do (recoverFirstVersionTurn, then
// firstVersionStage reading its checkpoint); so is a configuration's side
// build (sideBuildStage, laterSideBuildStage). Any other is abandoned and run
// again from the start (services/bench/lane.js).

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('../logger');
const snapshots = require('../homeroom-bot-snapshots');
const stageCosts = require('../stage-costs');

const BENCH_USERNAME = 'homeroom_bench';
// The bench user's own weekly allowance: a backstop behind every run's cap
// (an admin can change it on the user in Admin > Limits).
const DEFAULT_BENCH_WEEKLY_CENTS = 10000;
const RAW_OUTPUT_CHARS = 20000;
const DIFF_CHARS = 60000;
const TELEMETRY = 'homeroom_bench';
// Said on every build trial with hidden checks, until they can run (see
// hiddenChecksUnavailable).
const HIDDEN_CHECKS_GAP = 'hidden checks are not run on benchmark branches yet: graded on the build signals and the judge';

class BenchSideEffectError extends Error {
  constructor(what) {
    super(`benchmark trials may not ${what}`);
    this.code = 'bench_side_effect';
  }
}

// ── The GitHub a trial may use ──────────────────────────────────────────

const GITHUB_READS = Object.freeze([
  'isEnabled', 'getBotUsername', 'getBranchSha', 'getFileContent', 'compareFiles', 'listChangedFiles',
  'compareRefs', 'getProposalDiff', 'fetchPublicIssue', 'fetchIssueComments', 'getPR', 'getCommitAt',
]);

// A trial's own branch, `bench/r<run>-t<trial>`, or the first commit a
// run's first versions share, `bench/r<run>-s<id>` (services/bench/scaffold.js).
function assertBenchBranch(branch) {
  if (typeof branch !== 'string' || !/^bench\/r\d+-[ts]\d+$/.test(branch)) {
    throw new BenchSideEffectError(`touch the branch ${branch}`);
  }
}

/**
 * The GitHub client a trial is handed: the reads above, a branch made or
 * removed under `bench/`, and nothing else. Every other property is a
 * function that throws, so a comment, an issue, a pull request or a merge is
 * impossible rather than merely unused.
 */
function guardedGithub(github) {
  const allowed = {
    ensureBranchAtSha(owner, repo, branch, sha) {
      assertBenchBranch(branch);
      return github.ensureBranchAtSha(owner, repo, branch, sha);
    },
    deleteBenchBranch(owner, repo, branch) {
      assertBenchBranch(branch);
      return github.deleteBenchBranch(owner, repo, branch);
    },
    // #3737: a first-version trial's starting point, a commit with no
    // history holding the rendered starter, and the trial's branch pointed
    // at it (any earlier attempt's branch of the same trial removed first).
    // Resolves the commit's sha.
    async createBenchScaffold(owner, repo, branch, files, message) {
      assertBenchBranch(branch);
      const sha = await github.createRootCommit(owner, repo, files, { message });
      await github.deleteBenchBranch(owner, repo, branch);
      await github.ensureBranchAtSha(owner, repo, branch, sha);
      return sha;
    },
    // A first version's review put back on the last commit that booted
    // (homeroom-bot-live.js rollbackReviewBranch): the trial's own branch.
    resetBenchBranch(owner, repo, branch, sha) {
      assertBenchBranch(branch);
      return github.forceBranchToSha(owner, repo, branch, sha);
    },
  };
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (Object.prototype.hasOwnProperty.call(allowed, prop)) return allowed[prop];
      if (GITHUB_READS.includes(prop)) {
        return typeof github[prop] === 'function' ? (...args) => github[prop](...args) : undefined;
      }
      return () => { throw new BenchSideEffectError(`call github.${prop}`); };
    },
  });
}

// ── The bench user ───────────────────────────────────────────────────────

async function ensureBenchUser(pool, config = {}) {
  const { rows: found } = await pool.query(
    'SELECT id, username, is_synthetic, weekly_limit_cents FROM users WHERE username = $1', [BENCH_USERNAME],
  );
  let user = found[0] || null;
  if (user && user.is_synthetic !== true) throw new Error(`users row '${BENCH_USERNAME}' exists and is not synthetic`);
  if (!user) {
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    await pool.query(
      `INSERT INTO users (username, password, is_admin, can_create_apps, is_synthetic, weekly_limit_cents, daily_limit_cents)
       VALUES ($1, $2, FALSE, FALSE, TRUE, $3, $3)
       ON CONFLICT (username) DO NOTHING`,
      [BENCH_USERNAME, hash, DEFAULT_BENCH_WEEKLY_CENTS],
    );
    const { rows } = await pool.query(
      'SELECT id, username, is_synthetic, weekly_limit_cents FROM users WHERE username = $1', [BENCH_USERNAME],
    );
    user = rows[0];
    if (!user) throw new Error(`Could not create the ${BENCH_USERNAME} user`);
    log.info('bench', 'Benchmark user created', { userId: user.id });
  }
  try {
    const managedOpenRouter = require('../openrouter-managed-keys');
    await managedOpenRouter.ensureIncludedKey({ pool, userId: user.id, config, reason: 'homeroom_bench' });
  } catch (err) {
    log.warn('bench', 'Included key check failed', { err: err.message });
  }
  return user;
}

/** True for a session a benchmark trial owns (restart recovery abandons it). */
function isBenchSession(session) {
  return !!session && session.username === BENCH_USERNAME && session.user_is_synthetic === true;
}

/**
 * Whether restart recovery may follow a benchmark session's turn: an
 * active session's, or a paused one's with a turn in flight. A build's
 * nudge and a review's fix turns run on a session its build turn left
 * paused (homeroom-bot-live.js buildTurnRunner), as the live bot's do
 * (homeroom-bot.js isRecoveredBotSession, #1006): until 13 Oct 2026 server.js
 * destroyed such a worker in silence, its turn record left, and the trial sat
 * running until the watchdog or releaseStale gave it back. Pure.
 */
function isRecoveredBenchSession(session) {
  return isBenchSession(session)
    && (session.status === 'active' || (session.status === 'paused' && !!session.active_turn));
}

// ── Sessions, branches and turns ────────────────────────────────────────

/**
 * The worker a trial is handed: the real one, except that every worker it
 * starts is sealed at the trial's base commit (worker.ensureWorker's
 * pinnedBase; worker/session-branch.sh), so the checkout reaches nothing
 * later. `getBase` is the base the stage put on the trial before starting a
 * worker (runStage reads it from onSession); with none, the worker is
 * refused rather than started unsealed.
 */
function sealedWorker(worker, getBase) {
  return new Proxy(worker, {
    get(target, prop) {
      if (prop === 'ensureWorker') {
        return async (sessionId, opts = {}) => {
          const base = getBase();
          if (!base) throw new BenchSideEffectError('start a worker before its base commit is pinned');
          return target.ensureWorker(sessionId, { ...opts, pinnedBase: base });
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function branchFor(trial) {
  return `bench/r${Number(trial.run_id)}-t${Number(trial.id)}`;
}

/** Cut the trial's branch at `sha` (or main's tip when the snapshot has none). */
async function pinBranch(github, repo, branch, sha) {
  let base = sha;
  if (!base) base = await github.getBranchSha(repo.owner, repo.repo, 'main');
  await github.ensureBranchAtSha(repo.owner, repo.repo, branch, base);
  return base;
}

async function openSession(pool, config, { user, app, model, branch, title }) {
  const { rows } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues,
                                session_title, agent_backend, agent_provider, agent_model, agent_reasoning_effort)
     VALUES ($1, $2, $3, 'paused', FALSE, '{}', $4, 'codex_openrouter', 'openrouter', $5, $6)
     RETURNING *`,
    [app.id, user.id, branch, title, model, config.openrouterDefaultCodexReasoning || 'low'],
  );
  const session = rows[0];
  session.app_slug = app.slug;
  session.app_name = app.name;
  session.repo_url = app.repo_url;
  session.app_self_hosted = app.self_hosted;
  return session;
}

/**
 * One turn on a trial's session, the way the bot runs its own: a fresh
 * thread, the session's model stamped, the wall clock as the stop. `prompt`
 * is the text, or a function of the runtime the turn resolved for a prompt
 * that depends on it (the triage's, whose design self-check follows what the
 * model can see). Resolves { routed, result, stopped, infra, costUsd, usage,
 * prompt }, `prompt` being what was sent; never throws.
 */
async function runTurn({
  pool, config, user, session, repo, prompt, mode, model, budgetMs, deps, commitMsg = '', onActivity = null,
}) {
  const { worker, sessions, agentTurn, activeWorkers } = deps;
  let containerName;
  try {
    await worker.ensureWorkerImage();
    containerName = await worker.ensureWorker(session.id, {
      repoOwner: repo.owner, repoName: repo.repo, branchName: session.branch_name, temporary: true, onProgress: () => {},
    });
  } catch (err) {
    return { routed: { error: `worker: ${err.message}` }, result: {}, stopped: false, infra: true, costUsd: null, usage: {} };
  }
  await pool.query(
    "UPDATE chat_sessions SET status = 'active', agent_thread_id = NULL, agent_model = $2, last_activity_at = NOW() WHERE id = $1",
    [session.id, model],
  );
  session.agent_thread_id = null;
  session.agent_model = model;
  activeWorkers.add(session.id);
  let stopped = false;
  let stopping = null;
  const timer = setTimeout(() => {
    stopped = true;
    stopping = Promise.resolve(worker.stopTurn(session.id)).catch(() => {});
  }, budgetMs);
  if (typeof timer.unref === 'function') timer.unref();
  let pricing = null;
  let sent = typeof prompt === 'function' ? null : prompt;
  let routed;
  try {
    routed = await sessions.runCodexAttemptLoop({
      pool, session, userId: user.id, config, isCodexSession: true,
      turnModel: model, resumeThreadId: null, mode,
      telemetryComponent: TELEMETRY,
      resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
        pool, session, userId: user.id, model, resumeThreadId: null, config,
        // As the bot's own turns ask for it (#3296).
        harness: 'auto',
      }),
      dispatchOnce: (ctx) => {
        pricing = ctx?.pricingSnapshot || pricing;
        sent = typeof prompt === 'function' ? prompt(ctx) : prompt;
        return worker.execInWorker(session.id, {
          mode, prompt: sent, model, commitMsg, resumeSessionId: null, branchName: session.branch_name,
          // As the bot's follow-up asks: a failed turn's work is not kept.
          discardFailedTurn: true,
          ...(ctx || {}), telemetryComponent: TELEMETRY,
          // A studio trial's watch (services/bench/progress.js); nothing else.
          onProgress: typeof onActivity === 'function'
            ? (line) => { try { onActivity(line); } catch { /* a watcher never stops a turn */ } }
            : () => {},
        });
      },
      retryPredicate: () => null,
      sendStatus: async () => {},
      waitForStopped: async () => {},
      prepareRetry: async () => false,
      classifyAttemptStatus: ({ failed }) => (failed ? 'failed' : 'completed'),
      containerName,
    });
  } catch (err) {
    routed = { error: `dispatch: ${err.message}` };
  } finally {
    clearTimeout(timer);
    if (stopping) await stopping;
    activeWorkers.delete(session.id);
    await pool.query(
      "UPDATE chat_sessions SET status = 'paused', last_activity_at = NOW() WHERE id = $1 AND status = 'active'",
      [session.id],
    ).catch(() => {});
  }
  const result = (routed && routed.result) || {};
  const bot = require('../homeroom-bot');
  const relay = bot.relaySpend(result.relayUsage, pricing, agentTurn);
  const ledger = Number.isFinite(routed?.estimatedCostUsd) ? routed.estimatedCostUsd : null;
  return {
    routed, result, stopped, infra: false, prompt: sent,
    costUsd: ledger ?? relay?.costUsd ?? null,
    usage: {
      inputTokens: Number.isFinite(result.inputTokens) ? result.inputTokens : (relay?.inputTokens ?? null),
      outputTokens: Number.isFinite(result.outputTokens) ? result.outputTokens : (relay?.outputTokens ?? null),
    },
  };
}

/** How a turn ended, before its answer is read: null when it produced one. */
function turnStatus(turn) {
  if (turn.infra) return { status: 'infra_fail', error: String(turn.routed?.error || 'worker unavailable') };
  if (turn.stopped) return { status: 'timeout', error: 'the turn ran past its time limit' };
  if (!turn.routed) return { status: 'infra_fail', error: 'the turn did not run' };
  if (turn.routed.error) {
    const code = String(turn.routed.error);
    const bot = require('../homeroom-bot');
    const infra = bot.INFRA_ERRORS.has(code) || bot.REFUSAL_ERRORS.has(code) || code.startsWith('dispatch:') || code.startsWith('worker:');
    return { status: infra ? 'infra_fail' : 'model_fail', error: code };
  }
  return null;
}

function rawOf(text) {
  const s = String(text || '');
  return s.length > RAW_OUTPUT_CHARS ? `${s.slice(0, RAW_OUTPUT_CHARS)}\n[truncated]` : s;
}

/** What the trial's own session spent, from the ledger: exact, failed attempts included. */
async function sessionUsage(pool, sessionId) {
  if (!sessionId) return null;
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0)::float8 AS cost,
            COUNT(estimated_cost_usd)::int AS priced,
            COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
            COUNT(*)::int AS turns,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT routed_model), NULL) AS routed_models
       FROM agent_turns WHERE session_id = $1`,
    [sessionId],
  );
  return rows[0] || null;
}

/** The files and diff a trial's branch made against its base. */
async function branchDiff(github, repo, base, branch) {
  try {
    const out = await github.compareFiles(repo.owner, repo.repo, `${base}...${branch}`, DIFF_CHARS);
    return { files: out.files, diff: out.diff, complete: out.complete, truncated: out.truncated };
  } catch (err) {
    log.warn('bench', 'Could not read a trial branch\'s diff', { branch, err: err.message });
    return null;
  }
}

/**
 * The hidden checks of a build task, run on its branch. Not available in
 * this change, and said so on every trial that has some (#3654): declared
 * checks run against a staging preview (services/visuals.js
 * captureForSession), which is bound to a proposal's session, writes its
 * verdict onto it, patches its pull request and can merge it; and the
 * in-loop runner (worker/usernode-run-checks) needs a build turn's INLOOP_*
 * environment, which only an agent turn is given. Either path run against a
 * bench branch would have to be made side-effect free first. Until then a
 * build trial is graded on its deterministic build signals (commits, the
 * diff-scope rule) and the judge, who sees the hidden checks with the diff.
 */
async function hiddenChecksUnavailable({ task }) {
  const hidden = Array.isArray(task?.reference?.hidden_checks) ? task.reference.hidden_checks : [];
  if (!hidden.length) return null;
  return { ran: false, total: hidden.length, reason: HIDDEN_CHECKS_GAP };
}

// ── The stages ──────────────────────────────────────────────────────────

/** What a turn left behind that every stage records, whatever it said. */
function turnFields(turn) {
  return {
    cost_usd: turn.costUsd, input_tokens: turn.usage.inputTokens, output_tokens: turn.usage.outputTokens,
    raw_output: rawOf(turn.result.lastResultText),
  };
}

function triagePrompt(snapshot, seed, readsImages = false, guidance = null) {
  const bot = require('../homeroom-bot');
  return bot.triagePromptFor({
    seed, issueNumber: snapshot.issueNumber, firstVersion: !!snapshot.extra?.firstVersion, readsImages,
    // #3772: who decided on the project when the original look ran.
    decider: snapshot.extra?.decider || null,
    // A first version's people when the original look ran (membersNote).
    members: snapshot.extra?.members || null,
    // The game starter its first version builds on (firstVersionNote).
    starter: snapshot.extra?.starter || null,
    // A studio trial's context pack (services/bench/packs.js).
    guidance,
  });
}

/**
 * A triage turn's patch, read from how it ended. Shared by the live stage
 * and by a turn restart recovery followed to its end (recoverStage).
 */
function triageResult({ turn, out, prompt, snapshot }) {
  const bot = require('../homeroom-bot');
  const ended = turnStatus(turn);
  if (ended) return { ...out, ...ended };
  const parsed = bot.parseVerdict(turn.result.lastResultText);
  if (!parsed) return { ...out, status: 'model_fail', error: 'unparseable: no verdict block' };
  return {
    ...out,
    status: 'ok',
    parsed: {
      verdict: parsed.verdict,
      question: parsed.question,
      questionDefault: parsed.questionDefault,
      questionAnswers: parsed.questionAnswers,
      // B6: a first version's plan, or a second question.
      plan: parsed.plan || null,
      buildNote: parsed.buildNote,
      reason: parsed.reason,
      assumptions: parsed.assumptions,
      demoted: parsed.demoted,
      // Whether today's triage prompt is the prompt the run read.
      promptMatchesSnapshot: snapshots.hashText(prompt) === snapshot.promptHash,
    },
  };
}

async function triageStage(ctx) {
  const { pool, config, snapshot, model, user, app, repo, trial, deps, budgets, title } = ctx;
  const seed = ctx.seedOverride || snapshot.texts.seed;
  if (!seed) return { status: 'infra_fail', error: 'the snapshot has no seed' };
  const branch = branchFor(trial);
  let base;
  try {
    base = ctx.baseSha || await pinBranch(deps.github, repo, branch, snapshot.baseSha);
  } catch (err) {
    return { status: 'infra_fail', error: `branch: ${err.message}` };
  }
  const session = ctx.session || await openSession(pool, config, { user, app, model, branch, title });
  await ctx.onSession?.(session.id, { baseSha: base, branch });
  // Rendered at dispatch for what the trial's model can see, as the bot's
  // own triage is (homeroom-bot.js runTriage).
  const guidance = ctx.guidance?.triage || null;
  const turn = await runTurn({
    pool, config, user, session, repo, mode: 'scout', model, budgetMs: budgets.turnMs, deps, onActivity: ctx.onActivity,
    prompt: (runtime) => triagePrompt(snapshot, seed, require('../prompts').runtimeReadsImages(runtime), guidance),
  });
  const out = { session_id: session.id, base_sha: base, build_branch: branch, ...turnFields(turn), session };
  return triageResult({ turn, out, prompt: turn.prompt || triagePrompt(snapshot, seed, false, guidance), snapshot });
}

async function specStage(ctx) {
  const { pool, config, snapshot, model, user, app, repo, trial, deps, budgets, title } = ctx;
  const live = require('../homeroom-bot-live');
  const branch = branchFor(trial);
  let base;
  try {
    base = await pinBranch(deps.github, repo, branch, snapshot.baseSha);
  } catch (err) {
    return { status: 'infra_fail', error: `branch: ${err.message}` };
  }
  const session = await openSession(pool, config, { user, app, model, branch, title });
  await ctx.onSession?.(session.id, { baseSha: base, branch });
  let containerName;
  try {
    await deps.worker.ensureWorkerImage();
    containerName = await deps.worker.ensureWorker(session.id, {
      repoOwner: repo.owner, repoName: repo.repo, branchName: branch, temporary: true, onProgress: () => {},
    });
  } catch (err) {
    return { session_id: session.id, base_sha: base, build_branch: branch, status: 'infra_fail', error: `worker: ${err.message}`, session };
  }
  const spec = await live.draftSpec({
    pool, config, bot: user, session, containerName, seed: snapshot.texts.seed,
    buildNote: snapshot.texts.build_note || '', turnBudgetMs: budgets.turnMs, model, specBudgetMs: budgets.specMs,
    deps: { worker: deps.worker, sessions: deps.sessions, agentTurn: deps.agentTurn, activeWorkers: deps.activeWorkers },
    telemetryComponent: TELEMETRY,
    // #3737: a first version's spec decides its look, as the live one does.
    firstVersion: !!snapshot.extra?.firstVersion,
  });
  const out = { session_id: session.id, base_sha: base, build_branch: branch, cost_usd: spec.costUsd ?? null, session };
  if (spec.stopped) return { ...out, status: 'timeout', error: spec.error };
  if (spec.ok) return { ...out, status: 'ok', raw_output: rawOf(spec.specMd), parsed: { spec: spec.specMd } };
  if (spec.blocked) return { ...out, status: 'ok', parsed: { blocked: spec.blocked }, raw_output: rawOf(`BLOCKED: ${spec.blocked}`) };
  const m = String(spec.error || '').match(/failed \((.+)\)$/);
  const bot = require('../homeroom-bot');
  const infra = !!m && (bot.INFRA_ERRORS.has(m[1]) || m[1].startsWith('dispatch:'));
  return { ...out, status: infra ? 'infra_fail' : 'model_fail', error: spec.error || 'no spec' };
}

/**
 * A build's patch, from what buildAndPropose returned (or, for a build turn
 * restart recovery followed to its end, the same shape read back from the
 * turn's journal): its status, and for a build that landed, the diff from
 * the base and the hidden checks. Shared so the two cannot drift.
 */
async function buildResult({ built, base, branch, sessionId = null, deps, repo, task, trial }) {
  const bot = require('../homeroom-bot');
  const out = {
    session_id: built.sessionId || sessionId, base_sha: base, build_branch: branch,
    cost_usd: built.costUsd ?? null, build_sha: built.sha || null,
    build_commits: Number.isFinite(built.commits) ? built.commits : null,
  };
  const parsed = {
    built: !!built.ok, spec: built.specMd || null, specNote: built.specNote || null,
    // How much its drawn screens hold (spec-html.js screenStats), and what
    // each stage cost on its model (services/stage-costs.js).
    ...(Array.isArray(built.specScreens) && built.specScreens.length ? { specScreens: built.specScreens } : {}),
    ...(built.stageCosts ? { costParts: stageCosts.fromStages(built.stageCosts) } : {}),
    // A build turn that changed nothing: what it said and did, and its nudge
    // (homeroom-bot-live.js buildNudgePrompt), as a live run keeps it.
    ...(built.noChange ? { noChange: built.noChange } : {}),
  };
  if (built.blocked) return { ...out, status: 'ok', parsed: { ...parsed, blocked: built.blocked }, raw_output: rawOf(`BLOCKED: ${built.blocked}`) };
  if (!built.ok) {
    const error = String(built.error || 'unknown');
    if (/ran past its time limit/.test(error)) return { ...out, status: 'timeout', error, parsed };
    if (bot.isInfraBuildError(error)) return { ...out, status: 'infra_fail', error, parsed };
    return { ...out, status: 'model_fail', error, parsed };
  }
  const compared = await branchDiff(deps.github, repo, base, branch);
  const checks = await (deps.runHiddenChecks || hiddenChecksUnavailable)({ task, trial, repo, branch, base });
  return {
    ...out,
    status: 'ok',
    parsed,
    raw_output: rawOf(built.specMd || ''),
    diff: compared ? compared.diff : null,
    changed_files: compared ? { files: compared.files, complete: compared.complete, truncated: compared.truncated } : null,
    checks,
  };
}

async function buildStage(ctx) {
  const { pool, config, snapshot, model, user, app, repo, trial, task, deps, budgets, title } = ctx;
  const live = require('../homeroom-bot-live');
  const branch = branchFor(trial);
  let base = snapshot.baseSha || null;
  let sessionId = null;
  // The build's session gets its branch here instead of from
  // session-lifecycle, which would cut a dev/ branch from main's tip: the
  // trial's branch is cut at the snapshot's base commit.
  const sessionLifecycle = {
    async ensureSessionBranch({ sessionId: id }) {
      base = await pinBranch(deps.github, repo, branch, base);
      await pool.query('UPDATE chat_sessions SET branch_name = $2 WHERE id = $1', [id, branch]);
      // The base is on the trial before either turn runs: a build turn
      // finished after a restart diffs against it.
      await ctx.onSession?.(id, { baseSha: base, branch });
      return { branchName: branch, created: true };
    },
  };
  // Whether the build could look at its own screens, recorded on the trial
  // (`parsed.sight`): `told` is what its prompt said (the design self-check
  // asks for screenshots or for the page's text snapshot), decided here the
  // way buildAndPropose decides it and handed to it, so the two cannot
  // differ; `passed` is what the runtime of its turns said the model takes
  // in, which is what makes the worker hand it an image or a note in its
  // place (AGENT_MODEL_SUPPORTS_IMAGES). The lane adds the looks it took.
  // Each turn's is handed to ctx.onSight before the turn runs, the build
  // turn's last: a first version keeps it on its checkpoint, since a build
  // turn a restart interrupts is finished by recovery, which never sees this.
  const sight = { told: await live.buildSeesImages({ pool, config, userId: user.id, model }), passed: null };
  const agentTurn = observedRuntime(deps.agentTurn, async (runtime) => {
    const takesImages = runtime?.agentModelMetadata?.supportsImages;
    if (typeof takesImages === 'boolean') sight.passed = takesImages;
    await ctx.onSight?.({ ...sight });
  });
  const built = await live.buildAndPropose({
    pool, config, bot: user, app, repo, issueNumber: snapshot.issueNumber,
    issue: { title: snapshot.thread?.issue?.title || `Issue #${snapshot.issueNumber}` },
    seed: snapshot.texts.seed, buildNote: snapshot.texts.build_note || '',
    turnBudgetMs: budgets.buildMs, specBudgetMs: budgets.specMs, model,
    deps: {
      worker: deps.worker, sessions: deps.sessions, agentTurn,
      activeWorkers: deps.activeWorkers, sessionLifecycle, seesImages: sight.told,
      // Its reads only: whether a later build's repository has the
      // frontend-design skill, as a live build asks (services/design-skill.js).
      github: deps.github,
    },
    // Never proposed, never posted: no ceiling, no votes router, and no
    // onSpec but the one that keeps the spec on its trial for a restart to go
    // on from (keepAsItLands: a first version's, a side build's, a build's).
    propose: false,
    onSpec: ctx.onSpecWritten
      ? ({ sessionId: id, specMd, turnId, specHtml }) => ctx.onSpecWritten({ sessionId: id, specMd, turnId, specHtml })
      : null,
    proposalCeiling: null,
    // A spec a restart's recovery kept: built from as it is, not written
    // again, and with its HTML, so the build still starts from the screens
    // it drew (spec-screens-start.js) and its screens are counted, as a live
    // build a restart interrupted does (homeroom-bot.js build_spec_html).
    ...(ctx.presetSpec ? { presetSpec: ctx.presetSpec } : {}),
    ...(ctx.presetSpec && ctx.presetSpecHtml ? { presetSpecHtml: ctx.presetSpecHtml } : {}),
    platformRepo: !!snapshot.extra?.platformRepo,
    firstVersion: !!snapshot.extra?.firstVersion,
    starter: snapshot.extra?.starter || null,
    sessionTitle: title,
    telemetry: TELEMETRY,
    // A turn that changed nothing is nudged as a live build's is, and
    // counted under its own lane.
    origin: { lane: 'bench', trialId: trial.id },
    onSession: async (s) => { sessionId = s.id; await ctx.onSession?.(s.id, { branch }); },
    // A first version's spec model when it differs from its build's (the
    // `today` preset: the bot's own model for each stage), and a studio
    // trial's pack and watch. None of them for any other build task.
    ...(ctx.specModel ? { specModel: ctx.specModel } : {}),
    ...(ctx.guidance ? { specGuidance: ctx.guidance.spec || null, buildGuidance: ctx.guidance.build || null } : {}),
    ...(ctx.onActivity ? { onProgress: ctx.onActivity } : {}),
    ...(ctx.onStep ? { onStage: ctx.onStep } : {}),
    // A studio trial an admin cancelled stops before its build turn.
    ...(ctx.skipCheck ? { skipCheck: ctx.skipCheck } : {}),
    // A configuration's (services/bot-configs.js, through the lane's
    // studioContext): which CLI each model runs in, and its review.
    ...(ctx.harnessOf ? { harnessOf: ctx.harnessOf } : {}),
    ...(ctx.reviewer ? { review: { reviewer: ctx.reviewer, owner: { trialId: trial.id }, onState: ctx.onReviewState || null } } : {}),
    // And its build-speed tweaks (bot-configs.js TWEAKS), a first version's.
    ...(ctx.tweaks?.length ? { tweaks: ctx.tweaks } : {}),
    // Each step the build reaches, for a trial that keeps its work as it
    // lands (keepAsItLands): the live bot's checkpoint hook.
    ...(ctx.onBuildStep ? { onStep: ctx.onBuildStep } : {}),
  });
  if (ctx.onBuilt) {
    try { await ctx.onBuilt({ ...built, sight }); } catch { /* a checkpoint never stops a trial */ }
  }
  const out = await buildResult({ built, base, branch, sessionId, deps, repo, task, trial });
  const reviewed = built.review ? require('../bot-review').slimState(built.review) : null;
  const costParts = out.parsed?.costParts ? await stageCosts.withLedgerTokens(pool, out.parsed.costParts) : null;
  return {
    ...out,
    parsed: { ...(out.parsed || {}), sight, ...(reviewed ? { review: reviewed } : {}), ...(costParts ? { costParts } : {}) },
    // The reviewer calls are not agent turns, so the ledger the lane reads a
    // trial's cost from does not hold them (lane.recordTrial).
    ...(built.review ? { review_cost_usd: reviewerCost(built.review) } : {}),
  };
}

/** What a review's reviewer calls cost, together (bot-review.js reviewerCost). Pure. */
function reviewerCost(review) {
  return require('../bot-review').reviewerCost(review);
}

// ── Going on after a restart ────────────────────────────────────────────

/**
 * What a trial that goes on after a restart kept, and how it keeps more
 * (firstVersionStage, sideBuildStage, laterSideBuildStage): its checkpoint
 * as this claim was handed it (`done`), `keep` for each part as it finishes,
 * `noteOpened` for every session it opens in any claim (what a release
 * charges), and the build it kept: `wasBuilt` whether it landed or failed,
 * `landed` only one that landed. A build is kept with its commit or not at
 * all: one said to have landed with none on record is built again.
 */
function keptOf(ctx) {
  const done = ctx.checkpoint || {};
  const keep = async (part) => {
    try { await ctx.onCheckpoint?.(part); } catch { /* a checkpoint never stops a trial */ }
  };
  const opened = Array.isArray(done.sessions) ? done.sessions.map(Number) : [];
  const noteOpened = async (id) => {
    if (!id || opened.includes(Number(id))) return;
    opened.push(Number(id));
    await keep({ sessions: [...opened] });
  };
  const wasBuilt = done.build && !(done.build.ok && !done.build.sha) ? done.build : null;
  return { done, keep, noteOpened, wasBuilt, landed: wasBuilt?.ok ? wasBuilt : null };
}

/** A kept spec that found the request impossible, as a build's outcome (buildResult reads it). Pure. */
function blockedBuildOf(spec) {
  return { ok: false, sessionId: spec.sessionId, blocked: spec.blocked, error: spec.error || null, specMd: null };
}

/**
 * A fresh session at the trial's branch, for a build an earlier claim landed
 * (its worker went with the restart and its session was put away): on the
 * trial before its worker starts, which is sealed at `base` as every worker
 * of the trial is, and counted among the sessions the trial opened.
 */
async function openKeptSession(ctx, kept, { model, base, branch }) {
  const s = await openSession(ctx.pool, ctx.config, { user: ctx.user, app: ctx.app, model, branch, title: ctx.title });
  await ctx.onSession?.(s.id, { baseSha: base, branch });
  await kept.noteOpened(s.id);
  return s;
}

/**
 * What a spec an earlier claim wrote cost, as the cost breakdown's spec part,
 * from its own session's ledger: a build from a kept spec writes none
 * (buildAndPropose's presetSpec), and without it the part fell to "other".
 * Only when the spec had a session of its own, never the build's, which holds
 * both turns.
 */
async function withKeptSpecCost(pool, built, done, model) {
  const id = Number(done.spec?.sessionId) || null;
  if (built.parsed?.costParts?.spec) return built;
  // Named by its turn's ledger id when the claim that wrote it kept one.
  const named = done.spec?.turnId ? (await stageCosts.turnParts(pool, { spec: { turnIds: [done.spec.turnId], model } })).spec : null;
  if (!named && (!id || id === Number(built.session_id))) return built;
  const spec = named || await stageCosts.sessionPart(pool, id, model);
  if (!spec) return built;
  return { ...built, parsed: { ...(built.parsed || {}), costParts: { spec, ...(built.parsed?.costParts || {}) } } };
}

// ── A configuration's side builds ───────────────────────────────────────
//
// A side build (services/bot-configs.js spawnSideBuilds) goes on after a
// restart as a first version does. Until 7 Oct 2026 every restart threw its
// turn away and ran it again: the platform restarts on each merge to main,
// 60 to 80 times a day and that night every 3 to 15 minutes, and a side
// build takes 10 to 20, so almost none finished (eight ended `infra_fail`
// that day, interrupted twice) and their configurations' pairs never
// completed. Now its spec turn, its build turn and a review's fix turn are
// each followed to their end (services/bench/lane.js "After a restart"),
// and what each claim finished is kept on the trial's checkpoint: the spec,
// the build the moment its build turn lands, and its review's state. The
// next claim takes each as it is and goes on from the first without one.

/**
 * The hooks a build stage keeps its work through as each part lands, a
 * first version's (firstVersionStage) and a side build's (buildSideNow)
 * alike: every session it opens (`kept.noteOpened`, what a release
 * charges); the spec as it is written, with its turn's ledger id; what the
 * build could see; and the build the moment its build turn (and any nudge)
 * pushed, with what its spec and build turns cost and their ledger ids
 * (buildAndPropose's `landed` step), before any review. A review's state is
 * kept as it goes; the build is kept with its first state too when no
 * `landed` step came (it always does but in a stubbed build). With no
 * review, the build is kept once buildAndPropose is over, if no step kept it.
 * So a restart anywhere after the build turn goes on from the build, never
 * builds it again, and its review, begun, is recorded cut short.
 */
function keepAsItLands(ctx, kept, { onBuilt = null } = {}) {
  let sessionId = null;
  let specMd = kept.done.spec?.specMd || null;
  let reviewSeen = false;
  let landedKept = false;
  // What the build turn could see (buildStage hands it over before each turn).
  let sight = kept.done.sight || null;
  return {
    onSession: async (id, info) => {
      sessionId = Number(id);
      await kept.noteOpened(id);
      return ctx.onSession?.(id, info);
    },
    onSpecWritten: ({ sessionId: id, specMd: written, turnId = null, specHtml = null }) => {
      specMd = written;
      return kept.keep({
        spec: { sessionId: Number(id), specMd: written, ...(turnId ? { turnId } : {}), ...(specHtml ? { specHtml } : {}) },
      });
    },
    onSight: (seen) => {
      sight = seen;
      return kept.keep({ sight: seen });
    },
    onBuildStep: async (name, data = {}) => {
      if (name !== 'landed' || landedKept || !data.landed?.sha) return;
      landedKept = true;
      await kept.keep({
        build: keptBuild({
          ok: true, sessionId: Number(data.sessionId) || sessionId, sha: data.landed.sha,
          commits: Number(data.landed.commits) || null, specMd, stageCosts: data.stageCosts || null, sight,
        }),
      });
    },
    onReviewState: async (state) => {
      const part = { review: require('../bot-review').slimState(state) };
      if (!reviewSeen) {
        reviewSeen = true;
        if (state?.finalSha && !landedKept) {
          landedKept = true;
          part.build = keptBuild({ ok: true, sessionId, sha: state.finalSha, commits: state.finalCommits, specMd });
        }
      }
      await kept.keep(part);
    },
    onBuilt: async (b) => {
      if (b.ok && b.sha && !landedKept) await kept.keep({ build: keptBuild(b) });
      if (onBuilt) await onBuilt(b);
    },
  };
}

/**
 * A side build's spec and build turns, run now (buildStage, never proposed),
 * each kept as it lands (keepAsItLands). A spec an earlier claim kept is
 * built from as it is (presetSpec). An earlier claim's branch goes first,
 * with anything a build the restart lost pushed to it: the build cuts the
 * branch at its base again (buildStage's ensureSessionBranch), which refuses
 * a branch at any other commit (github.ensureBranchAtSha).
 */
async function buildSideNow(ctx, kept, { models, snapshot, budgets, reviewer = undefined, onBuilt = null }) {
  const { deps, repo, trial } = ctx;
  try {
    await deps.github.deleteBenchBranch(repo.owner, repo.repo, branchFor(trial));
  } catch (err) {
    return { status: 'infra_fail', error: `branch: ${err.message}` };
  }
  return buildStage({
    ...ctx,
    model: models.build,
    specModel: models.spec !== models.build ? models.spec : null,
    snapshot,
    budgets,
    ...(reviewer !== undefined ? { reviewer } : {}),
    presetSpec: kept.done.spec?.specMd || null,
    presetSpecHtml: kept.done.spec?.specHtml || null,
    ...keepAsItLands(ctx, kept, { onBuilt }),
  });
}

/**
 * The review of a side build an earlier claim landed, when the restart came
 * before its review began: the review the live stage runs once its build
 * turn lands (homeroom-bot-live reviewLanded, bot-review.js runReviewLoop),
 * run now, as restart recovery reviews a live first version whose build turn
 * it followed (homeroom-bot.js reviewRecoveredBuild). The build's worker went
 * with the restart, so it runs on a fresh session at the trial's branch, its
 * fix turns by the same runner (live.buildTurnRunner). Its state is kept on
 * the checkpoint as it goes, so a restart in it is settled, not run again
 * (settleCutShortReview). Resolves { review, sessionId }, review null when
 * it could not start: a review fails open, and the build is captured as it
 * stands.
 */
async function reviewKeptBuild(ctx, kept, { models, replay, budgets, base, branch, resumeFrom = null, recoveredFix = null }) {
  const live = require('../homeroom-bot-live');
  const botReview = require('../bot-review');
  const { pool, config, deps, repo, app, user, trial } = ctx;
  const { landed, done } = kept;
  const session = await openKeptSession(ctx, kept, { model: models.build, base, branch });
  await kept.keep({ reviewSessionId: Number(session.id) });
  const turnDeps = {
    worker: deps.worker, sessions: deps.sessions, agentTurn: deps.agentTurn, activeWorkers: deps.activeWorkers, github: deps.github,
  };
  try {
    await deps.worker.ensureWorkerImage();
    const containerName = await deps.worker.ensureWorker(session.id, {
      repoOwner: repo.owner, repoName: repo.repo, branchName: branch, temporary: true, onProgress: () => {},
    });
    const readsImages = typeof done.sight?.told === 'boolean'
      ? done.sight.told
      : await live.buildSeesImages({ pool, config, userId: user.id, model: models.build });
    log.info('bench', resumeFrom ? 'Carrying on a review a restart cut short' : 'Reviewing a build a restart caught before its review', {
      trialId: trial.id, sessionId: session.id, resumes: Number(resumeFrom?.resumes) || 0, recoveredFix: !!recoveredFix,
    });
    const review = await live.reviewLanded({
      pool, config, bot: user, app, repo, session, branchName: branch, seed: replay.texts.seed,
      spec: landed.specMd || done.spec?.specMd || null,
      review: {
        reviewer: ctx.reviewer,
        owner: { trialId: trial.id },
        onState: (state) => kept.keep({ review: botReview.slimState(state) }),
      },
      deps: turnDeps,
      runBuildTurn: live.buildTurnRunner({
        pool, config, bot: user, session, model: models.build, branchName: branch, containerName, deps: turnDeps,
        harness: ctx.harnessOf ? ctx.harnessOf(models.build, config) : 'auto', telemetry: TELEMETRY, onProgress: ctx.onActivity || null,
        firstVersion: true, tweaks: ctx.tweaks || [],
      }),
      tweaks: ctx.tweaks || [],
      // A review a restart cut short, carried on from its saved state, as a
      // live first version's is (homeroom-bot.js resumeInterruptedReview).
      ...(resumeFrom ? { resumeFrom, recoveredFix } : {}),
      turnBudgetMs: budgets.buildMs,
      readsImages,
      platformRepo: !!replay.extra?.platformRepo,
      skipNow: ctx.skipCheck || null,
      onProgress: ctx.onActivity || null,
      start: { sha: landed.sha, commits: landed.commits, costUsd: null, activeMs: null, buildText: null },
    });
    return { review, sessionId: Number(session.id) };
  } catch (err) {
    log.warn('bench', 'Could not review a build a restart caught; capturing it as it stands', { trialId: trial.id, err: err.message });
    return { review: null, sessionId: Number(session.id) };
  }
}

/**
 * A build's review a restart cut short (in a capture, a reviewer call or a
 * fix turn) once it cannot be carried on (bot-review.js canResume: done, or
 * past MAX_REVIEW_RESUMES restarts), settled the way restart recovery
 * settles a live first version's (homeroom-bot.js completeRecoveredLive,
 * noteReviewInterrupted, checkRecoveredFix): not run again, but recorded `interrupted` at the
 * branch as it stands. A fix no capture saw boot is captured once
 * (`captureTip`, which resolves the screenshot step's answer and the session
 * it ran in): kept when it boots, that capture its final one; otherwise, or
 * when it cannot be captured, put back on the last commit that booted. The
 * branch is read rather than the kept state trusted, since a fix that landed
 * just before the restart may not have been saved. A review that had
 * finished is taken as it is. Resolves the settled review, and `tipShot`
 * ({ capture, sessionId }) when a capture saw the kept fix boot. Never
 * throws.
 */
async function settleCutShortReview(ctx, { review, landed, branch, captureTip = null }) {
  if (!review || review.state === 'done') return { review: review || null, tipShot: null };
  const { deps, repo } = ctx;
  const tip = await Promise.resolve()
    .then(() => deps.github.getBranchSha(repo.owner, repo.repo, branch))
    .catch(() => null);
  let finalSha = tip || review.finalSha || landed.sha || null;
  let finalCommits = review.finalCommits ?? landed.commits ?? null;
  let rolledBack = null;
  let tipShot = null;
  const booted = review.lastBooted?.sha || null;
  if (booted && finalSha && finalSha !== booted) {
    const shot = captureTip ? await Promise.resolve().then(captureTip).catch((err) => ({ ok: false, error: err.message })) : null;
    if (shot?.ok && shot.capture?.booted === true) {
      tipShot = { capture: shot.capture, sessionId: shot.sessionId ?? null };
    } else {
      try {
        await require('../homeroom-bot-live').rollbackReviewBranch({ github: deps.github, repo, branchName: branch, sha: booted });
        rolledBack = {
          from: finalSha, to: booted, why: shot?.ok ? 'did not boot after the restart' : 'could not be captured after the restart',
        };
        finalSha = booted;
        if (review.lastBooted.commits != null) finalCommits = review.lastBooted.commits;
      } catch (err) {
        log.warn('bench', 'Could not roll an unchecked review fix back; capturing it as it stands', {
          trialId: ctx.trial?.id, err: err.message,
        });
      }
    }
  }
  return {
    review: {
      ...review,
      state: 'done',
      stop: 'interrupted',
      stopDetail: 'the platform restarted during the review',
      finalSha,
      finalCommits,
      finishedAt: new Date().toISOString(),
      roundsUsed: (Array.isArray(review.rounds) ? review.rounds : []).filter((r) => r && r.verdict).length,
      ...(rolledBack ? { rolledBack } : {}),
      ...(tipShot ? { lastBooted: { sha: finalSha, commits: finalCommits }, fixCheckedAfterRestart: true } : {}),
    },
    tipShot,
  };
}

/**
 * What a kept build cost, stage by stage: as it kept its parts when it
 * landed live (keepAsItLands, buildAndPropose's `landed` step), with any
 * part it lacks read off the ledger by the turn ids the checkpoint kept (a
 * build turn, or a spec turn, restart recovery followed names no cost:
 * stageCosts.turnParts). Before this its whole cost fell to "other", and
 * the report could not find its build turn (bench/speed.js). Never throws.
 */
async function keptCosts(pool, was, done, models) {
  if (!was) return was;
  const have = was.stageCosts || {};
  const wanted = {};
  if (!have.spec && done.spec?.turnId) wanted.spec = { turnIds: [done.spec.turnId], model: models.spec };
  if (!have.build && Array.isArray(was.turnIds) && was.turnIds.length) wanted.build = { turnIds: was.turnIds, model: models.build };
  if (!Object.keys(wanted).length) return was;
  const read = await stageCosts.turnParts(pool, wanted);
  return Object.keys(read).length ? { ...was, stageCosts: { ...have, ...read } } : was;
}

/**
 * An earlier claim's build, gone on from (firstVersionStage, sideBuildStage),
 * as restart recovery goes on from a live first version's: one that landed
 * is reviewed now when its configuration has a reviewer and the restart
 * came before its review began (reviewKeptBuild); a review the restart cut
 * short is carried on from its saved state (`resumeFrom`, with the fix turn
 * recovery followed: `recoveredFix`) until MAX_REVIEW_RESUMES restarts have
 * caught it, then recorded cut short (settleCutShortReview); then it
 * is read as the live stage reads a build (buildResult), its stages' costs
 * the review's included (keptCosts, stageCosts.reviewParts). A build that
 * failed, or a spec that found the request impossible, is the trial's
 * outcome as it stands. Resolves { built, reviewSession, tipCapture,
 * finalCapture }: the session its review ran in, the capture a settled
 * review took of its tip (the build's final one), and that or the review's
 * own last capture.
 */
async function goOnFromKept(ctx, kept, { models, replay, budgets, base, branch }) {
  const { done, landed } = kept;
  let was = kept.wasBuilt || blockedBuildOf(done.spec);
  let reviewed = null;
  let reviewSession = null;
  let tipCapture = null;
  let reviewedNow = false;
  const botReview = require('../bot-review');
  if (landed && ctx.reviewer) {
    if (done.review && botReview.canResume(done.review)) {
      // Cut short by a restart, and not yet carried through
      // MAX_REVIEW_RESUMES of them: carried on from its saved state, with
      // the fix turn recovery followed when the review was waiting on it.
      try { ctx.onStep?.('review'); } catch { /* a watcher never stops a trial */ }
      const recoveredFix = done.recoveredFix && botReview.awaitsFix(done.review, done.recoveredFix) ? done.recoveredFix : null;
      ({ review: reviewed, sessionId: reviewSession } = await reviewKeptBuild(ctx, kept, {
        models, replay, budgets, base, branch, resumeFrom: done.review, recoveredFix,
      }));
      reviewedNow = true;
      // A resume that could not start leaves it cut short, as before.
      if (!reviewed) reviewed = (await settleCutShortReview(ctx, { review: done.review, landed, branch })).review;
    } else if (done.review) {
      const settled = await settleCutShortReview(ctx, {
        review: done.review, landed, branch,
        // The tip's one capture, on a session of its own at the branch:
        // when it boots, its screenshots are the build's final ones.
        captureTip: async () => {
          const s = await openKeptSession(ctx, kept, { model: models.build, base, branch });
          return { ...(await screenshotStep(ctx, Number(s.id))), sessionId: Number(s.id) };
        },
      });
      reviewed = settled.review;
      if (settled.tipShot) {
        tipCapture = settled.tipShot.capture;
        reviewSession = settled.tipShot.sessionId;
      }
      await kept.keep({ review: reviewed });
    } else {
      try { ctx.onStep?.('review'); } catch { /* a watcher never stops a trial */ }
      ({ review: reviewed, sessionId: reviewSession } = await reviewKeptBuild(ctx, kept, { models, replay, budgets, base, branch }));
      reviewedNow = true;
    }
    if (reviewed?.finalSha) {
      was = { ...was, sha: reviewed.finalSha, ...(Number(reviewed.finalCommits) > 0 ? { commits: Number(reviewed.finalCommits) } : {}) };
    }
  }
  was = await keptCosts(ctx.pool, was, done, models);
  const built = await buildResult({ built: was, base, branch, sessionId: was.sessionId, deps: ctx.deps, repo: ctx.repo, task: ctx.task, trial: ctx.trial });
  // What it could see: kept with a build that landed live, or, for one
  // restart recovery finished, kept when its turn started (onSight).
  const sight = was.sight || done.sight;
  const costParts = { ...(built.parsed?.costParts || {}), ...stageCosts.reviewParts(reviewed, { buildModel: models.build }) };
  built.parsed = {
    ...(built.parsed || {}),
    ...(sight ? { sight } : {}),
    ...(reviewed ? { review: require('../bot-review').slimState(reviewed) } : {}),
    ...(Object.keys(costParts).length ? { costParts: await stageCosts.withLedgerTokens(ctx.pool, costParts) } : {}),
  };
  // The reviewer calls of every claim: not agent turns, so no release
  // charged them (lane.recordTrial adds them once).
  if (reviewed) built.review_cost_usd = reviewerCost(reviewed);
  // A review run in this claim captured its final state itself; a settled
  // one's kept state holds only a slim copy of its capture.
  return { built, reviewSession, tipCapture, finalCapture: tipCapture || (reviewedNow ? reviewed?.finalCapture || null : null) };
}

/** Which session ids a side build's result is built from: its spec's, its build's and any its claim opened after. Pure. */
function sideSessionIds(done, ...more) {
  return [...new Set([done.spec?.sessionId, ...more].filter(Boolean).map(Number))];
}

/**
 * A SIDE BUILD of a live first version (services/bot-configs.js
 * spawnSideBuilds): one configuration's spec, build and review of the request
 * the live build is building, on the live project's own repository, from the
 * commit the live build started at. No first commit and no triage: the live
 * run's triage outcome and plan (its build snapshot's seed and build note,
 * with the creator's choices in it) are replayed as they are, so only the
 * spec, the build and the review differ. Then the screenshot step, as a
 * first version's.
 *
 * After a restart its next claim goes on from what the last kept (keptOf,
 * buildSideNow): a kept spec is built from; a build that landed is not built
 * again but reviewed now when its configuration has a reviewer and the
 * restart came before the review began (reviewKeptBuild), or its review
 * recorded cut short when the restart came during it (settleCutShortReview),
 * then captured on a fresh session at its branch.
 */
async function sideBuildStage(ctx) {
  const { pool, snapshot, deps, repo, trial } = ctx;
  if (!snapshot?.texts?.seed || !snapshot.baseSha) {
    return { status: 'infra_fail', error: 'the live run recorded no build snapshot to replay' };
  }
  const models = firstVersionModels(ctx);
  const step = (name) => { try { ctx.onStep?.(name); } catch { /* a watcher never stops a trial */ } };
  const kept = keptOf(ctx);
  const { done, landed } = kept;
  const replay = { ...snapshot, extra: { ...(snapshot.extra || {}), firstVersion: true } };
  // A first version's own clocks (homeroom-bot buildBudgets, firstVersion).
  const budgets = ctx.budgets.firstVersion || ctx.budgets;
  const base = snapshot.baseSha;
  const branch = branchFor(trial);
  // A reviewed build's final state, as its review captured it.
  let reviewedCapture = null;
  // The session a kept build's review ran in: its screenshots are taken there too.
  let reviewSession = null;
  let built;
  if (kept.wasBuilt || done.spec?.blocked) {
    // What an earlier claim's build did (or a spec that found the request
    // impossible), read as the live stage reads it, and its review first.
    ({ built, reviewSession, finalCapture: reviewedCapture } = await goOnFromKept(ctx, kept, { models, replay, budgets, base, branch }));
  } else {
    if (!done.spec) step('spec');
    built = await buildSideNow(ctx, kept, {
      models, snapshot: replay, budgets,
      onBuilt: async (b) => {
        reviewedCapture = b?.review?.finalCapture || null;
        if (ctx.onBuilt) await ctx.onBuilt(b);
      },
    });
  }
  built = await withKeptSpecCost(pool, built, done, models.spec);
  const out = {
    ...built,
    session_ids: sideSessionIds(done, built.session_id, reviewSession),
    parsed: {
      ...(built.parsed || {}), models, side: { botRunId: ctx.sideBuild?.botRunId || null },
      ...(Number(done.handBacks) > 0 ? { resumedAfterRestart: Number(done.handBacks) } : {}),
    },
  };
  if (built.status !== 'ok' || !built.parsed?.built || !built.session_id) return out;
  // Its review captured the final state already, and when a fix broke the
  // app that is the commit the branch went back to, which the worker's own
  // checkout no longer is: taken as it is, not captured again.
  if (reviewedCapture) return { ...out, capture: reviewedCapture };
  step('capture');
  // On the build's own worker; or, for a build an earlier claim landed, on
  // the session its review just ran in, or a fresh one at its branch.
  let shotSession = Number(built.session_id);
  if (landed) {
    shotSession = reviewSession || Number((await openKeptSession(ctx, kept, { model: models.build, base, branch })).id);
    out.session_ids = sideSessionIds(done, ...out.session_ids, shotSession);
  }
  const shot = await screenshotStep(ctx, shotSession);
  if (!shot.ok) return { ...out, status: 'infra_fail', error: shot.error };
  return { ...out, capture: shot.capture };
}

/**
 * A BUILD task's trial (a recorded build replayed on a candidate model): its
 * spec and build turns (buildStage), each kept as it lands (keepAsItLands),
 * so a restart in its spec turn goes on from the spec rather than writing
 * it again, as a live build goes on from a kept plan (homeroom-bot.js
 * resumeLiveBuildFromSpec). Until 13 Oct 2026 that turn was abandoned and
 * the whole trial run again, a claim spent. Its build turn a restart caught
 * is finished by recovery as before (lane.finishRecoveredTrial); a build
 * that landed before a restart that came after it is read as it stands.
 */
async function replayBuildStage(ctx) {
  const { pool, snapshot, deps, repo, trial } = ctx;
  const kept = keptOf(ctx);
  const { done } = kept;
  const branch = branchFor(trial);
  const models = { spec: ctx.specModel || ctx.model, build: ctx.model };
  let built;
  if (kept.wasBuilt || done.spec?.blocked) {
    const was = await keptCosts(pool, kept.wasBuilt || blockedBuildOf(done.spec), done, models);
    built = await buildResult({
      built: was, base: snapshot.baseSha || null, branch, sessionId: was.sessionId, deps, repo, task: ctx.task, trial,
    });
    const sight = was.sight || done.sight;
    if (sight) built.parsed = { ...(built.parsed || {}), sight };
  } else {
    if (done.spec) {
      // An earlier claim's branch goes first, with anything a build the
      // restart lost pushed to it: the build cuts it at its base again.
      try {
        await deps.github.deleteBenchBranch(repo.owner, repo.repo, branch);
      } catch (err) {
        return { status: 'infra_fail', error: `branch: ${err.message}` };
      }
    }
    built = await buildStage({
      ...ctx, presetSpec: done.spec?.specMd || null, presetSpecHtml: done.spec?.specHtml || null, ...keepAsItLands(ctx, kept),
    });
  }
  built = await withKeptSpecCost(pool, built, done, models.spec);
  const ids = sideSessionIds(done, built.session_id);
  return {
    ...built,
    ...(ids.length > 1 ? { session_ids: ids } : {}),
    ...(Number(done.handBacks) > 0 ? { parsed: { ...(built.parsed || {}), resumedAfterRestart: Number(done.handBacks) } } : {}),
  };
}

/**
 * A SIDE BUILD of a LATER change (services/bot-configs.js spawnSideBuilds,
 * scope `later`): one configuration's spec and build of the request the
 * bot's own build (live or shadow) is building, on the project's own
 * repository from the commit that build started at, replaying its request
 * and its triage's plan (the build snapshot's seed and build note) as they
 * are. The spec is a later change's (no first-version design brief), on the
 * build's own clocks; no review and no screenshot step. Never proposed,
 * never posted: buildStage's propose:false on the trial's guarded GitHub.
 * After a restart it goes on from what its last claim kept, as a first
 * version's side build does: a kept build is its result.
 */
async function laterSideBuildStage(ctx) {
  const { pool, snapshot, deps, repo, trial } = ctx;
  if (!snapshot?.texts?.seed || !snapshot.baseSha) {
    return { status: 'infra_fail', error: 'the run recorded no build snapshot to replay' };
  }
  const models = firstVersionModels(ctx);
  const kept = keptOf(ctx);
  const { done } = kept;
  let built;
  if (kept.wasBuilt || done.spec?.blocked) {
    // With what its stages cost (keptCosts: a build turn recovery followed
    // names none of its own).
    const was = await keptCosts(pool, kept.wasBuilt || blockedBuildOf(done.spec), done, models);
    built = await buildResult({
      built: was, base: snapshot.baseSha, branch: branchFor(trial), sessionId: was.sessionId, deps, repo, task: ctx.task, trial,
    });
    const sight = was.sight || done.sight;
    if (sight) built.parsed = { ...(built.parsed || {}), sight };
  } else {
    if (!done.spec) { try { ctx.onStep?.('spec'); } catch { /* a watcher never stops a trial */ } }
    built = await buildSideNow(ctx, kept, {
      models, snapshot: { ...snapshot, extra: { ...(snapshot.extra || {}), firstVersion: false } }, budgets: ctx.budgets, reviewer: null,
    });
  }
  built = await withKeptSpecCost(pool, built, done, models.spec);
  return {
    ...built,
    session_ids: sideSessionIds(done, built.session_id),
    parsed: {
      ...(built.parsed || {}), models, side: { botRunId: ctx.sideBuild?.botRunId || null },
      ...(Number(done.handBacks) > 0 ? { resumedAfterRestart: Number(done.handBacks) } : {}),
    },
  };
}

/**
 * The agent-turn module a build is handed, the same but for
 * resolveCodexRuntimeContext, whose runtime is shown to `onRuntime` (the
 * last one a build resolves is its build turn's) and then returned as it
 * is. A watcher that throws never stops the turn.
 */
function observedRuntime(agentTurn, onRuntime) {
  if (!agentTurn) return agentTurn;
  return new Proxy(agentTurn, {
    get(target, prop) {
      if (prop === 'resolveCodexRuntimeContext') {
        return async (...args) => {
          const runtime = await target.resolveCodexRuntimeContext(...args);
          try { await onRuntime(runtime); } catch { /* a watcher never stops a turn */ }
          return runtime;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A follow-up's prompt and mode, rebuilt from its snapshot. */
function followupTurn(snapshot, kind) {
  const followup = require('../homeroom-bot-followup');
  const seed = snapshot.texts.seed;
  const prNumber = snapshot.extra?.prNumber || null;
  if (kind === 'checks_fix') {
    let failing = [];
    try { failing = JSON.parse(snapshot.texts.failing || '[]'); } catch { failing = []; }
    return {
      prompt: followup.checksFixPrompt({
        seed, proposalBlock: snapshot.texts.proposal_block || '', prNumber, failing, total: snapshot.extra?.total || failing.length,
      }),
      mode: 'build',
    };
  }
  let replies = [];
  try { replies = JSON.parse(snapshot.texts.replies || '[]'); } catch { replies = []; }
  const canRevise = snapshot.extra?.canRevise !== false;
  return {
    prompt: followup.followUpPrompt({
      seed, proposalBlock: snapshot.texts.proposal_block || '', spec: snapshot.texts.spec || '', prNumber, replies, canRevise,
    }),
    mode: canRevise ? 'build' : 'scout',
  };
}

/**
 * A follow-up or checks-fix turn's patch, read from how it ended: its action
 * and, when it moved the head, the diff from the base. Shared by the live
 * stage and by a turn restart recovery followed to its end.
 */
async function followupResult({ turn, out, mode, base, branch, repo, deps }) {
  const followup = require('../homeroom-bot-followup');
  const ended = turnStatus(turn);
  if (ended) return { ...out, ...ended };
  const parsed = followup.parseFollowUp(turn.result.lastResultText);
  const moved = followup.headMoved({ mode, result: turn.result, reviewedHeadSha: base, action: parsed?.action });
  if (!parsed && !moved) return { ...out, status: 'model_fail', error: 'unparseable: no action block' };
  const compared = moved ? await branchDiff(deps.github, repo, base, branch) : null;
  return {
    ...out,
    status: 'ok',
    build_sha: moved ? turn.result.sha : null,
    build_commits: moved ? (Number(turn.result.ahead) || null) : null,
    parsed: {
      action: moved ? 'revise' : parsed.action,
      reply: parsed?.reply || null,
      answers: parsed?.answers || null,
      summary: parsed?.summary || null,
      moved: !!moved,
    },
    diff: compared ? compared.diff : null,
    changed_files: compared ? { files: compared.files, complete: compared.complete, truncated: compared.truncated } : null,
  };
}

async function followupStage(ctx, kind) {
  const { pool, config, snapshot, model, user, app, repo, trial, deps, budgets, title } = ctx;
  const seed = snapshot.texts.seed;
  if (!seed || !snapshot.baseSha) return { status: 'infra_fail', error: 'the snapshot has no seed or no proposal head' };
  const { prompt, mode } = followupTurn(snapshot, kind);
  const branch = branchFor(trial);
  let base;
  try {
    base = await pinBranch(deps.github, repo, branch, snapshot.baseSha);
  } catch (err) {
    return { status: 'infra_fail', error: `branch: ${err.message}` };
  }
  const session = await openSession(pool, config, { user, app, model, branch, title });
  await ctx.onSession?.(session.id, { baseSha: base, branch });
  const turn = await runTurn({
    pool, config, user, session, repo, prompt, mode, model, budgetMs: budgets.turnMs, deps,
    commitMsg: `Homeroom benchmark: trial ${trial.id}`,
    // Its lines in the studio's watch, as a triage's are.
    onActivity: ctx.onActivity,
  });
  const out = { session_id: session.id, base_sha: base, build_branch: branch, session, ...turnFields(turn) };
  return followupResult({ turn, out, mode, base, branch, repo, deps });
}

// ── The taste eval (#3737, services/bench/taste.js) ─────────────────────

/**
 * The screenshot step on a session's worker (services/bench/capture.js).
 * Resolves { ok: true, capture } (booted or not: an app that would not boot
 * is a result) or { ok: false, error } when the platform could not run it.
 */
async function screenshotStep(ctx, sessionId) {
  const { pool, deps, trial, app, repo } = ctx;
  let containerName;
  try {
    await deps.worker.ensureWorkerImage();
    containerName = await deps.worker.ensureWorker(sessionId, {
      repoOwner: repo.owner, repoName: repo.repo, branchName: branchFor(trial), temporary: true, onProgress: () => {},
    });
  } catch (err) {
    return { ok: false, error: `worker: ${err.message}` };
  }
  const step = deps.captureStep || ((args) => require('./capture').captureTrial(args));
  return step({ pool, trialId: trial.id, worker: deps.worker, containerName, appId: app.id });
}

/**
 * A capture trial (the "before" arm): the app's repository at the task's
 * commit, in a sealed worker, and only the screenshot step. No model turn,
 * so nothing is spent on a model.
 */
async function captureStage(ctx) {
  const { pool, config, snapshot, model, user, app, repo, trial, deps, title } = ctx;
  const input = require('./taste').inputOf(snapshot);
  if (!input.sha) return { status: 'infra_fail', error: 'the task names no commit' };
  const branch = branchFor(trial);
  let base;
  try {
    base = await pinBranch(deps.github, repo, branch, input.sha);
  } catch (err) {
    return { status: 'infra_fail', error: `branch: ${err.message}` };
  }
  const session = await openSession(pool, config, { user, app, model, branch, title });
  await ctx.onSession?.(session.id, { baseSha: base, branch });
  const out = { session_id: session.id, base_sha: base, build_branch: branch, cost_usd: 0, session };
  const shot = await screenshotStep(ctx, session.id);
  if (!shot.ok) return { ...out, status: 'infra_fail', error: shot.error };
  return { ...out, status: 'ok', parsed: { captured: true }, capture: shot.capture };
}

/**
 * The model each turn of a first version runs on: the trial's own for all
 * three, or, for the studio's `today` preset (services/bench/studio.js),
 * what the live bot runs each stage on now. Pure.
 */
function firstVersionModels(ctx) {
  const m = ctx.stageModels || {};
  return { triage: m.triage || ctx.model, spec: m.spec || ctx.model, build: m.build || ctx.model };
}

/**
 * A first-version trial: the bot's real first-version path from a brief,
 * the way a project's first version is made today.
 *
 *   1. The new project's first commit (services/bench/scaffold.js): today's
 *      starter rendered for the app's name, the first session's card of the
 *      idea, and the context pack's files, made once per run, task and pack
 *      and shared by every arm; the trial's branch is cut at it.
 *   2. The brief filed as the project's first request, quoting the card as
 *      the live one does (homeroom-bot-dm firstVersionIssue).
 *   3. The triage with the first-version note (and the pack's guidance).
 *   4. The plan. The live bot shows it to the creator and waits for Build it
 *      (homeroom-bot.js awaitGo, goAhead); here the creator taps Build it
 *      without changing anything, so the build note gets exactly the lines
 *      goAhead adds for the plan and its suggested answers (creatorChoiceNote).
 *   5. The spec and the build on the first version's longer clocks
 *      (buildAndPropose, never proposed), each on its own model.
 *   6. The screenshot step on the build's worker.
 *
 * A triage that does not answer `ready` builds nothing, as the bot would
 * not, and the trial says what it answered instead.
 *
 * Each sub-step's outcome is kept on the trial as it finishes
 * (ctx.onCheckpoint): the triage's answer, the spec, a build that landed;
 * and what the build could see, as each of its turns starts (onSight).
 * A restart that interrupts the trial hands it back to the lane, and its
 * next claim (ctx.checkpoint) takes each kept outcome as it is and goes on
 * from the first sub-step without one, as the bot's own builds go on from a
 * kept spec (homeroom-bot.js handBackRun, buildAndPropose's presetSpec). A
 * build that landed keeps its branch; anything earlier starts the branch
 * again at the first commit.
 */
async function firstVersionStage(ctx) {
  const { pool, snapshot, repo, trial, deps, budgets } = ctx;
  const taste = require('./taste');
  const bot = require('../homeroom-bot');
  const scaffold = require('./scaffold');
  const input = taste.inputOf(snapshot);
  if (!input.brief || !input.appName) return { status: 'infra_fail', error: 'the task has no brief' };
  const step = (name) => { try { ctx.onStep?.(name); } catch { /* a watcher never stops a trial */ } };
  const models = firstVersionModels(ctx);
  const branch = branchFor(trial);
  const kept = keptOf(ctx);
  const { done, keep, noteOpened, wasBuilt, landed } = kept;
  step('scaffold');
  const made = await (deps.scaffold || scaffold.ensure)(pool, {
    runId: trial.run_id, taskId: ctx.task?.id, pack: ctx.pack || null, input, repo, github: deps.github, user: ctx.user, deps,
  });
  if (!made || !made.ok) return { status: 'infra_fail', error: `scaffold: ${made?.error || 'not made'}` };
  let base;
  try {
    if (landed) {
      // Its build landed before a restart: the branch stays at its commit.
      await pinBranch(deps.github, repo, branch, landed.sha);
      base = made.sha;
    } else {
      // An earlier attempt's branch of the same trial (a restart) goes first.
      await deps.github.deleteBenchBranch(repo.owner, repo.repo, branch);
      base = await pinBranch(deps.github, repo, branch, made.sha);
    }
  } catch (err) {
    return { status: 'infra_fail', error: `branch: ${err.message}` };
  }
  const card = scaffold.requestCard(made.sketch);
  const botLogin = await require('../homeroom-bot-live').botUsernameOf(deps.github).catch(() => null);
  const request = taste.firstVersionRequest(input, card);
  const seed = taste.seedFor(input, botLogin, card);
  const replay = {
    ...snapshot, issueNumber: taste.ISSUE_NUMBER, baseSha: base, promptHash: null,
    texts: { seed, build_note: '' }, thread: { issue: { title: request.title } },
    extra: {
      ...(snapshot.extra || {}), firstVersion: true,
      // A task scaffolded from a game starter (taste.js `template`) is
      // planned, specced and built on it, as a live project made from it is.
      ...(require('../app-templates').botStarter(input.template) ? { starter: input.template } : {}),
    },
  };
  const started = {
    scaffold: { sha: made.sha, branch: made.branch || null },
    sketch: card ? { emoji: card.emoji || null, tagline: card.tagline || null, points: card.points || [] } : null,
    models,
    ...(Number(done.handBacks) > 0 ? { resumedAfterRestart: Number(done.handBacks) } : {}),
  };
  let triaged = done.triage || null;
  if (!triaged) {
    step('triage');
    triaged = await triageStage({
      ...ctx, model: models.triage, snapshot: replay, baseSha: base,
      // Which session is the triage's: recovery tells its turn from the spec's by it.
      onSession: async (id, info) => {
        await keep({ triageSessionId: Number(id) });
        await noteOpened(id);
        return ctx.onSession?.(id, info);
      },
    });
    if (triaged.status === 'ok') await keep({ triage: keptTriage(triaged) });
  }
  const sessionIds = [triaged.session_id].filter(Boolean);
  const common = { base_sha: base, build_branch: branch, session_ids: sessionIds };
  const triage = triaged.parsed ? {
    verdict: triaged.parsed.verdict, question: triaged.parsed.question || null, buildNote: triaged.parsed.buildNote || null,
    reason: triaged.parsed.reason || null, assumptions: triaged.parsed.assumptions || [],
  } : null;
  if (triaged.status !== 'ok') return { ...triaged, ...common, session: undefined, parsed: { ...started, triage, built: false } };
  if (triage.verdict !== 'ready') {
    return {
      ...common, session_id: triaged.session_id, status: 'ok', cost_usd: triaged.cost_usd,
      raw_output: triaged.raw_output, parsed: { ...started, triage, built: false },
    };
  }
  // An admin's cancel (services/bench/lane.js cancelTrial) ends it here.
  const stopped = ctx.skipCheck ? await ctx.skipCheck() : null;
  if (stopped) {
    return { ...common, session_id: triaged.session_id, status: 'cancelled', error: stopped, cost_usd: triaged.cost_usd, parsed: { ...started, triage, built: false } };
  }
  step('plan');
  const plan = bot.planFor(triaged.parsed);
  const chosen = bot.choicesFrom(plan.questions, []);
  const buildNote = `${triage.buildNote || ''}${bot.creatorChoiceNote(chosen, { bullets: plan.bullets })}`;
  let built;
  // The session a kept build's review ran in (its screenshots are taken
  // there too), and the capture a settled review took of its tip.
  let reviewSession = null;
  let tipCapture = null;
  const buildSnapshot = { ...replay, texts: { seed, build_note: buildNote } };
  // A first version's own clocks (homeroom-bot buildBudgets, firstVersion).
  const clocks = budgets.firstVersion || budgets;
  if (wasBuilt || done.spec?.blocked) {
    // What the build (or a spec that found it impossible) did before a
    // restart, read as the live stage reads it, and its configuration's
    // review first, as recovery reviews a live first version's
    // (goOnFromKept). Until 13 Oct 2026 a kept build was captured as it
    // stood: a restart while all six of run 189's builds were building left
    // every one of them unreviewed.
    ({ built, reviewSession, tipCapture } = await goOnFromKept(ctx, kept, {
      models, replay: buildSnapshot, budgets: clocks, base, branch,
    }));
  } else {
    if (!done.spec) step('spec');
    built = await buildStage({
      ...ctx,
      model: models.build,
      specModel: models.spec !== models.build ? models.spec : null,
      snapshot: buildSnapshot,
      budgets: clocks,
      presetSpec: done.spec?.specMd || null,
      presetSpecHtml: done.spec?.specHtml || null,
      // Each part kept as it lands: the spec, the build the moment it
      // pushed (with its costs), and its review's state as it goes.
      ...keepAsItLands(ctx, kept),
    });
  }
  built = await withKeptSpecCost(pool, built, done, models.spec);
  const ids = [...sessionIds, done.spec?.sessionId, built.session_id, reviewSession].filter(Boolean).map(Number);
  const cost = [triaged.cost_usd, built.cost_usd].filter(Number.isFinite);
  // The triage's part of the cost breakdown, from its own session's ledger.
  const triagePart = await stageCosts.sessionPart(pool, triaged.session_id, models.triage)
    || stageCosts.part({ usd: triaged.cost_usd, model: models.triage });
  const costParts = { ...(triagePart ? { triage: triagePart } : {}), ...(built.parsed?.costParts || {}) };
  const merged = {
    ...built, base_sha: base, build_branch: branch, session_id: built.session_id || triaged.session_id, session_ids: [...new Set(ids)],
    cost_usd: cost.length ? cost.reduce((a, b) => a + b, 0) : null,
    parsed: {
      ...started, ...(built.parsed || {}), triage, plan: { bullets: plan.bullets, questions: plan.questions, chosen },
      ...(Object.keys(costParts).length ? { costParts } : {}),
    },
  };
  if (built.status !== 'ok' || !built.parsed?.built || !built.session_id) return merged;
  // A review a restart cut short took the one capture of its tip: that is
  // the build's final state, not captured again.
  if (tipCapture) return { ...merged, capture: tipCapture };
  step('capture');
  // On the build's own worker; or, for a build that landed before a restart
  // (its worker gone, its session put away), on the session its review just
  // ran in, or a fresh one at its branch.
  let shotSession = built.session_id;
  if (landed) {
    shotSession = reviewSession || (await openKeptSession(ctx, kept, { model: models.build, base, branch })).id;
    merged.session_ids = [...new Set([...merged.session_ids, Number(shotSession)])];
  }
  const shot = await screenshotStep(ctx, shotSession);
  // The platform failing to run the step is not the build's fault: the
  // trial is a fault, kept out of quality, with its build still recorded.
  if (!shot.ok) return { ...merged, status: 'infra_fail', error: shot.error };
  return { ...merged, capture: shot.capture };
}

/** A triage's outcome as a checkpoint keeps it: everything but the live session. */
function keptTriage(t) {
  return {
    status: t.status, error: t.error || null, session_id: t.session_id || null, cost_usd: t.cost_usd ?? null,
    raw_output: t.raw_output ?? null, parsed: t.parsed || null,
  };
}

/** A build's outcome (buildAndPropose's, or a recovered turn's) as a checkpoint keeps it. */
function keptBuild(b) {
  return {
    ok: !!b.ok, sessionId: b.sessionId ? Number(b.sessionId) : null, sha: b.sha || null,
    commits: Number.isFinite(b.commits) ? b.commits : null, specMd: b.specMd || null, specNote: b.specNote || null,
    error: b.error || null, ...(b.blocked ? { blocked: b.blocked } : {}),
    ...(b.sight ? { sight: b.sight } : {}),
    ...(b.stageCosts ? { stageCosts: b.stageCosts } : {}),
    // The ledger ids of a build turn restart recovery followed, which names
    // no cost: its next claim reads them (keptCosts).
    ...(Array.isArray(b.turnIds) && b.turnIds.length ? { turnIds: b.turnIds.slice(0, 4) } : {}),
    ...(Array.isArray(b.specScreens) && b.specScreens.length ? { specScreens: b.specScreens } : {}),
    ...(b.noChange ? { noChange: b.noChange } : {}),
  };
}

/**
 * A reference build (services/bench/studio.js submitReference): an app a
 * Claude Code session built from the same first commit and pack, copied
 * into the trial's branch when it was handed in (capture_sha). It is judged
 * like the bot's builds and so goes through the same screenshot step, in the
 * same sealed worker, with no model turn: nothing is spent on a model. Its
 * diff is read against the first commit it was built on.
 */
async function referenceStage(ctx) {
  const { pool, config, user, app, repo, trial, deps, title } = ctx;
  const sha = trial.capture_sha;
  if (!sha) return { status: 'infra_fail', error: 'the reference names no commit' };
  const scaffoldSha = trial.base_sha || null;
  const branch = branchFor(trial);
  let tip;
  try {
    tip = await pinBranch(deps.github, repo, branch, sha);
  } catch (err) {
    return { status: 'infra_fail', error: `branch: ${err.message}` };
  }
  const session = await openSession(pool, config, { user, app, model: ctx.sessionModel || ctx.model, branch, title });
  // Sealed at the first commit it was built on, as a built first version's
  // worker is at capture time.
  await ctx.onSession?.(session.id, { baseSha: scaffoldSha || tip, branch });
  const out = {
    session_id: session.id, base_sha: scaffoldSha || tip, build_branch: branch, build_sha: sha, cost_usd: 0, session,
    build_commits: Number.isFinite(trial.build_commits) && trial.build_commits > 0 ? trial.build_commits : 1,
  };
  const compared = scaffoldSha ? await branchDiff(deps.github, repo, scaffoldSha, branch) : null;
  try { ctx.onStep?.('capture'); } catch { /* a watcher never stops a trial */ }
  const shot = await screenshotStep(ctx, session.id);
  const parsed = { built: true, reference: true, label: trial.reference_label || null, scaffold: { sha: scaffoldSha } };
  const files = compared ? { diff: compared.diff, changed_files: { files: compared.files, complete: compared.complete, truncated: compared.truncated } } : {};
  if (!shot.ok) return { ...out, ...files, status: 'infra_fail', error: shot.error, parsed };
  return { ...out, ...files, status: 'ok', parsed, capture: shot.capture };
}

const STAGE_RUNNERS = Object.freeze({
  triage: triageStage,
  spec: specStage,
  // A side build of a later change replays its plan (laterSideBuildStage);
  // any other build keeps its spec for a restart to go on from.
  build: (ctx) => (ctx.sideBuild ? laterSideBuildStage(ctx) : replayBuildStage(ctx)),
  followup: (ctx) => followupStage(ctx, 'followup'),
  checks_fix: (ctx) => followupStage(ctx, 'checks_fix'),
  // A DM task is a conversation of triage turns (services/bench/dm-sim.js).
  dm: (ctx) => require('./dm-sim').dmStage(ctx),
  // A reference build handed in from outside is a first version too,
  // only captured (referenceStage).
  first_version: (ctx) => {
    if (ctx.trial?.reference_label) return referenceStage(ctx);
    // A side build of a live first version replays its plan (sideBuildStage).
    return ctx.sideBuild ? sideBuildStage(ctx) : firstVersionStage(ctx);
  },
  capture: captureStage,
});

// ── After a restart ─────────────────────────────────────────────────────

/**
 * Whether restart recovery can follow a trial's interrupted turn to its end.
 * For most trials, when the turn is the trial's last and nothing after it
 * needs this process's memory: a triage, a follow-up and a checks fix are one
 * turn; a build is two, a spec turn (`scout`) and then the build turn
 * (`build`), and only the second is its last. A first version's every turn
 * (its triage, spec and build) is followed, and what it produced kept for
 * the trial's next claim to go on from (recoverFirstVersionTurn); so is a
 * side build's (sideBuildStage at the `first_version` stage,
 * laterSideBuildStage at `build`): its spec turn, its build turn and a
 * review's fix turn, each a `scout` or a `build` turn (sideTurnOf). A
 * reference build has no turn. A DM conversation, a spec stage, or anything
 * unknown is run again instead. Pure.
 */
function resumableTurn(stage, activeTurn, { reference = false, side = false } = {}) {
  if (!activeTurn) return false;
  if (side) return (stage === 'first_version' || stage === 'build') && (activeTurn.mode === 'scout' || activeTurn.mode === 'build');
  if (stage === 'triage' || stage === 'followup' || stage === 'checks_fix') return true;
  // A spec task's one turn; a build's spec turn too, kept for its next
  // claim to build from (replayBuildStage), and its build turn finished.
  if (stage === 'spec') return activeTurn.mode === 'scout';
  if (stage === 'build') return activeTurn.mode === 'scout' || activeTurn.mode === 'build';
  if (stage === 'first_version') return !reference && (activeTurn.mode === 'scout' || activeTurn.mode === 'build');
  return false;
}

/**
 * Which of a first version's turns a session's turn is: 'triage', 'spec',
 * 'build' or 'fix' (a review's fix turn), or null. The triage and the spec
 * are both `scout` turns, told apart by the triage's session, which the
 * trial keeps before its turn runs (firstVersionStage). A fix is a `build`
 * turn too, told from the build's by the landed build the checkpoint keeps
 * from the moment it pushed (keepAsItLands), as a side build's is
 * (sideTurnOf). Pure.
 */
function firstVersionTurnOf(checkpoint, sessionId, activeTurn) {
  if (!activeTurn) return null;
  if (activeTurn.mode === 'build') return checkpoint?.build?.ok ? 'fix' : 'build';
  if (activeTurn.mode !== 'scout') return null;
  const cp = checkpoint || {};
  if (cp.triageSessionId != null) return Number(cp.triageSessionId) === Number(sessionId) ? 'triage' : 'spec';
  return cp.triage ? 'spec' : 'triage';
}

/**
 * Which of a side build's turns a session's turn is: 'spec' (its one `scout`
 * turn: a side build has no triage), 'build', or 'fix', a review's fix turn.
 * A fix is a `build` turn too, told from the build's by the landed build the
 * checkpoint keeps from the moment the review starts (buildSideNow). Null
 * for any other turn. Pure.
 */
function sideTurnOf(checkpoint, activeTurn) {
  if (!activeTurn) return null;
  if (activeTurn.mode === 'scout') return 'spec';
  if (activeTurn.mode !== 'build') return null;
  return checkpoint?.build?.ok ? 'fix' : 'build';
}

/** A journal replay's result in the shape runTurn resolves, so the same readers apply. */
function recoveredTurn(result = {}, timedOut = false) {
  const r = result || {};
  return {
    routed: { result: r, error: null },
    result: r,
    stopped: !!timedOut,
    infra: false,
    costUsd: null, // the ledger has it (lane.recordTrial)
    usage: {
      inputTokens: Number.isFinite(r.inputTokens) ? r.inputTokens : null,
      outputTokens: Number.isFinite(r.outputTokens) ? r.outputTokens : null,
    },
  };
}

const RECOVERED_NOTE = ' (finished after a restart)';

/**
 * A trial's last turn, finished by restart recovery: its patch, read from
 * the journal replay's `result` by the same readers the live stage uses
 * (triageResult, followupResult, buildResult). `baseSha` and `branch` are
 * what the trial recorded before the turn ran. Resolves null for a turn
 * that is not the trial's last (resumableTurn). Nothing here posts, pushes
 * or proposes: GitHub is read through the trial's guarded client only.
 */
async function recoverStage({
  stage, snapshot, task, trial, session, activeTurn, result = {}, timedOut = false, repo, deps,
  baseSha = null, branch = null,
}) {
  if (!resumableTurn(stage, activeTurn)) return null;
  const turn = recoveredTurn(result, timedOut);
  const br = branch || branchFor(trial);
  if (stage === 'triage') {
    const prompt = triagePrompt(snapshot, snapshot.texts.seed);
    const out = { session_id: session.id, base_sha: baseSha || snapshot.baseSha || null, build_branch: br, ...turnFields(turn) };
    return triageResult({ turn, out, prompt, snapshot });
  }
  if (stage === 'followup' || stage === 'checks_fix') {
    const base = baseSha || snapshot.baseSha;
    if (!base) throw new Error('the trial has no base on record');
    const { mode } = followupTurn(snapshot, stage);
    const out = { session_id: session.id, base_sha: base, build_branch: br, ...turnFields(turn) };
    return followupResult({ turn, out, mode, base, branch: br, repo, deps });
  }
  if (stage === 'spec') {
    // Read as specStage reads draftSpec's answer.
    const out = { session_id: session.id, base_sha: baseSha || snapshot.baseSha || null, build_branch: br, cost_usd: null };
    if (timedOut) return { ...out, status: 'timeout', error: `the spec ran past its time limit${RECOVERED_NOTE}` };
    const live = require('../homeroom-bot-live');
    const r = result || {};
    const read = live.readSpec(r.lastResultText, { parts: r.answerParts });
    if (read.ok) return { ...out, status: 'ok', raw_output: rawOf(read.specMd), parsed: { spec: read.specMd } };
    if (read.blocked) return { ...out, status: 'ok', parsed: { blocked: read.blocked }, raw_output: rawOf(`BLOCKED: ${read.blocked}`) };
    const failed = live.failedClaudeTurn(r);
    return { ...out, status: 'model_fail', error: failed ? `the spec turn failed (${failed})${RECOVERED_NOTE}` : `no spec${RECOVERED_NOTE}` };
  }
  // The build turn. The spec turn before it stored its spec on the session;
  // a build's spec turn itself is kept, not finished (lane.handBackTrial).
  if (activeTurn.mode !== 'build') return null;
  if (!baseSha) throw new Error('the build has no base on record');
  const built = recoveredBuild({ session, result, timedOut });
  return buildResult({ built, base: baseSha, branch: br, sessionId: session.id, deps, repo, task, trial });
}

/**
 * A build turn restart recovery followed to its end, in the shape
 * buildAndPropose resolves (buildResult reads it). `specMd` is the spec it
 * was built from, when the caller has it; otherwise the session's. Pure.
 */
function recoveredBuild({ session, result = {}, timedOut = false, specMd: given = null }) {
  const live = require('../homeroom-bot-live');
  const r = result || {};
  const turnFailed = timedOut ? null : live.failedClaudeTurn(r);
  const landed = !timedOut && !turnFailed && r.pushOk === true && Number(r.ahead) > 0;
  const specMd = given || (String(session.spec_md || '').trim() ? session.spec_md : null);
  // A turn that ended cleanly and changed nothing keeps what it said, as a
  // build that was not interrupted does; recovery does not nudge it.
  const facts = live.turnFacts({ routed: { result: r }, stopped: timedOut }, { model: session.agent_model || null });
  const quit = facts.ended === 'no_change' || facts.ended === 'not_pushed';
  return {
    ...(quit ? {
      noChange: {
        turns: [{ ...facts, said: live.agentSaid(r.lastResultText) }],
        nudged: false, notNudged: 'a restart caught the turn, and recovery does not nudge', committed: null, recovered: true,
      },
    } : {}),
    ok: landed,
    sessionId: session.id,
    sha: landed ? (r.sha || null) : null,
    commits: landed ? Number(r.ahead) : null,
    costUsd: null,
    specMd,
    specNote: specMd ? null : 'no spec on record; the build worked from the plan',
    error: landed ? null
      : timedOut ? `the build ran past its time limit${RECOVERED_NOTE}`
        : turnFailed ? `the build turn failed (${turnFailed})${RECOVERED_NOTE}`
          : r.pushFailed ? `couldn't push the build's commit (${r.pushFailed})${RECOVERED_NOTE}`
            : `the build produced no change to propose${RECOVERED_NOTE}`,
  };
}

/**
 * A first version's turn, followed to its end by restart recovery: what it
 * produced, as the part of the trial's checkpoint its next claim goes on
 * from (firstVersionStage), read by the same readers the live stage uses.
 * Resolves { step, keep }, or null when the turn left nothing to keep: a
 * spec that failed or ran out of time (the live build would go on from the
 * plan alone; the next claim writes the spec again instead), or a turn that
 * is none of the three. A triage's or a build's failure is kept: it is the
 * trial's outcome, and its next claim records it as the live stage would.
 *
 * `side` reads a side build's turn the same way (sideTurnOf), its spec and
 * its build as a first version's. A review's fix turn keeps nothing of its
 * own: the review is on the checkpoint already, and the next claim records
 * it cut short at the branch as the fix left it (settleCutShortReview).
 */
/**
 * The ledger id of a turn record (agent_turns.logical_turn_id): the
 * attempt identity the worker persists with it, else the record's own id,
 * which the worker takes from it. Null without one. Pure.
 */
function ledgerTurnIdOf(activeTurn) {
  const id = activeTurn?.logicalTurnId || activeTurn?.turnId || null;
  return typeof id === 'string' && id ? id : null;
}

function recoverFirstVersionTurn({ checkpoint, session, activeTurn, result = {}, timedOut = false, side = false }) {
  const step = side ? sideTurnOf(checkpoint, activeTurn) : firstVersionTurnOf(checkpoint, session.id, activeTurn);
  if (!step || step === 'fix') return null;
  const turn = recoveredTurn(result, timedOut);
  if (step === 'triage') {
    const out = { session_id: session.id, ...turnFields(turn) };
    // A first version's triage prompt is rendered for the trial, never
    // read from a snapshot, so there is no hash to compare it to.
    return { step, keep: { triage: keptTriage(triageResult({ turn, out, prompt: '', snapshot: { promptHash: null } })) } };
  }
  if (step === 'spec') {
    if (timedOut) return null;
    const read = require('../homeroom-bot-live').readSpec(turn.result.lastResultText, { parts: turn.result.answerParts });
    // With its turn's ledger id, so the trial can still name what it cost.
    const turnId = ledgerTurnIdOf(activeTurn);
    const named = turnId ? { turnId } : {};
    // And its HTML: the build that goes on from it starts from the screens
    // it drew (presetSpecHtml). Run 190: a restart during all six spec turns
    // kept only the markdown, and no build started from its screens.
    const html = read.specHtml ? { specHtml: read.specHtml } : {};
    if (read.ok) return { step, keep: { spec: { sessionId: Number(session.id), specMd: read.specMd, ...named, ...html } } };
    if (read.blocked) return { step, keep: { spec: { sessionId: Number(session.id), blocked: read.blocked, error: read.error, ...named } } };
    return null;
  }
  const specMd = checkpoint?.spec?.specMd || null;
  const turnId = ledgerTurnIdOf(activeTurn);
  return {
    step,
    keep: { build: keptBuild({ ...recoveredBuild({ session, result, timedOut, specMd }), ...(turnId ? { turnIds: [turnId] } : {}) }) },
  };
}

/**
 * Run one stage of one task on one model, with nothing leaving the
 * benchmark. Resolves the trial's patch: its status, what it said, what it
 * cost, and (for a build) its branch and diff. Never throws: a refused side
 * effect or anything unexpected is an infra failure with its reason.
 */
async function runStage(ctx) {
  const runner = STAGE_RUNNERS[ctx.stage];
  if (!runner) return { status: 'not_applicable', error: `no runner for ${ctx.stage}` };
  const startedMs = Date.now();
  // Every stage puts its base on the trial (onSession) before it starts a
  // worker; the worker it is handed is sealed at that base.
  let pinned = null;
  const sealed = {
    ...ctx,
    onSession: async (id, info = {}) => {
      if (info?.baseSha) pinned = info.baseSha;
      return ctx.onSession?.(id, info);
    },
    deps: ctx.deps?.worker ? { ...ctx.deps, worker: sealedWorker(ctx.deps.worker, () => pinned) } : ctx.deps,
  };
  let out;
  try {
    out = await runner(sealed);
  } catch (err) {
    log.warn('bench', 'A trial threw', { trialId: ctx.trial?.id, stage: ctx.stage, err: err.message });
    out = { status: 'infra_fail', error: `${err.code === 'bench_side_effect' ? 'refused: ' : 'threw: '}${err.message}` };
  }
  return { ...out, duration_ms: Date.now() - startedMs };
}

/** The clocks a trial gets: the bot's own, from its settings and the app. */
function budgetsFor(settings, app, config, stage) {
  const bot = require('../homeroom-bot');
  const turnMs = 1000 * (Number(settings?.turnSeconds) || bot.DEFAULTS.turnSeconds);
  const built = bot.buildBudgets(app, config, turnMs);
  const budgets = { turnMs: stage === 'build' || stage === 'spec' ? built.turnBudgetMs : turnMs, buildMs: built.turnBudgetMs, specMs: built.specBudgetMs };
  if (stage !== 'first_version') return budgets;
  // A first version's triage has a triage's clock; its spec and build get
  // the longer ones the bot gives a first version.
  const first = bot.buildBudgets(app, config, turnMs, { firstVersion: true });
  return { ...budgets, firstVersion: { turnMs, buildMs: first.turnBudgetMs, specMs: first.specBudgetMs } };
}

module.exports = {
  BENCH_USERNAME,
  DEFAULT_BENCH_WEEKLY_CENTS,
  RAW_OUTPUT_CHARS,
  DIFF_CHARS,
  TELEMETRY,
  HIDDEN_CHECKS_GAP,
  GITHUB_READS,
  BenchSideEffectError,
  guardedGithub,
  sealedWorker,
  assertBenchBranch,
  ensureBenchUser,
  isBenchSession,
  isRecoveredBenchSession,
  branchFor,
  pinBranch,
  openSession,
  runTurn,
  turnStatus,
  sessionUsage,
  branchDiff,
  hiddenChecksUnavailable,
  runStage,
  budgetsFor,
  STAGE_RUNNERS,
  triageStage,
  firstVersionStage,
  sideBuildStage,
  laterSideBuildStage,
  replayBuildStage,
  settleCutShortReview,
  reviewerCost,
  firstVersionModels,
  referenceStage,
  captureStage,
  screenshotStep,
  triageResult,
  followupResult,
  buildResult,
  resumableTurn,
  recoveredTurn,
  recoverStage,
  recoveredBuild,
  firstVersionTurnOf,
  sideTurnOf,
  recoverFirstVersionTurn,
  ledgerTurnIdOf,
  keptCosts,
  goOnFromKept,
  keepAsItLands,
};
