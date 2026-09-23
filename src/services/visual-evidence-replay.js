'use strict';

// #2380 — platform-side launcher/parser for the deterministic evidence
// runtime. The browser process emits an explicit JSON-line protocol. Binary
// data is admitted only after metadata, digest, count and per-media caps pass.

const crypto = require('crypto');
const docker = require('./docker');
const kubernetes = require('./kubernetes');
const planContract = require('./visual-evidence-plan');

const EVENT_PREFIX = '__USERNODE_EVIDENCE__ ';
const ARTIFACT_PREFIX = '__USERNODE_EVIDENCE_ARTIFACT__ ';
const MAX_ARTIFACTS = planContract.MAX_STORIES * planContract.MAX_VIEWPORTS * 5;
const MAX_BYTES = Object.freeze({ png: 8 * 1024 * 1024, webm: 6 * 1024 * 1024, gif: 4 * 1024 * 1024 });
const CONTENT_TYPES = Object.freeze({ png: 'image/png', webm: 'video/webm', gif: 'image/gif' });
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

class EvidenceReplayError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'EvidenceReplayError';
    this.code = code;
    this.detail = detail;
  }
}

function parseJsonLine(line, prefix) {
  try { return JSON.parse(line.slice(prefix.length)); }
  catch { throw new EvidenceReplayError('invalid_replay_output', 'Evidence replay emitted malformed JSON.'); }
}

function validateArtifact(frame) {
  if (!frame || typeof frame !== 'object') throw new EvidenceReplayError('invalid_artifact', 'Evidence artifact frame is missing.');
  if (!/^[0-9a-f]{32}$/.test(String(frame.runId || '')) || ![1, 2].includes(Number(frame.pass))) {
    throw new EvidenceReplayError('invalid_artifact', 'Evidence artifact has an invalid run or pass identity.');
  }
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,94}[a-z0-9])?$/.test(String(frame.storyId || ''))) {
    throw new EvidenceReplayError('invalid_artifact', 'Evidence artifact has an invalid story id.');
  }
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/.test(String(frame.viewport || ''))) {
    throw new EvidenceReplayError('invalid_artifact', 'Evidence artifact has an invalid viewport.');
  }
  if (!['base', 'head', 'paired'].includes(frame.side)
      || !['focus', 'context', 'animation'].includes(frame.variant)
      || !Object.hasOwn(MAX_BYTES, frame.media)
      || frame.contentType !== CONTENT_TYPES[frame.media]) {
    throw new EvidenceReplayError('invalid_artifact', 'Evidence artifact metadata is inconsistent.');
  }
  if (typeof frame.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) {
    throw new EvidenceReplayError('invalid_artifact', 'Evidence artifact payload is not base64.');
  }
  const data = Buffer.from(frame.data, 'base64');
  if (data.length !== Number(frame.bytes) || data.length > MAX_BYTES[frame.media]) {
    throw new EvidenceReplayError('artifact_over_cap', `${frame.media} evidence artifact is missing, truncated, or over its size cap.`, {
      declared: frame.bytes, actual: data.length, cap: MAX_BYTES[frame.media],
    });
  }
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  if (digest !== frame.sha256) throw new EvidenceReplayError('artifact_digest_mismatch', 'Evidence artifact digest does not match its bytes.');
  if (frame.variant === 'animation' && (frame.side !== 'paired' || frame.media === 'png')) {
    throw new EvidenceReplayError('invalid_artifact', 'Animations must be paired encoded media.');
  }
  if (frame.variant !== 'animation' && frame.media !== 'png') {
    throw new EvidenceReplayError('invalid_artifact', 'Focused and context evidence must be PNG.');
  }
  return {
    runId: String(frame.runId || ''),
    pass: Number(frame.pass),
    storyId: frame.storyId,
    viewport: frame.viewport,
    side: frame.side,
    variant: frame.variant,
    media: frame.media,
    contentType: frame.contentType,
    width: Number.isInteger(frame.width) && frame.width > 0 ? frame.width : null,
    height: Number.isInteger(frame.height) && frame.height > 0 ? frame.height : null,
    bytes: data.length,
    focusRect: frame.focusRect && typeof frame.focusRect === 'object' ? frame.focusRect : null,
    stageLabels: Array.isArray(frame.stageLabels) ? frame.stageLabels.slice(0, 50).map((value) => String(value).slice(0, 200)) : null,
    sha256: digest,
    data,
  };
}

function parseReplayOutput(stdout, expected = {}) {
  const events = [];
  const artifacts = [];
  let result = null;
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith(EVENT_PREFIX)) {
      const event = parseJsonLine(line, EVENT_PREFIX);
      if (event?.type === 'result') {
        if (result) throw new EvidenceReplayError('duplicate_replay_result', 'Evidence replay emitted more than one result.');
        result = event;
      } else events.push(event);
    } else if (line.startsWith(ARTIFACT_PREFIX)) {
      if (artifacts.length >= MAX_ARTIFACTS) throw new EvidenceReplayError('artifact_count_over_cap', 'Evidence replay emitted too many artifacts.');
      artifacts.push(validateArtifact(parseJsonLine(line, ARTIFACT_PREFIX)));
    }
  }
  if (!result) throw new EvidenceReplayError('missing_replay_result', 'Evidence replay ended without a verdict.');
  if (!/^[0-9a-f]{32}$/.test(String(result.runId || '')) || ![1, 2].includes(Number(result.pass))) {
    throw new EvidenceReplayError('invalid_replay_result', 'Evidence replay omitted its run or pass identity.');
  }
  const expectedRunId = expected.runId == null ? null : String(expected.runId);
  const expectedPass = expected.pass == null ? null : Number(expected.pass);
  if (expectedRunId && result.runId !== expectedRunId) {
    throw new EvidenceReplayError('replay_identity_mismatch', 'Evidence replay returned a different run id.');
  }
  if (expectedPass != null && result.pass !== expectedPass) {
    throw new EvidenceReplayError('replay_identity_mismatch', 'Evidence replay returned a different pass number.');
  }
  for (const artifact of artifacts) {
    if ((expectedRunId && artifact.runId !== expectedRunId)
        || (expectedPass != null && artifact.pass !== expectedPass)) {
      throw new EvidenceReplayError('artifact_identity_mismatch', 'Evidence artifact belongs to a different run or pass.');
    }
  }
  if (result.passed !== true && artifacts.length) {
    throw new EvidenceReplayError('failed_replay_has_artifacts', 'A failed replay cannot publish evidence artifacts.');
  }
  if (result.passed === true) {
    if (!/^[0-9a-f]{64}$/.test(String(result.planHash || ''))) {
      throw new EvidenceReplayError('invalid_replay_result', 'Passing replay omitted its plan hash.');
    }
    if (expected.planHash != null && result.planHash !== String(expected.planHash)) {
      throw new EvidenceReplayError('replay_plan_hash_mismatch', 'Evidence replay did not execute the submitted replay plan.');
    }
    if (!Array.isArray(result.stories)) throw new EvidenceReplayError('invalid_replay_result', 'Passing replay omitted story results.');
    if (Number(result.artifactCount || 0) !== artifacts.length) {
      throw new EvidenceReplayError('artifact_count_mismatch', 'Evidence artifact count does not match the replay verdict.');
    }
  }
  return { result, events, artifacts };
}

function executionDetail(execution) {
  const detail = {};
  if (execution?.partial === true) detail.partial = true;
  if (execution?.partialReason) detail.partialReason = String(execution.partialReason).slice(0, 300);
  if (Number.isInteger(execution?.exitCode)) detail.exitCode = execution.exitCode;
  const stdout = String(execution?.stdout || '');
  let cursor = stdout.length;
  for (let inspected = 0; inspected < 24 && cursor > 0; inspected += 1) {
    const start = stdout.lastIndexOf(EVENT_PREFIX, cursor - 1);
    if (start < 0) break;
    const end = stdout.indexOf('\n', start);
    try {
      const event = JSON.parse(stdout.slice(start + EVENT_PREFIX.length, end < 0 ? undefined : end));
      if (/^(?:started|browser_launch_started|browser_launch_completed|scratch_context_started|scratch_context_ready|viewport_started|viewport_finished|side_started|side_finished|side_failed|session_bootstrap|navigation_started|navigation_completed|action_started|action_completed|assertion_started|assertion_completed|animation_started|animation_completed)$/.test(event?.type || '')) {
        detail.lastEvent = {
          type: event.type,
          ...(typeof event.storyId === 'string' ? { storyId: event.storyId.slice(0, 96) } : {}),
          ...(typeof event.viewport === 'string' ? { viewport: event.viewport.slice(0, 32) } : {}),
          ...(['base', 'head'].includes(event.side) ? { side: event.side } : {}),
          ...(typeof event.actionId === 'string' ? { actionId: event.actionId.slice(0, 96) } : {}),
          ...(typeof event.phase === 'string' ? { phase: event.phase.slice(0, 40) } : {}),
          ...(Number.isInteger(event.assertionIndex) ? { assertionIndex: event.assertionIndex } : {}),
        };
        break;
      }
    } catch { /* a malformed line is reported by the protocol parser */ }
    cursor = start;
  }
  return detail;
}

function runtimeReason(error) {
  return String(error?.message || '').replace(/\s+/g, ' ')
    .replace(/(\b(?:token|access_token|auth|authorization|password|secret|api[_-]?key|code|session)\s*=\s*)[^&\s"'<>)]*/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:sk-(?:proj-)?|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{16,}\b/gi, '[redacted]')
    .slice(0, 300);
}

function withRuntimeDetail(error) {
  if (error && typeof error === 'object') {
    error.detail = {
      ...(error.detail && typeof error.detail === 'object' ? error.detail : {}),
      runtime: {
        code: String(error.code || 'unknown').slice(0, 80),
        reason: runtimeReason(error),
        killed: error.killed === true,
      },
      ...(error.stdout ? { execution: executionDetail(error) } : {}),
    };
  }
  return error;
}

function comparableStories(value) {
  return (value || []).map((story) => ({
    id: story?.id,
    viewport: story?.viewport,
    base: {
      fingerprint: story?.base?.fingerprint, path: story?.base?.path,
      contextHash: story?.base?.contextHash, focusHash: story?.base?.focusHash,
    },
    head: {
      fingerprint: story?.head?.fingerprint, path: story?.head?.path,
      contextHash: story?.head?.contextHash, focusHash: story?.head?.focusHash,
    },
  }));
}

function expectedCoverage(plan) {
  const parsed = planContract.parseReplayPlan(plan);
  return parsed.stories.flatMap((story) => story.viewports.map((viewport) => ({
    storyId: story.id,
    viewport: viewport.name,
    animation: story.replay.checkpoint.animation,
  })));
}

function hasExactCoverage(stories, artifacts, plan, { publishArtifacts = true } = {}) {
  const expected = expectedCoverage(plan);
  const storyKeys = (stories || []).map((story) => `${story.id}\u0000${story.viewport}`);
  const expectedStoryKeys = expected.map((item) => `${item.storyId}\u0000${item.viewport}`);
  if (storyKeys.length !== expectedStoryKeys.length
      || new Set(storyKeys).size !== storyKeys.length
      || expectedStoryKeys.some((key) => !storyKeys.includes(key))) return false;
  if (!publishArtifacts) return !artifacts?.length;

  const expectedArtifacts = [];
  for (const item of expected) {
    for (const side of ['base', 'head']) {
      for (const variant of ['focus', 'context']) {
        expectedArtifacts.push(`${item.storyId}\u0000${item.viewport}\u0000${side}\u0000${variant}\u0000png`);
      }
    }
    if (item.animation !== 'none') {
      expectedArtifacts.push(`${item.storyId}\u0000${item.viewport}\u0000paired\u0000animation\u0000webm`);
    }
  }
  const artifactKeys = (artifacts || []).map((artifact) =>
    `${artifact.storyId}\u0000${artifact.viewport}\u0000${artifact.side}\u0000${artifact.variant}\u0000${artifact.media}`);
  return artifactKeys.length === expectedArtifacts.length
    && new Set(artifactKeys).size === artifactKeys.length
    && expectedArtifacts.every((key) => artifactKeys.includes(key));
}

function hammingHex(left, right) {
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (bits) { distance += Number(bits & 1n); bits >>= 1n; }
  return distance;
}

function reproducibilityDifference(leftStories, rightStories) {
  if (leftStories.length !== rightStories.length) return {
    field: 'storyCount', firstCount: leftStories.length, secondCount: rightStories.length,
  };
  for (let index = 0; index < leftStories.length; index += 1) {
    const left = leftStories[index];
    const right = rightStories[index];
    if (left.id !== right.id || left.viewport !== right.viewport) return {
      field: 'storyIdentity', index,
      first: { storyId: left.id, viewport: left.viewport },
      second: { storyId: right.id, viewport: right.viewport },
    };
    for (const side of ['base', 'head']) {
      const at = { storyId: left.id, viewport: left.viewport, side };
      if (left[side].fingerprint !== right[side].fingerprint) return {
        ...at, field: 'fingerprint',
        first: left[side].fingerprint, second: right[side].fingerprint,
      };
      if (left[side].path !== right[side].path) return { ...at, field: 'path' };
      for (const hash of ['contextHash', 'focusHash']) {
        if (!/^[0-9a-f]{16}$/.test(String(left[side][hash] || ''))
            || !/^[0-9a-f]{16}$/.test(String(right[side][hash] || ''))) return { ...at, field: hash, invalidHash: true };
        const distance = hammingHex(left[side][hash], right[side][hash]);
        if (distance > 2) return { ...at, field: hash, hammingDistance: distance };
      }
    }
  }
  return null;
}

function reproducibleStories(leftStories, rightStories) {
  return reproducibilityDifference(leftStories, rightStories) == null;
}

// The browser runner emits every known provenance field, representing an
// absent optional hosted asset revision as null. The orchestrator may omit
// that field entirely. Compare the same explicit shape on both sides so this
// harmless normalization cannot reject every otherwise valid replay.
function comparableProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    baseSha: value.baseSha,
    headSha: value.headSha,
    fixtureFingerprint: value.fixtureFingerprint,
    baseImageDigest: value.baseImageDigest || null,
    headImageDigest: value.headImageDigest || null,
    hostedAssetRevision: value.hostedAssetRevision || null,
  };
}

function comparePasses(first, second, { plan = null, provenance = null, runId = null } = {}) {
  if (first?.result?.passed !== true || second?.result?.passed !== true) {
    return { passed: false, code: 'replay_failed', reason: 'Both clean replay passes must succeed.' };
  }
  if (first.result.planHash !== second.result.planHash) {
    return { passed: false, code: 'plan_hash_changed', reason: 'The replay plan changed between clean passes.' };
  }
  if (plan && first.result.planHash !== planContract.planHash(plan)) {
    return { passed: false, code: 'plan_hash_mismatch', reason: 'The clean replay passes did not execute the submitted replay plan.' };
  }
  if (plan && (!hasExactCoverage(first.result.stories, first.artifacts, plan, { publishArtifacts: false })
      || !hasExactCoverage(second.result.stories, second.artifacts, plan))) {
    return {
      passed: false,
      code: 'incomplete_replay_coverage',
      reason: 'The replay did not produce the exact declared story, viewport, and artifact set.',
    };
  }
  if (runId && (first.result.runId !== runId || second.result.runId !== runId)) {
    return { passed: false, code: 'run_identity_changed', reason: 'The clean replay passes do not belong to this evidence run.' };
  }
  if (first.result.pass !== 1 || second.result.pass !== 2) {
    return { passed: false, code: 'pass_identity_changed', reason: 'The clean replay passes were not executed in the required order.' };
  }
  if (provenance) {
    const expected = JSON.stringify(comparableProvenance(provenance));
    if (JSON.stringify(comparableProvenance(first.result.provenance)) !== expected
        || JSON.stringify(comparableProvenance(second.result.provenance)) !== expected) {
      return { passed: false, code: 'provenance_changed', reason: 'The clean replay provenance changed between passes.' };
    }
  }
  const left = comparableStories(first.result.stories);
  const right = comparableStories(second.result.stories);
  const difference = reproducibilityDifference(left, right);
  if (difference) {
    return { passed: false, code: 'non_reproducible', reason: 'The two clean replay passes reached different checkpoints.', detail: difference };
  }
  if (!second.artifacts.length) {
    return { passed: false, code: 'missing_artifacts', reason: 'The reproducible pass produced no review artifacts.' };
  }
  return {
    passed: true,
    planHash: second.result.planHash,
    runs: 2,
    relativePointer: plan ? planContract.containsRelativePointer(plan) : false,
    stories: comparableStories(second.result.stories),
  };
}

function runtimeMode(config) {
  return config?.captureRuntime || process.env.CAPTURE_RUNTIME || config?.appRuntime || 'docker';
}

async function runPass(config, sessionId, input, { signal = null, onEvent = null, previewRunId = null } = {}) {
  const payload = JSON.stringify(input);
  const onStdoutLine = typeof onEvent === 'function' ? (line) => {
    if (!line.startsWith(EVENT_PREFIX)) return;
    try { onEvent(parseJsonLine(line, EVENT_PREFIX)); } catch { /* final parser owns validity */ }
  } : null;
  let execution;
  if (runtimeMode(config) === 'kubernetes') {
    try {
      execution = await kubernetes.runEvidenceJob(config, {
        sessionId, stdinPayload: payload,
        timeoutMs: config.visualEvidence?.maxRunMs || 720_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        salvagePartial: true,
        onStdoutLine, signal, previewRunId,
      });
    } catch (error) {
      throw withRuntimeDetail(error);
    }
  } else {
    await require('./visuals').ensureCaptureImage();
    try {
      execution = await docker.runOneShot(`usernode-evidence-${sessionId}-${input.pass}`, {
        image: require('./visuals').CAPTURE_IMAGE,
        stdinPayload: payload,
        cmd: ['node', '/app/evidence-replay.js'],
        memory: '6g', cpus: '8', timeoutMs: config.visualEvidence?.maxRunMs || 720_000,
        maxBuffer: MAX_OUTPUT_BYTES, onStdoutLine,
      });
    } catch (err) {
      if (!err.stdout) {
        throw withRuntimeDetail(err);
      }
      execution = { stdout: err.stdout, stderr: err.stderr || '', exitCode: err.code };
    }
  }
  let parsed;
  try {
    parsed = parseReplayOutput(execution.stdout, {
      runId: input.runId,
      pass: input.pass,
      planHash: planContract.planHash(input.plan),
    });
  } catch (error) {
    throw new EvidenceReplayError(error?.code || 'invalid_replay_output', error?.message || 'Evidence replay output is invalid.', {
      ...(error?.detail && typeof error.detail === 'object' ? error.detail : {}),
      execution: executionDetail(execution),
    });
  }
  if (parsed.result.passed !== true) {
    throw new EvidenceReplayError(parsed.result.code || 'replay_failed', parsed.result.message || 'Evidence replay failed.', {
      ...(parsed.result.detail && typeof parsed.result.detail === 'object' ? parsed.result.detail : {}),
      execution: executionDetail(execution),
    });
  }
  return parsed;
}

async function storeArtifacts(pool, runId, artifacts, { headSha, planHash } = {}) {
  if (!/^[0-9a-f]{32}$/.test(String(runId || ''))) throw new EvidenceReplayError('invalid_run_id', 'Invalid evidence run id.');
  if (!/^[0-9a-f]{40}$/.test(String(headSha || '')) || !/^[0-9a-f]{64}$/.test(String(planHash || ''))) {
    throw new EvidenceReplayError('invalid_artifact_fence', 'Artifact storage requires the exact head SHA and replay plan hash.');
  }
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    if (client !== pool) await client.query('BEGIN');
    const selected = await client.query(
      `SELECT r.id
         FROM visual_evidence_runs r
         JOIN chat_sessions s ON s.id = r.session_id
        WHERE r.id = $1 AND r.head_sha = $2 AND r.plan_hash = $3
          AND r.state = 'reviewing'
          AND s.visual_evidence_run_id = r.id
          AND s.visual_evidence_state = 'reviewing'
        FOR UPDATE`,
      [runId, headSha, planHash]
    );
    if (!selected.rowCount) {
      throw new EvidenceReplayError(
        'stale_evidence_operation',
        'This replay no longer owns the proposal evidence slot; its artifacts were discarded.'
      );
    }
    await client.query('DELETE FROM visual_evidence_artifacts WHERE run_id = $1', [runId]);
    for (const artifact of artifacts) {
      await client.query(
        `INSERT INTO visual_evidence_artifacts
           (id, run_id, story_id, viewport, side, variant, media, content_type,
            data, width, height, bytes, sha256, focus_rect, stage_labels)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)`,
        [crypto.randomBytes(16).toString('hex'), runId, artifact.storyId, artifact.viewport,
         artifact.side, artifact.variant, artifact.media, artifact.contentType, artifact.data,
         artifact.width, artifact.height, artifact.bytes, artifact.sha256,
         artifact.focusRect ? JSON.stringify(artifact.focusRect) : null,
         artifact.stageLabels ? JSON.stringify(artifact.stageLabels) : null]
      );
    }
    if (client !== pool) await client.query('COMMIT');
  } catch (err) {
    if (client !== pool) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { if (client !== pool) client.release(); }
  return artifacts.length;
}

module.exports = {
  EVENT_PREFIX,
  ARTIFACT_PREFIX,
  MAX_ARTIFACTS,
  MAX_BYTES,
  MAX_OUTPUT_BYTES,
  EvidenceReplayError,
  validateArtifact,
  parseReplayOutput,
  comparePasses,
  comparableProvenance,
  reproducibleStories,
  runPass,
  storeArtifacts,
};
