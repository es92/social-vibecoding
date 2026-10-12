'use strict';

// A MODE=sync worker owns the Git push, while the CLI-handoff lifecycle owns
// the immutable revision that staging and checks describe. Keep those two
// halves together: once a successful sync moves the bot-owned branch, adopt
// that exact SHA into the managed proposal and start its replacement preview.

const log = require('./logger');
const summaryFreshness = require('./summary-freshness');

const SHA_RE = /^[0-9a-f]{40}$/i;

function sameSha(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

function repoOf(session) {
  const match = String(session?.repo_url || '')
    .match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function pinsCurrent(session, headSha) {
  return sameSha(session?.handoff_head_sha, headSha)
    && sameSha(session?.handoff_uploaded_sha, headSha)
    && sameSha(session?.checks_commit_sha, headSha)
    && (session?.status !== 'promoted' || sameSha(session?.reviewed_head_sha, headSha));
}

async function readPins(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT status, branch_name, handoff_head_sha, handoff_uploaded_sha,
            checks_commit_sha, reviewed_head_sha
       FROM chat_sessions WHERE id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

async function adoptActive({ config, pool, session, headSha, deps }) {
  const pipeline = deps.pipeline || require('./handoff-pipeline');
  const visuals = deps.visuals || require('./visuals');
  const { rows } = await pool.query(
    `UPDATE chat_sessions
        SET handoff_head_sha = $1,
            ${summaryFreshness.INVALIDATE_SQL},
            handoff_uploaded_sha = $1,
            handoff_local_commit_sha = NULL,
            handoff_upload_checked_sha = NULL,
            check_state = 'pending', checks_commit_sha = $1,
            check_error_detail = NULL,
            staging_container_id = NULL, staging_url = NULL,
            last_activity_at = NOW()
      WHERE id = $2 AND status = 'active' AND source = 'cli_handoff'
        AND branch_name IS NOT DISTINCT FROM $3
        AND handoff_head_sha IS NOT DISTINCT FROM $4
        AND handoff_uploaded_sha IS NOT DISTINCT FROM $5
        AND checks_commit_sha IS NOT DISTINCT FROM $6
      RETURNING *`,
    [headSha, session.id, session.branch_name || null,
      session.handoff_head_sha || null, session.handoff_uploaded_sha || null,
      session.checks_commit_sha || null]
  );
  if (!rows.length) {
    const current = await readPins(pool, session.id);
    if (current && pinsCurrent(current, headSha)) {
      return { ok: true, applied: false, unchanged: true, headSha };
    }
    return { ok: false, reason: 'session_state_changed', headSha };
  }

  const fresh = rows[0];
  if (session.shots_state || session.shots_detail) {
    await require('./shots-state').markStaleForHead(pool, session.id, headSha)
      .catch((err) => log.warn('cli-handoff-sync', 'could not invalidate prior-head before & after shots', {
        sessionId: session.id, headSha, err: err.message,
      }));
  }
  const pending = await visuals.setChecksPending(
    pool, session.id, headSha, 'building', 'sync-main'
  ).catch((err) => {
    // The atomic adoption above already removed the old verdict and pinned
    // it to this exact SHA. Keep the rebuild moving; captureForSession stamps
    // the testing phase again, and a failed preview receives a terminal
    // error through the ordinary handoff pipeline.
    log.warn('cli-handoff-sync', 'could not stamp sync-main build phase', {
      sessionId: session.id, headSha, err: err.message,
    });
    return true;
  });
  if (pending === false) {
    return { ok: false, reason: 'session_state_changed', headSha };
  }
  try {
    visuals.notifyChecksPending(session.id, headSha, 'building', 'sync-main');
  } catch (_) { /* notification only */ }

  const app = {
    id: session.app_id,
    slug: session.app_slug,
    name: session.app_name,
    repo_url: session.repo_url,
  };
  const releasePipeline = pipeline.beginHandoffPipeline(session.id);
  try {
    pipeline.startHandoffPipeline(
      config, pool, fresh, app, headSha, releasePipeline, 'sync-main'
    );
  } catch (err) {
    releasePipeline();
    throw err;
  }
  return { ok: true, applied: true, headSha, checksStarted: true };
}

async function adoptPromoted({ config, pool, session, headSha, deps }) {
  const votes = deps.votes || require('../routes/votes');
  const revision = await votes.reconcileNativeReviewedHead({
    config, pool, session, fresh: true, notify: true, deferChecks: true, madeBy: 'homeroom',
  });
  if (revision.blocked || !sameSha(revision.headSha, headSha)) {
    return {
      ok: false,
      reason: revision.reason || 'branch_moved',
      headSha: revision.headSha || null,
    };
  }

  const { rows } = await pool.query(
    `UPDATE chat_sessions
        SET handoff_head_sha = $1,
            ${summaryFreshness.INVALIDATE_SQL},
            handoff_uploaded_sha = $1,
            handoff_local_commit_sha = NULL,
            handoff_upload_checked_sha = NULL,
            staging_container_id = NULL, staging_url = NULL,
            last_activity_at = NOW()
      WHERE id = $2 AND status = 'promoted' AND source = 'cli_handoff'
        AND branch_name IS NOT DISTINCT FROM $3
        AND handoff_head_sha IS NOT DISTINCT FROM $4
        AND handoff_uploaded_sha IS NOT DISTINCT FROM $5
        AND reviewed_head_sha = $1
      RETURNING *`,
    [headSha, session.id, session.branch_name || null,
      session.handoff_head_sha || null, session.handoff_uploaded_sha || null]
  );
  if (!rows.length) {
    const current = await readPins(pool, session.id);
    if (current && pinsCurrent(current, headSha)
        && sameSha(current.reviewed_head_sha, headSha)) {
      return { ok: true, applied: false, unchanged: true, headSha };
    }
    return { ok: false, reason: 'session_state_changed', headSha };
  }

  const fresh = {
    ...session,
    ...rows[0],
    handoff_head_sha: headSha,
    handoff_uploaded_sha: headSha,
    checks_commit_sha: headSha,
    reviewed_head_sha: headSha,
  };
  const prImportSync = deps.prImportSync || require('./pr-import-sync');
  Promise.resolve(prImportSync.rerunChecksForNewHead({
    config, pool, session: fresh, newHead: headSha, trigger: 'sync-main',
  })).catch((err) => log.warn('cli-handoff-sync', 'post-sync checks failed', {
    sessionId: session.id, headSha, err: err.message,
  }));
  return {
    ok: true,
    applied: true,
    headSha,
    checksStarted: true,
    approvalEpoch: revision.epoch,
    moveKind: revision.kind || null,
  };
}

async function reconcileCliHandoffSync({ config, pool, session, newHead }, deps = {}) {
  if (session?.source !== 'cli_handoff') {
    return { ok: true, applied: false, reason: 'not_cli_handoff' };
  }
  if (!['active', 'promoted'].includes(session.status)) {
    return { ok: true, applied: false, reason: 'not_open' };
  }

  const github = deps.github || require('./github');
  const repo = repoOf(session);
  if (!repo || !session.branch_name) {
    return { ok: false, reason: 'missing_branch' };
  }
  let liveHead;
  try {
    liveHead = await github.getBranchSha(repo.owner, repo.repo, session.branch_name);
  } catch (err) {
    log.warn('cli-handoff-sync', 'could not verify the synced branch head', {
      sessionId: session.id, err: err.message,
    });
    return { ok: false, reason: 'github_unavailable' };
  }
  const headSha = String(newHead || liveHead || '').toLowerCase();
  if (!SHA_RE.test(headSha) || !sameSha(liveHead, headSha)) {
    return { ok: false, reason: 'branch_moved', headSha: liveHead || null };
  }
  if (pinsCurrent(session, headSha)) {
    return { ok: true, applied: false, unchanged: true, headSha };
  }

  return session.status === 'promoted'
    ? adoptPromoted({ config, pool, session, headSha, deps })
    : adoptActive({ config, pool, session, headSha, deps });
}

module.exports = {
  reconcileCliHandoffSync,
  _repoOf: repoOf,
  _pinsCurrent: pinsCurrent,
};
