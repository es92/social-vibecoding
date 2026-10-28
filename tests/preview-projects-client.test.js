'use strict';

// Projects made inside a platform preview: the preview's half
// (services/preview-projects-client.js), against a fake of production's
// door. What it sends, what it waits for, the env it gives a project, and
// that the runtime seam (application-runtime.js) hands a project made here
// to it and nothing else.
//
// Run with: node --test tests/preview-projects-client.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const client = require('../src/services/preview-projects-client');
const runtime = require('../src/services/application-runtime');
const platformJwt = require('../src/services/platform-jwt');

const KEYS = ['USERNODE_ENV', 'PREVIEW_PROJECTS_URL', 'PREVIEW_PROJECTS_TOKEN', 'PREVIEW_PROJECTS_SESSION_ID',
  'PREVIEW_PROJECTS_ORIGIN', 'PREVIEW_PROJECTS_INTERNAL_ORIGIN', 'IFRAME_JWT_PRIVATE_KEY'];

function setEnv(t, values) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// Production's door, as the client sees it: records each request, answers
// from `script`, and walks a project through the states it is given.
async function fakeProduction(t, { states = {}, refuse = null } = {}) {
  const requests = [];
  const seen = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: json });
      const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (refuse && refuse(req)) return send(409, { ok: false, error: 'busy', message: 'This project is busy.' });
      const m = /^\/api\/preview-projects\/([^/?]+)(\/[a-z]+)?/.exec(req.url);
      const slug = m && decodeURIComponent(m[1]);
      if (req.method === 'GET' && !m[2]) {
        const list = states[slug] || [{ state: 'created' }];
        const i = Math.min(seen[slug] = (seen[slug] ?? -1) + 1, list.length - 1);
        if (list[i] === 404) return send(404, { ok: false, error: 'not_found' });
        return send(200, { ok: true, project: { slug, ...list[i] } });
      }
      if (req.method === 'GET' && m[2] === '/logs') return send(200, { ok: true, text: 'hello\n' });
      if (req.method === 'DELETE') return send(states[slug] === 404 ? 404 : 200, { ok: true, removed: true });
      return send(req.method === 'PUT' ? 200 : 202, { ok: true, project: { slug } });
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function previewEnv(url) {
  return {
    USERNODE_ENV: 'staging',
    PREVIEW_PROJECTS_URL: url,
    PREVIEW_PROJECTS_TOKEN: 'svpp_' + 'a'.repeat(43),
    PREVIEW_PROJECTS_SESSION_ID: '11513',
    PREVIEW_PROJECTS_ORIGIN: 'https://usernode-2d5619--s11513.onhomeroom.test',
    PREVIEW_PROJECTS_INTERNAL_ORIGIN: 'http://sv-preview-2-s11513.social-apps.svc:3000',
  };
}

test('only a preview production gave all of it to is one', (t) => {
  setEnv(t, {});
  const full = previewEnv('http://usernode:3000');
  assert.equal(client.active(full), true);
  assert.equal(client.active({ ...full, USERNODE_ENV: 'production' }), false, 'never production');
  for (const missing of ['PREVIEW_PROJECTS_URL', 'PREVIEW_PROJECTS_TOKEN', 'PREVIEW_PROJECTS_SESSION_ID', 'PREVIEW_PROJECTS_ORIGIN']) {
    const env = { ...full };
    delete env[missing];
    assert.equal(client.active(env), false, missing);
  }
  assert.equal(client.active({ ...full, PREVIEW_PROJECTS_SESSION_ID: 'x' }), false);
  assert.equal(client.active({ ...full, PREVIEW_PROJECTS_ORIGIN: 'http://plain' }), false);
});

test('a project made here answers under this preview\'s session, never at a production app\'s address', (t) => {
  setEnv(t, previewEnv('http://usernode:3000'));
  assert.match(client.appUrl('city-tier-list-a5f3bf'), /^https:\/\/city-tier-list-a5f3bf--s11513\./);
});

test('the database step asks production for the project, and keeps a password that opens nothing', async (t) => {
  const prod = await fakeProduction(t);
  setEnv(t, previewEnv(prod.url));
  const { password } = await client.createDatabase({ id: 41, slug: 'tier', name: 'Tier' });
  assert.match(password, /^[0-9a-f]{48}$/);
  assert.deepEqual(prod.requests[0], {
    method: 'PUT', url: '/api/preview-projects/tier', auth: 'Bearer svpp_' + 'a'.repeat(43), body: { appId: 41, name: 'Tier' },
  });
});

test('a build sends the generated files (not .git or node_modules) and waits for production\'s image', async (t) => {
  const prod = await fakeProduction(t, { states: { tier: [{ state: 'building' }, { state: 'built', imageRef: 'reg/p@sha256:ab' }] } });
  setEnv(t, previewEnv(prod.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-project-src-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'server.js'), 'ok');
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public', 'app.js'), 'js');
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh', { mode: 0o755 });
  for (const skipped of ['.git', 'node_modules']) {
    fs.mkdirSync(path.join(dir, skipped));
    fs.writeFileSync(path.join(dir, skipped, 'x'), 'no');
  }
  const built = await runtime.build({}, { app: { id: 41, slug: 'tier' }, environment: 'production', sourceDir: dir, revision: null });
  assert.deepEqual(built, { runtimeKind: 'broker', imageRef: 'reg/p@sha256:ab', buildRef: null, engine: 'broker' });
  const upload = prod.requests.find((r) => r.url === '/api/preview-projects/tier/build');
  const files = Object.fromEntries(upload.body.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(files).sort(), ['public/app.js', 'run.sh', 'server.js']);
  assert.equal(Buffer.from(files['public/app.js'].content, 'base64').toString(), 'js');
  assert.equal(files['run.sh'].mode, '100755');
});

test('a build production could not finish fails with production\'s reason', async (t) => {
  const prod = await fakeProduction(t, { states: { tier: [{ state: 'failed', error: 'npm ci failed' }] } });
  setEnv(t, previewEnv(prod.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-project-src-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'server.js'), 'ok');
  await assert.rejects(runtime.build({}, { app: { slug: 'tier' }, environment: 'production', sourceDir: dir }), /npm ci failed/);
});

test('a project is given the preview\'s signing key, the preview as its platform, and no database, LLM or storage of the preview\'s', async (t) => {
  const prod = await fakeProduction(t, { states: { tier: [{ state: 'deploying' }, { state: 'running', hostname: 'tier--s11513.onhomeroom.test', url: 'https://tier--s11513.onhomeroom.test' }] } });
  setEnv(t, previewEnv(prod.url));
  platformJwt._resetStagingSigningPair();
  platformJwt.generateStagingIframeKeyPair();
  t.after(() => platformJwt._resetStagingSigningPair());
  const productionParentKey = '-----BEGIN PUBLIC KEY-----\nproduction\n-----END PUBLIC KEY-----';
  let rolledOut = false;
  const deployed = await runtime.deploy({}, {
    app: { id: 41, slug: 'tier' },
    environment: 'production',
    imageRef: 'reg/p@sha256:ab',
    env: {
      DATABASE_URL: 'postgres://app_tier:placeholder@preview-db/app_tier',
      USERNODE_JWT_PUBLIC_KEY: productionParentKey,
      JWT_SECRET: productionParentKey,
      IFRAME_JWT_PUBLIC_KEY: productionParentKey,
      USERNODE_APP_ID: '41',
      USERNODE_PLATFORM_ORIGIN: 'https://app.onhomeroom.test',
      USERNODE_LLM_PROXY_URL: 'http://usernode:3000/api/app-llm',
      USERNODE_LLM_PROXY_TOKEN: 'per-app',
      USERNODE_PLATFORM_API_URL: 'http://usernode:3000/api/app-platform',
      USERNODE_STORAGE_URL: 'http://storage',
      USERNODE_STORAGE_TOKEN: 's',
      PORT: '3000',
      USERNODE_ENV: 'production',
      SOME_SECRET: 'kept',
    },
    onRollout: () => { rolledOut = true; },
  });
  assert.equal(rolledOut, true);
  assert.deepEqual(deployed, {
    runtimeKind: 'broker', runtimeName: 'tier', imageRef: 'reg/p@sha256:ab',
    hostname: 'tier--s11513.onhomeroom.test', url: 'https://tier--s11513.onhomeroom.test',
  });
  const { body } = prod.requests.find((r) => r.url === '/api/preview-projects/tier/deploy');
  assert.equal(body.imageRef, 'reg/p@sha256:ab');
  const signing = platformJwt.signingPublicKeyPem();
  assert.ok(signing && signing !== productionParentKey);
  assert.equal(body.env.USERNODE_JWT_PUBLIC_KEY, signing);
  assert.equal(body.env.JWT_SECRET, signing);
  assert.equal(body.env.IFRAME_JWT_PUBLIC_KEY, signing);
  assert.equal(body.env.USERNODE_PLATFORM_ORIGIN, 'https://usernode-2d5619--s11513.onhomeroom.test');
  assert.equal(body.env.USERNODE_PLATFORM_API_URL, 'http://sv-preview-2-s11513.social-apps.svc:3000/api/app-platform');
  assert.equal(body.env.USERNODE_PLATFORM_API_V1_URL, 'http://sv-preview-2-s11513.social-apps.svc:3000/api/app-platform/v1');
  for (const gone of ['DATABASE_URL', 'PORT', 'USERNODE_ENV', 'USERNODE_LLM_PROXY_URL', 'USERNODE_STORAGE_URL', 'USERNODE_STORAGE_TOKEN']) {
    assert.equal(body.env[gone], undefined, gone);
  }
  assert.equal(body.env.USERNODE_LLM_PROXY_TOKEN, 'per-app', 'the app platform API takes it');
  assert.equal(body.env.SOME_SECRET, 'kept');
});

test('the signing key is the injected one when there is one, and the clone\'s own otherwise', (t) => {
  setEnv(t, { USERNODE_ENV: 'staging' });
  platformJwt._resetStagingSigningPair();
  t.after(() => platformJwt._resetStagingSigningPair());
  assert.equal(platformJwt.signingPublicKeyPem(), null);
  platformJwt.generateStagingIframeKeyPair();
  const own = platformJwt.signingPublicKeyPem();
  assert.match(own, /BEGIN PUBLIC KEY/);
  const { privateKey, publicKey } = require('node:crypto').generateKeyPairSync('rsa', {
    modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.IFRAME_JWT_PRIVATE_KEY = privateKey;
  assert.equal(platformJwt.signingPublicKeyPem().trim(), publicKey.trim());
});

test('everything later done to a project made here goes to production, by its slug', async (t) => {
  const prod = await fakeProduction(t, { states: { tier: [{ state: 'running', runtime: { status: 'running', rolloutReady: true }, healthy: true }], gone: [404] } });
  setEnv(t, previewEnv(prod.url));
  const ref = runtime.productionRef({}, { slug: 'tier', runtime_kind: 'broker', runtime_name: null });
  assert.deepEqual(ref, { runtimeKind: 'broker', runtimeName: 'tier' });
  assert.equal(await runtime.status({}, ref), 'running');
  assert.equal(await runtime.probeHealth({}, ref), true);
  assert.equal(await runtime.logs({}, ref, 50), 'hello\n');
  await runtime.restart({}, ref);
  await runtime.remove({}, ref);
  await runtime.remove({}, { runtimeKind: 'broker', runtimeName: 'gone' });
  assert.equal(runtime.appOrigin({}, ref), client.appUrl('tier'));
  assert.equal((await runtime.inspect({}, { runtimeKind: 'broker', runtimeName: 'gone' })).status, 'not_found');
  const urls = prod.requests.map((r) => `${r.method} ${r.url}`);
  assert.ok(urls.includes('GET /api/preview-projects/tier/logs?tail=50'));
  assert.ok(urls.includes('POST /api/preview-projects/tier/restart'));
  assert.ok(urls.includes('DELETE /api/preview-projects/tier'));
  assert.ok(urls.includes('DELETE /api/preview-projects/gone'), 'a project production no longer has is removed already');
});

test('outside a preview production gave the credential to, build and deploy are untouched', async (t) => {
  setEnv(t, { USERNODE_ENV: 'production' });
  const docker = require('../src/services/docker');
  const saved = docker.buildImage;
  const calls = [];
  docker.buildImage = async (dir, image) => { calls.push([dir, image]); };
  t.after(() => { docker.buildImage = saved; });
  const built = await runtime.build({ appRuntime: 'docker' }, { app: { slug: 'tier' }, environment: 'production', sourceDir: '/tmp/x', dockerImage: 'img' });
  assert.equal(built.runtimeKind, 'docker');
  assert.deepEqual(calls, [['/tmp/x', 'img']]);
});

test('a refusal from production says what production said', async (t) => {
  const prod = await fakeProduction(t, { refuse: (req) => req.method === 'POST' });
  setEnv(t, previewEnv(prod.url));
  await assert.rejects(runtime.restart({}, { runtimeKind: 'broker', runtimeName: 'tier' }), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, 'busy');
    assert.match(err.message, /busy/);
    return true;
  });
});

test('app creation hands its database to production only in such a preview, and the apps routes frame it there', () => {
  const creator = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'app-creator.js'), 'utf8');
  assert.match(creator, /previewProjects\.active\(\)\s*\?\s*await previewProjects\.createDatabase\(row\)\s*:\s*await dbManager\.createDatabase\(dbManager\.appDbName\(row\.slug\)\)/);
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'apps.js'), 'utf8');
  assert.equal((routes.match(/!url && !\w+\.self_hosted && previewProjects\.active\(\)\) url = previewProjects\.appUrl\(/g) || []).length, 2,
    'the list and the app read both');
});

// ── The starters this proposal changed, made as the preview boots ──────

// A pool whose transactions are recorded: apps already there by slug.
function seedPool({ existing = [], owner = 41 } = {}) {
  const queries = [];
  const apps = new Set(existing);
  let nextId = 100;
  const run = async (sql, params = []) => {
    queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('FROM users WHERE username')) return { rows: owner ? [{ id: owner }] : [] };
    if (sql.includes('INSERT INTO apps')) {
      if (apps.has(params[1])) return { rows: [] };
      apps.add(params[1]);
      return { rows: [{ id: nextId++, slug: params[1] }] };
    }
    return { rows: [] };
  };
  return { queries, query: run, connect: async () => ({ query: run, release() {} }) };
}

test('each starter the proposal changed is made once, open, owned by the demo identity, as the dialog makes one', async (t) => {
  setEnv(t, {});
  const env = { ...previewEnv('http://usernode:3000'), PREVIEW_PROJECTS_STARTER_DIRS: 'tier-list,group-poll,Not Valid,tier-list' };
  assert.deepEqual(client.settings(env).starterDirs, ['tier-list', 'group-poll', 'tier-list']);
  const pool = seedPool();
  const first = await client.seedChangedStarters(pool, null, env);
  const appTemplates = require('../src/services/app-templates');
  const tierId = appTemplates.READY_IDS.find((id) => appTemplates.dirOf(id) === 'tier-list');
  const pollId = appTemplates.READY_IDS.find((id) => appTemplates.dirOf(id) === 'group-poll');
  assert.deepEqual(first.made, [`${tierId}-this-change`, `${pollId}-this-change`]);
  const insert = pool.queries.find((q) => q.sql.startsWith('BEGIN') === false && q.sql.includes('INSERT INTO apps'));
  assert.deepEqual(insert.params, [`${appTemplates.get(tierId).title} (this change)`, `${tierId}-this-change`, 41, 'public', 'public']);
  assert.match(insert.sql, /INSERT INTO app_collaborators/, 'with its creator\'s membership, which starts its setup');
  assert.ok(pool.queries.some((q) => q.sql.startsWith('UPDATE apps SET governance_rules') && JSON.parse(q.params[0]).preset === 'you_or_the_group'));
  assert.ok(pool.queries.some((q) => q.sql.startsWith('UPDATE apps SET template') && q.params[0] === tierId));
  assert.match(client.changeStarterSlug(tierId), /^[a-z0-9-]+-this-change$/);
  assert.ok(`${client.changeStarterSlug(tierId)}--s11513`.length <= 63, 'its host is one DNS label');

  const again = await client.seedChangedStarters(seedPool({ existing: [`${tierId}-this-change`, `${pollId}-this-change`] }), null, env);
  assert.deepEqual(again.made, [], 'a boot later leaves them as they are');
});

test('outside such a preview, without a demo owner, or for a directory with no ready-made starter, nothing is made', async (t) => {
  setEnv(t, {});
  const none = seedPool();
  assert.deepEqual(await client.seedChangedStarters(none, null, { USERNODE_ENV: 'staging', PREVIEW_PROJECTS_STARTER_DIRS: 'tier-list' }), { made: [] });
  assert.deepEqual(await client.seedChangedStarters(none, null, previewEnv('http://usernode:3000')), { made: [] }, 'no starters named');
  assert.equal(none.queries.length, 0);
  const env = { ...previewEnv('http://usernode:3000'), PREVIEW_PROJECTS_STARTER_DIRS: 'tier-list' };
  assert.deepEqual(await client.seedChangedStarters(seedPool({ owner: null }), null, env), { made: [] });
  assert.deepEqual(await client.seedChangedStarters(seedPool(), null, { ...env, PREVIEW_PROJECTS_STARTER_DIRS: 'no-such-starter' }), { made: [] });
  const migrate = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrate.js'), 'utf8');
  const catalog = migrate.indexOf("require('../services/staging-apps').seedCatalog(pool, config)");
  const changed = migrate.indexOf("require('../services/preview-projects-client').seedChangedStarters(pool, config)");
  assert.ok(catalog > 0 && changed > catalog, 'made with the staging seeds, after the demo owner and catalog exist');
});
