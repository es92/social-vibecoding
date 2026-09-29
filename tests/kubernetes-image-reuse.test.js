const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveImage, isTransientRegistryError } = require('../scripts/resolve-kubernetes-image');

const digest = `sha256:${'a'.repeat(64)}`;
const manifest = { digest, manifests: [{
  digest: `sha256:${'b'.repeat(64)}`,
  platform: { os: 'linux', architecture: 'amd64' },
}] };

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-image-reuse-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  const write = (file, contents) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), contents);
  };
  for (const file of ['worker/Dockerfile', 'worker/worker-run.sh', 'capture/Dockerfile',
    'capture/capture.js', 'evidence/hosted-app-fixture.js', 'src/services/visual-evidence-plan.js',
    '.github/workflows/build-kubernetes-images.yml',
    'scripts/resolve-kubernetes-image.js', 'frontend/ui.js']) write(file, `original ${file}\n`);
  // Real Git trees, without commits or user Git signing hooks/configuration.
  const revision = () => { git('add', '.'); return git('write-tree'); };
  return { cwd, git, write, revision };
}

// `retry` collects the resolver's retry behaviour: every registry lookup, the
// delay before each retry and the warning it printed. Tests that do not care
// omit it; the sleep is always a no-op so a retrying test does not wait.
function resolve(repo, options = {}, inspect = () => JSON.stringify(manifest), retry = null) {
  return resolveImage({
    component: 'worker', owner: 'Usernode-Labs', revision: repo.revision(),
    ref: 'refs/heads/main', claudeCodeVersion: '2.1.251', ...options,
  }, {
    cwd: repo.cwd,
    run(file, args) {
      if (file === 'git') return repo.git(...args);
      assert.equal(file, 'docker');
      assert.deepEqual(args.slice(0, 3), ['buildx', 'imagetools', 'inspect']);
      assert.deepEqual(args.slice(4), ['--format', '{{json .Manifest}}']);
      if (retry) retry.lookups += 1;
      return inspect(args[3]);
    },
    sleep(ms) { if (retry) retry.delays.push(ms); },
    warn(message) { if (retry) retry.warnings.push(message); },
  });
}

function retryLog() {
  return { lookups: 0, delays: [], warnings: [] };
}

function registryError(stderr) {
  return Object.assign(new Error(`Command failed: docker buildx imagetools inspect\n${stderr}`), { stderr });
}

// The exact failure that skipped #2589's release.
const CONNECTION_RESET = 'ERROR: failed to copy: httpReadSeeker: failed open: failed to do request: '
  + 'Get "https://pkg-containers.githubusercontent.com/ghcrblobs07/blobs/sha256:603f39f2": '
  + 'read tcp 10.1.0.217:39248->185.199.110.154:443: read: connection reset by peer';

test('unchanged component reuses the index digest across unrelated source changes', t => {
  const repo = repository(t);
  const first = resolve(repo);
  repo.write('frontend/ui.js', 'changed UI\n');
  const next = resolve(repo);
  assert.equal(next.reuse_tag, first.reuse_tag);
  assert.equal(next.digest, digest); // Index digest, not its child image digest.
  assert.equal(next.image, 'ghcr.io/usernode-labs/social-vibecoding-worker');
  assert.equal(next.reason, 'matching-build-inputs');
});

test('all component inputs invalidate reuse, including modes, removals and Docker ignore rules', t => {
  const repo = repository(t);
  let previous = resolve(repo).reuse_tag;
  const changes = [
    () => repo.write('worker/worker-run.sh', 'new runtime behavior\n'),
    () => fs.chmodSync(path.join(repo.cwd, 'worker/worker-run.sh'), 0o755),
    () => repo.write('worker/Dockerfile', 'FROM new-base\n'),
    () => repo.write('worker/.dockerignore', '*.log\n'),
    () => repo.write('worker/new-dependency.lock', 'version=2\n'),
    () => fs.unlinkSync(path.join(repo.cwd, 'worker/new-dependency.lock')),
  ];
  for (const change of changes) {
    change();
    const next = resolve(repo).reuse_tag;
    assert.notEqual(next, previous);
    previous = next;
  }
});

test('worker and capture inputs are independent', t => {
  const repo = repository(t);
  const worker = resolve(repo).reuse_tag;
  let capture = resolve(repo, { component: 'capture' }).reuse_tag;
  for (const file of ['capture/capture.js', 'evidence/hosted-app-fixture.js']) {
    repo.write(file, `new ${file} behavior\n`);
    const next = resolve(repo, { component: 'capture' }).reuse_tag;
    assert.equal(resolve(repo).reuse_tag, worker);
    assert.notEqual(next, capture);
    capture = next;
  }
  // The capture image no longer carries the replay runner or the evidence
  // declaration schema, so a change to that schema rebuilds neither image.
  repo.write('src/services/visual-evidence-plan.js', 'new declaration schema\n');
  assert.equal(resolve(repo, { component: 'capture' }).reuse_tag, capture);
  assert.equal(resolve(repo).reuse_tag, worker);
});

test('the resolved Claude Code version invalidates only the worker image', t => {
  const repo = repository(t);
  const worker = resolve(repo, { claudeCodeVersion: '2.1.251' }).reuse_tag;
  const capture = resolve(repo, {
    component: 'capture', claudeCodeVersion: '2.1.251',
  }).reuse_tag;

  assert.notEqual(
    resolve(repo, { claudeCodeVersion: '2.1.272' }).reuse_tag,
    worker,
  );
  assert.equal(resolve(repo, {
    component: 'capture', claudeCodeVersion: '2.1.272',
  }).reuse_tag, capture);
});

test('workflow and resolver changes invalidate both reusable components', t => {
  const repo = repository(t);
  for (const file of ['.github/workflows/build-kubernetes-images.yml', 'scripts/resolve-kubernetes-image.js']) {
    const before = ['worker', 'capture'].map(component => resolve(repo, { component }).reuse_tag);
    repo.write(file, 'changed build recipe\n');
    for (const [index, component] of ['worker', 'capture'].entries()) {
      assert.notEqual(resolve(repo, { component }).reuse_tag, before[index]);
    }
  }
});

test('candidate branches cannot supply the stable reuse key', t => {
  const repo = repository(t);
  assert.notEqual(resolve(repo).reuse_tag, resolve(repo, { ref: 'refs/heads/feat/k8s' }).reuse_tag);
});

test('platform always builds without consulting the reuse registry', t => {
  const repo = repository(t);
  for (const forceRebuild of ['none', 'worker', 'capture', 'all']) {
    const result = resolve(repo, { component: 'platform', forceRebuild }, () => assert.fail('unexpected lookup'));
    assert.equal(result.digest, '');
    assert.equal(result.reuse_tag, '');
    assert.equal(result.refresh, String(forceRebuild === 'all'));
  }
});

test('a scheduled dependency refresh reuses the platform image for the exact source revision', t => {
  const repo = repository(t);
  let inspectedTag;
  const result = resolve(repo, {
    component: 'platform', reuseCurrentPlatform: true,
  }, tag => {
    inspectedTag = tag;
    return JSON.stringify(manifest);
  });
  assert.match(inspectedTag,
    /^ghcr\.io\/usernode-labs\/social-vibecoding-platform:sha-[a-f0-9]{40}$/);
  assert.equal(result.reuse_tag, inspectedTag);
  assert.equal(result.digest, digest);
  assert.equal(result.refresh, 'false');
  assert.equal(result.reason, 'current-source-release');
});

test('a scheduled dependency refresh fails closed when its platform release is missing', t => {
  const repo = repository(t);
  assert.throws(() => resolve(repo, {
    component: 'platform', reuseCurrentPlatform: true,
  }, () => {
    throw Object.assign(new Error('missing'), { stderr: 'manifest unknown' });
  }), /Current platform image is missing/);
  assert.throws(() => resolve(repo, {
    component: 'platform', reuseCurrentPlatform: true, forceRebuild: 'all',
  }), /cannot force-rebuild the platform/);
});

test('manual refresh bypasses reuse only for selected components', t => {
  const repo = repository(t);
  for (const component of ['worker', 'capture']) {
    for (const forceRebuild of [component, 'all']) {
      const result = resolve(repo, { component, forceRebuild }, () => assert.fail('unexpected lookup'));
      assert.equal(result.digest, '');
      assert.equal(result.refresh, 'true');
      assert.equal(result.reason, 'forced-refresh');
      assert.match(result.reuse_tag, /:inputs-[a-f0-9]{64}$/);
    }
    const result = resolve(repo, { component, forceRebuild: component === 'worker' ? 'capture' : 'worker' });
    assert.equal(result.digest, digest);
    assert.equal(result.refresh, 'false');
  }
});

test('missing or deleted images rebuild without returning a digest', t => {
  const repo = repository(t);
  for (const stderr of ['ERROR: image: not found', 'manifest unknown', 'unexpected status: 404 Not Found']) {
    const result = resolve(repo, {}, () => { throw Object.assign(new Error('inspect failed'), { stderr }); });
    assert.equal(result.digest, '');
    assert.equal(result.reason, 'image-not-found');
    assert.equal(result.refresh, 'false');
  }
});

test('registry authentication and transport failures stop release resolution', t => {
  const repo = repository(t);
  for (const stderr of ['401 Unauthorized', '403 Forbidden', '429 Too Many Requests', 'TLS handshake timeout']) {
    assert.throws(() => resolve(repo, {}, () => {
      throw Object.assign(new Error(stderr), { stderr });
    }), new RegExp(stderr));
  }
});

test('a dropped registry connection is retried and the reused digest still resolves', t => {
  const repo = repository(t);
  const retry = retryLog();
  let failuresLeft = 2;
  const result = resolve(repo, {}, () => {
    if (failuresLeft-- > 0) throw registryError(CONNECTION_RESET);
    return JSON.stringify(manifest);
  }, retry);
  assert.equal(result.digest, digest);
  assert.equal(result.reason, 'matching-build-inputs');
  assert.equal(retry.lookups, 3);
  assert.deepEqual(retry.delays, [2000, 4000]); // Backs off; never sleeps after the last attempt.
  assert.equal(retry.warnings.length, 2);
  assert.match(retry.warnings[0], /attempt 1\/3.*retrying in 2000ms.*connection reset by peer/);
  assert.match(retry.warnings[0], /^ghcr\.io\/usernode-labs\/social-vibecoding-worker:inputs-/);
});

test('a registry that keeps failing exhausts three attempts and then fails the release', t => {
  const repo = repository(t);
  for (const stderr of [CONNECTION_RESET, '429 Too Many Requests', 'TLS handshake timeout',
    'unexpected status: 503 Service Unavailable', 'dial tcp: lookup ghcr.io: no such host']) {
    const retry = retryLog();
    assert.throws(() => resolve(repo, {}, () => { throw registryError(stderr); }, retry),
      error => error.stderr === stderr);
    assert.equal(retry.lookups, 3, stderr);
    assert.deepEqual(retry.delays, [2000, 4000], stderr);
  }
  // execFileSync's own deadline, which arrives as a code rather than as stderr.
  const retry = retryLog();
  assert.throws(() => resolve(repo, {}, () => {
    throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT', stderr: '' });
  }, retry), /ETIMEDOUT/);
  assert.equal(retry.lookups, 3);
});

test('authentication failures and cache misses are not retried', t => {
  const repo = repository(t);
  for (const stderr of ['401 Unauthorized', '403 Forbidden', 'denied: permission_denied']) {
    const retry = retryLog();
    assert.throws(() => resolve(repo, {}, () => { throw registryError(stderr); }, retry), new RegExp(stderr));
    assert.equal(retry.lookups, 1, stderr);
    assert.deepEqual(retry.delays, [], stderr);
  }
  const retry = retryLog();
  const result = resolve(repo, {}, () => { throw registryError('manifest unknown'); }, retry);
  assert.equal(result.reason, 'image-not-found');
  assert.equal(retry.lookups, 1);
  assert.deepEqual(retry.delays, []);
});

test('a transient error on a later attempt still counts against the same budget', t => {
  const repo = repository(t);
  const retry = retryLog();
  const failures = [CONNECTION_RESET, '401 Unauthorized'];
  assert.throws(() => resolve(repo, {}, () => { throw registryError(failures.shift()); }, retry),
    /401 Unauthorized/);
  // Retried the reset once, then stopped at the deterministic failure.
  assert.equal(retry.lookups, 2);
  assert.deepEqual(retry.delays, [2000]);
});

test('transient registry errors are recognised by what the registry client says', () => {
  for (const transient of [CONNECTION_RESET, 'connection refused', 'write: broken pipe',
    'unexpected EOF', 'i/o timeout', 'TLS handshake timeout', 'context deadline exceeded (Client.Timeout)',
    'lookup ghcr.io: no such host', 'lookup ghcr.io: server misbehaving',
    'unexpected status: 429 Too Many Requests', 'unexpected status: 502 Bad Gateway',
    'unexpected status code 503', 'received unexpected HTTP status: 500 Internal Server Error']) {
    assert.equal(isTransientRegistryError(registryError(transient)), true, transient);
  }
  assert.equal(isTransientRegistryError({ code: 'ETIMEDOUT' }), true);
  for (const deterministic of ['401 Unauthorized', '403 Forbidden', 'denied: permission_denied',
    'unexpected status: 400 Bad Request', 'manifest unknown', 'not found',
    'invalid reference format', '']) {
    assert.equal(isTransientRegistryError(registryError(deterministic)), false, deterministic);
  }
  // A digest or a URL that happens to contain three digits is not a status code.
  assert.equal(isTransientRegistryError(registryError(
    'ERROR: blobs/sha256:603f39f28e36ae7e13d3ae817d27aa5722275ab0927c12196fda0c282275946b: denied')), false);
  assert.equal(isTransientRegistryError(null), false);
});

test('invalid registry responses and incompatible platforms cannot become release digests', t => {
  const repo = repository(t);
  for (const response of ['not JSON', '{}', JSON.stringify({ ...manifest, digest: 'latest' }),
    JSON.stringify({ digest, manifests: [{ platform: { os: 'linux', architecture: 'arm64' } }] })]) {
    assert.throws(() => resolve(repo, {}, () => response));
  }
});

test('invalid workflow inputs fail before consulting the registry', t => {
  const repo = repository(t);
  for (const options of [{ component: '../worker' }, { revision: 'main' }, { owner: 'owner\ninjected=x' },
    { ref: 'refs/tags/v1' }, { forceRebuild: 'yes' }, { claudeCodeVersion: undefined },
    { claudeCodeVersion: '' },
    { claudeCodeVersion: 'latest' }, { claudeCodeVersion: '2.1.251; echo unsafe' },
    { reuseCurrentPlatform: true }]) {
    assert.throws(() => resolve(repo, options, () => assert.fail('unexpected lookup')));
  }
});

test('workflow CLI writes a reused digest to GitHub outputs without building', t => {
  const repo = repository(t);
  repo.write('bin/docker', `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(manifest)}'\n`);
  fs.chmodSync(path.join(repo.cwd, 'bin/docker'), 0o755);
  const output = path.join(repo.cwd, 'github-output');
  execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/resolve-kubernetes-image.js')], {
    cwd: repo.cwd, encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(repo.cwd, 'bin')}:${process.env.PATH}`,
      COMPONENT: 'worker', GITHUB_REPOSITORY_OWNER: 'Usernode-Labs', GITHUB_SHA: repo.revision(),
      GITHUB_REF: 'refs/heads/main', FORCE_REBUILD: 'none', CLAUDE_CODE_VERSION: '2.1.272',
      GITHUB_OUTPUT: output },
  });
  const values = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
  assert.equal(values.digest, digest);
  assert.equal(values.refresh, 'false');
  assert.equal(values.reason, 'matching-build-inputs');
  assert.match(values.reuse_tag, /^ghcr\.io\/usernode-labs\/social-vibecoding-worker:inputs-[a-f0-9]{64}$/);
});
