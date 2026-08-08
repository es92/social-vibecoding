'use strict';

// #1049: the alternate development flows, offered IN the platform.
//
// Usernode has had a second way to build for a while: instead of spending
// daily AI credits here, hand a work order to the coding agent the user
// already pays for — Claude Code (claude.ai/code) or Codex
// (chatgpt.com/codex) — let it push a branch to their own fork, and turn
// the result into an ordinary proposal. Every piece of that already worked.
// Almost nobody used it, because the ONLY door was the MCP connector:
// production has 299 accounts, one linked GitHub login and three
// external-agent tasks ever, while 32 distinct users have hit their daily
// credit limit. The flow was not missing; it was invisible.
//
// So these routes put the same engine behind the browser. They are thin:
// prepareWork / submitWork / inspectFork / inspectPushedBranch in
// services/external-agent-tasks.js are plain functions with no MCP
// coupling, and this file only resolves the app, shapes a status payload
// and maps the service's structured failures onto HTTP.
//
//   GET  /api/apps/:slug/dev-flow/status         → the walkthrough's state
//   POST /api/apps/:slug/external-tasks          → prepare a work order
//   POST /api/apps/:slug/external-tasks/:id/submit → open the PR + import
//
// The connector is now one way in, not the way in. Anyone who has linked
// GitHub can run the whole flow from the dev chat.
//
// AUTH: all three sit behind the global /api/* gate (middleware/auth.js) and
// re-resolve the app through appAccess with 'collab' — the same bar the
// browser's own proposal paths use. The two POSTs additionally carry the
// same-origin check the connector-management routes use, because they spend
// a rate-limit slot and open a pull request.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const externalAgentTasks = require('../services/external-agent-tasks');
const githubLink = require('../services/github-link');
const connectorLimits = require('../services/connector-limits');

// The three values the picker can send. 'external' is deliberately absent:
// it is what normalizeAgent falls back to for an unrecognised MCP client,
// not something a person chooses from a list of two products.
const PICKABLE_AGENTS = ['claude-code', 'codex'];

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Service failure code → HTTP status. Anything unmapped is a 400: the
// service's failures are all "you or your GitHub account needs to do
// something", never a bug on this side, and the client renders the
// service's own wording either way. The keys are the complete set of codes
// external-agent-tasks.js and connector-limits.js can emit, and
// tests/dev-flow-routes.test.js scrapes both files to keep it that way — an
// unmapped code would answer 400 for something that is really a 429 or a
// 502, which is what a retry policy reads.
const STATUS_BY_CODE = {
  no_repository: 409,
  platform_unavailable: 503,
  github_link_unavailable: 503,
  github_not_linked: 409,
  unknown_task: 404,
  no_access: 403,
  fork_mismatch: 403,
  fork_collab_denied: 403,
  branch_not_found: 409,
  no_commits: 409,
  already_submitted: 409,
  pr_open_failed: 502,
  import_failed: 502,
  invalid_request: 400,
  at_capacity: 429,
};

// Same-origin guard for the two writes, copied in spirit from
// routes/mcp-remote.js's browserCsrf: these are cookie-authenticated
// mutations that spend a slot and can open a pull request, so a
// cross-origin form post must not reach them.
function sameOrigin(config, req, res) {
  if (req.headers.origin && req.headers.origin !== config.cliAuthOrigin) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite != null && fetchSite !== 'same-origin') {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

function sendFailure(res, result) {
  const status = STATUS_BY_CODE[result.code] || 400;
  return res.status(status).json({
    error: result.message || 'That did not work.',
    code: result.code || 'error',
    retryable: !!result.retryable,
    ...(result.settingsUrl ? { settingsUrl: result.settingsUrl } : {}),
  });
}

// The origin the service stamps into work orders and settings links. The
// canonical public origin, never the Host header a caller controls.
function originOf(config) {
  return config.cliAuthOrigin || '';
}

// The loopback the import runs through, so the browser flow reuses
// POST /api/apps/:slug/pr-import EXACTLY as the browser's own import button
// does — same access check, same announcement, same staging build kick.
// 127.0.0.1 + this process's own port, so it cannot leave the box.
function loopbackBase(config) {
  return `http://127.0.0.1:${config.port || 3000}`;
}

function taskDeps(pool, config) {
  return {
    pool,
    config,
    gh: require('../services/github'),
    githubLink,
    limits: connectorLimits,
    prompts: require('../services/prompts'),
  };
}

// How many live connector grants this account has. Advisory only — the
// walkthrough never requires one — but worth showing at the hand-off step,
// where "you already have Claude connected" changes the instructions from
// "paste this" to "or just tell Claude to pick it up".
async function connectorCount(pool, userId) {
  if (IS_STAGING) return 0;
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT t.grant_id)::int AS n
         FROM mcp_tokens t
        WHERE t.user_id = $1
          AND t.revoked_at IS NULL
          AND t.expires_at > clock_timestamp()`,
      [userId]
    );
    return rows[0]?.n || 0;
  } catch {
    // mcp_tokens is staging:private and the whole connector feature can be
    // switched off — an unreadable count is "none", never a failed status.
    return 0;
  }
}

// inspectPushedBranch answers with a bare string. The walkthrough wants a
// shape it can render three ways, so the mapping lives here rather than
// being re-derived in the client.
function shapeBranch(state) {
  return {
    state,
    pushed: state === 'pushed',
    // 'unpushed' is the one state worth naming out loud: the branch exists
    // but still points at the commit it started from, which is "you
    // committed locally and never pushed" almost every time.
    unpushed: state === 'unpushed',
    missing: state === 'missing',
  };
}

function devFlowRoutes(config) {
  const router = Router();
  const pool = getPool();

  // ── The walkthrough's state ──────────────────────────────────────────
  //
  // One request answers every step: is GitHub linked, is there a fork, is
  // there a work order already, has the branch been pushed. The client
  // re-polls this on "Check again" and when the tab regains focus, which is
  // what makes the guided flow feel like it is watching along.
  router.get('/api/apps/:slug/dev-flow/status', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });

      const gh = require('../services/github');
      const parsed = app.repo_url ? gh.parseGithubUrl(app.repo_url) : null;
      const linkAvailable = githubLink.isEnabled(config);

      // Staging mock data (#555 convention): external_agent_tasks and
      // mcp_tokens are both staging:private, and a staging clone has no
      // GitHub OAuth app either — so without this a reviewer sees the
      // "unavailable" branch and can review nothing. Obviously-fake,
      // read-only, written nowhere, and a strict no-op in production.
      if (IS_STAGING) {
        return res.json(req.query.demo === '1'
          ? demoStatus(app, parsed)
          : {
            // The picker's own state: the flow is offerable, nothing is
            // linked, no work order exists. Fixture session 990403 renders
            // against exactly this; ?demo=1 moves it on to the walkthrough.
            // Nothing here can DO anything — both writes answer 503 in
            // staging — so this only decides what a reviewer can see.
            available: true,
            reason: null,
            demo: true,
            repo: parsed || null,
            github: { linked: false, login: null, available: true },
            connectors: { count: 0 },
            fork: null,
            task: null,
            branch: null,
          });
      }

      if (!parsed || !gh.isEnabled() || !linkAvailable) {
        return res.json({
          available: false,
          reason: !parsed ? 'no_repository' : (!gh.isEnabled() ? 'platform_unavailable' : 'link_unavailable'),
          repo: parsed || null,
          github: { linked: false, login: null, available: linkAvailable },
          connectors: { count: await connectorCount(pool, req.user.id) },
          fork: null,
          task: null,
          branch: null,
        });
      }

      const link = await githubLink.linkStatus(pool, req.user.id);
      const linked = !!(link && link.linked && link.login);
      const payload = {
        available: true,
        reason: null,
        repo: { owner: parsed.owner, repo: parsed.repo },
        github: { linked, login: linked ? link.login : null, available: true },
        connectors: { count: await connectorCount(pool, req.user.id) },
        fork: null,
        task: null,
        branch: null,
      };

      if (!linked) return res.json(payload);

      // Step 2. Advisory exactly as it is inside prepareWork: a read that
      // fails reports 'unknown' rather than asserting the user has no fork.
      const fork = await externalAgentTasks.inspectFork(link.login, parsed);
      const forkState = ['ready', 'name_conflict', 'unknown'].includes(fork.state)
        ? fork.state
        : 'missing';
      const forkRepoName = forkState === 'name_conflict'
        ? `${parsed.repo}${externalAgentTasks.CONFLICT_FORK_SUFFIX}`
        : ((fork.fork && fork.fork.name) || parsed.repo);
      payload.fork = {
        state: forkState,
        owner: link.login,
        repo: forkRepoName,
        url: `https://github.com/${link.login}/${forkRepoName}`,
        pageUrl: `https://github.com/${parsed.owner}/${parsed.repo}/fork`,
      };

      // Steps 3-5. An open task is RE-RENDERED from its stored values —
      // same branch, same base commit — so reopening the chat resumes the
      // walkthrough instead of restarting it.
      const task = await externalAgentTasks.loadLatestOpenTaskForSlug(pool, req.user.id, app.slug);
      if (task) {
        const rendered = externalAgentTasks.renderPreparedTask({
          task,
          app,
          owner: parsed.owner,
          repo: parsed.repo,
          origin: originOf(config),
          // The agent this task was prepared for. The browser flow records
          // it as the client id (`usernode-web:<agent>`), which is exactly
          // what normalizeAgent reads — so the choice survives a reload
          // without a column of its own.
          clientId: task.client_id,
          prompts: require('../services/prompts'),
          forkStatus: forkState,
          reused: true,
        });
        payload.task = {
          id: rendered.taskId,
          agent: rendered.agent,
          branch: rendered.branch,
          baseSha: rendered.baseSha,
          forkOwner: rendered.forkOwner,
          forkRepo: rendered.forkRepo,
          forkUrl: rendered.forkUrl,
          forkPageUrl: rendered.forkPageUrl,
          issueNumber: task.issue_number || null,
          brief: task.brief || '',
          guidance: rendered.guidance,
          workOrder: rendered.workOrder,
        };
        let branchState = 'unknown';
        try {
          branchState = await externalAgentTasks.inspectPushedBranch(
            task, task.branch_name, task.fork_repo
          );
        } catch (err) {
          log.warn('dev-flow', 'branch inspect failed', { taskId: task.id, err: err.message });
        }
        payload.branch = shapeBranch(branchState);
      }

      return res.json(payload);
    } catch (err) {
      log.error('dev-flow', 'status failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Prepare a work order ─────────────────────────────────────────────
  //
  // body { agent, brief?, issueNumber?, restart? }
  //
  // Idempotent per (user, app, request) exactly as the connector's
  // prepare_work is — asking twice returns the task that already exists,
  // and only genuinely new work spends an hourly slot.
  router.post('/api/apps/:slug/external-tasks', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!sameOrigin(config, req, res)) return undefined;

    // Not String(...): String(['codex']) is 'codex', so an array would slip
    // past the allowlist and reach prepareWork as a non-string.
    const agent = typeof req.body?.agent === 'string' ? req.body.agent : '';
    if (!PICKABLE_AGENTS.includes(agent)) {
      return res.status(400).json({ error: `agent must be one of ${PICKABLE_AGENTS.join(', ')}`, code: 'invalid_request' });
    }
    const brief = typeof req.body?.brief === 'string' ? req.body.brief : '';
    const rawIssue = req.body?.issueNumber;
    const issueNumber = Number.isInteger(rawIssue) && rawIssue > 0 ? rawIssue : null;
    if (!brief.trim() && !issueNumber) {
      return res.status(400).json({
        error: 'Describe the change you want first — the work order needs something to hand your agent.',
        code: 'invalid_request',
      });
    }

    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (IS_STAGING) {
        return res.status(503).json({
          error: 'Preparing work for an external agent is disabled in a staging preview.',
          code: 'platform_unavailable',
        });
      }

      const result = await externalAgentTasks.prepareWork(taskDeps(pool, config), {
        user: req.user,
        app,
        issueNumber,
        brief,
        agent,
        // Recorded on the row, and the SAME string normalizeAgent reads
        // back on the status route — so the picked agent survives a reload
        // without adding a column.
        clientId: `usernode-web:${agent}`,
        clientName: 'Usernode',
        origin: originOf(config),
        restart: !!req.body?.restart,
      });
      if (!result.ok) return sendFailure(res, result);

      log.info('dev-flow', 'work order prepared', {
        userId: req.user.id, slug: app.slug, agent, taskId: result.taskId, reused: result.reused,
      });
      return res.json(result);
    } catch (err) {
      log.error('dev-flow', 'prepare failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Submit the pushed branch ─────────────────────────────────────────
  //
  // body { title?, body?, branch?, forkRepo? }
  //
  // Opens the cross-fork pull request with the platform's own credentials
  // and hands it to /api/apps/:slug/pr-import, so what lands is an ordinary
  // imported proposal. Every gate the connector path applies (attribution,
  // promoted cap, proposal rate) applies here too — they live in
  // submitWork, not in the transport.
  router.post('/api/apps/:slug/external-tasks/:id/submit', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!sameOrigin(config, req, res)) return undefined;

    // Digits only — parseInt('1.5.2') is 1, which would submit a DIFFERENT
    // task than the one the caller named.
    const taskId = /^\d+$/.test(req.params.id) ? parseInt(req.params.id, 10) : NaN;
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ error: 'Bad task id', code: 'invalid_request' });
    }

    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (IS_STAGING) {
        return res.status(503).json({
          error: 'Submitting external work is disabled in a staging preview.',
          code: 'platform_unavailable',
        });
      }

      const cookie = req.headers.cookie || '';
      const importProposal = async (targetSlug, prNumber) => {
        try {
          const resp = await fetch(`${loopbackBase(config)}/api/apps/${encodeURIComponent(targetSlug)}/pr-import`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              // The caller's OWN session, replayed: the import then runs
              // under exactly the authorization the browser had, and the
              // proposal is attributed to them rather than to the platform.
              cookie,
            },
            body: JSON.stringify({ pr: prNumber }),
          });
          const text = await resp.text();
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
          return { ok: resp.ok, status: resp.status, body: parsed };
        } catch (err) {
          log.warn('dev-flow', 'pr-import loopback failed', { err: err.message });
          return { ok: false, status: 0, body: null, networkError: true };
        }
      };

      const result = await externalAgentTasks.submitWork(taskDeps(pool, config), {
        user: req.user,
        clientName: 'Usernode',
        clientId: 'usernode-web',
        taskId,
        slug: app.slug,
        branch: typeof req.body?.branch === 'string' ? req.body.branch : undefined,
        forkRepo: typeof req.body?.forkRepo === 'string' ? req.body.forkRepo : undefined,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        body: typeof req.body?.body === 'string' ? req.body.body : undefined,
        source: 'web',
        importProposal,
      });
      if (!result.ok) return sendFailure(res, result);

      log.info('dev-flow', 'external work submitted', {
        userId: req.user.id, slug: app.slug, taskId,
        proposalId: result.proposalId, via: result.submittedVia,
      });
      return res.json(result);
    } catch (err) {
      log.error('dev-flow', 'submit failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// Staging mock data. Same rules as every other ?demo=1 branch on the
// platform: obviously fake, read-only, written nowhere, impossible in
// production (IS_STAGING gates the caller). It puts the walkthrough at
// step 4 — GitHub linked, fork ready, work order in hand, branch not yet
// pushed — because that is the step with the most to review.
function demoStatus(app, parsed) {
  const owner = (parsed && parsed.owner) || 'usernode-apps';
  const repo = (parsed && parsed.repo) || app.slug;
  const login = 'octo-contributor';
  const branch = 'usernode/staging-fixture-1049';
  const baseSha = '0123456789abcdef0123456789abcdef01234567';
  return {
    available: true,
    reason: null,
    demo: true,
    repo: { owner, repo },
    github: { linked: true, login, available: true },
    connectors: { count: 1 },
    fork: {
      state: 'ready',
      owner: login,
      repo,
      url: `https://github.com/${login}/${repo}`,
      pageUrl: `https://github.com/${owner}/${repo}/fork`,
    },
    task: {
      id: 990501,
      agent: 'claude-code',
      branch,
      baseSha,
      forkOwner: login,
      forkRepo: repo,
      forkUrl: `https://github.com/${login}/${repo}`,
      forkPageUrl: `https://github.com/${owner}/${repo}/fork`,
      issueNumber: null,
      brief: 'Add a dark-mode toggle to the settings screen.',
      // An array, exactly as renderPreparedTask returns — a reviewer looking
      // at the demo payload should see the real shape, not a stand-in one.
      guidance: [
        `Fork ${owner}/${repo} on GitHub — your fork is ${login}/${repo}.`,
        'Open https://claude.ai/code and start a new session.',
        `Choose ${login}/${repo} as its repository.`,
        'Paste the work order below in exactly as written.',
        'Come back here when it has pushed; Usernode submits the change itself.',
      ],
      workOrder: [
        `You are working on the Usernode app "${app.name || app.slug}".`,
        '',
        `Repository to fork from: https://github.com/${owner}/${repo}`,
        `Your fork: https://github.com/${login}/${repo}`,
        `Branch to create: ${branch}`,
        `Base commit: ${baseSha}`,
        '',
        'TASK',
        'Add a dark-mode toggle to the settings screen.',
        '',
        'When you are done, commit and push the branch, then come back to',
        'Usernode and press "Submit for review".',
      ].join('\n'),
    },
    branch: shapeBranch('missing'),
  };
}

module.exports = { devFlowRoutes, PICKABLE_AGENTS, STATUS_BY_CODE, shapeBranch };
