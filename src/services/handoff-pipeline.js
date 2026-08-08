'use strict';

// The "an agent that is not a platform worker container produced a commit —
// now finish the job" pipeline.
//
// This code used to live inside src/routes/proposal-handoff.js, where it was
// written for exactly one caller: the `proposal_*` MCP tools driving a local
// Codex/Claude session (`chat_sessions.source = 'cli_handoff'`). #907 adds a
// second caller — a local coding agent attached to an ordinary native Dev
// session (`source = 'anthropic'`) — that needs the identical tail: build the
// staging preview, persist the pointer, warm the certificate, tell any open
// web page, capture visuals.
//
// The only behavioral change in the move is the row guard. Every UPDATE here
// used to require `source = 'cli_handoff'`, which silently no-opped for a
// native session. It now requires `source IS DISTINCT FROM 'imported'`:
//
//   * an imported PR is a mirror of someone else's GitHub branch — the
//     platform does not own its head and must never stage over it, so it
//     stays excluded;
//   * every other source is a session whose commits the platform produced or
//     adopted, and the guard's real job is the one it still does — refusing
//     to persist a stale build after a newer head has taken the session.
//
// Session ownership and staging capacity are enforced by the callers, before
// they get here.

const staging = require('./staging');
const stagingRecovery = require('./staging-recovery');
const visuals = require('./visuals');
const { beginSessionOperation } = require('./active-workers');
const log = require('./logger');

// Written into every guard below. Kept as one constant so the "which sessions
// may the platform stage over" rule has exactly one definition.
const OWNED_SOURCE_SQL = "source IS DISTINCT FROM 'imported'";

// A user can submit a newer local commit while an earlier HTTP request is
// still proving ancestry/updating GitHub. Serialize that adoption per session
// so an older request can never persist its SHA after the newer request and
// regress the durable reviewed head. This matches staging.js's process model;
// deployments run one platform process, while different sessions still move
// independently.
const handoffSubmissionTails = new Map();
const handoffPipelines = new Set();

function serializeHandoffSubmission(sessionId, fn) {
  const key = String(sessionId);
  const previous = handoffSubmissionTails.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  handoffSubmissionTails.set(key, tail);
  tail.then(() => {
    if (handoffSubmissionTails.get(key) === tail) handoffSubmissionTails.delete(key);
  });
  return run;
}

function hasInFlightHandoffPipeline(sessionId) {
  return handoffPipelines.has(String(sessionId));
}

function beginHandoffPipeline(sessionId) {
  const key = String(sessionId);
  handoffPipelines.add(key);
  const releaseOperation = beginSessionOperation(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    handoffPipelines.delete(key);
    releaseOperation();
  };
}

function startHandoffPipeline(config, pool, session, app, headSha, releasePipeline) {
  const run = runStaging(config, pool, session, app, headSha);
  run.catch((err) => {
    log.error('handoff-pipeline', 'Unexpected handoff run rejection', {
      sessionId: session.id, err: err.message,
    });
  }).finally(() => {
    releasePipeline();
  });
  return run;
}

async function discardHandoffStaging(pool, session, app, result, expectedHeadSha) {
  try {
    const removed = await staging.teardownStaging(
      { ...session, staging_container_id: result.containerId, staging_url: result.stagingUrl },
      { slug: app.slug }
    );
    if (removed?.leaked) {
      // teardownStaging deliberately leaves a durable pointer on failure so
      // the staging reaper can retry. This result was never attached to the
      // row, so establish that pointer only after removal actually leaked.
      await pool.query(
        `UPDATE chat_sessions
            SET staging_container_id = $1, staging_url = $2
          WHERE id = $3 AND ${OWNED_SOURCE_SQL}
            AND (status <> 'active'
                 OR checks_commit_sha IS NOT DISTINCT FROM $4)`,
        [result.containerId, result.stagingUrl, session.id, expectedHeadSha]
      ).catch((err) => log.warn('handoff-pipeline', 'Failed to retain leaked staging pointer', {
        sessionId: session.id, err: err.message,
      }));
    }
  } catch (err) {
    log.warn('handoff-pipeline', 'Failed to discard superseded staging build', {
      sessionId: session.id, err: err.message,
    });
  }
}

async function runStaging(config, pool, session, app, headSha) {
  let result;
  try {
    result = await staging.buildAndDeployStaging(config, session, app, headSha);
  } catch (err) {
    // A newer submission may have queued while this build was running. Its
    // pending verdict must not be overwritten by a late failure from the old
    // head.
    const { rows } = await pool.query(
      `SELECT status, checks_commit_sha FROM chat_sessions WHERE id = $1`,
      [session.id]
    ).catch(() => ({ rows: [] }));
    if (rows[0]?.status !== 'active' || rows[0]?.checks_commit_sha !== headSha) {
      log.info('handoff-pipeline', 'Ignoring stale staging failure', {
        sessionId: session.id, headSha,
      });
      return;
    }
    log.error('handoff-pipeline', 'Staging build failed', {
      sessionId: session.id, headSha, err: err.message,
    });
    await stagingRecovery.recordStagingBootFailure({
      config, pool, session, commitHash: headSha, err,
    }).catch((recordErr) => log.warn('handoff-pipeline', 'Failed to record staging failure', {
      sessionId: session.id, err: recordErr.message,
    }));
    return;
  }

  try {
    const persisted = await pool.query(
      `UPDATE chat_sessions
          SET staging_container_id = $1, staging_url = $2, last_activity_at = NOW()
        WHERE id = $3 AND checks_commit_sha = $4
          AND status = 'active' AND ${OWNED_SOURCE_SQL}`,
      [result.containerId, result.stagingUrl, session.id, headSha]
    );
    // A newer accepted head now owns the session. Its serialized build will
    // replace this container; do not let the stale capture overwrite the
    // newer head's pending check state in the meantime.
    if (!persisted.rowCount) {
      const { rows } = await pool.query(
        `SELECT status, checks_commit_sha FROM chat_sessions WHERE id = $1`,
        [session.id]
      ).catch(() => ({ rows: [] }));
      const current = rows[0];
      if (!current || current.status !== 'active') {
        await discardHandoffStaging(pool, session, app, result, headSha);
      }
      return;
    }
  } catch (err) {
    log.error('handoff-pipeline', 'Failed to persist staging result', {
      sessionId: session.id, headSha, err: err.message,
    });
    // The container and cloned DB already exist, but no durable row points at
    // them. Best-effort removal is safer than leaving an undiscoverable
    // preview behind after a transient persistence failure.
    await discardHandoffStaging(pool, session, app, result, headSha);
    return;
  }

  await staging.warmStagingCert(session, result.hostname, result.stagingUrl)
    .catch((err) => log.warn('handoff-pipeline', 'Staging certificate warm failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));
  // The caller may have no open SSE response (the CLI handoff never does; a
  // local agent turn only does while the browser tab that started it is
  // still open), so use the global/session buses to make an optionally-open
  // web Dev page learn that its preview is live.
  try {
    // eslint-disable-next-line global-require
    const { broadcastGlobal, pushSessionUpdate } = require('./ws');
    broadcastGlobal({
      type: 'session_event', sessionId: session.id,
      event: 'staging_ready', url: result.stagingUrl,
    });
    pushSessionUpdate({
      action: 'staging_ready', sessionId: session.id, appSlug: app.slug,
    });
  } catch (err) {
    log.warn('handoff-pipeline', 'Staging-ready notify failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  }

  // captureForSession owns its terminal error verdict and never lets a test
  // runner failure escape. Awaiting it here keeps status honest while still
  // running entirely outside the original HTTP request.
  await visuals.captureForSession(config, session, app, headSha, result);
  return result;
}

module.exports = {
  OWNED_SOURCE_SQL,
  serializeHandoffSubmission,
  hasInFlightHandoffPipeline,
  beginHandoffPipeline,
  startHandoffPipeline,
  discardHandoffStaging,
  runStaging,
};
