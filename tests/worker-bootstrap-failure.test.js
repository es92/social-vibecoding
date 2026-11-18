// Bootstrap failures used to arrive as the two words "clone failed".
//
// Three production sessions on 2026-09-02 died 212-252ms after their
// container spawned, and every layer between git and the user threw the
// reason away: worker-run.sh merged git's stderr into stdout and `die`d with
// a fixed string, and `_awaitWarmReady` turned that marker straight into
// `new Error('clone failed')` with none of the preceding lines. The
// container that still held the answer in `docker logs` was reaped, unread,
// at the start of the next attempt. Two users then spent real budget chasing a GitHub auth problem
// that does not exist on this path (the worker clones anonymously and holds
// no credentials at all).
//
// These tests pin the four properties that fix is made of:
//   1. The failing command's output reaches the thrown Error, along with the
//      last phase the wrapper announced.
//   2. The rejection paths that carry NO detail of their own (the wrapper
//      dying, the warm-ready timeout) carry the log tail instead.
//   3. Transient failures retry, bounded; deterministic ones do not.
//   4. The diagnostics are non-enumerable, so every existing
//      `{ message, stack }` log line and `send('error', …)` payload is
//      byte-identical to before.
//
// Run with: node --test tests/worker-bootstrap-failure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'test-worker-secret';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Load worker.js against a fake docker + github + `docker logs -f`.
//
// `scripts` is one canned bootstrap-log script per attempt: an array of
// stdout lines, optionally ending the stream (`close`) rather than reaching
// warm-ready. The last script repeats if there are more attempts than
// scripts, which is what makes "fails every time" a one-element array.
function loadWorker({ scripts = [], repoPrivate = false, dockerLogs = '' } = {}) {
  const ids = {
    docker: require.resolve('../src/services/docker'),
    github: require.resolve('../src/services/github'),
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    childProcess: require.resolve('child_process'),
    subject: require.resolve('../src/services/worker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }) }) });

  const calls = [];
  const logs = [];
  const realDocker = require('../src/services/docker');
  stub(ids.docker, {
    ...realDocker,
    getContainerStatus: async () => 'not_found',
    getContainerLabels: async () => ({}),
    ensureVolume: async () => {},
    stopAndRemove: async (name) => { calls.push({ cmd: 'stopAndRemove', name }); },
    execFileAsync: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === 'logs' && args[1] === '--tail') {
        return { stdout: dockerLogs, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });
  stub(ids.github, {
    ...require('../src/services/github'),
    checkRepoPublic: async () => ({ ok: true, private: repoPrivate }),
    getCloneUrl: async () => 'https://github.com/owner/repo.git',
  });
  const record = (level) => (scope, msg, data) => logs.push({ level, scope, msg, data });
  stub(ids.logger, {
    info: record('info'), warn: record('warn'),
    error: record('error'), debug: record('debug'),
    redactString: require('../src/services/logger').redactString,
  });

  let spawnCount = 0;
  const realCp = require('child_process');
  stub(ids.childProcess, {
    ...realCp,
    spawn: () => {
      const script = scripts[Math.min(spawnCount, scripts.length - 1)] || { lines: [] };
      spawnCount += 1;
      const handlers = {};
      const proc = {
        stdout: { on: (ev, fn) => { if (ev === 'data') handlers.data = fn; } },
        stderr: { on: (ev, fn) => { if (ev === 'data') handlers.stderr = fn; } },
        on: (ev, fn) => { handlers[ev] = fn; },
        kill: () => {},
      };
      setImmediate(() => {
        if (script.lines?.length) handlers.data?.(Buffer.from(`${script.lines.join('\n')}\n`));
        if (script.stderr?.length) handlers.stderr?.(Buffer.from(`${script.stderr.join('\n')}\n`));
        if (script.close !== false) handlers.close?.(script.code ?? 1);
      });
      return proc;
    },
  });

  delete require.cache[ids.subject];
  const worker = require('../src/services/worker');
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k];
      else delete require.cache[id];
    }
    delete require.cache[require.resolve('../src/services/worker')];
  };
  return { worker, calls, logs, restore, spawns: () => spawnCount };
}

const ENSURE_ARGS = { repoOwner: 'owner', repoName: 'repo', branchName: 'dev/test' };

// A clone that failed the way the real ones did: git's stderr, folded onto
// the marker line by worker-run.sh's `clip`.
const CLONE_FAILURE = {
  lines: [
    '__USERNODE_PHASE__ seeded playwright mcp config',
    '__USERNODE_PHASE__ clone',
    "__USERNODE_ERROR__ clone failed: Cloning into '.'... | fatal: unable to access 'https://github.com/owner/repo.git/': Could not resolve host: github.com",
  ],
};

async function expectReject(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection, got none');
}

// ── 1. The reason survives all the way to the thrown Error ──────────────

test('a clone failure carries git\'s own words, the phase, and the log tail', async () => {
  const { worker, restore } = loadWorker({ scripts: [CLONE_FAILURE] });
  try {
    const err = await expectReject(() => worker.ensureWorker(1, ENSURE_ARGS));

    // The words a human needs. Before this change the whole message was the
    // eleven characters "clone failed".
    assert.match(err.message, /^clone failed: /);
    assert.match(err.message, /Could not resolve host: github\.com/);

    assert.equal(err.bootstrapPhase, 'clone', 'names how far bootstrap got');
    assert.equal(err.bootstrapContainerName, 'usernode-worker-1');
    assert.equal(err.bootstrapAttempts, 3, 'records how many attempts were spent');
  } finally { restore(); }
});

test('the wrapper dying with no marker at all still reports the container output', async () => {
  // The rejection path with NO detail of its own: `docker logs -f` closed
  // before warm-ready. Without the ring buffer this says only that bootstrap
  // did not finish.
  const { worker, restore } = loadWorker({
    scripts: [{
      lines: ['__USERNODE_PHASE__ clone'],
      stderr: ['error response from daemon: no space left on device'],
    }],
  });
  try {
    const err = await expectReject(() => worker.ensureWorker(2, ENSURE_ARGS));
    assert.match(err.message, /^warm wrapper exited before warm-ready/);
    assert.equal(err.bootstrapPhase, 'clone');
    assert.ok(
      err.bootstrapLog.some((l) => /no space left on device/.test(l)),
      `log tail should hold the container output, got ${JSON.stringify(err.bootstrapLog)}`,
    );
  } finally { restore(); }
});

test('diagnostics are non-enumerable, so existing error logging is unchanged', async () => {
  const { worker, restore } = loadWorker({ scripts: [CLONE_FAILURE] });
  try {
    const err = await expectReject(() => worker.ensureWorker(3, ENSURE_ARGS));
    // `log.error('sessions', 'Chat error', { message, stack })` and
    // `send('error', { error: err.message })` must serialize exactly as they
    // did before — a bootstrap log tail in an SSE frame would be a
    // regression, not a feature.
    assert.deepEqual(Object.keys(err), []);
    assert.equal(JSON.stringify({ ...err }), '{}');
    assert.ok(err.bootstrapLog, 'still readable by the code that wants it');
  } finally { restore(); }
});

// ── 2. The harvest happens before the corpse is reaped ──────────────────

test('the failing container\'s logs are read before the next attempt scrubs it', async () => {
  const { worker, calls, restore } = loadWorker({
    // No lines at all: nothing for the ring buffer to hold, so the harvest
    // is the only source of detail.
    scripts: [{ lines: [] }],
    dockerLogs: 'fatal: the remote end hung up unexpectedly\n',
  });
  try {
    await expectReject(() => worker.ensureWorker(4, ENSURE_ARGS));
    const order = calls
      .map((c) => (c.cmd === 'stopAndRemove' ? 'reap' : (c.args?.[0] === 'logs' && c.args?.[1] === '--tail' ? 'harvest' : null)))
      .filter(Boolean);
    // reap (attempt 1's defensive scrub) → harvest → reap → harvest → …
    // The invariant that matters: no harvest is preceded by its OWN reap.
    assert.equal(order[0], 'reap');
    assert.equal(order[1], 'harvest');
    assert.ok(order.filter((o) => o === 'harvest').length >= 1);
  } finally { restore(); }
});

// ── 3. Bounded retry of the transient, none of the deterministic ────────

test('a transient clone failure is retried, three attempts total', async () => {
  const { worker, restore, spawns } = loadWorker({ scripts: [CLONE_FAILURE] });
  try {
    const progress = [];
    await expectReject(() => worker.ensureWorker(5, { ...ENSURE_ARGS, onProgress: (t) => progress.push(t) }));
    assert.equal(spawns(), 3, 'BOOTSTRAP_MAX_ATTEMPTS attempts, no more');
    const retries = progress.filter((t) => t.startsWith('[retrying setup'));
    assert.equal(retries.length, 2, 'one user-visible retry line per retry');
    assert.equal(retries[0], '[retrying setup (attempt 2 of 3)]');
  } finally { restore(); }
});

test('a clone that succeeds on the second attempt returns a warm container', async () => {
  const { worker, restore, spawns } = loadWorker({
    scripts: [
      CLONE_FAILURE,
      { lines: ['__USERNODE_PHASE__ clone', '__USERNODE_PHASE__ warm-ready'], close: false },
    ],
  });
  try {
    const name = await worker.ensureWorker(6, ENSURE_ARGS);
    assert.equal(name, 'usernode-worker-6');
    assert.equal(spawns(), 2, 'stops retrying the moment it works');
  } finally { restore(); }
});

test('a checkout failure is NOT retried — the branch will not fix itself', async () => {
  const { worker, restore, spawns } = loadWorker({
    scripts: [{
      lines: [
        '__USERNODE_PHASE__ checkout',
        "__USERNODE_ERROR__ checkout failed: fatal: a branch named 'dev/test' already exists",
      ],
    }],
  });
  try {
    const err = await expectReject(() => worker.ensureWorker(7, ENSURE_ARGS));
    assert.match(err.message, /^checkout failed: /);
    assert.equal(spawns(), 1);
    assert.equal(err.bootstrapAttempts, 1);
    assert.ok(!worker.isRetryableBootstrapError(err));
  } finally { restore(); }
});

test('a private repo is refused once, before any container is spawned', async () => {
  const { worker, calls, restore, spawns } = loadWorker({ repoPrivate: true });
  try {
    const err = await expectReject(() => worker.ensureWorker(8, ENSURE_ARGS));
    assert.match(err.message, /repo is private/);
    assert.equal(spawns(), 0, 'never even started a container');
    assert.equal(calls.filter((c) => c.args?.[0] === 'run').length, 0);
    // Deterministic, so it is not retried.
    assert.ok(!worker.isRetryableBootstrapError(err));
  } finally { restore(); }
});

test('classification keys off the stable marker prefix, never git\'s wording', () => {
  const { worker, restore } = loadWorker();
  try {
    const { isRetryableBootstrapError: isRetry } = worker;
    // The whole point of slice 1 is that the text after the colon now VARIES.
    assert.ok(isRetry(new Error('clone failed: fatal: could not read Username')));
    assert.ok(isRetry(new Error('clone failed: fatal: Could not resolve host')));
    assert.ok(isRetry(new Error('clone failed: anything at all')));
    assert.ok(isRetry(new Error('warm-ready timeout for usernode-worker-9')));
    assert.ok(!isRetry(new Error('warm wrapper exited before warm-ready (code=1)')),
      'a wrapper that died structurally will die the same way again');
    assert.ok(!isRetry(new Error('boom')));
    assert.ok(!isRetry(null));
  } finally { restore(); }
});

// ── 4. Concurrent ensures still share one bootstrap ─────────────────────

test('concurrent ensures share a failed bootstrap and a later call can retry', async () => {
  const { worker, restore, spawns } = loadWorker({ scripts: [
    CLONE_FAILURE, CLONE_FAILURE, CLONE_FAILURE,
    { lines: ['__USERNODE_PHASE__ warm-ready'], close: false },
  ] });
  try {
    const first = worker.ensureWorker(10, ENSURE_ARGS);
    const second = worker.ensureWorker(10, ENSURE_ARGS);
    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'rejected');
    // Three attempts for the ONE coalesced bootstrap, not six: the retries
    // live INSIDE the shared promise, so a second caller adds no load and
    // gets the same error the first one did.
    assert.equal(spawns(), 3);
    assert.strictEqual(results[1].reason, results[0].reason);
    assert.match(results[1].reason.message, /^clone failed: /);
    assert.equal(await worker.ensureWorker(10, ENSURE_ARGS), 'usernode-worker-10');
    assert.equal(spawns(), 4, 'a later call starts fresh after the failed attempt is released');
  } finally { restore(); }
});

// ── 5. Kubernetes workers get the same bounded retry ────────────────────
//
// The Kubernetes path used to make exactly one attempt, so a single slow
// setup reached the user as "Setting up the coding agent timed out" while
// the Docker path would have quietly tried again.

function loadKubernetesWorker(outcomes) {
  const kubernetes = require('../src/services/kubernetes');
  const prevRuntime = process.env.WORKER_RUNTIME;
  process.env.WORKER_RUNTIME = 'kubernetes';
  const saved = {
    ensureWorker: kubernetes.ensureWorker, getWorkerStatus: kubernetes.getWorkerStatus,
    workerIdentity: kubernetes.workerIdentity, deleteWorkerIdentity: kubernetes.deleteWorkerIdentity,
    workerIdentityGone: kubernetes.workerIdentityGone,
  };
  const calls = [];
  const deleted = [];
  kubernetes.getWorkerStatus = async () => 'not_found';
  // A failed volume's heal (worker-volume-heal.js): the claim is the one
  // that failed, its delete is accepted and it is gone at once.
  kubernetes.workerIdentity = async () => ({ deployment: 'dep-uid', secret: 'sec-uid', pvc: 'claim-uid' });
  kubernetes.deleteWorkerIdentity = async (_config, sessionId, ids) => { deleted.push({ sessionId, ids }); };
  kubernetes.workerIdentityGone = async () => true;
  kubernetes.ensureWorker = async (_config, opts) => {
    calls.push({ timeoutMs: opts.timeoutMs, retryAttempt: opts.retryAttempt, avoidNodes: opts.avoidNodes || null });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    return { runtimeKind: 'kubernetes', runtimeName: `sv-worker-s${opts.sessionId}`, pvcName: null };
  };
  const loaded = loadWorker();
  require('../src/services/worker-volume-heal')._resetForTests();
  return {
    ...loaded,
    calls,
    deleted,
    restore: () => {
      Object.assign(kubernetes, saved);
      if (prevRuntime === undefined) delete process.env.WORKER_RUNTIME;
      else process.env.WORKER_RUNTIME = prevRuntime;
      loaded.restore();
    },
  };
}

function couldNotStart(reason) {
  const err = new Error('worker could not start (ImagePullBackOff)');
  Object.defineProperty(err, 'bootstrapReason', { value: reason });
  return err;
}

test('a Kubernetes warm-ready timeout is retried on a fresh Pod, then succeeds', async () => {
  const { worker, calls, restore } = loadKubernetesWorker([
    new Error('warm-ready timeout for sv-worker-s11'), 'ok',
  ]);
  try {
    const progress = [];
    await worker.ensureWorker(11, { ...ENSURE_ARGS, onProgress: (t) => progress.push(t) });
    assert.equal(calls.length, 2);
    // The first attempt applies the Deployment as a first dispatch would;
    // the retry stamps its attempt so the stuck Pod is replaced.
    assert.equal(calls[0].retryAttempt, null);
    assert.equal(calls[1].retryAttempt, 2);
    assert.equal(calls[1].timeoutMs, Math.round(calls[0].timeoutMs / 2), 'later attempts get half the budget');
    assert.deepEqual(progress, ['[retrying setup (attempt 2 of 3)]']);
  } finally { restore(); }
});

test('a Kubernetes warm-ready timeout gives up after three attempts', async () => {
  const { worker, calls, restore } = loadKubernetesWorker([new Error('warm-ready timeout for sv-worker-s12')]);
  try {
    const err = await expectReject(() => worker.ensureWorker(12, ENSURE_ARGS));
    assert.equal(calls.length, 3);
    assert.equal(err.bootstrapAttempts, 3);
  } finally { restore(); }
});

test('a Kubernetes worker that cannot start at all is not retried', async () => {
  const { worker, calls, restore } = loadKubernetesWorker([couldNotStart('image_unavailable')]);
  try {
    const err = await expectReject(() => worker.ensureWorker(13, ENSURE_ARGS));
    assert.equal(calls.length, 1);
    assert.equal(err.bootstrapReason, 'image_unavailable');
    assert.ok(!worker.isRetryableBootstrapError(err));
  } finally { restore(); }
});

// ── 6. A state volume that cannot be made or mounted ────────────────────
//
// 18 Nov 2026: every attempt reused the same broken claim on the same full
// node, so no retry could ever work. A claim that never held anything is
// deleted and the worker tried again off that node; one that may hold the
// agent's conversation is kept, and the setup stops at once.

const { VOLUME_FAILURE_TEXT } = require('../src/services/kubernetes-worker-bootstrap');

function volumeFailed(kind, { node = 'talos-ap6-6cz', bound = true } = {}) {
  const err = new Error(VOLUME_FAILURE_TEXT[kind]);
  Object.defineProperty(err, 'bootstrapReason', { value: `volume_${kind}_failed` });
  Object.defineProperty(err, 'volumeFailure', { value: {
    kind, reason: `volume_${kind}_failed`, node, claim: 'sv-worker-s14-state', claimUid: 'claim-uid',
    volume: bound ? 'pvc-7a1' : null, bound, message: 'kubelet words', count: 1,
  } });
  return err;
}

test('a volume that never held anything is deleted and the worker started again off its node', async () => {
  const { worker, calls, deleted, restore } = loadKubernetesWorker([volumeFailed('format'), 'ok']);
  try {
    const progress = [];
    await worker.ensureWorker(14, { ...ENSURE_ARGS, onProgress: (t) => progress.push(t) });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].avoidNodes, null, 'a first attempt is placed as it always was');
    assert.deepEqual(calls[1].avoidNodes, ['talos-ap6-6cz']);
    assert.deepEqual(deleted, [{ sessionId: 14, ids: { deployment: 'dep-uid', secret: 'sec-uid', pvc: 'claim-uid' } }]);
    assert.deepEqual(progress, ['[retrying setup (attempt 2 of 3)]']);
  } finally { restore(); }
});

test('a volume that may hold state is kept, and the setup stops at once with the reason in words', async () => {
  const { worker, calls, deleted, logs, restore } = loadKubernetesWorker([volumeFailed('mount')]);
  try {
    const err = await expectReject(() => worker.ensureWorker(15, ENSURE_ARGS));
    assert.equal(calls.length, 1, 'the same claim on the same node would fail the same way');
    assert.deepEqual(deleted, []);
    assert.equal(err.message, 'This change’s worker couldn’t start: its disk volume failed to mount.');
    assert.equal(err.volumeHeal.why, 'may_hold_state');
    assert.ok(!worker.isRetryableBootstrapError(err));
    assert.ok(!worker.isTransientStartError(err));
    assert.equal(worker.workerStartReason(err), err.message);
    const failed = logs.find((l) => l.msg === 'Bootstrap failed');
    assert.deepEqual([failed.data.node, failed.data.claim, failed.data.volumeHeal], ['talos-ap6-6cz', 'sv-worker-s14-state', 'report:may_hold_state']);
  } finally { restore(); }
});

test('a healed volume that fails on every node in turn gives up after three attempts, still worth a later try', async () => {
  const { worker, calls, restore } = loadKubernetesWorker([
    volumeFailed('provision', { node: 'n1', bound: false }), volumeFailed('format', { node: 'n2' }), volumeFailed('format', { node: 'n3' }),
  ]);
  try {
    const err = await expectReject(() => worker.ensureWorker(16, ENSURE_ARGS));
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.avoidNodes), [null, ['n1'], ['n1', 'n2']]);
    assert.equal(err.message, VOLUME_FAILURE_TEXT.format);
    assert.ok(worker.isTransientStartError(err), 'its claim was deleted: a later setup starts fresh');
  } finally { restore(); }
});

test('why a worker could not start, in words, for every kind of start failure', () => {
  const { worker, restore } = loadWorker();
  try {
    const typed = (reason) => Object.defineProperty(new Error('worker could not start (x)'), 'bootstrapReason', { value: reason });
    assert.equal(worker.workerStartReason(typed('volume_provision_failed')), VOLUME_FAILURE_TEXT.provision);
    assert.equal(worker.workerStartReason(typed('image_unavailable')), 'This change’s worker couldn’t start: its software couldn’t be downloaded.');
    assert.equal(worker.workerStartReason(typed('unschedulable')), 'This change’s worker couldn’t start: no machine had room for it.');
    assert.equal(worker.workerStartReason(new Error('warm-ready timeout for sv-worker-s1')), 'This change’s worker didn’t finish starting in time.');
    assert.match(worker.workerStartReason(new Error('clone failed: fatal: unable to access')), /couldn’t download the project’s code/);
    for (const error of [null, new Error('checkout failed: branch missing'), new Error('Image build failed'), { code: 'shots_agent_failed' }]) {
      assert.equal(worker.workerStartReason(error), null);
      assert.equal(worker.isWorkerStartFailure(error), false);
    }
  } finally { restore(); }
});
