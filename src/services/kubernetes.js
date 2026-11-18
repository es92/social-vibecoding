const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const log = require('./logger');
const { collectPodDiagnostics, conditionDetails, boundedText } = require('./kubernetes-diagnostics');
const { waitForWorkerBootstrap } = require('./kubernetes-worker-bootstrap');
const buildkit = require('./kubernetes-buildkit');
const { watchDeployment } = require('./kubernetes-deployment-watch');
const { readPodStart, mergePodStart } = require('./check-pod-start');
const repoRef = require('./repo-ref');

// The client is 967 ES modules: about a quarter of a second and 70 MB to
// load. Most processes that load this file never reach the cluster (341 of
// 1,594 test processes required the client on 7 October 2026 and one used
// it), so it is loaded by the first call that needs it. require() caches it
// from then on.
const kubernetesClient = () => require('@kubernetes/client-node');

const MANAGED_BY = 'social-vibecoding-runtime';
const PART_OF = 'social-vibecoding';

// How often a build or rollout is re-read while it is being waited on. The
// wait is a cheap GET against a cached object; what the interval buys is
// how long a finished step sits unnoticed, which at 2-3s was a visible
// slice of a ~25s preview turnaround.
const BUILD_POLL_MS = 1000;
const ROLLOUT_POLL_MS = 1000;
// How long a finished check Job (and its Pod's log) stays for a harvest to
// read when the process that launched it died (services/check-harvest.js).
// A run that settles deletes its Jobs itself (deleteSettledCheckJobs).
const CHECK_JOB_TTL_SECONDS = 3600;
const TERMINAL_CONTAINER_WAITING_REASONS = new Set([
  'CreateContainerConfigError',
  'CreateContainerError',
  'InvalidImageName',
  'ErrImageNeverPull',
]);

// The app container's health probes. The startup probe decides how soon a
// booted container is seen (its period is the latency, its threshold the
// boot budget: 120s for an app, 60s for the asset server); the readiness
// probe decides how soon after that the Pod is Ready — the kubelet runs it
// on its own period once startup has passed, so 5s there was up to 5s of
// waiting on a container already answering /health. 2s is still one GET
// every 2s per pod in steady state. Liveness stays coarse.
function httpProbes({ startupFailureThreshold }) {
  const health = { httpGet: { path: '/health', port: 'http' } };
  return {
    startupProbe: { ...health, periodSeconds: 1, failureThreshold: startupFailureThreshold },
    readinessProbe: { ...health, periodSeconds: 2, failureThreshold: 3 },
    livenessProbe: { ...health, periodSeconds: 15, failureThreshold: 3 },
  };
}

let clients;

function setClientsForTest(value) { clients = value; }

function getClients() {
  if (clients) return clients;
  const k8s = kubernetesClient();
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();
  clients = {
    kc,
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    networking: kc.makeApiClient(k8s.NetworkingV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
  };
  return clients;
}

function isNotFound(err) {
  return err?.code === 404 || err?.response?.statusCode === 404 || err?.response?.status === 404;
}

function isConflict(err) {
  return err?.code === 409 || err?.response?.statusCode === 409 || err?.response?.status === 409;
}

// A preview attempt (the workflow's preview machine): its env Secret is its
// own, and the Deployment records the highest attempt that wrote it, so an
// older attempt that lands late cannot overwrite a newer one.
const PREVIEW_ATTEMPT_ANNOTATION = 'social.usernode.io/preview-attempt';
// The fence a preview's Deployment (or Docker container) carries: the
// attempt that wrote it and which claim of that attempt's build, as `n.k`
// (a bare `n` is claim 0). A claim of a build that lost its lease may still
// be running while the next claim of the same attempt deploys: the claim
// tells them apart. Ordered by attempt, then claim.
function attemptFence(value) {
  const [n, k] = String(value ?? '').split('.');
  const attempt = Number(n);
  return Number.isInteger(attempt) && n !== '' ? { attempt, claim: Number(k) || 0 } : null;
}
const fenceValue = (attempt, claim = 0) => (claim ? `${attempt}.${claim}` : String(attempt));
// Written by a newer attempt, or a later claim of this one.
const fenceNewer = (written, attempt, claim = 0) =>
  !!written && (written.attempt > attempt || (written.attempt === attempt && written.claim > claim));
// Written by exactly this claim of this attempt.
const fenceIs = (written, attempt, claim = 0) => !!written && written.attempt === attempt && written.claim === claim;
const fenceOf = (o) => attemptFence(o?.metadata?.annotations?.[PREVIEW_ATTEMPT_ANNOTATION]);
function attemptSecretName(runtimeName, attempt) {
  return attempt ? withSuffix(runtimeName, `env-a${attempt}`) : withSuffix(runtimeName, 'env');
}

// The namespace's ResourceQuota refused an object: every slot it allows (for
// a worker, a volume claim or the storage those claims request) is taken.
function isQuotaExceeded(err) {
  const code = err?.code ?? err?.response?.statusCode ?? err?.response?.status;
  return code === 403 && /exceeded quota/i.test(String(err?.message || ''));
}

function dnsName(value, max = 63) {
  const clean = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/-+$/g, '');
}

function withSuffix(value, suffix, max = 63) {
  const cleanSuffix = `-${dnsName(suffix, max)}`;
  const base = dnsName(value, max - cleanSuffix.length);
  return `${base}${cleanSuffix}`;
}

function envChecksum(env) {
  const entries = Object.entries(env || {})
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function labels({ appId, sessionId, environment }) {
  const result = {
    'app.kubernetes.io/part-of': PART_OF,
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'social.usernode.io/environment': environment,
  };
  if (appId !== undefined && appId !== null) result['social.usernode.io/app-id'] = String(appId);
  if (sessionId !== undefined && sessionId !== null) result['social.usernode.io/session-id'] = String(sessionId);
  return result;
}

function isConflict(err) {
  return err?.code === 409 || err?.response?.statusCode === 409 || err?.response?.status === 409;
}

// Two callers can write the same object at once: two bootstraps of one
// session's worker (14 Oct 2026, session 8499: the read found no env Secret,
// another bootstrap created it, and this create's 409 "already exists" failed
// the person's message). A 409 is either that lost create or a replace that
// lost to another write's resourceVersion; both are settled by reading the
// object again and replacing it, the client-go RetryOnConflict pattern.
const UPSERT_CONFLICT_ATTEMPTS = 3;

async function upsert(api, readMethod, createMethod, replaceMethod, namespace, body) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await upsertOnce(api, readMethod, createMethod, replaceMethod, namespace, body);
    } catch (err) {
      if (!isConflict(err) || attempt >= UPSERT_CONFLICT_ATTEMPTS) throw err;
      delete body.metadata.resourceVersion;
    }
  }
}

async function upsertOnce(api, readMethod, createMethod, replaceMethod, namespace, body) {
  const name = body.metadata.name;
  let current;
  try {
    current = await api[readMethod]({ name, namespace });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return await api[createMethod]({ namespace, body });
  }
  body.metadata.resourceVersion = current.metadata.resourceVersion;
  if (body.kind === 'Service') {
    for (const field of ['clusterIP', 'clusterIPs', 'ipFamilies', 'ipFamilyPolicy', 'healthCheckNodePort']) {
      if (current.spec?.[field] !== undefined) body.spec[field] = current.spec[field];
    }
  }
  return await api[replaceMethod]({ name, namespace, body });
}

async function deleteIfPresent(api, method, name, namespace, options = {}) {
  try {
    await api[method]({ name, namespace, ...options });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function requireBuildConfig(config) {
  const cfg = config.kubernetes;
  const missing = [];
  for (const key of ['repositoryPrefix', 'cacheRepositoryPrefix', 'builderImage']) {
    if (!cfg[key]) missing.push(key);
  }
  if (missing.length) {
    throw new Error(`Kubernetes build configuration missing: ${missing.join(', ')}`);
  }
  return cfg;
}

function packageRunsScript(sourceDir, scriptName) {
  if (!sourceDir) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
    return typeof pkg.scripts?.[scriptName] === 'string';
  } catch {
    return false;
  }
}

// Whether a build reads its `sourceDir` below the root. The source itself
// never comes from that directory here: kpack is given the repository and
// revision, and the BuildKit Job fetches the commit itself. The directory is
// read for two things, package.json's scripts (above) and which Dockerfile
// the tree carries (buildkit.selectDockerfile), and both sit at the root
// unless BUILDKIT_DOCKERFILES names a Dockerfile in a subdirectory.
function buildReadsBelowSourceRoot(config) {
  return (config?.kubernetes?.buildkitDockerfiles || []).some((name) => /[\\/]/.test(String(name)));
}

async function deleteBuild(config, name) {
  await deleteIfPresent(
    getClients().custom,
    'deleteNamespacedCustomObject',
    name,
    config.kubernetes.buildNamespace,
    {
      group: 'kpack.io', version: 'v1alpha2', plural: 'builds',
      propagationPolicy: 'Background',
    }
  );
}

// Source identity changes on every commit, but does not make dependency/launch
// layers incompatible. Compare the remaining recipe without changing the
// revision-bearing output tag or its existing fingerprint.
function reusableBuildEnv(env, { includeRevision = false } = {}) {
  return JSON.stringify((env || []).filter((entry) => includeRevision || !['GIT_SHA', 'BPE_OVERRIDE_GIT_SHA'].includes(entry.name))
    .map((entry) => [entry.name, entry.value, entry.valueFrom])
    .sort((a, b) => a[0].localeCompare(b[0])));
}

async function compatibleCompletedBuilds(config, body, repository) {
  // Mutable builder tags cannot establish that two builds used the same recipe.
  if (!/@sha256:[a-f0-9]{64}$/.test(body.spec.builder.image)) return [];
  const appId = body.metadata.labels['social.usernode.io/app-id'];
  if (!appId) return [];
  try {
    const builds = await listManagedBuilds(config, { appId });
    const eligible = builds.filter((build) => {
      const meta = build.metadata;
      const spec = build.spec;
      const status = build.status;
      const success = status?.conditions?.find((condition) => condition.type === 'Succeeded');
      return meta?.namespace === body.metadata.namespace && meta.name !== body.metadata.name
        && !meta.deletionTimestamp && !meta.ownerReferences?.length
        && meta.labels?.['app.kubernetes.io/managed-by'] === MANAGED_BY
        && meta.labels?.['social.usernode.io/app-id'] === appId
        && success?.status === 'True' && Number.isFinite(Date.parse(success.lastTransitionTime))
        && spec?.builder?.image === body.spec.builder.image
        && spec.serviceAccountName === body.spec.serviceAccountName
        && spec.source?.git?.url === body.spec.source.git.url
        && !spec.source.subPath && !spec.projectDescriptorPath
        && !spec.services?.length && !spec.cnbBindings?.length
        && reusableBuildEnv(spec.env) === reusableBuildEnv(body.spec.env)
        && typeof status.latestImage === 'string'
        && status.latestImage.startsWith(`${repository}@sha256:`)
        && /^[a-f0-9]{64}$/.test(status.latestImage.slice(`${repository}@sha256:`.length));
    });
    eligible.sort((a, b) => {
      const finished = (build) => Date.parse(build.status.conditions.find((c) => c.type === 'Succeeded').lastTransitionTime);
      return finished(b) - finished(a) || a.metadata.name.localeCompare(b.metadata.name);
    });
    return eligible;
  } catch (err) {
    // Cache discovery is optional; an inventory failure still permits a build.
    log.warn('kubernetes', 'Previous build image lookup failed; building without image reuse', {
      appId, err: err.message,
    });
    return [];
  }
}

// What services/kubernetes-buildkit.js needs from this module: the shared
// client, naming, label and diagnostics helpers, handed over rather than
// imported so the two files stay one-directional.
function buildkitRuntime() {
  return {
    getClients, clientsLogApi, attachLineObserver, labels, dnsName, withSuffix, deleteIfPresent, isNotFound,
    collectPodDiagnostics, boundedText,
    getCloneUrl: (owner, name) => require('./github').getCloneUrl(owner, name),
  };
}

// The builder for this tree under BUILD_ENGINE (see config.js): a kpack
// Build, or a BuildKit Job when the source carries a Dockerfile and the
// engine setting admits it. Both return the same `{ buildRef, imageRef,
// requestedTag, phases, reused }` and fail with the same buildFailed/buildLog
// contract, so nothing downstream tells them apart.
//
// Under `auto`, a lane the cluster cannot run — no namespace or RBAC for it
// yet, or a node without user namespaces for the rootless daemon — is a
// reason to build with kpack, not to fail the app's preview: the lane is
// an optimisation, and the fleet turns it on one piece at a time (the
// foundation chart, then the node sysctl). The verdict is remembered for a
// while so a cluster without the lane does not pay for a doomed Job per
// build. A lane whose quota is still full after it made room (see
// quotaRoom in kubernetes-buildkit.js) sends only that build to kpack: its
// TTL frees the quota, so it is not a verdict to remember. Under
// `buildkit` the failure surfaces, because that setting is the way to find
// out the lane is not actually being used.
async function createBuild(config, params) {
  const { engine } = buildkit.selectEngine(config, params.sourceDir);
  if (engine !== buildkit.ENGINE) return createKpackBuild(config, params);
  const strict = config.kubernetes.buildEngine === buildkit.ENGINE;
  const remembered = strict ? null : buildkit.unavailableReason();
  if (remembered) {
    log.debug('kubernetes', 'BuildKit lane recently unavailable; building with kpack', { appId: params.app?.id, reason: remembered });
    return createKpackBuild(config, params);
  }
  try {
    return await buildkit.createBuild(config, params, buildkitRuntime());
  } catch (err) {
    if (strict || !err?.engineUnavailable) throw err;
    if (!err.laneFull) buildkit.noteUnavailable(err);
    log.warn('kubernetes', err.laneFull ? 'BuildKit lane full; building this one with kpack' : 'BuildKit lane unavailable; building with kpack', {
      appId: params.app?.id, revision: params.revision, reason: err.message,
    });
    return createKpackBuild(config, params);
  }
}

// `onProgress(image)` is called as the kpack Build advances: `{ phase,
// phases: [{ name, ms }], detail }` — which lifecycle phase (init container)
// is running, how long the finished ones took, and the last line the running
// phase printed. Best-effort throughout; a status read that fails is skipped.
async function createKpackBuild(config, { app, revision, environment, sessionId, sourceDir, onProgress = null }) {
  if (!/^[a-f0-9]{40}$/i.test(revision || '')) {
    throw new Error('Kubernetes builds require a full 40-character Git commit SHA');
  }
  if (!repoRef.parse(app.repo_url)) {
    throw new Error('Kubernetes builds require a repository URL');
  }
  const cfg = requireBuildConfig(config);
  const suffix = sessionId ? `s${sessionId}-` : '';
  const repository = `${cfg.repositoryPrefix}/${dnsName(app.slug)}`;
  const cacheTag = `${cfg.cacheRepositoryPrefix}/${dnsName(app.slug)}:cache`;
  // Both staging and production images need production frontend artifacts.
  // Explicit kpack env takes precedence over npm-install's development layer
  // environment. Paketo still installs build dependencies in its separate
  // development install step before running these scripts.
  const buildEnv = [
    { name: 'BP_NODE_VERSION', value: cfg.nodeVersion },
    { name: 'NODE_ENV', value: 'production' },
    // Stamp both generated frontend assets and the image's launch process.
    // Build-time env alone is not retained by the CNB launcher. Paketo's
    // environment-variables buildpack embeds this non-secret source identity.
    { name: 'GIT_SHA', value: revision },
    { name: 'BPE_OVERRIDE_GIT_SHA', value: revision },
  ];
  // The platform self-app generates ignored React/Tailwind artifacts. Paketo
  // must materialize them while /workspace is writable; the launch container
  // deliberately runs as non-root and treats the image filesystem as built.
  // Detect the script from the exact checked-out source instead of coupling
  // this runtime adapter to one app id or slug.
  if (packageRunsScript(sourceDir, 'ensure:shell')) {
    buildEnv.push({ name: 'BP_NODE_RUN_SCRIPTS', value: 'ensure:shell' });
  } else if (packageRunsScript(sourceDir, 'build')) {
    // Standard generated/imported apps declare their asset build in npm.
    // Keep ensure:shell first: its prerender -> CSS ordering is load-bearing.
    buildEnv.push({ name: 'BP_NODE_RUN_SCRIPTS', value: 'build' });
  }
  // A new builder must rebuild an unchanged app revision, not reuse an old
  // successful immutable Build after create returns 409. Include this in the
  // tag too, so the artifact address identifies the source AND build recipe.
  const recipe = crypto.createHash('sha256')
    .update(JSON.stringify({ builder: cfg.builderImage, env: buildEnv }))
    .digest('hex').slice(0, 12);
  const buildName = dnsName(`sv-${app.id}-${suffix}${revision.slice(0, 12)}-${recipe}`);
  const tag = `${repository}:git-${revision}-${recipe}`;
  const body = {
    apiVersion: 'kpack.io/v1alpha2',
    kind: 'Build',
    metadata: { name: buildName, namespace: cfg.buildNamespace, labels: labels({ appId: app.id, sessionId, environment }) },
    spec: {
      tags: [tag],
      serviceAccountName: cfg.buildServiceAccount,
      builder: { image: cfg.builderImage },
      cache: { registry: { tag: cacheTag } },
      // A repository on Homeroom's git host is cloned from its clone address
      // (GIT_HOST_INTERNAL_URL, else the public one); GitHub's as before.
      source: { git: { url: repoRef.isHosted(app.repo_url) ? repoRef.cloneUrl(app.repo_url) : app.repo_url.replace(/\.git$/, ''), revision } },
      activeDeadlineSeconds: cfg.activeDeadlineSeconds,
      ...batchWorkPlacement(cfg),
      env: buildEnv,
      resources: {
        requests: { cpu: process.env.BUILD_REQUESTS_CPU || '500m', memory: process.env.BUILD_REQUESTS_MEMORY || '1Gi', 'ephemeral-storage': process.env.BUILD_REQUESTS_EPHEMERAL_STORAGE || '2Gi' },
        limits: { cpu: process.env.BUILD_LIMITS_CPU || '2', memory: process.env.BUILD_LIMITS_MEMORY || '2Gi', 'ephemeral-storage': process.env.BUILD_LIMITS_EPHEMERAL_STORAGE || '8Gi' },
      },
    },
  };
  const completed = await compatibleCompletedBuilds(config, body, repository);
  const exact = completed.find((previous) => previous.spec.source.git.revision === revision
    && reusableBuildEnv(previous.spec.env, { includeRevision: true })
      === reusableBuildEnv(body.spec.env, { includeRevision: true }));
  if (exact) {
    // Session identity affects deployment, not the immutable build artifact.
    // Borrow only completed images: no ownership changes, shared in-flight
    // jobs, or cancellation/deletion of another session's build on failure.
    return {
      buildRef: `${cfg.buildNamespace}/${exact.metadata.name}`,
      imageRef: exact.status.latestImage, requestedTag: tag, phases: [], reused: true,
    };
  }
  // A different revision can still supply cached dependency/launch layers.
  if (completed.length) body.spec.lastBuild = { image: completed[0].status.latestImage };
  await waitForCheckPool(config);
  const { custom } = getClients();
  const createDeadline = Date.now() + 60000;
  while (true) {
    try {
      await custom.createNamespacedCustomObject({ group: 'kpack.io', version: 'v1alpha2', namespace: cfg.buildNamespace, plural: 'builds', body });
      break;
    } catch (err) {
      if (err?.code !== 409 && err?.response?.statusCode !== 409) {
        err.buildFailed = true;
        err.buildLog = boundedText(err.message);
        err.message = boundedText(err.message);
        throw err;
      }
      // Background GC may still be removing a Build pruned just before this
      // deployment acquired its lock. Never reuse a terminating object.
      const existing = await readBuild(config, buildName).catch((readErr) => {
        if (isNotFound(readErr)) return null;
        throw readErr;
      });
      if (existing && !existing.metadata?.deletionTimestamp) break;
      if (Date.now() >= createDeadline) throw new Error(`Timed out waiting to recreate kpack Build ${buildName}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    const result = await waitForBuild(config, buildName, { onProgress });
    return {
      buildRef: `${cfg.buildNamespace}/${buildName}`, imageRef: result.status.latestImage, requestedTag: tag,
      phases: result.phases || null,
    };
  } catch (err) {
    await deleteBuild(config, buildName).catch((cleanupErr) => {
      log.warn('kubernetes', 'Failed kpack Build cleanup failed', {
        buildName, err: cleanupErr.message,
      });
    });
    throw err;
  }
}

// The kpack pod runs the buildpack lifecycle as init containers, in order
// (prepare, analyze, detect, restore, build, export on current kpack), each
// with its own start and finish stamps. That is the whole per-phase timing,
// read straight off the pod: no log parsing is needed for the phases, only
// for the `detail` line.
function buildPhasesFromPod(pod) {
  const spec = (pod && pod.spec && Array.isArray(pod.spec.initContainers)) ? pod.spec.initContainers : [];
  const statuses = (pod && pod.status && Array.isArray(pod.status.initContainerStatuses)) ? pod.status.initContainerStatuses : [];
  const byName = new Map(statuses.map((s) => [s.name, s]));
  const phases = [];
  let phase = null;
  let runningSince = null;
  for (const c of spec) {
    const st = byName.get(c.name) || {};
    const t = st.state && st.state.terminated;
    const r = st.state && st.state.running;
    if (t) {
      const ms = Date.parse(t.finishedAt) - Date.parse(t.startedAt);
      phases.push({ name: c.name, ms: Number.isFinite(ms) ? Math.max(0, ms) : null });
    } else if (r && !phase) {
      phase = c.name;
      runningSince = r.startedAt || null;
    }
  }
  if (!phase) {
    const main = (pod && pod.status && Array.isArray(pod.status.containerStatuses)) ? pod.status.containerStatuses[0] : null;
    if (main && main.state && main.state.running) phase = main.name || 'completion';
    else if (spec.length && phases.length === spec.length) phase = 'completion';
    else if (spec.length) phase = spec[0].name; // scheduled, nothing running yet
  }
  return { phase, phases, runningSince, order: spec.map((c) => c.name) };
}

async function waitForBuild(config, name, { onProgress = null } = {}) {
  const cfg = config.kubernetes;
  const deadline = Date.now() + (cfg.activeDeadlineSeconds + 60) * 1000;
  const clients = getClients();
  const { custom, core } = clients;
  const report = typeof onProgress === 'function';
  let lastBuild = null;
  let image = { phase: null, phases: [], detail: null };
  let followed = null;
  let followAbort = null;
  const stopFollow = () => {
    if (followAbort && typeof followAbort.abort === 'function') { try { followAbort.abort(); } catch { /* closed */ } }
    followAbort = null;
    followed = null;
  };
  const emit = () => { if (report) { try { onProgress({ ...image, phases: image.phases.slice() }); } catch { /* observer only */ } } };
  // The running phase's log, followed, for the `detail` line. Re-attached
  // when the running phase changes (kpack runs them one after another).
  const followPhase = async (podName, phase) => {
    if (!report || !core || !podName || !phase || phase === followed) return;
    const logApi = clientsLogApi(clients);
    if (!logApi) return;
    stopFollow();
    try {
      const sink = new stream.PassThrough();
      attachLineObserver(sink, (line) => {
        const text = log.redactString(String(line || '').replace(/\x1b\[[0-9;]*m/g, '')).trim();
        if (!text) return;
        image.detail = text.length > 160 ? `${text.slice(0, 157)}...` : text;
        emit();
      });
      followAbort = await logApi.log(cfg.buildNamespace, podName, phase, sink, { follow: true });
      followed = phase;
    } catch { /* not started yet; next tick */ }
  };
  const observe = async (build) => {
    if (!report || !core) return;
    const podName = build.status && build.status.podName;
    if (!podName) return;
    try {
      const pod = await core.readNamespacedPod({ name: podName, namespace: cfg.buildNamespace });
      const derived = buildPhasesFromPod(pod);
      const phaseChanged = derived.phase !== image.phase;
      image = { ...image, phase: derived.phase, phases: derived.phases, ...(phaseChanged ? { detail: null } : {}) };
      emit();
      if (derived.phase && derived.phase !== 'completion') await followPhase(podName, derived.phase);
    } catch { /* progress is best-effort */ }
  };
  try {
    while (Date.now() < deadline) {
      const build = await custom.getNamespacedCustomObject({ group: 'kpack.io', version: 'v1alpha2', namespace: cfg.buildNamespace, plural: 'builds', name });
      lastBuild = build;
      const succeeded = build.status?.conditions?.find((condition) => condition.type === 'Succeeded');
      if (succeeded?.status === 'True' && build.status?.latestImage) {
        await observe(build);
        return { ...build, phases: image.phases.length ? image.phases : null };
      }
      if (succeeded?.status === 'False') {
        const err = new Error(`kpack Build ${name} failed: ${succeeded.message || succeeded.reason || 'unknown error'}`);
        if (succeeded.reason === 'DeadlineExceeded') {
          err.killed = true;
          err.buildTimeoutSeconds = cfg.activeDeadlineSeconds;
        }
        throw err;
      }
      await observe(build);
      // One status read a second: each kpack phase boundary and the final
      // Succeeded flip used to wait up to 3s to be noticed, ~2s on average
      // over a build, for a read that costs the API server nothing.
      await new Promise((resolve) => setTimeout(resolve, BUILD_POLL_MS));
    }
    const err = new Error(`Timed out waiting for kpack Build ${name}`);
    err.killed = true;
    err.buildTimeoutSeconds = cfg.activeDeadlineSeconds + 60;
    throw err;
  } catch (err) {
    // This error crosses the same persistence/reporting boundary as Docker's
    // buildFailed/buildLog contract. Capture the lifecycle Pod before createBuild
    // removes the failed Build and Kubernetes garbage-collects its Pod.
    const podName = lastBuild?.status?.podName;
    const diagnostics = podName
      ? await collectPodDiagnostics(core, { namespace: cfg.buildNamespace, podName, container: null })
      : { logs: '', details: '', unavailable: 'Build did not expose a Pod name' };
    if (diagnostics.deadlineExceeded) {
      err.killed = true;
      err.buildTimeoutSeconds = cfg.activeDeadlineSeconds;
    }
    err.buildFailed = true;
    err.buildRef = `${cfg.buildNamespace}/${name}`;
    err.message = boundedText(err.message);
    err.buildLog = boundedText([err.message, diagnostics.details, diagnostics.logs].filter(Boolean).join('\n'));
    if (diagnostics.unavailable) log.warn('kubernetes', 'Build failure diagnostics incomplete', {
      buildRef: err.buildRef, detail: diagnostics.unavailable,
    });
    throw err;
  } finally {
    stopFollow();
  }
}

function appResourceName(app, environment, sessionId) {
  return dnsName(environment === 'production' ? `sv-app-${app.id}-${app.slug}` : `sv-preview-${app.id}-s${sessionId}`);
}

function podSecurityContext() {
  return { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } };
}

function nodePodSecurityContext() {
  return {
    ...podSecurityContext(),
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
  };
}

function containerSecurityContext() {
  return { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: false };
}

// Previews and apps prefer to run in the CNPG primary's zone. A page makes
// many sequential queries, so a pod in another data centre pays that round
// trip on every one: previews that landed in Falkenstein while the database
// ran in Helsinki took a third longer to check, and 8 of 10 runs there failed
// 60 to 240 checks on data that arrived too late (2026-10-01, sessions 5588,
// 5664 and 5674).
//
// The preference stops at the zone. A second term for the primary's own HOST
// saves nothing a page can measure inside one data centre, and it piled the
// fleet onto one node: on 2026-10-12 that node ran 100 of 209 app pods at the
// kubelet's 110-pod limit while its three zone neighbours ran 25 to 43, so
// losing it would have taken the database primary and half the apps together.
//
// It is a preference, so other eligible nodes stay available when the zone
// is full. A node without `topology.kubernetes.io/zone` matches no zone, so
// a cluster whose nodes carry no zone labels gets normal placement.
// Select the primary role, not a Pod/node name, so new scheduling follows
// CNPG failover without moving already-running pods.
function databaseAffinity(cfg, environment) {
  if (environment !== 'staging' && environment !== 'production') return {};
  if (!cfg.previewDatabaseNamespace || !cfg.previewDatabaseCluster) return {};
  const primary = {
    namespaces: [cfg.previewDatabaseNamespace],
    labelSelector: { matchLabels: {
      'cnpg.io/cluster': cfg.previewDatabaseCluster,
      'cnpg.io/instanceRole': 'primary',
    } },
  };
  return {
    affinity: {
      podAffinity: {
        preferredDuringSchedulingIgnoredDuringExecution: [
          { weight: 100, podAffinityTerm: { ...primary, topologyKey: 'topology.kubernetes.io/zone' } },
        ],
      },
    },
  };
}

// The app's ready Pod, for the deploy log (the node it was scheduled on) and
// for the creation timing (podStartTimeline). Best effort: a lookup that
// fails or finds no ready Pod returns null and never fails the deploy that
// just succeeded.
async function findReadyAppPod(core, namespace, name, imageRef) {
  try {
    const pods = await core.listNamespacedPod({ namespace,
      labelSelector: `social.usernode.io/runtime-name=${name}` });
    return (pods?.items || []).find((item) => !item.metadata?.deletionTimestamp
      && item.spec?.nodeName
      && item.spec?.containers?.some((c) => c.name === 'app' && c.image === imageRef)
      && item.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')) || null;
  } catch {
    return null;
  }
}

// How a Pod's start was spent, from its own status (#4895): placed on a node
// (PodScheduled), its app container running (the image pulled and the
// container created), and Ready (the app booted and its /health answered
// the probes). Whole seconds, as the API keeps them. Null when any of the
// four stamps is missing, e.g. a Pod that restarted since.
function podStartTimeline(pod) {
  const at = (value) => {
    const t = Date.parse(value || '');
    return Number.isFinite(t) ? t : null;
  };
  const condition = (type) => at(pod?.status?.conditions
    ?.find((c) => c.type === type && c.status === 'True')?.lastTransitionTime);
  const created = at(pod?.metadata?.creationTimestamp);
  const scheduled = condition('PodScheduled');
  const ready = condition('Ready');
  const app = (pod?.status?.containerStatuses || []).find((c) => c.name === 'app');
  const started = at(app?.state?.running?.startedAt);
  if ([created, scheduled, started, ready].some((t) => t == null) || app?.restartCount) return null;
  return {
    scheduleMs: Math.max(0, scheduled - created),
    startMs: Math.max(0, started - scheduled),
    readyMs: Math.max(0, ready - started),
  };
}

// ── Platform assets on every app's own origin ─────────────────────────
//
// The bridge, the native kit and the Tailwind runtime are centrally hosted:
// every app loads all three from the platform. Apps have historically named
// the platform's HOSTNAME to do it, which is what makes a domain move break
// the whole fleet at once: the last one left every app scaffolded before it
// still requesting these three files from the previous hostname, which no
// longer answers, so they lost the bridge, the kit and their styling
// together.
//
// Serving the same three prefixes on the app's OWN hostname lets an app
// reference them at a relative path and carry no hostname at all. The
// backend is a small Deployment of the platform's own image running
// scripts/serve-platform-assets.js, in the generated-app namespace: an
// Ingress backend must be a Service in the SAME namespace as the Ingress,
// and the platform runs in its own. That script's header has the rest.
const PLATFORM_ASSET_PREFIXES = Object.freeze([
  '/usernode-bridge/', '/usernode-native/', '/usernode-tailwind/',
]);
const PLATFORM_ASSET_NAME = 'usernode-platform-assets';
const PLATFORM_ASSET_MANAGED_BY = 'social-vibecoding-platform-assets';

// Deliberately NOT the runtime's own managed-by value: listStatusResources
// selects on it to enumerate APP deployments, and this is not an app — it
// would show up in the admin status list as a phantom one, with no app-id
// or session-id label for normalizeDeployment to read.
function platformAssetLabels() {
  return {
    'app.kubernetes.io/part-of': PART_OF,
    'app.kubernetes.io/name': PLATFORM_ASSET_NAME,
    'app.kubernetes.io/managed-by': PLATFORM_ASSET_MANAGED_BY,
  };
}

// Pure, so the shape can be asserted without a cluster. The asset prefixes
// come FIRST and the catch-all last; the Ingress spec resolves overlapping
// Prefix rules by longest match, so order is belt-and-braces rather than
// the mechanism. `assetBackend` false omits them entirely, which is what
// keeps an asset-backend failure from changing how an app itself is routed.
function appIngressManifest({ name, namespace, hostname, resourceLabels, cfg, assetBackend, gateBackend = null }) {
  const assetPaths = assetBackend ? PLATFORM_ASSET_PREFIXES.map((prefix) => ({
    path: prefix,
    pathType: 'Prefix',
    backend: { service: { name: PLATFORM_ASSET_NAME, port: { number: 3000 } } },
  })) : [];
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: {
      name, namespace, labels: resourceLabels,
      // TLS belongs to the installation, not the disposable app/preview.
      // No issuer annotation: ingress-shim must not create per-host certificates.
      annotations: {},
    },
    spec: {
      ingressClassName: cfg.ingressClassName,
      rules: [{ host: hostname, http: { paths: [
        ...assetPaths,
        // Everything else goes to the app, through the app-host gate when it
        // is on (APP_GATE; scripts/app-gate.js), straight to the app's own
        // Service when it is off.
        { path: '/', pathType: 'Prefix', backend: { service: { name: gateBackend || name, port: { number: 3000 } } } },
      ] } }],
      tls: [{ hosts: [hostname], secretName: cfg.appTlsSecretName || 'social-apps-wildcard-tls' }],
    },
  };
}

// Env for the shared asset server: only what platform.json says, so the
// container still holds none of the platform's configuration.
function platformAssetEnv(config) {
  const cfg = config?.kubernetes || {};
  return [
    { name: 'USERNODE_DOMAIN', value: String(cfg.platformDomain || '') },
    { name: 'USERNODE_APPS_DOMAIN', value: String(cfg.appDomain || cfg.platformDomain || '') },
    // Only while apps move (services/apps-domain-move.js): the waking page
    // still knows a preview at the old domain. Absent otherwise, so nothing
    // rolls the asset server when nothing is moving.
    ...(cfg.legacyAppDomain ? [{ name: 'USERNODE_LEGACY_APPS_DOMAIN', value: String(cfg.legacyAppDomain) }] : []),
    // Only once previews have a domain of their own (services/previews-domain.js).
    ...(cfg.previewDomain ? [{ name: 'USERNODE_PREVIEWS_DOMAIN', value: String(cfg.previewDomain) }] : []),
    { name: 'MARKETING_BASE_URL', value: String(config?.marketingBaseUrl || '') },
    // Offline apps (services/offline-cache.js): how the shared files are cached.
    { name: 'APP_OFFLINE_CACHE', value: require('./offline-cache').enabled() ? 'on' : 'off' },
  ];
}

function platformAssetPath(prefix) {
  return {
    path: prefix,
    pathType: 'Prefix',
    backend: { service: { name: PLATFORM_ASSET_NAME, port: { number: 3000 } } },
  };
}

function isSelfAppIngressHost(hostname, config) {
  const slug = String(config?.selfAppSlug || '');
  const appDomain = String(config?.kubernetes?.appDomain || '');
  const previewDomain = String(config?.kubernetes?.previewDomain || '');
  const host = String(hostname || '');
  if (!slug || !appDomain) return false;
  const isPreview = (label) => label.startsWith(`${slug}--s`) && /^\d+$/.test(label.slice(`${slug}--s`.length));
  // A preview on its own domain (services/previews-domain.js), or one not
  // rebuilt since, still on the apps domain.
  if (previewDomain && host.endsWith(`.${previewDomain}`)) {
    return isPreview(host.slice(0, -(previewDomain.length + 1)));
  }
  if (!host.endsWith(`.${appDomain}`)) return false;
  const appLabel = host.slice(0, -(appDomain.length + 1));
  return appLabel === slug || isPreview(appLabel);
}

// Heal Ingresses that predate the shared asset backend. A recheck reuses a
// healthy preview rather than redeploying it, so relying only on
// deployApplication's Ingress upsert leaves those previews permanently on
// their old catch-all route. Preserve every unrelated rule/path verbatim,
// replace only our exact three prefixes, and strip them from the self app:
// its preview must serve the asset bytes from the revision under review.
function ingressWithPlatformAssetRoutes(ingress, config) {
  let changed = false;
  const rules = (ingress?.spec?.rules || []).map((rule) => {
    if (!rule?.http || !Array.isArray(rule.http.paths)) return rule;
    const selfApp = isSelfAppIngressHost(rule.host, config);
    const kept = rule.http.paths.filter((item) =>
      !PLATFORM_ASSET_PREFIXES.includes(item?.path)
    );
    const paths = selfApp
      ? kept
      : [...PLATFORM_ASSET_PREFIXES.map(platformAssetPath), ...kept];
    if (JSON.stringify(paths) === JSON.stringify(rule.http.paths)) return rule;
    changed = true;
    return { ...rule, http: { ...rule.http, paths } };
  });
  if (!changed) return null;
  return { ...ingress, spec: { ...ingress.spec, rules } };
}

async function reconcilePlatformAssetIngresses(config) {
  const cfg = config.kubernetes;
  const namespace = cfg.appNamespace;
  const { networking } = getClients();
  // Test doubles and non-runtime callers may provide only the APIs they
  // exercise. A real Kubernetes client always exposes both methods.
  if (!networking?.listNamespacedIngress || !networking?.replaceNamespacedIngress) return 0;
  const listed = await networking.listNamespacedIngress({
    namespace,
    labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY}`,
  });
  let updated = 0;
  for (const ingress of listed.items || []) {
    if (ingress?.metadata?.labels?.['app.kubernetes.io/managed-by'] !== MANAGED_BY) continue;
    const body = ingressWithPlatformAssetRoutes(ingress, config);
    const name = ingress?.metadata?.name;
    if (!body || !name) continue;
    try {
      await networking.replaceNamespacedIngress({ name, namespace, body });
    } catch (err) {
      // Written since the list: a deploy routed it while this ran (see
      // platformAssetBackendForDeploy). That write is the newer one, so
      // leave it and go on with the rest rather than abandon them all.
      if (!isConflict(err)) throw err;
      continue;
    }
    updated += 1;
  }
  return updated;
}

// Memoised for the life of the process, which is the right window rather
// than just a convenience: the image is read from the RUNNING platform
// Deployment, and a platform rollout replaces this process, so the next one
// re-reads it and the assets track the platform's own version — the
// fleet-wide fix central hosting is for. Without the memo this would add
// three API calls to every app deploy and every preview build.
let platformAssetBackend = null;
// After a failed reconcile, stop trying for a while. Clearing the memo alone
// means the NEXT app deploy pays the readiness wait again, and the one after
// that — so a backend that cannot come up (a bad launch command, an image
// that will not start) would add that wait to every deploy on the platform
// rather than costing it once. Routing is the thing being delayed here, and
// no app needs it urgently enough to be worth that.
let platformAssetBackendRetryAfter = 0;
// Set once this process's reconcile has finished, so a deploy after that
// awaits the settled memo and reads nothing (platformAssetBackendForDeploy).
let platformAssetBackendReady = false;

async function ensurePlatformAssetBackend(config, { readyTimeoutMs = 45000, retryAfterMs = 300000 } = {}) {
  if (platformAssetBackend) return platformAssetBackend;
  // Still cooling off from a failure: no backend, and crucially no wait.
  if (Date.now() < platformAssetBackendRetryAfter) return null;
  platformAssetBackendReady = false;
  platformAssetBackend = (async () => {
    const cfg = config.kubernetes;
    const namespace = cfg.appNamespace;
    const { core, apps } = getClients();

    const platform = await apps.readNamespacedDeployment({
      namespace: cfg.platformNamespace || 'social-platform',
      name: cfg.platformDeployment || 'social-vibecoding',
    });
    const containers = platform?.spec?.template?.spec?.containers || [];
    const image = (containers.find((c) => c.name === 'platform') || containers[0] || {}).image;
    if (!image) throw new Error('platform Deployment exposes no container image');

    const resourceLabels = platformAssetLabels();
    const selectorLabels = { 'social.usernode.io/runtime-name': PLATFORM_ASSET_NAME };

    await upsert(core, 'readNamespacedService', 'createNamespacedService', 'replaceNamespacedService', namespace, {
      apiVersion: 'v1', kind: 'Service', metadata: { name: PLATFORM_ASSET_NAME, namespace, labels: resourceLabels },
      spec: { selector: selectorLabels, ports: [{ name: 'http', port: 3000, targetPort: 3000 }], type: 'ClusterIP' },
    });

    await upsert(apps, 'readNamespacedDeployment', 'createNamespacedDeployment', 'replaceNamespacedDeployment', namespace, {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: PLATFORM_ASSET_NAME, namespace, labels: resourceLabels },
      spec: {
        // Two, with maxUnavailable 0: this sits on the critical path of
        // every app's page load, so a single-replica restart would be a
        // fleet-wide gap in styling and in the bridge.
        replicas: 2,
        strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
        selector: { matchLabels: selectorLabels },
        template: {
          metadata: { labels: { ...resourceLabels, ...selectorLabels } },
          spec: {
            serviceAccountName: cfg.generatedAppServiceAccount,
            automountServiceAccountToken: false,
            // Dockerfile.kubernetes runs as UID 1000; keep the explicit pod
            // identity aligned with it for the shared asset backend.
            securityContext: nodePodSecurityContext(),
            containers: [{
              name: 'assets', image, imagePullPolicy: 'IfNotPresent',
              // The platform's node:22-alpine image provides Node on PATH.
              // The CNB launcher belongs to kpack-built child-app images.
              command: ['node', 'scripts/serve-platform-assets.js'],
              // The three public facts behind /usernode-bridge/v1/platform.json
              // (src/services/app-host-config.js): where the platform is, the
              // apps domain, and the site's front door. Nothing secret.
              env: platformAssetEnv(config),
              ports: [{ name: 'http', containerPort: 3000 }],
              ...httpProbes({ startupFailureThreshold: 60 }),
              resources: { requests: { cpu: '25m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
              securityContext: containerSecurityContext(),
            }],
          },
        },
      },
    });

    // Only now is it safe to route to it. Publishing the Ingress paths on
    // an upsert that merely SUCCEEDED is what turned a broken backend into a
    // 503 on every asset path — strictly worse than not routing at all,
    // because the app itself can no longer serve those paths either. If it
    // never becomes ready this throws, the caller logs, and the app deploys
    // with exactly its previous routing.
    await waitForDeployment(namespace, PLATFORM_ASSET_NAME, { timeoutMs: readyTimeoutMs });
    // The backend is now safe to route to. Reconcile old app/preview
    // Ingresses as well as the one deployApplication is about to upsert;
    // otherwise an unchanged preview can be rechecked forever without ever
    // receiving the new routes. Best-effort so an RBAC/list failure cannot
    // withhold the known-ready backend from the current deployment.
    await reconcilePlatformAssetIngresses(config).catch((err) => {
      log.warn('kubernetes', 'existing platform asset routes could not be reconciled', {
        namespace, error: err?.message,
      });
    });
    platformAssetBackendReady = true;
    return PLATFORM_ASSET_NAME;
  })().catch((err) => {
    // Clear the memo so the next deploy retries rather than this process
    // serving apps without asset routing until it restarts.
    platformAssetBackend = null;
    platformAssetBackendRetryAfter = Date.now() + retryAfterMs;
    throw err;
  });
  return platformAssetBackend;
}

// Whether a shared backend in the app namespace (the asset backend, the app
// gate) serves right now: its Service is there and selects its pods, and its
// Deployment has a replica that is ready and available. Two reads. Any
// error, or anything missing, is "not serving".
//
// An older revision's replicas count. Both Deployments roll with
// maxUnavailable 0, so while a new revision fails to start the old one keeps
// answering, and every app already routed to it is being served by them.
async function sharedBackendServing(config, name) {
  const namespace = config.kubernetes.appNamespace;
  const { core, apps } = getClients();
  if (typeof core?.readNamespacedService !== 'function' || typeof apps?.readNamespacedDeployment !== 'function') return false;
  try {
    const [service, deployment] = await Promise.all([
      core.readNamespacedService({ name, namespace }),
      apps.readNamespacedDeployment({ name, namespace }),
    ]);
    if (!service?.metadata || service.metadata.deletionTimestamp) return false;
    if (service.spec?.selector?.['social.usernode.io/runtime-name'] !== name) return false;
    if (!deployment?.metadata || deployment.metadata.deletionTimestamp) return false;
    if ((deployment.spec?.replicas ?? 1) < 1) return false;
    const status = deployment.status || {};
    return (status.readyReplicas || 0) >= 1 && (status.availableReplicas || 0) >= 1;
  } catch {
    return false;
  }
}

// KUBERNETES_ASSET_BACKEND_WAIT (config.kubernetes.assetBackendWait):
// `serving` (the default) lets a deploy route to a shared backend that
// already serves without waiting for its reconcile; `always` waits, as
// every deploy did before.
function sharedBackendWaitAlways(config) {
  return String(config?.kubernetes?.assetBackendWait || 'serving').trim().toLowerCase() === 'always';
}

// A shared backend for one deploy. `ensure()` is its memoised reconcile;
// `settled` and `coolingOff` are read from its memo BEFORE calling it.
//
// The reconcile's first run in a process upserts the backend with the
// platform's image, waits for that rollout and (for the assets) rewrites
// every app Ingress: 20-30 s. Platform pods restart on every release and
// new apps are rare, so nearly every new app's deploy was the first in its
// process and waited for all of it (19 Oct 2026: a pod's first app deploy
// 19 s, its second 0 s). So when the backend already serves, this deploy is
// routed to it at once and the reconcile goes on behind it, its failure
// logged. When it does not serve, the deploy waits for the reconcile
// exactly as before: routing to a backend that is not up is the 503 on every
// asset path of #2045. When the memo has settled, is cooling off, or
// KUBERNETES_ASSET_BACKEND_WAIT is `always`, the memo answers, as before.
async function sharedBackendForDeploy(config, { name, ensure, settled, coolingOff, app }) {
  const reconcile = ensure();
  if (settled || coolingOff || sharedBackendWaitAlways(config)) return reconcile;
  if (!(await sharedBackendServing(config, name))) return reconcile;
  reconcile.catch((err) => {
    log.warn('kubernetes', 'shared backend reconcile failed behind a deploy routed to it while it served', {
      backend: name, app: app?.slug, error: err?.message,
    });
  });
  return name;
}

function platformAssetBackendForDeploy(config, app) {
  return sharedBackendForDeploy(config, {
    name: PLATFORM_ASSET_NAME, app,
    ensure: () => ensurePlatformAssetBackend(config),
    settled: Boolean(platformAssetBackend) && platformAssetBackendReady,
    coolingOff: !platformAssetBackend && Date.now() < platformAssetBackendRetryAfter,
  });
}

// ── The app-host gate (#3657) ────────────────────────────────────────────
//
// On the standalone deployment Caddy forward_auths every app-host request
// to the platform (GET /__caddy/access). Cilium's Envoy has no such hook, so
// on Kubernetes the gate is a small proxy Deployment of the platform's own
// image in the app namespace (scripts/app-gate.js): each app Ingress's
// catch-all path points at it, it asks the platform about each request, and
// passes what is allowed on to the app's Service. The asset prefixes keep
// going straight to the asset backend.
//
// APP_GATE (config.kubernetes.appGate) is the switch, and it is OFF unless
// set: turning it on needs the app namespace's network policy to let the
// gate's pods (app.kubernetes.io/name=usernode-app-gate) reach the app pods
// and the platform Service, which this repository does not manage. `on`
// brings the gate up, waits for it, then repoints every managed Ingress;
// `off` repoints them all back to their own Services. Both run at platform
// boot (leader) and on every deploy, so the env var is the source of truth;
// scripts/app-gate-switch.js applies either mode immediately in an incident.
const APP_GATE_NAME = 'usernode-app-gate';
const APP_GATE_MANAGED_BY = 'social-vibecoding-app-gate';
const APP_GATE_HEALTH_PATH = '/__usernode_gate/health';

function appGateMode(config) {
  return String(config?.kubernetes?.appGate || 'off').trim().toLowerCase() === 'on' ? 'on' : 'off';
}

function appGateLabels() {
  return {
    'app.kubernetes.io/part-of': PART_OF,
    'app.kubernetes.io/name': APP_GATE_NAME,
    'app.kubernetes.io/managed-by': APP_GATE_MANAGED_BY,
  };
}

// Pure, so the shape can be asserted without a cluster.
function appGateDeploymentManifest({ namespace, image, cfg, platformUrl }) {
  const selectorLabels = { 'social.usernode.io/runtime-name': APP_GATE_NAME };
  const labels = appGateLabels();
  const health = { httpGet: { path: APP_GATE_HEALTH_PATH, port: 'http' } };
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: APP_GATE_NAME, namespace, labels },
    spec: {
      // Every app request crosses it: never fewer than two, never both down.
      replicas: 2,
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: { labels: { ...labels, ...selectorLabels } },
        spec: {
          serviceAccountName: cfg.generatedAppServiceAccount,
          automountServiceAccountToken: false,
          securityContext: nodePodSecurityContext(),
          containers: [{
            name: 'gate', image, imagePullPolicy: 'IfNotPresent',
            command: ['node', 'scripts/app-gate.js'],
            // Where to ask, and nothing else: the gate holds no keys and
            // reads no database; the platform decides.
            env: [
              { name: 'GATE_PLATFORM_URL', value: String(platformUrl || '') },
              { name: 'GATE_UPSTREAM_PORT', value: '3000' },
              { name: 'GATE_POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
            ],
            ports: [{ name: 'http', containerPort: 3000 }, { name: 'activity', containerPort: 3001 }],
            startupProbe: { ...health, periodSeconds: 1, failureThreshold: 60 },
            readinessProbe: { ...health, periodSeconds: 2, failureThreshold: 3 },
            livenessProbe: { ...health, periodSeconds: 15, failureThreshold: 3 },
            resources: { requests: { cpu: '100m', memory: '96Mi' }, limits: { cpu: '1', memory: '384Mi' } },
            securityContext: containerSecurityContext(),
          }],
        },
      },
    },
  };
}

let appGateBackend = null;
let appGateBackendRetryAfter = 0;
let appGateBackendReady = false;

// Same memo and cool-off as the asset backend (above), for the same reasons.
async function ensureAppGateBackend(config, { readyTimeoutMs = 60000, retryAfterMs = 300000 } = {}) {
  if (appGateMode(config) !== 'on') return null;
  if (appGateBackend) return appGateBackend;
  if (Date.now() < appGateBackendRetryAfter) return null;
  appGateBackendReady = false;
  appGateBackend = (async () => {
    const cfg = config.kubernetes;
    const namespace = cfg.appNamespace;
    const platformUrl = process.env.PLATFORM_INTERNAL_URL || '';
    if (!platformUrl) throw new Error('PLATFORM_INTERNAL_URL is not set; the app gate has nowhere to ask');
    const { core, apps } = getClients();
    const platform = await apps.readNamespacedDeployment({
      namespace: cfg.platformNamespace || 'social-platform',
      name: cfg.platformDeployment || 'social-vibecoding',
    });
    const containers = platform?.spec?.template?.spec?.containers || [];
    const image = (containers.find((c) => c.name === 'platform') || containers[0] || {}).image;
    if (!image) throw new Error('platform Deployment exposes no container image');
    await upsert(core, 'readNamespacedService', 'createNamespacedService', 'replaceNamespacedService', namespace, {
      apiVersion: 'v1', kind: 'Service', metadata: { name: APP_GATE_NAME, namespace, labels: appGateLabels() },
      spec: {
        selector: { 'social.usernode.io/runtime-name': APP_GATE_NAME },
        ports: [{ name: 'http', port: 3000, targetPort: 3000 }],
        type: 'ClusterIP',
      },
    });
    await upsert(apps, 'readNamespacedDeployment', 'createNamespacedDeployment', 'replaceNamespacedDeployment', namespace,
      appGateDeploymentManifest({ namespace, image, cfg, platformUrl }));
    // Only a gate that answers may carry the apps' traffic.
    await waitForDeployment(namespace, APP_GATE_NAME, { timeoutMs: readyTimeoutMs });
    appGateBackendReady = true;
    return APP_GATE_NAME;
  })().catch((err) => {
    appGateBackend = null;
    appGateBackendRetryAfter = Date.now() + retryAfterMs;
    throw err;
  });
  return appGateBackend;
}

// The gate for one deploy, the way the asset backend is chosen (see
// sharedBackendForDeploy): a gate that already answers takes the app at
// once while its reconcile goes on behind it.
function appGateBackendForDeploy(config, app) {
  return sharedBackendForDeploy(config, {
    name: APP_GATE_NAME, app,
    ensure: () => ensureAppGateBackend(config),
    settled: Boolean(appGateBackend) && appGateBackendReady,
    coolingOff: !appGateBackend && Date.now() < appGateBackendRetryAfter,
  });
}

// The catch-all path of one Ingress, pointed through the gate (`on`) or at
// the app's own Service (`off`: the Ingress and the Service share the
// runtime name, see deployApplication). Every other path is kept verbatim.
// Null when nothing changes.
function ingressWithGateRoute(ingress, mode) {
  const own = ingress?.metadata?.name;
  if (!own) return null;
  // A custom domain's Ingress (#4405) is not named after a Service: the app
  // Service it fronts is in its annotation (customDomainIngressManifest).
  const service = ingress?.metadata?.annotations?.[CUSTOM_DOMAIN_SERVICE_ANNOTATION] || own;
  const target = mode === 'on' ? APP_GATE_NAME : service;
  let changed = false;
  const rules = (ingress?.spec?.rules || []).map((rule) => {
    if (!rule?.http || !Array.isArray(rule.http.paths)) return rule;
    const paths = rule.http.paths.map((item) => {
      if (item?.path !== '/' || !item?.backend?.service) return item;
      const current = item.backend.service.name;
      // Only ever swap between the two names this code writes.
      if (current !== service && current !== APP_GATE_NAME) return item;
      if (current === target) return item;
      changed = true;
      return { ...item, backend: { ...item.backend, service: { ...item.backend.service, name: target } } };
    });
    return changed ? { ...rule, http: { ...rule.http, paths } } : rule;
  });
  if (!changed) return null;
  return { ...ingress, spec: { ...ingress.spec, rules } };
}

// Point every managed app/preview Ingress at the mode's backend. `on` brings
// the gate up first and does nothing if it does not come up; `off` needs
// nothing up. `force` is scripts/app-gate-switch.js's incident override.
async function reconcileAppGateIngresses(config, { force = null } = {}) {
  const mode = force || appGateMode(config);
  if (mode === 'on') {
    const gate = await ensureAppGateBackend(
      force ? { ...config, kubernetes: { ...config.kubernetes, appGate: 'on' } } : config
    );
    if (!gate) return { mode, updated: 0, skipped: 'gate_unavailable' };
  }
  const namespace = config.kubernetes.appNamespace;
  const { networking } = getClients();
  if (!networking?.listNamespacedIngress || !networking?.replaceNamespacedIngress) return { mode, updated: 0 };
  const listed = await networking.listNamespacedIngress({
    namespace,
    labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY}`,
  });
  // Each Ingress on its own: one that changed since the list (a deploy
  // replaced it) is read again and routed, and one that still fails does
  // not leave the rest of the fleet unrouted. Any failure is thrown at the
  // end, so the release's work tries the whole reconcile again.
  let updated = 0;
  const failed = [];
  for (const listedIngress of listed.items || []) {
    if (listedIngress?.metadata?.labels?.['app.kubernetes.io/managed-by'] !== MANAGED_BY) continue;
    const name = listedIngress.metadata.name;
    let ingress = listedIngress;
    for (let attempt = 1; ; attempt += 1) {
      const body = ingressWithGateRoute(ingress, mode);
      if (!body) break;
      try {
        await networking.replaceNamespacedIngress({ name, namespace, body });
        updated += 1;
        break;
      } catch (err) {
        if (isConflict(err) && attempt < UPSERT_CONFLICT_ATTEMPTS && networking.readNamespacedIngress) {
          ingress = await networking.readNamespacedIngress({ name, namespace }).catch(() => null);
          if (ingress) continue;
        }
        if (isNotFound(err)) break;
        failed.push({ name, message: err.message });
        break;
      }
    }
  }
  if (failed.length) {
    throw Object.assign(new Error(`${failed.length} Ingress(es) not routed: ${failed.slice(0, 3).map((f) => `${f.name} (${f.message})`).join(', ')}`), { updated });
  }
  return { mode, updated };
}

// Apps and previews moving to another domain (USERNODE_LEGACY_APPS_DOMAIN,
// services/apps-domain-move.js). Pure: the Ingress with every
// `<label>.<from>` host, in its rules and its TLS, now `<label>.<to>`, or
// null when it names none. A label is one DNS label (an app's slug or a
// preview's `<slug>--s<id>`), so nothing nested under the old domain moves.
function ingressOnAppsDomain(ingress, from, to) {
  if (!ingress?.spec || !from || !to || from === to) return null;
  const suffix = `.${from}`;
  let changed = false;
  const move = (host) => {
    const name = String(host || '').toLowerCase();
    if (!name.endsWith(suffix)) return host;
    const label = name.slice(0, -suffix.length);
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return host;
    changed = true;
    return `${label}.${to}`;
  };
  const rules = (ingress.spec.rules || []).map((rule) => ({ ...rule, host: move(rule.host) }));
  const tls = (ingress.spec.tls || []).map((entry) => ({ ...entry, hosts: (entry.hosts || []).map(move) }));
  if (!changed) return null;
  return { ...ingress, spec: { ...ingress.spec, rules, ...(ingress.spec.tls ? { tls } : {}) } };
}

// Move every production app Ingress still on the old apps domain to the
// current one. A preview's address is its machine's (staging_url) and moves
// on its next build; a custom domain's Ingress is the person's own host and
// never on either. Like the gate's pass: each Ingress on its own, one that
// changed since the list read again, and any failure thrown at the end so
// the next run tries again. The wildcard certificate covers both domains
// while the move runs (the foundation's runtime.appTls.dnsNames).
async function reconcileAppsDomainIngresses(config, { from, to }) {
  const namespace = config.kubernetes.appNamespace;
  const { networking } = getClients();
  if (!networking?.listNamespacedIngress || !networking?.replaceNamespacedIngress) return { updated: 0 };
  const listed = await networking.listNamespacedIngress({
    namespace,
    labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY}`,
  });
  let updated = 0;
  const failed = [];
  for (const listedIngress of listed.items || []) {
    if (listedIngress?.metadata?.labels?.['app.kubernetes.io/managed-by'] !== MANAGED_BY) continue;
    if (listedIngress?.metadata?.labels?.[CUSTOM_DOMAIN_ID_LABEL]) continue;
    if (listedIngress?.metadata?.labels?.['social.usernode.io/environment'] !== 'production') continue;
    const name = listedIngress.metadata.name;
    let ingress = listedIngress;
    for (let attempt = 1; ; attempt += 1) {
      const body = ingressOnAppsDomain(ingress, from, to);
      if (!body) break;
      try {
        await networking.replaceNamespacedIngress({ name, namespace, body });
        updated += 1;
        break;
      } catch (err) {
        if (isConflict(err) && attempt < UPSERT_CONFLICT_ATTEMPTS && networking.readNamespacedIngress) {
          ingress = await networking.readNamespacedIngress({ name, namespace }).catch(() => null);
          if (ingress) continue;
        }
        if (isNotFound(err)) break;
        failed.push({ name, message: err.message });
        break;
      }
    }
  }
  if (failed.length) {
    throw Object.assign(new Error(`${failed.length} Ingress(es) not moved: ${failed.slice(0, 3).map((f) => `${f.name} (${f.message})`).join(', ')}`), { updated });
  }
  return { updated };
}

// `cpus` is the container's CPU LIMIT (a ceiling, not a request — requests
// stay at 100m so scheduling is unchanged). Staging previews pass
// docker.STAGING_CPUS through application-runtime.deploy so the capture
// run's eight concurrent pages get the same headroom on both runtimes;
// production apps pass nothing and keep the 1-CPU limit they always had.
async function deployApplication(config, {
  app, environment, sessionId, imageRef, env, cpus = null,
  labels: extraLabels = {}, runtimeName = null, internalOnly = false,
  command = [], runAsUser = null, onRollout = null, attempt = null, servingAttempt = null, claim = 0,
}) {
  if (!imageRef?.includes('@sha256:')) throw new Error('Kubernetes deployments require an immutable image digest');
  if (attempt != null && (!Number.isSafeInteger(attempt) || attempt <= 0 || environment === 'production')) {
    throw new Error('A preview attempt must be a positive integer on a preview');
  }
  // runAsUser is an explicit override for an image that names no user and
  // so would run as root; nothing sets it unless the caller asks. The pod
  // still runs with runAsNonRoot, so 0 is refused here, not by the kubelet.
  if (runAsUser != null && (!Number.isSafeInteger(runAsUser) || runAsUser <= 0)) {
    throw new Error('Kubernetes runAsUser must be a positive integer');
  }
  if (!Array.isArray(command) || command.some((part) => typeof part !== 'string' || !part)) {
    throw new Error('Kubernetes container command must be an array of non-empty strings');
  }
  const cfg = config.kubernetes;
  const namespace = cfg.appNamespace;
  const name = runtimeName || appResourceName(app, environment, sessionId);
  if (name !== dnsName(name) || name.length > 63) throw new Error('Invalid Kubernetes runtime name');
  const resourceLabels = { ...extraLabels, ...labels({ appId: app.id, sessionId, environment }) };
  const selectorLabels = { 'social.usernode.io/runtime-name': name };
  // Service endpoints must come from this data-policy generation, including
  // while RollingUpdate still has the old ReplicaSet alive. The Deployment
  // selector stays immutable so an existing preview can roll forward.
  const dataPolicyLabel = require('./platform-preview-data-policy').LABEL;
  const serviceSelector = extraLabels[dataPolicyLabel]
    ? { ...selectorLabels, [dataPolicyLabel]: extraLabels[dataPolicyLabel] } : selectorLabels;
  const secretName = attempt ? attemptSecretName(name, attempt) : withSuffix(name, 'env');
  const hostname = environment === 'production'
    ? `${app.slug}.${cfg.appDomain}`
    : `${app.slug}--s${sessionId}.${cfg.previewDomain || cfg.appDomain}`;
  // Check before creating or updating any Kubernetes resources.
  require('./caddy').assertAppHostname(hostname, cfg.platformDomain);
  const resourceProfile = require('./app-resource-profiles').forApp(config, app, environment, { cpus, internalOnly });
  const { core, apps, networking } = getClients();
  // The Deployment as this attempt found it (the fence). When its rollout
  // fails, what goes back is the template of the attempt that serves
  // (`servingAttempt`), which need not be this one: a cancelled candidate
  // may have written it since (attempts only; [main] deletes the preview).
  let previous = null;
  if (attempt) {
    previous = await readFencedDeployment(apps, namespace, name, attempt, claim);
  }

  const secretBody = {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: secretName, namespace, labels: resourceLabels },
    type: 'Opaque', stringData: Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)])),
  };
  if (attempt) await writeFencedSecret(core, namespace, secretBody, attempt, claim);
  else await upsert(core, 'readNamespacedSecret', 'createNamespacedSecret', 'replaceNamespacedSecret', namespace, secretBody);
  await upsert(core, 'readNamespacedService', 'createNamespacedService', 'replaceNamespacedService', namespace, {
    apiVersion: 'v1', kind: 'Service', metadata: { name, namespace, labels: resourceLabels },
    spec: { selector: serviceSelector, ports: [{ name: 'http', port: 3000, targetPort: 3000 }], type: 'ClusterIP' },
  });
  const deploymentBody = {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace, labels: resourceLabels,
      ...(attempt ? { annotations: { [PREVIEW_ATTEMPT_ANNOTATION]: fenceValue(attempt, claim) } } : {}) },
    spec: {
      replicas: 1,
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: {
          labels: { ...resourceLabels, ...selectorLabels },
          annotations: {
            'social.usernode.io/env-checksum': envChecksum(env),
            [require('./app-resource-profiles').ANNOTATION]: resourceProfile.profile,
          },
        },
        spec: {
          serviceAccountName: cfg.generatedAppServiceAccount,
          automountServiceAccountToken: false,
          securityContext: runAsUser == null
            ? podSecurityContext()
            : { ...podSecurityContext(), runAsUser, runAsGroup: runAsUser },
          ...databaseAffinity(cfg, environment),
          containers: [{
            name: 'app', image: imageRef, imagePullPolicy: 'IfNotPresent',
            ...(command.length ? { command } : {}),
            ports: [{ name: 'http', containerPort: 3000 }],
            env: app.slug === config.selfAppSlug
              ? [{ name: 'USERNODE_SHELL_ASSETS_PREBUILT', value: '1' }]
              : [],
            envFrom: [{ secretRef: { name: secretName } }],
            ...httpProbes({ startupFailureThreshold: 120 }),
            resources: resourceProfile.resources,
            securityContext: containerSecurityContext(),
          }],
        },
      },
    },
  };
  const deployed = attempt
    ? await writeFencedDeployment(apps, namespace, name, attempt, claim, deploymentBody, previous)
    : await upsert(apps, 'readNamespacedDeployment', 'createNamespacedDeployment', 'replaceNamespacedDeployment', namespace, deploymentBody);
  // Best-effort, and deliberately so: the asset backend is shared
  // infrastructure, and a failure to reconcile it must not stop THIS app
  // from deploying. Without it the Ingress simply omits the asset paths and
  // the app routes exactly as it did before.
  //
  // RECONCILING the shared backend and ROUTING this app to it are separate
  // questions, and conflating them cost an outage (#2045). The backend is
  // shared; the routing is per-app. Guarding both on the self-app check meant
  // platform previews — far and away the most frequent deploy here — stopped
  // reconciling at all, so the one thing that happens constantly could no
  // longer heal a broken backend, and an already-deployed app whose Ingress
  // carried the asset paths kept answering 503 with no way back.
  //
  // So: always reconcile, and route only for child apps. The platform's own
  // deployment is the SOURCE of these three trees — routing them to the
  // shared backend would serve a preview the production image's copy of its
  // own files, and the preview's checks would describe bytes that are not in
  // the preview. Its 15 native-kit demo checks caught exactly that.
  if (!internalOnly) {
    let assetBackend = null;
    try {
      // The reconcile starts here either way; this deploy waits for it only
      // when the backend does not already serve (sharedBackendForDeploy).
      const backend = await platformAssetBackendForDeploy(config, app);
      if (app.slug !== config.selfAppSlug) assetBackend = backend;
    } catch (err) {
      log.warn('kubernetes', 'platform asset backend unavailable — app deploys without asset routing', {
        namespace, app: app.slug, error: err?.message,
      });
    }
    // The app-host gate (APP_GATE): a new or redeployed app goes behind it
    // only once it is up; otherwise straight to its own Service, as before.
    let gateBackend = null;
    if (appGateMode(config) === 'on') {
      try {
        gateBackend = await appGateBackendForDeploy(config, app);
      } catch (err) {
        log.warn('kubernetes', 'app gate unavailable — app deploys without it', {
          namespace, app: app.slug, error: err?.message,
        });
      }
    }
    await upsert(networking, 'readNamespacedIngress', 'createNamespacedIngress', 'replaceNamespacedIngress', namespace,
      appIngressManifest({ name, namespace, hostname, resourceLabels, cfg, assetBackend, gateBackend }));
  }
  // Everything is applied; what follows is the Pod starting. A caller timing
  // the two apart (services/app-creator.js) hears it here.
  if (typeof onRollout === 'function') { try { onRollout(); } catch { /* observer only */ } }
  try {
    await waitForDeployment(namespace, name, {
      generation: deployed?.metadata?.generation, uid: deployed?.metadata?.uid,
      terminalPodFilter: { imageRef, environmentChecksum: envChecksum(env), container: 'app' },
    });
  } catch (err) {
    const diagnostics = await collectPodDiagnostics(core, { namespace, runtimeName: name, imageRef,
      environmentChecksum: envChecksum(env) });
    err.healthcheckFailed = true;
    err.containerLogs = boundedText([
      err.rolloutDetails, diagnostics.details, diagnostics.logs, err.terminalPodDetails,
    ].filter(Boolean).join('\n'));
    err.containerStatus = 'not_ready';
    err.infrastructure = diagnostics.infrastructure || /exceeded quota/i.test(err.rolloutDetails || '');
    err.message = boundedText(err.message);
    if (diagnostics.unavailable) log.warn('kubernetes', 'Preview failure diagnostics incomplete', {
      namespace, name, detail: diagnostics.unavailable,
    });
    // A preview attempt whose rollout fails gives the Deployment back the
    // template that served before it: the old ReplicaSet never stopped
    // (maxUnavailable 0), so the preview keeps serving the older revision,
    // and the failed pod goes. Only without one is the preview deleted.
    // 'restored', 'superseded' (a newer attempt owns it), 'missing' (no
    // template of the serving attempt is left: nothing serves), or 'failed'.
    const restore = attempt && servingAttempt != null
      ? await restoreTemplate(apps, namespace, name, attempt, claim, attemptSecretName(name, servingAttempt), previous)
        .catch((restoreErr) => {
          err.restoreFailed = restoreErr.message;
          log.warn('kubernetes', 'Could not restore the serving preview template', {
            namespace, name, attempt, err: restoreErr.message,
          });
          return 'failed';
        })
      : 'missing';
    if (restore === 'missing' && environment !== 'production') {
      // A failed preview has no serving value but its declared CPU limit still
      // consumes ResourceQuota. Production keeps its prior ReplicaSet for a
      // recoverable rollout; previews are disposable and are rebuilt on retry.
      // An attempt deletes only the Deployment it wrote, by its UID.
      // Only the Deployment exactly this claim wrote: not a newer attempt's,
      // nor the same attempt's written by a later claim of its build.
      const read = attempt ? await readFencedDeployment(apps, namespace, name, attempt, claim).catch(() => null) : null;
      const own = read && fenceIs(fenceOf(read), attempt, claim) ? read : null;
      if (!attempt || own) {
        const cleanup = attempt ? deleteAttemptDeployment(config, name, own) : deleteApplication(config, name).then(() => true);
        const deleted = await cleanup.catch((cleanupErr) => {
          log.warn('kubernetes', 'Failed preview cleanup failed', {
            namespace, name, err: cleanupErr.message,
          });
          return false;
        });
        // An earlier attempt served from this Deployment and nothing of its
        // template was left to give back: what served is gone too, and the
        // preview machine must hear it (as the Docker replacement says).
        if (deleted && attempt && servingAttempt != null) err.servingRemoved = true;
      }
    }
    throw err;
  }
  const pod = await findReadyAppPod(core, namespace, name, imageRef);
  const node = pod ? pod.spec.nodeName : null;
  const podTimeline = podStartTimeline(pod);
  return {
    runtimeKind: 'kubernetes', runtimeName: name, imageRef,
    hostname: internalOnly ? `${name}.${namespace}.svc` : hostname,
    url: internalOnly ? `http://${name}.${namespace}.svc:3000` : `https://${hostname}`,
    ...(node ? { node } : {}),
    ...(podTimeline ? { podTimeline } : {}),
  };
}

// The Deployment as this claim of an attempt finds it, refused when a newer
// attempt, or a later claim of this one, has already written it. Null when
// there is none yet.
async function readFencedDeployment(apps, namespace, name, attempt, claim = 0) {
  let current;
  try { current = await apps.readNamespacedDeployment({ name, namespace }); }
  catch (err) { if (isNotFound(err)) return null; throw err; }
  const written = fenceOf(current);
  if (fenceNewer(written, attempt, claim)) throw supersededBy(written, attempt, claim);
  return current;
}

function supersededBy(written, attempt, claim) {
  return Object.assign(new Error(`Preview attempt ${fenceValue(attempt, claim)} was superseded by ${fenceValue(written.attempt, written.claim)}`),
    { code: 'attempt_superseded', permanent: true });
}

// An attempt's env Secret, written under the same fence as the Deployment:
// the claims of one attempt share it, and a claim that lost its lease and
// runs on must not put its own database back in it after a later claim
// wrote theirs. Created, or replaced on the version read with the fence, so
// a write in between conflicts and the fence is read again.
async function writeFencedSecret(core, namespace, body, attempt, claim) {
  const name = body.metadata.name;
  body.metadata.annotations = { ...(body.metadata.annotations || {}), [PREVIEW_ATTEMPT_ANNOTATION]: fenceValue(attempt, claim) };
  for (let i = 0; ; i++) {
    let current = null;
    try { current = await core.readNamespacedSecret({ name, namespace }); }
    catch (err) { if (!isNotFound(err)) throw err; }
    const written = fenceOf(current);
    if (fenceNewer(written, attempt, claim)) throw supersededBy(written, attempt, claim);
    try {
      if (!current) {
        delete body.metadata.resourceVersion;
        return await core.createNamespacedSecret({ namespace, body });
      }
      body.metadata.resourceVersion = current.metadata.resourceVersion;
      return await core.replaceNamespacedSecret({ name, namespace, body });
    } catch (err) {
      // 409: written (or created) by someone else since the read.
      if ((!isConflict(err) && !(current && isNotFound(err))) || i >= 3) throw err;
    }
  }
}

// Create, or replace on the version this attempt read: a write by anyone
// else in between conflicts, and the fence is read again.
async function writeFencedDeployment(apps, namespace, name, attempt, claim, body, current) {
  for (let i = 0; ; i++) {
    try {
      if (!current) return await apps.createNamespacedDeployment({ namespace, body });
      body.metadata.resourceVersion = current.metadata.resourceVersion;
      return await apps.replaceNamespacedDeployment({ name, namespace, body });
    } catch (err) {
      if ((!isConflict(err) && !(current && isNotFound(err))) || i >= 3) throw err;
      delete body.metadata.resourceVersion;
      current = await readFencedDeployment(apps, namespace, name, attempt, claim);
    }
  }
}

// The pod template whose env comes from `secret`: the one this attempt
// read, else the newest of the Deployment's ReplicaSets that ran it (as
// `kubectl rollout undo` finds an earlier revision).
async function servingTemplate(apps, namespace, name, secret, previous) {
  const usesSecret = (template) => (template?.spec?.containers || [])
    .some((c) => (c.envFrom || []).some((e) => e.secretRef?.name === secret));
  if (usesSecret(previous?.spec?.template)) return previous.spec.template;
  const sets = await apps.listNamespacedReplicaSet({ namespace, labelSelector: `social.usernode.io/runtime-name=${name}` });
  const found = (sets.items || [])
    .filter((rs) => usesSecret(rs.spec?.template))
    .sort((a, b) => Number(b.metadata?.annotations?.['deployment.kubernetes.io/revision'] || 0)
      - Number(a.metadata?.annotations?.['deployment.kubernetes.io/revision'] || 0))[0];
  if (!found) return null;
  const template = structuredClone(found.spec.template);
  if (template.metadata?.labels) delete template.metadata.labels['pod-template-hash'];
  return template;
}

async function restoreTemplate(apps, namespace, name, attempt, claim, servingSecret, previous) {
  const template = await servingTemplate(apps, namespace, name, servingSecret, previous);
  if (!template) return 'missing';
  const dataPolicy = require('./platform-preview-data-policy');
  // A current preview can fall back only to the same accepted export policy.
  // Restoring an older generation must never reopen its private clone.
  const currentPolicy = previous?.spec?.template?.metadata?.labels?.[dataPolicy.LABEL];
  if (currentPolicy && template.metadata?.labels?.[dataPolicy.LABEL] !== currentPolicy) return 'missing';
  for (let i = 0; ; i++) {
    const current = await apps.readNamespacedDeployment({ name, namespace });
    // A newer attempt, or a later claim of this one, owns the Deployment
    // now; its template is not ours to undo.
    if (fenceNewer(fenceOf(current), attempt, claim)) return 'superseded';
    const requiredPolicy = current.spec?.template?.metadata?.labels?.[dataPolicy.LABEL];
    if (requiredPolicy && template.metadata?.labels?.[dataPolicy.LABEL] !== requiredPolicy) return 'missing';
    current.spec.template = template;
    try {
      await apps.replaceNamespacedDeployment({ name, namespace, body: current });
      return 'restored';
    } catch (err) {
      if (!isConflict(err) || i >= 3) throw err;
    }
  }
}

// Whether the preview's live pod template takes its env from attempt n's
// Secret: the attempt still serves (or is rolling out), so its database
// and Secret must stay. A Deployment that is gone serves nothing.
async function previewServesAttempt(config, name, n) {
  const { apps } = getClients();
  let current;
  try { current = await apps.readNamespacedDeployment({ name, namespace: config.kubernetes.appNamespace }); }
  catch (err) { if (isNotFound(err)) return false; throw err; }
  const secret = attemptSecretName(name, n);
  return (current.spec?.template?.spec?.containers || [])
    .some((c) => (c.envFrom || []).some((e) => e.secretRef?.name === secret));
}

// A preview attempt the machine cancelled after it had written the
// Deployment gives it back: to the template of the attempt that serves
// (`servingN`), or, when nothing served before it, its own Deployment is
// deleted by its UID. Never once a newer attempt owns the Deployment.
// Answers 'restored', 'deleted', 'superseded' or 'missing'.
async function restorePreviewAttempt(config, name, attempt, servingN, claim = 0) {
  const { apps } = getClients();
  const namespace = config.kubernetes.appNamespace;
  let own;
  try { own = await readFencedDeployment(apps, namespace, name, attempt, claim); }
  catch (err) { if (err.code === 'attempt_superseded') return 'superseded'; throw err; }
  if (!own) return 'missing';
  // Only what exactly this claim wrote is its to give back.
  if (!fenceIs(fenceOf(own), attempt, claim)) return 'superseded';
  if (servingN != null) {
    const restored = await restoreTemplate(apps, namespace, name, attempt, claim, attemptSecretName(name, servingN), null);
    if (restored !== 'missing') return restored;
  }
  return await deleteAttemptDeployment(config, name, own) ? 'deleted' : 'superseded';
}

// ── A preview asleep (#6157) ─────────────────────────────────────────────
//
// A preview nobody has used for a while sleeps (services/preview-sleep.js):
// its Deployment is scaled to no replicas and everything else stays, its
// image, its Service, its Ingress, its env Secret and the database clone it
// uses, so waking it is a scale back to one and a wait for the pod. No
// rebuild, and no checks run again: the same image serves the same head.

// Pure: the Deployment as it was read, with `replicas` changed and nothing
// else (its template, its fence, the version it was read at). A preview
// runs one replica awake and none asleep.
function scaledPreviewDeployment(deployment, replicas) {
  if (replicas !== 0 && replicas !== 1) throw new Error('A preview runs one replica awake and none asleep');
  const body = structuredClone(deployment);
  body.spec = { ...(body.spec || {}), replicas };
  delete body.status;
  return body;
}

// Scale a preview's Deployment to `replicas`. Only the Deployment is
// written. It is replaced on the version read and never retried on a
// conflict: a write in between is an attempt's deploy, which sets its own
// replicas, or another sleep or wake, and either is newer than this one.
// `attempt`: the attempt the caller read as serving; a Deployment another
// attempt has written since (its fence) is left alone. Answers 'scaled',
// 'unchanged' (already so), 'missing', 'superseded' or 'conflict'.
async function scalePreview(config, runtimeName, replicas, { attempt = null } = {}) {
  const namespace = config.kubernetes.appNamespace;
  const { apps } = getClients();
  let current;
  try { current = await apps.readNamespacedDeployment({ name: runtimeName, namespace }); }
  catch (err) { if (isNotFound(err)) return 'missing'; throw err; }
  if (!current?.metadata || current.metadata.deletionTimestamp) return 'missing';
  if (attempt != null && (fenceOf(current)?.attempt ?? 0) !== attempt) return 'superseded';
  if ((current.spec?.replicas ?? 1) === replicas) return 'unchanged';
  try {
    await apps.replaceNamespacedDeployment({ name: runtimeName, namespace, body: scaledPreviewDeployment(current, replicas) });
  } catch (err) {
    if (isConflict(err)) return 'conflict';
    if (isNotFound(err)) return 'missing';
    throw err;
  }
  return 'scaled';
}

// Wait until the preview's one replica serves (the rollout contract every
// deploy waits for). Throws when it does not within `timeoutMs`.
async function waitForPreview(config, runtimeName, { timeoutMs = 3 * 60 * 1000 } = {}) {
  await waitForDeployment(config.kubernetes.appNamespace, runtimeName, { timeoutMs });
}

// Pure: where a sleeping preview's direct link goes while it has no pod.
// With the app-host gate on, its Ingress already sends every request to the
// gate, which asks the platform; the platform answers a sleeping preview's
// host with the waking page (routes/app-error.js), so nothing changes. With
// the gate off the Ingress goes straight to the preview's Service, which has
// no endpoints asleep, and the ingress controller (Cilium's Envoy, which
// takes no custom error backend) would answer a bare 503: so while it
// sleeps, its catch-all path goes to the shared asset backend in the same
// namespace, which serves the waking page for a preview's host
// (scripts/serve-platform-assets.js), and back to the Service when it wakes.
// The asset prefixes and every other path are left as they are. Answers the
// Ingress to write, or null when there is nothing to change (already so, or
// a catch-all this does not recognise).
function ingressForSleep(ingress, { name, asleep, gateBackend = null }) {
  const from = asleep ? name : PLATFORM_ASSET_NAME;
  const to = asleep ? PLATFORM_ASSET_NAME : (gateBackend || name);
  let changed = false;
  const rules = (ingress?.spec?.rules || []).map((rule) => {
    if (!rule?.http || !Array.isArray(rule.http.paths)) return rule;
    const paths = rule.http.paths.map((item) => {
      if (item?.path !== '/' || item?.backend?.service?.name !== from) return item;
      changed = true;
      return { ...item, backend: { ...item.backend, service: { ...item.backend.service, name: to } } };
    });
    return { ...rule, http: { ...rule.http, paths } };
  });
  return changed ? { ...ingress, spec: { ...ingress.spec, rules } } : null;
}

// Apply ingressForSleep to a preview's Ingress. With the gate on, a sleeping
// preview keeps its route (the gate serves the waking page); waking sends a
// catch-all left on the asset backend to the gate when it serves, else to
// the preview's own Service. Answers 'routed', 'unchanged' or 'missing'.
async function routePreviewForSleep(config, runtimeName, { asleep }) {
  const namespace = config.kubernetes.appNamespace;
  const { networking } = getClients();
  if (typeof networking?.readNamespacedIngress !== 'function') return 'missing';
  const gate = appGateMode(config) === 'on';
  if (asleep && gate) return 'unchanged';
  const gateBackend = !asleep && gate && await sharedBackendServing(config, APP_GATE_NAME) ? APP_GATE_NAME : null;
  for (let i = 0; ; i++) {
    let ingress;
    try { ingress = await networking.readNamespacedIngress({ name: runtimeName, namespace }); }
    catch (err) { if (isNotFound(err)) return 'missing'; throw err; }
    const body = ingressForSleep(ingress, { name: runtimeName, asleep, gateBackend });
    if (!body) return 'unchanged';
    try {
      await networking.replaceNamespacedIngress({ name: runtimeName, namespace, body });
      return 'routed';
    } catch (err) {
      if (!isConflict(err) || i >= UPSERT_CONFLICT_ATTEMPTS) throw err;
    }
  }
}

// A preview attempt's own Deployment, as it read it, deleted only if nobody
// has written it since: the precondition carries its UID and the version it
// read, so a successor's update in between (same UID) makes the delete
// conflict, and it is left alone. Nothing else goes: the Service and the
// Ingress are the session's, kept for whichever attempt serves next, and
// retired with the preview. Answers whether it was deleted.
async function deleteAttemptDeployment(config, name, read) {
  const { apps } = getClients();
  try {
    await deleteIfPresent(apps, 'deleteNamespacedDeployment', name, config.kubernetes.appNamespace,
      { body: { propagationPolicy: 'Foreground',
        preconditions: { uid: read.metadata.uid, resourceVersion: read.metadata.resourceVersion } } });
    return true;
  } catch (err) {
    if (isConflict(err)) return false;
    throw err;
  }
}

function terminalPodFailureDetails(pods, { imageRef, environmentChecksum, container = 'app' } = {}) {
  const details = [];
  for (const pod of pods || []) {
    if (pod.metadata?.deletionTimestamp) continue;
    if (imageRef && !pod.spec?.containers?.some(item => item.name === container && item.image === imageRef)) continue;
    if (environmentChecksum
        && pod.metadata?.annotations?.['social.usernode.io/env-checksum'] !== environmentChecksum) continue;
    const statuses = [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || [])];
    for (const status of statuses) {
      if (container && status.name !== container) continue;
      const waiting = status.state?.waiting;
      if (!TERMINAL_CONTAINER_WAITING_REASONS.has(waiting?.reason)) continue;
      details.push(`${status.name}: ${[waiting.reason, waiting.message].filter(Boolean).join(': ')}`);
    }
  }
  return details;
}

function deploymentReady(deployment, generation) {
  const desired = deployment.spec?.replicas ?? 1;
  const status = deployment.status || {};
  return !deployment.metadata?.deletionTimestamp && desired > 0
    && status.observedGeneration >= Math.max(generation, deployment.metadata?.generation)
    && status.updatedReplicas === desired && status.replicas === desired
    && status.readyReplicas >= desired && status.availableReplicas >= desired;
}

async function waitForDeployment(namespace, name, {
  timeoutMs = 5 * 60 * 1000, generation = 0, uid = null, terminalPodFilter = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const api = getClients();
  const { apps, core } = api;
  let rolloutDetails = '';
  let watcher;
  let watchAttempted = false;
  let wake;
  let wakePending = false;
  let nextDiagnosisAt = 0;
  const notify = () => { wakePending = true; wake?.(); };
  const stopWatch = () => { watcher?.abort(); watcher = null; };
  try {
    while (Date.now() < deadline) {
      const deployment = await apps.readNamespacedDeployment({ name, namespace });
      uid ||= deployment.metadata?.uid;
      const sameDeployment = !uid || deployment.metadata?.uid === uid;
      const status = deployment.status || {};
      rolloutDetails = boundedText(conditionDetails(status.conditions).join('\n'), 4096);
      // Watch events only wake us; this authoritative read retains the full
      // completion contract and cannot publish a stale/backlogged ready event.
      if (sameDeployment && deploymentReady(deployment, generation)) return deployment;
      if (!watchAttempted) {
        watchAttempted = true;
        const resourceVersion = deployment.metadata?.resourceVersion;
        const startWatch = api.watchDeployment || (api.kc && ((options, event, done) =>
          watchDeployment(api.kc, options, event, done)));
        if (sameDeployment && uid && resourceVersion && startWatch) {
          let finishedSynchronously = false;
          const event = (type, object) => {
            if (type === 'ERROR' || type === 'DELETED') { finishedSynchronously = true; stopWatch(); return; }
            if ((type !== 'ADDED' && type !== 'MODIFIED') || object?.metadata?.uid !== uid
                || object.metadata.name !== name || object.metadata.namespace !== namespace
                || object.metadata.resourceVersion === resourceVersion
                || !deploymentReady(object, generation)) return;
            // One early confirmation per wait: a misleading event cannot make
            // us hammer the API. Subsequent observation uses ordinary polling.
            stopWatch();
            notify();
          };
          const done = () => { finishedSynchronously = true; stopWatch(); };
          try {
            watcher = startWatch({ namespace, name, resourceVersion,
              timeoutMs: Math.max(1, deadline - Date.now()) }, event, done);
            if (finishedSynchronously || wakePending) stopWatch();
          } catch { stopWatch(); }
        }
      }
      // A Pod rejected before its process starts will never become healthy, so
      // waiting the whole rollout budget only turns a precise configuration
      // error into a five-minute "spinning up" delay. This read is best-effort:
      // transient API errors keep the ordinary rollout waiter in control.
      if (Date.now() >= nextDiagnosisAt && terminalPodFilter && typeof core?.listNamespacedPod === 'function') {
        nextDiagnosisAt = Date.now() + ROLLOUT_POLL_MS;
        try {
          const pods = await core.listNamespacedPod({ namespace,
            labelSelector: `social.usernode.io/runtime-name=${name}` });
          const terminal = terminalPodFailureDetails(pods.items, terminalPodFilter);
          if (terminal.length) {
            const detail = terminal.join('\n');
            const err = new Error(`Deployment ${namespace}/${name} cannot start: ${terminal[0]}`);
            err.rolloutDetails = rolloutDetails;
            err.terminalPodDetails = boundedText(detail, 4096);
            err.terminalPodFailure = true;
            throw err;
          }
        } catch (err) {
          if (err.terminalPodFailure) throw err;
        }
      }
      if (!wakePending) {
        await new Promise(resolve => {
          const timer = setTimeout(finish, Math.max(0, Math.min(ROLLOUT_POLL_MS, deadline - Date.now())));
          function finish() { clearTimeout(timer); wake = null; resolve(); }
          wake = finish;
        });
      }
      wakePending = false;
    }
    const err = new Error(`Timed out waiting for Deployment ${namespace}/${name}`);
    err.rolloutDetails = rolloutDetails;
    throw err;
  } finally { stopWatch(); }
}

async function getApplicationStatus(config, runtimeName) {
  return (await inspectApplication(config, runtimeName)).status;
}

async function inspectApplication(config, runtimeName) {
  try {
    const deployment = await getClients().apps.readNamespacedDeployment({ name: runtimeName, namespace: config.kubernetes.appNamespace });
    const state = deploymentState(deployment);
    const status = state === 'creating' ? 'created' : state;
    const desired = deployment.spec?.replicas ?? 1;
    return { status, asleep: require('./production-sleep').isAsleep(deployment), labels: deployment.spec?.template?.metadata?.labels || {},
      imageRef: deployment.spec?.template?.spec?.containers?.find(c => c.name === 'app')?.image,
      rolloutReady: desired > 0 && !deployment.metadata?.deletionTimestamp
        && deployment.status?.observedGeneration >= deployment.metadata?.generation
        && deployment.status?.updatedReplicas === desired
        && deployment.status?.replicas === desired
        && deployment.status?.readyReplicas >= desired
        && deployment.status?.availableReplicas >= desired };
  } catch (err) {
    if (isNotFound(err)) return { status: 'not_found', labels: {} };
    throw err;
  }
}

// Production sleep uses the same immutable image and a resourceVersion fence,
// while every address must already be behind the gate that tracks activity.
async function readProductionForSleep(config, app, { waking = false } = {}) {
  const { apps, networking } = getClients();
  let deployment;
  try { deployment = await apps.readNamespacedDeployment({ name: app.runtime_name, namespace: config.kubernetes.appNamespace }); }
  catch (err) { if (isNotFound(err)) return null; throw err; }
  const l = deployment.metadata?.labels || {};
  if (!deployment.metadata?.uid || !deployment.metadata?.resourceVersion || deployment.metadata.deletionTimestamp
    || l['app.kubernetes.io/managed-by'] !== MANAGED_BY || l['social.usernode.io/app-id'] !== String(app.id)
    || l['social.usernode.io/environment'] !== 'production' || ![0, 1].includes(deployment.spec?.replicas ?? 1)) return null;
  if (waking) return deployment;
  if ((deployment.spec?.replicas ?? 1) !== 1 || deployment.status?.readyReplicas !== 1
    || deployment.status?.updatedReplicas !== 1 || deployment.status?.observedGeneration < deployment.metadata.generation) return null;
  const ingresses = await networking.listNamespacedIngress({ namespace: config.kubernetes.appNamespace,
    labelSelector: `social.usernode.io/app-id=${app.id}` });
  const routes = (ingresses.items || []).flatMap((i) => (i.spec?.rules || []).flatMap((r) =>
    (r.http?.paths || []).filter((p) => p.path === '/')));
  if (!routes.length || routes.some((r) => r.backend?.service?.name !== APP_GATE_NAME)) return null;
  return deployment;
}

async function scaleProductionForSleep(config, deployment, replicas, asleepAt = null) {
  if (![0, 1].includes(replicas)) throw new Error('A production sleep runtime has zero or one replica');
  const body = structuredClone(deployment);
  body.spec.replicas = replicas;
  body.metadata.annotations ||= {};
  const { ANNOTATION } = require('./production-sleep');
  if (replicas === 0) body.metadata.annotations[ANNOTATION] = new Date(asleepAt).toISOString();
  else {
    delete body.metadata.annotations[ANNOTATION];
    // Even if already at one: fence an older in-flight sleep before recording
    // the app awake. A lost coordinator lock cannot let it scale down later.
    body.metadata.annotations['social.usernode.io/production-wake-at'] = new Date().toISOString();
  }
  delete body.status;
  try {
    await getClients().apps.replaceNamespacedDeployment({ name: body.metadata.name,
      namespace: config.kubernetes.appNamespace, body });
    return 'scaled';
  } catch (err) {
    if (isConflict(err)) return 'conflict';
    if (isNotFound(err)) return 'missing';
    throw err;
  }
}

async function appGateActivity(config) {
  const { core } = getClients();
  const pods = await core.listNamespacedPod({ namespace: config.kubernetes.appNamespace,
    labelSelector: `app.kubernetes.io/managed-by=${APP_GATE_MANAGED_BY},app.kubernetes.io/name=${APP_GATE_NAME}` });
  // Include draining gateways: their existing streams still count. Pending,
  // unreachable and old gateways without telemetry prevent new sleeps.
  const live = (pods.items || []).filter((p) => !['Succeeded', 'Failed'].includes(p.status?.phase));
  if (!live.length) throw new Error('No app gateway observations');
  return Promise.all(live.map(async (pod) => {
    const ip = pod.status?.podIP;
    const ipKind = require('node:net').isIP(ip || '');
    if (!ipKind || !pod.metadata?.uid) throw new Error('Gateway has no live telemetry address');
    const host = ipKind === 6 ? `[${ip}]` : ip;
    const response = await fetch(`http://${host}:3001/activity`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Gateway telemetry refused');
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('Gateway telemetry too large');
    const snapshot = JSON.parse(text);
    if (snapshot.podUid !== pod.metadata.uid) throw new Error('Gateway telemetry identity changed');
    return snapshot;
  }));
}

async function getApplicationLogs(config, runtimeName, tailLines = 200) {
  const namespace = config.kubernetes.appNamespace;
  const pods = await getClients().core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${runtimeName}` });
  const pod = pods.items?.[0];
  if (!pod) return '';
  return getClients().core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container: 'app', tailLines });
}

// Production debug may read only workloads managed by this platform in its
// configured app/worker namespaces. A caller never supplies a namespace or
// pod name, and a matching name alone does not grant access to another owner.
async function getDebugLogs(config, runtimeName, { tailLines = 200, maxBytes = 256 * 1024, timeoutMs = 15000 } = {}) {
  if (!require('./debug-access').isAllowedLogContainer(runtimeName, 'kubernetes')) throw new Error('Invalid runtime name');
  const worker = runtimeName.startsWith('sv-worker-');
  const namespace = worker ? config.kubernetes.workerNamespace : config.kubernetes.appNamespace;
  const container = worker ? 'worker' : 'app';
  const managedBy = 'app.kubernetes.io/managed-by';
  const { apps, core } = getClients();
  const operation = async () => {
    const deployment = await apps.readNamespacedDeployment({ name: runtimeName, namespace });
    if (deployment.metadata?.labels?.[managedBy] !== MANAGED_BY) throw new Error('Runtime is not managed by this platform');
    const pods = await core.listNamespacedPod({ namespace,
      labelSelector: `social.usernode.io/runtime-name=${runtimeName},${managedBy}=${MANAGED_BY}` });
    const candidates = (pods.items || []).filter(pod => !pod.metadata?.deletionTimestamp);
    candidates.sort((a, b) => new Date(b.metadata?.creationTimestamp || 0) - new Date(a.metadata?.creationTimestamp || 0));
    const pod = candidates[0];
    if (!pod) throw new Error('Runtime Pod not found');
    return core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container, tailLines, limitBytes: maxBytes + 1 });
  };
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Runtime log read timed out')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// ── Custom domains (#4405) ────────────────────────────────────────────
//
// A project served at a web address its manager owns. The app's own Ingress
// stays exactly as it is (one host, the shared wildcard Secret, no issuer:
// tests/kubernetes-app-tls.test.js); a SECOND Ingress, `sv-domain-<id>`,
// carries the custom host, routes it the same way (the asset prefixes to
// the shared asset backend, everything else through the gate when it is on
// or to the app's Service) and, unlike the app's, asks cert-manager for a
// certificate of its own: this host is not under the wildcard, and the
// manager has already proved they control it (services/app-domains.js) by
// the time this is written, so an HTTP-01 challenge for it can succeed and
// nobody else's name ever costs the issuer a certificate.
//
// The Secret the certificate lands in is the Ingress's own and goes with it.
// The app's Service name rides in an annotation so the gate switch
// (ingressWithGateRoute) can point the catch-all back at it.
const CUSTOM_DOMAIN_SERVICE_ANNOTATION = 'social.usernode.io/app-service';
const CUSTOM_DOMAIN_ID_LABEL = 'social.usernode.io/domain-id';

function customDomainResourceName(domain) {
  return dnsName(`sv-domain-${domain.id}`);
}

// Pure, so the shape can be asserted without a cluster.
function customDomainIngressManifest({ domain, app, namespace, cfg, assetBackend, gateBackend = null, serviceName }) {
  const name = customDomainResourceName(domain);
  const hostname = String(domain.hostname || '').toLowerCase();
  const service = serviceName || app.runtime_name || appResourceName(app, 'production');
  const assetPaths = assetBackend ? PLATFORM_ASSET_PREFIXES.map(platformAssetPath) : [];
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: {
      name, namespace,
      labels: { ...labels({ appId: app.id, environment: 'production' }), [CUSTOM_DOMAIN_ID_LABEL]: String(domain.id) },
      annotations: {
        'cert-manager.io/cluster-issuer': cfg.clusterIssuer || 'letsencrypt-public',
        [CUSTOM_DOMAIN_SERVICE_ANNOTATION]: service,
      },
    },
    spec: {
      ingressClassName: cfg.ingressClassName,
      rules: [{ host: hostname, http: { paths: [
        ...assetPaths,
        { path: '/', pathType: 'Prefix', backend: { service: { name: gateBackend || service, port: { number: 3000 } } } },
      ] } }],
      tls: [{ hosts: [hostname], secretName: withSuffix(name, 'tls') }],
    },
  };
}

async function deployCustomDomain(config, { app, domain }) {
  const cfg = config.kubernetes;
  const namespace = cfg.appNamespace;
  const hostname = String(domain.hostname || '').toLowerCase();
  if (!hostname || !/^[a-z0-9.-]+$/.test(hostname)) throw new Error('Invalid custom domain hostname');
  require('./caddy').assertAppHostname(hostname, cfg.platformDomain);
  const { networking } = getClients();
  let assetBackend = null;
  try {
    assetBackend = await ensurePlatformAssetBackend(config);
  } catch (err) {
    log.warn('kubernetes', 'platform asset backend unavailable — custom domain routes without asset paths', {
      namespace, hostname, error: err?.message,
    });
  }
  let gateBackend = null;
  if (appGateMode(config) === 'on') {
    try {
      gateBackend = await ensureAppGateBackend(config);
    } catch (err) {
      log.warn('kubernetes', 'app gate unavailable — custom domain routes straight to the app', {
        namespace, hostname, error: err?.message,
      });
    }
  }
  await upsert(networking, 'readNamespacedIngress', 'createNamespacedIngress', 'replaceNamespacedIngress', namespace,
    customDomainIngressManifest({ domain, app, namespace, cfg, assetBackend, gateBackend }));
  return { name: customDomainResourceName(domain), hostname };
}

// The Ingress and the certificate Secret cert-manager wrote for it. The
// app's own resources are never touched.
async function deleteCustomDomain(config, { domain }) {
  const namespace = config.kubernetes.appNamespace;
  const name = customDomainResourceName(domain);
  const { core, networking } = getClients();
  await deleteIfPresent(networking, 'deleteNamespacedIngress', name, namespace);
  await deleteIfPresent(core, 'deleteNamespacedSecret', withSuffix(name, 'tls'), namespace);
}

// A replace that lost to another write's resourceVersion (the Deployment's
// own controller updating it) is read again and replaced, as the upserts
// are, rather than read as a failed restart.
async function restartApplication(config, runtimeName) {
  const namespace = config.kubernetes.appNamespace;
  for (let attempt = 1; ; attempt += 1) {
    const deployment = await getClients().apps.readNamespacedDeployment({ name: runtimeName, namespace });
    deployment.spec.template.metadata ||= {};
    deployment.spec.template.metadata.annotations ||= {};
    deployment.spec.template.metadata.annotations['social.usernode.io/restarted-at'] = new Date().toISOString();
    let restarted;
    try {
      restarted = await getClients().apps.replaceNamespacedDeployment({ name: runtimeName, namespace, body: deployment });
    } catch (err) {
      if (!isConflict(err) || attempt >= UPSERT_CONFLICT_ATTEMPTS) throw err;
      continue;
    }
    return waitForDeployment(namespace, runtimeName, { generation: restarted?.metadata?.generation, uid: restarted?.metadata?.uid });
  }
}

// The Deployment is deleted only if it is still the one read first (its UID,
// or `uid` when given), and the call returns once its Pods are gone: a caller
// that deploys the same name next (app heal, a shots environment) never races
// a Deployment still terminating. (Production ran this way under the retired
// PREVIEW_LIFECYCLE_ENABLED; it is the only way now.) `identity`: read every
// resource's UID first and delete each with it as a precondition, plus the
// named `secrets` (the preview machine's retirement, so a same-named
// successor keeps its resources).
async function deleteApplication(config, runtimeName, { uid: ownUid = null, identity = false, secrets = [] } = {}) {
  const namespace = config.kubernetes.appNamespace;
  const { apps, core, networking } = getClients();
  if (identity) return deleteByIdentity(config, runtimeName, secrets);
  // A read that fails for another reason (a quota refusal after a failed
  // rollout) must not keep the resources it would free: delete without the
  // precondition and the wait, as for a Deployment that is gone.
  let uid = ownUid;
  if (!uid) {
    try { uid = (await apps.readNamespacedDeployment({ name: runtimeName, namespace })).metadata.uid; }
    catch { uid = null; }
  }
  const deletions = await Promise.allSettled([
    deleteIfPresent(networking, 'deleteNamespacedIngress', runtimeName, namespace),
    deleteIfPresent(core, 'deleteNamespacedService', runtimeName, namespace),
    deleteIfPresent(core, 'deleteNamespacedSecret', withSuffix(runtimeName, 'env'), namespace),
    // Keep shared and legacy TLS material across rebuilds, idle teardown and
    // failed rollouts. Certificate retirement is a separate operator action.
    //
    // Foreground keeps the Deployment until its Pods are gone, which is what
    // the wait below reads. With a body the API server takes the delete
    // options from the body alone, so the policy goes in with the
    // precondition; beside it, as a query option, it was ignored, the
    // Deployment went at once and the wait returned with its Pods still
    // running (the same mistake orphaned check Pods, #4310).
    deleteIfPresent(apps, 'deleteNamespacedDeployment', runtimeName, namespace, uid
      ? { body: { propagationPolicy: 'Foreground', preconditions: { uid } } }
      : { propagationPolicy: 'Foreground' }),
  ]);
  const failed = deletions.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  if (uid) {
    const deadline = Date.now() + 60000;
    for (;;) {
      let deployment;
      try { deployment = await apps.readNamespacedDeployment({ name: runtimeName, namespace }); }
      catch (err) { if (isNotFound(err)) break; throw err; }
      if (deployment.metadata.uid !== uid) throw new Error('Preview was replaced during teardown');
      if (Date.now() >= deadline) throw new Error('Preview deletion is still pending');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function deleteByIdentity(config, runtimeName, secrets) {
  const namespace = config.kubernetes.appNamespace;
  const { apps, core, networking } = getClients();
  const targets = [
    [networking, 'readNamespacedIngress', 'deleteNamespacedIngress', runtimeName],
    [core, 'readNamespacedService', 'deleteNamespacedService', runtimeName],
    [apps, 'readNamespacedDeployment', 'deleteNamespacedDeployment', runtimeName],
    ...[...new Set(secrets)].map((name) => [core, 'readNamespacedSecret', 'deleteNamespacedSecret', name]),
  ];
  await Promise.all(targets.map(async ([api, read, del, name]) => {
    let uid;
    try { uid = (await api[read]({ name, namespace })).metadata.uid; }
    catch (err) { if (isNotFound(err)) return; throw err; }
    await deleteIfPresent(api, del, name, namespace, {
      ...(del === 'deleteNamespacedDeployment' ? { propagationPolicy: 'Foreground' } : {}),
      body: { preconditions: { uid } },
    });
  }));
}

// Whether any of a preview's resources still exists (an error is not absence).
async function previewResourcesPresent(config, runtimeName, secrets = []) {
  const namespace = config.kubernetes.appNamespace;
  const { apps, core, networking } = getClients();
  const reads = [
    [networking, 'readNamespacedIngress', runtimeName], [core, 'readNamespacedService', runtimeName],
    [apps, 'readNamespacedDeployment', runtimeName], ...secrets.map((name) => [core, 'readNamespacedSecret', name]),
  ];
  const present = await Promise.all(reads.map(async ([api, read, name]) => {
    try { await api[read]({ name, namespace }); return name; }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  }));
  return present.filter(Boolean);
}

async function deleteSecret(config, name) {
  const { core } = getClients();
  await deleteIfPresent(core, 'deleteNamespacedSecret', name, config.kubernetes.appNamespace);
}

async function deleteBuilds(config, appId) {
  await getClients().custom.deleteCollectionNamespacedCustomObject({
    group: 'kpack.io', version: 'v1alpha2', namespace: config.kubernetes.buildNamespace,
    plural: 'builds', labelSelector: `social.usernode.io/app-id=${appId}`,
    propagationPolicy: 'Background',
  });
  await buildkit.deleteBuilds(config, appId, buildkitRuntime());
}

async function deleteFailedBuilds(config) {
  const namespace = config.kubernetes.buildNamespace;
  const { custom } = getClients();
  const response = await custom.listNamespacedCustomObject({
    group: 'kpack.io', version: 'v1alpha2', namespace, plural: 'builds',
    labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY}`,
  });
  const items = response.items || [];
  const failed = items.filter((build) => build.status?.conditions?.some(
    (condition) => condition.type === 'Succeeded' && condition.status === 'False'
  ));
  for (const build of failed) {
    await deleteBuild(config, build.metadata.name);
  }
  const jobs = await buildkit.deleteFailedBuilds(config, buildkitRuntime()).catch((err) => {
    log.warn('kubernetes', 'Failed BuildKit Job sweep skipped', { err: err.message });
    return { examined: 0, deleted: 0 };
  });
  return { examined: items.length + jobs.examined, deleted: failed.length + jobs.deleted };
}

function buildApiParams(config) {
  return { group: 'kpack.io', version: 'v1alpha2', namespace: config.kubernetes.buildNamespace, plural: 'builds' };
}

async function listManagedBuilds(config, { appId } = {}) {
  const items = [];
  let next;
  do {
    const page = await getClients().custom.listNamespacedCustomObject({
      ...buildApiParams(config), labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY}`
        + (appId ? `,social.usernode.io/app-id=${appId}` : ''),
      limit: 500, _continue: next,
    });
    if (!Array.isArray(page?.items)) throw new Error('Invalid kpack Build inventory');
    items.push(...page.items);
    next = page.metadata?.continue;
  } while (next);
  return items;
}

async function readBuild(config, name) {
  return getClients().custom.getNamespacedCustomObject({ ...buildApiParams(config), name });
}

async function deleteBuildSnapshot(config, build) {
  const { name, uid, resourceVersion } = build.metadata;
  if (!uid || !resourceVersion) throw new Error('Build deletion requires UID and resourceVersion');
  await getClients().custom.deleteNamespacedCustomObject({
    ...buildApiParams(config), name,
    body: { propagationPolicy: 'Background', preconditions: { uid, resourceVersion } },
  });
}

const VOLUME_QUOTA_RETRY_MS = 2000;
const VOLUME_QUOTA_RETRIES = 10;

// `reclaimVolumes({ sessionId })` frees other changes' idle volumes when the
// quota refuses this one and resolves how many it deleted. The quota's usage
// drops only once the controller observes those deletions, so the claim is
// retried for a short while rather than once.
// `memory` is this worker's limit in WORKER_MEMORY units (worker.js
// workerMemoryFor); config.workerMemory when it is not given.
// `avoidNodes`: nodes this worker must not be scheduled on, for a retry on a
// fresh claim after its volume failed on one (worker-volume-heal.js).
async function ensureWorker(config, { sessionId, env, onProgress, temporary = false,
  reclaimVolumes = null, retryDelayMs = VOLUME_QUOTA_RETRY_MS, timeoutMs, retryAttempt = null, memory = null,
  avoidNodes = [] }) {
  const cfg = config.kubernetes;
  if (!cfg.workerImage?.includes('@sha256:')) throw new Error('KUBERNETES_WORKER_IMAGE must be an immutable digest');
  const namespace = cfg.workerNamespace;
  const name = dnsName(`sv-worker-s${sessionId}`);
  const pvcName = withSuffix(name, 'state');
  const secretName = withSuffix(name, 'env');
  const resourceLabels = labels({ sessionId, environment: 'worker' });
  const workerContractLabels = config.workerContractVersion
    ? { 'social.usernode.io/worker-contract': String(config.workerContractVersion) }
    : {};
  const selectorLabels = { 'social.usernode.io/runtime-name': name };
  const { core, apps } = getClients();
  const claimVolume = async () => {
    try {
      const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace, labels: resourceLabels }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: cfg.workerStorageSize } } } };
      if (cfg.workerStorageClass) pvc.spec.storageClassName = cfg.workerStorageClass;
      await core.createNamespacedPersistentVolumeClaim({ namespace, body: pvc });
    } catch (err) { if (err?.code !== 409 && err?.response?.statusCode !== 409) throw err; }
  };
  if (!temporary) {
    try {
      await claimVolume();
    } catch (err) {
      if (!isQuotaExceeded(err) || typeof reclaimVolumes !== 'function') throw err;
      const freed = await reclaimVolumes({ sessionId }).catch(() => 0);
      if (!(freed > 0)) throw err;
      let last = err;
      for (let attempt = 0; attempt < VOLUME_QUOTA_RETRIES; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        try { await claimVolume(); last = null; break; } catch (retryErr) {
          if (!isQuotaExceeded(retryErr)) throw retryErr;
          last = retryErr;
        }
      }
      if (last) throw last;
    }
  }
  await upsert(core, 'readNamespacedSecret', 'createNamespacedSecret', 'replaceNamespacedSecret', namespace, {
    apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, namespace, labels: resourceLabels }, type: 'Opaque',
    stringData: Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)])),
  });
  const deployed = await upsert(apps, 'readNamespacedDeployment', 'createNamespacedDeployment', 'replaceNamespacedDeployment', namespace, {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: {
      name, namespace, labels: { ...resourceLabels, ...workerContractLabels,
        'social.usernode.io/storage-mode': temporary ? 'temporary' : 'persistent' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels },
      strategy: { type: 'Recreate' },
      template: {
        metadata: {
          labels: { ...resourceLabels, ...selectorLabels, ...workerContractLabels },
          // A setup retry re-applies an otherwise identical Deployment, which
          // would leave the stuck Pod in place. Stamping the attempt changes
          // the template, so the Recreate strategy stops that Pod and starts a
          // fresh one on the same Deployment, Secret and volume: a retry owns
          // exactly the objects a first dispatch does.
          annotations: { 'social.usernode.io/env-checksum': envChecksum(env),
            ...(retryAttempt ? { 'social.usernode.io/setup-attempt': String(retryAttempt) } : {}) },
        },
        spec: {
          serviceAccountName: cfg.workerServiceAccount,
          automountServiceAccountToken: false,
          // The pause container becomes PID 1 and reaps zombies, as `--init`
          // does on Docker (services/docker.js). worker-run.sh ends in `exec
          // sleep infinity`, which never calls wait(), so every orphaned
          // `git` of an agent's turn stayed a zombie: 900–1,700 PIDs per
          // worker with about 20 live processes (Oct 2026), all of them
          // counted against the kubelet's per-Pod PID limit. Not PID 1,
          // `sleep` also ends on SIGTERM instead of holding the Pod for its
          // whole grace period.
          shareProcessNamespace: true,
          securityContext: nodePodSecurityContext(),
          ...workerAvoidNodes(avoidNodes),
          containers: [{
            name: 'worker', image: cfg.workerImage, imagePullPolicy: 'IfNotPresent',
            env: [{ name: 'USERNODE_WORKER_REQUIRE_READY', value: '1' }],
            envFrom: [{ secretRef: { name: secretName } }],
            volumeMounts: [{ name: 'state', mountPath: '/home/node/.claude' }],
            startupProbe: { exec: { command: ['test', '-f', '/tmp/usernode-worker-ready'] }, periodSeconds: 2, failureThreshold: 150 },
            readinessProbe: { exec: { command: ['test', '-f', '/tmp/usernode-worker-ready'] }, periodSeconds: 2, failureThreshold: 1 },
            resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: config.workerCpus || '2', memory: String(memory || config.workerMemory || '2Gi').replace(/g$/i, 'Gi').replace(/m$/i, 'Mi') } },
            securityContext: containerSecurityContext(),
          }],
          volumes: [{ name: 'state', ...(temporary
            ? { emptyDir: {} }
            : { persistentVolumeClaim: { claimName: pvcName } }) }],
        },
      },
    },
  });
  await waitForWorkerBootstrap(core, apps, { namespace, name, onProgress,
    imageRef: cfg.workerImage, environmentChecksum: envChecksum(env),
    generation: deployed?.metadata?.generation || 0, timeoutMs, claimName: temporary ? null : pvcName });
  return { runtimeKind: 'kubernetes', runtimeName: name, pvcName: temporary ? null : pvcName };
}

// A Node's name (a DNS subdomain), as the scheduler matches it.
const NODE_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

// The Pod spec's part that keeps a worker off `nodes`, by the Node's own
// name (matchFields, not a hostname label a node may not carry). Nothing
// for none: a worker's template is otherwise unchanged.
function workerAvoidNodes(nodes) {
  const names = [...new Set((Array.isArray(nodes) ? nodes : []).map(String).filter((n) => NODE_NAME.test(n)))];
  if (!names.length) return {};
  return { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{
    matchFields: [{ key: 'metadata.name', operator: 'NotIn', values: names }],
  }] } } } };
}

async function getWorkerStatus(config, runtimeName) {
  try {
    const { apps, core } = getClients();
    const namespace = config.kubernetes.workerNamespace;
    const deployment = await apps.readNamespacedDeployment({ name: runtimeName, namespace });
    if (deployment.metadata?.deletionTimestamp || !deployment.status?.availableReplicas
        || deployment.status.observedGeneration < deployment.metadata?.generation) return 'created';
    // Deployment counters can lag a Pod restart. Reuse only a current ready
    // worker, whose probe is tied to the container-local bootstrap marker.
    const pods = await core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${runtimeName}` });
    return pods.items?.some(pod => !pod.metadata?.deletionTimestamp && pod.status?.phase === 'Running'
      && readyPod(pod) && pod.status?.containerStatuses?.some(c => c.name === 'worker' && c.ready && c.state?.running))
      ? 'running' : 'created';
  } catch (err) {
    if (isNotFound(err)) return 'not_found';
    throw err;
  }
}

// Pod termination evidence is separate from readiness: a restarted worker can
// be ready again after losing the process that owned the current turn.
async function inspectWorkerTermination(config, runtimeName, { since, timeoutMs = 5000 } = {}) {
  const namespace = config.kubernetes.workerNamespace;
  let timer;
  const operation = async () => {
    const pods = await getClients().core.listNamespacedPod({ namespace,
      labelSelector: `social.usernode.io/runtime-name=${runtimeName},app.kubernetes.io/managed-by=${MANAGED_BY}` });
    if (!pods.items?.length) return { status: 'gone', oomKilled: false };
    const sinceMs = new Date(since).getTime();
    let gone = true;
    for (const pod of pods.items) {
      const worker = pod.status?.containerStatuses?.find(c => c.name === 'worker');
      if (!pod.metadata?.deletionTimestamp && worker?.state?.running) gone = false;
      for (const terminated of [worker?.state?.terminated, worker?.lastState?.terminated]) {
        if (terminated?.reason === 'OOMKilled' && Number.isFinite(sinceMs)
            && new Date(terminated.finishedAt).getTime() >= sinceMs) {
          return { status: 'exited', oomKilled: true };
        }
      }
    }
    return { status: gone ? 'not_running' : 'running', oomKilled: false };
  };
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Worker termination observation timed out')), timeoutMs);
    })]);
  } catch { return null; } finally { clearTimeout(timer); }
}

async function getWorkerContractVersion(config, runtimeName) {
  return (await getWorkerRuntimeMetadata(config, runtimeName)).contractVersion;
}

// Read the desired Deployment identity rather than a transient Pod. Worker
// images are immutable digest references, so this lets the host distinguish a
// healthy-but-old warm worker from one already reconciled to the current
// atomic platform release without depending on container runtime image IDs.
async function getWorkerRuntimeMetadata(config, runtimeName) {
  try {
    const deployment = await getClients().apps.readNamespacedDeployment({
      name: runtimeName,
      namespace: config.kubernetes.workerNamespace,
    });
    const worker = deployment.spec?.template?.spec?.containers?.find(
      container => container.name === 'worker'
    );
    return {
      contractVersion: deployment.metadata?.labels?.['social.usernode.io/worker-contract'] || null,
      imageRef: worker?.image || null,
      storageMode: deployment.spec?.template?.spec?.volumes?.find((volume) => volume.name === 'state')?.emptyDir
        ? 'temporary' : 'persistent',
    };
  } catch (err) {
    if (isNotFound(err)) return { contractVersion: null, imageRef: null, storageMode: null };
    throw err;
  }
}

// How long a deletion that waits (`waitGone`: an eviction, which a turn
// starting on the session waits for, services/worker-eviction.js) waits for
// its worker's Deployment to be gone. Foreground propagation keeps it,
// marked for deletion, until its Pods have terminated; a worker ensured
// meanwhile would update the Deployment about to go and wait for a bootstrap
// that never comes.
const WORKER_GONE_WAIT_MS = 3 * 60 * 1000;

async function deleteWorker(config, sessionId, { deleteVolume = false, waitGone = false, waitMs = WORKER_GONE_WAIT_MS, pollMs = 1000 } = {}) {
  const namespace = config.kubernetes.workerNamespace;
  const name = dnsName(`sv-worker-s${sessionId}`);
  const { apps, core } = getClients();
  await Promise.all([
    deleteIfPresent(apps, 'deleteNamespacedDeployment', name, namespace, { propagationPolicy: 'Foreground' }),
    deleteIfPresent(core, 'deleteNamespacedSecret', withSuffix(name, 'env'), namespace),
  ]);
  if (deleteVolume) await deleteIfPresent(core, 'deleteNamespacedPersistentVolumeClaim', withSuffix(name, 'state'), namespace);
  if (!waitGone) return;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await apps.readNamespacedDeployment({ name, namespace });
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    if (Date.now() >= deadline) throw new Error(`Worker ${name} is still being deleted after ${Math.round(waitMs / 1000)} s`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// A session's worker resources by identity (their uids; null for one that
// is not there), for a removal fenced to exactly these: a worker made after
// the read (the session came back) has other uids, so a delete carrying the
// old uid as its precondition is refused for it, and leaves it alone. The
// state volume is read only for a removal that takes it (`volume`).
async function workerIdentity(config, sessionId, { volume = false } = {}) {
  const namespace = config.kubernetes.workerNamespace;
  const name = dnsName(`sv-worker-s${sessionId}`);
  const { apps, core } = getClients();
  const uid = async (api, method, resourceName) => {
    try { return (await api[method]({ namespace, name: resourceName }))?.metadata?.uid || null; }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  };
  return {
    deployment: await uid(apps, 'readNamespacedDeployment', name),
    secret: await uid(core, 'readNamespacedSecret', withSuffix(name, 'env')),
    pvc: volume ? await uid(core, 'readNamespacedPersistentVolumeClaim', withSuffix(name, 'state')) : null,
  };
}

function workerIdentityResources(sessionId) {
  const name = dnsName(`sv-worker-s${sessionId}`);
  const { apps, core } = getClients();
  return [
    ['deployment', apps, 'Deployment', name],
    ['secret', core, 'Secret', withSuffix(name, 'env')],
    ['pvc', core, 'PersistentVolumeClaim', withSuffix(name, 'state')],
  ];
}

// Deletes the resources `ids` names, each only if it still has that uid
// (the Deployment in the foreground: it goes once its pods have). Gone
// already, or replaced by a newer one (the precondition refused), is done.
async function deleteWorkerIdentity(config, sessionId, ids) {
  const namespace = config.kubernetes.workerNamespace;
  for (const [field, api, kind, name] of workerIdentityResources(sessionId)) {
    const uid = ids?.[field];
    if (!uid) continue;
    try {
      await api[`deleteNamespaced${kind}`]({ name, namespace,
        body: { ...(kind === 'Deployment' ? { propagationPolicy: 'Foreground' } : {}), preconditions: { uid } } });
    } catch (err) {
      if (!isNotFound(err) && !isConflict(err)) throw err;
    }
  }
}

// Whether every resource `ids` names has finished going: absent, or there
// under another uid (a newer one). An accepted delete is not that: a
// Deployment deleted in the foreground stays until its pods have
// terminated, and a volume until no pod mounts it.
async function workerIdentityGone(config, sessionId, ids) {
  const namespace = config.kubernetes.workerNamespace;
  for (const [field, api, kind, name] of workerIdentityResources(sessionId)) {
    const uid = ids?.[field];
    if (!uid) continue;
    try {
      const now = await api[`readNamespaced${kind}`]({ name, namespace });
      if (now?.metadata?.uid === uid) return false;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  return true;
}

// A deletion acceptance is not proof that pods/PVCs finished terminating.
// Account erasure keeps its durable task pending while finalizers run.
async function eraseWorker(config, sessionId) {
  await deleteWorker(config, sessionId, { deleteVolume: true });
  const { apps, core } = getClients();
  const namespace = config.kubernetes.workerNamespace;
  const name = dnsName(`sv-worker-s${sessionId}`);
  const absent = async (api, method, resourceName) => {
    try { await api[method]({ namespace, name: resourceName }); }
    catch (err) { if (isNotFound(err)) return; throw err; }
    throw new Error('worker_erasure_pending');
  };
  await absent(apps, 'readNamespacedDeployment', name);
  await absent(core, 'readNamespacedSecret', withSuffix(name, 'env'));
  await absent(core, 'readNamespacedPersistentVolumeClaim', withSuffix(name, 'state'));
  const pods = await core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${name}` });
  if (pods.items?.length) throw new Error('worker_erasure_pending');
}

async function listWorkers(config) {
  const namespace = config.kubernetes.workerNamespace;
  const deployments = await getClients().apps.listNamespacedDeployment({
    namespace,
    labelSelector: 'app.kubernetes.io/managed-by=social-vibecoding-runtime,social.usernode.io/environment=worker',
  });
  return (deployments.items || []).map((deployment) => ({
    name: deployment.metadata.name,
    sessionId: Number(deployment.metadata.labels?.['social.usernode.io/session-id']),
    state: deploymentState(deployment) === 'creating' ? 'created' : deploymentState(deployment),
  })).filter((item) => Number.isFinite(item.sessionId));
}

// appResourceName's preview spelling. The name is the identity: evidence
// replays (`sv-evidence-*`) share the staging environment label and carry a
// session id too, but they belong to the evidence runner, not to a session's
// preview, so the label selector alone would sweep them up.
const PREVIEW_NAME_RE = /^sv-preview-(\d+)-s(\d+)$/;

// Every preview Deployment in the app namespace, whatever the session rows
// say about it. This is the Kubernetes counterpart of `docker ps -a` for the
// stale-preview sweep (services/staging-reap.js): a preview whose row was
// nulled, or whose row is gone, is visible only from this side.
// Security retirement is independent of preview availability and the optional
// ingress gate. Constrain Services first, then remove stale controllers and
// actual Pods (including old ReplicaSets during a rolling replacement).
async function retirePlatformPreviewPolicy(config, appId, digest, { timeoutMs = 30000, pollMs = 200 } = {}) {
  const { LABEL } = require('./platform-preview-data-policy');
  const namespace = config.kubernetes.appNamespace;
  const selector = `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/app-id=${appId},social.usernode.io/environment=staging`;
  const { apps, core } = getClients();
  // Use the runtime's existing get/update-Service, list Deployment/RS/Pod,
  // and foreground-delete-Deployment permissions. This retirement needs no
  // Service list or direct ReplicaSet/Pod-delete permission.
  const ours = object => object.metadata?.labels?.['social.usernode.io/app-id'] === String(appId)
    && object.metadata.labels['social.usernode.io/environment'] === 'staging'
    && object.metadata.labels['app.kubernetes.io/managed-by'] === MANAGED_BY;
  const runtimeName = object => object.metadata.labels['social.usernode.io/runtime-name'] || object.metadata.name;
  const unsafeController = object => object.spec?.template?.metadata?.labels?.[LABEL] !== digest;
  const retired = new Set(), examined = new Set();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [deployments, sets, pods] = await Promise.all([
      apps.listNamespacedDeployment({ namespace, labelSelector: selector }),
      apps.listNamespacedReplicaSet({ namespace, labelSelector: selector }),
      core.listNamespacedPod({ namespace, labelSelector: selector }),
    ]);
    const ds = (deployments.items || []).filter(ours);
    const rs = (sets.items || []).filter(ours);
    const ps = (pods.items || []).filter(ours);
    ds.forEach(d => examined.add(d.metadata.name));
    const unsafeNames = new Set([
      ...ds.filter(unsafeController).map(d => d.metadata.name),
      ...rs.filter(unsafeController).map(runtimeName),
      ...ps.filter(p => p.metadata.labels[LABEL] !== digest).map(runtimeName),
    ]);
    // Constrain every known Service first. Desired labels alone cannot
    // attest the endpoints during a rolling replacement. Read by trusted
    // runtime names so an unavailable Service list is never treated as empty.
    const names = new Set([...ds.map(d => d.metadata.name), ...rs.map(runtimeName), ...ps.map(runtimeName)]);
    for (const name of names) {
      let service;
      try { service = await core.readNamespacedService({ name, namespace }); }
      catch (err) { if (isNotFound(err)) continue; throw err; }
      if (!ours(service)) throw new Error('Preview Service identity changed during data-policy retirement');
      if (service.spec?.selector?.[LABEL] === digest) continue;
      service.spec.selector = { ...service.spec.selector, [LABEL]: digest };
      await core.replaceNamespacedService({ name, namespace, body: service });
    }
    if (!unsafeNames.size) return { examined: examined.size, retired: retired.size };
    // Retire the entire runtime even when its desired template is current
    // but an older ReplicaSet/Pod still serves. Foreground garbage collection
    // stops all controllers and waits for kubelet-confirmed Pod termination.
    for (const deployment of ds.filter(d => unsafeNames.has(d.metadata.name))) {
      if (deployment.metadata.deletionTimestamp) continue;
      if (!await deleteAttemptDeployment(config, deployment.metadata.name, deployment)) {
        throw new Error('Preview changed during data-policy retirement; retry inventory');
      }
      retired.add(deployment.metadata.name);
    }
    // Re-inventory controllers as well as actual Pods. An orphan controller,
    // disconnected node or failed removal cannot be declared safe. Services
    // remain restricted; an operator must remove/isolate an orphan if the
    // normal foreground deletion cannot retire it.
    if (Date.now() >= deadline) throw new Error('Unsafe platform preview controllers or Pods are still retiring');
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

async function listPreviews(config, { strict = false } = {}) {
  const namespace = config.kubernetes.appNamespace;
  const deployments = await getClients().apps.listNamespacedDeployment({
    namespace,
    labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/environment=staging`,
  });
  if (strict && !Array.isArray(deployments?.items)) throw new Error('Invalid Deployment preview inventory');
  const previews = [];
  for (const deployment of deployments.items || []) {
    const name = deployment.metadata?.name || '';
    const labelsMap = deployment.metadata?.labels || {};
    const match = PREVIEW_NAME_RE.exec(name);
    if (!match || labelsMap['social.usernode.io/session-id'] !== match[2]) continue;
    const state = deploymentState(deployment);
    previews.push({
      name,
      appId: Number(match[1]),
      sessionId: Number(match[2]),
      state: state === 'creating' ? 'created' : state,
      image: deployment.spec?.template?.spec?.containers?.find((c) => c.name === 'app')?.image || null,
      labels: labelsMap,
    });
  }
  return previews;
}

function previewRoutingIdentity(metadata) {
  const match = PREVIEW_NAME_RE.exec(metadata?.name || '');
  const tags = metadata?.labels || {};
  if (!match || tags['app.kubernetes.io/managed-by'] !== MANAGED_BY
      || tags['social.usernode.io/environment'] !== 'staging'
      || tags['social.usernode.io/app-id'] !== match[1]
      || tags['social.usernode.io/session-id'] !== match[2]
      || tags['social.usernode.io/shots-run'] || tags['social.usernode.io/evidence-run']) return null;
  const appId = Number(match[1]), sessionId = Number(match[2]);
  return Number.isSafeInteger(appId) && appId > 0 && Number.isSafeInteger(sessionId) && sessionId > 0
    ? { appId, sessionId } : null;
}

// Cleanup also sees routing left after a Deployment disappeared. Runtime
// status and env recovery still use listPreviews: routing alone is no pod.
// Read every list before returning anything; an unreadable list is not an
// empty one on which a garbage collector may base a deletion.
async function listPreviewResources(config) {
  const { core, networking } = getClients();
  const namespace = config.kubernetes.appNamespace;
  const labelSelector = `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/environment=staging`;
  const all = async (api, method) => {
    const items = [];
    let next;
    do {
      const page = await api[method]({ namespace, labelSelector, limit: 500, _continue: next });
      if (!Array.isArray(page?.items)) throw new Error(`Invalid ${method} preview inventory`);
      items.push(...page.items);
      next = page.metadata?.continue;
    } while (next);
    return items;
  };
  const [previews, services, ingresses] = await Promise.all([
    listPreviews(config, { strict: true }), all(core, 'listNamespacedService'), all(networking, 'listNamespacedIngress'),
  ]);
  const deployments = new Set(previews.map((p) => p.name));
  const byName = new Map(previews.map((p) => [p.name, p]));
  for (const [kind, objects] of [['service', services], ['ingress', ingresses]]) {
    for (const object of objects) {
      const metadata = object.metadata;
      const identity = previewRoutingIdentity(metadata);
      if (!identity || deployments.has(metadata.name)) continue;
      if (!byName.has(metadata.name)) byName.set(metadata.name, {
        name: metadata.name, ...identity, state: 'not_found', image: null,
        labels: metadata.labels, routingResources: [],
      });
      byName.get(metadata.name).routingResources.push({ kind, metadata: {
        name: metadata.name, uid: metadata.uid, resourceVersion: metadata.resourceVersion, labels: metadata.labels,
      } });
    }
  }
  return [...byName.values()];
}

// Only the routing object the sweep judged, never a same-named replacement
// or one updated by a new build after inventory. A missing object is done;
// a precondition failure is retried from a fresh inventory next time.
async function deletePreviewRoutingResource(config, kind, metadata) {
  const { name, uid, resourceVersion } = metadata || {};
  if (!previewRoutingIdentity(metadata) || !uid || !resourceVersion) {
    throw new Error('Preview routing deletion requires matching ownership labels, UID and resourceVersion');
  }
  const { core, networking } = getClients();
  const target = { service: [core, 'deleteNamespacedService'], ingress: [networking, 'deleteNamespacedIngress'] }[kind];
  if (!target) throw new Error(`Unknown preview routing kind: ${kind}`);
  await deleteIfPresent(target[0], target[1], name, config.kubernetes.appNamespace,
    { body: { preconditions: { uid, resourceVersion } } });
}

// Shots fixtures use the production environment label; paired runtimes use
// staging. Require both the exact run label and its deterministic name so
// neither ordinary apps nor vote-backed previews enter this cleanup inventory.
async function listShotsRuntimes(config) {
  const deployments = await getClients().apps.listNamespacedDeployment({
    namespace: config.kubernetes.appNamespace,
    labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY}`,
  });
  const { HOSTED_APP_ID } = require('../../worker/shots-hosted-app-contract');
  const runtimes = [];
  for (const deployment of deployments.items || []) {
    const metadata = deployment.metadata || {};
    const labelsMap = metadata.labels || {};
    if (labelsMap['app.kubernetes.io/managed-by'] !== MANAGED_BY) continue;
    for (const tag of ['shots', 'evidence']) {
      const runId = labelsMap[`social.usernode.io/${tag}-run`];
      const side = labelsMap[`social.usernode.io/${tag}-side`];
      if (!/^[0-9a-f]{32}$/.test(runId || '')) continue;
      const otherRun = labelsMap[`social.usernode.io/${tag === 'shots' ? 'evidence' : 'shots'}-run`];
      if (otherRun && otherRun !== runId) continue;
      const session = labelsMap['social.usernode.io/session-id'];
      if (!/^[1-9]\d*$/.test(session || '') || !Number.isSafeInteger(Number(session))) continue;
      let expected;
      if (side === 'base' || side === 'head') {
        if (labelsMap['social.usernode.io/environment'] !== 'staging') continue;
        expected = `sv-${tag}-${runId.slice(0, 16)}-${side === 'base' ? 'b' : 'h'}`;
      } else if (side === 'hosted-app') {
        if (labelsMap['social.usernode.io/app-id'] !== String(HOSTED_APP_ID)
            || labelsMap['social.usernode.io/environment'] !== 'production') continue;
        expected = appResourceName({ id: HOSTED_APP_ID, slug: `homeroom-${tag}-${runId.slice(0, 16)}` }, 'production');
      }
      if (!expected || metadata.name !== expected) continue;
      runtimes.push({
        runtimeKind: 'kubernetes', runtimeName: expected, runId,
        sessionId: Number(session), createdAt: metadata.creationTimestamp || null,
      });
      break;
    }
  }
  return runtimes;
}

// Every worker state volume, with whether a worker Deployment still mounts it.
async function listWorkerVolumes(config) {
  const namespace = config.kubernetes.workerNamespace;
  const { core, apps } = getClients();
  const labelSelector = `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/environment=worker`;
  const [claims, deployments] = await Promise.all([
    core.listNamespacedPersistentVolumeClaim({ namespace, labelSelector }),
    apps.listNamespacedDeployment({ namespace, labelSelector }),
  ]);
  const mounted = new Set((deployments.items || []).map((deployment) => deployment.metadata?.name));
  return (claims.items || []).map((claim) => {
    const sessionId = Number(claim.metadata?.labels?.['social.usernode.io/session-id']);
    const runtimeName = dnsName(`sv-worker-s${sessionId}`);
    return {
      name: claim.metadata?.name,
      sessionId,
      createdAt: claim.metadata?.creationTimestamp || null,
      terminating: !!claim.metadata?.deletionTimestamp,
      attached: mounted.has(runtimeName),
      state: claim.metadata?.name === withSuffix(runtimeName, 'state'),
    };
  }).filter((volume) => Number.isSafeInteger(volume.sessionId) && volume.state)
    .map(({ state, ...volume }) => volume);
}

function deploymentState(deployment) {
  const desired = deployment.spec?.replicas ?? 1;
  const ready = deployment.status?.readyReplicas || 0;
  const available = deployment.status?.availableReplicas || 0;
  const observed = deployment.status?.observedGeneration || 0;
  const generation = deployment.metadata?.generation || 0;
  if (desired === 0 || deployment.metadata?.deletionTimestamp) return 'stopped';
  // Old replicas can remain ready while the new image is failing to start.
  // Use the same completion contract as waitForDeployment before reporting
  // the desired template as running.
  if (ready >= desired && available >= desired && observed >= generation
      && deployment.status?.updatedReplicas === desired
      && deployment.status?.replicas === desired) return 'running';
  if ((deployment.status?.replicas || 0) > 0 || deployment.status?.unavailableReplicas) return 'restarting';
  return 'creating';
}

// Read only this installation's platform Deployment. This describes the
// rollout that Argo has applied; image build/publication remains in Actions.
async function getPlatformDeployStatus(config, { timeoutMs = 3000 } = {}) {
  const cfg = config.kubernetes || {};
  const namespace = cfg.platformNamespace || 'social-platform';
  const name = cfg.platformDeployment || 'social-vibecoding';
  let timer;
  try {
    const deployment = await Promise.race([
      getClients().apps.readNamespacedDeployment({ namespace, name }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Platform rollout read timed out')), timeoutMs); }),
    ]);
    const status = deployment.status || {};
    const observed = status.observedGeneration >= (deployment.metadata?.generation || 0);
    const failure = observed && status.conditions?.find(c =>
      (c.type === 'Progressing' && c.status === 'False') || (c.type === 'ReplicaFailure' && c.status === 'True'));
    const complete = deploymentState(deployment) === 'running';
    const stopped = deployment.spec?.replicas === 0 || !!deployment.metadata?.deletionTimestamp;
    const progressing = status.conditions?.find(c => c.type === 'Progressing');
    const revision = deployment.spec?.template?.metadata?.annotations?.['social.usernode.io/source-revision'];
    return { runtimeKind: 'kubernetes', scope: 'rollout',
      deploying: !complete && !failure && !deployment.spec?.paused && !stopped,
      failed: !!failure,
      phase: failure ? 'failed' : stopped ? 'stopped' : deployment.spec?.paused ? 'paused' : complete ? 'complete' : 'rollout',
      sha: /^[a-f0-9]{40}$/i.test(revision || '') ? revision : null,
      startedAt: progressing?.lastUpdateTime || progressing?.lastTransitionTime || null,
      ...(failure ? { message: boundedText([failure.reason, failure.message].filter(Boolean).join(': '), 1000) } : {}),
    };
  } finally { clearTimeout(timer); }
}

// Read one Pod of this installation's own namespace: the platform reads its
// own at boot for what ended its last container (platform-release.js
// recordPodExit). Bounded like the rollout read above, so a slow API server
// cannot hold a boot step open. The chart's rollout-reader Role grants `get`
// on pods there (deploy/helm/social-vibecoding-platform/templates/rollout-rbac.yaml).
async function readPlatformPod({ name, namespace, timeoutMs = 5000 }) {
  let timer;
  try {
    return await Promise.race([
      getClients().core.readNamespacedPod({ name, namespace }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Platform pod read timed out')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function readyPod(pod) {
  return (pod.status?.conditions || []).some((condition) =>
    condition.type === 'Ready' && condition.status === 'True'
  );
}

function normalizeDeployment(deployment, pods) {
  const runtimeName = deployment.metadata?.name;
  const labelsMap = deployment.metadata?.labels || {};
  const matchingPods = (pods || []).filter((pod) =>
    pod.metadata?.labels?.['social.usernode.io/runtime-name'] === runtimeName
      && !pod.metadata?.deletionTimestamp
  );
  const readyPods = matchingPods.filter(readyPod);
  const candidates = readyPods.length ? readyPods : matchingPods;
  candidates.sort((left, right) =>
    new Date(right.metadata?.creationTimestamp || 0) - new Date(left.metadata?.creationTimestamp || 0)
  );
  const currentPod = candidates[0] || null;
  const desired = deployment.spec?.replicas ?? 1;
  const ready = deployment.status?.readyReplicas || 0;
  const restarts = matchingPods.reduce((total, pod) => total + (pod.status?.containerStatuses || [])
    .reduce((sum, container) => sum + (container.restartCount || 0), 0), 0);
  const environment = labelsMap['social.usernode.io/environment'] || 'unknown';
  return {
    name: runtimeName,
    id: currentPod?.metadata?.uid || deployment.metadata?.uid || null,
    runtimeKind: 'kubernetes',
    resourceType: environment === 'production' ? 'app' : environment,
    environment,
    state: deploymentState(deployment),
    status: `${ready}/${desired} ready${restarts ? ` · ${restarts} restart${restarts === 1 ? '' : 's'}` : ''}`,
    image: deployment.spec?.template?.spec?.containers?.[0]?.image || null,
    startedAt: currentPod?.metadata?.creationTimestamp || deployment.metadata?.creationTimestamp || null,
    appId: Number(labelsMap['social.usernode.io/app-id']) || null,
    sessionId: Number(labelsMap['social.usernode.io/session-id']) || null,
    ready,
    desired,
    restarts,
  };
}

async function listStatusResources(config) {
  const cfg = config.kubernetes;
  const selector = 'app.kubernetes.io/managed-by=social-vibecoding-runtime';
  const namespaces = [...new Set([cfg.appNamespace, cfg.workerNamespace].filter(Boolean))];
  const { apps, core } = getClients();
  const perNamespace = await Promise.all(namespaces.map(async (namespace) => {
    const [deployments, pods] = await Promise.all([
      apps.listNamespacedDeployment({ namespace, labelSelector: selector }),
      core.listNamespacedPod({ namespace, labelSelector: selector }),
    ]);
    return (deployments.items || []).map((deployment) =>
      normalizeDeployment(deployment, pods.items || [])
    );
  }));
  return perNamespace.flat();
}

const QUANTITY_MULTIPLIERS = {
  n: 1e-9, u: 1e-6, m: 1e-3,
  '': 1,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50,
};

function quantityNumber(value) {
  const match = String(value ?? '').trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([a-zA-Z]*)$/);
  if (!match || !Object.prototype.hasOwnProperty.call(QUANTITY_MULTIPLIERS, match[2])) return null;
  const result = Number(match[1]) * QUANTITY_MULTIPLIERS[match[2]];
  return Number.isFinite(result) ? result : null;
}

function quotaMetric(quota, key) {
  const hard = quota.status?.hard?.[key] ?? quota.spec?.hard?.[key];
  if (hard === undefined || hard === null) return null;
  const used = quota.status?.used?.[key] ?? '0';
  const hardNumber = quantityNumber(hard);
  const usedNumber = quantityNumber(used);
  return {
    used: String(used),
    hard: String(hard),
    percent: hardNumber && usedNumber !== null
      ? Math.max(0, Math.round((usedNumber / hardNumber) * 1000) / 10)
      : null,
    headroomPercent: hardNumber && usedNumber !== null
      ? Math.max(0, Math.round((1 - (usedNumber / hardNumber)) * 1000) / 10)
      : null,
  };
}

async function listNamespaceCapacity(config) {
  const cfg = config.kubernetes;
  const namespaces = [...new Set([
    cfg.appNamespace,
    cfg.workerNamespace,
    cfg.buildNamespace,
  ].filter(Boolean))];
  const { core } = getClients();
  return Promise.all(namespaces.map(async (namespace) => {
    try {
      const response = await core.listNamespacedResourceQuota({ namespace });
      const quotas = response.items || [];
      const quota = quotas.find((item) => item.metadata?.name === 'social-vibecoding') || quotas[0];
      if (!quota) return { namespace, quotaName: null, resources: null };
      return {
        namespace,
        quotaName: quota.metadata?.name || null,
        resources: {
          pods: quotaMetric(quota, 'pods'),
          requestsCpu: quotaMetric(quota, 'requests.cpu'),
          requestsMemory: quotaMetric(quota, 'requests.memory'),
          limitsCpu: quotaMetric(quota, 'limits.cpu'),
          limitsMemory: quotaMetric(quota, 'limits.memory'),
          requestsEphemeralStorage: quotaMetric(quota, 'requests.ephemeral-storage'),
          limitsEphemeralStorage: quotaMetric(quota, 'limits.ephemeral-storage'),
          requestsStorage: quotaMetric(quota, 'requests.storage'),
          persistentVolumeClaims: quotaMetric(quota, 'persistentvolumeclaims'),
          services: quotaMetric(quota, 'services'),
          secrets: quotaMetric(quota, 'secrets'),
          configMaps: quotaMetric(quota, 'configmaps'),
          jobs: quotaMetric(quota, 'count/jobs.batch'),
          builds: quotaMetric(quota, 'count/builds.kpack.io'),
        },
      };
    } catch (err) {
      log.warn('kubernetes', 'Namespace quota status unavailable', {
        namespace, err: err.message,
      });
      return { namespace, quotaName: null, resources: null, unavailable: true };
    }
  }));
}

// `onStdoutLine(line)`: the same observer contract as docker.runOneShot —
// complete stdout lines as the run progresses, on top of the final log the
// verdict is read from. A Job has no stdout to listen to, so while polling
// for completion the pod log is re-read every few ticks and only the lines
// past the last consumed offset are handed over. Errors reading the log are
// swallowed: progress is a courtesy, the verdict still comes from the final
// read below, unchanged.
async function runCaptureJob(config, options) {
  return runCheckJob(config, { memory: '6g', cpus: '8', ...options }, 'capture');
}

async function runUnitSuiteJob(config, options) {
  return runCheckJob(config, options, 'unit-suite');
}

// A check Job's name before any shard suffix: `sv-<kind>-s<session>-<run>`,
// or under `namePrefix` in place of `sv-<kind>`.
function checkJobRunName(kind, sessionId, runId, namePrefix = null) {
  return `${namePrefix || `sv-${kind}`}-s${sessionId}-${runId}`;
}

// Delete one check Job by name, with its Pod and input Secret (Background
// propagation, as stopCheckJobs). For a Job no preview run owns, such as
// an early unit suite nobody adopted. Never throws.
async function deleteCheckJob(config, name) {
  try {
    const { batch } = getClients();
    await deleteIfPresent(batch, 'deleteNamespacedJob', dnsName(name), config.kubernetes.workerNamespace,
      { propagationPolicy: 'Background' });
    return true;
  } catch {
    return false;
  }
}

// How many unit suites (a run's own, main-watch's, and early ones) are
// running in the worker namespace: a suite split across Jobs counts once,
// by its run id. Null when the count could not be read.
async function countRunningUnitSuiteJobs(config) {
  try {
    const { batch } = getClients();
    const jobs = await batch.listNamespacedJob({
      namespace: config.kubernetes.workerNamespace,
      labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/workload=check`,
    });
    const runs = new Set();
    for (const job of jobs.items || []) {
      const name = job.metadata?.name || '';
      if (!(name.startsWith('sv-unit-suite-') || name.startsWith('sv-unit-early-'))) continue;
      if (job.metadata?.deletionTimestamp || describeCheckJob(job).state !== 'running') continue;
      runs.add(job.metadata?.labels?.['social.usernode.io/preview-run-id'] || name);
    }
    return runs.size;
  } catch {
    return null;
  }
}

// Delete every check Job of one run, running or not, with their Pods and
// input Secrets: all the shards of an early unit suite nobody adopted.
// Never throws; returns how many it asked to delete.
async function deleteRunCheckJobs(config, { sessionId, previewRunId }) {
  if (!previewRunId) return 0;
  try {
    const { batch } = getClients();
    const namespace = config.kubernetes.workerNamespace;
    const jobs = await batch.listNamespacedJob({ namespace,
      labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/session-id=${sessionId},social.usernode.io/preview-run-id=${previewRunId}` });
    const mine = (jobs.items || []).filter((job) => job.metadata?.labels?.['social.usernode.io/preview-run-id'] === previewRunId
      && !job.metadata?.deletionTimestamp);
    await Promise.all(mine.map((job) => deleteIfPresent(batch, 'deleteNamespacedJob', job.metadata.name, namespace,
      { propagationPolicy: 'Background' }).catch(() => {})));
    return mine.length;
  } catch {
    return 0;
  }
}

// A DELETE response only acknowledges termination. Keep preview ownership
// until every consuming Pod has stopped, including Jobs orphaned by a crash.
// `spare(runId)` keeps the Jobs of the runs it names (by preview-run-id).
// An early unit suite (`sv-unit-early-…`) is never touched here: it goes
// with its attempt (preview services retireAttempt).
async function cancelPreviewChecks(config, sessionId, previewRunId = null, { spare = () => false } = {}) {
  const { batch, core } = getClients();
  const namespace = config.kubernetes.workerNamespace;
  const selector = `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/session-id=${sessionId}`
    + (previewRunId ? `,social.usernode.io/preview-run-id=${previewRunId}` : '');
  const jobs = await batch.listNamespacedJob({ namespace, labelSelector: selector });
  await Promise.all((jobs.items || []).map(async job => {
    const name = job.metadata.name;
    if (!name.startsWith(`sv-capture-s${sessionId}-`)
        && !name.startsWith(`sv-unit-suite-s${sessionId}-`)) return;
    const runId = job.metadata.labels?.['social.usernode.io/preview-run-id'];
    if (previewRunId && runId !== previewRunId) return;
    if (runId && spare(runId)) return;
    const podsStopped = async () => {
      const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` });
      return (pods.items || []).every(pod => ['Succeeded', 'Failed'].includes(pod.status?.phase));
    };
    if ((job.status?.succeeded || job.status?.failed) && await podsStopped()) return;
    // The policy goes in the body. The API server reads delete options from
    // the body when there is one and ignores the query string, and a batch/v1
    // Job deleted without a policy ORPHANS its dependents: its Pods ran on
    // with no deadline and its input Secret lost its owner, which is how 130
    // ownerless input Secrets filled the worker namespace's quota.
    await deleteIfPresent(batch, 'deleteNamespacedJob', name, namespace, {
      body: { propagationPolicy: 'Foreground', preconditions: { uid: job.metadata.uid } },
    });
    const deadline = Date.now() + 60000;
    for (;;) {
      let gone = false;
      try { await batch.readNamespacedJob({ name, namespace }); }
      catch (err) { if (isNotFound(err)) gone = true; else throw err; }
      if (gone && await podsStopped()) break;
      if (Date.now() >= deadline) throw new Error(`Preview checks still stopping: ${name}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }));
}

// Read-only observations may be abandoned on supersession. Creation/deletion
// requests are always awaited, so a late mutation cannot escape ownership.
function observeCheck(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

function checkResourceRequest(request, limit, resource) {
  const limitNumber = quantityNumber(limit);
  if (limitNumber === null || limitNumber <= 0) {
    throw new Error(`Invalid check ${resource} limit`);
  }
  // Smaller operator overrides must not produce an inadmissible Pod whose
  // request exceeds its limit. Keep the normal working-set reservation otherwise.
  return quantityNumber(request) > limitNumber ? limit : request;
}

// Kubernetes pod-log reads are snapshots, not a durable stream contract. A
// terminal read can legitimately arrive empty or shorter than an earlier
// follow/poll read (for example while the Pod is completing). Keep complete
// lines we have already observed and only let the terminal snapshot extend
// that known prefix. An inconsistent snapshot must never erase evidence the
// progress observer already received.
function boundedCheckOutput(text, maxBuffer) {
  const bytes = Buffer.from(text || '', 'utf8');
  let end = Math.min(bytes.length, maxBuffer);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function createCheckOutputAccumulator(maxBuffer) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    appendLine(line) {
      const chunk = Buffer.from(`${line}\n`, 'utf8');
      // Retain complete protocol lines only. A partial frame is not useful to
      // settlement, and keeping it would also risk cutting a UTF-8 sequence.
      if (truncated || bytes + chunk.length > maxBuffer) {
        truncated = true;
        return false;
      }
      chunks.push(chunk);
      bytes += chunk.length;
      return true;
    },
    output() { return Buffer.concat(chunks, bytes).toString('utf8'); },
    get truncated() { return truncated; },
  };
}

function reconcileCheckOutput(observed, terminal) {
  const known = String(observed || '');
  const snapshot = String(terminal || '');
  if (!known) return snapshot;
  if (!snapshot) return known;
  // The normal cumulative-log case: preserve any new complete lines or
  // trailing fragment that only the terminal read saw.
  if (snapshot.startsWith(known)) return snapshot;
  // Empty/short terminal reads are the production failure #2340 reproduced.
  if (known.startsWith(snapshot)) return known;
  // A non-prefix snapshot is not safe to splice into a line protocol. The
  // observed stream is the only version whose ordering we actually know.
  return known;
}

// Kubernetes' syntax for a label key (an optional DNS-subdomain prefix, then
// a name) and for a label value.
const LABEL_NAME = '[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?';
const NODE_POOL_PAIR = new RegExp(
  `^((?:[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?/)?${LABEL_NAME})=(${LABEL_NAME})$`);
const warnedNodePools = new Set();

function checkPoolConfigurationError(message) {
  return Object.assign(new Error(message), { code: 'CHECK_POOL_CONFIG', infrastructure: true });
}

// CHECK_NODE_POOL as { key, value }, or null when it is empty or is not a
// valid label pair. An invalid one is said once and ignored: a Job the API
// refuses for a malformed toleration is a check that cannot start, and
// running where checks always ran is the better failure.
function checkNodePool(cfg) {
  const raw = String(cfg.checkNodePool || '').trim();
  if (!raw) {
    if (cfg.checkNodePoolRequired) throw checkPoolConfigurationError('CHECK_NODE_POOL_REQUIRED needs a valid CHECK_NODE_POOL');
    return null;
  }
  const match = NODE_POOL_PAIR.exec(raw);
  if (!match) {
    if (cfg.checkNodePoolRequired) throw checkPoolConfigurationError('CHECK_NODE_POOL_REQUIRED needs a valid CHECK_NODE_POOL');
    if (!warnedNodePools.has(raw)) {
      warnedNodePools.add(raw);
      log.warn('kubernetes', 'CHECK_NODE_POOL is not a label key=value; checks keep the default placement', { value: raw });
    }
    return null;
  }
  return { key: match[1], value: match[2] };
}

// Where a check Pod may run.
//
// Without a pool, checks prefer spare hosts and are never stranded when only
// one host fits: a soft spread over every node, counted across all check
// kinds and sessions.
//
// With a pool (CHECK_NODE_POOL), its nodes carry the label and the same pair
// as a NoSchedule taint, so nothing else is scheduled on them. Checks
// tolerate the taint and prefer the label. It stays a preference: with the
// pool full or its nodes gone, checks run on the other nodes as before.
//
// The spread goes when there is a pool. Both are scoring preferences of the
// same weight to the scheduler, and the spread counts check Pods per host, so
// on a pool of one large node it would send every Pod after the first back to
// the small nodes the pool is there to relieve.
function checkPlacement(cfg, checkSelector) {
  const pool = checkNodePool(cfg);
  if (!pool) {
    return {
      topologySpreadConstraints: [{
        maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway',
        nodeAffinityPolicy: 'Honor', nodeTaintsPolicy: 'Honor',
        labelSelector: { matchLabels: checkSelector },
      }],
    };
  }
  return {
    tolerations: [{ key: pool.key, operator: 'Equal', value: pool.value, effect: 'NoSchedule' }],
    ...(cfg.checkNodePoolRequired ? {
      affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{
        matchExpressions: [{ key: pool.key, operator: 'In', values: [pool.value] }],
      }] } } },
    } : {
    affinity: { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{
      weight: 100,
      preference: { matchExpressions: [{ key: pool.key, operator: 'In', values: [pool.value] }] },
    }] } },
    }),
  };
}

function batchWorkPlacement(cfg) {
  if (!cfg.checkNodePoolRequired) return {};
  const pool = checkNodePool(cfg);
  return { nodeSelector: { [pool.key]: pool.value },
    tolerations: [{ key: pool.key, operator: 'Equal', value: pool.value, effect: 'NoSchedule' }] };
}

async function checkPoolCapacity(config = null) {
  const checkPool = require('./check-pool');
  if (!checkPool.required(config)) return { available: true, cap: Infinity };
  const cfg = config?.kubernetes || {
    checkNodePool: process.env.CHECK_NODE_POOL, checkNodePoolRequired: true,
    checkPoolMetricsUrl: process.env.CHECK_POOL_METRICS_URL,
  };
  const pool = checkNodePool(cfg);
  if (!pool) throw checkPoolConfigurationError('A required checks pool is missing');
  if (cfg.checkPoolMetricsUrl) {
    let url;
    try { url = new URL('/api/v1/query', cfg.checkPoolMetricsUrl); }
    catch { throw checkPoolConfigurationError('Invalid check-pool metrics URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw checkPoolConfigurationError('Invalid check-pool metrics URL');
    url.searchParams.set('query', checkPool.metricsQuery(pool));
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Check-pool metrics unavailable');
    const data = await response.json();
    if (data.status !== 'success' || data.data?.resultType !== 'vector' || !Array.isArray(data.data.result)) {
      throw new Error('Invalid check-pool metrics response');
    }
    return checkPool.fromMetrics(data.data.result);
  }
  const nodes = await getClients().core.listNode({ labelSelector: `${pool.key}=${pool.value}` });
  // Tolerate exactly the configured pool taint (including a non-default key).
  const allowed = (nodes.items || []).filter((n) => !(n.spec?.taints || []).some((t) =>
    ['NoSchedule', 'NoExecute'].includes(t.effect)
      && !(t.effect === 'NoSchedule' && t.key === pool.key && t.value === pool.value)));
  return checkPool.plan(allowed.map((n) => ({ ...n, spec: { ...n.spec,
    taints: (n.spec?.taints || []).filter((t) => t.key !== pool.key),
  } })));
}

async function reconcileAppResourceProfiles(config, appRows, { maxChanges = 1 } = {}) {
  const profiles = require('./app-resource-profiles');
  const assignments = profiles.assignments(config.kubernetes?.appResourceProfiles ?? {});
  const { apps } = getClients();
  const namespace = config.kubernetes.appNamespace;
  const deployments = await apps.listNamespacedDeployment({ namespace,
    labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/environment=production` });
  const byId = new Map(appRows.map((app) => [String(app.id), app]));
  let changed = 0;
  for (const deployment of deployments.items || []) {
    const app = byId.get(deployment.metadata?.labels?.['social.usernode.io/app-id']);
    if (!app || deployment.metadata?.deletionTimestamp) continue;
    const previousProfile = deployment.spec?.template?.metadata?.annotations?.[profiles.ANNOTATION];
    if (!Object.hasOwn(assignments, String(app.id)) && previousProfile !== 'small') continue;
    if (app.self_hosted || app.slug === config.selfAppSlug
      || Number(app.id) === require('../../worker/shots-hosted-app-contract').HOSTED_APP_ID) continue;
    const replicas = deployment.spec?.replicas ?? 1;
    if (![0, 1].includes(replicas) || (replicas === 1 && (
      deployment.status?.observedGeneration < deployment.metadata.generation
      || deployment.status?.replicas !== 1 || deployment.status?.updatedReplicas !== 1
      || deployment.status?.readyReplicas !== 1))) continue;
    const container = deployment.spec?.template?.spec?.containers?.find((c) => c.name === 'app');
    if (!container) continue;
    const selected = profiles.forApp(config, app, 'production');
    const current = container.resources?.requests || {};
    const annotation = deployment.spec.template.metadata?.annotations?.[profiles.ANNOTATION] || 'standard';
    if (current.cpu === selected.resources.requests.cpu && current.memory === selected.resources.requests.memory
      && annotation === selected.profile) continue;
    // Preserve all hard limits and storage settings, including explicit
    // workload exceptions. Refuse a profile that exceeds an existing ceiling.
    const quantity = require('./check-pool').quantity;
    const cpuLimit = quantity(container.resources?.limits?.cpu);
    const memoryLimit = quantity(container.resources?.limits?.memory);
    if (!Number.isFinite(cpuLimit) || !Number.isFinite(memoryLimit)
      || quantity(selected.resources.requests.cpu) > cpuLimit
      || quantity(selected.resources.requests.memory) > memoryLimit) continue;
    const body = structuredClone(deployment);
    const target = body.spec.template.spec.containers.find((c) => c.name === 'app');
    target.resources.requests = { ...target.resources.requests, ...selected.resources.requests };
    body.spec.template.metadata ||= {};
    body.spec.template.metadata.annotations ||= {};
    body.spec.template.metadata.annotations[profiles.ANNOTATION] = selected.profile;
    delete body.status;
    try {
      await apps.replaceNamespacedDeployment({ namespace, name: body.metadata.name, body });
      changed += 1;
    } catch (err) { if (!isConflict(err) && !isNotFound(err)) throw err; }
    if (changed >= maxChanges) break;
  }
  return { examined: deployments.items?.length || 0, changed };
}

async function waitForCheckPool(config, { signal = null, waitMs = 15 * 60 * 1000, pollMs = 3000 } = {}) {
  if (!require('./check-pool').required(config)) return;
  const deadline = Date.now() + waitMs;
  let reported = false;
  for (;;) {
    signal?.throwIfAborted();
    try {
      if ((await checkPoolCapacity(config)).available) return;
    } catch (err) {
      signal?.throwIfAborted();
      if (err.code === 'CHECK_POOL_CONFIG') throw err;
      // Monitoring can roll independently of the platform. Wait before
      // creating resources, so its transient failures consume no Job deadline.
      if (!reported) {
        log.warn('kubernetes', 'Batch capacity metrics unavailable; waiting before resource creation');
        reported = true;
      }
    }
    if (Date.now() >= deadline) {
      throw Object.assign(new Error('The dedicated checks pool is unavailable'), { infrastructure: true });
    }
    const delayMs = Math.max(1, Math.min(pollMs, deadline - Date.now()));
    await observeCheck(new Promise((resolve) => setTimeout(resolve, delayMs)), signal);
  }
}

// `namePrefix` names a Job outside the preview's own check Jobs: an early
// unit suite (preview services checks.unitEarly) is `sv-unit-early-…`, which
// cancelPreviewChecks and stopCheckJobs leave alone. `nameSuffix` and
// `shard` name and label one of a run's capture shards; `cpuRequest` is a
// shard's smaller share of the scheduler (services/visuals.js
// CAPTURE_SHARD_CPU_REQUEST).
async function runCheckJob(config, {
  sessionId, env, stdinPayload = null, timeoutMs = 180000,
  onStdoutLine = null, cmd, memory = '2g', cpus = '4', maxBuffer = 64 * 1024 * 1024,
  salvagePartial = false, signal = null, previewRunId = null,
  namePrefix = null, nameSuffix = null, shard = null, cpuRequest = null, unitShard = null,
}, kind) {
  const cfg = config.kubernetes;
  const unitSuite = kind === 'unit-suite';
  const cpuLimit = String(cpus);
  const memoryLimit = String(memory).replace(/g$/i, 'Gi').replace(/m$/i, 'Mi');
  const resources = {
    requests: {
      cpu: checkResourceRequest(cpuRequest || '4', cpuLimit, 'CPU'),
      memory: checkResourceRequest(unitSuite ? '1Gi' : '3Gi', memoryLimit, 'memory'),
      'ephemeral-storage': '1Gi',
    },
    limits: { cpu: cpuLimit, memory: memoryLimit, 'ephemeral-storage': unitSuite ? '8Gi' : '4Gi' },
  };
  const image = unitSuite ? cfg.workerImage : cfg.captureImage;
  if (!image?.includes('@sha256:')) throw new Error(`${unitSuite ? 'KUBERNETES_WORKER_IMAGE' : 'KUBERNETES_CAPTURE_IMAGE'} must be an immutable digest`);
  const namespace = cfg.workerNamespace;
  const runName = checkJobRunName(kind, sessionId, previewRunId || Date.now().toString(36), namePrefix);
  const name = nameSuffix ? withSuffix(runName, nameSuffix) : dnsName(runName);
  // A shard's Secret keeps its shard in its name. Cut from the Job's name,
  // which is already near the 63-character limit for a run id that is a
  // UUID, the `-input` suffix pushed the shard's own suffix off the end, and
  // every shard of a unit suite asked for the same Secret: only the first
  // could start (10 Oct 2026, every proposal's split unit suite).
  const inputSecretName = !unitSuite && stdinPayload == null ? null
    : nameSuffix ? withSuffix(runName, `${nameSuffix}-input`) : withSuffix(name, 'input');
  if (stdinPayload != null && Buffer.byteLength(String(stdinPayload), 'utf8') > 900 * 1024) {
    throw new Error('Capture stdin payload exceeds the Kubernetes Secret transport limit');
  }
  const container = {
    name: kind, image, imagePullPolicy: 'IfNotPresent',
    env: Object.entries(env || {}).map(([key, value]) => unitSuite
      ? { name: key, valueFrom: { secretKeyRef: { name: inputSecretName, key } } }
      : { name: key, value: String(value) }),
    // Captures share Docker's limits and reserve the observed browser working set.
    resources,
    securityContext: containerSecurityContext(),
  };
  if (unitSuite) {
    container.command = cmd;
  }
  const podVolumes = [];
  if (!unitSuite && inputSecretName) {
    container.command = ['sh', '-c'];
    container.args = ['exec node /app/capture.js < /var/run/usernode-capture/tests.json'];
    container.volumeMounts = [{
      name: 'capture-input', mountPath: '/var/run/usernode-capture', readOnly: true,
    }];
    podVolumes.push({
      name: 'capture-input',
      secret: { secretName: inputSecretName, items: [{ key: 'tests.json', path: 'tests.json' }] },
    });
  }
  // Count all check kinds and sessions together, excluding resident workers.
  const checkSelector = {
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'app.kubernetes.io/part-of': PART_OF,
    'social.usernode.io/workload': 'check',
  };
  const checkLabels = { ...labels({ sessionId, environment: unitSuite ? 'worker' : 'capture' }), ...checkSelector };
  const body = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace, labels: { ...checkLabels } }, spec: {
    backoffLimit: 0, activeDeadlineSeconds: Math.ceil(timeoutMs / 1000), ttlSecondsAfterFinished: CHECK_JOB_TTL_SECONDS,
    template: { metadata: { labels: { ...checkLabels } }, spec: {
      restartPolicy: 'Never', serviceAccountName: cfg.workerServiceAccount,
      automountServiceAccountToken: false, securityContext: nodePodSecurityContext(),
      // A pause PID 1 reaps what the browser and the suite orphan, as on the
      // worker (ensureWorker). The Job still ends with the check's own exit.
      shareProcessNamespace: true,
      ...checkPlacement(cfg, checkSelector),
      containers: [container], ...(podVolumes.length ? { volumes: podVolumes } : {}),
    } },
  } };
  const { batch, core } = getClients();
  if (previewRunId) {
    body.metadata.labels['social.usernode.io/preview-run-id'] = previewRunId;
    body.spec.template.metadata.labels['social.usernode.io/preview-run-id'] = previewRunId;
  }
  if (Number.isInteger(shard)) {
    body.metadata.labels['social.usernode.io/capture-shard'] = String(shard);
    body.spec.template.metadata.labels['social.usernode.io/capture-shard'] = String(shard);
  }
  // One shard of a split unit suite, as `k-of-n` (services/unit-suite.js):
  // the harvest reads how many shards a run had from it.
  if (unitShard) {
    body.metadata.labels['social.usernode.io/unit-shard'] = String(unitShard);
    body.spec.template.metadata.labels['social.usernode.io/unit-shard'] = String(unitShard);
  }
  let inputSecretCreated = false;
  let inputSecret = null;
  // Follow state lives outside the try so the finally can close the stream.
  let following = false;
  let followAbort = null;
  // The Pod's start state (check-pod-start.js), read while the Job waits and
  // kept on what this returns or throws as `podStart`: a Pod that never
  // started its container is the platform's fault, and a DeadlineExceeded
  // Job may have taken its Pod by the time its failure is read.
  let podStart = null;
  const retainPartial = !unitSuite && salvagePartial;
  const retained = createCheckOutputAccumulator(maxBuffer);
  const reportLine = line => {
    if (retainPartial) retained.appendLine(line);
    if (typeof onStdoutLine === 'function') {
      try { onStdoutLine(line); } catch { /* observer must not break the run */ }
    }
  };
  const boundedOutput = text => boundedCheckOutput(text, maxBuffer);
  // A create the API refused or never answered: nothing ran, so the caller
  // can say the check could not start rather than that it failed
  // (services/unit-suite.js reads the mark).
  const create = async (call) => {
    try { return await call(); } catch (err) {
      if (err && typeof err === 'object') err.checkJobNotCreated = true;
      throw err;
    }
  };
  // An API call after the create that failed for any reason but a cancel:
  // the Job may run on, but this runner lost it before it ended, which is
  // the platform's fault too (check-pod-start.js checkStartFault).
  const lost = async (call) => {
    try { return await call(); } catch (err) {
      if (!signal?.aborted && err && typeof err === 'object') err.checkJobApiLost = true;
      throw err;
    }
  };
  try {
    signal?.throwIfAborted();
    // Covers early and main-watch Jobs too. Their execution deadlines begin
    // only once the dedicated pool exists, not while waiting for its return.
    await create(() => waitForCheckPool(config, { signal }));
    if (inputSecretName) {
      inputSecret = await create(() => core.createNamespacedSecret({ namespace, body: {
        apiVersion: 'v1', kind: 'Secret',
        metadata: { name: inputSecretName, namespace, labels: labels({ sessionId, environment: unitSuite ? 'worker' : 'capture' }) },
        type: 'Opaque', stringData: unitSuite
          ? Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)]))
          : { 'tests.json': String(stdinPayload) },
      } }));
      inputSecretCreated = true;
    }
    signal?.throwIfAborted();
    // A refused create (the namespace's quota, for one) leaves no Job to own
    // the Secret; the finally below deletes it.
    const createdJob = await create(() => batch.createNamespacedJob({ namespace, body }));
    // A platform restart must not orphan private clone credentials. The Job's
    // TTL also garbage-collects its input Secret if normal cleanup cannot run.
    // The Secret goes first so a Pod never starts without its input, which
    // leaves a crash between the Job's create and this write as the one way
    // to strand it ownerless. The owner is written onto the object the create
    // returned, without reading it back, so that window is these two calls;
    // services/check-retention.js removes what a crash leaves in it.
    if (inputSecretName && createdJob?.metadata?.uid) {
      await lost(async () => {
        const secret = inputSecret?.metadata?.resourceVersion
          ? inputSecret : await core.readNamespacedSecret({ name: inputSecretName, namespace });
        secret.metadata.ownerReferences = [{ apiVersion: 'batch/v1', kind: 'Job', name, uid: createdJob.metadata.uid }];
        await core.replaceNamespacedSecret({ name: inputSecretName, namespace, body: secret });
      });
    }
    const deadline = Date.now() + timeoutMs + 15000;
    // Progress observer state. Two ways to see the container's stdout as it
    // streams: FOLLOW the pod log (one long request; each line reaches the
    // observer as it is printed, the same cadence docker's stdout gives),
    // or, until the follow is up or where it is unavailable, re-read the
    // cumulative log every PROGRESS_EVERY_TICKS and hand over what is new.
    // The polled read arrives in ~6s steps, which on a fast document group
    // is 50-100 checks at once; the follow is what makes the bar move
    // smoothly. `consumed` is how much of the log either path has already
    // delivered, so a follow that starts after a poll skips what the poll
    // handed over instead of replaying it.
    const PROGRESS_EVERY_TICKS = 3;
    let progressPodName = null;
    let consumed = 0;
    let tick = 0;
    const findPod = async () => {
      if (progressPodName) return progressPodName;
      const pods = await observeCheck(core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` }), signal);
      progressPodName = pods.items?.[0]?.metadata?.name || null;
      return progressPodName;
    };
    const readOutput = async () => {
      let timer;
      try {
        return await Promise.race([(async () => {
          const podName = await findPod();
          if (!podName) return '';
          // One extra byte detects a silently truncated capture log.
          return String(await core.readNamespacedPodLog({ name: podName, namespace, container: kind,
            limitBytes: unitSuite ? maxBuffer : maxBuffer + 1 }) || '');
        })(), new Promise((_resolve, reject) => {
          // Salvaging logs must never prevent timeout cleanup of the Job.
          timer = setTimeout(() => reject(new Error('Check Job log read timed out')), 15000);
        })]);
      } finally { clearTimeout(timer); }
    };
    const startFollow = async () => {
      if ((!retainPartial && typeof onStdoutLine !== 'function') || following) return;
      try {
        if (!(await findPod())) return;
        const logApi = clientsLogApi(getClients());
        if (!logApi) return;
        const sink = new stream.PassThrough();
        attachLineObserver(sink, reportLine, { skipBytes: consumed });
        // The API refuses a container that has not started ("is waiting to
        // start"); the next tick tries again, and the polled read covers
        // the gap.
        followAbort = await observeCheck(logApi.log(namespace, progressPodName, kind, sink, { follow: true }).then(handle => {
          if (signal?.aborted) handle?.abort();
          return handle;
        }), signal);
        following = true;
      } catch { /* the polled read stays in charge */ }
    };
    const observeProgress = async () => {
      if ((!retainPartial && typeof onStdoutLine !== 'function') || following) return;
      try {
        if (!(await findPod())) return;
        const text = await observeCheck(core.readNamespacedPodLog({ name: progressPodName, namespace, container: kind, limitBytes: maxBuffer }), signal);
        const log = String(text || '');
        if (log.length <= consumed) return;
        const fresh = log.slice(consumed);
        const lastNl = fresh.lastIndexOf('\n');
        if (lastNl === -1) return; // no complete new line yet
        for (const line of fresh.slice(0, lastNl).split('\n')) {
          reportLine(line);
        }
        consumed += lastNl + 1;
      } catch { /* progress is best-effort */ }
    };
    // One reading of the Pod's start state, until its container is seen
    // started. Best-effort: a failed read leaves the last reading.
    const watchStart = async () => {
      if (podStart?.started) return;
      try {
        const pods = await observeCheck(core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` }), signal);
        const pod = pods.items?.[0];
        if (pod) {
          progressPodName = progressPodName || pod.metadata?.name || null;
          podStart = mergePodStart(podStart, readPodStart(pod, kind));
        }
      } catch { signal?.throwIfAborted(); }
    };
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const job = await lost(() => observeCheck(batch.readNamespacedJob({ name, namespace }), signal));
      signal?.throwIfAborted();
      if (job.status?.failed || job.status?.conditions?.some(c => c.type === 'Failed' && c.status === 'True')) {
        const pods = await observeCheck(core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` }), signal);
        const pod = pods.items?.[0];
        if (pod) podStart = mergePodStart(podStart, readPodStart(pod, kind));
        const err = new Error(`${kind} Job ${name} failed`);
        err.stdout = pod ? await observeCheck(core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container: kind, limitBytes: maxBuffer }), signal).catch(() => '') : '';
        const terminated = pod?.status?.containerStatuses?.find(c => c.name === kind)?.state?.terminated;
        err.code = terminated?.exitCode;
        const jobReason = job.status.conditions?.find(c => c.type === 'Failed')?.reason;
        err.stderr = [jobReason, terminated?.reason].filter(Boolean).join(': ');
        err.killed = jobReason === 'DeadlineExceeded' || terminated?.reason === 'OOMKilled';
        err.captureJobTerminated = true;
        err.podStart = podStart;
        throw err;
      }
      if (job.status?.succeeded) {
        let terminalOutput;
        try { terminalOutput = await observeCheck(readOutput(), signal); }
        catch (err) { err.captureLogFailed = !unitSuite; throw err; }
        signal?.throwIfAborted();
        const stdout = reconcileCheckOutput(retained.output(), terminalOutput);
        if (!unitSuite && (Buffer.byteLength(terminalOutput, 'utf8') > maxBuffer
            || retained.truncated)) {
          const err = new Error('Capture output exceeds maxBuffer');
          err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          err.stdout = boundedOutput(stdout);
          throw err;
        }
        return { stdout, runtimeName: name };
      }
      tick += 1;
      if (tick % PROGRESS_EVERY_TICKS === 1) await watchStart();
      if (!following) await startFollow();
      if (!following && tick % PROGRESS_EVERY_TICKS === 0) await observeProgress();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const err = new Error(`Timed out waiting for ${kind} Job ${name}`);
    err.killed = true;
    // Read before deletion: deleting the Job can immediately remove the Pod
    // and the only durable copy of completed capture frames, and with it
    // whether its container ever started.
    err.stdout = await readOutput().catch(() => '');
    await watchStart();
    err.podStart = podStart;
    // A coordinated owner confirms foreground termination before replacement.
    if (!signal) await deleteIfPresent(batch, 'deleteNamespacedJob', name, namespace, { propagationPolicy: 'Background' });
    throw err;
  } catch (err) {
    signal?.throwIfAborted();
    if (err && typeof err === 'object' && err.podStart === undefined) err.podStart = podStart;
    const stdout = boundedOutput(reconcileCheckOutput(retained.output(), err.stdout));
    // Capture output is a frame protocol, so every runtime-level ending can
    // be settled honestly even when it produced zero complete frames. Keep
    // the Job/container reason alongside the salvaged stream instead of
    // throwing it past the verdict path and losing the only explanation.
    // Unit suites retain their throwing contract; their outcome parser has
    // a separate TAP/stderr path.
    // Kubernetes API errors also use numeric codes (for example 409 when a
    // Job already exists). Only a failed Job observed above is a container
    // termination whose partial stdout can be salvaged.
    const captureTerminated = err.captureJobTerminated === true;
    if (retainPartial && (err.killed || err.captureLogFailed
        || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || captureTerminated)) {
      const termination = [err.stderr, Number.isInteger(err.code) ? `exit code ${err.code}` : '']
        .filter(Boolean).join(', ');
      return { stdout, stderr: err.stderr || '', runtimeName: name, partial: true, podStart: err.podStart || null,
        partialReason: err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output over maxBuffer'
          : err.captureLogFailed ? 'capture log unavailable'
            : err.stderr?.includes('OOMKilled') ? 'capture OOM killed'
              : err.killed ? 'run timed out'
                : termination ? `capture terminated (${termination})` : 'capture Job failed' };
    }
    throw err;
  } finally {
    if (followAbort && typeof followAbort.abort === 'function') {
      try { followAbort.abort(); } catch { /* already closed */ }
    }
    if (inputSecretCreated) {
      await deleteIfPresent(core, 'deleteNamespacedSecret', inputSecretName, namespace)
        .catch((err) => log.warn('kubernetes', 'Check input Secret cleanup failed', {
          name: inputSecretName, err: err.message,
        }));
    }
  }
}

// ── Harvesting a run whose launcher died (services/check-harvest.js) ──
//
// runCheckJob above owns a Job for the life of the process that created it.
// When that process is replaced mid-run — a platform rollout — the Job runs
// on to completion regardless, and these two functions are how a later
// process finds it and reads what it produced, without creating or deleting
// anything. Deletion stays with the Job's own TTL / activeDeadline, with
// cancelPreviewChecks, which a newer run for the session calls first, and
// with deleteSettledCheckJobs, once a run's verdict is stored.

function describeCheckJob(job) {
  const failedCondition = (job.status?.conditions || []).find(c => c.type === 'Failed' && c.status === 'True');
  const failed = !!(job.status?.failed || failedCondition);
  const succeeded = !failed && !!job.status?.succeeded;
  return {
    name: job.metadata?.name || '',
    uid: job.metadata?.uid || null,
    state: failed ? 'failed' : (succeeded ? 'succeeded' : 'running'),
    failedReason: failedCondition?.reason || null,
    startedAt: job.status?.startTime || job.metadata?.creationTimestamp || null,
    finishedAt: failed ? (failedCondition?.lastTransitionTime || null)
      : (succeeded ? (job.status?.completionTime || null) : null),
  };
}

// The check Jobs one run created, by kind: `{ capture, unitSuite }`, each
// a describeCheckJob() summary or null when that Job does not exist (never
// created, already garbage-collected, or deleted by a newer run). Matched by
// the preview-run-id label runCheckJob stamps, so a session's OTHER runs are
// never mistaken for this one.
async function findCheckJobs(config, { sessionId, previewRunId }) {
  if (!previewRunId) return { capture: null, unitSuite: null };
  const { batch } = getClients();
  const namespace = config.kubernetes.workerNamespace;
  const selector = `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/session-id=${sessionId},social.usernode.io/preview-run-id=${previewRunId}`;
  const jobs = await batch.listNamespacedJob({ namespace, labelSelector: selector });
  // `captures` is every capture Job of the run, by name: one, or one per
  // shard plus a sweep (services/visuals.js runCaptureShards). `capture` is
  // the first of them, as before shards existed.
  // `unitSuites` likewise: one Job, or one per shard of a split suite,
  // with the shard count its label gives (`unitShards`).
  const found = { capture: null, captures: [], unitSuite: null, unitSuites: [], unitShards: 1 };
  for (const job of jobs.items || []) {
    const name = job.metadata?.name || '';
    if (name.startsWith(`sv-capture-s${sessionId}-`)) found.captures.push(describeCheckJob(job));
    else if (name.startsWith(`sv-unit-suite-s${sessionId}-`) || name.startsWith(`sv-unit-early-s${sessionId}-`)) {
      found.unitSuites.push(describeCheckJob(job));
      const of = /^\d+-of-(\d+)$/.exec(job.metadata?.labels?.['social.usernode.io/unit-shard'] || '');
      if (of) found.unitShards = Math.max(found.unitShards, Number(of[1]));
    }
  }
  found.captures.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  found.capture = found.captures[0] || null;
  found.unitSuites.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  found.unitSuite = found.unitSuites[0] || null;
  return found;
}

// Stop a session's check Jobs that are still running, except those of the
// runs `spare` names (by preview-run-id): the runs a newer one supersedes
// (check-harvest.stopSupersededRuns). Unlike cancelPreviewChecks this waits
// for nothing. The policy is a query option with no body, as deleteIfPresent
// sends it: with a body the API server reads the options from the body
// alone, and a batch/v1 Job deleted without a policy orphans its Pod and
// input Secret. Background propagation takes both (runCheckJob points the
// Secret's ownerReference at its Job). Each name carries its run id, so no
// precondition is needed. A finished Job holds no capacity and is left for
// its TTL, and a Job with no run label names no run that could be
// superseded. Returns the names it deleted.
async function stopCheckJobs(config, { sessionId, spare = () => false }) {
  const { batch } = getClients();
  const namespace = config.kubernetes.workerNamespace;
  const selector = `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/session-id=${sessionId}`;
  const jobs = await batch.listNamespacedJob({ namespace, labelSelector: selector });
  const stopping = (jobs.items || []).filter((job) => {
    const name = job.metadata?.name || '';
    if (!name.startsWith(`sv-capture-s${sessionId}-`) && !name.startsWith(`sv-unit-suite-s${sessionId}-`)) return false;
    const runId = job.metadata?.labels?.['social.usernode.io/preview-run-id'];
    if (!runId || spare(runId)) return false;
    return !job.metadata?.deletionTimestamp && describeCheckJob(job).state === 'running';
  });
  await Promise.all(stopping.map((job) => deleteIfPresent(
    batch, 'deleteNamespacedJob', job.metadata.name, namespace, { propagationPolicy: 'Background' },
  )));
  return stopping.map((job) => job.metadata.name);
}

// Wait for a check Job to end and return its whole output. Same shape a
// runCheckJob caller sees, minus the throw: `{ state, stdout, stderr,
// exitCode, timedOut, partial, partialReason, podStart }`, where `state` is 'succeeded'
// | 'failed' | 'gone' (the Job disappeared — a newer run cancelled it, or
// the TTL collected it) | 'timeout' (our own wait ran out; the Job's
// activeDeadline should have ended it long before, so this is a stuck
// cluster rather than a slow suite). A Job that is still running is
// polled every 2s, and its log is re-read every few ticks so `onStdoutLine`
// sees the frames as they land — the same cadence runCheckJob's polled path
// gives, which is what keeps the card's bar moving across the hand-over.
// Lines are delivered from the START of the log, so an observer rebuilding
// progress state sees every frame the run ever printed. An aborted `signal`
// ends the wait with state 'aborted' — the adopter was superseded, and the
// Job is the successor's to cancel.
async function collectCheckJob(config, {
  name, kind, timeoutMs = 20 * 60 * 1000, maxBuffer = 64 * 1024 * 1024, onStdoutLine = null, signal = null,
}) {
  const { batch, core } = getClients();
  const namespace = config.kubernetes.workerNamespace;
  const unitSuite = kind === 'unit-suite';
  const PROGRESS_EVERY_TICKS = 3;
  let podName = null;
  let consumed = 0;
  let tick = 0;
  // The Pod's start state, as runCheckJob keeps it (check-pod-start.js),
  // returned with every state: the harvest needs it most when the Job ended
  // by its deadline and took the Pod with it.
  let podStart = null;
  const notePod = (pod) => { if (pod) podStart = mergePodStart(podStart, readPodStart(pod, kind)); };
  const retained = createCheckOutputAccumulator(maxBuffer);
  const findPod = async () => {
    if (podName) return podName;
    const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` });
    podName = pods.items?.[0]?.metadata?.name || null;
    notePod(pods.items?.[0]);
    return podName;
  };
  const watchStart = async () => {
    if (podStart?.started) return;
    try {
      const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` });
      podName = podName || pods.items?.[0]?.metadata?.name || null;
      notePod(pods.items?.[0]);
    } catch { /* the last reading stands */ }
  };
  const readLog = async ({ limitBytes }) => {
    if (!(await findPod())) return '';
    return String(await core.readNamespacedPodLog({ name: podName, namespace, container: kind, limitBytes }) || '');
  };
  const deliverNew = (text) => {
    if (text.length <= consumed) return;
    const fresh = text.slice(consumed);
    const lastNl = fresh.lastIndexOf('\n');
    if (lastNl === -1) return;
    for (const line of fresh.slice(0, lastNl).split('\n')) {
      retained.appendLine(line);
      if (typeof onStdoutLine === 'function') {
        try { onStdoutLine(line); } catch { /* observer must not break the harvest */ }
      }
    }
    consumed += lastNl + 1;
  };
  const boundedOutput = text => boundedCheckOutput(text, maxBuffer);
  const finish = async (job) => {
    const described = describeCheckJob(job);
    let raw = '';
    let logFailed = false;
    try { raw = await readLog({ limitBytes: unitSuite ? maxBuffer : maxBuffer + 1 }); }
    catch { logFailed = true; }
    // Everything the observer has not yet seen, so the progress state the
    // caller is rebuilding ends level with the verdict it is about to read.
    deliverNew(raw);
    const reconciled = reconcileCheckOutput(retained.output(), raw);
    const over = !unitSuite && (Buffer.byteLength(raw, 'utf8') > maxBuffer
      || retained.truncated);
    const stdout = over ? boundedOutput(reconciled) : reconciled;
    let exitCode = null;
    let terminatedReason = null;
    try {
      const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` });
      notePod(pods.items?.[0]);
      const terminated = pods.items?.[0]?.status?.containerStatuses?.find(c => c.name === kind)?.state?.terminated;
      if (terminated) { exitCode = terminated.exitCode ?? null; terminatedReason = terminated.reason || null; }
    } catch { /* the Job's own status is enough */ }
    const timedOut = described.failedReason === 'DeadlineExceeded' || terminatedReason === 'OOMKilled';
    const partial = described.state === 'failed' || over || logFailed;
    return {
      state: described.state,
      stdout,
      stderr: [described.failedReason, terminatedReason].filter(Boolean).join(': '),
      exitCode,
      timedOut,
      partial,
      partialReason: !partial ? ''
        : over ? 'output over maxBuffer'
          : logFailed ? 'capture log unavailable'
            : terminatedReason === 'OOMKilled' ? 'capture OOM killed'
              : timedOut ? 'run timed out' : `job ${described.failedReason || 'failed'}`,
      podStart,
    };
  };
  const empty = (state, partialReason) => ({
    state, stdout: '', stderr: '', exitCode: null, timedOut: false, partial: true, partialReason, podStart,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return empty('aborted', 'harvest superseded');
    let job;
    try { job = await batch.readNamespacedJob({ name, namespace }); }
    catch (err) {
      if (isNotFound(err)) return empty('gone', 'job gone');
      throw err;
    }
    const described = describeCheckJob(job);
    if (described.state !== 'running') return finish(job);
    tick += 1;
    if (tick % PROGRESS_EVERY_TICKS === 1) {
      await watchStart();
      try { deliverNew(await readLog({ limitBytes: maxBuffer })); } catch { /* progress is best-effort */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await watchStart();
  let stdout = '';
  try {
    const raw = await readLog({ limitBytes: maxBuffer });
    deliverNew(raw);
    stdout = boundedOutput(reconcileCheckOutput(retained.output(), raw));
  } catch { stdout = retained.output(); }
  return {
    state: 'timeout', stdout, stderr: '', exitCode: null, timedOut: true, partial: true, partialReason: 'run timed out',
    podStart,
  };
}

// A settled run's Jobs: its verdict is stored and the manifest a harvest
// would find them by is cleared, so nothing reads them again. Deleting them
// then, rather than leaving each for CHECK_JOB_TTL_SECONDS, keeps the worker
// namespace's Job count near the runs in flight; the TTL held every run of
// the last hour, two Jobs each, and filled 100 of 100 on 7 Oct 2026. Only
// this run's finished Jobs go: one still running is left to its deadline and
// TTL. Background propagation takes the Pods and the owned input Secret too.
// Resolves how many were deleted.
async function deleteSettledCheckJobs(config, { sessionId, previewRunId }) {
  if (!previewRunId) return 0;
  const { batch } = getClients();
  const namespace = config.kubernetes.workerNamespace;
  const selector = `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/session-id=${sessionId},social.usernode.io/preview-run-id=${previewRunId}`;
  const jobs = await batch.listNamespacedJob({ namespace, labelSelector: selector });
  let deleted = 0;
  for (const job of jobs.items || []) {
    const name = job.metadata?.name || '';
    if (!name.startsWith(`sv-capture-s${sessionId}-`) && !name.startsWith(`sv-unit-suite-s${sessionId}-`)
        && !name.startsWith(`sv-unit-early-s${sessionId}-`)) continue;
    if (job.metadata?.labels?.['social.usernode.io/preview-run-id'] !== previewRunId) continue;
    if (job.metadata?.deletionTimestamp || describeCheckJob(job).state === 'running') continue;
    await deleteIfPresent(batch, 'deleteNamespacedJob', name, namespace, { propagationPolicy: 'Background' });
    deleted += 1;
  }
  return deleted;
}

// ── What a check run can leave behind (services/check-retention.js) ──
//
// Every Job and Pod in the worker namespace, and every Secret the platform
// manages there, each list read to its end. Jobs and Pods are unfiltered
// because anything that references a Secret keeps it; Secrets are only the
// platform's own because nothing else is ours to delete. A page that fails
// fails the whole inventory: a partial list must never read as "nothing
// references this".
async function listCheckLeftovers(config) {
  const { batch, core } = getClients();
  const namespace = config.kubernetes.workerNamespace;
  const all = async (api, method, labelSelector) => {
    const items = [];
    let next;
    do {
      const page = await api[method]({ namespace, ...(labelSelector ? { labelSelector } : {}), limit: 500, _continue: next });
      if (!Array.isArray(page?.items)) throw new Error(`Invalid ${method} inventory`);
      items.push(...page.items);
      next = page.metadata?.continue;
    } while (next);
    return items;
  };
  const [jobs, pods, secrets] = await Promise.all([
    all(batch, 'listNamespacedJob'),
    all(core, 'listNamespacedPod'),
    all(core, 'listNamespacedSecret', `app.kubernetes.io/managed-by=${MANAGED_BY}`),
  ]);
  return { jobs, pods, secrets };
}

// Deletes exactly the object the sweep judged. One that changed since (an
// owner written onto it, say) fails the precondition with a 409 and stays.
async function deleteCheckLeftover(config, kind, metadata) {
  const { name, uid, resourceVersion } = metadata || {};
  if (!name || !uid || !resourceVersion) throw new Error('Check leftover deletion requires a name, UID and resourceVersion');
  const method = { pod: 'deleteNamespacedPod', secret: 'deleteNamespacedSecret' }[kind];
  if (!method) throw new Error(`Unknown check leftover kind: ${kind}`);
  await getClients().core[method]({
    name, namespace: config.kubernetes.workerNamespace, body: { preconditions: { uid, resourceVersion } },
  });
}

// The pod-log follow client: an injected `logs` for tests, else one built
// on the real kube config. Null where neither exists (a test that injected
// only the typed API clients), which leaves the polled read in charge.
function clientsLogApi(clients) {
  if (!clients) return null;
  if (clients.logs && typeof clients.logs.log === 'function') return clients.logs;
  if (clients.kc) {
    try {
      const k8s = kubernetesClient();
      clients.logs = new k8s.Log(clients.kc);
      return clients.logs;
    } catch { return null; }
  }
  return null;
}

// Feed a readable's bytes to `onLine` one complete line at a time, after
// skipping the first `skipBytes` CHARACTERS (what a polled read already
// delivered — `consumed` above counts characters of the decoded log, so the
// skip does too; a StringDecoder keeps a multi-byte character split across
// chunks whole). Chunk boundaries fall anywhere; the trailing partial is
// flushed at end. Same contract as docker.attachLineObserver, kept local so
// the two runtime modules do not import each other.
function attachLineObserver(readable, onLine, { skipBytes = 0 } = {}) {
  const { StringDecoder } = require('string_decoder');
  const decoder = new StringDecoder('utf8');
  let toSkip = Math.max(0, skipBytes | 0);
  let carry = '';
  const deliver = (line) => { try { onLine(line); } catch { /* observer must not break the run */ } };
  readable.on('data', (chunk) => {
    let text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    if (toSkip > 0) {
      const n = Math.min(toSkip, text.length);
      text = text.slice(n);
      toSkip -= n;
      if (!text) return;
    }
    carry += text;
    let nl;
    while ((nl = carry.indexOf('\n')) !== -1) {
      deliver(carry.slice(0, nl));
      carry = carry.slice(nl + 1);
    }
  });
  readable.on('end', () => {
    carry += decoder.end();
    if (carry) { deliver(carry); carry = ''; }
  });
  readable.on('error', () => {});
}

async function execInWorker(config, runtimeName, command, stdinText = null, { timeoutMs = 30000, maxBuffer = null } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Worker exec timeout must be a positive finite number');
  if (maxBuffer !== null && (!Number.isFinite(maxBuffer) || maxBuffer <= 0)) throw new Error('Worker exec maxBuffer must be a positive finite number');
  const namespace = config.kubernetes.workerNamespace;
  const stdout = new stream.PassThrough();
  const stderr = new stream.PassThrough();
  let out = ''; let err = '';
  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  const input = stdinText === null ? null : stream.Readable.from([stdinText]);
  return new Promise((resolve, reject) => {
    let socket;
    let status;
    let settled = false;
    const disconnect = () => {
      if (!socket || socket.readyState === 3) return;
      try { socket.terminate(); } catch (_) { /* transport already gone */ }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input?.destroy();
      stdout.destroy();
      stderr.destroy();
      disconnect();
      if (error) {
        error.stdout = out;
        error.stderr = err;
        reject(error);
      } else resolve({ stdout: out, stderr: err });
    };
    // Bound discovery, connection setup and execution together. A timeout
    // releases the caller; it cannot prove that the remote command stopped.
    const timer = setTimeout(() => {
      const error = new Error(`Worker exec timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      finish(error);
    }, timeoutMs);
    let outputBytes = 0;
    const collect = (isStdout) => (chunk) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (maxBuffer !== null && outputBytes > maxBuffer) {
        const error = new Error('Worker exec output exceeds maxBuffer');
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        finish(error);
        return;
      }
      if (isStdout) out += chunk;
      else err += chunk;
    };
    stdout.on('data', collect(true));
    stderr.on('data', collect(false));
    stdout.on('error', finish);
    stderr.on('error', finish);
    const onClose = () => {
      if (status?.status === 'Success') return finish();
      const error = new Error(status?.status === 'Failure'
        ? err || status.message || 'Worker exec failed'
        : 'Worker exec closed without a successful exit status');
      const exitCode = status?.details?.causes?.find(cause => cause.reason === 'ExitCode')?.message;
      if (exitCode !== undefined) error.code = Number(exitCode);
      finish(error);
    };
    (async () => {
      const api = getClients();
      const pods = await api.core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${runtimeName}` });
      if (settled) return;
      const pod = pods.items?.[0];
      if (!pod) {
        // Missing Pods can mean a starting Deployment. Prove absence through
        // the API before telling liveness callers that the worker is gone.
        // This lookup remains inside the exec operation's timeout budget.
        const workerState = await getWorkerStatus(config, runtimeName);
        if (settled) return;
        const error = new Error(`Worker Pod for ${runtimeName} not found`);
        if (workerState === 'not_found') error.code = 'WORKER_NOT_FOUND';
        throw error;
      }
      const exec = api.exec || new (kubernetesClient().Exec)(api.kc);
      socket = await exec.exec(namespace, pod.metadata.name, 'worker', command, stdout, stderr, input, false, value => { status = value; });
      // Keep an error handler even after settling: terminating a late socket
      // can emit an error. Never let a timed-out connection resume stdin.
      socket.on('error', error => finish(error instanceof Error ? error : new Error('Worker exec transport failed')));
      if (settled) { disconnect(); return; }
      socket.on('close', onClose);
      // A short command may finish before Exec.exec returns its socket.
      if (socket.readyState === 3) onClose();
    })().catch(finish);
  });
}

module.exports = {
  batchWorkPlacement, waitForBatchPool: waitForCheckPool,
  reconcileAppResourceProfiles,
  readProductionForSleep, scaleProductionForSleep, appGateActivity,
  checkPoolCapacity,
  previewServesAttempt,
  restorePreviewAttempt,
  scaledPreviewDeployment, scalePreview, waitForPreview, ingressForSleep, routePreviewForSleep,
  dnsName, withSuffix, labels, appResourceName, createBuild, buildReadsBelowSourceRoot,
  deployApplication, getApplicationStatus, inspectApplication,
  getApplicationLogs, getDebugLogs, restartApplication, deleteApplication, deleteBuilds, deleteFailedBuilds, ensureWorker, workerAvoidNodes,
  attemptSecretName, previewResourcesPresent, deleteSecret, PREVIEW_ATTEMPT_ANNOTATION, attemptFence, fenceValue, fenceNewer,
  listManagedBuilds, readBuild, deleteBuildSnapshot,
  runCaptureJob, runUnitSuiteJob, cancelPreviewChecks, findCheckJobs, collectCheckJob,
  checkJobRunName, deleteCheckJob, countRunningUnitSuiteJobs, deleteRunCheckJobs,
  deleteSettledCheckJobs, listCheckLeftovers, deleteCheckLeftover, MANAGED_BY, CHECK_JOB_TTL_SECONDS,
  execInWorker, _getClients: getClients,
  getWorkerStatus, getWorkerContractVersion, getWorkerRuntimeMetadata, deleteWorker, eraseWorker,
  workerIdentity, deleteWorkerIdentity, workerIdentityGone, listWorkers,
  listWorkerVolumes, retirePlatformPreviewPolicy, listPreviews, listPreviewResources, deletePreviewRoutingResource, listShotsRuntimes, isQuotaExceeded,
  listStatusResources, listNamespaceCapacity, inspectWorkerTermination, getPlatformDeployStatus,
  readPlatformPod, stopCheckJobs,
  _setClientsForTest: setClientsForTest, _envChecksumForTest: envChecksum, _upsertForTest: upsert,
  _packageRunsScriptForTest: packageRunsScript,
  _attachLineObserverForTest: attachLineObserver,
  _clientsLogApiForTest: clientsLogApi,
  _buildPhasesFromPodForTest: buildPhasesFromPod,
  podStartTimeline,
  _deploymentStateForTest: deploymentState,
  _waitForDeploymentForTest: waitForDeployment,
  _terminalPodFailureDetailsForTest: terminalPodFailureDetails,
  _normalizeDeploymentForTest: normalizeDeployment,
  _quantityNumberForTest: quantityNumber,
  PLATFORM_ASSET_PREFIXES, PLATFORM_ASSET_NAME, ensurePlatformAssetBackend,
  _appIngressManifestForTest: appIngressManifest,
  customDomainResourceName, customDomainIngressManifest, deployCustomDomain, deleteCustomDomain,
  CUSTOM_DOMAIN_SERVICE_ANNOTATION,
  _platformAssetEnvForTest: platformAssetEnv,
  APP_GATE_NAME, APP_GATE_HEALTH_PATH, appGateMode, ensureAppGateBackend, reconcileAppGateIngresses,
  _appGateDeploymentManifestForTest: appGateDeploymentManifest,
  _ingressWithGateRouteForTest: ingressWithGateRoute,
  reconcileAppsDomainIngresses, ingressOnAppsDomain,
  _resetAppGateForTest: () => { appGateBackend = null; appGateBackendRetryAfter = 0; appGateBackendReady = false; },
  _ingressWithPlatformAssetRoutesForTest: ingressWithPlatformAssetRoutes,
  _reconcilePlatformAssetIngressesForTest: reconcilePlatformAssetIngresses,
  _ensurePlatformAssetBackendForTest: ensurePlatformAssetBackend,
  _resetPlatformAssetBackendForTest: () => {
    platformAssetBackend = null; platformAssetBackendRetryAfter = 0; platformAssetBackendReady = false;
  },
  _sharedBackendServingForTest: sharedBackendServing,
};
