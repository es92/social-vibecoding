'use strict';

// End-to-end coordinator for a proposal's before/after shots. The platform
// builds the exact before (base) and after (head) revisions with fixture data
// and signed-in fixture users; the preview agent follows each declared change
// on both and saves what it sees through RunControl; this module then
// publishes every change that has a complete before/after set.

const appManifest = require('./app-manifest');
const crypto = require('node:crypto');
const os = require('node:os');
const github = require('./github');
const log = require('./logger');
const logRedaction = require('./log-redaction');
const evidenceAgent = require('./visual-evidence-agent');
const evidenceControl = require('./visual-evidence-control');
const environment = require('./visual-evidence-environment');
const identities = require('./visual-evidence-identities');
const planContract = require('./visual-evidence-plan');
const state = require('./visual-evidence-state');
const turnLifecycle = require('./turn-lifecycle');
const { isUiAffecting: uiFileHeuristic } = require('./visual-file-classifier');
const worker = require('./worker');

const ACTIVE_STATES = new Set(['planned', 'provisioning', 'exploring', 'replaying', 'reviewing']);
const CLOSED_STATUSES = new Set(['merged', 'archived']);
const EVIDENCE_STOPPED_REASON = 'Stopped before it finished. No shots were taken for this commit; take them again from the proposal.';
// Runs a person stopped while this process executes them. The stop already
// made the run terminal in the database; this keeps its runner from handing
// the preview agent another turn before a state transition refuses it.
const stopRequested = new Set();
const DIFF_CONTEXT_CHARS = 8_000;
const inFlight = new Map();
const inFlightRunIds = new Map();
const liveHeartbeats = new Map();
const HEARTBEAT_INTERVAL_MS = 30_000;
const EVIDENCE_PROCESS_ID = crypto.randomBytes(8).toString('hex');
const EVIDENCE_PROCESS_STARTED_AT = new Date().toISOString();
const MAX_AGENT_EVENTS = 128;
const SESSION_IDLE_WAIT_MS = 120_000;
const EVIDENCE_RECOVERY_WAIT_MS = 240_000;

function progressPhase(event) {
  if (!event || typeof event !== 'object') return null;
  if (typeof event.stage === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(event.stage)) {
    return event.stage;
  }
  // kpack reports container names and log lines. Persist only the phase name;
  // never put build output, fixture values, or internal origins in the view.
  if (typeof event.phase === 'string') {
    const phase = event.phase.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 57);
    return phase ? `build_${phase}` : null;
  }
  return null;
}

function startRunHeartbeat(pool, runId, stateService, observer = null, intervalMs = HEARTBEAT_INTERVAL_MS) {
  let phase = 'provisioning';
  let stopped = false;
  let writing = false;
  let pending = false;
  let agentActivity = null;
  let agentFinalResponse = null;
  let lastAgentFlushAt = 0;
  let lastHeartbeatWriteMs = null;
  const live = {
    phase, writeStartedAt: null, lastSucceededAt: null,
    lastErrorAt: null, lastErrorCode: null,
  };
  liveHeartbeats.set(runId, live);
  const flush = () => {
    if (stopped || typeof stateService.heartbeatRun !== 'function') return;
    if (writing) { pending = true; return; }
    writing = true;
    Promise.resolve().then(async () => {
      do {
        pending = false;
        const patch = {
          heartbeat: {
            processId: EVIDENCE_PROCESS_ID,
            processStartedAt: EVIDENCE_PROCESS_STARTED_AT,
            host: os.hostname().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 128),
            buildSha: exactSha(process.env.GIT_SHA),
            poolTotal: Number.isInteger(pool.totalCount) ? pool.totalCount : null,
            poolIdle: Number.isInteger(pool.idleCount) ? pool.idleCount : null,
            poolWaiting: Number.isInteger(pool.waitingCount) ? pool.waitingCount : null,
            previousWriteMs: lastHeartbeatWriteMs,
          },
          ...(agentActivity ? { agentActivity } : {}),
          ...(agentFinalResponse ? { agentFinalResponse } : {}),
        };
        const writeStartedAt = Date.now();
        live.writeStartedAt = new Date(writeStartedAt).toISOString();
        await stateService.heartbeatRun(pool, runId, phase,
          Object.keys(patch).length ? patch : null);
        lastHeartbeatWriteMs = Date.now() - writeStartedAt;
        live.lastSucceededAt = new Date().toISOString();
        live.writeStartedAt = null;
      } while (pending && !stopped);
    }).catch((error) => {
      live.lastErrorAt = new Date().toISOString();
      live.lastErrorCode = String(error?.code || 'heartbeat_write_failed').slice(0, 64);
      log.warn('visual-evidence', 'Evidence heartbeat failed', {
        runId, phase, error: error.message,
        poolTotal: pool.totalCount, poolIdle: pool.idleCount, poolWaiting: pool.waitingCount,
      });
    }).finally(() => {
      writing = false;
      live.writeStartedAt = null;
      if (pending && !stopped) flush();
    });
  };
  const timer = setInterval(flush, intervalMs);
  timer.unref?.();
  flush();
  return {
    onAgentDiagnostic(activity, kind) {
      if (stopped || !activity || typeof activity !== 'object') return;
      agentActivity = activity;
      if (['auth_bootstrap', 'hosted_app_catalog', 'hosted_app_allowlist',
        'tool_start', 'tool_end', 'browser_call_start', 'browser_call_pending',
        'browser_call_end', 'browser_server_exit', 'document_request', 'document_response',
        'controlled_failure_set', 'controlled_failure_hit',
        'provider_request_start', 'provider_request_pending', 'provider_response_headers',
        'provider_response_first_byte', 'provider_request_end',
        'context_result', 'provider_result',
        'runner_exit', 'turn_end', 'agent_deadline'].includes(kind)
          || Date.now() - lastAgentFlushAt >= 5000) {
        lastAgentFlushAt = Date.now();
        flush();
      }
    },
    onAgentFinalResponse(summary) {
      if (stopped || !summary || typeof summary !== 'object') return;
      agentFinalResponse = summary;
      flush();
    },
    onProgress(event) {
      if (typeof observer === 'function') {
        try { observer(event); } catch (error) {
          log.warn('visual-evidence', 'Evidence progress observer failed', { runId, error: error.message });
        }
      }
      const next = progressPhase(event);
      if (next && next !== phase) { phase = next; live.phase = next; flush(); }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      if (liveHeartbeats.get(runId) === live) liveHeartbeats.delete(runId);
    },
  };
}

// This private observer is evaluated by the process answering diagnostics,
// rather than copied from the run's last successful database heartbeat. A
// different process ID on the same host proves a restart; an in-progress
// write on the owner distinguishes a blocked heartbeat from a stopped owner.
function liveRunObserver(runId, pool) {
  const live = liveHeartbeats.get(runId) || null;
  return {
    observedAt: new Date().toISOString(),
    host: os.hostname().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 128),
    processId: EVIDENCE_PROCESS_ID,
    processStartedAt: EVIDENCE_PROCESS_STARTED_AT,
    buildSha: exactSha(process.env.GIT_SHA),
    ownsRun: !!live,
    heartbeatWrite: live ? {
      phase: live.phase,
      startedAt: live.writeStartedAt,
      lastSucceededAt: live.lastSucceededAt,
      lastErrorAt: live.lastErrorAt,
      lastErrorCode: live.lastErrorCode,
    } : null,
    poolTotal: Number.isInteger(pool?.totalCount) ? pool.totalCount : null,
    poolIdle: Number.isInteger(pool?.idleCount) ? pool.idleCount : null,
    poolWaiting: Number.isInteger(pool?.waitingCount) ? pool.waitingCount : null,
  };
}

class VisualEvidenceOrchestrationError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'VisualEvidenceOrchestrationError';
    this.code = code;
    this.detail = detail;
  }
}

function exactSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function headForSession(session, explicit = null) {
  return exactSha(explicit)
    || exactSha(session.imported_pr_head_sha)
    // Once a proposal is promoted, reviewed_head_sha is the authoritative
    // revision reviewers and votes describe. A native handoff pin can lag it
    // after a same-proposal update, so it must not win merely because it was
    // written earlier in the lifecycle.
    || exactSha(session.reviewed_head_sha)
    || exactSha(session.checks_commit_sha)
    || exactSha(session.handoff_head_sha)
    || exactSha(session.staging_commit_sha)
    || null;
}

function intentForSession(session) {
  const detail = session?.visual_evidence_detail;
  return detail && typeof detail === 'object' && detail.intent
    ? planContract.parseIntent(detail.intent)
    : null;
}

function publicSessionAndApp(row) {
  return {
    session: row,
    app: {
      id: row.app_id,
      slug: row.app_slug,
      name: row.app_name,
      repo_url: row.repo_url,
      manifest_snapshot: row.manifest_snapshot,
    },
  };
}

async function loadSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
            a.manifest_snapshot
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [sessionId]
  );
  if (!rows[0]) throw new VisualEvidenceOrchestrationError('session_not_found', 'Proposal session not found.');
  return rows[0];
}

async function resolveRevisionContext(session, explicitHead = null, githubService = github) {
  const headSha = headForSession(session, explicitHead);
  if (!headSha) {
    throw new VisualEvidenceOrchestrationError(
      'missing_evidence_head',
      'The before/after shots cannot start until the proposal has an exact submitted commit.'
    );
  }
  const { owner, repo } = environment.repoParts(session.repo_url);
  let baseSha = exactSha(session.handoff_base_sha);
  let comparison = null;
  if (!baseSha) {
    const repository = await githubService.getRepoHead(owner, repo);
    comparison = await githubService.compareRefs(owner, repo, `${repository.defaultBranch}...${headSha}`);
    baseSha = exactSha(comparison.mergeBaseSha);
  }
  if (!baseSha) {
    throw new VisualEvidenceOrchestrationError(
      'missing_evidence_base',
      'GitHub did not return an exact merge base for this proposal revision.'
    );
  }
  if (!comparison) {
    comparison = await githubService.compareRefs(owner, repo, `${baseSha}...${headSha}`);
  }
  let diffSummary = null;
  if (typeof githubService.getProposalDiff === 'function') {
    try {
      const summary = await githubService.getProposalDiff(
        owner, repo, `${baseSha}...${headSha}`, DIFF_CONTEXT_CHARS
      );
      diffSummary = {
        text: String(summary?.diff || '').slice(0, DIFF_CONTEXT_CHARS),
        fileCount: Math.max(0, Number(summary?.fileCount) || 0),
        truncated: summary?.truncated === true,
      };
    } catch (error) {
      log.warn('visual-evidence', 'Could not load the bounded proposal diff for evidence context', {
        owner, repo, headSha, error: error.message,
      });
    }
  }
  return {
    owner,
    repo,
    baseSha,
    headSha,
    files: comparison.files || [],
    filesComplete: comparison.filesComplete !== false,
    diffSummary,
  };
}

function evidenceWords(value) {
  return new Set(String(value || '').toLowerCase().replace(/\+/g, ' plus ')
    .match(/[a-z0-9]{4,}/g) || []);
}

function testingPathsForSession(session) {
  const candidates = [session?.testing_path,
    ...(Array.isArray(session?.testing_paths) ? session.testing_paths.map((entry) =>
      typeof entry === 'string' ? entry : entry?.path) : [])];
  return [...new Set(candidates.filter((value) =>
    planContract.validRelativePath(value) && !planContract.credentialLike(value)))].slice(0, 8);
}

function declaredCheckSummary(checkout, intent = null, testingPaths = []) {
  try {
    const checks = appManifest.readTests(appManifest.read(checkout));
    // A large manifest's first 80 checks can omit the changed screen
    // entirely. Put checks whose names, paths, or readiness selectors match
    // the accepted story first; retain declaration order for equal scores.
    const storyText = (intent?.stories || []).map((story) => [
      story.claim, story.intent?.startPath, story.intent?.checkpoint,
      story.intent?.focus, ...(story.intent?.steps || []),
    ].join(' ')).join(' ');
    const words = evidenceWords(storyText);
    const navigationWords = evidenceWords((intent?.stories || []).map((story) => [
      story.intent?.startPath, ...(story.intent?.steps || []),
    ].join(' ')).join(' '));
    const intentPaths = new Set((intent?.stories || []).map((story) => story.intent?.startPath)
      .filter((value) => value && value !== '/'));
    const knownTestingPaths = new Set(testingPaths);
    const frequencies = new Map();
    const indexed = checks.map((test, index) => {
      const nameWords = evidenceWords(test.name);
      const pathWords = evidenceWords(test.path);
      const selectorWords = evidenceWords(test.expectSelector);
      for (const word of new Set([...nameWords, ...pathWords, ...selectorWords])) {
        if (words.has(word)) frequencies.set(word, (frequencies.get(word) || 0) + 1);
      }
      return { test, index, nameWords, pathWords, selectorWords };
    });
    const ranked = indexed.map(({ test, index, nameWords, pathWords, selectorWords }) => {
      // The proposal's recorded manual test route is already a concrete
      // navigation clue. Prefer its exact declared check over a word match
      // to a generic screen, while leaving the browser agent to verify it.
      let score = intentPaths.has(test.path) ? 1_000_000
        : knownTestingPaths.has(test.path) ? 500_000 : 0;
      for (const word of words) {
        const weight = Math.log2(1 + checks.length / (frequencies.get(word) || 1))
          * (navigationWords.has(word) ? 3 : 1);
        if (nameWords.has(word)) score += 3 * weight;
        if (pathWords.has(word)) score += 2 * weight;
        if (selectorWords.has(word)) score += weight;
      }
      return { test, index, score };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    return ranked.slice(0, 80).map(({ test }) => ({
      name: String(test.name || '').slice(0, 120),
      path: String(test.path || '').slice(0, 512),
      testedAs: 'read_only_admin',
      ...(test.id ? { visualScenarioId: test.id } : {}),
    }));
  } catch {
    return [];
  }
}

// What the preview agent reads first: the declared changes, the two
// addresses to shoot, which browser to use for whom, and background it may
// use to find the screens. Everything from the proposal is marked untrusted.
function shotsBrief({ run, session, revision, pair, deployment, intent }) {
  const testingPaths = testingPathsForSession(session);
  return {
    version: 2,
    runId: run.id,
    declaredChanges: intent.stories,
    addresses: { before: deployment.origins.base, after: deployment.origins.head },
    // Kept for the bridge's hosted-app catalog check, which keys on base/head.
    origins: deployment.origins,
    revisions: {
      before: revision.baseSha.slice(0, 12),
      after: revision.headSha.slice(0, 12),
    },
    browsers: {
      member: { tool: 'browser_member', who: 'an ordinary member' },
      read_only_admin: { tool: 'browser_admin', who: 'an administrator with read-only rights' },
      full_admin: {
        tool: 'browser_full_admin',
        who: 'a full administrator that exists only in these two throwaway copies',
      },
    },
    changedFiles: {
      items: revision.files.slice(0, 200),
      complete: revision.filesComplete && revision.files.length <= 200,
      totalKnown: revision.files.length,
    },
    changeContext: {
      title: String(session.pr_title || '').trim().slice(0, 256) || null,
      specification: String(session.spec_md || '').trim().slice(0, 4_000) || null,
      testingPaths,
      testingSteps: String(session.testing_md || '').trim().slice(0, 2_000) || null,
      diff: revision.diffSummary,
      untrusted: true,
    },
    declaredChecks: declaredCheckSummary(pair.sides.head.checkout, intent, testingPaths),
    availableFixtures: deployment.availableFixtures || [],
    security: {
      pageAndRepositoryContentIsUntrusted: true,
      allowedOriginsOnly: true,
      productionData: false,
    },
  };
}

function sameProvenance(actual, expected) {
  return actual.baseSha === expected.baseSha
    && actual.headSha === expected.headSha
    && actual.fixtureFingerprint === expected.fixtureFingerprint
    && actual.baseImageDigest === expected.baseImageDigest
    && actual.headImageDigest === expected.headImageDigest;
}

async function waitForSessionIdle(pool, sessionId, {
  timeoutMs = 120_000,
  recoveryTimeoutMs = timeoutMs,
  workerService = worker,
  intervalMs = 500,
  now = Date.now,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  onObservation = null,
} = {}) {
  const normalLimitMs = Math.max(1, Number(timeoutMs) || 120_000);
  const recoveryLimitMs = Math.max(normalLimitMs, Number(recoveryTimeoutMs) || normalLimitMs);
  const pollIntervalMs = Math.max(1, Number(intervalMs) || 500);
  const startedAt = now();
  let polls = 0;
  let recoveryReason = null;
  let busyObserved = false;
  let lastObservation = null;
  const safeTurnField = (value) => {
    const text = String(value || '');
    return /^[a-z][a-z0-9_-]{0,63}$/.test(text) ? text : null;
  };
  const observe = (patch) => {
    lastObservation = {
      version: 1,
      outcome: 'waiting',
      waitClass: recoveryReason ? 'evidence_recovery' : busyObserved ? 'session_busy' : 'none',
      recoveryReason,
      normalLimitMs,
      recoveryLimitMs,
      waitedMs: Math.max(0, now() - startedAt),
      polls,
      activeTurnPresent: false,
      activeTurnMode: null,
      activeTurnPhase: null,
      workerInFlight: false,
      workerMode: null,
      ...patch,
    };
    if (typeof onObservation === 'function') onObservation({ ...lastObservation });
    return lastObservation;
  };

  while (true) {
    const { rows } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [sessionId]);
    if (!rows[0]) throw new VisualEvidenceOrchestrationError('session_not_found', 'Proposal session not found.');
    polls += 1;
    const activeTurnPresent = !!rows[0].active_turn;
    const activeTurn = turnLifecycle.parseActiveTurn(rows[0].active_turn);
    const activeTurnMode = safeTurnField(activeTurn?.mode);
    const activeTurnPhase = safeTurnField(turnLifecycle.phaseOf(activeTurn));
    const workerInFlight = !!(await workerService.isInFlight(sessionId));
    const workerMode = safeTurnField(await workerService.getActiveTurnMode?.(sessionId));
    if (activeTurnPresent || workerInFlight) busyObserved = true;
    if (!recoveryReason) {
      if (activeTurnMode === 'evidence') recoveryReason = 'evidence_turn';
      else if (activeTurnPhase === turnLifecycle.PHASE_CLEANUP_PENDING) {
        recoveryReason = 'cleanup_pending';
      } else if (workerMode === 'evidence') recoveryReason = 'evidence_worker';
    }
    const observation = observe({
      activeTurnPresent,
      activeTurnMode,
      activeTurnPhase,
      workerInFlight,
      workerMode,
    });
    if (!activeTurnPresent && !workerInFlight) {
      const result = { ...observation, outcome: 'idle' };
      if (typeof onObservation === 'function') onObservation({ ...result });
      return result;
    }
    const activeLimitMs = recoveryReason ? recoveryLimitMs : normalLimitMs;
    if (observation.waitedMs >= activeLimitMs) {
      const result = { ...observation, outcome: 'timeout' };
      if (typeof onObservation === 'function') onObservation({ ...result });
      throw new VisualEvidenceOrchestrationError(
        'evidence_agent_busy',
        recoveryReason
          ? 'The previous preview agent did not finish shutting down in time.'
          : 'The proposal agent stayed busy past the time the before/after shots had to start.',
        { idleWait: result }
      );
    }
    await wait(Math.min(pollIntervalMs, activeLimitMs - observation.waitedMs));
  }
}

function errorCode(error) {
  const code = String(error?.code || '');
  return /^[A-Za-z0-9_]{1,48}$/.test(code) ? code : 'visual_evidence_failed';
}

function safeModelId(value) {
  const model = String(value || '');
  return /^[A-Za-z0-9._:/-]{1,120}$/.test(model) ? model : null;
}

function redactDiagnosticText(value, max = 240) {
  return String(value)
    .replace(/(\b(?:token|access_token|auth|authorization|password|secret|api[_-]?key|code|session)\s*=\s*)[^&\s"'<>)]*/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:sk-(?:proj-)?|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{16,}\b/gi, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .slice(0, max);
}

// The worker deletes a normal-turn journal after it exits. Keep the model's
// final words only for a turn that did not produce evidence, in the private
// owner diagnostics. The runtime has seeded fixture data; mask known run
// credentials and internal origins before storing this bounded excerpt.
function agentFinalResponseSummary(result, authTokens, origins) {
  const raw = typeof result?.lastResultText === 'string' ? result.lastResultText.trim() : '';
  const knownValues = [...Object.values(authTokens || {}), ...Object.values(origins || {})];
  const scrubbed = redactDiagnosticText(
    logRedaction.redactValues(logRedaction.redactString(raw), knownValues), 3000
  );
  const safeEnum = (value) => /^[a-z0-9_:-]{1,80}$/i.test(String(value || '')) ? String(value) : null;
  return {
    workerResultPresent: !!result && typeof result === 'object',
    characters: raw.length,
    excerpt: scrubbed || null,
    truncated: raw.length > 3000,
    resultSubtype: safeEnum(result?.resultSubtype),
    stopReason: safeEnum(result?.providerStopReason),
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    permissionDenialCount: Number.isInteger(result?.permissionDenialCount)
      ? result.permissionDenialCount : null,
    toolErrorCount: Number.isInteger(result?.toolErrorCount) ? result.toolErrorCount : null,
    responseTextBlockCount: Number.isInteger(result?.responseTextBlockCount)
      ? result.responseTextBlockCount : null,
    providerTurnCount: Number.isInteger(result?.providerTurnCount)
      ? result.providerTurnCount : null,
  };
}

function visibleError(error) {
  const message = String(error?.message || 'The before/after shots could not be taken.').trim();
  return redactDiagnosticText(message, 2000) || 'The before/after shots could not be taken.';
}

function safeDiagnosticValue(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (depth >= 7) return '[nested detail omitted]';
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => safeDiagnosticValue(item, depth + 1));
  }
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).slice(0, 24)
    .filter(([key]) => !/^(?:token|authorization|cookie|password|secret|payload|data)$/i.test(key))
    .map(([key, item]) => [key, safeDiagnosticValue(item, depth + 1)]));
}

// An error's own structured detail (a reset or sign-in step, validation
// issues), redacted and bounded for the owner-only diagnostics.
function boundedErrorDetail(error) {
  try {
    const value = error?.detail || (error?.issues ? { issues: error.issues } : null);
    if (value == null) return null;
    const serialized = JSON.stringify(safeDiagnosticValue(value));
    return serialized.length <= 16000
      ? JSON.parse(serialized)
      : { truncated: true, excerpt: serialized.slice(0, 8000) };
  } catch { return null; }
}

const AGENT_DIAGNOSTIC_KINDS = new Set([
  'worker_prepare_start', 'worker_prepare_end', 'backend_selected',
  'turn_start', 'turn_end', 'provider_dispatched', 'provider_init',
  'provider_tool_config',
  'first_stream', 'first_output', 'provider_result', 'provider_notice', 'provider_usage',
  'context_result',
  'runner_phase', 'runner_result', 'runner_exit', 'resume_retry',
  'tool_start', 'tool_end', 'agent_deadline',
  'browser_call_start', 'browser_call_pending', 'browser_call_end', 'browser_server_exit',
  'auth_bootstrap', 'hosted_app_catalog', 'hosted_app_allowlist',
  'document_request', 'document_response', 'controlled_failure_set', 'controlled_failure_hit',
  'provider_request_start', 'provider_request_pending', 'provider_response_headers',
  'provider_response_first_byte', 'provider_request_end',
  'worker_stop_requested', 'worker_stop_returned',
]);
const AGENT_DIAGNOSTIC_PHASES = new Set([
  'refresh', 'evidence_proxy', 'evidence_browser_bootstrap',
  'evidence_mcp_ready', 'claude', 'agent', 'done',
]);
const AGENT_DIAGNOSTIC_TOOLS = new Set([
  'get_brief', 'save_shot', 'save_clip', 'skip_change', 'fail_request',
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot',
  'browser_take_screenshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option',
  'browser_hover', 'browser_mouse_move_xy', 'browser_drag', 'browser_resize', 'browser_wait_for',
  'browser_console_messages', 'browser_network_requests', 'browser_tabs',
  'browser_close', 'other',
]);

function recordAgentDiagnostic(metrics, raw) {
  const kind = String(raw?.kind || '');
  if (!AGENT_DIAGNOSTIC_KINDS.has(kind)) return;
  const activity = metrics.agentActivity;
  const event = { atMs: Math.max(0, Date.now() - metrics.startedAtMs), kind };
  if (raw.backend === 'claude_code' || raw.backend === 'codex_openrouter') {
    event.backend = raw.backend;
  }
  if (raw.requestMode === 'agent_new' || raw.requestMode === 'agent_resume') {
    event.requestMode = raw.requestMode;
  }
  if (AGENT_DIAGNOSTIC_PHASES.has(raw.phase)) event.phase = raw.phase;
  if (['ok', 'error', 'tool_error', 'rpc_error', 'unparsed', 'server_exit',
    'loaded', 'invalid', 'request_error', 'invalid_catalog',
    'http_error', 'network_error', 'stream_error', 'cancelled'].includes(raw.outcome)) {
    event.outcome = raw.outcome;
  }
  for (const key of ['mcpServerCount', 'toolDefinitionCount', 'topLevelFunctionToolCount',
    'topLevelNamespaceToolCount', 'topLevelCustomToolCount', 'topLevelOtherToolCount',
    'nestedToolDefinitionCount', 'nestedFunctionToolCount', 'nestedCustomToolCount',
    'nestedOtherToolCount', 'shotsToolDefinitionCount', 'otherMcpServerCount',
    'forwardedToolDefinitionCount', 'removedToolDefinitionCount', 'browserMemberToolCount',
    'browserAdminToolCount', 'browserFullAdminToolCount', 'storyCount', 'callOrdinal', 'headingCount',
    'buttonCount', 'linkCount', 'imageBlocks', 'exitCode', 'checkRank',
    'documentOrdinal', 'httpStatus', 'requestOrdinal', 'chunkCount', 'hitOrdinal',
    'count', 'catalogCount']) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0 && raw[key] <= 1000) {
      event[key] = raw[key];
    }
  }
  if (Number.isSafeInteger(raw.responseCharacters) && raw.responseCharacters >= 0
      && raw.responseCharacters <= 1_000_000) {
    event.responseCharacters = raw.responseCharacters;
  }
  for (const key of ['durationMs', 'responseBytes', 'textChars', 'bodyBytes']) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0 && raw[key] <= 10_000_000) {
      event[key] = raw[key];
    }
  }
  if (typeof raw.truncated === 'boolean') event.truncated = raw.truncated;
  if (kind === 'controlled_failure_set' && typeof raw.enabled === 'boolean') {
    event.enabled = raw.enabled;
  }
  if (['timeout', 'network', 'browser_closed', 'locator_ambiguous', 'other'].includes(raw.errorClass)) {
    event.errorClass = raw.errorClass;
  }
  if (raw.signal === 'SIGTERM' || raw.signal === 'SIGINT') event.signal = raw.signal;
  if (['base', 'head', 'hosted', 'outside'].includes(raw.side)) event.side = raw.side;
  if (['member', 'admin', 'full_admin'].includes(raw.persona)) event.persona = raw.persona;
  if (['intent_start', 'declared_check', 'other'].includes(raw.routeHint)) {
    event.routeHint = raw.routeHint;
  }
  if (['await_headers', 'await_first_byte', 'streaming'].includes(raw.stage)) {
    event.stage = raw.stage;
  }
  for (const key of ['briefToolAvailable', 'saveShotToolAvailable', 'skipChangeToolAvailable']) {
    if (typeof raw[key] === 'boolean') event[key] = raw[key];
  }
  for (const key of ['jsonValid', 'declaredChangesPresent', 'addressesPresent', 'revisionsPresent']) {
    if (typeof raw[key] === 'boolean') event[key] = raw[key];
  }
  if (kind === 'auth_bootstrap') {
    for (const key of ['attempted', 'cookieAlreadyPresent', 'sessionCookieInstalled', 'sessionCookiePresent']) {
      if (typeof raw[key] === 'boolean') event[key] = raw[key];
    }
    if (Number.isInteger(raw.responseStatus) && raw.responseStatus >= 100 && raw.responseStatus <= 599) {
      event.responseStatus = raw.responseStatus;
    }
  }
  for (const key of ['resultSubtype', 'providerStopReason']) {
    if (/^[a-z0-9_:-]{1,80}$/i.test(String(raw[key] || ''))) event[key] = raw[key];
  }
  if (kind === 'tool_start' || kind === 'tool_end'
      || kind === 'browser_call_start' || kind === 'browser_call_pending'
      || kind === 'browser_call_end') {
    event.tool = AGENT_DIAGNOSTIC_TOOLS.has(raw.tool) ? raw.tool : 'other';
    if (['member', 'admin', 'full_admin'].includes(raw.persona)) event.persona = raw.persona;
    if (['base', 'head', 'outside'].includes(raw.side)) event.side = raw.side;
    if (Number.isSafeInteger(raw.routeOrdinal) && raw.routeOrdinal > 0
        && raw.routeOrdinal <= 1000) event.routeOrdinal = raw.routeOrdinal;
    if (Number.isSafeInteger(raw.sequence) && raw.sequence > 0 && raw.sequence <= 100000) {
      event.sequence = raw.sequence;
    }
    if (kind === 'tool_start') {
      activity.toolCounts[event.tool] = (activity.toolCounts[event.tool] || 0) + 1;
    }
    if (kind === 'browser_call_start') {
      activity.browserCallCounts[event.tool] = (activity.browserCallCounts[event.tool] || 0) + 1;
    }
    if (event.sequence) {
      if (kind === 'tool_start') activity.pending.set(event.sequence, event);
      else activity.pending.delete(event.sequence);
    }
    if (event.callOrdinal && event.persona) {
      const key = `${event.persona}:${event.callOrdinal}`;
      if (kind === 'browser_call_start' || kind === 'browser_call_pending') {
        activity.browserPending.set(key, { ...activity.browserPending.get(key), ...event });
      } else if (kind === 'browser_call_end') {
        activity.browserPending.delete(key);
      }
    }
  }
  if (event.documentOrdinal && event.side) {
    const key = `${event.side}:${event.documentOrdinal}`;
    if (kind === 'document_request') activity.documentPending.set(key, event);
    else if (kind === 'document_response') activity.documentPending.delete(key);
  }
  if (event.requestOrdinal) {
    if (kind === 'provider_request_end') activity.providerPending.delete(event.requestOrdinal);
    else if (kind.startsWith('provider_request_') || kind.startsWith('provider_response_')) {
      activity.providerPending.set(event.requestOrdinal,
        { ...activity.providerPending.get(event.requestOrdinal), ...event });
    }
  }
  if (kind === 'provider_tool_config') {
    activity.providerToolConfigs.push(event);
    if (activity.providerToolConfigs.length > 8) activity.providerToolConfigs.shift();
  }
  activity.counts[kind] = (activity.counts[kind] || 0) + 1;
  activity.events.push(event);
  if (activity.events.length > MAX_AGENT_EVENTS) activity.events.shift();
}

function newRunMetrics() {
  return {
    startedAtMs: Date.now(),
    timingsMs: {
      idleWait: 0,
      provisioning: 0,
      agentExploration: 0,
      artifactPersist: 0,
      cleanup: 0,
    },
    agentAttempts: 0,
    agentDispatches: [],
    agentFinalResponses: [],
    agentActivity: { events: [], counts: {}, toolCounts: {}, pending: new Map(),
      browserCallCounts: {}, browserPending: new Map(), documentPending: new Map(),
      providerPending: new Map(), providerToolConfigs: [], budgetMs: null },
    agentFinalResponse: null,
    artifactBytes: 0,
    idleWait: null,
    tokenUsage: {},
  };
}

function addTiming(metrics, key, startedAtMs) {
  const elapsed = Math.max(0, Date.now() - startedAtMs);
  metrics.timingsMs[key] = Math.max(0, Number(metrics.timingsMs[key]) || 0) + elapsed;
  return elapsed;
}

function addAgentUsage(metrics, dispatched) {
  const result = dispatched?.result;
  if (!result || typeof result !== 'object') return;
  for (const key of [
    'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
    'outputTokens', 'reasoningOutputTokens', 'costCents',
  ]) {
    if (result[key] == null) continue;
    const value = Number(result[key]);
    if (!Number.isFinite(value) || value < 0) continue;
    metrics.tokenUsage[key] = (metrics.tokenUsage[key] || 0) + value;
  }
}

function agentActivitySummary(metrics) {
  return {
    version: 1,
    budgetMs: metrics.agentActivity.budgetMs,
    counts: { ...metrics.agentActivity.counts },
    toolCounts: { ...metrics.agentActivity.toolCounts },
    browserCallCounts: { ...metrics.agentActivity.browserCallCounts },
    events: metrics.agentActivity.events.slice(-MAX_AGENT_EVENTS),
    pendingTools: [...metrics.agentActivity.pending.values()].slice(-8),
    pendingBrowserCalls: [...metrics.agentActivity.browserPending.values()].slice(-8),
    pendingDocumentRequests: [...metrics.agentActivity.documentPending.values()].slice(-8),
    pendingProviderRequests: [...metrics.agentActivity.providerPending.values()].slice(-8),
    ...(metrics.agentActivity.providerToolConfigs.length ? {
      providerToolConfigs: metrics.agentActivity.providerToolConfigs.slice(-8),
    } : {}),
  };
}

function traceSummary(metrics, extra = {}) {
  return {
    ...extra,
    timingsMs: {
      ...metrics.timingsMs,
      total: Math.max(0, Date.now() - metrics.startedAtMs),
    },
    idleWait: metrics.idleWait,
    agentAttempts: metrics.agentAttempts,
    agentDispatches: metrics.agentDispatches.slice(0, 8),
    ...(metrics.agentFinalResponses.length
      ? { agentFinalResponses: metrics.agentFinalResponses.slice(0, 8) } : {}),
    agentActivity: agentActivitySummary(metrics),
    artifactBytes: metrics.artifactBytes,
    planSource: metrics.planSource || null,
    ...(Object.keys(metrics.tokenUsage).length ? { tokenUsage: { ...metrics.tokenUsage } } : {}),
  };
}

function notifyEvidence(session, app, evidenceState, extra = {}) {
  try {
    require('./ws').pushVoteUpdate({
      sessionId: Number(session.id),
      appId: app?.id || session.app_id || null,
      appSlug: app?.slug || session.app_slug || null,
      merged: false,
      action: 'visual_evidence',
      visualEvidenceState: evidenceState,
      ...extra,
    });
  } catch (_) { /* live refresh is best-effort; durable state is authoritative */ }
  notifyConversations(session.id);
}

// A conversation shows its active change's running preview (and its Stop),
// so the owners of the open conversations on this change re-read them.
function notifyConversations(changeId) {
  let pool;
  try { pool = require('../db/pool').getPool(); } catch (_) { return; }
  if (!pool || typeof pool.query !== 'function') return;
  pool.query(
    `SELECT id, user_id FROM agent_sessions WHERE active_change_id = $1 AND status = 'open'`,
    [Number(changeId)]
  ).then(({ rows }) => {
    const ws = require('./ws');
    for (const row of rows) ws.pushToUser(row.user_id, { type: 'agent_session_changed', agentSessionId: row.id });
  }).catch(() => { /* the conversation catches up on its next read */ });
}

async function failCurrentRun(pool, runId, error, stateService = state, runTrace = null) {
  try {
    const current = await stateService.getRun(pool, runId);
    if (current.current_run_id !== current.id || !ACTIVE_STATES.has(current.state)) return false;
    await stateService.transitionRun(pool, runId, 'failed', {
      failureCode: errorCode(error),
      failureReason: visibleError(error),
      ...(runTrace ? { traceSummary: runTrace } : {}),
    });
    return true;
  } catch (transitionError) {
    if (!['stale_evidence_operation', 'invalid_evidence_transition'].includes(transitionError?.code)) {
      log.warn('visual-evidence', 'Could not terminalize failed evidence run', {
        runId,
        code: transitionError?.code,
        error: transitionError?.message,
      });
    }
    return false;
  }
}

async function executeRun(config, options, injected = {}) {
  const deps = {
    state: injected.state || state,
    environment: injected.environment || environment,
    identities: injected.identities || identities,
    evidenceAgent: injected.evidenceAgent || evidenceAgent,
    evidenceControl: injected.evidenceControl || evidenceControl,
    worker: injected.worker || worker,
    waitForSessionIdle: injected.waitForSessionIdle || waitForSessionIdle,
  };
  const { pool, revision, onProgress = null } = options;
  let run = options.run;
  let session = options.session;
  let app = options.app;
  let pair = null;
  let registration = null;
  let failurePhase = 'load_run';
  let temporaryWorkerAttempted = false;
  const metrics = newRunMetrics();
  metrics.planSource = 'preview_agent';
  const agentBudgetMs = config.visualEvidence?.maxAgentMs || 480_000;
  metrics.agentActivity.budgetMs = agentBudgetMs;
  const progress = (message) => {
    if (typeof onProgress === 'function') onProgress(message);
  };
  const stage = (name) => progress({ stage: name });

  try {
    if (!run || !session || !app) {
      const current = await deps.state.getRun(pool, options.runId);
      const row = await loadSession(pool, current.session_id);
      ({ session, app } = publicSessionAndApp(row));
      run = current;
    }
    if (run.current_run_id && run.current_run_id !== run.id) {
      throw new VisualEvidenceOrchestrationError('stale_evidence_operation', 'A newer run took over these before/after shots before this one started.');
    }
    const intent = planContract.parseIntent(run.intent || intentForSession(session));
    if (run.state === 'not_required') return deps.state.getForSession(pool, session.id, { headSha: run.head_sha });
    if (intent.impact === 'none') {
      // State settles these as not_required; a legacy row must not start an
      // agent with nothing to shoot.
      throw new VisualEvidenceOrchestrationError(
        'visual_evidence_intent_conflict',
        'This proposal declares no visible change, so there is nothing to shoot.'
      );
    }

    failurePhase = 'wait_for_idle';
    stage(failurePhase);
    const idleStartedAt = Date.now();
    const runBudgetMs = config.visualEvidence?.maxRunMs || 1_440_000;
    const idleTimeoutMs = Math.min(runBudgetMs, SESSION_IDLE_WAIT_MS);
    const recoveryTimeoutMs = Math.min(runBudgetMs, EVIDENCE_RECOVERY_WAIT_MS);
    let recoveryWaitReported = false;
    try {
      metrics.idleWait = await deps.waitForSessionIdle(pool, session.id, {
        timeoutMs: idleTimeoutMs,
        recoveryTimeoutMs,
        workerService: deps.worker,
        onObservation: (observation) => {
          metrics.idleWait = observation;
          if (observation.waitClass === 'evidence_recovery' && !recoveryWaitReported) {
            recoveryWaitReported = true;
            progress('Waiting for the interrupted preview agent to finish cleaning up…');
          }
        },
      });
    } catch (error) {
      if (error?.detail?.idleWait) metrics.idleWait = error.detail.idleWait;
      throw error;
    } finally {
      addTiming(metrics, 'idleWait', idleStartedAt);
    }
    // A timeout stops the prior turn and leaves its worker stop marker. This
    // is a new run, so retire that marker once, after the prior turn is idle
    // and before this run provisions; a stop during setup still wins.
    deps.worker.clearPendingStop(session.id);
    progress('Building the exact before and after versions…');
    failurePhase = 'prepare_pair';
    stage(failurePhase);
    const provisioningStartedAt = Date.now();
    if (run.state === 'planned') {
      await deps.state.transitionRun(pool, run.id, 'provisioning', { startedAt: new Date() });
    } else if (run.state !== 'provisioning') {
      throw new VisualEvidenceOrchestrationError(
        'stale_evidence_operation', 'This run is no longer available to build.'
      );
    }
    notifyEvidence(session, app, 'provisioning');
    pair = await deps.environment.preparePair(config, { pool, run, session, app, onProgress });
    failurePhase = 'exploration_reset';
    stage(failurePhase);
    const exploration = await deps.environment.resetPair(config, pair, { onProgress });
    const expectedProvenance = {
      baseSha: run.base_sha,
      headSha: run.head_sha,
      fixtureFingerprint: pair.fixtureFingerprint,
      baseImageDigest: pair.sides.base.imageDigest,
      headImageDigest: pair.sides.head.imageDigest,
    };
    if (!sameProvenance(exploration, expectedProvenance)) {
      throw new VisualEvidenceOrchestrationError('evidence_provenance_mismatch', 'The before and after builds did not match their fixture and images.');
    }
    failurePhase = 'mint_fixture_identities';
    stage(failurePhase);
    const authTokens = await deps.identities.mintEvidenceAuthTokens(pool, app.id);
    failurePhase = 'persist_exploration';
    stage(failurePhase);
    await deps.state.transitionRun(pool, run.id, 'exploring', {
      fixtureFingerprint: pair.fixtureFingerprint,
      baseImageDigest: pair.sides.base.imageDigest,
      headImageDigest: pair.sides.head.imageDigest,
    });
    addTiming(metrics, 'provisioning', provisioningStartedAt);
    notifyEvidence(session, app, 'exploring');
    stage('exploring');

    const context = shotsBrief({ run, session, revision, pair, deployment: exploration, intent });
    const navigationHints = {
      intentPaths: intent.stories.map((story) => story.intent.startPath),
      testingPaths: context.changeContext.testingPaths,
      declaredPaths: context.declaredChecks.map((check) => check.path),
    };
    const recordClips = intent.stories.some((story) => planContract.needsClip(story));
    failurePhase = 'register_control';
    stage(failurePhase);
    registration = deps.evidenceControl.registerRun({
      runId: run.id,
      sessionId: session.id,
      intent,
      context,
      expiresAt: Date.now() + runBudgetMs,
    });

    const agentStartedAt = Date.now();
    const dispatchOnce = async (forceBackend = null) => {
      if (stopRequested.has(run.id)) {
        throw new VisualEvidenceOrchestrationError('evidence_stopped', EVIDENCE_STOPPED_REASON);
      }
      metrics.agentAttempts += 1;
      const dispatchTrace = {
        requestedBackend: String(forceBackend || session.agent_backend || 'unknown').slice(0, 64),
        requestedModel: safeModelId(session.agent_model || session.model),
        budgetMs: agentBudgetMs,
      };
      metrics.agentDispatches.push(dispatchTrace);
      const dispatchStartedAt = Date.now();
      try {
        // Provisioning is platform work; the agent's budget starts here and
        // is shared by the first dispatch and any backend fallback.
        const remainingMs = agentBudgetMs - (Date.now() - agentStartedAt);
        dispatchTrace.timeoutMs = Math.max(0, remainingMs);
        if (remainingMs <= 0) {
          throw new VisualEvidenceOrchestrationError(
            'evidence_agent_timeout', 'The preview agent ran out of time.'
          );
        }
        if (evidenceAgent.temporaryEvidenceWorker(session)) temporaryWorkerAttempted = true;
        const dispatched = await deps.evidenceAgent.dispatch(config, {
          pool,
          session,
          runId: run.id,
          origins: exploration.origins,
          authTokens,
          navigationHints,
          recordClips,
          onProgress: (line) => progress(`Preview agent: ${line}`),
          onEvidenceDiagnostic: (event) => {
            recordAgentDiagnostic(metrics, event);
            options.onAgentDiagnostic?.(agentActivitySummary(metrics), event?.kind);
          },
          resumeThreadId: null,
          forceBackend,
          timeoutMs: remainingMs,
        }, injected.agentDependencies || {});
        addAgentUsage(metrics, dispatched);
        dispatchTrace.backend = String(dispatched.backend || dispatchTrace.requestedBackend).slice(0, 64);
        dispatchTrace.model = safeModelId(dispatched.model);
        if (dispatched.fallbackReason) dispatchTrace.fallbackReason = String(dispatched.fallbackReason).slice(0, 64);
        dispatchTrace.outcome = 'completed';
        metrics.agentFinalResponse = agentFinalResponseSummary(
          dispatched.result, authTokens, exploration.origins
        );
        metrics.agentFinalResponses.push({
          dispatch: metrics.agentDispatches.length, ...metrics.agentFinalResponse,
        });
        options.onAgentFinalResponse?.(metrics.agentFinalResponse);
        return { dispatched, error: null };
      } catch (error) {
        if (error?.evidenceBackend) dispatchTrace.backend = String(error.evidenceBackend).slice(0, 64);
        if (error?.evidenceModel) dispatchTrace.model = safeModelId(error.evidenceModel);
        dispatchTrace.outcome = 'failed';
        dispatchTrace.code = errorCode(error);
        return { dispatched: null, error };
      } finally {
        metrics.timingsMs.agentExploration += Math.max(0, Date.now() - dispatchStartedAt);
      }
    };

    failurePhase = 'agent_exploration';
    stage(failurePhase);
    progress('The preview agent is taking before/after shots…');
    let agentOutcome = await dispatchOnce();
    if (agentOutcome.error && registration.control.saved.size === 0
        && session.agent_backend === 'codex_openrouter'
        && !metrics.agentActivity.counts.provider_dispatched) {
      progress('The selected Codex model could not start; using the platform preview agent…');
      agentOutcome = await dispatchOnce('claude_code');
    }

    // Publish every change with a complete before/after set, even when the
    // turn ran out of time or another change was skipped. Only a run with
    // nothing to publish fails, and it says why for each change.
    const summary = registration.control.summary();
    if (!summary.verdict.passed) {
      const reasons = [...new Set(summary.stories.map((story) => story.reason).filter(Boolean))];
      if (agentOutcome.error && !registration.control.skipped.size && !registration.control.skippedAll) {
        throw agentOutcome.error;
      }
      throw new VisualEvidenceOrchestrationError(
        'evidence_capture_incomplete',
        reasons.join(' ').slice(0, 1800) || 'The preview agent did not save a before and after shot.'
      );
    }
    failurePhase = 'persist_shots';
    stage(failurePhase);
    await deps.state.transitionRun(pool, run.id, 'reviewing', {
      hardVerdict: summary.verdict,
      planHash: summary.manifestHash,
      traceSummary: traceSummary(metrics, {
        planHash: summary.manifestHash, runs: 1, stories: summary.verdict.stories,
      }),
    });
    notifyEvidence(session, app, 'reviewing');
    const artifactPersistStartedAt = Date.now();
    failurePhase = 'store_artifacts';
    stage(failurePhase);
    await deps.state.storeArtifacts(pool, run.id, summary.files, {
      headSha: run.head_sha,
      planHash: summary.manifestHash,
    });
    addTiming(metrics, 'artifactPersist', artifactPersistStartedAt);
    metrics.artifactBytes = summary.files.reduce((sum, file) => sum + file.bytes, 0);

    // Tear the before/after builds down before the shots become visible, so
    // no published run can leave private fixture runtimes live.
    failurePhase = 'cleanup';
    stage(failurePhase);
    const cleanupStartedAt = Date.now();
    await deps.environment.cleanupPair(config, pair);
    addTiming(metrics, 'cleanup', cleanupStartedAt);
    pair = null;
    const finalTrace = traceSummary(metrics, {
      planHash: summary.manifestHash,
      runs: 1,
      stories: summary.verdict.stories,
      terminalFailureClass: null,
    });
    failurePhase = 'verify';
    stage(failurePhase);
    await deps.state.transitionRun(pool, run.id, 'verified', {
      hardVerdict: summary.verdict,
      planHash: summary.manifestHash,
      traceSummary: finalTrace,
    });
    const { agentFinalResponses: _privateResponses, ...logFinalTrace } = finalTrace;
    log.info('visual-evidence', 'Before/after shots published', {
      sessionId: session.id,
      runId: run.id,
      trace: logFinalTrace,
    });
    notifyEvidence(session, app, 'verified');
    progress('Before/after shots are ready.');
    return deps.state.getForSession(pool, session.id, { headSha: run.head_sha });
  } catch (error) {
    const control = registration?.control;
    const toolFailure = control?.lastToolFailure;
    const detail = boundedErrorDetail(error);
    const failureTrace = traceSummary(metrics, {
      terminalFailureClass: errorCode(error),
      ...(metrics.agentFinalResponse ? { agentFinalResponse: metrics.agentFinalResponse } : {}),
      failure: {
        phase: failurePhase,
        code: errorCode(error),
        message: visibleError(error),
        ...(toolFailure ? {
          tool: toolFailure.operation,
          toolCode: errorCode(toolFailure.error),
          toolMessage: visibleError(toolFailure.error),
        } : {}),
        ...(detail ? { detail } : {}),
      },
      ...(control ? { control: {
        savedFiles: control.saved.size,
        skippedChanges: control.skipped.size,
        skippedAll: control.skippedAll ? true : false,
      } } : {}),
    });
    const failed = await failCurrentRun(
      pool,
      run?.id || options.runId,
      error,
      deps.state,
      failureTrace
    );
    if (failed && session && app) {
      notifyEvidence(session, app, 'failed', { failureCode: errorCode(error) });
    }
    // The final model answer is for the proposal owner and app managers only;
    // do not copy its potentially app-derived text into the general log ring.
    const {
      agentFinalResponse: _privateResponse,
      agentFinalResponses: _privateResponses,
      ...logTrace
    } = failureTrace;
    log.warn('visual-evidence', 'Before/after run ended without shots', {
      sessionId: session?.id || null,
      runId: run?.id || options.runId || null,
      code: errorCode(error),
      trace: logTrace,
    });
    throw error;
  } finally {
    registration?.unregister();
    if (run) stopRequested.delete(run.id);
    try {
      if (pair) {
        const cleanupStartedAt = Date.now();
        try { await deps.environment.cleanupPair(config, pair); }
        finally {
          addTiming(metrics, 'cleanup', cleanupStartedAt);
          log.info('visual-evidence', 'Before/after build cleanup finished', {
            sessionId: session?.id || null,
            runId: run?.id || options.runId || null,
            cleanupMs: metrics.timingsMs.cleanup,
          });
        }
      }
    } finally {
      if (temporaryWorkerAttempted) {
        try {
          await deps.worker.destroyCcVolume(session.id);
          log.info('visual-evidence', 'Temporary preview worker released', {
            sessionId: session.id, runId: run?.id || options.runId || null,
          });
        } catch (error) {
          // Cleanup must not replace the run's outcome. The Kubernetes
          // error is still logged so operators can investigate a leak.
          log.warn('visual-evidence', 'Temporary preview worker cleanup failed', {
            sessionId: session.id, runId: run?.id || options.runId || null,
            error: error.message,
          });
        }
      }
    }
  }
}

// #2601/#2558: the human sentence for each refusal, for the proposal to
// carry and for the log line. `already_running` and `not_required` are not
// here on purpose — neither is a run that failed to start, and a run with a
// state of its own says more than any note could.
const NOT_STARTED_REASONS = Object.freeze({
  disabled: 'Before/after shots are not being taken on this deployment, so nothing picked this one up.',
  missing_intent: 'This proposal has no declared change recorded, so there was nothing to shoot.',
  no_revision: 'The proposal revision to preview could not be resolved, so the run never started.',
  no_staging_preview: 'No staging preview was built for this commit, so there was nothing to take before/after shots of.',
});

// Store the refusal on the proposal and say so at info level. Both halves
// are best-effort: a refusal that cannot be written down must not turn into
// an exception on a fire-and-forget scheduling path.
async function noteNotStarted(pool, sessionId, reason, injected = {}) {
  const text = NOT_STARTED_REASONS[reason] || null;
  log.info('visual-evidence', 'Visual evidence run not started', { sessionId, reason });
  if (!text) return;
  try {
    await (injected.state || state).recordNotStarted(pool, sessionId, text);
  } catch (error) {
    log.warn('visual-evidence', 'Could not record why the visual evidence run did not start', {
      sessionId, reason, error: error.message,
    });
  }
}

async function scheduleForSession(config, options, injected = {}) {
  const { pool, sessionId, headSha = null, trigger = 'preview-ready',
    onProgress = null } = options;
  if (!config.visualEvidence?.execute) {
    await noteNotStarted(pool, sessionId, 'disabled', injected);
    return { scheduled: false, reason: 'disabled' };
  }
  const session = await loadSession(pool, sessionId);
  // Closed changes do not start automatic evidence runs. A proposal owner or
  // manager may still deliberately rerun a merged change to diagnose an old
  // failure; its temporary evidence worker does not recreate a retained PVC.
  if (CLOSED_STATUSES.has(session.status)
      && !(session.status === 'merged' && trigger === 'manual-rerun')) {
    return { scheduled: false, reason: 'closed' };
  }
  const intent = intentForSession(session);
  if (!intent) {
    await noteNotStarted(pool, sessionId, 'missing_intent', injected);
    return { scheduled: false, reason: 'missing_intent' };
  }
  // An explicit head is a fence, not permission to revive a former commit.
  // The session is reloaded here because the author route and the checks
  // hand-off both observed it earlier, before this asynchronous launch.
  if (headSha && exactSha(headSha) !== headForSession(session)) {
    return { scheduled: false, reason: 'head_moved' };
  }
  const revision = await resolveRevisionContext(session, headSha, injected.github || github);
  const key = `${sessionId}:${revision.headSha}`;
  if (inFlight.has(key)) return { scheduled: false, reason: 'already_running', promise: inFlight.get(key) };
  const heuristicUi = uiFileHeuristic(revision.files);
  const created = await (injected.state || state).createRun(pool, {
    sessionId,
    baseSha: revision.baseSha,
    headSha: revision.headSha,
    intent,
    trigger,
    heuristicUi,
  });
  const run = created.run;
  notifyEvidence(session, publicSessionAndApp(session).app, run.state);
  require('./pr-metadata').syncEvidencePrBlock(pool, sessionId).catch((error) => {
    log.warn('visual-evidence', 'Could not publish the authenticated evidence link to the PR', {
      sessionId, runId: run.id, error: error.message,
    });
  });
  if (run.state === 'not_required') {
    return { scheduled: false, reason: 'not_required', runId: run.id };
  }
  if (!created.created && run.state !== 'planned') {
    return { scheduled: false, reason: run.state, runId: run.id };
  }
  // Claim the durable planned row before handing work to an asynchronous
  // runner. A checks hand-off, the recovery sweep and an author submission
  // may all arrive together, including on different server pods. Only one
  // planned -> provisioning transition may own the paired environments.
  try {
    await (injected.state || state).transitionRun(pool, run.id, 'provisioning', {
      startedAt: new Date(),
    });
  } catch (error) {
    if (['invalid_evidence_transition', 'stale_evidence_operation'].includes(error?.code)) {
      return { scheduled: false, reason: 'already_running', runId: run.id };
    }
    throw error;
  }
  const { session: sessionValue, app } = publicSessionAndApp(session);
  // The run is under way, so whatever an earlier attempt recorded about it
  // not starting is no longer true (#2601/#2558).
  await (injected.state || state).clearNotStarted(pool, sessionId).catch(() => {});
  const heartbeat = startRunHeartbeat(
    pool, run.id, injected.state || state, onProgress,
    injected.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS
  );
  const promise = executeRun(config, {
    pool,
    run: { ...run, state: 'provisioning' },
    session: sessionValue,
    app,
    revision,
    onProgress: heartbeat.onProgress,
    onAgentDiagnostic: heartbeat.onAgentDiagnostic,
    onAgentFinalResponse: heartbeat.onAgentFinalResponse,
  }, injected).catch((error) => {
    log.warn('visual-evidence', 'Visual evidence run failed', {
      sessionId,
      runId: run.id,
      code: errorCode(error),
      error: visibleError(error),
    });
    throw error;
  }).finally(() => {
    heartbeat.stop();
    inFlight.delete(key);
    inFlightRunIds.delete(key);
  });
  // Attach a rejection observer now so fire-and-forget callers never create
  // an unhandled rejection; callers that need completion may still await the
  // original promise returned below.
  promise.catch(() => {});
  inFlight.set(key, promise);
  inFlightRunIds.set(key, run.id);
  return { scheduled: true, runId: run.id, promise };
}

function inFlightSnapshot() {
  return [...inFlight.keys()];
}

function inFlightRunSnapshot() {
  return [...inFlightRunIds.values()];
}

// The running evidence run on a change, whatever its head, or null. Settles
// (never rejects) when the run ends.
function inFlightRunFor(sessionId) {
  const prefix = `${Number(sessionId)}:`;
  for (const [key, promise] of inFlight) {
    if (key.startsWith(prefix)) return promise.then(() => {}, () => {});
  }
  return null;
}

// A person's Stop on the change's running before/after shots. The run is
// failed at once, with its own code, so the proposal reads "stopped" and an
// automatic trigger for the same head does not start it again (a person's
// Rerun still does). The preview agent is killed only when the change's
// worker is running an evidence turn: never a coding turn. Whatever step the
// runner is inside ends at its next state transition, which the failed run
// refuses, and its temporary environments are released then.
async function stopForSession(pool, sessionId, injected = {}) {
  const stateService = injected.state || state;
  const workerApi = injected.worker || worker;
  const session = await loadSession(pool, sessionId);
  const runId = session.visual_evidence_run_id;
  if (!runId) return { stopped: false, reason: 'not_running' };
  const run = await stateService.getRun(pool, runId);
  if (!run || run.current_run_id !== run.id || !ACTIVE_STATES.has(run.state)) {
    return { stopped: false, reason: 'not_running' };
  }
  try {
    await stateService.transitionRun(pool, run.id, 'failed', {
      failureCode: 'evidence_stopped',
      failureReason: EVIDENCE_STOPPED_REASON,
    });
  } catch (error) {
    if (['invalid_evidence_transition', 'stale_evidence_operation'].includes(error?.code)) {
      return { stopped: false, reason: 'not_running' };
    }
    throw error;
  }
  if (inFlight.has(`${Number(sessionId)}:${run.head_sha}`)) stopRequested.add(run.id);
  if (workerApi.getActiveTurnMode(sessionId) === 'evidence') {
    await workerApi.stopTurn(sessionId).catch((error) => {
      log.warn('visual-evidence', 'Could not stop the preview agent', { sessionId, runId: run.id, error: error.message });
    });
  }
  log.info('visual-evidence', 'Before/after shots stopped', { sessionId, runId: run.id, from: run.state });
  notifyEvidence(session, publicSessionAndApp(session).app, 'failed', { failureCode: 'evidence_stopped' });
  return { stopped: true, runId: run.id };
}

module.exports = {
  VisualEvidenceOrchestrationError,
  exactSha,
  headForSession,
  intentForSession,
  uiFileHeuristic,
  loadSession,
  resolveRevisionContext,
  declaredCheckSummary,
  shotsBrief,
  sameProvenance,
  waitForSessionIdle,
  newRunMetrics,
  addTiming,
  addAgentUsage,
  traceSummary,
  progressPhase,
  startRunHeartbeat,
  liveRunObserver,
  notifyEvidence,
  failCurrentRun,
  executeRun,
  scheduleForSession,
  noteNotStarted,
  NOT_STARTED_REASONS,
  inFlightSnapshot,
  inFlightRunSnapshot,
  inFlightRunFor,
  stopForSession,
  EVIDENCE_STOPPED_REASON,
};
