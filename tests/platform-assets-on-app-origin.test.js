'use strict';

// The three centrally hosted assets, served from every app's OWN origin.
//
// The defect this guards: an app that names the platform's hostname to load
// the bridge, the native kit and the Tailwind runtime loses all three the
// moment that hostname changes. It did — the platform moved to
// my.onhomeroom.com and every app scaffolded before it went on requesting
// social-vibecoding.usernodelabs.org, which no longer answers, so the
// Tailwind tag 404'd and the very next inline script threw
// `tailwind is not defined` before the app rendered anything.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const k8s = require('../src/services/kubernetes');
const assetServer = require('../scripts/serve-platform-assets');
const { appIdentityEnv, platformOrigin } = require('../src/services/app-identity-env');
const appManifest = require('../src/services/app-manifest');

const CFG = { ingressClassName: 'cilium', appTlsSecretName: 'social-apps-wildcard-tls' };

function ingressFor(hostname, assetBackend = k8s.PLATFORM_ASSET_NAME) {
  return k8s._appIngressManifestForTest({
    name: 'usernode-app-todo-list', namespace: 'social-apps',
    hostname, resourceLabels: {}, cfg: CFG, assetBackend,
  });
}
const pathsOf = (ingress) => ingress.spec.rules[0].http.paths;

test('every app hostname routes the three asset prefixes to the shared backend', () => {
  const paths = pathsOf(ingressFor('todo-list.onhomeroom.com'));
  for (const prefix of k8s.PLATFORM_ASSET_PREFIXES) {
    const rule = paths.find((p) => p.path === prefix);
    assert.ok(rule, `${prefix} is routed`);
    assert.equal(rule.pathType, 'Prefix');
    assert.equal(rule.backend.service.name, k8s.PLATFORM_ASSET_NAME);
  }
  // The app itself still owns everything else.
  const catchAll = paths.find((p) => p.path === '/');
  assert.equal(catchAll.backend.service.name, 'usernode-app-todo-list');
});

test('the asset prefixes precede the catch-all', () => {
  const paths = pathsOf(ingressFor('todo-list.onhomeroom.com'));
  assert.equal(paths[paths.length - 1].path, '/', 'the catch-all is last');
  for (const prefix of k8s.PLATFORM_ASSET_PREFIXES) {
    assert.ok(paths.findIndex((p) => p.path === prefix) < paths.length - 1);
  }
});

test('staging previews get the same routing as production', () => {
  // Proposal checks run against the preview hostname, so an app converted to
  // relative paths would fail its own "Native kit boots" check — and could
  // never merge the conversion — if previews were not covered.
  const preview = pathsOf(ingressFor('todo-list--s412.onhomeroom.com')).map((p) => p.path);
  const production = pathsOf(ingressFor('todo-list.onhomeroom.com')).map((p) => p.path);
  assert.deepEqual(preview, production);
});

test('an unavailable asset backend leaves the app routed exactly as before', () => {
  // Shared infrastructure failing must not change how THIS app is served.
  const paths = pathsOf(ingressFor('todo-list.onhomeroom.com', null));
  assert.deepEqual(paths.map((p) => p.path), ['/']);
  assert.equal(paths[0].backend.service.name, 'usernode-app-todo-list');
});

test('the backend serves exactly the prefixes the Ingress routes to it', () => {
  // The coupling that actually matters: a prefix routed but not served is a
  // 404 on every app, and one served but not routed is dead code.
  assert.deepEqual([...assetServer.PREFIXES].sort(), [...k8s.PLATFORM_ASSET_PREFIXES].sort());
});

test('the asset server serves only its three directories', () => {
  assert.ok(assetServer.resolveAsset('/usernode-native/v1/native.css'));
  assert.ok(assetServer.resolveAsset('/usernode-bridge/v1/bridge.js'));
  // A percent-encoded `..` survives URL parsing and is only decoded inside
  // resolveAsset, so containment has to be checked against the asset
  // directories rather than against public/ — otherwise this process
  // quietly becomes a static server for the whole public tree.
  assert.equal(assetServer.resolveAsset('/usernode-native/%2e%2e/js/app.js'), null);
  assert.equal(assetServer.resolveAsset('/usernode-native/../../../etc/passwd'), null);
  assert.equal(assetServer.resolveAsset('/js/app.js'), null);
  assert.equal(assetServer.isAssetPath('/js/app.js'), false);
});

test('the files the backend is asked for are really in the image', () => {
  for (const file of ['usernode-bridge/v1/bridge.js', 'usernode-native/v1/native.css',
    'usernode-native/v1/native.js', 'usernode-tailwind/v1/tailwind.js']) {
    assert.ok(fs.existsSync(path.join(assetServer.ROOT, file)), `${file} ships in public/`);
  }
});

test('the asset backend runs the platform image and is not mistaken for an app', async (t) => {
  const created = [];
  const fake = {
    apps: {
      readNamespacedDeployment: async ({ name, namespace }) => {
        assert.equal(namespace, 'social-platform');
        assert.equal(name, 'social-vibecoding');
        return { spec: { template: { spec: { containers: [
          { name: 'platform', image: 'registry.example/social-vibecoding@sha256:abc' },
        ] } } } };
      },
      createNamespacedDeployment: async ({ namespace, body }) => { created.push({ namespace, body }); return body; },
      replaceNamespacedDeployment: async ({ body }) => body,
      listNamespacedPod: async () => ({ items: [] }),
    },
    core: {
      readNamespacedService: async () => { const e = new Error('nf'); e.code = 404; throw e; },
      createNamespacedService: async ({ namespace, body }) => { created.push({ namespace, body }); return body; },
      replaceNamespacedService: async ({ body }) => body,
    },
  };
  // The Deployment read must 404 on first reconcile too.
  fake.apps.readNamespacedDeployment = (() => {
    const platform = fake.apps.readNamespacedDeployment;
    let seen = 0;
    return async (args) => {
      if (args.namespace === 'social-apps') {
        // First read is the upsert's existence check (404 -> create). Later
        // reads are waitForDeployment polling for readiness.
        if (seen++ === 0) { const e = new Error('nf'); e.code = 404; throw e; }
        return { metadata: { name: args.name, generation: 1 }, spec: { replicas: 2 },
          status: { observedGeneration: 1, replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 } };
      }
      return platform(args);
    };
  })();

  k8s._setClientsForTest(fake);
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  const config = { kubernetes: { appNamespace: 'social-apps', platformNamespace: 'social-platform',
    platformDeployment: 'social-vibecoding', generatedAppServiceAccount: 'social-generated-app' } };
  const name = await k8s._ensurePlatformAssetBackendForTest(config);
  assert.equal(name, k8s.PLATFORM_ASSET_NAME);

  const deployment = created.find((r) => r.body.kind === 'Deployment').body;
  const service = created.find((r) => r.body.kind === 'Service').body;
  assert.equal(created.every((r) => r.namespace === 'social-apps'), true,
    'it lives beside the apps, because an Ingress backend must be same-namespace');

  const container = deployment.spec.template.spec.containers[0];
  assert.equal(container.image, 'registry.example/social-vibecoding@sha256:abc',
    'the image comes from the running platform Deployment, so the assets track the platform');
  // Dockerfile.kubernetes uses node:22-alpine with USER node. Kubernetes
  // needs its numeric UID to enforce runAsNonRoot, and this platform image
  // launches Node directly (it has no CNB launcher).
  assert.deepEqual(deployment.spec.template.spec.securityContext, {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    seccompProfile: { type: 'RuntimeDefault' },
  });
  assert.deepEqual(container.command, ['node', 'scripts/serve-platform-assets.js']);
  assert.deepEqual(container.args || [], []);
  assert.ok(deployment.spec.replicas >= 2, 'no single-replica restart gap on every app page load');
  assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);

  // listStatusResources enumerates APP deployments by this label value; the
  // asset backend is not an app and must not appear there as a phantom one.
  assert.notEqual(deployment.metadata.labels['app.kubernetes.io/managed-by'], 'social-vibecoding-runtime');
  assert.deepEqual(service.spec.selector, deployment.spec.selector.matchLabels,
    'an ordinary selector Service — the one backend shape every ingress controller programs');
});

test('a failed reconcile is retried rather than remembered', async (t) => {
  let calls = 0;
  k8s._setClientsForTest({
    apps: { readNamespacedDeployment: async () => { calls += 1; throw new Error('api down'); } },
    core: {},
  });
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  const config = { kubernetes: { appNamespace: 'social-apps' } };

  // A failure is never cached as a SUCCESS — the next attempt after the
  // cooldown really does reconcile again, so a transient API error heals by
  // itself rather than leaving the fleet unrouted until a platform restart.
  await assert.rejects(() => k8s._ensurePlatformAssetBackendForTest(config, { retryAfterMs: 0 }));
  await assert.rejects(() => k8s._ensurePlatformAssetBackendForTest(config, { retryAfterMs: 0 }));
  assert.equal(calls, 2, 'the memo does not cache a failure');

  // But inside the cooldown it declines immediately rather than retrying:
  // otherwise a backend that cannot come up adds its readiness wait to every
  // app deploy on the platform instead of costing it once.
  await assert.rejects(() => k8s._ensurePlatformAssetBackendForTest(config, { retryAfterMs: 300000 }));
  assert.equal(await k8s._ensurePlatformAssetBackendForTest(config), null);
  assert.equal(calls, 3, 'the cooled-off call touched no API at all');
});

test('apps are handed the platform origin for the links a relative path cannot express', () => {
  const before = process.env.USERNODE_DOMAIN;
  try {
    process.env.USERNODE_DOMAIN = 'my.example.com';
    assert.equal(platformOrigin(), 'https://my.example.com');
    assert.equal(appIdentityEnv({ id: 7 }).USERNODE_PLATFORM_ORIGIN, 'https://my.example.com');

    // Omitted, never defaulted: a baked-in fallback is the exact failure
    // this key exists to end.
    delete process.env.USERNODE_DOMAIN;
    assert.equal(platformOrigin(), null);
    assert.ok(!('USERNODE_PLATFORM_ORIGIN' in appIdentityEnv({ id: 7 })));
  } finally {
    if (before === undefined) delete process.env.USERNODE_DOMAIN;
    else process.env.USERNODE_DOMAIN = before;
  }
});

test('an app manifest cannot shadow the platform origin', () => {
  // This set is what the manifest reader consults before accepting a
  // declared secret: a key in it is dropped with a warning rather than
  // handed to the container. Without it an app could redeclare the key and
  // point its own "Open in Homeroom" links wherever it liked.
  assert.ok(appManifest.RESERVED_KEYS.has('USERNODE_PLATFORM_ORIGIN'));
});

const DEAD_HOST = /\bsocial-vibecoding\.usernodelabs\.org\b/;

test('nothing the platform hands a coding agent names a platform hostname', () => {
  // The regression guard, asserted on what is actually EMITTED rather than
  // on source text — so a comment recording this defect's history cannot
  // satisfy it, and no new literal can slip past by being formatted oddly.
  //
  // Both surfaces were live defects. The work order handed every agent three
  // dead links, and the conventions doc injected into every build agent's
  // system prompt told them to load the same dead host — which is how apps
  // kept being built with a hostname that a domain move invalidates.
  const before = process.env.USERNODE_DOMAIN;
  try {
    process.env.USERNODE_DOMAIN = 'my.example.com';
    delete require.cache[require.resolve('../src/services/prompts')];
    const prompts = require('../src/services/prompts');
    const svc = require('../src/services/external-agent-tasks');

    const conventions = prompts.getAppConventions();
    assert.doesNotMatch(conventions, DEAD_HOST);
    assert.match(conventions, /my\.example\.com\/usernode-tailwind\/v1\/tailwind\.js/,
      'the doc names THIS deployment, resolved at load');

    const order = svc.buildWorkOrder({
      appName: 'Recipe Box', appSlug: 'recipe-box',
      upstreamUrl: 'https://github.com/usernode-bot/recipe-box',
      upstreamSlug: 'usernode-bot/recipe-box',
      forkUrl: 'https://github.com/someuser/recipe-box',
      forkCloneUrl: 'https://github.com/someuser/recipe-box.git',
      forkRepo: 'recipe-box',
      forkPageUrl: 'https://github.com/usernode-bot/recipe-box/fork',
      forkStatus: 'ready',
      branch: 'usernode/recipe-box-issue-4-abc123',
      baseSha: `ba5e${'0'.repeat(34)}fe`,
      brief: 'x',
      webPath: 'https://usernode.example/#app/recipe-box',
      taskId: 31,
      platformRules: prompts.getWorkOrderEssentials(),
    });
    assert.doesNotMatch(order, DEAD_HOST);
  } finally {
    if (before === undefined) delete process.env.USERNODE_DOMAIN;
    else process.env.USERNODE_DOMAIN = before;
    delete require.cache[require.resolve('../src/services/prompts')];
  }
});

test('the hard-coded hostname fallbacks that remain have not grown', () => {
  // Six `process.env.USERNODE_DOMAIN || '<literal>'` defaults predate this
  // change and are NOT fixed by it. They are listed rather than tolerated
  // silently: a seventh fails this test, and the two that matter most are
  // named here so the debt is visible instead of folklore.
  //
  //   template.js  — scaffolds NEW apps, so a deployment that leaves
  //                  USERNODE_DOMAIN unset bakes the dead host into every
  //                  app it creates. This is the defect repeating itself.
  //   caddy.js     — the docker runtime's app hostname suffix.
  //
  // The other four (a migration's staging fixtures, a claude.md link, a
  // User-Agent string) are inert by comparison.
  const KNOWN = [
    'src/db/migrate.js',
    'src/routes/sessions.js',
    'src/services/anthropic-credits.js',
    'src/services/caddy.js',
    'src/services/template.js',
  ];
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|md)$/.test(entry.name)) continue;
      if (DEAD_HOST.test(fs.readFileSync(full, 'utf-8'))) {
        found.add(path.relative(path.join(__dirname, '..'), full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  walk(path.join(__dirname, '..', 'scripts'));
  assert.deepEqual([...found].sort(), KNOWN,
    'derive the origin from USERNODE_DOMAIN rather than naming a host a domain move invalidates');
});

test('the platform\'s own app keeps serving its own asset trees', async (t) => {
  // The regression these two assertions exist for: the platform IS the
  // source of /usernode-bridge/, /usernode-native/ and /usernode-tailwind/.
  // Routing them to the shared backend on its own deployment served a
  // preview the PRODUCTION image's copy of those files, so the preview's
  // checks described bytes that were not in the preview. Fifteen native-kit
  // demo checks went red on /usernode-native/v1/demo.html.
  k8s._setClientsForTest({
    apps: { readNamespacedDeployment: async () => { throw new Error('must not reconcile for the self app'); } },
    core: {},
  });
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  // The manifest an unrouted app gets: its own catch-all and nothing else.
  const paths = pathsOf(ingressFor('usernode-2d5619--s4137.onhomeroom.com', null));
  assert.deepEqual(paths.map((p) => p.path), ['/'],
    'the self app serves every path from itself, asset trees included');
});

test('a backend that never becomes ready is not routed to', async (t) => {
  // Publishing the Ingress paths on an upsert that merely SUCCEEDED turned a
  // broken backend into a 503 on every asset path — strictly worse than not
  // routing at all, because then the app cannot serve them either. Readiness
  // is the gate, so the failure mode is "no asset routing", the status quo.
  const fake = {
    apps: {
      readNamespacedDeployment: async ({ namespace, name }) => {
        if (namespace === 'social-platform') {
          return { spec: { template: { spec: { containers: [{ name: 'platform', image: 'img@sha256:a' }] } } } };
        }
        // Never ready.
        return { metadata: { name, generation: 1 }, spec: { replicas: 2 },
          status: { observedGeneration: 1, replicas: 2, updatedReplicas: 0, readyReplicas: 0, availableReplicas: 0 } };
      },
      createNamespacedDeployment: async ({ body }) => body,
      replaceNamespacedDeployment: async ({ body }) => body,
      listNamespacedPod: async () => ({ items: [] }),
    },
    core: {
      readNamespacedService: async () => { const e = new Error('nf'); e.code = 404; throw e; },
      createNamespacedService: async ({ body }) => body,
      replaceNamespacedService: async ({ body }) => body,
      listNamespacedPod: async () => ({ items: [] }),
    },
  };
  k8s._setClientsForTest(fake);
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  const config = { kubernetes: { appNamespace: 'social-apps', platformNamespace: 'social-platform',
    platformDeployment: 'social-vibecoding', generatedAppServiceAccount: 'social-generated-app' } };
  await assert.rejects(
    () => k8s._ensurePlatformAssetBackendForTest(config, { readyTimeoutMs: 150 }),
    'reconcile fails rather than reporting a backend that cannot serve'
  );

  // And it then backs off. Without this, a backend that cannot come up adds
  // the readiness wait to EVERY app deploy on the platform rather than
  // costing it once — the routing is what gets delayed, and nothing needs it
  // urgently enough to pay that.
  const startedAt = Date.now();
  assert.equal(await k8s._ensurePlatformAssetBackendForTest(config, { readyTimeoutMs: 150 }), null,
    'the next caller gets no backend rather than another wait');
  assert.ok(Date.now() - startedAt < 100, 'and returns immediately');
});

test('the platform\'s own deploy still reconciles the shared backend', async (t) => {
  // #2045. Reconciling the shared backend and routing THIS app to it are
  // separate questions, and guarding both on the self-app check meant
  // platform previews — the most frequent deploy here — stopped reconciling
  // at all. The one thing that happens constantly could then no longer heal
  // a broken backend, and an already-deployed app whose Ingress carried the
  // asset paths answered 503 with no way back: it cannot detect that, cannot
  // serve those paths itself (the Ingress rule wins), and cannot fix it from
  // app code.
  let reconciled = 0;
  const fake = {
    apps: {
      readNamespacedDeployment: async ({ namespace, name }) => {
        if (namespace === 'social-platform') {
          reconciled += 1;
          return { spec: { template: { spec: { containers: [{ name: 'platform', image: 'img@sha256:a' }] } } } };
        }
        return { metadata: { name, generation: 1 }, spec: { replicas: 2 },
          status: { observedGeneration: 1, replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 } };
      },
      createNamespacedDeployment: async ({ body }) => body,
      replaceNamespacedDeployment: async ({ body }) => body,
      listNamespacedPod: async () => ({ items: [] }),
    },
    core: {
      readNamespacedService: async () => { const e = new Error('nf'); e.code = 404; throw e; },
      createNamespacedService: async ({ body }) => body,
      replaceNamespacedService: async ({ body }) => body,
      listNamespacedPod: async () => ({ items: [] }),
    },
  };
  k8s._setClientsForTest(fake);
  k8s._resetPlatformAssetBackendForTest();
  t.after(() => { k8s._setClientsForTest(null); k8s._resetPlatformAssetBackendForTest(); });

  const config = { kubernetes: { appNamespace: 'social-apps', platformNamespace: 'social-platform',
    platformDeployment: 'social-vibecoding', generatedAppServiceAccount: 'social-generated-app' } };
  assert.equal(await k8s.ensurePlatformAssetBackend(config), k8s.PLATFORM_ASSET_NAME);
  assert.equal(reconciled, 1, 'the reconcile is reachable independent of which app is deploying');

  // The self app still must not be ROUTED to it — it is the source of those
  // three trees, and routing them away serves a preview the production
  // image's copy of its own files.
  assert.deepEqual(
    pathsOf(ingressFor('usernode-2d5619--s4137.onhomeroom.com', null)).map((p) => p.path),
    ['/'],
  );
});

test('the boot path reconciles the backend, on Kubernetes only', () => {
  // Otherwise a fix to how the backend is BUILT does not reach one that
  // already exists until some child app happens to deploy.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  const leader = server.slice(server.indexOf('async function becomeLeader()'));
  const call = leader.indexOf('ensurePlatformAssetBackend');
  assert.ok(call > 0, 'the leader reconciles the hosted-asset backend');

  const block = leader.slice(0, call);
  assert.match(block.slice(-400), /mode\(config\) === 'kubernetes'/,
    'gated on the runtime — the docker runtime has no cluster to reconcile against');
  // Fire-and-forget: a platform that cannot reach its cluster must still boot.
  assert.match(leader.slice(call, call + 400), /\.catch\(/,
    'failure is logged, never fatal');
  assert.doesNotMatch(leader.slice(Math.max(0, call - 200), call), /await\s+require/,
    'and never awaited, so boot is not blocked on it');
});
