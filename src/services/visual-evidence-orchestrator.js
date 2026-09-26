'use strict';

// #2380 — end-to-end coordinator for exact-revision visual evidence. This
// module deliberately separates model exploration from deterministic replay:
// the evidence agent can submit a plan through RunControl, while only these
// callbacks may reset fixtures, execute the plan twice, store bytes, or move
// the durable run to verified.

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
const replay = require('./visual-evidence-replay');
const state = require('./visual-evidence-state');
const { isUiAffecting: uiFileHeuristic } = require('./visual-file-classifier');
const worker = require('./worker');

const ACTIVE_STATES = new Set(['planned', 'provisioning', 'exploring', 'replaying', 'reviewing']);
const CLOSED_STATUSES = new Set(['merged', 'archived']);
const EVIDENCE_STOPPED_REASON = 'Stopped before it finished. Nothing was captured for this commit; run it again from the proposal to capture it.';
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
const MAX_REPLAY_EVENTS = 40;
const MAX_AGENT_EVENTS = 128;
const REPAIRABLE_LOCATOR_CODES = new Set([
  'ambiguous_locator', 'locator_not_found', 'locator_not_visible',
]);
const MAX_REPAIR_ATTEMPTS = 2;

function replayRepairKind(error, plan) {
  const code = errorCode(error);
  if (REPAIRABLE_LOCATOR_CODES.has(code)) return 'locator';
  if (code === 'controlled_failure_unused') return 'controlled_failure';
  if (code === 'browser_diagnostics' && error?.detail?.phase === 'browser_diagnostics') {
    const diagnostics = error.detail.browserDiagnostics || error.detail;
    const httpErrors = diagnostics.httpErrors || [];
    const consoleErrors = diagnostics.consoleErrors || [];
    // A same-origin API 404 can mean the planner followed a check fixture
    // under the wrong persona. Give it a bounded chance to find real data.
    // Browser errors and blocked origins always invalidate this replay; a
    // hosted-app story may instead select another real app on a fresh pass.
    if (httpErrors.length > 0
        && httpErrors.every((item) => item.status === 404
          && item.location?.sameOrigin === true
          && String(item.location?.pathname || '').startsWith('/api/'))
        && consoleErrors.every((item) => item.source?.sameOrigin === true
          && httpErrors.some((response) => response.location.pathname === item.source.pathname)
          && /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/.test(item.message || ''))
        && !(diagnostics.pageErrors || []).length
        && !(diagnostics.failedRequests || []).length
        && !(diagnostics.blockedRequests || []).length) return 'route_data';
    const story = plan?.stories?.find((item) => item.id === error.detail.storyId);
    const openedHostedApp = ['before', 'after'].some((side) =>
      story?.replay?.[side]?.actions?.some((action) => action.type === 'waitForHostedApp'));
    if (openedHostedApp && error.detail.hostedAppSlugs?.length
        && (diagnostics.blockedRequests?.some((item) => item.embedded === true)
          || diagnostics.pageErrors?.some((item) => item.sourceKind === 'hosted_app')
          || diagnostics.consoleErrors?.some((item) => item.sourceKind === 'hosted_app'))) return 'hosted_app';
  }
  if (code === 'unstable_checkpoint' && error?.detail?.phase === 'capture_checkpoint'
      && error.detail.sampleCount >= 3) {
    const story = plan?.stories?.find((item) => item.id === error.detail.storyId);
    if (story && story.intent.animation !== 'motion') return 'static_timing';
  }
  // A missing element in a positive assertion is another locator error.
  // Wrong values and states remain hard failures except for an exact motion
  // checkpoint that can be verified after an observed, bounded state wait.
  if (code !== 'assertion_failed' || error?.detail?.phase !== 'assertion') return null;
  if (error.detail.count === 0
    && ['visible', 'attached', 'checked', 'text', 'value', 'focusWithin']
      .includes(error.detail.assertion?.type)) return 'locator';
  const detail = error.detail;
  const story = plan?.stories?.find((item) => item.id === detail.storyId);
  const side = detail.side === 'base' ? 'before' : detail.side === 'head' ? 'after' : null;
  const assertion = side && Number.isInteger(detail.assertionIndex)
    ? story?.replay?.checkpoint?.assertions?.[side]?.[detail.assertionIndex] : null;
  if (story?.intent?.animation !== 'motion' || !assertion
      || planContract.canonicalJson(assertion) !== planContract.canonicalJson(detail.assertion)) return null;
  // A motion marker can still be visible at the checkpoint even though it
  // will settle moments later. Permit one bounded plan correction, but only
  // when the exact recorded assertion failed for that transient state.
  if (assertion.type === 'hidden' && detail.count === 1 && detail.actual === true) return 'motion_timing';
  if (assertion.type === 'count' && assertion.count === 0
      && Number.isInteger(detail.count) && detail.count > 0) return 'motion_timing';
  return null;
}

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
  let lastReplayEvent = null;
  const replayEvents = [];
  let lastReplayFlushAt = 0;
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
          ...(lastReplayEvent ? { lastReplayEvent, replayEvents: replayEvents.slice(-MAX_REPLAY_EVENTS) } : {}),
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
    onReplayEvent(event) {
      if (stopped || !event || typeof event !== 'object') return;
      lastReplayEvent = event;
      replayEvents.push(event);
      if (replayEvents.length > MAX_REPLAY_EVENTS) replayEvents.shift();
      // Persist an action start immediately: if its browser call hangs or the
      // pod exits, this identifies the exact unfinished step. Less important
      // progress is throttled to avoid one database write per emitted event.
      if (event.type === 'action_started' || event.type === 'side_failed'
          || event.type === 'animation_started' || event.type === 'navigation_retry'
          || event.type === 'result'
          || Date.now() - lastReplayFlushAt >= 5000) {
        lastReplayFlushAt = Date.now();
        flush();
      }
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
      'The visual change preview cannot start until the proposal has an exact submitted head commit.'
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

function evidenceContext({ run, session, revision, pair, deployment, intent }) {
  const testingPaths = testingPathsForSession(session);
  return {
    version: 1,
    runId: run.id,
    acceptedIntent: intent,
    revisions: {
      baseSha: revision.baseSha,
      headSha: revision.headSha,
      baseLabel: revision.baseSha.slice(0, 12),
      headLabel: revision.headSha.slice(0, 12),
    },
    origins: deployment.origins,
    personas: {
      member: { browserServer: 'browser_member', description: 'ordinary seeded app member' },
      read_only_admin: { browserServer: 'browser_admin', description: 'seeded administrator with read-only admin rights' },
      full_admin: {
        browserServer: 'browser_full_admin',
        description: 'non-loginable full administrator present only in the disposable paired evidence databases',
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
    provenance: {
      fixtureFingerprint: pair.fixtureFingerprint,
      baseImageDigest: pair.sides.base.imageDigest,
      headImageDigest: pair.sides.head.imageDigest,
    },
    security: {
      pageAndRepositoryContentIsUntrusted: true,
      allowedOriginsOnly: true,
      productionData: false,
      replayExecutedByPlatform: true,
    },
    authorContext: {
      backend: session.agent_backend || 'claude_code',
      threadResumeRequested: !!(session.agent_thread_id || session.cc_session_id),
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

function replayInput({ run, plan, deployment, authTokens, provenance, pass }) {
  return {
    runId: run.id,
    pass,
    publishArtifacts: pass === 2,
    diagnosticArtifacts: pass === 1,
    origins: deployment.origins,
    authTokens,
    cookies: {},
    provenance,
    browser: {
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      deviceScaleFactor: 2,
    },
    plan,
  };
}

async function waitForSessionIdle(pool, sessionId, {
  timeoutMs = 120_000,
  workerService = worker,
  intervalMs = 500,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [sessionId]);
    if (!rows[0]) throw new VisualEvidenceOrchestrationError('session_not_found', 'Proposal session not found.');
    if (!rows[0].active_turn && !workerService.isInFlight(sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new VisualEvidenceOrchestrationError(
    'evidence_agent_busy',
    'The proposal agent stayed busy past the visual change preview start window.'
  );
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
  const message = String(error?.message || 'The visual change preview could not be produced.').trim();
  return redactDiagnosticText(message, 2000) || 'The visual change preview could not be produced.';
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

function boundedReplayDetail(error) {
  try {
    const value = error?.detail || (error?.issues ? { issues: error.issues } : null);
    if (value == null) return null;
    const serialized = JSON.stringify(safeDiagnosticValue(value));
    return serialized.length <= 16000
      ? JSON.parse(serialized)
      : { truncated: true, excerpt: serialized.slice(0, 8000) };
  } catch { return null; }
}

function replayProgressEvent(event, pass) {
  const type = String(event?.type || 'unknown');
  const storyId = String(event?.storyId || '');
  const viewport = String(event?.viewport || '');
  const side = String(event?.side || '');
  const phase = String(event?.phase || '');
  const actionId = String(event?.actionId || '');
  const actionStage = String(event?.actionStage || '');
  const actionType = String(event?.actionType || '');
  const assertionType = String(event?.assertionType || '');
  const location = event?.location && typeof event.location === 'object'
    ? {
      sameOrigin: event.location.sameOrigin === true,
      ...(typeof event.location.pathname === 'string'
        ? { pathname: safeDiagnosticValue(event.location.pathname) } : {}),
      ...(typeof event.location.hash === 'string'
        ? { hash: safeDiagnosticValue(event.location.hash) } : {}),
      queryKeys: Array.isArray(event.location.queryKeys)
        ? event.location.queryKeys.slice(0, 12).map((value) => safeDiagnosticValue(String(value))) : [],
    } : null;
  return {
    pass,
    type: /^[a-z_]{1,40}$/.test(type) ? type : 'unknown',
    ...(/^[a-z0-9][a-z0-9_-]{0,95}$/.test(storyId) ? { storyId } : {}),
    ...(/^[a-z0-9][a-z0-9_-]{0,31}$/.test(viewport) ? { viewport } : {}),
    ...(['base', 'head'].includes(side) ? { side } : {}),
    ...(/^[a-z_]{1,40}$/.test(phase) ? { phase } : {}),
    ...(/^[a-z0-9][a-z0-9_-]{0,95}$/.test(actionId) ? { actionId } : {}),
    ...(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(actionStage) ? { actionStage } : {}),
    ...(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(actionType) ? { actionType } : {}),
    ...(Number.isInteger(event?.assertionIndex) && event.assertionIndex >= 0
      ? { assertionIndex: event.assertionIndex } : {}),
    ...(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(assertionType) ? { assertionType } : {}),
    ...(Number.isInteger(event?.durationMs) && event.durationMs >= 0
      ? { durationMs: event.durationMs } : {}),
    ...(type === 'navigation_retry' && event?.attempt === 2 ? { attempt: 2 } : {}),
    ...(['actionCount', 'assertionCount', 'recordedFrameCount', 'httpErrorCount',
      'recoveredRequestCount', 'recoveredNetworkChanges', 'controlledFailureHits',
      'expectedFailureConsoleCount', 'expectedSandboxWarnings', 'baseFrames', 'headFrames', 'bytes'].reduce((counts, key) => {
      if (Number.isInteger(event?.[key]) && event[key] >= 0) counts[key] = event[key];
      return counts;
    }, {})),
    ...(type === 'checkpoint_stability' ? {
      mode: event.mode === 'motion' ? 'motion' : 'static',
      networkQuiet: event.networkQuiet === true,
      ...(['sampleCount', 'networkWaitMs', 'captureWaitMs'].reduce((values, key) => {
        if (Number.isInteger(event?.[key]) && event[key] >= 0) values[key] = event[key];
        return values;
      }, {})),
      samples: Array.isArray(event.samples) ? event.samples.slice(0, 6).map((sample) => ({
        ...(['settleMs', 'screenshotMs', 'hashMs', 'distance'].reduce((values, key) => {
          if (Number.isInteger(sample?.[key]) && sample[key] >= 0) values[key] = sample[key];
          return values;
        }, {})),
      })) : [],
    } : {}),
    ...(type === 'session_bootstrap' ? {
      attempted: event.attempted === true,
      cookieAlreadyPresent: event.cookieAlreadyPresent === true,
      sessionCookieInstalled: event.sessionCookieInstalled === true,
      ...(Number.isInteger(event.responseStatus) ? { responseStatus: event.responseStatus } : {}),
    } : {}),
    ...(['steps', 'motion'].includes(event?.animation) ? { animation: event.animation } : {}),
    ...(Number.isInteger(event?.status) && event.status >= 100 && event.status <= 599
      ? { status: event.status } : {}),
    ...(location ? { location } : {}),
    ...(typeof event?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(event.code)
      ? { code: event.code } : {}),
    ...(type === 'result' && event?.passed === true ? {
      passed: true,
      ...(Number.isInteger(event.artifactCount) ? { artifactCount: event.artifactCount } : {}),
      ...(Array.isArray(event.stories) ? { storyCount: event.stories.length } : {}),
    } : {}),
    ...(type === 'result' && event?.passed === false ? {
      passed: false,
      code: /^[a-z0-9_]{1,80}$/.test(String(event.code || '')) ? String(event.code) : 'replay_failed',
      message: safeDiagnosticValue(String(event.message || 'Evidence replay failed.')),
      ...(event.detail != null ? { detail: boundedReplayDetail({ detail: event.detail }) } : {}),
    } : {}),
  };
}

const AGENT_DIAGNOSTIC_KINDS = new Set([
  'worker_prepare_start', 'worker_prepare_end', 'backend_selected',
  'turn_start', 'turn_end', 'provider_dispatched', 'provider_init',
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
  'evidence_get_context', 'evidence_reset_side', 'evidence_set_request_failure', 'evidence_run_plan',
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot',
  'browser_take_screenshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option',
  'browser_hover', 'browser_drag', 'browser_resize', 'browser_wait_for',
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
  for (const key of ['mcpServerCount', 'toolDefinitionCount', 'browserMemberToolCount',
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
  for (const key of ['evidenceGetContextAvailable', 'evidenceRunPlanAvailable']) {
    if (typeof raw[key] === 'boolean') event[key] = raw[key];
  }
  for (const key of ['jsonValid', 'acceptedIntentPresent', 'originsPresent', 'revisionsPresent']) {
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
      replay: 0,
      artifactPersist: 0,
      cleanup: 0,
    },
    replayPasses: [],
    replayRuntime: null,
    lastReplayEvent: null,
    replayEvents: [],
    agentAttempts: 0,
    agentDispatches: [],
    agentActivity: { events: [], counts: {}, toolCounts: {}, pending: new Map(),
      browserCallCounts: {}, browserPending: new Map(), documentPending: new Map(),
      providerPending: new Map(), budgetMs: null },
    agentFinalResponse: null,
    repairCount: 0,
    repairTrigger: null,
    repairTriggers: [],
    fixtureResets: [],
    artifactBytes: 0,
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
  };
}

function traceSummary(metrics, extra = {}) {
  return {
    ...extra,
    timingsMs: {
      ...metrics.timingsMs,
      total: Math.max(0, Date.now() - metrics.startedAtMs),
    },
    replayPasses: metrics.replayPasses.slice(0, 12),
    replayRuntime: metrics.replayRuntime,
    lastReplayEvent: metrics.lastReplayEvent,
    replayEvents: metrics.replayEvents.slice(-MAX_REPLAY_EVENTS),
    fixtureResets: metrics.fixtureResets.slice(0, 12),
    agentAttempts: metrics.agentAttempts,
    agentDispatches: metrics.agentDispatches.slice(0, 4),
    agentActivity: agentActivitySummary(metrics),
    repairCount: metrics.repairCount,
    ...(metrics.repairTrigger ? { repairTrigger: metrics.repairTrigger } : {}),
    repairTriggers: metrics.repairTriggers.slice(0, MAX_REPAIR_ATTEMPTS),
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
    replay: injected.replay || replay,
    evidenceAgent: injected.evidenceAgent || evidenceAgent,
    evidenceControl: injected.evidenceControl || evidenceControl,
    worker: injected.worker || worker,
  };
  const { pool, revision, onProgress = null } = options;
  let run = options.run;
  let session = options.session;
  let app = options.app;
  let pair = null;
  let registration = null;
  let latestArtifacts = null;
  let latestPlanHash = null;
  let latestHardVerdict = null;
  let failurePhase = 'load_run';
  let temporaryWorkerAttempted = false;
  // The first planning turn must not inherit the proposal's coding history.
  // Subsequent locator-repair turns resume only this run's evidence thread.
  let agentThreadId = null;
  const metrics = newRunMetrics();
  metrics.replayRuntime = String(config.captureRuntime || process.env.CAPTURE_RUNTIME || config.appRuntime || 'docker').slice(0, 32);
  const agentBudgetMs = config.visualEvidence?.maxAgentMs || 480_000;
  const repairAgentBudgetMs = config.visualEvidence?.maxRepairAgentMs || 240_000;
  const agentWindows = new Map();
  metrics.agentActivity.budgetMs = agentBudgetMs;
  let replayBudgetStartedAt = null;
  let replaySuspendedMs = 0;
  const suspendedMs = () => replaySuspendedMs
    + (replayBudgetStartedAt == null ? 0 : Date.now() - replayBudgetStartedAt);
  const progress = (message) => {
    if (typeof onProgress === 'function') onProgress(message);
  };
  const stage = (name) => progress({ stage: name });
  const recordReplayEvent = (event, pass) => {
    const summary = replayProgressEvent(event, pass);
    summary.elapsedMs = Math.max(0, Date.now() - metrics.startedAtMs);
    metrics.lastReplayEvent = summary;
    metrics.replayEvents.push(summary);
    if (metrics.replayEvents.length > MAX_REPLAY_EVENTS) metrics.replayEvents.shift();
    if (typeof options.onReplayEvent === 'function') options.onReplayEvent(summary);
    progress(`Evidence pass ${pass}: ${summary.type}`);
  };

  try {
    if (!run || !session || !app) {
      const current = await deps.state.getRun(pool, options.runId);
      const row = await loadSession(pool, current.session_id);
      ({ session, app } = publicSessionAndApp(row));
      run = current;
    }
    if (run.current_run_id && run.current_run_id !== run.id) {
      throw new VisualEvidenceOrchestrationError('stale_evidence_operation', 'This visual change preview run was superseded before it started.');
    }
    const intent = planContract.parseIntent(run.intent || intentForSession(session));
    const authorPlan = options.authorPlan == null
      ? (run.author_plan == null ? null : planContract.parseReplayPlan(run.author_plan))
      : planContract.parseReplayPlan(options.authorPlan);
    metrics.planSource = authorPlan ? 'author' : 'hosted_planner';
    if (authorPlan && planContract.canonicalJson(planContract.semanticIntentFromPlan(authorPlan))
        !== planContract.canonicalJson(intent)) {
      throw new VisualEvidenceOrchestrationError(
        'evidence_intent_mismatch',
        'The author plan must preserve the proposal’s accepted visual claims.'
      );
    }
    if (run.state === 'not_required') return deps.state.getForSession(pool, session.id, { headSha: run.head_sha });
    if (intent.impact === 'none') {
      throw new VisualEvidenceOrchestrationError(
        'visual_evidence_intent_conflict',
        'This revision changes browser UI files but declares no visual change. The author must provide a visible claim and replayable steps, or revise the change or declaration before evidence can run.'
      );
    }

    failurePhase = 'wait_for_idle';
    stage(failurePhase);
    const idleStartedAt = Date.now();
    await waitForSessionIdle(pool, session.id, {
      timeoutMs: Math.min(config.visualEvidence?.maxRunMs || 1_440_000, 120_000),
      workerService: deps.worker,
    });
    addTiming(metrics, 'idleWait', idleStartedAt);
    if (!authorPlan) {
      // A timeout stops the prior hosted turn and leaves its worker stop
      // marker intact. This is a new evidence run, so retire that marker
      // once, after the prior turn is idle and before this run provisions.
      // Do not clear it in dispatchOnce: a stop during this run's setup must
      // still prevent its first dispatch, fallback, and repair turns.
      deps.worker.clearPendingStop(session.id);
    }
    progress('Preparing exact base and head revisions for visual evidence…');
    failurePhase = 'prepare_pair';
    stage(failurePhase);
    const provisioningStartedAt = Date.now();
    if (run.state === 'planned') {
      await deps.state.transitionRun(pool, run.id, 'provisioning', { startedAt: new Date() });
    } else if (run.state !== 'provisioning') {
      throw new VisualEvidenceOrchestrationError(
        'stale_evidence_operation', 'This visual evidence run is no longer available for provisioning.'
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
      throw new VisualEvidenceOrchestrationError('evidence_provenance_mismatch', 'The paired exploration environment did not match its prepared fixture and images.');
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

    const context = evidenceContext({ run, session, revision, pair, deployment: exploration, intent });
    const navigationHints = {
      intentPaths: intent.stories.map((story) => story.intent.startPath),
      testingPaths: context.changeContext.testingPaths,
      declaredPaths: context.declaredChecks.map((check) => check.path),
    };
    failurePhase = 'register_control';
    stage(failurePhase);
    registration = deps.evidenceControl.registerRun({
      runId: run.id,
      sessionId: session.id,
      intent,
      context,
      expiresAt: Date.now() + (config.visualEvidence?.maxRunMs || 1_440_000),
      resetSide: async (side) => {
        const reset = await deps.environment.resetPair(config, pair, { onProgress });
        if (!sameProvenance(reset, expectedProvenance)) {
          throw new VisualEvidenceOrchestrationError('evidence_provenance_mismatch', 'The exploration reset changed the paired fixture or image.');
        }
        return { side, origin: reset.origins[side], bothSidesReset: true };
      },
      runPlan: async (plan, { attempt }) => {
        const replayStartedAt = Date.now();
        replayBudgetStartedAt = replayStartedAt;
        try {
          progress(attempt === 1
            ? (authorPlan
              ? 'Replaying the change author’s submitted UI flow twice…'
              : 'Replaying the agent-authored UI flow twice…')
            : 'Replaying the corrected UI flow twice…');
          failurePhase = 'persist_replay_plan';
          stage(failurePhase);
          await deps.state.transitionRun(pool, run.id, 'replaying', {
            replayPlan: plan,
            planHash: planContract.planHash(plan),
            repairAttempt: attempt - 1,
          });
          notifyEvidence(session, app, 'replaying');
          const planHash = planContract.planHash(plan);
          const prepareCase = (pass) => async ({ storyId, viewport }) => {
            failurePhase = `reset_pass_${pass}`;
            stage(failurePhase);
            const resetStartedAt = Date.now();
            const deployment = await deps.environment.resetPair(config, pair, { onProgress });
            if (!sameProvenance(deployment, expectedProvenance)) {
              throw new VisualEvidenceOrchestrationError('evidence_provenance_mismatch',
                `Replay pass ${pass} did not use the prepared fixture and images.`);
            }
            metrics.fixtureResets.push({ pass, storyId, viewport,
              durationMs: Math.max(0, Date.now() - resetStartedAt) });
            failurePhase = `pass_${pass}`;
            stage(failurePhase);
            return deployment;
          };
          const firstStartedAt = Date.now();
          failurePhase = 'pass_1';
          stage(failurePhase);
          const first = await deps.replay.runPassCases(
            config,
            session.id,
            replayInput({ run, plan, deployment: exploration, authTokens, provenance: expectedProvenance, pass: 1 }),
            { prepareCase: prepareCase(1), onEvent: (event) => {
              recordReplayEvent(event, 1);
            }, previewRunId: run.id }
          );
          metrics.replayPasses.push({
            attempt,
            pass: 1,
            durationMs: Math.max(0, Date.now() - firstStartedAt),
          });
          const secondStartedAt = Date.now();
          failurePhase = 'pass_2';
          stage(failurePhase);
          const second = await deps.replay.runPassCases(
            config,
            session.id,
            replayInput({ run, plan, deployment: exploration, authTokens, provenance: expectedProvenance, pass: 2 }),
            { prepareCase: prepareCase(2), onEvent: (event) => {
              recordReplayEvent(event, 2);
            }, previewRunId: run.id }
          );
          metrics.replayPasses.push({
            attempt,
            pass: 2,
            durationMs: Math.max(0, Date.now() - secondStartedAt),
          });
          failurePhase = 'compare';
          stage(failurePhase);
          const hardVerdict = deps.replay.comparePasses(first, second, {
            plan,
            provenance: expectedProvenance,
            runId: run.id,
          });
          if (!hardVerdict.passed) {
            if (hardVerdict.code === 'non_reproducible' && hardVerdict.detail?.side) {
              try {
                await deps.replay.storeDiagnosticArtifacts(pool, run.id, first.artifacts, second.artifacts, {
                  headSha: run.head_sha,
                  planHash,
                  attempt,
                  comparison: hardVerdict.detail,
                });
              } catch (diagnosticError) {
                log.warn('visual-evidence', 'Could not retain private comparison images', {
                  sessionId: session.id, runId: run.id,
                  code: errorCode(diagnosticError),
                  message: visibleError(diagnosticError),
                });
              }
            }
            throw new VisualEvidenceOrchestrationError(hardVerdict.code, hardVerdict.reason, hardVerdict.detail || null);
          }
          const replayTrace = traceSummary(metrics, {
            planHash,
            runs: 2,
            stories: hardVerdict.stories,
            relativePointer: hardVerdict.relativePointer,
          });
          failurePhase = 'persist_replay_verdict';
          stage(failurePhase);
          await deps.state.transitionRun(pool, run.id, 'reviewing', {
            hardVerdict,
            traceSummary: replayTrace,
            repairAttempt: attempt - 1,
          });
          notifyEvidence(session, app, 'reviewing');
          const artifactPersistStartedAt = Date.now();
          failurePhase = 'store_artifacts';
          stage(failurePhase);
          await deps.replay.storeArtifacts(pool, run.id, second.artifacts, {
            headSha: run.head_sha,
            planHash,
          });
          addTiming(metrics, 'artifactPersist', artifactPersistStartedAt);
          addTiming(metrics, 'replay', replayStartedAt);
          metrics.artifactBytes = second.artifacts.reduce(
            (sum, artifact) => sum + Math.max(0, Number(artifact.bytes) || artifact.data?.length || 0),
            0
          );
          latestArtifacts = second.artifacts;
          latestPlanHash = planHash;
          latestHardVerdict = hardVerdict;
          failurePhase = 'agent_exploration';
          stage(failurePhase);
          return {
            hardVerdict,
            planHash,
            traceSummary: traceSummary(metrics, {
              planHash,
              runs: 2,
              stories: hardVerdict.stories,
              relativePointer: hardVerdict.relativePointer,
            }),
          };
        } finally {
          replaySuspendedMs += Date.now() - replayStartedAt;
          replayBudgetStartedAt = null;
        }
      },
    });

    const dispatchOnce = async (forceBackend = null, repairAttempt = 0) => {
      if (stopRequested.has(run.id)) {
        throw new VisualEvidenceOrchestrationError('evidence_stopped', EVIDENCE_STOPPED_REASON);
      }
      let window = agentWindows.get(repairAttempt);
      if (!window) {
        window = { startedAt: Date.now(), suspendedAt: suspendedMs() };
        agentWindows.set(repairAttempt, window);
      }
      const dispatchStartedAt = Date.now();
      const suspendedAtStart = suspendedMs();
      metrics.agentAttempts += 1;
      const dispatchTrace = {
        requestedBackend: String(forceBackend || session.agent_backend || 'unknown').slice(0, 64),
        requestedModel: safeModelId(session.agent_model || session.model),
        repairAttempt,
        budgetMs: repairAttempt > 0 ? repairAgentBudgetMs : agentBudgetMs,
      };
      metrics.agentDispatches.push(dispatchTrace);
      try {
        // Provisioning and deterministic replay are platform work. Starting
        // this clock before the paired images/fixtures were ready spent the
        // agent's four minutes before it could even open its first page.
        const remainingAgentMs = dispatchTrace.budgetMs
          - (Date.now() - window.startedAt
            - (suspendedMs() - window.suspendedAt));
        dispatchTrace.timeoutMs = Math.max(0, remainingAgentMs);
        if (remainingAgentMs <= 0) {
          throw new VisualEvidenceOrchestrationError(
            'evidence_agent_timeout',
            'The preview agent used its bounded exploration time.'
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
          onProgress: (line) => progress(`Evidence agent: ${line}`),
          onEvidenceDiagnostic: (event) => {
            recordAgentDiagnostic(metrics, event);
            options.onAgentDiagnostic?.(agentActivitySummary(metrics), event?.kind);
          },
          resumeThreadId: agentThreadId,
          forceBackend,
          repairAttempt,
          timeoutMs: remainingAgentMs,
          suspendedMs,
        }, injected.agentDependencies || {});
        addAgentUsage(metrics, dispatched);
        agentThreadId = dispatched.threadId || agentThreadId || null;
        dispatchTrace.backend = String(dispatched.backend || dispatchTrace.requestedBackend).slice(0, 64);
        dispatchTrace.model = safeModelId(dispatched.model);
        if (dispatched.fallbackReason) dispatchTrace.fallbackReason = String(dispatched.fallbackReason).slice(0, 64);
        dispatchTrace.outcome = 'completed';
        if (!latestHardVerdict?.passed) {
          metrics.agentFinalResponse = agentFinalResponseSummary(
            dispatched.result, authTokens, exploration.origins
          );
          options.onAgentFinalResponse?.(metrics.agentFinalResponse);
        }
        return { dispatched, error: null };
      } catch (error) {
        if (error?.evidenceBackend) dispatchTrace.backend = String(error.evidenceBackend).slice(0, 64);
        if (error?.evidenceModel) dispatchTrace.model = safeModelId(error.evidenceModel);
        dispatchTrace.outcome = 'failed';
        dispatchTrace.code = errorCode(error);
        return { dispatched: null, error };
      } finally {
        metrics.timingsMs.agentExploration += Math.max(0,
          Date.now() - dispatchStartedAt - (suspendedMs() - suspendedAtStart));
      }
    };

    const awaitSubmittedReplay = async () => {
      if (!registration.control.planCalls) return;
      try { await registration.control.waitForPlan(); }
      catch { /* The control retains the exact replay error for repair or failure. */ }
    };

    failurePhase = 'agent_exploration';
    stage(failurePhase);
    let agentOutcome = null;
    if (authorPlan) {
      // The implementing agent already knows the UI flow. It supplies only
      // the typed plan; the same platform-owned two-pass replay and storage
      // decide whether the captured media is reproducible and complete.
      await registration.control.runPlan(authorPlan);
    } else {
      progress('The proposal agent is exploring the changed UI…');
      agentOutcome = await dispatchOnce();
      if (agentOutcome.error && !latestHardVerdict
          && registration.control.planCalls === 0
          && session.agent_backend === 'codex_openrouter'
          && !metrics.agentActivity.counts.provider_dispatched) {
        progress('The selected Codex model could not start the evidence flow; using the platform evidence planner…');
        agentOutcome = await dispatchOnce('claude_code');
      }
      // The hosted tool acknowledges an accepted plan immediately. Its HTTP
      // request must never wait through a full paired browser replay, which
      // can exceed ingress and MCP idle timeouts. The platform owns and awaits
      // the replay here, even if the planning agent has already exited.
      await awaitSubmittedReplay();
      while (!latestHardVerdict
          && registration.control.planCalls === metrics.repairCount + 1
          && metrics.repairCount < MAX_REPAIR_ATTEMPTS
          && ['pass_1', 'pass_2'].includes(failurePhase)
          && replayRepairKind(registration.control.lastReplayFailure?.error,
            registration.control.lastSubmittedPlan)) {
        const replayFailure = registration.control.lastReplayFailure.error;
        const repairKind = replayRepairKind(replayFailure, registration.control.lastSubmittedPlan);
        // A wrong locator or premature motion checkpoint can get a bounded
        // correction turn. No failed media is published; the replacement must
        // still pass both clean, provenance-fenced replay passes.
        const failureDetail = boundedReplayDetail(replayFailure);
        registration.control.allowRepair(
          repairKind === 'motion_timing'
            ? 'A motion checkpoint ran while an observed element was still visible. Inspect both revisions and add an observed, bounded wait without changing the checkpoint assertions or interactions.'
            : repairKind === 'static_timing'
              ? 'The static checkpoint kept changing after at least three pixel samples. Inspect both revisions and wait for an observed settled state. Keep the original interactions, focus, and assertions.'
            : repairKind === 'hosted_app'
              ? 'The selected hosted app loaded but had browser errors or blocked external requests. Inspect a different deployed public app on both revisions, keep the original platform interaction and assertions, and use it only if its runtime loads cleanly. Do not widen the network policy or suppress browser errors.'
            : repairKind === 'route_data'
              ? 'The planned route produced same-origin API 404s. Inspect the accepted persona on both revisions, choose real accessible data, and follow the claimed user flow. Do not use an error page or a shell with missing content as evidence.'
            : 'A planned locator did not match the intended visible element during replay. Inspect its actual state on both revisions and correct the replays.',
          {
            kind: repairKind,
            code: errorCode(replayFailure),
            message: visibleError(replayFailure),
            detail: failureDetail,
          }
        );
        metrics.repairTrigger = {
          kind: repairKind,
          code: errorCode(replayFailure),
          ...(Number.isInteger(metrics.lastReplayEvent?.pass)
            ? { pass: metrics.lastReplayEvent.pass } : {}),
          ...(['base', 'head'].includes(failureDetail?.side)
            ? { side: failureDetail.side } : {}),
          ...(/^[a-z0-9][a-z0-9_-]{0,95}$/.test(String(failureDetail?.actionId || ''))
            ? { actionId: failureDetail.actionId } : {}),
          ...(Number.isInteger(failureDetail?.assertionIndex)
            ? { assertionIndex: failureDetail.assertionIndex } : {}),
        };
        metrics.repairTriggers.push(metrics.repairTrigger);
        // The failed pass may have changed its fixture. Restore the same
        // pinned pair before the planner inspects the control again.
        failurePhase = 'repair_reset';
        const repairResetStartedAt = Date.now();
        try { await registration.control.resetSide('base'); }
        finally { replaySuspendedMs += Date.now() - repairResetStartedAt; }
        metrics.repairCount += 1;
        failurePhase = 'agent_repair';
        progress(repairKind === 'motion_timing'
          ? 'A motion checkpoint ran before the animation settled; the evidence agent is checking the timing…'
          : repairKind === 'static_timing'
            ? 'The static checkpoint kept changing; the evidence agent is checking the settled state…'
          : repairKind === 'hosted_app'
            ? 'The selected app had browser errors; the evidence agent is checking another deployed app…'
          : repairKind === 'route_data'
            ? 'The planned route could not load its data; the evidence agent is checking the account and fixture…'
          : 'A planned control did not match the page; the evidence agent is inspecting and correcting it…');
        const priorBackend = metrics.agentDispatches.at(-1)?.requestedBackend;
        agentOutcome = await dispatchOnce(priorBackend === 'claude_code' ? 'claude_code' : null, metrics.repairCount);
        await awaitSubmittedReplay();
        if (registration.control.planCalls === metrics.repairCount) break;
      }
      if (agentOutcome.error && !latestHardVerdict) {
        if (metrics.repairCount > 0 && registration.control.planCalls === metrics.repairCount) {
          throw agentOutcome.error;
        }
        throw registration.control.lastReplayFailure?.error
          || registration.control.lastToolFailure?.error || agentOutcome.error;
      }
    }

    if (!latestHardVerdict?.passed || !latestArtifacts || !latestPlanHash) {
      // The run-plan tool can fail while the model turn itself exits normally.
      // Preserve that platform replay error instead of replacing it with the
      // unhelpful "missing replay" fallback.
      if (registration.control.lastReplayFailure) throw registration.control.lastReplayFailure.error;
      if (registration.control.lastToolFailure) throw registration.control.lastToolFailure.error;
      if (registration.control.finished?.status === 'failed') {
        throw new VisualEvidenceOrchestrationError('evidence_agent_reported_failure', registration.control.finished.reason);
      }
      throw new VisualEvidenceOrchestrationError('missing_evidence_replay', 'The visual evidence replay did not produce a passing plan.');
    }

    // A successful run tears down its exact-revision environment before it
    // becomes reviewer-visible. Cleanup is part of the durable timing trace,
    // and no verified row can leave private fixture runtimes live.
    if (pair) {
      failurePhase = 'cleanup';
      stage(failurePhase);
      const cleanupStartedAt = Date.now();
      await deps.environment.cleanupPair(config, pair);
      addTiming(metrics, 'cleanup', cleanupStartedAt);
      pair = null;
    }
    const finalTrace = traceSummary(metrics, {
      planHash: latestPlanHash,
      runs: 2,
      stories: latestHardVerdict?.stories || [],
      relativePointer: latestHardVerdict?.relativePointer === true,
      terminalFailureClass: null,
    });
    failurePhase = 'verify';
    stage(failurePhase);
    await deps.state.transitionRun(pool, run.id, 'verified', {
      hardVerdict: latestHardVerdict,
      planHash: latestPlanHash,
      repairAttempt: Math.max(0, registration.control.planCalls - 1),
      traceSummary: finalTrace,
    });
    log.info('visual-evidence', 'Visual evidence captures stored', {
      sessionId: session.id,
      runId: run.id,
      trace: finalTrace,
    });
    notifyEvidence(session, app, 'verified');
    progress('Visual evidence captured for human review.');
    return deps.state.getForSession(pool, session.id, { headSha: run.head_sha });
  } catch (error) {
    const control = registration?.control;
    const toolFailure = control?.lastReplayFailure || control?.lastToolFailure;
    const diagnosticError = toolFailure?.error || error;
    const replayDetail = boundedReplayDetail(diagnosticError);
    const failureTrace = traceSummary(metrics, {
      terminalFailureClass: errorCode(error),
      ...(metrics.agentFinalResponse ? { agentFinalResponse: metrics.agentFinalResponse } : {}),
      failure: {
        phase: toolFailure?.operation === 'run-plan' && control.planCalls === 0
          ? 'plan_validation' : failurePhase,
        code: errorCode(diagnosticError),
        message: visibleError(diagnosticError),
        ...(toolFailure ? { tool: toolFailure.operation } : {}),
        ...(replayDetail ? { detail: replayDetail } : {}),
      },
      ...(control ? { control: {
        planCalls: control.planCalls,
        finishStatus: control.finished?.status || null,
        finishReason: control.finished?.reason || null,
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
    const { agentFinalResponse: _privateResponse, ...logTrace } = failureTrace;
    log.warn('visual-evidence', 'Visual evidence run ended without captured evidence', {
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
          log.info('visual-evidence', 'Visual evidence environment cleanup finished', {
            sessionId: session?.id || null,
            runId: run?.id || options.runId || null,
            cleanupMs: metrics.timingsMs.cleanup,
          });
        }
      }
    } finally {
      // Repair attempts resume the same evidence thread, so keep the worker
      // through the entire run and release it only after the last attempt.
      if (temporaryWorkerAttempted) {
        try {
          await deps.worker.destroyCcVolume(session.id);
          log.info('visual-evidence', 'Temporary evidence worker released', {
            sessionId: session.id, runId: run?.id || options.runId || null,
          });
        } catch (error) {
          // Cleanup must not replace the replay verdict. The Kubernetes
          // error is still logged so operators can investigate a leak.
          log.warn('visual-evidence', 'Temporary evidence worker cleanup failed', {
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
  disabled: 'Visual change previews are not being run on this deployment, so nothing picked this one up.',
  missing_intent: 'This proposal has no visual change preview claim recorded, so there was nothing to run.',
  no_revision: 'The proposal revision to preview could not be resolved, so the run never started.',
  no_staging_preview: 'No staging preview was built for this commit, so there was nothing to record a visual change preview against.',
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
    onProgress = null, authorPlan = null } = options;
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
    authorPlan,
  });
  const run = created.run;
  if (run.author_plan) {
    log.info('visual-evidence', 'Scheduling submitted author plan', {
      sessionId, runId: run.id, headSha: run.head_sha,
      planHash: planContract.planHash(run.author_plan),
    });
  }
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
    onReplayEvent: heartbeat.onReplayEvent,
    authorPlan: run.author_plan || authorPlan,
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

// A person's Stop on the change's running visual change preview. The run is
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
  log.info('visual-evidence', 'Visual change preview stopped', { sessionId, runId: run.id, from: run.state });
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
  evidenceContext,
  sameProvenance,
  replayInput,
  waitForSessionIdle,
  newRunMetrics,
  addTiming,
  addAgentUsage,
  traceSummary,
  progressPhase,
  replayProgressEvent,
  replayRepairKind,
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
