'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const github = require('../services/github');
const staging = require('../services/staging');
const visuals = require('../services/visuals');
const sessionLifecycle = require('../services/session-lifecycle');
const { beginSessionOperation, isSessionBusy } = require('../services/active-workers');
const { effectiveSessionCaps } = require('../services/session-caps');
const { drainGuard } = require('../services/lifecycle');
const events = require('../services/events');
const log = require('../services/logger');
const {
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_COMMIT_MESSAGE_BYTES,
  ALLOWED_FILE_MODES,
  validateUploadPath,
} = require('../services/proposal-commit-upload');

const SOURCE = 'cli_handoff';
const SHA_RE = /^[0-9a-f]{40}$/i;
const REQUEST_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const PHASE_RE = /^[A-Za-z0-9][A-Za-z0-9 _./:-]{0,63}$/;
const MAX_SPEC_BYTES = 32 * 1024;
const MAX_HISTORY_BYTES = 40 * 1024;
const MAX_EVENT_BYTES = 8 * 1024;
const MAX_HISTORY_EVENTS = 80;
const MAX_TESTS = 50;
const COMMIT_UPLOAD_JSON_LIMIT = '12mb';
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// The staging/visuals tail and its per-session serialization moved to
// services/handoff-pipeline.js in #907, so a local coding agent attached to
// an ordinary native session finishes through exactly the same code path this
// route has always used. Re-exported below for existing importers and tests.
const {
  serializeHandoffSubmission,
  hasInFlightHandoffPipeline,
  beginHandoffPipeline,
  startHandoffPipeline,
  discardHandoffStaging,
  runStaging,
} = require('../services/handoff-pipeline');

class ValidationError extends Error {}
class HandoffConflictError extends Error {}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new ValidationError(`${label} must be an object`);
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new ValidationError(`${label} contains unsupported field: ${extra[0]}`);
}

function boundedText(value, { label, min = 0, max, trim = false }) {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
  const text = trim ? value.trim() : value;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < min || bytes > max || /\u0000/.test(text)) {
    throw new ValidationError(`${label} must be between ${min} and ${max} UTF-8 bytes`);
  }
  return text;
}

function parseSha(value, label) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    throw new ValidationError(`${label} must be a 40-character Git commit SHA`);
  }
  return value.toLowerCase();
}

function parseRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value)) {
    throw new ValidationError('requestId must be 8-64 lowercase letters, numbers, or hyphens');
  }
  return value;
}

function parseSessionId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
}

function parseIssueNumbers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new ValidationError('linkedIssues must be an array of at most 50 issue numbers');
  }
  const out = [];
  for (const raw of value) {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw new ValidationError('linkedIssues must contain positive integers');
    }
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

function parseHistory(value, { required = false, requireUser = false } = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > MAX_HISTORY_EVENTS) {
    throw new ValidationError(`history must contain ${required ? '1-' : '0-'}${MAX_HISTORY_EVENTS} events`);
  }
  let total = 0;
  const out = value.map((item, index) => {
    exactKeys(item, ['id', 'kind', 'content', 'phase'], `history[${index}]`);
    if (typeof item.id !== 'string' || !EVENT_ID_RE.test(item.id)) {
      throw new ValidationError(`history[${index}].id is invalid`);
    }
    if (!['user', 'summary'].includes(item.kind)) {
      throw new ValidationError(`history[${index}].kind must be user or summary`);
    }
    const content = boundedText(item.content, {
      label: `history[${index}].content`, min: 1, max: MAX_EVENT_BYTES,
    });
    total += Buffer.byteLength(content, 'utf8');
    let phase = null;
    if (item.phase !== undefined) {
      if (typeof item.phase !== 'string' || !PHASE_RE.test(item.phase)) {
        throw new ValidationError(`history[${index}].phase is invalid`);
      }
      phase = item.phase;
    }
    return { id: item.id, kind: item.kind, content, phase };
  });
  if (total > MAX_HISTORY_BYTES) {
    throw new ValidationError(`history content exceeds ${MAX_HISTORY_BYTES} UTF-8 bytes`);
  }
  if (requireUser && !out.some((item) => item.kind === 'user')) {
    throw new ValidationError('history must include at least one user event');
  }
  return out;
}

function parseTests(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TESTS) {
    throw new ValidationError(`tests must be an array of at most ${MAX_TESTS} results`);
  }
  return value.map((item, index) => {
    exactKeys(item, ['command', 'status', 'summary'], `tests[${index}]`);
    const command = boundedText(item.command, {
      label: `tests[${index}].command`, min: 1, max: 1024, trim: true,
    });
    if (!['passed', 'failed', 'skipped'].includes(item.status)) {
      throw new ValidationError(`tests[${index}].status must be passed, failed, or skipped`);
    }
    const summary = item.summary === undefined ? null : boundedText(item.summary, {
      label: `tests[${index}].summary`, max: 2048,
    });
    return { command, status: item.status, summary };
  });
}

function parseStartBody(body) {
  exactKeys(body, ['schemaVersion', 'requestId', 'baseSha', 'title', 'spec', 'history', 'linkedIssues'], 'body');
  if (body.schemaVersion !== 1) throw new ValidationError('schemaVersion must be 1');
  return {
    requestId: parseRequestId(body.requestId),
    baseSha: parseSha(body.baseSha, 'baseSha'),
    title: boundedText(body.title, { label: 'title', min: 1, max: 256, trim: true }),
    spec: boundedText(body.spec, { label: 'spec', min: 1, max: MAX_SPEC_BYTES }),
    history: parseHistory(body.history, { required: true, requireUser: true }),
    linkedIssues: parseIssueNumbers(body.linkedIssues),
  };
}

function parseContextBody(body) {
  exactKeys(body, ['schemaVersion', 'history'], 'body');
  if (body.schemaVersion !== 1) throw new ValidationError('schemaVersion must be 1');
  return { history: parseHistory(body.history, { required: true }) };
}

function parseBuildBody(body) {
  exactKeys(body, ['schemaVersion', 'headSha', 'history', 'spec', 'tests'], 'body');
  if (body.schemaVersion !== 1) throw new ValidationError('schemaVersion must be 1');
  return {
    headSha: parseSha(body.headSha, 'headSha'),
    history: parseHistory(body.history),
    spec: body.spec === undefined ? null : boundedText(body.spec, {
      label: 'spec', min: 1, max: MAX_SPEC_BYTES,
    }),
    tests: parseTests(body.tests),
  };
}

function parseCommitUploadBody(body) {
  exactKeys(body, [
    'schemaVersion', 'localCommitSha', 'parentSha', 'parentTreeSha', 'treeSha', 'message',
    'authoredAt', 'committedAt', 'files',
  ], 'body');
  if (body.schemaVersion !== 1) throw new ValidationError('schemaVersion must be 1');
  const localCommitSha = parseSha(body.localCommitSha, 'localCommitSha');
  const parentSha = parseSha(body.parentSha, 'parentSha');
  const parentTreeSha = parseSha(body.parentTreeSha, 'parentTreeSha');
  const treeSha = parseSha(body.treeSha, 'treeSha');
  const message = boundedText(body.message, {
    label: 'message', min: 1, max: MAX_COMMIT_MESSAGE_BYTES,
  });
  const parseDate = (value, label) => {
    if (typeof value !== 'string' || !RFC3339_RE.test(value)
        || !Number.isFinite(Date.parse(value))) {
      throw new ValidationError(`${label} must be an RFC 3339 timestamp`);
    }
    return value;
  };
  if (!Array.isArray(body.files) || body.files.length < 1
      || body.files.length > MAX_UPLOAD_FILES) {
    throw new ValidationError(`files must contain 1-${MAX_UPLOAD_FILES} entries`);
  }
  const seen = new Set();
  let totalBytes = 0;
  const files = body.files.map((file, index) => {
    exactKeys(file, ['path', 'mode', 'contentBase64', 'delete'], `files[${index}]`);
    let filePath;
    try { filePath = validateUploadPath(file.path); } catch {
      throw new ValidationError(`files[${index}].path is invalid`);
    }
    if (seen.has(filePath)) throw new ValidationError(`files[${index}].path is duplicated`);
    seen.add(filePath);
    if (file.delete === true) {
      if (file.mode !== undefined || file.contentBase64 !== undefined
          || Object.keys(file).some((key) => !['path', 'delete'].includes(key))) {
        throw new ValidationError(`files[${index}] deletion contains unsupported fields`);
      }
      return { path: filePath, delete: true };
    }
    if (file.delete !== undefined) {
      throw new ValidationError(`files[${index}].delete must be true when present`);
    }
    if (!ALLOWED_FILE_MODES.has(file.mode)) {
      throw new ValidationError(`files[${index}].mode is unsupported`);
    }
    if (typeof file.contentBase64 !== 'string'
        || file.contentBase64.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) {
      throw new ValidationError(`files[${index}].contentBase64 is invalid`);
    }
    const content = Buffer.from(file.contentBase64, 'base64');
    if (content.toString('base64') !== file.contentBase64
        || content.length > MAX_UPLOAD_FILE_BYTES) {
      throw new ValidationError(`files[${index}] content exceeds its limit`);
    }
    totalBytes += content.length;
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      throw new ValidationError('uploaded file content exceeds the total limit');
    }
    return { path: filePath, mode: file.mode, contentBase64: file.contentBase64 };
  });
  return {
    localCommitSha,
    parentSha,
    parentTreeSha,
    treeSha,
    message,
    authoredAt: parseDate(body.authoredAt, 'authoredAt'),
    committedAt: parseDate(body.committedAt, 'committedAt'),
    files,
  };
}

function requireCli(req, res) {
  if (req.cliAuthenticated) return true;
  res.status(404).json({ error: 'not_found' });
  return false;
}

function requireCliMiddleware(req, res, next) {
  if (requireCli(req, res)) next();
}

function repoCoordinates(app) {
  return github.parseGithubUrl(app && app.repo_url);
}

function accessRow(session) {
  return {
    id: session.app_id,
    collab_visibility: session.collab_visibility,
    view_visibility: session.view_visibility,
  };
}

function startRequestFingerprint(app, input) {
  const normalized = {
    appId: String(app.id),
    baseSha: input.baseSha,
    title: input.title,
    spec: input.spec,
    history: input.history,
    linkedIssues: [...input.linkedIssues].sort((a, b) => a - b),
  };
  return crypto.createHash('sha256')
    .update(`proposal-start-v1\u0000${JSON.stringify(normalized)}`)
    .digest('hex');
}

function matchesStartRequest(session, app, input) {
  const fingerprint = startRequestFingerprint(app, input);
  if (session?.handoff_request_fingerprint) {
    return session.handoff_request_fingerprint === fingerprint;
  }
  // Compatibility for a row created by an earlier prerelease checkout. New
  // rows always carry the immutable fingerprint; these mutable-field checks
  // are only a conservative fallback during local upgrades.
  const storedIssues = Array.isArray(session?.linked_issues)
    ? session.linked_issues.map(Number).sort((a, b) => a - b)
    : [];
  const requestedIssues = [...input.linkedIssues].sort((a, b) => a - b);
  return Number(session?.app_id) === Number(app?.id)
    && session?.handoff_base_sha === input.baseSha
    && session?.session_title === input.title
    && session?.spec_md === input.spec
    && storedIssues.length === requestedIssues.length
    && storedIssues.every((issue, index) => issue === requestedIssues[index]);
}

// The exact commit whose staging/check verdict currently describes this
// shared local/web proposal. handoff_head_sha remains the audit record of the
// last commit submitted through MCP; a later web turn naturally advances
// checks_commit_sha through the ordinary Dev workflow.
function currentCheckedHead(session) {
  return session?.checks_commit_sha || session?.handoff_head_sha || null;
}

function hasUnsubmittedUpload(session) {
  if (!session?.handoff_uploaded_sha
      || session.handoff_uploaded_sha === session.handoff_head_sha) return false;
  return (session.checks_commit_sha || null)
    === (session.handoff_upload_checked_sha || null);
}

// An upload advances the managed Git branch before proposal_submit_build
// starts checks. Once that uploaded SHA has been submitted, ordinary web Dev
// turns own the branch/checks head again. This distinction prevents a stale
// local audit SHA from hiding a newer web-authored branch tip.
function currentProposalBranchHead(session) {
  if (hasUnsubmittedUpload(session)) {
    return session.handoff_uploaded_sha;
  }
  return currentCheckedHead(session)
    || session?.handoff_uploaded_sha
    || session?.handoff_base_sha
    || null;
}

function publicSessionStatus(session) {
  let state;
  const headSha = currentCheckedHead(session);
  if (session.status !== 'active') state = session.status;
  else if (hasUnsubmittedUpload(session)) state = 'uploaded';
  else if (!headSha) state = 'draft';
  else if (['failing', 'error'].includes(session.check_state)) state = 'failed';
  else if (staging.hasInFlightBuild(Number(session.id)) || !session.staging_url) state = 'deploying';
  else if (isSessionBusy(Number(session.id))
      || hasInFlightHandoffPipeline(session.id)
      || visuals.hasInFlightCapture(session.id)
      || !session.check_state || session.check_state === 'pending') state = 'checking';
  else if (session.check_state === 'passing' || session.check_state === 'skipped') state = 'ready';
  else state = 'failed';
  return {
    sessionId: Number(session.id),
    source: session.source,
    state,
    status: session.status,
    branch: session.branch_name,
    baseSha: session.handoff_base_sha,
    headSha,
    localHeadSha: session.handoff_local_commit_sha || session.handoff_head_sha || null,
    submittedHeadSha: session.handoff_head_sha || null,
    uploadedHeadSha: session.handoff_uploaded_sha || null,
    stagingUrl: session.staging_url || null,
    checkState: session.check_state || null,
    checkError: session.check_error_detail || null,
    prNumber: session.pr_number || null,
    prUrl: session.pr_url || null,
    webPath: `/#app/${session.app_slug}/dev/sessions/${session.id}`,
  };
}

async function insertHistoryRows(client, sessionId, history) {
  if (!history.length) return 0;
  let inserted = 0;
  for (const item of history) {
    const metadata = {
      source: SOURCE,
      handoffEventId: item.id,
      phase: item.phase,
    };
    if (item.kind === 'summary') metadata.handoffSummary = true;
    const role = item.kind === 'user' ? 'user' : 'assistant';
    const { rowCount } = await client.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT DO NOTHING`,
      [sessionId, role, item.content, JSON.stringify(metadata)]
    );
    if (rowCount) {
      inserted += rowCount;
      continue;
    }
    const { rows } = await client.query(
      `SELECT role, content, metadata FROM chat_session_messages
        WHERE session_id = $1 AND metadata->>'handoffEventId' = $2
        LIMIT 1`,
      [sessionId, item.id]
    );
    const prior = rows[0];
    if (!prior
        || prior.role !== role
        || prior.content !== item.content
        || (prior.metadata?.phase || null) !== item.phase
        || !!prior.metadata?.handoffSummary !== (item.kind === 'summary')) {
      throw new HandoffConflictError(`History event ${item.id} was already used with different content`);
    }
  }
  return inserted;
}

async function insertHistory(pool, sessionId, history) {
  if (!history.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await insertHistoryRows(client, sessionId, history);
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function testsSummary(tests) {
  if (!tests.length) return null;
  const lines = ['Local test results reported by the CLI agent:'];
  for (const item of tests) {
    const line = `- ${item.status.toUpperCase()}: ${item.command}${item.summary ? ` — ${item.summary}` : ''}`;
    if (Buffer.byteLength([...lines, line].join('\n'), 'utf8') > MAX_EVENT_BYTES - 48) {
      lines.push('- … additional local test results omitted from this summary');
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

async function snapshotSpec(pool, sessionId, content, commitSha = null) {
  const { rows: latestRows } = await pool.query(
    `SELECT version, content FROM chat_session_specs
     WHERE session_id = $1 ORDER BY version DESC LIMIT 1`,
    [sessionId]
  );
  const latest = latestRows[0];
  if (latest && latest.content === content) {
    if (commitSha) {
      await pool.query(
        `UPDATE chat_session_specs SET commit_sha = $1, built_at = NOW()
         WHERE session_id = $2 AND version = $3`,
        [commitSha, sessionId, latest.version]
      );
    }
    return latest.version;
  }
  const version = latest ? Number(latest.version) + 1 : 1;
  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, commit_sha)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, version, content, commitSha]
  );
  return version;
}

async function loadOwnedHandoff(pool, sessionId, userId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
            a.collab_visibility, a.view_visibility
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1 AND cs.user_id = $2 AND cs.source = $3`,
    [sessionId, userId, SOURCE]
  );
  return rows[0] || null;
}

function proposalHandoffRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);
  const proposalJson = express.json({ limit: '512kb' });
  const commitUploadJson = express.json({ limit: COMMIT_UPLOAD_JSON_LIMIT });

  router.post('/api/apps/:slug/proposal-handoffs', proposalJson, drainGuard, async (req, res) => {
    if (!requireCli(req, res)) return;
    let input;
    try {
      input = parseStartBody(req.body);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: 'invalid_request', message: err.message });
      log.error('proposal-handoff', 'Start validation failed unexpectedly', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const repo = repoCoordinates(app);
      if (!github.isEnabled() || !repo) {
        return res.status(400).json({ error: 'No GitHub repo configured for this app' });
      }

      const { rows: existingRows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug
           FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
          WHERE cs.user_id = $1 AND cs.handoff_request_id = $2`,
        [req.user.id, input.requestId]
      );
      if (existingRows.length) {
        const existing = existingRows[0];
        if (!matchesStartRequest(existing, app, input)) {
          return res.status(409).json({ error: 'request_id_conflict' });
        }
        // Creation commits the session/spec/history atomically below. A retry
        // therefore reads only; importantly it cannot append the original
        // spec again after a later local/web revision changed the live row.
        return res.json(publicSessionStatus(existing));
      }

      const caps = effectiveSessionCaps(config, req.user);
      const { rows: ownCounts } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM chat_sessions
          WHERE user_id = $1 AND status = 'active' AND is_headless = FALSE`,
        [req.user.id]
      );
      if (Number(ownCounts[0].cnt) >= caps.activeSessions) {
        return res.status(429).json({ error: `You already have ${caps.activeSessions} running sessions. Pause or archive one first.` });
      }
      const { rows: globalCounts } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM chat_sessions WHERE status IN ('active', 'promoted')`
      );
      if (Number(globalCounts[0].cnt) >= Number(config.maxGlobalSessions || 100)) {
        const { freed } = await sessionLifecycle.freeGlobalSlot({
          pool, graceMs: config.sessionPressureGraceMs,
        });
        if (!freed) return res.status(429).json({ error: 'Platform is at capacity right now. Try again in a few minutes.' });
      }

      const branchName = `dev/cli-u${req.user.id}-${input.requestId}`;
      try {
        await github.ensureBranchAtSha(repo.owner, repo.repo, branchName, input.baseSha);
      } catch (err) {
        if (err.code === 'branch_conflict') return res.status(409).json({ error: 'branch_conflict' });
        log.warn('proposal-handoff', 'GitHub branch creation failed', {
          app: app.slug, ...github.describeGithubError(err),
        });
        return res.status(503).json({ error: 'github_unavailable' });
      }

      let created;
      let insertedSession = false;
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query(
            `INSERT INTO chat_sessions
               (app_id, user_id, branch_name, status, source, handoff_request_id,
                handoff_base_sha, handoff_request_fingerprint,
                session_title, spec_md, linked_issues)
             VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [app.id, req.user.id, branchName, SOURCE, input.requestId,
              input.baseSha, startRequestFingerprint(app, input),
              input.title, input.spec, input.linkedIssues]
          );
          created = rows[0];
          await snapshotSpec(client, created.id, input.spec);
          await insertHistoryRows(client, created.id, input.history);
          await client.query('COMMIT');
          insertedSession = true;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        if (err.code !== '23505') throw err;
        const { rows } = await pool.query(
          `SELECT * FROM chat_sessions
            WHERE user_id = $1 AND handoff_request_id = $2`,
          [req.user.id, input.requestId]
        );
        created = rows[0];
        if (!created) throw err;
        if (!matchesStartRequest(created, app, input)) {
          return res.status(409).json({ error: 'request_id_conflict' });
        }
      }
      if (insertedSession) {
        events.record(pool, {
          type: events.EVENT_TYPES.DEV_SESSION_STARTED,
          userId: req.user.id,
          appId: app.id,
          sessionId: created.id,
          metadata: { source: SOURCE },
        });
      }
      res.status(insertedSession ? 201 : 200)
        .json(publicSessionStatus({ ...created, app_slug: app.slug }));
    } catch (err) {
      if (err instanceof HandoffConflictError) {
        return res.status(409).json({ error: 'history_event_conflict', message: err.message });
      }
      log.error('proposal-handoff', 'Failed to start handoff', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/sessions/:id/proposal-handoff/context', proposalJson, async (req, res) => {
    if (!requireCli(req, res)) return;
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return res.status(404).json({ error: 'Active handoff session not found' });
    let input;
    try {
      input = parseContextBody(req.body);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: 'invalid_request', message: err.message });
      log.error('proposal-handoff', 'Context validation failed unexpectedly', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    try {
      const session = await loadOwnedHandoff(pool, sessionId, req.user.id);
      if (!session || session.status !== 'active') return res.status(404).json({ error: 'Active handoff session not found' });
      if (!(await appAccess.checkAppAccess(pool, accessRow(session), req.user, 'collab'))) {
        return res.status(404).json({ error: 'Active handoff session not found' });
      }
      const inserted = await insertHistory(pool, session.id, input.history);
      await pool.query(`UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1`, [session.id]);
      res.json({ ok: true, inserted });
    } catch (err) {
      if (err instanceof HandoffConflictError) {
        return res.status(409).json({ error: 'history_event_conflict', message: err.message });
      }
      log.error('proposal-handoff', 'Failed to append context', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post(
    '/api/sessions/:id/proposal-handoff/commits',
    requireCliMiddleware,
    drainGuard,
    commitUploadJson,
    async (req, res) => {
      if (!requireCli(req, res)) return;
      const sessionId = parseSessionId(req.params.id);
      if (!sessionId) return res.status(404).json({ error: 'Active handoff session not found' });
      let input;
      try {
        input = parseCommitUploadBody(req.body);
      } catch (err) {
        if (err instanceof ValidationError) {
          return res.status(400).json({ error: 'invalid_request', message: err.message });
        }
        log.error('proposal-handoff', 'Commit upload validation failed unexpectedly', { err: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
      try {
        return await serializeHandoffSubmission(sessionId, async () => {
        const session = await loadOwnedHandoff(pool, sessionId, req.user.id);
        if (!session || session.status !== 'active') {
          return res.status(404).json({ error: 'Active handoff session not found' });
        }
        if (!(await appAccess.checkAppAccess(pool, accessRow(session), req.user, 'collab'))) {
          return res.status(404).json({ error: 'Active handoff session not found' });
        }
        if (isSessionBusy(Number(session.id))
            || hasInFlightHandoffPipeline(session.id)
            || staging.hasInFlightBuild(Number(session.id))
            || visuals.hasInFlightCapture(session.id)) {
          return res.status(409).json({
            error: 'session_busy',
            message: 'The shared proposal is currently changing. Retry when it finishes.',
          });
        }
        const expectedParent = currentProposalBranchHead(session);
        const releaseOperation = beginSessionOperation(session.id);
        try {
          const repo = repoCoordinates(session);
          if (!github.isEnabled() || !repo) {
            return res.status(400).json({ error: 'No GitHub repo configured for this app' });
          }
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
            if (err.code === 'branch_moved') {
              return res.status(409).json({
                error: 'branch_moved',
                message: 'The proposal branch changed. Fetch its current head and rebase the local commit before retrying.',
              });
            }
            if (err.code === 'tree_mismatch') {
              return res.status(409).json({
                error: 'tree_mismatch',
                message: 'The uploaded files did not reconstruct the tested local Git tree.',
              });
            }
            if (err.code === 'parent_tree_mismatch') {
              return res.status(409).json({
                error: 'parent_tree_mismatch',
                message: 'The local commit parent does not match the current proposal tree. Upload local commits in order or rebase onto the current proposal branch.',
              });
            }
            const detail = github.describeGithubError(err);
            // Never log GitHub's response data on this endpoint: a provider
            // validation error may echo fields from the source upload.
            log.warn('proposal-handoff', 'Bot-owned commit upload failed', {
              sessionId: session.id,
              status: detail.status,
              requestId: detail.requestId,
              message: detail.message,
            });
            return res.status(503).json({ error: 'github_unavailable' });
          }
          // The exact local/platform pair is already durable. This can be a
          // retry before submission or long after its staging checks passed.
          // Rewriting the row would wrongly erase a valid verdict and preview
          // even though createProposalCommit just proved the branch unchanged.
          if (session.handoff_uploaded_sha === uploaded.sha
              && session.handoff_local_commit_sha === input.localCommitSha) {
            return res.status(200).json({
              ok: true,
              sessionId: Number(session.id),
              localCommitSha: input.localCommitSha,
              headSha: uploaded.sha,
              treeSha: uploaded.treeSha,
              branch: session.branch_name,
              uploaded: false,
              webPath: `/#app/${session.app_slug}/dev/sessions/${session.id}`,
            });
          }
          const advanced = await pool.query(
            `UPDATE chat_sessions
                SET handoff_uploaded_sha = $1, handoff_local_commit_sha = $5,
                    handoff_upload_checked_sha = checks_commit_sha,
                    check_state = NULL, check_phase = NULL,
                    check_error_detail = NULL, test_results = '[]'::jsonb,
                    checks_checked_at = NULL, consecutive_check_failures = 0,
                    first_check_failure_at = NULL, last_check_failure_at = NULL,
                    check_next_retry_at = NULL, check_error_notified_at = NULL,
                    capture_state = NULL, capture_detail = NULL, captured_at = NULL,
                    last_activity_at = NOW()
              WHERE id = $2 AND status = 'active' AND source = $3
                AND (CASE
                       WHEN handoff_uploaded_sha IS NOT NULL
                        AND handoff_uploaded_sha IS DISTINCT FROM handoff_head_sha
                        AND checks_commit_sha IS NOT DISTINCT FROM handoff_upload_checked_sha
                         THEN handoff_uploaded_sha
                       ELSE COALESCE(checks_commit_sha, handoff_uploaded_sha,
                                     handoff_head_sha, handoff_base_sha)
                     END) IS NOT DISTINCT FROM $4`,
            [uploaded.sha, session.id, SOURCE, expectedParent, input.localCommitSha]
          );
          if (!advanced.rowCount) {
            return res.status(409).json({ error: 'session_state_changed' });
          }
          return res.status(uploaded.created ? 201 : 200).json({
            ok: true,
            sessionId: Number(session.id),
            localCommitSha: input.localCommitSha,
            headSha: uploaded.sha,
            treeSha: uploaded.treeSha,
            branch: session.branch_name,
            uploaded: uploaded.created,
            webPath: `/#app/${session.app_slug}/dev/sessions/${session.id}`,
          });
        } finally {
          releaseOperation();
        }
        });
      } catch (err) {
        log.error('proposal-handoff', 'Failed to upload local commit', { err: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.post('/api/sessions/:id/proposal-handoff/build', proposalJson, drainGuard, async (req, res) => {
    if (!requireCli(req, res)) return;
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return res.status(404).json({ error: 'Active handoff session not found' });
    let input;
    try {
      input = parseBuildBody(req.body);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: 'invalid_request', message: err.message });
      log.error('proposal-handoff', 'Build validation failed unexpectedly', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    try {
      return await serializeHandoffSubmission(sessionId, async () => {
        const session = await loadOwnedHandoff(pool, sessionId, req.user.id);
        if (!session || session.status !== 'active') return res.status(404).json({ error: 'Active handoff session not found' });
        if (!(await appAccess.checkAppAccess(pool, accessRow(session), req.user, 'collab'))) {
          return res.status(404).json({ error: 'Active handoff session not found' });
        }
        const localPipelineBusy = hasInFlightHandoffPipeline(session.id);
        const stagingBusy = staging.hasInFlightBuild(Number(session.id));
        const captureBusy = visuals.hasInFlightCapture(session.id);
        if (localPipelineBusy && currentCheckedHead(session) === input.headSha) {
          return res.status(202).json({
            ok: true,
            status: publicSessionStatus(session).state,
            sessionId: Number(session.id),
            headSha: input.headSha,
            webPath: `/#app/${session.app_slug}/dev/sessions/${session.id}`,
          });
        }
        if (!isSessionBusy(Number(session.id))
            && !localPipelineBusy && !stagingBusy && !captureBusy
            && currentCheckedHead(session) === input.headSha
            && publicSessionStatus(session).state === 'ready') {
          // The head SHA is the build's idempotency key. A retry after the
          // original 202 response was lost must not tear down a healthy
          // preview and run the entire staging/check pipeline again. Failed
          // and interrupted states deliberately fall through so the same
          // commit can be retried without manufacturing a no-op commit.
          return res.status(200).json(publicSessionStatus(session));
        }
        if (isSessionBusy(Number(session.id)) || localPipelineBusy || stagingBusy || captureBusy) {
          return res.status(409).json({
            error: 'session_busy',
            message: 'The shared proposal is currently changing in another local or web turn. Retry when it finishes.',
          });
        }
        // The upload endpoint is the only credential-safe path from a local
        // checkout to the bot-owned branch. Do not retain the old handoff
        // behavior that accepted any repository commit supplied by SHA: that
        // would bypass exact-tree reconstruction and let callers submit code
        // that Usernode never received through proposal_push_commit.
        if (!session.handoff_uploaded_sha
            || session.handoff_uploaded_sha !== input.headSha) {
          return res.status(409).json({
            error: 'head_not_uploaded',
            message: 'Upload this exact local commit with proposal_push_commit before submitting it for staging.',
          });
        }
        // Claim the shared session synchronously after the final busy check
        // and before the first GitHub await. Web dispatch/sync gates consult
        // the same registry, closing the check-then-act race between the two
        // surfaces. Early returns release here; an accepted build transfers
        // release ownership to the detached staging/check pipeline.
        const releasePipeline = beginHandoffPipeline(session.id);
        let pipelineDetached = false;
        try {
          const repo = repoCoordinates(session);
          if (!github.isEnabled() || !repo) return res.status(400).json({ error: 'No GitHub repo configured for this app' });

          try {
            const fromBase = await github.compareCommitAncestry(
              repo.owner, repo.repo, session.handoff_base_sha, input.headSha
            );
            if (fromBase.status !== 'ahead' || fromBase.aheadBy < 1) {
              return res.status(409).json({ error: 'head_not_descendant_of_base' });
            }
            const previousHead = currentCheckedHead(session);
            if (previousHead && previousHead !== input.headSha) {
              const fromPrevious = await github.compareCommitAncestry(
                repo.owner, repo.repo, previousHead, input.headSha
              );
              if (fromPrevious.status !== 'ahead' || fromPrevious.aheadBy < 1) {
                return res.status(409).json({ error: 'head_not_descendant_of_previous' });
              }
            }
            await github.advanceBranchToSha(repo.owner, repo.repo, session.branch_name, input.headSha);
          } catch (err) {
            if (err.code === 'non_fast_forward') return res.status(409).json({ error: 'non_fast_forward' });
            log.warn('proposal-handoff', 'GitHub commit adoption failed', {
              sessionId: session.id, ...github.describeGithubError(err),
            });
            return res.status(503).json({ error: 'github_unavailable' });
          }

          await insertHistory(pool, session.id, input.history);
          const summary = testsSummary(input.tests);
          if (summary) {
            const summaryId = crypto.createHash('sha256').update(summary).digest('hex').slice(0, 16);
            await insertHistory(pool, session.id, [{
              id: `tests:${input.headSha}:${summaryId}`,
              kind: 'summary',
              phase: 'test',
              content: summary,
            }]);
          }
          const spec = input.spec || session.spec_md;
          if (input.spec) {
            await pool.query(`UPDATE chat_sessions SET spec_md = $1 WHERE id = $2`, [input.spec, session.id]);
          }
          await snapshotSpec(pool, session.id, spec, input.headSha);
          const adopted = await pool.query(
            `UPDATE chat_sessions
                SET handoff_head_sha = $1,
                    handoff_local_commit_sha = CASE
                      WHEN handoff_uploaded_sha = $1 THEN handoff_local_commit_sha
                      ELSE NULL
                    END,
                    handoff_uploaded_sha = $1,
                    handoff_upload_checked_sha = NULL,
                    check_state = 'pending', checks_commit_sha = $1,
                    check_error_detail = NULL,
                    staging_container_id = NULL, staging_url = NULL,
                    last_activity_at = NOW()
              WHERE id = $2 AND status = 'active' AND source = $3
                AND handoff_uploaded_sha = $1
                AND checks_commit_sha IS NOT DISTINCT FROM $4
                AND handoff_head_sha IS NOT DISTINCT FROM $5
                AND handoff_upload_checked_sha IS NOT DISTINCT FROM $6`,
            [input.headSha, session.id, SOURCE, session.checks_commit_sha || null,
              session.handoff_head_sha || null, session.handoff_upload_checked_sha || null]
          );
          // Manual archive/pause is intentionally allowed to abort work. If
          // it won while the GitHub checks above were in flight, keep the
          // pushed branch/history but do not resurrect a check pipeline for
          // a session that is no longer active.
          if (!adopted.rowCount) {
            return res.status(409).json({ error: 'session_state_changed' });
          }
          const pending = await visuals.setChecksPending(pool, session.id, input.headSha);
          if (pending === false) {
            return res.status(409).json({ error: 'session_state_changed' });
          }
          visuals.notifyChecksPending(session.id, input.headSha);

          const freshSession = {
            ...session,
            handoff_head_sha: input.headSha,
            handoff_uploaded_sha: input.headSha,
            checks_commit_sha: input.headSha,
            spec_md: spec,
          };
          const app = {
            id: session.app_id,
            slug: session.app_slug,
            name: session.app_name,
            repo_url: session.repo_url,
          };
          pipelineDetached = true;
          startHandoffPipeline(config, pool, freshSession, app, input.headSha, releasePipeline);
          return res.status(202).json({
            ok: true,
            status: 'deploying',
            sessionId: Number(session.id),
            headSha: input.headSha,
            webPath: `/#app/${session.app_slug}/dev/sessions/${session.id}`,
          });
        } finally {
          if (!pipelineDetached) releasePipeline();
        }
      });
    } catch (err) {
      if (err instanceof HandoffConflictError) {
        return res.status(409).json({ error: 'history_event_conflict', message: err.message });
      }
      log.error('proposal-handoff', 'Failed to submit build', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/sessions/:id/proposal-handoff', async (req, res) => {
    if (!requireCli(req, res)) return;
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return res.status(404).json({ error: 'Handoff session not found' });
    try {
      const session = await loadOwnedHandoff(pool, sessionId, req.user.id);
      if (!session) return res.status(404).json({ error: 'Handoff session not found' });
      if (!(await appAccess.checkAppAccess(pool, accessRow(session), req.user, 'view'))) {
        return res.status(404).json({ error: 'Handoff session not found' });
      }
      res.json(publicSessionStatus(session));
    } catch (err) {
      log.error('proposal-handoff', 'Failed to read status', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Server-side counterpart to proposal_promote's preflight. This router is
  // mounted before voteRoutes, so a handoff promoted from either MCP or its
  // optionally-open web page must still be on the exact currently checked
  // head with live staging and a terminal passing verdict. Local and web
  // turns retain the same source/session and can alternate.
  router.post('/api/sessions/:id/promote', async (req, res, next) => {
    let releasePromotion = null;
    let releaseOnResponse = false;
    try {
      const sessionId = parseSessionId(req.params.id);
      // Do not let a numeric alias (for example 0101) fall through to the
      // generic promotion route, whose PostgreSQL integer coercion could
      // resolve it to a CLI handoff row without running this exact-head gate.
      // Every first-party session URL is canonical already.
      if (!sessionId) return res.status(404).json({ error: 'Active session not found' });
      const session = await loadOwnedHandoff(pool, sessionId, req.user.id);
      if (!session) return next();
      if (!(await appAccess.checkAppAccess(pool, accessRow(session), req.user, 'collab'))) {
        return res.status(404).json({ error: 'Active handoff session not found' });
      }
      if (publicSessionStatus(session).state !== 'ready') {
        return res.status(409).json({ error: 'proposal_not_ready' });
      }
      if (isSessionBusy(Number(session.id))) {
        return res.status(409).json({ error: 'proposal_not_ready' });
      }
      // Hold the same cross-surface claim used by build/sync through the
      // downstream promotion handler. Releasing before next() would reopen a
      // window where a local build could replace the reviewed SHA between
      // this preflight and the status='promoted' write.
      releasePromotion = beginSessionOperation(session.id);
      const repo = repoCoordinates(session);
      if (!repo) return res.status(409).json({ error: 'proposal_repo_missing' });
      let remoteHead;
      try {
        remoteHead = await github.getBranchSha(repo.owner, repo.repo, session.branch_name);
      } catch (err) {
        log.warn('proposal-handoff', 'Could not verify branch before promotion', {
          sessionId: session.id, ...github.describeGithubError(err),
        });
        return res.status(503).json({ error: 'github_unavailable' });
      }
      const checkedHead = currentCheckedHead(session);
      if (String(remoteHead).toLowerCase() !== checkedHead) {
        const detail = 'The proposal branch changed after checks. Rebuild the new head locally or from the web Dev session before promoting.';
        await pool.query(
          `UPDATE chat_sessions SET check_state = 'error', check_error_detail = $1
            WHERE id = $2 AND status = 'active' AND source = $3
              AND COALESCE(checks_commit_sha, handoff_head_sha) IS NOT DISTINCT FROM $4`,
          [detail, session.id, SOURCE, checkedHead]
        ).catch(() => {});
        return res.status(409).json({ error: 'branch_head_changed', message: detail });
      }
      // The common promotion route will create/read the PR after this
      // middleware returns. Carry the exact preflight revision across so its
      // authoritative PR-head read can close the remaining external-push
      // race before the row enters voting.
      req.cliHandoffCheckedHead = checkedHead;
      res.once('finish', releasePromotion);
      res.once('close', releasePromotion);
      releaseOnResponse = true;
      return next();
    } catch (err) {
      log.error('proposal-handoff', 'Promotion readiness check failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    } finally {
      if (releasePromotion && !releaseOnResponse) releasePromotion();
    }
  });

  return router;
}

module.exports = {
  proposalHandoffRoutes,
  parseStartBody,
  parseContextBody,
  parseBuildBody,
  parseCommitUploadBody,
  parseSessionId,
  startRequestFingerprint,
  publicSessionStatus,
  currentCheckedHead,
  serializeHandoffSubmission,
  hasInFlightHandoffPipeline,
  ValidationError,
  SOURCE,
};
