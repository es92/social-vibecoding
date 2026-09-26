'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const replay = require('../src/services/visual-evidence-replay');
const kubernetes = require('../src/services/kubernetes');
const runner = require('../evidence/replay-runner');

const event = (value) => `${replay.EVENT_PREFIX}${JSON.stringify(value)}`;
function artifact(overrides = {}) {
  const data = overrides.buffer || Buffer.from('png fixture');
  return {
    runId: 'a'.repeat(32), pass: 2, storyId: 'dialog', viewport: 'desktop',
    side: 'base', variant: 'focus', media: 'png', contentType: 'image/png',
    width: 100, height: 80, focusRect: { x: 1, y: 2, width: 50, height: 40 },
    bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'),
    data: data.toString('base64'),
    ...overrides,
  };
}
const artifactLine = (value) => `${replay.ARTIFACT_PREFIX}${JSON.stringify(value)}`;

test('protocol parser admits digest-checked bounded artifacts and one result', () => {
  const png = artifact();
  const parsed = replay.parseReplayOutput([
    event({ type: 'started', pass: 2 }),
    artifactLine(png),
    event({ type: 'result', runId: 'a'.repeat(32), pass: 2, passed: true, planHash: 'b'.repeat(64), stories: [], artifactCount: 1 }),
  ].join('\n'));
  assert.equal(parsed.artifacts.length, 1);
  assert.deepEqual(parsed.artifacts[0].data, Buffer.from('png fixture'));
  assert.equal(parsed.events[0].type, 'started');
});

test('protocol parser rejects malformed, mismatched, duplicate, and failed-result output', () => {
  assert.throws(() => replay.parseReplayOutput('noise'), { code: 'missing_replay_result' });
  assert.throws(() => replay.parseReplayOutput(`${replay.EVENT_PREFIX}{bad`), { code: 'invalid_replay_output' });
  assert.throws(() => replay.parseReplayOutput([
    artifactLine(artifact({ sha256: '0'.repeat(64) })),
    event({ type: 'result', runId: 'a'.repeat(32), pass: 2, passed: true, planHash: 'b'.repeat(64), stories: [], artifactCount: 1 }),
  ].join('\n')), { code: 'artifact_digest_mismatch' });
  assert.throws(() => replay.parseReplayOutput([
    event({ type: 'result', runId: 'a'.repeat(32), pass: 2, passed: true, planHash: 'b'.repeat(64), stories: [], artifactCount: 0 }),
    event({ type: 'result', runId: 'a'.repeat(32), pass: 2, passed: true, planHash: 'b'.repeat(64), stories: [], artifactCount: 0 }),
  ].join('\n')), { code: 'duplicate_replay_result' });
  assert.throws(() => replay.parseReplayOutput([
    artifactLine(artifact()),
    event({ type: 'result', runId: 'a'.repeat(32), pass: 2, passed: false, code: 'assertion_failed', artifactCount: 1 }),
  ].join('\n')), { code: 'failed_replay_has_artifacts' });
  assert.throws(() => replay.parseReplayOutput(
    event({ type: 'result', runId: 'a'.repeat(32), pass: 2, passed: true, planHash: 'b'.repeat(64), stories: [], artifactCount: 0 }),
    { planHash: 'c'.repeat(64) },
  ), { code: 'replay_plan_hash_mismatch' });
});

test('a partial browser job keeps its termination reason and last checkpoint', async (t) => {
  const saved = kubernetes.runEvidenceJob;
  kubernetes.runEvidenceJob = async () => ({
    stdout: [
      event({ type: 'viewport_started', runId: 'a'.repeat(32), pass: 1,
        storyId: 'invite-suggestions', viewport: 'desktop' }),
      event({ type: 'action_started', runId: 'a'.repeat(32), pass: 1,
        storyId: 'invite-suggestions', viewport: 'desktop', side: 'head', actionId: 'open-settings' }),
    ].join('\n'),
    partial: true, partialReason: 'capture OOM killed',
  });
  t.after(() => { kubernetes.runEvidenceJob = saved; });
  await assert.rejects(replay.runPass({ captureRuntime: 'kubernetes' }, 42, {
    runId: 'a'.repeat(32), pass: 1, plan: require('./fixtures/visual-evidence').plan(),
  }), (error) => {
    assert.equal(error.code, 'missing_replay_result');
    assert.deepEqual(error.detail.execution, {
      partial: true, partialReason: 'capture OOM killed',
      lastEvent: { type: 'action_started', storyId: 'invite-suggestions', viewport: 'desktop', side: 'head', actionId: 'open-settings' },
    });
    return true;
  });
});

test('Kubernetes streams action and failure events into the live diagnostics callback', async (t) => {
  const saved = kubernetes.runEvidenceJob;
  const action = event({ type: 'action_started', runId: 'a'.repeat(32), pass: 1,
    storyId: 'invite-suggestions', viewport: 'desktop', side: 'head', actionId: 'open-settings' });
  const failure = event({ type: 'result', runId: 'a'.repeat(32), pass: 1,
    passed: false, code: 'locator_not_found', message: 'Control was missing.' });
  kubernetes.runEvidenceJob = async (_config, options) => {
    options.onStdoutLine(action);
    options.onStdoutLine(failure);
    return { stdout: [action, failure].join('\n') };
  };
  t.after(() => { kubernetes.runEvidenceJob = saved; });
  const observed = [];
  await assert.rejects(replay.runPass({ captureRuntime: 'kubernetes' }, 42, {
    runId: 'a'.repeat(32), pass: 1, plan: require('./fixtures/visual-evidence').plan(),
  }, { onEvent: (item) => observed.push(item) }), { code: 'locator_not_found' });
  assert.deepEqual(observed.map((item) => item.type), ['action_started', 'result']);
  assert.equal(observed[0].actionId, 'open-settings');
});

test('each story and viewport runs after a fresh paired fixture reset', async () => {
  const plan = require('./fixtures/visual-evidence').plan();
  plan.stories[0].viewports.push({ name: 'mobile', width: 390, height: 844 });
  const planHash = require('../src/services/visual-evidence-plan').planHash(plan);
  const runId = 'a'.repeat(32);
  let settingEnabled = true;
  let resets = 0;
  const selected = [];
  const result = await replay.runPassCases({}, 42,
    { runId, pass: 1, plan, publishArtifacts: false }, {
      prepareCase: async (item) => {
        settingEnabled = false;
        resets += 1;
        selected.push(`${item.storyId}/${item.viewport}`);
        return { origins: { base: 'http://base:3000', head: 'http://head:3000' } };
      },
      runCase: async (_config, _sessionId, input) => {
        assert.equal(settingEnabled, false, 'the preceding viewport must not change this fixture');
        assert.equal(input.plan.stories[0].viewports.length, 2, 'each job carries the full hashed plan');
        settingEnabled = true;
        return {
          result: { passed: true, runId, pass: 1, planHash,
            provenance: { fixtureFingerprint: 'same-pair' },
            stories: [{ id: input.selection.storyId, viewport: input.selection.viewport }] },
          artifacts: [], events: [],
        };
      },
    });
  assert.equal(resets, 2);
  assert.deepEqual(selected, ['invite-suggestions/desktop', 'invite-suggestions/mobile']);
  assert.deepEqual(result.result.stories.map((item) => item.viewport), ['desktop', 'mobile']);
  assert.equal(result.result.planHash, planHash);
});

test('an isolated case cannot return another viewport or fixture identity', async () => {
  const plan = require('./fixtures/visual-evidence').plan();
  const runId = 'a'.repeat(32);
  const planHash = require('../src/services/visual-evidence-plan').planHash(plan);
  await assert.rejects(replay.runPassCases({}, 42, {
    runId, pass: 1, plan, publishArtifacts: false,
    provenance: { fixtureFingerprint: 'expected' },
  }, {
    prepareCase: async () => ({ origins: { base: 'http://base:3000', head: 'http://head:3000' } }),
    runCase: async () => ({
      result: { passed: true, runId, pass: 1, planHash,
        provenance: { fixtureFingerprint: 'changed' },
        stories: [{ id: 'invite-suggestions', viewport: 'desktop' }] },
      artifacts: [],
    }),
  }), { code: 'isolated_replay_mismatch' });
});

test('a browser job launcher error keeps its original code with bounded runtime context', async (t) => {
  const saved = kubernetes.runEvidenceJob;
  const launchError = Object.assign(new Error('Job timed out at http://internal/?token=secret.jwt'), {
    code: 'ETIMEDOUT', killed: true,
  });
  kubernetes.runEvidenceJob = async () => { throw launchError; };
  t.after(() => { kubernetes.runEvidenceJob = saved; });
  await assert.rejects(replay.runPass({ captureRuntime: 'kubernetes' }, 42, {
    runId: 'a'.repeat(32), pass: 1, plan: require('./fixtures/visual-evidence').plan(),
  }), (error) => {
    assert.equal(error, launchError);
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.detail.runtime.killed, true);
    assert.doesNotMatch(error.detail.runtime.reason, /secret\.jwt/);
    return true;
  });
});

test('artifact variants and media types cannot be relabelled', () => {
  assert.throws(() => replay.validateArtifact(artifact({ variant: 'animation', side: 'base' })), { code: 'invalid_artifact' });
  assert.throws(() => replay.validateArtifact(artifact({ media: 'webm', contentType: 'video/webm' })), { code: 'invalid_artifact' });
  assert.throws(() => replay.validateArtifact(artifact({ storyId: '../escape' })), { code: 'invalid_artifact' });
});

function pass({ planHash = 'a'.repeat(64), base = 'base', head = 'head', artifacts = true } = {}) {
  return {
    result: {
      passed: true, planHash, runId: 'a'.repeat(32), pass: 1,
      stories: [{
        id: 'dialog', viewport: 'desktop',
        base: { fingerprint: base, path: '/dialog', contextHash: '0'.repeat(16), focusHash: '1'.repeat(16) },
        head: { fingerprint: head, path: '/dialog', contextHash: '2'.repeat(16), focusHash: '3'.repeat(16) },
      }],
    },
    artifacts: artifacts ? [{ storyId: 'dialog' }] : [],
  };
}

test('two clean passes must agree before evidence is reproducible', () => {
  const second = (options = {}) => {
    const value = pass(options);
    value.result.pass = 2;
    return value;
  };
  assert.equal(replay.comparePasses(pass(), second()).passed, true);
  assert.deepEqual(replay.comparePasses(pass(), second({ head: 'different' })), {
    passed: false, code: 'non_reproducible', reason: 'The two clean replay passes reached different checkpoints.',
    detail: { storyId: 'dialog', viewport: 'desktop', side: 'head', field: 'fingerprint', first: 'head', second: 'different' },
  });
  assert.equal(replay.comparePasses(pass(), second({ planHash: 'b'.repeat(64) })).code, 'plan_hash_changed');
  assert.equal(replay.comparePasses(pass(), second(), { plan: require('./fixtures/visual-evidence').plan() }).code, 'plan_hash_mismatch');
  assert.equal(replay.comparePasses(pass(), second({ artifacts: false })).code, 'missing_artifacts');
});

test('runner-normalized optional provenance matches the exact submitted fixture', () => {
  const submitted = {
    baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40), fixtureFingerprint: 'paired-fixture',
    baseImageDigest: 'sha256:base', headImageDigest: 'sha256:head',
  };
  const normalized = runner.validateInput({
    runId: 'a'.repeat(32), pass: 1,
    origins: { base: 'http://base:3000', head: 'http://head:3000' },
    authTokens: {
      member: 'fixture-member', read_only_admin: 'fixture-admin', full_admin: 'fixture-full-admin',
    },
    provenance: submitted,
    plan: require('./fixtures/visual-evidence').plan(),
  }).provenance;
  assert.equal(normalized.hostedAssetRevision, null);
  const first = pass();
  const second = pass();
  first.result.provenance = normalized;
  second.result.provenance = normalized;
  second.result.pass = 2;
  assert.equal(replay.comparePasses(first, second, { provenance: submitted }).passed, true);
  second.result.provenance = { ...normalized, headImageDigest: 'sha256:other' };
  assert.equal(replay.comparePasses(first, second, { provenance: submitted }).code, 'provenance_changed');
});

test('a passing replay must cover every declared story, viewport, and requested artifact exactly', () => {
  const plan = require('./fixtures/visual-evidence').plan();
  const planHash = require('../src/services/visual-evidence-plan').planHash(plan);
  const stories = [{
    id: 'invite-suggestions', viewport: 'desktop',
    base: { fingerprint: 'base', path: '/lists/demo', contextHash: '0'.repeat(16), focusHash: '1'.repeat(16) },
    head: { fingerprint: 'head', path: '/lists/demo', contextHash: '2'.repeat(16), focusHash: '3'.repeat(16) },
  }];
  const artifacts = [
    ['base', 'focus', 'png'], ['base', 'context', 'png'],
    ['head', 'focus', 'png'], ['head', 'context', 'png'],
    ['paired', 'animation', 'webm'],
  ].map(([side, variant, media]) => ({
    storyId: 'invite-suggestions', viewport: 'desktop', side, variant, media,
  }));
  const first = { result: { passed: true, planHash, runId: 'a'.repeat(32), pass: 1, stories }, artifacts: [] };
  const second = { result: { passed: true, planHash, runId: 'a'.repeat(32), pass: 2, stories }, artifacts };
  assert.equal(replay.comparePasses(first, second, { plan }).passed, true);
  const diagnosticImages = artifacts.filter((item) => item.media === 'png');
  assert.equal(replay.comparePasses({ ...first, artifacts: diagnosticImages }, second, { plan }).passed, true);
  assert.equal(replay.comparePasses({ ...first, artifacts }, second, { plan }).code,
    'incomplete_replay_coverage', 'pass one cannot claim an animation as a diagnostic image');
  assert.equal(replay.comparePasses(first, { ...second, artifacts: artifacts.slice(1) }, { plan }).code,
    'incomplete_replay_coverage');
  assert.equal(replay.comparePasses({ ...first, artifacts: [artifacts[0]] }, second, { plan }).code,
    'incomplete_replay_coverage');
});

test('mismatched comparison stores only four private images behind the current run fence', async () => {
  const data = Buffer.from('diagnostic image');
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  const items = (pass) => ['focus', 'context'].map((variant) => ({
    pass, storyId: 'dialog', viewport: 'desktop', side: 'head', variant,
    media: 'png', width: 100, height: 80, sha256: digest, data,
  }));
  const writes = [];
  let current = true;
  const pool = { query: async (sql, values) => {
    if (String(sql).includes('FROM visual_evidence_runs')) return { rowCount: current ? 1 : 0 };
    writes.push({ sql: String(sql), values });
    return { rowCount: 1 };
  } };
  const args = {
    headSha: 'b'.repeat(40), planHash: 'c'.repeat(64), attempt: 1,
    comparison: { storyId: 'dialog', viewport: 'desktop', side: 'head' },
  };
  assert.equal(await replay.storeDiagnosticArtifacts(pool, 'a'.repeat(32), items(1), items(2), args), 4);
  assert.equal(writes.filter((item) => item.sql.includes('INSERT INTO visual_evidence_diagnostic_artifacts')).length, 4);
  assert.deepEqual(writes.filter((item) => item.sql.includes('INSERT INTO visual_evidence_diagnostic_artifacts'))
    .map((item) => item.values[3]), [1, 1, 2, 2]);
  current = false;
  await assert.rejects(replay.storeDiagnosticArtifacts(pool, 'a'.repeat(32), items(1), items(2), args),
    { code: 'stale_evidence_operation' });
  await assert.rejects(replay.storeDiagnosticArtifacts(pool, 'a'.repeat(32), [], items(2), args),
    { code: 'missing_diagnostic_artifact' });
});

test('Kubernetes exposes a separate evidence command rather than changing legacy capture', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/services/kubernetes'), 'utf8');
  assert.match(source, /async function runEvidenceJob/);
  assert.match(source, /exec node \/app\/evidence-replay\.js/);
  assert.match(source, /exec node \/app\/capture\.js/);
  assert.match(source, /if \(inputSecretName && createdJob\?\.metadata\?\.uid\)/);
  const launcher = fs.readFileSync(require.resolve('../src/services/visual-evidence-replay'), 'utf8');
  assert.match(launcher, /runEvidenceJob[\s\S]*salvagePartial: true/);
});

test('replay authentication is appended by the platform and redacted from provenance', () => {
  const authorized = runner.authorizedUrl('http://base.internal:3000', '/dialog?fixture=1#open', 'secret.jwt');
  const parsed = new URL(authorized);
  assert.equal(parsed.searchParams.get('fixture'), '1');
  assert.equal(parsed.searchParams.get('token'), 'secret.jwt');
  assert.equal(runner.publicRelativePath(authorized), '/dialog?fixture=1#open');
  assert.doesNotMatch(runner.redactedUrl(authorized), /secret\.jwt/);
  assert.match(runner.redactedUrl(authorized), /%5Bredacted%5D/);
});
