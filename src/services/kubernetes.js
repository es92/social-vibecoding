const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const k8s = require('@kubernetes/client-node');
const log = require('./logger');
const { collectPodDiagnostics, conditionDetails, boundedText } = require('./kubernetes-diagnostics');
const { waitForWorkerBootstrap } = require('./kubernetes-worker-bootstrap');
const buildkit = require('./kubernetes-buildkit');

const MANAGED_BY = 'social-vibecoding-runtime';
const PART_OF = 'social-vibecoding';

// How often a build or rollout is re-read while it is being waited on. The
// wait is a cheap GET against a cached object; what the interval buys is
// how long a finished step sits unnoticed, which at 2-3s was a visible
// slice of a ~25s preview turnaround.
const BUILD_POLL_MS = 1000;
const ROLLOUT_POLL_MS = 1000;
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

async function upsert(api, readMethod, createMethod, replaceMethod, namespace, body) {
  const name = body.metadata.name;
  try {
    const current = await api[readMethod]({ name, namespace });
    body.metadata.resourceVersion = current.metadata.resourceVersion;
    if (body.kind === 'Service') {
      for (const field of ['clusterIP', 'clusterIPs', 'ipFamilies', 'ipFamilyPolicy', 'healthCheckNodePort']) {
        if (current.spec?.[field] !== undefined) body.spec[field] = current.spec[field];
      }
    }
    return api[replaceMethod]({ name, namespace, body });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return api[createMethod]({ namespace, body });
  }
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
// build. Under `buildkit` the failure surfaces, because that setting is the
// way to find out the lane is not actually being used.
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
    buildkit.noteUnavailable(err);
    log.warn('kubernetes', 'BuildKit lane unavailable; building with kpack', {
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
  if (!/^https:\/\/github\.com\//.test(app.repo_url || '')) {
    throw new Error('Kubernetes builds require an HTTPS GitHub repository URL');
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
      source: { git: { url: app.repo_url.replace(/\.git$/, ''), revision } },
      activeDeadlineSeconds: cfg.activeDeadlineSeconds,
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

function previewDatabaseAffinity(cfg, environment) {
  if (environment !== 'staging' || !cfg.previewDatabaseNamespace || !cfg.previewDatabaseCluster) return {};
  return {
    affinity: {
      podAffinity: {
        // A preference leaves other eligible nodes available immediately.
        // Select the primary role, not a Pod/node name, so new scheduling
        // follows CNPG failover without moving already-running previews.
        preferredDuringSchedulingIgnoredDuringExecution: [{
          weight: 100,
          podAffinityTerm: {
            namespaces: [cfg.previewDatabaseNamespace],
            labelSelector: { matchLabels: {
              'cnpg.io/cluster': cfg.previewDatabaseCluster,
              'cnpg.io/instanceRole': 'primary',
            } },
            topologyKey: 'kubernetes.io/hostname',
          },
        }],
      },
    },
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
function appIngressManifest({ name, namespace, hostname, resourceLabels, cfg, assetBackend }) {
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
        { path: '/', pathType: 'Prefix', backend: { service: { name, port: { number: 3000 } } } },
      ] } }],
      tls: [{ hosts: [hostname], secretName: cfg.appTlsSecretName || 'social-apps-wildcard-tls' }],
    },
  };
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
  const domain = String(config?.kubernetes?.appDomain || '');
  const host = String(hostname || '');
  if (!slug || !domain || !host.endsWith(`.${domain}`)) return false;
  const appLabel = host.slice(0, -(domain.length + 1));
  if (appLabel === slug) return true;
  const previewId = appLabel.slice(`${slug}--s`.length);
  return appLabel.startsWith(`${slug}--s`) && /^\d+$/.test(previewId);
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
    await networking.replaceNamespacedIngress({ name, namespace, body });
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

async function ensurePlatformAssetBackend(config, { readyTimeoutMs = 45000, retryAfterMs = 300000 } = {}) {
  if (platformAssetBackend) return platformAssetBackend;
  // Still cooling off from a failure: no backend, and crucially no wait.
  if (Date.now() < platformAssetBackendRetryAfter) return null;
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

// `cpus` is the container's CPU LIMIT (a ceiling, not a request — requests
// stay at 100m so scheduling is unchanged). Staging previews pass
// docker.STAGING_CPUS through application-runtime.deploy so the capture
// run's eight concurrent pages get the same headroom on both runtimes;
// production apps pass nothing and keep the 1-CPU limit they always had.
async function deployApplication(config, {
  app, environment, sessionId, imageRef, env, cpus = null,
  labels: extraLabels = {}, runtimeName = null, internalOnly = false,
}) {
  if (!imageRef?.includes('@sha256:')) throw new Error('Kubernetes deployments require an immutable image digest');
  const cfg = config.kubernetes;
  const namespace = cfg.appNamespace;
  const name = runtimeName || appResourceName(app, environment, sessionId);
  if (name !== dnsName(name) || name.length > 63) throw new Error('Invalid Kubernetes runtime name');
  const resourceLabels = { ...extraLabels, ...labels({ appId: app.id, sessionId, environment }) };
  const selectorLabels = { 'social.usernode.io/runtime-name': name };
  const secretName = withSuffix(name, 'env');
  const hostname = environment === 'production'
    ? `${app.slug}.${cfg.appDomain}`
    : `${app.slug}--s${sessionId}.${cfg.appDomain}`;
  // Check before creating or updating any Kubernetes resources.
  require('./caddy').assertAppHostname(hostname, cfg.platformDomain);
  const { core, apps, networking } = getClients();

  await upsert(core, 'readNamespacedSecret', 'createNamespacedSecret', 'replaceNamespacedSecret', namespace, {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: secretName, namespace, labels: resourceLabels },
    type: 'Opaque', stringData: Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)])),
  });
  await upsert(core, 'readNamespacedService', 'createNamespacedService', 'replaceNamespacedService', namespace, {
    apiVersion: 'v1', kind: 'Service', metadata: { name, namespace, labels: resourceLabels },
    spec: { selector: selectorLabels, ports: [{ name: 'http', port: 3000, targetPort: 3000 }], type: 'ClusterIP' },
  });
  const deployed = await upsert(apps, 'readNamespacedDeployment', 'createNamespacedDeployment', 'replaceNamespacedDeployment', namespace, {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace, labels: resourceLabels },
    spec: {
      replicas: 1,
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: {
          labels: { ...resourceLabels, ...selectorLabels },
          annotations: { 'social.usernode.io/env-checksum': envChecksum(env) },
        },
        spec: {
          serviceAccountName: cfg.generatedAppServiceAccount,
          automountServiceAccountToken: false,
          securityContext: podSecurityContext(),
          ...previewDatabaseAffinity(cfg, environment),
          containers: [{
            name: 'app', image: imageRef, imagePullPolicy: 'IfNotPresent',
            ports: [{ name: 'http', containerPort: 3000 }],
            env: app.slug === config.selfAppSlug
              ? [{ name: 'USERNODE_SHELL_ASSETS_PREBUILT', value: '1' }]
              : [],
            envFrom: [{ secretRef: { name: secretName } }],
            ...httpProbes({ startupFailureThreshold: 120 }),
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: String(cpus || '1'), memory: '1Gi' } },
            securityContext: containerSecurityContext(),
          }],
        },
      },
    },
  });
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
      const backend = await ensurePlatformAssetBackend(config);
      if (app.slug !== config.selfAppSlug) assetBackend = backend;
    } catch (err) {
      log.warn('kubernetes', 'platform asset backend unavailable — app deploys without asset routing', {
        namespace, app: app.slug, error: err?.message,
      });
    }
    await upsert(networking, 'readNamespacedIngress', 'createNamespacedIngress', 'replaceNamespacedIngress', namespace,
      appIngressManifest({ name, namespace, hostname, resourceLabels, cfg, assetBackend }));
  }
  try {
    await waitForDeployment(namespace, name, {
      generation: deployed?.metadata?.generation,
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
    // A failed preview has no serving value but its declared CPU limit still
    // consumes ResourceQuota. Production keeps its prior ReplicaSet for a
    // recoverable rollout; previews are disposable and are rebuilt on retry.
    if (environment !== 'production') {
      await deleteApplication(config, name).catch((cleanupErr) => {
        log.warn('kubernetes', 'Failed preview cleanup failed', {
          namespace, name, err: cleanupErr.message,
        });
      });
    }
    throw err;
  }
  return {
    runtimeKind: 'kubernetes', runtimeName: name, imageRef,
    hostname: internalOnly ? `${name}.${namespace}.svc` : hostname,
    url: internalOnly ? `http://${name}.${namespace}.svc:3000` : `https://${hostname}`,
  };
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

async function waitForDeployment(namespace, name, {
  timeoutMs = 5 * 60 * 1000, generation = 0, terminalPodFilter = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const { apps, core } = getClients();
  let rolloutDetails = '';
  while (Date.now() < deadline) {
    const deployment = await apps.readNamespacedDeployment({ name, namespace });
    const desired = deployment.spec?.replicas ?? 1;
    const status = deployment.status || {};
    rolloutDetails = boundedText(conditionDetails(status.conditions).join('\n'), 4096);
    // An available OLD replica keeps serving during a rolling update. Wait
    // for the controller to observe our write, replace every old replica,
    // and make the updated replicas ready and available before publishing it.
    if (!deployment.metadata.deletionTimestamp && desired > 0
        && status.observedGeneration >= Math.max(generation, deployment.metadata.generation)
        && status.updatedReplicas === desired && status.replicas === desired
        && status.readyReplicas >= desired && status.availableReplicas >= desired) return deployment;
    // A Pod rejected before its process starts will never become healthy, so
    // waiting the whole rollout budget only turns a precise configuration
    // error into a five-minute "spinning up" delay. This read is best-effort:
    // transient API errors keep the ordinary rollout waiter in control.
    if (terminalPodFilter && typeof core?.listNamespacedPod === 'function') {
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
    await new Promise((resolve) => setTimeout(resolve, ROLLOUT_POLL_MS));
  }
  const err = new Error(`Timed out waiting for Deployment ${namespace}/${name}`);
  err.rolloutDetails = rolloutDetails;
  throw err;
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
    return { status, labels: deployment.spec?.template?.metadata?.labels || {},
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

async function restartApplication(config, runtimeName) {
  const namespace = config.kubernetes.appNamespace;
  const deployment = await getClients().apps.readNamespacedDeployment({ name: runtimeName, namespace });
  deployment.spec.template.metadata ||= {};
  deployment.spec.template.metadata.annotations ||= {};
  deployment.spec.template.metadata.annotations['social.usernode.io/restarted-at'] = new Date().toISOString();
  const restarted = await getClients().apps.replaceNamespacedDeployment({ name: runtimeName, namespace, body: deployment });
  return waitForDeployment(namespace, runtimeName, { generation: restarted?.metadata?.generation });
}

async function deleteApplication(config, runtimeName) {
  const namespace = config.kubernetes.appNamespace;
  const { apps, core, networking } = getClients();
  const coordinated = require('./preview-lifecycle').enabled(config);
  let uid;
  if (coordinated) {
    try { uid = (await apps.readNamespacedDeployment({ name: runtimeName, namespace })).metadata.uid; }
    catch (err) { if (!isNotFound(err)) throw err; }
  }
  const deletions = await Promise.allSettled([
    deleteIfPresent(networking, 'deleteNamespacedIngress', runtimeName, namespace),
    deleteIfPresent(core, 'deleteNamespacedService', runtimeName, namespace),
    deleteIfPresent(core, 'deleteNamespacedSecret', withSuffix(runtimeName, 'env'), namespace),
    // Keep shared and legacy TLS material across rebuilds, idle teardown and
    // failed rollouts. Certificate retirement is a separate operator action.
    deleteIfPresent(apps, 'deleteNamespacedDeployment', runtimeName, namespace, {
      propagationPolicy: 'Foreground', ...(uid ? { body: { preconditions: { uid } } } : {}),
    }),
  ]);
  const failed = deletions.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  if (coordinated && uid) {
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

async function ensureWorker(config, { sessionId, env, onProgress }) {
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
  try {
    const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace, labels: resourceLabels }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: cfg.workerStorageSize } } } };
    if (cfg.workerStorageClass) pvc.spec.storageClassName = cfg.workerStorageClass;
    await core.createNamespacedPersistentVolumeClaim({ namespace, body: pvc });
  } catch (err) { if (err?.code !== 409 && err?.response?.statusCode !== 409) throw err; }
  await upsert(core, 'readNamespacedSecret', 'createNamespacedSecret', 'replaceNamespacedSecret', namespace, {
    apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, namespace, labels: resourceLabels }, type: 'Opaque',
    stringData: Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)])),
  });
  const deployed = await upsert(apps, 'readNamespacedDeployment', 'createNamespacedDeployment', 'replaceNamespacedDeployment', namespace, {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: {
      name, namespace, labels: { ...resourceLabels, ...workerContractLabels },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels },
      strategy: { type: 'Recreate' },
      template: {
        metadata: {
          labels: { ...resourceLabels, ...selectorLabels, ...workerContractLabels },
          annotations: { 'social.usernode.io/env-checksum': envChecksum(env) },
        },
        spec: {
          serviceAccountName: cfg.workerServiceAccount,
          automountServiceAccountToken: false,
          securityContext: nodePodSecurityContext(),
          containers: [{
            name: 'worker', image: cfg.workerImage, imagePullPolicy: 'IfNotPresent',
            env: [{ name: 'USERNODE_WORKER_REQUIRE_READY', value: '1' }],
            envFrom: [{ secretRef: { name: secretName } }],
            volumeMounts: [{ name: 'state', mountPath: '/home/node/.claude' }],
            startupProbe: { exec: { command: ['test', '-f', '/tmp/usernode-worker-ready'] }, periodSeconds: 2, failureThreshold: 150 },
            readinessProbe: { exec: { command: ['test', '-f', '/tmp/usernode-worker-ready'] }, periodSeconds: 2, failureThreshold: 1 },
            resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: config.workerCpus || '2', memory: (config.workerMemory || '2Gi').replace(/g$/i, 'Gi') } },
            securityContext: containerSecurityContext(),
          }],
          volumes: [{ name: 'state', persistentVolumeClaim: { claimName: pvcName } }],
        },
      },
    },
  });
  await waitForWorkerBootstrap(core, apps, { namespace, name, onProgress,
    imageRef: cfg.workerImage, environmentChecksum: envChecksum(env),
    generation: deployed?.metadata?.generation || 0 });
  return { runtimeKind: 'kubernetes', runtimeName: name, pvcName };
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
    };
  } catch (err) {
    if (isNotFound(err)) return { contractVersion: null, imageRef: null };
    throw err;
  }
}

async function deleteWorker(config, sessionId, { deleteVolume = false } = {}) {
  const namespace = config.kubernetes.workerNamespace;
  const name = dnsName(`sv-worker-s${sessionId}`);
  const { apps, core } = getClients();
  await Promise.all([
    deleteIfPresent(apps, 'deleteNamespacedDeployment', name, namespace, { propagationPolicy: 'Foreground' }),
    deleteIfPresent(core, 'deleteNamespacedSecret', withSuffix(name, 'env'), namespace),
  ]);
  if (deleteVolume) await deleteIfPresent(core, 'deleteNamespacedPersistentVolumeClaim', withSuffix(name, 'state'), namespace);
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

async function cloneWorkerVolume(config, sourceSessionId, targetSessionId) {
  const cfg = config.kubernetes;
  const namespace = cfg.workerNamespace;
  const sourceRuntime = dnsName(`sv-worker-s${sourceSessionId}`);
  const sourcePvc = withSuffix(sourceRuntime, 'state');
  const targetPvc = withSuffix(dnsName(`sv-worker-s${targetSessionId}`), 'state');
  const { core, batch } = getClients();
  const source = await core.readNamespacedPersistentVolumeClaim({ name: sourcePvc, namespace });
  try {
    const body = {
      apiVersion: 'v1', kind: 'PersistentVolumeClaim',
      metadata: { name: targetPvc, namespace, labels: labels({ sessionId: targetSessionId, environment: 'worker' }) },
      spec: {
        accessModes: source.spec.accessModes || ['ReadWriteOnce'],
        resources: { requests: { storage: source.spec.resources?.requests?.storage || cfg.workerStorageSize } },
      },
    };
    if (source.spec.storageClassName) body.spec.storageClassName = source.spec.storageClassName;
    await core.createNamespacedPersistentVolumeClaim({ namespace, body });
  } catch (err) { if (err?.code !== 409 && err?.response?.statusCode !== 409) throw err; }

  const sourcePods = await core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${sourceRuntime}` });
  const sourceNode = sourcePods.items?.[0]?.spec?.nodeName;
  const name = dnsName(`sv-worker-copy-${sourceSessionId}-${targetSessionId}-${Date.now().toString(36)}`);
  const podSpec = {
    restartPolicy: 'Never', serviceAccountName: cfg.workerServiceAccount, automountServiceAccountToken: false,
    securityContext: nodePodSecurityContext(),
    containers: [{ name: 'copy', image: cfg.workerImage, command: ['sh', '-c', 'cp -a /from/. /to/'], volumeMounts: [{ name: 'from', mountPath: '/from', readOnly: true }, { name: 'to', mountPath: '/to' }], securityContext: containerSecurityContext(), resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '1Gi' } } }],
    volumes: [{ name: 'from', persistentVolumeClaim: { claimName: sourcePvc, readOnly: true } }, { name: 'to', persistentVolumeClaim: { claimName: targetPvc } }],
  };
  if (sourceNode) podSpec.nodeName = sourceNode;
  await batch.createNamespacedJob({ namespace, body: { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace, labels: labels({ sessionId: targetSessionId, environment: 'worker' }) }, spec: { backoffLimit: 0, activeDeadlineSeconds: 300, ttlSecondsAfterFinished: 3600, template: { metadata: { labels: labels({ sessionId: targetSessionId, environment: 'worker' }) }, spec: podSpec } } } });
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await batch.readNamespacedJob({ name, namespace });
    if (job.status?.succeeded) return;
    if (job.status?.failed) throw new Error(`Worker PVC copy Job ${name} failed`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for worker PVC copy Job ${name}`);
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

async function runEvidenceJob(config, options) {
  return runCheckJob(config, { memory: '6g', cpus: '8', ...options }, 'evidence');
}

async function runUnitSuiteJob(config, options) {
  return runCheckJob(config, options, 'unit-suite');
}

// A DELETE response only acknowledges termination. Keep preview ownership
// until every consuming Pod has stopped, including Jobs orphaned by a crash.
async function cancelPreviewChecks(config, sessionId) {
  const { batch, core } = getClients();
  const namespace = config.kubernetes.workerNamespace;
  const selector = `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/session-id=${sessionId}`;
  const jobs = await batch.listNamespacedJob({ namespace, labelSelector: selector });
  await Promise.all((jobs.items || []).map(async job => {
    const name = job.metadata.name;
    if (!name.startsWith(`sv-capture-s${sessionId}-`)
        && !name.startsWith(`sv-evidence-s${sessionId}-`)
        && !name.startsWith(`sv-unit-suite-s${sessionId}-`)) return;
    const podsStopped = async () => {
      const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` });
      return (pods.items || []).every(pod => ['Succeeded', 'Failed'].includes(pod.status?.phase));
    };
    if ((job.status?.succeeded || job.status?.failed) && await podsStopped()) return;
    await deleteIfPresent(batch, 'deleteNamespacedJob', name, namespace, {
      propagationPolicy: 'Foreground', body: { preconditions: { uid: job.metadata.uid } },
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

async function runCheckJob(config, {
  sessionId, env, stdinPayload = null, timeoutMs = 180000,
  onStdoutLine = null, cmd, memory = '2g', cpus = '4', maxBuffer = 64 * 1024 * 1024,
  salvagePartial = false, signal = null, previewRunId = null,
}, kind) {
  const cfg = config.kubernetes;
  const unitSuite = kind === 'unit-suite';
  const evidence = kind === 'evidence';
  const cpuLimit = String(cpus);
  const memoryLimit = String(memory).replace(/g$/i, 'Gi').replace(/m$/i, 'Mi');
  const resources = {
    requests: {
      cpu: checkResourceRequest('1', cpuLimit, 'CPU'),
      memory: checkResourceRequest(unitSuite ? '1Gi' : '3Gi', memoryLimit, 'memory'),
      'ephemeral-storage': '1Gi',
    },
    limits: { cpu: cpuLimit, memory: memoryLimit, 'ephemeral-storage': unitSuite ? '8Gi' : '4Gi' },
  };
  const image = unitSuite ? cfg.workerImage : cfg.captureImage;
  if (!image?.includes('@sha256:')) throw new Error(`${unitSuite ? 'KUBERNETES_WORKER_IMAGE' : 'KUBERNETES_CAPTURE_IMAGE'} must be an immutable digest`);
  const namespace = cfg.workerNamespace;
  const runName = `sv-${kind}-s${sessionId}-${previewRunId || Date.now().toString(36)}`;
  // One evidence run launches two clean replay passes, and a repair may
  // launch more. Finished Jobs remain for their TTL, so the run id is a
  // correlation label, not a unique Job name. Keep the suffix even if the
  // base must be truncated to fit Kubernetes' DNS name limit. Reserve room
  // for the input Secret's "-input" suffix without truncating the nonce.
  const name = evidence ? withSuffix(runName, crypto.randomBytes(8).toString('hex'), 57) : dnsName(runName);
  const inputSecretName = !unitSuite && stdinPayload == null ? null : withSuffix(name, 'input');
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
    container.args = [evidence
      ? 'exec node /app/evidence-replay.js < /var/run/usernode-capture/tests.json'
      : 'exec node /app/capture.js < /var/run/usernode-capture/tests.json'];
    container.volumeMounts = [{
      name: 'capture-input', mountPath: '/var/run/usernode-capture', readOnly: true,
    }];
    podVolumes.push({
      name: 'capture-input',
      secret: { secretName: inputSecretName, items: [{ key: 'tests.json', path: 'tests.json' }] },
    });
  }
  const body = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace, labels: labels({ sessionId, environment: unitSuite ? 'worker' : 'capture' }) }, spec: {
    backoffLimit: 0, activeDeadlineSeconds: Math.ceil(timeoutMs / 1000), ttlSecondsAfterFinished: 3600,
    template: { metadata: { labels: labels({ sessionId, environment: unitSuite ? 'worker' : 'capture' }) }, spec: { restartPolicy: 'Never', serviceAccountName: cfg.workerServiceAccount, automountServiceAccountToken: false, securityContext: nodePodSecurityContext(), containers: [container], ...(podVolumes.length ? { volumes: podVolumes } : {}) } },
  } };
  const { batch, core } = getClients();
  if (previewRunId) {
    body.metadata.labels['social.usernode.io/preview-run-id'] = previewRunId;
    body.spec.template.metadata.labels['social.usernode.io/preview-run-id'] = previewRunId;
  }
  let inputSecretCreated = false;
  // Follow state lives outside the try so the finally can close the stream.
  let following = false;
  let followAbort = null;
  const retainPartial = !unitSuite && salvagePartial;
  const retained = createCheckOutputAccumulator(maxBuffer);
  const reportLine = line => {
    if (retainPartial) retained.appendLine(line);
    if (typeof onStdoutLine === 'function') {
      try { onStdoutLine(line); } catch { /* observer must not break the run */ }
    }
  };
  const boundedOutput = text => boundedCheckOutput(text, maxBuffer);
  try {
    signal?.throwIfAborted();
    if (inputSecretName) {
      await core.createNamespacedSecret({ namespace, body: {
        apiVersion: 'v1', kind: 'Secret',
        metadata: { name: inputSecretName, namespace, labels: labels({ sessionId, environment: unitSuite ? 'worker' : 'capture' }) },
        type: 'Opaque', stringData: unitSuite
          ? Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)]))
          : { 'tests.json': String(stdinPayload) },
      } });
      inputSecretCreated = true;
    }
    signal?.throwIfAborted();
    const createdJob = await batch.createNamespacedJob({ namespace, body });
    // A platform restart must not orphan private clone credentials. The Job's
    // TTL also garbage-collects its input Secret if normal cleanup cannot run.
    if (inputSecretName && createdJob?.metadata?.uid) {
      const secret = await core.readNamespacedSecret({ name: inputSecretName, namespace });
      secret.metadata.ownerReferences = [{ apiVersion: 'batch/v1', kind: 'Job', name, uid: createdJob.metadata.uid }];
      await core.replaceNamespacedSecret({ name: inputSecretName, namespace, body: secret });
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
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const job = await observeCheck(batch.readNamespacedJob({ name, namespace }), signal);
      signal?.throwIfAborted();
      if (job.status?.failed || job.status?.conditions?.some(c => c.type === 'Failed' && c.status === 'True')) {
        const pods = await observeCheck(core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` }), signal);
        const pod = pods.items?.[0];
        const err = new Error(`${kind} Job ${name} failed`);
        err.stdout = pod ? await observeCheck(core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container: kind, limitBytes: maxBuffer }), signal).catch(() => '') : '';
        const terminated = pod?.status?.containerStatuses?.find(c => c.name === kind)?.state?.terminated;
        err.code = terminated?.exitCode;
        const jobReason = job.status.conditions?.find(c => c.type === 'Failed')?.reason;
        err.stderr = [jobReason, terminated?.reason].filter(Boolean).join(': ');
        err.killed = jobReason === 'DeadlineExceeded' || terminated?.reason === 'OOMKilled';
        err.captureJobTerminated = true;
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
      if (!following) await startFollow();
      if (!following && tick % PROGRESS_EVERY_TICKS === 0) await observeProgress();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const err = new Error(`Timed out waiting for ${kind} Job ${name}`);
    err.killed = true;
    // Read before deletion: deleting the Job can immediately remove the Pod
    // and the only durable copy of completed capture frames.
    err.stdout = await readOutput().catch(() => '');
    // A coordinated owner confirms foreground termination before replacement.
    if (!signal) await deleteIfPresent(batch, 'deleteNamespacedJob', name, namespace, { propagationPolicy: 'Background' });
    throw err;
  } catch (err) {
    signal?.throwIfAborted();
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
      return { stdout, stderr: err.stderr || '', runtimeName: name, partial: true,
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
        .catch(() => {});
    }
  }
}

// ── Harvesting a run whose launcher died (services/check-harvest.js) ──
//
// runCheckJob above owns a Job for the life of the process that created it.
// When that process is replaced mid-run — a platform rollout — the Job runs
// on to completion regardless, and these two functions are how a later
// process finds it and reads what it produced, without creating or deleting
// anything. Deletion stays with the Job's own TTL / activeDeadline and with
// cancelPreviewChecks, which a newer run for the session calls first.

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
  const found = { capture: null, unitSuite: null };
  for (const job of jobs.items || []) {
    const name = job.metadata?.name || '';
    if (name.startsWith(`sv-capture-s${sessionId}-`)) found.capture = describeCheckJob(job);
    else if (name.startsWith(`sv-unit-suite-s${sessionId}-`)) found.unitSuite = describeCheckJob(job);
  }
  return found;
}

// Wait for a check Job to end and return its whole output. Same shape a
// runCheckJob caller sees, minus the throw: `{ state, stdout, stderr,
// exitCode, timedOut, partial, partialReason }`, where `state` is 'succeeded'
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
  const retained = createCheckOutputAccumulator(maxBuffer);
  const findPod = async () => {
    if (podName) return podName;
    const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` });
    podName = pods.items?.[0]?.metadata?.name || null;
    return podName;
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
    };
  };
  const empty = (state, partialReason) => ({
    state, stdout: '', stderr: '', exitCode: null, timedOut: false, partial: true, partialReason,
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
      try { deliverNew(await readLog({ limitBytes: maxBuffer })); } catch { /* progress is best-effort */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  let stdout = '';
  try {
    const raw = await readLog({ limitBytes: maxBuffer });
    deliverNew(raw);
    stdout = boundedOutput(reconcileCheckOutput(retained.output(), raw));
  } catch { stdout = retained.output(); }
  return { state: 'timeout', stdout, stderr: '', exitCode: null, timedOut: true, partial: true, partialReason: 'run timed out' };
}

// The pod-log follow client: an injected `logs` for tests, else one built
// on the real kube config. Null where neither exists (a test that injected
// only the typed API clients), which leaves the polled read in charge.
function clientsLogApi(clients) {
  if (!clients) return null;
  if (clients.logs && typeof clients.logs.log === 'function') return clients.logs;
  if (clients.kc) {
    try { clients.logs = new k8s.Log(clients.kc); return clients.logs; } catch { return null; }
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

async function execInWorker(config, runtimeName, command, stdinText = null, { timeoutMs = 30000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Worker exec timeout must be a positive finite number');
  const namespace = config.kubernetes.workerNamespace;
  const stdout = new stream.PassThrough();
  const stderr = new stream.PassThrough();
  let out = ''; let err = '';
  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  stdout.on('data', (chunk) => { out += chunk; });
  stderr.on('data', (chunk) => { err += chunk; });
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
      const exec = api.exec || new k8s.Exec(api.kc);
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
  dnsName, withSuffix, labels, appResourceName, createBuild, deployApplication, getApplicationStatus, inspectApplication,
  getApplicationLogs, getDebugLogs, restartApplication, deleteApplication, deleteBuilds, deleteFailedBuilds, ensureWorker,
  listManagedBuilds, readBuild, deleteBuildSnapshot,
  runCaptureJob, runEvidenceJob, runUnitSuiteJob, cancelPreviewChecks, findCheckJobs, collectCheckJob,
  execInWorker, _getClients: getClients,
  getWorkerStatus, getWorkerContractVersion, getWorkerRuntimeMetadata, deleteWorker, listWorkers, cloneWorkerVolume,
  listStatusResources, listNamespaceCapacity, inspectWorkerTermination, getPlatformDeployStatus,
  _setClientsForTest: setClientsForTest, _envChecksumForTest: envChecksum,
  _attachLineObserverForTest: attachLineObserver,
  _buildPhasesFromPodForTest: buildPhasesFromPod,
  _deploymentStateForTest: deploymentState,
  _terminalPodFailureDetailsForTest: terminalPodFailureDetails,
  _normalizeDeploymentForTest: normalizeDeployment,
  _quantityNumberForTest: quantityNumber,
  PLATFORM_ASSET_PREFIXES, PLATFORM_ASSET_NAME, ensurePlatformAssetBackend,
  _appIngressManifestForTest: appIngressManifest,
  _ingressWithPlatformAssetRoutesForTest: ingressWithPlatformAssetRoutes,
  _reconcilePlatformAssetIngressesForTest: reconcilePlatformAssetIngresses,
  _ensurePlatformAssetBackendForTest: ensurePlatformAssetBackend,
  _resetPlatformAssetBackendForTest: () => { platformAssetBackend = null; platformAssetBackendRetryAfter = 0; },
};
