// The preview machine's I/O: durable work items, each reported back as an
// event. What they call outside src/workflow/ is of two sorts, each named
// in the boundary list (tests/baselines/workflow-process-state.json):
//
//   I/O cores    the build, the database clone and the deploy
//                (staging.prepareAttempt: buildAndDeployStagingInner without
//                the per-process queue or the coordinator), the checks run
//                (visuals.captureForSession in its workflow mode, without
//                its in-process seat), the Jobs and the runtime by identity;
//   hand-offs    to flows later steps migrate: the merge queue and the
//                Homeroom bot's notes.
//
// The handlers keep no state of their own in process memory: what one needs
// is in its input, in Postgres, or on the cluster. The hand-offs call into
// flows that still do (the merge queue, the bot, a sync with main); they go
// with the steps that migrate those. What browsers hear about a decision is
// the transitions' (src/workflow/pushes.ts); the build and the run still
// stream their own progress (checks_progress and its events) as they go.

import { createHash } from 'node:crypto';
import type { Json, Pool, WorkContext, WorkHandler } from '../kernel/index.ts';
import { LeaseLost } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { PREPARE_CLAIMS, WORK } from './machine.ts';
import { parseRepoAddress } from '../rules/github-url.ts';

interface Deps { config: any; pool: Pool }

// How long a prepare or a checks run holds its lease between renewals. A
// cancelled one learns it at its next checkpoint or renewal; the machine
// waits longer than a lease before it retires a cancelled attempt or runs a
// retirement, and nothing is dropped while it still serves (below).
export const PREPARE_LEASE_MS = 60000;
// Retries after a lost lease, never after a failure: a build that fails is
// the error lane's, as on [main]. One database per claim (machine.ts).
const PREPARE_ATTEMPTS = PREPARE_CLAIMS;
// A lost checks run is collected from the cluster by its retry; a second
// loss reruns it once more.
const RUN_ATTEMPTS = 3;
// The per-process limits [main] has for builds and check runs.
const CONCURRENCY = 10;

const repoOf = (url: unknown) => parseRepoAddress(url);
const cancelled = (ctx: WorkContext, err: unknown) => ctx.signal.aborted || err instanceof LeaseLost;

// A UUID derived from `text` (version 4's layout, as check_runs' key and the
// Jobs' run-id label take it).
function uuidOf(text: string): string {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The id one claim of a checks run gives its Jobs and its check_runs row:
// one per claim, so a claim that runs again never meets the Jobs of the one
// before under the same names. The run itself is known by the work item's
// key (`runKey`), which its manifest carries and its media are held under.
export function claimRunId(sessionId: number, runKey: string, claim: number): string {
  return uuidOf(`preview-run:${sessionId}:${runKey}:${claim}`);
}

// The run id of attempt n's early unit suite: known from the attempt alone to
// the launcher, the checks run that reads it and the retirements that remove
// it, so none of them has to be told.
export function unitEarlyRunId(sessionId: number, n: number): string {
  return uuidOf(`preview-unit-early:${sessionId}:${n}`);
}

export function previewServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const staging = () => legacy('services/staging');
  const visuals = () => legacy('services/visuals');
  const kubernetes = () => legacy('services/kubernetes');
  const dbManager = () => legacy('services/db-manager');
  const runtimeMode = () => legacy('services/application-runtime').mode(config);
  const session = async (id: number) => (await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`, [id])).rows[0] || null;
  const app = async (id: number) => (await pool.query('SELECT * FROM apps WHERE id = $1', [id])).rows[0] || null;
  // The machine cancelled this work item (the kernel's `cancel`), as opposed
  // to its claim having expired; an error reading it is not a cancel.
  const cancelledByMachine = async (workId: string) => (await pool.query(
    `SELECT COALESCE((result->>'cancelled')::boolean, FALSE) AS cancelled FROM wf_work WHERE id = $1`, [workId])
    .catch(() => ({ rows: [] }))).rows[0]?.cancelled === true;
  // The session's runtime on Kubernetes: one name per session, every attempt.
  const runtimeName = (appId: number, sessionId: number) =>
    kubernetes().appResourceName({ id: appId }, 'staging', sessionId);
  // Whether attempt n still serves the session's preview: its env Secret in
  // the live pod template (Kubernetes), its number on the container (Docker).
  const serves = async (input: { sessionId: number; appId: number; appSlug?: string; n: number }) => {
    if (runtimeMode() === 'kubernetes') {
      return kubernetes().previewServesAttempt(config, runtimeName(input.appId, input.sessionId), input.n);
    }
    if (!input.appSlug) return false;
    const c = await legacy('services/docker').inspectContainer(`usernode-staging-${input.appSlug}--${input.sessionId}`).catch(() => null);
    // Any claim of attempt n (kubernetes.js attemptFence: `n.k`).
    const fence = kubernetes().attemptFence(c?.labels?.[kubernetes().PREVIEW_ATTEMPT_ANNOTATION]);
    return fence?.attempt === input.n;
  };
  // An attempt's early unit suite, running or finished: its Jobs go.
  const dropUnitEarly = async (sessionId: number, n: number) => {
    if (config.workerRuntime !== 'kubernetes') return;
    await kubernetes().deleteRunCheckJobs(config, { sessionId, previewRunId: unitEarlyRunId(sessionId, n) });
  };
  // Every claim of a run (its check_runs rows, by the run's key): their Jobs
  // cancelled, finished or not, and their rows gone.
  const clearRun = async (sessionId: number, runKey: string) => {
    const { rows } = await pool.query(
      `SELECT run_id FROM check_runs WHERE session_id = $1 AND manifest->>'runKey' = $2`, [sessionId, runKey]);
    for (const r of rows) {
      if (config.captureRuntime === 'kubernetes') {
        await kubernetes().cancelPreviewChecks(config, sessionId, r.run_id);
        await kubernetes().deleteRunCheckJobs(config, { sessionId, previewRunId: r.run_id });
      }
      await legacy('services/check-runs').finish(pool, r.run_id);
    }
  };
  // An attempt the machine cancelled after it had written the session's
  // Deployment gives it back to the attempt that serves; its database goes
  // only once it serves nothing.
  const undo = async (input: any) => {
    if (runtimeMode() === 'kubernetes') {
      await kubernetes().restorePreviewAttempt(config, runtimeName(input.appId, input.sessionId), input.n,
        input.serving?.n ?? null, input.claim ?? 0).catch(() => null);
    }
    if (!await serves(input).catch(() => true)) await dbManager().dropDatabase(input.db).catch(() => {});
  };

  return {
    [WORK.wake]: {
      maxAttempts: 2, leaseMs: 60000, concurrency: 2,
      async run({ input }): Promise<Json> {
        return legacy('services/preview-sleep').wake(config, pool, Number(input.sessionId), {
          reason: String(input.reason), repairRoute: input.repairRoute === true,
        });
      },
    },
    // Build attempt n of the head into its own checkout, database and env
    // Secret, then update the session's runtime to it (fenced by attempt,
    // the serving template restored on a failed rollout). A build or boot
    // failure is a result; only a lost lease is retried here.
    [WORK.prepare]: {
      maxAttempts: PREPARE_ATTEMPTS,
      leaseMs: PREPARE_LEASE_MS,
      concurrency: CONCURRENCY,
      // Built by the newest build only. A preview carries the build that
      // made it: a platform preview its data policy, which a newer build
      // retires in every one an older build made, and any preview its
      // environment, which the preview-env clock judges by the newest
      // build's. On 28 Oct 2026 the old conductors started the platform
      // previews of two changes after a new release's conductor had
      // started, and each was retired within a minute.
      newestOnly: true,
      async run(ctx): Promise<Json> {
        const { input } = ctx;
        const [row, a] = await Promise.all([session(input.sessionId), app(input.appId)]);
        if (!row || !a) return { ok: false, detail: 'The proposal or its app no longer exists' };
        // Each claim clones into its own database: one before it may have
        // deployed, and its pods still use that one.
        const db: string = (Array.isArray(input.dbs) && input.dbs[ctx.attempt - 1]) || input.db;
        // The claim fences what it writes: a claim that lost its lease and
        // runs on never touches what a later claim of the attempt deployed.
        const attempt = { n: input.n, claim: ctx.attempt, dbName: db, servingN: input.serving?.n ?? null,
          checkpoint: (v: Json) => ctx.checkpoint(v) };
        try {
          const built = await staging().prepareAttempt(config, row, a, input.head, attempt);
          // Deployed: still this machine's attempt? A cancel that came during
          // the rollout is seen here, and the deploy undone.
          await ctx.checkpoint({ step: 'deployed', db });
          await staging().verifyStagingEdge(row, built.hostname, built.stagingUrl).catch(() => null);
          return {
            ok: true, db, url: built.stagingUrl, runtimeKind: built.runtimeKind, runtimeName: built.runtimeName,
            containerId: built.containerId ?? null, imageRef: built.imageRef ?? null, buildRef: built.buildRef ?? null,
          };
        } catch (err) {
          if (cancelled(ctx, err) || (err as { code?: string }).code === 'attempt_superseded') {
            // Only a cancelled attempt undoes what it created after the
            // cancel (the machine's retirement covers everything before). A
            // lost lease authorizes nothing: a retry of this same attempt
            // may be using the database right now.
            if (await cancelledByMachine(ctx.workId)) await undo({ ...input, db, appSlug: a.slug, claim: ctx.attempt });
            throw err;
          }
          // A failure seen by a claim that is no longer the live one (its
          // lease ran out, or the machine cancelled it) reports nothing and
          // sets nothing off: checkpoint throws for it.
          await ctx.checkpoint({ step: 'failed', db });
          // #6149: a database or runtime stamped by another build of the
          // platform is the release window, not the change's fault, while a
          // newer build is serving: retry it as a platform fault, and say so
          // in words. With no newer build it stays the immediate refusal it
          // is (an unreviewed change, or this build is the newest).
          const refusal = err as { previewDatabaseServerFault?: boolean; policySkew?: boolean };
          const policy = legacy('services/platform-preview-data-policy');
          const rollout = refusal.policySkew === true && await policy.newerBuildServing(pool);
          if (rollout) policy.markRollout(err);
          const detail = rollout ? policy.ROLLOUT_DETAIL : visuals().summarizeBootFailure(err);
          const infrastructure = rollout || !!legacy('services/deploy-failure').bootFailureIsInfrastructure(err);
          // #6536: a failed build's own first error, for the check row and
          // the fix turn. A rollout or an infrastructure failure is not the
          // change's build and says nothing to fix.
          const buildError = infrastructure ? null : (legacy('services/deploy-failure').firstBuildError(err) || null);
          const sync = legacy('services/boot-failure-sync');
          const catchUp = infrastructure ? null
            : await sync.afterBootFailure({ config, pool, session: row, commitHash: input.head, err }).catch(() => null);
          return {
            ok: false, detail, infrastructure, aboutMain: sync.explain(catchUp) || null, sync: !!catchUp?.sync,
            buildError,
            platformFault: rollout || refusal.previewDatabaseServerFault === true,
            servingRemoved: !!(err as { servingRemoved?: boolean }).servingRemoved,
          };
        }
      },
    },

    // The repo's unit suite for attempt n, started with its build instead of
    // after it: on the platform's own app the build, the boot and the wait
    // for a checks slot came to about 70s in front of a 168s suite. Its Jobs
    // carry the attempt's early run id; the checks run against the attempt
    // reads them (unit-suite.collectUnitSuite), or runs its own suite when
    // there is nothing to read. The item only launches the Jobs and follows
    // them to their end; their outcome is the checks run's to read. Started
    // only while fewer unit suites run than the checks queue lets runs go at
    // once, so a burst of builds cannot fill the worker namespace's quota
    // ahead of the runs the queue admits. EARLY_UNIT_SUITE=0 turns it off.
    // A required batch pool admits whole runs, not speculative early suites:
    // those would bypass its shared budget. Their suite runs after the build,
    // inside the admitted checks run instead.
    [WORK.unitEarly]: {
      // Its Jobs outlive a lost claim, and a retry finds them.
      maxAttempts: 2,
      leaseMs: PREPARE_LEASE_MS,
      concurrency: CONCURRENCY,
      async run({ input, signal }): Promise<Json> {
        const off = ['0', 'false', 'off'].includes(String(process.env.EARLY_UNIT_SUITE ?? '1').trim().toLowerCase());
        const unitSuite = legacy('services/unit-suite');
        if (off || config.kubernetes?.checkNodePoolRequired || config.workerRuntime !== 'kubernetes'
          || !unitSuite.isEnabled()) return { started: false, why: 'off' };
        // Only while its attempt is still being built: once it serves, its
        // checks run is under way and runs a suite of its own if it finds
        // none; once it is superseded or failed, nothing will read one.
        const { rows: [live] } = await pool.query(
          `SELECT 1 FROM wf_instances WHERE machine = 'preview' AND key = $1 AND (data->'preparing'->>'n')::int = $2`,
          [`session:${input.sessionId}`, Number(input.n)]);
        if (!live) return { started: false, why: 'not_preparing' };
        const runId = unitEarlyRunId(input.sessionId, input.n);
        const k = kubernetes();
        const jobs = await k.findCheckJobs(config, { sessionId: input.sessionId, previewRunId: runId });
        if (jobs.unitSuites?.length || jobs.unitSuite) return { started: true, runId, joined: true };
        const cap = legacy('services/checks-queue').maxConcurrentRuns();
        const running = await k.countRunningUnitSuiteJobs(config);
        if (running === null || (cap > 0 && running >= cap)) return { started: false, why: 'busy', running, cap };
        const [row, a] = await Promise.all([session(input.sessionId), app(input.appId)]);
        const repo = repoOf(a?.repo_url);
        if (!row || !repo) return { started: false, why: 'gone' };
        // Not for a head whose suite already passed under the same
        // conditions, when nobody asked for a fresh run: the checks run
        // copies that pass instead (services/unit-suite-reuse.js), and these
        // Jobs would be thrown away. Asked with the trigger of the run this
        // build is for; the lookup reads the proposal's own request.
        const reusable = await unitSuite.reusablePass({
          config, pool, appId: input.appId, sessionId: input.sessionId, repoOwner: repo.owner, repoName: repo.repo,
          commitSha: input.head, trigger: input.trigger ?? null,
        });
        if (reusable) return { started: false, why: 'reused' };
        // `commitSha`: this item follows the suite to its end, so its pass is
        // recorded for reuse, for the commit it judged.
        await unitSuite.maybeRunUnitSuite({
          config, pool, appId: input.appId, sessionId: input.sessionId, repoOwner: repo.owner, repoName: repo.repo,
          ref: input.head, prNumber: Number(row.pr_number) || null,
          signal, previewRunId: runId, jobNamePrefix: 'sv-unit-early', commitSha: input.head, strict: true,
        }).catch(() => null);
        return { started: true, runId };
      },
    },

    // The checks for the attempt that serves, from admission to the parsed
    // settlement; the machine stores it. The run's Jobs carry the work
    // item's key as their run id, so a retry after a lost claim collects
    // them from the cluster instead of running them again, and runs them
    // again only when there is nothing to read.
    [WORK.run]: {
      maxAttempts: RUN_ATTEMPTS,
      leaseMs: PREPARE_LEASE_MS,
      concurrency: CONCURRENCY,
      async run(ctx): Promise<Json> {
        const { input, attempt, signal } = ctx;
        const [row, a] = await Promise.all([session(input.sessionId), app(input.appId)]);
        if (!row || !a) return { outcome: 'blocked', reason: 'The proposal or its app no longer exists' };
        // The place in the checks queue an earlier claim had: the run asks
        // for its slot as of then, not from the back of the line.
        let queuedSince: string | null = null;
        if (attempt > 1) {
          const collected = await legacy('services/check-harvest')
            .collectForWorkflow(config, pool, { runKey: input.runId, session: row, app: a, signal });
          if (collected) return collected as Json;
          const { rows: [placed] } = await pool.query(
            `SELECT min(queued_at) AS at FROM check_runs WHERE session_id = $1 AND manifest->>'runKey' = $2`,
            [input.sessionId, input.runId]);
          queuedSince = placed?.at ? new Date(placed.at).toISOString() : null;
          // Nothing to read: what the earlier claims left goes, and the run
          // starts over under this claim's own id.
          await clearRun(input.sessionId, input.runId);
        }
        // The preview it checks, awake (#6157: a preview nobody used sleeps,
        // services/preview-sleep.js). One that slept and did not wake in time
        // is the platform's fault, never the change's: its error lane runs
        // it again.
        const awake = await legacy('services/preview-sleep').wakeForRun(config, pool, input.sessionId);
        if (!awake.ok) return { outcome: 'blocked', reason: awake.detail, platformFault: true };
        const stagingResult = { runtimeName: input.runtimeName, runtimeKind: input.runtimeKind, stagingUrl: input.url, timings: null };
        const report: { uiAffecting?: boolean } = {};
        const result = await visuals().captureForSession(config, row, a, input.head, stagingResult, {
          trigger: input.trigger,
          workflow: {
            runId: claimRunId(input.sessionId, input.runId, attempt), runKey: input.runId, signal,
            unitRunId: unitEarlyRunId(input.sessionId, input.n), queuedSince, report,
          },
        });
        const out = (result ?? { outcome: 'blocked', reason: 'The checks run produced no result' }) as Record<string, Json>;
        return (report.uiAffecting ? { ...out, uiUndeclared: String(input.head).toLowerCase() } : out) as Json;
      },
    },

    // A cancelled run's Jobs and its place in the checks queue, by its own
    // ids (every claim's): never the session's others.
    [WORK.cancel]: {
      maxAttempts: 5,
      async run({ input }): Promise<Json> {
        await clearRun(input.sessionId, input.runId);
        return { cancelled: true };
      },
    },

    // GitHub's view of a settled run: the PR body's visuals block, from the
    // media the settlement published (patched or cleared), and for the
    // platform's own app the platform-variables check.
    [WORK.publish]: {
      maxAttempts: 5,
      async run({ input }): Promise<Json> {
        const row = await session(input.sessionId);
        if (!row) return { gone: true };
        const v = visuals();
        const repo = repoOf(row.repo_url);
        const github = legacy('services/github');
        if (row.pr_number && repo && github.isEnabled()) {
          const stored = input.visuals ? await v.getForSession(pool, input.sessionId, input.head) : null;
          if (stored) {
            const block = legacy('services/pr-metadata').buildVisualsBlock(stored, legacy('services/caddy').USERNODE_DOMAIN);
            await v.patchPrBody(pool, row, repo.owner, repo.repo, block);
          } else {
            await v.clearPrVisuals(pool, row, repo.owner, repo.repo);
          }
        }
        if (input.state) {
          const a = await app(row.app_id);
          if (a?.self_hosted) {
            const verdict = await legacy('services/platform-env-check').refreshPlatformEnvCheck({
              pool, app: a, session: row.source === 'cli_handoff' ? { ...row, checks_commit_sha: input.head } : row,
            });
            // The settle's checks_ready went out before this refresh: say it
            // again, so an open Checks card re-reads the platform variables.
            if (verdict && row.checks_commit_sha === input.head) {
              visuals().notifyChecks(input.sessionId,
                { state: row.check_state, results: Array.isArray(row.test_results) ? row.test_results : [] }, input.head, null);
            }
          }
        }
        return { published: true };
      },
    },

    // A superseded, failed or cancelled attempt: its database, its Secret
    // and its checkout. Never the serving attempt (the machine asks for it
    // only for one that does not serve).
    [WORK.retireAttempt]: {
      maxAttempts: 5,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        // Never what serves: a cancelled attempt whose deploy could not be
        // given back still has the live pods on its database and Secret.
        if (await serves(input)) throw new Error(`Attempt ${input.n} still serves the preview; not retired`);
        for (const db of (Array.isArray(input.dbs) ? input.dbs : [input.db])) await dbManager().dropDatabase(db, { strict: true });
        if (runtimeMode() === 'kubernetes') {
          const k = kubernetes();
          await k.deleteSecret(config, k.attemptSecretName(runtimeName(input.appId, input.sessionId), input.n));
        }
        await dropUnitEarly(input.sessionId, input.n);
        const dirs = Array.from({ length: PREPARE_ATTEMPTS + 1 }, (_, claim) => `/tmp/usernode-preview-${input.sessionId}-a${input.n}-c${claim}`);
        await legacy('services/docker').execFileAsync('rm', ['-rf', ...dirs]).catch(() => {});
        return { dropped: input.db };
      },
    },

    // The whole preview: the runtime and its Secrets by identity, every
    // attempt's database, the session's checks Jobs. It runs once a prepare
    // the machine cancelled has stopped (`notBefore`), and closes only when
    // a look after the deletes finds nothing.
    [WORK.retire]: {
      maxAttempts: 5,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        const attempts = (input.attempts || []) as { n: number; db: string }[];
        const kube = runtimeMode() === 'kubernetes';
        const k = kubernetes();
        const name = input.runtimeKind === 'docker' || !kube ? null : (input.runtimeName || runtimeName(input.appId, input.sessionId));
        const secrets = name ? [...new Set([0, ...attempts.map((a) => a.n)])].map((n) => k.attemptSecretName(name, n)) : [];
        if (name) {
          await k.deleteApplication(config, name, { identity: true, secrets });
          if (config.captureRuntime === 'kubernetes') await k.cancelPreviewChecks(config, input.sessionId);
        } else {
          // A preview's short stop grace (#767). A container that survives is
          // a failed retirement, before any database it may still use goes
          // (#851): the item is retried, and an admin sees it if it never
          // goes.
          const docker = legacy('services/docker');
          const container = input.runtimeName || `usernode-staging-${input.appSlug}--${input.sessionId}`;
          const removed = await legacy('services/application-runtime').remove(config,
            { runtimeKind: 'docker', runtimeName: container }, { stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC });
          if (removed && removed.removed === false) throw new Error(`Still present after retirement: ${container}`);
        }
        for (const a of attempts) await dropUnitEarly(input.sessionId, a.n);
        // Projects someone made in the preview, which production ran for it
        // (services/preview-projects.js): before the preview's own
        // databases, and a project that will not go fails the item.
        await legacy('services/preview-projects').retireForSession(config, pool, input.sessionId);
        const dbs = attempts.flatMap((a: { db: string; dbs?: string[] }) => a.dbs ?? [a.db]);
        for (const db of dbs) await dbManager().dropDatabase(db, { strict: true });
        const left = name ? await k.previewResourcesPresent(config, name, secrets) : [];
        for (const db of dbs) if (await dbManager().databaseExists(db, { strict: true })) left.push(db);
        if (left.length) throw new Error(`Still present after retirement: ${left.join(', ')}`);
        return { closed: true };
      },
    },

    // The databases of a serving attempt's other claims (one that died after
    // its clone, or after a deploy this attempt's rollout has since
    // replaced): never the one that serves, which the machine leaves out.
    [WORK.dropClaims]: {
      maxAttempts: 5,
      leaseMs: 120000,
      async run({ input }): Promise<Json> {
        for (const db of input.dbs || []) await dbManager().dropDatabase(db, { strict: true });
        return { dropped: input.dbs || [] };
      },
    },
  };
}
