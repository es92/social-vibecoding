// The clock machine's work: one handler per job for its runs (`clock.<job>`,
// one at a time across every process), and one for its targets when it has
// any (`clock.<job>.item`), and the jobs themselves (JOBS, below): each job's
// I/O is its own module's function, which keeps nothing in the process.

import type { Json, WorkContext, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { itemKind, runKind, MAX_ITEMS } from './machine.ts';
import { bootRelease } from '../release/boot.ts';

// What a job's I/O reads: the platform's configuration and its pool.
export interface JobDeps { config: any; pool: any; previewRetirement?: Json }

export interface Job {
  name: string;
  // How long after a run ends the next is due; 0 runs it again at once.
  everyMs: number;
  leaseMs?: number;
  // Asked for, not scheduled (an admin's fleet job): run only when an admin
  // asked (RunNow: the run's `asked`). A run nobody asked for (an older
  // build arms the job on its interval) does nothing.
  onDemand?: boolean;
  // What it does depends on the build (its keys, its catalogs, its
  // environment): only the newest release's processes run it. An older
  // build's run during a rollout does nothing (`skipped: older_build`), and
  // its targets are claimed only by a process of the build that found them.
  newestOnly?: boolean;
  // One run: what it found is its result (its status, and `items`: the
  // targets owed an effect of their own). `ctx.input.previous` is the last
  // successful run's result.
  run(ctx: WorkContext, deps: JobDeps): Promise<Json | void>;
  item?: {
    run(ctx: WorkContext, deps: JobDeps): Promise<Json | void>;
    concurrency?: number;
    leaseMs?: number;
    maxAttempts?: number;
  };
}

// Whether this process runs the newest build: the build of the workflow
// process that started serving last (`platform_processes`, live). By when it
// started, not by when its release was first seen, so a rollback to an older
// build, or a rollout of the same build with another configuration, is the
// newest once it serves. A platform with no process recorded (a test) has no
// older build.
const LIVE_SECONDS = 45;
async function newestBuild(pool: any): Promise<boolean> {
  const own = String(process.env.GIT_SHA || '').trim().slice(0, 40) || null;
  const { rows: [newest] } = await pool.query(
    `SELECT release FROM platform_processes
      WHERE state = 'serving' AND role <> 'web' AND heartbeat_at > now() - make_interval(secs => $1)
      ORDER BY started_at DESC LIMIT 1`, [LIVE_SECONDS]);
  return !newest || (newest.release ?? null) === own;
}

// A result is stored as instance data: JSON, and nothing a Date or an
// undefined would turn into something else.
const json = (v: unknown): Json => (v === undefined ? null : JSON.parse(JSON.stringify(v)) as Json);

export function clockServices(jobs: readonly Job[], deps: JobDeps): Record<string, WorkHandler> {
  const out: Record<string, WorkHandler> = {};
  for (const job of jobs) {
    out[runKind(job.name)] = {
      // A failed run is not tried again here: the clock runs the job again
      // later (sooner after a failure), with what is current then. A run
      // whose process went away is claimed again once its lease lapses, and
      // runs from the start: every job is safe to run twice.
      maxAttempts: 1,
      resumable: true,
      maxLostAttempts: 3,
      leaseMs: job.leaseMs ?? 120000,
      concurrency: 1,
      async run(ctx) {
        if (job.onDemand && !ctx.input.asked) return { skipped: 'not_asked' };
        if (!job.newestOnly) return json(await job.run(ctx, deps));
        const release = bootRelease();
        if (!await newestBuild(deps.pool)) return { skipped: 'older_build' };
        const result = await job.run(ctx, deps);
        return json(result && typeof result === 'object' && !Array.isArray(result) ? { ...result, release } : result);
      },
    };
    if (job.item) {
      const item = job.item;
      out[itemKind(job.name)] = {
        maxAttempts: item.maxAttempts ?? 3,
        // Its checkpoint is what it has done (a target's effect is made once).
        resumable: true,
        maxLostAttempts: 3,
        backoffMs: (a) => Math.min(10 * 60 * 1000, 60 * 1000 * 2 ** (a - 1)),
        leaseMs: item.leaseMs ?? 120000,
        concurrency: item.concurrency ?? 2,
        ...(job.newestOnly ? { ownRelease: true } : {}),
        async run(ctx) { return json(await item.run(ctx, deps)); },
      };
    }
  }
  return out;
}

// The platform's scheduled jobs, each a clock (machine.ts): its interval and
// its run, which is its own module's function. Every run here is safe to run
// twice: an age DELETE, a delete preconditioned on what it read, or a state
// change written as a compare-and-set with the notice it causes. An effect
// that must happen once per target (a model call, a GitHub write) is a
// target (`item`), never made by the sweep itself.
// workflow-foundation's design-leader-duties.md is the design.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Whether the run has been asked to stop (its lease is lost, or the process
// is shutting down): a sweep over many rows stops at the next one.
// (A run hands back at most MAX_ITEMS targets. A list that can be longer is
// paged: each run takes the next page after the last one it reached, kept
// as `after` in its result, and starts over once a page comes back short.)
const page = (ctx: WorkContext) => ({ after: (ctx.input.previous as any)?.after ?? null, limit: MAX_ITEMS });
// A clock whose every target reads GitHub reads at most GITHUB_READS_PER_HOUR
// of them an hour, whatever the GitHub budget's headers say (a process that
// has made no call yet knows none): its page is that hour's share of its
// interval, and the pages after it cover the rest on the next runs.
export const GITHUB_READS_PER_HOUR = 600;
const githubPage = (ctx: WorkContext, everyMs: number) =>
  ({ ...page(ctx), limit: Math.max(1, Math.min(MAX_ITEMS, Math.ceil(GITHUB_READS_PER_HOUR * everyMs / HOUR))) });
const importedEveryMs = () => Math.max(parseInt(process.env.IMPORTED_HEAD_SYNC_COOLDOWN_MS || '', 10) || 3 * MIN, 30 * 1000);
const stopped = (ctx: WorkContext) => () => ctx.signal.aborted;

// WORKSHOP_THEMES_SWEEP_INTERVAL_MS (config.js workshopSweepIntervalMs): 0
// switches the sweep off.
const workshopEveryMs = () => {
  const v = parseInt(process.env.WORKSHOP_THEMES_SWEEP_INTERVAL_MS || String(HOUR), 10);
  return v > 0 ? v : 0;
};

export const JOBS: readonly Job[] = Object.freeze([
  // ── Retention ───────────────────────────────────────────────────────
  {
    // CLI device codes and sessions past their audit window.
    name: 'cli-auth-cleanup', everyMs: 6 * HOUR,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/cli-auth').cleanupCliAuth(pool),
  },
  {
    // A change's worker nothing has used for WORKER_IDLE_EVICTION_MS and
    // nothing works on, evicted (its volume kept); a running worker with no
    // row counted as used from now; one whose change is gone, destroyed
    // (services/worker-eviction.js). Every process writes when it uses one.
    name: 'worker-eviction', everyMs: 2 * MIN, leaseMs: 5 * MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/worker-eviction').sweep(pool),
  },
  {
    // Model calls no live turn will settle into llm_usage (its record went
    // without settling them, or there was none), after two hours
    // (services/limits.js settleOpenTurnSpend).
    name: 'turn-spend-settle', everyMs: 15 * MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/limits').settleOpenTurnSpend(pool),
  },
  {
    // #892: progress estimates whose run never wrote its outcome (its
    // process went mid-run), resolved once two hours old
    // (services/estimate-backfill.js).
    name: 'estimate-backfill', everyMs: 30 * MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/estimate-backfill').sweep(pool),
  },
  {
    // #907: local agents' leases whose machine stopped heartbeating are
    // released, and a turn still sitting on one failed, so a change stops
    // saying it runs on a laptop in a bag (services/local-agent.js). A
    // lease is a 120 s TTL a 30 s heartbeat refreshes: a minute is well
    // inside it. The turns it fails are finished by the item that
    // dispatched them.
    name: 'local-agent-leases', everyMs: MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/local-agent').sweepExpiredLeases(pool).then((n: number) => ({ released: n })),
  },
  {
    // A coding record no work item holds (the old orphan sweep's and
    // watchdog's case): a `recover` turn asked for it
    // (services/turn-leftovers.js).
    name: 'turn-leftovers', everyMs: MIN, leaseMs: 5 * MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/turn-leftovers').sweep(pool),
  },
  {
    // Turns' streams (stream_events) a finished turn did not clear, and the
    // watchers of a process that went (services/session-bus.js).
    name: 'turn-stream-retention', everyMs: 15 * MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/session-bus').prune(pool),
  },
  {
    // #5132: a person's IP address is kept IP_RETENTION_DAYS (180 days, six
    // months, by default), then cleared from the rows that recorded it; the
    // rows stay.
    name: 'ip-retention', everyMs: 24 * HOUR,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/ip-retention').purgeExpiredIps(pool),
  },
  {
    // Wallet links read off the chain (services/chain-poller.js): a run
    // every 4 seconds, backing off to a minute while the explorer is down,
    // its cursor the last run's result.
    name: 'wallet-links', everyMs: 0,
    run: (ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/chain-poller').poll(config, pool, ctx.input.previous ?? null),
  },
  {
    // The shared limiters' counts past their window
    // (services/rate-limit-store.js).
    name: 'rate-limit-retention', everyMs: HOUR,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/rate-limit-store').prune(pool),
  },
  {
    // An agent session's delegated connector grants, a week after their turn.
    name: 'delegation-prune', everyMs: HOUR,
    run: async (_ctx: WorkContext, { pool }: JobDeps) => ({ pruned: await legacy('services/mcp-oauth').pruneDelegations(pool) }),
  },
  {
    // /debug merge traces past their window.
    name: 'merge-debug-prune', everyMs: 6 * HOUR,
    run: async (_ctx: WorkContext, { pool }: JobDeps) => ({
      pruned: await legacy('services/merge-debug').pruneOldRuns(pool, parseInt(process.env.MERGE_DEBUG_RETENTION_DAYS || '30', 10)),
    }),
  },
  {
    // Uploads nothing took, staging app files, closed moderation records.
    name: 'upload-gc', everyMs: HOUR,
    run: (_ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/upload-retention').sweep(pool, config),
  },
  {
    // The per-route request and server-error counts past their 14 days (the
    // Server errors figure and the server_errors signal read them), the
    // route costs past their 7, and each process's health past its 14.
    name: 'server-error-prune', everyMs: 24 * HOUR,
    run: async (_ctx: WorkContext, { pool }: JobDeps) => {
      const n = await legacy('services/server-error-counts').prune(pool);
      if (n && (n.requests || n.errors || n.routes)) legacy('services/logger').info('server-errors', 'Pruned old server error counts', n);
      const h = await legacy('services/process-health').prune(pool);
      if (h && h.processes) legacy('services/logger').info('process-health', 'Pruned old process health', h);
      return n && h ? { ...n, ...h } : n || h;
    },
  },
  {
    // Before & after shots: media and audit windows, and runtimes no run owns.
    name: 'shots-gc', everyMs: 6 * HOUR, leaseMs: 5 * MIN,
    run: (_ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/shots-gc').sweep(config, pool),
  },
  {
    // Processes that stopped beating (services/processes.js).
    name: 'process-reap', everyMs: 5 * MIN,
    run: async (_ctx: WorkContext, { pool }: JobDeps) => ({ reaped: await legacy('services/processes').reap(pool) }),
  },
  {
    // Successful kpack Builds past their window that nothing references, and
    // failed ones a restart left behind.
    name: 'build-retention', everyMs: HOUR, leaseMs: 5 * MIN,
    run: async (ctx: WorkContext, { pool, config }: JobDeps) => {
      // The failed Builds first; a failure there is reported, and the sweep
      // still runs.
      const failed = await legacy('services/application-runtime').cleanupFailedBuilds(config)
        .catch((err: Error) => ({ error: err.message }));
      const r = await legacy('services/build-retention').sweep(config, { dryRun: false, pool, shouldStop: stopped(ctx) });
      if (r.deleted.length) legacy('services/logger').info('build-retention', 'kpack retention sweep', { examined: r.examined, deleted: r.deleted });
      return { failedDeleted: failed?.deleted ?? 0, failedError: failed?.error ?? null, examined: r.examined, deleted: r.deleted.length, busy: !!r.busy };
    },
  },
  {
    // Check input Secrets and finished check Pods whose Job is gone.
    name: 'check-retention', everyMs: 15 * MIN, leaseMs: 5 * MIN,
    run: async (ctx: WorkContext, { config }: JobDeps) => {
      const r = await legacy('services/check-retention').sweep(config, { shouldStop: stopped(ctx) });
      return { examined: r.examined, eligible: r.eligible, deleted: r.deleted.length };
    },
  },
  {
    // Account deletions' provider and worker cleanups (each task its own
    // SKIP LOCKED row lease, its finish fenced on its attempt).
    name: 'account-deletion', everyMs: MIN,
    run: async (_ctx: WorkContext, { pool, config }: JobDeps) => {
      await legacy('services/account-deletion-cleanup').sweep(pool, config);
      return null;
    },
  },

  // ── Phone pushes ────────────────────────────────────────────────────
  {
    // The sender: a run drains the queue for a few minutes, then the clock
    // runs it again at once. One at a time across every process; each row
    // it claims carries this run's attempt, so a run beside another (a
    // release, a stall) never sends one push twice.
    name: 'push-drain', everyMs: 0, leaseMs: MIN,
    run: async (ctx: WorkContext) => {
      const r = await legacy('services/mobile-push').drain({
        token: { workId: ctx.workId, attempt: ctx.attempt }, forMs: 4 * MIN, signal: ctx.signal,
      });
      // Push off here: the clock waits a few minutes rather than spin.
      return r?.off ? { ...r, restMs: 4 * MIN } : r;
    },
  },
  {
    // The sender's tables past their windows.
    name: 'push-retention', everyMs: 6 * HOUR,
    run: () => legacy('services/mobile-push').retention(),
  },

  // ── Probes and reports ──────────────────────────────────────────────
  {
    // Whether each public app's shell opens without signing in. The first
    // run of a new build re-probes every app that read public.
    name: 'shell-probe', everyMs: 5 * MIN,
    run: async (ctx: WorkContext, { config }: JobDeps) => {
      const build = String(process.env.GIT_SHA || 'dev');
      const r = await legacy('services/shell-probe').sweep(config, {
        refreshPublic: (ctx.input.previous as any)?.build !== build, shouldStop: stopped(ctx),
      });
      return { ...r, build };
    },
  },
  {
    // Each imported app's repository still public (a worker clones without
    // credentials), logged for the operator; one GitHub read per app.
    name: 'repo-privacy-audit', everyMs: 24 * HOUR, leaseMs: 5 * MIN,
    run: (ctx: WorkContext, { pool }: JobDeps) => legacy('services/repo-privacy-audit').audit(pool, { shouldStop: stopped(ctx) }),
  },
  {
    // #5634: the compliance report's scan, every
    // COMPLIANCE_SCAN_INTERVAL_DAYS (a week by default), and an admin's
    // Scan now: each check's result kept as one more scan, one GitHub read
    // per project for the LICENSE check.
    name: 'compliance-scan',
    get everyMs() { return legacy('services/compliance').scanIntervalDays() * 24 * HOUR; },
    leaseMs: 10 * MIN,
    run: (ctx: WorkContext, { pool }: JobDeps) => legacy('services/compliance').runScan(pool, { shouldStop: stopped(ctx) }),
  },
  {
    // Custom domains: DNS for a claim, the certificate, the live host's
    // health. Each step a compare-and-set on the status it read.
    name: 'app-domains', everyMs: MIN,
    run: (ctx: WorkContext, { config }: JobDeps) => legacy('services/app-domains').sweep(config, { shouldStop: stopped(ctx) }),
  },
  {
    // Every app's database against its storage cap (its admins warned, the
    // database frozen read-only at the top). Also run by an admin's
    // "Measure now" (routes/admin.js).
    name: 'app-storage-cap',
    get everyMs() { return legacy('services/app-storage-cap').config().sweepIntervalMs; },
    leaseMs: 5 * MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/app-storage-cap').sweep(pool),
  },
  {
    // The server-wide caps and GitHub's hourly budget, told to the full
    // admins once a level is crossed (each level a row-locked compare).
    name: 'platform-limits', everyMs: 5 * MIN,
    run: (_ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/platform-limit-alerts').sweep(pool, config),
  },
  {
    // Problems the platform finds in itself, each filed as one request,
    // updated, and closed once it stops (shadow mode: rows only). Its own
    // session advisory lock keeps two passes from filing one problem twice.
    name: 'platform-signals', everyMs: 5 * MIN,
    run: (_ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/platform-signals').sweep(pool, config),
  },
  {
    // The unexpected-events digest and the hourly pile-up alert.
    name: 'incident-alerts', everyMs: 5 * MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/platform-incident-alerts').sweep(pool),
  },

  // ── What people are told ────────────────────────────────────────────
  {
    // The once-a-day "what needs your vote" digest.
    name: 'vote-digest', everyMs: HOUR,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/vote-digest').sweep(pool),
  },
  {
    // The Friday "this week on <app>" card.
    name: 'weekly-digest', everyMs: HOUR,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/weekly-digest').sweep(pool),
  },
  {
    // A person let in gets the welcome group an admin set up.
    name: 'welcome-dm', everyMs: 30 * 1000,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/welcome-dm').sweep(pool),
  },
  {
    // The email a notice owes when no phone could take its push (an invite
    // moment, a project opening): each notice that owes one
    // (its `mailed_at` NULL, written with it) a target, sent once and marked
    // (services/activity-mail.js).
    name: 'notice-mail', everyMs: MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/activity-mail').noticeMailTargets(pool, { limit: MAX_ITEMS }),
    item: {
      concurrency: 2,
      maxAttempts: 5,
      run: (ctx: WorkContext, { pool }: JobDeps) => legacy('services/activity-mail').mailNotice(pool, Number(ctx.input.input?.notificationId), ctx.steps()),
    },
  },
  {
    // "Your agent is waiting on you", once its delay has passed.
    name: 'connector-input-waits', everyMs: MIN,
    run: async (_ctx: WorkContext, { pool }: JobDeps) => ({ sent: await legacy('services/connector-input-waits').sweepDue(pool) }),
  },
  {
    // Season challenges scored from the points ledger: a beat a minute runs
    // the rules that are due. Its own advisory lock (the one the scoring at
    // people's doors plans its counted measures under) keeps two passes from
    // paying one unit twice or grading one entry twice.
    name: 'challenge-scorer', everyMs: MIN,
    run: async (ctx: WorkContext, { pool, config }: JobDeps) => {
      const scorer = legacy('services/topochain/challenge-scorer');
      if (!(scorer.intervalMinutes(config) > 0)) return { off: true };
      const r = await scorer.tick(pool, config, { lastAggregateCheckAt: (ctx.input.previous as any)?.aggregateCheckedAt ?? 0 });
      if (r?.credits) legacy('services/logger').info('challenge-scorer', 'Credits written', { credits: r.credits, graded: r.graded });
      // The run's whole summary is its challenge_scoring_runs row.
      return { runId: r?.runId ?? null, credits: r?.credits ?? 0, graded: r?.graded ?? 0, idle: !!r?.idle, busy: !!r?.busy,
        aggregateCheckedAt: r?.aggregateCheckedAt ?? (ctx.input.previous as any)?.aggregateCheckedAt ?? 0 };
    },
  },

  // ── Production apps: what their runtimes and repositories say ────────
  // (What follows from it is app delivery's: app-delivery/.)
  {
    // Every running app's runtime: one not running is reported Unhealthy,
    // keyed by the run; app delivery decides whether to heal it.
    // APP_HEAL_INTERVAL_MS=0 switches it off.
    name: 'app-health',
    get everyMs() { return legacy('services/app-heal').intervalMs(null) || 24 * HOUR; },
    leaseMs: 5 * MIN,
    run: (ctx: WorkContext, { pool, config }: JobDeps) => {
      const heal = legacy('services/app-heal');
      return heal.intervalMs(config) ? heal.scan(config, pool, { n: ctx.input.n, shouldStop: stopped(ctx) }) : { off: true };
    },
  },
  {
    // Every running app's main on GitHub: a commit production does not run
    // is reported MainMoved, keyed by the commit; app delivery decides
    // whether to deploy it. MAIN_DRIFT_POLL_MS sets how often.
    name: 'main-drift',
    get everyMs() { return legacy('services/main-drift-poller').intervalMs(); },
    leaseMs: 10 * MIN,
    run: (ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/main-drift-poller').scan(config, pool, { shouldStop: stopped(ctx) }),
  },

  // ── The App bench ──────────────────────────────────────────────────
  {
    // What its trials leave behind (services/bench/lane.js sweep): kept
    // `bench/` branches past their time (within GitHub's background budget),
    // side builds' results a trial that never ran left waiting, and the
    // studio's previews past their day. Which trials run is the bench-lane
    // machine's (src/workflow/bench-lane/).
    name: 'bench-sweep', everyMs: 10 * MIN,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/bench/lane').sweep(pool),
  },

  // ── The build's own: what only the newest build may do ──────────────
  {
    // Ready-made apps' images, built ahead under this build's keys
    // (services/starter-images.js): each key owed a build a target of its
    // own, one build of it at a time.
    name: 'starter-images', everyMs: MIN, newestOnly: true,
    run: (_ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/starter-images').targets(config, pool),
    item: {
      concurrency: 3,
      maxAttempts: 1,
      leaseMs: 5 * MIN,
      run: (ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/starter-images').buildTarget(config, pool, ctx.input.input),
    },
  },
  {
    // The app-host gate follows APP_GATE, in both directions: on brings it up
    // and routes every app through it, off routes them all straight back
    // (services/kubernetes.js reconcileAppGateIngresses). The newest build's
    // setting (a change of APP_GATE alone, a rollback): an older build still
    // running during a rollout never routes the fleet back by its own. On
    // Kubernetes, where the platform runs its cluster's maintenance.
    name: 'app-gate', everyMs: 10 * MIN, newestOnly: true, leaseMs: 5 * MIN,
    run: (_ctx: WorkContext, { config }: JobDeps) => (legacy('services/application-runtime').mode(config) === 'kubernetes'
      ? legacy('services/kubernetes').reconcileAppGateIngresses(config)
      : { off: true }),
  },
  {
    // The translation of this build's new interface text
    // (services/language-sync-runner.js): a catalog not yet translated, or a
    // batch to collect, is a target, one pass at a time. Paid: a batch is
    // submitted once per catalog. LANGUAGE_SYNC_ENABLED=false switches it
    // off.
    name: 'language-sync', everyMs: 10 * MIN, newestOnly: true,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/language-sync-runner').look({ pool }),
    item: {
      concurrency: 1,
      leaseMs: 10 * MIN,
      run: async (ctx: WorkContext, { pool, config }: JobDeps) => {
        const out = await legacy('services/language-sync-runner').runOnce({ config, pool, deps: { steps: ctx.steps() } });
        if (!out?.skipped) legacy('services/logger').info('language-sync', 'Translation pass', out);
        return out;
      },
    },
  },

  // ── Previews: outside facts about the runtimes and the servers ───────
  // (What the preview machine decides about a preview it holds, its idle
  // give-back and the checks it owes, is its own deadline: preview/.)
  // ── The workflow's own ──────────────────────────────────────────────
  {
    // Events an older build refused as unknown during a rollout, asked
    // again once no older build serves (platform.ts reaskRefused).
    name: 'reask-refused', everyMs: MIN, newestOnly: true,
    run: async (_ctx: WorkContext, { pool }: JobDeps) => (await import('../platform.ts')).reaskRefused(pool),
  },
  // ── An admin's fleet jobs ───────────────────────────────────────────
  // Run when an admin asks (Admin › Rollover, Admin › Staging), one at a
  // time across every process; each unit (an app, a preview) is a step of
  // the run, so a restart carries the job on (services/fleet-job.js).
  {
    // Every running app's container recreated with a freshly assembled
    // environment.
    name: 'container-rollover', everyMs: 0, onDemand: true, leaseMs: 10 * MIN,
    run: (ctx: WorkContext, { config, pool }: JobDeps) => legacy('services/app-rollover').runJob(ctx, { config, pool }),
  },
  {
    // Every out-of-date or abandoned preview torn down at once.
    name: 'preview-reap', everyMs: 0, onDemand: true, leaseMs: 10 * MIN,
    run: (ctx: WorkContext, { config, pool }: JobDeps) => legacy('services/staging-reap').runJob(ctx, { config, pool }),
  },
  {
    // A vote-backed preview whose runtime or database is gone is reported
    // lost; the preview machine builds it again.
    name: 'preview-runtimes', everyMs: 2 * MIN, leaseMs: 10 * MIN,
    run: (ctx: WorkContext, { config }: JobDeps) => legacy('services/staging-recovery').lookForLostPreviews(config, { signal: ctx.signal }),
  },
  {
    // Previews that serve nobody (their session merged, was archived or is
    // gone, or their row no longer names them and no instance holds them),
    // each taken as a target of its own: retired through the machine, or
    // removed by name. STAGING_STALE_SWEEP_INTERVAL_MS=0 switches it off.
    name: 'preview-gc',
    get everyMs() { return legacy('services/staging-reap').staleSweepIntervalMs() || 24 * HOUR; },
    run: (ctx: WorkContext, { config }: JobDeps) => {
      const reap = legacy('services/staging-reap');
      return reap.staleSweepIntervalMs() ? reap.leftovers(config, page(ctx)) : { off: true };
    },
    item: {
      concurrency: 3,
      // A teardown that left the preview running fails the item: it is
      // tried again, and its error is the item's.
      run: async (ctx: WorkContext, { config }: JobDeps) => {
        const r = await legacy('services/staging-reap').reapLeftover(ctx.input.input, config);
        if (r?.outcome === 'failed') throw new Error(r.error || 'the preview survived its teardown');
        return r;
      },
    },
  },
  {
    // Previews built with another platform environment than the newest
    // build's, handed to the preview machine. Only the newest build acts: an
    // older Pod still running during a rollout would judge the new build's
    // previews by its own environment, so its run looks at nothing.
    name: 'preview-env', everyMs: 15 * MIN, leaseMs: 10 * MIN, newestOnly: true,
    run: (_ctx: WorkContext, { config }: JobDeps) => legacy('services/staging-reap').tellStaleEnv(config),
  },
  {
    name: 'preview-data-policy', everyMs: MIN, leaseMs: 10 * MIN, newestOnly: true,
    run: (_ctx: WorkContext, { config, pool, previewRetirement }: JobDeps) => legacy('services/platform-preview-startup').check(config, pool, previewRetirement),
  },
  {
    // Staging databases nothing can reach any more (no session, build or
    // connection). STAGING_ORPHAN_DB_SWEEP_INTERVAL_MS=0 switches it off.
    name: 'preview-orphan-dbs',
    get everyMs() { return legacy('services/staging-reap').orphanDbSweepIntervalMs() || 24 * HOUR; },
    leaseMs: 30 * MIN,
    run: (_ctx: WorkContext, { config }: JobDeps) => {
      const reap = legacy('services/staging-reap');
      return reap.orphanDbSweepIntervalMs() ? reap.sweepOrphanDbs(config) : { off: true };
    },
  },
  {
    // A deleted app's database, staging template or files its teardown could
    // not remove, retried from the receipt it left (#5121). Never throws; a
    // no-op in a preview.
    name: 'app-data-purges', everyMs: 6 * HOUR, leaseMs: 30 * MIN,
    run: (_ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/app-data-retention').retryPendingPurges(pool, config),
  },
  {
    // The shared Postgres (and the preview database server) near its
    // connection limit: one preview given back at a time, none while the
    // last one asked for is still being retired, looked at again a minute
    // later while saturated. And, while a preview server is drained, what
    // still depends on it, every ten minutes.
    // STAGING_PRESSURE_SWEEP_INTERVAL_MS=0 switches the reclaim off.
    name: 'preview-pressure', everyMs: 0,
    run: async (ctx: WorkContext, { config }: JobDeps) => {
      const reap = legacy('services/staging-reap');
      const every = reap.pressureSweepIntervalMs();
      const previous = (ctx.input.previous ?? {}) as any;
      const drain = await reap.previewServerDrainStatus(config, { lastAt: previous.drainAt ?? 0 });
      const drainAt = drain?.at ?? previous.drainAt ?? 0;
      if (!every) return { off: true, drainAt, restMs: 5 * MIN };
      const main = await reap.sweepConnectionPressure(config, { asked: previous.main?.asked ?? [] });
      const preview = await reap.sweepConnectionPressure(config, { server: 'preview', asked: previous.preview?.asked ?? [] });
      const pressed = main.saturated || preview.saturated || main.waiting || preview.waiting;
      return { main, preview, drainAt, restMs: pressed ? MIN : Math.min(every, 5 * MIN) };
    },
  },
  {
    // A merged change's Kubernetes worker volume that outlived its merge.
    name: 'worker-volumes', everyMs: HOUR,
    run: async (_ctx: WorkContext, { pool, config }: JobDeps) => (config.archivedRetentionMs > 0
      ? { reclaimed: (await legacy('services/worker-volume-reclaim').reclaimWorkerVolumes({ pool, mode: 'closed', limit: 50 })).length }
      : { off: true }),
  },

  // ── Proposals: what GitHub and the mirrors say about them ────────────
  // (What follows from it is the proposal machine's: proposal/, and
  // services/proposal-scans.js says which event each look sends.)
  {
    // Each imported pull request: its head, its description, and whether
    // GitHub merged or closed it. IMPORTED_HEAD_SYNC_COOLDOWN_MS sets how
    // often (at least 30 seconds).
    name: 'imported-prs',
    get everyMs() { return importedEveryMs(); },
    run: (ctx: WorkContext, { pool }: JobDeps) => legacy('services/proposal-scans').importedTargets(pool, githubPage(ctx, importedEveryMs())),
    item: {
      concurrency: 2,
      leaseMs: 10 * MIN,
      run: (ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/proposal-scans').lookImported(config, pool, Number(ctx.input.input?.sessionId)),
    },
  },
  {
    // Each native proposal up for a vote: one merged by hand on GitHub is
    // recorded.
    name: 'merged-by-hand', everyMs: 6 * HOUR,
    run: (ctx: WorkContext, { pool }: JobDeps) => legacy('services/proposal-scans').mergedByHandTargets(pool, githubPage(ctx, 6 * HOUR)),
    item: {
      concurrency: 4,
      run: (ctx: WorkContext, { pool }: JobDeps) => legacy('services/proposal-scans').lookMergedByHand(pool, Number(ctx.input.input?.sessionId)),
    },
  },
  {
    // Each native proposal in review: its reviewed head read again (a push
    // made outside Homeroom), and its explicit-approval flag.
    name: 'proposal-revisions', everyMs: HOUR,
    run: (ctx: WorkContext, { pool }: JobDeps) => legacy('services/proposal-scans').revisionTargets(pool, githubPage(ctx, HOUR)),
    item: {
      concurrency: 2,
      leaseMs: 5 * MIN,
      run: (ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/proposal-scans').refreshRevision(config, pool, Number(ctx.input.input?.sessionId)),
    },
  },
  {
    // Every proposal in review measured against its app's main.
    name: 'proposal-measure', everyMs: MIN, leaseMs: 15 * MIN,
    run: (ctx: WorkContext, { pool }: JobDeps) => legacy('services/proposal-scans').measurePromoted(pool, { shouldStop: stopped(ctx) }),
  },
  {
    // A proposal failing only checks main has since fixed is brought up to
    // date with main (services/fixed-check-sync.js).
    name: 'fixed-check-sync', everyMs: 5 * MIN, leaseMs: 10 * MIN,
    run: (ctx: WorkContext, { pool, config }: JobDeps) => legacy('services/proposal-scans').fixedCheckSync(config, pool, {
      previous: ctx.input.previous ?? null, shouldStop: stopped(ctx),
    }),
  },

  // ── Paid per target: each target an item of its own ─────────────────
  {
    // PR and feedback-issue titles filed with a fallback while the model
    // was unavailable, generated again: each title a target, so it is
    // generated and billed once however many runs find it.
    name: 'title-heal',
    get everyMs() { return Math.max(parseInt(process.env.TITLE_HEAL_SWEEP_MS || '', 10) || 10 * MIN, MIN); },
    run: (_ctx: WorkContext, { config }: JobDeps) => legacy('services/title-heal').targets(config),
    item: {
      concurrency: 2,
      run: (ctx: WorkContext, { config }: JobDeps) => legacy('services/title-heal').healTarget(config, ctx.input.input),
    },
  },
  {
    // The Workshop passes a board change or a page view owed (each app's
    // reconcile_due_at, services/workshop-themes.js), once the board has
    // been quiet since its first change: each app a target of its own.
    name: 'workshop-changes', everyMs: 10 * 1000,
    run: (_ctx: WorkContext, { pool }: JobDeps) => legacy('services/workshop-themes').changeTargets({ pool, limit: MAX_ITEMS }),
    item: {
      concurrency: 2,
      leaseMs: 5 * MIN,
      run: (ctx: WorkContext, { pool }: JobDeps) => legacy('services/workshop-themes').changeApp({
        pool, appId: Number(ctx.input.input?.appId), due: String(ctx.input.input?.due),
      }),
    },
  },
  {
    // The Workshop's themes: every app opened in the last week re-checked,
    // re-drafted once a day when anything changed. Each app a target.
    name: 'workshop-themes',
    get everyMs() { return workshopEveryMs() || 24 * HOUR; },
    run: async (_ctx: WorkContext, { pool }: JobDeps) => (workshopEveryMs()
      ? legacy('services/workshop-themes').sweepTargets({ pool })
      : { disabled: true }),
    item: {
      concurrency: 2,
      leaseMs: 5 * MIN,
      run: (ctx: WorkContext, { pool }: JobDeps) => legacy('services/workshop-themes').sweepApp({ pool, appId: Number(ctx.input.input?.appId) }),
    },
  },
] as Job[]);

export const JOB_NAMES: ReadonlySet<string> = new Set(JOBS.map((j) => j.name));

