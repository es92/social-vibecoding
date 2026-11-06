// The launcher list, and the shell's own reads of one app, carry the manifest
// snapshot WITHOUT its declared tests and platform env.
//
// Those two blocks are read only by the server, and they are the only parts of
// the snapshot that grow without bound: the platform's own dapp.json declares
// 800+ checks, which made its one snapshot ~280 KB of every GET /api/apps (and
// of the GET /api/apps/:slug the Improve target made on every load). The
// description — the one field a client reads — has to survive, and the detail
// route without the flag still answers the whole snapshot.
//
// Same harness shape as tests/apps-creation-phase-route.test.js.
//
// Run with: node --test tests/app-manifest-summary-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  appCreator: require.resolve('../src/services/app-creator'),
  appForker: require.resolve('../src/services/app-forker'),
  caddy: require.resolve('../src/services/caddy'),
  docker: require.resolve('../src/services/docker'),
  github: require.resolve('../src/services/github'),
  driftPoller: require.resolve('../src/services/main-drift-poller'),
  appSecrets: require.resolve('../src/services/app-secrets'),
  appManifest: require.resolve('../src/services/app-manifest'),
  renamePr: require.resolve('../src/services/rename-pr'),
  staging: require.resolve('../src/services/staging'),
};

stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub(ids.appCreator, { createApp: async () => {} });
stub(ids.appForker, { forkApp: async () => {} });
stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
stub(ids.docker, { getHostPort: async () => null });
stub(ids.github, { parseGithubUrl: () => null, isEnabled: () => false });
stub(ids.driftPoller, { checkAndRedeployOne: async () => ({}) });
stub(ids.appSecrets, {});
stub(ids.appManifest, { MAX_APP_NAME_LENGTH: 64 });
stub(ids.renamePr, {});
stub(ids.staging, { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });

const MANIFEST = {
  name: 'Recipes',
  description: 'Shared recipes for the house.',
  secrets: [{ key: 'API_KEY', required: false }],
  governance: { strategy: 'approvals' },
  tests: Array.from({ length: 50 }, (_, i) => ({
    name: `check ${i}`, path: `/#route-${i}`, expectText: 'x'.repeat(200),
  })),
  platform_env: [{ key: 'SOME_ENV', description: 'y'.repeat(500) }],
};

function makeAppRow(over) {
  return {
    id: 7,
    name: 'Recipes',
    slug: 'recipes',
    status: 'stopped',
    created_by: 100,
    self_hosted: false,
    collab_visibility: 'public',
    view_visibility: 'public',
    manifest_snapshot: MANIFEST,
    forked_from: null,
    last_failure: null,
    ...over,
  };
}

const poolMod = require('../src/db/pool');
let appRow = makeAppRow();
poolMod.getPool = () => ({
  query: async (sql) => {
    const s = String(sql);
    if (/FROM apps WHERE slug = \$1/.test(s)) return { rows: [appRow] };
    if (/FROM apps a\b/.test(s)) return { rows: [appRow] };
    return { rows: [], rowCount: 0 };
  },
});

const appAccess = require('../src/services/app-access');
const { appRoutes } = require('../src/routes/apps');
const express = require('express');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 100, username: 'creator' }; next(); });
  app.use(appRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function getJson(server, path) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  assert.equal(res.status, 200, path);
  return res.json();
}

test('summarizeManifestSnapshot drops only the declared tests and platform env', () => {
  const out = appAccess.summarizeManifestSnapshot(MANIFEST);
  assert.deepEqual(Object.keys(out).sort(), ['description', 'governance', 'name', 'secrets']);
  assert.equal(out.description, MANIFEST.description);
  assert.deepEqual(out.secrets, MANIFEST.secrets);
  // A copy: the stored row is never mutated.
  assert.ok(Array.isArray(MANIFEST.tests) && Array.isArray(MANIFEST.platform_env));
});

test('summarizeManifestSnapshot passes through what it has nothing to drop from', () => {
  const small = { description: 'x', secrets: [] };
  assert.equal(appAccess.summarizeManifestSnapshot(small), small);
  assert.equal(appAccess.summarizeManifestSnapshot(null), null);
  assert.equal(appAccess.summarizeManifestSnapshot(undefined), undefined);
  assert.equal(appAccess.summarizeManifestSnapshot('nope'), 'nope');
  const list = [1, 2];
  assert.equal(appAccess.summarizeManifestSnapshot(list), list);
});

test('GET /api/apps carries the launcher copy of every manifest', async () => {
  appRow = makeAppRow();
  const server = await startServer();
  try {
    const { apps } = await getJson(server, '/api/apps');
    assert.equal(apps.length, 1);
    const snap = apps[0].manifest_snapshot;
    assert.equal(snap.description, MANIFEST.description, 'the card sentence survives');
    assert.deepEqual(snap.secrets, MANIFEST.secrets);
    assert.equal(snap.tests, undefined);
    assert.equal(snap.platform_env, undefined);
  } finally {
    server.close();
  }
});

test('GET /api/apps/:slug answers the whole snapshot unless asked for the summary', async () => {
  appRow = makeAppRow();
  const server = await startServer();
  try {
    const full = (await getJson(server, '/api/apps/recipes')).app.manifest_snapshot;
    assert.deepEqual(full, MANIFEST);

    const summary = (await getJson(server, '/api/apps/recipes?manifest=summary')).app.manifest_snapshot;
    assert.equal(summary.description, MANIFEST.description);
    assert.equal(summary.tests, undefined);
    assert.equal(summary.platform_env, undefined);
  } finally {
    server.close();
  }
});

test('the shell reads the app record as a summary', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const appView = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');
  assert.match(appView, /fetch\(`\/api\/apps\/\$\{slug\}\?manifest=summary`\)/,
    'AppView.open reads the summary');
  const target = fs.readFileSync(path.join(root, 'frontend/src/features/app-context/platform-target.js'), 'utf8');
  assert.match(target, /\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\?manifest=summary/,
    'the Improve target reads the summary');
  // One address for all of them, so the service worker holds one copy and an
  // app opened from its channel is already warm.
  const messages = fs.readFileSync(path.join(root, 'frontend/src/features/messages/store.ts'), 'utf8');
  assert.match(messages, /\/api\/apps\/\$\{encodeURIComponent\(want\)\}\?manifest=summary/,
    'the discussion pane reads the summary');
});
