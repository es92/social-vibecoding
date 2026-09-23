'use strict';

// #2380 — end-to-end coordinator for exact-revision visual evidence. This
// module deliberately separates model exploration from deterministic replay:
// the evidence agent can submit a plan through RunControl, while only these
// callbacks may reset fixtures, execute the plan twice, store bytes, or move
// the durable run to verified.

const appManifest = require('./app-manifest');
const github = require('./github');
const log = require('./logger');
const evidenceAgent = require('./visual-evidence-agent');
const evidenceControl = require('./visual-evidence-control');
const environment = require('./visual-evidence-environment');
const identities = require('./visual-evidence-identities');
const planContract = require('./visual-evidence-plan');
const replay = require('./visual-evidence-replay');
const state = require('./visual-evidence-state');
const worker = require('./worker');

const ACTIVE_STATES = new Set(['planned', 'provisioning', 'exploring', 'replaying', 'reviewing']);
const DIFF_CONTEXT_CHARS = 8_000;
const inFlight = new Map();
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_REPLAY_EVENTS = 40;

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
  const flush = () => {
    if (stopped || typeof stateService.heartbeatRun !== 'function') return;
    if (writing) { pending = true; return; }
    writing = true;
    Promise.resolve().then(async () => {
      do {
        pending = false;
        await stateService.heartbeatRun(pool, runId, phase,
          lastReplayEvent ? { lastReplayEvent, replayEvents: replayEvents.slice(-MAX_REPLAY_EVENTS) } : null);
      } while (pending && !stopped);
    }).catch((error) => {
      log.warn('visual-evidence', 'Evidence heartbeat failed', { runId, error: error.message });
    }).finally(() => {
      writing = false;
      if (pending && !stopped) flush();
    });
  };
  const timer = setInterval(flush, intervalMs);
  timer.unref?.();
  flush();
  return {
    onReplayEvent(event) {
      if (stopped || !event || typeof event !== 'object') return;
      lastReplayEvent = event;
      replayEvents.push(event);
      if (replayEvents.length > MAX_REPLAY_EVENTS) replayEvents.shift();
      // Persist an action start immediately: if its browser call hangs or the
      // pod exits, this identifies the exact unfinished step. Less important
      // progress is throttled to avoid one database write per emitted event.
      if (event.type === 'action_started' || event.type === 'side_failed'
          || event.type === 'animation_started' || event.type === 'result'
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
      if (next && next !== phase) { phase = next; flush(); }
    },
    stop() { stopped = true; clearInterval(timer); },
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

function uiFileHeuristic(files) {
  return (files || []).some((name) => /(?:^|\/)(?:frontend|public|client|web|ui|components?|pages?|views?|styles?)(?:\/|$)/i.test(name)
    || /\.(?:html?|css|scss|sass|less|tsx?|jsx?|vue|svelte|svg)$/i.test(name));
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

function declaredCheckSummary(checkout) {
  try {
    return appManifest.readTests(appManifest.read(checkout)).slice(0, 80).map((test) => ({
      name: String(test.name || '').slice(0, 120),
      path: String(test.path || '').slice(0, 512),
      ...(test.id ? { visualScenarioId: test.id } : {}),
    }));
  } catch {
    return [];
  }
}

function evidenceContext({ run, session, revision, pair, deployment, intent }) {
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
    },
    changedFiles: {
      items: revision.files.slice(0, 200),
      complete: revision.filesComplete && revision.files.length <= 200,
      totalKnown: revision.files.length,
    },
    changeContext: {
      title: String(session.pr_title || '').trim().slice(0, 256) || null,
      specification: String(session.spec_md || '').trim().slice(0, 4_000) || null,
      diff: revision.diffSummary,
      untrusted: true,
    },
    declaredChecks: declaredCheckSummary(pair.sides.head.checkout),
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
    ...(['actionCount', 'assertionCount', 'recordedFrameCount', 'httpErrorCount', 'baseFrames', 'headFrames', 'bytes'].reduce((counts, key) => {
      if (Number.isInteger(event?.[key]) && event[key] >= 0) counts[key] = event[key];
      return counts;
    }, {})),
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
    repairCount: 0,
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
    agentAttempts: metrics.agentAttempts,
    agentDispatches: metrics.agentDispatches.slice(0, 4),
    repairCount: metrics.repairCount,
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
  let agentThreadId;
  const metrics = newRunMetrics();
  metrics.replayRuntime = String(config.captureRuntime || process.env.CAPTURE_RUNTIME || config.appRuntime || 'docker').slice(0, 32);
  const agentBudgetMs = config.visualEvidence?.maxAgentMs || 240_000;
  let agentWindowStartedAt = null;
  let agentWindowSuspendedAt = 0;
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

    failurePhase = 'wait_for_idle';
    stage(failurePhase);
    const idleStartedAt = Date.now();
    await waitForSessionIdle(pool, session.id, {
      timeoutMs: Math.min(config.visualEvidence?.maxRunMs || 720_000, 120_000),
      workerService: deps.worker,
    });
    addTiming(metrics, 'idleWait', idleStartedAt);
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
    const exploration = await deps.environment.resetPair(config, pair);
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
    failurePhase = 'register_control';
    stage(failurePhase);
    registration = deps.evidenceControl.registerRun({
      runId: run.id,
      sessionId: session.id,
      intent,
      context,
      expiresAt: Date.now() + (config.visualEvidence?.maxRunMs || 720_000),
      resetSide: async (side) => {
        const reset = await deps.environment.resetPair(config, pair);
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
          failurePhase = 'reset_pass_1';
          stage(failurePhase);
          const firstDeployment = await deps.environment.resetPair(config, pair);
          if (!sameProvenance(firstDeployment, expectedProvenance)) {
            throw new VisualEvidenceOrchestrationError('evidence_provenance_mismatch', 'Replay pass one did not use the prepared fixture and images.');
          }
          const firstStartedAt = Date.now();
          failurePhase = 'pass_1';
          stage(failurePhase);
          const first = await deps.replay.runPass(
            config,
            session.id,
            replayInput({ run, plan, deployment: firstDeployment, authTokens, provenance: expectedProvenance, pass: 1 }),
            { onEvent: (event) => {
              recordReplayEvent(event, 1);
            }, previewRunId: run.id }
          );
          metrics.replayPasses.push({
            attempt,
            pass: 1,
            durationMs: Math.max(0, Date.now() - firstStartedAt),
          });
          failurePhase = 'reset_pass_2';
          stage(failurePhase);
          const secondDeployment = await deps.environment.resetPair(config, pair);
          if (!sameProvenance(secondDeployment, expectedProvenance)) {
            throw new VisualEvidenceOrchestrationError('evidence_provenance_mismatch', 'Replay pass two did not use the prepared fixture and images.');
          }
          const secondStartedAt = Date.now();
          failurePhase = 'pass_2';
          stage(failurePhase);
          const second = await deps.replay.runPass(
            config,
            session.id,
            replayInput({ run, plan, deployment: secondDeployment, authTokens, provenance: expectedProvenance, pass: 2 }),
            { onEvent: (event) => {
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

    const dispatchOnce = async (forceBackend = null) => {
      if (agentWindowStartedAt == null) {
        agentWindowStartedAt = Date.now();
        agentWindowSuspendedAt = suspendedMs();
      }
      const dispatchStartedAt = Date.now();
      const suspendedAtStart = suspendedMs();
      metrics.agentAttempts += 1;
      const dispatchTrace = {
        requestedBackend: String(forceBackend || session.agent_backend || 'unknown').slice(0, 64),
        requestedModel: safeModelId(session.agent_model || session.model),
      };
      metrics.agentDispatches.push(dispatchTrace);
      try {
        // Provisioning and deterministic replay are platform work. Starting
        // this clock before the paired images/fixtures were ready spent the
        // agent's four minutes before it could even open its first page.
        const remainingAgentMs = agentBudgetMs
          - (Date.now() - agentWindowStartedAt
            - (suspendedMs() - agentWindowSuspendedAt));
        if (remainingAgentMs <= 0) {
          throw new VisualEvidenceOrchestrationError(
            'evidence_agent_timeout',
            'The preview agent used its bounded exploration time.'
          );
        }
        const dispatched = await deps.evidenceAgent.dispatch(config, {
          pool,
          session,
          runId: run.id,
          origins: exploration.origins,
          authTokens,
          onProgress: (line) => progress(`Evidence agent: ${line}`),
          resumeThreadId: agentThreadId,
          forceBackend,
          timeoutMs: remainingAgentMs,
          suspendedMs,
        }, injected.agentDependencies || {});
        addAgentUsage(metrics, dispatched);
        agentThreadId = dispatched.threadId || agentThreadId || null;
        dispatchTrace.backend = String(dispatched.backend || dispatchTrace.requestedBackend).slice(0, 64);
        dispatchTrace.model = safeModelId(dispatched.model);
        if (dispatched.fallbackReason) dispatchTrace.fallbackReason = String(dispatched.fallbackReason).slice(0, 64);
        dispatchTrace.outcome = 'completed';
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
          && session.agent_backend === 'codex_openrouter') {
        progress('The selected Codex model could not start the evidence flow; using the platform evidence planner…');
        agentOutcome = await dispatchOnce('claude_code');
      }
      if (agentOutcome.error && !latestHardVerdict) {
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
    log.warn('visual-evidence', 'Visual evidence run ended without captured evidence', {
      sessionId: session?.id || null,
      runId: run?.id || options.runId || null,
      code: errorCode(error),
      trace: failureTrace,
    });
    throw error;
  } finally {
    registration?.unregister();
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
  });
  // Attach a rejection observer now so fire-and-forget callers never create
  // an unhandled rejection; callers that need completion may still await the
  // original promise returned below.
  promise.catch(() => {});
  inFlight.set(key, promise);
  return { scheduled: true, runId: run.id, promise };
}

function inFlightSnapshot() {
  return [...inFlight.keys()];
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
  startRunHeartbeat,
  notifyEvidence,
  failCurrentRun,
  executeRun,
  scheduleForSession,
  noteNotStarted,
  NOT_STARTED_REASONS,
  inFlightSnapshot,
};
