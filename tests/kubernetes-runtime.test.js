const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const kubernetes = require('../src/services/kubernetes');

function notFound() {
  const error = new Error('not found');
  error.code = 404;
  return error;
}

function config() {
  return {
    workerContractVersion: 'v6',
    kubernetes: {
      buildNamespace: 'social-builds', appNamespace: 'social-apps', workerNamespace: 'social-workers',
      buildServiceAccount: 'social-kpack-builder', generatedAppServiceAccount: 'social-generated-app',
      repositoryPrefix: 'ghcr.io/example/social-apps', cacheRepositoryPrefix: 'ghcr.io/example/social-cache',
      builderImage: 'builder.example/image@sha256:abc', nodeVersion: '22.*', activeDeadlineSeconds: 30,
      appDomain: 'apps.example.test', ingressClassName: 'cilium', clusterIssuer: 'letsencrypt-public',
      workerServiceAccount: 'social-worker', workerImage: 'ghcr.io/example/social-worker@sha256:cafe',
      captureImage: 'ghcr.io/example/social-capture@sha256:babe', workerStorageClass: 'openebs-lvm-retain',
      workerStorageSize: '5Gi',
    },
  };
}

test.afterEach(() => kubernetes._setClientsForTest(null));

for (const conflict of ['terminating', 'disappeared']) {
  test(`kpack recreates a pruned Build when its conflicting object is ${conflict}`, async () => {
    let creates = 0;
    let reads = 0;
    kubernetes._setClientsForTest({ custom: {
      async createNamespacedCustomObject() {
        if (++creates === 1) throw Object.assign(new Error('exists'), { code: 409 });
      },
      async getNamespacedCustomObject() {
        if (++reads === 1) {
          if (conflict === 'disappeared') throw notFound();
          return { metadata: { deletionTimestamp: new Date().toISOString() },
            status: { conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: 'old-image' } };
        }
        return { status: { conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: 'new-image' } };
      },
    } });
    const result = await kubernetes.createBuild(config(), {
      app: { id: 7, slug: 'demo', repo_url: 'https://github.com/example/demo' },
      revision: 'a'.repeat(40), environment: 'production',
    });
    assert.equal(creates, 2);
    assert.equal(result.imageRef, 'new-image');
  });
}

test('kpack Build is isolated in social-builds and returns status.latestImage', async () => {
  let created;
  kubernetes._setClientsForTest({
    custom: {
      async createNamespacedCustomObject(request) { created = request; },
      async getNamespacedCustomObject() {
        return { status: { conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: 'ghcr.io/example/social-apps/demo@sha256:deadbeef' } };
      },
    },
  });
  const revision = 'a'.repeat(40);
  const result = await kubernetes.createBuild(config(), {
    app: { id: 7, slug: 'Demo App', repo_url: 'https://github.com/example/demo' },
    revision, environment: 'production',
  });
  assert.equal(created.namespace, 'social-builds');
  assert.equal(created.body.spec.source.git.revision, revision);
  assert.equal(created.body.spec.serviceAccountName, 'social-kpack-builder');
  assert.deepEqual(created.body.spec.env, [
    { name: 'BP_NODE_VERSION', value: '22.*' },
    { name: 'NODE_ENV', value: 'production' },
    { name: 'GIT_SHA', value: revision },
    { name: 'BPE_OVERRIDE_GIT_SHA', value: revision },
  ]);
  assert.equal(result.imageRef, 'ghcr.io/example/social-apps/demo@sha256:deadbeef');
  assert.match(result.buildRef, /^social-builds\//);
  const unstampedRecipe = crypto.createHash('sha256').update(JSON.stringify({
    builder: config().kubernetes.builderImage,
    env: created.body.spec.env.filter(entry => !['GIT_SHA', 'BPE_OVERRIDE_GIT_SHA'].includes(entry.name)),
  })).digest('hex').slice(0, 12);
  assert.ok(!created.body.spec.tags[0].endsWith(`-${unstampedRecipe}`), 'the same commit must rebuild its previously unstamped image');
});

test('kpack runs the shell generator during build when the checked-out app declares it', async (t) => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-kpack-source-'));
  t.after(() => fs.rmSync(sourceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
    scripts: { 'ensure:shell': 'node scripts/ensure-shell-artifacts.js --runtime' },
  }));
  let created;
  kubernetes._setClientsForTest({
    custom: {
      async createNamespacedCustomObject(request) { created = request; },
      async getNamespacedCustomObject() {
        return { status: { conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: 'ghcr.io/example/demo@sha256:built' } };
      },
    },
  });

  await kubernetes.createBuild(config(), {
    app: { id: 10, slug: 'self-app', repo_url: 'https://github.com/example/self-app' },
    revision: 'b'.repeat(40), environment: 'staging', sessionId: 42, sourceDir,
  });

  assert.deepEqual(created.body.spec.env, [
    { name: 'BP_NODE_VERSION', value: '22.*' },
    { name: 'NODE_ENV', value: 'production' },
    { name: 'GIT_SHA', value: 'b'.repeat(40) },
    { name: 'BPE_OVERRIDE_GIT_SHA', value: 'b'.repeat(40) },
    { name: 'BP_NODE_RUN_SCRIPTS', value: 'ensure:shell' },
  ]);
  // The source SHA is unchanged: adding production mode must invalidate the
  // successful Build/image made by the old adapter with development React.
  const oldRecipe = crypto.createHash('sha256').update(JSON.stringify({
    builder: config().kubernetes.builderImage,
    env: created.body.spec.env.filter((entry) => entry.name !== 'NODE_ENV'),
  })).digest('hex').slice(0, 12);
  assert.notEqual(created.body.metadata.name, `sv-10-s42-${'b'.repeat(12)}-${oldRecipe}`);
  assert.ok(!created.body.spec.tags[0].endsWith(`-${oldRecipe}`));
});

test('kpack selects a declared build script but preserves shell ordering and legacy apps', async (t) => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-kpack-build-script-'));
  t.after(() => fs.rmSync(sourceDir, { recursive: true, force: true }));
  let created;
  kubernetes._setClientsForTest({ custom: {
    async createNamespacedCustomObject(request) { created = request; },
    async getNamespacedCustomObject() {
      return { status: { conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: 'ghcr.io/example/demo@sha256:built' } };
    },
  } });
  for (const [scripts, expected] of [
    [{ start: 'node server.js', build: 'npm run build:css' }, 'build'],
    [{ build: 'other', 'ensure:shell': 'node ensure.js' }, 'ensure:shell'],
    [{ start: 'node server.js' }, undefined],
    [{ build: true }, undefined],
    [{ 'build:css': 'tailwindcss' }, undefined],
  ]) {
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ scripts }));
    await kubernetes.createBuild(config(), {
      app: { id: 11, slug: 'demo', repo_url: 'https://github.com/example/demo' },
      revision: 'd'.repeat(40), environment: 'production', sourceDir,
    });
    assert.equal(created.body.spec.env.find((v) => v.name === 'BP_NODE_RUN_SCRIPTS')?.value, expected);
    assert.equal(created.body.spec.env.find((v) => v.name === 'NODE_ENV')?.value, 'production');
  }
});

test('a terminal failed kpack Build is deleted before the failure returns', async () => {
  let deleted;
  let created;
  kubernetes._setClientsForTest({
    custom: {
      async createNamespacedCustomObject(request) { created = request; },
      async getNamespacedCustomObject() {
        return { status: { conditions: [{ type: 'Succeeded', status: 'False', message: 'npm failed' }] } };
      },
      async deleteNamespacedCustomObject(request) { deleted = request; },
    },
  });

  await assert.rejects(kubernetes.createBuild(config(), {
    app: { id: 7, slug: 'demo', repo_url: 'https://github.com/example/demo' },
    revision: 'c'.repeat(40), environment: 'production',
  }), /npm failed/);
  assert.equal(deleted.name, created.body.metadata.name);
  assert.match(deleted.name, /^sv-7-c{12}-[a-f0-9]{12}$/);
  assert.equal(deleted.namespace, 'social-builds');
  assert.equal(deleted.propagationPolicy, 'Background');
});

test('changing the builder or Node version rebuilds the same Git revision', async () => {
  const builds = [];
  kubernetes._setClientsForTest({ custom: {
    async createNamespacedCustomObject({ body }) { builds.push(body); },
    async getNamespacedCustomObject() {
      return { status: { conditions: [{ type: 'Succeeded', status: 'True' }], latestImage: 'ghcr.io/example/demo@sha256:built' } };
    },
  } });
  const options = {
    app: { id: 7, slug: 'demo', repo_url: 'https://github.com/example/demo' },
    revision: 'e'.repeat(40), environment: 'production',
  };
  const cfg = config();
  await kubernetes.createBuild(cfg, options);
  await kubernetes.createBuild(cfg, options);
  await kubernetes.createBuild({ ...cfg, kubernetes: { ...cfg.kubernetes, builderImage: 'builder.example/image@sha256:new' } }, options);
  await kubernetes.createBuild({ ...cfg, kubernetes: { ...cfg.kubernetes, nodeVersion: '22.1.0' } }, options);
  assert.equal(builds[0].metadata.name, builds[1].metadata.name);
  assert.deepEqual(builds[0].spec.tags, builds[1].spec.tags);
  assert.equal(new Set([builds[0], builds[2], builds[3]].map(b => b.metadata.name)).size, 3);
  assert.equal(new Set([builds[0], builds[2], builds[3]].map(b => b.spec.tags[0])).size, 3);
});

test('failed-build sweep removes only terminal failed managed Builds', async () => {
  const deleted = [];
  kubernetes._setClientsForTest({
    custom: {
      async listNamespacedCustomObject() {
        return { items: [
          { metadata: { name: 'failed' }, status: { conditions: [{ type: 'Succeeded', status: 'False' }] } },
          { metadata: { name: 'running' }, status: { conditions: [{ type: 'Succeeded', status: 'Unknown' }] } },
          { metadata: { name: 'passed' }, status: { conditions: [{ type: 'Succeeded', status: 'True' }] } },
        ] };
      },
      async deleteNamespacedCustomObject({ name }) { deleted.push(name); },
    },
  });

  assert.deepEqual(await kubernetes.deleteFailedBuilds(config()), { examined: 3, deleted: 1 });
  assert.deepEqual(deleted, ['failed']);
});

test('application deploy reconciles Secret, Deployment, Service and Ingress with a digest', async () => {
  // The asset backend is memoised per process, so clear it: otherwise
  // whether this test sees it reconciled depends on which deploy test ran
  // first in this file.
  kubernetes._resetPlatformAssetBackendForTest();
  const written = [];
  const missingReads = {
    readNamespacedSecret: async () => { throw notFound(); },
    readNamespacedService: async () => { throw notFound(); },
    readNamespacedDeployment: async ({ name }) => {
      if (written.some((item) => item.kind === 'Deployment')) {
        return { ...written.find(item => item.kind === 'Deployment').body,
          metadata: { name, generation: 1 }, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } };
      }
      throw notFound();
    },
    readNamespacedIngress: async () => { throw notFound(); },
  };
  const record = (kind) => async ({ body }) => { written.push({ kind, body }); return body; };
  kubernetes._setClientsForTest({
    core: { ...missingReads, createNamespacedSecret: record('Secret'), createNamespacedService: record('Service') },
    apps: { ...missingReads, createNamespacedDeployment: record('Deployment') },
    networking: { ...missingReads, createNamespacedIngress: record('Ingress') },
  });
  const result = await require('../src/services/application-runtime').deploy({ ...config(), appRuntime: 'kubernetes' }, {
    app: { id: 7, slug: 'demo' }, environment: 'production',
    imageRef: 'ghcr.io/example/social-apps/demo@sha256:deadbeef',
    env: { DATABASE_URL: 'postgres://redacted', PORT: '3000' },
    command: ['node', '/app/evidence-hosted-app-fixture.js'],
    labels: { 'usernode.env.fp': '0123456789abcdef', 'app.kubernetes.io/managed-by': 'cannot-override-owner' },
  });
  // The app's own four resources — everything except the shared backend.
  // (Its Secret is named <runtimeName>-env, so match by exclusion.)
  const appResources = written.filter((item) => item.body.metadata.name !== kubernetes.PLATFORM_ASSET_NAME);
  assert.deepEqual(appResources.map((item) => item.kind).sort(), ['Deployment', 'Ingress', 'Secret', 'Service']);
  // A deploy ALSO reconciles the shared platform-asset backend — the
  // Service every app's Ingress routes /usernode-bridge/, /usernode-native/
  // and /usernode-tailwind/ to. It is idempotent and memoised per process,
  // and it runs here rather than at boot so the Service is guaranteed to
  // exist before the Ingress that names it.
  assert.ok(written.some((item) => item.body.metadata.name === kubernetes.PLATFORM_ASSET_NAME),
    'the shared asset backend is reconciled alongside the app');
  const deployment = written.find((item) => item.kind === 'Deployment').body;
  assert.equal(deployment.spec.template.metadata.labels['usernode.env.fp'], '0123456789abcdef');
  assert.equal(deployment.metadata.labels['app.kubernetes.io/managed-by'], 'social-vibecoding-runtime');
  assert.deepEqual(deployment.spec.selector.matchLabels, { 'social.usernode.io/runtime-name': result.runtimeName });
  assert.equal((await kubernetes.inspectApplication(config(), result.runtimeName)).labels['usernode.env.fp'], '0123456789abcdef');
  assert.equal(deployment.spec.template.spec.containers[0].image, 'ghcr.io/example/social-apps/demo@sha256:deadbeef');
  assert.deepEqual(deployment.spec.template.spec.containers[0].command,
    ['node', '/app/evidence-hosted-app-fixture.js']);
  assert.equal(deployment.spec.template.spec.serviceAccountName, 'social-generated-app');
  assert.equal(
    deployment.spec.template.metadata.annotations['social.usernode.io/env-checksum'],
    kubernetes._envChecksumForTest({ DATABASE_URL: 'postgres://redacted', PORT: '3000' })
  );
  const ingress = written.find((item) => item.kind === 'Ingress').body;
  assert.equal(ingress.spec.ingressClassName, 'cilium');
  assert.equal(ingress.metadata.annotations['cert-manager.io/cluster-issuer'], undefined);
  assert.deepEqual(ingress.spec.tls, [{ hosts: ['demo.apps.example.test'], secretName: 'social-apps-wildcard-tls' }]);
  assert.equal(result.url, 'https://demo.apps.example.test');
});

test('internal-only evidence deploy creates no Ingress or shared public asset route', async () => {
  kubernetes._resetPlatformAssetBackendForTest();
  const written = [];
  let deployment = null;
  const missing = async () => { throw notFound(); };
  const record = (kind) => async ({ body }) => {
    written.push({ kind, body });
    if (kind === 'Deployment') deployment = body;
    return body;
  };
  kubernetes._setClientsForTest({
    core: {
      readNamespacedSecret: missing, createNamespacedSecret: record('Secret'),
      readNamespacedService: missing, createNamespacedService: record('Service'),
    },
    apps: {
      readNamespacedDeployment: async ({ name }) => {
        if (!deployment) throw notFound();
        return { ...deployment, metadata: { ...deployment.metadata, name, generation: 1 },
          status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } };
      },
      createNamespacedDeployment: record('Deployment'),
    },
    networking: {
      async readNamespacedIngress() { throw new Error('internal deploy must not read Ingress'); },
      async createNamespacedIngress() { throw new Error('internal deploy must not create Ingress'); },
    },
  });
  const result = await kubernetes.deployApplication(config(), {
    app: { id: 7, slug: 'demo' }, environment: 'staging', sessionId: 42,
    imageRef: 'ghcr.io/example/demo@sha256:deadbeef', env: {},
    runtimeName: 'sv-evidence-0123456789abcdef-b', internalOnly: true,
  });
  assert.deepEqual(written.map((item) => item.kind).sort(), ['Deployment', 'Secret', 'Service']);
  assert.equal(result.runtimeName, 'sv-evidence-0123456789abcdef-b');
  assert.equal(result.url, 'http://sv-evidence-0123456789abcdef-b.social-apps.svc:3000');
  assert.equal(result.hostname, 'sv-evidence-0123456789abcdef-b.social-apps.svc');
});

for (const [name, environment, database, preferred] of [
  ['configured staging', 'staging', { previewDatabaseNamespace: 'database-ns', previewDatabaseCluster: 'writer-cluster' }, true],
  ['production with database configuration', 'production', { previewDatabaseNamespace: 'database-ns', previewDatabaseCluster: 'writer-cluster' }, false],
  ['unconfigured staging', 'staging', {}, false],
  ['staging without database namespace', 'staging', { previewDatabaseCluster: 'writer-cluster' }, false],
  ['staging without database cluster', 'staging', { previewDatabaseNamespace: 'database-ns' }, false],
]) {
  test(`preview primary placement: ${name}`, async () => {
    let deployment;
    const missing = async () => { throw notFound(); };
    const record = async ({ body }) => body;
    // Deliberately no Pod/node discovery API: the scheduler resolves the
    // current primary, including after failover or when none matches.
    kubernetes._setClientsForTest({
      core: {
        readNamespacedSecret: missing, createNamespacedSecret: record,
        readNamespacedService: missing, createNamespacedService: record,
      },
      apps: {
        readNamespacedDeployment: async () => {
          if (!deployment) throw notFound();
          return { ...deployment, metadata: { ...deployment.metadata, generation: 1 },
            status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } };
        },
        createNamespacedDeployment: async ({ body }) => { deployment = body; return body; },
      },
      networking: { readNamespacedIngress: missing, createNamespacedIngress: record },
    });
    const cfg = config();
    Object.assign(cfg.kubernetes, database);
    await kubernetes.deployApplication(cfg, {
      app: { id: 7, slug: 'demo' }, environment, sessionId: 42,
      imageRef: 'ghcr.io/example/demo@sha256:deadbeef', env: {},
    });
    const spec = deployment.spec.template.spec;
    assert.equal(deployment.metadata.namespace, 'social-apps');
    assert.equal(spec.nodeName, undefined, 'never pin to a specific node');
    assert.equal(spec.nodeSelector, undefined, 'other eligible nodes remain available');
    if (preferred) {
      assert.deepEqual(spec.affinity, {
        podAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{
          weight: 100,
          podAffinityTerm: {
            namespaces: ['database-ns'],
            labelSelector: { matchLabels: {
              'cnpg.io/cluster': 'writer-cluster', 'cnpg.io/instanceRole': 'primary',
            } },
            topologyKey: 'kubernetes.io/hostname',
          },
        }] },
      }, 'use only a soft preference for this cluster’s current primary');
    } else {
      assert.equal(spec.affinity, undefined);
    }
  });
}

test('mutable image tags are refused before any Kubernetes write', async () => {
  await assert.rejects(
    kubernetes.deployApplication(config(), {
      app: { id: 7, slug: 'demo' }, environment: 'production', imageRef: 'ghcr.io/example/demo:latest', env: {},
    }),
    /immutable image digest/
  );
});

test('a failed staging rollout removes its quota-consuming resources', async () => {
  let deploymentCreated = false;
  const deleted = [];
  const missing = async () => { throw notFound(); };
  const remove = (kind) => async ({ name }) => { deleted.push(`${kind}/${name}`); };
  kubernetes._setClientsForTest({
    core: {
      readNamespacedSecret: missing,
      readNamespacedService: missing,
      async createNamespacedSecret() {},
      async createNamespacedService() {},
      deleteNamespacedSecret: remove('Secret'),
      deleteNamespacedService: remove('Service'),
    },
    apps: {
      async readNamespacedDeployment() {
        if (!deploymentCreated) throw notFound();
        throw new Error('quota denied');
      },
      async createNamespacedDeployment() { deploymentCreated = true; },
      deleteNamespacedDeployment: remove('Deployment'),
    },
    networking: {
      readNamespacedIngress: missing,
      async createNamespacedIngress() {},
      deleteNamespacedIngress: remove('Ingress'),
    },
  });

  await assert.rejects(kubernetes.deployApplication({ ...config(), selfAppSlug: 'self-app' }, {
    app: { id: 10, slug: 'self-app' }, environment: 'staging', sessionId: 42,
    imageRef: 'ghcr.io/example/self-app@sha256:deadbeef', env: {},
  }), /quota denied/);

  assert.deepEqual(deleted.sort(), [
    'Deployment/sv-preview-10-s42',
    'Ingress/sv-preview-10-s42',
    'Secret/sv-preview-10-s42-env',
    'Service/sv-preview-10-s42',
  ]);
});

test('worker runtime reconciles a retained PVC, Secret and warm Deployment', async () => {
  const written = [];
  const record = (kind) => async ({ body }) => { written.push({ kind, body }); return body; };
  kubernetes._setClientsForTest({
    core: {
      createNamespacedPersistentVolumeClaim: record('PersistentVolumeClaim'),
      readNamespacedSecret: async () => { throw notFound(); },
      createNamespacedSecret: record('Secret'),
      listNamespacedPod: async () => ({ items: [{
        metadata: { name: 'worker-pod', annotations: { 'social.usernode.io/env-checksum': kubernetes._envChecksumForTest({ WORKER_JWT: 'redacted' }) } },
        spec: { containers: [{ name: 'worker', image: config().kubernetes.workerImage }] },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [{ name: 'worker', ready: true, state: { running: {} } }] },
      }] }),
      readNamespacedPodLog: async () => '__USERNODE_PHASE__ warm-ready',
    },
    apps: {
      readNamespacedDeployment: async ({ name }) => {
        if (written.some((item) => item.kind === 'Deployment')) {
          return { metadata: { name, generation: 1 }, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } };
        }
        throw notFound();
      },
      createNamespacedDeployment: record('Deployment'),
    },
  });
  const result = await kubernetes.ensureWorker(config(), { sessionId: 42, env: { WORKER_JWT: 'redacted' } });
  assert.deepEqual(written.map((item) => item.kind), ['PersistentVolumeClaim', 'Secret', 'Deployment']);
  const pvc = written.find((item) => item.kind === 'PersistentVolumeClaim').body;
  assert.equal(pvc.spec.storageClassName, 'openebs-lvm-retain');
  const deployment = written.find((item) => item.kind === 'Deployment').body;
  assert.equal(deployment.spec.strategy.type, 'Recreate');
  const workerContainer = deployment.spec.template.spec.containers[0];
  assert.deepEqual(workerContainer.startupProbe.exec.command, ['test', '-f', '/tmp/usernode-worker-ready']);
  assert.deepEqual(workerContainer.readinessProbe.exec.command, workerContainer.startupProbe.exec.command);
  assert.deepEqual(workerContainer.env, [{ name: 'USERNODE_WORKER_REQUIRE_READY', value: '1' }]);
  assert.equal(deployment.metadata.labels['social.usernode.io/worker-contract'], 'v6');
  assert.equal(deployment.spec.template.metadata.labels['social.usernode.io/worker-contract'], 'v6');
  assert.deepEqual(
    {
      runAsNonRoot: deployment.spec.template.spec.securityContext.runAsNonRoot,
      runAsUser: deployment.spec.template.spec.securityContext.runAsUser,
      runAsGroup: deployment.spec.template.spec.securityContext.runAsGroup,
      fsGroup: deployment.spec.template.spec.securityContext.fsGroup,
    },
    { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 }
  );
  assert.equal(
    deployment.spec.template.metadata.annotations['social.usernode.io/env-checksum'],
    kubernetes._envChecksumForTest({ WORKER_JWT: 'redacted' })
  );
  assert.equal(deployment.spec.template.spec.volumes[0].persistentVolumeClaim.claimName, result.pvcName);
});

test('temporary evidence worker uses pod storage without allocating a PVC', async () => {
  const written = [];
  const record = (kind) => async ({ body }) => { written.push({ kind, body }); return body; };
  kubernetes._setClientsForTest({
    core: {
      createNamespacedPersistentVolumeClaim: record('PersistentVolumeClaim'),
      readNamespacedSecret: async () => { throw notFound(); },
      createNamespacedSecret: record('Secret'),
      listNamespacedPod: async () => ({ items: [{
        metadata: { name: 'worker-pod', annotations: { 'social.usernode.io/env-checksum': kubernetes._envChecksumForTest({}) } },
        spec: { containers: [{ name: 'worker', image: config().kubernetes.workerImage }] },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [{ name: 'worker', ready: true, state: { running: {} } }] },
      }] }),
      readNamespacedPodLog: async () => '__USERNODE_PHASE__ warm-ready',
    },
    apps: {
      readNamespacedDeployment: async ({ name }) => {
        if (written.some((item) => item.kind === 'Deployment')) {
          return { metadata: { name, generation: 1 }, status: { observedGeneration: 1,
            replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } };
        }
        throw notFound();
      },
      createNamespacedDeployment: record('Deployment'),
    },
  });
  const result = await kubernetes.ensureWorker(config(), { sessionId: 43, env: {}, temporary: true });
  assert.deepEqual(written.map((item) => item.kind), ['Secret', 'Deployment']);
  assert.equal(result.pvcName, null);
  const deployment = written.find((item) => item.kind === 'Deployment').body;
  assert.deepEqual(deployment.spec.template.spec.volumes, [{ name: 'state', emptyDir: {} }]);
  assert.equal(deployment.metadata.labels['social.usernode.io/storage-mode'], 'temporary');
});

test('worker contract and immutable image are read from the live Kubernetes Deployment', async () => {
  kubernetes._setClientsForTest({
    apps: {
      async readNamespacedDeployment() {
        return {
          metadata: { labels: { 'social.usernode.io/worker-contract': 'v6' } },
          spec: { template: { spec: { volumes: [{ name: 'state', persistentVolumeClaim: { claimName: 'sv-worker-s42-state' } }], containers: [
            { name: 'sidecar', image: 'example/sidecar@sha256:dead' },
            { name: 'worker', image: config().kubernetes.workerImage },
          ] } } },
        };
      },
    },
  });
  assert.deepEqual(await kubernetes.getWorkerRuntimeMetadata(config(), 'sv-worker-s42'), {
    contractVersion: 'v6',
    imageRef: config().kubernetes.workerImage,
    storageMode: 'persistent',
  });
  assert.equal(await kubernetes.getWorkerContractVersion(config(), 'sv-worker-s42'), 'v6');
});

test('environment checksum is stable by key order and changes with secret values', () => {
  const first = kubernetes._envChecksumForTest({ PORT: 3000, DATABASE_URL: 'postgres://one' });
  const reordered = kubernetes._envChecksumForTest({ DATABASE_URL: 'postgres://one', PORT: '3000' });
  const changed = kubernetes._envChecksumForTest({ DATABASE_URL: 'postgres://two', PORT: '3000' });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('capture runtime uses a bounded Job and caps log retrieval', async () => {
  let created;
  let logRequest;
  kubernetes._setClientsForTest({
    batch: {
      async createNamespacedJob(request) { created = request; },
      async readNamespacedJob() { return { status: { succeeded: 1 } }; },
    },
    core: {
      async listNamespacedPod() { return { items: [{ metadata: { name: 'capture-pod' } }] }; },
      async readNamespacedPodLog(request) { logRequest = request; return 'result'; },
    },
  });
  const result = await kubernetes.runCaptureJob(config(), { sessionId: 42, env: { CAPTURE_INPUT: '{}' }, timeoutMs: 120000 });
  assert.equal(created.namespace, 'social-workers');
  assert.equal(created.body.spec.backoffLimit, 0);
  assert.equal(created.body.spec.activeDeadlineSeconds, 120);
  assert.equal(created.body.spec.ttlSecondsAfterFinished, 3600);
  assert.equal(created.body.spec.template.spec.automountServiceAccountToken, false);
  assert.deepEqual(created.body.spec.template.spec.containers[0].resources, {
    requests: { cpu: '4', memory: '3Gi', 'ephemeral-storage': '1Gi' },
    // 6Gi: the pool is sixteen pages now (services/visuals.js CAPTURE_MEMORY
    // and tests/checks-budget.test.js carry the sizing).
    limits: { cpu: '8', memory: '6Gi', 'ephemeral-storage': '4Gi' },
  });
  assert.equal(created.body.spec.template.spec.securityContext.runAsUser, 1000);
  assert.equal(created.body.spec.template.spec.securityContext.runAsGroup, 1000);
  assert.equal(created.body.spec.template.spec.securityContext.fsGroup, 1000);
  assert.equal(logRequest.limitBytes, 64 * 1024 * 1024 + 1);
  assert.equal(result.stdout, 'result');
});

for (const kind of ['Capture', 'UnitSuite']) {
  for (const [cpus, memory, expectedMemory, expectedRequestMemory] of [
    ['6', '6g', '6Gi', kind === 'UnitSuite' ? '1Gi' : '3Gi'],
    ['0.5', '512m', '512Mi', '512Mi'],
  ]) {
    test(`${kind} honors resource overrides ${cpus} CPU / ${memory} without exceeding limits`, async () => {
      let created;
      kubernetes._setClientsForTest({
        batch: {
          async createNamespacedJob({ body }) { created = body; },
          async readNamespacedJob() { return { status: { succeeded: 1 } }; },
        },
        core: {
          async createNamespacedSecret() {},
          async deleteNamespacedSecret() {},
          async listNamespacedPod() { return { items: [{ metadata: { name: 'check-pod' } }] }; },
          async readNamespacedPodLog() { return 'passed'; },
        },
      });
      await kubernetes[`run${kind}Job`](config(), { sessionId: 42, env: {}, cpus, memory });
      const { requests, limits } = created.spec.template.spec.containers[0].resources;
      assert.equal(limits.cpu, cpus);
      assert.equal(limits.memory, expectedMemory);
      assert.equal(requests.cpu, Number(cpus) < 4 ? cpus : '4');
      assert.equal(requests.memory, expectedRequestMemory);
    });
  }
}

test('check kinds and sessions share one spread group without including resident workers', async () => {
  const jobs = [];
  kubernetes._setClientsForTest({
    batch: {
      async createNamespacedJob({ body }) { jobs.push(body); },
      async readNamespacedJob() { return { status: { succeeded: 1 } }; },
    },
    core: {
      async createNamespacedSecret() {},
      async deleteNamespacedSecret() {},
      async listNamespacedPod() { return { items: [{ metadata: { name: 'check-pod' } }] }; },
      async readNamespacedPodLog() { return 'passed'; },
    },
  });
  for (const [index, kind] of ['Capture', 'UnitSuite'].entries()) {
    await kubernetes[`run${kind}Job`](config(), { sessionId: 42 + index, env: {}, previewRunId: `run-${index}` });
  }
  const expected = {
    maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway',
    nodeAffinityPolicy: 'Honor', nodeTaintsPolicy: 'Honor',
    labelSelector: { matchLabels: {
      'app.kubernetes.io/managed-by': 'social-vibecoding-runtime',
      'app.kubernetes.io/part-of': 'social-vibecoding',
      'social.usernode.io/workload': 'check',
    } },
  };
  for (const job of jobs) {
    const pod = job.spec.template;
    assert.deepEqual(pod.spec.topologySpreadConstraints, [expected]);
    for (const [key, value] of Object.entries(expected.labelSelector.matchLabels)) {
      assert.equal(pod.metadata.labels[key], value);
      assert.equal(job.metadata.labels[key], value);
    }
    assert.equal(pod.spec.containers[0].resources.requests.cpu, '4');
    assert.equal(pod.spec.affinity, undefined, 'checks must not inherit preview database affinity');
    assert.equal(pod.spec.nodeSelector, undefined);
  }
  // Existing coding workers share runtime/part-of and worker environment labels,
  // but do not carry the dedicated check label required by the spread selector.
  const workerLabels = {
    'app.kubernetes.io/managed-by': 'social-vibecoding-runtime',
    'app.kubernetes.io/part-of': 'social-vibecoding',
    'social.usernode.io/environment': 'worker',
  };
  assert.equal(Object.entries(expected.labelSelector.matchLabels)
    .every(([key, value]) => workerLabels[key] === value), false);
});

test('invalid capture resource limits fail before creating credentials or workloads', async () => {
  kubernetes._setClientsForTest({});
  for (const options of [{ cpus: '0' }, { cpus: 'invalid' }, { memory: '-1g' }]) {
    await assert.rejects(kubernetes.runCaptureJob(config(), {
      sessionId: 42, env: {}, stdinPayload: '{}', ...options,
    }), /Invalid check (CPU|memory) limit/);
  }
});

test('capture runtime transports oversized test input through a temporary Secret volume', async () => {
  let createdJob;
  let createdSecret;
  let deletedSecret;
  kubernetes._setClientsForTest({
    batch: {
      async createNamespacedJob(request) { createdJob = request; },
      async readNamespacedJob() { return { status: { succeeded: 1 } }; },
    },
    core: {
      async createNamespacedSecret(request) { createdSecret = request; },
      async deleteNamespacedSecret(request) { deletedSecret = request; },
      async listNamespacedPod() { return { items: [{ metadata: { name: 'capture-pod' } }] }; },
      async readNamespacedPodLog() { return 'result'; },
    },
  });
  const payload = JSON.stringify([{ url: 'https://preview.example.invalid/' }]);
  await kubernetes.runCaptureJob(config(), {
    sessionId: 42, env: { TESTS: '@stdin' }, stdinPayload: payload, timeoutMs: 120000,
  });
  assert.equal(createdSecret.body.stringData['tests.json'], payload);
  const podSpec = createdJob.body.spec.template.spec;
  assert.match(podSpec.containers[0].args[0], /capture\.js < \/var\/run\/usernode-capture\/tests\.json/);
  assert.equal(podSpec.volumes[0].secret.secretName, createdSecret.body.metadata.name);
  assert.equal(deletedSecret.name, createdSecret.body.metadata.name);
});

test('status inventory normalizes application, preview and worker readiness from Deployments and Pods', async () => {
  const deploymentsByNamespace = {
    'social-apps': [
      {
        metadata: {
          name: 'sv-app-7-demo', uid: 'app-deploy', generation: 2,
          labels: {
            'social.usernode.io/environment': 'production',
            'social.usernode.io/app-id': '7',
          },
        },
        spec: { replicas: 1, template: { spec: { containers: [{ image: 'example/app@sha256:one' }] } } },
        status: { observedGeneration: 2, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
      },
      {
        metadata: {
          name: 'sv-preview-7-s42', uid: 'preview-deploy', generation: 3,
          labels: {
            'social.usernode.io/environment': 'staging',
            'social.usernode.io/app-id': '7',
            'social.usernode.io/session-id': '42',
          },
        },
        spec: { replicas: 1, template: { spec: { containers: [{ image: 'example/app@sha256:two' }] } } },
        status: { observedGeneration: 3, replicas: 1, unavailableReplicas: 1 },
      },
    ],
    'social-workers': [
      {
        metadata: {
          name: 'sv-worker-s42', uid: 'worker-deploy', generation: 1,
          labels: {
            'social.usernode.io/environment': 'worker',
            'social.usernode.io/session-id': '42',
          },
        },
        spec: { replicas: 1, template: { spec: { containers: [{ image: 'example/worker@sha256:three' }] } } },
        status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
      },
    ],
  };
  const podsByNamespace = {
    'social-apps': [{
      metadata: {
        name: 'sv-app-7-demo-pod', uid: 'app-pod', creationTimestamp: '2026-08-05T08:00:00Z',
        labels: { 'social.usernode.io/runtime-name': 'sv-app-7-demo' },
      },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: [{ restartCount: 2 }],
      },
    }],
    'social-workers': [{
      metadata: {
        name: 'sv-worker-s42-pod', uid: 'worker-pod', creationTimestamp: '2026-08-05T08:05:00Z',
        labels: { 'social.usernode.io/runtime-name': 'sv-worker-s42' },
      },
      status: { conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ restartCount: 0 }] },
    }],
  };
  kubernetes._setClientsForTest({
    apps: {
      async listNamespacedDeployment({ namespace }) { return { items: deploymentsByNamespace[namespace] || [] }; },
    },
    core: {
      async listNamespacedPod({ namespace }) { return { items: podsByNamespace[namespace] || [] }; },
    },
  });

  const inventory = await kubernetes.listStatusResources(config());
  const app = inventory.find((item) => item.name === 'sv-app-7-demo');
  const preview = inventory.find((item) => item.name === 'sv-preview-7-s42');
  const worker = inventory.find((item) => item.name === 'sv-worker-s42');
  assert.equal(app.resourceType, 'app');
  assert.equal(app.state, 'running');
  assert.equal(app.startedAt, '2026-08-05T08:00:00Z');
  assert.match(app.status, /2 restarts/);
  assert.equal(preview.resourceType, 'staging');
  assert.equal(preview.state, 'restarting');
  assert.equal(preview.sessionId, 42);
  assert.equal(worker.resourceType, 'worker');
  assert.equal(worker.state, 'running');
});

test('namespace capacity reports requests and pod quota without claiming live usage', async () => {
  kubernetes._setClientsForTest({
    core: {
      async listNamespacedResourceQuota({ namespace }) {
        return {
          items: [{
            metadata: { name: 'social-vibecoding' },
            status: {
              hard: { pods: '100', 'requests.cpu': '16', 'requests.memory': '32Gi' },
              used: { pods: namespace === 'social-apps' ? '4' : '0', 'requests.cpu': '750m', 'requests.memory': '1536Mi' },
            },
          }],
        };
      },
    },
  });

  const capacity = await kubernetes.listNamespaceCapacity(config());
  const apps = capacity.find((item) => item.namespace === 'social-apps');
  assert.deepEqual(apps.resources.pods, { used: '4', hard: '100', percent: 4, headroomPercent: 96 });
  assert.deepEqual(apps.resources.requestsCpu, { used: '750m', hard: '16', percent: 4.7, headroomPercent: 95.3 });
  assert.deepEqual(apps.resources.requestsMemory, { used: '1536Mi', hard: '32Gi', percent: 4.7, headroomPercent: 95.3 });
  assert.equal(kubernetes._quantityNumberForTest('1Gi'), 2 ** 30);
  assert.equal(kubernetes._quantityNumberForTest('250m'), 0.25);
});

test('capacity exposes saturated limit, storage and object quotas when CPU limits are unquoted', async () => {
  kubernetes._setClientsForTest({ core: {
    async listNamespacedResourceQuota() {
      return { items: [{ metadata: { name: 'social-vibecoding' }, status: {
        hard: {
          'requests.cpu': '24', 'limits.memory': '128Gi', 'requests.storage': '600Gi',
          'requests.ephemeral-storage': '100Gi', 'limits.ephemeral-storage': '400Gi',
          persistentvolumeclaims: '120', services: '128', secrets: '200', configmaps: '100',
          'count/jobs.batch': '100', 'count/builds.kpack.io': '100',
        },
        used: {
          'requests.cpu': '1', 'limits.memory': '128Gi', 'requests.storage': '500Gi',
          'requests.ephemeral-storage': '75Gi', 'limits.ephemeral-storage': '300Gi',
          persistentvolumeclaims: '119', services: '64', secrets: '180', configmaps: '10',
          'count/jobs.batch': '90', 'count/builds.kpack.io': '100',
        },
      } }] };
    },
  } });
  const [{ resources }] = await kubernetes.listNamespaceCapacity(config());
  assert.equal(resources.limitsCpu, null, 'no aggregate CPU limit must not invent a capacity');
  assert.equal(resources.requestsCpu.percent, 4.2);
  assert.equal(resources.limitsMemory.percent, 100, 'memory blocks admission despite low CPU requests');
  assert.equal(resources.limitsMemory.headroomPercent, 0);
  assert.equal(resources.requestsStorage.percent, 83.3);
  assert.equal(resources.persistentVolumeClaims.percent, 99.2);
  assert.equal(resources.requestsEphemeralStorage.percent, 75);
  assert.equal(resources.limitsEphemeralStorage.percent, 75);
  assert.equal(resources.services.percent, 50);
  assert.equal(resources.secrets.percent, 90);
  assert.equal(resources.configMaps.percent, 10);
  assert.equal(resources.jobs.percent, 90);
  assert.equal(resources.builds.percent, 100);
});


for (const failed of [false, true]) {
  test(`unit-suite Job ${failed ? 'preserves failures' : 'completes'} with private input and no cluster credentials`, async () => {
    let job, secret, removed;
    kubernetes._setClientsForTest({
      batch: {
        async createNamespacedJob(r) { job = r.body; },
        async readNamespacedJob() { return { status: failed ? { failed: 1 } : { succeeded: 1 } }; },
      },
      core: {
        async createNamespacedSecret(r) { secret = r.body; },
        async deleteNamespacedSecret(r) { removed = r.name; },
        async listNamespacedPod() { return { items: [{ metadata: { name: 'suite-pod' }, status: { containerStatuses: [{ name: 'unit-suite', state: { terminated: { exitCode: 1, reason: 'Error' } } }] } }] }; },
        async readNamespacedPodLog(r) { assert.equal(r.container, 'unit-suite'); return '# tests 2\n# fail 1\nnot ok 2 - regression\n'; },
      },
    });
    const options = { sessionId: 42, cmd: ['bash', '-c', 'npm test'], env: { REPO_URL: 'https://private-token@example.test/repo' }, memory: '2g', cpus: '4', timeoutMs: 60000 };
    if (failed) {
      await assert.rejects(kubernetes.runUnitSuiteJob(config(), options), err => {
        assert.equal(err.code, 1);
        assert.match(err.stdout, /not ok 2 - regression/);
        return true;
      });
    } else {
      assert.match((await kubernetes.runUnitSuiteJob(config(), options)).stdout, /# tests 2/);
    }
    const pod = job.spec.template.spec;
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(pod.securityContext.runAsUser, 1000);
    assert.equal(job.spec.backoffLimit, 0);
    assert.equal(job.spec.activeDeadlineSeconds, 60);
    assert.equal(job.spec.ttlSecondsAfterFinished, 3600);
    assert.equal(pod.containers[0].image, config().kubernetes.workerImage);
    assert.equal(pod.containers[0].resources.limits.memory, '2Gi');
    assert.equal(pod.containers[0].resources.limits.cpu, '4');
    assert.deepEqual(pod.containers[0].command, options.cmd);
    assert.ok(!JSON.stringify(job).includes('private-token'));
    assert.equal(secret.stringData.REPO_URL, options.env.REPO_URL);
    assert.equal(removed, secret.metadata.name);
  });
}

test('unit-suite input Secret is removed when Job admission fails', async () => {
  let removed = false;
  kubernetes._setClientsForTest({
    batch: { async createNamespacedJob() { throw new Error('quota'); } },
    core: { async createNamespacedSecret() {}, async deleteNamespacedSecret() { removed = true; } },
  });
  await assert.rejects(kubernetes.runUnitSuiteJob(config(), { sessionId: 1, env: {}, cmd: ['true'] }), /quota/);
  assert.equal(removed, true);
});


test('unit-suite credentials are owned by the Job and cleaned after its deadline', async (t) => {
  let secret, deletedJob, deletedSecret, owned;
  let clock = 0;
  t.mock.method(Date, 'now', () => ++clock <= 2 ? 0 : 20000);
  kubernetes._setClientsForTest({
    batch: {
      async createNamespacedJob() { return { metadata: { uid: 'job-uid' } }; },
      async deleteNamespacedJob(r) { deletedJob = r; },
    },
    core: {
      async createNamespacedSecret(r) { secret = r.body; },
      async readNamespacedSecret() { return secret; },
      async replaceNamespacedSecret(r) { owned = r.body.metadata.ownerReferences; },
      async deleteNamespacedSecret(r) { deletedSecret = r.name; },
    },
  });
  await assert.rejects(kubernetes.runUnitSuiteJob(config(), { sessionId: 1, env: {}, cmd: ['sleep', '60'], timeoutMs: 1000 }), err => err.killed === true);
  assert.equal(owned[0].uid, 'job-uid');
  assert.equal(owned[0].kind, 'Job');
  assert.equal(deletedJob.propagationPolicy, 'Background');
  assert.equal(deletedSecret, secret.metadata.name);
});

test('unit suite refuses a mutable worker image before creating any resources', async () => {
  const cfg = config();
  cfg.kubernetes.workerImage = 'example/worker:latest';
  kubernetes._setClientsForTest({});
  await assert.rejects(kubernetes.runUnitSuiteJob(cfg, { sessionId: 1 }), /immutable digest/);
});
