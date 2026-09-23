'use strict';

const { Router, json } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const appAdmins = require('../services/app-admins');
const log = require('../services/logger');
const orchestrator = require('../services/visual-evidence-orchestrator');
const plan = require('../services/visual-evidence-plan');
const state = require('../services/visual-evidence-state');
const view = require('../services/visual-evidence-view');
const { visualHeadForSession } = require('../services/pr-vote-revision');

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
    'id, slug, created_by, collab_visibility, view_visibility'
  );
  if (!app) return null;
  const { rows } = await pool.query(
    `SELECT cs.* FROM chat_sessions cs WHERE cs.id = $1 AND cs.app_id = $2`,
    [id, app.id]
  );
  return rows[0] ? { app, session: { ...rows[0], app_slug: app.slug } } : null;
}

function sendError(res, err) {
  const status = Number(err?.status) || (err?.code === 'invalid_visual_evidence' ? 400 : 409);
  return res.status(status).json({
    error: err?.code || 'visual_evidence_error',
    message: String(err?.message || 'The visual change preview could not be updated.').slice(0, 2000),
  });
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

function visualEvidenceRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/apps/:slug/proposals/:sessionId/evidence', async (req, res) => {
    const id = sessionId(req.params.sessionId);
    if (!id) return res.status(404).json({ error: 'Proposal not found' });
    try {
      const ctx = await loadContext(pool, req.params.slug, id, req.user, 'view');
      if (!ctx) return res.status(404).json({ error: 'Proposal not found' });
      return res.json({
        visualEvidence: config.visualEvidence?.present
          ? await view.getForSession(pool, ctx.session, ctx.app.slug)
          : null,
      });
    } catch (err) {
      log.error('visual-evidence', 'Evidence status read failed', { sessionId: id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The proposal owner and app managers can inspect the current run while it
  // is active, or an older run by id after a retry. The public evidence view
  // contains only the reviewer result; this private view supports diagnosis.
  router.get('/api/apps/:slug/proposals/:sessionId/evidence/diagnostics', async (req, res) => {
    const id = sessionId(req.params.sessionId);
    if (!config.visualEvidence?.present || !id) return res.status(404).json({ error: 'Evidence diagnostics not found' });
    try {
      const ctx = await loadContext(pool, req.params.slug, id, req.user, 'view');
      if (!ctx || (ctx.session.user_id !== req.user?.id
          && !(await appAdmins.canManageApp(pool, ctx.app, req.user)))) {
        return res.status(404).json({ error: 'Evidence diagnostics not found' });
      }
      const runId = req.query.runId || ctx.session.visual_evidence_run_id;
      if (!runId && req.query.runId == null) {
        const reason = ctx.session.visual_evidence_detail?.notStartedReason;
        if (!reason) return res.status(404).json({ error: 'Evidence diagnostics not found' });
        res.set({
          'Cache-Control': 'private, no-store',
          Vary: 'Cookie, Authorization',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.json({ diagnostics: {
          runId: null,
          state: ctx.session.visual_evidence_state || 'planned',
          headSha: visualHeadForSession(ctx.session),
          notStartedReason: String(reason).slice(0, 300),
        } });
      }
      if (!ARTIFACT_ID_RE.test(String(runId || ''))) {
        return res.status(404).json({ error: 'Evidence diagnostics not found' });
      }
      const { rows } = await pool.query(
        `SELECT id, base_sha, head_sha, state, replay_plan, plan_hash,
                trace_summary, failure_code, failure_reason, trigger,
                author_plan IS NOT NULL AS author_plan_supplied,
                fixture_fingerprint, base_image_digest, head_image_digest,
                repair_attempt, created_at, started_at, completed_at, updated_at
           FROM visual_evidence_runs
          WHERE id = $1 AND session_id = $2`,
        [runId, id]
      );
      const run = rows[0];
      if (!run) return res.status(404).json({ error: 'Evidence diagnostics not found' });
      const replayPlan = run.replay_plan ? plan.parseReplayPlan(run.replay_plan) : null;
      if (replayPlan && plan.planHash(replayPlan) !== run.plan_hash) {
        throw new Error('Stored evidence replay plan hash does not match its plan.');
      }
      const trace = run.trace_summary && typeof run.trace_summary === 'object'
        ? run.trace_summary : {};
      const artifacts = await pool.query(
        `SELECT story_id, viewport, side, variant, media, bytes, width, height, sha256
           FROM visual_evidence_artifacts
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
        currentRun: run.id === ctx.session.visual_evidence_run_id,
        state: run.state,
        baseSha: run.base_sha,
        headSha: run.head_sha,
        trigger: run.trigger || null,
        authorPlanSupplied: run.author_plan_supplied === true,
        createdAt: run.created_at || null,
        startedAt: run.started_at || null,
        completedAt: run.completed_at || null,
        updatedAt: run.updated_at || null,
        repairAttempt: Number(run.repair_attempt || 0),
        provenance: {
          fixtureFingerprint: run.fixture_fingerprint || null,
          baseImageDigest: run.base_image_digest || null,
          headImageDigest: run.head_image_digest || null,
        },
        planHash: run.plan_hash,
        replayPlan,
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
        trace: {
          progress: trace.progress || null,
          timingsMs: trace.timingsMs || null,
          replayPasses: trace.replayPasses || [],
          replayRuntime: trace.replayRuntime || null,
          lastReplayEvent: trace.lastReplayEvent || null,
          replayEvents: trace.replayEvents || [],
          agentAttempts: trace.agentAttempts || 0,
          agentDispatches: trace.agentDispatches || [],
          repairCount: trace.repairCount || 0,
          planSource: trace.planSource || null,
          tokenUsage: trace.tokenUsage || null,
          artifactBytes: trace.artifactBytes || 0,
          runs: trace.runs || 0,
          stories: trace.stories || [],
          relativePointer: trace.relativePointer === true,
          terminalFailureClass: trace.terminalFailureClass || null,
          failure: trace.failure || null,
          control: trace.control || null,
        },
      } });
    } catch (err) {
      log.error('visual-evidence', 'Evidence diagnostics read failed', { sessionId: id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/apps/:slug/proposals/:sessionId/evidence/:artifactId', async (req, res) => {
    const id = sessionId(req.params.sessionId);
    if (!config.visualEvidence?.present || !id || !ARTIFACT_ID_RE.test(String(req.params.artifactId || ''))) {
      return res.status(404).json({ error: 'Evidence artifact not found' });
    }
    try {
      const ctx = await loadContext(pool, req.params.slug, id, req.user, 'view');
      if (!ctx) return res.status(404).json({ error: 'Evidence artifact not found' });
      const { rows } = await pool.query(
        `SELECT a.data, a.content_type, a.bytes, a.sha256
           FROM visual_evidence_artifacts a
           JOIN visual_evidence_runs r ON r.id = a.run_id
           JOIN chat_sessions s ON s.id = r.session_id
          WHERE a.id = $1 AND s.id = $2 AND s.app_id = $3
            AND s.visual_evidence_run_id = r.id
            AND s.visual_evidence_state = 'verified' AND r.state = 'verified'
            AND r.head_sha = COALESCE(
                  CASE WHEN s.source = 'imported'
                    THEN s.imported_pr_head_sha
                    ELSE s.reviewed_head_sha
                  END,
                  s.checks_commit_sha,
                  s.handoff_head_sha
                )`,
        [req.params.artifactId, id, ctx.app.id]
      );
      const artifact = rows[0];
      if (!artifact) return res.status(404).json({ error: 'Evidence artifact not found' });
      const data = Buffer.isBuffer(artifact.data) ? artifact.data : Buffer.from(artifact.data || '');
      const range = parseRange(req.headers.range, data.length);
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
        res.set('Content-Range', `bytes */${data.length}`);
        return res.status(416).end();
      }
      if (range) {
        res.status(206);
        res.set({
          'Content-Range': `bytes ${range.start}-${range.end}/${data.length}`,
          'Content-Length': String(range.end - range.start + 1),
        });
        return res.end(data.subarray(range.start, range.end + 1));
      }
      res.set('Content-Length', String(data.length));
      return res.end(data);
    } catch (err) {
      log.error('visual-evidence', 'Evidence artifact read failed', { sessionId: id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The agent that wrote the revision may submit its executable UI flow.
  // It cannot submit media or a verdict: the ordinary paired replay generates
  // and checks every PNG/WebM artifact; people review what the media shows.
  router.post('/api/apps/:slug/proposals/:sessionId/evidence/plan',
    json({ limit: '512kb' }), async (req, res) => {
      const id = sessionId(req.params.sessionId);
      if (!id) return res.status(404).json({ error: 'Proposal not found' });
      if (!config.visualEvidence?.execute) {
        return res.status(503).json({ error: 'visual_evidence_disabled' });
      }
      try {
        const ctx = await loadContext(pool, req.params.slug, id, req.user, 'collab');
        if (!ctx || ctx.session.user_id !== req.user?.id) {
          return res.status(404).json({ error: 'Proposal not found' });
        }
        if (!['active', 'promoted'].includes(ctx.session.status)) {
          return res.status(409).json({ error: 'proposal_not_open' });
        }
        const currentHead = visualHeadForSession(ctx.session);
        if (!currentHead || req.body?.headSha !== currentHead) {
          return res.status(409).json({
            error: 'evidence_head_moved',
            message: 'Read the proposal’s current head and submit a plan for that exact commit.',
          });
        }
        const accepted = ctx.session.visual_evidence_detail?.intent;
        if (!accepted) {
          return res.status(409).json({ error: 'missing_visual_evidence_intent' });
        }
        const executable = plan.parseReplayPlan(req.body?.plan);
        if (plan.canonicalJson(plan.semanticIntentFromPlan(executable))
            !== plan.canonicalJson(plan.parseIntent(accepted))) {
          return res.status(409).json({
            error: 'evidence_intent_mismatch',
            message: 'The replay plan must preserve the accepted visual claims.',
          });
        }
        if (ctx.session.visual_evidence_run_id) {
          if (ctx.session.visual_evidence_state === 'failed') {
            await state.rerunSameHead(pool, ctx.session.visual_evidence_run_id, {
              trigger: 'author-plan',
              authorPlan: executable,
            });
          } else if (ctx.session.visual_evidence_state !== 'planned') {
            return res.status(409).json({
              error: 'evidence_run_in_progress',
              message: 'The current visual evidence run must finish before the author can resubmit its plan.',
            });
          }
        }
        const scheduled = await orchestrator.scheduleForSession(config, {
          pool, sessionId: id, headSha: currentHead, trigger: 'author-plan',
          authorPlan: executable,
        });
        if (!scheduled.scheduled) {
          if (scheduled.reason === 'head_moved') {
            return res.status(409).json({
              error: 'evidence_head_moved',
              message: 'The proposal head moved while the replay was being scheduled.',
            });
          }
          return res.status(409).json({
            error: 'evidence_run_in_progress',
            message: `The visual evidence run could not start (${scheduled.reason}).`,
          });
        }
        return res.status(202).json({
          ok: true, runId: scheduled.runId, visualEvidenceState: 'provisioning',
          headSha: currentHead,
        });
      } catch (err) {
        if (err?.code || err instanceof plan.VisualEvidenceValidationError) return sendError(res, err);
        log.error('visual-evidence', 'Author replay plan failed', { sessionId: id, err: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    });

  router.post('/api/apps/:slug/proposals/:sessionId/evidence/rerun', async (req, res) => {
    const id = sessionId(req.params.sessionId);
    if (!id) return res.status(404).json({ error: 'Proposal not found' });
    try {
      const ctx = await loadContext(pool, req.params.slug, id, req.user, 'collab');
      if (!ctx) return res.status(404).json({ error: 'Proposal not found' });
      const canManage = ctx.session.user_id === req.user?.id
        || await appAdmins.canManageApp(pool, ctx.app, req.user);
      if (!canManage) return res.status(404).json({ error: 'Proposal not found' });
      let replacement;
      if (req.body?.visualEvidence !== undefined) replacement = plan.parseIntent(req.body.visualEvidence);
      const currentId = ctx.session.visual_evidence_run_id;
      let run;
      if (currentId) {
        run = await state.rerunSameHead(pool, currentId, {
          trigger: 'manual-rerun', intent: replacement || null,
        });
      } else if (replacement) {
        await state.recordIntent(pool, id, replacement);
      } else if (!ctx.session.visual_evidence_detail?.intent) {
        return res.status(409).json({
          error: 'missing_visual_evidence_intent',
          message: 'Add a visual change preview claim and user flow before rerunning it.',
        });
      }
      const scheduled = await orchestrator.scheduleForSession(config, {
        pool, sessionId: id, headSha: run?.head_sha || null, trigger: 'manual-rerun',
      });
      return res.status(202).json({
        ok: true,
        runId: run?.id || scheduled.runId || null,
        visualEvidenceState: run?.state || 'planned',
      });
    } catch (err) {
      if (err?.code || err instanceof plan.VisualEvidenceValidationError) return sendError(res, err);
      log.error('visual-evidence', 'Evidence rerun failed', { sessionId: id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/proposals/:sessionId/evidence/override', async (req, res) => {
    const id = sessionId(req.params.sessionId);
    if (!id) return res.status(404).json({ error: 'Proposal not found' });
    try {
      const ctx = await loadContext(pool, req.params.slug, id, req.user, 'collab');
      if (!ctx) return res.status(404).json({ error: 'Proposal not found' });
      if (!(await appAdmins.canManageApp(pool, ctx.app, req.user))) {
        return res.status(404).json({ error: 'Proposal not found' });
      }
      if (!ctx.session.visual_evidence_run_id) {
        return res.status(409).json({ error: 'visual_evidence_run_missing', message: 'There is no current visual change preview run to override.' });
      }
      const run = await state.overrideRun(pool, ctx.session.visual_evidence_run_id, {
        userId: req.user.id,
        reason: req.body?.reason,
      });
      return res.json({ ok: true, runId: run.id, visualEvidenceState: run.state });
    } catch (err) {
      if (err?.code) return sendError(res, err);
      log.error('visual-evidence', 'Evidence override failed', { sessionId: id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { visualEvidenceRoutes, sessionId, parseRange, loadContext };
