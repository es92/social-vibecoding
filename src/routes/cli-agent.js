'use strict';

// #907 — the wire protocol a local coding agent speaks.
//
// Eight endpoints, all under /api/cli/agent, all bearer-authenticated with
// the `agent:local` scope. They are mounted INSIDE cliPreAuthRoutes, before
// its terminal `/api/cli` 404, so they inherit the same no-store headers,
// the same IP and per-token rate limits, the same `token_used` audit row per
// call, and the same "whole surface 404s in staging" gate as device login.
//
// Deliberate non-goals:
//
//   * These paths are NOT reachable through the generic `api_read`/`api_write`
//     MCP bridge — cli-api-policy denies the whole `/api/cli` prefix. An agent
//     protocol that a model could drive by hand would let a prompt-injected
//     model claim someone's coding turn.
//
//   * The platform never sends the local agent a credential of any kind, and
//     never accepts one. It sends a prompt; it receives a commit SHA. The
//     user's own Anthropic subscription is used by their own machine, under
//     their own login, exactly as if they had typed `claude` themselves.
//
// The lease is always re-read and re-validated on every call rather than
// trusted from the previous one. A lease that lapsed thirty seconds ago must
// not be able to post a result.

const express = require('express');
const { getPool } = require('../db/pool');
const { AGENT_SCOPE } = require('../services/cli-auth-constants');
const localAgent = require('../services/local-agent');
const github = require('../services/github');
const { drainGuard } = require('../services/lifecycle');
const log = require('../services/logger');

const MAX_REASON_CHARS = 500;
const MAX_SUMMARY_CHARS = 16 * 1024;
// The commit upload reuses the proposal-handoff body validator verbatim
// rather than growing a second one — the rule that a bot-owned commit must
// reconstruct the tested local tree exactly is the same rule here.
const COMMIT_UPLOAD_JSON_LIMIT = '12mb';

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  if (!plainObject(value)) return false;
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) return null;
  return value;
}

function parseSessionId(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 2147483647) return null;
  return value;
}

function boundedText(value, max) {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  if (value.length > max) return undefined;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function cliAgentRoutes(config, { pool = getPool(config), auth } = {}) {
  const router = express.Router({ strict: true, caseSensitive: true });
  // Injected by cliPreAuthRoutes so this module does not re-require its
  // parent (which requires this one).
  const { jsonBody, activeTokenMiddleware, bearerIpGuard } = auth;
  const json4kb = jsonBody('4kb');
  // Progress batches are the only genuinely variable-size payload the machine
  // sends while a turn runs. 256kb is far more than a well-behaved runtime
  // sends and far less than a body worth streaming.
  const json256kb = jsonBody('256kb');
  // The result body has to be bigger, because a scout turn's result IS a
  // document: MAX_SPEC_CHARS is 256 KiB on its own, so a maximal spec plus
  // JSON escaping and the summary would 413 against a 256kb cap — the bound
  // would be unreachable rather than enforced, and a legitimate long spec
  // would come back as "your turn never finished".
  const json768kb = jsonBody('768kb');

  const authenticated = [
    bearerIpGuard(pool, 'agent-ip'),
    // Audit the route PATTERN, not the concrete path: a per-turn-id route
    // string would make cli_auth_audit_events unusable for "what is this
    // token doing", which is the whole point of the table.
    ...activeTokenMiddleware(
      pool,
      AGENT_SCOPE,
      (req) => `/api/cli/agent${(req.route && req.route.path) || req.path}`
    ),
  ];

  // Load the lease named in the body/query and prove the caller owns it.
  // Returns null (having already answered) when it is gone or not theirs —
  // both of which the CLI treats as "re-attach", so they share one shape.
  async function requireLease(req, res, leaseId) {
    const id = parseId(leaseId);
    if (!id) {
      res.status(400).json({ error: 'invalid_request' });
      return null;
    }
    const { rows } = await pool.query(
      `SELECT * FROM session_agent_leases
        WHERE id = $1 AND user_id = $2 AND released_at IS NULL AND expires_at > NOW()`,
      [id, req.user.id]
    );
    if (!rows.length) {
      res.status(409).json({ error: 'lease_lost' });
      return null;
    }
    return rows[0];
  }

  async function requireOwnTurn(req, res, lease, turnId) {
    const id = parseId(turnId);
    if (!id) {
      res.status(400).json({ error: 'invalid_request' });
      return null;
    }
    const turn = await localAgent.getTurn(pool, id);
    if (!turn || String(turn.lease_id) !== String(lease.id)) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return turn;
  }

  // --- attach -------------------------------------------------------------
  //
  // Claim a session for this machine. The session must be an active dev
  // session the caller owns; a promoted/merged/archived one is refused
  // because its coding turns are over.
  router.post('/attach', drainGuard, json4kb, ...authenticated, async (req, res) => {
    const body = req.body;
    if (!exactKeys(body, ['sessionId', 'label', 'runtime'])) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const sessionId = parseSessionId(body.sessionId);
    if (!sessionId
        || !localAgent.isValidLabel(body.label)
        || !localAgent.isValidRuntime(body.runtime)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT cs.id, cs.status, cs.branch_name, cs.session_title,
                cs.handoff_base_sha, cs.checks_commit_sha, cs.handoff_uploaded_sha,
                a.slug AS app_slug, a.repo_url
           FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
          WHERE cs.id = $1 AND cs.user_id = $2`,
        [sessionId, req.user.id]
      );
      const session = rows[0];
      if (!session) return res.status(404).json({ error: 'not_found' });
      if (session.status !== 'active' && session.status !== 'promoted') {
        return res.status(409).json({ error: 'session_not_attachable' });
      }
      const { lease, reattached } = await localAgent.attach(pool, {
        sessionId,
        userId: req.user.id,
        label: body.label,
        runtime: body.runtime,
        accessTokenId: req.cliToken?.id ?? null,
      });
      log.info('cli-agent', reattached ? 'Local agent re-attached' : 'Local agent attached', {
        sessionId, leaseId: String(lease.id), runtime: lease.runtime,
      });
      return res.status(reattached ? 200 : 201).json({
        lease: localAgent.publicLease(lease),
        session: {
          sessionId: Number(session.id),
          appSlug: session.app_slug,
          repoUrl: session.repo_url,
          branch: session.branch_name,
          title: session.session_title,
          headSha: session.checks_commit_sha
            || session.handoff_uploaded_sha
            || session.handoff_base_sha
            || null,
        },
        webPath: `/#app/${session.app_slug}/dev/sessions/${session.id}`,
      });
    } catch (err) {
      if (err instanceof localAgent.LeaseConflictError) {
        return res.status(409).json({
          error: 'lease_held',
          label: err.existing?.label || null,
        });
      }
      log.error('cli-agent', 'Attach failed', { err: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  // --- heartbeat ----------------------------------------------------------
  router.post('/heartbeat', json4kb, ...authenticated, async (req, res) => {
    if (!exactKeys(req.body, ['leaseId'])) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const id = parseId(req.body.leaseId);
    if (!id) return res.status(400).json({ error: 'invalid_request' });
    try {
      const lease = await localAgent.heartbeat(pool, { leaseId: id, userId: req.user.id });
      if (!lease) return res.status(409).json({ error: 'lease_lost' });
      return res.json({ lease: localAgent.publicLease(lease) });
    } catch (err) {
      log.error('cli-agent', 'Heartbeat failed', { err: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  // --- long-poll for the next turn ----------------------------------------
  //
  // Answers 204 when nothing arrived within the poll window, which the CLI
  // treats as "poll again" rather than as an error. The wait is backed by an
  // in-process emitter, never a held pool client.
  router.get('/turns/next', ...authenticated, async (req, res) => {
    const keys = Object.keys(req.query);
    if (keys.some((key) => key !== 'leaseId')) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const lease = await requireLease(req, res, req.query.leaseId);
    if (!lease) return undefined;
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const turn = await localAgent.claimNextTurn(pool, {
        lease,
        timeoutMs: localAgent.LONG_POLL_MS,
        signal: controller.signal,
      });
      if (res.writableEnded) return undefined;
      if (!turn) return res.status(204).end();
      return res.json({ turn: localAgent.publicTurn(turn) });
    } catch (err) {
      log.error('cli-agent', 'Turn poll failed', { err: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  // --- accept / decline ---------------------------------------------------
  router.post('/turns/:id/accept', json4kb, ...authenticated, async (req, res) => {
    if (!exactKeys(req.body, ['leaseId'])) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const lease = await requireLease(req, res, req.body.leaseId);
    if (!lease) return undefined;
    const turn = await requireOwnTurn(req, res, lease, req.params.id);
    if (!turn) return undefined;
    const accepted = await localAgent.acceptTurn(pool, {
      turnId: turn.id, leaseId: lease.id,
    });
    // Not an error: the platform may already have given up on this offer
    // (offer timeout) or the user may have stopped the turn. The CLI's
    // correct response is to drop it and poll again, so say so plainly.
    if (!accepted) return res.status(409).json({ error: 'turn_not_offered' });
    return res.json({ turn: localAgent.publicTurn(accepted) });
  });

  router.post('/turns/:id/decline', json4kb, ...authenticated, async (req, res) => {
    if (!exactKeys(req.body, ['leaseId', 'reason'])) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const reason = boundedText(req.body.reason, MAX_REASON_CHARS);
    if (reason === undefined) return res.status(400).json({ error: 'invalid_request' });
    const lease = await requireLease(req, res, req.body.leaseId);
    if (!lease) return undefined;
    const turn = await requireOwnTurn(req, res, lease, req.params.id);
    if (!turn) return undefined;
    const declined = await localAgent.declineTurn(pool, {
      turnId: turn.id, leaseId: lease.id, reason,
    });
    if (!declined) return res.status(409).json({ error: 'turn_not_open' });
    return res.json({ turn: localAgent.publicTurn(declined) });
  });

  // --- progress -----------------------------------------------------------
  router.post('/turns/:id/progress', json256kb, ...authenticated, async (req, res) => {
    if (!exactKeys(req.body, ['leaseId', 'lines']) || !Array.isArray(req.body.lines)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    if (req.body.lines.some((line) => typeof line !== 'string')) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const lease = await requireLease(req, res, req.body.leaseId);
    if (!lease) return undefined;
    const turn = await requireOwnTurn(req, res, lease, req.params.id);
    if (!turn) return undefined;
    const updated = await localAgent.appendProgress(pool, {
      turnId: turn.id, leaseId: lease.id, lines: req.body.lines,
    });
    // The one place the cooperative-stop signal surfaces: a turn the user
    // stopped is no longer in an accepted/running state, so this rejects and
    // the CLI kills its child process.
    if (!updated) return res.status(409).json({ error: 'turn_not_running' });
    return res.status(204).end();
  });

  // --- commit upload ------------------------------------------------------
  //
  // The local machine has a tested commit and no push access — by design. It
  // ships the tree here and the platform reconstructs the identical commit
  // through its own GitHub App, exactly as `proposal push` already does for
  // the MCP handoff flow. Same validator, same exact-tree check, same refusal
  // to accept anything that does not reproduce the tested tree.
  //
  // Never accept a git credential from the CLI, and never send it one.
  router.post(
    '/turns/:id/commit',
    drainGuard,
    express.json({ limit: COMMIT_UPLOAD_JSON_LIMIT, strict: true }),
    ...authenticated,
    async (req, res) => {
      if (!plainObject(req.body) || !('leaseId' in req.body)) {
        return res.status(400).json({ error: 'invalid_request' });
      }
      const { leaseId, ...commitBody } = req.body;
      // eslint-disable-next-line global-require
      const { parseCommitUploadBody, ValidationError } = require('./proposal-handoff');
      let input;
      try {
        input = parseCommitUploadBody(commitBody);
      } catch (err) {
        if (err instanceof ValidationError) {
          return res.status(400).json({ error: 'invalid_request', message: err.message });
        }
        throw err;
      }
      const lease = await requireLease(req, res, leaseId);
      if (!lease) return undefined;
      const turn = await requireOwnTurn(req, res, lease, req.params.id);
      if (!turn) return undefined;
      if (!['accepted', 'running'].includes(turn.status)) {
        return res.status(409).json({ error: 'turn_not_running' });
      }
      // A scout turn is read-only, and this is the boundary where that is
      // actually enforced: no commit reaches GitHub, so no unreviewed code
      // reaches the managed branch, even if the machine on the other end is
      // buggy or hostile. Checked BEFORE the GitHub call, not after.
      if (turn.mode !== 'build') {
        return res.status(409).json({ error: 'read_only_turn' });
      }

      const { rows } = await pool.query(
        `SELECT cs.id, cs.branch_name, a.repo_url
           FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
          WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status = 'active'`,
        [turn.session_id, req.user.id]
      );
      const session = rows[0];
      if (!session) return res.status(409).json({ error: 'session_state_changed' });
      const repo = github.parseGithubUrl(session.repo_url);
      if (!github.isEnabled() || !repo || !session.branch_name) {
        return res.status(400).json({ error: 'repo_unavailable' });
      }

      // Multiple commits in one turn upload oldest-first; each expects the
      // previous bot-owned SHA as its remote parent.
      const expectedParent = turn.head_sha || turn.base_sha;
      let uploaded;
      try {
        uploaded = await github.createProposalCommit(repo.owner, repo.repo, {
          branchName: session.branch_name,
          expectedRemoteParentSha: expectedParent,
          localParentSha: input.parentSha,
          localParentTreeSha: input.parentTreeSha,
          expectedTreeSha: input.treeSha,
          localCommitSha: input.localCommitSha,
          message: input.message,
          authoredAt: input.authoredAt,
          committedAt: input.committedAt,
          files: input.files,
        });
      } catch (err) {
        if (['branch_moved', 'tree_mismatch', 'parent_tree_mismatch'].includes(err.code)) {
          return res.status(409).json({ error: err.code });
        }
        const detail = github.describeGithubError(err);
        // Never log GitHub's response body here: a provider validation error
        // can echo fields from the uploaded source.
        log.warn('cli-agent', 'Local agent commit upload failed', {
          sessionId: Number(session.id), status: detail.status, message: detail.message,
        });
        return res.status(503).json({ error: 'github_unavailable' });
      }

      const advanced = await localAgent.recordTurnHead(pool, {
        turnId: turn.id, leaseId: lease.id, headSha: uploaded.sha,
      });
      if (!advanced) return res.status(409).json({ error: 'turn_not_running' });
      return res.status(uploaded.created ? 201 : 200).json({
        headSha: uploaded.sha,
        treeSha: uploaded.treeSha,
        branch: session.branch_name,
        uploaded: uploaded.created,
      });
    }
  );

  // --- result -------------------------------------------------------------
  router.post('/turns/:id/result', json768kb, ...authenticated, async (req, res) => {
    // `specMd` is optional so a build-only client (or an older CLI) keeps
    // working unchanged; a scout turn that omits it is reported as producing
    // no spec, which is exactly what the worker-container scout does too.
    if (!exactKeys(req.body, ['leaseId', 'status', 'headSha', 'summary', 'error', 'specMd'])) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const { status } = req.body;
    // Only outcomes the agent can legitimately report about itself. The
    // platform owns 'abandoned' and 'stopped'; letting a client claim either
    // would let a laptop mark its own failed run as a benign re-route.
    if (!['completed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    if (req.body.headSha != null && !localAgent.isSha(req.body.headSha)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const summary = boundedText(req.body.summary, MAX_SUMMARY_CHARS);
    const errorDetail = boundedText(req.body.error, MAX_REASON_CHARS);
    if (summary === undefined || errorDetail === undefined) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    // The spec is markdown a human will read in the spec viewer, so unlike a
    // progress line it must keep its newlines — hence a length/type check
    // here rather than boundedText's control-character scrub. It goes through
    // the same sanitising render path every other spec does.
    if (req.body.specMd != null
        && (typeof req.body.specMd !== 'string'
          || req.body.specMd.length > localAgent.MAX_SPEC_CHARS)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const lease = await requireLease(req, res, req.body.leaseId);
    if (!lease) return undefined;
    const turn = await requireOwnTurn(req, res, lease, req.params.id);
    if (!turn) return undefined;
    // Cross-check the payload against the turn's mode rather than quietly
    // dropping the mismatched half: a client that thinks it just uploaded a
    // commit for a read-only turn is confused about something that matters.
    if (turn.mode === 'scout' && req.body.headSha != null) {
      return res.status(409).json({ error: 'read_only_turn' });
    }
    if (turn.mode === 'build' && req.body.specMd != null) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const finished = await localAgent.finishTurn(pool, {
      turnId: turn.id,
      leaseId: lease.id,
      status,
      headSha: req.body.headSha,
      summary,
      errorDetail,
      specMd: req.body.specMd,
    });
    if (!finished) return res.status(409).json({ error: 'turn_not_running' });
    log.info('cli-agent', 'Local agent reported turn result', {
      sessionId: Number(turn.session_id), turnId: String(turn.id),
      mode: turn.mode || 'build', status,
    });
    return res.json({ turn: localAgent.publicTurn(finished) });
  });

  // --- detach -------------------------------------------------------------
  router.post('/detach', json4kb, ...authenticated, async (req, res) => {
    if (!exactKeys(req.body, ['leaseId'])) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const id = parseId(req.body.leaseId);
    if (!id) return res.status(400).json({ error: 'invalid_request' });
    try {
      await localAgent.release(pool, {
        leaseId: id, userId: req.user.id, reason: 'detached',
      });
      // Idempotent: detaching an already-detached lease is what a retried
      // Ctrl-C looks like, and it is not an error.
      return res.status(204).end();
    } catch (err) {
      log.error('cli-agent', 'Detach failed', { err: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  // Anything else under /api/cli/agent terminates here rather than falling
  // through to the parent router's device-approval exemption.
  router.all('/*', (_req, res) => res.status(404).json({ error: 'not_found' }));

  return router;
}

module.exports = { cliAgentRoutes };
