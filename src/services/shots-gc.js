'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const applicationRuntime = require('./application-runtime');
const dbManager = require('./db-manager');
const environment = require('./shots-environment');
const log = require('./logger');
const state = require('./shots-state');
const kubernetes = require('./kubernetes');

const FAILED_MEDIA_HOURS = 24;
const ROLLBACK_MEDIA_DAYS = 7;
const RUN_RETENTION_DAYS = 30;
const EVAL_ARTIFACT_DAYS = 30;
// A shots eval's trial's row moves as its phases do (the shots-eval
// machine; its copies take at most half an hour). Its copies and checkouts
// are left alone for this long after it last did.
const LEGACY_RUN_GRACE_MS = 45 * 60_000;

// The copies of one run, by the run's own names (shots-environment.js):
// both runtimes and databases (and the names from before the rename), the
// hosted fixture, the clone source. Resolves the errors; an absent resource
// is not one. The shots machine's cleanup (shots-orchestrator.cleanupRun)
// and a shots eval's trial call it.
async function cleanupRunResources(config, run) {
  const errors = [];
  for (const side of ['base', 'head']) {
    const runtimeName = environment.runtimeName(run.id, side, applicationRuntime.mode(config));
    await environment.removeRuntime(config, {
      runtimeKind: applicationRuntime.mode(config), runtimeName,
    }).catch((err) => errors.push(err));
    const dbName = dbManager.shotsDbName(run.app_slug, run.id, side);
    await dbManager.dropDatabase(dbName, { strict: true }).catch((err) => errors.push(err));
    // A run the previous release started used the names from before the
    // rename. Removal is idempotent for absent resources, but API/database
    // errors must keep the durable cleanup pending.
    await environment.removeRuntime(config, {
      runtimeKind: applicationRuntime.mode(config),
      runtimeName: environment.legacyRuntimeName(run.id, side, applicationRuntime.mode(config)),
    }).catch((err) => errors.push(err));
    await dbManager.dropDatabase(dbManager.legacyShotsDbName(run.app_slug, run.id, side), { strict: true })
      .catch((err) => errors.push(err));
  }
  for (const ref of environment.hostedFixtureRefs(config, run.id)) {
    await environment.removeRuntime(config, ref).catch((err) => errors.push(err));
  }
  const prepared = dbManager.preparedCloneSourceName(dbManager.appDbName(run.app_slug), run.id);
  await dbManager.releasePreparedCloneSource(prepared).catch((err) => errors.push(err));
  return errors;
}

async function prune(pool, config = {}) {
  const failedMediaHours = Math.max(1,
    Number(config.shots?.failedArtifactRetentionHours) || FAILED_MEDIA_HOURS);
  const failedRunDays = Math.max(1,
    Number(config.shots?.failedMetadataRetentionDays) || RUN_RETENTION_DAYS);
  const failedMedia = await pool.query(
    `DELETE FROM shot_artifacts a
      USING shot_runs r
      WHERE a.run_id = r.id
        AND r.state IN ('failed','cancelled')
        AND COALESCE(r.completed_at, r.updated_at) < NOW() - ($1::int * INTERVAL '1 hour')`,
    [failedMediaHours]
  );
  // A stale run's files go after a week, unless its proposal's card still
  // shows them as the previous version's (shots_detail.previous) while the
  // current version's shots are taken.
  const rollbackMedia = await pool.query(
    `DELETE FROM shot_artifacts a
      USING shot_runs r
      WHERE a.run_id = r.id AND r.state = 'stale'
        AND COALESCE(r.completed_at, r.updated_at) < NOW() - ($1::int * INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM chat_sessions s
           WHERE s.id = r.session_id AND s.shots_detail->'previous'->>'runId' = r.id
        )`,
    [ROLLBACK_MEDIA_DAYS]
  );
  const runs = await pool.query(
    `DELETE FROM shot_runs r
      WHERE r.state IN ('failed','stale','cancelled','not_required','overridden')
        AND COALESCE(r.trace_summary, '{}'::jsonb)
          @> jsonb_build_object('cleanupComplete', true, 'cleanupVersion', $2::int)
        AND COALESCE(r.completed_at, r.updated_at) < NOW() - ($1::int * INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM chat_sessions s
           WHERE s.shots_run_id = r.id
              OR (s.id = r.session_id AND s.shots_detail->'previous'->>'runId' = r.id)
        )`,
    [failedRunDays, environment.RESOURCE_CLEANUP_VERSION]
  );
  return {
    failedArtifacts: failedMedia.rowCount || 0,
    rollbackArtifacts: rollbackMedia.rowCount || 0,
    runs: runs.rowCount || 0,
  };
}

// A shots eval's images (shots-eval.js) are for comparing configurations
// while the comparison is fresh: kept EVAL_ARTIFACT_DAYS after the trial
// finished. The trial keeps its results and numbers.
async function pruneEvalArtifacts(pool, { days = EVAL_ARTIFACT_DAYS } = {}) {
  const { rowCount } = await pool.query(
    `DELETE FROM shots_eval_artifacts a
      USING shots_eval_trials t
      WHERE a.trial_id = t.id
        AND t.state IN ('verified', 'failed', 'cancelled')
        AND COALESCE(t.completed_at, t.updated_at) < NOW() - ($1::int * INTERVAL '1 day')`,
    [Math.max(1, Number(days) || EVAL_ARTIFACT_DAYS)]
  );
  return rowCount || 0;
}

async function sweepOrphanCheckouts(pool, { maxAgeMs = 720_000, tmpDir = os.tmpdir() } = {}) {
  const boundedAge = Math.max(60_000, Number(maxAgeMs) || 720_000);
  // A shots eval's trial (the shots-eval machine) checks out its revisions
  // under its attempt id the same way, while it builds its copies.
  // A proposal's run under way is the shots machine's, which settles every
  // run it starts; a trial's is alive while its lease is.
  const active = await pool.query(
    `SELECT id FROM shot_runs
      WHERE state IN ('planned','provisioning','exploring','replaying','reviewing')
     UNION ALL
     SELECT attempt_id AS id FROM shots_eval_trials
      WHERE state IN ('provisioning','exploring','reviewing')
        AND updated_at >= NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
    [Math.max(boundedAge, LEGACY_RUN_GRACE_MS)]
  );
  const activePrefixes = new Set((active.rows || []).map((row) => String(row.id || '').slice(0, 8)));
  let entries;
  try {
    entries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch (err) {
    log.warn('shots', 'Could not inspect temporary shots checkouts', { error: err.message });
    return { examined: 0, removed: 0 };
  }
  let examined = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^usernode-(?:shots|evidence)-([0-9a-f]{8})-[A-Za-z0-9._-]+$/.exec(entry.name);
    if (!match || activePrefixes.has(match[1])) continue;
    const target = path.join(tmpDir, entry.name);
    let stat;
    try { stat = await fs.stat(target); } catch { continue; }
    examined += 1;
    if (Date.now() - stat.mtimeMs < boundedAge) continue;
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log.warn('shots', 'Could not remove orphan shots checkout', {
        directory: entry.name, error: err.message,
      });
    }
  }
  return { examined, removed };
}

// A session deletion can cascade away its run, and an old or late-finishing
// runner can leave resources after a completion marker was written. Reconcile
// the actual runtime inventory too, without touching media or ordinary previews.
async function sweepOrphanRuntimes(config, pool, {
  limit = 100, minAgeMs = LEGACY_RUN_GRACE_MS, now = Date.now(),
  list = kubernetes.listShotsRuntimes, remove = applicationRuntime.remove,
} = {}) {
  const result = { examined: 0, removed: 0, failed: 0 };
  if (applicationRuntime.mode(config) !== 'kubernetes') return result;
  const cutoff = now - Math.max(LEGACY_RUN_GRACE_MS, Number(minAgeMs) || 0);
  const runtimes = (await list(config)).filter((ref) => {
    const created = new Date(ref.createdAt || '').getTime();
    return Number.isFinite(created) && created < cutoff;
  }).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!runtimes.length) return result;
  // No deletion is attempted unless the entire state lookup succeeds. A
  // nonterminal row is left to the shots machine, however old its runtime.
  // A shots eval's trial names its copies by its attempt id; its row is
  // read the same way (the shots-eval machine).
  const { rows } = await pool.query(
    `SELECT id, session_id, state, updated_at FROM shot_runs WHERE id = ANY($1::text[])
     UNION ALL
     SELECT attempt_id AS id, session_id, state, updated_at FROM shots_eval_trials
      WHERE attempt_id = ANY($1::text[])`,
    [[...new Set(runtimes.map((ref) => ref.runId))]]
  );
  const runs = new Map(rows.map((run) => [run.id, run]));
  const max = Math.max(1, Math.min(100, Number(limit) || 100));
  let attempted = 0;
  for (const ref of runtimes) {
    result.examined += 1;
    const run = runs.get(ref.runId);
    if (run && (Number(run.session_id) !== ref.sessionId
        || !state.TERMINAL_STATES.has(run.state)
        || !(new Date(run.updated_at).getTime() < cutoff))) continue;
    if (attempted >= max) break;
    attempted += 1;
    try {
      await remove(config, ref);
      result.removed += 1;
    } catch (error) {
      result.failed += 1;
      log.warn('shots', 'Orphan shots runtime cleanup failed', {
        runId: ref.runId, runtimeName: ref.runtimeName, error: error.message,
      });
    }
  }
  return result;
}

// One pass of the `shots-gc` clock (src/workflow/clock/services.ts), on any
// process: what the cluster and the database hold. The checkouts a run left
// in a process's own temporary directory are that process's to remove
// (sweepOwnCheckouts, every process: server.js startProcessDuties), since a
// run's work is claimed wherever the workflow runs.
async function sweep(config, pool) {
  const runtimes = await sweepOrphanRuntimes(config, pool);
  const pruned = await prune(pool, config);
  const evalArtifacts = await pruneEvalArtifacts(pool);
  return {
    orphanRuntimesExamined: runtimes.examined,
    orphanRuntimesRemoved: runtimes.removed,
    orphanRuntimeFailures: runtimes.failed,
    ...pruned,
    evalArtifacts,
  };
}

// This process's own leftover checkouts, every few hours.
const OWN_CHECKOUTS_EVERY_MS = 3 * 60 * 60 * 1000;
let ownCheckoutsTimer = null;
function sweepOwnCheckouts(config, pool) {
  if (ownCheckoutsTimer) return;
  const run = () => sweepOrphanCheckouts(pool, { maxAgeMs: config.shots?.maxRunMs || 1_440_000 })
    .then((r) => { if (r.removed) log.info('shots', 'Removed orphan shots checkouts', r); })
    .catch((err) => log.warn('shots', 'Orphan shots checkout sweep failed', { error: err.message }));
  ownCheckoutsTimer = setInterval(run, OWN_CHECKOUTS_EVERY_MS);
  ownCheckoutsTimer.unref?.();
  // And once soon after boot: what a crash left is most likely there then.
  setTimeout(() => { if (ownCheckoutsTimer) run(); }, 10 * 60 * 1000).unref?.();
}
function stopOwnCheckouts() {
  if (ownCheckoutsTimer) clearInterval(ownCheckoutsTimer);
  ownCheckoutsTimer = null;
}

module.exports = {
  FAILED_MEDIA_HOURS,
  ROLLBACK_MEDIA_DAYS,
  RUN_RETENTION_DAYS,
  EVAL_ARTIFACT_DAYS,
  LEGACY_RUN_GRACE_MS,
  cleanupRunResources,
  prune,
  pruneEvalArtifacts,
  sweepOrphanCheckouts,
  sweepOwnCheckouts,
  stopOwnCheckouts,
  sweepOrphanRuntimes,
  sweep,
};
