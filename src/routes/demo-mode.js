const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const staging = require('../services/staging');
const ws = require('../services/ws');
const notifications = require('../services/notifications');
const notificationPreferences = require('../services/notification-preferences');
const activeUsers = require('../services/active-users');
const appAccess = require('../services/app-access');
const events = require('../services/events');
const topicAttrs = require('../services/topic-attributes');
const usernames = require('../services/usernames');
const appManifest = require('../services/app-manifest');
const governanceService = require('../services/governance');
const prImportSync = require('../services/pr-import-sync');
const sessionLifecycle = require('../services/session-lifecycle');
const externalAgentPatch = require('../services/external-agent-patch');
const { reviewedHeadForSession } = require('../services/pr-vote-revision');
const { drainGuard } = require('../services/lifecycle');
const votes = require('./votes');

// Demo mode — a synthetic partner, on one app, for recording the proposal
// flow.
//
// A recording of "somebody proposes a change, you get the notification, you
// preview it, you vote, it merges" needs a second participant who acts on
// cue, and it needs to be re-shootable: the app has to go back to where it
// started between takes. Asking a person to tap at the right moment twelve
// times is not a plan, and a script holding a real account's session is a
// credential lying around. So the second participant is SYNTHETIC: a users
// row the platform owns, that cannot sign in, and that acts only through the
// five routes here.
//
// ── Containment ───────────────────────────────────────────────────────
//
// This is the part worth being precise about. A triggerable account that
// proposes and votes is, in the wrong shape, a lever for manufacturing
// consent on a platform whose whole premise is that changes merge by group
// vote. Four things keep it the right shape:
//
//   1. The partner cannot authenticate. Its password is random and thrown
//      away, it has no OAuth link, and both the session middleware and the
//      login route refuse an is_synthetic row outright (middleware/auth.js,
//      routes/auth.js) — a session row that named it is no session.
//   2. Every route here checks the app is in demo mode AND the caller is
//      its creator AND a full platform admin. Two fences, not one: the
//      creator fence keeps this off anybody else's app; the admin fence
//      keeps it a platform-people feature rather than something every
//      creator holds over an app other people use — the partner's yes
//      counts like a person's, and on a small shared app creator plus
//      partner reach the unopposed threshold. Never admin INSTEAD of
//      creator: that would be the override that acts on somebody else's
//      app. Demo mode is a thing you do to your own app.
//   3. The platform's own app can never be in demo mode.
//   4. The partner's standing as a voter (services/active-users.js) is
//      written for the demo app only and removed when demo mode goes off.
//      It counts for nothing anywhere else.
//
// And it is marked: the app's settings dialog says the app is in demo mode
// and names the partner (routes/apps.js exposes demo_partner for that).
//
// ── What each route does ───────────────────────────────────────────────
//
// The proposal is REAL. demo/propose opens a pull request from a branch
// already on the app's repository, or from a patch it applies there itself
// (the repository is the platform's own; the creator cannot push to it), as
// the platform's own bot — the same authorship every connector submission
// has — and files it as an imported
// proposal owned by the partner, already promoted. Imported is the right
// source: the preview, checks, head-sync and merge machinery all key off it
// (services/pr-import-sync.js, checkAndMerge) and none of it needs a
// dev-chat worker. Then it does the one thing pr-import's own straight-to-
// vote path does not: the pr_proposed fan-out, which is the notification the
// viewer is waiting for.
//
// A take has two cues, not one, when the operator wants them apart. With
// `hold: true` demo/propose files the same proposal as an UNSHARED
// in-progress row — status 'active', shared_at NULL — so the pull request
// opens and the preview and checks build exactly as above, but nothing is
// announced and nothing lists it: the In-progress area shows shared rows
// only, the vote list shows promoted ones, and the build narrates into the
// proposal's own thread, which nothing can open yet. demo/promote is the
// second cue, and it is the promotion routes/votes.js performs for a
// person's in-progress work — status 'promoted', the "promoted … for
// voting" lines, the event, the pr_proposed fan-out — with the partner's
// vote cast first when asked, so the card already reads "voted yes" when
// the notification is tapped. By then the preview is minutes old, which is
// the point: the beat the camera waits for is the notification, not a
// build.
//
// ── The approvals rule ─────────────────────────────────────────────────
//
// Switching demo mode on also puts the app into the "at least N approvals"
// mode (services/governance.js), N = 2 by default. Under the DEFAULT
// strategy a two-voter app whose proposal has one yes arms the
// lazy-consensus clock, and the card reads "Goes live in ~3d · 1/2" until
// the second vote lands. That is correct, and it is unrecordable: the beat
// on camera is "she has approved it, it is waiting on me", and what the
// screen says is a three-day countdown. In approvals mode the same moment
// reads "1 of 2 approvals", there is no clock at all, and the second yes
// still merges it immediately. Nothing about the vote changes: the same
// votes are cast, counted and gated.
//
// It is a GOVERNANCE column, so it is put back: the previous value is
// snapshotted into demo_prev_approvals on the way in and restored on the
// way out, and the app's settings dialog says the rule is in force while
// demo mode is on.
//
// demo/vote records the partner's vote through recordVote and hands the
// session to checkAndMerge, exactly as routes/votes.js does for a person.
// demo/reset tears the partner's proposals down, held ones included, puts
// main back to the commit demo mode was switched on at, and rebuilds
// production. GET demo lists what would silently spoil a take — the
// notification preference that defaults off, a creator who has not used
// the app lately — before the camera rolls, and says whether a held
// proposal's preview has finished building.

// Owner/repo from an app's repo_url, or null. Same shape as routes/votes.js.
function parseRepo(url) {
  const [, owner, repo] = (url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo: repo.replace(/\.git$/, '') } : null;
}

// Branch names arrive from a connected agent. Git's own rules are looser
// than this; the point is that nothing here becomes a path or a ref
// expression by accident.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
function validBranch(name) {
  return BRANCH_RE.test(name) && !name.includes('..')
    && !name.endsWith('/') && !name.endsWith('.lock');
}

const prLabel = (prNumber, title) => (title ? `PR #${prNumber}: ${title}` : `PR #${prNumber}`);

function demoModeRoutes(config) {
  const router = Router();
  const pool = getPool();

  // The one gate. Answers the app row, or null with the refusal already sent.
  //
  // Creator AND full platform admin — rule 2 above. canAdminWrite is
  // required on top of the creator check, never accepted in place of it:
  // the containment argument for a synthetic voter is that it exists on
  // YOUR app at YOUR request, and an admin override would turn that into
  // "somebody's app".
  async function loadDemoApp(req, res, { requireDemoMode = true } = {}) {
    const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', '*');
    if (!app) {
      res.status(404).json({ error: 'App not found' });
      return null;
    }
    if (app.self_hosted) {
      res.status(403).json({ error: 'The Homeroom platform app cannot be put in demo mode.' });
      return null;
    }
    if (req.user?.id == null || app.created_by !== req.user.id) {
      res.status(403).json({ error: 'Only the app\'s creator can use demo mode.' });
      return null;
    }
    if (!req.user.canAdminWrite) {
      res.status(403).json({ error: 'Demo mode is for an app\'s creator who is also a full platform admin.' });
      return null;
    }
    if (requireDemoMode && !app.demo_mode) {
      res.status(403).json({
        error: 'This app is not in demo mode. Switch it on first (POST /api/apps/:slug/demo-mode).',
      });
      return null;
    }
    return app;
  }

  // The column says who the partner is; the flag says what it is. A row
  // that has lost its flag is not something anybody may act as.
  async function loadPartner(app) {
    if (!app.demo_partner_id) return null;
    const { rows } = await pool.query(
      'SELECT id, username, is_synthetic FROM users WHERE id = $1',
      [app.demo_partner_id]
    );
    return rows[0] && rows[0].is_synthetic ? rows[0] : null;
  }

  // The partner counts as a voter the way anybody does — by having used the
  // app lately (≥60s within 10 days, services/active-users.js) and, on a
  // collab-private app, by being a member. It cannot use anything, so demo
  // mode writes the standing for it: on this app only, refreshed each time
  // it acts, so the threshold stays at "both of you" however long the takes
  // go on.
  async function refreshPartnerStanding(app, partner, creatorId) {
    await pool.query(
      `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
       VALUES ($1, $2, 60, CURRENT_DATE)
       ON CONFLICT (app_id, user_id, date) DO UPDATE
         SET seconds_spent = GREATEST(app_activity.seconds_spent, 60)`,
      [app.id, partner.id]
    );
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
       VALUES ($1, $2, 'member', $3, NOW())
       ON CONFLICT (app_id, user_id) DO UPDATE SET status = 'member'`,
      [app.id, partner.id, creatorId]
    );
  }

  // The approvals rule a switch-on asks for: 2 unless told otherwise, and
  // an explicit null keeps the app on its own (timed) strategy for a take
  // that wants the countdown on camera. Answers { ok, value } or an error.
  function readApprovals(body) {
    if (!body || !('approvals' in body) || body.approvals === undefined) return { ok: true, value: 2 };
    if (body.approvals === null) return { ok: true, value: null };
    const n = Number(body.approvals);
    if (!Number.isInteger(n) || n < 1 || n > appManifest.MAX_APPROVALS_REQUIRED) {
      return { ok: false, error: `approvals must be a whole number between 1 and ${appManifest.MAX_APPROVALS_REQUIRED}, or null to leave the app's own rule alone.` };
    }
    return { ok: true, value: n };
  }

  // Every proposal the partner has on this app, any status. Reset removes
  // all of them; switching demo mode off requires there to be none.
  async function partnerSessions(app, partner) {
    const { rows } = await pool.query(
      `SELECT id, pr_number, status FROM chat_sessions
        WHERE app_id = $1 AND user_id = $2 ORDER BY id`,
      [app.id, partner.id]
    );
    return rows;
  }

  // The partner's proposal that is open now, with the app columns
  // checkAndMerge reads off the session (routes/votes.js selects the same).
  async function openDemoSession(app, partner) {
    const { rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
              a.self_hosted AS app_self_hosted
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
        WHERE cs.app_id = $1 AND cs.user_id = $2
          AND cs.status IN ('active', 'promoted', 'merging')
        ORDER BY cs.id DESC LIMIT 1`,
      [app.id, partner.id]
    );
    return rows[0] || null;
  }

  // ── What a promotion says, whom it reaches, and the partner's vote ──────
  //
  // Shared by demo/propose (straight to the vote) and demo/promote (a held
  // proposal, on cue). The group-chat lines, the session update and the
  // event are the ones routes/votes.js emits when a person promotes.
  async function announcePromotion({ app, partner, session }) {
    const line = `${partner.username} promoted ${prLabel(session.pr_number, session.pr_title)} for voting`;
    const meta = { vote: { sessionId: session.id, prNumber: session.pr_number } };
    await ws.sendSystemMessage(pool, app.id, line, 'vote', meta).catch(() => {});
    await ws.sendSystemMessage(pool, app.id, line, 'vote', meta, { type: 'session', ref: session.id })
      .catch(() => {});
    ws.pushSessionUpdate({ action: 'promoted', sessionId: session.id, appSlug: app.slug });
    try {
      events.record(pool, {
        type: events.EVENT_TYPES.PR_PROMOTED,
        userId: partner.id, appId: app.id, sessionId: session.id,
        metadata: { prNumber: session.pr_number, source: 'imported', demo: true },
      });
    } catch { /* events are best-effort */ }
  }

  // The beat the feature exists for. Same fan-out as the promote route in
  // routes/votes.js. The partner is the proposer, so it is excluded, and
  // the creator — active, and the app's creator — is who it reaches.
  // Answers how many it reached; a failed fan-out is a warning, not a
  // failed promotion.
  async function notifyVoters({ app, partner, session }) {
    try {
      const rows = await notifications.createPrProposedNotifications(pool, {
        appId: app.id, sessionId: session.id, proposerId: partner.id,
      });
      for (const row of rows) {
        ws.pushNotificationToUser(row.user_id, {
          type: 'notification_new',
          notification: notifications.serialize({
            ...row, app_slug: app.slug, app_name: app.name,
            pr_title: session.pr_title, pr_number: session.pr_number,
            source_username: partner.username,
          }),
        });
      }
      return rows.length;
    } catch (err) {
      log.warn('demo-mode', 'pr_proposed fan-out failed', { sessionId: session.id, err: err.message });
      return 0;
    }
  }

  // The partner's vote: the same write a person's click makes
  // (routes/votes.js), stamped with the reviewed head and the approval
  // epoch, under the row lock. No pre-vote reconciliation — the head is the
  // platform's own and nothing else writes that branch; checkAndMerge
  // re-verifies it regardless. True when it counted.
  //
  // No "somebody voted on your proposal" notification: the author IS the
  // partner, and a notification to an account that cannot sign in is a row
  // nobody reads.
  async function castPartnerVote({ app, partner, session, vote }) {
    const recorded = await votes.recordVote({
      pool, session, userId: partner.id, vote,
      headSha: reviewedHeadForSession(session), revisionEnforced: true,
    });
    if ((recorded.rowCount || 0) === 0) return false;
    const label = prLabel(session.pr_number || session.id, session.pr_title);
    await ws.sendSystemMessage(pool, app.id, `${partner.username} voted ${vote} on ${label}`, 'vote',
      { vote: { sessionId: session.id, prNumber: session.pr_number || null } },
      { type: 'session', ref: session.id }).catch(() => {});
    ws.pushVoteUpdate({ sessionId: session.id, appSlug: app.slug, merged: false });
    try {
      events.record(pool, {
        type: events.EVENT_TYPES.PR_VOTE_CAST,
        userId: partner.id, appId: app.id, sessionId: session.id, metadata: { vote, demo: true },
      });
    } catch { /* best-effort */ }
    return true;
  }

  // After a vote, the merge check — off the request, as routes/votes.js
  // runs it for a person's vote.
  function mergeCheckAfterVote(app, session) {
    votes.checkAndMerge(config, pool, session)
      .then((result) => {
        if (result?.merged) ws.pushVoteUpdate({ sessionId: session.id, appSlug: app.slug, merged: true });
      })
      .catch((err) => log.error('demo-mode', 'Background merge failed', {
        sessionId: session.id, err: err.message,
      }));
  }

  // ── The switch ─────────────────────────────────────────────────────────
  router.post('/api/apps/:slug/demo-mode', drainGuard, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res, { requireDemoMode: false });
      if (!app) return;
      const partner = await loadPartner(app);

      if (req.body?.enabled === false) {
        if (partner && (await partnerSessions(app, partner)).length) {
          return res.status(409).json({
            error: 'The partner still has proposals on this app. Reset demo mode first, then switch it off.',
          });
        }
        // The approvals rule goes back to whatever it was. Guarded on
        // demo_mode so switching off an app that is already off cannot read
        // an empty snapshot as "the default strategy" and clear a real
        // setting.
        const { rows: restored } = await pool.query(
          `UPDATE apps
              SET demo_mode = FALSE, demo_partner_id = NULL, demo_base_sha = NULL,
                  approvals_required = CASE WHEN demo_mode THEN demo_prev_approvals ELSE approvals_required END,
                  demo_prev_approvals = NULL
            WHERE id = $1
        RETURNING approvals_required`,
          [app.id]
        );
        governanceService.invalidateGovernance(app.id);
        if (partner) {
          // Its standing goes with it (rule 4 above), and so does the row: a
          // partner has no history left by now, and a synthetic account with
          // nothing to attribute is a name held for nobody.
          await pool.query('DELETE FROM users WHERE id = $1 AND is_synthetic = TRUE', [partner.id]);
        }
        const back = restored[0] ? restored[0].approvals_required : null;
        log.info('demo-mode', 'Demo mode off', { slug: app.slug, userId: req.user.id, approvalsRequired: back });
        return res.json({ demoMode: false, partner: null, baseSha: null, approvalsRequired: back });
      }

      const approvals = readApprovals(req.body);
      if (!approvals.ok) return res.status(400).json({ error: approvals.error });

      let who = partner;
      const wanted = typeof req.body?.partnerName === 'string' ? req.body.partnerName.trim() : '';
      if (who && wanted && wanted !== who.username) {
        return res.status(409).json({
          error: `This app's demo partner is @${who.username}. Switch demo mode off to choose another name.`,
        });
      }
      if (!who) {
        if (!wanted) {
          return res.status(400).json({ error: 'partnerName is required the first time demo mode is switched on.' });
        }
        const valid = usernames.validateUsername(wanted);
        if (!valid.ok) return res.status(400).json({ error: valid.error });
        const free = await usernames.checkAvailability(pool, valid.value, null);
        if (!free.available) return res.status(409).json({ error: free.error });
        // Random and discarded: nothing will ever compare equal to it, and
        // routes/auth.js refuses the row before comparing anyway.
        const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
        const { rows } = await pool.query(
          `INSERT INTO users (username, password, is_admin, can_create_apps, is_synthetic)
           VALUES ($1, $2, FALSE, FALSE, TRUE)
           RETURNING id, username, is_synthetic`,
          [valid.value, hash]
        );
        who = rows[0];
      }

      // Where main stands now is where reset puts it back. Read live when
      // GitHub is there; the deploy's own record otherwise.
      let baseSha = app.main_sha || null;
      const repo = parseRepo(app.repo_url);
      if (repo && github.isEnabled()) {
        try {
          const head = await github.getRepoHead(repo.owner, repo.repo);
          if (head?.headSha) baseSha = head.headSha;
        } catch (err) {
          log.warn('demo-mode', 'Could not read the repository head; using the deployed sha', {
            slug: app.slug, err: err.message,
          });
        }
      }
      // The snapshot is taken on the way IN and only then: switching on an
      // app that is already on must not overwrite it with demo mode's own
      // value, which would make the way out a no-op.
      await pool.query(
        `UPDATE apps
            SET demo_mode = TRUE, demo_partner_id = $1, demo_base_sha = $2,
                demo_prev_approvals = CASE WHEN demo_mode THEN demo_prev_approvals ELSE approvals_required END,
                approvals_required = $4
          WHERE id = $3`,
        [who.id, baseSha, app.id, approvals.value]
      );
      governanceService.invalidateGovernance(app.id);
      await refreshPartnerStanding(app, who, req.user.id);
      log.info('demo-mode', 'Demo mode on', {
        slug: app.slug, partner: who.username, baseSha, approvalsRequired: approvals.value,
      });
      res.json({
        demoMode: true, partner: { id: who.id, username: who.username }, baseSha,
        approvalsRequired: approvals.value,
      });
    } catch (err) {
      log.error('demo-mode', 'Switch failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Status: what would spoil the take ─────────────────────────────────
  router.get('/api/apps/:slug/demo', async (req, res) => {
    try {
      const app = await loadDemoApp(req, res, { requireDemoMode: false });
      if (!app) return;
      const partner = await loadPartner(app);
      const open = partner ? await openDemoSession(app, partner) : null;

      let tally = null;
      if (open) {
        const { rows } = await pool.query(
          'SELECT vote, COUNT(*)::int AS n FROM pr_votes WHERE session_id = $1 GROUP BY vote',
          [open.id]
        );
        tally = { yes: 0, no: 0 };
        for (const r of rows) if (r.vote in tally) tally[r.vote] = r.n;
      }
      const activeIds = await activeUsers.listActiveUserIds(pool, app.id);
      const activeCount = activeIds.length;
      // Which rule decides the threshold. In approvals mode it is the number
      // itself, and how lately anybody used the app does not enter into it.
      const gov = await governanceService.getGovernance(pool, app.id);
      const approvalsRequired = gov.approvalsRequired;
      const required = approvalsRequired != null
        ? approvalsRequired
        : activeUsers.requiredVotes(activeCount, tally ? tally.no : 0);
      const creatorActive = await activeUsers.isUserActive(pool, app.id, req.user.id);
      const partnerActive = partner ? await activeUsers.isUserActive(pool, app.id, partner.id) : false;
      const notify = await notificationPreferences.allowsKind(pool, {
        userId: req.user.id, appId: app.id, kind: 'pr_proposed',
      });

      const reasons = [];
      if (!app.demo_mode) reasons.push('Demo mode is off.');
      if (!partner) reasons.push('There is no partner yet: switch demo mode on with a partnerName.');
      if (!notify) {
        reasons.push('"New proposals to vote on" is off for you on this app (it defaults off), so no notification would arrive. Switch it on in the app\'s notification settings.');
      }
      if (approvalsRequired == null) {
        // Only the default strategy counts voters by how lately they used
        // the app; approvals mode counts votes.
        if (!creatorActive) {
          reasons.push('You have not used this app in the last 10 days, so you are not counted as a voter and the partner\'s yes would merge on its own. Open the app for a minute.');
        }
        if (partner && !partnerActive) {
          reasons.push('The partner is not counted as a voter; switching demo mode on again, or proposing, refreshes that.');
        }
        reasons.push('This app is on the default strategy, so a proposal with one yes counts down a lazy-consensus window and the card reads "Goes live in ~3d" rather than a tally. Switch demo mode on with approvals: 2 for the "1 of 2 approvals" card.');
      }
      if (required !== 2) {
        reasons.push(approvalsRequired != null
          ? `This app merges a proposal on ${required} approval(s); the take expects 2, so the partner's yes waits on yours.`
          : `${activeCount} active voter(s) means ${required} yes vote(s) merge a proposal; the take expects 2, so the partner's yes waits on yours.`);
      }

      res.json({
        demoMode: !!app.demo_mode,
        partner: partner ? { id: partner.id, username: partner.username } : null,
        baseSha: app.demo_base_sha || null,
        // null means the app's own (timed) strategy, where a single yes
        // shows a countdown rather than a tally.
        approvalsRequired: approvalsRequired ?? null,
        mainSha: app.main_sha || null,
        activeCount,
        required,
        creatorActive,
        partnerActive,
        notifyOnNewProposals: notify,
        openProposal: open ? {
          sessionId: open.id,
          status: open.status,
          // Held: filed, building, announced to nobody yet (demo/promote).
          held: open.status === 'active',
          prNumber: open.pr_number || null,
          prUrl: open.pr_url || null,
          title: open.pr_title || null,
          stagingUrl: open.staging_url || null,
          // The checks verdict on the preview: 'pending' while it builds,
          // 'passing' once it is the preview a vote would open.
          checkState: open.check_state || null,
          previewReady: !!open.staging_url,
          votes: tally,
        } : null,
        ready: reasons.length === 0,
        reasons,
      });
    } catch (err) {
      log.error('demo-mode', 'Status failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Propose ────────────────────────────────────────────────────────────
  router.post('/api/apps/:slug/demo/propose', drainGuard, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res);
      if (!app) return;
      const partner = await loadPartner(app);
      if (!partner) {
        return res.status(409).json({ error: 'Demo mode has no partner. Switch it on with a partnerName first.' });
      }

      const branchIn = typeof req.body?.branch === 'string' ? req.body.branch.trim() : '';
      const patch = typeof req.body?.patch === 'string' ? req.body.patch : '';
      if (branchIn && patch.trim()) {
        return res.status(400).json({ error: 'Pass either branch or patch, not both.' });
      }
      if (!branchIn && !patch.trim()) {
        return res.status(400).json({
          error: 'Pass branch (a branch already on the app\'s repository) or patch (the change as git diff or git format-patch output).',
        });
      }
      if (branchIn && !validBranch(branchIn)) {
        return res.status(400).json({ error: 'branch must name a branch on the app\'s repository.' });
      }
      const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 256) : '';
      if (!title) return res.status(400).json({ error: 'title is required.' });
      const description = typeof req.body?.description === 'string' ? req.body.description : '';
      const summary = typeof req.body?.summary === 'string' && req.body.summary.trim()
        ? req.body.summary.trim() : null;
      const testingPaths = Array.isArray(req.body?.testingPaths)
        ? req.body.testingPaths.filter((p) => typeof p === 'string' && p.trim())
          .map((p) => p.trim()).slice(0, 3)
        : [];
      // Held: filed as the partner's unshared in-progress work, so the pull
      // request opens and the preview builds while nothing is announced;
      // demo/promote is the cue that puts it up for the vote.
      const hold = req.body?.hold === true;

      const repo = parseRepo(app.repo_url);
      if (!repo || !github.isEnabled()) {
        return res.status(409).json({ error: 'GitHub is not configured for this app.' });
      }
      if (await openDemoSession(app, partner)) {
        return res.status(409).json({ error: 'A demo proposal is already open. Reset before proposing again.' });
      }

      let branch = branchIn;
      let headSha;
      // Only a branch this call created is this call's to remove.
      let discardBranch = async () => {};
      if (patch.trim()) {
        // The app's repository is the platform's own and its creator cannot
        // push there, so a change usually arrives as a patch, applied at
        // main's current head and pushed as the bot. Same path, same bounds
        // as submit_work's patch shape (services/external-agent-patch.js):
        // size-capped before git runs, .github/** refused, every path
        // enumerated first. Applied at the LIVE head rather than the recorded
        // base: after a reset they are the same commit, and between takes
        // that did not reset, the live head is the one a PR can merge into.
        let baseSha = app.main_sha || null;
        try {
          const live = await github.getRepoHead(repo.owner, repo.repo);
          if (live?.headSha) baseSha = live.headSha;
        } catch (err) {
          log.warn('demo-mode', 'Could not read the repository head; applying at the deployed sha', {
            slug: app.slug, err: err.message,
          });
        }
        const applied = await externalAgentPatch.applyPatch({
          owner: repo.owner, repo: repo.repo, patch, baseSha,
          userId: partner.id, taskId: `demo-${app.id}`,
        });
        if (!applied.ok) {
          const status = applied.code === 'patch_too_large' ? 413
            : applied.code === 'platform_unavailable' ? 503
              : applied.code === 'patch_did_not_apply' ? 409 : 400;
          return res.status(status).json({
            error: applied.message || 'The patch could not be applied.', code: applied.code || null,
          });
        }
        branch = applied.branch;
        headSha = applied.headSha;
        if (typeof applied.cleanup === 'function') discardBranch = applied.cleanup;
      } else {
        try {
          headSha = await github.getBranchSha(repo.owner, repo.repo, branch);
        } catch (err) {
          return res.status(404).json({ error: `Branch "${branch}" was not found on ${repo.owner}/${repo.repo}.` });
        }
      }
      let pr;
      try {
        pr = await github.createPR(repo.owner, repo.repo, { branch, title, body: description });
      } catch (err) {
        // A branch this call pushed for a PR that never opened is litter;
        // applyPatch hands back the broom for exactly this.
        await discardBranch().catch(() => {});
        log.error('demo-mode', 'Opening the PR failed', { slug: app.slug, branch, err: err.message });
        return res.status(502).json({ error: 'GitHub did not open the pull request. Nothing was proposed.' });
      }
      const prNumber = pr.number;
      const prUrl = pr.html_url || null;
      // The PR is the bot's, as every connector submission's is; the PROPOSAL
      // is the partner's. It is the same split pr-import makes.
      const botLogin = await github.getBotUsername().catch(() => null);

      const { rows: inserted } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status,
            source, imported_pr_head_sha, imported_pr_author, imported_pr_head_repo,
            promoted_at, created_at, testing_path, testing_paths, linked_issues,
            pr_body, pr_summary_md)
         VALUES ($1, $2, $3, $4, $5, $6, $14::text,
            'imported', $7, $8, $9,
            CASE WHEN $14::text = 'promoted' THEN NOW() END, NOW(), $10, $11::jsonb, '{}', $12, $13)
         RETURNING id, status`,
        [
          app.id, partner.id, branch, prNumber, prUrl, title,
          headSha, botLogin, `${repo.owner}/${repo.repo}`,
          testingPaths[0] || null, testingPaths.length ? JSON.stringify(testingPaths) : null,
          description || null, summary,
          hold ? 'active' : 'promoted',
        ]
      );
      const sessionId = inserted[0].id;
      await topicAttrs.selfAssignProposal(pool, app.id, sessionId, partner);
      await refreshPartnerStanding(app, partner, req.user.id);

      const session = {
        id: sessionId, app_id: app.id, app_slug: app.slug, app_name: app.name,
        user_id: partner.id, branch_name: branch, pr_number: prNumber, pr_url: prUrl,
        pr_title: title, pr_body: description || null, pr_summary_md: summary,
        repo_url: app.repo_url, staging_url: null, source: 'imported',
        status: hold ? 'active' : 'promoted',
        imported_pr_head_sha: headSha, imported_pr_head_repo: `${repo.owner}/${repo.repo}`,
        testing_md: null, testing_path: testingPaths[0] || null,
        testing_paths: testingPaths.length ? testingPaths : null,
      };
      // Preview + checks, exactly as an import gets them. Never throws.
      prImportSync.kickImportedChecks({ config, pool, session, app, headSha });

      let notified = 0;
      if (hold) {
        // Nothing said and nothing listed. The build narrates into the
        // proposal's thread (pr-import-sync.postProposalNote), which nothing
        // can open until demo/promote.
        log.info('demo-mode', 'Demo proposal held', { slug: app.slug, sessionId, prNumber });
      } else {
        await announcePromotion({ app, partner, session });
        notified = await notifyVoters({ app, partner, session });
        log.info('demo-mode', 'Demo proposal opened', { slug: app.slug, sessionId, prNumber, notified });
      }
      res.json({ ok: true, sessionId, prNumber, prUrl, headSha, held: hold, notified });
    } catch (err) {
      log.error('demo-mode', 'Propose failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Promote: the second cue ────────────────────────────────────────────
  router.post('/api/apps/:slug/demo/promote', drainGuard, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res);
      if (!app) return;
      const partner = await loadPartner(app);
      if (!partner) return res.status(409).json({ error: 'Demo mode has no partner.' });
      const vote = req.body?.vote === 'yes' || req.body?.vote === 'no' ? req.body.vote : null;

      const session = await openDemoSession(app, partner);
      if (!session) {
        return res.status(404).json({ error: 'No demo proposal is held. Propose one with hold first.' });
      }
      if (session.status !== 'active') {
        return res.status(409).json({ error: 'The demo proposal is already up for the vote.' });
      }

      // What goes up for the vote is what was proposed. The promote route in
      // routes/votes.js re-reads the pull request before it opens voting and
      // fails closed when it cannot; so does this. Nothing else writes the
      // branch, so a moved head is a take that needs a reset, not a rebuild.
      const repo = parseRepo(app.repo_url);
      if (repo && github.isEnabled() && session.pr_number) {
        let pr;
        try {
          pr = await github.getPR(repo.owner, repo.repo, session.pr_number);
        } catch (err) {
          log.warn('demo-mode', 'Could not read the pull request before promoting', {
            sessionId: session.id, err: err.message,
          });
          return res.status(503).json({ error: 'GitHub could not verify the pull request. Try again shortly.' });
        }
        if (pr?.merged) {
          return res.status(409).json({
            error: `PR #${session.pr_number} was already merged on GitHub, so there is nothing to vote on. Reset before the next take.`,
          });
        }
        if (pr?.state === 'closed') {
          return res.status(409).json({ error: `PR #${session.pr_number} is closed on GitHub. Reset and propose again.` });
        }
        const head = String(pr?.head?.sha || '').toLowerCase();
        const proposedAt = String(session.imported_pr_head_sha || '').toLowerCase();
        if (head && proposedAt && head !== proposedAt) {
          return res.status(409).json({ error: 'The branch moved since it was proposed. Reset and propose again.' });
        }
      }

      // promoted_at anchors the stale-PR sweeper's clock, as in routes/
      // votes.js; the status guard is the same one, so two cues racing
      // cannot promote twice.
      const promoted = await pool.query(
        `UPDATE chat_sessions
            SET status = 'promoted', promoted_at = NOW(), stale_notified_at = NULL
          WHERE id = $1 AND status = 'active'`,
        [session.id]
      );
      if (!promoted.rowCount) return res.status(409).json({ error: 'session_state_changed' });
      session.status = 'promoted';
      await refreshPartnerStanding(app, partner, req.user.id);

      await announcePromotion({ app, partner, session });
      // The vote goes before the fan-out on purpose: the notification should
      // open on a card that already reads "voted yes".
      let voted = null;
      if (vote && await castPartnerVote({ app, partner, session, vote })) voted = vote;
      const notified = await notifyVoters({ app, partner, session });

      log.info('demo-mode', 'Demo proposal promoted', {
        slug: app.slug, sessionId: session.id, prNumber: session.pr_number, voted, notified,
      });
      res.json({ ok: true, sessionId: session.id, prNumber: session.pr_number || null, voted, notified });
      if (voted) mergeCheckAfterVote(app, session);
    } catch (err) {
      log.error('demo-mode', 'Promote failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Vote ───────────────────────────────────────────────────────────────
  router.post('/api/apps/:slug/demo/vote', drainGuard, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res);
      if (!app) return;
      const partner = await loadPartner(app);
      if (!partner) return res.status(409).json({ error: 'Demo mode has no partner.' });
      const vote = req.body?.vote === 'no' ? 'no' : 'yes';

      const session = await openDemoSession(app, partner);
      if (session && session.status === 'active') {
        return res.status(409).json({
          error: 'The demo proposal is held, not yet up for the vote. Promote it first (POST /api/apps/:slug/demo/promote), which can cast this vote as well.',
        });
      }
      if (!session || !['promoted', 'merging'].includes(session.status)) {
        return res.status(404).json({ error: 'No demo proposal is up for a vote.' });
      }
      if (!await castPartnerVote({ app, partner, session, vote })) {
        return res.status(409).json({ error: 'The proposal is no longer open for votes.' });
      }
      res.json({ ok: true, sessionId: session.id, vote });
      mergeCheckAfterVote(app, session);
    } catch (err) {
      log.error('demo-mode', 'Vote failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Reset ──────────────────────────────────────────────────────────────
  router.post('/api/apps/:slug/demo/reset', drainGuard, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res);
      if (!app) return;
      const partner = await loadPartner(app);
      if (!partner) return res.status(409).json({ error: 'Demo mode has no partner.' });
      const repo = parseRepo(app.repo_url);
      const githubUp = !!(repo && github.isEnabled());

      const sessions = await partnerSessions(app, partner);
      for (const s of sessions) {
        await sessionLifecycle.teardownStagingForSession({ pool, sessionId: s.id, reason: 'demo-reset' })
          .catch((err) => log.warn('demo-mode', 'Preview teardown failed', { sessionId: s.id, err: err.message }));
        if (githubUp && s.pr_number && s.status !== 'merged') {
          await github.closePR(repo.owner, repo.repo, s.pr_number)
            .catch((err) => log.warn('demo-mode', 'Closing the PR failed', { pr: s.pr_number, err: err.message }));
        }
      }
      const ids = sessions.map((s) => s.id);
      if (ids.length) {
        // pr_votes, notifications (the creator's pr_proposed included),
        // events and the preview record all cascade from the session.
        await pool.query('DELETE FROM chat_sessions WHERE id = ANY($1::int[])', [ids]);
      }

      let main = null;
      if (githubUp && app.demo_base_sha) {
        const moved = await github.forceBranchToSha(repo.owner, repo.repo, 'main', app.demo_base_sha);
        main = { from: moved.previousSha, to: moved.sha, moved: !!moved.updated };
      }
      await refreshPartnerStanding(app, partner, req.user.id);

      // Production follows main. Fire-and-forget, as the redeploy route in
      // routes/apps.js does; a failure lands on the deploy-status broadcast.
      let redeploy = 'skipped';
      if (main && main.moved) {
        redeploy = 'started';
        staging.rebuildProduction(config, app)
          .then(async ({ containerId, sha }) => {
            await pool.query(
              `UPDATE apps SET container_id = $1, main_sha = $2, status = 'running',
                               last_deploy_at = NOW()
               WHERE id = $3`,
              [containerId, sha || null, app.id]
            );
          })
          .catch((err) => log.warn('demo-mode', 'Rebuild after reset failed', { slug: app.slug, err: err.message }));
      }
      log.info('demo-mode', 'Demo reset', { slug: app.slug, removed: ids.length, main, redeploy });
      res.json({ ok: true, sessionsRemoved: ids.length, main, redeploy });
    } catch (err) {
      log.error('demo-mode', 'Reset failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { demoModeRoutes, parseRepo, validBranch };
