'use strict';

// A worker whose state volume cannot be created or mounted fails its setup
// within seconds, heals a claim that never held anything, keeps and reports
// one that may, and tells infra about a node that keeps failing volumes.
//
// 18 Nov 2026: node talos-ap6-6cz's 1 GiB OpenEBS LVM thin pool was 91% full.
// New worker volumes there failed to format, then on every mount, or never
// provisioned, and the platform recreated the same Pods on the same claims
// for 35 minutes, each setup waiting out its whole warm-ready timeout.
//
// Run with: node --test tests/worker-volume-failure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const bootstrap = require('../src/services/kubernetes-worker-bootstrap');
const heal = require('../src/services/worker-volume-heal');
const signals = require('../src/services/platform-signals');
const kubernetes = require('../src/services/kubernetes');

const flush = () => new Promise(setImmediate);

// The kubelet's and the provisioner's own words, as they were that day.
const FORMAT_MESSAGE = 'MountVolume.SetUp failed for volume "pvc-7a1" : rpc error: code = Internal desc = failed to format and mount '
  + 'the volume as xfs: format of disk "/dev/openebs-vg/pvc-7a1" failed: type:("xfs") target:("/var/lib/kubelet/pods/x/volumes/'
  + 'kubernetes.io~csi/pvc-7a1/mount") options:("rw") errcode:(exit status 1) output:(mkfs.xfs: libxfs_device_zero write failed: '
  + 'No space left on device)';
const MOUNT_MESSAGE = 'MountVolume.SetUp failed for volume "pvc-7a1" : rpc error: code = Internal desc = mount failed: exit status 32 '
  + 'Mounting command: mount Mounting arguments: -t xfs -o rw /dev/openebs-vg/pvc-7a1 /var/lib/kubelet/pods/x/mount '
  + 'Output: mount: /var/lib/kubelet/pods/x/mount: fsconfig() failed: Structure needs cleaning.';
const PROVISION_MESSAGE = 'failed to provision volume with StorageClass "openebs-lvm": rpc error: code = ResourceExhausted '
  + 'desc = lvcreate -T openebs-vg/thinpool -V 1Gi -n pvc-9b2 failed - exit status 5';

const warning = (reason, message, extra = {}) => ({ type: 'Warning', reason, message, count: 1, ...extra });

// ── Which events are a volume that will not come ─────────────────────────

test('format, mount and provisioning failures are read off the event; transient ones are not', () => {
  assert.equal(bootstrap.classifyVolumeEvent(warning('FailedMount', FORMAT_MESSAGE)), 'format',
    'a format failure is read as one, though its sentence also says "mount"');
  assert.equal(bootstrap.classifyVolumeEvent(warning('FailedMount', MOUNT_MESSAGE)), 'mount');
  assert.equal(bootstrap.classifyVolumeEvent(warning('ProvisioningFailed', PROVISION_MESSAGE)), 'provision');

  for (const event of [
    // The kubelet's summary of a mount still in progress, and a CSI driver
    // that has not registered yet: both clear by waiting.
    warning('FailedMount', 'Unable to attach or mount volumes: unmounted volumes=[state], unattached volumes=[state]: timed out waiting for the condition'),
    warning('FailedMount', 'MountVolume.MountDevice failed for volume "pvc-7a1" : kubernetes.io/csi: attacher.MountDevice failed to create newCsiDriverClient: driver name local.csi.openebs.io not found in the list of registered CSI drivers'),
    // A provisioner call that timed out is tried again by the provisioner.
    warning('ProvisioningFailed', 'failed to provision volume with StorageClass "openebs-lvm": rpc error: code = DeadlineExceeded desc = context deadline exceeded'),
    warning('ProvisioningFailed', 'failed to provision volume with StorageClass "openebs-lvm": rpc error: code = Unavailable desc = connection refused'),
    // Not a warning, or not about a volume.
    { type: 'Normal', reason: 'WaitForFirstConsumer', message: 'waiting for first consumer to be created before binding' },
    { type: 'Normal', reason: 'FailedMount', message: MOUNT_MESSAGE },
    warning('BackOff', 'Back-off restarting failed container'),
    null,
  ]) {
    assert.equal(bootstrap.classifyVolumeEvent(event), null, JSON.stringify(event));
  }
});

test('a volume failure reads as the worker not starting, in words, and is a platform fault', () => {
  for (const [kind, reason] of Object.entries(bootstrap.VOLUME_FAILURE_REASONS)) {
    assert.match(bootstrap.VOLUME_FAILURE_TEXT[kind], /^This change’s worker couldn’t start: its disk volume /);
    assert.equal(bootstrap.VOLUME_FAILURE_TEXT_BY_REASON[reason], bootstrap.VOLUME_FAILURE_TEXT[kind]);
  }
  assert.equal(bootstrap.VOLUME_FAILURE_TEXT.mount, 'This change’s worker couldn’t start: its disk volume failed to mount.');
  assert.equal(bootstrap.VOLUME_FAILURE_TEXT.provision, 'This change’s worker couldn’t start: its disk volume couldn’t be created.');
});

// ── The setup wait fails within seconds ─────────────────────────────────

const OPTIONS = { namespace: 'workers', name: 'sv-worker-s13913', imageRef: 'worker@sha256:abc', environmentChecksum: 'env', generation: 2,
  claimName: 'sv-worker-s13913-state' };

// A Pod placed on the node, its container never started (ContainerCreating),
// its claim bound or not, and the events Kubernetes keeps for both.
function fixture({ bound = true, scheduled = true, podEvents = [], claimEvents = [] } = {}) {
  const pod = {
    metadata: { name: 'sv-worker-s13913-6d9f-abcde', uid: 'pod-uid', annotations: { 'social.usernode.io/env-checksum': 'env' } },
    spec: { nodeName: scheduled ? 'talos-ap6-6cz' : undefined, containers: [{ name: 'worker', image: OPTIONS.imageRef }] },
    status: { phase: 'Pending', conditions: [{ type: 'Ready', status: 'False' }],
      containerStatuses: scheduled ? [{ name: 'worker', ready: false, state: { waiting: { reason: 'ContainerCreating' } } }] : [] },
  };
  const claim = {
    metadata: { name: OPTIONS.claimName, uid: 'claim-uid',
      annotations: { 'volume.kubernetes.io/selected-node': 'talos-ap6-6cz' } },
    spec: bound ? { volumeName: 'pvc-7a1' } : {},
    status: { phase: bound ? 'Bound' : 'Pending' },
  };
  const deployment = { metadata: { generation: 2 }, status: { observedGeneration: 2, updatedReplicas: 1, replicas: 1, availableReplicas: 0 } };
  const listed = [];
  const events = { pod: podEvents, claim: claimEvents };
  const core = {
    listNamespacedPod: async () => ({ items: [pod] }),
    readNamespacedPod: async () => pod,
    readNamespacedPodLog: async () => '__USERNODE_PHASE__ seeded\n',
    readNamespacedPersistentVolumeClaim: async ({ name }) => { assert.equal(name, OPTIONS.claimName); return claim; },
    listNamespacedEvent: async ({ fieldSelector }) => {
      listed.push(fieldSelector);
      if (fieldSelector.includes('kind=Pod,')) return { items: events.pod.map((e) => ({ involvedObject: { kind: 'Pod', uid: 'pod-uid' }, ...e })) };
      return { items: events.claim.map((e) => ({ involvedObject: { kind: 'PersistentVolumeClaim', uid: 'claim-uid' }, ...e })) };
    },
  };
  return { pod, claim, deployment, core, apps: { readNamespacedDeployment: async () => deployment }, events, listed };
}

async function settle(t, promise, { tickMs = 2000, maxMs = 60000 } = {}) {
  let out = null;
  promise.then(() => { out = 'resolved'; }, (err) => { out = err; });
  for (let elapsed = 0; elapsed <= maxMs && !out; elapsed += tickMs) {
    await flush(); await flush(); await flush();
    if (out) break;
    t.mock.timers.tick(tickMs);
  }
  await flush(); await flush();
  return { out };
}

test('a volume that cannot be formatted fails the wait at once, with the node, the claim and the kubelet\'s words', async (t) => {
  bootstrap._resetEventsRefusedForTests();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ podEvents: [warning('FailedMount', FORMAT_MESSAGE)] });
  const { out } = await settle(t, bootstrap.waitForWorkerBootstrap(f.core, f.apps, OPTIONS), { maxMs: 6000 });
  assert.ok(out instanceof Error, 'failed within seconds, not after the five-minute timeout');
  assert.equal(out.message, bootstrap.VOLUME_FAILURE_TEXT.format);
  assert.equal(out.bootstrapReason, 'volume_format_failed');
  assert.equal(out.bootstrapFailed, true);
  assert.deepEqual(
    { kind: out.volumeFailure.kind, node: out.volumeFailure.node, claim: out.volumeFailure.claim,
      claimUid: out.volumeFailure.claimUid, volume: out.volumeFailure.volume, bound: out.volumeFailure.bound },
    { kind: 'format', node: 'talos-ap6-6cz', claim: OPTIONS.claimName, claimUid: 'claim-uid', volume: 'pvc-7a1', bound: true },
  );
  assert.match(out.bootstrapLog.join('\n'), /libxfs_device_zero write failed/, 'the kubelet\'s words stay in the log');
  assert.ok(!Object.keys(out).includes('volumeFailure'), 'the detail is non-enumerable, so logged errors are unchanged');
  assert.ok(f.listed.every((s) => !s.includes('PersistentVolumeClaim')), 'a bound claim\'s provisioning events are not read');
});

test('a mount error is given a few seconds, then fails the wait', async (t) => {
  bootstrap._resetEventsRefusedForTests();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ podEvents: [warning('FailedMount', MOUNT_MESSAGE)] });
  let out = null;
  bootstrap.waitForWorkerBootstrap(f.core, f.apps, OPTIONS).then(() => { out = 'resolved'; }, (err) => { out = err; });
  let elapsed = 0;
  for (; elapsed < 30000 && !out; elapsed += 2000) {
    await flush(); await flush(); await flush();
    if (out) break;
    if (elapsed === bootstrap.VOLUME_MOUNT_GRACE_MS - 4000) assert.equal(out, null, 'one mount error is not yet a volume that will not mount');
    t.mock.timers.tick(2000);
  }
  await flush(); await flush();
  assert.ok(out instanceof Error);
  assert.ok(elapsed >= bootstrap.VOLUME_MOUNT_GRACE_MS && elapsed <= bootstrap.VOLUME_MOUNT_GRACE_MS + 2 * bootstrap.VOLUME_EVENT_POLL_MS,
    `failed ${elapsed} ms in: after its grace, well before the timeout`);
  assert.equal(out.bootstrapReason, 'volume_mount_failed');
  assert.equal(out.message, bootstrap.VOLUME_FAILURE_TEXT.mount);
});

test('a mount error the kubelet already tried three times fails the wait at once', async (t) => {
  bootstrap._resetEventsRefusedForTests();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ podEvents: [warning('FailedMount', MOUNT_MESSAGE, { count: 7 })] });
  const { out } = await settle(t, bootstrap.waitForWorkerBootstrap(f.core, f.apps, OPTIONS), { maxMs: 2000 });
  assert.equal(out.bootstrapReason, 'volume_mount_failed');
});

test('a claim that cannot be provisioned fails the wait, naming the node the scheduler chose for it', async (t) => {
  bootstrap._resetEventsRefusedForTests();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ bound: false, scheduled: false, claimEvents: [warning('ProvisioningFailed', PROVISION_MESSAGE)] });
  const { out } = await settle(t, bootstrap.waitForWorkerBootstrap(f.core, f.apps, OPTIONS), { maxMs: 2000 });
  assert.equal(out.message, bootstrap.VOLUME_FAILURE_TEXT.provision);
  assert.equal(out.volumeFailure.kind, 'provision');
  assert.equal(out.volumeFailure.bound, false);
  assert.equal(out.volumeFailure.node, 'talos-ap6-6cz', 'from the claim\'s selected-node annotation');
});

test('events of another Pod, of an older claim of the same name, or of a claim now bound do not fail the wait', async (t) => {
  bootstrap._resetEventsRefusedForTests();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({
    podEvents: [warning('FailedMount', FORMAT_MESSAGE, { involvedObject: { kind: 'Pod', uid: 'an-older-pod' } })],
    claimEvents: [warning('ProvisioningFailed', PROVISION_MESSAGE)],
  });
  const pending = bootstrap.waitForWorkerBootstrap(f.core, f.apps, { ...OPTIONS, timeoutMs: 8000 });
  const { out } = await settle(t, pending, { maxMs: 12000 });
  assert.ok(out instanceof Error);
  assert.match(out.message, /^warm-ready timeout/, 'nothing about this Pod or claim said its volume failed');

  // An unbound claim whose only provisioning failure was an older claim's,
  // deleted and made again under the same name.
  const g = fixture({ bound: false, scheduled: false,
    claimEvents: [warning('ProvisioningFailed', PROVISION_MESSAGE, { involvedObject: { kind: 'PersistentVolumeClaim', uid: 'an-older-claim' } })] });
  const { out: again } = await settle(t, bootstrap.waitForWorkerBootstrap(g.core, g.apps, { ...OPTIONS, timeoutMs: 8000 }), { maxMs: 12000 });
  assert.match(again.message, /^warm-ready timeout/);
  assert.ok(g.listed.some((s) => s.includes('PersistentVolumeClaim')), 'the unbound claim\'s events were read');
});

test('a worker that started is never failed by its volume\'s events', async (t) => {
  bootstrap._resetEventsRefusedForTests();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ podEvents: [warning('FailedMount', MOUNT_MESSAGE, { count: 9 })] });
  f.pod.status.phase = 'Running';
  f.pod.status.containerStatuses = [{ name: 'worker', ready: true, state: { running: {} } }];
  f.pod.status.conditions = [{ type: 'Ready', status: 'True' }];
  f.deployment.status.availableReplicas = 1;
  const { out } = await settle(t, bootstrap.waitForWorkerBootstrap(f.core, f.apps, OPTIONS), { maxMs: 2000 });
  assert.equal(out, 'resolved');
  assert.deepEqual(f.listed, [], 'no events are read for a container that is running');
});

test('events the platform may not read leave the wait as it was, and are not asked for again each poll', async (t) => {
  bootstrap._resetEventsRefusedForTests();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  let asked = 0;
  f.core.listNamespacedEvent = async () => { asked += 1; throw Object.assign(new Error('events is forbidden'), { code: 403 }); };
  const ready = () => {
    f.pod.status.phase = 'Running';
    f.pod.status.containerStatuses = [{ name: 'worker', ready: true, state: { running: {} } }];
    f.pod.status.conditions = [{ type: 'Ready', status: 'True' }];
    f.deployment.status.availableReplicas = 1;
  };
  let out = null;
  bootstrap.waitForWorkerBootstrap(f.core, f.apps, OPTIONS).then(() => { out = 'resolved'; }, (err) => { out = err; });
  for (let i = 0; i < 10; i += 1) { await flush(); await flush(); await flush(); t.mock.timers.tick(2000); }
  assert.equal(out, null, 'still waiting');
  assert.equal(asked, 1, 'asked once, then left alone');
  ready();
  for (let i = 0; i < 3 && !out; i += 1) { await flush(); await flush(); await flush(); t.mock.timers.tick(2000); }
  await flush();
  assert.equal(out, 'resolved');
  bootstrap._resetEventsRefusedForTests();
});

test('a worker on scratch storage reads no volume events', async (t) => {
  bootstrap._resetEventsRefusedForTests();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ podEvents: [warning('FailedMount', FORMAT_MESSAGE)] });
  const pending = bootstrap.waitForWorkerBootstrap(f.core, f.apps, { ...OPTIONS, claimName: null, timeoutMs: 4000 });
  const { out } = await settle(t, pending, { maxMs: 8000 });
  assert.match(out.message, /^warm-ready timeout/);
  assert.deepEqual(f.listed, []);
});

// ── Heal a claim that never held anything; keep one that may ───────────

const FAILURE = { kind: 'format', reason: 'volume_format_failed', node: 'talos-ap6-6cz', claim: 'sv-worker-s1-state',
  claimUid: 'claim-uid', volume: 'pvc-7a1', bound: true, message: 'mkfs.xfs: No space left on device' };

test('heal or report: only a claim with no volume, or a volume with no filesystem, is deleted', () => {
  assert.deepEqual(heal.healDecision(FAILURE), { action: 'heal', why: 'never_formatted' });
  assert.deepEqual(heal.healDecision({ ...FAILURE, kind: 'provision', bound: false }), { action: 'heal', why: 'never_provisioned' });
  // A volume that has a filesystem may have mounted, and may hold the
  // agent's conversation: nothing records that it did not.
  assert.deepEqual(heal.healDecision({ ...FAILURE, kind: 'mount' }), { action: 'report', why: 'may_hold_state' });
  assert.deepEqual(heal.healDecision({ ...FAILURE, kind: 'provision', bound: true }), { action: 'report', why: 'may_hold_state' });
  // Which claim failed is not known: nothing is deleted.
  assert.deepEqual(heal.healDecision({ ...FAILURE, claimUid: null }), { action: 'report', why: 'no_claim' });
  assert.deepEqual(heal.healDecision(null), { action: 'report', why: 'no_claim' });
});

function fakeKubernetes({ pvc = 'claim-uid', goneAfter = 1 } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    workerIdentity: async (_config, sessionId, opts) => { calls.push(['identity', sessionId, opts]); return { deployment: 'dep-uid', secret: 'sec-uid', pvc }; },
    deleteWorkerIdentity: async (_config, sessionId, ids) => { calls.push(['delete', sessionId, ids]); },
    workerIdentityGone: async () => { reads += 1; calls.push(['gone?']); return reads >= goneAfter; },
  };
}

test('a never-formatted claim is deleted with its worker, by identity, and waited for', async () => {
  heal._resetForTests();
  const k8s = fakeKubernetes({ goneAfter: 2 });
  const out = await heal.handleVolumeFailure({ sessionId: 1, failure: FAILURE,
    deps: { kubernetes: k8s, config: {}, signals: null, pollMs: 1 } });
  assert.deepEqual(out, { healed: true, action: 'heal', why: 'never_formatted', node: 'talos-ap6-6cz' });
  assert.deepEqual(k8s.calls.map((c) => c[0]), ['identity', 'delete', 'gone?', 'gone?']);
  assert.deepEqual(k8s.calls[0][2], { volume: true });
  assert.deepEqual(k8s.calls[1][2], { deployment: 'dep-uid', secret: 'sec-uid', pvc: 'claim-uid' },
    'the Deployment goes too: its Pod holds the claim');
});

test('a claim that may hold state is kept and reported; one already replaced is left alone', async () => {
  heal._resetForTests();
  const kept = fakeKubernetes();
  const out = await heal.handleVolumeFailure({ sessionId: 2, failure: { ...FAILURE, kind: 'mount', reason: 'volume_mount_failed' },
    deps: { kubernetes: kept, config: {}, signals: null } });
  assert.deepEqual(out, { healed: false, action: 'report', why: 'may_hold_state', node: 'talos-ap6-6cz' });
  assert.deepEqual(kept.calls, [], 'nothing is read or deleted');

  const replaced = fakeKubernetes({ pvc: 'a-newer-claim' });
  const again = await heal.handleVolumeFailure({ sessionId: 3, failure: FAILURE, deps: { kubernetes: replaced, config: {}, signals: null } });
  assert.equal(again.healed, true);
  assert.equal(again.replaced, true);
  assert.deepEqual(replaced.calls.map((c) => c[0]), ['identity'], 'a claim of another uid is not deleted');
});

test('a delete that does not finish, or fails, heals nothing', async () => {
  heal._resetForTests();
  let clock = 0;
  const slow = fakeKubernetes({ goneAfter: Infinity });
  const pending = await heal.handleVolumeFailure({ sessionId: 4, failure: FAILURE,
    deps: { kubernetes: slow, config: {}, signals: null, pollMs: 1, waitMs: 5, now: () => { clock += 2; return clock; } } });
  assert.deepEqual(pending, { healed: false, action: 'report', why: 'delete_pending', node: 'talos-ap6-6cz' });

  const broken = { ...fakeKubernetes(), deleteWorkerIdentity: async () => { throw new Error('forbidden'); } };
  const failed = await heal.handleVolumeFailure({ sessionId: 5, failure: FAILURE, deps: { kubernetes: broken, config: {}, signals: null } });
  assert.deepEqual(failed, { healed: false, action: 'report', why: 'delete_failed', node: 'talos-ap6-6cz' });
});

// ── A node that keeps failing volumes is reported ────────────────────────

test('three volumes failing on one node in half an hour raise one signal for infra, keyed by the node', async () => {
  heal._resetForTests();
  const raised = [];
  const fakeSignals = { raise: async (_pool, item) => { raised.push(item); return { id: 1 }; } };
  const now = Date.parse('2026-11-18T10:00:00Z');
  const deps = (at) => ({ kubernetes: fakeKubernetes(), config: {}, pool: {}, signals: fakeSignals, now: () => at, pollMs: 1 });
  await heal.handleVolumeFailure({ sessionId: 10, failure: { ...FAILURE, claim: 'a' }, deps: deps(now) });
  await heal.handleVolumeFailure({ sessionId: 10, failure: { ...FAILURE, claim: 'a' }, deps: deps(now + 1000) });
  await heal.handleVolumeFailure({ sessionId: 11, failure: { ...FAILURE, claim: 'b' }, deps: deps(now + 2000) });
  assert.equal(raised.length, 0, 'two claims, one of them twice, is not yet a node problem');
  // Another node's failures are its own.
  await heal.handleVolumeFailure({ sessionId: 12, failure: { ...FAILURE, claim: 'c', node: 'talos-other' }, deps: deps(now + 3000) });
  assert.equal(raised.length, 0);
  await heal.handleVolumeFailure({ sessionId: 13, failure: { ...FAILURE, claim: 'd', kind: 'provision', reason: 'volume_provision_failed', bound: false },
    deps: deps(now + 4000) });
  assert.equal(raised.length, 1);
  const [item] = raised;
  assert.equal(item.kind, 'worker_volumes');
  assert.equal(item.key, 'talos-ap6-6cz');
  assert.match(item.title, /talos-ap6-6cz/);
  assert.match(item.summary, /^3 worker state volumes on node talos-ap6-6cz/);
  assert.equal(item.occurrences, 4);
  // It is a kind the platform files, for infra, cleared once it stops.
  const normalized = signals.normalizeItem(item);
  assert.equal(normalized.fingerprint, 'worker_volumes:talos-ap6-6cz');
  assert.equal(normalized.fixer, 'infra');
  assert.equal(signals.KINDS.worker_volumes.source, 'push');
  // Failures older than the window no longer count.
  heal._resetForTests();
  raised.length = 0;
  for (const [i, at] of [now, now + heal.NODE_WINDOW_MS + 1, now + 2 * heal.NODE_WINDOW_MS + 2].entries()) {
    await heal.handleVolumeFailure({ sessionId: 20 + i, failure: { ...FAILURE, claim: `old-${i}` }, deps: deps(at) });
  }
  assert.equal(raised.length, 0, 'three failures spread over an hour and a half are not one episode');
});

// ── A retry keeps off the node ───────────────────────────────────────────

test('a worker retried after its volume failed keeps off that node, by the Node\'s own name', () => {
  assert.deepEqual(kubernetes.workerAvoidNodes([]), {});
  assert.deepEqual(kubernetes.workerAvoidNodes(undefined), {});
  assert.deepEqual(kubernetes.workerAvoidNodes(['talos-ap6-6cz', 'talos-ap6-6cz', 'Not A Node!']), {
    affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{
      matchFields: [{ key: 'metadata.name', operator: 'NotIn', values: ['talos-ap6-6cz'] }],
    }] } } },
  });
});
