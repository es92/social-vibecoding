'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const appAdmins = require('../services/app-admins');
const log = require('../services/logger');
const shots = require('../services/shots-files');
const plan = require('../services/visible-changes');
const state = require('../services/shots-state');
const view = require('../services/shots-view');
const mediaStore = require('../services/media-store');
const { visualHeadForSession } = require('../services/pr-vote-revision');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

const ARTIFACT_ID_RE = /^[0-9a-f]{32}$/;

function sessionId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

async function loadContext(pool, slug, id, user, level = 'view') {
  const app = await appAccess.getAppForUser(
    pool,
    slug,
    user,
    level,
    'id, slug, repo_url, created_by, collab_visibility, view_visibility'
  );
  if (!app) return null;
  const { rows } = await pool.query(
    `SELECT cs.* FROM chat_sessions cs WHERE cs.id = $1 AND cs.app_id = $2`,
    [id, app.id]
  );
  return rows[0] ? { app, session: { ...rows[0], app_slug: app.slug } } : null;
}

function sendError(res, err) {
  const status = Number(err?.status) || (err?.code === 'invalid_visible_changes' ? 400 : 409);
  return res.status(status).json({
    error: err?.code || 'shots_error',
    message: String(err?.message || 'The before & after shots could not be updated.').slice(0, 2000),
  });
}

// The shots machine's refusals, as the shots routes always answered them.
const REFUSALS = new Map([
  ['not_authorized', 'Your current permissions do not allow that action.'],
  ['shots_rerun_in_flight', 'Wait for the current shots to finish before taking them again.'],
  ['missing_visible_changes', 'Declare the change and how to reach it before taking the shots again.'],
  ['closed', 'This proposal is closed, so its shots are not taken again.'],
  ['invalid_shots_override_state', 'These before & after shots cannot be waived now.'],
]);
function refused(res, reason) {
  const code = String(reason || 'shots_refused');
  return res.status(code === 'not_authorized' ? 403 : 409).json({ error: code, message: REFUSALS.get(code) || 'The before & after shots could not do that now.' });
}

function parseRange(header, total) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || start >= total) return false;
  return { start, end: Math.min(end, total - 1) };
}

const LEGACY_PATH_RE = /^(\/api\/apps\/[^/?]+\/proposals\/[^/?]+\/)evidence(?=[/?]|$)/;

function shotsRoutes(config, { store = mediaStore.getStore(config) } = {}) {
  const router = Router();
  const pool = getPool(config);

  // These routes were /evidence before the rename. A tab still running the
  // previous release's shell, and a link copied from it, keep working.
  router.use((req, _res, next) => {
    const legacy = LEGACY_PATH_RE.exec(req.url);
    if (legacy) req.url = `${legacy[1]}shots${req.url.slice(legacy[0].length)}`;
    next();
  });

  router.get('/api/apps/:slug/proposals/:sessionId/shots', async (req, res) => {
    const id = sessionId(req.params.sessionId);
    if (!id) return res.status(404).json({ error: 'Proposal not found' });
    try {
      const ctx = await loadContext(pool, req.params.slug, id, req.user, 'view');
      if (!ctx) return res.status(404).json({ error: 'Proposal not found' });
      return res.json({
        shots: config.shots?.present
          ? await view.getForSession(pool, ctx.session, ctx.app.slug, { viewer: req.user })
          : null,
      });
    } catch (err) {
      log.error('shots', 'Shots status read failed', { sessionId: id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The proposal owner and app managers can inspect the current run while it
  // is active, or an older run by id after a retry. The public shots view
  // contains only the reviewer result; this private view supports diagnosis.
  const agentProgress = async (runId) => {
    const { rows: [row] } = await pool.query('SELECT progress FROM shot_run_control WHERE run_id = $1', [runId]);
    return row?.progress || null;
  };
  router.get('/api/apps/:slug/proposals/:sessionId/shots/diagnostics', async (req, res) => {
    const id = sessionId(req.params.sessionId);
    if (!config.shots?.present || !id) return res.status(404).json({ error: 'Shots diagnostics not found' });
    try {
      const ctx = await loadContext(pool, req.params.slug, id, req.user, 'view');
      if (!ctx || (ctx.session.user_id !== req.user?.id
          && !(await appAdmins.canManageApp(pool, ctx.app, req.user)))) {
        return res.status(404).json({ error: 'Shots diagnostics not found' });
      }
      const runId = req.query.runId || ctx.session.shots_run_id;
      if (!runId && req.query.runId == null) {
        const reason = ctx.session.shots_detail?.notStartedReason;
        if (!reason) return res.status(404).json({ error: 'Shots diagnostics not found' });
        res.set({
          'Cache-Control': 'private, no-store',
          Vary: 'Cookie, Authorization',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.json({ diagnostics: {
          runId: null,
          state: ctx.session.shots_state || 'planned',
          headSha: visualHeadForSession(ctx.session),
          notStartedReason: String(reason).slice(0, 300),
        } });
      }
      if (!ARTIFACT_ID_RE.test(String(runId || ''))) {
        return res.status(404).json({ error: 'Shots diagnostics not found' });
      }
      const { rows } = await pool.query(
        `SELECT id, base_sha, head_sha, state, plan_hash, hard_verdict,
                trace_summary, failure_code, failure_reason, trigger,
                fixture_fingerprint, base_image_digest, head_image_digest,
                created_at, started_at, completed_at, updated_at
           FROM shot_runs
          WHERE id = $1 AND session_id = $2`,
        [runId, id]
      );
      const run = rows[0];
      if (!run) return res.status(404).json({ error: 'Shots diagnostics not found' });
      const trace = run.trace_summary && typeof run.trace_summary === 'object'
        ? run.trace_summary : {};
      const artifacts = await pool.query(
        `SELECT story_id, viewport, side, variant, media, bytes, width, height, sha256
           FROM shot_artifacts
          WHERE run_id = $1
          ORDER BY story_id, viewport, side, variant
          LIMIT 256`,
        [run.id]
      );
      res.set({
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie, Authorization',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.json({ diagnostics: {
        runId: run.id,
        currentRun: run.id === ctx.session.shots_run_id,
        state: run.state,
        baseSha: run.base_sha,
        headSha: run.head_sha,
        trigger: run.trigger || null,
        createdAt: run.created_at || null,
        startedAt: run.started_at || null,
        completedAt: run.completed_at || null,
        updatedAt: run.updated_at || null,
        provenance: {
          fixtureFingerprint: run.fixture_fingerprint || null,
          baseImageDigest: run.base_image_digest || null,
          headImageDigest: run.head_image_digest || null,
        },
        // The hash of exactly which shots were published.
        planHash: run.plan_hash,
        // As stored, except that a ready change whose before and after came
        // out the same reads 'unchanged', as every result does.
        shotResults: shots.isShotsVerdict(run.hard_verdict) && Array.isArray(run.hard_verdict.stories)
          ? run.hard_verdict.stories.map((story) => (story?.status === 'ready'
            ? { ...story, status: shots.resultStatus(story) } : story))
          : [],
        // What the shots agent noticed broken on the after build, as stored.
        shotNotices: shots.isShotsVerdict(run.hard_verdict) && Array.isArray(run.hard_verdict.notices)
          ? run.hard_verdict.notices : [],
        artifacts: artifacts.rows.map((artifact) => ({
          storyId: artifact.story_id,
          viewport: artifact.viewport,
          side: artifact.side,
          variant: artifact.variant,
          media: artifact.media,
          bytes: artifact.bytes,
          width: artifact.width,
          height: artifact.height,
          sha256: artifact.sha256,
        })),
        failureCode: run.failure_code,
        failureReason: run.failure_reason,
        // What the agent is doing now, from its workspace (while it exists).
        agentProgress: run.id === ctx.session.shots_run_id ? await agentProgress(run.id) : null,
        trace: {
          progress: trace.progress || null,
          heartbeat: trace.heartbeat || null,
          timingsMs: trace.timingsMs || null,
          idleWait: trace.idleWait || null,
          agentAttempts: trace.agentAttempts || 0,
          agentDispatches: trace.agentDispatches || [],
          agentActivity: trace.agentActivity || null,
          agentFinalResponse: trace.agentFinalResponse || null,
          agentFinalResponses: trace.agentFinalResponses || [],
          planSource: trace.planSource || null,
          tokenUsage: trace.tokenUsage || null,
          artifactBytes: trace.artifactBytes || 0,
          runs: trace.runs || 0,
          stories: trace.stories || [],
          terminalFailureClass: trace.terminalFailureClass || null,
          failure: trace.failure || null,
          control: trace.control || null,
        },
      } });
    } catch (err) {
      log.error('shots', 'Shots diagnostics read failed', { sessionId: id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/apps/:slug/proposals/:sessionId/shots/:artifactId', async (req, res) => {
    const id = sessionId(req.params.sessionId);
    if (!config.shots?.present || !id || !ARTIFACT_ID_RE.test(String(req.params.artifactId || ''))) {
      return res.status(404).json({ error: 'Shots artifact not found' });
    }
    try {
      const ctx = await loadContext(pool, req.params.slug, id, req.user, 'view');
      if (!ctx) return res.status(404).json({ error: 'Shots artifact not found' });
      // A dense still (services/shots-density.js) at its own address, for an
      // account in the New Needs you experiment; anyone else asking for it
      // gets the 1x copy every other address serves.
      const dense = req.query.density === 'device' && await view.viewerSeesDense(pool, req.user);
      const { rows } = await pool.query(
        `SELECT CASE WHEN $4 THEN COALESCE(a.dense_sha256, a.sha256) ELSE a.sha256 END AS sha256,
                CASE WHEN $4 THEN COALESCE(a.dense_object_key, a.object_key) ELSE a.object_key END AS object_key,
                CASE WHEN $4 THEN COALESCE(a.dense_bytes, a.bytes) ELSE a.bytes END AS bytes,
                a.content_type, a.variant
           FROM shot_artifacts a
           JOIN shot_runs r ON r.id = a.run_id
           JOIN chat_sessions s ON s.id = r.session_id
          WHERE a.id = $1 AND s.id = $2 AND s.app_id = $3
            AND s.shots_run_id = r.id
            AND s.shots_state = 'verified' AND r.state = 'verified'
            AND r.head_sha = COALESCE(
                  CASE WHEN s.source = 'imported'
                    THEN s.imported_pr_head_sha
                    ELSE s.reviewed_head_sha
                  END,
                  s.checks_commit_sha,
                  s.handoff_head_sha
                )`,
        [req.params.artifactId, id, ctx.app.id, dense === true]
      );
      const artifact = rows[0];
      // A close-up (services/shots-closeups.js) is only ever shown to an
      // account in the experiment, at its own address.
      if (!artifact || (artifact.variant === 'closeup' && !dense)) return res.status(404).json({ error: 'Shots artifact not found' });
      const size = Number(artifact.bytes);
      const range = parseRange(req.headers.range, size);
      res.set({
        'Content-Type': artifact.content_type,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: `"${artifact.sha256}"`,
        Vary: 'Cookie, Authorization',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      });
      if (range === false) {
        res.set('Content-Range', `bytes */${size}`);
        return res.status(416).end();
      }
      if (range) {
        res.status(206);
        res.set({
          'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
          'Content-Length': String(range.end - range.start + 1),
        });
        return await mediaStore.respond(res, store, artifact, range);
      }
      res.set('Content-Length', String(size));
      return await mediaStore.respond(res, store, artifact);
    } catch (err) {
      log.error('shots', 'Shots artifact read failed', { sessionId: id, err: err.message });
      if (res.headersSent || res.destroyed) return res.destroy();
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Take the shots again (with a new declaration, maybe). The shots machine
  // starts the run; this answers once it has decided.
  router.post('/api/apps/:slug/proposals/:sessionId/shots/rerun', sameOriginBrowserOnly, async (req, res) => {
    const id = sessionId(req.params.sessionId);
    if (!id) return res.status(404).json({ error: 'Proposal not found' });
    try {
      const ctx = await loadContext(pool, req.params.slug, id, req.user, 'collab');
      if (!ctx) return res.status(404).json({ error: 'Proposal not found' });
      const canManage = ctx.session.user_id === req.user?.id
        || await appAdmins.canManageApp(pool, ctx.app, req.user);
      if (!canManage) return res.status(404).json({ error: 'Proposal not found' });
      let replacement;
      const declared = plan.declaredChanges(req.body);
      if (declared !== undefined) replacement = plan.parseIntent(declared);
      if (!replacement && !ctx.session.shots_detail?.intent) {
        return res.status(409).json({
          error: 'missing_visible_changes',
          message: 'Declare the change and how to reach it before taking the shots again.',
        });
      }
      const out = await state.retryShots({
        sessionId: id, appId: ctx.app.id, intent: replacement || null, actor: `user:${req.user.id}`,
      });
      if (out.status === 'rejected' || out.status === 'faulted') return refused(res, out.reason);
      return res.status(202).json({
        ok: true,
        runId: out.reply?.runId || null,
        shotsState: out.reply?.state || 'planned',
      });
    } catch (err) {
      if (err?.code || err instanceof plan.VisibleChangesValidationError) return sendError(res, err);
      log.error('shots', 'Shots rerun failed', { sessionId: id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Stop the running before/after shots. The same people as Rerun, which is
  // how a stopped run is started again.
  router.post('/api/apps/:slug/proposals/:sessionId/shots/stop', sameOriginBrowserOnly, async (req, res) => {
    const id = sessionId(req.params.sessionId);
    if (!id) return res.status(404).json({ error: 'Proposal not found' });
    try {
      const ctx = await loadContext(pool, req.params.slug, id, req.user, 'collab');
      if (!ctx) return res.status(404).json({ error: 'Proposal not found' });
      const canManage = ctx.session.user_id === req.user?.id
        || await appAdmins.canManageApp(pool, ctx.app, req.user);
      if (!canManage) return res.status(404).json({ error: 'Proposal not found' });
      const runId = ctx.session.shots_run_id || null;
      const out = await state.stopShots({ sessionId: id, appId: ctx.app.id, actor: `user:${req.user.id}` });
      if (out.status === 'rejected') return res.json({ stopped: false, reason: 'not_running' });
      if (out.status === 'faulted') return refused(res, out.reason);
      return res.json({ stopped: true, runId: out.reply?.runId || runId });
    } catch (err) {
      if (err?.code) return sendError(res, err);
      log.error('shots', 'Shots stop failed', { sessionId: id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/proposals/:sessionId/shots/override', sameOriginBrowserOnly, async (req, res) => {
    const id = sessionId(req.params.sessionId);
    if (!id) return res.status(404).json({ error: 'Proposal not found' });
    try {
      const ctx = await loadContext(pool, req.params.slug, id, req.user, 'collab');
      if (!ctx) return res.status(404).json({ error: 'Proposal not found' });
      if (!(await appAdmins.canManageApp(pool, ctx.app, req.user))) {
        return res.status(404).json({ error: 'Proposal not found' });
      }
      if (!ctx.session.shots_run_id) {
        return res.status(409).json({ error: 'shots_run_missing', message: 'There are no current before & after shots to override.' });
      }
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : '';
      if (!reason) {
        return res.status(400).json({ error: 'invalid_shots_override', message: 'An authorized user and visible override reason are required.' });
      }
      const out = await state.waiveShots({ sessionId: id, appId: ctx.app.id, userId: req.user.id, reason });
      if (out.status === 'rejected' || out.status === 'faulted') return refused(res, out.reason);
      return res.json({ ok: true, runId: out.reply?.runId || ctx.session.shots_run_id, shotsState: out.reply?.state || 'overridden' });
    } catch (err) {
      if (err?.code) return sendError(res, err);
      log.error('shots', 'Shots override failed', { sessionId: id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { shotsRoutes, sessionId, parseRange, loadContext };
