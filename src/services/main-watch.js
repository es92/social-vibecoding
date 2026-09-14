'use strict';

// Main watch — the safety net under direct merges.
//
// A proposal's checks judge its own head against the main of the time
// (services/check-admission.js). Under direct-merge lanes it then merges as
// it stands, so every merge lands a tree that nobody has run the checks
// against AS A WHOLE: two proposals that each pass alone can fail together,
// and the old bring-up-to-date-then-re-check step that used to catch that
// is gone on purpose — it cost a worker sync and a full re-run per sibling
// per merge (#2100's thundering herd).
//
// So the check moves to where the whole tree exists: after each merge, the
// repo's own unit suite runs once more on the merge commit. Green is the
// common case and costs one container that nobody waits on. Red PAUSES the
// app's merges — checkAndMerge's main_healthy gate refuses every proposal
// until a fix lands (the next merge that comes back green) or an admin
// resumes them (POST /api/apps/:slug/main-check/resume, an explicit "I know").
// Nothing is rolled back and nothing is blamed: the culprit is whatever
// landed since the last green, which the group can see.
//
// Only the unit suite. The dapp.json assertions need a built preview of
// main, which is production itself; a red production is caught by the
// deploy's own health check and the rollback that follows it.
//
// State lives on the apps row (main_check_*; see schema.sql). Every write is
// compare-and-swap on the merge commit, so a slow run for an older merge
// cannot overwrite the verdict for a newer one.

const log = require('./logger');
const unitSuite = require('./unit-suite');

function isEnabled() {
  const v = String(process.env.MAIN_WATCH_ENABLED ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function parseRepo(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function short(sha) {
  return sha ? String(sha).slice(0, 7) : '';
}

// A row's main-watch block, in the shape the API serializes. Never throws
// and is correct on a row that predates the columns (state null: never run).
function describe(appRow) {
  const a = appRow || {};
  const state = a.main_check_state || null;
  const sha = a.main_check_sha || null;
  const resumedSha = a.main_check_resumed_sha || null;
  const paused = state === 'failing' && !!sha
    && String(resumedSha || '').toLowerCase() !== String(sha).toLowerCase();
  return {
    state,
    sha,
    at: a.main_check_at ? new Date(a.main_check_at).toISOString() : null,
    detail: a.main_check_detail && typeof a.main_check_detail === 'object' ? a.main_check_detail : null,
    resumedSha,
    paused,
  };
}

/** Is this app's merging paused by a red main? */
async function mergePause(pool, appId) {
  if (!pool || appId == null) return { paused: false, state: null };
  try {
    const { rows } = await pool.query(
      `SELECT main_check_state, main_check_sha, main_check_at, main_check_detail,
              main_check_resumed_sha
         FROM apps WHERE id = $1`,
      [appId]
    );
    return describe(rows[0]);
  } catch (err) {
    // An unreadable row must not wedge every merge on the app; the pause is
    // a safety net, and a net that cannot be read is not a net that caught
    // something.
    log.warn('main-watch', 'pause read failed; not pausing', { appId, err: err.message });
    return { paused: false, state: null, error: err.message };
  }
}

// The verdict a run produced, from the unit-suite row. 'error' is a run
// that could not happen — the clone or the install failed, or the runner
// was killed at its deadline — and says nothing about main, so it pauses
// nothing. A verdict about the code is 'passing' or 'failing'.
function classify(outcome) {
  if (!outcome || !outcome.row) return { state: 'skipped', detail: { reason: 'no runnable test script' } };
  const row = outcome.row;
  const detail = {
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
  };
  if (row.status === 'pass') return { state: 'passing', detail };
  const reason = String(row.failureReason || '');
  if (/^Suite setup failed/.test(reason) || /^Suite run exceeded/.test(reason)) {
    return { state: 'error', detail };
  }
  return { state: 'failing', detail };
}

/**
 * Run the suite on a merge commit and record what it said. Fire-and-forget
 * from finalizeMerge; never throws.
 */
async function afterMerge(config, pool, { app, session = null, mergeSha } = {}) {
  if (!isEnabled() || !pool || !app || !mergeSha) return null;
  const parsed = parseRepo(app.repo_url);
  if (!parsed) return null;
  const prNumber = session && session.pr_number ? Number(session.pr_number) : null;
  const startedDetail = { prNumber, sessionId: session ? session.id : null };

  // Claim the sha. The CTE reads the state this run supersedes, which is
  // how a red→green transition is noticed below.
  let previous = null;
  try {
    const { rows } = await pool.query(
      `WITH prev AS (
         SELECT main_check_state AS was_state, main_check_sha AS was_sha FROM apps WHERE id = $1
       )
       UPDATE apps
          SET main_check_state = 'running', main_check_sha = $2,
              main_check_at = NOW(), main_check_detail = $3::jsonb
        WHERE id = $1
    RETURNING (SELECT was_state FROM prev) AS was_state, (SELECT was_sha FROM prev) AS was_sha`,
      [app.id, mergeSha, JSON.stringify(startedDetail)]
    );
    previous = rows[0] || null;
  } catch (err) {
    log.warn('main-watch', 'claim failed; not running', { appId: app.id, err: err.message });
    return null;
  }
  // A red sha that an admin resumed stays resumed for THAT sha only; a new
  // merge is a new question, and the column says so by no longer matching.

  log.info('main-watch', 'Running the unit suite on main', {
    appId: app.id, slug: app.slug, sha: mergeSha, prNumber,
  });
  let verdict;
  try {
    const outcome = await unitSuite.maybeRunUnitSuite({
      config, pool, appId: app.id,
      // Not a proposal's run: named for the app so a session's own cleanup
      // (kubernetes.cancelPreviewChecks matches on `s<sessionId>-`) cannot
      // take it down, and so the container name is stable per app.
      sessionId: `main-${app.id}`,
      repoOwner: parsed.owner, repoName: parsed.repo, ref: mergeSha, prNumber: null,
    });
    verdict = classify(outcome);
  } catch (err) {
    verdict = { state: 'error', detail: { failureReason: String(err && err.message || err).slice(0, 600) } };
  }
  const detail = { ...startedDetail, ...verdict.detail };

  let stored = false;
  try {
    const write = await pool.query(
      `UPDATE apps
          SET main_check_state = $3, main_check_at = NOW(), main_check_detail = $4::jsonb
        WHERE id = $1 AND main_check_sha = $2`,
      [app.id, mergeSha, verdict.state, JSON.stringify(detail)]
    );
    stored = write.rowCount !== 0;
  } catch (err) {
    log.warn('main-watch', 'verdict write failed', { appId: app.id, sha: mergeSha, err: err.message });
    return null;
  }
  if (!stored) {
    log.info('main-watch', 'Discarded a verdict for a superseded merge', { appId: app.id, sha: mergeSha });
    return null;
  }
  log.info('main-watch', `main is ${verdict.state}`, {
    appId: app.id, slug: app.slug, sha: mergeSha, prNumber, state: verdict.state,
  });

  const prRef = prNumber ? `PR #${prNumber}` : 'the last merge';
  if (verdict.state === 'failing') {
    const reason = detail.failureReason ? ` ${String(detail.failureReason).slice(0, 400)}` : '';
    await postGroup(pool, app.id,
      `⚠️ main's unit suite is failing after ${prRef} merged (${short(mergeSha)}).${reason} `
      + 'Merges for this app are paused until a fix lands or an admin resumes them.');
  } else if (verdict.state === 'passing' && previous && previous.was_state === 'failing') {
    await postGroup(pool, app.id,
      `main's unit suite is green again after ${prRef} merged (${short(mergeSha)}). Merges resume.`);
    // The pause lifted; whatever was approved meanwhile can go.
    try {
      require('./merge-queue').enqueue(config, app.id);
    } catch (err) {
      log.warn('main-watch', 'post-green enqueue failed', { appId: app.id, err: err.message });
    }
  }
  return { state: verdict.state, sha: mergeSha, detail };
}

/**
 * An admin's "resume merges" for the current red sha. Returns the block the
 * API serializes, or null when there was nothing to resume.
 */
async function resume(config, pool, appId, { by = null } = {}) {
  const { rows } = await pool.query(
    `UPDATE apps
        SET main_check_resumed_sha = main_check_sha
      WHERE id = $1 AND main_check_state = 'failing' AND main_check_sha IS NOT NULL
    RETURNING main_check_state, main_check_sha, main_check_at, main_check_detail, main_check_resumed_sha`,
    [appId]
  );
  if (!rows[0]) return null;
  log.info('main-watch', 'Merges resumed by an admin', {
    appId, sha: rows[0].main_check_sha, by: by && by.username,
  });
  await postGroup(pool, appId,
    `${by && by.username ? by.username : 'An admin'} resumed merges while main's unit suite is failing (${short(rows[0].main_check_sha)}).`);
  try {
    require('./merge-queue').enqueue(config, appId);
  } catch (err) {
    log.warn('main-watch', 'post-resume enqueue failed', { appId, err: err.message });
  }
  return describe(rows[0]);
}

async function postGroup(pool, appId, content) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(pool, appId, content, 'system');
  } catch (err) {
    log.warn('main-watch', 'group message failed', { appId, err: err.message });
  }
}

module.exports = {
  isEnabled,
  afterMerge,
  mergePause,
  resume,
  describe,
  classify,
};
