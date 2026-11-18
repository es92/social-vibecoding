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
    assert.deepEqual(snap, { description: MANIFEST.description },
      '#6794: the card sentence survives, and it is the only part a client reads');
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

// ── #6794: the list selects and sends only what a list reads ───────────

test('#6794: the list query leaves out what nothing reads and has Postgres trim the two JSON columns', () => {
  const cols = appAccess.appListColumnList('a');
  for (const gone of appAccess.APP_LIST_UNSELECTED_COLUMNS) {
    assert.ok(!new RegExp(`\\ba\\.${gone}\\b`).test(cols), `${gone} is not selected`);
  }
  assert.match(cols, /a\.manifest_snapshot - 'tests' - 'platform_env' ELSE a\.manifest_snapshot END AS manifest_snapshot/);
  assert.match(cols, /jsonb_build_object\('reason', a\.last_failure->'reason', 'at', a\.last_failure->'at'\) ELSE a\.last_failure END AS last_failure/,
    'the boot log never leaves the database for a list');
  // What the handler derives its answer from is still read.
  for (const kept of ['a.main_sha', 'a.directory_review_status', 'a.deploy_state', 'a.offline_cache_off_sha', 'a.self_hosted']) {
    assert.ok(cols.includes(kept), kept);
  }
  // One app's own read is unchanged.
  assert.ok(appAccess.nonSecretAppColumnList().includes('main_check_detail'));
  const src = require('node:fs').readFileSync(require.resolve('../src/routes/apps'), 'utf8');
  assert.ok(src.includes("SELECT ${appAccess.appListColumnList('a')},"), 'GET /api/apps uses it');
  assert.ok(src.includes('SELECT ${appAccess.nonSecretAppColumnList()}, template,'), 'GET /api/apps/:slug keeps every column');
});

test('#6794: a list row carries no column that only the server reads, and keeps what the cards read', async () => {
  appRow = makeAppRow({
    main_sha: 'a'.repeat(40), main_pr_number: 12, repo_url: 'https://github.com/example/recipes',
    main_check_state: 'passing', main_check_sha: 'b'.repeat(40), db_size_bytes: 1234,
    directory_review_status: 'listed', deploy_state: null, container_id: 'c1', retry_count: 2, community_id: 9,
    screenshot_device_scale: 2, demo_base_sha: null, offline_cache_off_sha: null,
    last_failure: { reason: 'Boot failed', at: '2026-11-18T00:00:00Z' },
    icon_emoji: '🍲', audience: 'open',
  });
  const server = await startServer();
  try {
    const { apps } = await getJson(server, '/api/apps');
    const row = apps[0];
    for (const key of appAccess.APP_LIST_UNSENT_KEYS) assert.equal(key in row, false, `${key} is not sent`);
    assert.equal(row.slug, 'recipes');
    assert.equal(row.main_sha, 'a'.repeat(40), 'the About sheet falls back to it');
    assert.equal(row.version.shortSha, 'aaaaaaa');
    assert.equal(row.last_failure_reason, 'Boot failed');
    assert.equal(row.last_failure_at, '2026-11-18T00:00:00Z');
    assert.equal('last_failure' in row, false);
    assert.equal(row.icon_emoji, '🍲');
    assert.ok('directory' in row && 'deployProgress' in row && 'offline_cache' in row, 'what is derived from them still is');
  } finally {
    server.close();
  }
});

test('listManifestSnapshot keeps the one line and passes through what is not a manifest', () => {
  assert.deepEqual(appAccess.listManifestSnapshot(MANIFEST), { description: MANIFEST.description });
  assert.deepEqual(appAccess.listManifestSnapshot({ secrets: [] }), {});
  assert.equal(appAccess.listManifestSnapshot(null), null);
  assert.equal(appAccess.listManifestSnapshot('nope'), 'nope');
});
