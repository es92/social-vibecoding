const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const visuals = require('../src/services/visuals');
const config = { kubernetes: { captureImage: 'capture@sha256:abc', workerImage: 'worker@sha256:def',
  workerNamespace: 'workers', workerServiceAccount: 'worker' } };
const frame = '__USERNODE_TEST__ index=0 status=pass loadStatus=200\ne30=\n__USERNODE_TEST_END__\n';
const incomplete = '__USERNODE_TEST__ index=1 status=pass loadStatus=200\ne30=';
const flush = () => new Promise(setImmediate);

function setup(t, { status = { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] },
  output = frame + incomplete, reason = 'Error', logFailure = false, logStall = false, streamOutput = null } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const events = [];
  let polls = 0;
  kubernetes._setClientsForTest({
    batch: {
      createNamespacedJob: async () => ({}),
      readNamespacedJob: async () => ({ status: typeof status === 'function' ? status(++polls) : status }),
      deleteNamespacedJob: async () => { events.push('delete-job'); },
    },
    core: {
      createNamespacedSecret: async () => { events.push('create-secret'); },
      deleteNamespacedSecret: async () => { events.push('delete-secret'); },
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'capture-pod' }, status: {
        containerStatuses: [{ name: 'capture', state: { terminated: { reason, exitCode: reason === 'OOMKilled' ? 137 : 1 } } }],
      } }] }),
      readNamespacedPodLog: async () => {
        events.push('read-log');
        if (logStall) return new Promise(() => {});
        if (logFailure) throw new Error('log API unavailable');
        return output;
      },
    },
    ...(streamOutput === null ? {} : { logs: { log: async (_ns, _pod, _container, sink) => {
      sink.write(streamOutput);
      return { abort: () => events.push('abort-follow') };
    } } }),
  });
  t.after(() => kubernetes._setClientsForTest(null));
  return { events };
}

test('capture deadline salvages complete frames while missing checks remain an error', async (t) => {
  const shot = '__USERNODE_SHOT__ kind=after media=png status=200 bytes=3 index=0\nYWJj\n__USERNODE_SHOT_END__\n';
  const { events } = setup(t, { output: shot + frame + incomplete });
  const result = await kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, stdinPayload: '{}', salvagePartial: true });
  assert.equal(result.partial, true);
  assert.equal(result.partialReason, 'run timed out');
  const { shots } = visuals.parseShots(result.stdout);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].buf.toString(), 'abc', 'a completed artifact survives the Job failure');
  const parsed = visuals.parseTests(result.stdout);
  assert.equal(parsed.length, 1, 'the incomplete second frame must not be accepted');
  assert.equal(visuals.classifyTests(parsed, 2).state, 'error');
  assert.ok(events.includes('delete-secret'));
});

test('capture OOM retains emitted frames and identifies the interruption', async (t) => {
  setup(t, { status: { failed: 1 }, reason: 'OOMKilled' });
  const result = await kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, salvagePartial: true });
  assert.equal(result.partialReason, 'capture OOM killed');
  assert.equal(visuals.parseTests(result.stdout).length, 1);
});

test('client deadline reads output before deleting the Job and input Secret', async (t) => {
  const { events } = setup(t, { status: {} });
  const pending = kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, stdinPayload: '{}', timeoutMs: 1, salvagePartial: true });
  await flush();
  t.mock.timers.tick(16000);
  const result = await pending;
  assert.equal(result.partial, true);
  assert.equal(result.stdout, frame + incomplete);
  assert.ok(events.indexOf('read-log') < events.indexOf('delete-job'));
  assert.ok(events.indexOf('delete-job') < events.indexOf('delete-secret'));
});

test('already-followed frames survive when the final pod log cannot be read', async (t) => {
  const { events } = setup(t, { status: n => n < 2 ? {} : { succeeded: 1 }, logFailure: true, streamOutput: frame });
  const seen = [];
  const pending = kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, salvagePartial: true, onStdoutLine: line => seen.push(line) });
  await flush();
  t.mock.timers.tick(2000);
  const result = await pending;
  assert.equal(result.stdout, frame);
  assert.equal(result.partialReason, 'capture log unavailable');
  assert.equal(seen.filter(line => line.startsWith('__USERNODE_TEST__')).length, 1);
  assert.ok(events.includes('abort-follow'));
});

test('already-followed frames survive a successful empty final pod log read', async (t) => {
  const { events } = setup(t, {
    status: n => n < 2 ? {} : { succeeded: 1 },
    output: '',
    streamOutput: frame,
  });
  const seen = [];
  const pending = kubernetes.runCaptureJob(config, {
    sessionId: 42, env: {}, salvagePartial: true, onStdoutLine: line => seen.push(line),
  });
  await flush();
  t.mock.timers.tick(2000);
  const result = await pending;
  assert.equal(result.stdout, frame);
  assert.equal(result.partial, undefined, 'a successful Job with complete retained output stays successful');
  assert.equal(seen.filter(line => line.startsWith('__USERNODE_TEST__')).length, 1);
  assert.ok(events.includes('abort-follow'));
});

test('already-followed frames survive a successful shorter final pod log read', async (t) => {
  setup(t, {
    status: n => n < 2 ? {} : { succeeded: 1 },
    output: frame.slice(0, frame.indexOf('\n') + 1),
    streamOutput: frame,
  });
  const pending = kubernetes.runCaptureJob(config, {
    sessionId: 42, env: {}, salvagePartial: true,
  });
  await flush();
  t.mock.timers.tick(2000);
  const result = await pending;
  assert.equal(result.stdout, frame);
  assert.equal(visuals.parseTests(result.stdout).length, 1);
});

test('a stalled salvage read cannot block timed-out Job cleanup', async (t) => {
  const { events } = setup(t, { status: {}, logStall: true, streamOutput: frame });
  const pending = kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, stdinPayload: '{}', timeoutMs: 1, salvagePartial: true });
  await flush();
  t.mock.timers.tick(16000);
  await flush();
  assert.equal(events.includes('delete-job'), false, 'attempt the final read before removing the Pod');
  t.mock.timers.tick(15000);
  const result = await pending;
  assert.equal(result.stdout, frame);
  assert.equal(result.partial, true);
  assert.ok(events.includes('delete-job'));
  assert.ok(events.includes('delete-secret'));
});

test('capture output truncation is explicit and byte-bounded', async (t) => {
  setup(t, { status: { succeeded: 1 }, output: frame + '🚀'.repeat(20) });
  const maxBuffer = Buffer.byteLength(frame) + 3;
  const result = await kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, salvagePartial: true, maxBuffer });
  assert.equal(result.partialReason, 'output over maxBuffer');
  assert.ok(Buffer.byteLength(result.stdout) <= maxBuffer);
  assert.equal(result.stdout.includes('\uFFFD'), false, 'the byte cap never cuts a UTF-8 sequence');
  assert.equal(visuals.parseTests(result.stdout).length, 1);
});

for (const scenario of ['ordinary-failure', 'empty-output']) {
  test(`partial salvage returns runtime diagnostics for ${scenario}`, async (t) => {
    setup(t, { status: { failed: 1 }, reason: 'Error',
      ...(scenario === 'empty-output' ? { output: '' } : {}) });
    const result = await kubernetes.runCaptureJob(config, {
      sessionId: 42, env: {}, salvagePartial: true,
    });
    assert.equal(result.partial, true);
    assert.match(result.partialReason, /capture terminated/);
    assert.match(result.partialReason, /Error/);
    assert.equal(result.stderr, 'Error');
    if (scenario === 'empty-output') assert.equal(result.stdout, '');
  });
}

for (const scenario of ['opt-out', 'unit-suite']) {
  test(`partial salvage preserves throwing behavior for ${scenario}`, async (t) => {
    setup(t);
    const run = scenario === 'unit-suite' ? kubernetes.runUnitSuiteJob : kubernetes.runCaptureJob;
    await assert.rejects(run(config, { sessionId: 42, env: {}, salvagePartial: scenario !== 'opt-out' }), /Job .* failed/);
  });
}

test('two evidence passes in one run create distinct Jobs and input Secrets', async (t) => {
  const jobs = new Set();
  const secrets = new Set();
  const jobBodies = [];
  const secretNames = [];
  kubernetes._setClientsForTest({
    batch: {
      createNamespacedJob: async ({ body }) => {
        const name = body.metadata.name;
        if (jobs.has(name)) throw Object.assign(new Error('Job already exists'), { code: 409 });
        jobs.add(name);
        jobBodies.push(body);
        return { metadata: { uid: `uid-${jobs.size}` } };
      },
      readNamespacedJob: async () => ({ status: { succeeded: 1 } }),
    },
    core: {
      createNamespacedSecret: async ({ body }) => {
        const name = body.metadata.name;
        if (secrets.has(name)) throw Object.assign(new Error('Secret already exists'), { code: 409 });
        secrets.add(name);
        secretNames.push(name);
      },
      readNamespacedSecret: async () => ({ metadata: {} }),
      replaceNamespacedSecret: async () => ({}),
      deleteNamespacedSecret: async ({ name }) => { secrets.delete(name); },
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'evidence-pod' } }] }),
      readNamespacedPodLog: async () => 'evidence output\n',
    },
  });
  t.after(() => kubernetes._setClientsForTest(null));

  const options = {
    sessionId: 42, env: {}, stdinPayload: '{}', salvagePartial: true,
    previewRunId: 'a'.repeat(32),
  };
  const first = await kubernetes.runEvidenceJob(config, options);
  const second = await kubernetes.runEvidenceJob(config, options);
  assert.equal(first.stdout, 'evidence output\n');
  assert.equal(second.stdout, 'evidence output\n');
  assert.equal(jobBodies.length, 2);
  assert.notEqual(jobBodies[0].metadata.name, jobBodies[1].metadata.name);
  assert.equal(jobs.size, 2, 'the first finished Job remains while pass two starts');
  assert.deepEqual(jobBodies.map(body => body.metadata.labels['social.usernode.io/preview-run-id']),
    [options.previewRunId, options.previewRunId]);
  for (let index = 0; index < jobBodies.length; index += 1) {
    const jobName = jobBodies[index].metadata.name;
    assert.ok(jobName.startsWith('sv-evidence-s42-'));
    assert.ok(jobName.length <= 57);
    assert.equal(secretNames[index], `${jobName}-input`);
  }
});

test('a Kubernetes API conflict is reported as a launcher error, not a container exit', async (t) => {
  kubernetes._setClientsForTest({
    batch: {
      createNamespacedJob: async () => { throw Object.assign(new Error('Job already exists'), { code: 409 }); },
    },
    core: {
      createNamespacedSecret: async () => ({}),
      deleteNamespacedSecret: async () => ({}),
    },
  });
  t.after(() => kubernetes._setClientsForTest(null));

  await assert.rejects(kubernetes.runEvidenceJob(config, {
    sessionId: 42, env: {}, stdinPayload: '{}', salvagePartial: true,
    previewRunId: 'a'.repeat(32),
  }), (error) => {
    assert.equal(error.code, 409);
    assert.equal(error.message, 'Job already exists');
    return true;
  });
});
