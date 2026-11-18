'use strict';

// A worker's state volume that could not be made or mounted
// (kubernetes-worker-bootstrap.js reads why from the kubelet's and the
// provisioner's events, and fails the setup wait within seconds).
//
// 18 Nov 2026: node talos-ap6-6cz's OpenEBS LVM thin pool, made at its first
// volume's 1 GiB and never grown, was 91% full after 13 worker volumes. Every
// new worker claim there failed to format, then on every mount, or never
// provisioned at all, and the platform recreated the same Pods on the same
// broken claims for 35 minutes: a change's shots ran out of time preparing
// its worker, and another change sat "syncing with main".
//
// A claim that has never held anything is deleted, with its worker, and the
// worker is started again on another node. One that may hold a coding
// agent's conversation is kept and reported. What tells them apart is what
// failed, never a guess:
//   - provisioning, with the claim still unbound: there is no volume at all;
//   - formatting: the CSI driver runs mkfs only on a device with no
//     filesystem, so nothing was ever written to it;
//   - mounting a volume that has a filesystem: it may have mounted before.
//     Nothing records that it has not (a mark on the claim would need
//     `patch` on persistentvolumeclaims, which the platform's role in the
//     workers' namespace does not have), so it is kept for a person.
// Either way its node is counted, and a node that keeps failing volumes is
// logged and raised as a platform signal (worker_volumes) for infra.

const log = require('./logger');

// How long a heal waits for the deleted claim (and the Deployment whose Pod
// holds it) to be gone before the worker is started again.
const HEAL_WAIT_MS = 90 * 1000;
const HEAL_POLL_MS = 2000;
// A node is reported once this many distinct claims failed on it within the
// window.
const NODE_WINDOW_MS = 30 * 60 * 1000;
const NODE_SIGNAL_AT = 3;

const WHAT_FAILED = Object.freeze({
  provision: 'a volume could not be created',
  format: 'a volume could not be formatted',
  mount: 'a volume could not be mounted',
});

/**
 * Pure: what to do with a claim whose volume failed.
 * Resolves { action: 'heal' | 'report', why }:
 *   heal    never_provisioned  the claim has no volume yet
 *           never_formatted    its volume has no filesystem
 *   report  may_hold_state     it has a filesystem, and may have mounted
 *           no_claim           the claim could not be read, so it is not
 *                              known which one to delete
 */
function healDecision(failure) {
  if (!failure || !failure.claim || !failure.claimUid) return { action: 'report', why: 'no_claim' };
  if (failure.kind === 'provision' && !failure.bound) return { action: 'heal', why: 'never_provisioned' };
  if (failure.kind === 'format') return { action: 'heal', why: 'never_formatted' };
  return { action: 'report', why: 'may_hold_state' };
}

// node -> the failures there within the window, in this process.
const nodeFailures = new Map();

/** Count a failure on `node`; resolves its recent failures there. */
function noteNodeFailure(node, entry, { now = Date.now() } = {}) {
  if (!node) return [];
  const list = (nodeFailures.get(node) || []).filter((e) => now - e.at < NODE_WINDOW_MS);
  list.push({ ...entry, at: now });
  const kept = list.slice(-20);
  nodeFailures.set(node, kept);
  return kept;
}

const distinctClaims = (entries) => [...new Set(entries.map((e) => e.claim).filter(Boolean))];

/** Pure: the platform signal for a node whose volumes keep failing. */
function nodeSignalItem(node, entries) {
  const claims = distinctClaims(entries);
  const latest = entries[entries.length - 1] || {};
  return {
    kind: 'worker_volumes',
    key: node,
    subject: { node },
    title: `Worker volumes keep failing on node ${node}`,
    summary: `${claims.length} worker state volumes on node ${node} could not be created or mounted in the last `
      + `${Math.round(NODE_WINDOW_MS / 60000)} minutes. Each one that never held anything is deleted and its worker `
      + 'started on another node; the node\'s storage needs looking at.',
    occurrences: entries.length,
    evidence: {
      lines: [
        `Latest: ${WHAT_FAILED[latest.kind] || 'a volume failed'} (${latest.reason || 'unknown'}).`,
        `Volumes failed on this node in ${Math.round(NODE_WINDOW_MS / 60000)} minutes: ${claims.length}.`,
        'A full OpenEBS LVM thin pool on the node fails volumes this way (18 Nov 2026).',
      ],
      where: ['src/services/kubernetes-worker-bootstrap.js', 'src/services/worker-volume-heal.js'],
    },
    evidencePrivate: { node, claims, messages: entries.slice(-3).map((e) => e.message || null) },
  };
}

async function reportNode(node, entries, { pool, signals }) {
  const claims = distinctClaims(entries);
  if (claims.length < NODE_SIGNAL_AT) return;
  log.warn('worker-volumes', 'Worker volumes keep failing on one node', {
    node, volumes: claims.length, failures: entries.length,
    windowMinutes: Math.round(NODE_WINDOW_MS / 60000), latest: entries[entries.length - 1]?.reason || null,
  });
  if (pool && signals && typeof signals.raise === 'function') {
    await signals.raise(pool, nodeSignalItem(node, entries));
  }
}

/**
 * A worker's state volume failed while its worker was being set up. Heals a
 * claim that never held anything (deletes it, its Deployment and its Secret
 * by identity, the same fenced removal a change's teardown uses, and waits
 * for them to be gone), or keeps and reports one that may hold state.
 * Never throws.
 *
 * Resolves { healed, action, why, node }: `healed` means the next attempt
 * starts on a fresh claim, and should keep off `node`.
 */
async function handleVolumeFailure({ sessionId, failure, deps = {} }) {
  const d = {
    kubernetes: deps.kubernetes || require('./kubernetes'),
    config: deps.config,
    pool: deps.pool ?? null,
    signals: deps.signals === undefined ? require('./platform-signals') : deps.signals,
    now: deps.now || Date.now,
    waitMs: deps.waitMs ?? HEAL_WAIT_MS,
    pollMs: deps.pollMs ?? HEAL_POLL_MS,
  };
  const decision = healDecision(failure);
  const node = failure?.node || null;
  const fields = {
    sessionId, claim: failure?.claim || null, volume: failure?.volume || null, node,
    reason: failure?.reason || null, why: decision.why, message: failure?.message || null,
  };
  try {
    const entries = noteNodeFailure(node, {
      claim: failure?.claim, kind: failure?.kind, reason: failure?.reason, message: failure?.message,
    }, { now: d.now() });
    await reportNode(node, entries, d);
  } catch (err) {
    log.warn('worker-volumes', 'Could not report a node whose volumes fail', { node, err: err.message });
  }
  if (decision.action === 'report') {
    log.error('worker-volumes', 'A worker\'s state volume failed and is kept: it may hold the agent\'s conversation', fields);
    return { healed: false, ...decision, node };
  }
  try {
    const ids = await d.kubernetes.workerIdentity(d.config, sessionId, { volume: true });
    if (ids.pvc && ids.pvc !== failure.claimUid) {
      // Another claim took its place meanwhile: nothing of ours to delete.
      log.info('worker-volumes', 'A failed worker volume was already replaced', fields);
      return { healed: true, ...decision, node, replaced: true };
    }
    if (ids.pvc) {
      await d.kubernetes.deleteWorkerIdentity(d.config, sessionId, ids);
      const until = d.now() + d.waitMs;
      for (;;) {
        if (await d.kubernetes.workerIdentityGone(d.config, sessionId, ids)) break;
        if (d.now() >= until) {
          log.error('worker-volumes', 'A failed worker volume is still being deleted', fields);
          return { healed: false, action: 'report', why: 'delete_pending', node };
        }
        await new Promise((r) => { setTimeout(r, d.pollMs); });
      }
    }
    log.warn('worker-volumes', 'Deleted a worker\'s state volume that never held anything; starting it on another node', fields);
    return { healed: true, ...decision, node };
  } catch (err) {
    log.error('worker-volumes', 'Could not delete a worker\'s failed state volume', { ...fields, err: err.message });
    return { healed: false, action: 'report', why: 'delete_failed', node };
  }
}

// Tests start with no node counted.
function _resetForTests() { nodeFailures.clear(); }

module.exports = {
  HEAL_WAIT_MS,
  NODE_WINDOW_MS,
  NODE_SIGNAL_AT,
  healDecision,
  noteNodeFailure,
  nodeSignalItem,
  handleVolumeFailure,
  _resetForTests,
};
