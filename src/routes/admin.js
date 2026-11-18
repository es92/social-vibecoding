const appAllowance = require('../services/app-allowance');
const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const { dbExportLimiter, mailTestLimiter, smsTestLimiter, smsTestNumberLimiter } = require('../middleware/rate-limits');
const { clientIp } = require('../services/client-ip');
const { drainGuard } = require('../services/lifecycle');
const log = require('../services/logger');
const limits = require('../services/limits');
const anthropicCredits = require('../services/anthropic-credits');
const dbExport = require('../services/db-export');
const adminAccessReview = require('../services/admin-access-review');
const compliance = require('../services/compliance');
const adminAppsUsage = require('../services/admin-apps-usage');
const appDataRetention = require('../services/app-data-retention');
const events = require('../services/events');
const llmTelemetry = require('../services/llm-telemetry');
const appRollover = require('../services/app-rollover');
const stagingReap = require('../services/staging-reap');
const starterImages = require('../services/starter-images');
// A scheduled job's last run (src/workflow/clock/), wherever it ran.
const clocks = require('../services/clocks');

// The automatic leftover-preview pass, as the Stale previews section shows
// it: the preview-gc clock's last run (src/workflow/clock/services.ts),
// read from any process. `tornDown` is how many it handed on to be taken
// (the clock keeps a run's targets as their count).
async function automaticReap(pool) {
  const intervalMs = stagingReap.staleSweepIntervalMs();
  const s = await clocks.status(pool, 'preview-gc').catch(() => null);
  const items = Number.isInteger(s?.result?.items) ? s.result.items : null;
  return {
    lastRunAt: s?.lastSweepAt || null, intervalMs,
    examined: s?.result?.examined ?? null, abandoned: s?.result?.abandoned ?? null,
    tornDown: items, failed: s?.lastError ? 1 : 0,
  };
}
const stagingEnv = require('../services/staging-env');
const mail = require('../services/mail');
const phoneAuth = require('../services/firebase-phone-auth');
const phoneFailureLog = require('../services/phone-failure-log');
const smsSelect = require('../services/sms/select');
const smsSenders = require('../services/sms/senders');
const mobilePushDiagnostics = require('../services/mobile-push-diagnostics');
const applicationRuntime = require('../services/application-runtime');
const managedOpenRouter = require('../services/openrouter-managed-keys');
const { featuredAppsAdminRoutes } = require('./admin-featured-apps');
const { emailTemplateAdminRoutes } = require('./admin-email-templates');
const { emailImageAdminRoutes } = require('./email-images');
const appStorageCap = require('../services/app-storage-cap');
const appFiles = require('../services/app-files');
const appLimit = require('../services/app-limit');
const previewProjectsSetting = require('../services/preview-projects-setting');
const versionsSetting = require('../services/versions-setting');
const sessionLimit = require('../services/session-limit');
const platformLimits = require('../services/platform-limit-alerts');
const githubBudget = require('../services/github-budget');
const modelCosts = require('../services/model-costs');
const homeroomBot = require('../services/homeroom-bot');
const smallChange = require('../services/small-change');
const shotsExport = require('../services/shots-export');
const shotsDensity = require('../services/shots-density');
const welcomeDm = require('../services/welcome-dm');
const onboarding = require('../services/onboarding');
const journeyLeftOut = require('../services/journey-left-out');
const journey = require('../services/journey');
const journeyDemoData = require('../services/journey-demo');
const growth = require('../services/growth');
const growthDemoData = require('../services/growth-demo');
const onboardingFlows = require('../services/onboarding-flows');
const onboardingFlowsDemo = require('../services/onboarding-flows-demo');
const usernames = require('../services/usernames');
// The CSV writer the topochain admin's two exports share: quoting plus the
// spreadsheet formula-injection guard, documented where it is defined.
const { csvField } = require('./topochain/helpers');
const { computeStandings } = require('../services/topochain/standings');
const {
  accountRecovery,
  withTransaction,
} = require('../services/cli-auth');

// Fixed app-wide key for pg_advisory_xact_lock, dedicated to admin-status
// mutations (revoke-admin and delete-user). Any code path that could drop
// the admin count must take this lock inside its transaction so the
// "at least one admin must remain" invariant is checked and committed
// atomically — two concurrent revokes/deletes can't both observe >1 admin
// and race to zero. Now shared with the platform-variable writes in
// routes/apps.js, which is why the number lives in one module.
const { ADMIN_MUTATION_LOCK } = require('../services/advisory-locks');

// Staging mock data (#555): ANTHROPIC_ADMIN_KEY is unset in staging and
// the credit balance is a platform_settings row nobody will have recorded
// there, so the "Anthropic credits" row would read "Not set up" in every
// preview. See the ?demo=1 branch on GET /api/admin/anthropic-credits.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

function adminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.use('/api/admin', adminMiddleware);

  // #717: content-free usage baseline across Mayor/helper calls and coding
  // agents. Read-only and aggregate-only; view-only admins may inspect it.
  router.get('/api/admin/llm-telemetry', async (req, res) => {
    const rawDays = req.query.days == null ? '14' : String(req.query.days);
    if (!/^\d+$/.test(rawDays)) {
      return res.status(400).json({
        error: `days must be an integer between 1 and ${llmTelemetry.MAX_REPORT_DAYS}`,
      });
    }
    const days = Number(rawDays);
    if (days < 1 || days > llmTelemetry.MAX_REPORT_DAYS) {
      return res.status(400).json({
        error: `days must be an integer between 1 and ${llmTelemetry.MAX_REPORT_DAYS}`,
      });
    }
    try {
      return res.json(await llmTelemetry.aggregateReport(pool, { days }));
    } catch (err) {
      log.warn('admin', 'LLM telemetry aggregate failed', {
        code: err && err.code ? String(err.code).slice(0, 64) : 'query_failed',
      });
      return res.status(500).json({ error: 'Could not load LLM telemetry' });
    }
  });

  // The helper calls per helper and first model (Admin → Homeroom bot →
  // Calls): how fast, how often Haiku answered instead, what they cost.
  // Read-only and aggregate-only, like the report above.
  router.get('/api/admin/homeroom-bot/calls', async (req, res) => {
    const days = Number(req.query.days == null ? 7 : req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > llmTelemetry.MAX_REPORT_DAYS) {
      return res.status(400).json({ error: `days must be an integer between 1 and ${llmTelemetry.MAX_REPORT_DAYS}` });
    }
    try {
      const report = await llmTelemetry.helperCallsReport(pool, { days });
      // Beside each helper its time limit, and the model the helpers ask now.
      const limits = require('../services/llm').HELPER_TIME_LIMIT_MS || {};
      return res.json({
        ...report,
        helperModel: await require('../services/helper-model').current(config, { pool }),
        helpers: report.helpers.map((h) => ({ ...h, limitMs: limits[h.component] || null })),
      });
    } catch (err) {
      log.warn('admin', 'Helper calls report failed', {
        code: err && err.code ? String(err.code).slice(0, 64) : 'query_failed',
      });
      return res.status(500).json({ error: 'Could not load the helper calls' });
    }
  });

  // ── Operations Overview ────────────────────────────────────
  //
  // A lightweight summary for the admin dashboard. The full tree lives on
  // `/status` (admin-gated sections there); this just surfaces the numbers
  // that warrant "something's wrong, go look" follow-up.
  router.get('/api/admin/overview', async (_req, res) => {
    try {
      const status = require('../services/status');
      const data = await status.gather(config, { isAdmin: true });

      const stuckApps = (data.apps || [])
        .filter((a) => a.dbStatus === 'creating' || a.dbStatus === 'error')
        .map((a) => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          dbStatus: a.dbStatus,
          createdBy: a.createdBy,
          createdAt: a.createdAt,
        }));

      const orphanWorkers = (data.workers || [])
        .filter((w) => w.orphan)
        .map((w) => ({
          name: w.name,
          sessionId: w.sessionId,
          appSlug: w.appSlug,
          uptimeSeconds: w.uptimeSeconds,
          sessionArchived: w.sessionArchived,
        }));

      const llmUsage = data.llmUsage || [];
      const totalSpendCents = llmUsage.reduce((sum, u) => sum + (u.costCents || 0), 0);

      res.json({
        stuckApps,
        orphanWorkers,
        llmToday: {
          totalSpendCents,
          users: llmUsage,
        },
      });
    } catch (err) {
      log.error('admin', 'Overview failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Mobile push diagnostics ────────────────────────────────
  //
  // Read-only operational visibility over the private push tables. The
  // response deliberately excludes encrypted registrations, token hashes,
  // service-account material and APNs credentials. View-only admins may use
  // it: diagnosing a device is observation, not a provider mutation.
  router.get('/api/admin/mobile-push/diagnostics', async (req, res) => {
    try {
      const data = await mobilePushDiagnostics.gather(pool, req.query.user);
      res.json({
        runtime: {
          enabled: config.mobilePushEnabled === true,
          environment: config.mobilePushEnvironment || null,
          firebaseProjectId: config.firebaseProjectId || null,
        },
        ...data,
      });
    } catch (err) {
      if (err instanceof mobilePushDiagnostics.MobilePushDiagnosticsInputError) {
        return res.status(400).json({ error: err.message });
      }
      log.error('admin', 'Mobile push diagnostics failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Why an admin's fleet job (a rollover, a reap of previews now) did not
  // start (services/app-rollover.js, staging-reap.js start).
  const FLEET_JOB_REFUSED = new Map([
    ['running', 'Rollover already in progress'],
    ['rollout', 'A platform release is rolling out. Try again in a few minutes.'],
    ['not_armed', 'This job is not available on this deployment.'],
  ]);

  // ── Container rollover ─────────────────────────────────────
  //
  // Recreate every running child-app container with freshly assembled env
  // (see services/app-rollover.js for why an env change needs a container
  // recreate at all). Fire-and-forget with a progress feed: POST asks the
  // container-rollover clock for a run and answers 202 with the job; the
  // work runs on whichever process runs the workflow.

  router.post('/api/admin/rollover', requireAdminWrite, drainGuard, async (req, res) => {
    try {
      // A staging preview has no production containers to roll over (and
      // no docker socket to reach them with). An explicit refusal beats a
      // sweep that fails 35 times.
      if (appRollover.isStagingEnv()) {
        return res.status(400).json({
          error: 'Container rollover is unavailable in staging previews.',
        });
      }
      const { started, reason, job } = await appRollover.start(pool, req.user);
      if (!started) {
        return res.status(409).json({ error: FLEET_JOB_REFUSED.get(reason) || FLEET_JOB_REFUSED.get('running'), reason, job });
      }
      // warn-level: a fleet-wide container recreate is worth finding in
      // the logs later, same stance as the db-export audit lines.
      log.warn('admin', 'Container rollover started', {
        by: req.user.username, jobId: job?.id ?? null,
      });
      res.status(202).json({ job });
    } catch (err) {
      log.error('admin', 'Rollover kickoff failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Read-only, so it stays on the plain adminMiddleware gate — view-only
  // admins can watch a rollover, they just can't start one. This is the
  // page-load + WS-reconnect source of truth (the clock's run, read from
  // any process).
  router.get('/api/admin/rollover', async (req, res) => {
    try {
      // Staging mock data (request-time demo injection): a preview has no
      // real job to show, so the console section would screenshot empty.
      // Never persisted, strictly a no-op outside staging.
      if (appRollover.isStagingEnv() && req.query.demo === '1') {
        return res.json({ job: appRollover.demoJob(), eligible: 5, demo: true });
      }
      const eligible = await appRollover.eligibleCount(config).catch(() => null);
      res.json({
        job: await appRollover.read(pool),
        eligible,
        concurrency: appRollover.concurrency(),
      });
    } catch (err) {
      log.error('admin', 'Rollover status failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Ready-made apps' prebuilt images ───────────────────────
  //
  // Admin > Templates (services/starter-images.js): each ready-made app, the
  // key of its code as this platform build generates it, and where that
  // key's image stands. Reading is for every admin; Rebuild queues a build
  // the leader's next sweep runs, and is refused in a staging preview, which
  // builds nothing.

  router.get('/api/admin/templates', async (req, res) => {
    try {
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        return res.json(starterImages.demoList(config));
      }
      res.json(await starterImages.list(config, getPool(config)));
    } catch (err) {
      log.error('admin', 'Template images listing failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/admin/templates/:id/rebuild', requireAdminWrite, async (req, res) => {
    try {
      if (!starterImages.prebuildsOn()) {
        return res.status(400).json({
          error: 'Images are not built here (a staging preview, or STARTER_PREBUILDS=off).',
        });
      }
      const queued = await starterImages.requestRebuild(config, getPool(config), String(req.params.id || ''));
      if (!queued) {
        return res.status(409).json({ error: 'Not queued: not a ready-made app, or its image is being built now.' });
      }
      log.warn('admin', 'Template image rebuild queued', { by: req.user.username, template: req.params.id });
      res.status(202).json(await starterImages.list(config, getPool(config)));
    } catch (err) {
      log.error('admin', 'Template image rebuild failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Stale staging previews ─────────────────────────────────
  //
  // The preview half of the rollover above. A preview's env is assembled by
  // the platform build that was deployed when it was BUILT, and previews
  // live for weeks — so a platform env change leaves them running happily
  // with stale env. This tears them down; the next Preview click rebuilds any
  // that someone actually wants, with current env, through the existing
  // ensure-staging path. See services/staging-reap.js for the full rationale.
  //
  // #851: staleness is now detected automatically (an env-fingerprint label,
  // services/staging-env.js) and swept on a background pass, so this button
  // is no longer the only remedy. It takes what that pass would take (out of
  // date, or abandoned by a merged, archived or deleted session; never a
  // preview backing a live vote), all at once instead of a few per interval.
  // The GET reports the automatic pass's last run so an admin can tell
  // whether pressing it is even necessary.

  router.post('/api/admin/staging-reap', requireAdminWrite, drainGuard, async (req, res) => {
    try {
      // A staging preview cannot see the fleet it would sweep, so refuse
      // rather than report an empty inventory as a successful sweep. Both
      // production runtimes enumerate their previews (Docker containers,
      // Kubernetes Deployments).
      if (stagingReap.isStagingEnv()) {
        return res.status(400).json({
          error: 'The stale-preview sweep is unavailable in staging previews.',
        });
      }
      const { started, reason, job } = await stagingReap.start(pool, req.user);
      if (!started) {
        const error = reason === 'running' ? 'Sweep already in progress' : FLEET_JOB_REFUSED.get(reason);
        return res.status(409).json({ error: error || 'Sweep already in progress', reason, job });
      }
      // warn-level: a fleet-wide preview teardown is worth finding in the
      // logs later, same stance as the rollover above.
      log.warn('admin', 'Stale preview sweep started', {
        by: req.user.username, jobId: job?.id ?? null,
      });
      res.status(202).json({ job });
    } catch (err) {
      log.error('admin', 'Stale preview sweep kickoff failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Read-only, so it stays on the plain adminMiddleware gate — view-only
  // admins can watch a sweep, they just can't start one.
  router.get('/api/admin/staging-reap', async (req, res) => {
    try {
      const runtimeKind = applicationRuntime.mode(config);
      // Staging mock data (request-time demo injection): a preview has no
      // docker socket, so this section would screenshot empty. Never
      // persisted, strictly a no-op outside staging.
      // `staging` is reported independently of `demo`: the POST is refused in
      // a preview whether or not the reviewer arrived with ?demo=1, so the
      // button must be able to say so either way.
      const staging = stagingReap.isStagingEnv();
      if (staging && req.query.demo === '1') {
        return res.json({
          job: stagingReap.demoJob(),
          ...stagingReap.demoCounts(),
          demo: true,
          staging,
          runtimeKind,
          available: false,
          unavailableReason: 'staging',
          concurrency: stagingReap.concurrency(),
        });
      }
      // `open` is every preview; `stale` is the out-of-date subset and
      // `abandoned` the further ones whose session finished. The button (and
      // the automatic pass) takes `stale` + `abandoned`. All come from one
      // inventory call.
      const counts = await stagingReap.previewCounts(config)
        .catch(() => ({ open: null, stale: null, abandoned: null }));
      // #6157: previews asleep (scaled to no replicas), and the storage
      // their database clones still hold. Null when it cannot be read.
      const asleep = await require('../services/preview-sleep').asleepTotals(pool).catch(() => null);
      res.json({
        job: await stagingReap.read(pool),
        open: counts.open,
        stale: counts.stale,
        abandoned: counts.abandoned,
        asleep,
        sleepAfterMs: require('../services/preview-sleep').sleepAfterMs(config),
        expectedFingerprint: stagingEnv.expectedStagingFingerprint(config),
        automatic: await automaticReap(pool),
        staging,
        runtimeKind,
        available: !staging,
        unavailableReason: staging ? 'staging' : null,
        concurrency: stagingReap.concurrency(),
      });
    } catch (err) {
      log.error('admin', 'Stale preview status failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Users ──────────────────────────────────────────────────

  router.get('/api/admin/users', async (req, res) => {
    try {
      // The all-time programme standings, the same shared aggregate the
      // global leaderboard ranks on, so the Points column here matches it.
      // One query for every user, read off by id below.
      const [standings, { rows }] = await Promise.all([computeStandings(pool, { seasonId: null }), pool.query(
        `SELECT u.id, u.username, u.is_admin, u.admin_readonly, u.app_quota, u.app_quota_requested_at, u.created_at,
                u.daily_limit_cents, u.weekly_limit_cents, u.usernode_pubkey,
                -- #3938: the podium flag the list's inline switch reads and
                -- flips; the same column the v4 toggle-exclude-podium route
                -- updates.
                u.exclude_podium,
                EXISTS (
                  SELECT 1 FROM user_social_identities identity
                   WHERE identity.user_id = u.id
                ) AS social_verified,
                -- #838: the three proofs the identity tier is read from,
                -- the same three limits.getIdentityTier reads per turn.
                EXISTS (
                  SELECT 1 FROM user_social_identities gh
                   WHERE gh.user_id = u.id AND gh.provider = 'github'
                ) AS has_github,
                EXISTS (
                  SELECT 1 FROM user_social_identities xi
                   WHERE xi.user_id = u.id AND xi.provider = 'x'
                ) AS has_x,
                EXISTS (
                  SELECT 1 FROM user_activities zk
                   WHERE zk.user_id = u.id AND zk.source = 'zkpassport'
                ) AS has_zkpassport,
                EXISTS (
                  SELECT 1 FROM user_phone_identities ph WHERE ph.user_id = u.id
                ) AS has_phone,
                identity_rule_exempt(u.id) AS identity_exempt,
                managed.id AS openrouter_key_id,
                managed.status AS openrouter_key_status,
                managed.remote_key_hash AS openrouter_key_hash,
                managed.remote_label AS openrouter_key_label,
                managed.daily_limit_usd AS openrouter_daily_limit_usd,
                managed.limit_reset AS openrouter_limit_reset,
                managed.issued_at AS openrouter_issued_at,
                managed.disabled_at AS openrouter_disabled_at,
                managed.deleted_at AS openrouter_deleted_at,
                (u.id = $1) AS is_self,
                ac.code as activation_code,
                COALESCE(lu.total_cost_cents, 0) as cost_today_cents,
                -- #1788: week-to-date platform-key spend, over the same
                -- Monday-00:00-UTC week the weekly cap is enforced on. A
                -- correlated subquery rather than a second join so the
                -- cost_today_cents join above keeps its one-row shape.
                (SELECT COALESCE(SUM(w.total_cost_cents), 0)
                   FROM llm_usage w
                  WHERE w.user_id = u.id
                    AND w.date >= date_trunc('week', CURRENT_DATE)::date) AS cost_week_cents,
                COALESCE(ac2.n, 0) AS apps_created
         FROM users u
         LEFT JOIN credentials.managed_openrouter_keys managed ON managed.user_id = u.id
         LEFT JOIN activation_codes ac ON ac.used_by = u.id
         LEFT JOIN llm_usage lu ON lu.user_id = u.id AND lu.date = CURRENT_DATE
         LEFT JOIN (
           SELECT created_by, COUNT(*) FILTER (WHERE status <> 'error') AS n
           FROM apps
           GROUP BY created_by
         ) ac2 ON ac2.created_by = u.id
         ORDER BY u.created_at ASC`,
        [req.user.id]
      )]);
      // #838: name the tier on each row so the console shows it and the
      // two readers of the flags can never disagree.
      const pointsByUser = new Map(
        standings.map((s) => [s.user_id, s.total_points])
      );
      res.json(rows.map((row) => ({
        ...row,
        identity_tier: limits.identityTierFromFlags(row).tier,
        total_points: pointsByUser.get(Number(row.id)) || 0,
      })));
    } catch (err) {
      log.error('admin', 'List users failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Company OpenRouter child-key controls. Raw keys are deliberately absent
  // from every admin response: ownership is correlated by local id + remote
  // hash, while the management credential performs provider mutations.
  router.patch('/api/admin/openrouter-keys/:id', requireAdminWrite, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0 || typeof req.body?.disabled !== 'boolean') {
      return res.status(400).json({ error: 'A valid key id and boolean disabled value are required.' });
    }
    try {
      const key = await managedOpenRouter.setDisabled({
        pool, id, disabled: req.body.disabled, config, actorId: req.user.id,
      });
      return res.json({ ok: true, key });
    } catch (err) {
      if (err instanceof managedOpenRouter.ManagedOpenRouterError) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
      }
      log.error('admin', 'Managed OpenRouter key update failed', { id, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/admin/openrouter-keys/:id', requireAdminWrite, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'A valid key id is required.' });
    }
    try {
      const key = await managedOpenRouter.remove({
        pool, id, config, actorId: req.user.id,
      });
      return res.json({ ok: true, key });
    } catch (err) {
      if (err instanceof managedOpenRouter.ManagedOpenRouterError) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
      }
      log.error('admin', 'Managed OpenRouter key removal failed', { id, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Bulk set every user's app-creation quota (see users.app_quota in
  // schema.sql). Body `{ quota }` — a non-negative integer applied to ALL
  // users. Admins are included; since they bypass enforcement this is
  // harmless and keeps the operation simple ("set all to 0", "set all to
  // 3"). Declared BEFORE the per-user `:id` route below: Express matches
  // this distinctly (different segment count), but ordering keeps intent
  // obvious.
  router.put('/api/admin/users/app-quota', requireAdminWrite, async (req, res) => {
    const { quota } = req.body || {};
    const n = Number(quota);
    if (typeof quota !== 'number' || !Number.isInteger(n) || n < 0 || n > 2147483647) {
      return res.status(400).json({ error: 'quota must be a non-negative integer up to 2147483647' });
    }
    try {
      await appAllowance.setQuota(pool, { quota: n, actorId: req.user.id });
      log.info('admin', 'App quota set for all users', { quota: n, by: req.user.username });
      res.json({ ok: true, quota: n });
    } catch (err) {
      log.error('admin', 'Bulk app-quota update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Set one user's app-creation quota (see users.app_quota in schema.sql).
  // Body `{ quota }` — a non-negative integer. Modeled on the per-user
  // daily-limit handler below. Quota 0 means the user cannot create apps;
  // admins bypass enforcement regardless (their quota is cosmetic).
  router.put('/api/admin/users/:id/app-quota', requireAdminWrite, async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0 || userId > 2147483647) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const { quota } = req.body || {};
    const n = Number(quota);
    if (typeof quota !== 'number' || !Number.isInteger(n) || n < 0 || n > 2147483647) {
      return res.status(400).json({ error: 'quota must be a non-negative integer up to 2147483647' });
    }
    try {
      const rows = await appAllowance.setQuota(pool, { userId, quota: n, actorId: req.user.id });
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      log.info('admin', 'App quota updated', {
        id: rows[0].id, username: rows[0].username,
        appQuota: n, by: req.user.username,
      });
      res.json({ ok: true, app_quota: n });
    } catch (err) {
      log.error('admin', 'App quota update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/admin/users/:id/app-quota-request/approve', requireAdminWrite, async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0 || userId > 2147483647) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    try {
      const granted = await appAllowance.grantRequest(pool, { userId, actorId: req.user.id });
      if (!granted) return res.status(409).json({ error: 'This request has already been reviewed or its allowance cannot be increased. Refresh the user list.' });
      log.info('admin', 'App allowance request granted', { userId, quota: granted.app_quota, by: req.user.username });
      res.json({ ok: true, app_quota: granted.app_quota });
    } catch (err) {
      log.error('admin', 'App allowance request approval failed', { message: err.message });
      res.status(500).json({ error: 'Could not approve the request. Please try again.' });
    }
  });

  router.delete('/api/admin/users/:id/app-quota-request', requireAdminWrite, async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0 || userId > 2147483647) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    try {
      await appAllowance.declineRequest(pool, { userId, actorId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('admin', 'App allowance request decline failed', { message: err.message });
      res.status(500).json({ error: 'Could not decline the request. Please try again.' });
    }
  });

  // Set a user's role (issue #311). The three-way role selector in
  // public/admin.html posts here. Role is read live on every request
  // (src/middleware/auth.js), so a change takes effect on the target's
  // next request — no session invalidation needed.
  //
  //   user       → is_admin = FALSE, admin_readonly = FALSE
  //   view_admin → is_admin = TRUE,  admin_readonly = TRUE   (see-only)
  //   admin      → is_admin = TRUE,  admin_readonly = FALSE  (full)
  //
  // Back-compat: an older client posting `{ isAdmin: boolean }` is mapped
  // (true → 'admin', false → 'user').
  //
  // Two server-authoritative guardrails (mirrored in the UI for UX only),
  // both counting FULL admins only — a view-only admin can't promote anyone
  // back, so they don't satisfy the "at least one admin" requirement:
  //   - A full admin can't lower their OWN role (self-lockout).
  //   - The platform must always retain at least one full admin. Enforced
  //     inside a transaction that takes the ADMIN_MUTATION_LOCK advisory
  //     lock, then counts full admins and performs the UPDATE atomically —
  //     two concurrent demotions can't both observe >1 and race to zero.
  //   Setting the last full admin to `view_admin` is blocked the same way
  //   as demoting them to `user`.
  // When an account got the role it holds now, for the access review
  // (#5133). Runs after the role write has committed: the role change is
  // already made, so a failure to note it is logged, never turned into an
  // error for a change that happened.
  async function noteRoleChange(userId, role, by) {
    try {
      await adminAccessReview.recordRoleChange(pool, { userId, role, changedBy: by.id });
    } catch (err) {
      log.error('admin', 'Role change not recorded for the access review', {
        id: userId, role, by: by.username, message: err.message,
      });
    }
  }

  router.post('/api/admin/users/:id/is-admin', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    let role = req.body?.role;
    if (role === undefined && typeof req.body?.isAdmin === 'boolean') {
      role = req.body.isAdmin ? 'admin' : 'user';
    }
    const ROLE_COLUMNS = {
      user:       { is_admin: false, admin_readonly: false },
      view_admin: { is_admin: true,  admin_readonly: true },
      admin:      { is_admin: true,  admin_readonly: false },
    };
    const target = ROLE_COLUMNS[role];
    if (!target) {
      return res.status(400).json({ error: "role must be one of 'user', 'view_admin', 'admin'" });
    }

    const endsFullAdmin = target.is_admin && !target.admin_readonly;

    // Self-protection: a full admin can't set their own role to anything
    // that isn't full admin (re-affirming 'admin' on yourself is a no-op).
    if (userId === req.user.id && !endsFullAdmin) {
      return res.status(400).json({ error: "You can't lower your own admin role." });
    }

    // A change that ENDS in full admin never reduces the full-admin count,
    // so it needs no lock.
    if (endsFullAdmin) {
      try {
        const { rows } = await pool.query(
          `UPDATE users SET is_admin = $1, admin_readonly = $2 WHERE id = $3
           RETURNING id, username, is_admin, admin_readonly`,
          [target.is_admin, target.admin_readonly, userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        log.info('admin', 'Role set', {
          id: rows[0].id, username: rows[0].username, role, by: req.user.username,
        });
        await noteRoleChange(rows[0].id, role, req.user);
        return res.json({
          ok: true, role,
          isAdmin: rows[0].is_admin, adminReadonly: rows[0].admin_readonly,
        });
      } catch (err) {
        log.error('admin', 'Role set failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    // Demotion path (→ user or → view_admin): serialize on the advisory
    // lock, re-count FULL admins, and update inside one transaction so the
    // last-full-admin invariant holds under concurrency.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);

      const { rows: existing } = await client.query(
        'SELECT id, is_admin, admin_readonly, participation_restricted_at FROM users WHERE id = $1',
        [userId]
      );
      if (!existing.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }

      const wasFullAdmin = existing[0].is_admin && !existing[0].admin_readonly && !existing[0].participation_restricted_at;
      if (wasFullAdmin) {
        const { rows: countRows } = await client.query(
          'SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE AND participation_restricted_at IS NULL'
        );
        if (countRows[0].n <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: "Can't drop the last full admin." });
        }
      }

      const { rows } = await client.query(
        `UPDATE users SET is_admin = $1, admin_readonly = $2 WHERE id = $3
         RETURNING id, username, is_admin, admin_readonly`,
        [target.is_admin, target.admin_readonly, userId]
      );
      await client.query('COMMIT');
      log.info('admin', 'Role set', {
        id: rows[0].id, username: rows[0].username, role, by: req.user.username,
      });
      await noteRoleChange(rows[0].id, role, req.user);
      res.json({
        ok: true, role,
        isAdmin: rows[0].is_admin, adminReadonly: rows[0].admin_readonly,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('admin', 'Role set failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // Admin-issued rename (issue tracked in the header of routes/profile.js,
  // which used to say this was unimplemented). Moving someone else's handle
  // is a moderation action, so it skips the self-service route's password
  // check and its 30-day cooldown: those two protections exist to stop a
  // hijacked SESSION from walking the namespace, a threat model that does
  // not apply to a full admin acting through their own gate. Format,
  // reserved-prefix and service-identity protection, and the
  // live-plus-retired-history uniqueness check all still run unchanged,
  // through the same src/services/usernames.js the self-service route uses,
  // so the two paths can never disagree about what a valid rename is.
  router.put('/api/admin/users/:id/username', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId) || userId <= 0 || userId > 2147483647) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const check = usernames.validateUsername(req.body?.username);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const next = check.value;

    try {
      const { rows } = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      const current = rows[0].username;

      // Seeded service accounts (usernode-capture and friends) are found BY
      // NAME at runtime; renaming one breaks a subsystem rather than moving
      // an identity. See usernames.isServiceIdentity's own comment.
      if (usernames.isServiceIdentity(current)) {
        return res.status(403).json({ error: 'This account cannot be renamed.' });
      }

      // An exact no-op is a success, not an error. A case-only change falls
      // through: renameUser treats it as a re-case, which retires nothing.
      if (current === next) {
        return res.json({ ok: true, username: current, retired: null, unchanged: true });
      }
      const recase = current.toLowerCase() === next.toLowerCase();

      const free = await usernames.checkAvailability(pool, next, userId);
      if (!free.available) {
        return res.status(409).json({ error: free.error });
      }

      const result = await usernames.renameUser(pool, userId, next);
      if (!result) return res.status(404).json({ error: 'User not found' });

      log.info('admin', 'Username changed', {
        id: userId, from: current, to: result.username, recase, by: req.user.username,
      });
      if (!recase) {
        try {
          events.record(pool, {
            type: events.EVENT_TYPES.USERNAME_CHANGED,
            userId,
            metadata: { from: current, to: result.username, admin: true, by: req.user.username },
          });
        } catch (err) {
          log.warn('admin', 'Username event record failed', { err: err.message });
        }
      }

      return res.json({ ok: true, username: result.username, retired: result.retired });
    } catch (err) {
      // The unique indexes on users.username and username_history are the
      // backstop behind the availability check above; a race with someone
      // else claiming the same handle lands here.
      if (err.code === '23505') {
        return res.status(409).json({ error: 'That username is taken.' });
      }
      log.error('admin', 'Username change failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/admin/users/:id', requireAdminWrite, async (req, res) => {
    try {
      const result = await require('../services/account-deletion').deleteAccount(pool, {
        userId: Number(req.params.id), actorId: req.user.id, mode: 'admin', confirmation: req.body?.confirmation,
      });
      res.json(result);
          } catch (err) { require('./account-deletion').sendError(res, err); }
  });

  // Admin-issued temporary password (issue #282). The universal recovery
  // path for accounts that can't self-reset with a wallet (no wallet
  // linked, or on plain desktop web). Gated by the same router-level
  // adminMiddleware as every other user route — any admin may issue one,
  // consistent with the rest of admin user-management.
  //
  // We generate a one-time temporary password, store only its bcrypt hash,
  // and return the plaintext exactly ONCE in the response for the admin to
  // relay out-of-band. The plaintext is never logged. Resetting deletes all
  // of the target's sessions so a leaked/old session can't outlive it. No
  // last-admin concern — this doesn't touch is_admin — and an admin may
  // reset their own password too.
  router.post('/api/admin/users/:id/reset-password', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    try {
      // URL-safe, ~12-char temporary password. base64url avoids +/=
      // so it's painless to relay over chat or read aloud.
      const tempPassword = crypto.randomBytes(9).toString('base64url');
      const hash = await bcrypt.hash(tempPassword, 12);

      const recovery = await withTransaction(pool, (client) => accountRecovery(client, {
        userId,
        actorUserId: req.user.id,
        updatePassword: (tx) => tx.query(
          `UPDATE users SET password = $1 WHERE id = $2
           RETURNING id, username, is_admin, admin_readonly`,
          [hash, userId]
        ),
      }));
      if (!recovery.found) return res.status(404).json({ error: 'User not found' });

      log.info('admin', 'Password reset issued', {
        id: recovery.user.id, username: recovery.user.username, by: req.user.username,
      });
      res.json({ ok: true, username: recovery.user.username, tempPassword });
    } catch (err) {
      log.error('admin', 'Password reset failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // "Reset first run" (communities, stage 5): the account's next load shows
  // the join screen again, with the tour not done, as for a new account. For
  // trying onboarding on a test account, or on yourself.
  // Nothing the account owns is touched (services/onboarding.js
  // resetFirstRun), so any full admin may do it, to anyone, like a password
  // reset.
  router.post('/api/admin/users/:id/reset-first-run', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    try {
      const user = await onboarding.resetFirstRun(pool, userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      log.info('admin', 'First run reset', { id: user.id, username: user.username, by: req.user.username });
      res.json({ ok: true, username: user.username });
    } catch (err) {
      log.error('admin', 'First run reset failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Journey: people left out (#3369) ──────────────────────
  //
  // Test accounts, and people who objected to being recorded, kept out of
  // the Journey page's numbers (services/journey-left-out.js). Any admin can
  // read the list; only a full admin changes it. Adding someone as
  // "objected" erases their UI telemetry and stops it being collected.

  const leftOutFail = (res, err, what) => {
    if (err instanceof journeyLeftOut.LeftOutError) {
      return res.status(err.status).json({ error: err.message });
    }
    log.error('admin', `Journey left-out ${what} failed`, { message: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  };

  // ── Journey readings (#3369) ───────────────────────────────
  //
  // Read-only, any admin. Under staging with ?demo=1 each one answers a
  // whole, labelled demo payload (services/journey-demo.js): a staging
  // clone mixes emptied private tables with reseeded fixtures, and half-real
  // numbers would be worse than invented ones that say so.
  const journeyDemo = (req) => IS_STAGING && req.query.demo === '1';
  // `cohort` narrows a reading to one cohort: an admit day, other_way,
  // invited, or waiting (still on the waitlist). Absent means everyone;
  // anything else is refused.
  const NAMED_COHORTS = new Set(['other_way', 'invited', 'waiting']);
  const badCohort = { status: 400, error: 'cohort must be an admit day in YYYY-MM-DD, other_way, invited, or waiting.' };
  const journeyCohort = (req) => {
    const raw = req.query.cohort;
    if (raw == null || raw === '') return { day: null };
    const day = NAMED_COHORTS.has(raw) ? raw : journey.parseDay(raw);
    return day ? { day } : null;
  };
  const journeyMembers = async (day, ctx) => {
    if (!day) return null;
    const mile = await journey.firstMile(pool, { day, ...ctx });
    return new Set(mile.people.filter((p) => p.userId).map((p) => Number(p.userId)));
  };
  const journeyRead = (what, demo, handler) => async (req, res) => {
    try {
      if (journeyDemo(req)) {
        const scope = journeyCohort(req);
        if (!scope) return res.status(400).json({ error: badCohort.error });
        return res.json(demo(req, scope.day));
      }
      const leftOutIds = await journeyLeftOut.leftOutIds(pool);
      const result = await handler(req, { leftOutIds, now: new Date() });
      if (result && result.status) return res.status(result.status).json({ error: result.error });
      return res.json(result);
    } catch (err) {
      log.error('admin', `Journey ${what} failed`, { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
  // `week=all` is the page's "all time" for the readings that have one.
  const journeyWeek = (req, now, { all = false } = {}) => {
    if (all && req.query.week === 'all') return journey.allTime(now);
    const week = journey.parseWeek(req.query.week, now);
    return week || null;
  };
  const badWeek = { status: 400, error: 'week must be a Monday in YYYY-MM-DD, not in the future, or all.' };
  // The window and the cohort of a reading, or the 400 to answer.
  const journeyScope = async (req, ctx, opts) => {
    const week = journeyWeek(req, ctx.now, opts);
    if (!week) return { error: badWeek };
    const scope = journeyCohort(req);
    if (!scope) return { error: badCohort };
    return { week, memberIds: await journeyMembers(scope.day, ctx) };
  };

  // The North Star is a weekly number, so "all time" keeps the last finished
  // week as the headline and returns every week as its trend.
  router.get('/api/admin/journey/summary', journeyRead('summary', (req, day) => journeyDemoData.summary(day, req.query.week === 'all'),
    async (req, ctx) => {
      const allTime = req.query.week === 'all';
      const scope = await journeyScope(allTime ? { ...req, query: { ...req.query, week: undefined } } : req, ctx);
      if (scope.error) return scope.error;
      return journey.summary(pool, { week: scope.week, memberIds: scope.memberIds, trendAll: allTime, ...ctx });
    }));

  router.get('/api/admin/journey/cohorts', journeyRead('cohorts', () => journeyDemoData.cohorts(),
    async (req, ctx) => journey.cohorts(pool, ctx)));

  // Who is in which project and whom they brought (journey.flows): each
  // project's audience, each person's footprint project by project, and the
  // invites they sent. Over all time, for everyone: it takes no week and no
  // cohort, and a reader narrows it by the people it already has.
  router.get('/api/admin/journey/flows', journeyRead('flows', () => journeyDemoData.flows(),
    async (req, ctx) => journey.flows(pool, ctx)));

  // Admin › Onboarding flows: one row per person with their whole path, for
  // the flow chart (services/onboarding-flows.js). Everyone over all time:
  // it takes no week and no cohort, and the page narrows it itself.
  router.get('/api/admin/onboarding-flows', journeyRead('onboarding flows', () => onboardingFlowsDemo.demo(),
    async (req, ctx) => onboardingFlows.reading(pool, ctx)));

  router.get('/api/admin/journey/first-mile', journeyRead('first mile', (req) => journeyDemoData.firstMile(req.query.admitted),
    async (req, ctx) => {
      const day = NAMED_COHORTS.has(req.query.admitted)
        ? req.query.admitted : journey.parseDay(req.query.admitted);
      if (!day) return { status: 400, error: 'admitted must be an admit day in YYYY-MM-DD, other_way, invited, or waiting.' };
      return journey.firstMile(pool, { day, ...ctx });
    }));

  router.get('/api/admin/journey/stages', journeyRead('stages', (req, day) => journeyDemoData.stages(day, req.query.week === 'all'),
    async (req, ctx) => {
      const scope = await journeyScope(req, ctx, { all: true });
      if (scope.error) return scope.error;
      return journey.stages(pool, { week: scope.week, memberIds: scope.memberIds, ...ctx });
    }));

  router.get('/api/admin/journey/loops', journeyRead('loops', (req, day) => journeyDemoData.loops(day, req.query.week === 'all'),
    async (req, ctx) => {
      const scope = await journeyScope(req, ctx, { all: true });
      if (scope.error) return scope.error;
      const opts = { week: scope.week, memberIds: scope.memberIds, ...ctx };
      const [change, invite] = await Promise.all([journey.changeLoop(pool, opts), journey.inviteLoop(pool, opts)]);
      return { change, invite };
    }));

  // The creation path and the pairs follow the page's filters like the
  // stages and loops: a week or all time, everyone or one admit cohort.
  router.get('/api/admin/journey/creation', journeyRead('creation path', (req, day) => journeyDemoData.creation(day, req.query.week === 'all'),
    async (req, ctx) => {
      const scope = await journeyScope(req, ctx, { all: true });
      if (scope.error) return scope.error;
      return journey.creationPath(pool, { week: scope.week, memberIds: scope.memberIds, ...ctx });
    }));

  // The first-session plan's measures (journey.firstSession).
  router.get('/api/admin/journey/first-session', journeyRead('first session', (req, day) => journeyDemoData.firstSession(day, req.query.week === 'all'),
    async (req, ctx) => {
      const scope = await journeyScope(req, ctx, { all: true });
      if (scope.error) return scope.error;
      return journey.firstSession(pool, { week: scope.week, memberIds: scope.memberIds, ...ctx });
    }));

  router.get('/api/admin/journey/pairs', journeyRead('pairs', (req, day) => journeyDemoData.pairs(day, req.query.week === 'all'),
    async (req, ctx) => {
      const scope = await journeyScope(req, ctx, { all: true });
      if (scope.error) return scope.error;
      return journey.pairs(pool, { week: scope.week, memberIds: scope.memberIds, ...ctx });
    }));

  router.get('/api/admin/journey/next-steps', journeyRead('next steps', () => journeyDemoData.nextSteps(),
    async (req, ctx) => {
      if (req.query.admitted == null) return journey.newcomerNextSteps(pool, ctx);
      const day = NAMED_COHORTS.has(req.query.admitted)
        ? req.query.admitted : journey.parseDay(req.query.admitted);
      if (!day) return { status: 400, error: 'admitted must be an admit day in YYYY-MM-DD, other_way, invited, or waiting.' };
      const mile = await journey.firstMile(pool, { day, ...ctx });
      const to = ctx.now;
      const from = new Date(to.getTime() - journey.NEWCOMER_DAYS * journey.DAY_MS);
      return journey.nextStepCounts(pool, { from, to, userIds: mile.people.filter((p) => p.userId).map((p) => p.userId) });
    }));

  router.get('/api/admin/journey/people/:id', journeyRead('person', (req) => journeyDemoData.person(req.params.id),
    async (req, ctx) => {
      const found = await journey.person(pool, { userId: req.params.id, now: ctx.now });
      return found || { status: 404, error: 'There is no such person.' };
    }));

  // Growth (services/growth.js): the Journey page's one reading since it
  // became the Growth dashboard. A row per person, their active weeks and the
  // groups; the page filters it in the browser.
  router.get('/api/admin/journey/growth', journeyRead('growth', () => growthDemoData.reading(),
    (req, ctx) => growth.reading(pool, ctx)));

  // One group's session, for the Groups view's side panel.
  router.get('/api/admin/journey/growth/groups/:appId', journeyRead('growth group', (req) => growthDemoData.timeline(req.params.appId),
    async (req) => {
      const appId = Number(req.params.appId);
      if (!Number.isSafeInteger(appId) || appId <= 0) return { status: 400, error: 'appId must be a positive integer.' };
      return growth.groupTimeline(pool, appId);
    }));

  router.get('/api/admin/journey/left-out', async (req, res) => {
    if (journeyDemo(req)) return res.json(journeyDemoData.leftOut());
    try {
      res.json({ people: await journeyLeftOut.list(pool) });
    } catch (err) {
      leftOutFail(res, err, 'read');
    }
  });

  router.post('/api/admin/journey/left-out', requireAdminWrite, async (req, res) => {
    try {
      const result = await journeyLeftOut.add(pool, req.body || {}, { actorId: req.user.id });
      log.info('admin', 'Journey left-out entry saved', {
        userId: result.entry.userId, reason: result.entry.reason, erased: result.erased, by: req.user.username,
      });
      res.json({ ok: true, entry: result.entry, erased: result.erased });
    } catch (err) {
      leftOutFail(res, err, 'add');
    }
  });

  router.delete('/api/admin/journey/left-out/:userId', requireAdminWrite, async (req, res) => {
    try {
      await journeyLeftOut.remove(pool, req.params.userId, { actorId: req.user.id });
      log.info('admin', 'Journey left-out entry removed', { userId: Number(req.params.userId), by: req.user.username });
      res.json({ ok: true });
    } catch (err) {
      leftOutFail(res, err, 'remove');
    }
  });

  // ── Activation Codes ───────────────────────────────────────

  router.get('/api/admin/codes', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ac.id, ac.code, ac.created_at, ac.used_at,
                u.username as used_by_username
         FROM activation_codes ac
         LEFT JOIN users u ON u.id = ac.used_by
         ORDER BY ac.created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      log.error('admin', 'List codes failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/admin/codes', requireAdminWrite, async (req, res) => {
    try {
      const code = crypto.randomBytes(6).toString('hex');
      const { rows } = await pool.query(
        'INSERT INTO activation_codes (code) VALUES ($1) RETURNING id, code, created_at',
        [code]
      );
      log.info('admin', 'Activation code created', { code, by: req.user.username });
      res.json(rows[0]);
    } catch (err) {
      log.error('admin', 'Create code failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/admin/codes/:id', requireAdminWrite, async (req, res) => {
    const codeId = parseInt(req.params.id);
    try {
      const result = await pool.query('DELETE FROM activation_codes WHERE id = $1 AND used_by IS NULL', [codeId]);
      if (result.rowCount === 0) {
        return res.status(400).json({ error: 'Code not found or already used' });
      }
      log.info('admin', 'Activation code deleted', { id: codeId, by: req.user.username });
      res.json({ ok: true });
    } catch (err) {
      log.error('admin', 'Delete code failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── LLM Spend Limits ───────────────────────────────────────
  //
  // Admin-tunable caps on LLM spend. Backed by the `platform_settings`
  // table (default per-user weekly + global + system) plus the
  // `users.weekly_limit_cents` per-user override. Reads are cached for 10s
  // in src/services/limits.js; PUTs invalidate that cache so the new value
  // takes effect on the next request from any worker.
  //
  // #2571: the per-user DAILY cap is switched off. `user_daily_limit_cents`
  // and `users.daily_limit_cents` are still readable and still writable
  // here — an operator's stored figures are not destroyed and the API shape
  // does not break — but no gate consults them, the Limits page no longer
  // offers the field, and the weekly cap is the account's only limit.
  // limits.resolveCaps owns the interaction.

  // #838: the weekly cap comes in identity tiers. `user_weekly_limit_cents`
  // is the unverified tier (the base); the phone, social and zkPassport keys
  // are null when unset, meaning "same as the base", and a PUT of null clears
  // one back to that.
  //
  // The verified-identity rule (`identityRule`, schema.sql identity_rule_since):
  // on, a vote on a public app counts only from a verified account (phone,
  // GitHub and X, or zkPassport), and accounts let in before it was switched
  // on are exempt from it and from the verified tiers' allowance. Switching
  // it on records the time once; off removes it.
  async function readLimitsPayload() {
    const userCents = await limits.getDefaultUserLimitCents(pool);
    const globalCents = await limits.getGlobalLimitCents(pool);
    const systemCents = await limits.getSystemTokensLimitCents(pool);
    const weeklyCents = await limits.getDefaultUserWeeklyLimitCents(pool);
    const weeklySocial = await limits.getTierWeeklyLimitCents(pool, limits.IDENTITY_TIER_SOCIAL);
    const weeklyZk = await limits.getTierWeeklyLimitCents(pool, limits.IDENTITY_TIER_ZK);
    const weeklyPhone = await limits.getTierWeeklyLimitCents(pool, limits.IDENTITY_TIER_PHONE);
    const identityRuleSince = await limits.identityRuleSince(pool);
    return {
      user_daily_limit_cents: userCents,
      user_weekly_limit_cents: weeklyCents,
      user_weekly_limit_social_cents: weeklySocial,
      user_weekly_limit_zk_cents: weeklyZk,
      user_weekly_limit_phone_cents: weeklyPhone,
      identity_rule_since: identityRuleSince,
      global_daily_limit_cents: globalCents,
      system_tokens_daily_limit_cents: systemCents,
    };
  }

  // #4296: the Unexpected events section. Read-only, so view-only admins see
  // it too; the alerts it describes go to full admins only.
  router.get('/api/admin/incidents', async (req, res) => {
    // Required here, not at the top: platform-incidents reads the events
    // type table when it loads, which route tests stub without.
    const platformIncidents = require('../services/platform-incidents');
    const platformIncidentAlerts = require('../services/platform-incident-alerts');
    const q = req.query || {};
    const listed = await platformIncidents.list(pool, {
      days: q.days,
      kind: typeof q.kind === 'string' && q.kind ? q.kind : null,
      app: typeof q.app === 'string' && q.app ? q.app : null,
    });
    if (!listed) return res.status(500).json({ error: 'Could not read unexpected events' });
    res.json({
      ...listed,
      alerts: {
        hourlyThreshold: platformIncidentAlerts.HOURLY_THRESHOLD,
        digestHourUtc: platformIncidentAlerts.DIGEST_HOUR_UTC,
      },
    });
  });

  // Apps & usage: every app with its members, contributors and activity
  // over a 7/30/90-day window (services/admin-apps-usage.js). Read-only, so
  // view-only admins see it too.
  router.get('/api/admin/apps-usage', async (req, res) => {
    try {
      res.json(await adminAppsUsage.adminPayload(pool, { days: (req.query || {}).days }));
    } catch (err) {
      log.error('admin', 'Read apps & usage failed', { message: err.message });
      res.status(500).json({ error: 'Could not read apps & usage' });
    }
  });

  // Data retention (#5121): apps idle past the inactivity window, with the
  // stage the policy puts them at, and every deleted app's purge receipt
  // (services/app-data-retention.js, docs/app-data-retention.md).
  // Read-only, so view-only admins see it too. No screen draws it yet.
  router.get('/api/admin/app-retention', async (req, res) => {
    try {
      res.json(await appDataRetention.adminReport(pool, { days: (req.query || {}).days }));
    } catch (err) {
      log.error('admin', 'Read app retention failed', { message: err.message });
      res.status(500).json({ error: 'Could not read app retention' });
    }
  });

  router.get('/api/admin/limits', async (_req, res) => {
    try {
      res.json(await readLimitsPayload());
    } catch (err) {
      log.error('admin', 'Read limits failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/limits', requireAdminWrite, async (req, res) => {
    const { user, weekly, global, system, weeklySocial, weeklyZk, weeklyPhone, identityRule } = req.body || {};
    const updates = [];
    const clears = [];
    const validate = (label, v) => {
      if (v === undefined) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        return `${label} must be a non-negative integer (cents)`;
      }
      return n;
    };
    // #838: the two tier caps also accept null, which clears the stored
    // value so the tier inherits the base weekly cap again.
    const validateOptional = (label, v) => {
      if (v === null) return 'clear';
      return validate(label, v);
    };
    const userN = validate('user', user);
    if (typeof userN === 'string') return res.status(400).json({ error: userN });
    const globalN = validate('global', global);
    if (typeof globalN === 'string') return res.status(400).json({ error: globalN });
    const systemN = validate('system', system);
    if (typeof systemN === 'string') return res.status(400).json({ error: systemN });
    const weeklyN = validate('weekly', weekly);
    if (typeof weeklyN === 'string') return res.status(400).json({ error: weeklyN });
    const socialN = validateOptional('weeklySocial', weeklySocial);
    if (typeof socialN === 'string' && socialN !== 'clear') return res.status(400).json({ error: socialN });
    const zkN = validateOptional('weeklyZk', weeklyZk);
    if (typeof zkN === 'string' && zkN !== 'clear') return res.status(400).json({ error: zkN });
    const phoneN = validateOptional('weeklyPhone', weeklyPhone);
    if (typeof phoneN === 'string' && phoneN !== 'clear') return res.status(400).json({ error: phoneN });
    if (identityRule !== undefined && typeof identityRule !== 'boolean') {
      return res.status(400).json({ error: 'identityRule must be true or false' });
    }
    if (userN === null && globalN === null && systemN === null && weeklyN === null
        && socialN === null && zkN === null && phoneN === null && identityRule === undefined) {
      return res.status(400).json({
        error: 'Provide at least one of: user, weekly, weeklySocial, weeklyZk, weeklyPhone, identityRule, global, system',
      });
    }
    if (userN !== null) updates.push([limits.KEY_USER, String(userN)]);
    if (weeklyN !== null) updates.push([limits.KEY_WEEKLY, String(weeklyN)]);
    if (socialN === 'clear') clears.push(limits.KEY_WEEKLY_SOCIAL);
    else if (socialN !== null) updates.push([limits.KEY_WEEKLY_SOCIAL, String(socialN)]);
    if (zkN === 'clear') clears.push(limits.KEY_WEEKLY_ZK);
    else if (zkN !== null) updates.push([limits.KEY_WEEKLY_ZK, String(zkN)]);
    if (phoneN === 'clear') clears.push(limits.KEY_WEEKLY_PHONE);
    else if (phoneN !== null) updates.push([limits.KEY_WEEKLY_PHONE, String(phoneN)]);
    if (identityRule === false) clears.push(limits.KEY_IDENTITY_RULE_SINCE);
    if (globalN !== null) updates.push([limits.KEY_GLOBAL, String(globalN)]);
    if (systemN !== null) updates.push([limits.KEY_SYSTEM, String(systemN)]);

    try {
      for (const [key, value] of updates) {
        await pool.query(
          `INSERT INTO platform_settings (key, value, updated_at, updated_by)
           VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [key, value, req.user.id]
        );
      }
      for (const key of clears) {
        await pool.query('DELETE FROM platform_settings WHERE key = $1', [key]);
      }
      // On: the time it was switched on, kept if it already is (the date
      // decides who is exempt, so a second "on" must not move it).
      if (identityRule === true) {
        await pool.query(
          `INSERT INTO platform_settings (key, value, updated_at, updated_by)
           VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (key) DO NOTHING`,
          [limits.KEY_IDENTITY_RULE_SINCE, new Date().toISOString(), req.user.id]
        );
      }
      // Hot-flip the cache so new limits apply on the very next request
      // instead of waiting up to 10s for the TTL to expire.
      limits.invalidate(...updates.map(([k]) => k), ...clears);
      log.info('admin', 'Platform limits updated', {
        by: req.user.username,
        user: userN, weekly: weeklyN, global: globalN, system: systemN,
        weeklySocial: socialN, weeklyZk: zkN, weeklyPhone: phoneN,
        identityRule: identityRule === undefined ? null : identityRule,
      });
      res.json(await readLimitsPayload());
    } catch (err) {
      log.error('admin', 'Update limits failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── App limit ───────────────────────────────────────────────
  //
  // The server-wide cap on live apps (services/app-limit.js): MAX_APPS is
  // the deploy's default, and a full admin can override it here without a
  // deploy, which is the only lever the Kubernetes deploy has (its chart
  // does not pass MAX_APPS through). Read open to view-only admins, like
  // /limits; the write is requireAdminWrite.
  //
  // `limit` is a whole number, or null to clear the setting and fall back
  // to MAX_APPS. A deploy that set MAX_APPS to 0 has switched the cap off,
  // and the setting cannot switch it back on (409): see the precedence in
  // services/app-limit.js.
  router.get('/api/admin/app-limit', async (_req, res) => {
    try {
      res.json(await appLimit.adminPayload(pool, config));
    } catch (err) {
      log.error('admin', 'Read app limit failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GitHub requests ─────────────────────────────────────────
  //
  // GitHub's hourly REST budget per credential, as the last response with
  // each one reported it (services/github-budget.js). Read-only, any admin,
  // like /limits: Admin, Limits shows it beside the app limit, and the
  // GitHub platform-limit alert opens there. In memory on this process, so
  // empty until the first GitHub response after a restart.
  //
  // A platform preview boots with no GitHub credential (GITHUB_PRIVATE_KEY's
  // staging_default is empty), so it would only ever show the empty state.
  // There it answers fixed, labelled sample figures instead, the same
  // request-time demo injection routes/apps.js resolveActionsSecrets uses.
  // Strictly a no-op outside staging.
  //
  // `configured` says whether the GitHub App is set up, the platform's only
  // GitHub credential since the bot token was retired (services/github.js
  // "Who Homeroom is on GitHub").
  router.get('/api/admin/github-budget', (_req, res) => {
    const snap = githubBudget.snapshot();
    const configured = {
      app: !!(config && config.githubAppId),
    };
    if (IS_STAGING && !snap.credentials.length) {
      return res.json({ ...githubBudget.demoSnapshot(), configured, demo: true });
    }
    res.json({ ...snap, configured });
  });

  router.put('/api/admin/app-limit', requireAdminWrite, async (req, res) => {
    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'limit')) {
      return res.status(400).json({ error: 'Provide limit: a whole number, or null to use MAX_APPS.' });
    }
    const invalid = appLimit.validate(body.limit);
    if (invalid) return res.status(400).json({ error: invalid });
    if (appLimit.deployDefault(config) <= 0) {
      return res.status(409).json({
        error: 'The deploy has switched the app limit off (MAX_APPS is 0), so there is nothing to set.',
      });
    }
    try {
      await appLimit.set(pool, { value: body.limit, actorId: req.user.id });
      log.info('admin', 'App limit updated', { by: req.user.username, limit: body.limit });
      // Re-measure now: a raise clears a standing warning, and a cut below
      // the live count tells the other admins at once rather than at the
      // next sweep.
      platformLimits.nudge(pool, config, 'apps');
      res.json(await appLimit.adminPayload(pool, config));
    } catch (err) {
      log.error('admin', 'Update app limit failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Projects in previews ────────────────────────────────────
  //
  // Whether platform previews may have projects made in them, which
  // production builds and runs for them (services/preview-projects.js).
  // On by default; a full admin turns it off or on here without a deploy.
  // Read open to view-only admins, like /app-limit; the write is
  // requireAdminWrite. `enabled` is true, false, or null to go back to the
  // default. When the deploy decides (the operator's
  // PREVIEW_PROJECTS_ENABLED=false, or a Docker deploy) there is nothing to
  // set (409): see the precedence in services/preview-projects-setting.js.
  router.get('/api/admin/preview-projects', async (_req, res) => {
    try {
      res.json(await previewProjectsSetting.adminPayload(pool, config));
    } catch (err) {
      log.error('admin', 'Read preview projects setting failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/preview-projects', requireAdminWrite, async (req, res) => {
    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'enabled')) {
      return res.status(400).json({ error: 'Provide enabled: true, false, or null for the default.' });
    }
    const invalid = previewProjectsSetting.validate(body.enabled);
    if (invalid) return res.status(400).json({ error: invalid });
    const block = previewProjectsSetting.deployBlock(config);
    if (block) {
      return res.status(409).json({
        error: block === 'off'
          ? 'The deploy has switched projects in previews off (PREVIEW_PROJECTS_ENABLED is false), so there is nothing to set.'
          : 'This deploy cannot make projects in previews (they need Kubernetes), so there is nothing to set.',
      });
    }
    try {
      await previewProjectsSetting.set(pool, { value: body.enabled, actorId: req.user.id });
      log.info('admin', 'Preview projects setting updated', { by: req.user.username, enabled: body.enabled });
      res.json(await previewProjectsSetting.adminPayload(pool, config));
    } catch (err) {
      log.error('admin', 'Update preview projects setting failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Versions ────────────────────────────────────────────────
  //
  // Whether originals offer their merged changes down to the versions that
  // follow them, and ready-mades are made as versions of their original
  // (services/versions-setting.js, docs/plans/versions.md). On by default; a
  // full admin turns it off or on here without a deploy. Read open to
  // view-only admins; the write is requireAdminWrite. `enabled` is true,
  // false, or null to go back to the default. The operator's
  // VERSIONS_ENABLED=false decides it whatever is stored (409).
  router.get('/api/admin/versions', async (_req, res) => {
    try {
      res.json(await versionsSetting.adminPayload(pool, config));
    } catch (err) {
      log.error('admin', 'Read versions setting failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/versions', requireAdminWrite, async (req, res) => {
    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'enabled')) {
      return res.status(400).json({ error: 'Provide enabled: true, false, or null for the default.' });
    }
    const invalid = versionsSetting.validate(body.enabled);
    if (invalid) return res.status(400).json({ error: invalid });
    if (versionsSetting.deployBlock(config)) {
      return res.status(409).json({
        error: 'The deploy has switched versions off (VERSIONS_ENABLED is false), so there is nothing to set.',
      });
    }
    try {
      await versionsSetting.set(pool, { value: body.enabled, actorId: req.user.id });
      log.info('admin', 'Versions setting updated', { by: req.user.username, enabled: body.enabled });
      res.json(await versionsSetting.adminPayload(pool, config));
    } catch (err) {
      log.error('admin', 'Update versions setting failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Session limit ───────────────────────────────────────────
  //
  // The platform-wide cap on coding sessions, active and in review
  // (services/session-limit.js): MAX_GLOBAL_SESSIONS is the deploy's
  // default, and a full admin can override it here without an infra commit
  // or a rollout. Read open to view-only admins, like /app-limit; the write
  // is requireAdminWrite. `limit` is a whole number, or null to clear the
  // setting and fall back to MAX_GLOBAL_SESSIONS.
  router.get('/api/admin/session-limit', async (_req, res) => {
    try {
      res.json(await sessionLimit.adminPayload(pool, config));
    } catch (err) {
      log.error('admin', 'Read session limit failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/session-limit', requireAdminWrite, async (req, res) => {
    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'limit')) {
      return res.status(400).json({ error: 'Provide limit: a whole number, or null to use MAX_GLOBAL_SESSIONS.' });
    }
    const invalid = sessionLimit.validate(body.limit);
    if (invalid) return res.status(400).json({ error: invalid });
    try {
      await sessionLimit.set(pool, { value: body.limit, actorId: req.user.id });
      log.info('admin', 'Session limit updated', { by: req.user.username, limit: body.limit });
      // Re-measure now: a raise clears a standing warning, and a cut below
      // the live count tells the other admins at once.
      platformLimits.nudge(pool, config, 'sessions');
      res.json(await sessionLimit.adminPayload(pool, config));
    } catch (err) {
      log.error('admin', 'Update session limit failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Welcome messages (#admin/welcome-dm) ──────────────────
  //
  // Who greets somebody just let in, in a group with them, and what the
  // first message says (services/welcome-dm.js). Read open to view-only
  // admins; the write is requireAdminWrite. `members` is a list of
  // usernames in order — the first sends the message and owns the group.
  router.get('/api/admin/welcome-dm', async (_req, res) => {
    try {
      res.json(await welcomeDm.adminPayload(pool));
    } catch (err) {
      log.error('admin', 'Read welcome messages failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The typeahead behind each "People in the group" row. Only accounts the
  // PUT below would accept are suggested. Admin-only and debounced by the
  // client, like /api/admin/support/search.
  router.get('/api/admin/welcome-dm/people', async (req, res) => {
    try {
      res.json({ users: await welcomeDm.searchPeople(pool, req.query.q) });
    } catch (err) {
      log.error('admin', 'Welcome messages people search failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/welcome-dm', requireAdminWrite, async (req, res) => {
    try {
      const result = await welcomeDm.writeSettings(pool, req.body || {}, req.user.id);
      if (!result.ok) return res.status(400).json({ error: result.error });
      log.info('admin', 'Welcome messages updated', {
        by: req.user.username, patch: Object.keys(req.body || {}),
      });
      res.json(await welcomeDm.adminPayload(pool));
    } catch (err) {
      log.error('admin', 'Update welcome messages failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Model costs (#2570) ────────────────────────────────────
  //
  // One row per model: the note the picker shows, the estimate it shows
  // beside it, what changes on that model ACTUALLY cost over the last 30
  // days, and an override an admin types when the two have drifted apart.
  //
  // The observed figure never rewrites the estimate by itself — see the
  // header of services/model-costs.js for why a median over a handful of
  // changes is not a number to put in front of everybody automatically.
  //
  // PERMISSIONS: the read is open to view-only admins, like /limits and
  // /storage — the figures are the point of the screen. The write is
  // requireAdminWrite, like every other mutation here.
  router.get('/api/admin/model-costs', async (_req, res) => {
    try {
      res.json(await modelCosts.adminPayload(pool));
    } catch (err) {
      log.error('admin', 'Read model costs failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/model-costs', requireAdminWrite, async (req, res) => {
    const { modelId, cents } = req.body || {};
    const id = modelCosts.normalizeModelId(modelId);
    if (!id) return res.status(400).json({ error: 'modelId is required' });
    // null clears the override and puts the derived estimate back, which is
    // the only way back once one is set.
    if (cents !== null) {
      const n = Number(cents);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: 'cents must be a non-negative number, or null to clear the override' });
      }
    }
    try {
      await modelCosts.writeOverride(pool, {
        modelId: id,
        cents: cents === null ? null : Number(cents),
        actorId: req.user.id,
      });
      log.info('admin', 'Model cost estimate updated', {
        modelId: id, cents: cents === null ? null : Number(cents), by: req.user.username,
      });
      res.json(await modelCosts.adminPayload(pool));
    } catch (err) {
      log.error('admin', 'Update model cost failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Homeroom bot (#2684) ───────────────────────────────────
  //
  // The bot's shadow-mode dashboard: its settings, the queue it will look
  // at next, the ledger of what it would have asked or built, and the two
  // one-tap ratings per row that calibrate it. services/homeroom-bot.js
  // owns every query; this layer only validates and gates.
  //
  // PERMISSIONS: the read is open to view-only admins, like /model-costs —
  // the verdicts are the point of the screen. The three writes (settings,
  // a rating, a "run now") are requireAdminWrite, like every mutation here,
  // and so is the CSV export — see its own note below.
  // `verdict=budget` is not a verdict: it selects the runs the bot stopped
  // on their own budget, which are recorded as failures carrying the limit
  // that tripped (#2742). It rides the same parameter because it is the same
  // control on the screen — one "what am I looking at" picker.
  const botRunFilters = (q) => ({
    app: typeof q.app === 'string' && /^[a-z0-9-]{1,120}$/.test(q.app) ? q.app : null,
    verdict: ['question', 'ready', 'person', 'empty', 'failed', 'answer', 'revise'].includes(q.verdict) ? q.verdict : null,
    budgetOnly: q.verdict === 'budget',
  });

  router.get('/api/admin/homeroom-bot', async (req, res) => {
    try {
      const q = req.query || {};
      const before = /^\d+$/.test(String(q.before || '')) ? Number(q.before) : null;
      res.json(await homeroomBot.adminPayload(pool, config, { ...botRunFilters(q), before }));
    } catch (err) {
      log.error('admin', 'Read homeroom bot failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The whole verdict ledger as one CSV, for the analysis the paged table
  // cannot do: how often a `ready` was rated wrong, what a verdict costs by
  // app, which questions keep coming back.
  //
  // PERMISSIONS: requireAdminWrite, unlike the read beside it. Not because
  // the rows are more sensitive — a view-only admin reads the same fields
  // on screen — but because a bulk downloadable artifact is the exposure
  // class the other two CSV exports (topochain users, waitlist) and the
  // database export already put behind the write gate. Consistent with
  // those rather than with the screen it sits on.
  //
  // Streamed, not buffered: `question` and `build_note` are 4,000 characters
  // each, so the file is written chunk by chunk as the keyset pages arrive
  // and neither this process nor the browser ever holds the whole ledger.
  // Every value goes through `csvField`, which quotes and carries the
  // spreadsheet formula-injection guard — this file is model-written text
  // and admin-typed notes, which is the case that guard exists for.
  router.get('/api/admin/homeroom-bot/export.csv', requireAdminWrite, async (req, res) => {
    const filters = botRunFilters(req.query || {});
    try {
      const scope = [
        filters.app || 'all-apps',
        filters.budgetOnly ? 'budget-stops' : (filters.verdict || 'all-verdicts'),
      ].join('-');
      const day = new Date().toISOString().slice(0, 10);
      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="homeroom-bot-verdicts-${scope}-${day}.csv"`);
      res.write(`${homeroomBot.EXPORT_COLUMNS.join(',')}\n`);
      let rows = 0;
      for await (const chunk of homeroomBot.iterateRunsForExport(pool, filters)) {
        for (const row of chunk) {
          res.write(`${homeroomBot.exportRow(row).map(csvField).join(',')}\n`);
        }
        rows += chunk.length;
      }
      log.info('admin', 'Homeroom bot verdicts exported', { by: req.user.username, rows, ...filters });
      return res.end();
    } catch (err) {
      log.error('admin', 'Homeroom bot CSV export failed', { message: err.message });
      // Past the first chunk the status line and half the file are already
      // on the wire, so there is no JSON error to send: end the response and
      // let the truncated download fail loudly rather than look complete.
      if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
      return res.end();
    }
  });

  // #6643: changes held for an admin (services/release-holds.js): the ones
  // still waiting, oldest first, and what became of the ones before.
  // Read-only, so it stays on the plain adminMiddleware gate: an admin
  // answers a hold by voting on the change itself. `note` is the reason an
  // admin wrote with their No, served as JSON data for admins.
  router.get('/api/admin/release-holds', async (req, res) => {
    try {
      res.json(await require('../services/release-holds').listForAdmin(pool, { viewerId: req.user?.id ?? null }));
    } catch (err) {
      log.error('admin', 'Read release holds failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The watch-only small-change tag (services/small-change.js): its latest
  // verdicts with their proposal, and the last week's totals. Read-only, so
  // it stays on the plain adminMiddleware gate. `reason` is model-written
  // text about a change, served as JSON data for admins.
  router.get('/api/admin/small-change-tags', async (req, res) => {
    try {
      res.json(await smallChange.adminPayload(pool, { limit: req.query.limit }));
    } catch (err) {
      log.error('admin', 'Read small-change tags failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/homeroom-bot/settings', requireAdminWrite, async (req, res) => {
    try {
      const result = await homeroomBot.writeSettings(pool, req.body || {}, req.user.id, config);
      if (!result.ok) return res.status(400).json({ error: result.error });
      log.info('admin', 'Homeroom bot settings updated', {
        by: req.user.username, patch: Object.keys(req.body || {}),
      });
      res.json(await homeroomBot.adminPayload(pool, config, {}));
    } catch (err) {
      log.error('admin', 'Update homeroom bot settings failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #3654: each field is changed only when the body carries it, so the
  // table's one-tap Yes/No (a rating alone) no longer erases a note, and the
  // verdict a labeller says was right rides beside them.
  router.post('/api/admin/homeroom-bot/runs/:id/rating', requireAdminWrite, async (req, res) => {
    try {
      const body = req.body || {};
      const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
      const result = await homeroomBot.rateRun(pool, {
        id: req.params.id,
        rating: has('rating') ? body.rating : undefined,
        note: has('note') ? body.note : undefined,
        labelVerdict: has('labelVerdict') ? body.labelVerdict : undefined,
        actorId: req.user.id,
      });
      if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
      res.json({ run: result.run });
    } catch (err) {
      log.error('admin', 'Rate homeroom bot run failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/admin/homeroom-bot/run', requireAdminWrite, drainGuard, async (req, res) => {
    try {
      const { slug, issueNumber } = req.body || {};
      const result = await homeroomBot.enqueueNow(pool, {
        slug, issueNumber, actorId: req.user.id,
      });
      if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
      log.info('admin', 'Homeroom bot run requested', {
        by: req.user.username, slug, issueNumber: Number(issueNumber),
      });
      res.status(202).json({ item: result.item, ...(result.running ? { running: true } : {}) });
    } catch (err) {
      log.error('admin', 'Homeroom bot run request failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // An ask to stop tagging that the bot misread: the person is tagged again
  // on that issue.
  router.post('/api/admin/homeroom-bot/mention-optouts/remove', requireAdminWrite, async (req, res) => {
    try {
      const { slug, issueNumber, username } = req.body || {};
      const result = await homeroomBot.removeMentionOptOut(pool, { slug, issueNumber, username });
      if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
      log.info('admin', 'Homeroom bot mention opt-out removed', { by: req.user.username, slug, issueNumber: Number(issueNumber), username });
      res.json({ ok: true, mentionOptOuts: await homeroomBot.mentionOptOutList(pool) });
    } catch (err) {
      log.error('admin', 'Homeroom bot mention opt-out removal failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // "Triage this app again" (#3480): every open issue on a live app goes in
  // its queue, oldest first, and the loop takes them one at a time.
  router.post('/api/admin/homeroom-bot/retriage-app', requireAdminWrite, drainGuard, async (req, res) => {
    try {
      const result = await homeroomBot.retriageApp(pool, { slug: req.body?.slug, actorId: req.user.id });
      if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
      log.info('admin', 'Homeroom bot app re-triaged', { by: req.user.username, slug: req.body?.slug, queued: result.queued });
      res.status(202).json(result);
    } catch (err) {
      log.error('admin', 'Homeroom bot app re-triage failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Before & after shots runs export ───────────────────────
  //
  // Every shots run as one CSV, for debugging successes and failures in
  // bulk: the per-proposal diagnostics answer one run at a time, and the
  // admin gallery lists merged proposals only. services/shots-export.js
  // owns the query, the filters and the columns; this layer only gates and
  // streams.
  //
  // PERMISSIONS: requireAdminWrite, like the Homeroom bot's export above and
  // for the same reason: a bulk downloadable artifact is the exposure class
  // the other CSV exports and the database export already put behind the
  // write gate. The agent's final responses are not in the file at all.
  //
  // Streamed, not buffered, and every value goes through `csvField`: the
  // declared changes, titles and failure text are author- and model-written,
  // which is the case the formula-injection guard exists for.
  // Experimental: before/after shots at the screen's own density (3x phone,
  // 2x desktop) instead of 1x. Off until switched on here; a run reads it
  // as it starts (services/shots-density.js).
  router.get('/api/admin/shots/device-density', async (req, res) => {
    try {
      res.json({ enabled: await shotsDensity.enabled(pool) });
    } catch (err) {
      log.error('admin', 'Read shots device density failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/shots/device-density', requireAdminWrite, async (req, res) => {
    const on = req.body?.enabled;
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    try {
      const enabled = await shotsDensity.setEnabled(pool, on, req.user.id);
      log.info('admin', 'Shots device density switched', { by: req.user.username, enabled });
      res.json({ enabled });
    } catch (err) {
      log.error('admin', 'Switch shots device density failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/admin/shots/export.csv', requireAdminWrite, async (req, res) => {
    const parsed = shotsExport.parseFilters(req.query || {});
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { filters } = parsed;
    try {
      const day = new Date().toISOString().slice(0, 10);
      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="shots-runs-${shotsExport.exportScope(filters)}-${day}.csv"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.write(`${shotsExport.EXPORT_COLUMNS.join(',')}\n`);
      // A row carries JSON trace columns, so a slow client could otherwise
      // let whole pages pile up in this process's write buffer. Wait for the
      // socket to drain between pages, and stop querying once the download
      // is abandoned.
      const drained = () => new Promise((resolve) => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
        res.on('drain', done);
        res.on('close', done);
      });
      let rows = 0;
      for await (const chunk of shotsExport.iterateRunsForExport(pool, filters)) {
        for (const row of chunk) {
          res.write(`${shotsExport.exportRow(row).map(csvField).join(',')}\n`);
        }
        rows += chunk.length;
        if (res.writableNeedDrain) await drained();
        if (res.destroyed) {
          log.info('admin', 'Shots runs export abandoned by the client', { by: req.user.username, rows });
          return undefined;
        }
      }
      log.info('admin', 'Shots runs exported', { by: req.user.username, rows, ...filters });
      return res.end();
    } catch (err) {
      log.error('admin', 'Shots runs CSV export failed', { message: err.message });
      if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
      // Past the first chunk the status line and part of the file are
      // already on the wire. Destroy the socket rather than ending it: a
      // clean end closes the chunked body normally and the browser saves a
      // truncated file as though it were complete; an aborted one is reported
      // as a failed download.
      return res.destroy();
    }
  });

  // ── App storage (#2253) ────────────────────────────────────
  //
  // The per-app database cap: what each app's database measures against
  // its cap, the two levers that undo a freeze, and a manual run of the
  // leader's sweep. The read is open to view-only admins (same stance as
  // /limits: the figures are the point of the screen); both mutations and
  // the sweep chain requireAdminWrite, because they change what a real
  // Postgres role may do.
  //
  // Slugs are checked against the shape apps.slug takes before they reach
  // the service. The service parameterises them, so this is a 400 for
  // garbage instead of a 404, not a safety measure.
  const STORAGE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

  // Each app's stored files beside its database: what they take and the
  // allowance they count against (services/app-files.js).
  const NO_FILES = { fileBytes: 0, fileAppOwnedBytes: 0, fileCapBytes: appFiles.PER_APP_CAP, fileCapOverrideBytes: null };
  function withFiles(payload, files) {
    return {
      ...payload,
      apps: payload.apps.map((row) => ({ ...row, ...(files.get(row.slug) || NO_FILES) })),
      defaults: { ...payload.defaults, fileCapBytes: appFiles.PER_APP_CAP },
    };
  }
  // Staging mock data: fixed, obviously fake file figures for the demo
  // rows, one of them under its own allowance.
  function withDemoFiles(payload) {
    const MB = 1024 * 1024;
    const files = new Map(payload.apps.map((row, i) => [row.slug, {
      fileBytes: [0, 640 * MB, 2300 * MB, 9 * 1024 * MB][i % 4],
      fileAppOwnedBytes: [0, 600 * MB, 0, 8 * 1024 * MB][i % 4],
      fileCapBytes: i % 4 === 3 ? 25 * 1024 * MB : appFiles.PER_APP_CAP,
      fileCapOverrideBytes: i % 4 === 3 ? 25 * 1024 * MB : null,
    }]));
    return withFiles(payload, files);
  }

  router.get('/api/admin/storage', async (req, res) => {
    // Staging mock data: a preview's cloned apps table may carry no
    // figures, and nothing is ever frozen from a preview, so ?demo=1
    // answers with fixed rows that show every state. Read-path only,
    // obviously fake, strict no-op in production.
    if (IS_STAGING && req.query.demo === '1') {
      return res.json(withDemoFiles(appStorageCap.demoAdminPayload()));
    }
    try {
      const sweep = await clocks.status(pool, 'app-storage-cap');
      const payload = await appStorageCap.adminPayload(pool, { lastSweep: sweep.result });
      const files = await appFiles.adminFileFigures(pool);
      res.json(withFiles(payload, files));
    } catch (err) {
      log.error('admin', 'Read app storage failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/storage/:slug', requireAdminWrite, async (req, res) => {
    const slug = String(req.params.slug || '');
    if (!STORAGE_SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid app slug' });
    const { capBytes, graceMinutes, fileCapBytes } = req.body || {};
    if (capBytes === undefined && graceMinutes === undefined && fileCapBytes === undefined) {
      return res.status(400).json({
        error: 'Provide capBytes or fileCapBytes (a number of bytes, or null for the default) and/or graceMinutes',
      });
    }
    if (fileCapBytes !== undefined && fileCapBytes !== null
        && !(Number.isSafeInteger(fileCapBytes) && fileCapBytes >= 0)) {
      return res.status(400).json({
        error: 'fileCapBytes must be a non-negative integer number of bytes, or null for the default',
      });
    }
    if (capBytes !== undefined && capBytes !== null
        && !(Number.isInteger(capBytes) && capBytes >= 0)) {
      return res.status(400).json({
        error: 'capBytes must be a non-negative integer number of bytes, or null for the default',
      });
    }
    if (graceMinutes !== undefined
        && !(Number.isInteger(graceMinutes) && graceMinutes >= 1
          && graceMinutes <= appStorageCap.MAX_GRACE_MINUTES)) {
      return res.status(400).json({
        error: `graceMinutes must be an integer between 1 and ${appStorageCap.MAX_GRACE_MINUTES}`,
      });
    }
    try {
      let row = null;
      if (capBytes !== undefined) {
        row = await appStorageCap.setCapOverride(pool, slug, capBytes);
        if (!row) return res.status(404).json({ error: 'App not found' });
      }
      if (graceMinutes !== undefined) {
        row = await appStorageCap.grantGrace(pool, slug, graceMinutes);
        if (!row) return res.status(404).json({ error: 'App not found' });
      }
      let files = null;
      if (fileCapBytes !== undefined) {
        files = await appFiles.setFileCapOverride(pool, slug, fileCapBytes);
        if (!files) return res.status(404).json({ error: 'App not found' });
        if (!row) row = await appStorageCap.readApp(pool, slug);
      }
      if (!files) files = (await appFiles.adminFileFigures(pool)).get(slug) || NO_FILES;
      log.info('admin', 'App storage settings updated', {
        by: req.user.username, slug, capBytes, graceMinutes, fileCapBytes,
      });
      res.json({ ...row, ...files });
    } catch (err) {
      log.error('admin', 'Update app storage failed', { slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The storage clock's run, now (src/workflow/clock/): one sweep at a time
  // wherever the workflow runs, and its result is the page's last sweep.
  router.post('/api/admin/storage/sweep', requireAdminWrite, async (req, res) => {
    try {
      let sweep;
      try {
        const ran = await clocks.runNow('app-storage-cap', req.user);
        if (ran && ran.lastError) return res.status(500).json({ error: ran.lastError });
        sweep = ran && ran.result;
      } catch (err) {
        // No clock runs it here (a staging preview arms none): measured on
        // the spot, which on a preview records figures and freezes nothing.
        if (err && err.code !== 'not_armed') throw err;
        sweep = await appStorageCap.sweep(pool);
      }
      if (!sweep) {
        return res.status(503).json({ error: 'Still measuring: the figures will show here when it ends.' });
      }
      log.info('admin', 'App storage sweep run from the console', {
        by: req.user.username, measured: sweep.measured, frozen: sweep.frozen,
        unfrozen: sweep.unfrozen, warned: sweep.warned, errors: (sweep.errors || []).length,
      });
      res.json({ sweep });
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ error: err.message });
      log.error('admin', 'App storage sweep failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Custom domains (#4405) ─────────────────────────────────
  //
  // Every custom domain with its project and where it stands. The read is
  // open to view-only admins; the levers (check again, disable, enable,
  // remove) change what the edge serves, so they requireAdminWrite. Disable
  // takes the host out of service without touching the project: its Homeroom
  // address keeps working, and Enable verifies the claim again from the
  // start.
  const appDomains = require('../services/app-domains');

  function adminDomainRow(row) {
    return {
      id: row.id,
      appSlug: row.app_slug,
      appName: row.app_name,
      createdBy: row.created_by_username || null,
      ...appDomains.publicRow(row),
      disabledAt: row.disabled_at ? new Date(row.disabled_at).toISOString() : null,
      failureCount: row.failure_count,
    };
  }

  router.get('/api/admin/domains', async (req, res) => {
    try {
      const rows = await appDomains.adminList(pool);
      res.json({ domains: rows.map(adminDomainRow), sweep: await clocks.status(pool, 'app-domains') });
    } catch (err) {
      log.error('admin', 'Read custom domains failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  async function adminDomainAction(req, res, act) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid domain id' });
    try {
      const row = await appDomains.byId(pool, id);
      if (!row) return res.status(404).json({ error: 'Domain not found' });
      const result = await act(row);
      log.info('admin', 'Custom domain action', { by: req.user.username, id, hostname: row.hostname, action: req.path.split('/').pop() });
      if (result === null) return res.status(204).end();
      const rows = await appDomains.adminList(pool);
      const fresh = rows.find((r) => r.id === id);
      res.json({ domain: fresh ? adminDomainRow(fresh) : null });
    } catch (err) {
      if (err.code === 'edge_teardown_failed') return res.status(503).json({ error: err.message, code: err.code });
      log.error('admin', 'Custom domain action failed', { id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  router.post('/api/admin/domains/:id/check', requireAdminWrite, (req, res) => adminDomainAction(req, res,
    (row) => (row.status === 'disabled' ? row : appDomains.checkNow(pool, config, row, { userId: req.user.id }))));
  router.post('/api/admin/domains/:id/disable', requireAdminWrite, (req, res) => adminDomainAction(req, res,
    (row) => (row.status === 'disabled' ? row : appDomains.disable(pool, config, row, req.user))));
  router.post('/api/admin/domains/:id/enable', requireAdminWrite, (req, res) => adminDomainAction(req, res,
    (row) => (row.status === 'disabled' ? appDomains.enable(pool, row, req.user) : row)));
  router.delete('/api/admin/domains/:id', requireAdminWrite, (req, res) => adminDomainAction(req, res,
    async (row) => {
      const { rows } = await pool.query('SELECT id, slug FROM apps WHERE id = $1', [row.app_id]);
      await appDomains.remove(pool, config, rows[0] || { id: row.app_id }, row, req.user);
      return null;
    }));

  // ── Featured apps ──────────────────────────────────────────
  //
  // The admin-curated list and the flag that takes an app out of Discover
  // (routes/admin-featured-apps.js), here behind the router-level
  // adminMiddleware above, and also behind a full admin's connector doors
  // (routes/featured-admin.js).
  router.use(featuredAppsAdminRoutes(pool));

  // ── Email templates ────────────────────────────────────────
  //
  // The templates and layouts every platform email is written from
  // (routes/admin-email-templates.js), behind the router-level
  // adminMiddleware above; writes and test sends need a full admin.
  router.use(emailTemplateAdminRoutes(pool, config));
  // The images those templates show (routes/email-images.js): the upload
  // needs a full admin; the bytes are served publicly from server.js.
  router.use(emailImageAdminRoutes(pool));

  // ── Anthropic credits (#555) ───────────────────────────────
  //
  // The organisation's remaining Anthropic credit, for the drawer's
  // status pane. Anthropic publishes billed spend, never a balance, so
  // the figure is derived from a balance an admin records here minus
  // cost_report spend since that date — see services/anthropic-credits.js
  // for the whole story. The two settings keys are intentionally absent
  // until someone records them; absence is the "not configured" state.

  // Router-level adminMiddleware only — NO requireAdminWrite. This is a
  // pure read, and view-only admins are squarely part of its audience
  // (same reasoning as /overview, /users, /codes, /limits above).
  router.get('/api/admin/anthropic-credits', async (req, res) => {
    // Staging mock data: read-only, obviously fake, no writes, strict
    // no-op in production. Admin-gated already by the router.
    if (IS_STAGING && req.query.demo === '1') {
      return res.json({
        configured: true,
        balanceCents: 500000,
        asOf: '2026-07-01',
        spentCents: 371550,
        remainingCents: 128450,
        source: 'anthropic',
        fetchedAt: new Date().toISOString(),
        partial: false,
        demo: true,
      });
    }
    try {
      res.json(await anthropicCredits.getCredits(pool, config));
    } catch (err) {
      // getCredits swallows its own failures, so reaching here means
      // something unexpected — still don't 500 a status-pane read.
      log.error('admin', 'Read anthropic credits failed', { message: err.message });
      res.json({ configured: true, error: 'Internal server error' });
    }
  });

  // Record the balance + the date it was correct. Full admins only —
  // this is a mutation, so it chains requireAdminWrite like PUT /limits.
  router.put('/api/admin/anthropic-credits', requireAdminWrite, async (req, res) => {
    const { balanceCents, balanceDollars, asOf } = req.body || {};

    let cents;
    if (balanceCents !== undefined) {
      cents = Number(balanceCents);
    } else if (balanceDollars !== undefined) {
      const d = Number(balanceDollars);
      cents = Number.isFinite(d) ? Math.round(d * 100) : NaN;
    } else {
      return res.status(400).json({ error: 'balanceCents or balanceDollars is required' });
    }
    if (!Number.isFinite(cents) || cents < 0) {
      return res.status(400).json({ error: 'Credit balance must be a non-negative amount' });
    }
    cents = Math.round(cents);

    const day = String(asOf || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return res.status(400).json({ error: 'asOf must be a date in YYYY-MM-DD form' });
    }
    const parsed = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
      return res.status(400).json({ error: 'asOf is not a real calendar date' });
    }
    // A future as-of date would subtract spend from a window that hasn't
    // happened yet and read as "full balance" forever.
    if (parsed.getTime() > Date.now()) {
      return res.status(400).json({ error: 'asOf cannot be in the future' });
    }

    try {
      for (const [key, value] of [
        [anthropicCredits.KEY_BALANCE, String(cents)],
        [anthropicCredits.KEY_AS_OF, day],
      ]) {
        await pool.query(
          `INSERT INTO platform_settings (key, value, updated_at, updated_by)
           VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [key, value, req.user.id]
        );
      }
      // Drop the cached arithmetic so the recomputed figure below (and
      // every drawer that opens next) reflects the new balance at once.
      anthropicCredits.invalidate();
      log.info('admin', 'Anthropic credit balance recorded', {
        by: req.user.username, balanceCents: cents, asOf: day,
      });
      res.json(await anthropicCredits.getCredits(pool, config));
    } catch (err) {
      log.error('admin', 'Update anthropic credits failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Per-user override. Body `{ cents }` sets a cap for this user only;
  // `{ cents: null }` clears the override and falls them back to the
  // platform default. Cache invalidation isn't needed because the per-
  // user limit is read fresh from the users table on every checkBudget
  // call (only the platform_settings rows are cached).
  router.put('/api/admin/users/:id/daily-limit', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const { cents } = req.body || {};
    let value;
    if (cents === null) {
      value = null;
    } else {
      const n = Number(cents);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: 'cents must be a non-negative integer or null' });
      }
      value = n;
    }
    try {
      const { rows } = await pool.query(
        `UPDATE users SET daily_limit_cents = $1 WHERE id = $2
         RETURNING id, username, daily_limit_cents`,
        [value, userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      log.info('admin', 'Per-user daily limit updated', {
        id: rows[0].id, username: rows[0].username,
        dailyLimitCents: rows[0].daily_limit_cents,
        by: req.user.username,
      });
      res.json({ ok: true, daily_limit_cents: rows[0].daily_limit_cents });
    } catch (err) {
      log.error('admin', 'Per-user limit update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #1788: the weekly twin of the route above. Body `{ cents }` sets a
  // weekly cap for this user only, `{ cents: null }` clears it back to the
  // platform default, and `{ cents: 0 }` means "no weekly cap applies to
  // this user" (see limits.resolveCaps). No cache invalidation for the same
  // reason as the daily route: per-user values are read fresh from `users`
  // on every gate.
  router.put('/api/admin/users/:id/weekly-limit', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const { cents } = req.body || {};
    let value;
    if (cents === null) {
      value = null;
    } else {
      const n = Number(cents);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: 'cents must be a non-negative integer or null' });
      }
      value = n;
    }
    try {
      const { rows } = await pool.query(
        `UPDATE users SET weekly_limit_cents = $1 WHERE id = $2
         RETURNING id, username, weekly_limit_cents`,
        [value, userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      log.info('admin', 'Per-user weekly limit updated', {
        id: rows[0].id, username: rows[0].username,
        weeklyLimitCents: rows[0].weekly_limit_cents,
        by: req.user.username,
      });
      // #2119: the user's included OpenRouter key carries this allowance, so
      // bring it in line now rather than on their next settings read. The
      // cap is already saved; the sync is best-effort and never fails this
      // request (a provider failure is logged inside it).
      try {
        await managedOpenRouter.syncAllowance({
          pool, userId, config, actorId: req.user.id,
          state: await managedOpenRouter.stateForUser(pool, userId),
        });
      } catch (err) {
        log.warn('admin', 'managed OpenRouter allowance sync skipped', { userId, err: err.message });
      }
      // #6377: a limit raised may give this person's week room again; what it
      // held back is released now. Best-effort: the limit is already saved and
      // a release that fails never changes this answer.
      await homeroomBot.releaseAllowanceHolds(pool).catch((err) =>
        log.warn('admin', 'Could not release requests held for a weekly limit change', { userId, err: err.message }));
      res.json({ ok: true, weekly_limit_cents: rows[0].weekly_limit_cents });
    } catch (err) {
      log.error('admin', 'Per-user weekly limit update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Linked wallet (issue #422) ─────────────────────────────
  //
  // Set / change / clear a user's linked Homeroom wallet
  // (users.usernode_pubkey). Mirrors the per-user daily-limit handler.
  // Body `{ pubkey }`:
  //   - null or '' → CLEAR: usernode_pubkey = NULL, and the link-flow
  //     columns (token/expiry) are nulled too, matching the user-facing
  //     DELETE /api/me/wallet-link unlink.
  //   - non-empty  → SET, after a wallet-shape check.
  //
  // There is NO unique constraint on usernode_pubkey (only username is
  // unique), and wallet login resolves the account by pubkey alone — so
  // two rows sharing a pubkey is the "accounts mixed up" failure mode this
  // route exists to fix. We therefore enforce single-ownership here: if
  // another user already holds the target pubkey we return 409 unless the
  // caller explicitly opts into reassigning it. Reassign clears the other
  // user and sets this one inside one transaction so there's never a
  // transient duplicate. We intentionally do NOT gate on
  // genesisAccounts.isGenesisAddress — that's for user-initiated linking
  // and returns true when the genesis set is unloaded; an admin correcting
  // an association must not be blocked by it.
  router.put('/api/admin/users/:id/wallet', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const raw = req.body?.pubkey;
    const reassign = req.body?.reassign === true;

    // Normalize to either a clean string to set, or null to clear.
    let pubkey = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'pubkey must be a string, null, or empty' });
      }
      const trimmed = raw.trim();
      if (trimmed === '') {
        pubkey = null;
      } else if (/\s/.test(trimmed)) {
        return res.status(400).json({ error: 'Wallet address must not contain whitespace' });
      } else if (!trimmed.startsWith('ut1')) {
        return res.status(400).json({ error: 'Wallet address must start with "ut1"' });
      } else if (trimmed.length < 8 || trimmed.length > 255) {
        return res.status(400).json({ error: 'Wallet address has an invalid length' });
      } else {
        pubkey = trimmed;
      }
    }

    try {
      // Clear is unconditional — no conflict possible when setting NULL.
      if (pubkey === null) {
        const { rows } = await pool.query(
          `UPDATE users
             SET usernode_pubkey = NULL,
                 wallet_link_token = NULL,
                 wallet_link_expires_at = NULL
           WHERE id = $1
           RETURNING id, username, usernode_pubkey`,
          [userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        log.info('admin', 'Wallet updated', {
          id: rows[0].id, username: rows[0].username,
          to: null, by: req.user.username,
        });
        return res.json({ ok: true, usernode_pubkey: null });
      }

      // Does another user already hold this pubkey?
      const { rows: holders } = await pool.query(
        'SELECT id, username FROM users WHERE usernode_pubkey = $1 AND id <> $2',
        [pubkey, userId]
      );
      if (holders.length && !reassign) {
        return res.status(409).json({
          error: `This wallet is already linked to "${holders[0].username}". Reassign it to move the wallet.`,
          conflictUser: { id: holders[0].id, username: holders[0].username },
        });
      }

      if (holders.length) {
        // Reassign: clear every other holder, then set the target — one
        // transaction so there's never a transient duplicate.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `UPDATE users
               SET usernode_pubkey = NULL,
                   wallet_link_token = NULL,
                   wallet_link_expires_at = NULL
             WHERE usernode_pubkey = $1 AND id <> $2`,
            [pubkey, userId]
          );
          const { rows } = await client.query(
            `UPDATE users
               SET usernode_pubkey = $1,
                   wallet_link_token = NULL,
                   wallet_link_expires_at = NULL
             WHERE id = $2
             RETURNING id, username, usernode_pubkey`,
            [pubkey, userId]
          );
          if (!rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
          }
          await client.query('COMMIT');
          log.info('admin', 'Wallet updated', {
            id: rows[0].id, username: rows[0].username,
            to: pubkey.slice(0, 12) + '…',
            reassignedFrom: holders.map((h) => h.username),
            by: req.user.username,
          });
          return res.json({ ok: true, usernode_pubkey: rows[0].usernode_pubkey });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }

      // No conflict — straight set.
      const { rows } = await pool.query(
        `UPDATE users
           SET usernode_pubkey = $1,
               wallet_link_token = NULL,
               wallet_link_expires_at = NULL
         WHERE id = $2
         RETURNING id, username, usernode_pubkey`,
        [pubkey, userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      log.info('admin', 'Wallet updated', {
        id: rows[0].id, username: rows[0].username,
        to: pubkey.slice(0, 12) + '…', by: req.user.username,
      });
      res.json({ ok: true, usernode_pubkey: rows[0].usernode_pubkey });
    } catch (err) {
      log.error('admin', 'Wallet update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Submitted features across all apps (#562) ─────────────────
  //
  // A platform-wide, admin-only view of member-submitted feature
  // requests, ranked by up-votes. "Submitted features" are the
  // user-submittable, GitHub-mirrored `issues` rows with kind='general'
  // (see src/routes/issues.js VALID_KINDS); the structured governance
  // kinds ('secret_change', 'close_issue') are deliberately excluded.
  // This is the first CROSS-APP issues query — every other issue read is
  // scoped to a single app_id or a single user. Gated only by the
  // router-level adminMiddleware (any admin, full OR view-only): it is a
  // pure read, so it must NOT chain requireAdminWrite, matching the other
  // /api/admin GET reads (/overview, /users, /codes, /limits).
  //
  // Ordering is by up-vote count DESC (matching the per-app list at
  // GET /api/apps/:slug/issues), with created_at then id as deterministic
  // tie-breaks so offset paging is stable. Offset paging (rather than the
  // keyset cursors used on high-churn feeds like votes.js) is used on
  // purpose: the sort key is a computed aggregate with heavy ties, which a
  // (created_at, id) cursor cannot page correctly, and this admin analytics
  // list is low-churn so any offset drift is acceptable.
  router.get('/api/admin/submitted-features', async (req, res) => {
    // status: 'open' (default) | 'closed' | 'all'. Anything else falls
    // back to the default rather than 400-ing an admin analytics read.
    const statusParam = String(req.query.status || 'open').toLowerCase();
    const status = ['open', 'closed', 'completed', 'all'].includes(statusParam) ? statusParam : 'open';

    // limit: default 50, clamped to [1, 200]; offset: non-negative int.
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const rawOffset = parseInt(req.query.offset, 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    // Shared WHERE: only member-submitted features, optionally status-scoped.
    // $1 carries the status filter ('all' → no status predicate).
    const statusClause = status === 'all' ? '' : ' AND i.status = $1';
    const filterParams = status === 'all' ? [] : [status];

    try {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS total
           FROM issues i
          WHERE i.kind = 'general'${statusClause}`,
        filterParams
      );
      const total = countRows[0] ? countRows[0].total : 0;

      const { rows } = await pool.query(
        `SELECT i.id, i.app_id, i.github_issue_number, i.title, i.description,
                i.kind, i.status, i.created_at, i.created_by,
                u.username AS created_by_username,
                a.slug AS app_slug, a.name AS app_name,
                (SELECT COUNT(*)::int FROM issue_votes
                   WHERE issue_id = i.id AND vote = 'up')   AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes
                   WHERE issue_id = i.id AND vote = 'down') AS down_count
           FROM issues i
           JOIN apps a ON a.id = i.app_id
           LEFT JOIN users u ON u.id = i.created_by
          WHERE i.kind = 'general'${statusClause}
          ORDER BY (SELECT COUNT(*) FROM issue_votes
                      WHERE issue_id = i.id AND vote = 'up') DESC,
                   i.created_at DESC, i.id DESC
          LIMIT ${limit} OFFSET ${offset}`,
        filterParams
      );

      res.json({ features: rows, total, limit, offset });
    } catch (err) {
      log.error('admin', 'Submitted-features list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Database export ────────────────────────────────────────
  //
  // A full, unredacted pg_dump of the platform database — plain SQL, gzip
  // compressed on the way out (`<db>-<stamp>.sql.gz`) — streamed straight
  // to a full admin's browser as a file download. The dumped file contains
  // every bcrypt hash in `users`, every live row of `sessions`, every
  // activation code, every app's db_password / llm_proxy_token /
  // storage_api_token / groups_api_token, and the AES-GCM ciphertext of every BYOK key and
  // app secret. It deliberately bypasses BOTH containment mechanisms the
  // platform otherwise relies on — the `staging:private` scrub in
  // db-manager.js and the grant-level deny lists in debug-access.js.
  //
  // So the gate is: full platform admins only (requireAdminWrite — never
  // adminMiddleware alone, which admits view-only admins, and never any
  // per-app admin notion), password re-entry on every single export, an
  // explicit typed confirmation, 3 per admin per day, one at a time
  // platform-wide, blocked outright in staging, and an append-only
  // `db_exports` row for every attempt — written BEFORE anything runs.
  //
  // Mechanics live in src/services/db-export.js (networked pg_dump +
  // in-process gzip + ticket store + single-flight guard); this file owns
  // auth and audit. NOTE: the audited/reported byte count is the COMPRESSED
  // size — what actually left the server — so history rows are comparable
  // with the file on the admin's disk, not with pg_database_size().

  const DB_EXPORT_HISTORY_MAX = 200;

  function auditClientIp(req) {
    return String(clientIp(req)).slice(0, 64) || null;
  }

  // Insert the audit row. Deliberately NOT fire-and-forget: callers await
  // this before doing the thing it records, so a dump can never run
  // without a row already committed for it. Returns the row id, or null
  // if the insert itself failed (in which case the caller logs and, for
  // the export path, refuses to proceed).
  async function recordExportAudit(req, { status, deniedReason = null, dbName = null }) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO db_exports (user_id, username, db_name, status, denied_reason, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          req.user?.id ?? null,
          req.user?.username || 'unknown',
          dbName || '(unresolved)',
          status,
          deniedReason,
          auditClientIp(req),
          String(req.get('user-agent') || '').slice(0, 512) || null,
        ]
      );
      return rows[0] ? rows[0].id : null;
    } catch (err) {
      log.error('admin', 'db-export audit insert failed', { message: err.message, status, deniedReason });
      return null;
    }
  }

  async function finishExportAudit(id, { status, bytesSent = 0, error = null, started = false }) {
    if (!id) return;
    try {
      await pool.query(
        `UPDATE db_exports
            SET status = $2,
                bytes_sent = $3,
                error = $4,
                started_at = COALESCE(started_at, CASE WHEN $5 THEN NOW() ELSE NULL END),
                finished_at = NOW()
          WHERE id = $1`,
        [id, status, bytesSent, error ? log.redactString(String(error)).slice(0, 4000) : null, started]
      );
    } catch (err) {
      log.error('admin', 'db-export audit update failed', { message: err.message, id });
    }
  }

  // ── Access review (#5133) ───────────────────────────────────────────
  //
  // Who holds admin rights, what each can do, and the quarterly review
  // (services/admin-access-review.js, docs/ops/admin-access.md). Both
  // routes are full admins only: the list says who can take the database
  // away, and recording a review is a write.
  router.get('/api/admin/access-review', requireAdminWrite, async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await adminAccessReview.report(pool));
    } catch (err) {
      log.error('admin', 'Access review read failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/admin/access-review/reviews', requireAdminWrite, drainGuard, async (req, res) => {
    const note = adminAccessReview.normaliseNote(req.body?.note);
    if (!note.ok) return res.status(400).json({ error: note.error });
    try {
      const row = await adminAccessReview.recordReview(pool, {
        reviewerId: req.user.id, note: note.value,
      });
      log.info('admin', 'Admin access reviewed', {
        by: req.user.username, id: row.id,
        fullAdmins: row.full_admins, viewOnlyAdmins: row.view_only_admins,
      });
      res.set('Cache-Control', 'no-store');
      res.json(await adminAccessReview.report(pool));
    } catch (err) {
      log.error('admin', 'Access review record failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Compliance report (#5634) ─────────────────────────────────────────
  //
  // The compliance plan's items with their status and what the scan found
  // (services/compliance.js). Every admin reads it; saving a status and
  // Scan now are full admins only.
  async function complianceReport() {
    const [report, scan] = await Promise.all([
      compliance.report(pool),
      clocks.status(pool, 'compliance-scan').catch(() => null),
    ]);
    return {
      ...report,
      scanClock: scan ? { nextDueAt: scan.nextDueAt, inFlight: scan.sweepInFlight, lastError: scan.lastError } : null,
    };
  }

  router.get('/api/admin/compliance', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await complianceReport());
    } catch (err) {
      log.error('admin', 'Compliance report read failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/admin/compliance/items/:code', async (req, res) => {
    try {
      const history = await compliance.itemHistory(pool, String(req.params.code || ''));
      if (!history) return res.status(404).json({ error: 'No such item in the compliance plan.' });
      res.set('Cache-Control', 'no-store');
      res.json(history);
    } catch (err) {
      log.error('admin', 'Compliance item history read failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/admin/compliance/items/:code/status', requireAdminWrite, drainGuard, async (req, res) => {
    const code = String(req.params.code || '');
    const input = compliance.normaliseStatus(code, req.body);
    if (!input.ok) return res.status(input.status).json({ error: input.error });
    try {
      const row = await compliance.recordStatus(pool, { code, ...input.value, changedBy: req.user.id });
      log.info('admin', 'Compliance status set', { code, status: row.status, by: req.user.username });
      res.set('Cache-Control', 'no-store');
      res.json(await complianceReport());
    } catch (err) {
      log.error('admin', 'Compliance status save failed', { code, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Scan now: the compliance-scan clock's run, waited for, so it is one
  // scan at a time wherever the workflow runs. A staging preview arms no
  // clock, so there it scans on the spot.
  router.post('/api/admin/compliance/scan', requireAdminWrite, drainGuard, async (req, res) => {
    try {
      let error = null;
      let pending = false;
      try {
        const ran = await clocks.runNow('compliance-scan', req.user, { timeoutMs: 90000 });
        if (!ran) pending = true;
        else if (ran.lastError) error = ran.lastError;
      } catch (err) {
        if (err && err.code !== 'not_armed') throw err;
        await compliance.runScan(pool).catch((e) => { error = e.message; });
      }
      log.info('admin', 'Compliance scan run from the console', { by: req.user.username, pending, error });
      res.set('Cache-Control', 'no-store');
      res.status(pending ? 202 : 200).json({ ...await complianceReport(), pending, scanError: error });
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ error: err.message });
      log.error('admin', 'Compliance scan failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Capability probe for the console. Readable by ANY admin (view-only
  // included) — it exposes no data, only whether the button should work
  // and, when it shouldn't, a machine-readable reason the client renders.
  // That indirection is what keeps public/js/admin-console.js free of any
  // USERNODE_ENV literal (pinned by tests/admin-console-page.test.js)
  // while the staging block itself stays server-side and absolute.
  router.get('/api/admin/db-export/status', async (req, res) => {
    try {
      const target = dbExport.resolveTargetDb(config);
      const inProgress = await dbExport.isExportInProgress(pool);

      let dbSizeBytes = null;
      try {
        const { rows } = await pool.query('SELECT pg_database_size(current_database())::bigint AS size');
        if (rows[0]) dbSizeBytes = Number(rows[0].size);
      } catch (err) {
        log.warn('admin', 'db-export size probe failed', { message: err.message });
      }

      // Advisory only — the enforced budget is the rolling in-memory
      // window in dbExportLimiter. This is the DB's view of the same
      // thing, for display; the two can disagree across a restart.
      let remainingToday = dbExport.MAX_PER_DAY;
      try {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM db_exports
            WHERE user_id = $1
              AND status <> 'denied'
              AND requested_at > NOW() - INTERVAL '24 hours'`,
          [req.user.id]
        );
        remainingToday = Math.max(0, dbExport.MAX_PER_DAY - (rows[0] ? rows[0].n : 0));
      } catch { /* display-only */ }

      let available = true;
      let reason = 'ok';
      if (dbExport.isStaging()) { available = false; reason = 'staging'; }
      else if (!target.dbName) { available = false; reason = 'unavailable'; }
      else if (inProgress) { available = false; reason = 'in_progress'; }
      else if (remainingToday <= 0) { available = false; reason = 'rate_limited'; }

      res.json({
        available,
        reason,
        dbName: target.dbName,
        dbSizeBytes,
        inProgress,
        remainingToday,
        maxPerDay: dbExport.MAX_PER_DAY,
        canWrite: !!req.user?.canAdminWrite,
      });
    } catch (err) {
      log.error('admin', 'db-export status failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Append-only history, readable by any admin. There is no delete or
  // edit counterpart, by design.
  router.get('/api/admin/db-export/history', async (req, res) => {
    try {
      const limit = Math.min(DB_EXPORT_HISTORY_MAX, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS total FROM db_exports');
      const { rows } = await pool.query(
        `SELECT id, user_id, username, db_name, status, denied_reason, ip,
                bytes_sent, requested_at, started_at, finished_at, error
           FROM db_exports
          ORDER BY requested_at DESC, id DESC
          LIMIT ${limit} OFFSET ${offset}`
      );
      res.json({ exports: rows, total: countRows[0] ? countRows[0].total : 0, limit, offset });
    } catch (err) {
      log.error('admin', 'db-export history failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Audit the two denials that never reach the ticket handler: a view-only
  // admin bounced by requireAdminWrite, and a full admin bounced by the
  // rate limiter. Both are attempts on a credential-dump endpoint, so both
  // belong on the record.
  async function noteDbExportPreDenials(req, res, next) {
    res.on('finish', () => {
      if (res.statusCode === 429) {
        recordExportAudit(req, { status: 'denied', deniedReason: 'rate_limited' }).catch(() => {});
      }
    });
    if (!req.user?.canAdminWrite) {
      log.warn('admin', 'db-export refused: view-only admin', {
        by: req.user?.username, ip: clientIp(req),
      });
      await recordExportAudit(req, { status: 'denied', deniedReason: 'view_only' });
    }
    next();
  }

  // Step 1 of 2. Verifies the typed confirmation and the admin's own
  // password, then hands back a single-use 60s ticket. The browser
  // navigates to the ticket URL, which is what makes this a real
  // streamed file download rather than a Blob held in page memory.
  router.post('/api/admin/db-export/ticket',
    noteDbExportPreDenials, requireAdminWrite, dbExportLimiter,
    async (req, res) => {
      try {
        // Layer 2 of the staging block. Kubernetes made the export transport
        // runtime-neutral (networked pg_dump), so this explicit environment
        // denial remains the real boundary: previews must never receive a
        // platform-database export even when they can reach PostgreSQL.
        if (dbExport.isStaging()) {
          await recordExportAudit(req, { status: 'denied', deniedReason: 'staging' });
          return res.status(403).json({
            error: 'Database export is disabled in staging previews.',
            code: 'staging',
          });
        }

        const { password, confirm } = req.body || {};
        if (confirm !== 'EXPORT') {
          return res.status(400).json({ error: 'Type EXPORT to confirm.', code: 'confirm_required' });
        }
        if (!password || typeof password !== 'string') {
          return res.status(400).json({ error: 'Your password is required.', code: 'password_required' });
        }

        const { rows } = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
        const hash = rows[0] ? rows[0].password : null;
        const ok = hash ? await bcrypt.compare(password, hash) : false;
        if (!ok) {
          await recordExportAudit(req, { status: 'denied', deniedReason: 'bad_password' });
          log.warn('admin', 'db-export refused: password verification failed', {
            by: req.user.username, ip: clientIp(req),
          });
          // Deliberately undifferentiated from any other verification
          // failure in the client-visible message.
          return res.status(401).json({ error: 'Password verification failed.', code: 'bad_password' });
        }

        const target = dbExport.resolveTargetDb(config);
        if (!target.dbName) {
          await recordExportAudit(req, { status: 'denied', deniedReason: 'unavailable' });
          return res.status(503).json({
            error: 'Database export is unavailable on this deployment.',
            code: 'unavailable',
          });
        }
        if (await dbExport.isExportInProgress(pool)) {
          await recordExportAudit(req, { status: 'denied', deniedReason: 'in_progress', dbName: target.dbName });
          return res.status(409).json({
            error: 'An export is already in progress. Try again shortly.',
            code: 'in_progress',
          });
        }

        // AUDIT BEFORE ANYTHING RUNS. Mirrors the prod-debug idiom in
        // routes/internal.js: the record is committed first, so even an
        // export that dies before producing a byte is on the books.
        const auditId = await recordExportAudit(req, { status: 'requested', dbName: target.dbName });
        if (!auditId) {
          return res.status(500).json({ error: 'Could not record the export, so it will not be run.' });
        }

        const { token, expiresInSeconds } = await dbExport.issueTicket(pool, { auditId });
        log.warn('admin', 'Database export authorized', {
          by: req.user.username, id: req.user.id, dbName: target.dbName,
          auditId, ip: clientIp(req), ticket: `${token.slice(0, 8)}…`,
        });

        res.json({
          token,
          url: `/api/admin/db-export?t=${encodeURIComponent(token)}`,
          filename: dbExport.exportFilename(target.dbName),
          expiresInSeconds,
        });
      } catch (err) {
        log.error('admin', 'db-export ticket failed', { message: err.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

  // Step 2 of 2. Browser-navigated GET: consumes the ticket and streams
  // the gzipped SQL dump with Content-Disposition: attachment. requireAdminWrite is
  // re-applied here rather than trusted from step 1 — the ticket narrows
  // who may use this URL, it is not the authorization.
  router.get('/api/admin/db-export', requireAdminWrite, async (req, res) => {
    let auditId = null;
    let started = false;
    try {
      if (dbExport.isStaging()) {
        return res.status(403).json({
          error: 'Database export is disabled in staging previews.',
          code: 'staging',
        });
      }

      const ticket = await dbExport.consumeTicket(pool, String(req.query.t || ''), req.user.id);
      if (!ticket) {
        log.warn('admin', 'db-export refused: invalid or expired ticket', {
          by: req.user.username, ip: clientIp(req),
        });
        return res.status(403).json({
          error: 'This export link has expired. Start the export again.',
          code: 'ticket_invalid',
        });
      }
      auditId = ticket.auditId;

      // A mobile client can legitimately change IP between the POST and
      // the navigation, so this is a warning, not a block.
      const ip = clientIp(req);
      if (ticket.ip && ip && ticket.ip !== ip) {
        log.warn('admin', 'db-export ticket redeemed from a different IP', {
          by: req.user.username, issuedTo: ticket.ip, redeemedFrom: ip, auditId,
        });
      }

      const target = dbExport.resolveTargetDb(config);
      if (!target.dbName) {
        await finishExportAudit(auditId, { status: 'failed', error: 'export target unavailable' });
        return res.status(503).json({
          error: 'Database export is unavailable on this deployment.',
          code: 'unavailable',
        });
      }

      // The one dump, platform-wide: its row is the claim.
      const claim = await dbExport.beginExport(pool, auditId);
      if (!claim.claimed && claim.reason === 'gone') {
        return res.status(403).json({
          error: 'This export link has expired. Start the export again.',
          code: 'ticket_invalid',
        });
      }
      if (!claim.claimed) {
        await finishExportAudit(auditId, { status: 'denied', error: 'another export was already running' });
        return res.status(409).json({
          error: 'An export is already in progress. Try again shortly.',
          code: 'in_progress',
        });
      }

      const filename = dbExport.exportFilename(target.dbName);
      log.warn('admin', 'Database export started', {
        by: req.user.username, dbName: target.dbName, auditId, filename,
      });

      let result;
      try {
        result = await dbExport.runExport({
          dbName: target.dbName,
          res,
          filename,
          onStart: () => {
            started = true;
            pool.query(
              `UPDATE db_exports SET started_at = NOW() WHERE id = $1`,
              [auditId]
            ).catch((err) => log.error('admin', 'db-export streaming mark failed', { message: err.message }));
          },
        });
      } finally {
        claim.end();
      }

      await finishExportAudit(auditId, {
        status: result.status,
        bytesSent: result.bytesSent,
        error: result.error,
        started,
      });

      log[result.status === 'completed' ? 'warn' : 'error']('admin', 'Database export finished', {
        by: req.user.username, dbName: target.dbName, auditId,
        status: result.status, bytesSent: result.bytesSent, rawBytes: result.rawBytes,
      });

      if (result.status === 'completed') {
        events.record(pool, {
          type: events.EVENT_TYPES.DB_EXPORTED,
          userId: req.user.id,
          metadata: { dbName: target.dbName, bytesSent: result.bytesSent, auditId },
        });
      }
    } catch (err) {
      log.error('admin', 'db-export stream failed', { message: err.message });
      await finishExportAudit(auditId, { status: 'failed', error: err.message, started });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
      else try { res.destroy(); } catch { /* socket already gone */ }
    }
  });

  // ── Email delivery ─────────────────────────────────────────
  //
  // The operator's view of platform outbound mail. Four routes, and the
  // split between them is the whole point: reads are open to any admin
  // (including view-only), the two that change something (which provider
  // sends, and the one that actually puts a message on the wire) are
  // full-admin-only.
  //
  // These live under /api/admin/mail and are ADDITIVE. The older
  // /api/v4/admin/settings/mail-status and /mail-activity pair that the
  // Topochain settings card reads is untouched — it is a different
  // console section with a different audience, and quietly repointing it
  // would be a second change riding on this one.

  // Conservative single-address check. Deliberately stricter than RFC
  // 5322: this is an operator typing their own inbox into a console, not
  // a signup form, so rejecting an exotic-but-legal address costs an
  // admin one retry while accepting a header-injecting one costs
  // everybody. No CR/LF anywhere, no comma or semicolon (one recipient,
  // not a list), and a length the ledger column can hold.
  const TEST_RECIPIENT_RE = /^[^\s@,;<>"'\\]+@[^\s@,;<>"'\\]+\.[A-Za-z]{2,}$/;

  function validateTestRecipient(raw) {
    if (typeof raw !== 'string') return { error: 'An email address is required.' };
    const to = raw.trim();
    if (!to) return { error: 'An email address is required.' };
    if (to.length > 255) return { error: 'That address is too long.' };
    if (/[\r\n]/.test(to)) return { error: 'That address is not a valid email address.' };
    if (!TEST_RECIPIENT_RE.test(to)) return { error: 'That address is not a valid email address.' };
    return { to };
  }

  // Configuration presence only — which provider is active, who named it
  // (an admin's saved choice, the deploy's variable, or neither), which keys
  // are absent, which flows break while it stays that way. describe()
  // returns no values by construction, so this response can never carry a
  // credential even though the page that renders it is admin-only.
  router.get('/api/admin/mail/status', async (req, res) => {
    try {
      const status = mail.describe(process.env, { saved: await mail.savedChoice(pool) });

      // Pre-fill the test form with the admin's own address when we have
      // one. The client session payload doesn't carry an email, so it
      // comes from here rather than from App.user.
      let suggestedRecipient = null;
      try {
        const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
        suggestedRecipient = (rows[0] && rows[0].email) || null;
      } catch (err) {
        // A missing suggestion is cosmetic; the card still works.
        log.warn('admin', 'Could not read the admin email for the mail card',
          { message: err.message });
      }

      res.json({ ...status, suggestedRecipient, canSendTest: !!req.user?.canAdminWrite });
    } catch (err) {
      log.error('admin', 'mail status failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The delivery ledger, newest first, with the 24-hour tally the card
  // shows above the table. `kind` filters to one message type (the
  // console uses it for the "Test emails only" toggle).
  router.get('/api/admin/mail/activity', async (req, res) => {
    try {
      const requested = Number(req.query.limit);
      const limit = Number.isFinite(requested)
        ? Math.min(100, Math.max(1, Math.floor(requested)))
        : 20;
      const kind = typeof req.query.kind === 'string' && req.query.kind.trim()
        ? req.query.kind.trim().slice(0, 64)
        : null;

      const [recent, totals, reports] = await Promise.all([
        pool.query(
          `SELECT id, kind, recipient, provider, status, error, created_at
             FROM mail_deliveries
            WHERE ($1::text IS NULL OR kind = $1)
            ORDER BY created_at DESC
            LIMIT ${limit}`,
          [kind]
        ),
        pool.query(
          `SELECT status, COUNT(*)::int AS n
             FROM mail_deliveries
            WHERE created_at > NOW() - INTERVAL '24 hours'
              AND ($1::text IS NULL OR kind = $1)
            GROUP BY status`,
          [kind]
        ),
        // The provider in force, an admin's saved choice included: delivered,
        // bounced and complained are shown only for the one whose webhook
        // reports them.
        mail.transportFor(config, pool).then(({ provider }) => (
          require('../services/mail/reports').readReports(pool, { provider: provider || null })
        )),
      ]);

      const last24h = {};
      for (const row of totals.rows) last24h[row.status] = row.n;

      res.json({ deliveries: recent.rows, last24h, kind, limit, reports });
    } catch (err) {
      log.error('admin', 'mail activity failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Change who sends platform mail. Full admins only, and a provider that is
  // not ready cannot be chosen: the point of the switch is a working path,
  // not a way to stop sign-in codes by accident. 409 carries the names of the
  // settings that are missing, never a value. The saved choice wins over
  // PLATFORM_MAIL_PROVIDER and is read at send time, so it needs no redeploy;
  // a staging preview saves it and goes on logging.
  router.put('/api/admin/mail/provider', requireAdminWrite, async (req, res) => {
    try {
      const name = typeof req.body?.provider === 'string'
        ? req.body.provider.trim().toLowerCase()
        : '';
      const before = mail.describe(process.env, { saved: await mail.savedChoice(pool) });
      const option = before.providers.find((o) => o.name === name);
      if (!option) {
        return res.status(400).json({ error: 'Unknown mail provider.', code: 'unknown_provider' });
      }
      if (!option.ready) {
        return res.status(409).json({
          error: 'That provider is not ready yet.',
          code: 'not_ready',
          missing: option.missing,
        });
      }
      await mail.setProvider(pool, name, req.user.id);
      events.record(pool, {
        type: events.EVENT_TYPES.MAIL_PROVIDER_CHANGED,
        userId: req.user.id,
        metadata: { from: before.provider || null, to: name },
      });
      log.warn('admin', 'Admin changed the mail provider', {
        by: req.user.username, from: before.provider || null, to: name,
      });
      res.json({ ok: true, status: mail.describe(process.env, { saved: name }) });
    } catch (err) {
      log.error('admin', 'mail provider change failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Send one diagnostic email.
  //
  // Full admins only (it spends provider quota and puts a real message in
  // somebody's inbox) and rate-limited on top of that. The response is
  // 200 for every outcome the mail service can REPORT — including
  // `failed` and `no_transport` — because those are answers to the
  // question the operator asked, not errors in asking it. Only a
  // malformed request gets a 4xx, and that path never writes a ledger
  // row: nothing was attempted.
  router.post('/api/admin/mail/test', requireAdminWrite, mailTestLimiter,
    async (req, res) => {
      try {
        const { to, error } = validateTestRecipient((req.body || {}).to);
        if (error) return res.status(400).json({ error });

        const outcome = await mail.sendTest(config, { to });

        events.record(pool, {
          type: events.EVENT_TYPES.MAIL_TEST_SENT,
          userId: req.user.id,
          metadata: { status: outcome.status, provider: outcome.provider, recipient: to },
        });

        log.warn('admin', 'Admin sent a test email', {
          by: req.user.username,
          status: outcome.status,
          provider: outcome.provider,
          reference: outcome.reference,
        });

        res.json({ outcome });
      } catch (err) {
        log.error('admin', 'mail test failed', { message: err.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

  // ── SMS delivery (Admin → SMS delivery) ──────────────────────────────
  //
  // Texts are sent by the provider chosen in the switch below: Firebase
  // (today's path), Brevo or Twilio. The status read names the platform
  // variables that are missing, never what any of them hold, and is open to
  // any admin. Its Sender IDs are the selected gateway's registry, or, while
  // Firebase sends, the first gateway that is ready (else Brevo's), so an
  // operator can check a registry before switching to it.
  router.get('/api/admin/sms/status', async (req, res) => {
    const chosen = await smsSelect.selection(pool).catch(() => null);
    const provider = smsSelect.describe(config, chosen);
    const selectedOption = provider.options.find((o) => o.name === provider.selected);
    const firebaseMissing = smsSelect.firebaseMissing(config);
    const readyGateway = provider.options.find((o) => smsSelect.isGateway(o.name) && o.ready);
    const senderProvider = smsSelect.isGateway(provider.selected)
      ? provider.selected
      : (readyGateway ? readyGateway.name : smsSelect.GATEWAYS[0]);
    res.json({
      offered: phoneAuth.offered(config),
      // Texts go out only when the SELECTED provider is configured; test
      // numbers (PHONE_TEST_CODE, never in production) need none.
      texts: !!(selectedOption && selectedOption.ready),
      testNumbers: phoneAuth.testNumbersOn(config),
      enabled: config.firebasePhoneAuthEnabled === true,
      projectId: config.firebaseProjectId || null,
      missing: firebaseMissing,
      canSendTest: !!req.user?.canAdminWrite,
      provider,
      senders: smsSenders.list(config, senderProvider),
      senderProvider,
      stagingLogOnly: provider.stagingLogOnly,
      // The Firebase backup for sign-in codes a gateway could not send
      // (services/firebase-phone-auth.js, FIREBASE BACKUP). `ready` is
      // Firebase being set up; without it the switch does nothing.
      fallback: {
        enabled: await smsSelect.fallbackEnabled(pool).catch(() => true),
        ready: phoneAuth.firebaseOffered(config),
      },
    });
  });

  // Switch the Firebase backup on or off. Full admins only.
  router.put('/api/admin/sms/fallback', requireAdminWrite, async (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(422).json({ error: 'enabled must be true or false.', code: 'invalid_enabled' });
    }
    try {
      await smsSelect.setFallback(pool, enabled, req.user.id);
      log.warn('admin', 'Admin switched the Firebase SMS backup', { by: req.user.username, enabled });
      res.json({ ok: true, enabled });
    } catch (err) {
      log.error('admin', 'sms fallback change failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Change who sends texts. Full admins only, and a provider that is not
  // ready cannot be chosen: the point of the switch is a working path, not
  // a way to close phone sign-in by accident. 409 carries what is missing.
  router.put('/api/admin/sms/provider', requireAdminWrite, async (req, res) => {
    try {
      const name = typeof req.body?.provider === 'string'
        ? req.body.provider.trim().toLowerCase()
        : '';
      const option = smsSelect.describe(config, null)
        .options.find((o) => o.name === name);
      if (!option) {
        return res.status(400).json({ error: 'Unknown SMS provider.', code: 'unknown_provider' });
      }
      if (!option.ready) {
        return res.status(409).json({
          error: 'That provider is not ready yet.',
          code: 'not_ready',
          missing: option.missing,
        });
      }
      const before = await smsSelect.selection(pool).catch(() => null);
      await smsSelect.setProvider(pool, name, req.user.id);
      events.record(pool, {
        type: events.EVENT_TYPES.SMS_PROVIDER_CHANGED,
        userId: req.user.id,
        metadata: { from: before ? before.provider : null, to: name },
      });
      log.warn('admin', 'Admin changed the SMS provider', {
        by: req.user.username, from: before ? before.provider : null, to: name,
      });
      res.json({ ok: true, provider: smsSelect.describe(config, { provider: name, source: 'admin' }) });
    } catch (err) {
      log.error('admin', 'sms provider change failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Send one diagnostic text. Full admins only (it is a real, billed text
  // to a number of the operator's choosing) and rate-limited per admin and
  // per number. 200 for every answer Firebase gave — `refused` and
  // `unreachable` are answers to the operator's question, the way the mail
  // test's `failed` is. A malformed number is 400 and nothing is sent; an
  // unconfigured platform is 409 and nothing is sent.
  router.post('/api/admin/sms/test', requireAdminWrite, smsTestLimiter, smsTestNumberLimiter,
    async (req, res) => {
      try {
        const body = req.body || {};
        let outcome;
        try {
          outcome = await phoneAuth.sendTestCode(config, body.phoneNumber, body.recaptchaToken, { pool });
        } catch (err) {
          if (err instanceof phoneAuth.PhoneAuthError) {
            return res.status(err.status).json({ error: err.message, code: err.code });
          }
          throw err;
        }
        if (outcome.status === 'not_offered') {
          return res.status(409).json({
            error: 'SMS is not set up, so there is no text to test.',
            code: 'not_offered',
          });
        }

        const phoneLast4 = outcome.phoneNumber.slice(-4);
        events.record(pool, {
          type: events.EVENT_TYPES.SMS_TEST_SENT,
          userId: req.user.id,
          metadata: {
            status: outcome.status,
            provider: outcome.provider || null,
            country: outcome.country || null,
            providerCode: outcome.providerCode,
            phoneLast4,
          },
        });

        log.warn('admin', 'Admin sent a test SMS', {
          by: req.user.username,
          status: outcome.status,
          providerCode: outcome.providerCode,
          phone: `…${phoneLast4}`,
        });

        res.json({ outcome: { ...outcome, sentAt: new Date().toISOString() } });
      } catch (err) {
        log.error('admin', 'sms test failed', { message: err.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

  // The delivery log: every send through the SMS layer, whatever its
  // outcome, with the country, the Sender ID, the provider's message id and the
  // number's last four digits. Any admin, as the failure log is.
  router.get('/api/admin/sms/deliveries', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, kind, provider, country, sender_id, phone_last4, status,
                error_code, provider_code, provider_message_id, attempts,
                delivery_status, created_at
           FROM sms_deliveries
          ORDER BY created_at DESC, id DESC
          LIMIT 50`
      );
      return res.json({ deliveries: rows });
    } catch (err) {
      log.error('admin', 'sms deliveries read failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The failure log the test send cannot answer on its own: every failed
  // phone code request, verification and link attempt real callers made
  // (routes/phone-auth.js fail()), newest first, with the account name and
  // Firebase's own code beside this API's. Any admin: it holds what the
  // users table already shows them plus error codes, never a phone number
  // (its last four digits only) and never session material.
  router.get('/api/admin/sms/failures', async (req, res) => {
    try {
      const { failures, total7d } = await phoneFailureLog.recentFailures(pool, 50);
      return res.json({ failures, total7d });
    } catch (err) {
      log.error('admin', 'sms failures read failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { adminRoutes };
