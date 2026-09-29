'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const applicationRuntime = require('./application-runtime');
const dbManager = require('./db-manager');
const environment = require('./visual-evidence-environment');
const log = require('./logger');
const state = require('./visual-evidence-state');
const { visualHeadForSession, sameSha } = require('./pr-vote-revision');

const FAILED_MEDIA_HOURS = 24;
const ROLLBACK_MEDIA_DAYS = 7;
const RUN_RETENTION_DAYS = 30;
// A live run renews its durable row every 30 seconds. Waiting for the entire
// 24-minute run budget after heartbeats stop hides interrupted deployments
// and stalls the owner's manual rerun option. Keep a generous five-minute
// silence window; pre-heartbeat runs retain their separate legacy grace.
const HEARTBEAT_SILENCE_MS = 5 * 60_000;
// Runs started before heartbeats were deployed may legitimately be in a
// 30-minute image build. Give those rows a longer one-time grace period.
const LEGACY_RUN_GRACE_MS = 45 * 60_000;

async function cleanupRunResources(config, run) {
  const errors = [];
  for (const side of ['base', 'head']) {
    const runtimeName = environment.runtimeName(run.id, side, applicationRuntime.mode(config));
    await applicationRuntime.remove(config, {
      runtimeKind: applicationRuntime.mode(config), runtimeName,
    }).catch((err) => errors.push(err));
    const dbName = dbManager.evidenceDbName(run.app_slug, run.id, side);
    await dbManager.dropDatabase(dbName, { strict: true }).catch((err) => errors.push(err));
  }
  const prepared = dbManager.preparedCloneSourceName(dbManager.appDbName(run.app_slug), run.id);
  await dbManager.releasePreparedCloneSource(prepared).catch((err) => errors.push(err));
  return errors;
}

async function recoverInterrupted(config, pool, {
  maxAgeMs = null, limit = 20, cleanup = cleanupRunResources, stateService = state,
} = {}) {
  const runBudgetMs = Math.max(60_000, Number(config.visualEvidence?.maxRunMs) || 1_440_000);
  const ageMs = Math.max(60_000, Number(maxAgeMs) || Math.min(runBudgetMs, HEARTBEAT_SILENCE_MS));
  const legacyAgeMs = Math.max(ageMs, LEGACY_RUN_GRACE_MS);
  const { rows } = await pool.query(
    `SELECT r.*, a.slug AS app_slug, s.visual_evidence_run_id AS current_run_id
       FROM visual_evidence_runs r
       JOIN chat_sessions s ON s.id = r.session_id
       JOIN apps a ON a.id = s.app_id
      WHERE r.state IN ('planned','provisioning','exploring','replaying','reviewing')
        AND NOT (r.state = 'planned' AND r.author_plan IS NOT NULL)
        AND r.updated_at < NOW() - (
          (CASE WHEN COALESCE(r.trace_summary, '{}'::jsonb) ? 'progress'
            THEN $1 ELSE $3 END)::bigint * INTERVAL '1 millisecond')
      ORDER BY r.updated_at ASC LIMIT $2`,
    [ageMs, Math.max(1, Math.min(100, Number(limit) || 20)), legacyAgeMs]
  );
  let failed = 0;
  let cancelled = 0;
  const markCleaned = (id) => pool.query(
    `UPDATE visual_evidence_runs
        SET trace_summary = jsonb_set(COALESCE(trace_summary, '{}'::jsonb),
          '{cleanupComplete}', 'true'::jsonb, true)
      WHERE id = $1 AND state IN ('failed','cancelled')
        AND failure_code = 'evidence_run_interrupted'`,
    [id]
  );
  for (const run of rows) {
    const minIdleMs = run.trace_summary?.progress ? ageMs : legacyAgeMs;
    let terminalized = false;
    if (run.current_run_id === run.id) {
      try {
        await stateService.transitionRun(pool, run.id, 'failed', {
          failureCode: 'evidence_run_interrupted',
          failureReason: 'The visual change preview stopped reporting progress before it completed. The cause is not recorded; you can retry the preview run.',
          recoveryMinIdleMs: minIdleMs,
        });
        failed += 1;
        terminalized = true;
      } catch (err) {
        if (err.code !== 'evidence_run_active' && err.code !== 'stale_evidence_operation'
            && err.code !== 'invalid_evidence_transition') {
          log.warn('visual-evidence', 'Interrupted run could not use normal transition', {
            runId: run.id, err: err.message,
          });
        }
      }
    } else {
      // This run no longer owns its proposal. Fence the direct update against
      // a late heartbeat or a changed owner, just as the current-run path is
      // fenced by transitionRun's row lock and idle check.
      const result = await pool.query(
        `UPDATE visual_evidence_runs r
            SET state = 'cancelled', failure_code = 'evidence_run_interrupted',
              failure_reason = 'The visual change preview worker stopped before the run completed.',
              completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
           FROM chat_sessions s
          WHERE r.id = $3 AND s.id = r.session_id
            AND s.visual_evidence_run_id IS DISTINCT FROM r.id
            AND r.state IN ('planned','provisioning','exploring','replaying','reviewing')
            AND r.updated_at < NOW() - (
              (CASE WHEN COALESCE(r.trace_summary, '{}'::jsonb) ? 'progress'
                THEN $1 ELSE $2 END)::bigint * INTERVAL '1 millisecond')`,
        [ageMs, legacyAgeMs, run.id]
      );
      terminalized = !!result.rowCount;
      if (terminalized) cancelled += 1;
    }
    if (!terminalized) continue;
    // Terminalize first, then clean up. A live worker can no longer renew a
    // row after this point, and a process exit during cleanup is retried below.
    const cleanupErrors = await cleanup(config, run);
    if (cleanupErrors.length) {
      log.warn('visual-evidence', 'Interrupted evidence cleanup was incomplete', {
        runId: run.id, errors: cleanupErrors.map((error) => error.message).slice(0, 4),
      });
    } else {
      await markCleaned(run.id);
    }
  }
  // A process can stop after terminalizing an interrupted run but before
  // resource cleanup finishes. Retry only rows without a completion marker;
  // cleanup is deterministic and safe to repeat for missing resources.
  const retries = await pool.query(
    `SELECT r.*, a.slug AS app_slug
       FROM visual_evidence_runs r
       JOIN chat_sessions s ON s.id = r.session_id
       JOIN apps a ON a.id = s.app_id
      WHERE r.state IN ('failed','cancelled')
        AND r.failure_code = 'evidence_run_interrupted'
        AND NOT (COALESCE(r.trace_summary, '{}'::jsonb) @> '{"cleanupComplete":true}'::jsonb)
      ORDER BY r.updated_at ASC LIMIT $1`,
    [Math.max(1, Math.min(100, Number(limit) || 20))]
  );
  let cleanupRetried = 0;
  for (const run of retries.rows) {
    const errors = await cleanup(config, run);
    if (errors.length) {
      log.warn('visual-evidence', 'Interrupted evidence cleanup retry failed', {
        runId: run.id, errors: errors.map((error) => error.message).slice(0, 4),
      });
      continue;
    }
    await markCleaned(run.id);
    cleanupRetried += 1;
  }
  return { examined: rows.length, failed, cancelled, cleanupRetried };
}

// Intent is written before checks finish. The ordinary checks completion
// event starts evidence, but a process can die between those two writes.
// A submitted author plan already has a durable planned run at import;
// both that case and an intent-only proposal need the same recovery handoff.
async function recoverUnstarted(config, pool, { limit = 10, minAgeMs = 60_000, schedule = null } = {}) {
  if (!config.visualEvidence?.execute) return { examined: 0, scheduled: 0 };
  const retryAfterMs = 10 * 60_000;
  const { rows } = await pool.query(
    `SELECT cs.id, cs.source, cs.imported_pr_head_sha, cs.reviewed_head_sha,
            cs.checks_commit_sha, cs.handoff_head_sha
       FROM chat_sessions cs
       LEFT JOIN visual_evidence_runs r ON r.id = cs.visual_evidence_run_id
      WHERE cs.visual_evidence_state = 'planned'
        AND (cs.visual_evidence_run_id IS NULL
             OR (r.state = 'planned' AND r.author_plan IS NOT NULL))
        AND cs.status IN ('active', 'promoted')
        AND cs.visual_evidence_detail->>'required' = 'true'
        AND jsonb_typeof(cs.visual_evidence_detail->'intent') = 'object'
        AND (cs.check_state IN ('passing', 'failing', 'error', 'skipped')
             OR cs.check_phase = 'deferred')
        AND cs.visual_evidence_updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
        AND COALESCE((cs.visual_evidence_detail->>'recoveryAttemptAt')::bigint, 0)
            < (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint - $3::bigint
      ORDER BY cs.visual_evidence_updated_at ASC LIMIT $2`,
    [Math.max(0, Number(minAgeMs) || 0), Math.max(1, Math.min(50, Number(limit) || 10)), retryAfterMs]
  );
  const dispatch = schedule || require('./visual-evidence-orchestrator').scheduleForSession;
  const defer = async (id) => {
    await pool.query(
      `UPDATE chat_sessions
          SET visual_evidence_detail = visual_evidence_detail
                || jsonb_build_object('recoveryAttemptAt', $2::bigint)
        WHERE id = $1 AND visual_evidence_state = 'planned'`,
      [id, Date.now()]
    );
  };
  let scheduled = 0;
  for (const session of rows) {
    const head = visualHeadForSession(session);
    if (!state.validSha(head) || !sameSha(head, session.checks_commit_sha)) continue;
    try {
      const result = await dispatch(config, {
        pool, sessionId: session.id, headSha: head, trigger: 'planned-recovery',
      });
      if (result.scheduled) scheduled += 1;
      else if (result.reason !== 'already_running') await defer(session.id);
    } catch (error) {
      log.warn('visual-evidence', 'Could not recover an unstarted visual evidence claim', {
        sessionId: session.id, headSha: head, error: error.message,
      });
      await defer(session.id).catch(() => {});
    }
  }
  return { examined: rows.length, scheduled };
}

// Production redeploys on every merge to main, and a run lives in the web
// process that scheduled it, so a rollout interrupts whatever is in flight.
// Nothing about the proposal is wrong when that happens. Give the current
// head a bounded number of fresh runs instead of leaving a failure that only
// a person clicking Retry can clear. `rerunSameHead` keeps the interrupted
// row as the audit record and the planned -> provisioning claim in
// scheduleForSession still guarantees one live runner.
const INTERRUPTED_RETRY_TRIGGER = 'interrupted-retry';
const MAX_INTERRUPTED_RETRIES = 2;

async function retryInterrupted(config, pool, {
  limit = 10, minAgeMs = 30_000, maxRetries = MAX_INTERRUPTED_RETRIES,
  schedule = null, stateService = state,
} = {}) {
  if (!config.visualEvidence?.execute) return { examined: 0, scheduled: 0 };
  const { rows } = await pool.query(
    `SELECT r.id AS run_id, r.head_sha, cs.id, cs.source, cs.imported_pr_head_sha,
            cs.reviewed_head_sha, cs.checks_commit_sha, cs.handoff_head_sha
       FROM chat_sessions cs
       JOIN visual_evidence_runs r ON r.id = cs.visual_evidence_run_id
      WHERE r.state = 'failed'
        AND r.failure_code = 'evidence_run_interrupted'
        AND cs.status NOT IN ('merged', 'archived')
        AND r.updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
        AND (SELECT COUNT(*) FROM visual_evidence_runs prior
              WHERE prior.session_id = cs.id AND prior.head_sha = r.head_sha
                AND prior.trigger = $3) < $4
      ORDER BY r.updated_at ASC LIMIT $2`,
    [Math.max(0, Number(minAgeMs) || 0), Math.max(1, Math.min(50, Number(limit) || 10)),
      INTERRUPTED_RETRY_TRIGGER, Math.max(0, Number(maxRetries) || 0)]
  );
  const dispatch = schedule || require('./visual-evidence-orchestrator').scheduleForSession;
  let scheduled = 0;
  for (const row of rows) {
    // A newer commit owns the proposal now; its own checks start evidence.
    if (!sameSha(visualHeadForSession(row), row.head_sha)) continue;
    try {
      await stateService.rerunSameHead(pool, row.run_id, { trigger: INTERRUPTED_RETRY_TRIGGER });
      const result = await dispatch(config, {
        pool, sessionId: row.id, headSha: row.head_sha, trigger: INTERRUPTED_RETRY_TRIGGER,
      });
      if (result.scheduled) scheduled += 1;
    } catch (error) {
      // Another pod or a person may have retried it first; both are fine.
      log.warn('visual-evidence', 'Could not retry an interrupted visual evidence run', {
        sessionId: row.id, runId: row.run_id, code: error.code, error: error.message,
      });
    }
  }
  return { examined: rows.length, scheduled };
}

async function prune(pool, config = {}) {
  const failedMediaHours = Math.max(1,
    Number(config.visualEvidence?.failedArtifactRetentionHours) || FAILED_MEDIA_HOURS);
  const failedRunDays = Math.max(1,
    Number(config.visualEvidence?.failedMetadataRetentionDays) || RUN_RETENTION_DAYS);
  const failedMedia = await pool.query(
    `DELETE FROM visual_evidence_artifacts a
      USING visual_evidence_runs r
      WHERE a.run_id = r.id
        AND r.state IN ('failed','cancelled')
        AND COALESCE(r.completed_at, r.updated_at) < NOW() - ($1::int * INTERVAL '1 hour')`,
    [failedMediaHours]
  );
  const rollbackMedia = await pool.query(
    `DELETE FROM visual_evidence_artifacts a
      USING visual_evidence_runs r
      WHERE a.run_id = r.id AND r.state = 'stale'
        AND COALESCE(r.completed_at, r.updated_at) < NOW() - ($1::int * INTERVAL '1 day')`,
    [ROLLBACK_MEDIA_DAYS]
  );
  const runs = await pool.query(
    `DELETE FROM visual_evidence_runs r
      WHERE r.state IN ('failed','stale','cancelled','not_required','overridden')
        AND COALESCE(r.completed_at, r.updated_at) < NOW() - ($1::int * INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM chat_sessions s WHERE s.visual_evidence_run_id = r.id
        )`,
    [failedRunDays]
  );
  return {
    failedArtifacts: failedMedia.rowCount || 0,
    rollbackArtifacts: rollbackMedia.rowCount || 0,
    runs: runs.rowCount || 0,
  };
}

async function sweepOrphanCheckouts(pool, { maxAgeMs = 720_000, tmpDir = os.tmpdir() } = {}) {
  const boundedAge = Math.max(60_000, Number(maxAgeMs) || 720_000);
  const active = await pool.query(
    `SELECT id FROM visual_evidence_runs
      WHERE state IN ('planned','provisioning','exploring','replaying','reviewing')
        AND updated_at >= NOW() - (
          (CASE WHEN COALESCE(trace_summary, '{}'::jsonb) ? 'progress'
            THEN $1 ELSE $2 END)::bigint * INTERVAL '1 millisecond')`,
    [boundedAge, Math.max(boundedAge, LEGACY_RUN_GRACE_MS)]
  );
  const activePrefixes = new Set((active.rows || []).map((row) => String(row.id || '').slice(0, 8)));
  let entries;
  try {
    entries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch (err) {
    log.warn('visual-evidence', 'Could not inspect temporary evidence checkouts', { error: err.message });
    return { examined: 0, removed: 0 };
  }
  let examined = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^usernode-evidence-([0-9a-f]{8})-[A-Za-z0-9._-]+$/.exec(entry.name);
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
      log.warn('visual-evidence', 'Could not remove orphan evidence checkout', {
        directory: entry.name, error: err.message,
      });
    }
  }
  return { examined, removed };
}

async function sweep(config, pool) {
  const recovered = await recoverInterrupted(config, pool);
  const checkouts = await sweepOrphanCheckouts(pool, {
    maxAgeMs: config.visualEvidence?.maxRunMs || 1_440_000,
  });
  const pruned = await prune(pool, config);
  return {
    ...recovered,
    orphanCheckoutsExamined: checkouts.examined,
    orphanCheckoutsRemoved: checkouts.removed,
    ...pruned,
  };
}

module.exports = {
  FAILED_MEDIA_HOURS,
  ROLLBACK_MEDIA_DAYS,
  RUN_RETENTION_DAYS,
  LEGACY_RUN_GRACE_MS,
  cleanupRunResources,
  recoverInterrupted,
  recoverUnstarted,
  retryInterrupted,
  MAX_INTERRUPTED_RETRIES,
  INTERRUPTED_RETRY_TRIGGER,
  prune,
  sweepOrphanCheckouts,
  sweep,
};
