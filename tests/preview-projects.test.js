'use strict';

// Projects made inside a platform preview: production's half
// (services/preview-projects.js) and its door (routes/preview-projects.js),
// without a database. The SQL is pinned against PostgreSQL in
// preview-projects-postgres.test.js; the preview's half in
// preview-projects-client.test.js.
//
// Run with: node --test tests/preview-projects.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const projects = require('../src/services/preview-projects');
const { previewProjectsRoutes, BUILD_BODY_LIMIT } = require('../src/routes/preview-projects');
const dbManager = require('../src/services/db-manager');
const redaction = require('../src/services/log-redaction');

const SELF = 'usernode-2d5619';
const CONFIG = { selfAppSlug: SELF, previewProjectsEnabled: true, appRuntime: 'kubernetes', kubernetes: { appNamespace: 'social-apps' } };

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let result;
  try { result = fn(); } catch (err) { restore(); throw err; }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

function fakePool(handlers, queries = []) {
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [needle, rows] of handlers) {
        if (sql.includes(needle)) return { rows: typeof rows === 'function' ? rows(params) : rows, rowCount: 1 };
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

// ── The switch ─────────────────────────────────────────────────────────

test('it is off unless switched on, never on in a preview, and only on Kubernetes', () => {
  withEnv({ USERNODE_ENV: 'production' }, () => {
    assert.equal(projects.enabled({ ...CONFIG, previewProjectsEnabled: false }), false);
    assert.equal(projects.enabled({ selfAppSlug: SELF, appRuntime: 'kubernetes' }), false, 'off by default');
    assert.equal(projects.enabled({ ...CONFIG, appRuntime: 'docker' }), false, 'Docker previews share an alias per session');
    assert.equal(projects.enabled(CONFIG), true);
  });
  withEnv({ USERNODE_ENV: 'staging' }, () => {
    assert.equal(projects.enabled(CONFIG), false, 'a preview never answers for another');
  });
});

test('the chart switches it off by default, and passes false through as false', () => {
  const values = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'helm', 'social-vibecoding-platform', 'values.yaml'), 'utf8');
  const template = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'helm', 'social-vibecoding-platform', 'templates', 'platform.yaml'), 'utf8');
  assert.match(values, /^ {2}previewProjects: false$/m);
  const line = template.split('\n').find((l) => l.includes('PREVIEW_PROJECTS_ENABLED'));
  assert.ok(line, 'the platform Deployment carries the switch');
  assert.match(line, /\.Values\.config\.previewProjects \| quote/);
  assert.doesNotMatch(line, /default/, 'Helm\'s default swallows false');
  const config = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
  assert.match(config, /previewProjectsEnabled: process\.env\.PREVIEW_PROJECTS_ENABLED === 'true'/);
});

// ── The credential ─────────────────────────────────────────────────────

test('a credential is 256 random bits behind its prefix; only its hash is stored, and logs mask it', () => {
  const a = projects.makeToken();
  const b = projects.makeToken();
  assert.match(a, /^svpp_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.match(projects.hashToken(a), /^[0-9a-f]{64}$/);
  assert.equal(projects.tokenFromHeader(`Bearer ${a}`), a);
  assert.equal(projects.tokenFromHeader(`bearer ${a}`), null);
  assert.equal(projects.tokenFromHeader(`Bearer ${a}x`), null);
  assert.equal(projects.tokenFromHeader('Bearer svpu_' + 'a'.repeat(43)), null, 'another credential\'s shape is not this one');
  assert.doesNotMatch(redaction.redactString(`token=${a}`), /svpp_[A-Za-z0-9_-]{43}/);
});

test('a token names a session of the PLATFORM, and nothing else', async () => {
  const token = projects.makeToken();
  const found = (slug) => fakePool([['FROM preview_project_tokens k', [{ session_id: 41, app_slug: slug }]]]);
  assert.deepEqual(await projects.authenticate(CONFIG, found(SELF), token), { ok: true, sessionId: 41 });
  assert.equal((await projects.authenticate(CONFIG, found('recipe-box'), token)).status, 401);
  assert.equal((await projects.authenticate(CONFIG, fakePool([['FROM preview_project_tokens k', []]]), token)).status, 401);
  const none = fakePool([]);
  assert.equal((await projects.authenticate(CONFIG, none, 'svpu_' + 'a'.repeat(43))).status, 401);
  assert.equal(none.queries.length, 0, 'a malformed token is refused before any lookup');
  const looked = found(SELF);
  await projects.authenticate(CONFIG, looked, token);
  assert.deepEqual(looked.queries[0].params, [projects.hashToken(token)], 'the lookup is by hash, never the token');
});

test('a platform preview is given the address, its credential, its session and its own origins; nothing else is', async () => {
  await withEnv({ USERNODE_ENV: 'production', PLATFORM_INTERNAL_URL: 'http://usernode.platform.svc:3000/' }, async () => {
    const queries = [];
    const pool = fakePool([
      ['INSERT INTO preview_project_tokens', [{ id: 9 }]],
      ['DELETE FROM preview_project_tokens', []],
    ], queries);
    const env = await projects.previewEnv(CONFIG, { app: { id: 2, slug: SELF }, sessionId: 11513, pool });
    assert.equal(env.PREVIEW_PROJECTS_URL, 'http://usernode.platform.svc:3000');
    assert.match(env.PREVIEW_PROJECTS_TOKEN, /^svpp_/);
    assert.equal(env.PREVIEW_PROJECTS_SESSION_ID, '11513');
    assert.match(env.PREVIEW_PROJECTS_ORIGIN, /^https:\/\/usernode-2d5619--s11513\./);
    assert.equal(env.PREVIEW_PROJECTS_INTERNAL_ORIGIN, 'http://sv-preview-2-s11513.social-apps.svc:3000');
    assert.equal(queries[0].params[1], projects.hashToken(env.PREVIEW_PROJECTS_TOKEN), 'only the hash goes in');
    assert.equal(env.MAX_APPS, '0', 'the broker caps it; the server-wide cap would stop Make it on the sample tiles alone');
    assert.equal(env.PREVIEW_PROJECTS_STARTER_DIRS, undefined, 'no commit, no starters');

    const untouched = fakePool([]);
    assert.deepEqual(await projects.previewEnv(CONFIG, { app: { id: 7, slug: 'recipe-box' }, sessionId: 5, pool: untouched }), {});
    assert.deepEqual(await projects.previewEnv({ ...CONFIG, previewProjectsEnabled: false }, { app: { id: 2, slug: SELF }, sessionId: 5, pool: untouched }), {});
    assert.equal(untouched.queries.length, 0);
  });
});

test('the starters a proposal changed are its app-templates directories, not the shared ones, up to the cap', () => {
  assert.deepEqual(projects.starterDirsIn([
    'app-templates/tier-list/api.js', 'app-templates/tier-list/public/app.js', 'app-templates/_scaffold/server.js',
    'app-templates/_game-room/x.js', 'src/services/app-templates.js', 'app-templates/group-poll/api.js',
    'app-templates/chore-list/api.js', 'app-templates/grocery-list/api.js',
  ]), ['tier-list', 'group-poll', 'chore-list']);
  assert.deepEqual(projects.starterDirsIn(null), []);
});

test('production asks the repository what the preview\'s commit changed, and names those starters', async () => {
  const github = require('../src/services/github');
  const saved = github.compareRefs;
  const asked = [];
  github.compareRefs = async (owner, repo, basehead) => {
    asked.push([owner, repo, basehead]);
    return { files: ['app-templates/tier-list/api.js', 'README.md'], filesComplete: true };
  };
  try {
    await withEnv({ USERNODE_ENV: 'production' }, async () => {
      const sha = 'a'.repeat(40);
      const app = { id: 2, slug: SELF, repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' };
      const pool = fakePool([['INSERT INTO preview_project_tokens', [{ id: 9 }]], ['DELETE FROM preview_project_tokens', []]]);
      const env = await projects.previewEnv(CONFIG, { app, sessionId: 7, commitHash: sha, pool });
      assert.equal(env.PREVIEW_PROJECTS_STARTER_DIRS, 'tier-list');
      assert.deepEqual(asked, [['Usernode-Labs', 'social-vibecoding', `main...${sha}`]]);
      github.compareRefs = async () => { throw new Error('GitHub is down'); };
      assert.deepEqual(await projects.changedStarterDirs(CONFIG, { app, commitHash: sha }), [], 'a failed read names none');
      assert.deepEqual(await projects.changedStarterDirs(CONFIG, { app, commitHash: 'latest' }), []);
    });
  } finally {
    github.compareRefs = saved;
  }
  const staging = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'staging.js'), 'utf8');
  assert.match(staging, /previewEnv\(config, \{\s*app, sessionId: session\.id, commitHash,\s*\}\)/);
});

// ── Names ──────────────────────────────────────────────────────────────

test('a project name is its own: never the platform\'s, never another preview\'s host, and one DNS label', () => {
  assert.equal(projects.checkSlug(CONFIG, 'city-tier-list-a5f3bf', 11513), null);
  assert.equal(projects.checkSlug(CONFIG, SELF, 11513).code, 'invalid_slug');
  assert.equal(projects.checkSlug(CONFIG, 'tier--s4', 11513).code, 'invalid_slug', 'it would read as session 4\'s preview');
  assert.equal(projects.checkSlug(CONFIG, 'Tier-List', 11513).code, 'invalid_slug');
  assert.equal(projects.checkSlug(CONFIG, '-tier', 11513).code, 'invalid_slug');
  assert.equal(projects.checkSlug(CONFIG, 'a'.repeat(50), 1234567890123).code, 'invalid_slug', 'slug--s<session> must fit in 63');
});

test('a project builds under a slug no app can have, and runs under its own', () => {
  const row = { id: 12, session_id: 11513, slug: 'goalio', name: 'Goalio' };
  assert.equal(projects.childApp(row).slug, 'goalio', 'its host is made from its own slug');
  assert.equal(projects.childApp(row).id, 'pp-12', 'an app id no app has, for the platform-preview retirement and sweeps');
  assert.equal(projects.runtimeNameOf(row), 'sv-pp-12-s11513');
  assert.doesNotMatch(projects.runtimeNameOf(row), /^sv-preview-\d+-s\d+$/, 'the leftover sweep\'s shape');
  // The build's slug names its image repository and layer cache.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'preview-projects.js'), 'utf8');
  assert.match(source, /slug: `preview-project-\$\{row\.id\}`/);
  assert.match(source, /app: buildApp\(row, source\.repoUrl\)/);
  assert.doesNotMatch(source, /app: childApp\(row, source/);
});

test('a project database is a preview-side name under its session, which the orphan sweep collects', () => {
  const name = projects.dbNameOf({ id: 12, session_id: 11513 });
  assert.match(name, /^app_pp12_staging_s11513_[0-9a-f]{6}$/);
  assert.equal(dbManager.isStagingCloneDb(name), true);
  assert.ok(name.length <= 63);
  const reap = require('../src/services/staging-reap');
  const keep = reap.selectOrphanDbs({ dbNames: [name], liveSessionIds: new Set([11513]), connectedDbNames: new Set() });
  assert.deepEqual(keep, [], 'kept while its preview lives');
  const gone = reap.selectOrphanDbs({ dbNames: [name], liveSessionIds: new Set(), connectedDbNames: new Set() });
  assert.deepEqual(gone, [name], 'and dropped once it is gone');
});

// ── What a preview may send ────────────────────────────────────────────

test('files must be plain relative paths within the limits', () => {
  const b64 = (s) => Buffer.from(s).toString('base64');
  const ok = projects.checkFiles([{ path: 'server.js', content: b64('x') }, { path: 'bin/run', content: b64('y'), mode: '100755' }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.files[1].mode, '100755');
  assert.equal(ok.files[0].content.toString(), 'x');
  for (const bad of ['', '/etc/passwd', '../up', 'a/../b', '.git/config', 'a//b', 'a\\b']) {
    assert.equal(projects.checkFiles([{ path: bad, content: b64('x') }]).code, 'invalid_files', bad);
  }
  assert.equal(projects.checkFiles([{ path: 'a', content: b64('x') }, { path: 'a', content: b64('y') }]).code, 'invalid_files');
  assert.equal(projects.checkFiles([]).code, 'invalid_files');
  const big = Buffer.alloc(projects.MAX_SOURCE_BYTES + 1).toString('base64');
  assert.equal(projects.checkFiles([{ path: 'big', content: big }]).status, 413);
  assert.ok(BUILD_BODY_LIMIT > Math.ceil(projects.MAX_SOURCE_BYTES * 4 / 3), 'the route takes a whole source, base64');
});

test('the env is the preview\'s within limits, and the database, port and environment are production\'s', () => {
  const ok = projects.checkEnv({ USERNODE_APP_ID: '41', DATABASE_URL: 'postgres://elsewhere', PORT: '1', USERNODE_ENV: 'production', EMPTY: null });
  assert.deepEqual(ok, { ok: true, env: { USERNODE_APP_ID: '41' } });
  assert.equal(projects.checkEnv({ 'lower-case': 'x' }).code, 'invalid_env');
  assert.equal(projects.checkEnv({ A: 1 }).code, 'invalid_env');
  assert.equal(projects.checkEnv({ A: 'x'.repeat(33 * 1024) }).status, 413);
  assert.equal(projects.checkEnv([]).code, 'invalid_env');
});

test('what a preview is told never carries the database password; a step that stopped reads as failed', () => {
  const row = {
    slug: 'tier', state: 'running', error: null, image_ref: 'r@sha256:1', hostname: 'tier--s5.example.test',
    builds: 2, db_password: 'secret', db_name: 'app_pp1_staging_s5_abcdef',
  };
  const shown = projects.view(row);
  assert.equal(JSON.stringify(shown).includes('secret'), false);
  assert.equal(shown.url, 'https://tier--s5.example.test');
  const stopped = projects.view({ ...row, state: 'building', op_started_at: new Date(Date.now() - (projects.STALE_MINUTES + 1) * 60000) });
  assert.equal(stopped.state, 'failed');
});

// ── Retirement ─────────────────────────────────────────────────────────

test('the preview machine retires a preview\'s projects before its own databases, and the orphan pass sweeps first', () => {
  const services = fs.readFileSync(path.join(__dirname, '..', 'src', 'workflow', 'preview', 'services.ts'), 'utf8');
  const retire = services.slice(services.indexOf('[WORK.retire]: {'));
  const projectsAt = retire.indexOf("legacy('services/preview-projects').retireForSession(config, pool, input.sessionId)");
  const dbsAt = retire.indexOf('dbManager().dropDatabase(db, { strict: true })');
  assert.ok(projectsAt > 0 && dbsAt > projectsAt);
  const reap = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'staging-reap.js'), 'utf8');
  const sweepAt = reap.indexOf("require('./preview-projects').sweep(config, pool)");
  assert.ok(sweepAt > 0 && sweepAt < reap.indexOf("pool.query(`SELECT datname FROM pg_database"));
});

test('retiring a session removes each project (runtime, database, branch, row) and its credentials, and fails if one stays', async () => {
  const runtime = require('../src/services/application-runtime');
  const gitHost = require('../src/services/git-host');
  const saved = { remove: runtime.remove, drop: dbManager.dropDatabase, deleteRef: gitHost.deleteRef };
  const calls = [];
  runtime.remove = async (_c, ref, opts) => { calls.push(['remove', ref.runtimeName, ref.appId, opts.deleteBuilds]); };
  dbManager.dropDatabase = async (name, opts) => {
    calls.push(['drop', name, opts.strict]);
    if (name === 'app_pp2_staging_s5_bbbbbb') throw new Error('in use');
  };
  gitHost.deleteRef = async (repo, ref) => { calls.push(['branch', repo, ref]); };
  try {
    const rows = [
      { id: 1, session_id: 5, slug: 'a', runtime_name: 'sv-pp-1-s5', db_name: 'app_pp1_staging_s5_aaaaaa', source_branch: 'project-1-b1' },
      { id: 2, session_id: 5, slug: 'b', runtime_name: null, db_name: 'app_pp2_staging_s5_bbbbbb', source_branch: null },
    ];
    const queries = [];
    const pool = fakePool([
      ['SELECT * FROM preview_projects WHERE session_id', rows],
      ['DELETE FROM preview_projects WHERE id', []],
      ['DELETE FROM preview_project_tokens WHERE session_id', []],
    ], queries);
    await assert.rejects(projects.retireForSession(CONFIG, pool, 5), /in use/);
    assert.deepEqual(calls, [
      ['remove', 'sv-pp-1-s5', 'pp-1', true],
      ['drop', 'app_pp1_staging_s5_aaaaaa', true],
      ['branch', projects.SOURCE_REPO, 'project-1-b1'],
      ['remove', 'sv-pp-2-s5', 'pp-2', true],
      ['drop', 'app_pp2_staging_s5_bbbbbb', true],
    ]);
    const deletes = queries.filter((q) => q.sql.includes('DELETE FROM preview_projects WHERE id')).map((q) => q.params[0]);
    assert.deepEqual(deletes, [1], 'the one that would not go keeps its row for the next try');
    assert.ok(queries.some((q) => q.sql.includes('DELETE FROM preview_project_tokens WHERE session_id')), 'its credentials go anyway');
  } finally {
    runtime.remove = saved.remove;
    dbManager.dropDatabase = saved.drop;
    gitHost.deleteRef = saved.deleteRef;
  }
});

// ── The door ───────────────────────────────────────────────────────────

async function serve(t, { enabled = true, internal = true, auth = { ok: true, sessionId: 41 }, allowed = true, service = {} } = {}) {
  const calls = [];
  const fake = {
    enabled: () => enabled,
    tokenFromHeader: projects.tokenFromHeader,
    authenticate: async () => auth,
    createProject: async (_c, _p, args) => { calls.push(['create', args]); return { ok: true, project: { slug: args.slug, state: 'created' } }; },
    describe: async (_c, _p, args) => { calls.push(['describe', args]); return { ok: true, project: { slug: args.slug, state: 'running' } }; },
    logs: async () => ({ ok: true, text: 'line' }),
    startBuild: async (_c, _p, args) => { calls.push(['build', { ...args, files: args.files.length }]); return { ok: true, project: { state: 'building' } }; },
    startDeploy: async (_c, _p, args) => { calls.push(['deploy', args]); return { ok: true, project: { state: 'deploying' } }; },
    restart: async () => ({ ok: true }),
    remove: async (_c, _p, args) => { calls.push(['remove', args]); return { ok: true, removed: true }; },
    ...service,
  };
  const app = express();
  app.use(previewProjectsRoutes(CONFIG, {
    pool: {}, service: fake, isInternal: () => internal,
    limiter: async () => ({ allowed, retryAfter: 30 }),
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = projects.makeToken();
  const call = (method, pathname, body, headers = {}) => fetch(`${base}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { call, calls };
}

test('the door is not there when off, from outside, or without a credential', async (t) => {
  for (const options of [{ enabled: false }, { internal: false }]) {
    const { call, calls } = await serve(t, options);
    const res = await call('PUT', '/api/preview-projects/tier', { appId: 3 });
    assert.equal(res.status, 404);
    assert.equal(calls.length, 0);
  }
  const refused = await serve(t, { auth: { ok: false, code: 'invalid_token', message: 'no', status: 401 } });
  assert.equal((await refused.call('GET', '/api/preview-projects/tier')).status, 401);
  const limited = await serve(t, { allowed: false });
  const res = await limited.call('GET', '/api/preview-projects/tier');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '30');
});

test('every operation acts on the credential\'s session, whatever the request says', async (t) => {
  const { call, calls } = await serve(t);
  assert.equal((await call('PUT', '/api/preview-projects/tier', { appId: 3, name: 'Tier', sessionId: 999 })).status, 200);
  const built = await call('POST', '/api/preview-projects/tier/build', { files: [{ path: 'a', content: 'eA==' }], sessionId: 999 });
  assert.equal(built.status, 202);
  assert.equal((await call('POST', '/api/preview-projects/tier/deploy', { imageRef: 'r@sha256:1', env: { A: 'b' } })).status, 202);
  assert.equal((await call('GET', '/api/preview-projects/tier?runtime=1')).status, 200);
  assert.equal((await call('DELETE', '/api/preview-projects/tier')).status, 200);
  assert.deepEqual(calls.map(([op, args]) => [op, args.sessionId]), [
    ['create', 41], ['build', 41], ['deploy', 41], ['describe', 41], ['remove', 41],
  ]);
  assert.equal(calls[3][1].runtime, true);
  assert.equal((await call('GET', '/api/preview-projects/tier', undefined, { 'cache-control': 'x' })).headers.get('cache-control'), 'no-store');
});

test('a body over its route\'s limit is refused before the service sees it', async (t) => {
  const { call, calls } = await serve(t);
  const res = await call('POST', '/api/preview-projects/tier/deploy', { imageRef: 'r', env: { A: 'x'.repeat(600 * 1024) } });
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
});
