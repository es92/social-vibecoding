'use strict';

const log = require('./logger');
const { boundedText, collectPodDiagnostics, conditionDetails } = require('./kubernetes-diagnostics');

// Waits the kubelet reports while it cannot even start the container. None
// of them clears inside a setup window, so waiting out the full timeout only
// delays the same answer. Each maps to a typed reason the route layer words
// for the user; the Kubernetes name stays in the logged message.
const STUCK_WAITING_REASONS = Object.freeze({
  ImagePullBackOff: 'image_unavailable',
  ErrImagePull: 'image_unavailable',
  InvalidImageName: 'image_unavailable',
  CreateContainerConfigError: 'config_error',
});
// Short graces, not zero: a registry blip can show ErrImagePull once, the
// Secret written just before the Deployment can briefly read as a config
// error, and a fresh volume can leave a Pod unschedulable for a few seconds.
const STUCK_WAITING_GRACE_MS = 30 * 1000;
const UNSCHEDULABLE_GRACE_MS = 60 * 1000;

function workerCouldNotStart(reason, detail) {
  const err = new Error(`worker could not start (${detail})`);
  Object.defineProperty(err, 'bootstrapReason', { value: reason, configurable: true, writable: true });
  return err;
}

// A worker's state volume that cannot be made or mounted. 18 Nov 2026: a
// node's OpenEBS LVM thin pool, made at its first volume's 1 GiB and never
// grown, filled, and every new worker claim there failed to format, then to
// mount, or never provisioned. The Pod only ever reads ContainerCreating (or
// Pending), so the wait ran out its whole five minutes, three times, on a
// claim no retry could fix. The kubelet and the provisioner say why in
// events within seconds; these are the ones that do not clear by waiting.
// What happens to the claim next is worker-volume-heal.js's.
const VOLUME_FAILURE_REASONS = Object.freeze({
  provision: 'volume_provision_failed',
  format: 'volume_format_failed',
  mount: 'volume_mount_failed',
});
// The error's message: it reaches people as it is (a shots card, a sync's
// status line, a build's failure). The kubelet's own words stay in the log.
const VOLUME_FAILURE_TEXT = Object.freeze({
  provision: 'This change’s worker couldn’t start: its disk volume couldn’t be created.',
  format: 'This change’s worker couldn’t start: its disk volume failed to mount.',
  mount: 'This change’s worker couldn’t start: its disk volume failed to mount.',
});
// The same, by the error's `bootstrapReason` (worker.js workerStartReason).
const VOLUME_FAILURE_TEXT_BY_REASON = Object.freeze(Object.fromEntries(
  Object.entries(VOLUME_FAILURE_REASONS).map(([kind, reason]) => [reason, VOLUME_FAILURE_TEXT[kind]]),
));
// How often the events are read while the Pod waits for its volume.
const VOLUME_EVENT_POLL_MS = 4000;
// A mount error fails the wait once it has been seen this long or this many
// times (the kubelet retries a mount within a second or two at first). A
// format or provisioning error fails it at once: neither clears by itself.
const VOLUME_MOUNT_GRACE_MS = 10 * 1000;
const VOLUME_MOUNT_TRIES = 3;
// The platform's role needs `list` on events in the workers' namespace
// (infra: rbac.yaml, social-runtime-worker-manager). Refused, the wait says
// so once an hour and goes on as it did before: it waits out its time.
const EVENTS_REFUSED_BACKOFF_MS = 60 * 60 * 1000;
let eventsRefusedUntil = 0;

// The provisioner's words for a volume it cannot make on the node it was
// given (`ResourceExhausted - exit status 5` on 18 Nov), as opposed to a
// call that timed out or a driver not yet up, which a retry gets past.
const PROVISION_FAILURE = /ResourceExhausted|no space left|insufficient (?:space|capacity|storage)|not enough (?:space|free)|exit status \d+/i;
const PROVISION_TRANSIENT = /DeadlineExceeded|deadline exceeded|code = Unavailable|connection refused|i\/o timeout|context canceled/i;
// mount-utils' FormatAndMount: "format of disk ... failed ... output:(mkfs.xfs:
// libxfs_device_zero write failed: No space left on device)". Checked before
// the mount patterns, which the same sentence can also match.
const FORMAT_FAILURE = /\bformat of disk\b|\bmkfs(?:\.\w+)?\b|\blibxfs_/i;
// "mount failed: exit status 32 ... fsconfig() failed", and the filesystem's
// own refusals. Not the kubelet's summary ("Unable to attach or mount
// volumes ... timed out waiting for the condition"), nor a CSI driver that
// has not registered yet: those clear.
const MOUNT_FAILURE = /mount failed: exit status \d+|fsconfig\(\) failed|wrong fs type|bad superblock|can't read superblock|structure needs cleaning|no space left on device/i;

/**
 * Pure: which volume failure one Kubernetes event reports, or null.
 *   'provision'  the claim's volume could not be made (ProvisioningFailed)
 *   'format'     the volume could not be formatted (FailedMount, mkfs)
 *   'mount'      the volume could not be mounted (FailedMount)
 */
function classifyVolumeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type && event.type !== 'Warning') return null;
  const message = String(event.message || '');
  if (event.reason === 'ProvisioningFailed') {
    return PROVISION_FAILURE.test(message) && !PROVISION_TRANSIENT.test(message) ? 'provision' : null;
  }
  if (event.reason === 'FailedMount') {
    if (FORMAT_FAILURE.test(message)) return 'format';
    if (MOUNT_FAILURE.test(message)) return 'mount';
  }
  return null;
}

const eventCount = (event) => Math.max(1, Number(event?.count) || Number(event?.series?.count) || 1);
const refused = (err) => [err?.code, err?.statusCode, err?.response?.statusCode, err?.response?.status].includes(403);

// The worst volume failure the events of this Pod and its claim report now,
// as { kind, reason, node, claim, claimUid, volume, bound, message, count, key },
// or null. Only the current Pod's events and, while it has no volume yet,
// the current claim's: an older Pod's mount error on the same volume may
// have cleared since (the volume mounted after it), and an older claim of
// the same name is another claim.
async function readVolumeFailure(core, { namespace, pod, claimName, read }) {
  let claim = null;
  try {
    claim = await read(() => core.readNamespacedPersistentVolumeClaim({ namespace, name: claimName }));
  } catch { /* the claim is read for its node and identity; the events still count */ }
  const unbound = !!claim && !claim.spec?.volumeName && claim.status?.phase !== 'Bound';
  const queries = [];
  if (pod?.metadata?.name) {
    queries.push({ selector: `involvedObject.kind=Pod,involvedObject.name=${pod.metadata.name}`,
      uid: pod.metadata.uid || null, kinds: ['format', 'mount'] });
  }
  if (unbound) {
    queries.push({ selector: `involvedObject.kind=PersistentVolumeClaim,involvedObject.name=${claimName}`,
      uid: claim.metadata?.uid || null, kinds: ['provision'] });
  }
  const rank = { provision: 0, format: 1, mount: 2 };
  let found = null;
  for (const q of queries) {
    const list = await read(() => core.listNamespacedEvent({ namespace, fieldSelector: q.selector, limit: 50 }));
    for (const event of list?.items || []) {
      if (q.uid && event.involvedObject?.uid && event.involvedObject.uid !== q.uid) continue;
      const kind = classifyVolumeEvent(event);
      if (!kind || !q.kinds.includes(kind)) continue;
      if (found && rank[found.kind] <= rank[kind]) continue;
      found = {
        kind,
        reason: VOLUME_FAILURE_REASONS[kind],
        node: pod?.spec?.nodeName || event.source?.host || event.reportingInstance
          || claim?.metadata?.annotations?.['volume.kubernetes.io/selected-node'] || null,
        claim: claimName,
        claimUid: claim?.metadata?.uid || null,
        volume: claim?.spec?.volumeName || null,
        bound: !unbound && !!claim,
        message: boundedText(event.message, 600),
        count: eventCount(event),
        key: `${q.uid || q.selector}/${kind}`,
      };
    }
  }
  return found;
}

function volumeFailed(failure) {
  const err = new Error(VOLUME_FAILURE_TEXT[failure.kind]);
  Object.defineProperty(err, 'bootstrapReason', { value: failure.reason, configurable: true, writable: true });
  Object.defineProperty(err, 'volumeFailure', { value: failure, configurable: true, writable: true });
  return err;
}

// Observe setup while the readiness probe is still false. Waiting for the
// Deployment first hides clone failures and all setup progress until timeout.
// `claimName`: the worker's state volume claim, whose failures (and its
// Pod's) are read from events while the container has not started; null for
// a worker on scratch storage.
async function waitForWorkerBootstrap(core, apps, {
  namespace, name, imageRef, environmentChecksum, generation = 0,
  onProgress, timeoutMs, claimName = null,
}) {
  if (!(timeoutMs > 0)) timeoutMs = 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  let phase = null;
  let recent = [];
  let podName = null;
  let lastReadError = null;
  let stuck = null;
  let nextVolumeReadAt = 0;
  const volumeSeen = new Map();
  const warnings = new Set();
  const emit = text => { try { onProgress?.(text); } catch { /* observer only */ } };
  const read = async fn => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Worker setup observation timed out')),
          Math.max(1, Math.min(5000, deadline - Date.now())));
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    while (Date.now() < deadline) {
      let deployment, pods;
      try {
        [deployment, pods] = await Promise.all([
          read(() => apps.readNamespacedDeployment({ namespace, name })),
          read(() => core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${name}` })),
        ]);
      } catch (err) {
        lastReadError = boundedText(err.message, 500);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      const candidates = (pods.items || []).filter(pod => !pod.metadata?.deletionTimestamp
        && pod.metadata?.annotations?.['social.usernode.io/env-checksum'] === environmentChecksum
        && pod.spec?.containers?.some(c => c.name === 'worker' && c.image === imageRef));
      candidates.sort((a, b) => new Date(b.metadata?.creationTimestamp || 0) - new Date(a.metadata?.creationTimestamp || 0));
      const pod = candidates[0];
      const started = !!pod?.status?.containerStatuses?.find(c => c.name === 'worker')?.state?.running;
      if (claimName && !started && Date.now() >= nextVolumeReadAt && Date.now() >= eventsRefusedUntil) {
        nextVolumeReadAt = Date.now() + VOLUME_EVENT_POLL_MS;
        let failure = null;
        try {
          failure = await readVolumeFailure(core, { namespace, pod, claimName, read });
        } catch (err) {
          if (refused(err)) {
            eventsRefusedUntil = Date.now() + EVENTS_REFUSED_BACKOFF_MS;
            log.warn('worker', 'Worker volume events cannot be read: the platform\'s role lacks list on events in the workers\' namespace', {
              namespace, runtimeName: name,
            });
          } else lastReadError = boundedText(err.message, 500);
        }
        if (failure) {
          const firstSeen = volumeSeen.get(failure.key) ?? Date.now();
          volumeSeen.set(failure.key, firstSeen);
          if (failure.kind !== 'mount' || failure.count >= VOLUME_MOUNT_TRIES
              || Date.now() - firstSeen >= VOLUME_MOUNT_GRACE_MS) {
            recent = [...recent, `[volume] ${failure.reason} on node ${failure.node || 'unknown'}: ${failure.message}`].slice(-20);
            throw volumeFailed(failure);
          }
        }
      }
      if (pod) {
        podName = pod.metadata.name;
        let output = '';
        try {
          output = await read(() => core.readNamespacedPodLog({ namespace, name: podName,
            container: 'worker', tailLines: 200, limitBytes: 16384 }));
        } catch (err) { lastReadError = boundedText(err.message, 500); }
        const lines = boundedText(output).split('\n').filter(Boolean);
        recent = lines.slice(-20);
        // A cumulative log snapshot may repeat earlier phases. Publish only
        // its latest phase, so polling never replays clone -> checkout -> clone.
        const phases = lines.filter(line => line.startsWith('__USERNODE_PHASE__ '));
        const nextPhase = phases.at(-1)?.replace('__USERNODE_PHASE__ ', '').trim();
        if (nextPhase && nextPhase !== phase) { phase = nextPhase; emit(`[${phase}]`); }
        for (const line of lines.filter(line => line.startsWith('__USERNODE_WARN__ '))) {
          if (!warnings.has(line)) { warnings.add(line); emit(`⚠ ${line.replace('__USERNODE_WARN__ ', '')}`); }
        }
        const fatal = lines.find(line => line.startsWith('__USERNODE_ERROR__ '));
        if (fatal) throw new Error(fatal.replace('__USERNODE_ERROR__ ', '').trim());
        const worker = pod.status?.containerStatuses?.find(c => c.name === 'worker');
        if (worker?.state?.terminated || worker?.state?.waiting?.reason === 'CrashLoopBackOff') {
          throw new Error(`warm wrapper exited before warm-ready (${worker.state.terminated?.reason || worker.state.waiting.reason})`);
        }
        const waiting = worker?.state?.waiting?.reason;
        const unschedulable = pod.status?.conditions?.some(c => c.type === 'PodScheduled'
          && c.status === 'False' && c.reason === 'Unschedulable');
        const stuckKey = STUCK_WAITING_REASONS[waiting] ? `${podName}/${waiting}`
          : (unschedulable ? `${podName}/Unschedulable` : null);
        if (!stuckKey) stuck = null;
        else if (stuck?.key !== stuckKey) stuck = { key: stuckKey, since: Date.now() };
        else if (Date.now() - stuck.since >= (unschedulable && !STUCK_WAITING_REASONS[waiting]
          ? UNSCHEDULABLE_GRACE_MS : STUCK_WAITING_GRACE_MS)) {
          throw STUCK_WAITING_REASONS[waiting]
            ? workerCouldNotStart(STUCK_WAITING_REASONS[waiting], waiting)
            : workerCouldNotStart('unschedulable', 'Unschedulable');
        }
        const status = deployment.status || {};
        if (!deployment.metadata?.deletionTimestamp && status.observedGeneration >= generation
            && status.updatedReplicas === 1 && status.replicas === 1 && status.availableReplicas >= 1
            && pod.status?.phase === 'Running' && worker?.ready && worker.state?.running
            && pod.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True')) {
          if (phase !== 'warm-ready') emit('[warm-ready]');
          return;
        }
      }
      const failure = deployment.status?.conditions?.find(c => c.type === 'ReplicaFailure' && c.status === 'True');
      if (failure) throw new Error(`Worker setup failed: ${conditionDetails([failure]).join('; ')}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error(`warm-ready timeout for ${name}`);
  } catch (err) {
    const diagnostics = await collectPodDiagnostics(core, {
      namespace, runtimeName: name, podName, imageRef, environmentChecksum, container: 'worker',
    });
    err.message = boundedText(err.message, 2000);
    const context = { bootstrapFailed: true, bootstrapPhase: phase, bootstrapContainerName: name,
      bootstrapLog: boundedText([recent.join('\n'), diagnostics.details, diagnostics.logs,
        diagnostics.unavailable, lastReadError].filter(Boolean).join('\n')).split('\n') };
    for (const [key, value] of Object.entries(context)) {
      Object.defineProperty(err, key, { value, configurable: true, writable: true });
    }
    throw err;
  }
}

// Tests start each case with the events readable.
function _resetEventsRefusedForTests() { eventsRefusedUntil = 0; }

module.exports = {
  waitForWorkerBootstrap, STUCK_WAITING_REASONS, STUCK_WAITING_GRACE_MS, UNSCHEDULABLE_GRACE_MS,
  classifyVolumeEvent, VOLUME_FAILURE_REASONS, VOLUME_FAILURE_TEXT, VOLUME_FAILURE_TEXT_BY_REASON,
  VOLUME_MOUNT_GRACE_MS, VOLUME_EVENT_POLL_MS,
  _resetEventsRefusedForTests,
};
