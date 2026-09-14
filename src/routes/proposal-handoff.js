'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const github = require('../services/github');
const staging = require('../services/staging');
const stagingRecovery = require('../services/staging-recovery');
const visuals = require('../services/visuals');
const sessionLifecycle = require('../services/session-lifecycle');
const proposalUpdate = require('../services/proposal-update');
const prImportSync = require('../services/pr-import-sync');
const branchNames = require('../services/branch-names');
const externalAgentHead = require('../services/external-agent-head');
// The connector-error → HTTP status map. It lives in routes/dev-flow.js
// because tests/dev-flow-routes.test.js scrapes the services' emitted codes
// against it in both directions; importing it here rather than restating it is
// what keeps the connector's loopback and the browser's twin from drifting
// apart on what a refusal means.
const { STATUS_BY_CODE: UPDATE_STATUS_BY_CODE } = require('./dev-flow');
const { beginSessionOperation, isSessionBusy } = require('../services/active-workers');
const { effectiveSessionCaps } = require('../services/session-caps');
const connectorLimits = require('../services/connector-limits');
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
class ReplacementConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

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

function parseBodySessionId(value, label) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    throw new ValidationError(`${label} must be a positive session integer`);
  }
  return value;
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
  exactKeys(body, [
    'schemaVersion', 'requestId', 'baseSha', 'title', 'spec', 'history',
    'linkedIssues', 'supersedesSessionId', 'externalAgent',
  ], 'body');
  if (body.schemaVersion !== 1) throw new ValidationError('schemaVersion must be 1');
  if (body.externalAgent !== undefined
      && !['codex', 'claude-code', 'external'].includes(body.externalAgent)) {
    throw new ValidationError('externalAgent must be codex, claude-code, or external');
  }
  return {
    externalAgent: body.externalAgent || 'external',
    requestId: parseRequestId(body.requestId),
    baseSha: parseSha(body.baseSha, 'baseSha'),
    title: boundedText(body.title, { label: 'title', min: 1, max: 256, trim: true }),
    spec: boundedText(body.spec, { label: 'spec', min: 1, max: MAX_SPEC_BYTES }),
    history: parseHistory(body.history, { required: true, requireUser: true }),
    linkedIssues: parseIssueNumbers(body.linkedIssues),
    supersedesSessionId: parseBodySessionId(
      body.supersedesSessionId,
      'supersedesSessionId'
    ),
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

// The update route's body: the fork branch that carries the new work, two
// optional refinements, and the revision's testing metadata. Same `exactKeys`
// discipline as every other body in this file — an unrecognised field is a 400
// rather than a silently ignored intention. The VALUES are validated by
// services/proposal-update.js against the same git-ref and repository-name
// predicates the submit path uses; this only bounds their size so nothing
// enormous reaches them.
//
// `testingPaths` / `testingSteps` are the same two fields the pr-import route
// takes, parsed by the same shared function (#1199). An update that carries
// them REPLACES the proposal's stored capture routes before the checks re-run,
// so the screenshots the group votes on show the screen this revision changed;
// an update that omits them leaves the stored routes alone. Before this, they
// were accepted by submit_work, dropped here, and every revised proposal
// silently fell back to home-page screenshots.
// #1347. The share-to-in-progress body. Deliberately the update body MINUS
// `recheck`: there is no prior verdict on a card that does not exist yet, so
// accepting a re-run flag here would name a control that could never do
// anything. Everything else is the same field with the same cap, because the
// two calls carry the same work — they differ only in where it lands.
function parseShareInProgressBody(body) {
  exactKeys(body, ['branch', 'forkRepo', 'expectedHeadSha', 'testingPaths', 'testingSteps', 'title', 'description', 'linkedIssues', 'externalAgent'], 'body');
  const branch = boundedText(body.branch, { label: 'branch', min: 1, max: 255, trim: true });
  const forkRepo = body.forkRepo == null
    ? null
    : boundedText(body.forkRepo, { label: 'forkRepo', min: 1, max: 100, trim: true });
  const expectedHeadSha = body.expectedHeadSha == null
    ? null
    : parseSha(body.expectedHeadSha, 'expectedHeadSha');
  if (body.testingPaths != null && !Array.isArray(body.testingPaths)) {
    throw new ValidationError('testingPaths must be an array of in-app paths');
  }
  if (body.testingPaths != null && body.testingPaths.length > 50) {
    throw new ValidationError('testingPaths must contain at most 50 entries');
  }
  if (body.testingSteps != null) {
    boundedText(body.testingSteps, { label: 'testingSteps', max: 16 * 1024 });
  }
  const title = body.title == null
    ? null
    : boundedText(body.title, { label: 'title', min: 1, max: 256, trim: true });
  if (body.linkedIssues != null && !Array.isArray(body.linkedIssues)) {
    throw new ValidationError('linkedIssues must be an array of issue numbers');
  }
  const description = body.description == null
    ? null
    : boundedText(body.description, { label: 'description', min: 1, max: 4000, trim: true });
  // Which coding agent wrote it — a badge, resolved by the connector service
  // and carried through so the shared card reads the same as a proposal from
  // the same agent. Bounded like any other caller-supplied label.
  const externalAgent = body.externalAgent == null
    ? null
    : boundedText(body.externalAgent, { label: 'externalAgent', min: 1, max: 40, trim: true });
  return {
    branch,
    forkRepo,
    expectedHeadSha,
    externalAgent,
    title,
    description,
    linkedIssues: body.linkedIssues == null ? null : body.linkedIssues,
    testing: {
      ...(body.testingPaths != null ? { testingPaths: body.testingPaths } : {}),
      ...(body.testingSteps != null ? { testingSteps: body.testingSteps } : {}),
    },
  };
}

function parseUpdateFromForkBody(body) {
  exactKeys(body, ['branch', 'forkRepo', 'expectedHeadSha', 'testingPaths', 'testingSteps', 'title', 'description', 'linkedIssues', 'recheck'], 'body');
  const branch = boundedText(body.branch, { label: 'branch', min: 1, max: 255, trim: true });
  const forkRepo = body.forkRepo == null
    ? null
    : boundedText(body.forkRepo, { label: 'forkRepo', min: 1, max: 100, trim: true });
  const expectedHeadSha = body.expectedHeadSha == null
    ? null
    : parseSha(body.expectedHeadSha, 'expectedHeadSha');
  // Shape only — an outright wrong TYPE is a caller bug worth naming, while an
  // individual unusable entry is dropped by the shared parser exactly as the
  // "==== TESTING ====" block parser drops it.
  if (body.testingPaths != null && !Array.isArray(body.testingPaths)) {
    throw new ValidationError('testingPaths must be an array of in-app paths');
  }
  if (body.testingPaths != null && body.testingPaths.length > 50) {
    throw new ValidationError('testingPaths must contain at most 50 entries');
  }
  if (body.testingSteps != null) {
    boundedText(body.testingSteps, { label: 'testingSteps', max: 16 * 1024 });
  }
  // The name the lazily-created PR takes when the session is proposed
  // (GitHub's own title cap). Optional; the service ignores it for a row
  // that already has a PR.
  const title = body.title == null
    ? null
    : boundedText(body.title, { label: 'title', min: 1, max: 256, trim: true });
  // The request(s) this revision implements (#1310) — the same field, cap and
  // sanitizer the pr-import route takes (#1217), so the create path and the
  // update path cannot disagree about what a linked issue is. Shape only
  // here, exactly like testingPaths: a wrong TYPE is a caller bug worth a
  // 400, while an individual unusable entry is silently dropped by the
  // shared sanitizer.
  if (body.linkedIssues != null && !Array.isArray(body.linkedIssues)) {
    throw new ValidationError('linkedIssues must be an array of issue numbers');
  }
  // #1323. The description the people voting read. Same cap as the create
  // path's PR body (services/external-agent-tasks.js prBodyFor), so an update
  // cannot store something the first submission would have clipped.
  const description = body.description == null
    ? null
    : boundedText(body.description, { label: 'description', min: 1, max: 4000, trim: true });
  // #1323. A re-run of the checks against the commit already on the proposal.
  // Until this existed the only way an agent could get one was to CHANGE a
  // capture route so the testing-metadata write happened to trigger it.
  if (body.recheck != null && typeof body.recheck !== 'boolean') {
    throw new ValidationError('recheck must be true or false');
  }
  const recheck = body.recheck === true;
  const { parseImportLinkedIssues } = require('./votes');
  const linkedIssues = body.linkedIssues == null
    ? []
    : parseImportLinkedIssues({ linkedIssues: body.linkedIssues });
  const testing = require('../services/testing-notes').parseSubmitted(body);
  return { branch, forkRepo, expectedHeadSha, testing, title,
    description,
    recheck, linkedIssues };
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
    supersedesSessionId: input.supersedesSessionId || null,
  };
  // Keep fingerprints from older clients stable when identity is unknown.
  if (input.externalAgent && input.externalAgent !== 'external') {
    normalized.externalAgent = input.externalAgent;
  }
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
    && (session?.external_agent || 'external') === (input.externalAgent || 'external')
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

// Managed local revisions follow the shared proposal lifecycle: active work
// is mutable, promoted proposals are mutable with a vote reset, and states the
// general rule freezes (notably merging/merged) remain frozen. Paused sessions
// retain their existing resume-first behavior.
function managedRevisionKind(session) {
  const kind = proposalUpdate.isContinuableStatus(session?.status);
  if (kind === 'proposal') return kind;
  if (kind === 'session' && session?.status === 'active') return kind;
  return null;
}

function checkRuntime(session) {
  const sessionId = Number(session.id);
  const runtime = {
    session: isSessionBusy(sessionId),
    pipeline: hasInFlightHandoffPipeline(session.id),
    build: staging.hasInFlightBuild(sessionId),
    capture: visuals.hasInFlightCapture(session.id),
  };
  runtime.inFlight = Object.values(runtime).some(Boolean);
  return runtime;
}

function isoDateOrNull(value) {
  if (value == null) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function checksSnapshot(session, runtime, options = {}) {
  const ranOnCommit = session.checks_commit_sha || null;
  const currentHead = currentProposalBranchHead(session);
  const managed = session.status === 'active' || session.status === 'promoted';
  const stalled = managed
    && !hasUnsubmittedUpload(session)
    && !runtime.inFlight
    && stagingRecovery.checkRunOverdue(session, options);
  return {
    state: session.check_state || null,
    phase: session.check_phase || null,
    trigger: session.check_trigger || null,
    checkedAt: isoDateOrNull(session.checks_checked_at),
    ranOnCommit,
    stale: !!(ranOnCommit && currentHead
      && ranOnCommit.toLowerCase() !== currentHead.toLowerCase()),
    inFlight: runtime.inFlight,
    stalled,
    activity: {
      session: runtime.session,
      pipeline: runtime.pipeline,
      build: runtime.build,
      capture: runtime.capture,
    },
  };
}

function revisionBuildState(session, checks, runtime) {
  const headSha = currentCheckedHead(session);
  if (hasUnsubmittedUpload(session)) return 'uploaded';
  if (!headSha) return 'draft';
  if (['failing', 'error'].includes(session.check_state)) return 'failed';
  if (checks.stalled) return 'stalled';
  if (runtime.build || !session.staging_url) return 'deploying';
  if (runtime.inFlight
      || !session.check_state || session.check_state === 'pending') return 'checking';
  if (session.check_state === 'passing' || session.check_state === 'skipped') return 'ready';
  return 'failed';
}

function statusNextStep(state, revisionState, checks) {
  const progress = revisionState || state;
  if (progress === 'stalled') {
    return 'This check run is overdue and no live worker owns it. Re-run checks on this same session with proposal_recheck, then keep polling proposal_status. Do not call proposal_start.';
  }
  if (progress === 'deploying' || progress === 'checking') {
    return 'A build or check run is still in progress. Keep this session and request ID and poll proposal_status; do not push or call proposal_start.';
  }
  if (progress === 'uploaded') {
    return 'Submit the uploaded head on this same session with proposal_submit_build.';
  }
  if (progress === 'draft') {
    return 'Continue this session, then upload its tested commit with proposal_push_commit.';
  }
  if (progress === 'failed') {
    return checks.state === 'error'
      ? 'The build or checks infrastructure failed. Re-run this same session with proposal_recheck; create a new proposal only if the user explicitly asks to replace it.'
      : 'Fix the reported failure and submit a later fast-forwarding commit to this same proposal.';
  }
  if (progress === 'ready' && state === 'active') {
    return 'The proposal is ready. Promote this same session only if the user wants it opened for voting.';
  }
  if (state === 'promoted') return 'This proposal is already open for voting; keep any revision on this same session.';
  if (state === 'archived') return 'This proposal is archived. Do not restart or keep polling it.';
  if (state === 'merging' || state === 'merged') return `This proposal is ${state}; no replacement is needed.`;
  return 'Continue with this same proposal session.';
}

function publicSessionStatus(session, options = {}) {
  const headSha = currentCheckedHead(session);
  const runtime = options.runtime || checkRuntime(session);
  const checks = checksSnapshot(session, runtime, options);
  const revisionState = revisionBuildState(session, checks, runtime);
  const state = session.status === 'active' ? revisionState : session.status;
  return {
    sessionId: Number(session.id),
    source: session.source,
    externalAgent: session.external_agent || 'external',
    state,
    status: session.status,
    ...(session.status === 'promoted' ? { revisionState } : {}),
    branch: session.branch_name,
    baseSha: session.handoff_base_sha,
    headSha,
    localHeadSha: session.handoff_local_commit_sha || session.handoff_head_sha || null,
    submittedHeadSha: session.handoff_head_sha || null,
    uploadedHeadSha: session.handoff_uploaded_sha || null,
    stagingUrl: session.staging_url || null,
    checkState: session.check_state || null,
    checkError: session.check_error_detail || null,
    checks,
    prNumber: session.pr_number || null,
    prUrl: session.pr_url || null,
    supersedesSessionId: session.handoff_supersedes_session_id == null
      ? null
      : Number(session.handoff_supersedes_session_id),
    webPath: `/#app/${session.app_slug}/dev/sessions/${session.id}`,
    nextStep: statusNextStep(state,
      session.status === 'promoted' ? revisionState : null, checks),
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

  // ── Advancing a proposal from its author's fork (#1054) ──────────────
  //
  // The connector's loopback target for submit_work's `proposalId` + `branch`
  // shape, and the browser twin's target too — one route, one set of gates,
  // whichever surface asks.
  //
  // Deliberately NOT behind `requireCli`: a connector access token is exactly
  // the credential this is for, and the CLI-only gate would 404 it. It is
  // instead on the connector allowlist in services/cli-api-policy.js, so a
  // connector token reaches this path and nothing else it was not granted.
  //
  // The route's whole job is authorization and shape: `collab` access to the
  // app, the proposal belonging to this app, and a body of at most five
  // fields. Every decision about whose fork it is, whether the work sits on
  // the proposal's head and what a moved branch means lives in
  // services/proposal-update.js, which the browser twin and the connector
  // share.
  router.post('/api/apps/:slug/proposals/:id/update-from-fork', proposalJson, drainGuard, async (req, res) => {
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return res.status(404).json({ error: 'not_found' });
    let input;
    try {
      input = parseUpdateFromForkBody(req.body);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: 'invalid_request', message: err.message });
      log.error('proposal-handoff', 'Update validation failed unexpectedly', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
                a.collab_visibility, a.view_visibility
           FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
          WHERE cs.id = $1 AND cs.app_id = $2`,
        [sessionId, app.id]
      );
      const session = rows[0] || null;
      if (!session) return res.status(404).json({ error: 'not_found', message: 'That proposal is not on this app.' });

      const result = await proposalUpdate.updateProposalFromForkBranch(
        { pool, config },
        {
          user: req.user,
          session,
          branch: input.branch,
          forkRepo: input.forkRepo,
          expectedHeadSha: input.expectedHeadSha,
          testing: input.testing,
          title: input.title,
          description: input.description,
          recheck: input.recheck,
          linkedIssues: input.linkedIssues,
          origin: config.cliAuthOrigin || null,
        }
      );
      if (!result.ok) {
        // One shared code→status map, in routes/dev-flow.js, so the connector
        // and the browser cannot disagree about what a refusal means.
        const status = UPDATE_STATUS_BY_CODE[result.code] || 400;
        return res.status(status).json({
          error: result.code,
          message: result.message,
          ...(result.retryable ? { retryable: true } : {}),
          ...(result.expectedBase ? { expectedBase: result.expectedBase } : {}),
          ...(result.headSha ? { headSha: result.headSha } : {}),
          ...(result.settingsUrl ? { settingsUrl: result.settingsUrl } : {}),
        });
      }
      return res.json({
        ...result,
        webPath: `/#app/${session.app_slug}/dev/sessions/${session.id}`,
      });
    } catch (err) {
      log.error('proposal-handoff', 'Proposal update failed', { sessionId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/apps/:slug/work/share-in-progress
  //
  // #1347. Land a coding agent's pushed branch in the app's IN-PROGRESS area
  // instead of putting it up for a vote.
  //
  // ── Why this is a session and not a lighter-weight thing ─────────────
  //
  // "In progress" is not a separate table: routes/issues.js composes it from
  // the dev SESSIONS linked to a request (composeInProgress), and a session is
  // shared with everyone exactly when `shared_at` is set — the same flag the
  // owner's own Share button writes. So sharing agent work to that area means
  // creating the session the area is already made of. Nothing new appears on
  // the Dev board that the board did not already know how to render.
  //
  // ── Why it reuses the update path to land the commits ────────────────
  //
  // Fetching a fork branch, verifying it belongs to the caller's linked GitHub
  // account, copying it somewhere the platform can build, recording the head
  // and starting the staging pipeline is a solved problem — it is exactly what
  // proposal-update.updateProposalFromForkBranch does for a revision. A second
  // implementation of it here would be a second place for the attribution gate
  // to be subtly wrong. So this route only CREATES the empty session and then
  // hands it to that function, which treats it as any other continuable
  // session (isContinuableStatus('active') === 'session') and runs the same
  // build + capture it runs for everything else.
  //
  // ── status 'active', and the cap that pays for it ────────────────────
  //
  // The session is created 'active' rather than 'paused' for two reasons that
  // point the same way: 'active' is the status that carries a staging preview
  // (settleActiveSession starts the pipeline; a paused row deliberately does
  // not, and reports resumeRequired instead), and it is the status the promote
  // route requires, so the card the group can see is also the card its owner
  // can send to a vote without an extra step.
  //
  // An active session holds a warm container, so it is bounded by the SAME
  // per-user active-session cap the browser's "start a session" button obeys —
  // checked before the row is inserted, so an over-cap share leaves nothing
  // behind. See services/connector-limits.js checkActiveCap.
  //
  // ── Failure leaves no litter ─────────────────────────────────────────
  //
  // If the hand-off refuses (a branch that is not the caller's, a base that
  // does not match, GitHub unreachable), the session row created moments
  // earlier is deleted before the error is returned. A half-made card in
  // everyone's In-progress area, with no commits behind it, is worse than the
  // refusal it came from.
  router.post('/api/apps/:slug/work/share-in-progress', proposalJson, drainGuard, async (req, res) => {
    let input;
    try {
      input = parseShareInProgressBody(req.body);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: 'invalid_request', message: err.message });
      log.error('proposal-handoff', 'Share validation failed unexpectedly', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });

      const capError = await connectorLimits.checkActiveCap(pool, config, req.user);
      if (capError) {
        return res.status(429).json({ error: capError.code, message: capError.message, retryable: true });
      }

      // ── The branch the ROW carries is the app repository's, not the fork's
      //
      // `input.branch` is a branch in the caller's own fork; `branch_name` on
      // a session is the branch in the APP's repository that everything
      // downstream reads — the landing below pushes to it, promote opens its
      // pull request from it, and `platformOwnedBranch` decides from its NAME
      // that a row with no `source` lives in the app repo. Storing the fork's
      // name there conflates the two, and puts a name the caller chose into a
      // namespace the platform owns.
      //
      // So it is minted here, in `usernode/from-…`, exactly like the mirror
      // rung's own heads. The branch does not exist yet — the landing creates
      // it — and that is the whole reason `updateProposalFromForkBranch` has a
      // first-landing case: there is no head to lease against on the first
      // share of a piece of work.
      const appRepoBranch = externalAgentHead.shareBranchName(req.user.id);

      // `shared_at` at creation, not afterwards: the point of the call is that
      // the card is visible, and a row that exists unshared for even one
      // failed statement is a private session the caller never asked for.
      const { rows: created } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, status, shared_at, session_title,
            external_agent, last_activity_at)
         VALUES ($1, $2, $3, 'active', NOW(), $4, $5, NOW())
         RETURNING id`,
        [
          app.id,
          req.user.id,
          appRepoBranch,
          input.title || null,
          input.externalAgent,
        ]
      );
      const sessionId = created[0].id;

      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
                a.collab_visibility, a.view_visibility
           FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
          WHERE cs.id = $1`,
        [sessionId]
      );
      const session = rows[0];

      const result = await proposalUpdate.updateProposalFromForkBranch(
        { pool, config },
        {
          user: req.user,
          session,
          branch: input.branch,
          forkRepo: input.forkRepo,
          expectedHeadSha: input.expectedHeadSha,
          testing: input.testing,
          title: input.title,
          description: input.description,
          linkedIssues: input.linkedIssues,
          origin: config.cliAuthOrigin || null,
        }
      );
      if (!result.ok) {
        await pool.query('DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2', [sessionId, req.user.id])
          .catch((err) => log.warn('proposal-handoff', 'could not clean up a failed share', {
            sessionId, err: err.message,
          }));
        const status = UPDATE_STATUS_BY_CODE[result.code] || 400;
        return res.status(status).json({
          error: result.code,
          message: result.message,
          ...(result.retryable ? { retryable: true } : {}),
          ...(result.expectedBase ? { expectedBase: result.expectedBase } : {}),
          ...(result.headSha ? { headSha: result.headSha } : {}),
          ...(result.settingsUrl ? { settingsUrl: result.settingsUrl } : {}),
        });
      }

      // Same announcement the owner's Share button makes, so an open Dev board
      // shows the card without a reload.
      try {
        const { pushSessionUpdate } = require('../services/ws');
        pushSessionUpdate({ action: 'shared', sessionId, appId: app.id, appSlug: app.slug });
      } catch (err) {
        log.warn('proposal-handoff', 'share broadcast failed (non-fatal)', { sessionId, err: err.message });
      }

      log.info('proposal-handoff', 'work shared to in-progress', {
        userId: req.user.id, slug: app.slug, sessionId, branch: input.branch,
      });
      return res.json({
        ...result,
        sessionId,
        shared: true,
        webPath: `/#app/${app.slug}/dev/sessions/${sessionId}`,
      });
    } catch (err) {
      log.error('proposal-handoff', 'Share to in-progress failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

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

      // A request ID is the exact-call idempotency key. The linked issue is
      // the broader work identity: a caller that invents another request ID
      // for the same pre-vote handoff must be sent back to that session rather
      // than silently creating a parallel branch. Promoted alternatives and
      // other users' work remain valid and are deliberately outside this
      // owner/app/pre-vote scope.
      let overlapping = [];
      if (input.linkedIssues.length) {
        ({ rows: overlapping } = await pool.query(
          `SELECT cs.*, a.slug AS app_slug
             FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
            WHERE cs.user_id = $1 AND cs.app_id = $2 AND cs.source = $3
              AND cs.status IN ('active', 'paused')
              AND cs.linked_issues && $4::INTEGER[]
            ORDER BY cs.created_at ASC, cs.id ASC`,
          [req.user.id, app.id, SOURCE, input.linkedIssues]
        ));
      }

      let replacementSession = null;
      if (input.supersedesSessionId != null) {
        const { rows: replacementRows } = await pool.query(
          `SELECT cs.*, a.slug AS app_slug
             FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
            WHERE cs.id = $1 AND cs.user_id = $2 AND cs.app_id = $3
              AND cs.source = $4 AND cs.status IN ('active', 'paused')`,
          [input.supersedesSessionId, req.user.id, app.id, SOURCE]
        );
        replacementSession = replacementRows[0] || null;
        if (!replacementSession) {
          return res.status(409).json({
            error: 'replacement_target_unavailable',
            message: 'The named proposal is not an active pre-vote handoff owned by this user and app.',
          });
        }
        if (input.linkedIssues.length
            && !input.linkedIssues.some((issue) =>
              (replacementSession.linked_issues || []).map(Number).includes(issue))) {
          return res.status(409).json({
            error: 'replacement_target_mismatch',
            message: 'The named proposal does not implement the same linked work item.',
            existingSession: publicSessionStatus(replacementSession),
          });
        }
        const another = overlapping.find((session) =>
          Number(session.id) !== Number(replacementSession.id));
        if (another) {
          return res.status(409).json({
            error: 'proposal_already_started',
            message: 'Another pre-vote proposal already implements this linked work. Continue that session or explicitly replace it.',
            existingSession: publicSessionStatus(another),
          });
        }
        if (checkRuntime(replacementSession).inFlight) {
          return res.status(409).json({
            error: 'replacement_target_busy',
            message: 'The proposal being replaced still has live work. Wait for it to stop before replacing it.',
            existingSession: publicSessionStatus(replacementSession),
          });
        }
      } else if (overlapping.length) {
        return res.status(409).json({
          error: 'proposal_already_started',
          message: 'A pre-vote proposal already implements this linked work. Continue the returned session; do not create another request ID to recover it.',
          existingSession: publicSessionStatus(overlapping[0]),
        });
      }

      const caps = effectiveSessionCaps(config, req.user);
      const { rows: ownCounts } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM chat_sessions
          WHERE user_id = $1 AND status = 'active' AND is_headless = FALSE
            AND source IS DISTINCT FROM 'imported'`,
        [req.user.id]
      );
      const replacedActiveSlot = replacementSession?.status === 'active' ? 1 : 0;
      if (Number(ownCounts[0].cnt) - replacedActiveSlot >= caps.activeSessions) {
        return res.status(429).json({ error: `You already have ${caps.activeSessions} running sessions. Pause or archive one first.` });
      }
      const { rows: globalCounts } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM chat_sessions
          WHERE status IN ('active', 'promoted')
            AND source IS DISTINCT FROM 'imported'`
      );
      if (Number(globalCounts[0].cnt) - replacedActiveSlot
          >= Number(config.maxGlobalSessions || 100)) {
        const { freed } = await sessionLifecycle.freeGlobalSlot({
          pool, graceMs: config.sessionPressureGraceMs,
        });
        if (!freed) return res.status(429).json({ error: 'Platform is at capacity right now. Try again in a few minutes.' });
      }

      const branchName = `dev/cli-u${req.user.id}-${input.requestId}`;
      // #1376: `requestId` is already validated to [a-z0-9-] and the user id
      // is numeric, so this is safe by construction — assert it anyway, so a
      // future change to either surfaces here rather than as an unpushable
      // branch discovered after the agent has already done the work.
      if (!branchNames.isValidBranchName(branchName)) {
        log.error('proposal-handoff', 'Refusing to create an unpushable branch', {
          app: app.slug, branchName,
        });
        return res.status(400).json({ error: 'bad_branch_name' });
      }
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
          if (replacementSession) {
            const replaced = await client.query(
              `UPDATE chat_sessions
                  SET status = 'archived', archived_at = NOW()
                WHERE id = $1 AND user_id = $2 AND app_id = $3 AND source = $4
                  AND status IN ('active', 'paused')
                RETURNING id`,
              [replacementSession.id, req.user.id, app.id, SOURCE]
            );
            if (!replaced.rowCount) {
              throw new ReplacementConflictError(
                'replacement_target_changed',
                'The proposal being replaced changed state. Read its status before trying again.'
              );
            }
          }
          const { rows } = await client.query(
            // This session's turns run on the
            // caller's own machine, in whatever tool they chose — Homeroom
            // never dispatched an agent for it. Preserve the caller's explicit
            // authoring identity without changing the platform execution backend.
            `INSERT INTO chat_sessions
               (app_id, user_id, branch_name, status, source, handoff_request_id,
                handoff_base_sha, handoff_request_fingerprint,
                session_title, spec_md, linked_issues, external_agent,
                handoff_supersedes_session_id)
             VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10, $12, $11)
             RETURNING *`,
            [app.id, req.user.id, branchName, SOURCE, input.requestId,
              input.baseSha, startRequestFingerprint(app, input),
              input.title, input.spec, input.linkedIssues,
              replacementSession ? replacementSession.id : null, input.externalAgent]
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
          metadata: {
            source: SOURCE,
            ...(replacementSession
              ? { supersedesSessionId: Number(replacementSession.id) }
              : {}),
          },
        });
        if (replacementSession) {
          await sessionLifecycle.finalizeArchivedSession({
            pool,
            sessionId: replacementSession.id,
            userId: req.user.id,
            reason: 'proposal-replaced',
          }).catch((err) => log.warn('proposal-handoff', 'Replacement cleanup failed', {
            sessionId: replacementSession.id,
            replacementSessionId: created.id,
            err: err.message,
          }));
        }
      }
      res.status(insertedSession ? 201 : 200)
        .json(publicSessionStatus({ ...created, app_slug: app.slug }));
    } catch (err) {
      if (err instanceof ReplacementConflictError) {
        return res.status(409).json({ error: err.code, message: err.message });
      }
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
        if (!session) return res.status(404).json({ error: 'Handoff session not found' });
        const revisionKind = managedRevisionKind(session);
        if (!revisionKind) {
          return res.status(409).json({
            error: 'proposal_closed',
            message: `This proposal is ${session.status || 'no longer open'}, so it cannot take a managed revision.`,
          });
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
          // A promoted retry still reconciles below: its first response may
          // have been lost after GitHub moved but before votes were reset.
          const alreadyRecorded = session.handoff_uploaded_sha === uploaded.sha
            && session.handoff_local_commit_sha === input.localCommitSha;
          if (!alreadyRecorded) {
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
              WHERE id = $2 AND status = $6 AND source = $3
                AND (CASE
                       WHEN handoff_uploaded_sha IS NOT NULL
                        AND handoff_uploaded_sha IS DISTINCT FROM handoff_head_sha
                        AND checks_commit_sha IS NOT DISTINCT FROM handoff_upload_checked_sha
                         THEN handoff_uploaded_sha
                       ELSE COALESCE(checks_commit_sha, handoff_uploaded_sha,
                                     handoff_head_sha, handoff_base_sha)
                     END) IS NOT DISTINCT FROM $4`,
              [uploaded.sha, session.id, SOURCE, expectedParent, input.localCommitSha,
                session.status]
            );
            if (!advanced.rowCount) {
              return res.status(409).json({ error: 'session_state_changed' });
            }
          }
          if (revisionKind === 'proposal') {
            const reconciled = await proposalUpdate.reconcileManagedCommitUpload(
              { config, pool },
              {
                session: {
                  ...session,
                  handoff_uploaded_sha: uploaded.sha,
                  handoff_local_commit_sha: input.localCommitSha,
                },
                expectedHeadSha: uploaded.sha,
              }
            );
            if (!reconciled.ok) {
              return res.status(UPDATE_STATUS_BY_CODE[reconciled.code]
                || (reconciled.retryable ? 503 : 409)).json({
                error: reconciled.code,
                message: reconciled.message,
                ...(reconciled.headSha ? { headSha: reconciled.headSha } : {}),
              });
            }
          }
          return res.status(!alreadyRecorded && uploaded.created ? 201 : 200).json({
            ok: true,
            sessionId: Number(session.id),
            localCommitSha: input.localCommitSha,
            headSha: uploaded.sha,
            treeSha: uploaded.treeSha,
            branch: session.branch_name,
            uploaded: alreadyRecorded ? false : uploaded.created,
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
        if (!session) return res.status(404).json({ error: 'Handoff session not found' });
        const revisionKind = managedRevisionKind(session);
        if (!revisionKind) {
          return res.status(409).json({
            error: 'proposal_closed',
            message: `This proposal is ${session.status || 'no longer open'}, so it cannot take a managed revision.`,
          });
        }
        if (!(await appAccess.checkAppAccess(pool, accessRow(session), req.user, 'collab'))) {
          return res.status(404).json({ error: 'Active handoff session not found' });
        }
        if (revisionKind === 'proposal'
            && session.handoff_head_sha === input.headSha
            && session.reviewed_head_sha === input.headSha) {
          const status = publicSessionStatus(session);
          return res.status(status.revisionState === 'ready' ? 200 : 202).json(status);
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
        // that Homeroom never received through proposal_push_commit.
        if (!session.handoff_uploaded_sha
            || session.handoff_uploaded_sha !== input.headSha) {
          return res.status(409).json({
            error: 'head_not_uploaded',
            message: 'Upload this exact local commit with proposal_push_commit before submitting it for staging.',
          });
        }
        if (revisionKind === 'proposal') {
          // The upload already moved the PR, reset old votes and stamped this
          // SHA pending. Build submission attaches the durable transcript/spec
          // and launches one proposal check run for the final uploaded commit.
          // It must not use the active-session pipeline, whose persistence is
          // intentionally scoped to status='active'.
          const releaseOperation = beginSessionOperation(session.id);
          try {
            const repo = repoCoordinates(session);
            if (!github.isEnabled() || !repo) {
              return res.status(400).json({ error: 'No GitHub repo configured for this app' });
            }
            let remoteHead;
            try {
              remoteHead = await github.getBranchSha(repo.owner, repo.repo, session.branch_name);
            } catch (err) {
              log.warn('proposal-handoff', 'Promoted managed revision head read failed', {
                sessionId: session.id, ...github.describeGithubError(err),
              });
              return res.status(503).json({ error: 'github_unavailable' });
            }
            if (String(remoteHead).toLowerCase() !== input.headSha) {
              return res.status(409).json({
                error: 'branch_moved',
                message: 'The proposal branch changed after this managed commit was uploaded.',
              });
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
                      handoff_upload_checked_sha = NULL,
                      last_activity_at = NOW()
                WHERE id = $2 AND status = $3 AND source = $4
                  AND handoff_uploaded_sha = $1
                  AND reviewed_head_sha IS NOT DISTINCT FROM $1
                  AND checks_commit_sha IS NOT DISTINCT FROM $1
                  AND handoff_head_sha IS NOT DISTINCT FROM $5
                  AND handoff_upload_checked_sha IS NOT DISTINCT FROM $6`,
              [input.headSha, session.id, session.status, SOURCE,
                session.handoff_head_sha || null, session.handoff_upload_checked_sha || null]
            );
            if (!adopted.rowCount) {
              return res.status(409).json({ error: 'session_state_changed' });
            }

            const freshSession = {
              ...session,
              handoff_head_sha: input.headSha,
              handoff_upload_checked_sha: null,
              spec_md: spec,
            };
            // Keep the shared session busy across the detached proposal build,
            // including the small async gap before staging registers itself.
            // The outer operation below releases only its own reference.
            const releaseChecks = beginSessionOperation(session.id);
            prImportSync.rerunChecksForNewHead({
              config, pool, session: freshSession, newHead: input.headSha,
            }).catch((err) => log.warn('proposal-handoff', 'Promoted managed revision checks failed', {
              sessionId: session.id, headSha: input.headSha, err: err.message,
            })).finally(releaseChecks);
            return res.status(202).json({
              ok: true,
              state: 'promoted',
              status: 'promoted',
              revisionState: 'deploying',
              sessionId: Number(session.id),
              headSha: input.headSha,
              webPath: `/#app/${session.app_slug}/dev/sessions/${session.id}`,
            });
          } finally {
            releaseOperation();
          }
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
          const pending = await visuals.setChecksPending(pool, session.id, input.headSha, 'building', 'commit-push');
          if (pending === false) {
            return res.status(409).json({ error: 'session_state_changed' });
          }
          visuals.notifyChecksPending(session.id, input.headSha, 'building', 'commit-push');

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
        return res.status(409).json({
          error: 'proposal_not_ready',
          message: 'This proposal is not ready yet. Wait for staging and checks to finish, then try again.',
        });
      }
      if (isSessionBusy(Number(session.id))) {
        return res.status(409).json({
          error: 'proposal_not_ready',
          message: 'This proposal is not ready yet. Wait for staging and checks to finish, then try again.',
        });
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
  parseUpdateFromForkBody,
  parseSessionId,
  startRequestFingerprint,
  publicSessionStatus,
  currentCheckedHead,
  serializeHandoffSubmission,
  hasInFlightHandoffPipeline,
  ValidationError,
  SOURCE,
};
